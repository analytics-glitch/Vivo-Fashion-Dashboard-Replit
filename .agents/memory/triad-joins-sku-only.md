---
name: all_sales / all_inventory / all_products_clean join key
description: Any join between the three core tables must go through SKU (or barcode), never style_name.
---

**Rule (user-mandated):** any join between `all_sales`, `all_inventory`, and `all_products_clean` MUST be on SKU (`s.variant_sku = p.sku`, `i.sku = p.sku`; barcode is an acceptable alternate key). Never link these tables on `style_name` or any other name field.

**Why:** ~16,700 `all_inventory` rows (~37k units) carry a BLANK `style_name` (the extract does not always populate it), so an `i.style_name = <style>` predicate silently drops stock — this zeroed the Product Analysis style-detail popup's per-location stock while SKU-joined surfaces showed correct figures. Sales-side name joins have the same hazard plus casing/renaming drift.

**How to apply:**
- Reach inventory/sales for a style by expanding the style to its SKUs via `all_products_clean` first (semi-join or direct sku join — master has 0 duplicate SKUs, so no fan-out).
- Style-grain rollup joins (`agg_a.style_name = agg_b.style_name`) are fine ONLY when both sides derived `style_name` from the master via SKU.
- Take dim values (size, color_print, brand…) from the master, not from `all_inventory`'s copies (blank/UPPERCASE drift).
- Fan-back joins from non-triad tables (e.g. `ibt_completions.style_name → all_products_clean.style_name → skus`) are acceptable — completions are style-grain by design.
