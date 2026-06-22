---
name: New/Returning source of truth
description: Why customer New-vs-Returning segmentation is recomputed from each customer's first-ever purchase date, NOT read from the stored all_sales.customer_type column.
---

# New vs Returning classification

**Rule:** Segment customers as New/Returning by **recomputing each customer's first-EVER purchase date** (a `first_purchase` CTE = `MIN(sale_date::date)` per `customer_id` across all history). A customer whose first-ever purchase falls inside the selected window is **New**; one who bought before the window is **Returning**. The *identified universe* is still gated on `LOWER(customer_type) IN ('new','returning','registered')` — anything else (`walk-in`, `Guest`, blank) is a Walk-in and excluded from New+Returning.

Applies to both `/api/customers` (`get_customers` `seg` CTE) and `/api/customer-type-spend` (`get_customer_type_spend`). They must stay consistent.

**Why the flip (was: trust stored `customer_type`):** The stored column **cannot express new-vs-returning for POS** — Kenya (and most retail POS) tags *every* counter sale `'registered'` and never `'new'`. So a `customer_type='new'` filter made "New" structurally **0** for Kenya and dumped 100% of identified shoppers into Returning, even when ~1,748 of 2,415 in a week were genuine first-time buyers. The user flagged this twice as wrong.

The old fear was that recompute inflates New because POS mints a fresh id per transaction. **That is not true of current `registered` data:** `registered` `customer_id`s are stable at ~2.5 orders/id, and the recompute on the Kenya week gave New=1,748 < total=2,415 (i.e. 667 had a prior purchase) — exactly matching the additive `first_time_registered` metric. Stable ids ⇒ recompute is reliable. (Residual cross-channel non-unification — same person with an online id and a separate POS id — only causes minor, acceptable over-count of New, far better than a hard 0.)

**How to apply:**
- New = `first_purchase_date BETWEEN date_from AND date_to`; Returning = `first_purchase_date < date_from`; Total = New + Returning (DISTINCT `order_id` counts).
- In `get_customers`, the `first_purchase` CTE must be defined **before** `seg` (Postgres CTEs can't forward-reference). `seg` JOINs `first_purchase`; `repeat_customers` stays a literal 0; walk-ins still come from `/api/customers/walk-ins`; avg-spend/churn/incomplete-profile stay on the identified-`customer_id` grain.
- Response keys are unchanged, so `Customers.jsx` needs no edit (label "customers with ≥2 orders" is loose copy, not a literal contract).
- If you ever see "New = 0 / Returning = 100%" again, this recompute regressed back to a `customer_type='new'` filter.
