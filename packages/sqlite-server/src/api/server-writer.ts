/**
 * Server-authored writes (REST API / MCP).
 *
 * The server acts as one more sync client (`SERVER_CLIENT_ID`): it dispatches
 * the app's own actions through the bundled reducers, derives the op exactly
 * like OperationLogEffects does, gives it a vector clock that causally
 * dominates every touched entity and the latest full-state import, encrypts
 * the payload when the user syncs encrypted, and stores it through the normal
 * upload path (validation + conflict detection). Clients then receive it like
 * any other remote op. No domain rule is re-implemented here.
 */
import { uuidv7 } from './uuidv7';
import { encrypt, mergeVectorClocks } from '@sp/sync-core';
import { Db } from '../db/database';
import type { EngineState } from '../engine/engine-api';
import type { EncryptionKeyProvider } from '../projection/encryption-keys';
import { Projector, UserCache } from '../projection/projector';
import { aggregateVectorClock, findLatestOpForEntity } from '../sync/op-store';
import { SyncService } from '../sync/sync-service';
import { uploadOps } from '../sync/upload';
import { DEFAULT_SYNC_CONFIG, Operation, VectorClock } from '../sync/types';

export const SERVER_CLIENT_ID = 'sp_sqlite_server';

export class WriteConflictError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'WriteConflictError';
  }
}

export type ActionBuilder = (
  state: EngineState,
) => Array<{ type: string } & Record<string, unknown>>;

export class ServerWriter {
  constructor(
    private readonly db: Db,
    private readonly projector: Projector,
    private readonly sync: SyncService,
    private readonly keys: EncryptionKeyProvider,
  ) {}

  get engine(): Projector['engine'] {
    return this.projector.engine;
  }

  /** Reads the caught-up state (no write). */
  read<T>(userId: number, fn: (state: EngineState) => T): Promise<T> {
    return this.projector.withCurrentState(userId, async ({ cache }) => fn(cache.state));
  }

  /**
   * Builds actions from the current state, persists them as ops and returns
   * `select(newState)` after they were applied by the projector.
   */
  write<T>(
    userId: number,
    build: ActionBuilder,
    select: (state: EngineState) => T,
  ): Promise<T> {
    return this.projector.withCurrentState(userId, async ({ cache, refresh }) => {
      const ops = await this.buildOps(userId, cache, build);
      if (ops.length > 0) {
        const results = uploadOps(
          this.db,
          userId,
          SERVER_CLIENT_ID,
          ops,
          DEFAULT_SYNC_CONFIG,
        );
        const failed = results.find((r) => !r.accepted);
        if (failed) {
          throw new WriteConflictError(
            failed.error ?? 'Write rejected',
            failed.errorCode,
          );
        }
        const latestSeq = Math.max(...results.map((r) => r.serverSeq ?? 0));
        this.sync.notifyCommitted(userId, SERVER_CLIENT_ID, latestSeq);
      }
      const after = await refresh();
      return select(after.state);
    });
  }

  private lastOwnCounter(userId: number): number {
    const row = this.db
      .prepare(
        'SELECT vector_clock FROM operations WHERE user_id = ? AND client_id = ? ORDER BY server_seq DESC LIMIT 1',
      )
      .get(userId, SERVER_CLIENT_ID) as { vector_clock: string } | undefined;
    return row
      ? ((JSON.parse(row.vector_clock) as VectorClock)[SERVER_CLIENT_ID] ?? 0)
      : 0;
  }

  private usesEncryption(userId: number): boolean {
    const row = this.db
      .prepare(
        'SELECT is_payload_encrypted FROM operations WHERE user_id = ? AND client_id <> ? ORDER BY server_seq DESC LIMIT 1',
      )
      .get(userId, SERVER_CLIENT_ID) as { is_payload_encrypted: number } | undefined;
    return row?.is_payload_encrypted === 1;
  }

  private async buildOps(
    userId: number,
    cache: UserCache,
    build: ActionBuilder,
  ): Promise<Operation[]> {
    const { engine } = this.projector;
    let state = cache.state;
    const actions = build(state);
    const encryptWith = this.keys.getPassword(userId);
    if (this.usesEncryption(userId) && !encryptWith) {
      throw new WriteConflictError(
        'This account syncs encrypted; configure its encryption password on the server first',
        'NEEDS_KEY',
      );
    }
    let counter = this.lastOwnCounter(userId);
    // The server has applied every stored op, so its clock is the merge of all
    // of them (like a fully synced client) plus the latest import; ops it
    // authors therefore causally follow everything devices uploaded so far.
    let runningClock: VectorClock = mergeVectorClocks(
      aggregateVectorClock(this.db, userId, {}),
      state.latestImport?.vectorClock ?? {},
    );
    const ops: Operation[] = [];
    for (const action of actions) {
      const res = await engine.dispatchLocal(state, action);
      state = res.state;
      if (!res.op) continue;
      // Dominate the latest op of every touched entity (server conflict check)
      // and the latest import (client-side SYNC_IMPORT filter).
      const touched = new Set([
        ...(res.op.entityIds ?? []),
        ...(res.op.entityId ? [res.op.entityId] : []),
      ]);
      for (const entityId of touched) {
        const latest = findLatestOpForEntity(
          this.db,
          userId,
          res.op.entityType,
          entityId,
        );
        if (latest) runningClock = mergeVectorClocks(runningClock, latest.vectorClock);
      }
      counter = Math.max(counter, runningClock[SERVER_CLIENT_ID] ?? 0) + 1;
      runningClock = { ...runningClock, [SERVER_CLIENT_ID]: counter };
      const plainPayload = res.op.payload;
      const payload = encryptWith
        ? await encrypt(JSON.stringify(plainPayload), encryptWith)
        : plainPayload;
      ops.push({
        id: uuidv7(),
        clientId: SERVER_CLIENT_ID,
        actionType: res.op.actionType,
        opType: res.op.opType as Operation['opType'],
        entityType: res.op.entityType,
        entityId: res.op.entityId,
        entityIds: res.op.entityIds,
        payload,
        vectorClock: { ...runningClock },
        timestamp: Date.now(),
        schemaVersion: engine.currentSchemaVersion,
        isPayloadEncrypted: !!encryptWith,
      });
    }
    return ops;
  }
}
