---
name: Gift voucher reporting vs extraction
description: Where gift-card/voucher filtering lives — raw extract keeps them, reporting excludes them (BigQuery pattern)
---

# Gift vouchers: keep in raw extract, exclude in reporting

**Rule:** The Shopify extractor (`shopify_sales_extractor.py` → `shopify_sales`) is a faithful port of the BigQuery "Shopify Sales Extractor" and intentionally has **NO gift-card/voucher filter** — every line item (including "VIVO Gift Voucher") becomes an `order` row, and refunds become `return` rows. Gift vouchers are excluded only **downstream at reporting time**, in `api_pg.py` `BASE_FILTERS`.

**Why:** This is exactly how BigQuery does it (raw table keeps everything; dashboards filter). A voucher line and its offsetting exchange-return are a matched pair (+X order / −X return); dropping the voucher in extraction while keeping the exchange returns would understate that order's net. Keeping both in raw and filtering vouchers only in reporting preserves net correctness AND clean reported sales.

**Reward-carrier exception (July 2026):** Odoo loyalty/reward lines (titles like "15% on specific products") are pure discount carriers — zero total, zero units, discount only. `BASE_FILTERS` must let these through (guarded OR: title match allowed only when total=0 AND units=0 AND discounts≠0), or the discount-netted Total Sales silently reverts to gross−returns on every dashboard. Gift card/voucher redemptions stay excluded — a voucher redeemed is a payment method, not a discount.

**How to apply:**
- `BASE_FILTERS` in `api_pg.py` must exclude BOTH `'%gift card%'` AND `'%gift voucher%'`. The real titles are "VIVO Gift Voucher" style, which the `'%gift card%'` pattern does NOT catch — that gap silently let a large block of voucher "sales" into `all_sales` reporting until both patterns were filtered.
- `transform_all_products_clean.py` and `sync_incremental.py` already filter both patterns — keep all reporting/transform layers consistent (both patterns) and never add a gift filter to the raw extractor.
- A BigQuery export of a single order that lacks the voucher/returns is usually a **snapshot-timing** difference (voucher + returns appear with a later exchange/refund), not a logic difference — our raw extract is just fresher.
