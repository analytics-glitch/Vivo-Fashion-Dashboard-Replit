---
name: Advisory locks are pooler-unsafe — use claim rows
description: Session advisory locks silently no-op through Neon's transaction-mode pooler; single-flight gates must use the app_singleflight claim-row helper.
---

**Rule:** Never use session advisory locks (`pg_try_advisory_lock`/`pg_advisory_unlock`) for cross-worker/cross-process single-flight when the connection may route through a transaction-mode pooler. Use `_singleflight_claim(key, ttl_minutes)` / `_singleflight_release(key, owner)` in api_pg.py (claim row in `app_singleflight`, TTL steal for crashed winners, owner-token so a late ex-winner can't delete a stolen claim).

**Why:** Prod (VM, multi-worker uvicorn) sets no `DATABASE_URL_DIRECT`, so even `get_direct_conn()` hits the pooler. Each statement lands on a fresh backend session, so *every* worker "acquires" the lock. On 2026-08-04 all three workers ran the full 41-step deferred startup + cache prewarm concurrently → DB saturated (queries 45–425s), watchdog restarted the API, cascade of cold restarts, prod "super slow" for users.

**How to apply:** Deferred startup and `run_sales_rollup_refresh` already use the claim gate. Any new startup work, cron-like loop, or refresh that must run once across workers/instances (dev sync loop + prod watchdog are separate processes) must use the claim helper, not advisory locks. `pg_advisory_xact_lock` inside a single transaction is still fine through the pooler. Fail-open on claim errors (idempotent work run twice beats never run).
