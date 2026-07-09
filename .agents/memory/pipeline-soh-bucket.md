---
name: Pipeline SOH bucket
description: PIPELINE_LOCATIONS is a subset of WAREHOUSE_LOCATIONS; any endpoint splitting soh_wh must exclude pipeline or surfaces disagree.
---
PIPELINE_LOCATIONS ('Fabric Trimming', 'Finished Goods Production', 'Sew/Stock/A'–'E') is a SUBSET of WAREHOUSE_LOCATIONS — the store/non-store split is unaffected, but "warehouse" now means sellable-warehouse-only wherever `soh_pipeline` is exposed.

**Rule:** any SOH endpoint that reports `soh_wh` alongside `soh_pipeline` must compute wh as `IN WAREHOUSE_LOCATIONS AND NOT IN PIPELINE_LOCATIONS`, and `soh_total = stores + wh + pipeline`. Currently split: product-detail, sor-all-styles, sor-style-colors, style-sku-breakdown(_sku_breakdown). NOT split (pipeline still counted inside warehouse, no pipeline field — intentional, don't "fix" silently): Range Mgmt / SOR-since-launch stock CTEs (~api_pg 17290/17625), ProductAnalysis store_stock/warehouse_stock endpoint, subcategory-stock-sales, dashboard cards.

**Why:** parent SOR rows vs expanded colour/SKU rows once disagreed when only some endpoints were split (architect-caught); % In WH semantics must match across master + drilldown.

**How to apply:** production-flow labels for tooltips: Fabric Trimming → "Waiting Sewing", Sew/Stock → "Sewing", Finished Goods Production → "Finishing". Verified example: SKU S1125019PR2M = 3 store + 0 wh + 19 pipeline = 22 total.

Note: this design supersedes the earlier "WIP locations excluded at ingestion" idea for these locations — they ARE synced into all_inventory now and surfaced as the pipeline bucket (wip-locations-excluded-ingestion.md still applies only to locations truly excluded in the extract).
