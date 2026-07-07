---
name: Cross-surface reconciliation must use real production paths
description: How to build reconciliation checks that can actually fail when pages disagree
---
Rule: a cross-page reconciliation check must compute each side through the SAME function the page actually calls (e.g. get_kpis vs get_country_summary vs get_trend_series), never by re-running one shared/duplicated SQL for both sides.

**Why:** the first nightly cross-check duplicated the KPI SQL for the "trend" side — it compared a query with itself and could never detect real drift (architect caught it).

**How to apply:** put the comparison in a pure, DB-free module (see dq_cross_compare.py) so unit tests can feed divergent inputs and prove the check fails; money tolerance = ±0.5 per ROUND()ed group, units = exact integer equality. Persist idempotently (upsert on run_date+check_name) for the DQ page.
