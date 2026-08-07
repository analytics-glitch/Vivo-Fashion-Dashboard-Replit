---
name: Costing style alias fold + union SKU scope
description: Renamed styles (canonical master name vs raw-Odoo name) must stay pickable in Product Costing — fold-by-style_number aliases + union style→SKU resolution.
---

**Rule:** in the costing style universe, a raw-Odoo entry that shares a style_number with an `all_products_clean` entry is folded into it: the raw name survives only as a searchable alias, ranked below primary-name hits, and matching an alias returns the canonical row (stored names stay byte-identical canonical — they are join keys across the BI). Style→SKU/colour resolution must union the product master (by name) with `raw_odoo_products` (same derived-name rule), with colour falling back to the LAST " - " segment of the raw product name (never the first — "Off - Shoulder").

**Why:** `all_products_clean` canonicalizes one dominant name per style_number while raw Odoo keeps original names. A name-deduped universe showed the same physical style twice, and master-only SKU joins made the raw-named twin — and brand-new not-yet-rebuilt styles — resolve zero SKUs: "No Done DPS found" despite done MOs.

**How to apply:** any costing/DPS/reservation surface resolving style→SKUs goes through the shared scope helper, never a master-only name join. Selling price stays master-only (raw-only styles legitimately price as None pre-production).

**Accepted gap:** a brand-new raw-Odoo colourway of a renamed style (its derived name equals the alias) is invisible from the canonical entry until the nightly rebuild absorbs its SKUs — the scope matches raw rows by canonical name, not aliases.
