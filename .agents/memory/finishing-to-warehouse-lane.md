---
name: Finishing→Warehouse transfer lane
description: How FGPRD→WHFIN daily receipts are extracted, stored, reported, and kept out of store-flow metrics
---
- The transfers extract fetches a third Odoo domain: FGPRD/Stock (id 1757) → WHFIN/Stock (id 8); rows get `transfer_type='finishing_to_warehouse'` and store fields ("WHFIN", "Warehouse Finished Goods", "Kenya").
- HWHFN/Stock also feeds WHFIN but is deliberately OUT of scope for this report (internal warehouse moves, not production output).
- "Transfer date" = completion date bucketed to EAT: `(date_done + interval '3 hours')::date` — `scheduled_date` is NOT the completion day.
- The reporting endpoint (`/api/analytics/finishing-to-warehouse`, daily agg + `?day=` per-style drill) joins products via `LEFT JOIN LATERAL ... ORDER BY (active IS TRUE) DESC, barcode LIMIT 1` because all_products_clean can hold multiple rows per SKU — a plain join fans out SUM(qty_done).
- Store-flow/warehouse queries ignore the new rows automatically: they filter `to_store_name NOT IN WAREHOUSE_LOCATIONS` ('Warehouse Finished Goods' is in that list) and `_WAREHOUSE_ORIGIN_FILTER` governs the from-side. Verify this holds if either list changes.
- The sync loop keeps ~7 days fresh; `FINISHING_DONE_DAYS` env deep-backfills in a one-off run (90d run on 2026-08-04 → history from 2026-05-11). Loading is upsert-on-move_id, so re-runs are safe; never truncate (see stock-transfers history retention).
- UI: one shared component (FinishingToWarehouse.jsx) mounted BOTH on the Stock Movement page and as the Inventory tab "Finishing → Warehouse" — edit it once, both surfaces update.

**Why:** management wants a daily record of what production hands over to the warehouse, keyed on the day the transfer was actually completed.
