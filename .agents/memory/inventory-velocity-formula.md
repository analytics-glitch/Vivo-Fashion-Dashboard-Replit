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

# Two velocity definitions coexist — do NOT conflate them

There are intentionally TWO weekly-velocity definitions in `api_pg.py`. Pick by which surface you are matching:
- **Recency-weighted (above):** weeks-of-cover / replenish / IBT dead-stock. The `((u28*2)+max(u56-u28,0))/12` form.
- **Product Analysis simple velocity:** `units_per_week = SUM(net_quantity over trailing velocity_days) / (velocity_days/7)`, `velocity_days` default 30, NO `sale_kind` filter (net_quantity is already signed), and `woc = soh / units_per_week` only when `units_per_week > 0`. This is what the Product Analysis page and the Custom Report's "Velocity" measures (`units_per_week`, `woc`) use.

**Why:** the Custom Report velocity columns are billed as "Product Analysis columns", so they must mirror PA's simple 30-day net model, not the recency-weighted inventory one. A first pass used the recency-weighted formula and the numbers didn't reconcile with the PA page.

**How to apply:** when adding velocity/WoC to a NEW surface, decide up front which page it must reconcile against and copy that exact formula. Brand/category aggregates won't match PA *exactly* because PA scopes to current-stock styles and excludes third-party/manually-retired styles; the per-style formula is what must match.

**Gotcha:** the dead-stock CTEs (`style_inv`, `style_sales56`) MUST inherit the same `country` filter as the suggestion query. If they aggregate globally while the request is country-scoped, styles get mis-classified as dead/alive for that market. Thread `c_inv`/`c_sales` into them.
