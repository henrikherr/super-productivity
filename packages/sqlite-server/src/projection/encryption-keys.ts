import { readFileSync, statSync } from 'node:fs';
import { Db } from '../db/database';
import { findUserByEmail } from '../auth/tokens';

/**
 * Supplies a user's sync encryption password (ADR-9). The clients encrypt
 * every SuperSync payload with it; the server needs it to project data and to
 * encrypt the ops it authors (REST/MCP writes).
 */
export interface EncryptionKeyProvider {
  getPassword(userId: number): string | undefined;
}

/** Test-only: the same password for every user (E2E suites use one fixed password). */
export class DefaultKeyProvider implements EncryptionKeyProvider {
  constructor(private readonly password: string) {}
  getPassword(): string | undefined {
    return this.password;
  }
}

export class StaticKeyProvider implements EncryptionKeyProvider {
  constructor(private readonly byUserId: ReadonlyMap<number, string>) {}
  getPassword(userId: number): string | undefined {
    return this.byUserId.get(userId);
  }
}

/**
 * Reads `<email>=<password>` lines (UTF-8, `#` comments allowed). The file
 * should be readable only by the service account (chmod 600); a warning is
 * logged otherwise. Re-read on every lookup miss so adding a key needs no
 * restart.
 */
export class FileKeyProvider implements EncryptionKeyProvider {
  private cache = new Map<number, string>();

  constructor(
    private readonly db: Db,
    private readonly path: string,
  ) {
    this.reload();
    try {
      const mode = statSync(path).mode & 0o777;
      if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
        console.warn(
          `[keys] ${path} is accessible by group/others (mode ${mode.toString(8)}); run chmod 600`,
        );
      }
    } catch {
      // reload() already reported a missing file
    }
  }

  reload(): void {
    const next = new Map<number, string>();
    let text = '';
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      console.error(`[keys] cannot read ${this.path}: ${(err as Error).message}`);
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const email = line.slice(0, eq).trim();
      const password = line.slice(eq + 1);
      const user = findUserByEmail(this.db, email);
      if (user && password) next.set(user.id, password);
    }
    this.cache = next;
  }

  getPassword(userId: number): string | undefined {
    const hit = this.cache.get(userId);
    if (hit !== undefined) return hit;
    this.reload();
    return this.cache.get(userId);
  }
}
