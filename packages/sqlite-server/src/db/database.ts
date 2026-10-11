import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Migration, MIGRATIONS } from './migrations';

export type Db = DatabaseSync;

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown,
  ) {
    super(
      `Database migration ${version} (${migrationName}) failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = 'MigrationError';
  }
}

export interface OpenDatabaseOptions {
  /** Path to the database file, or ':memory:' (tests only). */
  path: string;
  /** Override the migration list (tests). */
  migrations?: readonly Migration[];
  /** Milliseconds a writer waits for a competing writer before SQLITE_BUSY. */
  busyTimeoutMs?: number;
}

/**
 * Opens (and creates) the server database, applies connection pragmas and runs
 * pending migrations. Throws {@link MigrationError} if a migration fails; the
 * database then stays at the last successfully applied version.
 */
export const openDatabase = (options: OpenDatabaseOptions): Db => {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(resolve(options.path)), { recursive: true });
  }
  const db = new DatabaseSync(options.path);
  try {
    applyPragmas(db, options.busyTimeoutMs ?? 5000);
    runMigrations(db, options.migrations ?? MIGRATIONS, {
      preMigrationBackupPath:
        options.path === ':memory:'
          ? undefined
          : (v) =>
              `${resolve(options.path)}.pre-v${v}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
    });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
};

const applyPragmas = (db: Db, busyTimeoutMs: number): void => {
  // WAL: readers never block the single writer; required for concurrent HTTP
  // reads while an upload commits. Only valid on a local filesystem.
  db.exec('PRAGMA journal_mode = WAL');
  // FULL: an acknowledged upload survives power loss (Raspberry Pi target).
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
};

export const getSchemaVersion = (db: Db): number => {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
};

export interface RunMigrationsOptions {
  /** Where to write a full copy before migrating an existing database (gets the current version). */
  preMigrationBackupPath?: (currentVersion: number) => string;
}

export const runMigrations = (
  db: Db,
  migrations: readonly Migration[],
  options: RunMigrationsOptions = {},
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be consecutive from 1; found ${migration.version} at position ${index + 1}`,
      );
    }
  });

  const current = getSchemaVersion(db);
  const known = sorted.length;
  if (current > known) {
    throw new Error(
      `Database schema version ${current} is newer than this server (${known}). ` +
        'Refusing to start; update the server instead of downgrading the database.',
    );
  }
  if (current > 0 && current < known && options.preMigrationBackupPath) {
    // Consistent copy of the existing data before the first schema change.
    const target = options.preMigrationBackupPath(current);
    db.prepare('VACUUM INTO ?').run(target);
  }

  for (const migration of sorted) {
    if (migration.version <= current) continue;
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.name, Date.now());
      });
    } catch (err) {
      throw new MigrationError(migration.version, migration.name, err);
    }
  }
};

/**
 * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`. Rolls back on any throw.
 *
 * `fn` MUST be synchronous: node:sqlite is synchronous, and keeping the whole
 * transaction inside one JavaScript turn means no other request can interleave
 * statements into it. Passing an async function is a programming error and is
 * rejected before anything is committed.
 */
export const transaction = <T>(db: Db, fn: () => T): T => {
  if (db.isTransaction) {
    // Nested call: run inside the already-open transaction (savepoints are
    // not needed by any caller and would hide misuse).
    return fn();
  }
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
    if (result instanceof Promise) {
      throw new Error('transaction(): callback must be synchronous');
    }
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('COMMIT');
  return result;
};
