---
name: Walk-in / anonymous-transaction definition
description: How "walk-in customers" are counted on the BI Customers page and why NULL-id alone undercounts
---

# Walk-in (anonymous transaction) counting

A "walk-in customer" = an **anonymous transaction** (no real identified customer
profile): in-store walk-ins for Retail + guest checkouts for Online. Counting
rule: **each anonymous order = 1 walk-in customer** (`COUNT(DISTINCT order_id)`).

**A transaction is anonymous when ANY holds:**
- `customer_id` is missing (`NULL` / `''` / `'None'` / `'null'`), OR
- `customer_type ILIKE 'walk-in'`, OR
- `customer_id` resolves to a placeholder / brand **pseudo-account** whose name
  matches `_WALKIN_NAME_REGEX` (`walk-in|vivo|safari|zoya`).

**Why all three:** counting only `customer_id IS NULL` undercounts badly — the POS
attaches a placeholder customer (a pseudo-account, or `customer_type='walk-in'`)
to many walk-in sales, so they are NOT null. In dev's 90d window, null-id alone ≈
3,970 orders but the full definition ≈ 6,400. A near-zero walk-in KPI is the
symptom of using the null-only rule.

**Reconciliation invariant:** this is exactly the SAME exclusion `/api/customers`
applies to the *identified* universe (it drops null/pseudo ids). So
**walk-ins + identified customers = total transactions** by construction. If you
change one definition, change the other in lockstep or the two tiles disagree.

**Pseudo-account join:** dedupe the pseudo set (`SELECT DISTINCT customer_id`)
before `LEFT JOIN`ing to `all_sales` — `all_customers` has multiple rows per
customer, so a non-distinct join fans out sales rows and inflates counts/sums.

**Note (data semantics):** Online (Shop Zetu ShopifyQL) rows now **DO** carry
customer_id (~99.9% of history; only genuine guest checkouts are null), so Online
splits into real New/Returning and only a tiny walk-in remainder. A near-100%
walk-in Online reading is a **bug** (extractor not pulling customer_id), NOT
expected — see `online-no-customer-identity.md`.

**Incomplete-profile (different metric):** identified customers (real id, active in
period) who are missing name/phone/email. Denominator must reuse the same identified
exclusion so "X of N identified" reconciles with the Total Identified tile.
