# System Diagnosis — Vivo Fashion Group Platform
**Date:** 2026-08-04 · **Scope:** API server (FastAPI), architecture, database tables & queries, sync pipeline, current production incident.

---

## 1. Executive summary

The platform is fundamentally healthy: the database is well-indexed, the sync pipeline is running on schedule, and the API serves pages in ~50–250 ms. There is exactly **one live user-facing problem**: the sign-in check (`/api/__clerk/*`) intermittently hangs forever in production because some uvicorn workers still have their background thread pool saturated with stuck threads from this morning's database overload. Requests landing on a stuck worker never get a response → blank dashboard.

The overload itself was caused by a real architecture bug: session-level Postgres advisory locks silently **no-op through Neon's transaction-mode pooler**, so when production restarted, all 3 workers ran the full 46-step startup + cache prewarm concurrently and exhausted the connection pool. That bug is fixed in code (`app_singleflight` claim-row) but **is not yet published** — a Republish both ships the fix and replaces the stuck workers.

| Area | Verdict |
|---|---|
| Production serving | ✅ healthy except Clerk proxy path |
| Database health | ✅ good (indexes, sizes, connection counts normal) |
| Sync pipeline | ✅ on schedule (heartbeat 07:50, sales loaded 06:38) |
| Startup concurrency fix | ✅ fixed in dev, ⏳ awaiting Republish |
| Query-layer telemetry | ⚠️ blind spot (pg_stat_statements unreadable) |
| Async/blocking discipline | ⚠️ structural risk (details §6.4) |

---

## 2. Architecture map

```
Browsers / Mobile app
        │  (HTTPS, path-based proxy)
        ▼
┌────────────────────────────────────────────────────────────┐
│ Production VM (Reserved VM, 2 vCPU / 8 GiB)                │
│                                                            │
│  watchdog.py (supervisor)                                  │
│   ├── uvicorn api_pg:app  --workers $API_WORKERS           │
│   │     FastAPI · 421 route decorators · 38,613 lines      │
│   │     psycopg2 ThreadedConnectionPool PER WORKER         │
│   │     in-process SWR cache (_cache dict + threads)       │
│   │     46 deferred-startup steps (claim-row gated)        │
│   ├── sync_incremental.py (continuous loop)                │
│   └── recovery / rebuild steps (one-shot)                  │
│                                                            │
│        ▼ Neon Postgres (transaction-mode pooler)           │
│   all_sales 1.29 GB · shopify_sales 786 MB ·               │
│   all_customers 142 MB · 213 public tables                 │
└────────────────────────────────────────────────────────────┘

Data sources → sync_incremental.py:
  Shopify POS (vivowoman / uganda / rwanda)  → all_sales (Retail)
  Shop Zetu ShopifyQL                        → all_sales (Online)
  Odoo POS                                   → all_sales + all_inventory + products
  FootfallCam                                → footfall tables
  Google Sheets                              → warehouse bins, HR roster
```

**Dev vs prod launch:** dev runs `run_api.py` (single uvicorn, frees the port first). Prod is supervised by `watchdog.py`, which spawns uvicorn with `--workers $API_WORKERS`, health-checks `/api/healthz` every 5 min, and respawns within ~10 s of a crash. `API_WORKERS` is now pinned to **1** in production (was 3).

---

## 3. What is verifiably working

Measured directly against production today:

| Check | Result |
|---|---|
| `GET /` (dashboard shell) | 200 in 0.05–0.08 s, JS bundle 1.19 MB serves in 0.13 s |
| `GET /auth/me` (unauthenticated) | 401 correctly, 0.06 s |
| DB connections | 8 total, 1 active, 0 lock waits — completely calm |
| Active long-running queries | none |
| Sync heartbeat row | `last_cycle_at 2026-08-04 07:50:46` (loop alive, step=inventory) |
| Latest sales data | `all_sales.loaded_at 2026-08-04 06:38` (morning cycle completed) |
| Clerk upstream | `frontend-api.clerk.dev` reachable; `/api/__clerk/v1/environment` returns 200 in ~0.2 s **on healthy workers** |
| Indexes on `all_sales` (1.29 GB / ~764 MB heap) | 12 indexes covering the real query patterns: `(variant_sku, sale_date)`, `(store_id, sale_date)`, `(pos_location_name, sale_date)`, `(country, sale_date)`, `(sale_kind, sale_date)`, `(customer_id, sale_date)` partial indexes, `(loaded_at)` for cheap polls |
| `all_sales` primary key | `PRIMARY KEY (id, store_id)` — surrogate md5-of-grain id, collision-safe after the rebuild fix |
| Publish schema diff | clean: only `CREATE TABLE app_singleflight`, non-destructive, no data loss |

### Sync pipeline (assessed as well-designed)
- **Idempotent writes:** Shopify/Odoo syncs DELETE their window before INSERT — safe to re-run.
- **Heartbeat design:** single-row `sync_heartbeat` (id=1), pulsed per store/step and by a background thread during long extracts, so the watchdog can't false-kill slow cycles.
- **Recovery:** after 3 consecutive failed health checks, watchdog suspends the managed loop and runs a one-shot `--once --days 4` backfill, preventing overlap/double-pulls.
- **Batching:** `execute_values` with page_size=500; all_sales rebuild streams in 50 k batches (past OOM fixed).
- **Rebuild ordering:** REBUILD_ON_BOOT runs after the API is up but before the sync loop starts — prevents historical doubling.

