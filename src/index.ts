import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { STUBS } from './stubs.ts';

export type RlsTestErrorCode = 'INVALID_OPTIONS' | 'MIGRATION_FAILED' | 'NO_MATCHING_ROWS';

export class RlsTestError extends Error {
  readonly code: RlsTestErrorCode;

  constructor(code: RlsTestErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RlsTestError';
    this.code = code;
  }
}

export interface CreateTestDbOptions {
  /** Directory of `.sql` migrations, run in file name order. Relative paths start at the working directory. */
  migrations: string;
}

export interface CreateUserOptions {
  email?: string;
  /** Stored as `raw_user_meta_data`, which sign-up triggers usually read. */
  metadata?: Record<string, unknown>;
}

export interface QueryResult<T> {
  rows: T[];
  /** Rows inserted, updated or deleted. 0 for a select. */
  affectedRows: number;
}

/** Queries run as one kind of visitor: a signed-in user, or signed out. */
export interface Session {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * True when the access rules stop the statement: Postgres refuses it with a permission error
   * (42501), or it reads or changes no rows that it would have reached past the rules. Rejects with
   * `NO_MATCHING_ROWS` when there were no such rows, and with any other error unchanged. The
   * statement is always rolled back, so checking a write leaves the database as it was.
   */
  denied(sql: string, params?: unknown[]): Promise<boolean>;
}

export interface TestDb {
  /** Runs as the database owner, past every access rule. For setting up test data. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Queries as the signed-in user with this id. */
  as(userId: string): Session;
  /** Queries as a signed-out visitor. */
  readonly anon: Session;
  /** Adds a row to auth.users, which runs any sign-up triggers, and returns the new user's id. */
  createUser(options?: CreateUserOptions): Promise<string>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSUFFICIENT_PRIVILEGE = '42501';
// Supabase's default for its roles, so extensions created `with schema extensions` resolve unqualified.
const SEARCH_PATH = `set search_path = "$user", public, extensions`;
// What Supabase's auth server puts in a signed-in user's access token, read from their auth.users row.
// A user id with no row still gets sub and role, so as() works without createUser().
const CLAIMS = `select set_config('request.jwt.claims', coalesce(
  (select jsonb_build_object(
     'sub', id, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal1',
     'email', email, 'phone', phone, 'is_anonymous', is_anonymous,
     'app_metadata', raw_app_meta_data, 'user_metadata', raw_user_meta_data)
   from auth.users where id = $1::text::uuid),
  jsonb_build_object('sub', $1::text, 'role', 'authenticated'))::text, true)`;

/** An in-memory Postgres with Supabase's roles, auth and storage stubbed, and your migrations applied. */
export async function createTestDb(options: CreateTestDbOptions): Promise<TestDb> {
  checkKeys(options, ['migrations'], 'createTestDb');
  const dir = options.migrations;
  if (typeof dir !== 'string' || dir === '') {
    throw new RlsTestError('INVALID_OPTIONS', 'createTestDb: `migrations` must be a directory path.');
  }
  const files = sqlFiles(dir);

  const pg = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await pg.exec(STUBS);
    await pg.exec(SEARCH_PATH);
    for (const file of files) {
      try {
        await pg.exec(readFileSync(join(dir, file), 'utf8'));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new RlsTestError('MIGRATION_FAILED', `Migration ${file} failed: ${reason}`, { cause: error });
      }
    }
    // Migrations can leave settings behind (pg_dump output starts with `set row_security = off`),
    // while in Supabase every request starts on a clean connection.
    await pg.exec(`reset session authorization; reset all; ${SEARCH_PATH}`);
  } catch (error) {
    await pg.close();
    throw error;
  }

