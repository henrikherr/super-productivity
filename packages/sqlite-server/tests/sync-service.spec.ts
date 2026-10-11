import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SyncService } from '../src/sync/sync-service';
import { uploadOps } from '../src/sync/upload';
import {
  DEFAULT_SYNC_CONFIG,
  Operation,
  ServerOperation,
  UploadResult,
} from '../src/sync/types';
import { createTestDb, createUserWithToken, makeOp, TestDb } from './helpers';

type UploadBody = {
  results: UploadResult[];
  latestSeq: number;
  newOps?: ServerOperation[];
};
type DownloadBody = {
  ops: ServerOperation[];
  latestSeq: number;
  hasMore: boolean;
  gapDetected?: boolean;
  snapshotVectorClock?: Record<string, number>;
};

describe('SyncService (SuperSync protocol on SQLite)', () => {
  let t: TestDb;
  let sync: SyncService;
  let userId: number;

  beforeEach(() => {
    t = createTestDb();
    sync = new SyncService(t.db);
    userId = createUserWithToken(t.db).userId;
  });
  afterEach(() => t.cleanup());

  const upload = async (
    ops: Operation[],
    extra: Record<string, unknown> = {},
  ): Promise<UploadBody> => {
    const res = await sync.uploadOps(userId, {
      ops,
      clientId: ops[0].clientId,
      ...extra,
    });
    expect(res.status).toBe(200);
    return res.body as UploadBody;
  };
  const download = (query: Record<string, unknown>): DownloadBody => {
    const res = sync.downloadOps(userId, query);
    expect(res.status).toBe(200);
    return res.body as DownloadBody;
  };

  it('accepts ops, assigns consecutive server seqs and returns them on download', async () => {
    const a = makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 } });
    const b = makeOp({ clientId: 'clientA', vectorClock: { clientA: 2 } });
    const res = await upload([a, b]);
    expect(res.results.map((r) => [r.accepted, r.serverSeq])).toEqual([
      [true, 1],
      [true, 2],
    ]);
    expect(res.latestSeq).toBe(2);
    const dl = download({ sinceSeq: '0' });
    expect(dl.ops.map((o) => o.op.id)).toEqual([a.id, b.id]);
    expect(dl.ops[0].op.payload).toEqual(a.payload);
    expect(dl.hasMore).toBe(false);
  });

  it('persists the op log across a server restart', async () => {
    const a = makeOp({ vectorClock: { clientA: 1 } });
    await upload([a]);
    t.reopen();
    sync = new SyncService(t.db);
    const dl = download({ sinceSeq: '0' });
    expect(dl.ops).toHaveLength(1);
    expect(dl.ops[0].op).toMatchObject({
      id: a.id,
      actionType: a.actionType,
      entityId: 'task-1',
    });
    // sequence continues after restart
    const b = makeOp({ vectorClock: { clientA: 2 } });
    expect((await upload([b])).results[0].serverSeq).toBe(2);
  });

  it('excludes the caller own ops and pages with hasMore', async () => {
    await upload([
      makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 }, entityId: 'x1' }),
    ]);
    await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 1 }, entityId: 'x2' }),
    ]);
    await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 2 }, entityId: 'x3' }),
    ]);
    expect(
      download({ sinceSeq: '0', excludeClient: 'clientA' }).ops.map((o) => o.serverSeq),
    ).toEqual([2, 3]);
    const page = download({ sinceSeq: '0', limit: '2' });
    expect(page.ops).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it('rejects an exact retry as DUPLICATE_OPERATION and an id reuse as INVALID_OP_ID', async () => {
    const a = makeOp({ vectorClock: { clientA: 1 } });
    await upload([a]);
    const retry = await upload([{ ...a }]);
    expect(retry.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'DUPLICATE_OPERATION',
    });
    const reuse = await upload([{ ...a, actionType: '[Task Shared] deleteTask' }]);
    expect(reuse.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'INVALID_OP_ID',
    });
    expect(download({ sinceSeq: '0' }).ops).toHaveLength(1);
  });

  it('detects concurrent and superseded writes on the same entity', async () => {
    await upload([makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 } })]);
    // B never saw A's write → concurrent
    const concurrent = await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 1 } }),
    ]);
    expect(concurrent.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'CONFLICT_CONCURRENT',
      existingClock: { clientA: 1 },
    });
    // B after merging A's clock → accepted
    const merged = await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientA: 1, clientB: 2 } }),
    ]);
    expect(merged.results[0].accepted).toBe(true);
    // A with an old clock → superseded
    const stale = await upload([
      makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 } }),
    ]);
    expect(stale.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'CONFLICT_SUPERSEDED',
    });
  });

  it('checks every entity of a multi-entity op (entityIds), not only the first', async () => {
    await upload([
      makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 }, entityId: 'task-2' }),
    ]);
    const batch = makeOp({
      clientId: 'clientB',
      vectorClock: { clientB: 1 },
      opType: 'BATCH',
      entityId: 'task-1',
      entityIds: ['task-1', 'task-2'],
    });
    const res = await upload([batch]);
    expect(res.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'CONFLICT_CONCURRENT',
    });

    // A later single-entity write to task-3 must see a stored batch op touching it.
    const okBatch = makeOp({
      clientId: 'clientA',
      vectorClock: { clientA: 2 },
      opType: 'BATCH',
      entityId: 'task-1',
      entityIds: ['task-1', 'task-3'],
    });
    expect((await upload([okBatch])).results[0].accepted).toBe(true);
    const later = await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 2 }, entityId: 'task-3' }),
    ]);
    expect(later.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'CONFLICT_CONCURRENT',
    });
  });

  it('lets concurrent time-tracking deltas through (they commute)', async () => {
    const delta = (clientId: string, n: number): Operation =>
      makeOp({
        clientId,
        vectorClock: { [clientId]: n },
        actionType: '[TimeTracking] Sync time spent',
        payload: {
          actionPayload: { taskId: 'task-1', date: '2026-10-09', duration: 60000 },
        },
      });
    expect((await upload([delta('clientA', 1)])).results[0].accepted).toBe(true);
    expect((await upload([delta('clientB', 1)])).results[0].accepted).toBe(true);
  });

  it('validates ops per item without failing the batch', async () => {
    const good = makeOp({ vectorClock: { clientA: 1 } });
    const bad = makeOp({ entityType: 'NOPE', vectorClock: { clientA: 2 } });
    const res = await upload([good, bad]);
    expect(res.results[0].accepted).toBe(true);
    expect(res.results[1]).toMatchObject({
      accepted: false,
      errorCode: 'INVALID_ENTITY_TYPE',
    });
  });

  it('rejects a malformed request with 400 and an oversized batch with 413', async () => {
    expect((await sync.uploadOps(userId, { ops: [], clientId: 'c' })).status).toBe(400);
    const many = Array.from({ length: 101 }, () => makeOp());
    expect(
      (await sync.uploadOps(userId, { ops: many, clientId: 'clientA' })).status,
    ).toBe(413);
  });

  it('detects gaps: client ahead, and server emptied', async () => {
    await upload([makeOp({ vectorClock: { clientA: 1 } })]);
    expect(download({ sinceSeq: '5' }).gapDetected).toBe(true);
    sync.deleteAllData(userId);
    const dl = download({ sinceSeq: '1' });
    expect(dl).toMatchObject({ latestSeq: 0, gapDetected: true, ops: [] });
  });

  it('fast-forwards downloads to the latest full-state op and sends its clock', async () => {
    await upload([
      makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 }, entityId: 'e1' }),
    ]);
    await upload([
      makeOp({ clientId: 'clientC', vectorClock: { clientC: 7 }, entityId: 'e2' }),
    ]);
    const snap = await sync.uploadSnapshot(userId, {
      state: { task: { ids: [], entities: {} } },
      clientId: 'clientB',
      reason: 'recovery',
      vectorClock: { clientB: 3 },
      schemaVersion: 4,
      opId: randomUUID(),
    });
    expect(snap.body).toMatchObject({ accepted: true, serverSeq: 3 });
    await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 4 }, entityId: 'e3' }),
    ]);

    const dl = download({ sinceSeq: '0', excludeClient: 'clientD' });
    expect(dl.ops.map((o) => o.serverSeq)).toEqual([3, 4]);
    expect(dl.ops[0].op.opType).toBe('SYNC_IMPORT');
    // aggregate of prior history ∪ snapshot clock
    expect(dl.snapshotVectorClock).toEqual({ clientA: 1, clientB: 3, clientC: 7 });
    expect(dl.gapDetected).toBeUndefined();
  });

  it('rejects a second initial SYNC_IMPORT but accepts its idempotent retry', async () => {
    const opId = randomUUID();
    const body = {
      state: { a: 1 },
      clientId: 'clientA',
      reason: 'initial',
      vectorClock: { clientA: 1 },
      opId,
    };
    expect((await sync.uploadSnapshot(userId, body)).body).toMatchObject({
      accepted: true,
    });
    expect((await sync.uploadSnapshot(userId, body)).body).toMatchObject({
      accepted: true,
      serverSeq: 1,
    });
    const other = await sync.uploadSnapshot(userId, {
      ...body,
      opId: randomUUID(),
      clientId: 'clientB',
    });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ errorCode: 'SYNC_IMPORT_EXISTS' });
  });

  it('clean-slate snapshot wipes history but never reuses sequence numbers', async () => {
    await upload([makeOp({ vectorClock: { clientA: 1 } })]);
    await upload([makeOp({ vectorClock: { clientA: 2 } })]);
    const res = await sync.uploadSnapshot(userId, {
      state: { fresh: true },
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: 3 },
      opId: randomUUID(),
      isCleanSlate: true,
    });
    expect(res.body).toMatchObject({ accepted: true, serverSeq: 3 });
    const dl = download({ sinceSeq: '0' });
    expect(dl.ops.map((o) => o.serverSeq)).toEqual([3]);
  });

  it('fences uploads from clients that have not seen the latest state replacement', async () => {
    await upload([makeOp({ clientId: 'clientA', vectorClock: { clientA: 1 } })]);
    await sync.uploadSnapshot(userId, {
      state: {},
      clientId: 'clientB',
      reason: 'recovery',
      vectorClock: { clientB: 1 },
      opId: randomUUID(),
      snapshotOpType: 'BACKUP_IMPORT',
    });
    const fenced = await upload(
      [makeOp({ clientId: 'clientA', vectorClock: { clientA: 2 }, entityId: 'zz' })],
      { lastKnownServerSeq: 1 },
    );
    expect(fenced.results[0]).toMatchObject({
      accepted: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Download the latest full-state replacement before retrying',
    });
    // Boundary op is piggybacked even though it would otherwise be excluded.
    expect(fenced.newOps?.map((o) => o.serverSeq)).toEqual([2]);
    const ok = await upload(
      [
        makeOp({
          clientId: 'clientA',
          vectorClock: { clientA: 2, clientB: 1 },
          entityId: 'zz',
        }),
      ],
      { lastKnownServerSeq: 2 },
    );
    expect(ok.results[0].accepted).toBe(true);
  });

  it('rejects a stale causal REPAIR and accepts a current one', async () => {
    await upload([makeOp({ vectorClock: { clientA: 1 } })]);
    const stale = await sync.uploadSnapshot(userId, {
      state: {},
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: 2 },
      opId: randomUUID(),
      snapshotOpType: 'REPAIR',
      repairBaseServerSeq: 0,
    });
    expect(stale.body).toMatchObject({ accepted: false, errorCode: 'REPAIR_STALE' });
    const current = await sync.uploadSnapshot(userId, {
      state: {},
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: 2 },
      opId: randomUUID(),
      snapshotOpType: 'REPAIR',
      repairBaseServerSeq: 1,
    });
    expect(current.body).toMatchObject({ accepted: true, serverSeq: 2 });
  });

  it('returns cached results for a retried requestId with piggybacked ops', async () => {
    const a = makeOp({ vectorClock: { clientA: 1 } });
    const first = await upload([a], { requestId: 'req-1', lastKnownServerSeq: 0 });
    await upload([
      makeOp({ clientId: 'clientB', vectorClock: { clientB: 1 }, entityId: 'other' }),
    ]);
    const retry = (
      await sync.uploadOps(userId, {
        ops: [a],
        clientId: 'clientA',
        requestId: 'req-1',
        lastKnownServerSeq: 0,
      })
    ).body as UploadBody & { deduplicated?: boolean };
    expect(retry.deduplicated).toBe(true);
    expect(retry.results).toEqual(first.results);
    expect(retry.newOps?.map((o) => o.op.clientId)).toEqual(['clientB']);
  });

  it('rolls back every op of the request when the in-transaction hook fails', () => {
    const ops = [
      makeOp({ vectorClock: { clientA: 1 } }),
      makeOp({ vectorClock: { clientA: 2 }, entityId: 'b' }),
    ];
    const results = uploadOps(t.db, userId, 'clientA', ops, DEFAULT_SYNC_CONFIG, {
      onAccepted: () => {
        throw new Error('projection failed');
      },
    });
    expect(results.every((r) => !r.accepted && r.errorCode === 'INTERNAL_ERROR')).toBe(
      true,
    );
    expect(download({ sinceSeq: '0' }).ops).toHaveLength(0);
    // allocator rolled back too
    const retry = uploadOps(t.db, userId, 'clientA', ops, DEFAULT_SYNC_CONFIG);
    expect(retry.map((r) => r.serverSeq)).toEqual([1, 2]);
  });

  it('isolates users from each other', async () => {
    await upload([makeOp({ vectorClock: { clientA: 1 } })]);
    const other = createUserWithToken(t.db, 'other@example.test').userId;
    expect(
      (sync.downloadOps(other, { sinceSeq: '0' }).body as DownloadBody).ops,
    ).toHaveLength(0);
    // Same entity id for another user is not a conflict.
    const res = await sync.uploadOps(other, {
      ops: [makeOp({ clientId: 'clientZ', vectorClock: { clientZ: 1 } })],
      clientId: 'clientZ',
    });
    expect((res.body as UploadBody).results[0].accepted).toBe(true);
  });

  it('reports status, devices and restore points', async () => {
    await upload([makeOp({ vectorClock: { clientA: 1 } })]);
    download({ sinceSeq: '0', excludeClient: 'clientA', appVersion: '18.22.0' });
    await sync.uploadSnapshot(userId, {
      state: {},
      clientId: 'clientA',
      reason: 'recovery',
      vectorClock: { clientA: 2 },
      opId: randomUUID(),
      snapshotOpType: 'BACKUP_IMPORT',
    });
    expect(sync.status(userId).body).toMatchObject({ latestSeq: 2, devicesOnline: 1 });
    expect((sync.devices(userId).body as { devices: unknown[] }).devices).toHaveLength(1);
    expect(sync.restorePoints(userId, undefined).body).toMatchObject({
      restorePoints: [
        { serverSeq: 2, type: 'BACKUP_IMPORT', description: 'Backup restore' },
      ],
    });
    expect(sync.restorePoints(userId, '0').status).toBe(400);
    expect(sync.restore(userId, '99').status).toBe(400);
  });
});
