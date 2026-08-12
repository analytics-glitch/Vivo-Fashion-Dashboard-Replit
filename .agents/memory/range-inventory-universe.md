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
  sales**: both PA and RM now derive tier + Active/Retired from ONE shared helper
  `_lifecycle_tier(style_name, brand, age_weeks, reorder_count, months_active_12)`.
  Retired = that helper returning "Retired"; Active = everything else in the
  inventory universe (tier ∈ Tier 1..4). It is NOT `units_vel > 0` — that measure
  is now the separate "actively selling" overlay (`summary.actively_selling`,
  scoped to the kept set) and is NOT part of the Active/Retired partition. So a
  Retired style can still show window sales. PA also exposes a **separate `rev_pct`
  Pareto filter** (cumulative revenue-desc, keep until share ≥ rev_pct%, min 1)
  applied AFTER tier filtering — it does not change the universe.
- The "retired" status filter must drop only styles whose lifecycle status is
  Active (`if style_status=='retired' and not retired: continue`). Do NOT re-add a
  `g['stock'] <= 0` guard — `g['stock']` is store-only, so it drops warehouse-only
  styles that still hold inventory.
- `summary.active_styles` / `retired_styles` derive from the SAME
  `status_by_style` map used for row labels, so summary counts == row-level counts.
- PA and RM Retired now share the SAME definition (both from `_lifecycle_tier`),
  so they should align — the "flagged for retirement" / gated-Retire split was
  removed. Only the Total-styles universe is contractually required to reconcile;
  the cross_surface `INTENTIONAL_SKIPS` entry for PA-Retired vs RM-Retired is now
  belt-and-suspenders (harmless — it just doesn't assert them equal).
- Range-mgmt: Tier1..4 counts now SUM EXACTLY to Active (no separate flagged
  bucket; `flagged_for_retirement` is always 0). Retired = tier "Retired" only.

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

## Store-scoped universe (Aug 2026)
When PA receives a single `store` param (Store Detail cockpit / PA store
filter), the universe gate switches to store-scoped stock (`soh_current`) OR
any in-window transaction at that store — NOT business-wide stock. Business-wide
(no store) keeps the stores+warehouse gate that reconciles to RM's Total.
**Why:** the global gate made a store's "Active Styles" read ~the whole
catalogue (Junction showed 1,184). Sold-out-in-period styles must stay in the
store universe or the cockpit's Revenue/Units undercount.
