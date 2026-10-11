import { createHash } from 'node:crypto';
import { stableJsonStringify } from './conflict';

/**
 * Process-local cache of upload results keyed by client `requestId`, so a
 * client retrying after a lost response gets the original answer instead of
 * DUPLICATE_OPERATION rejections. Mirrors super-sync-server
 * request-deduplication.service.ts (5 minute TTL, fingerprint must match).
 */
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES_PER_USER = 200;

interface Entry<T> {
  fingerprint: string;
  value: T;
  expiresAt: number;
}

export class RequestDedupCache<T> {
  private readonly byUser = new Map<number, Map<string, Entry<T>>>();

  get(userId: number, requestId: string, fingerprint: () => string): T | undefined {
    const entry = this.byUser.get(userId)?.get(requestId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.byUser.get(userId)?.delete(requestId);
      return undefined;
    }
    return entry.fingerprint === fingerprint() ? entry.value : undefined;
  }

  set(userId: number, requestId: string, value: T, fingerprint: string): void {
    let map = this.byUser.get(userId);
    if (!map) {
      map = new Map();
      this.byUser.set(userId, map);
    }
    if (map.size >= MAX_ENTRIES_PER_USER) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(requestId, { fingerprint, value, expiresAt: Date.now() + DEDUP_TTL_MS });
  }

  clearForUser(userId: number): void {
    this.byUser.delete(userId);
  }
}

export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(stableJsonStringify(value)).digest('hex');
