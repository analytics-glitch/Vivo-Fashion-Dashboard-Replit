---
name: Advisory locks are pooler-unsafe — use claim rows
description: Session advisory locks silently no-op through Neon's transaction-mode pooler; single-flight gates must use the app_singleflight claim-row helper.
---

**Rule:** Never use session advisory locks (`pg_try_advisory_lock`/`pg_advisory_unlock`) for cross-worker/cross-process single-flight when the connection may route through a transaction-mode pooler. Use `_singleflight_claim(key, ttl_minutes)` / `_singleflight_release(key, owner)` in api_pg.py (claim row in `app_singleflight`, TTL steal for crashed winners, owner-token so a late ex-winner can't delete a stolen claim).

**Why:** Prod (VM, multi-worker uvicorn) sets no `DATABASE_URL_DIRECT`, so even `get_direct_conn()` hits the pooler. Each statement lands on a fresh backend session, so *every* worker "acquires" the lock. On 2026-08-04 all three workers ran the full 41-step deferred startup + cache prewarm concurrently → DB saturated (queries 45–425s), watchdog restarted the API, cascade of cold restarts, prod "super slow" for users.

**How to apply:** Deferred startup and `run_sales_rollup_refresh` already use the claim gate. Any new startup work, cron-like loop, or refresh that must run once across workers/instances (dev sync loop + prod watchdog are separate processes) must use the claim helper, not advisory locks. `pg_advisory_xact_lock` inside a single transaction is still fine through the pooler. Fail-open on claim errors (idempotent work run twice beats never run).

## Pooler-safe alternative: in-transaction FOR UPDATE lock row
For capacity/quota guards (e.g. event RSVP seat caps): keep a tiny table with one
row per entity (`entity_id PRIMARY KEY`), then inside ONE transaction (conn
autocommit=False): `INSERT … ON CONFLICT DO NOTHING` → `SELECT … FOR UPDATE` →
count → guarded write → commit. Row locks held within a single transaction are
pinned to one backend, so they serialize correctly through the txn-mode pooler
(unlike session advisory locks). Verified deterministic under a 12-way race for
the last seat: exactly one 200, rest 409, count lands exactly at cap.
**Why:** single-statement `INSERT … SELECT count<cap` under READ COMMITTED lets
concurrent statements all read the same pre-capacity snapshot — overshoot is
unbounded, not "one extra chair".
**How to apply:** any "at most N rows may reach state X" invariant enforced from
multiple workers/threads through the pooled DB.
