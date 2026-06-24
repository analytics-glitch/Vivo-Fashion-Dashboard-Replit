---
name: Finance / P&L page period model
description: Why the Finance page drives its own month-range period (not the global daily filter) and how the /api/finance/pl query is shaped for it.
---

# Finance / P&L page — period selection & query shape

The Finance page (`artifacts/vivo-bi/src/pages/Finance.jsx`, `/finance`) shows a
monthly P&L from the Postgres `finance_pl_summary` view via `GET /api/finance/pl`.

## It drives its OWN month-range period — NOT the global filter bar

The page intentionally ignores the global daily filter bar (`useFilters().applied`
date range) and owns local `fromMonth`/`toMonth` state (month presets: Last 3/6/12,
This year YTD, Last year, All + explicit From/To month dropdowns + a "Showing
<from> – <to> · N months (M closed)" label). It still hard-refreshes via the global
Refresh button (`dataVersion`).

**Why:** the global filter's DEFAULT preset is `today` (date_from=date_to=today). A
monthly P&L asked for a single still-open day → ZERO closed months → the CONFIRMED
(closed-month-only) KPI tier rendered empty/blank, which read as "broken / which
period is this?". Daily presets (7D/30D/90D) never map cleanly onto month-grain
accounting anyway. A dedicated month selector with a default of "last 12 months"
fixes the confusion and is the right granularity.

## Query shape: full history (cached) + windowed opex only

`/api/finance/pl` returns the **FULL** month history (`SELECT … FROM
finance_pl_summary ORDER BY month`, no date window) — a constant query string so
`run_query`'s md5 cache computes the expensive view ONCE, not per period change.
The frontend filters those rows to the selected window CLIENT-SIDE. Only
`opex_detail` (account-level sums from `raw_account_move_lines`, the cheaper query)
stays windowed by `date_from`/`date_to` server-side, so switching periods re-runs
only the cheap query while the heavy view stays warm.

**Why:** `finance_pl_summary` is an expensive aggregate view (~9s cold). The old
code re-scanned it windowed on every period change. Don't add a second full-view
scan (e.g. a separate all-months query) — it doubles the cost; one constant
cacheable scan + client-side filtering is strictly cheaper.

**How to apply:** month math is done in LOCAL time (first-of-month strings) to
avoid an EAT (UTC+3) off-by-one. CONFIRMED tier sums `is_closed` months only;
open months are shown in the matrix tagged partial but excluded from tier totals.
