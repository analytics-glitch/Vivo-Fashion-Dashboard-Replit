---
name: Merch Hub rollup fast-path
description: Architecture of the _fetch_styles fast path — rollup + watermark-incremental + SWR + status fallback rules.
---

# Merch Hub rollup fast-path

## Rule
`_fetch_styles(A=not None, status=None)` → `_fetch_styles_fast_path` → rollup + watermark-incremental.
`_fetch_styles(status="active"|"retired")` → always falls back to `_fetch_styles_sql` (original monolithic SQL).

**Why:** The SQL `status` filter is inside the `prod` CTE BEFORE GROUP BY, so it changes
aggregated `standard_cost_kes`, `full_price`, `colour_count` for styles with mixed active/retired SKUs.
Python post-filtering of the full-SKU core rowset cannot reproduce this without rerunning the SQL.

## Core cache (`merch_core|{country}|{pos_location}`)
- TTL 600s, SWR grace 600s, backed by `_core_swr_get_or_compute`.
- Populated by `_fetch_styles_core_sql`: reads `rollup_merch_style_day` + `rollup_merch_first_sale`
  (rollup path when `_rollup_fresh("merch_style_day", min_schema=3)`) OR live SQL fallback.
- Rollup path adds `incr_sales` CTE (`WHERE s.loaded_at > %(wm)s`) and `combined_sales = rollup UNION ALL incr`
  so the result is always current to the moment of the query.
- One core cache entry serves ALL brand/subcategory/tier/date-window combinations via Python narrowing.

## Period overlay (`merch_overlay|{from}|{to}|{country}|{pos}`)
- Only called when user picks a non-default date window.
- Also uses `combined_sales` (rollup + incremental) pattern for freshness.
- Cached 600s via `_cached`.

## Rollup schema ver 3 tables
- `rollup_merch_style_day` PK (style_name, sale_day, country, pos_location_name)
- `rollup_merch_first_sale` PK (style_name)
- Both added to `_rollup_defs()` and `_lazy_rollup_ddl` in api_pg.py.
- Built by `python3 build_sales_rollups.py merch_style_day merch_first_sale --force`.

## Prewarm
- `("merch-core", lambda: merch_router._styles_cached(...all None...))` in `_start_cache_prewarmer`.
- Warms the default (no-filter) combination which is also the base for Python narrowing.

## Performance (measured)
- Original SQL: ~25s
- Fast path cold (rollup + incremental + prod/stock/colour CTEs): ~7s
- Fast path warm (SWR cache hit): ~0.02s
- Date preset switch (core cached, overlay only): 0.3–0.6s

## How to apply
- Any new aggregation on the merch page that reads all_sales: add it to `rollup_merch_style_day`
  (bump `_ROLLUP_SCHEMA_VER`, add DDL, rebuild) OR add a separate rollup + the incremental pattern.
- The status-filter fallback is intentional — do not try to replicate status SQL filtering in Python.
- `_fetch_styles_sql` (original) is kept unchanged for tests (called with `A=None`).
