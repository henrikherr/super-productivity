/**
 * Declarative mapping from the app's persisted models (MODEL_CONFIGS keys) to
 * the relational projection tables (migration 2).
 *
 * Every model is described as one or more keyed collections of "owners"
 * (an entity, a time-tracking context, a planner day, a config section). When
 * an owner's value changes (reference inequality between the previous and
 * next engine state — NgRx reducers never mutate), all rows it owns are
 * deleted and re-inserted. Unchanged owners cost nothing.
 */

export type Bucket = 'live' | 'young' | 'old';

type Row = Record<string, unknown>;
type AnyRecord = Record<string, unknown>;

export interface DerivedTable {
  name: string;
  /** Column holding the owner id (together with user_id + bucket). */
  ownerColumn: string;
  /** Additional fixed column values that scope the owner (e.g. plugin kind). */
  scope?: Record<string, string>;
  rows(ownerId: string, value: unknown): Row[];
}

export interface Collection {
  name: string;
  /** Model whose slice holds the owners (MODEL_CONFIGS key). */
  modelKey: string;
  bucket: Bucket;
  /** Enumerates owners of the slice: id → value (compared by reference). */
  owners(slice: unknown): Map<string, unknown>;
  tables: DerivedTable[];
}

const asRecord = (v: unknown): AnyRecord =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRecord) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const bool = (v: unknown): number => (v === true ? 1 : 0);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Owners of an NgRx EntityState slice ({ ids, entities }). */
const entityOwners = (slice: unknown): Map<string, unknown> => {
  const entities = asRecord(asRecord(slice)['entities']);
  return new Map(Object.entries(entities).filter(([, v]) => v && typeof v === 'object'));
};

/** Owners of an array-of-{id} slice. */
const arrayOwners = (list: unknown): Map<string, unknown> => {
  const out = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const item of list) {
      const id = str(asRecord(item)['id']);
      if (id) out.set(id, item);
    }
  }
  return out;
};

const positioned = (ids: string[], make: (id: string, i: number) => Row): Row[] =>
  Array.from(new Set(ids)).map((id, i) => make(id, i));

// --- task (live + archives) -------------------------------------------------

const taskTables: DerivedTable[] = [
  {
    name: 'task',
    ownerColumn: 'id',
    rows: (id, value) => {
      const t = asRecord(value);
      return [
        {
          id,
          title: str(t['title']),
          project_id: str(t['projectId']),
          parent_id: str(t['parentId']),
          is_done: bool(t['isDone']),
          done_on: num(t['doneOn']),
          created: num(t['created']),
          modified: num(t['modified']),
          due_day: str(t['dueDay']),
          due_with_time: num(t['dueWithTime']),
          deadline_day: str(t['deadlineDay']),
          deadline_with_time: num(t['deadlineWithTime']),
          remind_at: num(t['remindAt']),
          time_estimate: num(t['timeEstimate']),
          time_spent: num(t['timeSpent']),
          repeat_cfg_id: str(t['repeatCfgId']),
          issue_id:
            str(t['issueId']) ??
            (typeof t['issueId'] === 'number' ? String(t['issueId']) : null),
          issue_type: str(t['issueType']),
          issue_provider_id: str(t['issueProviderId']),
          notes: str(t['notes']),
        },
      ];
    },
  },
  {
    name: 'task_tag',
    ownerColumn: 'task_id',
    rows: (_id, value) =>
      positioned(strArray(asRecord(value)['tagIds']), (tagId, position) => ({
        tag_id: tagId,
        position,
      })),
  },
  {
    name: 'task_subtask',
    ownerColumn: 'parent_id',
    rows: (_id, value) =>
      positioned(strArray(asRecord(value)['subTaskIds']), (taskId, position) => ({
        task_id: taskId,
        position,
      })),
  },
  {
    name: 'task_time_spent',
    ownerColumn: 'task_id',
    rows: (_id, value) =>
      Object.entries(asRecord(asRecord(value)['timeSpentOnDay']))
        .filter(([, ms]) => typeof ms === 'number' && Number.isFinite(ms))
        .map(([day, ms]) => ({ day, ms })),
  },
];

const timeTrackingTable: DerivedTable = {
  name: 'time_tracking',
  ownerColumn: 'context',
  rows: (context, value) => {
    const [contextType, ...rest] = context.split(':');
    const contextId = rest.join(':');
    return Object.entries(asRecord(value)).map(([day, entry]) => {
      const e = asRecord(entry);
      return {
        context_type: contextType,
        context_id: contextId,
        day,
        start: num(e['s']),
        end: num(e['e']),
        break_count: num(e['b']),
        break_time: num(e['bt']),
      };
    });
  },
};

