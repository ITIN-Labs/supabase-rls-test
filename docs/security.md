# Threat model

This is a test tool. It runs SQL written by the person writing the tests, in a database that only lives in the test process's memory. Nothing it does reaches a real Supabase project.

## What's trusted

Your migrations and test code. The package runs them as written, as the database owner or as the role you ask for. It doesn't try to protect you from your own SQL, and passing untrusted SQL to it is out of scope.

PGlite and Node. A bug in either is reported to them.

## What isn't

The result. The point of the package is to tell you whether your policies hold, so the main risk is a false all-clear.

## Risks and defences

A test passes here but the policy fails in Supabase. The stubs could differ from the real `auth` and `storage` schemas, or PGlite's Postgres could behave differently from the version Supabase runs. Defences: the stubs copy Supabase's own function definitions and grants; sessions carry the same token claims Supabase issues, read from the user's `auth.users` row; sign-ups run as `supabase_auth_admin` as they do in Supabase; and the README lists every known difference. A missing table or function is an error, not a silent pass, but a claim or column the stubs don't have reads as null, which a policy may treat as "deny".

Settings left by a migration change what sessions see. A pulled schema starts with `set row_security = off`, which would make every session query fail with a permission error and every `denied` check pass. Defence: after the migrations, the connection is reset (`reset session authorization; reset all`), and every session query also sets `row_security = on` itself. The test fixtures include a migration with a pg_dump header to keep this covered.

A broken test counts as a pass. A check that expects to be denied could pass because the SQL itself is wrong. Defence: `denied` counts only permission errors (42501) and empty results, and rejects on every other error. An empty result counts only if the statement, run again as the owner with the same token, does reach rows; when it doesn't (an empty table, a wrong id), `denied` rejects with `NO_MATCHING_ROWS` rather than passing. An error in that second run counts as reaching rows, since the same statement ran without error as the user: the second run differs only in getting past the policies, so the error comes from a row it reached, such as a trigger or constraint refusing it. The exception is a trigger or function that behaves differently for the owner role, which can make a check with no matching rows pass.

A denied check leaks its change into later tests. Defence: `denied` always rolls back, and the tests check that data is unchanged afterwards.

A session's role or claims leak into the next query. Defence: each session query runs in its own transaction with `set local`, which Postgres undoes when the transaction ends, even after an error. The tests check the connection is back to the owner afterwards.

Supply chain. One runtime dependency (PGlite), a committed lockfile, `npm ci` in CI, `npm audit`, CodeQL, Dependabot, actions pinned to commit SHAs, no install scripts, and publishing through npm trusted publishing with provenance.

## What leaves the machine

Nothing. The package makes no network requests and collects no telemetry.
