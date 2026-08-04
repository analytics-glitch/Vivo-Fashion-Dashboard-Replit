---
name: Blocking I/O must never run directly in async handlers
description: async FastAPI handlers/middleware must wrap psycopg2 in run_in_threadpool (or be plain def); Clerk proxy is pure-async httpx. Violations freeze the whole worker, not one request.
---

Never call blocking psycopg2 code (`_acquire_conn`, `_user_for_session`, `run_query`) directly inside an `async def` handler or middleware — `_acquire_conn`'s sleep-retry blocks the event loop, freezing EVERY concurrent request on that worker (health checks included).

**Why:** 2026-08-04 prod incident: DB pool saturation → `clerk_auth_gate`'s sync session lookup + the Clerk proxy's `run_in_threadpool` shared one finite anyio pool with heavy endpoints; stuck threads queued the sign-in check forever → blank dashboard for ~1 in 3 loads.

**How to apply:**
- Hot-path async code: wrap blocking DB calls in `run_in_threadpool` (auth gate does this for `_user_for_session`) or convert the handler to plain `def`.
- Outbound HTTP from async code: use `httpx.AsyncClient` (`_clerk_http` pattern, closed on shutdown), never `requests`+`run_in_threadpool` for latency-critical paths.
- Pool exhaustion should fail fast: `_acquire_conn` raises 503 after ~5s — keep it that way; don't add longer retry loops.
- `pg_stat_statements` top-20 + the in-process slow ring are exposed at `/api/admin/slow-queries` (admin-only); use it first in any slowdown diagnosis.
