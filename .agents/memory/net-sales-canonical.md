---
name: Net Sales canonical definition
description: The ONE canonical Net Sales figure (ex-VAT) across all BI surfaces, the stored net_sales_kes column caveat, and the PA narrowed-scope contract.
---

# Net Sales canonical (ex-VAT since 2026-07-10)

**Rule:** "Net Sales" everywhere = `NET_SALES_CANON` (api_pg.py): SUM((total_sales_kes − discounts_kes)/VAT for sale/order) − SUM(returns_kes/VAT for return), where VAT = `_VAT_DIV` (1.18 Uganda/Rwanda, 1.16 Kenya + Online — mirrors transform_all_sales.get_vat). Total Sales stays VAT-inclusive, so the Total → Net gap is mostly the VAT share (~14%) plus discounts. Surfaces: /api/kpis, kpi-trend, trend-series, total-sales-summary, margin net_revenue, PA net_revenue_period + summary.net_revenue_canonical, RFM monetary, orders-summary `net`, custom-report net_revenue, orders per-line `net_sales_canon_kes`, restatement figures.

**The stored per-row `net_sales_kes` column is still NOT the canon** — the sync path zeroes returns in it, and it's a plain ÷(1+VAT) without the canon's return handling. Surfaced only as "Net Sales ex-VAT" (Exports column, orders-summary `net_ex_vat`, orders legacy field) and used internally by costed_net margin math (deliberate). Always compute Net Sales via the NET_SALES_CANON fragment, never the stored column.

**PA contract:** `summary.net_revenue_canonical` is None whenever the style universe is narrowed (brand/category/subcategory/tier/pareto/status) — equality with the window canonical is not expected there; the UI falls back to the styles-scope sum labelled "(styles scope)".

**Rounding:** custom-report rounds per-dimension rows before Σ, so with the VAT division it may differ from round-of-total by ±0.5/row — the consistency test allows that tolerance; exact-equality surfaces (orders-summary, PA canonical) round the total once.

**Why:** four surfaces once showed four different "Net Sales"; then the user found VAT-inclusive Net too close to Total ("should not be similar") and chose ex-VAT (2026-07-10). Chosen so Net reflects revenue the business actually keeps.

**How to apply:** any new endpoint/tile labelled Net Sales/Net Revenue must use NET_SALES_CANON (never re-derive inline). Test: `python test_net_sales_consistency.py` (needs api-server + SEED_ADMIN_PASSWORD; bridge check is an ex-VAT band, not equality). validation_agent cross_surface reconciles kpis vs total-sales-summary — keep both on the same SQL. Prod's DB is separate: the ex-VAT figures appear there only after publish.
