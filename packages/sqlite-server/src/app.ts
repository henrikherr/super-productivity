import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  authenticateToken,
  AuthenticatedToken,
  createUser,
  findUserByEmail,
  issueToken,
  revokeOtherSyncTokens,
  scopeAllows,
  TokenScope,
} from './auth/tokens';
import { ServerConfig } from './config';
import { Db, transaction } from './db/database';
import {
  DEFAULT_BODY_LIMITS,
  HttpError,
  OPS_BODY_LIMITS,
  readJsonBody,
  SNAPSHOT_BODY_LIMITS,
} from './http/body';
import { getBearerToken, RequestContext, Router, sendJson } from './http/router';
import { SyncWebSocketHub } from './http/websocket';
import { SuperSyncOperationSchema } from '@sp/shared-schema';
import { getStoredEntityIds } from './sync/conflict';
import {
  allocateServerSeq,
  deleteAllOperations,
  ensureSyncState,
  insertOperation,
} from './sync/op-store';
import { SyncService } from './sync/sync-service';
import { DEFAULT_SYNC_CONFIG, Operation, SyncConfig } from './sync/types';
import type { ProjectionModule } from './projection/projection-module';

export interface AppOptions {
  db: Db;
  config: Pick<ServerConfig, 'testMode' | 'corsOrigins'>;
  syncConfig?: SyncConfig;
}

/** Extension point for feature modules (REST API, WebSocket, static web app). */
export interface AppModule {
  register(app: App): void;
}

export class App {
  readonly db: Db;
  readonly sync: SyncService;
  readonly router = new Router();
  readonly ws: SyncWebSocketHub;
  /** Set when the relational projection is enabled. */
  projection?: ProjectionModule;
  private readonly corsOrigins: Set<string>;
  private readonly testMode: boolean;
  /** Fallback for unmatched GET requests (static web app). */
  fallbackGet?: (ctx: RequestContext) => Promise<boolean> | boolean;

  constructor(options: AppOptions) {
    this.db = options.db;
    this.sync = new SyncService(options.db, options.syncConfig ?? DEFAULT_SYNC_CONFIG);
    this.corsOrigins = new Set(options.config.corsOrigins);
    this.testMode = options.config.testMode;
    this.ws = new SyncWebSocketHub(this);
    this.sync.setHistoryResetHook((db, userId) => this.onUserDataDeleted?.(db, userId));
    this.sync.onNewOps((userId, clientId, latestSeq) =>
      this.ws.notifyNewOps(userId, clientId, latestSeq),
    );
    this.registerCoreRoutes();
    if (this.testMode) this.registerTestRoutes();
  }

  use(module: AppModule): this {
    module.register(this);
    return this;
  }

  /** Authenticates the request for `scope`; sends 401/403 and returns undefined on failure. */
  authenticate(ctx: RequestContext, scope: TokenScope): AuthenticatedToken | undefined {
    const token = getBearerToken(ctx.req);
    if (!token) {
      sendJson(ctx.res, 401, { error: 'Missing or invalid Authorization header' });
      return undefined;
    }
    const auth = authenticateToken(this.db, token);
    if (!auth) {
      sendJson(ctx.res, 401, { error: 'invalid_token' });
      return undefined;
    }
    if (!scopeAllows(auth.scope, scope)) {
      sendJson(ctx.res, 403, { error: 'insufficient_scope' });
      return undefined;
    }
    return auth;
  }

