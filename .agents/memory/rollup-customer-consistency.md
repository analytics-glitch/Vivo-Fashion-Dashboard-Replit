---
name: Rollup customer consistency rules
description: Five invariants for keeping customer new/returning counts consistent across all dashboard surfaces.
---

# Rollup customer consistency rules

## The rules (all five must hold together)

**1. ROLLUP_MAX_AGE_SEC = 2h (7200s), not 25h.**
The rollup refreshes hourly. A 25h staleness window lets a failed sync or a REBUILD_ON_BOOT serve wrong new/returning classifications all day before falling back to live. 2h = one cycle + margin.

**2. After REBUILD_ON_BOOT, run `build_sales_rollups.py` immediately.**
watchdog.py's `run_full_rebuild()` rebuilds `all_sales` but doesn't touch the rollup. Without an explicit post-rebuild rollup run, exec-summary reads pre-rebuild first-purchase dates applied to new data → misclassifies returners as new for up to an hour.

**3. Stale rollup fallback must use `_unified_first_purchase_ctes()`, not raw `MIN(sale_date)`.**
`_unified_first_purchase_ctes()` bridges post-2026-03-20 Odoo IDs onto their legacy Shopify IDs (Kenya system switch). The old `MIN(sale_date)` fallback in `_es_customer_windows` lacked this bridge, so returning Kenya shoppers who reappeared under a new Odoo ID after the cutover were mislabelled "New" whenever the rollup was stale.

**4. All customer-count surfaces must exclude pseudo-accounts via `_WALKIN_PSEUDO_COND` (name + email regex).**
- `/api/exec-summary` → `_es_customer_windows` now adds `_not_walkin_pseudo_sql("s")` to its `pc` CTE WHERE.
- `/api/kpis/customer-type-split` → Walk-in CASE now uses `_WALKIN_PSEUDO_COND` (name + email), not just the `walk[- ]?in` name-only regex that missed email-domain pseudo accounts.
- `/api/customers` → already used `_not_walkin_pseudo_sql`.

**5. New/returning classification must always use `_unified_first_purchase_ctes()` or `rollup_customer_first_purchase` (which is built from it).**
Raw `MIN(sale_date)` GROUP BY customer_id is WRONG for new/returning; it misses the Kenya ID bridge.
Exception: `first_order_date` in `/api/analytics/repeat-customers` is intentionally the first order *in the requested window*, not the first-ever purchase — that MIN(sale_date) is correct and should not be replaced.

## Why: the prod LY baseline divergence
After an OOM crash + REBUILD_ON_BOOT on prod, the LY customer totals on exec-summary (e.g. YTD LY Total 34,276) were ~10% below the dev DB equivalent (37,997). Root causes: (a) rollup not rebuilt after all_sales rebuild, (b) stale fallback CTE used different bridge logic, (c) pseudo accounts included. The fixes above eliminate all three sources of divergence.

## How to apply
- Any new endpoint that shows customer counts or new/returning splits must use `_unified_first_purchase_ctes()` or the rollup, and must call `_not_walkin_pseudo_sql` or filter against `_WALKIN_PSEUDO_COND`.
- The rollup build is always `run_sales_rollup_refresh()` (via `build_sales_rollups.py`). Never bypass it with a bespoke `MIN(sale_date)` query.
