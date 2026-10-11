/**
 * Operation validation. Ported from
 * packages/super-sync-server/src/sync/services/validation.service.ts and
 * packages/super-sync-server/src/sync/sync.types.ts (sanitizeVectorClock,
 * validatePayload) so both servers accept and reject exactly the same ops.
 * Keep in sync when the reference changes.
 */
import { ENTITY_TYPES, SUPER_SYNC_MAX_ENTITY_IDS_PER_OP } from '@sp/shared-schema';
import { MAX_VECTOR_CLOCK_SIZE } from '@sp/sync-core';
import {
  isFullStateOpType,
  Operation,
  OP_TYPES,
  OpType,
  SYNC_ERROR_CODES,
  SyncConfig,
  VectorClock,
} from './types';

export const ALLOWED_ENTITY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPES);
export const TASK_TIME_DELTA_ACTION_TYPE = '[TimeTracking] Sync time spent';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
  /** UTF-8 size of the JSON payload; set on valid results. */
  payloadBytes?: number;
}

const isValidCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
};

const extractActionPayloadRecord = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const payloadObject = payload as Record<string, unknown>;
  const actionPayload = payloadObject['actionPayload'];
  return actionPayload &&
    typeof actionPayload === 'object' &&
    !Array.isArray(actionPayload)
    ? (actionPayload as Record<string, unknown>)
    : payloadObject;
};

export const sanitizeVectorClock = (
  clock: unknown,
): { valid: true; clock: VectorClock } | { valid: false; error: string } => {
  if (typeof clock !== 'object' || clock === null || Array.isArray(clock)) {
    return { valid: false, error: 'Vector clock must be an object' };
  }
  const entries = Object.entries(clock as Record<string, unknown>);
  const maxSanitizeSize = Math.ceil(MAX_VECTOR_CLOCK_SIZE * 2.5);
  if (entries.length > maxSanitizeSize) {
    return {
      valid: false,
      error: `Vector clock has too many entries (${entries.length}, max ${maxSanitizeSize})`,
    };
  }
  const sanitized: VectorClock = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 255) continue;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100_000_000
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return { valid: true, clock: sanitized };
};

export const validatePayload = (
  opType: OpType,
  payload: unknown,
): { valid: boolean; error?: string } => {
  if (isFullStateOpType(opType)) return { valid: true };
  if (opType === 'DEL') {
    if (payload === null || payload === undefined) return { valid: true };
    if (typeof payload === 'object' && !Array.isArray(payload)) return { valid: true };
    if (typeof payload === 'string') return { valid: true };
    return {
      valid: false,
      error: 'DEL payload must be null, an object, or an encrypted string',
    };
  }
  if (typeof payload === 'string') return { valid: true };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { valid: false, error: `${opType} payload must be a non-null object` };
  }
  const payloadObj = payload as Record<string, unknown>;
  if (opType === 'BATCH' && 'entities' in payloadObj) {
    if (
      typeof payloadObj['entities'] !== 'object' ||
      payloadObj['entities'] === null ||
      Array.isArray(payloadObj['entities'])
    ) {
      return { valid: false, error: 'BATCH entities must be an object keyed by ID' };
    }
  }
  return { valid: true };
};

export const validatePayloadComplexity = (
  payload: unknown,
  maxDepth = 20,
  maxKeys = 20000,
): boolean => {
  let totalKeys = 0;
  const checkDepth = (obj: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false;
    if (obj === null || typeof obj !== 'object') return true;
    if (Array.isArray(obj)) {
      totalKeys += obj.length;
      if (totalKeys > maxKeys) return false;
      return obj.every((item) => checkDepth(item, depth + 1));
    }
    const keys = Object.keys(obj);
    totalKeys += keys.length;
    if (totalKeys > maxKeys) return false;
    return keys.every((key) =>
      checkDepth((obj as Record<string, unknown>)[key], depth + 1),
    );
  };
  return checkDepth(payload, 0);
};

const invalid = (error: string, errorCode: string): ValidationResult => ({
  valid: false,
  error,
  errorCode,
});

