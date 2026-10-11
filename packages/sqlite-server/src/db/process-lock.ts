import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Locks held by THIS process (a second server instance in-process must be refused too). */
const heldLocks = new Set<string>();

/**
 * Ensures only one server instance writes a database file. The upload path
 * relies on in-process serialization of writers (see sync/upload.ts); a second
 * instance would break that guarantee. Stale locks of dead processes are reclaimed.
 */
export const acquireProcessLock = (dbPath: string): (() => void) => {
  const lockPath = `${resolve(dbPath)}.lock`;
  if (heldLocks.has(lockPath)) {
    throw new Error(
      `Database ${dbPath} is already used by this process (lock: ${lockPath})`,
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      heldLocks.add(lockPath);
      return () => {
        heldLocks.delete(lockPath);
        rmSync(lockPath, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        pid !== process.pid &&
        isProcessAlive(pid)
      ) {
        throw new Error(
          `Database ${dbPath} is already used by server process ${pid} (lock: ${lockPath})`,
        );
      }
      // Dead process, or our own pid left over from a crash before restart.
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire lock ${lockPath}`);
};
