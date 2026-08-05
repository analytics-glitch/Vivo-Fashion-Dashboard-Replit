---
name: Style picker tolerant matching
description: Own-style names carry whitespace quirks & multiple style numbers; match normalized, store byte-identical canonical names.
---

# Style picker tolerant matching (fabric reservations + costing)

**Rule:** The strict own-style pickers (reservation form, costing sheet creator) and their server-side validation must match case-insensitively and whitespace-normalized (collapse runs, NBSP→space), with every typed token matching the style name or ANY of the style's numbers — but what is stored must stay the byte-identical canonical `all_products_clean.style_name` row.

**Why:**
- ~14 own styles have double spaces or non-breaking spaces baked into their canonical names (e.g. "Vivo  Arusha Wide Drop Shoulder Maxi Dress"); typed single-space input can never substring-match them.
- ~230 styles carry multiple style numbers across their SKUs (e.g. SAF10BT/SAF10GR/SAF10WH on one style); the universe's modal `style_number` is only one of them — searching another real number found nothing until all numbers were exposed for matching (`style_numbers` array in the universe SQL).
- Canonical names are join keys elsewhere (costing sheets, DPS/MO lookups, reservations register) — never "clean" or normalize what gets written.

**How to apply:** Any new style typeahead or style-name validation must reuse the shared matcher/normalizer in `fabric_router.py` (`_style_norm`, `_style_search_rows`, `_match_style`) rather than a naive contiguous-substring check. Rank exact/prefix over token hits so the result cap doesn't bury the target. The cached universe rows are shared (run_query cache) — build parallel indexes, never mutate rows.
