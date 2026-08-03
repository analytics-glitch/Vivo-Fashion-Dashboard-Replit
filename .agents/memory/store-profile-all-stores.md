---
name: Store Profile "All Stores" mode
description: How the whole-business sentinel works across Store Profile endpoints
---
Store Profile endpoints (performance-report, kpi-trend, category-mix, weekday-weekend) accept a sentinel store "All Stores"/"__all__" via `_sp_all_stores()`.

Rules:
- Sales predicate becomes TRUE (whole business, all channels incl. Online).
- Inventory predicate becomes `_SP_ALL_INV_PRED` (excludes warehouse/holding/transit/receiving — shelf stock across stores only).
- Footfall predicate drops the store equality but keeps `ff_store_master_predicate()`.
- Revenue target = SUM over `DISTINCT ON (name)` per-store targets_monthly rows, manual source preferred per store.
- **Footfall quality gate must scale**: in all-mode `total_days` = days × stores, so `ff_ok` compares `zero_days <= 0.25 * total_days` (row count), NOT calendar days — otherwise whole-business footfall/conversion is silently nulled.

**How to apply:** any new store-scoped Store Profile query must use the sp_sales/sp_ff/sp_inv variables, not a hardcoded `pos_location_name = '{store_s}'`, or All-Stores mode silently returns zero/mismatched data.
