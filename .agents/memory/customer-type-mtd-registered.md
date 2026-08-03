---
name: MTD customer_type reads 'registered'
description: Why % new customers is 0 on MTD windows when classified from stored all_sales.customer_type
---
Rule: never classify New customers from `LOWER(all_sales.customer_type)='new'` on recent/MTD windows. Incremental Odoo sync writes `customer_type='registered'` (or 'walk-in') and rows are only reclassified to new/returning during full rebuilds — so any current-month window has zero 'new' rows and "% new" reads 0% while "% returning" reads 100%.

**Why:** Store Profile health check showed 0% new / 100% returning for every store; root cause was the stored-type classification, data was fine.

**How to apply:** Derive New = identified customer whose first-EVER purchase (rollup_customer_first_purchase when `_rollup_fresh("customer_first_purchase")`, else `_unified_first_purchase_ctes()` fallback) falls in the row's month/window; LEFT JOIN and treat NULL fp as New (rollup lag = customer born after refresh). Returning = fp strictly earlier. Note this coexists with the segment-revenue canon ("registered→Returning" for the New/Returning REVENUE split identity) — that canon governs revenue bucketing on /kpis/customer-type-split, not customer-count "% new" metrics.
