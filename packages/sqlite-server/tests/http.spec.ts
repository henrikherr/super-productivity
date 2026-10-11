import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { RunningServer } from '../src/index';
import { ServerConfig, validateConfig } from '../src/config';
import { createUser, issueToken } from '../src/auth/tokens';
import { runCli } from '../src/cli';
import { makeOp, makeTmpDir, removeTmpDir, startTestServer } from './helpers';

// Response bodies are asserted structurally; a loose type keeps the tests readable.
const json = async (res: Response): Promise<any> => res.json();

const baseConfig = (
  dir: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig => ({
  dbPath: join(dir, 'server.sqlite'),
  host: '127.0.0.1',
  port: 0,
  testMode: false,
  corsOrigins: ['https://app.example.test'],
  backupIntervalMinutes: 60,
  backupKeep: 2,
  projection: false,
  ...overrides,
});

describe('HTTP server', () => {
  let dir: string;
  let server: RunningServer | undefined;
  let token: string;

  beforeEach(async () => {
    dir = makeTmpDir();
    server = await startTestServer(baseConfig(dir));
    const user = createUser(server.db, 'henrik@example.test');
    token = issueToken(server.db, user.id, 'sync').token;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    removeTmpDir(dir);
  });

  const call = (
    path: string,
    init: RequestInit & { auth?: string | null } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    const auth = init.auth === undefined ? token : init.auth;
    if (auth) headers.set('Authorization', `Bearer ${auth}`);
    return fetch(`${server!.url}${path}`, { ...init, headers });
  };

  it('serves /health without auth and rejects sync calls without a valid token', async () => {
    expect((await call('/health', { auth: null })).status).toBe(200);
    const info = await call('/', { auth: null });
    expect(info.headers.get('content-type')).toContain('text/html');
    expect(await info.text()).toContain('token issue');
    const missing = await call('/api/sync/ops?sinceSeq=0', { auth: null });
    expect(missing.status).toBe(401);
    expect(
      (await call('/api/sync/ops?sinceSeq=0', { auth: 'spsq_invalid' })).status,
    ).toBe(401);
    expect((await call('/api/sync/nope')).status).toBe(404);
    expect((await call('/api/sync/ops', { method: 'PUT' })).status).toBe(405);
  });

  it('rejects REST-scoped tokens on sync endpoints (403)', async () => {
    const apiToken = issueToken(server!.db, 1, 'api-write').token;
    expect((await call('/api/sync/ops?sinceSeq=0', { auth: apiToken })).status).toBe(403);
  });

  it('accepts gzip and base64-gzip uploads like the real clients send', async () => {
    const op1 = makeOp({ vectorClock: { clientA: 1 } });
    const res1 = await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([
        ['Content-Type', 'application/json'],
        ['Content-Encoding', 'gzip'],
      ]),
      body: gzipSync(
        JSON.stringify({ ops: [op1], clientId: 'clientA', requestId: 'r1' }),
      ),
    });
    expect(res1.status).toBe(200);
    expect((await json(res1)).results[0]).toMatchObject({ accepted: true, serverSeq: 1 });

    const op2 = makeOp({ vectorClock: { clientA: 2 } });
    const res2 = await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([
        ['Content-Type', 'application/json'],
        ['Content-Encoding', 'gzip'],
        ['Content-Transfer-Encoding', 'base64'],
      ]),
      body: gzipSync(JSON.stringify({ ops: [op2], clientId: 'clientA' })).toString(
        'base64',
      ),
    });
    expect((await json(res2)).results[0]).toMatchObject({ accepted: true, serverSeq: 2 });

    const dl = await json(await call('/api/sync/ops?sinceSeq=0'));
    expect(dl.ops.map((o: { op: { id: string } }) => o.op.id)).toEqual([op1.id, op2.id]);
    expect(dl.capabilities).toEqual({ causalRepairSnapshots: true });
  });

  it('rejects broken bodies with 400/415 and oversized bodies with 413', async () => {
    const bad = await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([['Content-Encoding', 'gzip']]),
      body: 'not gzip',
    });
    expect(bad.status).toBe(400);
    const br = await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([['Content-Encoding', 'br']]),
      body: '{}',
    });
    expect(br.status).toBe(415);
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const tooBig = await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([['Content-Encoding', 'gzip']]),
      body: bomb,
    });
    expect(tooBig.status).toBe(413);
  });

  it('keeps data across a full server restart', async () => {
    const op = makeOp({ vectorClock: { clientA: 1 } });
    await call('/api/sync/ops', {
      method: 'POST',
      headers: new Headers([['Content-Type', 'application/json']]),
      body: JSON.stringify({ ops: [op], clientId: 'clientA' }),
    });
    await server!.close();
    server = await startTestServer(baseConfig(dir));
    const dl = await json(await call('/api/sync/ops?sinceSeq=0'));
    expect(dl.latestSeq).toBe(1);
    expect(dl.ops[0].op.id).toBe(op.id);
  });

  it('refuses a second server on the same database file', async () => {
    await expect(startTestServer(baseConfig(dir))).rejects.toThrow(/already used/);
  });

  it('answers CORS preflights only for configured origins', async () => {
    const ok = await fetch(`${server!.url}/api/sync/ops`, {
      method: 'OPTIONS',
      headers: new Headers([
        ['Origin', 'https://app.example.test'],
        ['Access-Control-Request-Method', 'POST'],
      ]),
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.test',
    );
    expect(ok.headers.get('access-control-allow-headers')).toContain('Content-Encoding');
    const evil = await fetch(`${server!.url}/api/sync/ops`, {
      method: 'OPTIONS',
      headers: new Headers([
        ['Origin', 'https://evil.example'],
        ['Access-Control-Request-Method', 'POST'],
      ]),
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('replace-token issues a new sync token and revokes the old one', async () => {
    const res = await call('/api/replace-token', { method: 'POST' });
    const { token: next } = await json(res);
    expect((await call('/api/sync/status', { auth: next })).status).toBe(200);
    expect((await call('/api/sync/status')).status).toBe(401);
  });

  it('does not expose test routes unless SP_TEST_MODE is set', async () => {
    const res = await call('/api/test/create-user', {
      method: 'POST',
      auth: null,
      body: JSON.stringify({ email: 'x@y.z', password: 'whatever1' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('HTTP server in test mode', () => {
  it('implements the E2E helper contract (create-user, cleanup, delete user)', async () => {
    const dir = makeTmpDir();
    const server = await startTestServer(baseConfig(dir, { testMode: true }));
    try {
      const create = await fetch(`${server.url}/api/test/create-user`, {
        method: 'POST',
        body: JSON.stringify({ email: 'e2e@e2e.local', password: 'TestPassword123!' }),
      });
      expect(create.status).toBe(201);
      const { token, userId } = await json(create);
      const op = makeOp({ vectorClock: { clientA: 1 } });
      await fetch(`${server.url}/api/sync/ops`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ops: [op], clientId: 'clientA' }),
      });
      // Re-creating the same user wipes its data (fresh test state).
      const again = await json(
        await fetch(`${server.url}/api/test/create-user`, {
          method: 'POST',
          body: JSON.stringify({ email: 'e2e@e2e.local', password: 'TestPassword123!' }),
        }),
      );
      expect(again.userId).toBe(userId);
      const dl = await json(
        await fetch(`${server.url}/api/sync/ops?sinceSeq=0`, {
          headers: { Authorization: `Bearer ${again.token}` },
        }),
      );
      expect(dl.ops).toHaveLength(0);
      expect(
        (await fetch(`${server.url}/api/test/user/${userId}`, { method: 'DELETE' }))
          .status,
      ).toBe(200);
      expect(
        (await fetch(`${server.url}/api/test/cleanup`, { method: 'POST' })).status,
      ).toBe(200);
    } finally {
      await server.close();
      removeTmpDir(dir);
    }
  });
});

describe('config safety', () => {
  const cfg = (o: Partial<ServerConfig>): ServerConfig => baseConfig('x', o);
  it('refuses non-loopback binds unless explicitly allowed', () => {
    expect(() => validateConfig(cfg({ host: '0.0.0.0' }), false)).toThrow(/non-loopback/);
    expect(() => validateConfig(cfg({ host: '100.64.0.5' }), true)).not.toThrow();
    expect(() => validateConfig(cfg({ host: '::1' }), false)).not.toThrow();
  });
  it('refuses test mode off loopback and wildcard CORS', () => {
    expect(() => validateConfig(cfg({ host: '0.0.0.0', testMode: true }), true)).toThrow(
      /TEST_MODE/,
    );
    expect(() => validateConfig(cfg({ corsOrigins: ['*'] }), false)).toThrow(/explicit/);
  });
});

describe('CLI', () => {
  it('creates users, issues/lists/revokes tokens and writes backups', async () => {
    const dir = makeTmpDir();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    const db = ['--db', join(dir, 'cli.sqlite')];
    try {
      expect(await runCli([...db, 'user', 'add', 'henrik@example.test'], io)).toBe(0);
      expect(
        await runCli(
          [...db, 'token', 'issue', 'henrik@example.test', 'api-read', 'mcp'],
          io,
        ),
      ).toBe(0);
      expect(out.at(-1)).toMatch(/^spsq_/);
      expect(
        await runCli([...db, 'token', 'issue', 'henrik@example.test', 'root'], io),
      ).toBe(1);
      expect(await runCli([...db, 'token', 'list', 'henrik@example.test'], io)).toBe(0);
      expect(out.at(-1)).toMatch(/api-read\tmcp\tactive/);
      expect(await runCli([...db, 'token', 'revoke', '1'], io)).toBe(0);
      expect(await runCli([...db, 'backup', join(dir, 'bk')], io)).toBe(0);
      expect(out.at(-1)).toMatch(/superprod-.*\.sqlite$/);
      expect(await runCli([...db, 'migrate'], io)).toBe(0);
      expect(
        await runCli([...db, 'projection', 'rebuild', 'henrik@example.test'], io),
      ).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: 'ok', applied_seq: 0 });
      expect(
        await runCli([...db, 'projection', 'status', 'nobody@example.test'], io),
      ).toBe(1);
    } finally {
      removeTmpDir(dir);
    }
  });
});

describe('static web app (SP_WEB_ROOT)', () => {
  it('serves files, falls back to index.html for routes and blocks traversal', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = makeTmpDir();
    const web = join(dir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<html>app</html>');
    writeFileSync(join(web, 'main.abc123.js'), 'console.log(1)');
    writeFileSync(join(web, 'assets', 'logo.svg'), '<svg/>');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    const server = await startTestServer(baseConfig(dir, { webRoot: web }));
    try {
      const index = await fetch(`${server.url}/`);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(index.headers.get('cache-control')).toBe('no-cache');
      expect(await index.text()).toBe('<html>app</html>');
      const js = await fetch(`${server.url}/main.abc123.js`);
      expect(js.headers.get('cache-control')).toContain('immutable');
      expect(await (await fetch(`${server.url}/assets/logo.svg`)).text()).toBe('<svg/>');
      expect(await (await fetch(`${server.url}/tag/TODAY/tasks`)).text()).toBe(
        '<html>app</html>',
      );
      expect((await fetch(`${server.url}/missing.js`)).status).toBe(404);
      expect((await fetch(`${server.url}/..%2fsecret.txt`)).status).toBe(404);
      expect((await fetch(`${server.url}/api/unknown`)).status).toBe(404);
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
    } finally {
      await server.close();
      removeTmpDir(dir);
    }
  });
});
