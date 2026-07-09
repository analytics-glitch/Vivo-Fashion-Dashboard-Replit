---
name: Product category mapping single source
description: all_products_clean.category derives from CATEGORY_MAP (sub_category → category); missing subcats = blank category on every surface.
---

`all_products_clean.category` is NOT copied from Odoo's raw `category` column — it is derived from `sub_category` via `CATEGORY_MAP` in `transform_all_products_clean.py`. Any Odoo subcategory absent from the map yields a blank category everywhere (Store Gaps, PA, exports…).

**Why:** 12 real subcats (Short & Mini Skirts, Men's Tops/Bottoms, jewellery, sets…) were missing → whole styles showed no category.

**How to apply:** the two SQL category-sync UPDATEs are now generated from `CATEGORY_MAP` (`CATEGORY_CASE_SQL`) — add new subcats ONLY to the dict, never to hand-written SQL. Remaining blanks (~43k) are legacy sales-only SKUs not in Odoo at all — expected. Prod self-heals: the sync loop reruns the transform nightly, so a publish ships the fix without a manual prod step.
