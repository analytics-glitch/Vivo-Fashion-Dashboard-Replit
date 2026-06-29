---
name: Online (Shop Zetu) has no customer identity
description: Why per-customer KPIs are structurally 0 for the Online channel, and how to show real numbers instead.
---

Online sales (Shop Zetu via the ShopifyQL feed; `store_id='shop-zetu'`, `country='Online'`)
carry **NO** `customer_id` / email — the feed is an order-level aggregate with no individual
customer identity. So any per-customer metric (unique customers, spend-per-customer, churn,
first-purchase New/Returning) is **structurally 0** for the Online segment — it is NOT a query bug.

The historical online rows from `vivowoman` DID carry customer_id but ended 2026-03-19 (Kenya Odoo
switch 2026-03-20), so any recent online window is Shop-Zetu-only → all per-customer KPIs read 0,
and every online order falls into the anonymous "walk-in" bucket.

**What IS real and derivable for online:** the feed gives each ORDER a New/Returning flag, stored
in `all_sales.customer_type` ('New'/'Returning'), plus real order values. So show **order-based**
figures: `COUNT(DISTINCT order_id)`, new/returning **orders** via `customer_type` filter, and
avg order value = total_sales ÷ orders.

**Why:** users see "Total Customers 0 / New 0 / Returning 0 / Avg Spend 0" on Online and think the
page is broken. The numbers are honest-zero for *customers* but real for *orders*.

**How to apply:**
- For online New/Returning use the RAW `customer_type` flag, **NOT** the `first_purchase` recompute
  used by `/api/customer-type-spend` — that join keys on `customer_id` and dumps every online order
  into Walk-in. Backend endpoint `GET /api/customers/online-summary` does the flag-based version.
- The vivo-bi Customers page detects `channelGroup==='online'` (`isOnlineOnly`) and swaps the
  Total/New/Returning/AvgSpend tiles to order-based values + relabels them, shows an explainer
  banner, and renders churn as N/A (churn is customer-based AND computed globally/channel-agnostic).
- The filter-bar "channel" param carries `pos_location_name` values; "Online - Shop Zetu" matches
  the DB exactly. (Some ONLINE_FALLBACK labels like "Online - Vivo Woman"/"Online - Uganda" do NOT
  match the real DB "Online - vivowoman"/"Online - vivo-uganda", but Shop Zetu is the only online
  source with current data, so the mismatch is cosmetic for now.)
