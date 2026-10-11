/**
 * Operation upload. Behavior ported from super-sync-server
 * (sync.service.ts `uploadOps`, operation-upload.service.ts `processOperation`).
 *
 * Concurrency model: node:sqlite is synchronous and the whole upload runs in
 * one `BEGIN IMMEDIATE` transaction inside a single JavaScript turn. Uploads
 * (and every other writer in this process) are therefore strictly serialized;
 * the Postgres server's RepeatableRead + row-lock reasoning collapses to that.
 * Only one server process may write a database file (enforced by the PID lock
 * in server startup).
 */
import { limitVectorClockSize, MAX_VECTOR_CLOCK_SIZE } from '@sp/sync-core';
import { Db, transaction } from '../db/database';
import {
  detectConflict,
  getStoredEntityIds,
  isSameDuplicateOperation,
  isSameIncomingOperation,
} from './conflict';
import {
  aggregateVectorClock,
  allocateServerSeq,
  deleteAllOperations,
  ensureSyncState,
  findLatestCausalFullState,
  findOperationById,
  insertOperation,
} from './op-store';
import {
  createStateReplacementRequiredResults,
  isCausalFullStateOperation,
  Operation,
  SYNC_ERROR_CODES,
  SyncConfig,
  UploadResult,
  VectorClock,
} from './types';
import { validateOp, ValidationResult } from './validation';

export interface AcceptedOperation {
  op: Operation;
  serverSeq: number;
  receivedAt: number;
}

/**
 * Runs inside the upload transaction after all ops of the request were
 * processed. Throwing rolls back the whole request (all ops rejected with
 * INTERNAL_ERROR), which keeps the op log and derived tables consistent.
 */
export type AcceptedOperationsHook = (
  db: Db,
  userId: number,
  accepted: AcceptedOperation[],
  context: { cleanSlate: boolean },
) => void;

export interface UploadOptions {
  isCleanSlate?: boolean;
  repairBaseServerSeq?: number;
  allowLegacyRepairWithoutBase?: boolean;
  lastKnownServerSeq?: number;
  onAccepted?: AcceptedOperationsHook;
  now?: number;
}

class CleanSlateUploadRejectedError extends Error {
  constructor(readonly results: UploadResult[]) {
    super('Clean-slate upload rejected');
  }
}

const rejected = (
  op: Operation,
  error: string | undefined,
  errorCode: string | undefined,
  existingClock?: VectorClock,
): UploadResult => ({ opId: op.id, accepted: false, error, errorCode, existingClock });

/**
 * Resolves the persisted state-replacement fence lazily (mirrors
 * resolveRetainedReplacementSeq): the latest retained SYNC_IMPORT/BACKUP_IMPORT,
 * or 0 when none exists.
 */
const resolveStateReplacementSeq = (db: Db, userId: number): number => {
  const row = db
    .prepare(
      `SELECT server_seq FROM operations WHERE user_id = ?
         AND op_type IN ('SYNC_IMPORT', 'BACKUP_IMPORT')
       ORDER BY server_seq DESC LIMIT 1`,
    )
    .get(userId) as { server_seq: number } | undefined;
  return row?.server_seq ?? 0;
};

export const getLatestStateReplacementSeq = (db: Db, userId: number): number | null => {
  const state = db
    .prepare('SELECT latest_state_replacement_seq FROM sync_state WHERE user_id = ?')
    .get(userId) as { latest_state_replacement_seq: number | null } | undefined;
  if (!state) return null;
  if (state.latest_state_replacement_seq !== null) {
    return state.latest_state_replacement_seq === 0
      ? null
      : state.latest_state_replacement_seq;
  }
  const resolved = resolveStateReplacementSeq(db, userId);
  return resolved === 0 ? null : resolved;
};

