---
name: Sales by Hour data sources
description: Where hour-of-day sales data lives, the cutover split, and the raw_shopify_orders.total_price=0 trap.
---

# Sales by Hour (hourly intraday sales)

`all_sales.sale_date` is DATE-only, so any hour-of-day analysis must read raw order headers, split by era to avoid double counting:

- **Kenya POS since 2026-03-20 (cutover)**: `raw_odoo_pos_orders.date_order` — UTC text, add 3h for EAT. Filter states NULL/done/paid/invoiced; exclude the `Shopzetu Online` config. Channel (pos_location_name) maps to `config_name` via `odoo_locations.ODOO_LOCATION_MAP`.
- **Shopify retail** (Uganda/Rwanda always; Kenya `vivowoman` strictly BEFORE the cutover): `raw_shopify_orders.created_at` — ISO with store-local offset, parse the local wall-clock hour directly.

**Trap: `raw_shopify_orders.total_price` is 0.0 on every row** (the historical extract never populated it). Order value must come from joining line-level `all_sales` (`l.order_id = o.id AND l.store_id = o.store_id`, `sale_kind='order'`, `total_sales_kes` already KES) — ~100% coverage across full history.

**Trap 2: never join `shopify_sales` for order value.** That table is populated ONLY by the one-time `shopify_full_extract` and freezes at its `target_end` (Uganda/Rwanda stopped at 2026-06-13); an inner join silently drops all recent days ("Rwanda/Uganda show no hourly sales"). `all_sales` is the sync-fresh source.

**Why:** the first endpoint version read header total_price and showed orders with 0 KES for the whole Shopify era.

**How to apply:** any new intraday/hourly surface must reuse this source split and the all_sales value join; `sync_incremental.py` upserts both header tables each cycle (no extra API calls) so the data stays fresh in dev AND prod. Online (`raw_shopify_vendor_sales`) is daily-grain — exclude it and say so in the UI.

**Env-free constants rule:** `api_pg.py` must NEVER `import sync_incremental` (module-level `os.environ[...]` for SHOPIFY_* secrets crashes an API process without them; a try/except fallback silently breaks channel filtering instead). Shared constants like `ODOO_LOCATION_MAP` live in the tiny env-free `odoo_locations.py`, imported top-level by both.
