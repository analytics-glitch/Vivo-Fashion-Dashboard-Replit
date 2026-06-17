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

- Product-analysis "retired" status filter must drop only **active** styles
  (`if style_status=='retired' and active: continue`). Do NOT re-add a
  `g['stock'] <= 0` guard there — `g['stock']` is **store-only** (excludes
  warehouse), so it silently dropped warehouse-only retired styles even though they
  hold inventory, making the retired view undercount.
- Product-analysis `summary.active_styles` must be derived from the SAME
  `status_by_style` map used for row labels (velocity AND not manually-retired),
  not raw `_is_active(g)` — otherwise the summary count (velocity-only) disagrees
  with the row-level Active count.
- Range-mgmt: Tier1..4 counts + the "flagged for retirement" bucket == Active
  (an active style can carry `tier='Retire'` when flagged), so Tier-sum alone is
  intentionally < Active.

**How to apply:** any new style-count surface on these two pages must filter to the
inventory universe and reconcile Active+Retired to Total before shipping.
