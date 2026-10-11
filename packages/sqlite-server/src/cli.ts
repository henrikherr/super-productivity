#!/usr/bin/env node
import {
  createUser,
  findUserByEmail,
  issueToken,
  listTokens,
  listUsers,
  revokeToken,
  TOKEN_SCOPES,
  TokenScope,
} from './auth/tokens';
import { createBackup } from './db/backup';
import { Db, getSchemaVersion, openDatabase } from './db/database';
import { loadEngine } from './engine/engine-loader';
import { FileKeyProvider, StaticKeyProvider } from './projection/encryption-keys';
import { getProjectionStatus } from './projection/projection-store';
import { Projector } from './projection/projector';

const USAGE = `sp-sqlite-server CLI

Usage: sp-sqlite-server <command> [args]   (database: --db <path> or SP_SQLITE_DB)

  migrate                          create/upgrade the database schema
  user add <email>                 create a user (account name)
  user list
  token issue <email> <scope> [label]   scope: ${TOKEN_SCOPES.join(' | ')}
  token list <email>
  token revoke <tokenId>
  backup <dir> [keep]              write a consistent online backup into <dir>
  projection status <email>        show projection cursor/status
  projection rebuild <email>       rebuild all derived tables from the op log
                                   (uses SP_ENCRYPTION_KEY_FILE for encrypted data)
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const requireUser = (db: Db, email: string | undefined): number => {
  if (!email) throw new Error('email required');
  const user = findUserByEmail(db, email);
  if (!user) throw new Error(`Unknown user ${email}`);
  return user.id;
};

export const runCli = async (
  argv: string[],
  io: CliIo,
  env = process.env,
): Promise<number> => {
  const args = [...argv];
  let dbPath = env.SP_SQLITE_DB ?? './data/superprod.sqlite';
  const dbFlag = args.indexOf('--db');
  if (dbFlag >= 0) {
    dbPath = args[dbFlag + 1];
    args.splice(dbFlag, 2);
  }
  const [cmd, sub, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }
  const db = openDatabase({ path: dbPath });
  try {
    if (cmd === 'migrate') {
      io.out(`schema version ${getSchemaVersion(db)} (${dbPath})`);
      return 0;
    }
    if (cmd === 'user' && sub === 'add') {
      const user = createUser(db, rest[0] ?? '');
      io.out(`created user ${user.id} ${user.email}`);
      return 0;
    }
    if (cmd === 'user' && sub === 'list') {
      for (const u of listUsers(db)) io.out(`${u.id}\t${u.email}`);
      return 0;
    }
    if (cmd === 'token' && sub === 'issue') {
      const userId = requireUser(db, rest[0]);
      const scope = rest[1] as TokenScope;
      if (!TOKEN_SCOPES.includes(scope))
        throw new Error(`scope must be one of ${TOKEN_SCOPES.join(', ')}`);
      const { token, tokenId } = issueToken(db, userId, scope, rest[2]);
      io.err(`token ${tokenId} (${scope}) issued; it is shown only once:`);
      io.out(token);
      return 0;
    }
    if (cmd === 'token' && sub === 'list') {
      const userId = requireUser(db, rest[0]);
      for (const t of listTokens(db, userId)) {
        io.out(
          `${t.id}\t${t.scope}\t${t.label ?? ''}\t${t.revoked_at ? 'revoked' : 'active'}\t` +
            `last used: ${t.last_used_at ? new Date(t.last_used_at).toISOString() : '-'}`,
        );
      }
      return 0;
    }
    if (cmd === 'token' && sub === 'revoke') {
      const ok = revokeToken(db, Number(rest[0]));
      io.out(ok ? 'revoked' : 'not found or already revoked');
      return ok ? 0 : 1;
    }
    if (cmd === 'projection' && (sub === 'status' || sub === 'rebuild')) {
      const userId = requireUser(db, rest[0]);
      if (sub === 'rebuild') {
        const keys = env.SP_ENCRYPTION_KEY_FILE
          ? new FileKeyProvider(db, env.SP_ENCRYPTION_KEY_FILE)
          : new StaticKeyProvider(new Map());
        await new Projector(
          db,
          loadEngine(env.SP_ENGINE_PATH || undefined),
          keys,
        ).rebuild(userId);
      }
      const st = getProjectionStatus(db, userId);
      io.out(JSON.stringify(st ?? { status: 'none' }));
      return st?.status === 'ok' || !st ? 0 : 1;
    }
    if (cmd === 'backup') {
      if (!sub) throw new Error('backup directory required');
      const path = await createBackup(db, sub, Number(rest[0] ?? 48));
      io.out(path);
      return 0;
    }
    io.err(USAGE);
    return 1;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
};

if (require.main === module) {
  runCli(process.argv.slice(2), {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  }).then((code) => process.exit(code));
}
