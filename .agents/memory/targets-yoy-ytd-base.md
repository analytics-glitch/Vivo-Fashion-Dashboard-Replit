---
name: Targets YoY must use same-date prior-year YTD
description: Annual-targets actual_ytd is a FULL-year span; the Targets Tracker YoY must compare against prior-year YTD bounded to today, not the prior year's whole year.
---

The `/api/analytics/annual-targets` endpoint's per-bucket `actual_ytd` is the sum
of ALL four quarters for the requested year (Jan 1–Dec 31), i.e. a full-year span.
For the current year that equals true YTD only because there is no future data.

**Rule:** Any year-over-year comparison on the Targets Tracker must compare
this-year YTD against the prior year's actuals over the SAME calendar window
(Jan 1 → today's month/day), exposed as `actual_ytd_ly` on the current-year
response. Do NOT fetch year-1 and use its `actual_ytd` for YoY — that is the
prior year's WHOLE year and makes mid-year YoY read catastrophically negative
(e.g. Kenya mid-2026 showed −57% vs a correct +3.7%).

**Why:** The frontend previously assumed the endpoint bounded year-1 actuals to
today's date; it does not. Half-a-year vs a full year understated YoY by ~the
return-adjusted remaining-months volume.

**How to apply:** Use `b.actual_ytd_ly` / `total.actual_ytd_ly` for the annual
YoY. The year-1 fetch (`priorYearData`) is still needed for the quarter cards'
"vs prior FULL quarter" (e.g. Q1-this-year vs Q4-last-year), so keep it.
Quarter QoQ uses `actual_quarters` (quarter-bounded) and is correct as-is.