---

## 4. The live incident — exact mechanism

**Symptom:** dashboard loads HTML + JS, then sits blank. This is the auth gate hanging.

**Mechanism, verified:**
1. `clerk_frontend_proxy` (api_pg.py:26812–26874) is `async def` and calls the blocking `requests` library via Starlette `run_in_threadpool` — i.e. the **shared anyio worker-thread pool**.
2. This morning's connection-pool exhaustion (`PoolError: connection pool exhausted` at `clerk_auth_gate`, api_pg.py:1296) left background threads inside some workers blocked indefinitely.
3. The anyio thread pool (default ~40 threads/worker) on those workers is now saturated with zombie threads. New `run_in_threadpool` calls queue behind them forever — **no timeout at the proxy layer** (the `timeout=20` applies to `requests`, but the request never reaches `requests`).
4. Measured from outside: `/api/__clerk/v1/environment` → 3 consecutive timeouts (worker A), then 5 successes ~0.2 s (worker B). Roughly 1 in 3–4 page loads hits a stuck worker → blank screen.
5. Everything else is fast because plain page/data endpoints don't touch the saturated pool paths.

**Fix:** Republish. It (a) replaces all workers, (b) ships the startup single-flight fix so the restart itself can't recreate the overload, (c) now boots with `API_WORKERS=1`, eliminating cross-worker threadpool lottery entirely.

**Residual hardening worth doing later:** rewrite the Clerk proxy with an async HTTP client (`httpx.AsyncClient`) so it never consumes the blocking thread pool.

---

## 5. Database findings

### Table footprint (production)
| Table | Total size | Notes |
|---|---|---|
| all_sales | 1.29 GB | core fact table; TEXT `sale_date` (must `::date` cast — a known trap) |
| shopify_sales | 786 MB | raw Shopify lines |
| all_customers | 142 MB | includes pseudo/walk-in accounts, excluded via `_not_walkin_pseudo_sql` |
| raw_shopify_orders | 137 MB | order headers; `total_price` is 0 — must join lines |
| all_products_clean | 60 MB | product/style master |
| all_inventory | 24 MB | current stock (WIP/pipeline locations excluded at ingestion) |
| stock_transfers | 12 MB | append-only history |
| fabric_receiving_po_sheets | 48 kB | small |
| rollup_style_velocity2 / rollup_sku_daily2 | tiny | correct — rollups live elsewhere/small grain |

213 public tables total. Note: `pg_stat_user_tables` counters read as 0 through the read-replica connection, so vacuum/seq-scan telemetry couldn't be measured this way (see §6.5).

### Indexing verdict: good
The index set on `all_sales` matches how the app actually queries (SKU+date, store+date, location+date, country+date, kind+date, customer first-purchase partial). The known performance invariants are being respected in code: inventory pre-aggregated by SKU before joining sales (no 34× fan-out), aged-stock uses a semi-join instead of full-history `MAX(sale_date)`, topbar polls hit `idx_all_sales_loaded_at`.

