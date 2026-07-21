---
name: Pipeline SOH bucket
description: soh_warehouse = 'Finished Goods Production' ONLY; everything else in WAREHOUSE_LOCATIONS is pipeline. Total SOH = stores + warehouse (pipeline always excluded).
---

## Rule (user-mandated)

The 3-way SOH split across **every** SOH surface in the dashboard:

| Bucket | SQL predicate |
|---|---|
| `soh_stores` | `pos_location_name NOT IN (WAREHOUSE_LOCATIONS)` |
| `soh_warehouse` | `pos_location_name = 'Finished Goods Production'` ONLY |
| `soh_pipeline` | `pos_location_name IN (WAREHOUSE_LOCATIONS) AND pos_location_name <> 'Finished Goods Production'` |

**Total SOH = Stores + Warehouse only. Pipeline is ALWAYS excluded from the total** (not sellable stock).

`WH_DISPATCH_LOCATION = "'Finished Goods Production'"` is the named constant in `api_pg.py`. `PIPELINE_LOCATIONS` is kept for reference but is no longer used in SQL.

"Finished Goods Production" = dispatch-ready finished garments awaiting store allocation. Everything else that was previously called "warehouse" (Warehouse Finished Goods, Warehouse Receiving, In Transit, Holding Warehouse Finished Goods, Buying & Merchandise, Raw Materials, Fabric Trimming, Sew/Stock, etc.) is **pipeline** — WIP, in-transit, or holding areas not ready for replenishment.

**Why:** the older mapping (`soh_warehouse = IN WAREHOUSE_LOCATIONS AND NOT IN PIPELINE_LOCATIONS`) incorrectly treated non-FGP locations like "Warehouse Finished Goods" as sellable warehouse stock. The user confirmed only "Finished Goods Production" is dispatch-ready stock.

## How to apply

When adding any new SOH surface:
1. Warehouse CTE/FILTER: `WHERE pos_location_name = 'Finished Goods Production'`
2. Pipeline CTE/FILTER: `WHERE pos_location_name IN (WAREHOUSE_LOCATIONS) AND pos_location_name <> 'Finished Goods Production'`
3. Never add pipeline into totals or replenishment eligibility (`soh_wh > 0` gate uses FGP only).

Gotcha from prior sessions: adding a CTE field without threading it through the OUTER SELECT (FULL OUTER JOIN queries) KeyErrors at runtime while compile passes.
