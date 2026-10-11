/**
 * Conflict detection and duplicate identity checks. The decision logic is
 * ported verbatim from packages/super-sync-server/src/sync/conflict.ts; only
 * the "latest op per entity" lookups are re-expressed for SQLite via the
 * `operation_entities` table (scalar entity_id UNION entity_ids).
 */
import { compareVectorClocks, limitVectorClockSize } from '@sp/sync-core';
import { Db } from '../db/database';
import {
  findLatestLegacyMiscConfigOp,
  findLatestOpForEntity,
  LatestEntityOp,
  StoredOperation,
} from './op-store';
import { Operation, VectorClock } from './types';

const TASK_TIME_DELTA_ACTION_TYPE = '[TimeTracking] Sync time spent';
const MISC_TASKS_SPLIT_SCHEMA_VERSION = 2;

export type ConflictType =
  | 'concurrent'
  | 'superseded'
  | 'equal_different_client'
  | 'unknown';

export interface ConflictResult {
  hasConflict: boolean;
  reason?: string;
  conflictType?: ConflictType;
  existingClock?: VectorClock;
}

const isLegacyMiscConfigOperation = (op: Operation): boolean =>
  op.schemaVersion < MISC_TASKS_SPLIT_SCHEMA_VERSION &&
  op.entityType === 'GLOBAL_CONFIG' &&
  op.entityId === 'misc';

/** All entities an op touches (incoming-op conflict check). */
export const getConflictEntityIds = (op: Operation): string[] => {
  const rawEntityIds = [
    ...(op.entityId ? [op.entityId] : []),
    ...(op.entityIds?.length ? op.entityIds : []),
  ];
  if (isLegacyMiscConfigOperation(op)) {
    rawEntityIds.push('tasks');
  }
  return Array.from(new Set(rawEntityIds));
};

/** The entity_ids array persisted with an op ([] when covered by entity_id). */
export const getStoredEntityIds = (op: Operation): string[] => {
  const ids = Array.from(
    new Set(op.entityIds?.length ? op.entityIds : op.entityId ? [op.entityId] : []),
  );
  if (ids.length <= 1 && ids[0] === op.entityId) {
    return [];
  }
  return ids;
};

export const resolveConflictForExistingOp = (
  op: Operation,
  entityId: string,
  existingOp: { actionType?: string; clientId: string; vectorClock: unknown },
): ConflictResult => {
  const existingClock = existingOp.vectorClock as VectorClock;
  const comparison = compareVectorClocks(op.vectorClock, existingClock);

  if (
    comparison === 'CONCURRENT' &&
    op.actionType === TASK_TIME_DELTA_ACTION_TYPE &&
    existingOp.actionType === TASK_TIME_DELTA_ACTION_TYPE
  ) {
    return { hasConflict: false };
  }
  if (comparison === 'GREATER_THAN') return { hasConflict: false };
  if (comparison === 'EQUAL' && op.clientId === existingOp.clientId) {
    return { hasConflict: false };
  }
  if (comparison === 'EQUAL') {
    return {
      hasConflict: true,
      conflictType: 'equal_different_client',
      reason: `Equal vector clocks from different clients for ${op.entityType}:${entityId} (client ${op.clientId} vs ${existingOp.clientId})`,
      existingClock,
    };
  }
  if (comparison === 'CONCURRENT') {
    return {
      hasConflict: true,
      conflictType: 'concurrent',
      reason: `Concurrent modification detected for ${op.entityType}:${entityId}`,
      existingClock,
    };
  }
  if (comparison === 'LESS_THAN') {
    return {
      hasConflict: true,
      conflictType: 'superseded',
      reason: `Superseded operation: server has newer version of ${op.entityType}:${entityId}`,
      existingClock,
    };
  }
  return {
    hasConflict: true,
    conflictType: 'unknown',
    reason: `Unknown vector clock comparison result for ${op.entityType}:${entityId}`,
    existingClock,
  };
};

const latestForEntity = (
  db: Db,
  userId: number,
  op: Operation,
  entityId: string,
): LatestEntityOp | undefined => {
  const existing = findLatestOpForEntity(db, userId, op.entityType, entityId);
  // Histories written before schema v2 store migrated task settings under
  // GLOBAL_CONFIG:misc. Consult it as an alias for a write targeting `tasks`.
  const legacy =
    op.entityType === 'GLOBAL_CONFIG' && entityId === 'tasks'
      ? findLatestLegacyMiscConfigOp(db, userId, MISC_TASKS_SPLIT_SCHEMA_VERSION)
      : undefined;
  if (legacy && (!existing || legacy.serverSeq > existing.serverSeq)) {
    return legacy;
  }
  return existing;
};