  private registerCoreRoutes(): void {
    const r = this.router;
    r.add('GET', '/health', (ctx) => sendJson(ctx.res, 200, { status: 'ok' }));

    r.add('POST', '/api/sync/ops', async (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const body = await readJsonBody(ctx.req, OPS_BODY_LIMITS);
      const result = await this.sync.uploadOps(auth.userId, body);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('GET', '/api/sync/ops', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.downloadOps(auth.userId, ctx.query);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('POST', '/api/sync/snapshot', async (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const body = await readJsonBody(ctx.req, SNAPSHOT_BODY_LIMITS);
      const result = await this.sync.uploadSnapshot(auth.userId, body);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('GET', '/api/sync/status', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.status(auth.userId);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('GET', '/api/sync/devices', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.devices(auth.userId);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('GET', '/api/sync/restore-points', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.restorePoints(auth.userId, ctx.query['limit']);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('GET', '/api/sync/restore/:serverSeq', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.restore(auth.userId, ctx.params['serverSeq']);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('DELETE', '/api/sync/data', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const result = this.sync.deleteAllData(auth.userId);
      sendJson(ctx.res, result.status, result.body);
    });
    r.add('POST', '/api/replace-token', (ctx) => {
      const auth = this.authenticate(ctx, 'sync');
      if (!auth) return;
      const issued = transaction(this.db, () => {
        const next = issueToken(this.db, auth.userId, 'sync', 'replace-token');
        revokeOtherSyncTokens(this.db, auth.userId, next.tokenId);
        return next;
      });
      sendJson(ctx.res, 200, { token: issued.token });
    });
  }

  /** Hook for derived data (projection) to wipe alongside the op log. */
  onUserDataDeleted?: (db: Db, userId: number) => void;

  private registerTestRoutes(): void {
    const r = this.router;
    r.add('POST', '/api/test/create-user', async (ctx) => {
      const body = (await readJsonBody(ctx.req, DEFAULT_BODY_LIMITS)) as
        | { email?: unknown }
        | undefined;
      const email = typeof body?.email === 'string' ? body.email : '';
      if (!email.includes('@')) {
        sendJson(ctx.res, 400, { error: 'email required' });
        return;
      }
      const user = transaction(this.db, () => {
        const existing = findUserByEmail(this.db, email);
        if (existing) {
          deleteAllOperations(this.db, existing.id);
          this.db.prepare('DELETE FROM sync_devices WHERE user_id = ?').run(existing.id);
          this.db.prepare('DELETE FROM sync_state WHERE user_id = ?').run(existing.id);
          this.onUserDataDeleted?.(this.db, existing.id);
          return existing;
        }
        return createUser(this.db, email);
      });
      const { token } = issueToken(this.db, user.id, 'sync', 'test');
      this.sync.clearCachesForUser(user.id);
      sendJson(ctx.res, 201, { token, userId: user.id, email: user.email });
    });
    r.add('POST', '/api/test/cleanup', (ctx) => {
      transaction(this.db, () => {
        const users = this.db.prepare('SELECT id FROM users').all() as Array<{
          id: number;
        }>;
        for (const u of users) this.onUserDataDeleted?.(this.db, u.id);
        this.db.exec(
          'DELETE FROM operation_entities; DELETE FROM operations; DELETE FROM sync_devices; DELETE FROM sync_state; DELETE FROM api_tokens; DELETE FROM users;',
        );
      });
      sendJson(ctx.res, 200, { cleaned: true });
    });
    r.add('POST', '/api/test/user/:userId/api-token', (ctx) => {
      const userId = Number(ctx.params['userId']);
      if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
        sendJson(ctx.res, 404, { error: 'User not found' });
        return;
      }
      sendJson(ctx.res, 201, {
        token: issueToken(this.db, userId, 'api-write', 'e2e').token,
      });
    });
    r.add('GET', '/api/test/user/:userId/ops', (ctx) => {
      const userId = Number(ctx.params['userId']);
      if (!Number.isInteger(userId)) {
        sendJson(ctx.res, 400, { error: 'Invalid userId' });
        return;
      }
      const limit = Number(ctx.query['limit'] ?? 10);
      const opType = ctx.query['opType'];
      const rows = (
        opType
          ? this.db
              .prepare(
                'SELECT id, client_id, op_type, server_seq, vector_clock FROM operations WHERE user_id = ? AND op_type = ? ORDER BY server_seq DESC LIMIT ?',
              )
              .all(userId, opType, limit)
          : this.db
              .prepare(
                'SELECT id, client_id, op_type, server_seq, vector_clock FROM operations WHERE user_id = ? ORDER BY server_seq DESC LIMIT ?',
              )
              .all(userId, limit)
      ) as Array<{
        id: string;
        client_id: string;
        op_type: string;
        server_seq: number;
        vector_clock: string;
      }>;
      sendJson(ctx.res, 200, {
        ops: rows.map((row) => ({
          id: row.id,
          clientId: row.client_id,
          opType: row.op_type,
          serverSeq: row.server_seq,
          vectorClock: JSON.parse(row.vector_clock),
        })),
      });
    });
    r.add('POST', '/api/test/user/:userId/legacy-plaintext-ops', async (ctx) => {
      const userId = Number(ctx.params['userId']);
      const body = (await readJsonBody(ctx.req, OPS_BODY_LIMITS)) as
        | { op?: unknown }
        | undefined;
      const parsed = SuperSyncOperationSchema.safeParse(body?.op);
      if (!Number.isInteger(userId) || !parsed.success) {
        sendJson(ctx.res, 400, { error: 'Invalid operation' });
        return;
      }
      const op = parsed.data as unknown as Operation;
      if (op.isPayloadEncrypted !== false) {
        sendJson(ctx.res, 400, {
          error: 'Legacy plaintext seed requires isPayloadEncrypted=false',
        });
        return;
      }
      const seeded = transaction(this.db, () => {
        if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId))
          return undefined;
        ensureSyncState(this.db, userId);
        const serverSeq = allocateServerSeq(this.db, userId);
        insertOperation(this.db, {
          op,
          userId,
          serverSeq,
          storedEntityIds: getStoredEntityIds(op),
          payloadBytes: Buffer.byteLength(JSON.stringify(op.payload)),
          receivedAt: Date.now(),
        });
        return { id: op.id, serverSeq };
      });
      if (!seeded) {
        sendJson(ctx.res, 404, { error: 'User not found' });
        return;
      }
      this.sync.notifyCommitted(userId, op.clientId, seeded.serverSeq);
      sendJson(ctx.res, 201, seeded);
    });
    r.add('DELETE', '/api/test/user/:userId/ops-after/:serverSeq', (ctx) => {
      const userId = Number(ctx.params['userId']);
      const serverSeq = Number(ctx.params['serverSeq']);
      if (!Number.isInteger(userId) || !Number.isInteger(serverSeq)) {
        sendJson(ctx.res, 400, { error: 'Invalid userId or serverSeq' });
        return;
      }
      // Simulates restoring a server backup taken at `serverSeq`.
      const deleted = transaction(this.db, () => {
        this.db
          .prepare('DELETE FROM operation_entities WHERE user_id = ? AND server_seq > ?')
          .run(userId, serverSeq);
        const count = this.db
          .prepare('DELETE FROM operations WHERE user_id = ? AND server_seq > ?')
          .run(userId, serverSeq).changes;
        this.db.prepare('DELETE FROM sync_state WHERE user_id = ?').run(userId);
        if (serverSeq > 0) {
          this.db
            .prepare('INSERT INTO sync_state (user_id, last_seq) VALUES (?, ?)')
            .run(userId, serverSeq);
        }
        this.onUserDataDeleted?.(this.db, userId);
        return count;
      });
      this.sync.clearCachesForUser(userId);
      sendJson(ctx.res, 200, { deleted, revertedToSeq: serverSeq });
    });
    r.add('DELETE', '/api/test/user/:userId', (ctx) => {
      const userId = Number(ctx.params['userId']);
      const deleted = transaction(this.db, () => {
        this.onUserDataDeleted?.(this.db, userId);
        deleteAllOperations(this.db, userId);
        return this.db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
      });
      sendJson(
        ctx.res,
        deleted ? 200 : 404,
        deleted ? { deleted: true } : { error: 'Not found' },
      );
    });
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin || !this.corsOrigins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Content-Encoding, Content-Transfer-Encoding, X-Requested-With',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    return true;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const corsAllowed = this.applyCors(req, res);
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = corsAllowed ? 204 : 403;
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const ctx: RequestContext = {
      req,
      res,
      method,
      path: url.pathname,
      query,
      params: {},
    };

    try {
      const match = this.router.match(method, url.pathname);
      if (match === undefined) {
        if (
          (method === 'GET' || method === 'HEAD') &&
          this.fallbackGet &&
          (await this.fallbackGet(ctx))
        ) {
          return;
        }
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      if (match === 'method') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      ctx.params = match.params;
      await match.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, errorCode: err.errorCode });
        return;
      }
      console.error(`[http] ${method} ${url.pathname} failed:`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  createHttpServer(): Server {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // Large snapshot uploads from slow mobile links.
    server.requestTimeout = 120_000;
    server.headersTimeout = 30_000;
    this.ws.attach(server);
    return server;
  }
}
