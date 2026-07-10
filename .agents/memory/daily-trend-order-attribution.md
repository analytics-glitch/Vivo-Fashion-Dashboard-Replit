---
name: Daily-trend order counts need first-day attribution
description: Per-day COUNT(DISTINCT order_id) summed over days > window-wide distinct when orders span sale_dates (Shopify edits); attribute each order to its first day
---

# Σ(per-day distinct orders) ≠ window distinct orders

Shopify order edits can land line rows on a LATER sale_date than the original
order, so one order_id has rows on two days. A daily-trend query that does
`COUNT(DISTINCT order_id)` per day then counts that order twice when the days
are summed, drifting above `/api/kpis` `COUNT(DISTINCT order_id)` over the
window (30d Online: 1,345 vs 1,348 — 3 edited orders).

**Rule:** any per-day order-count surface that must reconcile with a
window-wide KPI has to attribute each order to exactly ONE day — its first
sale_date in the window — not count it distinct per day.

**How to apply (the accepted pattern):** shared `base` CTE with the endpoint's
filters → `day_agg` keeps money/units summed on each row's own day (unchanged
semantics) → `order_first` = `SELECT DISTINCT ON (order_id) order_id, country,
sale_date FROM base WHERE sale_kind IN ('sale','order') AND order_id IS NOT
NULL ORDER BY order_id, sale_date, country` (one row per order, deterministic
tie-break, mirrors COUNT(DISTINCT) even for dirty cross-country dupes) →
per-day counts LEFT JOINed back with a **null-safe** join
(`o.country IS NOT DISTINCT FROM d.country`; plain `=` drops NULL buckets).
The continuously-running `xsurf_kpis_vs_daily_trend` cross-surface check is
the regression guard for this identity.
