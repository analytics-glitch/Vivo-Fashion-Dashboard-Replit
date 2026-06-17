---
name: Range tier model
description: How range-mgmt classify + Product Analysis assign T1-T4 / Retire (GATED, not pure-age) and the walk-in customer exclusion rule nearby
---

# Range tier classification = 2026 Range Strategy GATED lifecycle (NOT pure age, NOT Pareto)

`/api/range-mgmt/classify` and Product Analysis "Life Cycle" share one classifier:
module-level `_gated_range_tier(age_weeks, *, lifetime_sor, full_price_pct,
last_sale_days, woc, reorder_count)` (+ `_passed_week8_gate`,
`_passed_week12_backstop`). Age sets the STAGE; performance GATES decide
promotion vs retirement:

- < 8wk → Tier 4 (New/Test, pre-read).
- 8–12wk → Tier 3 if it passes the Week-8 read, else Tier 4.
- 12–39wk (~9mo) → Tier 3 if Week-8 read OR Week-12 backstop, else **Retire**.
- 39–104wk (9–24mo) → Tier 2 if 3+ reorders & SOR>60 & FP>90, else **Retire**.
- ≥104wk (24mo+) → Tier 1 if 5+ reorders & FP>90 & SOR>60, else **Retire**.

Gates: Week-8 read = lifetime SOR>60 AND FP>90 AND sold within 7d AND WOC≤8;
Week-12 backstop = lifetime SOR≥80. Gates **fail closed** when SOR or last-sale
is missing. Boundaries use the app's CALENDAR weeks (8/12/39/104), NOT the
attached SOP's 36/96, so trackers/`_RANGE_TARGETS` stay consistent — this is a
deliberate blend (attached gates + app calendar).

**Why:** The cockpit had drifted to pure-age tiers (`tier = age_tier`); the user
wanted the real SOP gates restored (a style must actually perform to graduate,
and fails to Retire if it doesn't). The frontend is display-only, so all tier
logic lives in these two backend spots.

**How to apply (critical invariants):**
- Range Mgmt keeps a SEPARATE pure-age band `age_band` (exposed as
  `row["age_tier"]`) used ONLY by age-milestone logic: the "Overdue read"
  status, the Tier-2 graduation-candidate tracker, and the approaching-gate
  counter. The DISPLAYED tier (`row["tier"]`/`auto_tier`, carried via `meta`)
  uses `gated_tier`. Don't collapse the two — they mean different things.
- HARD-RETIRE is unchanged and still overrides to Retire BEFORE gating matters:
  manual retirement list, every Zoya style, aged-out (≥39w, 0 6-mo units, no
  sale 270d+) → `is_retired` → routed to `retired[]`; `flagged` (≥39w, SOR<40,
  stock>0) → tier Retire in `active[]`. `_RANGE_OVERRIDES` can still pin a tier.
- Gate-failure "Retire" styles stay in `active[]` with tier "Retire" (same as
  flagged), counted in `tier_counts["Retire"]`, but are NOT added to the
  flagged-only retirement pipeline (pipeline = flagged queue). Known nuance.
- `marketing-candidates` reuses `range_mgmt_classify`, so it inherits gated
  tiers automatically — don't re-implement classification there.
- Product Analysis Life Cycle maps gated tier → words (Tier1→Core, Tier2→Core
  Performer, Tier3→Recent Performer, Tier4→New/Test, Retire→Retire); at exploded
  dim/pos grain the gate inputs are per-row (approximation), clean at style grain.
- Do NOT re-introduce a Pareto/sales-share pass for `tier`.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
