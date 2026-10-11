import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt, setArgon2ParamsForTesting } from '@sp/sync-core';
import { RunningServer } from '../src/index';
import { ServerConfig } from '../src/config';
import { createUser, issueToken } from '../src/auth/tokens';
import { loadEngine } from '../src/engine/engine-loader';
import type { EngineState, SpEngine } from '../src/engine/engine-api';
import { SERVER_CLIENT_ID } from '../src/api/server-writer';
import { makeTmpDir, removeTmpDir, startTestServer } from './helpers';

const PASSWORD = 'correct horse battery staple';
type Json = any;

/** Minimal encrypted sync client built from the app's own actions. */
class SyncClient {
  state: EngineState;
  clock: Record<string, number> = {};
  lastSeq = 0;
  constructor(
    private readonly engine: SpEngine,
    public url: string,
    private readonly token: string,
    readonly clientId: string,
  ) {
    this.state = engine.createInitialState();
  }

  async upload(action: { type: string } & Record<string, unknown>): Promise<Json> {
    const res = await this.engine.dispatchLocal(this.state, action);
    this.state = res.state;
    this.clock = { ...this.clock, [this.clientId]: (this.clock[this.clientId] ?? 0) + 1 };
    const op = {
      id: randomUUID(),
      clientId: this.clientId,
      vectorClock: { ...this.clock },
      timestamp: Date.now(),
      schemaVersion: this.engine.currentSchemaVersion,
      ...res.op!,
      payload: await encrypt(JSON.stringify(res.op!.payload), PASSWORD),
      isPayloadEncrypted: true,
    };
    const r = await fetch(`${this.url}/api/sync/ops`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ ops: [op], clientId: this.clientId }),
    });
    return r.json();
  }

  /** Downloads and applies remote ops (decrypting), like a client sync. */
  async pull(): Promise<Json[]> {
    const r = await fetch(
      `${this.url}/api/sync/ops?sinceSeq=${this.lastSeq}&excludeClient=${this.clientId}`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
      },
    );
    const body = (await r.json()) as Json;
    const ops: Json[] = [];
    for (const s of body.ops) {
      const op = { ...s.op };
      if (op.isPayloadEncrypted)
        op.payload = JSON.parse(await decrypt(op.payload, PASSWORD));
      ops.push(op);
      for (const [cid, n] of Object.entries(op.vectorClock as Record<string, number>)) {
        this.clock[cid] = Math.max(this.clock[cid] ?? 0, n);
      }
    }
    this.lastSeq = body.latestSeq;
    if (ops.length)
      this.state = (await this.engine.applyOperations(this.state, ops)).state;
    return ops;
  }
}

