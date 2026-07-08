---
name: Style-row endpoints must group by style_name only
description: top-skus / SOR / velocity style tables split rows when dims are in the GROUP BY
---
Rule: endpoints returning one row per style (`/api/top-skus`, `/api/sor`, `/api/analytics/velocity` sales CTE) must `GROUP BY p.style_name` ONLY, projecting `MAX(collection/brand/product_type)` for display.

**Why:** styles legitimately span multiple collections AND product_types in `all_products_clean` (e.g. one poncho mapped to "Sweaters & Ponchos" and "Scarves"); any dim in the grain silently splits the style's units across rows, so page totals drift vs Velocity/Overview (the 458+19 vs 477 Poncho bug).

**How to apply:** when adding a style-level breakdown, keep dims out of GROUP BY; if a dim FILTER is needed, apply it per-SKU-row before aggregation (see style-universe-brand-filter-grain.md). A regression test asserts one row per style (test_size_curve_no_size_data.TestSorStyleGrain).
