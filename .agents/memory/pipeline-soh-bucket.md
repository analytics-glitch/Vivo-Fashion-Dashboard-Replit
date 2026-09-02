---
name: Sellable and pipeline stock buckets
description: Sellable warehouse is Warehouse Finished Goods; Stock Mix uses an explicit retail allowlist, and Buying Order pipeline is always separate.
---

## Rule (user-mandated)

The current finished-goods split is:

| Bucket | SQL predicate |
|---|---|
| `soh_stores` | explicit known retail locations (Vivo, Zoya, Safari, Oasis, Shop Zetu) |
| `soh_warehouse` | `pos_location_name = 'Warehouse Finished Goods'` ONLY |
| Buying Order pipeline | committed units in open `production_orders`, broken down by `bo_state` |

**Total SOH = Stores + Warehouse only. Pipeline is ALWAYS excluded from the total** (not sellable stock).

`WH_DISPATCH_LOCATION = "'Warehouse Finished Goods'"` is the named constant in `api_pg.py`.

"Warehouse Finished Goods" is dispatch-ready stock. Finished Goods Production,
Warehouse Receiving, In Transit, holding, raw materials, Fabric Trimming,
Sew/Stock, samples, QC/defects and unknown locations are not sellable.

**Why:** exclusion-list logic classified new or raw Odoo locations as stores. An
explicit retail allowlist plus exact warehouse predicate fails closed, and a
separate Buying Order query cannot multiply sellable inventory.

## How to apply

When adding any new SOH surface:
1. Warehouse CTE/FILTER: exact `Warehouse Finished Goods`.
2. Prefer an explicit retail allowlist over `NOT IN (WAREHOUSE_LOCATIONS)`.
3. Query Buying Order pipeline independently by state.
4. Never add pipeline into SOH, WOC, SOR, or replenishment eligibility.

Gotcha from prior sessions: adding a CTE field without threading it through the OUTER SELECT (FULL OUTER JOIN queries) KeyErrors at runtime while compile passes.