/** Must run inside the upload transaction. */
export const detectConflict = (db: Db, userId: number, op: Operation): ConflictResult => {
  if (
    op.opType === 'SYNC_IMPORT' ||
    op.opType === 'BACKUP_IMPORT' ||
    op.opType === 'REPAIR'
  ) {
    return { hasConflict: false };
  }
  const entityIds = getConflictEntityIds(op);
  if (entityIds.length === 0) return { hasConflict: false };

  const multi = entityIds.length > 1 && !isLegacyMiscConfigOperation(op);
  for (const entityId of entityIds) {
    // The reference's batched multi-entity path does not apply the legacy
    // misc→tasks alias; mirror that by using the plain lookup for it.
    const existing = multi
      ? findLatestOpForEntity(db, userId, op.entityType, entityId)
      : latestForEntity(db, userId, op, entityId);
    if (!existing) continue;
    const result = resolveConflictForExistingOp(op, entityId, existing);
    if (result.hasConflict) return result;
  }
  return { hasConflict: false };
};

export const toStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => toStableJsonValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, toStableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

export const stableJsonStringify = (value: unknown): string =>
  JSON.stringify(toStableJsonValue(value)) ?? 'undefined';

export const areJsonValuesEqual = (a: unknown, b: unknown): boolean =>
  stableJsonStringify(a) === stableJsonStringify(b);

export const isSameDuplicateTimestamp = (
  existingTimestamp: number,
  existingReceivedAt: number,
  incomingStoredTimestamp: number,
  incomingOriginalTimestamp: number,
  maxClockDriftMs: number,
): boolean => {
  if (existingTimestamp === incomingStoredTimestamp) return true;
  return (
    existingTimestamp === existingReceivedAt + maxClockDriftMs &&
    existingTimestamp <= incomingOriginalTimestamp
  );
};

export const isSameDuplicateOperation = (
  existingOp: StoredOperation,
  userId: number,
  op: Operation,
  maxClockDriftMs: number,
  originalTimestamp: number = op.timestamp,
): boolean => {
  const storedClockClientIds =
    existingOp.vectorClock !== null &&
    typeof existingOp.vectorClock === 'object' &&
    !Array.isArray(existingOp.vectorClock)
      ? Object.keys(existingOp.vectorClock)
      : [];
  const storedVectorClock = limitVectorClockSize(op.vectorClock, [
    op.clientId,
    ...storedClockClientIds,
  ]);
  const incomingEncrypted = op.isPayloadEncrypted ?? false;
  const payloadsMatch =
    (existingOp.isPayloadEncrypted && incomingEncrypted) ||
    areJsonValuesEqual(existingOp.payload, op.payload);

  return (
    existingOp.userId === userId &&
    existingOp.clientId === op.clientId &&
    existingOp.actionType === op.actionType &&
    existingOp.opType === op.opType &&
    existingOp.entityType === op.entityType &&
    existingOp.entityId === (op.entityId ?? null) &&
    areJsonValuesEqual(existingOp.entityIds, getStoredEntityIds(op)) &&
    payloadsMatch &&
    areJsonValuesEqual(existingOp.vectorClock, storedVectorClock) &&
    existingOp.schemaVersion === op.schemaVersion &&
    isSameDuplicateTimestamp(
      existingOp.clientTimestamp,
      existingOp.receivedAt,
      op.timestamp,
      originalTimestamp,
      maxClockDriftMs,
    ) &&
    existingOp.isPayloadEncrypted === incomingEncrypted &&
    existingOp.syncImportReason === (op.syncImportReason ?? null) &&
    existingOp.repairBaseServerSeq === (op.repairBaseServerSeq ?? null)
  );
};

/** Complete identity comparison for two validated operations in one request. */
export const isSameIncomingOperation = (
  first: Operation,
  second: Operation,
  firstOriginalTimestamp: number = first.timestamp,
  secondOriginalTimestamp: number = second.timestamp,
): boolean => {
  const bothEncrypted =
    (first.isPayloadEncrypted ?? false) && (second.isPayloadEncrypted ?? false);
  return (
    first.clientId === second.clientId &&
    first.actionType === second.actionType &&
    first.opType === second.opType &&
    first.entityType === second.entityType &&
    first.entityId === second.entityId &&
    areJsonValuesEqual(getStoredEntityIds(first), getStoredEntityIds(second)) &&
    (bothEncrypted || areJsonValuesEqual(first.payload, second.payload)) &&
    areJsonValuesEqual(
      limitVectorClockSize(first.vectorClock, [first.clientId]),
      limitVectorClockSize(second.vectorClock, [second.clientId]),
    ) &&
    first.schemaVersion === second.schemaVersion &&
    firstOriginalTimestamp === secondOriginalTimestamp &&
    (first.isPayloadEncrypted ?? false) === (second.isPayloadEncrypted ?? false) &&
    (first.syncImportReason ?? null) === (second.syncImportReason ?? null) &&
    (first.repairBaseServerSeq ?? null) === (second.repairBaseServerSeq ?? null)
  );
};
