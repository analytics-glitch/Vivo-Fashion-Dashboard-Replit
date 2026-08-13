---
name: Merch stock-mix drill-down tree
description: Consistency contract between /api/merch/stock-mix and the Inventory tab's Total Stock Units KPI; where dims come from; client-side share derivation.
---

# Merch Stock Mix tree (Inventory & Stock Health tab)

**Rule:** the stock CTE inside `_fetch_stock_mix` must mirror `_fetch_styles`' stock scoping *exactly* — same warehouse location name, pos_location filter forcing warehouse→0, `country_inv_where` placement, third-party-brand exclusion applied per SKU **before** grouping, and the same product-universe INNER JOIN. The tree's grand total then equals the tab's Total Stock Units KPI by construction (verified exact under default/country/store/brand/date filters).

**Why:** the visible reconciliation (tree totals row == KPI card) is a stated contract of the feature; any predicate drift between the two queries breaks an equality users can see on one screen.

**How to apply:** any edit to `_fetch_styles`' stock predicates (locations, holding stores, pipeline buckets…) must be mirrored in `_fetch_stock_mix`, and vice versa.

Other fixed choices:
- Dims come from the product master only: mode() category/product_type per style (style resolves to ONE branch, never splits), per-SKU mode `color_print` for colour — never inventory's colour column.
- Blank category/subcategory → "Uncategorised" (same plain-`or` bucketing as by-subcategory), blank colour → "Unspecified".
- % of Stock / % of Sales / Gap are derived **client-side** from `totals` (fabric-page pattern) so rows and totals always agree; gap = %stock − %sales, positive = overstock, ±3pp chip thresholds.
- WOC keeps the tab's trailing-6-month ÷ 26 basis; parents retain pruned children's 6m units in denominators.
- Full inline tree (~1MB raw, ~120KB gzipped) is fine — no lazy colour loading needed.
- "% of Units Sold" is DUAL-semantic: share-of-total on category/sub/Total rows, period SOR (units ÷ (units + SOH), clamped 0–100, null→dash) on style/colour rows; Gap stays share-based at every level.
- Last-order dates: style = textual PO match (style_number/style_name, reorder-counts pattern); colour = variant-SKU→product-master match + normalised colour-name fallback. The SKU match out-covers the textual one, so colour dates roll UP into the style date at assembly (ISO strings max) — a style must never show "—" while its own colour shows a date.
- Every colour node carries `rep_sku` (highest-stock SKU) for thumbnails + the right-click detail popup; all three new fields are nullable and the frontend dash-guards them (cached old-shape payloads).
