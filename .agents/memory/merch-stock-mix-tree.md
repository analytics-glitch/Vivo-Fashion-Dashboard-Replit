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
- Style deep links use `?tab=merch-inventory&style=<exact style_number>&expanded=true`; the inventory client searches by style code, opens the ancestor path, scrolls to the style row, and reveals colourways.
- Lifecycle badges use `all_products_clean.status`: style status is Active if any SKU is Active, while each colourway computes its own status; retired/archived colourways are hidden only when the opt-in filter is turned off.
- The Stock Mix table's dedicated SOR is selected-period `units_period ÷ (units_period + stock_units)` at every node; calculate from aggregated numerator/denominator, never average child percentages.
- Fabric context is colourway-only: exact stock uses the referenced product; other-colour stock groups only nonblank `supplier_fabric_code` siblings and excludes the exact product. Never sum either into parents.
- Zero sellable SOH plus open Buying Order pipeline is "Awaiting delivery" at style/colour grain, with order age when available; it suppresses misleading recency display but not genuinely stale sellable stock warnings.

**Why:** a barcode identifies one colour product, while the supplier fabric code is the Odoo quality identity shared across its colours; blank quality codes must not create guessed families.

**How to apply:** use RMAT/Stock `available ÷ kg_per_mtr_eff` for both measures, retain exact zeroes, and deep-link valid barcodes to `/fabric?page=register&search=<barcode>`.

**Why:** SOR must reconcile from Total through Category, Subcategory, Style, and Colourway while remaining comparable to the selected-period Units Sold column.

**How to apply:** Treat missing units or SOH as unavailable (`—`); use green for ≥80%, neutral for 50–79%, amber below 50%, and red for 0% with positive SOH.

**Why:** Colourways may be retired independently of an active parent, but a retired parent with an active colourway is a source-data inconsistency that must remain visible rather than be silently corrected.

**How to apply:** Keep status at both style and colour grain in the stock-mix payload, and preserve the UI warning for retired-style/active-colour combinations.

**Why:** Style Deep Dive and Inventory & Stock Health need a deterministic two-way handoff without duplicating the stock-mix data model.

**How to apply:** Use the same query contract for future style-level navigation, and keep the reciprocal link on the expanded style row rather than on colour rows.
