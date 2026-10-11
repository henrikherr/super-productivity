import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db, openDatabase } from '../src/db/database';
import { createUser, issueToken } from '../src/auth/tokens';
import { Operation } from '../src/sync/types';
import { RunningServer, startServer } from '../src/index';

/** All test databases live inside the package (inside the allowed work dir). */
export const TMP_ROOT = resolve(__dirname, '.tmp');

export const makeTmpDir = (): string => {
  const dir = join(TMP_ROOT, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const removeTmpDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

export interface TestDb {
  db: Db;
  dir: string;
  path: string;
  reopen(): Db;
  cleanup(): void;
}

/** Opens a real on-disk SQLite database in a fresh temp directory. */
export const createTestDb = (): TestDb => {
  const dir = makeTmpDir();
  const path = join(dir, 'test.sqlite');
  const handle: TestDb = {
    db: openDatabase({ path }),
    dir,
    path,
    reopen: () => {
      handle.db.close();
      handle.db = openDatabase({ path });
      return handle.db;
    },
    cleanup: () => {
      try {
        handle.db.close();
      } catch {
        // already closed
      }
      removeTmpDir(dir);
    },
  };
  return handle;
};

export const createUserWithToken = (
  db: Db,
  email = 'henrik@example.test',
): { userId: number; token: string } => {
  const user = createUser(db, email);
  const { token } = issueToken(db, user.id, 'sync');
  return { userId: user.id, token };
};

let counter = 0;

/** Builds a plausible plaintext task-update operation. */
export const makeOp = (overrides: Partial<Operation> = {}): Operation => {
  counter++;
  const clientId = overrides.clientId ?? 'clientA';
  return {
    id: overrides.id ?? randomUUID(),
    clientId,
    actionType: '[Task Shared] updateTask',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: 'task-1',
    payload: {
      actionPayload: { task: { id: 'task-1', changes: { title: `t${counter}` } } },
      entityChanges: [],
    },
    vectorClock: { [clientId]: counter },
    timestamp: Date.now(),
    schemaVersion: 4,
    ...overrides,
  };
};

/**
 * Ports that `fetch` refuses ("bad port", Fetch spec §port blocking). With
 * `port: 0` the OS may hand one out — Windows' default dynamic range starts at 1024.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

/** `startServer` on an OS-assigned port that `fetch`/`WebSocket` can reach. */
export const startTestServer = async (
  ...args: Parameters<typeof startServer>
): Promise<RunningServer> => {
  for (;;) {
    const server = await startServer(...args);
    if (!FETCH_BLOCKED_PORTS.has(Number(new URL(server.url).port))) return server;
    await server.close();
  }
};
