---
name: Inventory page two-phase load + backend summary aggregation
description: Why the Inventory page computes headline KPIs from a compact backend summary and loads the ~50K inventory rows in a background phase.
---

# Inventory headline KPIs come from the backend summary; rows load in the background

The Inventory page's headline KPIs (total / store / warehouse units) and its two
summary charts (by-location, by-subcategory) are computed server-side by
`get_inventory_summary` (compact aggregate) and read on the frontend ONLY when no
local filters are active. When a local filter is active (search/brand/type/merch
cats/subs/style-status), the page falls back to the filter-aware client-side
aggregates over the row payload.

**Why:** the page used to roll up the ~50K-row `/inventory` payload client-side just
to show three numbers + two charts, and it blocked first paint on that fetch. The
fix splits data loading into two phases: Phase 1 (blocking) fetches only lightweight
aggregate endpoints (summary, stock-to-sales, weeks-of-cover, sell-through) so the
page is interactive fast; Phase 2 (background) fetches `/inventory` + `/top-skus`.

**How to apply:**
- The ~50K `/inventory` fetch CANNOT be removed: it still powers row-derived
  features — the low-stock-style KPI, brand/type filter pills, SKU search, the
  filter-aware client aggregates, and `/top-skus` sales overrides (the latter only
  when filters are active). Don't "optimize" it away.
- Stock-aging / phantom derive from `weeks-of-cover` (a LIGHT endpoint), NOT from the
  row payload — so they render correctly in Phase 1 and must NOT be gated on the
  background `rowsLoading` flag. The ONLY default (no-filter) section that needs
  `rowsLoading` gating is the low-stock KPI (otherwise it flashes a misleading 0).
- Country/channel global filters are applied server-side on the summary
  (`country` + `locations` params); they are intentionally excluded from the
  client-side `filtersActive` check.
- Both fetch phases call `setError` (fail-loud): a Phase-2 failure blanks the whole
  page even though Phase-1 content was renderable. This is by design (matches the
  app's no-silent-fallback principle), not a bug to "fix" silently.

## Merch subcategory taxonomy is mirrored in Python — keep in lock-step

`api_pg.py` carries `MERCH_SUBCATEGORIES` / `MERCH_SUBCATEGORIES_SQL` that mirror the
frontend `src/lib/productCategory.js` taxonomy so the backend summary merch-filters
the same set the client does. Any change to the JS taxonomy MUST be mirrored in the
Python constant or the summary and client aggregates diverge.

## Inventory country filter is case-sensitive upstream

`all_inventory.country` is stored capitalized (e.g. `Kenya`) but the frontend sends
lowercased country codes. `get_inventory_summary` uses `LOWER(i.country) IN (...)` to
match. The legacy `/inventory` row endpoint does NOT lowercase, so a single
lowercased country there returns 0 rows (pre-existing latent bug, not fixed here).
