---
name: Replenishment distribution batches
description: How "Save & distribute" freezes the SOR pick list into dated batches and how Done/Outstanding + the live-list filter are derived.
---

"Save & distribute" on the Replenishments page snapshots the current OPEN pick list into a dated server-saved batch (`replen_distribution` + `replen_distribution_line`). The live SOR top list then drops those items and refills with new ones until the next distribute.

**Rules (must hold for the feature to stay coherent):**
- The live list excludes any `pos|sku` returned in the GET endpoint's `open_keys` (the set still Outstanding in ANY batch). A distributed item lives in its batch, not the live list, until it is picked.
- Per-line Done/Outstanding is DERIVED, not stored: a line is Done when a `recommendation_actions` row (rec_type='replenish', status='done', twin `pos|sku|…` or `pos|barcode|…` rec_key) exists with `acted_at >= batch.created_at`. A stale done from before the batch does NOT count — so re-distributing a recurring item correctly starts it Outstanding again until re-picked.
- The per-day picker scorecard reuses the same batch data: Done counts only lines whose `done_day_eat` (= `acted_at AT TIME ZONE 'Africa/Nairobi'`) matches the selected day; Outstanding is every not-yet-done line across all open batches (day-independent).
- Marking a batch line done writes the SAME twin sku+barcode ledger rows as the live Mark-done flow, so the Completed audit + Transfer Tracking reconcile identically (see replen-done-twin-rows).

**Why:** there is no separate "picked" status column — the recommendation_actions ledger is the single source of truth, and the batch is just an immutable snapshot of what was handed out on a date.

**How to apply:** all three distribution endpoints (`POST /api/replenishment/distribute`, `GET .../distributions`, `DELETE .../distributions/{id}`) are roster-manager-gated (`_can_manage_roster`) — the GET too, because batch contents carry owner attribution. The frontend `openKeys` must be a `useMemo` dependency of `visibleRows` or the live list goes stale when batches change without a `rows` identity change.
