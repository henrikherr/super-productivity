/**
 * HTTP-agnostic SuperSync endpoint logic. Each method returns a status code and
 * a JSON body, matching the reference routes (sync.routes.ts,
 * sync.routes.ops-handler.ts, sync.routes.snapshot-handler.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  SuperSyncDownloadOpsQuerySchema,
  SuperSyncUploadOpsRequestSchema,
  SuperSyncUploadSnapshotRequestSchema,
} from '@sp/shared-schema';
import { Db, transaction } from '../db/database';
import { isSameIncomingOperation } from './conflict';
import { getOpsSinceWithSeq } from './download';
import {
  deleteAllOperations,
  findLatestFullStateOp,
  findOperationById,
  getLatestSeq,
} from './op-store';
import { fingerprint, RequestDedupCache } from './request-dedup';
import {
  ACTION_TYPE_LOAD_ALL_DATA,
  DEFAULT_SYNC_CONFIG,
  Operation,
  ONLINE_DEVICE_THRESHOLD_MS,
  ServerOperation,
  STATE_REPLACEMENT_REQUIRED_ERROR,
  SYNC_ERROR_CODES,
  SyncConfig,
  UploadResult,
} from './types';
import {
  AcceptedOperationsHook,
  getLatestStateReplacementSeq,
  touchDevice,
  uploadOps,
} from './upload';

export interface HandlerResult {
  status: number;
  body: unknown;
}

export const MAX_OPS_PER_BATCH = 100;
const PIGGYBACK_LIMIT = 500;

/** Called after ops were committed (e.g. WebSocket push). */
export type NewOpsListener = (
  userId: number,
  originClientId: string,
  latestSeq: number,
) => void;

/**
 * Hook that may transform/inspect an upload BEFORE the transaction (async work
 * such as payload decryption for the projection belongs here) and returns the
 * in-transaction hook to run with the accepted ops.
 */
export type PrepareUploadHook = (
  userId: number,
  ops: Operation[],
) => Promise<AcceptedOperationsHook | undefined>;

const validationError = (issues: unknown): HandlerResult => ({
  status: 400,
  // Same shape as the reference server outside production.
  body: { error: 'Validation failed', details: issues },
});

const parseAppVersion = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
};

export class SyncService {
  private readonly opsDedup = new RequestDedupCache<UploadResult[]>();
  private readonly snapshotDedup = new RequestDedupCache<Record<string, unknown>>();
  private readonly listeners: NewOpsListener[] = [];
  private prepareUpload?: PrepareUploadHook;
  private historyReset?: (db: Db, userId: number) => void;

  constructor(
    private readonly db: Db,
    private readonly config: SyncConfig = DEFAULT_SYNC_CONFIG,
  ) {}

  onNewOps(listener: NewOpsListener): void {
    this.listeners.push(listener);
  }

  setPrepareUploadHook(hook: PrepareUploadHook | undefined): void {
    this.prepareUpload = hook;
  }

  /**
   * Called INSIDE the transaction that wipes a user's history (clean-slate
   * snapshot, DELETE /data) so derived data is reset atomically with it.
   */
  setHistoryResetHook(hook: ((db: Db, userId: number) => void) | undefined): void {
    this.historyReset = hook;
  }

  /** Announces ops committed outside the upload path (server-authored ops, test seeding). */
  notifyCommitted(userId: number, clientId: string, latestSeq: number): void {
    this.notify(userId, clientId, latestSeq);
  }

  private notify(userId: number, clientId: string, latestSeq: number): void {
    for (const listener of this.listeners) {
      try {
        listener(userId, clientId, latestSeq);
      } catch (err) {
        console.error('[sync] new-ops listener failed', err);
      }
    }
  }

  clearCachesForUser(userId: number): void {
    this.opsDedup.clearForUser(userId);
    this.snapshotDedup.clearForUser(userId);
  }

  private piggyback(
    userId: number,
    sinceSeq: number,
    excludeClient: string | undefined,
  ): { newOps: ServerOperation[]; latestSeq: number; hasMorePiggyback: boolean } {
    const result = getOpsSinceWithSeq(
      this.db,
      userId,
      sinceSeq,
      excludeClient,
      PIGGYBACK_LIMIT,
      false,
    );
    let hasMorePiggyback = false;
    if (result.ops.length === PIGGYBACK_LIMIT) {
      hasMorePiggyback = result.ops[result.ops.length - 1].serverSeq < result.latestSeq;
    }
    return { newOps: result.ops, latestSeq: result.latestSeq, hasMorePiggyback };
  }

