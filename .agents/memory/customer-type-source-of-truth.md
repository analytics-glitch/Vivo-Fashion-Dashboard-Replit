---
name: New/Returning source of truth
description: Why customer New-vs-Returning segmentation is recomputed from each customer's first-ever purchase date, NOT read from the stored all_sales.customer_type column.
---

# New vs Returning classification

**Rule:** Segment customers as New/Returning by **recomputing each customer's first-EVER purchase date** (a `first_purchase` CTE = `MIN(sale_date::date)` per `customer_id` across all history). A customer whose first-ever purchase falls inside the selected window is **New**; one who bought before the window is **Returning**. The *identified universe* is still gated on `LOWER(customer_type) IN ('new','returning','registered')` — anything else (`walk-in`, `Guest`, blank) is a Walk-in and excluded from New+Returning.

Applies to `/api/customers` (`get_customers` `seg`), `/api/customer-type-spend`, `/api/customer-trend`, and `/api/customers-by-location`. They must stay consistent — all four share the `_unified_first_purchase_ctes()` helper.

**Identity must be UNIFIED across the 2026-03-20 Kenya id switch.** Post-cutover Kenya tags sales with short (≤6-digit) Odoo customer ids; legacy history sits under 13-digit Shopify ids — a *different namespace*. Computing first-purchase on the raw `customer_id` mislabels long-time shoppers as "New" when they reappear under a fresh Odoo id (Kenya 14–21 Jun 2026: raw recompute = ~80% New / 1696 of 2415 orders; true ~21% / 506 New after bridging). The bridge is `raw_odoo_customers.shopify_user_id` (Odoo `id` ↔ legacy Shopify id, ~96.6% coverage). `_unified_first_purchase_ctes(out_cte, out_col)` in `api_pg.py` emits 3 leading CTEs (`_id_bridge`, `_canon_fp`, the named output) that collapse an Odoo id to its linked Shopify id (canon = `COALESCE(shopify_user_id::text, customer_id)`), take `MIN(sale_date::date)` per canon, then re-map the date back onto every raw `customer_id` so callers keep joining on `s.customer_id` unchanged. Odoo ids are ≤6 digits and Shopify ids are 13, so the `id::text = customer_id` join can never false-bridge a legacy id; continuous-id (pre-cutover) periods are unchanged because Odoo sales are all later, so they never lower a pre-cutover MIN.

**Why the flip (was: trust stored `customer_type`):** The stored column **cannot express new-vs-returning for POS** — Kenya (and most retail POS) tags *every* counter sale `'registered'` and never `'new'`. So a `customer_type='new'` filter made "New" structurally **0** for Kenya and dumped 100% of identified shoppers into Returning, even when ~1,748 of 2,415 in a week were genuine first-time buyers. The user flagged this twice as wrong.

The old fear was that recompute inflates New because POS mints a fresh id per transaction. **That is not true of current `registered` data:** `registered` `customer_id`s are stable at ~2.5 orders/id, and the recompute on the Kenya week gave New=1,748 < total=2,415 (i.e. 667 had a prior purchase) — exactly matching the additive `first_time_registered` metric. Stable ids ⇒ recompute is reliable. (Residual cross-channel non-unification — same person with an online id and a separate POS id — only causes minor, acceptable over-count of New, far better than a hard 0.)

**How to apply:**
- New = `first_purchase_date BETWEEN date_from AND date_to`; Returning = `first_purchase_date < date_from`; Total = New + Returning (DISTINCT `order_id` counts).
- In `get_customers`, the `first_purchase` CTE must be defined **before** `seg` (Postgres CTEs can't forward-reference). `seg` JOINs `first_purchase`; `repeat_customers` stays a literal 0; walk-ins still come from `/api/customers/walk-ins`; avg-spend/churn/incomplete-profile stay on the identified-`customer_id` grain.
- Response keys are unchanged, so `Customers.jsx` needs no edit (label "customers with ≥2 orders" is loose copy, not a literal contract).
- If you ever see "New = 0 / Returning = 100%" again, this recompute regressed back to a `customer_type='new'` filter.
