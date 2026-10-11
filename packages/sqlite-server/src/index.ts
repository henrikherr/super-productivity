import { App } from './app';
import { loadConfigFromEnv, ServerConfig } from './config';
import { scheduleBackups } from './db/backup';
import { Db, openDatabase } from './db/database';
import { acquireProcessLock } from './db/process-lock';
import { loadEngine } from './engine/engine-loader';
import {
  DefaultKeyProvider,
  FileKeyProvider,
  StaticKeyProvider,
} from './projection/encryption-keys';
import { ProjectionModule } from './projection/projection-module';
import { Projector } from './projection/projector';
import { RestApiModule } from './api/rest-api';
import { ServerWriter } from './api/server-writer';
import { StaticFilesModule } from './http/static-files';
import { InfoPageModule } from './http/info-page';
import type { Server } from 'node:http';

export interface RunningServer {
  app: App;
  db: Db;
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Hook for optional modules (projection, REST API, web app) wired by the caller. */
export type ConfigureApp = (app: App, config: ServerConfig) => void | Promise<void>;

export const startServer = async (
  config: ServerConfig,
  configure?: ConfigureApp,
): Promise<RunningServer> => {
  const releaseLock =
    config.dbPath === ':memory:' ? () => undefined : acquireProcessLock(config.dbPath);
  let db: Db | undefined;
  try {
    db = openDatabase({ path: config.dbPath });
    const app = new App({ db, config });
    let projection: ProjectionModule | undefined;
    if (config.projection) {
      const loaded = loadEngine(config.enginePath);
      const keys = config.testDefaultEncryptionPassword
        ? new DefaultKeyProvider(config.testDefaultEncryptionPassword)
        : config.encryptionKeyFile
          ? new FileKeyProvider(db, config.encryptionKeyFile)
          : new StaticKeyProvider(new Map());
      const projector = new Projector(db, loaded, keys);
      projection = new ProjectionModule(projector);
      app.use(projection);
      app.use(new RestApiModule(new ServerWriter(db, projector, app.sync, keys)));
      app.projection = projection;
    }
    app.use(
      config.webRoot ? new StaticFilesModule(config.webRoot) : new InfoPageModule(),
    );
    await configure?.(app, config);
    const server = app.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => resolve());
    });
    void projection?.catchUpAll(app);
    const stopBackups = config.backupDir
      ? scheduleBackups(
          db,
          config.backupDir,
          config.backupIntervalMinutes,
          config.backupKeep,
        )
      : () => undefined;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const openDb = db;
    return {
      app,
      db: openDb,
      server,
      url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`,
      close: async () => {
        stopBackups();
        app.ws.shutdown();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        openDb.close();
        releaseLock();
      },
    };
  } catch (err) {
    db?.close();
    releaseLock();
    throw err;
  }
};

if (require.main === module) {
  const config = loadConfigFromEnv();
  startServer(config)
    .then((running) => {
      console.log(
        `[sp-sqlite-server] listening on ${running.url} (db: ${config.dbPath})`,
      );
      const shutdown = (): void => {
        console.log('[sp-sqlite-server] shutting down');
        running.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[sp-sqlite-server] failed to start:', err);
      process.exit(1);
    });
}
