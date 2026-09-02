---
name: External database variable ownership
description: How to retain Vivo's Neon database without blocking Replit's Dev/Prod publishing flow.
---

Vivo's external Neon connection belongs in `VIVO_DATABASE_URL`. Replit's reserved
`DATABASE_URL` must not be manually populated with an external connection string.
Runtime entrypoints should prefer the Vivo-specific variable while retaining the
managed variable only as a development compatibility fallback.

**Why:** Replit's Republish preflight refuses to proceed when an external database
occupies the reserved `DATABASE_URL`, even though the application itself can connect
to that database. Simply deleting it before redirecting the runtimes risks starting
the application against a different, incomplete managed database.

**How to apply:** Add or rotate the external connection under `VIVO_DATABASE_URL`,
confirm the API, worker, and standalone artifact services use it successfully, and
only then remove the manually configured `DATABASE_URL` secret. Do not migrate data
or switch database providers as part of this variable handoff.