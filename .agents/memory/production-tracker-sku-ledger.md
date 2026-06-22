---
name: Production tracker SKU-grain ledger
description: How the production-tracker movement ledger tracks units at the (sku,size) grain, the move-endpoint integrity rules, and the known whole-order desync artifact.
---

The production tracker ledger (`stage_movements`) records every unit move between
stages. Balances are derived by two views: `v_stage_balances` (order grain) and
`v_stage_sku_balances` (per `sku,size` grain). Both are NULL-safe via
`IS NOT DISTINCT FROM` so the legacy whole-order bucket (sku/size NULL) coexists
with per-variant rows.

**Intake grain & idempotency** (`sync_production_tracker.py` `sync_intake`):
- Orders WITH variant rows seed one intake per `(sku,size)` as a delta vs what is
  already recorded for that variant; the first time an order gains variants it
  deletes the legacy whole-order intake (`from_stage IS NULL AND sku IS NULL`).
- Variant-less orders fall back to a single whole-order intake. The fallback
  "existing" count must sum ALL intake rows for the order (any sku bucket), NOT
  just the sku-NULL row — otherwise an order that flips variants→variant-less
  double-counts (per-sku intake already covers the qty).
- **Why:** prod is a separate DB seeded by the deployed Sync Watchdog, so intake
  must be re-runnable without doubling history across order-shape transitions.

**Move endpoint integrity** (`POST /api/production/move`):
- Lock the order row (`SELECT 1 FROM production_orders WHERE order_ref=%s FOR UPDATE`)
  at the top of the tx so the availability check + insert are atomic; without it
  two concurrent moves on the same (stage,sku) can both pass and over-subscribe.
- With `sku`: availability checked against `v_stage_sku_balances`; without `sku`:
  against `v_stage_balances`. The UI (ProductionOrderModal SkuMoveRow) sends sku
  per row, so whole-order moves only happen for the real legacy NULL bucket.

**Known accepted artifact:** a handful of legacy test orders had whole-order
(sku-NULL) outbound moves BEFORE per-variant intake existed. Per-variant intake
re-seeds full quantities but the sku-NULL outbound doesn't decrement any sku
bucket, so `v_stage_sku_balances` over-counts for THOSE orders only. The
order-grain `v_stage_balances` total is the invariant and stays correct. Real/
prod orders move per-SKU from the start, so this does not occur in prod.
