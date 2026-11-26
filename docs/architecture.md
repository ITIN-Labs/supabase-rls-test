# How it works

`createTestDb` starts a PGlite database, which is Postgres compiled to WebAssembly and running inside the Node process. It runs one SQL script of stubs (`src/stubs.ts`) that recreates the parts of a Supabase database that migrations and policies use: the `anon`, `authenticated` and `service_role` roles and their grants, `auth.users` and the `auth.uid()` family of functions, and the storage tables and helper functions. The function bodies follow Supabase's own definitions, so a policy that calls `auth.uid()` sees the same value it would in production. Then it runs your migrations in file name order.

Supabase decides who a request belongs to from the JWT, which PostgREST turns into a role (`set role authenticated`) and a setting (`request.jwt.claims`). A session does the same thing directly: each query runs in its own transaction that starts with `set local role` and `set_config('request.jwt.claims', ..., true)`. Both are transaction-local, so when the transaction ends, by commit, rollback or error, the connection is back to the database owner. That's why sessions can be used in any order without leaking into each other, and why the owner's `db.query` needs no transaction of its own.

A signed-in session's claims come from the user's `auth.users` row, read just before the role switch (the `authenticated` role can't read `auth.users`), so they match what Supabase's auth server would issue. `createUser` inserts as `supabase_auth_admin` for the same reason: sign-up triggers then run with the privileges they have in production.

After the migrations, the connection is reset, because a migration can leave settings behind that no Supabase request would inherit.

`denied` runs the statement like any session query, always rolls back, and counts a permission error or an empty result as denied, which are the two ways Postgres reports a policy stopping a statement. An empty result is checked by rolling back to a savepoint and running the statement again as the owner; the request claims are transaction settings set before the savepoint, so they survive and `auth.uid()` means the same user in both runs. An error in the owner run, from a trigger or constraint on a row it reached, counts as rows reached.

## Choices

PGlite over a real Postgres server: it needs nothing installed and starts in a second or two. The cost is that it runs a newer Postgres than Supabase does, and only extensions PGlite ships (`pgcrypto` and `uuid-ossp` are loaded) can be created.

SQL over the PostgREST HTTP API: policies are enforced by Postgres, so testing at the SQL level checks them directly, without a server. The cost is that requests your app makes through the client library aren't exercised.

One runtime dependency and no assertion helpers: `denied` returns a boolean rather than throwing, so it fits any test runner's own assertions.
