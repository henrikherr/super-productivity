import type { App, AppModule } from '../app';
import { sendJson } from '../http/router';
import { getProjectionStatus } from './projection-store';
import { Projector } from './projector';

/**
 * Wires the projector into the server: new ops trigger a catch-up, history
 * resets wipe derived data in the same transaction, and all users are caught
 * up at startup (resuming after crashes or engine updates).
 */
export class ProjectionModule implements AppModule {
  constructor(readonly projector: Projector) {}

  register(app: App): void {
    const previousReset = app.onUserDataDeleted;
    app.onUserDataDeleted = (db, userId) => {
      previousReset?.(db, userId);
      this.projector.resetUserInTransaction(db, userId);
    };
    app.sync.onNewOps((userId) => {
      this.projector.catchUp(userId).catch((err) => {
        console.error(`[projector] catch-up failed for user ${userId}:`, err);
      });
    });

    app.router.add('GET', '/api/v1/projection/status', async (ctx) => {
      const auth = app.authenticate(ctx, 'api-read');
      if (!auth) return;
      await this.projector.catchUp(auth.userId);
      const status = getProjectionStatus(app.db, auth.userId);
      sendJson(ctx.res, 200, {
        ok: true,
        data: {
          status: status?.status ?? 'ok',
          appliedSeq: status?.applied_seq ?? 0,
          lastError: status?.last_error ?? null,
          skippedOps: status?.skipped_ops ?? 0,
          engineSchemaVersion: status?.engine_schema_version ?? null,
          engineRevision: status?.engine_revision ?? null,
        },
      });
    });
    app.router.add('POST', '/api/v1/projection/rebuild', async (ctx) => {
      const auth = app.authenticate(ctx, 'api-write');
      if (!auth) return;
      const cache = await this.projector.rebuild(auth.userId);
      sendJson(ctx.res, 200, { ok: true, data: { appliedSeq: cache.appliedSeq } });
    });
  }

  /** Catches up every user (startup). */
  async catchUpAll(app: App): Promise<void> {
    const users = app.db.prepare('SELECT id FROM users ORDER BY id').all() as Array<{
      id: number;
    }>;
    for (const { id } of users) {
      try {
        await this.projector.catchUp(id);
      } catch (err) {
        console.error(`[projector] startup catch-up failed for user ${id}:`, err);
      }
    }
  }
}
