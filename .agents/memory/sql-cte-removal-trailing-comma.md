---
name: Removing a CTE from a WITH-chain leaves a dangling trailing comma
description: Deleting a `name AS (...)` CTE block from a multi-line WITH clause but leaving the comma before the next CTE/final SELECT produces a Postgres syntax error that only fires at query execution, not at Python import/compile time.
---

# Symptom

`psycopg2.errors.SyntaxError: syntax error at or near "SELECT"` (or another
CTE name) at runtime, on an endpoint that otherwise imports, compiles, and
passes unit tests cleanly. The broken query is usually deep in a long
f-string SQL literal, so the error line number refers to a line *within the
SQL text*, not the Python file — don't go looking in the `.py` file at that
line number.

# Root cause

A `WITH a AS (...), b AS (...), c AS (...) SELECT ...` chain requires commas
strictly *between* CTEs, never before the final `SELECT`. When a CTE that
used to sit in the middle of the chain is deleted (e.g. removing an
override/join CTE during a refactor), it's easy to delete the CTE body but
leave the trailing `,` that used to separate it from the *next* item —
turning `..., removed_cte AS (...), SELECT ...` into `..., SELECT ...` with
one comma too many once the removed CTE's own leading/trailing comma isn't
also cleaned up. This is a distinct failure mode from the "stale local
variable" class (see `manual-style-retirement.md` history / `range-tier-model.md`
for a same-refactor `NameError` example): the comma bug is a `SyntaxError` at
**query execution**, invisible to Python's compiler, unit tests that mock the
DB layer, and `python -m py_compile`.

**Why it survives normal checks:** compile-checking a `.py` file only
validates Python syntax, not the SQL string literal inside it. Unit tests
that mock `_fetch_styles`/`_compute_tier` (see `range-tier-model.md`) never
execute the real SQL, so they pass while the live endpoint 500s.

# How to apply

After removing or reordering ANY CTE from a multi-CTE SQL string (not just
during override-removal work), diff the immediate lines *before* the deleted
block (does the previous CTE's closing `)` need a comma added?) and *after*
it (does a lingering `,` need removing before the next CTE or the final
`SELECT`?). Then actually execute the query against a real connection (or
call the wrapping Python function directly against the dev DB) — never trust
`compile`/unit-test-green alone for a SQL-string edit. A repo-wide grep for
`)\n,\nSELECT` / `),\nSELECT` at the top-level indentation of WITH-clause
literals is a fast way to catch this class after a bulk removal — it caught 3
separate broken queries in `merch_router.py` in one pass on 2026-08-27
(all three were the exact same one-comma-too-many pattern, from three
functions independently editing the same tier-override-removal region).
