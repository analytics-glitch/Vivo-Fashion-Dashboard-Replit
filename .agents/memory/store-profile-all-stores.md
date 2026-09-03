---
name: Store Profile "All Stores" mode
description: How the whole-business sentinel works across Store Profile endpoints
---
Store Profile endpoints (performance-report, kpi-trend, category-mix, weekday-weekend) accept either one store, a comma-separated multi-store scope, or the "All Stores"/"__all__" sentinel.

Rules:
- Sales predicate becomes TRUE (whole business, all channels incl. Online).
- Inventory predicate becomes `_SP_ALL_INV_PRED` (excludes warehouse/holding/transit/receiving — shelf stock across stores only).
- Footfall predicate drops the store equality but keeps `ff_store_master_predicate()`.
- Revenue target = SUM over `DISTINCT ON (name)` per-store targets_monthly rows, manual source preferred per store.
- Multi-store mode uses `IN (...)` for sales, canonical footfall names, and inventory; its revenue target sums only the selected stores. It remains distinct from All Stores, which includes the whole business.
- **Footfall quality gate must scale**: in all-mode or multi-store mode `total_days` = days × stores, so `ff_ok` compares `zero_days <= 0.25 * total_days` (row count), NOT calendar days — otherwise aggregate footfall/conversion is silently nulled.

**How to apply:** any new store-scoped Store Profile query must use the shared scope builders/sp_sales/sp_ff/sp_inv variables, not a hardcoded equality, or multi-store and All-Stores modes silently return zero/mismatched data.
