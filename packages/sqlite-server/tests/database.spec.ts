import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  getSchemaVersion,
  MigrationError,
  openDatabase,
  transaction,
} from '../src/db/database';
import { Migration, MIGRATIONS } from '../src/db/migrations';
import { createBackup, listBackups } from '../src/db/backup';
import { acquireProcessLock } from '../src/db/process-lock';
import { createTestDb, makeTmpDir, removeTmpDir, TestDb } from './helpers';

describe('database', () => {
  let t: TestDb | undefined;
  const dirs: string[] = [];
  afterEach(() => {
    t?.cleanup();
    t = undefined;
    dirs.splice(0).forEach(removeTmpDir);
  });

  it('creates the schema in WAL mode with foreign keys on', () => {
    t = createTestDb();
    expect(getSchemaVersion(t.db)).toBe(MIGRATIONS.length);
    expect(
      (t.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    expect(
      (t.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);
  });

  it('is idempotent on reopen and keeps data across restarts', () => {
    t = createTestDb();
    t.db.prepare("INSERT INTO users (email, created_at) VALUES ('a@b.c', 1)").run();
    t.reopen();
    t.reopen();
    expect(getSchemaVersion(t.db)).toBe(MIGRATIONS.length);
    expect(t.db.prepare('SELECT email FROM users').all()).toEqual([{ email: 'a@b.c' }]);
    const versions = t.db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toHaveLength(MIGRATIONS.length);
  });

  it('rolls back a failing migration and retries it on the next start', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = join(dir, 'm.sqlite');
    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'broken',
        sql: 'CREATE TABLE half_done (id INTEGER); SELECT * FROM table_that_does_not_exist;',
      },
    ];
    expect(() => openDatabase({ path, migrations: broken })).toThrow(MigrationError);

    // Previous version intact, partial DDL rolled back.
    const raw = new DatabaseSync(path);
    expect(getSchemaVersion(raw)).toBe(MIGRATIONS.length);
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(),
    ).toBeUndefined();
    raw.close();

    const fixed: Migration[] = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'fixed',
        sql: 'CREATE TABLE half_done (id INTEGER);',
      },
    ];
    const db = openDatabase({ path, migrations: fixed });
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length + 1);
    db.close();
  });

  it('refuses to open a database written by a newer server', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = join(dir, 'n.sqlite');
    const newer: Migration[] = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'future',
        sql: 'CREATE TABLE future (id INTEGER);',
      },
    ];
    openDatabase({ path, migrations: newer }).close();
    expect(() => openDatabase({ path })).toThrow(/newer than this server/);
  });

  it('rejects non-consecutive migration lists', () => {
    expect(() =>
      openDatabase({
        path: ':memory:',
        migrations: [{ version: 2, name: 'gap', sql: 'SELECT 1' }],
      }),
    ).toThrow(/consecutive/);
  });

  it('transaction() commits on success and rolls back on throw', () => {
    t = createTestDb();
    const db = t.db;
    transaction(db, () => {
      db.prepare("INSERT INTO users (email, created_at) VALUES ('ok@x', 1)").run();
    });
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO users (email, created_at) VALUES ('rolled@x', 1)").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT email FROM users ORDER BY id').all()).toEqual([
      { email: 'ok@x' },
    ]);
    expect(db.isTransaction).toBe(false);
  });

  it('transaction() rejects async callbacks without committing', () => {
    t = createTestDb();
    const db = t.db;
    expect(() =>
      transaction(db, (async () => {
        db.prepare("INSERT INTO users (email, created_at) VALUES ('async@x', 1)").run();
      }) as unknown as () => void),
    ).toThrow(/synchronous/);
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('writes consistent online backups and keeps only the newest N', async () => {
    t = createTestDb();
    t.db.prepare("INSERT INTO users (email, created_at) VALUES ('backup@x', 1)").run();
    const backupDir = join(t.dir, 'nas-backups');
    for (let i = 0; i < 3; i++) {
      await createBackup(t.db, backupDir, 2);
      await new Promise((r) => setTimeout(r, 5));
    }
    const backups = listBackups(backupDir);
    expect(backups).toHaveLength(2);
    const restored = new DatabaseSync(backups[1]);
    expect(restored.prepare('SELECT email FROM users').all()).toEqual([
      { email: 'backup@x' },
    ]);
    restored.close();
  });

  it('process lock prevents a second writer and reclaims stale locks', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = join(dir, 'locked.sqlite');
    const release = acquireProcessLock(path);
    expect(existsSync(`${path}.lock`)).toBe(true);
    // Same process re-acquiring is treated as stale reclaim (pid === self) only
    // after release; a foreign live pid is refused:
    release();
    // Parent process is alive and is not us.
    writeFileSync(`${path}.lock`, String(process.ppid));
    expect(() => acquireProcessLock(path)).toThrow(/already used/);
    // A dead pid is reclaimed.
    writeFileSync(`${path}.lock`, '999999');
    const release2 = acquireProcessLock(path);
    release2();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe('pre-migration backup', () => {
  it('copies an existing database before applying new migrations', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = makeTmpDir();
    try {
      const path = join(dir, 'up.sqlite');
      const v1Only = MIGRATIONS.slice(0, 1);
      const db1 = openDatabase({ path, migrations: v1Only });
      db1.prepare("INSERT INTO users (email, created_at) VALUES ('keep@x', 1)").run();
      db1.close();
      openDatabase({ path }).close(); // upgrades 1 → latest
      const backups = readdirSync(dir).filter((f) => f.startsWith('up.sqlite.pre-v1-'));
      expect(backups).toHaveLength(1);
      const copy = new DatabaseSync(join(dir, backups[0]));
      expect(getSchemaVersion(copy)).toBe(1);
      expect(copy.prepare('SELECT email FROM users').all()).toEqual([
        { email: 'keep@x' },
      ]);
      copy.close();
      openDatabase({ path }).close(); // nothing pending → no new backup
      expect(readdirSync(dir).filter((f) => f.includes('.pre-v'))).toHaveLength(1);
    } finally {
      removeTmpDir(dir);
    }
  });
});
