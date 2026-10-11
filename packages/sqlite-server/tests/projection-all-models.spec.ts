import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadEngine, LoadedEngine } from '../src/engine/engine-loader';
import type { AppData } from '../src/engine/engine-api';
import { StaticKeyProvider } from '../src/projection/encryption-keys';
import { Projector } from '../src/projection/projector';
import { loadProjectedAppData } from '../src/projection/projection-store';
import { SyncService } from '../src/sync/sync-service';
import { createTestDb, createUserWithToken, TestDb } from './helpers';

type AnyRecord = Record<string, unknown>;
const DAY = '2026-10-09';
const byDay = <T>(value: T): Record<string, T> => Object.fromEntries([[DAY, value]]);

/** App data with at least one instance of every persisted data type. */
const buildFullAppData = (engine: LoadedEngine['engine']): AppData => {
  const data = engine.toAppData(engine.createInitialState()) as Record<string, unknown>;
  const parent = engine.helpers.createTask({
    title: 'Parent',
    workContextType: 'PROJECT',
    workContextId: 'P1',
    additional: { tagIds: ['T1'], timeSpentOnDay: byDay(60_000), timeSpent: 60_000 },
  });
  const child = engine.helpers.createTask({
    title: 'Child',
    workContextType: 'PROJECT',
    workContextId: 'P1',
    additional: { parentId: parent['id'] },
  });
  parent['subTaskIds'] = [child['id']];
  const archived = engine.helpers.createTask({
    title: 'Archived',
    workContextType: 'PROJECT',
    workContextId: 'P1',
    additional: { isDone: true, doneOn: 1, timeSpentOnDay: byDay(5_000) },
  });
  const tId = parent['id'] as string;
  const cId = child['id'] as string;
  const aId = archived['id'] as string;
  const entityState = (items: AnyRecord[], extra: AnyRecord = {}): AnyRecord => ({
    ...extra,
    ids: items.map((i) => i['id']),
    entities: Object.fromEntries(items.map((i) => [i['id'], i])),
  });
  const project = data['project'] as {
    ids: string[];
    entities: Record<string, AnyRecord>;
  };
  const inbox = project.entities['INBOX_PROJECT'];
  data['task'] = { ...(data['task'] as AnyRecord), ...entityState([parent, child]) };
  data['project'] = entityState([
    inbox,
    {
      ...inbox,
      id: 'P1',
      title: 'Project One',
      taskIds: [tId],
      backlogTaskIds: [],
      noteIds: ['N1'],
    },
  ]);
  const tag = data['tag'] as { ids: string[]; entities: Record<string, AnyRecord> };
  const today = tag.entities['TODAY'];
  data['tag'] = entityState([
    today,
    { ...today, id: 'T1', title: 'Tag One', color: '#f00', taskIds: [tId] },
  ]);
  data['note'] = entityState(
    [
      {
        id: 'N1',
        projectId: 'P1',
        isPinnedToToday: true,
        content: 'Note one',
        created: 1,
        modified: 2,
      },
    ],
    { todayOrder: ['N1'] },
  );
  data['section'] = entityState([
    {
      id: 'S1',
      contextId: 'P1',
      contextType: 'PROJECT',
      title: 'Section one',
      taskIds: [tId],
    },
  ]);
  data['taskRepeatCfg'] = entityState([
    {
      id: 'R1',
      title: 'Daily',
      projectId: 'P1',
      tagIds: [],
      repeatCycle: 'DAILY',
      repeatEvery: 1,
      startDate: DAY,
      isPaused: false,
      lastTaskCreationDay: DAY,
    },
  ]);
  data['simpleCounter'] = entityState([
    {
      id: 'C1',
      title: 'Water',
      type: 'ClickCounter',
      isEnabled: true,
      countOnDay: byDay(3),
    },
  ]);
  data['issueProvider'] = entityState([
    { id: 'IP1', issueProviderKey: 'GITHUB', isEnabled: true, defaultProjectId: 'P1' },
  ]);
  data['metric'] = entityState([
    { id: DAY, obstructions: [], improvements: [], improvementsTomorrow: [] },
  ]);
  data['reminders'] = [
    {
      id: 'REM1',
      remindAt: 1_800_000_000_000,
      title: 'Ping',
      type: 'TASK',
      relatedId: tId,
    },
  ];
  data['planner'] = {
    ...(data['planner'] as AnyRecord),
    days: Object.fromEntries([['2026-10-10', [tId]]]),
  };
  data['timeTracking'] = {
    project: { P1: byDay({ s: 1, e: 2, b: 1, bt: 300 }) },
    tag: {},
  };
  data['pluginUserData'] = [{ id: 'plug', data: 'opaque' }];
  data['pluginMetadata'] = [{ id: 'plug', isEnabled: true }];
  data['archiveYoung'] = {
    task: entityState([archived]),
    timeTracking: { project: {}, tag: { T1: byDay({ s: 3, e: 4 }) } },
    lastTimeTrackingFlush: 0,
  };
  void cId;
  void aId;
  return data;
};

