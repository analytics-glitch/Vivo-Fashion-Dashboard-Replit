---
name: Range tier model
description: How range-mgmt classify assigns the displayed Tier 1-4 (now = SOP-2026 GATED lifecycle outcome; Retire is terminal/routed to Retired), Product Analysis Pareto T1-T4 + life_cycle, and the walk-in customer exclusion rule nearby
---

# Range Mgmt 5-bucket framework: displayed tier = the GATED SOP read; Retire is a TERMINAL bucket

`/api/range-mgmt/classify` powers the web "Vivo 4-Tier Framework" (RangeManagement.jsx
+ VivoRangeManagement.jsx, both hit the same endpoint).

**Hard display invariants the user requires (assert these, they regressed before):**
- `Tier 1 + Tier 2 + Tier 3 + Tier 4 == Active` (the four live tiers partition the active range).
- `Active + Retired == Total` (every in-stock style is in exactly one bucket).

**The displayed `row["tier"]` IS the SOP-2026 GATED lifecycle outcome** (not the catalogue
age band). One helper `_sop_classify(...)` is the single source of truth: it returns the
triple `(tier, status, recommended_action)` where tier ∈ Tier 1..4 or "Retire". Age sets the
stage but the performance gates decide promotion vs retirement at each stage. A gate-failed
style returns "Retire" and is routed OUT of the active tiers into `retired[]` — Retire is
terminal, NOT an active tier. `_gated_range_tier(...)` is now a thin wrapper that calls
`_sop_classify` and returns just the tier (Product Analysis's `life_cycle` mapping uses it;
the wrapper preserves the old `age_weeks is None -> Tier 4` behavior).

**The gated tree (calendar weeks 8/12/39/104, NOT the SOP's nominal 36/96 — same 9-/24-month
milestones; keeps trackers + `_RANGE_TARGETS` consistent):**
- Defensive guard: no launch date AND units≥100 AND lifetime SOR≥50 → Tier 2 (long-trading
  style whose launch date isn't healed yet); otherwise treat age as 0.
- <8wk → Tier 4 (New/Test). status On Track if sold in last 14d else At Risk.
- 8–12wk → Week-8 read: pass → Tier 3 (On Track); fail → Tier 4 (At Risk, review at Week-12).
- 12–39wk → pass Week-8 OR Week-12 backstop → Tier 3; else Retire.
- 39–104wk → reorders≥3 AND lifetime SOR>60 AND (FP>90 or FP unknown) → Tier 2; else Retire.
- ≥104wk → reorders≥5 AND (FP>90 or FP unknown) AND lifetime SOR>60 → Tier 1; else Retire.
- Gates: Week-8 = lifetime SOR>60 AND FP>90 AND sold within 7d AND WOC≤8; Week-12 = SOR≥80;
  fail closed when SOR/last-sale missing.

**Status taxonomy is now On Track / At Risk / Retire ONLY** (no "Overdue"). status + action
come straight from `_sop_classify`. `overdue_for_week8_read` KPI is derived: count of active
Tier 4 styles with age>8wk (the 8–12wk group that missed the Week-8 read, awaiting Week-12).

**Why:** The user explicitly applied the SOP-2026 gated decision tree and wants the displayed
tiers to follow it (fewer Tier 1, gate-failed styles retired) — the REVERSE of the earlier
pure-age model. Expect Active to drop sharply (~175 vs ~1106 total; RAG red vs the 500–700
target) and Retired to balloon — that is intended, not a bug.

**How to apply / precedence:**
- HARD-RETIRE always wins and routes OUT to `retired[]` regardless of gated outcome: manual
  retirement list, every Zoya style, aged-out (≥39w, 0 six-mo units, no sale 270d+).
- Manual override `_RANGE_OVERRIDES` (empty by default; only ever Tier 1..4) keeps a style in
  the ACTIVE range at the override tier and beats a gated "Retire"; `auto_tier` records the
  gated outcome so the frontend "override · auto-tier was X" hint stays meaningful.
- Both frontends already tolerate `tier=="Retire"` rows (route to retired) — no FE change was
  needed when the tier source flipped from age to gated.
- Retirement pipeline = gated-Retire styles that still hold stock (`not is_retired and
  current_stock>0`) — the actionable clear-stock list, not the long-dead/Zoya/manual set.
- `tier_counts` still carries a "Retire" key but it is 0 for `active` (Retire rows live in
  `retired[]`). Sum Tier 1..4 to reconcile against Active.
- `marketing-candidates` reuses `range_mgmt_classify`, so it inherits this automatically.
- Don't duplicate the age tree: `_gated_range_tier` MUST stay a wrapper over `_sop_classify`,
  or the two will drift.

# Product Analysis / Catalogue = a SEPARATE, different tier concept (don't conflate)

Product Analysis (`api_pg.py` ~line 3680+) has its OWN `tier` = Pareto cumulative-revenue
share T1/T2/T3/T4 (T1≤20%, T2≤60%, T3≤90%, T4 rest) over the kept styles, and a descriptive
`life_cycle` label (Core / Core Performer / Recent Performer / New / Test / Retire) mapped
from `_gated_range_tier`. These are intentionally NOT the Range Mgmt lifecycle tiers. Its
Active/Retired is velocity-based (`units_vel>0` AND not manually retired) and reconciles
Active+Retired==Total separately.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
