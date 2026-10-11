/**
 * Operation download with gap detection and full-state fast-forward.
 * Ported from super-sync-server operation-download.service.ts.
 */
import { limitVectorClockSize } from '@sp/sync-core';
import { Db } from '../db/database';
import {
  aggregateVectorClock,
  findLatestCausalFullState,
  getMinRetainedSeq,
  getOperationsInRange,
  getSyncState,
  storedToServerOperation,
} from './op-store';
import { ServerOperation, VectorClock } from './types';

export interface DownloadResult {
  ops: ServerOperation[];
  latestSeq: number;
  gapDetected: boolean;
  latestSnapshotSeq?: number;
  snapshotVectorClock?: VectorClock;
}

const parsePersistedVectorClock = (value: string | null): VectorClock | undefined => {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const clock: VectorClock = {};
  for (const [cid, counter] of Object.entries(parsed as Record<string, unknown>)) {
    if (cid.length === 0) return undefined;
    if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
      return undefined;
    }
    clock[cid] = counter;
  }
  return clock;
};

/**
 * Reads ops after `sinceSeq`. A single synchronous read is consistent because
 * no writer can interleave (see upload.ts concurrency note); WAL readers also
 * see a stable snapshot per statement.
 */
export const getOpsSinceWithSeq = (
  db: Db,
  userId: number,
  sinceSeq: number,
  excludeClient: string | undefined,
  limit: number,
  includeSnapshotMetadata = true,
): DownloadResult => {
  const state = getSyncState(db, userId);
  const latestSeq = state?.last_seq ?? 0;

  if (latestSeq === 0) {
    return { ops: [], latestSeq: 0, gapDetected: sinceSeq > 0 };
  }

  const latestFullState = findLatestCausalFullState(db, userId, latestSeq);
  const latestSnapshotSeq = latestFullState?.serverSeq;

  let effectiveSinceSeq = sinceSeq;
  let shouldComputeSnapshotVectorClock = false;
  if (latestSnapshotSeq !== undefined && sinceSeq < latestSnapshotSeq) {
    // Pre-import ops are superseded; start AT the full-state op.
    effectiveSinceSeq = latestSnapshotSeq - 1;
    shouldComputeSnapshotVectorClock = includeSnapshotMetadata;
  }

  const stored = getOperationsInRange(
    db,
    userId,
    effectiveSinceSeq,
    latestSeq,
    limit,
    excludeClient,
  );

  let minSeq: number | null = null;
  if (sinceSeq > 0 || stored.length === 0) {
    minSeq = getMinRetainedSeq(db, userId, latestSeq);
  }

  // A wiped account keeps its allocation counter but must look empty.
  if (stored.length === 0 && minSeq === null) {
    return { ops: [], latestSeq: 0, gapDetected: sinceSeq > 0 };
  }

  let gapDetected = false;
  if (sinceSeq > latestSeq && latestSeq > 0) {
    gapDetected = true;
  }
  if (sinceSeq > 0 && latestSeq > 0) {
    if (minSeq !== null && effectiveSinceSeq < minSeq - 1) {
      gapDetected = true;
    }
    if (
      !excludeClient &&
      stored.length > 0 &&
      stored[0].serverSeq > effectiveSinceSeq + 1
    ) {
      gapDetected = true;
    }
  }

  let snapshotVectorClock: VectorClock | undefined;
  if (shouldComputeSnapshotVectorClock && latestSnapshotSeq !== undefined) {
    const preserve: string[] = [];
    if (excludeClient) preserve.push(excludeClient);
    if (latestFullState?.clientId) preserve.push(latestFullState.clientId);
    const persisted =
      state?.latest_full_state_seq === latestSnapshotSeq
        ? parsePersistedVectorClock(state.latest_full_state_vector_clock)
        : undefined;
    snapshotVectorClock = limitVectorClockSize(
      persisted ?? aggregateVectorClock(db, userId, { upTo: latestSnapshotSeq }),
      preserve,
    );
  }

  return {
    ops: stored.map(storedToServerOperation),
    latestSeq,
    gapDetected,
    latestSnapshotSeq,
    snapshotVectorClock,
  };
};
