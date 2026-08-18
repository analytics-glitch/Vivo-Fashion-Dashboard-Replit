---
name: Product Workspace startup readiness
description: Startup behavior when the workspace database or optional migrations are slow or unavailable
---

The Product Workspace must bind its HTTP port and keep readiness/identity bootstrap independent from optional PostgreSQL schema work. Database probes and migration attempts need bounded timeouts, and optional migrations must log-and-skip rather than terminate or hold the shell in startup mode.

**Why:** PostgreSQL connection timeouts can occur independently of the web workflow. A single startup DDL batch otherwise leaves `/readyz` and the first-visit identity selector unusable even though the service itself is running.

**How to apply:** Keep `/api/workspace/readyz` service-level and return the exact `{status:"ok"}` contract once the HTTP service is listening. Fail closed for normal data routes until the database is reachable, but allow the no-auth `/team` bootstrap route to return the seeded identity list during degraded startup. Use bounded pg connection attempts so timed-out queries do not occupy the pool indefinitely.

Feature columns used by normal workspace routes must also be part of the main `ensureSchema()` bootstrap, not only the fallback recent-migration path. The fallback path runs only when the bounded bootstrap times out or fails, while a successful bootstrap marks the database ready immediately.

**Why:** A healthy database startup can otherwise report ready while a newly added route queries a column that the fallback migration would have created.

**How to apply:** When adding a workspace field, update the main idempotent schema batch and its default/backfill there; keep fallback migrations as a compatibility net, not the primary schema path.