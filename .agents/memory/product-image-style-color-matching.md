---
name: Product image matching is style+colour, not per-SKU
description: Why the image endpoints expand a SKU to its style+colour siblings before looking up photos.
---

Both image endpoints (`/api/product-images/{sku}` Shopify gallery, `/api/product-image/{sku}` Odoo single) resolve imagery at **style_name + color_print** level, not the exact SKU.

**Rule:** a request for one SKU returns the union of every sibling SKU that shares the same `style_name` + `color_print` (looked up in `all_products_clean` via `_style_color_skus`), exact-SKU rows ordered first, de-duped by URL. Each candidate is also tried with/without a leading `V` (`_with_v_variants`) because catalog vs Shopify disagree on the V-prefix.

**Why:** the image tables (`product_image_urls`, `product_image_map`) are keyed by variant SKU, so size variants of the same style+colour otherwise showed inconsistent or missing photos — a size whose own SKU had no image fell straight to the placeholder even when the style+colour clearly had photos. The frontend only knows the SKU in the tree/finder, so the style+colour expansion must happen server-side.

**How to apply:**
- Fallback chains stay: gallery (non-empty) → Odoo single → placeholder.
- Keep both lookups deterministic: `_style_color_skus` ends with `ORDER BY sku`, and the Odoo single-image query tie-breaks `ORDER BY (m.sku = %s) DESC, m.sku ASC` — without these, the same style+colour can resolve different Odoo images across sizes/calls.
- Expansion only triggers when both style_name and color_print are non-blank; otherwise it falls back to `[sku]` (original per-SKU behaviour), so it never over-broadens on missing catalog data.

For Assortment Plan style-level images, Odoo photos must be extracted from **every product variant**, not one arbitrary representative variant. Prefer a photographed in-stock variant, then use stable SKU order.

**Why:** some templates' initially selected variants have no image even though most sibling variants are photographed; representative-only extraction creates false placeholders.

**How to apply:** keep the image cache populated from all variants and make style-level lookup exact on Odoo style number, stock-first, then SKU.
