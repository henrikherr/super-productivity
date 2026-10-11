import { Db } from '../db/database';
import type { AppData, ImportMarker } from '../engine/engine-api';
import { COLLECTIONS, DerivedTable, MODEL_STORAGE, PROJECTION_TABLES } from './model-map';

export type ProjectionStatus = 'ok' | 'needs_key' | 'blocked' | 'error';

export interface ProjectionStatusRow {
  user_id: number;
  applied_seq: number;
  status: ProjectionStatus;
  last_error: string | null;
  skipped_ops: number;
  latest_import: string | null;
  engine_schema_version: number | null;
  engine_revision: string | null;
  updated_at: number;
}

type AnyRecord = Record<string, unknown>;
const asRecord = (v: unknown): AnyRecord =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRecord) : {};

export const getProjectionStatus = (
  db: Db,
  userId: number,
): ProjectionStatusRow | undefined =>
  db
    .prepare('SELECT * FROM projection_status WHERE user_id = ?')
    .get(userId) as unknown as ProjectionStatusRow | undefined;

export const setProjectionStatus = (
  db: Db,
  userId: number,
  patch: Partial<Omit<ProjectionStatusRow, 'user_id' | 'updated_at'>>,
): void => {
  const current = getProjectionStatus(db, userId);
  const next = {
    applied_seq: patch.applied_seq ?? current?.applied_seq ?? 0,
    status: patch.status ?? current?.status ?? 'ok',
    last_error:
      patch.last_error !== undefined ? patch.last_error : (current?.last_error ?? null),
    skipped_ops: patch.skipped_ops ?? current?.skipped_ops ?? 0,
    latest_import:
      patch.latest_import !== undefined
        ? patch.latest_import
        : (current?.latest_import ?? null),
    engine_schema_version:
      patch.engine_schema_version ?? current?.engine_schema_version ?? null,
    engine_revision: patch.engine_revision ?? current?.engine_revision ?? null,
  };
  db.prepare(
    `INSERT INTO projection_status (user_id, applied_seq, status, last_error, skipped_ops,
       latest_import, engine_schema_version, engine_revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET applied_seq = excluded.applied_seq,
       status = excluded.status, last_error = excluded.last_error,
       skipped_ops = excluded.skipped_ops, latest_import = excluded.latest_import,
       engine_schema_version = excluded.engine_schema_version,
       engine_revision = excluded.engine_revision, updated_at = excluded.updated_at`,
  ).run(
    userId,
    next.applied_seq,
    next.status,
    next.last_error,
    next.skipped_ops,
    next.latest_import,
    next.engine_schema_version,
    next.engine_revision,
    Date.now(),
  );
};

/** Removes every derived row of a user (status row is kept/reset by callers). */
export const resetProjection = (db: Db, userId: number): void => {
  for (const table of PROJECTION_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
  db.prepare('DELETE FROM entity_data WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM projection_model WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM projection_status WHERE user_id = ?').run(userId);
};

const insertRows = (
  db: Db,
  table: DerivedTable,
  userId: number,
  bucket: string,
  ownerId: string,
  value: unknown,
): void => {
  for (const row of table.rows(ownerId, value)) {
    const full: AnyRecord = {
      ...row,
      ...table.scope,
      user_id: userId,
      bucket,
      [table.ownerColumn]: ownerId,
    };
    const cols = Object.keys(full);
    db.prepare(
      `INSERT OR REPLACE INTO ${table.name} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`,
    ).run(...(cols.map((c) => normalizeSqlValue(full[c])) as never[]));
  }
};

const normalizeSqlValue = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return JSON.stringify(v);
};

const deleteOwnerRows = (
  db: Db,
  table: DerivedTable,
  userId: number,
  bucket: string,
  ownerId: string,
): void => {
  const scopeCols = Object.keys(table.scope ?? {});
  db.prepare(
    `DELETE FROM ${table.name} WHERE user_id = ? AND bucket = ? AND "${table.ownerColumn}" = ?${scopeCols
      .map((c) => ` AND "${c}" = ?`)
      .join('')}`,
  ).run(userId, bucket, ownerId, ...scopeCols.map((c) => table.scope![c]));
};

