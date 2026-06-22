---
name: New/Returning source of truth
description: Why customer New-vs-Returning segmentation must read the stored all_sales.customer_type column, not a recomputed first_purchase CTE.
---

# New vs Returning classification

**Rule:** Segment customers as New/Returning from the **stored `all_sales.customer_type`** column, not by recomputing each customer's first-ever purchase date from a `first_purchase` CTE keyed on `customer_id`.

Mapping used by `/api/customer-type-spend` (`get_customer_type_spend`):
`LOWER(customer_type)`: `new`→New; `returning`,`registered`→Returning; everything else (`walk-in`,`Guest`,blank)→Walk-in. `registered` = POS counter sales, treated as Returning per the business owner.

**Why:** `customer_id` is **not unified across channels** — Shopify (online) and Odoo POS use different id namespaces, and POS till sales mint a fresh numeric id almost every transaction with no profile in `all_customers`. So a first_purchase recompute makes every repeat POS shopper look "new" (it inflated New to ~75% of a week and undercounted total customers vs actual order volume). The stored `customer_type` already carries the correct upstream classification.

**How to apply:** Any New/Returning/Walk-in customer breakdown should trust `customer_type`. Counting `COUNT(DISTINCT order_id)` (orders) is the reliable volume — distinct `customer_id` is unreliable for POS. Both `/api/customer-type-spend` AND the Customers-page headline `/api/customers` (`get_customers`) now derive New/Returning/Total from `customer_type` this way; `/api/customers` keeps `repeat_customers` as a literal 0 (returning already folds in `registered`), excludes the Walk-in segment from the identified `total_customers` (= New + Returning; walk-ins still come from `/api/customers/walk-ins`), and keeps avg-spend/churn/incomplete-profile on the old identified-`customer_id` grain. The headline response keys are unchanged so `Customers.jsx` needs no edit.
