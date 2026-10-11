import { afterEach, describe, expect, it } from 'vitest';
import {
  authenticateToken,
  createUser,
  issueToken,
  revokeToken,
  scopeAllows,
} from '../src/auth/tokens';
import { createTestDb, TestDb } from './helpers';

describe('tokens', () => {
  let t: TestDb;
  afterEach(() => t.cleanup());

  it('stores only a hash and authenticates the plaintext token', () => {
    t = createTestDb();
    const user = createUser(t.db, 'Henrik@Example.test ');
    expect(user.email).toBe('henrik@example.test');
    const { token } = issueToken(t.db, user.id, 'sync', 'laptop');
    expect(token.startsWith('spsq_')).toBe(true);
    const stored = t.db.prepare('SELECT token_hash FROM api_tokens').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toContain(token);
    expect(authenticateToken(t.db, token)).toMatchObject({
      userId: user.id,
      scope: 'sync',
    });
  });

  it('rejects unknown, malformed and revoked tokens', () => {
    t = createTestDb();
    const user = createUser(t.db, 'a@b.c');
    const { token, tokenId } = issueToken(t.db, user.id, 'api-read');
    expect(authenticateToken(t.db, undefined)).toBeUndefined();
    expect(authenticateToken(t.db, 'spsq_wrong')).toBeUndefined();
    expect(authenticateToken(t.db, 'eyJhbGciOi.jwt.like')).toBeUndefined();
    expect(revokeToken(t.db, tokenId)).toBe(true);
    expect(authenticateToken(t.db, token)).toBeUndefined();
    expect(revokeToken(t.db, tokenId)).toBe(false);
  });

  it('survives a restart', () => {
    t = createTestDb();
    const user = createUser(t.db, 'a@b.c');
    const { token } = issueToken(t.db, user.id, 'sync');
    t.reopen();
    expect(authenticateToken(t.db, token)?.userId).toBe(user.id);
  });

  it('refuses duplicate users and unknown scopes', () => {
    t = createTestDb();
    createUser(t.db, 'a@b.c');
    expect(() => createUser(t.db, 'A@B.C')).toThrow(/exists/);
    expect(() => issueToken(t.db, 1, 'admin' as never)).toThrow(/scope/);
  });

  it('scope rules: write implies read, sync never grants REST access', () => {
    expect(scopeAllows('api-write', 'api-read')).toBe(true);
    expect(scopeAllows('api-read', 'api-write')).toBe(false);
    expect(scopeAllows('sync', 'api-read')).toBe(false);
    expect(scopeAllows('api-write', 'sync')).toBe(false);
    expect(scopeAllows('sync', 'sync')).toBe(true);
  });
});
