import { Db } from '../db/database';
import { Operation, OpType, ServerOperation, VectorClock } from './types';

/** Row shape of `operations`. JSON columns are stored as TEXT. */
export interface OperationRow {
  id: string;
  user_id: number;
  server_seq: number;
  client_id: string;
  action_type: string;
  op_type: string;
  entity_type: string;
  entity_id: string | null;
  entity_ids: string;
  payload: string;
  payload_bytes: number;
  vector_clock: string;
  schema_version: number;
  client_timestamp: number;
  received_at: number;
  is_payload_encrypted: number;
  sync_import_reason: string | null;
  repair_base_server_seq: number | null;
}

export interface StoredOperation {
  id: string;
  userId: number;
  serverSeq: number;
  clientId: string;
  actionType: string;
  opType: string;
  entityType: string;
  entityId: string | null;
  entityIds: string[];
  payload: unknown;
  vectorClock: VectorClock;
  schemaVersion: number;
  clientTimestamp: number;
  receivedAt: number;
  isPayloadEncrypted: boolean;
  syncImportReason: string | null;
  repairBaseServerSeq: number | null;
}

export const rowToStored = (row: OperationRow): StoredOperation => ({
  id: row.id,
  userId: row.user_id,
  serverSeq: row.server_seq,
  clientId: row.client_id,
  actionType: row.action_type,
  opType: row.op_type,
  entityType: row.entity_type,
  entityId: row.entity_id,
  entityIds: JSON.parse(row.entity_ids) as string[],
  payload: JSON.parse(row.payload) as unknown,
  vectorClock: JSON.parse(row.vector_clock) as VectorClock,
  schemaVersion: row.schema_version,
  clientTimestamp: row.client_timestamp,
  receivedAt: row.received_at,
  isPayloadEncrypted: row.is_payload_encrypted === 1,
  syncImportReason: row.sync_import_reason,
  repairBaseServerSeq: row.repair_base_server_seq,
});

export const storedToServerOperation = (s: StoredOperation): ServerOperation => ({
  serverSeq: s.serverSeq,
  op: {
    id: s.id,
    clientId: s.clientId,
    actionType: s.actionType,
    opType: s.opType as OpType,
    entityType: s.entityType,
    entityId: s.entityId ?? undefined,
    entityIds: s.entityIds.length > 0 ? s.entityIds : undefined,
    payload: s.payload,
    vectorClock: s.vectorClock,
    schemaVersion: s.schemaVersion,
    timestamp: s.clientTimestamp,
    isPayloadEncrypted: s.isPayloadEncrypted,
    syncImportReason: s.syncImportReason ?? undefined,
    repairBaseServerSeq: s.repairBaseServerSeq ?? undefined,
  },
  receivedAt: s.receivedAt,
});

export interface SyncStateRow {
  user_id: number;
  last_seq: number;
  latest_full_state_seq: number | null;
  latest_full_state_vector_clock: string | null;
  latest_state_replacement_seq: number | null;
}

export const ensureSyncState = (db: Db, userId: number): SyncStateRow => {
  db.prepare('INSERT OR IGNORE INTO sync_state (user_id, last_seq) VALUES (?, 0)').run(
    userId,
  );
  return db
    .prepare('SELECT * FROM sync_state WHERE user_id = ?')
    .get(userId) as unknown as SyncStateRow;
};

export const getSyncState = (db: Db, userId: number): SyncStateRow | undefined =>
  db.prepare('SELECT * FROM sync_state WHERE user_id = ?').get(userId) as unknown as
    | SyncStateRow
    | undefined;

export const allocateServerSeq = (db: Db, userId: number): number => {
  const row = db
    .prepare(
      'UPDATE sync_state SET last_seq = last_seq + 1 WHERE user_id = ? RETURNING last_seq',
    )
    .get(userId) as { last_seq: number } | undefined;
  if (!row) throw new Error(`sync_state row missing for user ${userId}`);
  return row.last_seq;
};

export const findOperationById = (db: Db, opId: string): StoredOperation | undefined => {
  const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(opId) as unknown as
    | OperationRow
    | undefined;
  return row ? rowToStored(row) : undefined;
};

