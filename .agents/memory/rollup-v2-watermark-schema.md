---
name: Rollup v2 — watermark skip, schema_ver gating, store×style grain
description: How the sales rollup framework skips no-op rebuilds, how readers gate on schema version, the all-filter-combos store×style rollup, and tie-order lessons from the cutover parity work.
---

## Watermark skip (hourly rebuild)
`run_sales_rollup_refresh(only=None, force=False)` captures `MAX(all_sales.loaded_at)` + `COUNT(all_products_clean)` + `CURRENT_DATE` BEFORE building and stamps them into `rollup_meta` (source_watermark, source_products, built_on, schema_ver) per table. On the next call, if ALL in-scope rollups match the current values (and row_count>0 and schema_ver == `_ROLLUP_SCHEMA_VER`), it only bumps refreshed_at and returns `{"skipped": ...}`.
**Why:** the hourly rebuild re-scanned whole history ~24×/day even when nothing had changed, and was a top contention source in the slow-query log.
**How to apply:** `build_sales_rollups.py --force` bypasses the skip. CURRENT_DATE is part of the watermark because window aggregates (28d/56d/182d/365d) shift at midnight even with no new rows.

## schema_ver gating for new columns
`_rollup_fresh(name, min_schema=N)` returns False when rollup_meta.schema_ver < N. Readers that need columns added in vN must pass min_schema=N so they fall back to live SQL until the first new-code build. Bump `_ROLLUP_SCHEMA_VER` whenever a def gains columns. Columns are ALWAYS appended LAST in both the def SELECT and the DDL/ALTERs — stage builds are positional (`CREATE stage LIKE table` + `INSERT SELECT`).
**Trap:** adding a column mid-task without rebuilding leaves "vN rows" missing the column — rebuild dev immediately; prod only ever builds from final code.

## rollup_store_style_sales serves ALL filter combos
Grain: (style_name, pos_location_name, country, has_style bool, base bool) over a 56d window with units_net_28d/30d, net_sales_28d, units_gross_28d, units_gross_2956d, rows_28d. Because BASE_FILTERS is materialized as the `base` flag and country/channel are grain dims, readers apply ANY country/channel filter to the rollup (`WHERE r.base` + `_style_filters(..., "r")`) — unlike the default-only rollups. Used by IBT sv CTE, warehouse→store, store-overstock vel, declining-styles.
- `has_style` mirrors live `p.style_name IS NOT NULL` (includes ''-style); use it, not `style<>''`.
- IBT sv reader needs `HAVING SUM(r.rows_28d) > 0` for row-existence parity (NULL-vs-0 matters through FULL OUTER JOIN + stats downstream).

## Velmap country branch asymmetry (intentional)
`_ibt_store_sku_velocity`: the DEFAULT read keeps the historical all-cells rollup behaviour (every cell that EVER sold; dead cells get the category prior) — that IS shipped production output. The COUNTRY branch must reproduce the LIVE 56d CTE exactly (what country requests returned pre-cutover), so it filters `rows_56d > 0` (v2 existence marker; a 0-unit SUM from netted returns still counts as an existing live cell — row count, not units<>0).

## Tie-order lessons from parity testing
- Greedy allocators (IBT solve) are ORDER-SENSITIVE: equal-score edges processed in SQL-plan order regroup bundles/markdowns when the plan changes. Edge SQL needs a TOTAL ORDER BY (score, style, sku, from_store, to_store). Same for LIMIT slices over tie-prone keys (w2s: `ORDER BY suggested_qty DESC, style_name, to_store`).
- classify's rows/retired_rows have NO order guarantee (plan-dependent today) — parity there is per-section SET equality, not byte order.
- Parity harnesses must unify int/Decimal/float (48 == 48.0) or every SUM(int)-vs-SUM(numeric) branch pair false-fails, and must isolate one rollup per case (patch `_rollup_fresh` per name) or pre-existing rollup branches contaminate the diff.

Soak baseline for the 2026-08-04 cutover: `soak_baseline_task1134.md` (workspace root).
