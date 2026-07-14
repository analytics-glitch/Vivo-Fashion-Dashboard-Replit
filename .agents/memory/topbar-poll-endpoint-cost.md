---
name: Topbar poll endpoints must be cheap
description: Per-user ~60s polls (data-freshness, active-pos, ibt/late-count) multiplied full-table scans / global solves into constant DB load.
---
Rule: any endpoint polled by the topbar/filter-bar (every ~60s per logged-in user) must be O(index lookup) or served from cache; never a full all_sales scan or a global optimizer run.

**Why:** SLOW QUERY logs showed 2–10s responses under real traffic: `MAX(loaded_at)` full-scanned 1.5M rows (no index), `/api/ibt/late-count` ran a full `_ibt_global_solve` per poll, and store-list GROUP BYs re-ran every 2 min, all while the 1-minute sync loop wrote to the same DB.

**How to apply:**
- `idx_all_sales_loaded_at` exists (ensured via a `@_deferred_startup` hook — startup DDL must never be synchronous, see startup-hooks-port-bind).
- `run_query` accepts an explicit `ttl=` override for slow-changing lookups (store→country map 3600s, active-pos 600s).
- `ibt/late-count` uses an in-process single-flight memo (lock + 600s TTL); keep the memo write on every success path.
- New badge/poll endpoints: reuse these patterns, and remember dev shares the DB with the per-minute sync loop — the published Reserved VM is the true perf environment.
