---
name: Fabric receiving quality + edit invariants
description: Rules for the Fabric Receiving sheet's per-roll quality inspection + admin edit (fabric_router.py / fabric_dashboard_live.html /fabric page)
---

# Fabric receiving quality + edit

Per-roll Quality (status Pass/Fail/Pending/none + notes) is fillable by ANY fabric
user after a sheet is saved; editing rolls/quantities is ADMIN-ONLY (gated in
api_pg's `clerk_auth_gate` by regex on `PUT ^/api/fabric/receiving/\d+$`, not just
client-side).

**Invariant: `roll_no` must be unique per sheet.** The admin PUT rewrites all
rolls (DELETE+INSERT → new roll_ids), so per-roll quality is carried over / matched
by **roll_no**, the stable user-facing key. If roll numbers duplicate, carry-over
overwrites and quality is mis-mapped or lost.
- Enforced in `_recv_parse_rolls` (a `seen` set → 400 on dup) which both create and
  PUT go through. **Enforced in app code, NOT a DB unique constraint** — a hand-made
  DB object auto-migrates to prod on publish and can fail on dirty rows (see
  `dev-only-db-objects-block-publish.md`).

**Admin edit is atomic:** the PUT accepts optional inline `status`/`notes` per roll
and writes rolls + quality in ONE transaction. Do not reintroduce a separate
follow-up POST to `.../quality` from the admin path (an earlier version swallowed
its failure → silent quality loss). Untouched rolls (no status/notes keys) fall
back to previous quality; a roll with an explicit edit re-stamps who/when via
`COALESCE(pass-through_at, now())`.

The standalone `POST .../quality` (non-admin path) keys by `roll_id` (stable, rolls
not rewritten) with a roll_no fallback that is only safe because of the uniqueness
invariant above.

All interpolated fields in the modal/print HTML go through `esc()` (see
`fabric-dashboard-xss.md`).
