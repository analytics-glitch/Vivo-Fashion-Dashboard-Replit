---
name: Warehouse Returns aged stock is per-(store,sku)
description: "Aged / dead-stock-in-store" must compute last-sale per (store, sku), never globally per sku.
---

# "Aged in store" must be a STORE-LEVEL last-sale, not a global one

For any "this item is stuck in THIS store / hasn't sold here in N days" feature
(e.g. the Warehouse Returns page `/api/analytics/warehouse-return-candidates`
mode=aged), the `last_sale` CTE must `GROUP BY pos_location_name, variant_sku`
and the inventory join must match on **both** location AND sku
(`ON i.sku = ls.sku AND i.pos_location_name = ls.pos_location`).

**Why:** if you group `last_sale` by `variant_sku` alone and join by sku only, a
recent sale of that SKU in *any* store sets the "last sold" for *every* store's
row. A SKU dead for months in Store B is then suppressed because Store A sold it
yesterday — the exact opposite of the requirement. `days_since_last_sale` and
the aged threshold filter both become wrong.

**How to apply:** store-level grain for `last_sold` + `units_180` (units sold at
that store). `style_sales`/retired logic stays company-wide on purpose (a style
is retired chain-wide, not per store). Proof check: pick a SKU sold recently in
one store but stale in another; aged mode must return only the stale store's row.

**Note:** the older `/api/analytics/aged-stock` endpoint (AgedStockReport) still
uses the global-per-sku grain despite its "at that store" docstring — a known
inconsistency. Don't copy its CTE blindly for store-stuck logic.