const processOperation = (
  db: Db,
  userId: number,
  clientId: string,
  op: Operation,
  now: number,
  config: SyncConfig,
  validation: ValidationResult,
  firstRequestOperation: { op: Operation; originalTimestamp: number } | undefined,
  fullStateAuthor: { author: string | undefined; resolved: boolean },
): { result: UploadResult; accepted?: AcceptedOperation } => {
  // Clamp future timestamps instead of rejecting them.
  const originalTimestamp = op.timestamp;
  const maxAllowedTimestamp = now + config.maxClockDriftMs;
  if (op.timestamp > maxAllowedTimestamp) {
    op.timestamp = maxAllowedTimestamp;
  }

  if (firstRequestOperation) {
    const isExactRetry = isSameIncomingOperation(
      firstRequestOperation.op,
      op,
      firstRequestOperation.originalTimestamp,
      originalTimestamp,
    );
    return {
      result: rejected(
        op,
        isExactRetry
          ? 'Duplicate operation ID'
          : 'Operation ID already belongs to a different operation',
        isExactRetry
          ? SYNC_ERROR_CODES.DUPLICATE_OPERATION
          : SYNC_ERROR_CODES.INVALID_OP_ID,
      ),
    };
  }

  if (!validation.valid) {
    return { result: rejected(op, validation.error, validation.errorCode) };
  }

  const fullStateVectorClock = isCausalFullStateOperation(op)
    ? { ...op.vectorClock }
    : undefined;

  const existingOp = findOperationById(db, op.id);
  if (existingOp) {
    const same = isSameDuplicateOperation(
      existingOp,
      userId,
      op,
      config.maxClockDriftMs,
      originalTimestamp,
    );
    return {
      result: rejected(
        op,
        same
          ? 'Duplicate operation ID'
          : 'Operation ID already belongs to a different operation',
        same ? SYNC_ERROR_CODES.DUPLICATE_OPERATION : SYNC_ERROR_CODES.INVALID_OP_ID,
      ),
    };
  }

  const conflict = detectConflict(db, userId, op);
  if (conflict.hasConflict) {
    const errorCode =
      conflict.conflictType === 'concurrent' ||
      conflict.conflictType === 'equal_different_client'
        ? SYNC_ERROR_CODES.CONFLICT_CONCURRENT
        : SYNC_ERROR_CODES.CONFLICT_SUPERSEDED;
    return { result: rejected(op, conflict.reason, errorCode, conflict.existingClock) };
  }

  const serverSeq = allocateServerSeq(db, userId);

  // Prune AFTER conflict detection (the full clock is compared) and BEFORE
  // storage. Protect the uploader and, for oversized clocks, the active
  // causal full-state author.
  if (isCausalFullStateOperation(op)) {
    fullStateAuthor.author = op.clientId;
    fullStateAuthor.resolved = true;
  }
  const protectedIds: string[] = [];
  if (Object.keys(op.vectorClock).length > MAX_VECTOR_CLOCK_SIZE) {
    if (!fullStateAuthor.resolved) {
      fullStateAuthor.author = findLatestCausalFullState(db, userId)?.clientId;
      fullStateAuthor.resolved = true;
    }
    if (fullStateAuthor.author) protectedIds.push(fullStateAuthor.author);
  }
  op.vectorClock = limitVectorClockSize(op.vectorClock, [op.clientId, ...protectedIds]);

  insertOperation(db, {
    op,
    userId,
    serverSeq,
    storedEntityIds: getStoredEntityIds(op),
    payloadBytes: validation.payloadBytes ?? 0,
    receivedAt: now,
  });

  if (fullStateVectorClock) {
    const merged: VectorClock = aggregateVectorClock(db, userId, { below: serverSeq });
    for (const [cid, counter] of Object.entries(fullStateVectorClock)) {
      merged[cid] = Math.max(merged[cid] ?? 0, counter);
    }
    db.prepare(
      'UPDATE sync_state SET latest_full_state_seq = ?, latest_full_state_vector_clock = ? WHERE user_id = ?',
    ).run(serverSeq, JSON.stringify(merged), userId);
  }

  return {
    result: { opId: op.id, accepted: true, serverSeq },
    accepted: { op, serverSeq, receivedAt: now },
  };
};

/**
 * Validates and stores a batch of operations for one user. Returns one
 * result per input op, in order. Never throws for per-op problems; a failed
 * transaction rejects every op with INTERNAL_ERROR (client retries).
 */
