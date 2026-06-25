---
name: Finance Reports Suite period model & view
description: The Finance page is a 7-report suite on the Odoo-structured finance_pl_summary view; why it drives its own month-range period and how the endpoints are shaped.
---

# Finance Reports Suite — structure, period model & query shape

`/finance` (`artifacts/vivo-bi/src/pages/Finance.jsx`) is a **7-report suite**
(shell + tabs) for **leadership + admin**, web-only, read-only, all KES:
P&L Statement (flagship) · Revenue · Cost of Revenue · Operating Expenses ·
Payroll · Vendor Spend · P&L Trend & KPIs. Shell fetches `/api/finance/pl` once;
report files live in `src/pages/finance/` with shared helpers in
`finance/shared.jsx` (Money red/parens negatives, HonestyTags, DataTableCard,
usePlDetail hook, STATEMENT model, kesCol/pctCol). Endpoints: `/api/finance/pl`,
`/api/finance/pl-detail`, `/api/finance/expense-by-vendor`.

## The view is the official Odoo P&L structure (rebuilt)

`finance_pl_summary` columns: month, gross_sales, returns, net_revenue_pipeline,
revenue_odoo, cogs, production, purchases, total_costs_of_revenue, gross_profit,
employment, admin, establishment, selling, marketing, finance_charges, other_opex,
total_operating_expenses, other_income, net_profit, is_closed, has_cost_anomaly.
- **operating_income is NOT a column** → derive `gross_profit -
  total_operating_expenses` (done in the `/api/finance/pl` SELECT).
- Accounting data exists **Feb 2026+** only; pre-2026 months carry just the sales
  pipeline (all Odoo P&L columns zero). `isAccounting()` gates them out and seeds
  the default period (accounting span).
- Detail sign convention reconciles exactly: revenue/other_income = credit−debit;
  costs/opex = debit−credit (in `/api/finance/pl-detail`, grouped by
  pl_section/pl_group/account). `/api/finance/expense-by-vendor` returns
  `{vendor, spend}` (NOT partner_name) — match that field name on the client.
- Data-honesty flags surfaced as tags everywhere: `has_cost_anomaly` (Apr 2026+)
  = under review but real figures shown; `is_closed=false` (Jun 2026+) = partial.

## It drives its OWN month-range period — NOT the global filter bar

Owns local `from`/`to` month state (presets Last 3/6/12, YTD, Last year + From/To
month inputs). Default = the accounting span (first accounting month → latest).

**Why:** the global filter's default preset is `today`; a monthly P&L on a single
open day = zero closed months = blank/"broken". Daily presets never map onto
month-grain accounting. A dedicated month selector is the right granularity.

## Query shape: full history (cached) + windowed detail

`/api/finance/pl` returns the **FULL** month history (constant query string → one
md5-cached scan of the expensive view); the frontend windows client-side and uses
the full list for the month selector bounds. `pl-detail` / `expense-by-vendor`
stay windowed server-side (cheap). The `usePlDetail` hook is shared so multiple
report tabs on the same window hit one cached DB query.

**Why:** `finance_pl_summary` is an expensive aggregate (~9s cold). Don't add a
second full-view scan — one constant cacheable scan + client filtering is cheaper.

**How to apply:** month math in LOCAL time (first-of-month strings) to avoid an
EAT (UTC+3) off-by-one. Auth: `/api/finance` gate widened admin→admin+leadership
in `clerk_auth_gate`; `finance` lives in permissions.js LEADERSHIP (ADMIN_ONLY_PAGES
is empty). Server gate is the real boundary — client nav hiding is bypassable.
