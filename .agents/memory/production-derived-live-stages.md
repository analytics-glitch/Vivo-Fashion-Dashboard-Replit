---
name: Production Tracker derived live stages
description: Waiting Sewing / Sewing / Finishing derive from all_inventory locations, not the manual ledger — rules for moves and per-endpoint overrides.
---

Waiting Sewing, Sewing and Finishing balances are DERIVED live from `all_inventory` Odoo stock locations (Fabric Trimming → waiting_sewing; `Sew/Stock/A`–`E` → sewing with line = location suffix; Finished Goods Production → finishing). The manual `stage_movements` ledger only drives buying_order, cutting, washing, repairs, defects, warehouse.

**Why:** the floor physically moves stock between Odoo locations anyway; a parallel manual ledger for those stages drifted and double-tracked. Deriving makes the board self-correcting.

**How to apply:**
- Every production endpoint (/summary, /board, /stages, /flow, order detail) must OVERRIDE the ledger balance for the three derived stages with `_production_derived_balances` (60s cache; call `_prod_derived_invalidate()` after any ledger write before re-reading). Adding a new production endpoint without the override reintroduces the stale ledger numbers.
- Manual moves OUT of waiting_sewing/sewing are 400-blocked ("live from Odoo stock"). Moves INTO a derived stage are allowed by design (cutting "Clear" → waiting_sewing; repairs → sewing): they decrement the source in the ledger; the inbound ledger row is never counted because the destination displays derived stock. Finishing keeps manual OUTs (washing/repairs/defects/warehouse) whose availability checks read the derived buckets.
- Derived rows carry `live:true`, `days_in_stage:null`, `allowed_next:[]` (except finishing). Frontends must gate move controls on `allowed_next.length > 0`, not just terminal flags — a live group with empty allowed once rendered a dead "Move whole order" control.
- Sewing lines are derived from the location suffix; no sewing-line picker anywhere. Repairs→sewing still auto-routes to `last_sewing_line`.
