---
name: Loyalty "birthday" = first-purchase anniversary
description: How the loyalty birthday-voucher-cost forecast defines a customer's birthday and tiers it
---

The loyalty **birthday voucher-cost** forecast defines a customer's "birthday" as the
**anniversary of their first-ever purchase**, NOT a date-of-birth.

**Why:** `crm_customer.dob` is effectively empty (a handful of rows, ~0 with a DOB),
so a DOB-based forecast always returned ~0. The user confirmed birthday should mean
"the first time the customer ever purchased". `all_customers.first_order_date` (TEXT,
~98.5% populated) is the source.

**How to apply (`cl_loy_voucher_cost` in `crm_clienteling.py`):**
- `all_customers` is keyed by `(customer_id, store_id)` → collapse to one row per
  customer with `MIN(first_order_date)` before matching, or you over-count.
- Match `to_char(fod::date,'MM-DD')` against the set of MM-DD strings in the window.
- **Feb-29 observes Feb-28** in non-leap years (CASE-map `'02-29'→'02-28'`) or those
  ~120 customers are silently dropped 3 years in 4.
- Tier each anniversary customer by rolling-12mo net spend (silver/gold thresholds
  from `crm_config`); dormant (no 12mo spend) falls into bronze.
- Guard the TEXT date with the `_ISO` regex before `::date`; build SQL with NO
  psycopg2 params (BASE_FILTERS has literal `%`), inline validated dates + `repr(float())` thresholds.
