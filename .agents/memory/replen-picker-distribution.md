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
  (read; self-seeds once if unset), `_assign_replen_owners_frozen_then_balance`
  (per-GET assignment: frozen map first, balance the rest), `_replen_by_owner_summary`.
- **Drift fallback = STORE-CONTIGUOUS, not per-line least-loaded.** A line NOT in
  the frozen map (the view window includes today → lines grow intraday → most lines
  drift off a morning save) is NOT balanced individually — that scatters one store
  across every picker, which the user explicitly rejected ("one store should have
  one owner unless we need the next store to balance; sort by stores first, fill an
  owner until enough, then proceed"). Final shape = **LPT least-loaded seeded with
  the frozen loads**: frozen lines never move; ALL non-frozen lines (intraday drift
  + brand-new stores) are balanced by units, largest store first onto the currently
  LIGHTEST picker, a store kept WHOLE on that picker until it reaches the
  equal-units target then the remainder spills to the next-lightest (split only
  when needed). A partly-frozen store keeps drifting onto its existing (dominant)
  owner only while that owner is still under target. **Why:** the prior "drift →
  store's dominant frozen owner, ALWAYS" rule piled every intraday line onto
  whoever already owned the store, so heavy pickers grew heavier and the real card
  drifted to a ~39-unit spread (Emma 192 / Matthew 153) by midday — sequential
  forward-only quota-fill couldn't claw it back because it never revisits an
  earlier, lighter picker. Seeding LPT with the frozen loads fixes both: sim
  all-new/all-frozen spread 1, frozen+drift spread ~5 with only boundary stores
  split. The ONLY residual imbalance is when the frozen map ITSELF is lopsided
  (can't reshuffle saved work) — but the save-time `_assign_replen_owners_by_units`
  is equal-units, so a fresh "Save & redistribute" always resets it. **How to
  apply:** both Daily report AND SOR go through
  `_assign_replen_owners_frozen_then_balance` (SOR `presort=False` keeps `_rank`;
  Daily POS-sorts). Do NOT reintroduce "drift always follows the frozen owner" — it
  is what unbalanced the card; balance non-frozen by least-loaded instead.
- **Redistribute MUST balance over the window the page actually displays**, or the
  per-picker units come out lopsided even though the balancer is equal-units.
  **Why:** the Daily page (`Replenishments.jsx`) defaults its window to
  yesterday→today and reads `/api/analytics/replenishment-report?date_from/to`. The
  roster card saves via `POST /api/admin/replenishment-config`, which used to call
  `_redistribute_replen_owners(owners)` with NO dates → it froze the balance over
  the **default 30-day** window. The displayed 1–2-day subset then missed most
  frozen line keys and fell back to whole-store ownership (`store_fallback`),
  reproducing the old uneven split (e.g. 314 vs 142 units). **How to apply:** the
  roster card now forwards the page's `dateFrom`/`dateTo`; BOTH roster POSTs
  (`/api/admin/replenishment-config` AND `/api/replenishment/roster`) re-validate
  via `_pa_safe_date` and thread them to `_redistribute_replen_owners` →
  `_compute_line_owner_map`. Keep the redistribute window == the display window
  (same default `limit=400` too) so every displayed line hits the frozen map.
  The IBT card mounts the same component without dates (it uses the whole-store
  map, not the line map) — that's fine, absent dates → backend default window.
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
  re-apply `_assign_replen_owners_frozen_then_balance` + emit `by_owner` (via
  `_replen_by_owner_summary`) itself; don't assume it's inherited.
