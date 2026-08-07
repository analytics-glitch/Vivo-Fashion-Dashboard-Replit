---
name: Churn/gap window query bounding
description: How to make LAG/LEAD gap-detection queries over all_sales fast without changing results; period-scoping expensive all_customers scans.
---

# Bounding gap/churn window queries (Customers page "computing…" fix)

**Rule 1 — bound the scan, prove it exact.** A LAG/LEAD gap query (churned/
unchurned, reactivation, etc.) over full-history all_sales is never necessary.
Bound the scan to `[date_from − gap_days, date_to]`:
- events counted have `d + gap ∈ [from, to]` ⇒ `d ≥ from − gap`, and any
  disqualifying neighbour purchase lies inside `(d, d+gap)` ⊆ scan range;
- a LAG that comes back NULL inside the bounded scan means the true previous
  purchase (if any) is `< from − gap`, so the gap condition holds automatically
  — replace it with an `EXISTS` history probe (`sale_date < scan_from`) under
  the SAME scope filters (BASE + country/channel), which is an index seek.
Verify parity against the unbounded query on several window/gap/scope combos
before swapping. (Measured: 36s → 3–4s, identical counts on 5 combos.)

**Rule 2 — half-open text end bound.** `sale_date` is TEXT; use
`>= scan_from AND < (date_to + 1 day)` rather than inclusive BETWEEN so a
hypothetical timestamp suffix on the end day can't slip past the string
compare. The `hist`/scan boundary is exactly complementary under text compare.
Clamp user-supplied gap days (e.g. ≤ 3650) — an unbounded int query param hits
Python `timedelta` OverflowError / PG date overflow → 500.

**Rule 3 — period-scope expensive all_customers scans.** The pseudo-account
regex (`_WALKIN_PSEUDO_COND`) over ~500k all_customers rows costs ~3s per use;
walk-ins ran it 4×/request (17s). Any CTE (pseudo/excluded/cust_profile) that
is only ever consulted for period-filtered sales rows can be scoped by joining
a `period_ids` CTE (distinct customer_ids from all_sales under the same WHERE)
— milliseconds, semantics-neutral. Same for profile GROUP BYs: aggregate only
period customers, keep the LEFT JOIN so missing profiles still count as
incomplete.

**Why:** slow query (36s) × no cold-miss single-flight in run_query × page
auto-refresh = concurrent pile-up that chokes the pool for an hour. Fixing the
query is the primary cure; `ttl=900` on these run_query calls is the storm
shield. Cold-miss request coalescing in run_query remains an open follow-up if
a storm ever recurs with fast queries.

**How to apply:** any new customer-gap analytics (churn, win-back, dormancy)
must start from the bounded pattern in `customers_churn_events`; any new
consumer of `_WALKIN_PSEUDO_COND` must period-scope it.
