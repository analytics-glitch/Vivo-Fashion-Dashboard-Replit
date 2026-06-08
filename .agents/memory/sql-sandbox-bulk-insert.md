---
name: SQL sandbox bulk insert
description: Why large INSERTs via the executeSql sandbox fail and how to chunk them
---

The `executeSql` callback in the code-execution sandbox passes the full SQL string as a process argument. Large multi-row `INSERT ... VALUES (...)` statements (e.g. 1000 rows) fail with `Error: spawn E2BIG` (argument list too long).

**How to apply:** When seeding via the sandbox, batch rows into small chunks (~200 rows per INSERT worked reliably for a ~13-column fact table). Loop and insert chunk-by-chunk.

**Why:** E2BIG is an OS limit on argv size, not a Postgres limit. Smaller statements sidestep it. Note the sandbox is a notebook — a long-running loop can be interrupted (e.g. when a background subagent completes), so verify the final row count with `SELECT count(*)` and re-run a TRUNCATE + reseed if the count is short.