  // POST /api/sync/ops
  async uploadOps(userId: number, body: unknown): Promise<HandlerResult> {
    const rawOps = (body as { ops?: unknown })?.ops;
    if (Array.isArray(rawOps) && rawOps.length > MAX_OPS_PER_BATCH) {
      return {
        status: 413,
        body: {
          error: `Too many operations (max ${MAX_OPS_PER_BATCH})`,
          errorCode: SYNC_ERROR_CODES.PAYLOAD_TOO_LARGE,
        },
      };
    }
    const parsed = SuperSyncUploadOpsRequestSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error.issues);

    const { clientId, lastKnownServerSeq, requestId } = parsed.data;
    const ops = parsed.data.ops as unknown as Operation[];
    const requestFingerprint = requestId ? fingerprint({ clientId, ops }) : undefined;

    if (requestId && requestFingerprint) {
      const cached = this.opsDedup.get(userId, requestId, () => requestFingerprint);
      if (cached && lastKnownServerSeq !== undefined) {
        const pb = this.piggyback(userId, lastKnownServerSeq, clientId);
        const replacementSeq = getLatestStateReplacementSeq(this.db, userId);
        const predatesReplacement =
          replacementSeq !== null &&
          (lastKnownServerSeq < replacementSeq ||
            cached.some(
              (r) =>
                r.accepted && (r.serverSeq === undefined || r.serverSeq < replacementSeq),
            ));
        if (!predatesReplacement) {
          return {
            status: 200,
            body: {
              results: cached,
              newOps: pb.newOps.length ? pb.newOps : undefined,
              latestSeq: pb.latestSeq,
              deduplicated: true,
              ...(pb.hasMorePiggyback ? { hasMorePiggyback: true } : {}),
            },
          };
        }
      } else if (cached) {
        return {
          status: 200,
          body: {
            results: cached,
            latestSeq: getLatestSeq(this.db, userId),
            deduplicated: true,
          },
        };
      }
    }

    const onAccepted = this.prepareUpload
      ? await this.prepareUpload(userId, ops)
      : undefined;
    const results = uploadOps(this.db, userId, clientId, ops, this.config, {
      lastKnownServerSeq,
      onAccepted,
    });

    const requiresStateReplacementDownload =
      results.length > 0 &&
      results.every(
        (r) =>
          !r.accepted &&
          r.errorCode === SYNC_ERROR_CODES.INTERNAL_ERROR &&
          r.error === STATE_REPLACEMENT_REQUIRED_ERROR,
      );

    if (
      requestId &&
      requestFingerprint &&
      !results.some((r) => r.errorCode === SYNC_ERROR_CODES.INTERNAL_ERROR)
    ) {
      this.opsDedup.set(userId, requestId, results, requestFingerprint);
    }

    let newOps: ServerOperation[] | undefined;
    let latestSeq: number;
    let hasMorePiggyback = false;
    if (lastKnownServerSeq !== undefined) {
      const pb = this.piggyback(
        userId,
        lastKnownServerSeq,
        requiresStateReplacementDownload ? undefined : clientId,
      );
      newOps = pb.newOps;
      latestSeq = pb.latestSeq;
      hasMorePiggyback = pb.hasMorePiggyback;
    } else {
      latestSeq = getLatestSeq(this.db, userId);
    }

    if (results.some((r) => r.accepted)) {
      this.notify(userId, clientId, latestSeq);
    }

