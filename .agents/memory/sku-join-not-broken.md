---
name: all_sales↔all_products_clean SKU join is sound
description: The variant_sku=sku join matches ~98%; do NOT "fix" it with fuzzy/prefix matching.
---

# The `all_sales.variant_sku = all_products_clean.sku` join is correct

Joining sales to products on `s.variant_sku = p.sku` matches **~97.7% of sale/order
rows** (1,501,083 / 1,537,188) and **~99.5% of distinct SKUs** (64,995 / 65,298).
Units matched ~97%.

**Why this matters:** A recurring (and wrong) diagnosis claims this join "drops
80–90% of rows" because a few sampled `variant_sku` values (e.g. `V0821064LGR2X`)
look unlike a sampled `sku` (e.g. `0819065BLA3X`). That is cherry-picking — most rows
match directly. Stripping a leading `V` prefix makes it **worse** (only ~869K match
vs ~1.50M direct). There is no better join key.

**How to apply:** Do NOT rip the SKU join out of the ~40 endpoints that use it, and do
NOT add prefix-stripping/fuzzy matching. If a product-scoped metric looks low, the
cause is almost always the **`product_type` filter**, not the join: joined
`product_type` covers only ~70% of sales units (and `all_sales.product_type` itself is
~97% NULL — never filter on it). Headline volume KPIs (e.g. canonical units sold) must
sum raw `ordered_item_quantity` under `BASE_FILTERS` with NO product_type/category
filter; only intentional "by subcategory/category" breakdowns should be product-scoped
(and will legitimately exclude the ~30% uncategorized units).
