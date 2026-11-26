# @itin-labs/supabase-rls-test

Test your Supabase row level security policies in plain Node tests, with no Docker. It runs your migrations on an in-memory Postgres ([PGlite](https://pglite.dev)) with Supabase's roles, `auth` and `storage` stubbed in, then lets you query as any user and check what they can read or change.

```sh
npm install --save-dev @itin-labs/supabase-rls-test
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDb } from '@itin-labs/supabase-rls-test';

test('people only see their own notes', async () => {
  const db = await createTestDb({ migrations: 'supabase/migrations' });
  const alice = await db.createUser({ email: 'alice@example.com' });
  const bob = await db.createUser({ email: 'bob@example.com' });

  const note = await db.as(alice).query(`insert into notes (body) values ('hi') returning id`);
  const id = note.rows[0].id;

  assert.equal((await db.as(bob).query('select * from notes')).rows.length, 0);
  assert.equal(await db.as(bob).denied(`update notes set body = 'mine now' where id = $1`, [id]), true);
  assert.equal(await db.anon.denied('select * from notes'), true);

  await db.close();
});
```

It's for anyone with a Supabase project whose data is protected by RLS policies and who wants those policies checked on every pull request, the same way the rest of the code is. It works with any test runner that can load ES modules, since it only returns values and throws errors.

## API

### `createTestDb(options): Promise<TestDb>`

Starts an in-memory database, adds the Supabase stubs (listed under [What's stubbed](#whats-stubbed)), then runs every `.sql` file in `options.migrations` in file name order. Supabase names migrations `<timestamp>_<name>.sql`, so that's the order they were written in. Other files in the directory are ignored.

| Option       | Type     | Default  | Meaning                                                                           |
| ------------ | -------- | -------- | --------------------------------------------------------------------------------- |
| `migrations` | `string` | required | Directory of migrations. A relative path starts at the current working directory. |

Unknown options throw. Each call gives a fresh, separate database. Starting one takes one to two seconds, mostly PGlite loading, so most suites create one per file in a `before` hook rather than one per test.

### `TestDb`

`db.query(sql, params?)` runs as the database owner, past every policy. Use it to set up data the way a migration or a `security definer` function would.

`db.as(userId)` returns a session for a signed-in user. `userId` must be a UUID, usually one from `createUser`. Inside the session's queries the role is `authenticated`, and `auth.jwt()` holds the claims Supabase's auth server would put in that user's token, read from their `auth.users` row: `sub`, `role`, `aud`, `aal` (`aal1`), `email`, `phone`, `is_anonymous`, `app_metadata` and `user_metadata`. So `auth.uid()`, `auth.email()` and policies on `auth.jwt() -> 'app_metadata'` see what they would in production. To test app metadata, set `raw_app_meta_data` on the user with `db.query`. A user id with no `auth.users` row gets just `sub` and `role`.

`db.anon` is a session for a signed-out visitor: role `anon`, `auth.uid()` is null.

`db.createUser({ email?, metadata? })` inserts a row into `auth.users` and returns the new user's id. `metadata` is stored as `raw_user_meta_data`. Both are optional. The insert runs as `supabase_auth_admin`, the role Supabase's auth server uses, so sign-up triggers run with the same privileges they have in production: a trigger that writes to `public` without being `security definer` fails here with a permission error, as it does when a real user signs up.

`db.close()` frees the database. Calling it again does nothing.

### `Session`

`session.query(sql, params?)` runs one statement as that visitor and commits it. It resolves to `{ rows, affectedRows }`. Errors from Postgres reject unchanged, so you can check their `code`.

`session.denied(sql, params?)` resolves to `true` when the policies stop the statement, and `false` when it goes through. Stopped means one of two things, because Postgres reports policies in two ways:

- Postgres refuses with a permission error (SQLSTATE `42501`). That's what an `insert` failing a `with check` does, and what a missing grant does.
- The statement reads or changes no rows, though past the policies it would reach some. That's what an `update`, `delete` or `select` does when the policy's `using` clause filters every row out.

To tell those apart from a check that points at nothing, `denied` runs an empty statement a second time, past the policies. If the statement matches nothing even past the policies, because the table is empty or the id is wrong, `denied` rejects with `NO_MATCHING_ROWS` instead of returning `true`. That second run happens as the database owner but keeps the user's token, so `auth.uid()` in the statement still means that user. If the second run raises an error, such as a trigger or a constraint refusing a row it reached, that counts as rows being there and `denied` returns `true`. Any error in the first run other than a permission error rejects unchanged, so a typo in a test's SQL fails the test too. `denied` always rolls the statement back, so checking a write leaves the data as it was.

It's still worth checking the opposite case, that someone who should be allowed is, so a policy that stops everyone shows up as a failure.

If a function of yours checks permissions itself, raise with `errcode = '42501'` so `denied` sees it as a refusal:

```sql
raise exception 'only owners can archive' using errcode = '42501';
```

### Errors

Problems with the arguments, the migrations or a `denied` check throw an `RlsTestError` with a `code`:

| `code`             | When                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_OPTIONS`  | An option is missing, unknown or the wrong type, the directory can't be read or has no `.sql` files, or a user id isn't a UUID. |
| `MIGRATION_FAILED` | A migration raised an error. The message names the file, and `cause` is the Postgres error.                                     |
| `NO_MATCHING_ROWS` | `denied` was given a statement that matches no rows even past the policies, so there was nothing for them to stop.              |

```ts
import { createTestDb, RlsTestError } from '@itin-labs/supabase-rls-test';

try {
  await createTestDb({ migrations: 'supabase/migrations' });
} catch (error) {
  if (error instanceof RlsTestError && error.code === 'MIGRATION_FAILED') {
    console.error(error.message); // Migration 20260102000000_notes.sql failed: syntax error at or near "tabel"
  }
  throw error;
}
```

## What's stubbed

Enough of Supabase for migrations and policies to run as they do there:

- the `anon`, `authenticated`, `service_role` and `supabase_auth_admin` roles, with Supabase's default grants on the `public` schema
- `auth.users` with its commonly used columns, and `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` with Supabase's own definitions
- `storage.buckets` and `storage.objects` with RLS on, Supabase's grants on them, and `storage.foldername()`, `storage.filename()` and `storage.extension()`
- the `extensions` schema with `pgcrypto` and `uuid-ossp` available to `create extension`, and Supabase's search path (`"$user", public, extensions`)
- the `supabase_realtime` publication, so migrations that add tables to it still run

Each session starts from a clean connection, as a request to Supabase does. Settings a migration leaves behind, such as the `set row_security = off` at the top of a pulled schema, don't carry into it.

## How it compares

`supabase test db` runs pgTAP tests against the real local Supabase stack. It's the most faithful option, since it runs the real `auth` and `storage` schemas on the Postgres version Supabase uses, but it needs Docker and the stack running, which is slow to start in CI and heavy on a laptop. [supabase-test-helpers](https://github.com/usebasejump/supabase-test-helpers) adds pgTAP helpers for creating users and switching roles, with the same requirements. Testing against a hosted Supabase branch is real end to end, but slower still, and each run touches a live project.

This package trades fidelity for having nothing to install or start, with tests in TypeScript next to the rest of yours. Where it loses is anything outside the stubs: the real `auth` schema's other tables and functions, most extensions, PostgREST, storage's HTTP API and realtime. If a policy depends on those, use `supabase test db`.

## Known limitations

- PGlite is Postgres 19, and Supabase projects run an earlier major version. Policies rarely notice, but a migration using syntax newer than your project's Postgres will pass here and fail there.
- Only `pgcrypto` and `uuid-ossp` can be created. A pulled schema usually also creates `pg_graphql`, `supabase_vault` or `pgjwt`; remove those lines from the copy of the migrations you test, or the migration fails.
- `db.query` and migrations run as a Postgres superuser. Supabase's `postgres` role isn't one, so a migration that needs superuser rights passes here and fails there.
- Storage's HTTP API fills in `owner` and `owner_id` from the token; a test inserting into `storage.objects` has to set them itself, or owner-based storage policies will deny it.
- It tests SQL, not the HTTP API. PostgREST applies the same roles and policies, so a policy that holds here holds there, but column choices and request headers your app sends aren't covered.
- Only the stubs listed above exist. Custom access token hooks, `auth.identities`, `auth.sessions` and the `vault` schema aren't there.
- `query` takes one statement at a time.
- `denied` counts an error in its second run, as the owner, as reaching rows. A trigger or function that raises only for the owner role can make a check that matches nothing return `true`.

## Privacy

Everything stays in memory in the test process. Nothing is sent over the network.

## Status and versioning

The tests cover every exported function, including bad input and the ways a statement can be denied, with a property-based test checking `denied` against a model of the policies. They run on Node 22, 24 and 26.

Versions are 0.x until the API has settled. A minor release (0.1 to 0.2) can change the API and says how in the changelog; a patch release won't. 1.0 will come when:

- it has run in the CI of at least two projects for three months without an API change
- the stubs have been checked against the current Supabase `auth` and `storage` schemas
- every example in this README is run by the test suite

## License

MIT
