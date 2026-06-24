---
name: BI sales rollup tables (dashboard speedup)
description: Pre-aggregated rollup_* tables that make Customers/Range-Mgmt/Product-Analysis fast; how the freshness gate + live fallback + sync refresh work.
---

# BI sales rollup tables

The slow cold endpoints (Customers ~28s, Range Mgmt ~11s, Product Analysis ~14s)
were full-scanning `all_sales` (~1.6M) for lifetime / trailing-window aggregates on
every request. They now read pre-aggregated `rollup_*` tables, refreshed in the
background, dropping cold latency to ~2.3s / 0.8s / 1.5s.

## Architecture (single source of truth in `api_pg.py`)
- `_rollup_defs()` returns the (name, table, select_sql) for each rollup. The read
  paths and the refresh both derive from this, so they cannot drift.
- `run_sales_rollup_refresh(only=None)` does a **build-then-swap per table**: build
  `<table>_stage`, TRUNCATE the live table, copy stage→live, stamp `rollup_meta`
  (name, refreshed_at, row_count). Idempotent full rebuild; safe to re-run.
- `_rollup_fresh(name)` is **fail-closed**: missing meta row, age > `ROLLUP_MAX_AGE_SEC`
  (25h), zero row_count, or any DB error → returns False → read path uses live SQL.
  Every gated read path keeps its original live SQL as the else-branch.

## Refresh wiring (prod is a SEPARATE DB — see prod-separate-db-rebuild.md)
- Standalone script `build_sales_rollups.py` = thin wrapper over
  `api_pg.run_sales_rollup_refresh()`. Run with no args (all) or a rollup name.
- `sync_incremental.py` runs it as a subprocess: **bootstrap immediately when
  `rollup_meta` is empty** (fresh prod DB gets fast on first deploy), then **hourly**
  (`_LAST_ROLLUP_REFRESH` guard). Skips if `rollup_meta` table is missing (cold DB
  before api_pg's startup hook created it) — a later cycle picks it up.
- **Why hourly, not daily:** per-style window columns (30d/180d/…) are baked at
  refresh time; per-customer rollups store ABSOLUTE first/last sale dates so churn's
  CURRENT_DATE math stays correct regardless of rollup age. The freshness gate bounds
  window-column drift to one refresh interval.

## Overlap protection
`run_sales_rollup_refresh` takes a **session advisory lock** (`pg_try_advisory_lock`,
key `_ROLLUP_REFRESH_LOCK_KEY=778201`) so a manual run + the hourly sync subprocess
can't collide on the shared `<table>_stage` tables. Overlapping caller skips cleanly
(`{"skipped": ...}`), unlocked in `finally`.

## Gating conditions per read path (when the live fallback kicks in)
- **Customers** (`get_customers`): rollup churned_cte + first_purchase_cte only when
  BOTH `customer_lifetime` AND `customer_first_purchase` are fresh (global, no params).
- **Range Mgmt** (`range_mgmt_classify`): rollup `rm_style` only when `not channel`
  (rollup has no channel dim) and fresh; country re-agg via `_rollup_country_where`.
- **Product Analysis** (`analytics_product_analysis`): rollup `pa_style` only when
  `not sel_dims and not pos_exploded and not store and vel==30` and fresh. period_sales
  stays live/date-bounded; lifetime/trailing come from rollup; FULL OUTER JOIN merges.

## Gotchas
- KES sums are stored **UNROUNDED** in rm_style/pa_style; `ROUND` is applied at READ
  to match the live round-of-sum. Don't pre-round in the rollup.
- `current_price` is stored with `current_price_date` (argmax); merging across
  countries picks max date. Same-date ties are inherently nondeterministic (matches
  live) — ~35/3483 styles differ, accepted.
- Direct-call smoke testing must pass explicit kwargs (NOT FastAPI `Query()` defaults).