describe('REST API (/api/v1, MCP-compatible)', () => {
  const engine = loadEngine().engine;
  let dir: string;
  let server: RunningServer;
  let syncToken: string;
  let readToken: string;
  let writeToken: string;
  let client: SyncClient;
  let config: ServerConfig;

  beforeAll(() => setArgon2ParamsForTesting({ memorySize: 8, iterations: 1 }));
  afterAll(() => setArgon2ParamsForTesting());

  beforeEach(async () => {
    dir = makeTmpDir();
    const keyFile = join(dir, 'keys.txt');
    config = {
      dbPath: join(dir, 'api.sqlite'),
      host: '127.0.0.1',
      port: 0,
      testMode: false,
      corsOrigins: [],
      backupIntervalMinutes: 60,
      backupKeep: 1,
      projection: true,
      encryptionKeyFile: keyFile,
    };
    // Users must exist before the key file is resolved; create via a first start.
    server = await startTestServer(config);
    const user = createUser(server.db, 'henrik@example.test');
    syncToken = issueToken(server.db, user.id, 'sync').token;
    readToken = issueToken(server.db, user.id, 'api-read', 'mcp-read').token;
    writeToken = issueToken(server.db, user.id, 'api-write', 'mcp').token;
    writeFileSync(keyFile, `# test\nhenrik@example.test=${PASSWORD}\n`);
    client = new SyncClient(engine, server.url, syncToken, 'phoneClient');
  });
  afterEach(async () => {
    await server.close();
    removeTmpDir(dir);
  });

  const api = async (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const addTaskFromClient = async (title: string): Promise<string> => {
    const task = engine.helpers.createTask({
      title,
      workContextType: 'PROJECT',
      workContextId: 'INBOX_PROJECT',
    });
    const res = await client.upload(
      (engine.actions['addTask'] as never as (p: unknown) => never)({
        task,
        workContextId: 'INBOX_PROJECT',
        workContextType: 'PROJECT',
        isAddToBacklog: false,
        isAddToBottom: false,
      }),
    );
    expect(res.results[0].accepted).toBe(true);
    return task['id'] as string;
  };

  it('enforces token scopes', async () => {
    expect((await api('GET', '/tasks', null)).status).toBe(401);
    expect((await api('GET', '/tasks', syncToken)).status).toBe(403);
    expect((await api('POST', '/tasks', readToken, { title: 'x' })).status).toBe(403);
    expect((await api('GET', '/health', null)).json).toMatchObject({ ok: true });
  });

  it('reads tasks synced (encrypted) by a phone, filtered like the desktop API', async () => {
    const id = await addTaskFromClient('Buy milk');
    await addTaskFromClient('Call mum');
    const all = await api('GET', '/tasks', readToken);
    expect(all.status).toBe(200);
    expect(all.json.ok).toBe(true);
    expect(all.json.data.map((t: Json) => t.title).sort()).toEqual([
      'Buy milk',
      'Call mum',
    ]);
    const q = await api('GET', '/tasks?query=milk', readToken);
    expect(q.json.data.map((t: Json) => t.id)).toEqual([id]);
    expect((await api('GET', `/tasks/${id}`, readToken)).json.data.title).toBe(
      'Buy milk',
    );
    expect((await api('GET', '/tasks/nope', readToken)).json).toMatchObject({
      ok: false,
      error: { code: 'TASK_NOT_FOUND' },
    });
    expect(
      (await api('GET', '/projects', readToken)).json.data.map((p: Json) => p.id),
    ).toEqual(['INBOX_PROJECT']);
    expect(
      (await api('GET', '/tags', readToken)).json.data.map((t: Json) => t.id),
    ).toContain('TODAY');
  });

  it('creates, updates, completes and deletes tasks; every write reaches devices as an encrypted op', async () => {
    const created = await api('POST', '/tasks', writeToken, {
      title: 'From MCP',
      timeEstimate: 1_800_000,
    });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    expect(created.json.data).toMatchObject({
      title: 'From MCP',
      projectId: 'INBOX_PROJECT',
      timeEstimate: 1_800_000,
    });

    // The phone receives the server op and applies it with its own reducers.
    const pulled = await client.pull();
    expect(pulled.map((o) => [o.clientId, o.actionType])).toEqual([
      [SERVER_CLIENT_ID, '[Task Shared] addTask'],
    ]);
    const phoneTasks = (client.state.root['tasks'] as Json).entities;
    expect(phoneTasks[id].title).toBe('From MCP');
    const raw = server.db
      .prepare('SELECT is_payload_encrypted, payload FROM operations WHERE client_id = ?')
      .get(SERVER_CLIENT_ID) as Json;
    expect(raw.is_payload_encrypted).toBe(1);
    expect(raw.payload).not.toContain('From MCP');

    const patched = await api('PATCH', `/tasks/${id}`, writeToken, {
      title: 'Renamed',
      isDone: true,
    });
    expect(patched.json.data).toMatchObject({ title: 'Renamed', isDone: true });
    expect(typeof patched.json.data.doneOn).toBe('number');
    expect((await api('GET', '/tasks', readToken)).json.data).toHaveLength(0);
    expect(
      (await api('GET', '/tasks?includeDone=true', readToken)).json.data,
    ).toHaveLength(1);

    // The phone keeps editing after receiving server ops: no conflict.
    await client.pull();
    const res = await client.upload(
      (engine.actions['updateTask'] as never as (p: unknown) => never)({
        task: { id, changes: { notes: 'from phone' } },
      }),
    );
    expect(res.results[0].accepted).toBe(true);
    expect((await api('GET', `/tasks/${id}`, readToken)).json.data.notes).toBe(
      'from phone',
    );

    expect((await api('DELETE', `/tasks/${id}`, writeToken)).json.data).toEqual({
      deleted: true,
      id,
    });
    expect((await api('GET', `/tasks/${id}`, readToken)).status).toBe(404);
  });

  it('gives server-authored ops a clock that follows every device op (not only the touched entity)', async () => {
    await addTaskFromClient('one');
    await addTaskFromClient('two');
    await api('POST', '/tasks', writeToken, { title: 'new entity from MCP' });
    const row = server.db
      .prepare(
        'SELECT vector_clock FROM operations WHERE client_id = ? ORDER BY server_seq DESC LIMIT 1',
      )
      .get(SERVER_CLIENT_ID) as { vector_clock: string };
    const clock = JSON.parse(row.vector_clock) as Record<string, number>;
    expect(clock['phoneClient']).toBe(2);
    expect(clock[SERVER_CLIENT_ID]).toBe(1);
  });

  it('validates input like the desktop API', async () => {
    expect((await api('POST', '/tasks', writeToken, { title: '' })).json.error.code).toBe(
      'INVALID_INPUT',
    );
    expect(
      (await api('POST', '/tasks', writeToken, { title: 'x', timeEstimate: 'soon' })).json
        .error,
    ).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '$input.timeEstimate', expected: 'number' }],
    });
    expect(
      (await api('POST', '/tasks', writeToken, { title: 'x', subTaskIds: [] })).json.error
        .code,
    ).toBe('UNSUPPORTED_FIELD');
    expect(
      (await api('POST', '/tasks', writeToken, { title: 'x', projectId: 'missing' })).json
        .error.code,
    ).toBe('PROJECT_NOT_FOUND');
    const id = (await api('POST', '/tasks', writeToken, { title: 'p' })).json.data.id;
    expect(
      (await api('PATCH', `/tasks/${id}`, writeToken, { parentId: 'x' })).json.error.code,
    ).toBe('UNSUPPORTED_FIELD');
    expect(
      (await api('PATCH', `/tasks/${id}`, writeToken, { deadlineDay: '2026-02-30' })).json
        .error.code,
    ).toBe('INVALID_INPUT');
  });

  it('creates subtasks under a parent and refuses nesting / inherited fields', async () => {
    const parent = (await api('POST', '/tasks', writeToken, { title: 'Parent' })).json
      .data;
    const sub = await api('POST', '/tasks', writeToken, {
      title: 'Child',
      parentId: parent.id,
    });
    expect(sub.status).toBe(201);
    expect(sub.json.data).toMatchObject({
      parentId: parent.id,
      projectId: parent.projectId,
    });
    expect(
      (await api('GET', `/tasks/${parent.id}`, readToken)).json.data.subTaskIds,
    ).toEqual([sub.json.data.id]);
    expect(
      (
        await api('POST', '/tasks', writeToken, {
          title: 'Grandchild',
          parentId: sub.json.data.id,
        })
      ).json.error.code,
    ).toBe('INVALID_PARENT');
    expect(
      (
        await api('POST', '/tasks', writeToken, {
          title: 'x',
          parentId: parent.id,
          tagIds: [],
        })
      ).json.error.code,
    ).toBe('UNSUPPORTED_FIELD');
    const rows = server.db.prepare('SELECT parent_id, task_id FROM task_subtask').all();
    expect(rows).toEqual([{ parent_id: parent.id, task_id: sub.json.data.id }]);
  });

  it('archives and restores tasks (archive bucket in SQLite)', async () => {
    const id = (
      await api('POST', '/tasks', writeToken, { title: 'Archive me', isDone: true })
    ).json.data.id;
    expect((await api('POST', `/tasks/${id}/archive`, writeToken)).json.data).toEqual({
      id,
      archived: true,
    });
    expect(
      (
        await api('GET', '/tasks?source=archived&includeDone=true', readToken)
      ).json.data.map((t: Json) => t.id),
    ).toEqual([id]);
    expect(server.db.prepare('SELECT bucket FROM task WHERE id = ?').all(id)).toEqual([
      { bucket: 'young' },
    ]);
    const restored = await api('POST', `/tasks/${id}/restore`, writeToken);
    expect(restored.json.data.id).toBe(id);
    expect(server.db.prepare('SELECT bucket FROM task WHERE id = ?').all(id)).toEqual([
      { bucket: 'live' },
    ]);
  });

  it('sets and removes deadlines through the app deadline actions', async () => {
    const id = (
      await api('POST', '/tasks', writeToken, {
        title: 'Report',
        deadlineDay: '2026-12-01',
      })
    ).json.data.id;
    expect((await api('GET', `/tasks/${id}`, readToken)).json.data.deadlineDay).toBe(
      '2026-12-01',
    );
    const removed = await api('PATCH', `/tasks/${id}`, writeToken, { deadlineDay: null });
    expect(removed.json.data.deadlineDay ?? null).toBeNull();
  });

  it('answers runtime-only endpoints with 501', async () => {
    expect((await api('GET', '/status', readToken)).json.error.code).toBe(
      'NOT_AVAILABLE_ON_SERVER',
    );
    expect((await api('POST', '/task-control/stop', writeToken)).status).toBe(501);
  });

  it('reports a missing encryption password instead of serving stale data', async () => {
    await addTaskFromClient('Secret');
    // Projection catches up asynchronously; a read forces it before the restart.
    expect((await api('GET', '/tasks', readToken)).json.data).toHaveLength(1);
    writeFileSync(join(dir, 'keys.txt'), '# no keys\n');
    // New server instance → key cache rebuilt from the (now empty) file.
    await server.close();
    server = await startTestServer(config);
    client.url = server.url;
    const res = await api('GET', '/tasks', readToken);
    // Projection already contains the data from before; with no NEW ops it stays readable.
    expect(res.status).toBe(200);
    await addTaskFromClient('Second secret');
    const after = await api('GET', '/tasks', readToken);
    expect(after.status).toBe(503);
    expect(after.json.error.code).toBe('PROJECTION_NEEDS_KEY');
    expect((await api('POST', '/tasks', writeToken, { title: 'x' })).status).toBe(503);
  });

  it('serves the same data after a server restart', async () => {
    const id = (await api('POST', '/tasks', writeToken, { title: 'Durable' })).json.data
      .id;
    await server.close();
    server = await startTestServer(config);
    expect((await api('GET', `/tasks/${id}`, readToken)).json.data.title).toBe('Durable');
  });
});
