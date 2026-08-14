---
name: Inventory must be pre-aggregated before joining sales
description: Why every all_inventory aggregation in api_pg.py lives in its own CTE/subquery keyed by sku (or style/location) before touching all_sales.
---

# Inventory pre-aggregation invariant (api_pg.py)

**Rule:** Never join raw `all_inventory` directly to raw `all_sales` and then `SUM` an inventory column (`available`/`on_hand`). `all_inventory` has many rows per SKU (one per location/bin) and `all_sales` has many rows per SKU (one per transaction line); a direct join fans out inventory by the number of matching sale rows.

**Why:** A naive `all_inventory i JOIN all_sales s ON s.variant_sku = i.sku` + `SUM(i.available)` over the live data inflates store-available units by ~34× (measured: 43.5M vs the true 1.28M). The original author already avoided this everywhere.

**How it's done (audited, all paths already correct):**
- Inventory is aggregated in its own CTE/subquery (`SUM(i.available) ... GROUP BY sku` or `... GROUP BY style/location`) and only then FULL/LEFT JOINed to the sales aggregate on the shared key. Examples: replenishment, markdown-candidates, stockout alerts/snapshot, store-clusters/IBT, lifecycle, buying plan-summary, custom report builder, size-health.
- `/api/sor` and `/api/analytics/sor-all-styles` keep `all_sales` as the base but pull stock from a style-aggregated subquery and read it with `COALESCE(MAX(i.current_stock),0)` (MAX, not SUM) so the per-style constant isn't summed across fanned-out sale rows.
- Aged-stock/velocity uses `all_inventory` as the base and joins sales pre-aggregated per-SKU CTEs (`last_sale`, `wh`), reading them via `MAX(...)`.
- Some endpoints query sales and inventory as two separate `run_query` calls and merge in Python.

**Verification:** `rg` for `i.sku = s.variant_sku` / `s.variant_sku = i.sku` returns zero hits — inventory only ever joins `all_products_clean` (1:1-ish on sku). If you add an endpoint, keep inventory in its own pre-aggregated CTE.

**Extension (catalogue-side fan-out):** the same trap exists joining inventory to the product catalogue — "1:1-ish" is not 1:1: duplicate catalogue rows for one SKU multiply even a pre-aggregated per-SKU inventory CTE once you SUM to style/colour grain. De-duplicate the catalogue side to one row per SKU before joining the inventory CTE.
