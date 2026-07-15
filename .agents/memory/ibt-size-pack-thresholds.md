---
name: IBT size-pack thresholds & new-style donor rule
description: Style-level per-store unit thresholds for IBT donor/receiver qualification by size-pack type, plus the 21-day new-style donate-only rule and replen WOC/slow-mover gates.
---

# IBT size-pack thresholds (user business rule, July 2026)

Thresholds are **style-level total units at a store** (not per SKU), classified from
the style's master size labels (`style_pack`/`pack_rules` CTEs in `_ibt_base_ctes`):

| pack type | receiver ≤ | donor ≥ | new-style donor ≥ |
|---|---|---|---|
| regular (S,M,L,1X,2X) | 4 | 6 | 5 |
| free size (explicit F/OS/Free-Size label ONLY) | 2 | 4 | 3 |
| 2 combined sizes (S/M, L/1X — one `/` size, n_sizes ≤ 2) | 1 | 3 | 2 |
| 3+ combined (XS/S, M/L, 1X/2X) | 2 | 4 | 3 |

**Why:** buying-team rule table (attached image spec); combined-size garments hold
fewer distinct units so lower bars apply.

**How to apply:**
- Unknown/ambiguous size structures fall back to REGULAR thresholds — only an
  explicit free-size label maps to free-size (a single-size style with a normal
  label is regular; review caught `n_sizes <= 1` wrongly lumped in).
- New style = launched ≤ 21 days ago (regular rules start at day 22). New styles
  may **donate only** (lower "If New style" column); the receiver side must keep
  an explicit `too_new` exclusion in `tos`.
- Per-SKU send mechanics unchanged (donor keeps ≥1/SKU, receiver ≤1/SKU,
  min-range ≥3 SKUs gate) — pack gates live only in `froms`/`tos`.

# Replen daily gates (same change set)

- **cover_ok**: don't replenish when store WOC on a plain last-4-weeks basis ≥ 4
  (woc4 = soh×4/units_28d; 0 when soh=0; sentinel 999 when no sales).
- **slow_mover**: gap between last and 2nd-to-last sale day at THAT store > 30
  days (single stale sale day also counts). 120-day `last2` CTE via
  `(array_agg(DISTINCT sale_date ORDER BY sale_date DESC))[1]/[2]` — sale_date is
  TEXT ISO so lexicographic order works.
- Both are held-back reasons after `overstock`, before `broken_curve`, and
  respect the force-release override.
