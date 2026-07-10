---
name: Odoo rebuild dedup dropped NULL-SKU lines
description: Why transform_odoo silently lost sales value, the line-id fix, and the safe raw-refresh + rebuild procedure.
---

# Odoo rebuild must dedup by unique line id, never by (order, day, sku)

`transform_all_sales.transform_odoo` deduped raw Odoo lines with
`ROW_NUMBER() OVER (PARTITION BY o.id, DATE(o.date_order), p.default_code ...)`
then dropped `rn != 1`. This **silently lost sales value**: when `raw_odoo_products`
is incomplete, the LEFT JOIN leaves `default_code` NULL on thousands of lines, and
Postgres window partitioning treats **all NULLs as one group** — so every NULL-SKU
line in an order after the first was thrown away. It removed **zero real duplicates**
(`true_dup_lines = 0` partitioning by `l.id`), i.e. pure loss (~1.6M gross over
Mar–Jun 2026; Kenya net was ~900K under BigQuery, dominated by this).

**Fix:** `PARTITION BY l.id` (the unique order-line id). Distinct lines are never
merged; latest `_synced_at` still wins for any true re-sync dup.

**Why:** the dedup intent was to drop re-synced duplicate lines, but raw line ids
are already unique, so the (order,day,sku) key only ever collapsed legitimate
distinct lines — catastrophically so for NULL/duplicate SKUs.

## Two Odoo paths must stay consistent (cf. shopzetu netting)
- Rebuild: `raw_odoo_pos_order_lines/orders/products` → `transform_odoo` → `all_sales`.
- Live: `sync_incremental.sync_odoo` writes `all_sales` directly and writes **every
  line with no dedup** (DELETE-by-order_id + reinsert). So only the rebuild path
  ever had this bug; after any rebuild it overwrites live rows, re-introducing loss
  until fixed.

## Root contributor: stale/incomplete raw_odoo_products
`default_code` NULLs come from products missing in `raw_odoo_products`
(`extract_odoo_products.py` TRUNCATEs + full-reloads). Refresh it before a rebuild
so SKUs/categories are correct; the `l.id` dedup makes value correct regardless.

## Scoped Odoo-only re-transform (lighter than a full rebuild)
For an Odoo-path-only data fix (e.g. the VAT-as-discount taint), DELETE
`store_id='vivofashiongroup'` + re-run `transform_odoo` in ONE transaction
(`rebuild_odoo_discounts.py` pattern) — bulk_insert's ON CONFLICT does NOT
update `discounts_kes`, so a plain re-run cannot heal rows in place.
**Trap:** raw headers upserted by the live sync have `state` NULL (the sync's
header upsert omits it), so the transform's `o.state IN (...)` filter silently
drops orders first seen by the sync — today's sales vanish. Either run
`extract_odoo_orders.py` first, or accept it and let the restored sync loop
self-heal recent days (verify the day totals recover before finishing).

## Safe full-clean rebuild procedure (no doubling, no June regression)
1. Idle the watchdog: `configureWorkflow("Sync Watchdog", "<idle loop>")` (running it
   during a rebuild doubles history — non-colliding ids, no PK guard).
2. Refresh raw foreground (background `&` from the bash tool gets killed when the call
   returns): `extract_odoo_products.py` (full), then `extract_odoo_orders.py`
   (incremental; raw orders lag the live sync, so rebuild-from-raw regresses recent
   days unless refreshed first).
3. One rebuild only — run as the `Rebuild all_sales` workflow (not bash `&`); poll
   `getWorkflowStatus` + `all_sales` counts. Shopify transform is the long phase.
4. Restore watchdog: `configureWorkflow("Sync Watchdog",
   "WATCHDOG_MANAGE_API=0 python3 /home/runner/workspace/watchdog.py")`. It
   self-heals recent days via its LEAST(loaded_at, sale_date) watermark.
