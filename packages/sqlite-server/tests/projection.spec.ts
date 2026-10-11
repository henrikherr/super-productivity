import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { encrypt, setArgon2ParamsForTesting } from '@sp/sync-core';
import { loadEngine, LoadedEngine } from '../src/engine/engine-loader';
import type { EngineState, SpEngine } from '../src/engine/engine-api';
import { StaticKeyProvider } from '../src/projection/encryption-keys';
import { Projector } from '../src/projection/projector';
import { getProjectionStatus } from '../src/projection/projection-store';
import { SyncService } from '../src/sync/sync-service';
import { Operation, UploadResult } from '../src/sync/types';
import { createTestDb, createUserWithToken, TestDb } from './helpers';

/**
 * Builds real operations the way a client does: dispatch an app action on a
 * local copy of the state, take the op envelope the engine derives from the
 * action meta (same as OperationLogEffects).
 */
class FakeClient {
  state: EngineState;
  private counter = 0;
  clock: Record<string, number> = {};

  constructor(
    private readonly engine: SpEngine,
    readonly clientId: string,
  ) {
    this.state = engine.createInitialState();
  }

  async op(action: { type: string } & Record<string, unknown>): Promise<Operation> {
    const res = await this.engine.dispatchLocal(this.state, action);
    this.state = res.state;
    if (!res.op) throw new Error(`action ${action.type} is not persistent`);
    this.counter++;
    this.clock = { ...this.clock, [this.clientId]: this.counter };
    return {
      id: randomUUID(),
      clientId: this.clientId,
      vectorClock: { ...this.clock },
      timestamp: Date.now(),
      schemaVersion: this.engine.currentSchemaVersion,
      ...res.op,
    } as Operation;
  }

  newTask(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return this.engine.helpers.createTask({
      title,
      workContextType: 'PROJECT',
      workContextId: 'INBOX_PROJECT',
      additional: extra,
    });
  }

  addTaskAction(
    task: Record<string, unknown>,
  ): { type: string } & Record<string, unknown> {
    return (
      this.engine.actions['addTask'] as unknown as (p: unknown) => { type: string }
    )({
      task,
      workContextId: 'INBOX_PROJECT',
      workContextType: 'PROJECT',
      isAddToBacklog: false,
      isAddToBottom: false,
    }) as never;
  }

  action(
    name: string,
    props: Record<string, unknown>,
  ): { type: string } & Record<string, unknown> {
    return (this.engine.actions[name] as unknown as (p: unknown) => { type: string })(
      props,
    ) as never;
  }
}

