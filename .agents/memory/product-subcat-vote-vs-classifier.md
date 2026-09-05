---
name: Product subcat vote vs per-cycle keyword classifier
description: Why style subcategories went mixed daily and how the transform vote must fill NULLs to stay stable
---

Two writers shape `all_products_clean.product_type` and they must be reasoned about together:

1. **Nightly transform** (`transform_all_products_clean.py`): staged atomic rebuild. Sales-only SKUs
   (sold historically, no longer in Odoo — e.g. legacy un-prefixed SKUs like `0819102BLAF` vs live
   `V0819102BLAF`) insert with `product_type NULL`. The "dominant subcat per style_number" vote then
   runs — with live-preference (rows `active IS TRUE` decide when the style has any; all-rows vote
   otherwise) — and MUST also stamp NULL-subcat rows with the winner.
2. **Per-cycle keyword classifier** (`sync_incremental.categorise_products`, every ~1-min cycle):
   fills `product_type IS NULL` from product-NAME keywords. Rule order matters: `%wrap%` → Scarves
   fires before `%poncho%` → Sweaters & Ponchos, so "Wrap Poncho" styles get Scarves.

**Why:** if the vote leaves sales-only rows NULL, the classifier re-labels them within minutes,
recreating a mixed-subcat style (e.g. 26 keyword-Scarves vs 12 live S&P). Merch endpoints compute
subcategory as per-SKU `mode()`, so the majority of stale rows flips the visible subcategory —
daily, no matter what the vote decided. Filling NULLs with the style winner starves the classifier
(nothing left to label) and keeps the style uniform between rebuilds.

**How to apply:** any change to the vote must keep the NULL-fill target predicate
(`product_type IS NULL OR NOT IN (Sample/Gift)`) in BOTH the main vote and the final consolidation
loop. Vote SOURCE stays non-NULL rows only. Styles with no genuinely-labelled rows at all stay NULL
and remain classifier territory (intended). When debugging "wrong subcategory that comes back after
a rebuild", suspect the classifier's keyword defaults (`ELSE 'Accessories'`) polluting the vote base
— compare only complete generations; the live table no longer exposes the NULL-heavy pre-vote
stage while a rebuild is in progress.
