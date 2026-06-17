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

**The gated tree (calendar weeks 8/12/39/104 = 9-/24-month milestones; keeps trackers +
`_RANGE_TARGETS` consistent):**
- age None → Tier 4.
- <8wk → Tier 4 (New/Test).
- 8–12wk → Week-8 read: pass → Tier 3; fail → Tier 4.
- 12–39wk → pass Week-8 OR Week-12 backstop → Tier 3; else Retire.
- 39–104wk → reorders≥3 AND lifetime SOR>60 AND (FP>90 or unknown) → Tier 2; else Retire.
- ≥104wk → reorders≥5 AND (FP>90 or unknown) AND lifetime SOR>60 → Tier 1; else Retire.
- Gates: Week-8 = lifetime SOR>60 AND FP>90 AND sold within 7d AND WOC≤8; Week-12 = SOR≥80;
  fail closed when SOR/last-sale missing.

**Partition / counter model (this is what the user's banner-math spec documents):**
- `rows` (active) = ALL classified styles = Tier 1..4 PLUS the still-trading "Retire" flags.
- `retired_rows` = HARD-retired only (manual list / Zoya / aged-out: ≥39w, 0 six-mo units, no
  sale 270d+).
- `Active.count == len(rows)` (INCLUDES flagged Retire). So **Tier1+Tier2+Tier3+Tier4 != Active**
  here — Active = T1+T2+T3+T4+Retire. (This supersedes the old "T1+..+T4==Active" invariant.)
- `Total == Active + Retired`.
- `flagged_for_retirement = tier_counts["Retire"]` (the in-Active flag count) — NOT len(pipeline).
- `overdue_for_week8_read` = active Tier 4 styles with age≥8wk (missed Week-8 read).
- RAG total compares `len(active)` vs the Total target (500–700); per-tier vs `_RANGE_TARGETS`.
- SOR per card = unit-volume-weighted avg (rows with 0 lifetime units excluded).

**Why:** the user supplied a 140-line spec
(attached_assets/Pasted-How-every-number-...txt) defining exactly this: counts["Retire"] is the
"Flagged for retirement" badge of styles still trading INSIDE Active 926, the Retired 427 are
physically retired upstream only. Expect Active ≈ most of the universe and a large flagged count
(our catalog is older/broader than the SOP target → RAG red) — intended, not a bug.

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
