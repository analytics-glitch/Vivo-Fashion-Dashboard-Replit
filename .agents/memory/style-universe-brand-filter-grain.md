---
name: Style-universe third-party filter must be SKU-row-level, not MAX(brand)
description: Why Product Analysis and Range Management must both exclude third-party brand BEFORE GROUP BY style_name; post-aggregation MAX(brand) silently diverges on mixed-brand styles.
---

# Third-party brand exclusion must be applied at the SKU row, before GROUP BY

`/api/analytics/product-analysis` (PA) and `/api/range-mgmt/classify` (RM) both
define the same "styles that currently hold inventory" universe, and the
cross-surface check `xsurf_pa_vs_rm_total` enforces
`PA.summary.styles == len(RM.rows) + len(RM.retired_rows)`.

**The rule:** exclude `brand ILIKE '%third party%'` in the `prod` CTE `WHERE`
(per `all_products_clean` SKU row, BEFORE `GROUP BY style_name`) — NOT as a
post-aggregation filter on `MAX(brand)`. A style is third-party only when ALL its
SKUs are; a style with any owned SKU survives with a non-third-party `MAX(brand)`.

**Why:** RM used to filter on the aggregated `MAX(brand)` in the final WHERE.
`MAX(brand)` is lexicographic, so a style with MIXED SKU-level brand tags
(some "Third Party", some owned) was dropped whenever "Third Party" happened to
be its largest brand string — but PA's row-level filter kept it. That made PA
count higher than RM (prod: 1176 vs 1164, a 12-style gap). Dev never reproduced
it because dev `all_products_clean` had NO mixed-brand styles — this is a
prod-data-state divergence (prod is a separate DB), invisible to a dev rebuild.

**How to apply:** any style-universe surface on these two pages must apply the
third-party exclusion per-row in its `prod` CTE. Don't reintroduce a
`MAX(brand)`-only filter. The other parts of the two universes are already
algebraically identical: PA's `soh_current` equals `soh_stores` in the default
(no store, `include_warehouse=False`) case, so PA's
`soh_current>0 OR soh_warehouse>0 OR soh_stores>0` == RM's
`soh_stores>0 OR soh_warehouse>0`; and RM appends every raw row to exactly one of
active/retired so `rows+retired_rows` == universe size. The general lesson:
**a row-level vs aggregate-level filter on the same column is only equivalent when
the column is constant within the group** — verify that before assuming two
"identical" universe queries agree on all data.
