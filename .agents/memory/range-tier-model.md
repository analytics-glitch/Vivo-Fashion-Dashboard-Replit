---
name: Range tier model
description: How range-mgmt classify assigns the displayed Tier 1-4 (lifecycle/age band, partitions Active) vs the gated SOP read (status/pipeline), Product Analysis Pareto T1-T4, and the walk-in customer exclusion rule nearby
---

# Range Mgmt 4-tier framework: tiers PARTITION Active (lifecycle/age band); the gated SOP read is STATUS, not the tier

`/api/range-mgmt/classify` powers the web "Vivo 4-Tier Framework" (RangeManagement.jsx
+ VivoRangeManagement.jsx, both hit the same endpoint).

**Hard display invariants the user requires (assert these, they regressed before):**
- `Tier 1 + Tier 2 + Tier 3 + Tier 4 == Active` (the four tiers partition the active range).
- `Active + Retired == Total` (every in-stock style is in exactly one of the two buckets).

**The displayed `row["tier"]` = the lifecycle/AGE band** (`row["age_tier"]`, always
Tier 1..Tier 4): <8wk→Tier 4 (New/Test), 8–39wk→Tier 3, 39–104wk→Tier 2, ≥104wk→Tier 1
(None age → Tier 4). So every active style lands in exactly one tier. `_RANGE_OVERRIDES`
(empty by default; the runtime override endpoint only ever sets Tier 1..4) can re-bucket
within Tier 1..4; `auto_tier` stays the un-overridden age tier so the frontend's
"manual override · auto-tier was X" hint stays meaningful.

**The 2026 SOP GATED read drives STATUS + the retirement pipeline, NOT the tier bucket.**
`_gated_range_tier(age_weeks, *, lifetime_sor, full_price_pct, last_sale_days, woc,
reorder_count)` (+ `_passed_week8_gate`, `_passed_week12_backstop`) returns Tier 1..4 or
"Retire"; its "Retire" outcome only feeds `status` (set in the first loop: `gated_tier=="Retire"
→ status="Retire"`). A still-in-range style that fails its gate keeps its lifecycle tier
and surfaces the concern via `status`/`flagged` — it is NOT pulled out of the tier counts.

**Why:** A prior version assigned `row["tier"]` from `gated_tier`, so ~755 active styles
that failed gates got tier "Retire" and fell outside Tier 1..4 — the four tiles summed to
173 while Active showed 928. The user's mental model: Active (the headline, target band
500–700) is fixed and the four tiers must add up to it; the gate read is a per-style
status overlay, not a bucket. Restoring `tier = age_band` matches the endpoint's own
documented intent and both invariants.

**How to apply:**
- Don't reintroduce `tier = gated_tier`. Keep gated logic on `status` + the `flagged_for_retirement`
  pipeline only. `flagged` (≥39w, lifetime SOR<40, stock>0) feeds the pipeline but the style
  STAYS in its age tier (don't set its tier to "Retire").
- HARD-RETIRE still routes rows OUT of `active` into `retired[]` BEFORE tiering: manual
  retirement list, every Zoya style, aged-out (≥39w, 0 six-mo units, no sale 270d+). Those
  are the ONLY things that move a style to Retired.
- `tier_counts` still carries a "Retire" key but it is now ~0 for active styles (a gate-failed
  active style is counted in its age tier). Sum Tier 1..4 to reconcile against Active.
- Gates (for status): Week-8 read = lifetime SOR>60 AND FP>90 AND sold within 7d AND WOC≤8;
  Week-12 backstop = lifetime SOR≥80; fail closed when SOR/last-sale missing. Calendar weeks
  8/12/39/104 (NOT the SOP's 36/96) so trackers/`_RANGE_TARGETS` stay consistent.
- `marketing-candidates` reuses `range_mgmt_classify`, so it inherits this automatically.

# Product Analysis / Catalogue = a SEPARATE, different tier concept (don't conflate)

Product Analysis (`api_pg.py` ~line 3680+) has its OWN `tier` = Pareto cumulative-revenue
share T1/T2/T3/T4 (T1≤20%, T2≤60%, T3≤90%, T4 rest) over the kept styles, and a descriptive
`life_cycle` label (Core / Core Performer / Recent Performer / New / Test / Retire) mapped
from `_gated_range_tier`. These are intentionally NOT the Range Mgmt lifecycle tiers and were
NOT changed by the partition fix. Its Active/Retired is velocity-based (`units_vel>0` AND not
manually retired) and reconciles Active+Retired==Total separately.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
