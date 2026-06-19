---
name: Range tier model
description: How range-mgmt classify assigns the displayed Tier 1-4 (= SOP-2026 GATED outcome). A gated-Retire still-trading style now KEEPS a real Tier 1-4 (its age band) + a flagged_for_retirement row flag and stays IN Active; hard-retire is the only thing that fills Retired. Also Product Analysis Pareto T1-T4 + life_cycle, and the walk-in customer exclusion rule nearby.
---

# Range Mgmt 5-bucket framework: gated-Retire is a FLAG that STAYS IN ACTIVE with a real tier

`/api/range-mgmt/classify` powers the web "Vivo 4-Tier Framework" (RangeManagement.jsx
+ VivoRangeManagement.jsx, both hit the same endpoint).

**The single hard rule the user cares about:** a gated "Retire" verdict on a still-trading
style is a FLAG, NOT a move and NOT a "Retire" tier. The style stays in the Active range,
gets a REAL displayed `tier` = its age band (Tier 1..4), and carries a boolean row flag
`flagged_for_retirement=true`. The Retired bucket is filled by HARD/physical retirement ONLY
(the manual styles list, every Zoya style, long-dead aged-out). **Never route gated-Retire
into `retired[]`** — doing so retires best-sellers and is the exact regression the user rejected
("Why are you retiring our best sellers?").

**Why flagged styles must be PART of Active (and carry a real tier):** the user's banner-math
rule is "Tier 1,2,3,4 should make up the active number" AND "sum of tiers = total active" AND
"Active + Retired = Total". For that to hold, flagged styles cannot sit in a separate "Retire"
tier (that broke `sum(tiers)==active`). So the gated-Retire verdict becomes a flag overlay on
top of the age-band tier, not a tier of its own. The FLAGGED badge + the "flagged for
retirement" KPI tile + the markdown rail are what surface the flag.

**The displayed `row["tier"]`:** for a style that PASSES its gate it is the gated promotion
(Tier 1..4). For a style that FAILS its gate (gated-Retire) it is the AGE BAND
(`_age_band_tier`: ≥96wk→T1, 36–96wk→T2, 8–36wk→T3, <8wk→T4) and `flagged_for_retirement` is
set. `_gated_range_tier(age_weeks, *, lifetime_sor, full_price_pct, last_sale_days, woc,
recent_sor, reorder_count)` still returns the raw gated outcome ("Retire" or Tier 1..4);
`range_mgmt_classify` translates a "Retire" outcome into (age-band tier + flag). Product
Analysis's `life_cycle` mapping still reads the raw `_gated_range_tier` label directly.

**The gated tree (calendar weeks 8/12/36/96 = 9-/24-month milestones):**
- age None → Tier 4.
- <8wk → Tier 4 (New/Test).
- 8–12wk → Week-8 read: pass → Tier 3; fail → Tier 4 (NOT flagged yet — still in trial window).
- 12–36wk → pass Week-8 OR Week-12 backstop → Tier 3; else gated-Retire (→ flag + age band T3).
- 36–96wk → reorders≥3 AND lifetime SOR>60 → Tier 2; else gated-Retire (→ flag + age band T2).
- ≥96wk → reorders≥5 AND last_sale_days≤30 AND recent_sor(sor_6m)>60 → Tier 1; else gated-Retire
  (→ flag + age band T1). (Tier 1 must be CURRENTLY selling well — lifetime SOR was replaced by
  recent 6-month SOR + a 30-day recency gate; both callers pass sor_6m as `recent_sor`.)
- Gates: Week-8 = lifetime SOR>60 AND sold within 7d AND WOC≤8; Week-12 = SOR≥80; fail closed when
  SOR/last-sale missing.
- **full_price_pct is NOT gated** (best-sellers sold mostly on promo were being flagged); still
  computed + shown as a column; the graduation-candidate predictor also dropped its FP>90 cond.

**Partition / counter model (the user's banner-math spec):**
- `rows` (active) = ALL classified still-trading styles = Tier 1..4 (the flagged ones included,
  each with its age-band tier). There is NO "Retire" tier anymore.
- `retired_rows` = HARD-retired only (manual list / Zoya / aged-out: ≥39w, 0 six-mo units, no
  sale 270d+).
- **`tier_counts` has NO "Retire" key** — only Tier 1..4. `sum(tier_counts.values()) ==
  total_active_styles == len(active) == tier_summary["Active"].count`.
- `flagged_for_retirement` (summary count) = number of active rows with the row flag set; it is
  its own KPI/badge, NOT a tier and NOT subtracted from Active.
- `Total == Active + Retired` (Total.count = len(rows) + len(retired_rows)). Flagged are already
  inside Active, so they are NOT a third additive term.
- `overdue_for_week8_read` = active Tier 4 styles with age≥8wk (missed Week-8 read).
- RAG total compares the active count (Tier 1-4) vs the Total target (500–700); per-tier vs
  `_RANGE_TARGETS`. SOR per card = unit-volume-weighted avg (0-lifetime-unit rows excluded).

**How to apply / precedence:**
- HARD-RETIRE wins and routes to `retired[]`: manual list, Zoya, aged-out. Checked first; on a
  hard-retired style `continue` before active bucketing (its row flag is False).
- Else the style goes into `active[]` with a real Tier 1..4; if the gated outcome was "Retire" it
  also gets `flagged_for_retirement=true`.
- Manual override `_RANGE_OVERRIDES` (Tier 1..4 only) re-buckets within Active, BEATS a gated
  "Retire", and CLEARS the flag; `auto_tier` records the un-overridden gated tier.
- Retirement pipeline / markdown rail = active rows where `flagged_for_retirement` AND
  `current_stock>0` — they stay in Active; the pipeline is an overlay, it does not remove them.
- The web `status` field is still "Retire" for a flagged, non-overridden style, so the
  RangeManagement **status** filter keeps a "Retire" option (distinct from the removed tier
  option). The tier MultiSelect + tier pills are Tier 1..4 only; a FLAGGED rose badge renders in
  the Tier column when `r.flagged_for_retirement`.
- `VivoRangeManagement.jsx` (legacy recreation report) reads `flagged_for_retirement` to keep
  treating flagged styles as "retired" in ITS portfolio split, and EXCLUDES them from its active
  filter so they are not double-counted. The main RangeManagement banner reads `summary.*`.
- `marketing-candidates` reuses `range_mgmt_classify`, inheriting all of this automatically.

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
