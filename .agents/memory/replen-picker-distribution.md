---
name: Replenishment picker distribution
description: How the replenishment pick list splits work across pickers — equal-LINES rule, and why it's FROZEN (rebalanced only on Save & redistribute) not live
---

# Replenishment pick-list picker distribution

The pick list (`/api/analytics/replenishment-report`) distributes lines across
the picker roster to give each picker **as close to equal LINE COUNT as
possible** (each picker gets roughly the same number of rows, e.g. 118 lines ÷ 4
pickers ≈ 30 each). Rows are ordered by POS location, and a single store **may be
split across more than one picker** when the equal-lines boundary falls inside it.

**Why:** the requirement evolved. It started as "contiguous block of stores by
count", then "whole stores kept together, balanced by units", then "equal units,
stores splittable", and **finally "equal LINES, stores splittable"** — the user
switched the balance metric from pieces (units) to line count because the team
counts work as rows to pick, not total pieces. Because stores stay contiguous the
result is **near-equal, not exact** (e.g. 30/30/29/29), not a hard even split.

**Balance metric = LINES, not pieces.** In `_assign_replen_owners_frozen_then_balance`
every line weighs `1` (not `int(r["replenish"])`): the frozen-load seed, the
`total`/`target`, the LPT store sort key, and the running accumulator all count
rows. To revert to units, restore `int(r.get("replenish") or 0)` at those four
sites. `_replen_by_owner_summary` independently recomputes BOTH lines and units
from the rows, so the workload card still shows real unit totals per picker.

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
- **A single store splits across AT MOST TWO pickers (ideally one).** In the
  non-frozen LPT fill a store switches owner only ONCE — when the current picker
  hits the equal-units target AND another picker is genuinely lighter — then the
  whole remainder of that store stays with the second picker (a `switched` flag
  blocks any third). **Why:** the user rejected one store scattered across 3 pickers
  ("I have a store with 3 pickers"); the earlier re-pick-lightest-on-every-overflow
  loop let a big store touch 3+. **How to apply:** keep the per-store single-switch
  cap; small stores stay whole (1 owner), only stores that overflow a full picker
  split (to exactly 2). Sim: even a deliberately huge store maxes at 2 pickers,
  spread still ~5 units.
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
- **"Workload by picker" card must reconcile with the "Save & distribute (N)"
  button.** The card is computed CLIENT-side over `activeRows` (open, not-yet-
  distributed, not-picked = the exact set the button freezes), NOT from the server's
  `sor.by_owner`. **Why:** `sor.by_owner` counts the FULL engine pick list (every
  row incl. lines already frozen into open batches or already `replenished`), so it
  diverged from both the button count and the visible pick-list table below it
  (which both exclude `openKeys` + `replenished`) — the user saw ~400 lines/765u in
  the card vs (102) on the button. **How to apply:** keep the workload card sourced
  from `activeRows` (mirror `_replen_by_owner_summary`: lines=count, units=Σ
  `replenish`, stores=distinct pos); the card hides when nothing is left to freeze.
- **SOR pick-list endpoint has a whole-result cache** (`/api/analytics/replenishment-sor`).
  The engine `_compute_replenishment_sor` runs several heavy velocity/sell-out CTEs;
  every plain page load / lookback toggle re-ran them (cold ~seconds → "Computing the
  SOR pick list…" spinner hangs). Result is memoised via `cache_get`/`cache_set` keyed
  `replen_sor:{weeks}:{limit}:{EAT-date}` ttl=600, so repeat loads are instant. The
  endpoint takes `nocache=1` to bypass AND refresh; the client (`loadSor`) sends it
  only on `forceFresh` (mutations + explicit Refresh) so the list is never stale after
  an action. **Why:** `run_query`'s per-query cache alone has short smart_ttl for
  today's data, so it didn't cover the repeat-load case. **How to apply:** `datetime`
  the class is NOT imported at module top (only `date, timedelta`) — the endpoint does
  a local `from datetime import datetime as _dt` for the EAT-date key; keep it or it
  NameErrors. Cold-start after a restart is still slow (all caches empty) — that's
  expected, steady-state is cached.
- Owner/`by_owner` decoration is a **post-sizing step each list engine applies
  separately** — there are now TWO replenishment list builders (the SOR engine
  `_compute_replenishment_sor` AND the older `_compute_replenishment_report_rows`
  by-item report). A SOR-first rewrite once silently dropped owners from the SOR
  engine while the by-item report kept them, so the Daily Replenishment page lost
  its roster card. **Why:** ownership is decoration layered after the formula, not
  part of sizing. **How to apply:** any new replenishment list endpoint must
  re-apply `_assign_replen_owners_frozen_then_balance` + emit `by_owner` (via
  `_replen_by_owner_summary`) itself; don't assume it's inherited.