describe('projection covers every persisted data type', () => {
  let loaded: LoadedEngine;
  let t: TestDb;
  let sync: SyncService;
  let userId: number;

  beforeAll(() => {
    loaded = loadEngine();
  });
  beforeEach(() => {
    t = createTestDb();
    sync = new SyncService(t.db);
    userId = createUserWithToken(t.db).userId;
  });
  afterEach(() => t.cleanup());

  const count = (table: string, where = ''): number =>
    (
      t.db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ? ${where}`)
        .get(userId) as {
        c: number;
      }
    ).c;

  const importState = async (state: AppData, clock: number): Promise<void> => {
    const res = await sync.uploadSnapshot(userId, {
      state,
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: clock },
      opId: randomUUID(),
      snapshotOpType: 'BACKUP_IMPORT',
    });
    expect(res.body).toMatchObject({ accepted: true });
  };

  it('stores, reloads exactly after restart, changes and deletes all data types', async () => {
    const projector = new Projector(t.db, loaded, new StaticKeyProvider(new Map()));
    await importState(buildFullAppData(loaded.engine), 1);
    const cache = await projector.catchUp(userId);

    // Stored: one row (or more) per data type in its typed table.
    expect(count('task', "AND bucket = 'live'")).toBe(2);
    expect(count('task_subtask')).toBe(1);
    expect(count('task_tag')).toBe(1);
    expect(count('task_time_spent', "AND bucket = 'live'")).toBe(1);
    expect(count('task', "AND bucket = 'young'")).toBe(1);
    expect(count('task_time_spent', "AND bucket = 'young'")).toBe(1);
    expect(count('project', "AND id = 'P1'")).toBe(1);
    expect(count('project_task', "AND project_id = 'P1'")).toBe(1);
    expect(count('tag', "AND id = 'T1'")).toBe(1);
    expect(count('tag_task', "AND tag_id = 'T1'")).toBe(1);
    expect(count('note')).toBe(1);
    expect(count('section')).toBe(1);
    expect(count('section_task')).toBe(1);
    expect(count('task_repeat_cfg')).toBe(1);
    expect(count('simple_counter')).toBe(1);
    expect(count('simple_counter_day')).toBe(1);
    expect(count('issue_provider')).toBe(1);
    expect(count('metric')).toBe(1);
    expect(count('reminder')).toBe(1);
    expect(count('planner_day')).toBe(1);
    expect(count('time_tracking', "AND bucket = 'live'")).toBe(1);
    expect(count('time_tracking', "AND bucket = 'young'")).toBe(1);
    expect(count('plugin_data')).toBe(2);
    expect(count('board')).toBeGreaterThan(0);
    expect(count('global_config')).toBeGreaterThan(5);

    // Reloaded exactly (restart path: tables → engine state, no replay).
    const reloaded = loadProjectedAppData(t.db, userId)!;
    const restartState = loaded.engine.fromAppData(reloaded);
    expect(loaded.engine.toAppData(restartState)).toEqual(cache.appData);

    // Changed: via app actions (note + tag), applied as ops.
    const noteUpdate = (
      loaded.engine.actions['updateNote'] as never as (p: unknown) => { type: string }
    )({
      note: { id: 'N1', changes: { content: 'Note edited' } },
    });
    const res = await loaded.engine.dispatchLocal(cache.state, noteUpdate as never);
    await sync.uploadOps(userId, {
      clientId: 'clientA',
      ops: [
        {
          id: randomUUID(),
          clientId: 'clientA',
          vectorClock: { clientA: 2 },
          timestamp: Date.now(),
          schemaVersion: loaded.engine.currentSchemaVersion,
          ...res.op!,
        },
      ],
    });
    await projector.catchUp(userId);
    expect(
      t.db.prepare('SELECT content FROM note WHERE user_id = ?').get(userId),
    ).toEqual({
      content: 'Note edited',
    });

    // Deleted: a later import without the data removes every derived row.
    await importState(loaded.engine.toAppData(loaded.engine.createInitialState()), 3);
    await projector.catchUp(userId);
    for (const table of [
      'note',
      'section',
      'section_task',
      'task_repeat_cfg',
      'issue_provider',
      'metric',
      'reminder',
      'planner_day',
      'time_tracking',
      'plugin_data',
      'task_subtask',
      'task_tag',
      'task_time_spent',
    ]) {
      expect(count(table), table).toBe(0);
    }
    // The empty import re-creates the app's default counters; ours is gone.
    expect(count('simple_counter', "AND id = 'C1'")).toBe(0);
    expect(count('simple_counter_day', "AND counter_id = 'C1'")).toBe(0);
    expect(count('task')).toBe(0);
    expect(count('project', "AND id = 'P1'")).toBe(0);
    expect(count('tag', "AND id = 'T1'")).toBe(0);
  });
});
