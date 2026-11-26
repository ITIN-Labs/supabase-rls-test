# @itin-labs/supabase-rls-test

## 0.1.1

### Patch Changes

- 0d9a844: `denied` returns `true` when the check's second run, as the owner, reaches a row and a trigger or constraint refuses it. It used to reject with that error.

## 0.1.0

### Minor Changes

- d5a0f97: Added: first release, with `createTestDb`, sessions for signed-in users and signed-out visitors, and `denied` checks.
