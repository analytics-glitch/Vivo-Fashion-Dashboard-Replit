---
name: Replenishment picker distribution
description: How the replenishment pick list splits work across pickers — equal-units rule, and why it's FROZEN (rebalanced only on Save & redistribute) not live
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
- Balancing is `_assign_replen_owners_by_units(rows, owners)`: sort by
  (pos_location, sku, barcode) → contiguous store lines → greedily advance the
  picker on cumulative `i*(total/k)` unit thresholds. Spread between pickers is
  bounded by the largest single line's units (small), so it's near-even.
- The result is **FROZEN**, NOT live. It must be recomputed ONLY by the explicit
  "Save & redistribute" action. **Why:** if it rebalanced on every GET, a picker
  who finished their lines and refreshed the page would be handed new work — the
  user explicitly rejected that. The balance is persisted as a per-line
  `{store|sku: owner}` map in app_config (`replenishment_line_owner_map`) and the
  report reads it on every load, so a reload never reshuffles. Helpers:
  `_compute_line_owner_map` (balance the current window), `_replen_line_owner_map`
  (read; self-seeds once if unset), `_owner_for_line` (frozen lookup).
- Drift (a line added since the last redistribute, not in the frozen map) →
  that store's main picker (dominant owner in the map), else a stable md5 hash of
  the line key over the roster. Both are reload-stable; no row is ever "—".
- "Save & redistribute" (`POST /api/replenishment/roster`) must compute the line
  map over the **window the operator is viewing** — the roster card sends
  `date_from`/`date_to`; the POST re-validates them (`_pa_safe_date`, they reach
  SQL) and passes them to `_redistribute_replen_owners`. It also still recomputes
  the store→owner map for the sibling surfaces below.
- The frozen store→owner map (`_compute_store_owner_map`, `_owner_for_store`,
  `replenishment_store_owner_map`) is still used by the sibling single-SKU /
  single-style surfaces (replenish-by-item, replenish-gaps) and IBT owner
  decoration — leave those on store-level ownership.
- Per-owner summary (`summary.by_owner`) and the client-side per-owner PDF both
  read row-level `r["owner"]`, so any new owner logic must set it on every row.
  Every row always gets a real picker (never "—").
- Prod is a separate DB; the new logic ships with code on publish and is live
  immediately (no data migration / redistribute needed for balance).
- Owner/`by_owner` decoration is a **post-sizing step each list engine applies
  separately** — there are now TWO replenishment list builders (the SOR engine
  `_compute_replenishment_sor` AND the older `_compute_replenishment_report_rows`
  by-item report). A SOR-first rewrite once silently dropped owners from the SOR
  engine while the by-item report kept them, so the Daily Replenishment page lost
  its roster card. **Why:** ownership is decoration layered after the formula, not
  part of sizing. **How to apply:** any new replenishment list endpoint must
  re-apply `_owner_for_line` + emit `by_owner` itself; don't assume it's inherited.
