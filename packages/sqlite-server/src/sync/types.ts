import {
  SUPER_SYNC_ERROR_CODES,
  SUPER_SYNC_OP_TYPES,
  type SuperSyncOpType,
} from '@sp/shared-schema';
import type { VectorClock } from '@sp/sync-core';

export type { VectorClock };

export const SYNC_ERROR_CODES = SUPER_SYNC_ERROR_CODES;
export const OP_TYPES = SUPER_SYNC_OP_TYPES;
export type OpType = SuperSyncOpType;

/** Wire/storage shape of an operation (mirrors super-sync-server `Operation`). */
export interface Operation {
  id: string;
  clientId: string;
  actionType: string;
  opType: OpType;
  entityType: string;
  entityId?: string;
  entityIds?: string[];
  payload: unknown;
  vectorClock: VectorClock;
  timestamp: number;
  schemaVersion: number;
  isPayloadEncrypted?: boolean;
  syncImportReason?: string;
  repairBaseServerSeq?: number;
}

export interface ServerOperation {
  serverSeq: number;
  op: Operation;
  receivedAt: number;
}

export interface UploadResult {
  opId: string;
  accepted: boolean;
  serverSeq?: number;
  error?: string;
  errorCode?: string;
  existingClock?: VectorClock;
}

export const STATE_REPLACEMENT_REQUIRED_ERROR =
  'Download the latest full-state replacement before retrying';

export const createStateReplacementRequiredResults = (ops: Operation[]): UploadResult[] =>
  ops.map((op) => ({
    opId: op.id,
    accepted: false,
    error: STATE_REPLACEMENT_REQUIRED_ERROR,
    errorCode: SYNC_ERROR_CODES.INTERNAL_ERROR,
  }));

export const FULL_STATE_OP_TYPES: ReadonlySet<string> = new Set([
  'SYNC_IMPORT',
  'BACKUP_IMPORT',
  'REPAIR',
]);

export const isFullStateOpType = (opType: string): boolean =>
  FULL_STATE_OP_TYPES.has(opType);

/** Full-state ops proven to supersede their prefix (legacy REPAIR without base does not). */
export const isCausalFullStateOperation = (
  op: Pick<Operation, 'opType' | 'repairBaseServerSeq'>,
): boolean =>
  op.opType === 'SYNC_IMPORT' ||
  op.opType === 'BACKUP_IMPORT' ||
  (op.opType === 'REPAIR' && op.repairBaseServerSeq !== undefined);

export interface SyncConfig {
  maxPayloadSizeBytes: number;
  maxClockDriftMs: number;
}

export const MS_PER_MINUTE = 60 * 1000;

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  maxPayloadSizeBytes: 20 * 1024 * 1024,
  maxClockDriftMs: MS_PER_MINUTE,
};

/** A device counts as online when it synced within this window. */
export const ONLINE_DEVICE_THRESHOLD_MS = 5 * MS_PER_MINUTE;

export const ACTION_TYPE_LOAD_ALL_DATA = '[SP_ALL] Load(import) all data';
