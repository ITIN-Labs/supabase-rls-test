---
'@itin-labs/supabase-rls-test': patch
---

`denied` returns `true` when the check's second run, as the owner, reaches a row and a trigger or constraint refuses it. It used to reject with that error.
