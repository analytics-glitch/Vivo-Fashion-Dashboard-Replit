---
name: Pipeline SOH bucket
description: PIPELINE_LOCATIONS is a subset of WAREHOUSE_LOCATIONS; Total SOH = stores + sellable warehouse ONLY (pipeline always excluded) on every SOH surface.
---
PIPELINE_LOCATIONS ('Fabric Trimming', 'Finished Goods Production', 'Sew/Stock/A'–'E') is a SUBSET of WAREHOUSE_LOCATIONS — the store/non-store split is unaffected, but "warehouse" means sellable-warehouse-only wherever `soh_pipeline` is exposed.

**Rule (user-confirmed, supersedes the earlier `total = stores + wh + pipeline` wording):** every SOH surface shows the 3 buckets separately — Stores / Warehouse Finished Goods (sellable, = `IN WAREHOUSE_LOCATIONS AND NOT IN PIPELINE_LOCATIONS`) / Pipeline — and **Total SOH = Stores + Warehouse only; pipeline is ALWAYS excluded from the total** (not sellable stock).

Split surfaces (backend + web): product-detail, sor-all-styles, sor-style-colors, style-sku-breakdown, Product Analysis (pipeline_stock), Range Mgmt classify + weekly-sor (soh_pipeline), products-plan (pipeline_soh), exec-summary stock mix (stock_units_pipeline / total_stock_units_pipeline; its "stock_units" = wh+stores), Inventory page (frontend classifier `isPipelineLocation` checked BEFORE `isWarehouseLocation`; headline Total = store+wh, NOT the backend total_units which still includes pipeline). Intentionally untouched: replenishment/IBT ops engines.

**Why:** pipeline garments are WIP and cannot be sold; counting them inflated sellable SOH and made surfaces disagree; user confirmed "Total SOH should always only include Warehouse Finished Goods and Stores".

**How to apply:** when adding a new SOH surface, compute wh with the NOT IN PIPELINE filter, expose the pipeline bucket separately, and never add it into the total. Gotcha: adding a CTE field without threading it through the OUTER SELECT (FULL OUTER JOIN queries) KeyErrors at runtime while compile passes. Tooltip labels: Fabric Trimming → "Waiting Sewing", Sew/Stock → "Sewing", Finished Goods Production → "Finishing".

Note: this design supersedes the earlier "WIP locations excluded at ingestion" idea for these locations — they ARE synced into all_inventory now and surfaced as the pipeline bucket (wip-locations-excluded-ingestion.md still applies only to locations truly excluded in the extract).
