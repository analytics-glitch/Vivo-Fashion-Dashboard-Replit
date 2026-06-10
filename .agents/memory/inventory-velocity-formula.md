---
name: Inventory velocity & dead-stock formula
description: The single recency-weighted weekly-velocity formula and dead-stock rule that every inventory endpoint must share, and why.
---

# Recency-weighted weekly velocity (one formula, used everywhere)

`weekly_units = ((units_28 * 2) + max(units_56 - units_28, 0)) / 12.0`

- `units_28` = units sold in the last 28 days; `units_56` = units sold in the last 56 days.
- The last 28 days are double-weighted; the prior 28 days count once; the denominator is the 12-week-equivalent so the result is a per-week rate.
- Reorder policy: `REORDER_COVER_WEEKS = LEAD_TIME_WEEKS (4) + SAFETY_WEEKS (1) = 5`.
  `reorder_point = round(weekly_units * REORDER_COVER_WEEKS)`, `at_risk = soh < reorder_point`,
  `weeks_of_cover = soh / weekly_units`.

**Why:** weeks-of-cover, replenish-by-color (style + per-color), and the IBT dead-stock test all express "how fast is this selling". If they each invent their own window (the old code used a flat 30-day `/4.0`), the same style shows different cover numbers on different screens and merchandisers lose trust. Keep the formula byte-for-byte identical across endpoints.

**How to apply:** any new endpoint that reports velocity, weeks-of-cover, reorder points, or "at risk" must reuse this exact formula. SQL side mirrors it with a `FILTER (WHERE sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text)` for the 28-day leg over a 56-day window. `all_sales.sale_date` is TEXT, so use `>= (CURRENT_DATE - INTERVAL 'N days')::text` (text comparison), NOT a `::date` cast inside the window predicate.

# Dead-stock rule (IBT exclusion)

A style is dead stock when BOTH hold over the trailing 56 days:
- cover > 16 weeks: `avail * 8.0 / NULLIF(u56,0) > 16` OR `u56 = 0`, and
- sell-through < 5%: `u56 / NULLIF(u56 + avail, 0) < 0.05` OR `(u56 + avail) = 0`.
(`* 8.0` annualizes 56-day units to a ~weekly cover proxy: 52/56-days ≈ 8 periods.)

The IBT suggestion SQL lives in one shared builder `_ibt_suggestions_sql(...)`, reused by both `/api/analytics/ibt-suggestions` and `/api/ibt/late-count`. Dead-stock styles are excluded from BOTH the donor (`froms`) and recipient (`tos`) sides so we never recommend shuffling stock nobody is buying.

**Gotcha:** the dead-stock CTEs (`style_inv`, `style_sales56`) MUST inherit the same `country` filter as the suggestion query. If they aggregate globally while the request is country-scoped, styles get mis-classified as dead/alive for that market. Thread `c_inv`/`c_sales` into them.
