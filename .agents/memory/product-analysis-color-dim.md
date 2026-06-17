---
name: Product Analysis colour dim
description: Colour is a row-explosion dim in /api/analytics/product-analysis; the "blank Colour" bug is an inventory join-key mismatch, NOT a reason to aggregate
---

# Colour is an explosion dim — each colour is its own row

In Product Analysis the user EXPECTS one row per colour (colour is in the
frontend `DIM_KEYS` along with print/size/pos_location). Do NOT "fix" a blank
Colour column by removing colour from the dims and string_agg-ing it into one
cell — that produces "Black, Navy Blue" in a single row, which is the WRONG
behaviour. The user wants each colour as a separate row.

## The real "blank Colour" bug (inventory join-key mismatch)
When colour is exploded, the prod + sales CTEs key colour off
`all_products_clean.color_print` (Title Case, e.g. "Black"), but the stock CTE
used `all_inventory.color_print` directly — which is ~93% NULL and UPPERCASE
where present ("BLACK"). The `USING(style_name, color)` join then collapsed and
`activity_where` (soh>0) dropped almost everything, leaving ~13 "(none)" rows.

**Fix:** derive the stock colour from the product master via sku
(`need_stock_pc` → `JOIN all_products_clean pc ON pc.sku=i.sku`, use
`pc.color_print`), exactly like `print` already does. Then all three CTEs share
one consistent colour key and explosion returns real colours (3599 rows, 0
blank). `all_inventory` has no reliable colour/print of its own — always join
through the product master for those dims.

**Why:** `all_inventory.color_print` and `all_products_clean.color_print` are
formatted differently and inventory's is mostly NULL; never join sales/stock to
products on raw colour/print strings.

## Primary Color (AI) field
`_primary_color_map()` maps each style's colour tokens onto a fixed palette:
in-process memo -> persistent `color_primary_map` table -> deterministic keyword
rules -> ONE batched `_chat_llm` call for the long tail. Persists results, never
raises. When colour is exploded each row has one colour -> one primary; when
aggregated it maps each token and joins ("Black, Blue").

## Third Party exclusion
Product Analysis excludes the "Third Party" brand via `NOT ILIKE '%third party%'`
in BOTH the prod and sales CTEs (rollups derive from rows, so they cascade).
