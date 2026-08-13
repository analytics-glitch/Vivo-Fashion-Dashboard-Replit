---
name: Colourway key noise & display tidy
description: color_print values carry "X - X / stylecode / size" noise; how to display them without breaking data keys.
---

Some `all_products_clean.color_print` values embed product-name noise: `"<colour> - <colour> / <style code> / <size>"` (e.g. `"Hunters Green - Hunters Green / V0323019 / L"`, `"Mustard / 0819102 / F"`). Style codes may be letter-prefixed (`V0323019`, `Avalbps001`); size tokens include `F`, `Xl`, `1X`, `S/M`. Crucially, a single style can contain BOTH a clean key (`"Mustard"`) and noisy twins (`"Mustard - Mustard / 0819102 / F"`) as *distinct colourway rows* — they are different keys, not duplicates to merge.

**Rule:** tidy labels for display only (strip trailing digit-bearing/size tokens, collapse `X - X` → `X`), keep the raw value as the data key everywhere (tooltips, drill-down params, API round-trips), and when two rows tidy to the same label, fall back to showing the raw label so bars stay distinguishable. Genuine two-colour names (`"Navy / White"`, `"White / Mint Sinka Print"`) must survive — only strip from the END of the segment list.

**Why:** merging or rewriting keys client-side silently conflates distinct SKU groups and breaks per-colour drill-downs; the Style Deep Dive colourway charts use exactly this display-tidy + collision-fallback pattern (`tidyColorLabel` in MerchDeepDive.jsx).

**How to apply:** any surface listing colourways (drill-downs, exports, RM/PA colour views) should reuse this approach until the noise is fixed at the data source (transform-level canonicalization — see product-color-name-authoritative.md: colour derives from the product NAME).
