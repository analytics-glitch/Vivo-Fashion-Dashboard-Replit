---
name: Online (Shop Zetu) now carries customer_id
description: Online customer KPIs are real (not structural zeros) once the ShopifyQL feed pulls customer_id; do NOT special-case Online to order-based metrics.
---

**Current state (corrected):** Online sales (Shop Zetu via the ShopifyQL feed; `store_id='shop-zetu'`,
`country='Online'`) **DO** carry `customer_id`. The ShopZetu QL extractor was updated to pull it and
`raw_shopify_vendor_sales` now has a `customer_id` column; a full re-extract + `transform_all_sales`
rebuild populated `all_sales.customer_id` for ~99% of historical Shop Zetu rows (coverage by month is
near-complete; only the very newest rows can lag until the next backfill).

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
