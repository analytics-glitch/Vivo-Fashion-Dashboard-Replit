---
name: Store Profile rate-KPI projection & page contract
description: Rate KPIs (ASP/ABV/conversion/%) must never be day-prorated; Store Profile page structure and category-target math.
---

**Rule:** In any month-end projection, only VOLUME KPIs (revenue, units, transactions, footfall, customer_count) may be linearly extrapolated by days. Rate KPIs (ASP, ABV, conversion, discount/return/new/returning %) are averages — carry the MTD rate, then recompute ASP = proj_revenue/proj_units, ABV = proj_revenue/proj_transactions, conversion = proj_txns/proj_footfall for coherence.

**Why:** Day-prorating an average multiplies it by ~days_in_month/days_done, producing absurd ASP/ABV values; a review round caught this in /api/store-profile/performance-report.

**How to apply:** Any endpoint or frontend computing "projected EOM" or targets. Also on the Store Profile page:
- Health Check compares projected_eom vs expected baseline (like-for-like full-month scale), issues sorted first.
- Per-category unit targets = derived_targets.units × (category 6-month unit share); category MTD fetched via category-mix?month=YYYY-MM.
- Mix-shift %-points must use same-scope denominators (store-level vs store-level for categories; parent-category-level for sub-categories).
- Volume-KPI "what to do" fallbacks must be explicit ("no target set" / "month complete"), never a default "✓ done".
