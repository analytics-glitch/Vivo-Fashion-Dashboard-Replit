---
name: Product Analysis colour column
description: Why colour must be an aggregated display column, not a row-explosion dim, in /api/analytics/product-analysis
---

# Colour in Product Analysis must be aggregated, not exploded

`all_products_clean.color_print` is sparse per-SKU (many blanks). When colour is
sent as an explosion `dim` to `/api/analytics/product-analysis`, the GROUP BY
produces a dominant `'(none)'` bucket and the Colour column reads blank/"(none)".

**Rule:** keep colour OUT of the frontend `DIM_KEYS` so it stays a plain
aggregated display column. The backend `_disp("color")` already does
`string_agg(DISTINCT NULLIF(TRIM(color_print),''), ', ')` when colour is not in
the selected dims — that path returns the real colours.

**Why:** explosion = GROUP BY on a sparse column = a giant empty bucket;
aggregation collapses a style's non-blank colours into one cell.

**How to apply:** if asked to "show colour" or "fix blank colour" on Product
Analysis, do NOT add colour to dims. Print/size/pos_location are fine as dims.

## Primary Color (AI) field
`_primary_color_map()` maps each style's aggregated colour tokens onto a fixed
palette: in-process memo -> persistent `color_primary_map` table -> deterministic
keyword rules -> ONE batched `_chat_llm` call for the long tail. Persists results
so the LLM is consulted at most once per distinct colour ever; never raises
(falls back to deterministic/"Other"). Too many distinct colours (~5.6k) for a
per-request LLM call, so caching is essential.

## Third Party exclusion
Reporting on Product Analysis excludes the "Third Party" brand via
`NOT ILIKE '%third party%'` in BOTH the prod and sales CTEs (rollups are derived
in Python from rows, so they cascade automatically).