/** Splits a model slice into its meta part and entity map for storage. */
const splitForStorage = (
  modelKey: string,
  slice: unknown,
): { meta: unknown; entities?: Map<string, unknown> } => {
  const storage = MODEL_STORAGE[modelKey];
  if (!storage || storage.kind === 'whole') return { meta: slice ?? null };
  if (storage.kind === 'entity') {
    const { entities, ...rest } = asRecord(slice);
    return { meta: rest, entities: new Map(Object.entries(asRecord(entities))) };
  }
  if (storage.kind === 'array') {
    const list = Array.isArray(slice) ? slice : [];
    const entities = new Map<string, unknown>();
    const order: string[] = [];
    for (const item of list) {
      const id = asRecord(item)['id'];
      if (typeof id === 'string') {
        entities.set(id, item);
        order.push(id);
      }
    }
    return { meta: { order }, entities };
  }
  // archive: { task: EntityState, ...rest }
  const { task, ...rest } = asRecord(slice);
  const { entities, ...taskRest } = asRecord(task);
  return {
    meta: { ...rest, task: taskRest },
    entities: new Map(Object.entries(asRecord(entities))),
  };
};

/**
 * Writes the difference between two engine states. Must run inside a
 * transaction together with the status update. `prev` undefined = full write.
 */
export const writeProjectionDiff = (
  db: Db,
  userId: number,
  prev: AppData | undefined,
  next: AppData,
): { changedOwners: number } => {
  let changedOwners = 0;

  // 1) Exact restart storage (projection_model + entity_data).
  for (const modelKey of Object.keys(MODEL_STORAGE)) {
    const prevSlice = prev?.[modelKey];
    const nextSlice = next[modelKey];
    if (prev && prevSlice === nextSlice) continue;
    const storage = MODEL_STORAGE[modelKey];
    const nextSplit = splitForStorage(modelKey, nextSlice);
    const prevSplit = prev ? splitForStorage(modelKey, prevSlice) : undefined;
    db.prepare(
      `INSERT INTO projection_model (user_id, model_key, meta) VALUES (?, ?, ?)
       ON CONFLICT (user_id, model_key) DO UPDATE SET meta = excluded.meta`,
    ).run(userId, modelKey, JSON.stringify(nextSplit.meta ?? null));
    if (nextSplit.entities) {
      const entityModel = storage.kind === 'archive' ? 'task' : modelKey;
      const upsert = db.prepare(
        `INSERT INTO entity_data (user_id, model_key, bucket, id, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, model_key, bucket, id) DO UPDATE SET data = excluded.data`,
      );
      const del = db.prepare(
        'DELETE FROM entity_data WHERE user_id = ? AND model_key = ? AND bucket = ? AND id = ?',
      );
      for (const [id, value] of nextSplit.entities) {
        if (prevSplit?.entities?.get(id) === value) continue;
        upsert.run(userId, entityModel, storage.bucket, id, JSON.stringify(value));
      }
      for (const id of prevSplit?.entities?.keys() ?? []) {
        if (!nextSplit.entities.has(id)) del.run(userId, entityModel, storage.bucket, id);
      }
    }
  }

  // 2) Typed query tables.
  for (const collection of COLLECTIONS) {
    const prevSlice = prev?.[collection.modelKey];
    const nextSlice = next[collection.modelKey];
    if (prev && prevSlice === nextSlice) continue;
    const prevOwners = prev ? collection.owners(prevSlice) : new Map<string, unknown>();
    const nextOwners = collection.owners(nextSlice);
    for (const [ownerId, value] of nextOwners) {
      if (prev && prevOwners.get(ownerId) === value) continue;
      changedOwners++;
      for (const table of collection.tables) {
        deleteOwnerRows(db, table, userId, collection.bucket, ownerId);
        insertRows(db, table, userId, collection.bucket, ownerId, value);
      }
    }
    for (const ownerId of prevOwners.keys()) {
      if (nextOwners.has(ownerId)) continue;
      changedOwners++;
      for (const table of collection.tables) {
        deleteOwnerRows(db, table, userId, collection.bucket, ownerId);
      }
    }
  }
  return { changedOwners };
};

