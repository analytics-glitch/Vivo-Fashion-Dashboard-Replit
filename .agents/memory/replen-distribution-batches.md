---
name: Replenishment distribution batches
description: How "Save & distribute" freezes the SOR pick list into dated batches and how Done/Outstanding + the live-list filter are derived.
---

"Save & distribute" on the Replenishments page snapshots the current OPEN pick list into a dated server-saved batch (`replen_distribution` + `replen_distribution_line`). The live SOR top list then drops those items and refills with new ones until the next distribute.

**Rules (must hold for the feature to stay coherent):**
- Dispatch-ready replenishment stock means Warehouse Finished Goods only. Finished Goods Production and every other pipeline location are never pickable.
- Frozen assignments remain immutable history, but every read allocates the current Warehouse Finished Goods pool across outstanding lines oldest-first. Show the live pickable quantity separately, block zero-stock lines, and reserve outstanding commitments from new recommendations.
- The live list excludes any `pos|sku` returned in the GET endpoint's `open_keys` (the set still Outstanding in ANY batch). A distributed item lives in its batch, not the live list, until it is picked.
- Per-line Done/Outstanding is DERIVED, not stored: a line is Done when a `recommendation_actions` row (rec_type='replenish', status='done', twin `pos|sku|…` or `pos|barcode|…` rec_key) exists with `acted_at >= batch.created_at`. A stale done from before the batch does NOT count — so re-distributing a recurring item correctly starts it Outstanding again until re-picked.
- The per-day picker scorecard reuses the same batch data: Done counts only lines whose `done_day_eat` (= `acted_at AT TIME ZONE 'Africa/Nairobi'`) matches the selected day; Outstanding is every not-yet-done line across all open batches (day-independent).
- Marking a batch line done writes the SAME twin sku+barcode ledger rows as the live Mark-done flow, so the Completed audit + Transfer Tracking reconcile identically (see replen-done-twin-rows).

**Why:** frozen quantities document what was handed out, not what can still be physically dispatched. Revalidating against one shared live pool prevents pipeline stock or the same warehouse units from being promised to several stores. There is no separate "picked" status column — the recommendation_actions ledger is the single source of truth.

**How to apply:** the WRITE distribution endpoints (`POST /api/replenishment/distribute`, `DELETE .../distributions/{id}`) are roster-manager-gated (`_can_manage_roster` = admin + the two named operators). `GET .../distributions` is open to ANY authenticated user, but a NON-manager (a picker) gets it FILTERED to only their own lines — gating GET fully to managers hid the batch from pickers (they fell back to the live 400-row SOR list = "seeing a different thing / the 400"), and showing ALL owners' lines to every picker was too much.

Per-picker filtering: owners are free-text first names with NO login→owner mapping table, so `_replen_owner_matches_user(owner, user)` matches the WHOLE owner label against concrete identities (full name / first name / email local-part + its first token). Do NOT match on any shared token — a shared surname or generic token leaks another picker's lines. It fails closed. Residual, unavoidable without a real map: two staff with the SAME first name match the same first-name owner. `open_keys` is computed BEFORE this filter (owner-agnostic) so the manager live-list drop-set stays complete; batches with zero lines for a picker are dropped from their response.

Web page: the frontend var `isAdmin` is actually `canManageRoster(user)` (mirrors `_can_manage_roster`), so the LIVE SOR pick list card + its heavy `loadSor` compute + Save-&-distribute/redistribute + BatchCard delete are all restricted to admin + the two allow-listed operator emails in roster.js (those two non-admins CAN distribute). The frontend `openKeys` must be a `useMemo` dependency of `visibleRows` or the live list goes stale when batches change without a `rows` identity change.
