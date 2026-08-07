---
name: Retired Stock report
description: Contract for the Retired Stock tab (Product Development hub) + /api/analytics/retired-report — buckets, holding location, embedded breakdowns.
---

# Retired Stock report (Product Development hub tab)

- Tab id `retired-stock` in PA_TABS reuses `pageId: "range-mgmt"` — zero permission/nav
  changes; deep link `?tab=retired-stock`. Component: vivo-bi RetiredStockReport.jsx.
- Endpoint `GET /api/analytics/retired-report` returns `{summary, stores, styles}` where
  **each style row embeds its `store_breakdown` array**. A separate per-style drill
  endpoint was built then DELETED — it cost ~20s of full all_sales scans per row click.
  **Why:** breakdown data falls out of the master (style,store) query for free; keep it
  embedded (payload ~750KB, fine for internal BI). Don't reintroduce a drill endpoint.
- Measures: units = NET `net_quantity` (sell-through lens, SOR-report precedent, NOT the
  gross `_UNITS` headline canon); money = NET_SALES_CANON ex-VAT. SOR = 100·u/(u+soh),
  NULL when denom≤0 or u<0; window + lifetime ("since launch" = no date filter) variants.
- Universe = retired styles (shared `_ODOO_RETIRED_STYLES_SQL`, never re-derived) with
  stock OR sales in window; `styles_retired_catalog` = all retired styles for context.
  Third-party brand excluded per-SKU-row BEFORE GROUP BY style_name.
- SOH: `_retired_soh_bucket` → stores / wh ('Warehouse Finished Goods') / pipeline;
  'Finished Goods Production' returns None (excluded entirely); soh_total = stores+wh.
  `summary.styles_with_stock` predicate = soh_stores>0 OR soh_wh>0 (RM parity).
- **"Retired Stock" holding location** (Kenya, real pos_location_name; IBT/replen already
  exclude it; NOT in WAREHOUSE_LOCATIONS so platform-wide it's store stock): units stay
  inside `soh_stores` so totals reconcile with Range Management, but rows carry
  `is_holding` ⇒ no SOR%, never top_store, not in stores_with_stock counts, UI shows it
  in the "Not on a shop floor" strip, never the store table/chart.
  **How to apply:** any new surface listing retired-stock locations must honor
  `_RETIRED_HOLDING_LOCS` the same way.
- Renamed-twin dedup: `_dedup_raw_by_style_number` is shallow-copy (scalars only) — the
  per-store breakdown dicts are PRE-MERGED by a local `_twin_key()` (style_number) and
  re-attached after dedup. Any new nested field needs the same pre-merge treatment.