/**
 * Reconstructs the persisted app data of a user from `projection_model` and
 * `entity_data`. Returns undefined when nothing is stored yet.
 */
export const loadProjectedAppData = (db: Db, userId: number): AppData | undefined => {
  const metas = db
    .prepare('SELECT model_key, meta FROM projection_model WHERE user_id = ?')
    .all(userId) as Array<{ model_key: string; meta: string }>;
  if (metas.length === 0) return undefined;
  const entityRows = db
    .prepare('SELECT model_key, bucket, id, data FROM entity_data WHERE user_id = ?')
    .all(userId) as Array<{
    model_key: string;
    bucket: string;
    id: string;
    data: string;
  }>;
  const entitiesBy = new Map<string, Record<string, unknown>>();
  for (const row of entityRows) {
    const key = `${row.model_key}\u0000${row.bucket}`;
    let map = entitiesBy.get(key);
    if (!map) {
      map = {};
      entitiesBy.set(key, map);
    }
    map[row.id] = JSON.parse(row.data) as unknown;
  }
  const out: AppData = {};
  for (const { model_key: modelKey, meta: metaText } of metas) {
    const meta = JSON.parse(metaText) as unknown;
    const storage = MODEL_STORAGE[modelKey];
    if (!storage || storage.kind === 'whole') {
      out[modelKey] = meta;
      continue;
    }
    if (storage.kind === 'entity') {
      const entities = entitiesBy.get(`${modelKey}\u0000${storage.bucket}`) ?? {};
      out[modelKey] = { ...asRecord(meta), entities };
      continue;
    }
    if (storage.kind === 'array') {
      const entities = entitiesBy.get(`${modelKey}\u0000${storage.bucket}`) ?? {};
      const order = (asRecord(meta)['order'] as string[] | undefined) ?? [];
      out[modelKey] = order.filter((id) => id in entities).map((id) => entities[id]);
      continue;
    }
    const entities = entitiesBy.get(`task\u0000${storage.bucket}`) ?? {};
    const m = asRecord(meta);
    out[modelKey] = { ...m, task: { ...asRecord(m['task']), entities } };
  }
  return out;
};

/**
 * Cheap integrity check used after load: every id listed in an entity model's
 * `ids` must have its entity row (a crash cannot cause this — writes are
 * transactional — but manual DB edits or bugs could).
 */
export const verifyProjectedAppData = (data: AppData): string[] => {
  const problems: string[] = [];
  for (const [modelKey, storage] of Object.entries(MODEL_STORAGE)) {
    if (storage.kind !== 'entity' && storage.kind !== 'archive') continue;
    const slice =
      storage.kind === 'archive'
        ? asRecord(asRecord(data[modelKey])['task'])
        : asRecord(data[modelKey]);
    const ids = slice['ids'];
    const entities = asRecord(slice['entities']);
    if (!Array.isArray(ids)) continue;
    const missing = ids.filter((id) => typeof id === 'string' && !(id in entities));
    if (missing.length)
      problems.push(`${modelKey}: ${missing.length} id(s) without entity`);
  }
  return problems;
};

export const markerToJson = (m: ImportMarker | undefined): string | null =>
  m ? JSON.stringify(m) : null;
export const markerFromJson = (s: string | null | undefined): ImportMarker | undefined =>
  s ? (JSON.parse(s) as ImportMarker) : undefined;