export const hasAnyOperation = (db: Db, userId: number): boolean =>
  db.prepare('SELECT 1 FROM operations WHERE user_id = ? LIMIT 1').get(userId) !==
  undefined;

/** lastSeq if the user has retained operations, else 0 (empty-server contract). */
export const getLatestSeq = (db: Db, userId: number): number => {
  if (!hasAnyOperation(db, userId)) return 0;
  return getSyncState(db, userId)?.last_seq ?? 0;
};

export interface InsertOperationInput {
  op: Operation;
  userId: number;
  serverSeq: number;
  storedEntityIds: string[];
  payloadBytes: number;
  receivedAt: number;
}

export const insertOperation = (db: Db, input: InsertOperationInput): void => {
  const { op, userId, serverSeq } = input;
  db.prepare(
    `INSERT INTO operations (
      id, user_id, server_seq, client_id, action_type, op_type, entity_type, entity_id,
      entity_ids, payload, payload_bytes, vector_clock, schema_version, client_timestamp,
      received_at, is_payload_encrypted, sync_import_reason, repair_base_server_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    op.id,
    userId,
    serverSeq,
    op.clientId,
    op.actionType,
    op.opType,
    op.entityType,
    op.entityId ?? null,
    JSON.stringify(input.storedEntityIds),
    JSON.stringify(op.payload ?? null),
    input.payloadBytes,
    JSON.stringify(op.vectorClock),
    op.schemaVersion,
    op.timestamp,
    input.receivedAt,
    op.isPayloadEncrypted ? 1 : 0,
    op.syncImportReason ?? null,
    op.repairBaseServerSeq ?? null,
  );
  const touched = new Set<string>(input.storedEntityIds);
  if (op.entityId) touched.add(op.entityId);
  const insertEntity = db.prepare(
    'INSERT OR IGNORE INTO operation_entities (user_id, entity_type, entity_id, server_seq) VALUES (?, ?, ?, ?)',
  );
  for (const entityId of touched) {
    insertEntity.run(userId, op.entityType, entityId, serverSeq);
  }
};

export interface LatestEntityOp {
  serverSeq: number;
  clientId: string;
  actionType: string;
  vectorClock: VectorClock;
}

/** Latest op that touched (entityType, entityId) via scalar id or entity set. */
export const findLatestOpForEntity = (
  db: Db,
  userId: number,
  entityType: string,
  entityId: string,
): LatestEntityOp | undefined => {
  const row = db
    .prepare(
      `SELECT o.server_seq, o.client_id, o.action_type, o.vector_clock
       FROM operation_entities e
       JOIN operations o ON o.user_id = e.user_id AND o.server_seq = e.server_seq
       WHERE e.user_id = ? AND e.entity_type = ? AND e.entity_id = ?
       ORDER BY e.server_seq DESC
       LIMIT 1`,
    )
    .get(userId, entityType, entityId) as
    | { server_seq: number; client_id: string; action_type: string; vector_clock: string }
    | undefined;
  return row
    ? {
        serverSeq: row.server_seq,
        clientId: row.client_id,
        actionType: row.action_type,
        vectorClock: JSON.parse(row.vector_clock) as VectorClock,
      }
    : undefined;
};

/** Pre-v2 GLOBAL_CONFIG:misc writes alias GLOBAL_CONFIG:tasks (see conflict.ts). */
export const findLatestLegacyMiscConfigOp = (
  db: Db,
  userId: number,
  beforeSchemaVersion: number,
): LatestEntityOp | undefined => {
  const row = db
    .prepare(
      `SELECT server_seq, client_id, action_type, vector_clock FROM operations
       WHERE user_id = ? AND entity_type = 'GLOBAL_CONFIG' AND entity_id = 'misc'
         AND schema_version < ?
       ORDER BY server_seq DESC LIMIT 1`,
    )
    .get(userId, beforeSchemaVersion) as
    | { server_seq: number; client_id: string; action_type: string; vector_clock: string }
    | undefined;
  return row
    ? {
        serverSeq: row.server_seq,
        clientId: row.client_id,
        actionType: row.action_type,
        vectorClock: JSON.parse(row.vector_clock) as VectorClock,
      }
    : undefined;
};

/** Latest causal full-state op (SYNC_IMPORT/BACKUP_IMPORT, or REPAIR with base). */
export const findLatestCausalFullState = (
  db: Db,
  userId: number,
  maxServerSeq?: number,
): { serverSeq: number; clientId: string } | undefined => {
  const row = db
    .prepare(
      `SELECT server_seq, client_id FROM operations
       WHERE user_id = ? AND server_seq <= ?
         AND (op_type IN ('SYNC_IMPORT', 'BACKUP_IMPORT')
              OR (op_type = 'REPAIR' AND repair_base_server_seq IS NOT NULL))
       ORDER BY server_seq DESC LIMIT 1`,
    )
    .get(userId, maxServerSeq ?? Number.MAX_SAFE_INTEGER) as
    | { server_seq: number; client_id: string }
    | undefined;
  return row ? { serverSeq: row.server_seq, clientId: row.client_id } : undefined;
};

/** Latest full-state op of any kind (incl. legacy REPAIR). */
export const findLatestFullStateOp = (
  db: Db,
  userId: number,
): { id: string; clientId: string; serverSeq: number } | undefined => {
  const row = db
    .prepare(
      `SELECT id, client_id, server_seq FROM operations
       WHERE user_id = ? AND op_type IN ('SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR')
       ORDER BY server_seq DESC LIMIT 1`,
    )
    .get(userId) as { id: string; client_id: string; server_seq: number } | undefined;
  return row
    ? { id: row.id, clientId: row.client_id, serverSeq: row.server_seq }
    : undefined;
};

/**
 * Per-client max vector-clock counter over ops in a seq range. Uses SQLite's
 * JSON1 `json_each`; non-integer values are ignored like the Postgres version.
 */
export const aggregateVectorClock = (
  db: Db,
  userId: number,
  range: { below?: number; upTo?: number },
): VectorClock => {
  const upper =
    range.below !== undefined ? range.below - 1 : (range.upTo ?? Number.MAX_SAFE_INTEGER);
  const rows = db
    .prepare(
      `SELECT kv.key AS client_id, MAX(CAST(kv.value AS INTEGER)) AS max_counter
       FROM operations o, json_each(o.vector_clock) AS kv
       WHERE o.user_id = ? AND o.server_seq <= ?
         AND json_type(o.vector_clock) = 'object'
         AND kv.type = 'integer' AND kv.value >= 0
       GROUP BY kv.key`,
    )
    .all(userId, upper) as Array<{ client_id: string; max_counter: number }>;
  const out: VectorClock = {};
  for (const row of rows) out[row.client_id] = Number(row.max_counter);
  return out;
};

export const getOperationsInRange = (
  db: Db,
  userId: number,
  afterSeq: number,
  upToSeq: number,
  limit: number,
  excludeClient?: string,
): StoredOperation[] => {
  const rows = (excludeClient
    ? db
        .prepare(
          `SELECT * FROM operations
             WHERE user_id = ? AND server_seq > ? AND server_seq <= ? AND client_id <> ?
             ORDER BY server_seq ASC LIMIT ?`,
        )
        .all(userId, afterSeq, upToSeq, excludeClient, limit)
    : db
        .prepare(
          `SELECT * FROM operations
             WHERE user_id = ? AND server_seq > ? AND server_seq <= ?
             ORDER BY server_seq ASC LIMIT ?`,
        )
        .all(userId, afterSeq, upToSeq, limit)) as unknown as OperationRow[];
  return rows.map(rowToStored);
};

export const getMinRetainedSeq = (
  db: Db,
  userId: number,
  upToSeq: number,
): number | null => {
  const row = db
    .prepare(
      'SELECT server_seq FROM operations WHERE user_id = ? AND server_seq <= ? ORDER BY server_seq ASC LIMIT 1',
    )
    .get(userId, upToSeq) as { server_seq: number } | undefined;
  return row?.server_seq ?? null;
};

export const deleteAllOperations = (db: Db, userId: number): void => {
  db.prepare('DELETE FROM operation_entities WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM operations WHERE user_id = ?').run(userId);
};
