import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Db, transaction } from '../db/database';

export type TokenScope = 'sync' | 'api-read' | 'api-write';

export const TOKEN_SCOPES: readonly TokenScope[] = ['sync', 'api-read', 'api-write'];

/** Prefix makes leaked tokens greppable and distinguishable from JWTs. */
const TOKEN_PREFIX = 'spsq_';

export interface UserRow {
  id: number;
  email: string;
  created_at: number;
}

export interface AuthenticatedToken {
  userId: number;
  tokenId: number;
  scope: TokenScope;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const generateToken = (): string =>
  TOKEN_PREFIX + randomBytes(32).toString('base64url');

export const createUser = (db: Db, email: string): UserRow => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('email/name must not be empty');
  }
  return transaction(db, () => {
    const existing = db
      .prepare('SELECT id, email, created_at FROM users WHERE email = ?')
      .get(normalized) as UserRow | undefined;
    if (existing) {
      throw new Error(`User ${normalized} already exists`);
    }
    const now = Date.now();
    const result = db
      .prepare('INSERT INTO users (email, created_at) VALUES (?, ?)')
      .run(normalized, now);
    return { id: Number(result.lastInsertRowid), email: normalized, created_at: now };
  });
};

export const findUserByEmail = (db: Db, email: string): UserRow | undefined =>
  db
    .prepare('SELECT id, email, created_at FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as UserRow | undefined;

export const listUsers = (db: Db): UserRow[] =>
  db
    .prepare('SELECT id, email, created_at FROM users ORDER BY id')
    .all() as unknown as UserRow[];

/**
 * Issues a new token and returns its plaintext ONCE. Only the hash is stored.
 */
export const issueToken = (
  db: Db,
  userId: number,
  scope: TokenScope,
  label?: string,
): { token: string; tokenId: number } => {
  if (!TOKEN_SCOPES.includes(scope)) {
    throw new Error(`Unknown token scope: ${scope}`);
  }
  const token = generateToken();
  const result = db
    .prepare(
      'INSERT INTO api_tokens (user_id, token_hash, scope, label, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, hashToken(token), scope, label ?? null, Date.now());
  return { token, tokenId: Number(result.lastInsertRowid) };
};

export const revokeToken = (db: Db, tokenId: number): boolean =>
  db
    .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), tokenId).changes > 0;

/** Revokes every sync token of a user except `keepTokenId` (replace-token flow). */
export const revokeOtherSyncTokens = (
  db: Db,
  userId: number,
  keepTokenId: number,
): void => {
  db.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND scope = 'sync' AND id <> ? AND revoked_at IS NULL",
  ).run(Date.now(), userId, keepTokenId);
};

export const listTokens = (
  db: Db,
  userId: number,
): Array<{
  id: number;
  scope: TokenScope;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}> =>
  db
    .prepare(
      'SELECT id, scope, label, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY id',
    )
    .all(userId) as never;

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * Resolves a bearer token. Returns undefined for unknown or revoked tokens.
 * Lookup is by hash (constant work per request); the final comparison is
 * timing-safe as defense in depth.
 */
export const authenticateToken = (
  db: Db,
  token: string | undefined,
): AuthenticatedToken | undefined => {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) {
    return undefined;
  }
  const hash = hashToken(token);
  const row = db
    .prepare(
      'SELECT id, user_id, token_hash, scope, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL',
    )
    .get(hash) as
    | {
        id: number;
        user_id: number;
        token_hash: string;
        scope: TokenScope;
        last_used_at: number | null;
      }
    | undefined;
  if (!row) return undefined;
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_WRITE_INTERVAL_MS) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { userId: row.user_id, tokenId: row.id, scope: row.scope };
};

/** Scope check: 'api-write' implies 'api-read'. Sync tokens never grant REST API access. */
export const scopeAllows = (granted: TokenScope, required: TokenScope): boolean =>
  granted === required || (granted === 'api-write' && required === 'api-read');
