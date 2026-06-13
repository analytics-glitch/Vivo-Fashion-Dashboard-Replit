---
name: Range Management endpoints contract
description: Shape/filter rules the /api/range-mgmt/* endpoints must satisfy so RangeManagement.jsx and WeeklySORHeatmap.jsx render
---

# Range Management endpoints (api_pg.py)

`/api/range-mgmt/classify`, `/api/range-mgmt/weekly-sor`, and
`POST /api/range-mgmt/overrides/bulk-promote` back the Range Mgmt page.

## Contract gotchas (frontend reads these exact shapes)

- `summary.tier_summary` MUST be keyed with **spaces**: `"Tier 1".."Tier 4"`
  plus `"Total"`, `"Active"`, `"Retired"`. RangeManagement.jsx maps over the
  spaced tier names and reads `tier_summary[t]`. A no-space key silently drops
  per-tier revenue/units/SOR (only count survives via a `tier_counts` fallback).
- `weekly-sor` returns `{weeks:[1..14], rows:[{...,weekly_sor:[14 cells, null for future weeks]}], min_combined}`.
  weekly_sor is **cumulative** SOR; styles aged <14 weeks; denom = lifetime units + store stock; exclude denom < min_combined.
- `recent_movements` is intentionally `[]` — no tier-history snapshots exist in the DB.
- Manual tier promotions persist in module-level `_RANGE_OVERRIDES` (session-scoped, lost on restart) and classify applies them as `tier` vs `auto_tier`.

## Brand scope rule

- Range Management covers **only Vivo, Safari, Zoya** brands. `'Third Party Brands'`
  is excluded from `classify` (final WHERE: `COALESCE(p.brand,'') NOT ILIKE '%third party%'`)
  and from `weekly-sor` (`new_styles` CTE). Brand values in `all_products_clean.brand`
  are exactly: `Vivo`, `Third Party Brands`, `Safari`, `Zoya`.
- **Every Zoya style is always Retired** — in the classify loop, `brand == 'zoya'`
  forces `is_retired=True` (so Zoya never enters active tiers, Pareto, pipeline, or
  candidates, and `_RANGE_OVERRIDES` can't promote it back because overrides apply
  only after the retired-row `continue`). Zoya is also excluded from `weekly-sor`
  (a retired brand has no "new style" to track).
- **Why:** business directive — third-party is not the house range; Zoya is being wound down.

## Filter rules

- Use `_style_filters(country, channel, alias)` for BOTH sales (alias `s`) and inventory (alias `i`).
  **Apply channel to inventory too** (channel maps to `pos_location_name`), or current_stock/WoC/SOR
  become inconsistent when a channel filter is active.
- Sales CTEs MUST include `BASE_FILTERS` (same as `build_filters`) or excluded
  Staff/Manual/Online-vivo-uganda traffic leaks back into tier metrics.

**Why:** these were the exact defects that left the page blank or showing wrong tier numbers.
