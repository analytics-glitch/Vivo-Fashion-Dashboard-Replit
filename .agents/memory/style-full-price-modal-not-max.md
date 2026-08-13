---
name: Style full/ticket price = mode, not MAX
description: Why style-level "full price" is the modal SKU price, not MAX(price)
---

# Style full/ticket price must be the MODAL price, not MAX(price)

Rule: any style-level "full price" / "original price" derived from
`all_products_clean.price` across a style's SKUs must use
`mode() WITHIN GROUP (ORDER BY price) FILTER (WHERE price > 0)`, NOT `MAX(price)`.

**Why:** the product master carries a foreign-currency leak on a handful of
country SKUs — a style's KES ticket price is duplicated as a raw local-currency
value on some Uganda/Rwanda SKUs (e.g. a 5,550 KES poncho had two SKUs at
181,000). `MAX(price)` surfaces that outlier as the "full price". This is
**prod-only**: dev's `all_products_clean` was clean (all 5,550 or 0) while prod
had the 181,000 rows — so the bug is invisible in dev and only shows on the
published app. Prod scan: ~1,795/3,615 styles had `MAX != mode`, 719 had
`MAX > 3x mode` (widespread contamination). Mode is immune unless the majority
of a style's SKUs are contaminated.

**How to apply:** three surfaces in `api_pg.py` use this (all switched to mode):
Product Analysis `prod` CTE (`full_price`), Range Management `prod` CTE
(`price` → `original_price`/`full_price_pct`), and the catalog SOR-report `prod`
CTE (`original_price`). PA & RM must stay aligned (shared `full_price_pct`
definition). For the PA "Price Range" column, `price_min` uses
`MIN(price) FILTER (WHERE price>0)` and `price_max` is clamped in Python to
`full_price` when `price_max > full_price * 3` so the range top can't surface the
outlier either. `mode()` is a valid ordered-set aggregate inside these GROUP BY
queries alongside the other aggregates; the pa_style rollup path shares the same
prod CTE so it is covered too.

**Colourway grain (Deep Dive style-colors feed):** the same modal rule applies
per colourway — `merch_router._fetch_style_colors` computes `full_price` as the
mode over that colourway's SKUs.

**ASP-vs-full-price comparisons:** ticket/full prices are VAT-inclusive, so any
"ASP as % of full price" metric must use a VAT-inclusive, discount-aware
realized ASP — `SUM(total_sales_kes − discounts_kes) / units` — never the
ex-VAT net-sales canon (`NET_SALES_CANON`). The 1.16/1.18 VAT divisor alone
would put every item ~14–15% under ticket, making thresholds like "ASP > 90% of
full" unreachable.