  // userId undefined means signed out.
  const session = (userId?: string): Session => {
    // Everything here is transaction-local, so the next query starts as the owner again.
    const enter = async (tx: Transaction) => {
      if (userId === undefined) {
        await tx.exec(
          `select set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon; set local row_security = on`,
        );
      } else {
        // Claims first: once the role is authenticated, auth.users can't be read.
        await tx.query(CLAIMS, [userId]);
        await tx.exec('set local role authenticated; set local row_security = on');
      }
    };
    return {
      query: (sql, params) =>
        pg.transaction(async (tx) => {
          await enter(tx);
          return result(await tx.query(sql, params));
        }),
      denied: (sql, params) =>
        pg.transaction(async (tx) => {
          try {
            await enter(tx);
            await tx.exec('savepoint statement');
            if (!isEmpty(result(await tx.query(sql, params)))) return false;
            // An empty result only means the rules stopped it if there were rows to stop, so run it
            // again as the owner, keeping the claims so auth.uid() in the statement still matches.
            await tx.exec('rollback to savepoint statement; set local role none');
            if (isEmpty(result(await tx.query(sql, params)))) {
              throw new RlsTestError(
                'NO_MATCHING_ROWS',
                'denied(): the statement matched no rows even past the access rules, so there was nothing for them to stop. Point the check at a row that exists, for example with `where id = $1`.',
              );
            }
            return true;
          } catch (error) {
            if ((error as { code?: unknown }).code === INSUFFICIENT_PRIVILEGE) return true;
            throw error;
          } finally {
            if (!tx.closed) await tx.rollback();
          }
        }),
    };
  };

  return {
    query: async (sql, params) => result(await pg.query(sql, params)),
    as(userId) {
      if (typeof userId !== 'string' || !UUID.test(userId)) {
        throw new RlsTestError(
          'INVALID_OPTIONS',
          'as(): the user id must be a UUID, such as one createUser() returned.',
        );
      }
      return session(userId);
    },
    anon: session(),
    async createUser(user = {}) {
      checkKeys(user, ['email', 'metadata'], 'createUser');
      if (user.email !== undefined && typeof user.email !== 'string') {
        throw new RlsTestError('INVALID_OPTIONS', 'createUser: `email` must be a string.');
      }
      if (user.metadata !== undefined && !isPlainObject(user.metadata)) {
        throw new RlsTestError('INVALID_OPTIONS', 'createUser: `metadata` must be a plain object.');
      }
      const r = await pg.transaction(async (tx) => {
        // Supabase's auth server signs people up as supabase_auth_admin, which can't write to public
        // tables, so a sign-up trigger that isn't security definer fails here as it does there.
        await tx.exec('set local role supabase_auth_admin; set local search_path = auth');
        return tx.query<{ id: string }>(
          'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
          [user.email ?? null, JSON.stringify(user.metadata ?? {})],
        );
      });
      const [row] = r.rows;
      // Only a before-insert trigger on auth.users that returns null can get here.
      if (!row) throw new Error('createUser: a trigger on auth.users cancelled the insert.');
      return row.id;
    },
    close: async () => {
      if (!pg.closed) await pg.close();
    },
  };
}

function sqlFiles(dir: string): string[] {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    names = readdirSync(dir);
  } catch (error) {
    throw new RlsTestError('INVALID_OPTIONS', `createTestDb: can't read the migrations directory ${resolve(dir)}.`, {
      cause: error,
    });
  }
  // Supabase names migrations <timestamp>_<name>.sql, so name order is the order they were written.
  const files = names.filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new RlsTestError('INVALID_OPTIONS', `createTestDb: no .sql files in ${resolve(dir)}.`);
  }
  return files;
}

function result<T>(r: { rows: T[]; affectedRows?: number }): QueryResult<T> {
  return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
}

function isEmpty(r: QueryResult<unknown>): boolean {
  return r.affectedRows === 0 && r.rows.length === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkKeys(value: unknown, allowed: string[], where: string): void {
  if (!isPlainObject(value)) {
    throw new RlsTestError('INVALID_OPTIONS', `${where}: options must be a plain object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RlsTestError(
      'INVALID_OPTIONS',
      `${where}: unknown option ${unknown.map((k) => `\`${k}\``).join(', ')}. Allowed: ${allowed.join(', ')}.`,
    );
  }
}