/** Owners of a TimeTrackingState ({ project: {id: dateMap}, tag: {...} }). */
const timeTrackingOwners = (tt: unknown): Map<string, unknown> => {
  const out = new Map<string, unknown>();
  for (const type of ['project', 'tag'] as const) {
    for (const [id, dateMap] of Object.entries(asRecord(asRecord(tt)[type]))) {
      out.set(`${type.toUpperCase()}:${id}`, dateMap);
    }
  }
  return out;
};

const archiveCollections = (
  modelKey: 'archiveYoung' | 'archiveOld',
  bucket: Bucket,
): Collection[] => [
  {
    name: `${modelKey}.task`,
    modelKey,
    bucket,
    owners: (slice) => entityOwners(asRecord(slice)['task']),
    tables: taskTables,
  },
  {
    name: `${modelKey}.timeTracking`,
    modelKey,
    bucket,
    owners: (slice) => timeTrackingOwners(asRecord(slice)['timeTracking']),
    tables: [timeTrackingTable],
  },
];

export const COLLECTIONS: Collection[] = [
  {
    name: 'task',
    modelKey: 'task',
    bucket: 'live',
    owners: entityOwners,
    tables: taskTables,
  },
  ...archiveCollections('archiveYoung', 'young'),
  ...archiveCollections('archiveOld', 'old'),
  {
    name: 'project',
    modelKey: 'project',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'project',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const p = asRecord(v);
          return [
            {
              title: str(p['title']),
              is_archived: bool(p['isArchived']),
              is_hidden_from_menu: bool(p['isHiddenFromMenu']),
              is_enable_backlog: bool(p['isEnableBacklog']),
            },
          ];
        },
      },
      {
        name: 'project_task',
        ownerColumn: 'project_id',
        rows: (_id, v) => {
          const p = asRecord(v);
          return [
            ...positioned(strArray(p['taskIds']), (taskId, position) => ({
              task_id: taskId,
              list: 'today',
              position,
            })),
            ...positioned(strArray(p['backlogTaskIds']), (taskId, position) => ({
              task_id: taskId,
              list: 'backlog',
              position,
            })),
          ];
        },
      },
    ],
  },
  {
    name: 'tag',
    modelKey: 'tag',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'tag',
        ownerColumn: 'id',
        rows: (_id, v) => [
          { title: str(asRecord(v)['title']), color: str(asRecord(v)['color']) },
        ],
      },
      {
        name: 'tag_task',
        ownerColumn: 'tag_id',
        rows: (_id, v) =>
          positioned(strArray(asRecord(v)['taskIds']), (taskId, position) => ({
            task_id: taskId,
            position,
          })),
      },
    ],
  },
  {
    name: 'note',
    modelKey: 'note',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'note',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const n = asRecord(v);
          return [
            {
              project_id: str(n['projectId']),
              content: str(n['content']),
              is_pinned_to_today: bool(n['isPinnedToToday']),
              created: num(n['created']),
              modified: num(n['modified']),
            },
          ];
        },
      },
    ],
  },
  {
    name: 'section',
    modelKey: 'section',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'section',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const s = asRecord(v);
          return [
            {
              title: str(s['title']),
              context_id: str(s['contextId']),
              context_type: str(s['contextType']),
            },
          ];
        },
      },
      {
        name: 'section_task',
        ownerColumn: 'section_id',
        rows: (_id, v) =>
          positioned(strArray(asRecord(v)['taskIds']), (taskId, position) => ({
            task_id: taskId,
            position,
          })),
      },
    ],
  },
  {
    name: 'taskRepeatCfg',
    modelKey: 'taskRepeatCfg',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'task_repeat_cfg',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const r = asRecord(v);
          return [
            {
              title: str(r['title']),
              project_id: str(r['projectId']),
              repeat_cycle: str(r['repeatCycle']),
              repeat_every: num(r['repeatEvery']),
              start_date: str(r['startDate']),
              is_paused: bool(r['isPaused']),
              last_task_creation_day: str(r['lastTaskCreationDay']),
            },
          ];
        },
      },
    ],
  },
  {
    name: 'simpleCounter',
    modelKey: 'simpleCounter',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'simple_counter',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const c = asRecord(v);
          return [
            {
              title: str(c['title']),
              type: str(c['type']),
              is_enabled: bool(c['isEnabled']),
            },
          ];
        },
      },
      {
        name: 'simple_counter_day',
        ownerColumn: 'counter_id',
        rows: (_id, v) =>
          Object.entries(asRecord(asRecord(v)['countOnDay']))
            .filter(([, n]) => typeof n === 'number' && Number.isFinite(n))
            .map(([day, value]) => ({ day, value })),
      },
    ],
  },
  {
    name: 'issueProvider',
    modelKey: 'issueProvider',
    bucket: 'live',
    owners: entityOwners,
    tables: [
      {
        name: 'issue_provider',
        ownerColumn: 'id',
        rows: (_id, v) => [
          {
            issue_provider_key: str(asRecord(v)['issueProviderKey']),
            is_enabled: bool(asRecord(v)['isEnabled']),
          },
        ],
      },
    ],
  },
  {
    name: 'metric',
    modelKey: 'metric',
    bucket: 'live',
    owners: entityOwners,
    tables: [{ name: 'metric', ownerColumn: 'id', rows: () => [{}] }],
  },
  {
    name: 'reminders',
    modelKey: 'reminders',
    bucket: 'live',
    owners: arrayOwners,
    tables: [
      {
        name: 'reminder',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const r = asRecord(v);
          return [
            {
              related_id: str(r['relatedId']),
              type: str(r['type']),
              remind_at: num(r['remindAt']),
              title: str(r['title']),
            },
          ];
        },
      },
    ],
  },
  {
    name: 'boards',
    modelKey: 'boards',
    bucket: 'live',
    owners: (slice) => {
      const out = new Map<string, unknown>();
      const cfgs = asRecord(slice)['boardCfgs'];
      if (Array.isArray(cfgs)) {
        cfgs.forEach((cfg, position) => {
          const id = str(asRecord(cfg)['id']);
          // Position is part of the owner value so reordering rewrites rows.
          if (id) out.set(id, { cfg, position });
        });
      }
      return out;
    },
    tables: [
      {
        name: 'board',
        ownerColumn: 'id',
        rows: (_id, v) => {
          const { cfg, position } = v as { cfg: unknown; position: number };
          return [{ title: str(asRecord(cfg)['title']), position }];
        },
      },
    ],
  },
  {
    name: 'planner',
    modelKey: 'planner',
    bucket: 'live',
    owners: (slice) => new Map(Object.entries(asRecord(asRecord(slice)['days']))),
    tables: [
      {
        name: 'planner_day',
        ownerColumn: 'day',
        rows: (_day, v) =>
          positioned(strArray(v), (taskId, position) => ({ task_id: taskId, position })),
      },
    ],
  },
  {
    name: 'timeTracking',
    modelKey: 'timeTracking',
    bucket: 'live',
    owners: timeTrackingOwners,
    tables: [timeTrackingTable],
  },
  {
    name: 'globalConfig',
    modelKey: 'globalConfig',
    bucket: 'live',
    owners: (slice) => new Map(Object.entries(asRecord(slice))),
    tables: [
      {
        name: 'global_config',
        ownerColumn: 'section',
        rows: (_s, v) => [{ data: JSON.stringify(v ?? null) }],
      },
    ],
  },
  {
    name: 'pluginUserData',
    modelKey: 'pluginUserData',
    bucket: 'live',
    owners: arrayOwners,
    tables: [
      {
        name: 'plugin_data',
        ownerColumn: 'id',
        scope: { kind: 'user_data' },
        rows: () => [{}],
      },
    ],
  },
  {
    name: 'pluginMetadata',
    modelKey: 'pluginMetadata',
    bucket: 'live',
    owners: arrayOwners,
    tables: [
      {
        name: 'plugin_data',
        ownerColumn: 'id',
        scope: { kind: 'metadata' },
        rows: () => [{}],
      },
    ],
  },
];

