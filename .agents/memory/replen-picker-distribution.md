---
name: Replenishment picker distribution
description: How the replenishment pick list splits work across pickers (the rule, and why it's live per-report instead of a frozen store map)
---

# Replenishment pick-list picker distribution

The pick list (`/api/analytics/replenishment-report`) distributes lines across
the picker roster to give each picker **as close to equal total UNITS as
possible**. Rows are ordered by POS location, and a single store **may be split
across more than one picker** when the equal-units boundary falls inside it.

**Why:** the requirement evolved. It started as "contiguous block of stores by
count" (very uneven units), then "whole stores kept together, balanced by units"
(still uneven because a store is indivisible and store sizes vary a lot), then
finally "equal units, stores splittable" — the user prioritised even units over
keeping a store with one person.

**How to apply:**
- Assignment is `_assign_replen_owners_by_units(rows, owners)`: sort by
  (pos_location, sku, barcode) → contiguous store lines → greedily advance the
  picker on cumulative `i*(total/k)` unit thresholds. Spread between pickers is
  bounded by the largest single line's units (small), so it's near-even.
- It is computed **live on every report GET** from the current roster — there is
  NO frozen owner map for the pick list, so a refresh always rebalances. "Save &
  redistribute" only updates the **roster owners list** (names/count); it is not
  needed to rebalance the pick list.
- The frozen store→owner map (`_compute_store_owner_map`, `_owner_for_store`,
  `replenishment_store_owner_map`) is still used by the sibling single-SKU /
  single-style surfaces (replenish-by-item, replenish-gaps) and IBT owner
  decoration — leave those on store-level ownership.
- Per-owner summary (`summary.by_owner`) and the client-side per-owner PDF both
  read row-level `r["owner"]`, so any new owner logic must set it on every row.
  Every row always gets a real picker (never "—").
- Prod is a separate DB; the new logic ships with code on publish and is live
  immediately (no data migration / redistribute needed for balance).
