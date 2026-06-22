---
name: Displayed product name source
description: Where any user-facing product name must come from in the BI backend.
---

Every displayed product name in the BI must be sourced from the `all_products_clean` master (joined by SKU), NOT from raw `all_sales.product_title` or raw `all_inventory.product_name`.

Canonical pattern at each SELECT that surfaces a name:
`COALESCE(NULLIF(p.product_name, ''), <raw>) AS <alias>` where `p` is the existing `LEFT JOIN all_products_clean p ON ...sku = p.sku`. Keep the output alias unchanged (`product_name` / `product_title`) so the frontend keeps working.

**Why:** Kenya products come from Odoo with clean separate fields, but Uganda/Rwanda/Online come from Shopify/Shop Zetu as ONE concatenated title that gets text-split — Online's title is code-first (`Vivo Leila Dress - 0819136 / GREEN / M`) vs retail colour-first, so the raw title parses colour wrong/blank and sometimes carries stale wording ("Vivo Basic Val Cap..." vs clean "Vivo Val Cap..."). `all_products_clean.product_name` is clean name+colour for all rows; `style_name` is name-only.

**How to apply:** When adding/editing any endpoint that returns a product name, never emit `s.product_title` or `i.product_name` directly — wrap with the COALESCE pattern. Fallback is only hit for SKUs absent from the master (NULL/unmatched Online, gift vouchers, shopping bags). Most analytics endpoints already use clean `p.style_name`; the leak sites were the inventory, orders, SKU-velocity, warehouse-return-candidates, replenish (by-item/by-style/main), replenishment-accuracy and replenishment-export endpoints. If you COALESCE inside a grouped SELECT, the GROUP BY must repeat the same COALESCE expression.
