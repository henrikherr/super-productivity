import { isIP } from 'node:net';

export interface ServerConfig {
  /** SQLite database file. Must be on a local filesystem (WAL). */
  dbPath: string;
  host: string;
  port: number;
  /** Enables /api/test/* (E2E only). Allowed only on a loopback host. */
  testMode: boolean;
  /** Browser origins allowed to call the API cross-origin. */
  corsOrigins: string[];
  /** Directory for periodic online backups (e.g. a NAS mount); unset = disabled. */
  backupDir?: string;
  backupIntervalMinutes: number;
  backupKeep: number;
  /** Directory with a built web frontend to serve at `/` (optional). */
  webRoot?: string;
  /** File holding `<email>=<sync encryption password>` lines (server-side decryption). */
  encryptionKeyFile?: string;
  /** Relational projection + REST API (needs the engine bundle). Default on. */
  projection: boolean;
  /** Override the engine bundle path (default dist/engine/sp-engine.cjs). */
  enginePath?: string;
  /** TEST MODE ONLY: encryption password assumed for every user (E2E runs). */
  testDefaultEncryptionPassword?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host) || (isIP(host) === 4 && host.startsWith('127.'));

const parseBool = (value: string | undefined): boolean =>
  value === '1' || value?.toLowerCase() === 'true';

export const loadConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ServerConfig => {
  const config: ServerConfig = {
    dbPath: env.SP_SQLITE_DB ?? './data/superprod.sqlite',
    host: env.SP_HOST ?? '127.0.0.1',
    port: Number(env.SP_PORT ?? 1902),
    testMode: parseBool(env.SP_TEST_MODE),
    corsOrigins: (env.SP_CORS_ORIGINS ?? 'https://app.super-productivity.com')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    backupDir: env.SP_BACKUP_DIR || undefined,
    backupIntervalMinutes: Number(env.SP_BACKUP_INTERVAL_MINUTES ?? 60),
    backupKeep: Number(env.SP_BACKUP_KEEP ?? 48),
    webRoot: env.SP_WEB_ROOT || undefined,
    encryptionKeyFile: env.SP_ENCRYPTION_KEY_FILE || undefined,
    projection: (env.SP_PROJECTION ?? 'on').toLowerCase() !== 'off',
    enginePath: env.SP_ENGINE_PATH || undefined,
    testDefaultEncryptionPassword: env.SP_TEST_DEFAULT_ENCRYPTION_PASSWORD || undefined,
  };
  validateConfig(config, parseBool(env.SP_ALLOW_NON_LOOPBACK));
  return config;
};

export const validateConfig = (config: ServerConfig, allowNonLoopback: boolean): void => {
  // 0 = OS-assigned ephemeral port (tests).
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid SP_PORT: ${config.port}`);
  }
  if (!isLoopbackHost(config.host) && !allowNonLoopback) {
    throw new Error(
      `Refusing to bind to non-loopback host "${config.host}". Expose the server through ` +
        '`tailscale serve` (recommended) or set SP_ALLOW_NON_LOOPBACK=true deliberately.',
    );
  }
  if (config.testMode && !isLoopbackHost(config.host)) {
    throw new Error('SP_TEST_MODE is only allowed on a loopback host');
  }
  if (config.testDefaultEncryptionPassword && !config.testMode) {
    throw new Error('SP_TEST_DEFAULT_ENCRYPTION_PASSWORD requires SP_TEST_MODE');
  }
  if (config.corsOrigins.includes('*')) {
    throw new Error('SP_CORS_ORIGINS must list explicit origins; "*" is not allowed');
  }
  if (
    config.backupDir &&
    (!(config.backupIntervalMinutes > 0) || !(config.backupKeep >= 1))
  ) {
    throw new Error('Invalid backup interval/keep settings');
  }
};
