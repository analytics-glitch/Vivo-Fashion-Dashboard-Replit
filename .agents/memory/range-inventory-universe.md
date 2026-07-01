---
name: Range / Product Analysis style universe = inventory only
description: Total Styles on Range Mgmt + Product Analysis count only styles that currently hold stock; Active + Retired must reconcile to Total.
---

# Style universe = styles with current inventory

Both `/api/range-mgmt/classify` and `/api/analytics/product-analysis` scope their
style universe to **styles that currently hold inventory** (stores OR warehouse),
NOT "sold ever". So "Total Styles" = inventory-holding styles; everything else
(historical sold-out styles) is excluded.

- range-mgmt classify universe: `soh_stores > 0 OR soh_warehouse > 0` (still
  excludes third-party brand; Zoya still forced retired).
- product-analysis activity filter: standard path `soh_current>0 OR soh_warehouse>0
  OR soh_stores>0`; POS-exploded path `soh_current>0` (per selling point).

**Why:** business directive — the range views should reflect the *live* assortment
you can still sell/manage, not the full historical catalog.

## Invariant: Active + Retired == Total (must reconcile)

The user expects `Active = Total - Retired` and the tier classification to cover the
active set. Things that previously broke this and must stay fixed:

- Product-analysis Active/Retired is a **LIFECYCLE status decoupled from window
  sales**: Retired = manually retired OR gated to the "Retire" lifecycle tier
  (recomputed at STYLE grain via `_style_gated_retire`, same gate as the Life
  Cycle column); Active = everything else in the inventory universe. It is NOT
  `units_vel > 0` — that measure is now the separate "actively selling" overlay
  (`summary.actively_selling`, scoped to the kept set) and is NOT part of the
  Active/Retired partition. So a Retired style can still show window sales.
- The "retired" status filter must drop only styles whose lifecycle status is
  Active (`if style_status=='retired' and not retired: continue`). Do NOT re-add a
  `g['stock'] <= 0` guard — `g['stock']` is store-only, so it drops warehouse-only
  styles that still hold inventory.
- `summary.active_styles` / `retired_styles` derive from the SAME
  `status_by_style` map used for row labels, so summary counts == row-level counts.
- PA's Retired (manual OR gated-Retire) intentionally DIFFERS from Range Mgmt's
  Retired (hard/manual only). Do not force them to match — only the Total-styles
  universe must reconcile between the two pages.
- Range-mgmt: Tier1..4 counts + the "flagged for retirement" bucket == Active
  (an active style can carry `tier='Retire'` when flagged), so Tier-sum alone is
  intentionally < Active.

**How to apply:** any new style-count surface on these two pages must filter to the
inventory universe and reconcile Active+Retired to Total before shipping.

The data-validation agent's Step-6 cross-surface (`validation_agent/cross_surface.py`
`_check_products`) locks this in: it fetches product-analysis once per `style_status`
filter (all/active/retired — 3 heavy scans, endpoint has a 10-min cache) and asserts
`active_styles+retired_styles==styles` per filter, the filtered slices partition the
`all` universe, and PA total == RM `rows+retired_rows`. PA-Retired vs RM-Retired is an
explicit `INTENTIONAL_SKIPS` entry (different defs by design) — never reconcile them.
**Why:** the lifecycle Active/Retired redefinition intentionally decoupled PA's
Retired from RM's hard/manual-only Retired; only the total universe must agree.
