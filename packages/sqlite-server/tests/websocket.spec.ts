import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RunningServer } from '../src/index';
import { createUser, issueToken } from '../src/auth/tokens';
import { makeOp, makeTmpDir, removeTmpDir, startTestServer } from './helpers';

interface Collected {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
}

const connect = (url: string): Collected => {
  const ws = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return { ws, messages, closed, opened };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('WebSocket /api/sync/ws', () => {
  let dir: string;
  let server: RunningServer;
  let token: string;
  let wsBase: string;

  beforeEach(async () => {
    dir = makeTmpDir();
    server = await startTestServer({
      dbPath: join(dir, 'ws.sqlite'),
      host: '127.0.0.1',
      port: 0,
      testMode: false,
      corsOrigins: [],
      backupIntervalMinutes: 60,
      backupKeep: 1,
      projection: false,
    });
    const user = createUser(server.db, 'ws@example.test');
    token = issueToken(server.db, user.id, 'sync').token;
    wsBase = server.url.replace('http://', 'ws://') + '/api/sync/ws';
  });
  afterEach(async () => {
    await server.close();
    removeTmpDir(dir);
  });

  it('confirms the connection and pushes new_ops to other devices only', async () => {
    const a = connect(`${wsBase}?token=${token}&clientId=clientA`);
    const b = connect(`${wsBase}?token=${token}&clientId=clientB`);
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => a.messages.length > 0 && b.messages.length > 0);
    expect(a.messages[0]).toMatchObject({ type: 'connected' });

    await fetch(`${server.url}/api/sync/ops`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ops: [makeOp({ vectorClock: { clientA: 1 } })],
        clientId: 'clientA',
      }),
    });
    await waitFor(() => b.messages.some((m) => m.type === 'new_ops'));
    expect(b.messages.find((m) => m.type === 'new_ops')).toMatchObject({ latestSeq: 1 });
    expect(a.messages.some((m) => m.type === 'new_ops')).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it('closes with 4003 for an invalid token', async () => {
    const c = connect(`${wsBase}?token=spsq_nope&clientId=clientA`);
    expect((await c.closed).code).toBe(4003);
  });

  it('relays presence state to other devices and replays it to late joiners', async () => {
    const a = connect(`${wsBase}?token=${token}&clientId=clientA`);
    const b = connect(`${wsBase}?token=${token}&clientId=clientB`);
    await Promise.all([a.opened, b.opened]);
    a.ws.send(JSON.stringify({ type: 'presence_state', payload: 'opaque-1' }));
    await waitFor(() => b.messages.some((m) => m.type === 'presence_state'));
    expect(b.messages.find((m) => m.type === 'presence_state')).toMatchObject({
      payload: 'opaque-1',
      ordinal: 1,
      producerConnected: true,
    });
    const late = connect(`${wsBase}?token=${token}&clientId=clientC`);
    await late.opened;
    await waitFor(() => late.messages.some((m) => m.type === 'presence_state'));
    // Producer disconnect is announced.
    a.ws.close();
    await waitFor(() =>
      b.messages.some(
        (m) => m.type === 'presence_state' && m.producerConnected === false,
      ),
    );
    b.ws.close();
    late.ws.close();
  });
});
