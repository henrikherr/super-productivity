import { test, expect } from '../../fixtures/supersync.fixture';
import {
  SUPERSYNC_BASE_URL,
  createTestUser,
  getSuperSyncConfig,
  createSimulatedClient,
  closeClient,
  waitForTask,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';
import { expectTaskOnAllClients } from '../../utils/supersync-assertions';

/**
 * Full round trip through the self-hosted SQLite server (packages/sqlite-server):
 * app UI → SuperSync upload → SQLite op log → relational projection → REST API
 * (as used by superprod-mcp) → server-authored op → app UI, plus a fresh
 * device restoring everything from the server.
 *
 * Runs only against the SQLite server (it exposes /api/v1); skips against the
 * Postgres SuperSync server. The server must run with SP_TEST_MODE and
 * SP_TEST_DEFAULT_ENCRYPTION_PASSWORD=e2e-default-encryption-pw so it can
 * decrypt the clients' encrypted payloads. See sqlite-roadmap.md §9.
 */

type ApiTask = { id: string; title: string; isDone: boolean };

const isSqliteServer = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${SUPERSYNC_BASE_URL}/api/v1/health`);
    const body = (await res.json()) as { data?: { server?: string } };
    return body.data?.server === 'sp-sqlite-server';
  } catch {
    return false;
  }
};

test.describe('@supersync @sqliteserver SQLite server round trip', () => {
  test('UI ⇄ SQLite projection ⇄ REST API (MCP) ⇄ fresh device', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.skip(!(await isSqliteServer()), 'requires packages/sqlite-server');
    let clientA: SimulatedE2EClient | null = null;
    let clientB: SimulatedE2EClient | null = null;
    try {
      const user = await createTestUser(testRunId);
      const syncConfig = getSuperSyncConfig(user);
      const tokenRes = await fetch(
        `${SUPERSYNC_BASE_URL}/api/test/user/${user.userId}/api-token`,
        { method: 'POST' },
      );
      const apiToken = ((await tokenRes.json()) as { token: string }).token;
      const api = async (
        method: string,
        path: string,
        body?: unknown,
      ): Promise<unknown> => {
        const res = await fetch(`${SUPERSYNC_BASE_URL}/api/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${apiToken}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = (await res.json()) as { ok: boolean; data: unknown };
        expect(json.ok, `${method} ${path}`).toBe(true);
        return json.data;
      };

      // 1) A task created in the app reaches the SQLite projection.
      clientA = await createSimulatedClient(browser, baseURL!, 'A', testRunId);
      await clientA.sync.setupSuperSync(syncConfig);
      const uiTask = `Task-${testRunId}-from-ui`;
      await clientA.workView.addTask(uiTask);
      await clientA.sync.syncAndWait();
      // The simulated client prefixes titles with its name (`A-<runId>-…`).
      await expect
        .poll(async () =>
          ((await api('GET', '/tasks')) as ApiTask[]).some((t) =>
            t.title.endsWith(uiTask),
          ),
        )
        .toBe(true);

      // 2) A write through the REST API (what the MCP does) shows up in the app.
      const apiTitle = `Task-${testRunId}-from-api`;
      // Due today so it shows up in the Today view the simulated client is on.
      const now = new Date();
      const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
        .map((n) => String(n).padStart(2, '0'))
        .join('-');
      const created = (await api('POST', '/tasks', {
        title: apiTitle,
        dueDay: today,
      })) as ApiTask;
      expect(created.title).toBe(apiTitle);
      await clientA.sync.syncAndWait();
      await waitForTask(clientA.page, apiTitle);

      // 3) Completing it via API is reflected after sync too.
      await api('PATCH', `/tasks/${created.id}`, { isDone: true });
      const doneList = (await api('GET', '/tasks?includeDone=true')) as ApiTask[];
      expect(doneList.find((t) => t.id === created.id)?.isDone).toBe(true);

      // 4) A brand-new device restores the full state from the server.
      clientB = await createSimulatedClient(browser, baseURL!, 'B', testRunId);
      await clientB.sync.setupSuperSync(syncConfig);
      await clientB.sync.syncAndWait();
      await expectTaskOnAllClients([clientA, clientB], uiTask);
      await waitForTask(clientB.page, apiTitle);
    } finally {
      if (clientA) await closeClient(clientA);
      if (clientB) await closeClient(clientB);
    }
  });
});
