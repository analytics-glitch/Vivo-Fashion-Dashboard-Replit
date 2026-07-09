---
name: WIP locations excluded at ingestion
description: Unfinished-goods (sewing/finishing/trim) Odoo locations must be excluded in the inventory extract, never classified downstream.
---

# WIP locations excluded at ingestion

**Rule:** Odoo internal locations holding unfinished goods (sewing, finishing, trim — e.g. `Sew/Stock/A–E`) must never enter `all_inventory`. Exclude them in `extract_odoo_inventory.py`'s `EXCLUDED_LOCATIONS` (case-insensitive substring match), tokens `Sew/Stock`, `Sewing`, `Finishing`.

**Why:** These locations leaked past the exclusion list (~5,551 units) and `WAREHOUSE_LOCATIONS` in the API classified them as sendable warehouse stock — inflating replenishment `soh_wh` and inventory totals with garments that don't exist as sellable product yet. Business rule from the user: WIP is never product, never warehouse stock.

**How to apply:**
- The extract delete+repopulates all Kenya rows each ~5-min sync cycle, so an exclusion added there is self-healing (dev immediately; prod after publish + next sync).
- Ingestion is the choke point — do NOT try to special-case WIP inside `WAREHOUSE_LOCATIONS` (it is dual-purpose across ~123 call sites: `NOT IN` = stores, `IN` = warehouse pool). Keep WIP names listed there as defense so a stray row is at least never treated as a store.
- If a new WIP-like location appears in Odoo, add its name/alias token to `EXCLUDED_LOCATIONS`; verify with `SELECT DISTINCT pos_location_name FROM all_inventory` — only stores + `Warehouse Finished Goods` (+ Shopify/ShopZetu-owned) should remain.
