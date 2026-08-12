---
name: Colour-style status is derived
description: Product rule for colour-style (style × colour) lifecycle status — derived, never stored; how Active Colour Styles must be counted on any surface.
---

# Colour-style status is derived — no stored status field

**Rule:** a colourway (style × colour) is **Active** iff BOTH:
1. its parent style is Active (computed tier ∈ Tier 1–4), AND
2. that specific colour has inventory (stores + sellable-warehouse SOH > 0, same scoping as the style-level stock basis).

Everything else is treated as retired: a zero-stock colourway under an Active style is "retired", and a style Retired/Archived at STYLE level cascades — ALL its colourways are retired regardless of their stock. An Active style can legitimately have some or even zero Active colourways.

**Why:** user decision (Aug 2026, Merch Overview card rework). There is deliberately NO colour-level status column — the two options considered were "derive from parent status + inventory" vs "add a stored status field with rules"; derive won because the stated rules are fully determined by existing data, so a stored field would only be a cache to keep in sync. If manual per-colour overrides are ever needed, add the field then.

**How to apply:** any surface counting "active colour styles" must count in-stock colourways of Active-tier styles only (product-master colour via SKU join, never all_inventory's colour column), not COUNT(DISTINCT color_print) over the product master. Reference implementation: merch summary's per-style in-stock-colourway count summed inside the Active-tier deduped branch.