describe('relational projection (real app reducers)', () => {
  let loaded: LoadedEngine;
  let t: TestDb;
  let sync: SyncService;
  let userId: number;
  let keys: Map<number, string>;
  let projector: Projector;

  beforeAll(() => {
    loaded = loadEngine();
    // Fast Argon2 for tests (same module instance the projector decrypts with).
    setArgon2ParamsForTesting({ memorySize: 8, iterations: 1 });
  });
  afterAll(() => setArgon2ParamsForTesting());

  beforeEach(() => {
    t = createTestDb();
    sync = new SyncService(t.db);
    userId = createUserWithToken(t.db).userId;
    keys = new Map();
    projector = new Projector(t.db, loaded, new StaticKeyProvider(keys), {
      batchSize: 3,
    });
  });
  afterEach(() => t.cleanup());

  const upload = async (
    client: FakeClient,
    ops: Operation[],
  ): Promise<UploadResult[]> => {
    const res = await sync.uploadOps(userId, { ops, clientId: client.clientId });
    return (res.body as { results: UploadResult[] }).results;
  };
  const rows = (sql: string, ...params: unknown[]): Array<Record<string, unknown>> =>
    t.db.prepare(sql).all(userId, ...(params as never[])) as Array<
      Record<string, unknown>
    >;

  it('projects tasks, subtask/project/tag relations and time records into tables', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const parent = a.newTask('Parent task', { timeEstimate: 3_600_000 });
    const child = a.newTask('Child task', { parentId: parent['id'] });
    const ops = [await a.op(a.addTaskAction(parent))];
    // A subtask is a task whose parentId is set; the reducers maintain the
    // parent's subTaskIds.
    ops.push(await a.op(a.addTaskAction(child)));
    ops.push(
      await a.op(
        a.action('updateTask', {
          task: { id: parent['id'], changes: { title: 'Parent renamed', isDone: false } },
        }),
      ),
    );
    expect((await upload(a, ops)).every((r) => r.accepted)).toBe(true);
    await projector.catchUp(userId);

    const tasks = rows(
      'SELECT id, title, parent_id, project_id, time_estimate FROM task WHERE user_id = ? AND bucket = ? ORDER BY title',
      'live',
    );
    expect(tasks).toEqual([
      {
        id: child['id'],
        title: 'Child task',
        parent_id: parent['id'],
        project_id: 'INBOX_PROJECT',
        time_estimate: 0,
      },
      {
        id: parent['id'],
        title: 'Parent renamed',
        parent_id: null,
        project_id: 'INBOX_PROJECT',
        time_estimate: 3_600_000,
      },
    ]);
    const inbox = rows(
      "SELECT task_id, list, position FROM project_task WHERE user_id = ? AND project_id = 'INBOX_PROJECT' ORDER BY position",
    );
    expect(inbox.map((r) => r['task_id'])).toContain(parent['id']);
    expect(getProjectionStatus(t.db, userId)).toMatchObject({
      status: 'ok',
      applied_seq: 3,
    });
  });

  it('survives a server restart without replaying (loads tables) and continues', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const task = a.newTask('Persisted');
    await upload(a, [await a.op(a.addTaskAction(task))]);
    await projector.catchUp(userId);

    t.reopen();
    sync = new SyncService(t.db);
    const restarted = new Projector(t.db, loaded, new StaticKeyProvider(keys));
    const cache = await restarted.catchUp(userId);
    expect(cache.appliedSeq).toBe(1);
    const restoredTasks = (
      cache.state.root['tasks'] as { entities: Record<string, { title: string }> }
    ).entities;
    expect(restoredTasks[task['id'] as string].title).toBe('Persisted');

    await upload(a, [
      await a.op(
        a.action('updateTask', {
          task: { id: task['id'], changes: { title: 'After restart' } },
        }),
      ),
    ]);
    await restarted.catchUp(userId);
    expect(rows('SELECT title FROM task WHERE user_id = ?')).toEqual([
      { title: 'After restart' },
    ]);
  });

  it('decrypts encrypted client payloads with the configured password; reports needs_key otherwise', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const task = a.newTask('Secret task');
    const op = await a.op(a.addTaskAction(task));
    const encryptedOp = {
      ...op,
      payload: await encrypt(JSON.stringify(op.payload), 'pw-123'),
      isPayloadEncrypted: true,
    };
    expect((await upload(a, [encryptedOp]))[0].accepted).toBe(true);

    await projector.catchUp(userId);
    expect(getProjectionStatus(t.db, userId)).toMatchObject({
      status: 'needs_key',
      applied_seq: 0,
    });
    await expect(projector.getCurrentState(userId)).rejects.toThrow(
      /encryption password/,
    );

    keys.set(userId, 'wrong');
    await projector.catchUp(userId);
    expect(getProjectionStatus(t.db, userId)?.last_error).toMatch(/wrong/);

    keys.set(userId, 'pw-123');
    await projector.catchUp(userId);
    expect(getProjectionStatus(t.db, userId)).toMatchObject({
      status: 'ok',
      applied_seq: 1,
    });
    expect(rows('SELECT title FROM task WHERE user_id = ?')).toEqual([
      { title: 'Secret task' },
    ]);
  });

  it('moves archived tasks (incl. time data) into the archive bucket via the real archive handler', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const task = a.newTask('Done task', {
      timeSpentOnDay: Object.fromEntries([['2026-10-09', 1_800_000]]),
      timeSpent: 1_800_000,
    });
    await upload(a, [await a.op(a.addTaskAction(task))]);
    const live = (
      a.state.root['tasks'] as { entities: Record<string, Record<string, unknown>> }
    ).entities[task['id'] as string];
    await upload(a, [
      await a.op(
        a.action('moveToArchive', {
          tasks: [{ ...live, isDone: true, doneOn: 1, subTasks: [] }],
        }),
      ),
    ]);
    await projector.catchUp(userId);
    expect(rows('SELECT bucket, title FROM task WHERE user_id = ?')).toEqual([
      { bucket: 'young', title: 'Done task' },
    ]);
    expect(rows('SELECT bucket, day, ms FROM task_time_spent WHERE user_id = ?')).toEqual(
      [{ bucket: 'young', day: '2026-10-09', ms: 1_800_000 }],
    );
  });

  it('applies a full-state import and drops ops concurrent with it (clean-slate semantics)', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const b = new FakeClient(loaded.engine, 'clientB');
    await upload(a, [await a.op(a.addTaskAction(a.newTask('Before import')))]);

    // B imports a backup containing a single different task.
    const importState = loaded.engine.toAppData(b.state);
    const bt = b.newTask('From backup');
    const tasks = importState['task'] as {
      ids: string[];
      entities: Record<string, unknown>;
    };
    importState['task'] = {
      ...tasks,
      ids: [bt['id']],
      entities: { [bt['id'] as string]: bt },
    };
    const project = importState['project'] as {
      entities: Record<string, Record<string, unknown>>;
    };
    project.entities['INBOX_PROJECT'] = {
      ...project.entities['INBOX_PROJECT'],
      taskIds: [bt['id']],
    };
    const snap = await sync.uploadSnapshot(userId, {
      state: importState,
      clientId: 'clientB',
      reason: 'recovery',
      vectorClock: { clientB: 1 },
      opId: randomUUID(),
      snapshotOpType: 'BACKUP_IMPORT',
    });
    expect(snap.body).toMatchObject({ accepted: true, serverSeq: 2 });

    // A (never saw the import) writes a NEW entity: no server conflict, but
    // clients discard it as concurrent with the import → projection must too.
    const stray = await a.op(a.addTaskAction(a.newTask('Stray after import')));
    expect((await upload(a, [stray]))[0].accepted).toBe(true);

    await projector.catchUp(userId);
    expect(rows('SELECT title FROM task WHERE user_id = ? ORDER BY title')).toEqual([
      { title: 'From backup' },
    ]);
    expect(getProjectionStatus(t.db, userId)?.applied_seq).toBe(3);
  });

  it('resets derived data atomically with a clean-slate upload', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    sync.setHistoryResetHook((db, uid) => projector.resetUserInTransaction(db, uid));
    await upload(a, [await a.op(a.addTaskAction(a.newTask('Old')))]);
    await projector.catchUp(userId);
    const empty = loaded.engine.toAppData(loaded.engine.createInitialState());
    await sync.uploadSnapshot(userId, {
      state: empty,
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: 5 },
      opId: randomUUID(),
      isCleanSlate: true,
    });
    expect(rows('SELECT COUNT(*) AS c FROM task WHERE user_id = ?')).toEqual([{ c: 0 }]);
    await projector.catchUp(userId);
    expect(rows('SELECT COUNT(*) AS c FROM task WHERE user_id = ?')).toEqual([{ c: 0 }]);
    expect(getProjectionStatus(t.db, userId)?.applied_seq).toBe(2);
  });

  it('a full rebuild from the op log yields exactly the incremental projection', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    const ops: Operation[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const task = a.newTask(`Task ${i}`);
      ids.push(task['id'] as string);
      ops.push(await a.op(a.addTaskAction(task)));
    }
    ops.push(
      await a.op(
        a.action('updateTask', { task: { id: ids[2], changes: { title: 'Renamed' } } }),
      ),
    );
    ops.push(
      await a.op(
        a.action('deleteTask', {
          task: {
            ...((a.state.root['tasks'] as never as { entities: Record<string, unknown> })
              .entities[ids[4]] as object),
            subTasks: [],
          },
        }),
      ),
    );
    for (const op of ops) await upload(a, [op]);
    await projector.catchUp(userId); // batchSize 3 → several incremental batches

    // `modified` is set to Date.now() by the app reducers at APPLY time
    // (task-shared-crud.reducer.ts), so it legitimately differs per replay —
    // on every client, too. Everything else must be identical.
    const dump = (): string =>
      JSON.stringify(
        ['task', 'project_task', 'entity_data', 'projection_model'].map((table) =>
          t.db
            .prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY 1,2,3`)
            .all(userId),
        ),
      ).replace(/\\?"modified\\?":\d+/g, 'modified');
    const incremental = dump();
    await projector.rebuild(userId);
    expect(dump()).toBe(incremental);
    expect(rows('SELECT COUNT(*) AS c FROM task WHERE user_id = ?')).toEqual([{ c: 6 }]);
  });

  it('keeps the previous projection when the engine fails mid-batch (no partial writes)', async () => {
    const a = new FakeClient(loaded.engine, 'clientA');
    await upload(a, [await a.op(a.addTaskAction(a.newTask('Stable')))]);
    await projector.catchUp(userId);
    await upload(a, [await a.op(a.addTaskAction(a.newTask('Will fail')))]);

    const failing: LoadedEngine = {
      ...loaded,
      engine: {
        ...loaded.engine,
        applyOperations: async () => Promise.reject(new Error('engine crashed')),
      },
    };
    const broken = new Projector(t.db, failing, new StaticKeyProvider(keys));
    await expect(broken.catchUp(userId)).rejects.toThrow('engine crashed');
    expect(rows('SELECT title FROM task WHERE user_id = ?')).toEqual([
      { title: 'Stable' },
    ]);
    expect(getProjectionStatus(t.db, userId)?.applied_seq).toBe(1);

    await new Projector(t.db, loaded, new StaticKeyProvider(keys)).catchUp(userId);
    expect(rows('SELECT title FROM task WHERE user_id = ? ORDER BY title')).toEqual([
      { title: 'Stable' },
      { title: 'Will fail' },
    ]);
  });
});
