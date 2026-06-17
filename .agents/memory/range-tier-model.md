---
name: Range tier model
description: How range-mgmt classify assigns the displayed Tier 1-4 (= SOP-2026 GATED outcome; "Retire" is an in-Active FLAG, NOT moved to Retired), why hard-retire is the only thing that fills Retired, Product Analysis Pareto T1-T4 + life_cycle, and the walk-in customer exclusion rule nearby
---

# Range Mgmt 5-bucket framework: tier = GATED SOP read; "Retire" is a FLAG that STAYS IN ACTIVE

`/api/range-mgmt/classify` powers the web "Vivo 4-Tier Framework" (RangeManagement.jsx
+ VivoRangeManagement.jsx, both hit the same endpoint).

**The single hard rule the user cares about:** a gated "Retire" verdict on a still-trading
style is a FLAG ("flagged for retirement"), NOT a move. It stays in the Active range with
`tier=="Retire"`. The Retired bucket is filled by HARD/physical retirement ONLY (the manual
styles list the user supplies, every Zoya style, long-dead aged-out). **Never route gated-Retire
into `retired[]`** — doing so retires best-sellers and is the exact regression the user rejected
("Why are you retiring our best sellers?").

**The displayed `row["tier"]` IS the SOP-2026 GATED lifecycle outcome** (Tier 1..4 or "Retire"),
from `_gated_range_tier(age_weeks, *, lifetime_sor, full_price_pct, last_sale_days, woc,
reorder_count)`. Age sets the stage; the performance gates decide promotion vs the Retire flag.
Product Analysis's `life_cycle` mapping reuses the same helper.

**The gated tree (calendar weeks 8/12/36/96 = 9-/24-month milestones; keeps trackers +
`_RANGE_TARGETS` consistent):**
- age None → Tier 4.
- <8wk → Tier 4 (New/Test).
- 8–12wk → Week-8 read: pass → Tier 3; fail → Tier 4.
- 12–36wk → pass Week-8 OR Week-12 backstop → Tier 3; else Retire.
- 36–96wk → reorders≥3 AND lifetime SOR>60 → Tier 2; else Retire.
- ≥96wk → reorders≥5 AND lifetime SOR>60 → Tier 1; else Retire.
- Gates: Week-8 = lifetime SOR>60 AND sold within 7d AND WOC≤8; Week-12 = SOR≥80;
  fail closed when SOR/last-sale missing.
- **full_price_pct is NOT gated** (user removed it — best-sellers sold mostly on promo were
  being flagged). It's still computed + shown as a display column; `_passed_week8_gate` /
  `_gated_range_tier` keep the param but ignore it. The graduation-candidate predictor also
  dropped its FP>90 condition.

**Partition / counter model (this is what the user's banner-math spec documents):**
- `rows` (active) = ALL classified still-trading styles = Tier 1..4 PLUS the "Retire" flags.
- `retired_rows` = HARD-retired only (manual list / Zoya / aged-out: ≥39w, 0 six-mo units, no
  sale 270d+).
- **Active count = Tier1+Tier2+Tier3+Tier4 ONLY** (`total_active_styles == active_tier_total`,
  `tier_summary["Active"].count` excludes Retire). The flagged "Retire" rows still live in
  `rows`/`active` (never moved to `retired_rows`) but are NOT counted in Active. This is the
  user's explicit rule "Tier 1,2,3,4 should make up active number" — it supersedes the earlier
  "Active = T1+..+T4+Retire" model.
- `flagged_for_retirement = tier_counts["Retire"]` — its own badge, separate from Active.
- `Total == Active + flagged + Retired` (rows = T1-4 + Retire; Total.count = rows + retired_rows).
- `overdue_for_week8_read` = active Tier 4 styles with age≥8wk (missed Week-8 read).
- RAG total compares `active_tier_total` (Tier 1-4) vs the Total target (500–700); per-tier vs
  `_RANGE_TARGETS`.
- SOR per card = unit-volume-weighted avg (rows with 0 lifetime units excluded).

**Why:** the user supplied a banner-math spec defining three distinct counts — Tier 1-4 = the
Active number, counts["Retire"] = the "Flagged for retirement" badge (still trading, not retired),
retired_count = physically retired upstream only. On our live DB far fewer styles clear the
reorder/SOR/FP gates than in the reference data, so Active comes out small and the flagged count
large (RAG red) — that gap is DATA, not logic; the gate rules match the spec exactly.

**How to apply / precedence:**
- HARD-RETIRE wins and routes to `retired[]`: manual list, Zoya, aged-out. Checked first; on a
  hard-retired style we `continue` before active bucketing.
- Else the style goes into `active[]` with `tier = gated_tier` (may be "Retire").
- Manual override `_RANGE_OVERRIDES` (empty by default; only Tier 1..4) re-buckets within Active
  and BEATS a gated "Retire"; `auto_tier` records the un-overridden gated outcome.
- Retirement pipeline = active rows with `tier=="Retire"` AND `current_stock>0` (markdown rail
  overlay) — these still live in Active, the pipeline does not remove them.
- VivoRangeManagement.jsx reads `rows` and itself splits `tier=="Retire"` into a flagged set; the
  main RangeManagement.jsx banner reads `summary.*`. Backend must put gated-Retire in `rows`, not
  `retired_rows`, for both to render correctly.
- `marketing-candidates` reuses `range_mgmt_classify`, inheriting this automatically.

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
