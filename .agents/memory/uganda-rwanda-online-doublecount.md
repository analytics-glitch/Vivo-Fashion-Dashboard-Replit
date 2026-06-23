---
name: Uganda/Rwanda channel='Online' double-count
description: Why dev can show ~2x Uganda/Rwanda sales vs prod, and the cross-pipeline mechanism behind it.
---

# Uganda/Rwanda double-count (dev shows ~2× prod)

Symptom: Overview "Country split" / Targets show Uganda & Rwanda at roughly **double**
the production figures (e.g. dev Uganda ~73M vs prod ~36.65M YTD), while Kenya matches.
No row-level duplication is detectable by the usual grain
(order_id, variant_sku, day, sale_kind, line_item_id) because the two copies differ in
`line_item_id`/`channel`. Detect it instead with: same `order_name` appearing under BOTH
`channel='Online'` AND `channel=<POS location>`, and `online_tag ≈ pos_tag` every month.

## Mechanism (two writers, two formats, no cross-dedup)
Uganda/Rwanda Shopify retail orders get written to `all_sales` by **two** pipelines in
**incompatible** row formats, so they don't dedupe against each other:

- **Copy A — `transform_shopify`** (full rebuild, source `shopify_sales`): proper retail
  rows — `line_item_id` present, `purchase_option='pos'`, `sale_line_type='product'`,
  `channel = <POS location>` (e.g. "Vivo Acacia"), id = `md5(line_item_id|order_id|day|title)`.
- **Copy B — `sync_incremental.py`** (live sync): aggregate rows — `line_item_id` NULL,
  `purchase_option`/`sale_line_type` NULL, and **`channel='Online'`** because of the line
  `"POS" if (store_id=='vivowoman' and pos_location!='vivowoman') else "Online"` — i.e. it
  hard-labels every non-vivowoman store (vivo-uganda/vivo-rwanda) as Online (a semantic
  mislabel: these are physical POS stores, not online).

Steady state is actually single-copy: the sync does `DELETE FROM all_sales WHERE store_id=? AND order_id=ANY(window)` before insert, so it removes Copy A for orders it touches.
**The double appears only when a full rebuild OVERLAPS the live sync**: the rebuild
re-inserts Copy A (via `ON CONFLICT (id,store_id)`, a different key) for orders the sync had
already converted to Copy B, leaving BOTH. Production never runs the full rebuild and its
`shopify_sales` is empty, so prod has Copy B only = the single correct figure.

## Fix
- **One-time dev correction (lossless):** delete Copy B only where a Copy A exists for the
  same (store_id, order_name): `line_item_id IS NULL AND channel='Online' AND EXISTS(retail row)`.
  Keep Copy-B-only recent orders (full extract lags a few days) — they refill via sync.
- **Prevent recurrence:** never run `transform_all_sales` while the Sync Watchdog is live
  (same rule as the ShopZetu netting note). Normal sync alone never re-doubles.
- **Open code bug (prod-affecting, confirm before applying):** `sync_incremental` channel
  mapping should not label vivo-uganda/vivo-rwanda POS sales as `channel='Online'`; fixing it
  also makes Copy B's channel match Copy A. Changes prod channel breakdowns (Uganda/Rwanda
  move out of "Online"), so totals unaffected but get user sign-off.
