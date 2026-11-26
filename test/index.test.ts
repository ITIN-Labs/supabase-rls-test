import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';
import { createTestDb, RlsTestError, type TestDb } from '../src/index.ts';

const MIGRATIONS = 'test/migrations';

const rejectsWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof RlsTestError, `expected RlsTestError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

describe('createTestDb', () => {
  it('rejects options that are missing, unknown or the wrong type', async () => {
    await assert.rejects(createTestDb(undefined as never), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(createTestDb({} as never), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(createTestDb({ migrations: 42 } as never), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(createTestDb({ migrations: '' }), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(
      createTestDb({ migrations: MIGRATIONS, seed: 'x' } as never),
      (error: unknown) => rejectsWith('INVALID_OPTIONS')(error) && /`seed`/.test((error as Error).message),
    );
  });

  it('rejects a directory that is missing, a file, or holds no .sql files', async () => {
    await assert.rejects(createTestDb({ migrations: 'test/nope' }), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(createTestDb({ migrations: 'package.json' }), rejectsWith('INVALID_OPTIONS'));
    await assert.rejects(createTestDb({ migrations: 'test/empty-migrations' }), rejectsWith('INVALID_OPTIONS'));
  });

  it('names the migration that failed and keeps the Postgres error as the cause', async () => {
    await assert.rejects(createTestDb({ migrations: 'test/broken-migrations' }), (error: unknown) => {
      rejectsWith('MIGRATION_FAILED')(error);
      const { message, cause } = error as RlsTestError;
      assert.match(message, /20260102000000_typo\.sql/);
      assert.match(message, /syntax error/);
      assert.equal((cause as { code?: string }).code, '42601');
      return true;
    });
  });
});

describe('a test database', () => {
  let db: TestDb;
  let alice: string;
  let bob: string;
  let aliceNote: number;

  before(async () => {
    db = await createTestDb({ migrations: MIGRATIONS });
    alice = await db.createUser({ email: 'alice@example.test', metadata: { name: 'Alice' } });
    bob = await db.createUser({ email: 'bob@example.test' });
    const r = await db.as(alice).query<{ id: number }>(`insert into notes (body) values ('hi') returning id`);
    aliceNote = r.rows[0]!.id;
  });
  after(async () => {
    await db.close();
    await db.close(); // a second close is harmless
  });

  it('runs migrations in name order and skips files that are not .sql', async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int n from storage.buckets where id = 'avatars'`);
    assert.equal(r.rows[0]!.n, 1);
  });

  describe('createUser', () => {
    it('returns the new id and runs sign-up triggers', async () => {
      const r = await db.query<{ id: string; name: string }>('select id, name from profiles order by name');
      assert.deepEqual(
        r.rows.map((p) => p.name),
        ['Alice', 'bob'],
      );
      assert.ok(r.rows.some((p) => p.id === alice));
    });

    it('works with no options and keeps unicode metadata intact', async () => {
      const anyone = await db.createUser();
      const named = await db.createUser({ metadata: { name: 'Zoë 山田 🧭' } });
      const r = await db.query<{ id: string; name: string }>('select id, name from profiles where id = any($1)', [
        [anyone, named],
      ]);
      assert.deepEqual(new Set(r.rows.map((p) => p.name)), new Set(['someone', 'Zoë 山田 🧭']));
    });

    it('rejects bad options', async () => {
      await assert.rejects(db.createUser({ email: 5 } as never), rejectsWith('INVALID_OPTIONS'));
      await assert.rejects(db.createUser({ metadata: [] } as never), rejectsWith('INVALID_OPTIONS'));
      await assert.rejects(db.createUser({ metadata: new Date() } as never), rejectsWith('INVALID_OPTIONS'));
      await assert.rejects(db.createUser({ password: 'x' } as never), rejectsWith('INVALID_OPTIONS'));
      await assert.rejects(db.createUser(null as never), rejectsWith('INVALID_OPTIONS'));
    });

    it('runs sign-up triggers as supabase_auth_admin, so one without security definer fails', async () => {
      await db.query('create table public.signups (id uuid)');
      await db.query(
        'create function public.log_signup() returns trigger language plpgsql as $$ begin insert into public.signups values (new.id); return new; end $$',
      );
      await db.query(
        'create trigger log_signup after insert on auth.users for each row execute function public.log_signup()',
      );
      try {
        await assert.rejects(db.createUser(), { code: '42501' });
      } finally {
        await db.query('drop trigger log_signup on auth.users');
      }
    });

    it('throws when a trigger cancels the insert', async () => {
      await db.query(
        'create function public.cancel_signup() returns trigger language plpgsql as $$ begin return null; end $$',
      );
      await db.query(
        'create trigger cancel_signup before insert on auth.users for each row execute function public.cancel_signup()',
      );
      try {
        await assert.rejects(db.createUser(), /cancelled the insert/);
      } finally {
        await db.query('drop trigger cancel_signup on auth.users');
      }
    });

    it('lets Postgres refuse a duplicate email', async () => {
      await assert.rejects(db.createUser({ email: 'alice@example.test' }), { code: '23505' });
    });
  });

  describe('sessions', () => {
    it('only accepts a UUID as a user id', () => {
      assert.throws(() => db.as('alice'), rejectsWith('INVALID_OPTIONS'));
      assert.throws(() => db.as(42 as never), rejectsWith('INVALID_OPTIONS'));
      assert.throws(() => db.as(`${alice} `), rejectsWith('INVALID_OPTIONS'));
    });

    it('sets auth.uid(), auth.role() and auth.jwt() for each kind of visitor', async () => {
      const sql = `select auth.uid() uid, auth.role() role, auth.jwt() ->> 'sub' sub`;
      assert.deepEqual((await db.as(alice).query(sql)).rows, [{ uid: alice, role: 'authenticated', sub: alice }]);
      assert.deepEqual((await db.anon.query(sql)).rows, [{ uid: null, role: 'anon', sub: null }]);
      assert.deepEqual((await db.query(sql)).rows, [{ uid: null, role: null, sub: null }]);
    });

    it("puts the user's auth.users row in the token, as Supabase does", async () => {
      await db.query(`update auth.users set raw_app_meta_data = '{"plan":"pro"}' where id = $1`, [alice]);
      const r = await db.as(alice).query(
        `select auth.email() email, auth.jwt() -> 'app_metadata' ->> 'plan' plan,
                auth.jwt() -> 'user_metadata' ->> 'name' name, auth.jwt() ->> 'aal' aal`,
      );
      assert.deepEqual(r.rows, [{ email: 'alice@example.test', plan: 'pro', name: 'Alice', aal: 'aal1' }]);
    });

    it('still works for a user id with no auth.users row', async () => {
      const stranger = '00000000-0000-4000-8000-000000000000';
      const r = await db.as(stranger).query(`select auth.uid() uid, auth.email() email`);
      assert.deepEqual(r.rows, [{ uid: stranger, email: null }]);
    });

    it('ignores settings a migration left behind', async () => {
      // test/migrations/20260104000000_pulled_schema.sql turns row security off, empties the search
      // path and sets an old-style claim, as a pulled schema does.
      assert.equal((await db.as(bob).query<{ uid: string }>('select auth.uid() uid')).rows[0]!.uid, bob);
      assert.equal((await db.as(bob).query('select * from notes')).rows.length, 0);
      assert.deepEqual((await db.query(`select current_setting('row_security') r`)).rows, [{ r: 'on' }]);
    });

    it('has pgcrypto and uuid-ossp available, on the extensions search path', async () => {
      await db.query('insert into tokens default values');
      const r = await db.query<{ ok: boolean }>(
        `select length(digest) = 64 and id is not null and gen_random_bytes(4) is not null ok from tokens`,
      );
      assert.deepEqual(r.rows, [{ ok: true }]);
    });

    it('keeps sessions apart when queries run at the same time', async () => {
      const sql = 'select auth.uid() uid';
      const [a, b, owner] = await Promise.all([
        db.as(alice).query(sql),
        db.as(bob).denied('select * from notes'),
        db.query(sql),
      ]);
      assert.deepEqual(a.rows, [{ uid: alice }]);
      assert.equal(b, true);
      assert.deepEqual(owner.rows, [{ uid: null }]);
    });

    it('applies the access rules and passes parameters through', async () => {
      const mine = await db.as(alice).query('select body from notes where id = $1', [aliceNote]);
      assert.deepEqual(mine.rows, [{ body: 'hi' }]);
      assert.equal((await db.as(bob).query('select * from notes')).rows.length, 0);
      assert.equal((await db.query('select * from notes')).rows.length, 1);
    });

    it('commits what a query changes and reports affected rows', async () => {
      const r = await db.as(alice).query(`update notes set body = 'hello' where id = $1`, [aliceNote]);
      assert.equal(r.affectedRows, 1);
      assert.equal((await db.query<{ body: string }>('select body from notes')).rows[0]!.body, 'hello');
    });

    it('leaves the owner connection as the owner afterwards, even after an error', async () => {
      await assert.rejects(db.as(bob).query('selec 1'));
      await db.anon.query('select 1');
      assert.deepEqual((await db.query('select current_user u')).rows, [{ u: 'postgres' }]);
      assert.deepEqual((await db.query(`select current_setting('request.jwt.claims', true) c`)).rows, [{ c: '' }]);
    });

    it('lets a policy that reads another table through a function see the right user', async () => {
      await db.as(alice).query('insert into note_readers (note_id, user_id) values ($1, $2)', [aliceNote, bob]);
      assert.equal((await db.as(bob).query('select * from notes')).rows.length, 1);
      await db.as(alice).query('delete from note_readers');
      assert.equal((await db.as(bob).query('select * from notes')).rows.length, 0);
    });

    it('applies storage policies that use storage.foldername()', async () => {
      const insert = `insert into storage.objects (bucket_id, name) values ('avatars', $1)`;
      assert.equal(await db.as(alice).denied(insert, [`${alice}/me.png`]), false);
      assert.equal(await db.as(alice).denied(insert, [`${bob}/me.png`]), true);
      assert.equal(await db.anon.denied(insert, [`${alice}/me.png`]), true);
    });

    it('has the storage path helpers', async () => {
      const r = await db.query(
        `select storage.foldername('a/b/c.tar.gz') folders, storage.filename('a/b/c.tar.gz') file, storage.extension('a/b/c.tar.gz') ext`,
      );
      assert.deepEqual(r.rows, [{ folders: ['a', 'b'], file: 'c.tar.gz', ext: 'gz' }]);
    });

    it('does not let users truncate storage tables', async () => {
      await assert.rejects(db.as(alice).query('truncate storage.objects'), { code: '42501' });
    });
  });

  describe('denied', () => {
    const count = async () => (await db.query<{ n: number }>('select count(*)::int n from notes')).rows[0]!.n;

    it('is true when Postgres refuses with a permission error', async () => {
      assert.equal(await db.as(bob).denied(`insert into notes (owner_id, body) values ($1, 'x')`, [alice]), true);
      assert.equal(await db.anon.denied(`insert into notes (body) values ('x')`), true);
      assert.equal(await db.anon.denied('select clear_notes()'), true);
    });

    it('is true when the rules filter every row out', async () => {
      assert.equal(await db.as(bob).denied(`update notes set body = 'x'`), true);
      assert.equal(await db.as(bob).denied('delete from notes'), true);
      assert.equal(await db.as(bob).denied('select * from notes'), true);
    });

    it('is false when the statement goes through, and rolls the change back', async () => {
      const before = await count();
      assert.equal(await db.as(alice).denied('delete from notes'), false);
      assert.equal(await db.as(alice).denied(`insert into notes (body) values ('x')`), false);
      assert.equal(await db.as(alice).denied('select * from notes'), false);
      assert.equal(await count(), before);
    });

    it('rejects when nothing matched even past the rules, so a wrong id or empty table cannot pass', async () => {
      await assert.rejects(db.as(bob).denied('delete from notes where id = -1'), rejectsWith('NO_MATCHING_ROWS'));
      await assert.rejects(db.anon.denied('select * from notes where false'), rejectsWith('NO_MATCHING_ROWS'));
      await db.query('create table empty_things (id int)');
      await db.query('alter table empty_things enable row level security');
      await assert.rejects(db.as(alice).denied('select * from empty_things'), rejectsWith('NO_MATCHING_ROWS'));
      await db.query('drop table empty_things');
    });

    it('keeps the claims for the owner check, so auth.uid() in the statement still means the user', async () => {
      // Bob owns no notes: past the rules his own notes are still none, so this is a wrong check.
      await assert.rejects(
        db.as(bob).denied('select * from notes where owner_id = auth.uid()'),
        rejectsWith('NO_MATCHING_ROWS'),
      );
    });

    it('is true when the owner run reaches a row that a trigger then refuses', async () => {
      await db.query(
        `create function public.freeze_notes() returns trigger language plpgsql as $$ begin raise exception 'notes are frozen'; end $$`,
      );
      await db.query(
        'create trigger freeze_notes before update on notes for each row execute function public.freeze_notes()',
      );
      try {
        assert.equal(await db.as(bob).denied(`update notes set body = 'x'`), true);
        await assert.rejects(
          db.as(bob).denied(`update notes set body = 'x' where id = -1`),
          rejectsWith('NO_MATCHING_ROWS'),
        );
      } finally {
        await db.query('drop trigger freeze_notes on notes');
        await db.query('drop function public.freeze_notes()');
      }
    });

    it('rejects any other error, so a broken test cannot pass', async () => {
      await assert.rejects(db.as(bob).denied('delete from notez'), { code: '42P01' });
      await assert.rejects(db.as(bob).denied('selec 1'), { code: '42601' });
      await assert.rejects(db.as(bob).denied('select always_fails()'), { code: 'P0001' });
    });

    it('matches the access rules and never changes data, for any mix of owners', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
          fc.boolean(),
          async (owners, asAlice) => {
            await db.query('delete from notes');
            const ids: number[] = [];
            for (const ownedByAlice of owners) {
              const r = await db.query<{ id: number }>(
                `insert into notes (owner_id, body) values ($1, 'n') returning id`,
                [ownedByAlice ? alice : bob],
              );
              ids.push(r.rows[0]!.id);
            }
            const user = asAlice ? alice : bob;
            const snapshot = (await db.query('select * from notes order by id')).rows;
            for (const [i, id] of ids.entries()) {
              const mine = owners[i] === asAlice;
              assert.equal(await db.as(user).denied(`update notes set body = 'changed' where id = $1`, [id]), !mine);
              assert.equal(await db.as(user).denied('delete from notes where id = $1', [id]), !mine);
            }
            assert.deepEqual((await db.query('select * from notes order by id')).rows, snapshot);
          },
        ),
        { numRuns: 25 },
      );
    });
  });
});
