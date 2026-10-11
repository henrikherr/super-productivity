/**
 * Projector: turns the authoritative op log into the relational projection.
 *
 * - Runs AFTER ops are committed (sync never waits for or fails because of it).
 * - Processes users one batch at a time on a single global queue; the bundled
 *   engine holds one global context, so it must never run concurrently.
 * - Each batch: read ops > applied_seq → decrypt (ADR-9) → engine.applyOperations
 *   (client remote-apply semantics) → write table diff + new applied_seq in ONE
 *   transaction. A crash at any point leaves the previous consistent projection;
 *   the next run resumes from the stored cursor.
 * - Optimistic check inside the write transaction: if the cursor moved or the
 *   user's history was reset meanwhile (clean slate, delete), the batch is
 *   discarded and recomputed.
 */
import { decrypt } from '@sp/sync-core';
import { Db, transaction } from '../db/database';
import type { AppData, EngineOperation, EngineState } from '../engine/engine-api';
import type { LoadedEngine } from '../engine/engine-loader';
import { getOperationsInRange, getSyncState, StoredOperation } from '../sync/op-store';
import type { EncryptionKeyProvider } from './encryption-keys';
import {
  getProjectionStatus,
  loadProjectedAppData,
  markerFromJson,
  markerToJson,
  resetProjection,
  setProjectionStatus,
  verifyProjectedAppData,
  writeProjectionDiff,
} from './projection-store';

export interface UserCache {
  state: EngineState;
  appData: AppData;
  appliedSeq: number;
  generation: number;
}

export interface ProjectorOptions {
  batchSize?: number;
}

export class ProjectionUnavailableError extends Error {
  constructor(
    readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectionUnavailableError';
  }
}

export class Projector {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<number, UserCache>();
  private readonly generations = new Map<number, number>();
  private readonly batchSize: number;

  constructor(
    private readonly db: Db,
    private readonly loaded: LoadedEngine,
    private readonly keys: EncryptionKeyProvider,
    options: ProjectorOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 200;
  }

  get engine(): LoadedEngine['engine'] {
    return this.loaded.engine;
  }

  private generation(userId: number): number {
    return this.generations.get(userId) ?? 0;
  }

  /** Runs `fn` exclusively on the global engine queue. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Must be called INSIDE the transaction that deletes a user's history
   * (clean-slate upload, DELETE /api/sync/data, test reset).
   */
  resetUserInTransaction(db: Db, userId: number): void {
    resetProjection(db, userId);
    this.generations.set(userId, this.generation(userId) + 1);
    this.cache.delete(userId);
  }

  /** Ensures the projection reflects every committed op of the user. */
  catchUp(userId: number): Promise<UserCache> {
    return this.runExclusive(() => this.catchUpNow(userId));
  }

  /** Discards the projection and rebuilds it from the op log. */
  rebuild(userId: number): Promise<UserCache> {
    return this.runExclusive(async () => {
      transaction(this.db, () => this.resetUserInTransaction(this.db, userId));
      return this.catchUpNow(userId);
    });
  }

  /**
   * Runs `fn` exclusively with the caught-up state of a healthy projection.
   * `refresh()` re-runs the catch-up inside the same exclusive section (used
   * after the caller committed new ops).
   */
  withCurrentState<T>(
    userId: number,
    fn: (ctx: { cache: UserCache; refresh: () => Promise<UserCache> }) => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(async () => {
      const cache = await this.catchUpNow(userId);
      const status = getProjectionStatus(this.db, userId);
      if (status && status.status !== 'ok') {
        throw new ProjectionUnavailableError(
          status.status,
          status.last_error ?? status.status,
        );
      }
      return fn({ cache, refresh: () => this.catchUpNow(userId) });
    });
  }

  /** Current projected state (after catching up) or a typed error explaining why not. */
  async getCurrentState(userId: number): Promise<UserCache> {
    const cache = await this.catchUp(userId);
    const status = getProjectionStatus(this.db, userId);
    if (status && status.status !== 'ok') {
      throw new ProjectionUnavailableError(
        status.status,
        status.last_error ?? status.status,
      );
    }
    return cache;
  }

