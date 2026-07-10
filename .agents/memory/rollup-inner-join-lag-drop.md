---
name: Rollup INNER JOIN silently drops post-refresh entities
description: Any query that INNER JOINs a periodically-refreshed rollup table loses entities created after the last refresh — LEFT JOIN + NULL-classify instead
---

# INNER JOIN on a refreshed-rollup table = silent undercount

The Customers KPI (`/api/customers` seg CTE) INNER JOINed `first_purchase`,
which is served from `rollup_customer_first_purchase` when fresh. A customer
whose first-EVER purchase happened AFTER the rollup's last refresh is missing
from the rollup, so the INNER JOIN silently dropped them from
`total_customers` — while customer-details / customer-frequency (which don't
join the rollup) counted them. Result: KPI ~45 lower than the other two
surfaces, flagged by the xsurf_cust_* cross-surface checks.

**Rule:** any surface that joins a periodically-refreshed rollup/materialized
table must LEFT JOIN it and explicitly classify the NULL (rollup-missing) case.

**Why:** rollups always lag live data; an entity born between refreshes exists
in `all_sales` but not the rollup. INNER JOIN semantics turn that lag into a
silent row drop, which no error surfaces.

**How to apply:** for first-purchase joins, NULL ⇒ New (a rollup-missing
customer's first purchase by definition post-dates the refresh, so any window
that reaches them contains it). This is safe for historical windows too: a
customer with sales in an old window would already be in the rollup.
