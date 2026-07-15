---
name: total_sales_kes is GROSS (pre-discount)
description: all_sales money-column convention — total_sales_kes must be pre-discount on EVERY ingestion path or KPI net double-subtracts
---
The KPI SQL computes `net_sales = total_sales_kes − discounts_kes`, so every ingestion path (Shopify sync, Odoo sync, all rebuild transforms) MUST store `total_sales_kes` as the GROSS (pre-discount, VAT-incl) amount, with the discount only in `discounts_kes`.

**Why:** the Odoo paths once stored `price_subtotal_incl` (post-discount) as total, which double-subtracted discounts (Net understated on promo days, Net == Total on no-promo days). The rebuild transform additionally mislabelled the VAT amount (`incl − excl`) as the discount.

**How to apply:** for Odoo lines, derive `disc = max(price_unit×qty − price_subtotal_incl, 0)` and set `total = gross = price_subtotal_incl + disc` (this reconstruction keeps `total − disc == charged amount` exactly even under cashier price overrides where `price_unit×qty < incl`). `net_sales_kes` (ex-VAT) stays on the POST-discount amount (`incl / vat`). Any new ingestion path must follow this; verify with `total − disc == price_subtotal_incl` on a discounted order.

**Reporting canon (July 2026):** Odoo loyalty/reward lines now land in `discounts_kes`, so the user-facing "Total Sales" on EVERY surface = `total_sales_kes − COALESCE(discounts_kes,0) − returns` (VAT-incl). All ~50 aggregation sites in api_pg.py (headline KPIs, trends, splits, targets `_TARGET_REVENUE`, report measures, customer spend, CRM spend, ABV/ASP numerators) subtract discounts inside the sale/order CASE. Intentional exceptions: raw feeds (orders-summary `total` with its own discount column, Sales-by-Hour raw sources, per-line exports), net_sales_kes-canon endpoints, price_min/max ticket prices. Any NEW revenue aggregate must use the discount-netted pattern; check with the New+Returning == Total identity.
