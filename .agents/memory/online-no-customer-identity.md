---
name: Online (Shop Zetu) now carries customer_id
description: Online customer KPIs are real (not structural zeros) once the ShopifyQL feed pulls customer_id; do NOT special-case Online to order-based metrics.
---

**Current state (corrected):** Online sales (Shop Zetu via the ShopifyQL feed; `store_id='shop-zetu'`,
`country='Online'`) **DO** carry `customer_id` (~99.9% of all-history rows; only genuine guest
checkouts are null). **Invariant — three ingestion paths must ALL carry `customer_id` in lockstep** or
Online silently reverts to ~100% walk-in: the raw ShopifyQL extractor (must request the `customer_id`
*dimension*, not just have the column), the rebuild transform, and the live-sync wrapper. **Why:** the
original bug was the extractor never requesting the dimension, so the raw column existed but was always
NULL and the transform fell back to a retail-only orders table that never has shop-zetu rows.

**DEV vs raw gotcha:** dev `all_sales` Online was repopulated **directly via the live-sync wrapper**
(per-window delete+insert, shop-zetu-scoped), NOT via a raw backfill + transform — so dev
`raw_shopify_vendor_sales.customer_id` is still NULL for history. A full `transform_all_sales` rebuild
in dev would **re-NULL Online** unless you first run the raw extractor full-history backfill. Prod gets
that raw backfill automatically via the `REBUILD_ON_BOOT=1` watchdog gate. Operational notes: ShopifyQL
hard rate-limits this store (run wrappers in bounded month/year chunks; each invocation commits), and
`nohup &` background jobs do NOT survive a bash tool call in this env — run long chunks in the foreground.

**Therefore per-customer KPIs work for Online through the normal path.** `/api/customers` with
`channel='Online - Shop Zetu'` returns real `total_customers` / `new_customers` /
`returning_customers` / `avg_customer_spend` (e.g. 22–28 Jun 2026 ≈ 152 customers, 51 new, 101
returning, avg KES 6,847). Orders without a customer_id correctly fall into the walk-in bucket, exactly
like retail.

**Why this note exists:** an earlier fix assumed Online had NO customer identity and special-cased the
vivo-bi Customers page to show ORDER-based figures (`COUNT(DISTINCT order_id)` + raw `customer_type`
flag) via a dedicated `/api/customers/online-summary` endpoint + an `isOnlineOnly` UI branch. That
premise became false after the pipeline change. The special-case was **fully reverted** (endpoint
removed; Customers.jsx Total/New/Returning/AvgSpend/churn tiles restored to the canonical
customer-based path).

**How to apply:**
- Do NOT re-add an Online-specific order-based override on the Customers page. Let Online flow through
  `/api/customers` like every other channel.
- If you ever see Online customer KPIs read 0 again, first check `customer_id` coverage on
  `all_sales WHERE store_id='shop-zetu'` (and the `raw_shopify_vendor_sales.customer_id` column) — a
  regression in the extractor, not a structural limitation, is the likely cause.
- Historical caveat: the older `vivowoman` online rows also carried customer_id but ended 2026-03-19
  (Kenya Odoo switch 2026-03-20); recent online windows are Shop-Zetu-only.
- The filter-bar "channel" param carries `pos_location_name` values; "Online - Shop Zetu" matches the
  DB exactly. (Some ONLINE_FALLBACK labels like "Online - Vivo Woman"/"Online - Uganda" don't match
  "Online - vivowoman"/"Online - vivo-uganda", but Shop Zetu is the only online source with current
  data, so the mismatch is cosmetic.)