  private loadUser(userId: number): UserCache {
    const cached = this.cache.get(userId);
    if (cached && cached.generation === this.generation(userId)) return cached;
    const { engine } = this.loaded;
    const status = getProjectionStatus(this.db, userId);
    const stale =
      !status ||
      status.engine_schema_version !== engine.currentSchemaVersion ||
      status.engine_revision !== this.loaded.revision;
    if (status && stale) {
      // Projection was built by a different engine: rebuild from the op log
      // so derived data always matches the running server's rules.
      console.log(
        `[projector] user ${userId}: engine changed (${status.engine_revision} → ${this.loaded.revision}), rebuilding`,
      );
      transaction(this.db, () => this.resetUserInTransaction(this.db, userId));
    }
    const current = getProjectionStatus(this.db, userId);
    let state: EngineState;
    let appData: AppData;
    const stored = current ? loadProjectedAppData(this.db, userId) : undefined;
    if (current && !stored && current.applied_seq === 0) {
      // Status row only (e.g. 'needs_key' before the first successful batch).
      state = engine.createInitialState();
      appData = engine.toAppData(state);
    } else if (current) {
      const problems = stored ? verifyProjectedAppData(stored) : ['no data'];
      if (!stored || problems.length) {
        console.error(
          `[projector] user ${userId}: stored projection invalid (${problems.join('; ')}), rebuilding`,
        );
        transaction(this.db, () => this.resetUserInTransaction(this.db, userId));
        return this.loadUser(userId);
      }
      state = {
        ...engine.fromAppData(stored),
        latestImport: markerFromJson(current.latest_import),
      };
      appData = engine.toAppData(state);
    } else {
      state = engine.createInitialState();
      appData = engine.toAppData(state);
    }
    const entry: UserCache = {
      state,
      appData,
      appliedSeq: current?.applied_seq ?? 0,
      generation: this.generation(userId),
    };
    this.cache.set(userId, entry);
    return entry;
  }

  private async decryptOps(
    userId: number,
    ops: StoredOperation[],
  ): Promise<EngineOperation[]> {
    const needsKey = ops.some((o) => o.isPayloadEncrypted);
    const password = needsKey ? this.keys.getPassword(userId) : undefined;
    if (needsKey && !password) {
      throw new ProjectionUnavailableError(
        'needs_key',
        'Encrypted data: configure the sync encryption password for this user (SP_ENCRYPTION_KEY_FILE)',
      );
    }
    const out: EngineOperation[] = [];
    for (const o of ops) {
      let payload = o.payload;
      if (o.isPayloadEncrypted) {
        if (typeof payload !== 'string') {
          throw new ProjectionUnavailableError(
            'error',
            `Op ${o.id} flagged encrypted but payload is not a string`,
          );
        }
        try {
          payload = JSON.parse(await decrypt(payload, password!)) as unknown;
        } catch {
          throw new ProjectionUnavailableError(
            'needs_key',
            'Cannot decrypt synced data: the configured encryption password is wrong',
          );
        }
      }
      out.push({
        id: o.id,
        clientId: o.clientId,
        actionType: o.actionType,
        opType: o.opType,
        entityType: o.entityType,
        entityId: o.entityId ?? undefined,
        entityIds: o.entityIds.length ? o.entityIds : undefined,
        payload,
        vectorClock: o.vectorClock,
        timestamp: o.clientTimestamp,
        schemaVersion: o.schemaVersion,
        syncImportReason: o.syncImportReason ?? undefined,
        repairBaseServerSeq: o.repairBaseServerSeq ?? undefined,
      });
    }
    return out;
  }