/**
 * How each model slice is stored for lossless restarts:
 * - 'entity': NgRx EntityState → `entity_data` rows + meta (ids order, extra fields)
 * - 'array':  array of {id} → `entity_data` rows + meta.order
 * - 'archive': { task: EntityState, ...rest } → `entity_data` rows (bucket young/old) + meta
 * - 'whole':  stored completely in `projection_model.meta`
 */
export type StorageKind = 'entity' | 'array' | 'archive' | 'whole';

export const MODEL_STORAGE: Record<string, { kind: StorageKind; bucket: Bucket }> = {
  task: { kind: 'entity', bucket: 'live' },
  project: { kind: 'entity', bucket: 'live' },
  tag: { kind: 'entity', bucket: 'live' },
  note: { kind: 'entity', bucket: 'live' },
  section: { kind: 'entity', bucket: 'live' },
  taskRepeatCfg: { kind: 'entity', bucket: 'live' },
  simpleCounter: { kind: 'entity', bucket: 'live' },
  issueProvider: { kind: 'entity', bucket: 'live' },
  metric: { kind: 'entity', bucket: 'live' },
  reminders: { kind: 'array', bucket: 'live' },
  pluginUserData: { kind: 'array', bucket: 'live' },
  pluginMetadata: { kind: 'array', bucket: 'live' },
  archiveYoung: { kind: 'archive', bucket: 'young' },
  archiveOld: { kind: 'archive', bucket: 'old' },
  globalConfig: { kind: 'whole', bucket: 'live' },
  planner: { kind: 'whole', bucket: 'live' },
  boards: { kind: 'whole', bucket: 'live' },
  menuTree: { kind: 'whole', bucket: 'live' },
  timeTracking: { kind: 'whole', bucket: 'live' },
};

/** All projection tables (for reset). */
export const PROJECTION_TABLES = Array.from(
  new Set(COLLECTIONS.flatMap((c) => c.tables.map((t) => t.name))),
);
