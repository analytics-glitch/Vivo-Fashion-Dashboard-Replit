---
name: Customer pseudo-account exclusion is a single canonical predicate
description: Every customer analytics surface must apply the same walk-in/placeholder/brand pseudo-account exclusion or page totals stop reconciling.
---
The rule: any endpoint that counts or lists identified customers must include the canonical exclusion helper (`_not_walkin_pseudo_sql()` wrapping `_WALKIN_PSEUDO_COND` — name regex + pseudo-email regex against `all_customers`). Surfaces covered: customers KPIs, customer-frequency, top-customers, repeat-customers, customer-details, RFM, churned-customers, churn-rate, retention months trend, crosswalk, customer-search.

**Why:** the first pass applied it only to the "main" pages; an architect review found five more endpoints leaking pseudo-accounts (Village MKT-style brand accounts in Top Customers etc.), and totals disagreed across pages (10,447 vs 10,377). Contractual identities now locked by validation cross-surface checks (`xsurf_cust_*` in validation_agent/cross_surface.py): total == Σ frequency buckets == details total; freq repeat(2+) == repeat-customers `total_repeat_count` (COUNT(*) OVER, since the row list is capped at 500); new+returning == total; retention total == customers total. RFM is deliberately NOT compared (excludes zero/negative-monetary customers by design).

**How to apply:** when adding ANY new customer-grain endpoint, add `_not_walkin_pseudo_sql(alias=…)` to its WHERE, and consider adding it to the `_check_customers` identity set if its total is contractually equal to the headline.
