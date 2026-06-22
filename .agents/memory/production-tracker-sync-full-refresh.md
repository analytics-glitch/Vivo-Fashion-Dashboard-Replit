---
name: Production Tracker sync is a full refresh + must prune
description: Why sync_production_tracker.py must delete stale colour lines / size variants, and where Odoo holds per-size data.
---

# Production Tracker sync — full refresh, prune-or-drift

`sync_production_tracker.py` re-fetches **every** buying order + its lines + size
variants from Odoo each run (not incremental). It upserts into
`production_orders` / `production_order_lines` / `production_order_variants`.

**Rule:** after upserting lines and variants, it MUST prune rows whose Odoo id is
no longer in the fetched set (`prune_lines` by `odoo_line_id`, `prune_variants`
by `odoo_variant_id`). Both are guarded to skip when their fetched set is empty
so a degenerate/failed fetch can't wipe the table; the whole thing is one
transaction so any error rolls back.

**Why:** upsert-only (`ON CONFLICT DO UPDATE`) never removes rows deleted upstream
in Odoo, so a colour/size dropped from a BO would linger and inflate the
Production Report's per-order colour/size counts and the cross-order roll-ups
above Odoo truth over time. Caught in code review.

**How to apply:** any new table this sync writes (or any new "re-fetch all then
upsert" sync) needs the matching prune step keyed on the upstream id.

## Where per-size data lives in Odoo
Sizes are NOT on the colour line. Each `vivo.buying.order.line` has
`variant_line_ids` → `vivo.buying.order.line.variant`, whose `product_id` label
is `[SKU] Style - Colour (SIZE)` (e.g. `(L/1X)`, `(S/M)`) plus `qty`. SKU = inside
`[...]`, size = trailing `(...)`. ~4–5% of variants have no parseable trailing
size → stored as NULL; the report's "sizes" count and the modal's size badge both
exclude NULL (`COUNT(DISTINCT size)` / `.filter(Boolean)`), while the colour×size
matrix still shows a `—` column for them.
