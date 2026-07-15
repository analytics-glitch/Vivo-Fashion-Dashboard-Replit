---
name: Fabric receiving quality + edit invariants
description: Rules for the Fabric Receiving sheet's per-roll quality inspection + admin edit (fabric_router.py / fabric_dashboard_live.html /fabric page)
---

# Fabric receiving quality + edit

**One receiving sheet per PO (DB-enforced).** A PO-level sheet row (UNIQUE
po_id) owns per-product SECTIONS; rolls hang off the sections. ALL write paths
(including the legacy create endpoint) must go through the shared append flow,
which serializes the whole PO under a transaction-scoped advisory lock and
assigns roll numbers server-side (progressive per product per PO, legacy rows
counted). Never assign roll numbers client-side and never insert a section
without linking it to the PO sheet, or the one-sheet invariant silently breaks.
**Why:** a per-fabric-per-delivery model fragmented one PO into many sheets;
the reviewer-mandated fix is PO-level identity with sections as children.

**Upload locks rolls.** After a successful Odoo upload, roll add/edit/delete
and sheet edit/delete are ADMIN-ONLY; every mutation is audited (with an
after-upload flag) and surfaced as a change log merged with upload history.
Per-roll Quality stays open to everyone at all times. Re-upload is allowed
only while the Odoo PO is still Draft (server-checked live).

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

**Quality changes are audited** (`quality_updated` rows in fabric_recv_audit with
roll_no, old→new status/notes, after_upload flag) on BOTH the standalone POST and
the admin PUT's inline quality edits — but ONLY when something actually changed
(no-op saves must not write audit rows or bump who/when).

All interpolated fields in the modal/print HTML go through `esc()` (see
`fabric-dashboard-xss.md`).
