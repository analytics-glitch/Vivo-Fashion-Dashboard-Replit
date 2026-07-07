---
name: Net Sales canonical definition
description: The ONE canonical Net Sales figure across all BI surfaces, the ex-VAT legacy measure, and the PA narrowed-scope contract.
---

# Net Sales canonical

**Rule:** "Net Sales" everywhere = `NET_SALES_CANON` (api_pg.py): SUM(total_sales_kes − discounts_kes for sale/order) − SUM(returns_kes for return). VAT-inclusive, same basis as Total Sales, so the bridge is simply Total (already net of returns) − Discounts. Surfaces: /api/kpis, kpi-trend, trend-series, total-sales-summary, margin net_revenue, PA net_revenue_period + summary.net_revenue_canonical, RFM monetary, orders-summary `net`, custom-report net_revenue, orders per-line `net_sales_canon_kes`.

**The stored per-row `net_sales_kes` column is a DIFFERENT measure** (÷(1+VAT), ex-VAT) — surfaced only as "Net Sales ex-VAT" (Exports column, orders-summary `net_ex_vat`, orders legacy field) and used internally by costed_net margin math (deliberate). Never label it plain "Net Sales".

**PA contract:** `summary.net_revenue_canonical` is None whenever the style universe is narrowed (brand/category/subcategory/tier/pareto/status) — equality with the window canonical is not expected there; the UI falls back to the styles-scope sum labelled "(styles scope)".

**Why:** four surfaces once showed four different "Net Sales" for the same window; canonical was chosen because it reconciles to the shilling with Total on every surface (June 2026: 101,205,259 − 11,404,599 = 89,800,660).

**How to apply:** any new endpoint/tile labelled Net Sales/Net Revenue must use NET_SALES_CANON. Test: `python test_net_sales_consistency.py` (needs api-server + SEED_ADMIN_PASSWORD). validation_agent cross_surface reconciles kpis vs total-sales-summary — keep both on the same SQL.