    return {
      status: 200,
      body: {
        results,
        newOps: newOps && newOps.length > 0 ? newOps : undefined,
        latestSeq,
        ...(hasMorePiggyback ? { hasMorePiggyback: true } : {}),
      },
    };
  }

  // GET /api/sync/ops
  downloadOps(userId: number, query: Record<string, unknown>): HandlerResult {
    const parsed = SuperSyncDownloadOpsQuerySchema.safeParse(query);
    if (!parsed.success) return validationError(parsed.error.issues);
    const { sinceSeq, limit = 500, excludeClient, appVersion } = parsed.data;
    if (excludeClient) {
      touchDevice(this.db, userId, excludeClient, parseAppVersion(appVersion));
    }
    const maxLimit = Math.min(limit, 1000);
    const result = getOpsSinceWithSeq(
      this.db,
      userId,
      sinceSeq,
      excludeClient,
      maxLimit + 1,
    );
    const hasMore = result.ops.length > maxLimit;
    if (hasMore) result.ops.pop();
    return {
      status: 200,
      body: {
        ops: result.ops,
        hasMore,
        latestSeq: result.latestSeq,
        gapDetected: result.gapDetected || undefined,
        snapshotVectorClock: result.snapshotVectorClock,
        serverTime: Date.now(),
        capabilities: { causalRepairSnapshots: true },
      },
    };
  }

  // POST /api/sync/snapshot
  async uploadSnapshot(userId: number, body: unknown): Promise<HandlerResult> {
    const parsed = SuperSyncUploadSnapshotRequestSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error.issues);
    const {
      state,
      clientId,
      reason,
      vectorClock,
      schemaVersion,
      isPayloadEncrypted,
      opId,
      isCleanSlate,
      snapshotOpType,
      syncImportReason,
      repairBaseServerSeq,
      requestId,
    } = parsed.data;
    const shouldCleanSlate = snapshotOpType === 'REPAIR' ? false : isCleanSlate;
    const isLegacyRepairUpload =
      snapshotOpType === 'REPAIR' &&
      repairBaseServerSeq === undefined &&
      isCleanSlate === true;

    let memo: string | undefined;
    const getFingerprint = (): string =>
      (memo ??= fingerprint({
        state,
        clientId,
        reason,
        vectorClock,
        schemaVersion,
        isPayloadEncrypted,
        syncImportReason,
        opId,
        isCleanSlate: shouldCleanSlate,
        snapshotOpType,
        repairBaseServerSeq,
      }));

    if (requestId) {
      const cached = this.snapshotDedup.get(userId, requestId, getFingerprint);
      if (cached) return { status: 200, body: cached };
    }
    if (isCleanSlate && !opId) {
      return {
        status: 400,
        body: { error: 'opId is required for clean-slate snapshot idempotency' },
      };
    }

    const syncImportExists = (existing: {
      id: string;
      clientId: string;
    }): HandlerResult => ({
      status: 409,
      body: {
        error: 'SYNC_IMPORT_EXISTS',
        errorCode: 'SYNC_IMPORT_EXISTS',
        message:
          'A SYNC_IMPORT already exists. Download existing data and upload your changes as regular operations.',
        existingImportId: existing.id,
      },
    });

    if (reason === 'initial' && !shouldCleanSlate) {
      const existing = this.findExistingSyncImport(userId, opId);
      if (existing) {
        if (opId && existing.id === opId) {
          return { status: 200, body: { accepted: true, serverSeq: existing.serverSeq } };
        }
        return syncImportExists(existing);
      }
    }

    const op: Operation = {
      id: opId ?? randomUUID(),
      clientId,
      actionType: ACTION_TYPE_LOAD_ALL_DATA,
      opType: snapshotOpType ?? 'SYNC_IMPORT',
      entityType: 'ALL',
      payload: state,
      vectorClock,
      timestamp: Date.now(),
      schemaVersion: schemaVersion ?? 1,
      isPayloadEncrypted: isPayloadEncrypted ?? false,
      syncImportReason,
      repairBaseServerSeq,
    };

    // Durable idempotency for destructive clean-slate and REPAIR uploads.
    if ((shouldCleanSlate || snapshotOpType === 'REPAIR') && opId) {
      const existing = findOperationById(this.db, opId);
      if (existing) {
        const existingOperation: Operation = {
          id: existing.id,
          clientId: existing.clientId,
          actionType: existing.actionType,
          opType: existing.opType as Operation['opType'],
          entityType: existing.entityType,
          entityId: existing.entityId ?? undefined,
          entityIds: existing.entityIds,
          payload: existing.payload,
          vectorClock: existing.vectorClock,
          timestamp: op.timestamp,
          schemaVersion: existing.schemaVersion,
          isPayloadEncrypted: existing.isPayloadEncrypted,
          syncImportReason: existing.syncImportReason ?? undefined,
          repairBaseServerSeq: existing.repairBaseServerSeq ?? undefined,
        };
        const isExactRetry =
          existing.userId === userId &&
          ['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR'].includes(existing.opType) &&
          isSameIncomingOperation(existingOperation, op, 0, 0);
        return {
          status: 200,
          body: isExactRetry
            ? { accepted: true, serverSeq: existing.serverSeq }
            : {
                accepted: false,
                error: 'Operation ID already belongs to a different operation',
                errorCode: SYNC_ERROR_CODES.INVALID_OP_ID,
              },
        };
      }
    }

    if (snapshotOpType === 'REPAIR' && !isLegacyRepairUpload) {
      const current = getLatestSeq(this.db, userId);
      if (repairBaseServerSeq === undefined || repairBaseServerSeq !== current) {
        return {
          status: 200,
          body: {
            accepted: false,
            error: 'REPAIR snapshot does not include current server state',
            errorCode: SYNC_ERROR_CODES.REPAIR_STALE,
          },
        };
      }
    }

    const onAccepted = this.prepareUpload
      ? await this.prepareUpload(userId, [op])
      : undefined;

    // Re-check the initial-import rule now that async work may have let
    // another request commit (still before our own transaction).
    if (reason === 'initial' && !shouldCleanSlate) {
      const existing = this.findExistingSyncImport(userId, opId);
      if (existing) {
        if (opId && existing.id === opId) {
          return { status: 200, body: { accepted: true, serverSeq: existing.serverSeq } };
        }
        return syncImportExists(existing);
      }
    }

    const historyReset = this.historyReset;
    const results = uploadOps(this.db, userId, clientId, [op], this.config, {
      isCleanSlate: shouldCleanSlate,
      repairBaseServerSeq,
      allowLegacyRepairWithoutBase: isLegacyRepairUpload,
      onAccepted: (db, uid, accepted, ctx) => {
        if (ctx.cleanSlate) historyReset?.(db, uid);
        onAccepted?.(db, uid, accepted, ctx);
      },
    });
    let finalResult = results[0];

    if (
      !finalResult.accepted &&
      finalResult.errorCode === SYNC_ERROR_CODES.DUPLICATE_OPERATION &&
      opId
    ) {
      const existing = findOperationById(this.db, opId);
      if (existing && existing.userId === userId) {
        finalResult = { opId, accepted: true, serverSeq: existing.serverSeq };
      }
    }
    if (shouldCleanSlate && finalResult.accepted) {
      this.clearCachesForUser(userId);
    }
    if (finalResult.accepted && finalResult.serverSeq !== undefined) {
      this.notify(userId, clientId, finalResult.serverSeq);
    }

    const responseBody: Record<string, unknown> = {
      accepted: finalResult.accepted,
      serverSeq: finalResult.serverSeq,
      error: finalResult.error,
      errorCode: finalResult.errorCode,
    };
    if (
      requestId &&
      finalResult.errorCode !== SYNC_ERROR_CODES.DUPLICATE_OPERATION &&
      finalResult.errorCode !== SYNC_ERROR_CODES.INTERNAL_ERROR
    ) {
      this.snapshotDedup.set(userId, requestId, responseBody, getFingerprint());
    }
    return { status: 200, body: responseBody };
  }

  private findExistingSyncImport(
    userId: number,
    incomingOpId?: string,
  ): { id: string; clientId: string; serverSeq: number } | undefined {
    if (incomingOpId) {
      const exact = findOperationById(this.db, incomingOpId);
      if (
        exact &&
        exact.userId === userId &&
        ['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR'].includes(exact.opType)
      ) {
        return { id: exact.id, clientId: exact.clientId, serverSeq: exact.serverSeq };
      }
    }
    return findLatestFullStateOp(this.db, userId);
  }

  // GET /api/sync/status
  status(userId: number): HandlerResult {
    const latestSeq = getLatestSeq(this.db, userId);
    const devicesOnline = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS c FROM sync_devices WHERE user_id = ? AND last_seen_at >= ?',
        )
        .get(userId, Date.now() - ONLINE_DEVICE_THRESHOLD_MS) as { c: number }
    ).c;
    const used = (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(payload_bytes), 0) AS b FROM operations WHERE user_id = ?',
        )
        .get(userId) as { b: number }
    ).b;
    return {
      status: 200,
      body: {
        latestSeq,
        devicesOnline,
        storageUsedBytes: Number(used),
        // Self-hosted: no quota. Report a large ceiling so clients never warn.
        storageQuotaBytes: Number.MAX_SAFE_INTEGER,
      },
    };
  }

  // GET /api/sync/devices
  devices(userId: number): HandlerResult {
    const devices = this.db
      .prepare(
        'SELECT client_id AS clientId, last_seen_at AS lastSeenAt FROM sync_devices WHERE user_id = ? ORDER BY last_seen_at DESC',
      )
      .all(userId);
    return { status: 200, body: { devices } };
  }

  // GET /api/sync/restore-points
  restorePoints(userId: number, limitParam: string | undefined): HandlerResult {
    const limit = limitParam ? parseInt(limitParam, 10) : 30;
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return { status: 400, body: { error: 'Invalid limit parameter (must be 1-100)' } };
    }
    const rows = this.db
      .prepare(
        `SELECT server_seq, client_id, op_type, client_timestamp FROM operations
         WHERE user_id = ? AND (op_type IN ('SYNC_IMPORT', 'BACKUP_IMPORT')
           OR (op_type = 'REPAIR' AND repair_base_server_seq IS NOT NULL))
         ORDER BY server_seq DESC LIMIT ?`,
      )
      .all(userId, limit) as Array<{
      server_seq: number;
      client_id: string;
      op_type: string;
      client_timestamp: number;
    }>;
    const describe = (t: string): string =>
      t === 'SYNC_IMPORT'
        ? 'Full sync import'
        : t === 'BACKUP_IMPORT'
          ? 'Backup restore'
          : t === 'REPAIR'
            ? 'Auto-repair'
            : 'State snapshot';
    return {
      status: 200,
      body: {
        restorePoints: rows.map((r) => ({
          serverSeq: r.server_seq,
          timestamp: Number(r.client_timestamp),
          type: r.op_type,
          clientId: r.client_id,
          description: describe(r.op_type),
        })),
      },
    };
  }

  // GET /api/sync/restore/:serverSeq
  restore(
    userId: number,
    serverSeqParam: string,
    generate?: (userId: number, targetSeq: number) => unknown,
  ): HandlerResult {
    const targetSeq = parseInt(serverSeqParam, 10);
    if (isNaN(targetSeq) || targetSeq < 1) {
      return {
        status: 400,
        body: { error: 'Invalid serverSeq parameter (must be a positive integer)' },
      };
    }
    const latest = getLatestSeq(this.db, userId);
    if (targetSeq > latest) {
      return {
        status: 400,
        body: { error: `Target sequence ${targetSeq} exceeds latest sequence ${latest}` },
      };
    }
    if (generate) {
      return {
        status: 200,
        body: {
          state: generate(userId, targetSeq),
          serverSeq: targetSeq,
          generatedAt: Date.now(),
        },
      };
    }
    return {
      status: 400,
      body: {
        error:
          'Server-side restore is not available for encrypted data. Use the app to restore locally.',
        errorCode: SYNC_ERROR_CODES.ENCRYPTED_OPS_NOT_SUPPORTED,
      },
    };
  }

  // DELETE /api/sync/data
  deleteAllData(
    userId: number,
    onDeleted?: (db: Db, userId: number) => void,
  ): HandlerResult {
    transaction(this.db, () => {
      this.db
        .prepare('INSERT OR IGNORE INTO sync_state (user_id, last_seq) VALUES (?, 0)')
        .run(userId);
      this.db
        .prepare(
          `UPDATE sync_state SET latest_full_state_seq = NULL,
             latest_full_state_vector_clock = NULL, latest_state_replacement_seq = NULL
           WHERE user_id = ?`,
        )
        .run(userId);
      deleteAllOperations(this.db, userId);
      this.db.prepare('DELETE FROM sync_devices WHERE user_id = ?').run(userId);
      this.historyReset?.(this.db, userId);
      onDeleted?.(this.db, userId);
    });
    this.clearCachesForUser(userId);
    return { status: 200, body: { success: true } };
  }
}
