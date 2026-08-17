---
name: Product Workspace startup readiness
description: Startup behavior when the workspace database or optional migrations are slow or unavailable
---

The Product Workspace must bind its HTTP port and keep readiness/identity bootstrap independent from optional PostgreSQL schema work. Database probes and migration attempts need bounded timeouts, and optional migrations must log-and-skip rather than terminate or hold the shell in startup mode.

**Why:** PostgreSQL connection timeouts can occur independently of the web workflow. A single startup DDL batch otherwise leaves `/readyz` and the first-visit identity selector unusable even though the service itself is running.

**How to apply:** Keep `/api/workspace/readyz` service-level and return the exact `{status:"ok"}` contract once the HTTP service is listening. Fail closed for normal data routes until the database is reachable, but allow the no-auth `/team` bootstrap route to return the seeded identity list during degraded startup. Use bounded pg connection attempts so timed-out queries do not occupy the pool indefinitely.