export const uploadOps = (
  db: Db,
  userId: number,
  clientId: string,
  ops: Operation[],
  config: SyncConfig,
  options: UploadOptions = {},
): UploadResult[] => {
  const { isCleanSlate, repairBaseServerSeq, lastKnownServerSeq } = options;
  if (isCleanSlate && ops.length === 0) return [];

  const now = options.now ?? Date.now();
  const containsRepair = ops.some((op) => op.opType === 'REPAIR');
  const isLegacyRepairUpload =
    containsRepair &&
    repairBaseServerSeq === undefined &&
    (options.allowLegacyRepairWithoutBase ?? false);
  const shouldCleanSlate = !!isCleanSlate && !containsRepair;

  const validations = new Map<Operation, ValidationResult>();
  const validationFor = (op: Operation): ValidationResult => {
    let v = validations.get(op);
    if (!v) {
      v = validateOp(op, clientId, config);
      validations.set(op, v);
    }
    return v;
  };

  if (isCleanSlate) {
    const all = ops.map(validationFor);
    if (all.some((v) => !v.valid)) {
      return ops.map((op, i) =>
        all[i].valid
          ? rejected(
              op,
              'Clean-slate batch contains an invalid operation',
              SYNC_ERROR_CODES.INTERNAL_ERROR,
            )
          : rejected(op, all[i].error ?? 'Invalid operation', all[i].errorCode),
      );
    }
  }

  const results: UploadResult[] = [];
  try {
    transaction(db, () => {
      const state = ensureSyncState(db, userId);
      const currentServerSeq = state.last_seq;

      let latestStateReplacementSeq = state.latest_state_replacement_seq;
      if (latestStateReplacementSeq === null) {
        latestStateReplacementSeq = resolveStateReplacementSeq(db, userId);
        db.prepare(
          'UPDATE sync_state SET latest_state_replacement_seq = ? WHERE user_id = ?',
        ).run(latestStateReplacementSeq, userId);
      }
      if (
        lastKnownServerSeq !== undefined &&
        latestStateReplacementSeq > 0 &&
        lastKnownServerSeq < latestStateReplacementSeq
      ) {
        results.push(...createStateReplacementRequiredResults(ops));
        return;
      }

      if (containsRepair && !isLegacyRepairUpload) {
        if (
          repairBaseServerSeq === undefined ||
          repairBaseServerSeq !== currentServerSeq
        ) {
          results.push(
            ...ops.map((op) =>
              op.opType === 'REPAIR'
                ? rejected(
                    op,
                    'REPAIR snapshot does not include current server state',
                    SYNC_ERROR_CODES.REPAIR_STALE,
                  )
                : rejected(
                    op,
                    'Batch deferred because its REPAIR snapshot is stale',
                    SYNC_ERROR_CODES.INTERNAL_ERROR,
                  ),
            ),
          );
          return;
        }
      }

      if (shouldCleanSlate) {
        // Delete history but PRESERVE last_seq so sequence numbers never repeat.
        deleteAllOperations(db, userId);
        db.prepare('DELETE FROM sync_devices WHERE user_id = ?').run(userId);
        db.prepare(
          `UPDATE sync_state SET latest_full_state_seq = NULL,
             latest_full_state_vector_clock = NULL, latest_state_replacement_seq = NULL
           WHERE user_id = ?`,
        ).run(userId);
      }

      const firstOperationById = new Map<
        string,
        { op: Operation; originalTimestamp: number }
      >();
      const fullStateAuthor = {
        author: undefined as string | undefined,
        resolved: false,
      };
      const accepted: AcceptedOperation[] = [];

      for (const op of ops) {
        const firstRequestOperation = firstOperationById.get(op.id);
        const validation = validationFor(op);
        if (!firstRequestOperation) {
          firstOperationById.set(op.id, {
            op: { ...op },
            originalTimestamp: op.timestamp,
          });
        }
        const processed = processOperation(
          db,
          userId,
          clientId,
          op,
          now,
          config,
          validation,
          firstRequestOperation,
          fullStateAuthor,
        );
        results.push(processed.result);
        if (processed.accepted) accepted.push(processed.accepted);
      }

      let latestAcceptedReplacement: number | undefined;
      ops.forEach((op, index) => {
        const result = results[index];
        if (
          result?.accepted &&
          result.serverSeq !== undefined &&
          (op.opType === 'SYNC_IMPORT' || op.opType === 'BACKUP_IMPORT')
        ) {
          latestAcceptedReplacement = Math.max(
            latestAcceptedReplacement ?? 0,
            result.serverSeq,
          );
        }
      });
      if (latestAcceptedReplacement !== undefined) {
        db.prepare(
          'UPDATE sync_state SET latest_state_replacement_seq = ? WHERE user_id = ?',
        ).run(latestAcceptedReplacement, userId);
      }

      if (
        isCleanSlate &&
        (results.length !== ops.length || results.some((r) => !r.accepted))
      ) {
        throw new CleanSlateUploadRejectedError(
          ops.map((op, index) => {
            const result = results[index];
            return result && !result.accepted
              ? result
              : rejected(
                  op,
                  'Clean-slate replacement was rolled back',
                  SYNC_ERROR_CODES.INTERNAL_ERROR,
                );
          }),
        );
      }

      if (accepted.length > 0 && options.onAccepted) {
        options.onAccepted(db, userId, accepted, { cleanSlate: shouldCleanSlate });
      }
    });
  } catch (err) {
    if (err instanceof CleanSlateUploadRejectedError) {
      return err.results;
    }
    // Rollback: nothing from this request is stored. Generic message only;
    // SQL details stay in the server log.
    console.error(`[upload] transaction failed for user ${userId}:`, err);
    return ops.map((op) =>
      rejected(op, 'Transaction failed - please retry', SYNC_ERROR_CODES.INTERNAL_ERROR),
    );
  }

  touchDevice(db, userId, clientId, undefined, now);
  return results;
};

/** Records device activity (outside the upload transaction, like the reference). */
export const touchDevice = (
  db: Db,
  userId: number,
  clientId: string,
  appVersion: string | null | undefined,
  now: number = Date.now(),
): void => {
  db.prepare(
    `INSERT INTO sync_devices (user_id, client_id, app_version, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, client_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       app_version = CASE WHEN ? THEN excluded.app_version ELSE sync_devices.app_version END`,
  ).run(userId, clientId, appVersion ?? null, now, now, appVersion !== undefined ? 1 : 0);
};