/** Validates an operation. Mutates `op.vectorClock` to its sanitized form. */
export const validateOp = (
  op: Operation,
  requestClientId: string,
  config: SyncConfig,
): ValidationResult => {
  if (op.clientId !== requestClientId) {
    return invalid(
      `Operation clientId "${op.clientId}" does not match request clientId "${requestClientId}"`,
      SYNC_ERROR_CODES.INVALID_CLIENT_ID,
    );
  }
  if (!op.id || typeof op.id !== 'string') {
    return invalid('Invalid operation ID', SYNC_ERROR_CODES.INVALID_OP_ID);
  }
  if (op.id.length > 255) {
    return invalid('Operation ID too long', SYNC_ERROR_CODES.INVALID_OP_ID);
  }
  if (!op.opType || !(OP_TYPES as readonly string[]).includes(op.opType)) {
    return invalid('Invalid opType', SYNC_ERROR_CODES.INVALID_OP_TYPE);
  }
  if (!op.entityType) {
    return invalid('Missing entityType', SYNC_ERROR_CODES.INVALID_ENTITY_TYPE);
  }
  if (!ALLOWED_ENTITY_TYPES.has(op.entityType)) {
    return invalid(
      `Invalid entityType: ${op.entityType}`,
      SYNC_ERROR_CODES.INVALID_ENTITY_TYPE,
    );
  }
  if (op.entityId !== undefined && op.entityId !== null) {
    if (typeof op.entityId !== 'string' || op.entityId.length > 255) {
      return invalid(
        'Invalid entityId format or length',
        SYNC_ERROR_CODES.INVALID_ENTITY_ID,
      );
    }
    if (op.entityId.trim().length === 0) {
      return invalid(
        'entityId cannot be empty or whitespace-only',
        SYNC_ERROR_CODES.INVALID_ENTITY_ID,
      );
    }
  }
  if (op.entityIds !== undefined && op.entityIds !== null) {
    if (
      !Array.isArray(op.entityIds) ||
      op.entityIds.length > SUPER_SYNC_MAX_ENTITY_IDS_PER_OP
    ) {
      return invalid(
        'Invalid entityIds: not an array or too many entries',
        SYNC_ERROR_CODES.INVALID_ENTITY_ID,
      );
    }
    for (const id of op.entityIds) {
      if (typeof id !== 'string' || id.length > 255 || id.trim().length === 0) {
        return invalid(
          'Invalid entityIds element: must be a non-empty string <= 255 chars',
          SYNC_ERROR_CODES.INVALID_ENTITY_ID,
        );
      }
    }
  }
  const isFullStateOp = isFullStateOpType(op.opType);
  const isBulkEntityType = op.entityType === 'ALL' || op.entityType === 'RECOVERY';
  if (!isFullStateOp && !isBulkEntityType && !op.entityId) {
    return invalid(
      `Operation ${op.opType} on ${op.entityType} requires entityId`,
      SYNC_ERROR_CODES.MISSING_ENTITY_ID,
    );
  }
  if (op.payload === undefined) {
    return invalid('Missing payload', SYNC_ERROR_CODES.INVALID_PAYLOAD);
  }
  if (op.actionType === TASK_TIME_DELTA_ACTION_TYPE && !op.isPayloadEncrypted) {
    const actionPayload = extractActionPayloadRecord(op.payload);
    if (
      !actionPayload ||
      actionPayload['taskId'] !== op.entityId ||
      !isValidCalendarDate(actionPayload['date']) ||
      typeof actionPayload['duration'] !== 'number' ||
      !Number.isFinite(actionPayload['duration']) ||
      actionPayload['duration'] < 0
    ) {
      return invalid('Invalid task-time sync payload', SYNC_ERROR_CODES.INVALID_PAYLOAD);
    }
  }
  if (op.schemaVersion !== undefined) {
    if (
      !Number.isInteger(op.schemaVersion) ||
      op.schemaVersion < 1 ||
      op.schemaVersion > 100
    ) {
      return invalid(
        `Invalid schema version: ${op.schemaVersion}`,
        SYNC_ERROR_CODES.INVALID_SCHEMA_VERSION,
      );
    }
  }
  if (!Number.isSafeInteger(op.timestamp)) {
    return invalid('Invalid timestamp', SYNC_ERROR_CODES.INVALID_TIMESTAMP);
  }
  const clockValidation = sanitizeVectorClock(op.vectorClock);
  if (!clockValidation.valid) {
    return invalid(clockValidation.error, SYNC_ERROR_CODES.INVALID_VECTOR_CLOCK);
  }
  op.vectorClock = clockValidation.clock;

  const maxDepth = isFullStateOp ? 50 : 20;
  const maxKeys = isFullStateOp ? 500000 : 20000;
  if (!validatePayloadComplexity(op.payload, maxDepth, maxKeys)) {
    return invalid(
      `Payload too complex (max depth ${maxDepth}, max keys ${maxKeys})`,
      SYNC_ERROR_CODES.INVALID_PAYLOAD,
    );
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(op.payload), 'utf8');
  if (payloadBytes > config.maxPayloadSizeBytes) {
    return invalid('Payload too large', SYNC_ERROR_CODES.PAYLOAD_TOO_LARGE);
  }
  const payloadValidation = validatePayload(op.opType, op.payload);
  if (!payloadValidation.valid) {
    return invalid(
      payloadValidation.error ?? 'Invalid payload',
      SYNC_ERROR_CODES.INVALID_PAYLOAD,
    );
  }
  return { valid: true, payloadBytes };
};