### Risks
- `sync_odoo_customers_incremental` runs a regex `SELECT DISTINCT` over `all_sales` hourly (sync_incremental.py:1204) — potential full-table scan of a 1.29 GB table if the expression can't use an index. Worth verifying with EXPLAIN.
- `all_sales` has no business-grain unique constraint; idempotency relies entirely on DELETE-by-window discipline. One new extract path that forgets the delete doubles data (mitigated by the validation agent's checks, but not enforced by the DB).

---

## 6. Code & architecture findings

### 6.1 Startup concurrency (root cause of this morning) — FIXED, pending publish
- `pg_try_advisory_lock` silently no-ops through Neon's transaction-mode pooler → every worker "won" the lock → 3 workers × 46 startup steps + prewarm ran concurrently → DB saturation.
- Fix in code: `_singleflight_claim/_singleflight_release` (auto-created `app_singleflight` table, TTL-steal + owner UUID token), applied to `_launch_deferred_startup` and `run_sales_rollup_refresh`. Verified in dev: exactly one worker runs startup.
- **Pending:** Republish to ship it. Also recommended (not yet done): set `DATABASE_URL_DIRECT` in production so advisory locks work against a direct connection; user previously declined — the claim-row approach is the working alternative.

### 6.2 Connection pool sizing — coherent, one inconsistency
- Per-worker `ThreadedConnectionPool(minconn=2, maxconn=MAX_DB_CONNECTIONS)` where `MAX_DB_CONNECTIONS = max(4, TOTAL_DB_CONNECTIONS // API_WORKERS)` — total = budget, so scaling workers can't exceed Neon's ceiling. Good design.
- **Inconsistency:** `watchdog.py` defaults `_API_WORKERS` to `"1"` while `api_pg.py` defaults `API_WORKERS` to `"4"`. If prod ever runs uvicorn without the watchdog (or with a stale env), pool math and worker count disagree. Production env now pins `API_WORKERS=1` explicitly — good. Align the `api_pg.py` default to 1 for consistency.

### 6.3 Caching layers — sound, with one interaction risk
- SWR cache: in-process dict, stale entries served within a grace window while a single-flight background thread recomputes. Correctly does NOT background-refresh mutation-adjacent caches.
- Heavy-dashboard prewarmer (900 s TTL + 600 s warm) keeps 10–20 s whole-history queries cached; a separate `_warm_loop` thread keeps PG `shared_buffers` hot with 90-day slices. This is why normal page loads are fast.
- Risk: with N workers, each holds its own cache + prewarm threads → N× warm load. At `API_WORKERS=1` this disappears; if workers are raised again, prewarm should also be claim-gated.

### 6.4 Async/blocking discipline — the main structural weakness
- Many endpoints are `async def` but perform blocking psycopg2 work; `_acquire_conn` retries a full pool with `time.sleep(0.05)` loops — called from async context this **blocks the event loop**, stalling every concurrent request on that worker (not just the slow one).
- Blocking work correctly wrapped today: Clerk proxy (`run_in_threadpool`), AI chat cores, background refreshes. But the wrapper of choice (`run_in_threadpool`) shares one finite thread pool — heavy DB endpoints + Clerk proxy + auth lookups all compete for the same ~40 threads. This coupling is exactly how a DB incident became a login outage.
- **Recommended direction:** (a) make hot-path handlers `def` (FastAPI runs them in its own threadpool) or use `asyncio.to_thread` with dedicated executors per concern; (b) move the Clerk proxy to `httpx.AsyncClient`; (c) replace the sleep-retry pool acquisition with `pool.getconn` under a short timeout + clear 503, so pool exhaustion fails fast instead of freezing.

### 6.5 Observability blind spots
- `pg_stat_statements` is installed in `shared_preload_libraries`, but its rows are not readable from the workspace query tool — so there is **no per-query slow-query telemetry**. We know *which* endpoints are heavy from code review, not from measured query stats.
- Deployment logs were not retrievable via the tooling during this diagnosis (returned empty); incident forensics relied on DB state + black-box probing.
- Recommendation: an internal `/api/admin/slow-queries` endpoint (reads `pg_stat_statements` server-side, admin-gated) so the slowest 20 queries by total time are visible in-app.

### 6.6 Monolith scale
`api_pg.py` is 38,613 lines with 421 route registrations plus sync, validation, fabric, IBT, CRM, HR, finance domains. Routers have been split out for newer domains (growth model, retail desk, AI insights, fabric chat) — that pattern works; continuing it is the right direction but is maintenance work, not a live risk.

### 6.7 Known low-priority noise (pre-existing, not regressions)
- `loyalty-smoke` workflow failing (502) — dev-side check.
- Shopify `refunds-create` webhook 405s in prod logs — endpoint not registered for that method.
- Fabric sheet extract needs a Google Sheets connection.
- Expo package version warning.

---

## 7. Prioritized action list

**Now (unblocks production):**
1. **Republish.** Ships the single-flight startup fix, replaces stuck workers, boots at `API_WORKERS=1`. Publish diff is clean (only creates `app_singleflight`).

**This week (hardening against recurrence):**
2. Rewrite `clerk_frontend_proxy` with `httpx.AsyncClient` + explicit timeout — removes auth from the blocking thread pool permanently. (api_pg.py:26812)
3. Make pool exhaustion fail fast: `_acquire_conn` should raise a clear 503 after a short wait instead of sleep-looping; audit `async def` handlers doing blocking DB work on hot paths (auth gate, /auth/me, topbar polls).
4. Add an admin-gated slow-query visibility endpoint (reads `pg_stat_statements` server-side).

**Soon (maintenance):**
5. Align `api_pg.py`'s `API_WORKERS` default with the watchdog (1); document that raising workers requires claim-gating the prewarmer too.
6. EXPLAIN-verify the hourly regex `SELECT DISTINCT` customer gap-fill over `all_sales`; rewrite against the rollup if it seq-scans.
7. Consider a business-grain unique guard (or an upsert path) for `all_sales` writes as a defense-in-depth alongside DELETE-window idempotency.

---

## 8. Evidence appendix
- Prod HTTP probes: `/` 200 (0.05 s), `/auth/me` 401 (0.06 s), `/api/__clerk/v1/environment` 3× timeout then 5× 200 (~0.2 s) — stuck-worker lottery.
- Prod DB (2026-08-04 ~08:00 UTC): 8 connections, 1 active, 0 lock waits, no long-running queries.
- `sync_heartbeat`: id=1, `last_cycle_at 2026-08-04 07:50:46+00`, status=inventory.
- `all_sales.loaded_at` max = 2026-08-04 06:38:11.
- Publish schema diff: `hasStructuralDataLoss: false`, `maybeNonBackwardsCompatible: false`, single statement `CREATE TABLE app_singleflight`.
- Earlier prod logs (morning incident): `PoolError: connection pool exhausted` at `clerk_auth_gate` (api_pg.py:1296).
