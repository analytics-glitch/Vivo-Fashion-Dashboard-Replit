---
name: Net-sales netting in BI endpoints
description: Which endpoints net returns and the exact SQL convention used
---

The metrics spec (/tmp/vivodocs/03_metrics.md 3.2.2) says Net Sales = gross − returns and is
applied at: /api/top-skus, /api/sor, /api/subcategory-sales, executive-summary, country-summary.
Does NOT net: /api/kpis (its own total_sales is gross), /api/sales-summary.

**Convention (must stay consistent across the app):** "net" = order rows' `net_sales_kes`
MINUS return rows' `returns_kes`, i.e.
`SUM(CASE WHEN sale_kind IN ('sale','order') THEN net_sales_kes WHEN sale_kind='return' THEN -returns_kes ELSE 0 END)`.
Note `net_sales_kes` for order rows is already ~12-13% below gross_sales_kes (discounts/tax), so
"net" is ~14% below gross overall — that is expected, not a bug.

**Why:** /kpis, country-summary, etc. already use this exact formula; using gross_sales_kes−returns
instead would make top-skus/sor disagree with the Overview KPI (replit.md: cross-tabs must stay
internally consistent).

**How to apply:** include `'return'` in the sale_kind filter so return rows enter the aggregate;
keep units_sold / gross_sales / orders restricted to sale+order via CASE/FILTER. /api/analytics/sor-all-styles
is the unlimited clone of /sor and MUST net identically.
