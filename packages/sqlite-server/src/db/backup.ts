import { backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from './database';

const BACKUP_PREFIX = 'superprod-';
const BACKUP_SUFFIX = '.sqlite';

const timestamp = (date: Date): string => date.toISOString().replace(/[:.]/g, '-');

/**
 * Writes a consistent copy of the live database into `dir` using SQLite's
 * online backup API (safe while the server keeps writing), then keeps only the
 * newest `keep` backups. The copy is written to a temp name and renamed, so a
 * crash never leaves a half-written file with a final name — important when
 * `dir` is a network share (NAS).
 */
export const createBackup = async (
  db: Db,
  dir: string,
  keep: number,
): Promise<string> => {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${BACKUP_PREFIX}${timestamp(new Date())}${BACKUP_SUFFIX}`);
  const tmpPath = `${finalPath}.partial`;
  rmSync(tmpPath, { force: true });
  await sqliteBackup(db, tmpPath);
  renameSync(tmpPath, finalPath);
  pruneBackups(dir, keep);
  return finalPath;
};

export const listBackups = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort()
    .map((f) => join(dir, f));

export const pruneBackups = (dir: string, keep: number): void => {
  const backups = listBackups(dir);
  const excess = backups.length - keep;
  for (let i = 0; i < excess; i++) {
    rmSync(backups[i], { force: true });
  }
};

/** Starts periodic backups; returns a stop function. Failures are logged, not fatal. */
export const scheduleBackups = (
  db: Db,
  dir: string,
  intervalMinutes: number,
  keep: number,
): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const path = await createBackup(db, dir, keep);
      console.log(`[backup] wrote ${path} (${statSync(path).size} bytes)`);
    } catch (err) {
      console.error('[backup] failed:', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
};
