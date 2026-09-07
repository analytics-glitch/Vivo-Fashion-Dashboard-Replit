---
name: Startup DDL must never block port bind
description: Prod crash-loop cause — FastAPI startup hooks doing DDL blocked on orphaned-session Postgres locks past the platform's ~60s port timeout.
---

**Rule:** Any DB-touching FastAPI startup work (idempotent DDL, seeds, health logging) must run via the `_deferred_startup` decorator in `api_pg.py` (one ordered background daemon thread), never as a synchronous `@app.on_event("startup")` hook.

**Why:** A deploy restart SIGKILLs the previous API+sync processes mid-write; their orphaned Postgres sessions can hold table locks for minutes. The next boot's `CREATE/ALTER TABLE` then blocks silently, uvicorn never binds port 8080 within the platform's ~60s port timeout, and the deployment crash-loops ("a port configuration was specified but the required port was never opened"). The 60s window is not enough headroom — port bind must be unconditional.

**How to apply:** New startup ensures → `@_deferred_startup` (order = registration order; keep dependents after their dependencies, e.g. seed-admin after users-table). Imported route modules must also enqueue compatibility work during registration (for example through the host module's deferred-startup helper), never execute their own ensure synchronously. Keep synchronous only fast non-locking asserts (e.g. standard_conforming_strings). The watchdog also waits (bounded 60s port poll) for the API port before starting the sync loop, so sync writes never race boot. Runner lifecycle lines log at WARNING because the `api_pg` logger has no handler — INFO is silently dropped; deployment-log observability depends on WARNING+.
