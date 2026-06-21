---
name: Fabric consumption/moves are fabric-only
description: Fabric page consumption & movement figures must count category='Fabric' products only — trims (even in kg) and unmatched products are excluded.
---

# Fabric consumption & moves = fabric only

The Fabric page consumption and movement (out_kg) figures must represent **fabric
weight only**. Two distinct contaminants must be kept out:

1. **Non-weight UOMs** — trims/accessories logged in `Pcs`, `m`, etc. Handled by the
   long-standing `uom IN ('g','kg')` filter (grams ÷ 1000).
2. **Trims that happen to be logged in kg** — buttons/elastic/etc. recorded with a kg
   UOM. The UOM filter does NOT catch these; they're only distinguishable by the
   product master classification.

**Rule:** count a move only when its product is classified `category = 'Fabric'` in
`raw_fabric_products` (the master has exactly two categories: `Fabric` ≈2021,
`Trim` ≈667). Unmatched/unknown products (NULL category) are treated as NOT fabric.

**Why:** Without this, e.g. June 2026 fabric consumption read ~10,030 kg incl. 389.6 kg
of Trim rows logged in kg; and an all-UOM sum (wrong) showed 91,418 because 81,388
*pieces* of trims were added as if kg. Correct fabric-only June ≈ 9,641; May ≈ 19,557.

**How it's implemented (single chokepoint = the view):** `fabric_moves_effective`
carries an `is_fabric` boolean column:
- raw Odoo rows → `(raw_fabric_products.category = 'Fabric')` via LEFT JOIN on product_id
- **sheet override rows (Jan–Apr 2026) → always `TRUE`** — the buying team's reconciled
  sheet is fabric by definition; if you filtered sheet rows by category you'd drop
  barcode-unmatched lines and break the verified reconciled totals
  (6586/15659/17789/13059).

Every consumption read filters via `_net_cons_where` (which appends `AND <alias>.is_fabric`);
`/api/fabric/movement-flow` adds `WHERE is_fabric` directly. Any NEW consumption/moves
read MUST go through `_net_cons_where` or include `is_fabric`, or trims creep back in.

**Out of scope / separate issue:** movement-flow `internal_kg` is still huge (hundreds of
millions of kg) — those are RMAT/Stock ↔ Virtual-Inventory stock-count/revaluation
adjustment artifacts on fabric products, not real movement. Not addressed here.