  private async catchUpNow(userId: number): Promise<UserCache> {
    const { engine } = this.loaded;
    for (let guard = 0; guard < 100_000; guard++) {
      const user = this.loadUser(userId);
      const latestSeq = getSyncState(this.db, userId)?.last_seq ?? 0;
      if (user.appliedSeq >= latestSeq) {
        const hasStoredModels =
          this.db
            .prepare('SELECT 1 FROM projection_model WHERE user_id = ? LIMIT 1')
            .get(userId) !== undefined;
        if (!hasStoredModels) {
          // Nothing to apply yet: persist the empty projection once.
          transaction(this.db, () => {
            writeProjectionDiff(this.db, userId, undefined, user.appData);
            setProjectionStatus(this.db, userId, {
              applied_seq: user.appliedSeq,
              status: 'ok',
              engine_schema_version: engine.currentSchemaVersion,
              engine_revision: this.loaded.revision,
            });
          });
        }
        return user;
      }
      const stored = getOperationsInRange(
        this.db,
        userId,
        user.appliedSeq,
        latestSeq,
        this.batchSize,
      );
      if (stored.length === 0) return user;
      const generationAtStart = user.generation;

      let ops: EngineOperation[];
      try {
        ops = await this.decryptOps(userId, stored);
      } catch (err) {
        const e =
          err instanceof ProjectionUnavailableError
            ? err
            : new ProjectionUnavailableError('error', String(err));
        setProjectionStatus(this.db, userId, {
          status: e.status as never,
          last_error: e.message,
        });
        return user;
      }

      const result = await engine.applyOperations(user.state, ops);
      let processedUpTo = stored[stored.length - 1].serverSeq;
      let status: 'ok' | 'blocked' = 'ok';
      let lastError: string | null = null;
      if (result.blockedByNewerSchema) {
        const blockedIdx = stored.findIndex(
          (s) => s.id === result.blockedByNewerSchema!.opId,
        );
        processedUpTo =
          blockedIdx > 0 ? stored[blockedIdx - 1].serverSeq : user.appliedSeq;
        status = 'blocked';
        lastError =
          `Op ${result.blockedByNewerSchema.opId} uses schema ${result.blockedByNewerSchema.schemaVersion}; ` +
          `this server supports ${engine.currentSchemaVersion}. Update the server.`;
      }
      if (result.failures.length) {
        // Same as the clients: a reducer-rejected op is skipped, not retried.
        lastError =
          lastError ??
          `Skipped ${result.failures.length} op(s): ${result.failures
            .slice(0, 3)
            .map((f) => `${f.opId} (${f.stage}: ${f.error})`)
            .join('; ')}`;
        console.warn(`[projector] user ${userId}: ${lastError}`);
      }
      const nextAppData = engine.toAppData(result.state);
      const committed = transaction(this.db, () => {
        const dbStatus = getProjectionStatus(this.db, userId);
        if (
          this.generation(userId) !== generationAtStart ||
          (dbStatus?.applied_seq ?? 0) !== user.appliedSeq
        ) {
          return false;
        }
        const hasStoredModels =
          this.db
            .prepare('SELECT 1 FROM projection_model WHERE user_id = ? LIMIT 1')
            .get(userId) !== undefined;
        writeProjectionDiff(
          this.db,
          userId,
          hasStoredModels ? user.appData : undefined,
          nextAppData,
        );
        setProjectionStatus(this.db, userId, {
          applied_seq: processedUpTo,
          status,
          last_error: lastError,
          skipped_ops: (dbStatus?.skipped_ops ?? 0) + result.failures.length,
          latest_import: markerToJson(result.state.latestImport),
          engine_schema_version: engine.currentSchemaVersion,
          engine_revision: this.loaded.revision,
        });
        return true;
      });
      if (!committed) {
        this.cache.delete(userId);
        continue;
      }
      this.cache.set(userId, {
        state: result.state,
        appData: nextAppData,
        appliedSeq: processedUpTo,
        generation: generationAtStart,
      });
      if (status === 'blocked') return this.cache.get(userId)!;
    }
    throw new Error('projector: catch-up did not converge');
  }
}
