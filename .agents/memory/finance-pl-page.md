---
name: Finance / P&L page
description: How the BI Finance page reads finance_pl_summary and why figures are split into confirmed vs provisional tiers.
---

# Finance / P&L page

The BI Finance page (`/finance`, `GET /api/finance/pl`) reads the Postgres
`finance_pl_summary` VIEW (one row per calendar month; `month` is a real DATE =
first of month, so no `::date` cast is needed unlike `all_sales.sale_date`).

**Why the two-tier split (confirmed vs provisional):** the view derives COGS and
opex from `raw_account_move_lines` JOIN `finance_account_map` (on `account_code`,
grouping by `pl_group`), but the underlying Odoo accounting is incomplete:
- COGS recognition is partial, so implied **gross margins read ~97–100%** (gross
  profit ≈ net revenue). The view exposes `has_full_cogs` (true only when implied
  margin ≤ 0.80) to flag months whose COGS is not fully booked.
- Payroll is **not journaled at all** — `salaries` is hard-coded `0` and
  `has_salaries` is always `false` (~KES 40M/month missing). The UI shows
  "Not in Odoo", never `0`.

Therefore Gross Margin %, Gross Profit, and Operating Income are PROVISIONAL
(muted/amber, behind a standing warning banner). Net Revenue and Production/Admin
Opex are CONFIRMED. The exact banner copy is a constant in `Finance.jsx` — keep
it verbatim.

**How to apply:** tier roll-ups and the trend chart use CLOSED months only
(`is_closed = true`, i.e. `month < date_trunc('month', CURRENT_DATE)`); the
current month is partial and must be excluded from any comparison/summary.
`production_opex`/`admin_opex` can be **negative** for the open/current month
(partial postings) — that is expected, not a bug.
