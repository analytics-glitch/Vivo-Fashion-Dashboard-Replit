---
name: Range tier model
description: The ONE dashboard-wide, no-SOR style lifecycle tier model (_lifecycle_tier) shared by Range Management + Product Analysis (tier column AND life_cycle word). Retired = manual list / Zoya only; Tier 1-4 by NOOS-consistency + reorder cycles. Also the walk-in customer exclusion rule nearby.
---

# One shared, NO-SOR lifecycle tier model: `_lifecycle_tier`

The user's rule: tier classification is ONE shared model dashboard-wide and must
NOT use SOR (sell-through/rate). The old SOP-2026 SOR-gated chain
(`_gated_range_tier` / `_passed_week8_gate` / `_passed_week12_backstop`) is
**deleted** — never reintroduce SOR into TIER classification.

BUT (July 2026, user rule): the SOP gates live on as an ADVISORY
`flagged_for_retirement` overlay via `_retirement_flag_reason` in
`range_mgmt_classify` — flagged styles keep their real Tier 1..4 and a
`flag_reason` string (shown as a Range Mgmt column + FLAGGED badge tooltip +
retirement pipeline reason). Hard retirement stays Odoo-status ONLY; the flag
just shows the team what is due for retirement. Boundaries follow the ORIGINAL
SOP verbatim: read window ≤12wk never flagged, ~9mo = 36wk (NOT the tier
model's 39), 24mo = 96wk; Week-8 = SOR>60 + sale ≤7d + WoC≤8 (missing WoC
skipped); Week-12 backstop SOR≥80; 24mo+ hero-core = ≥5 reorders + sale ≤30d +
6m SOR>75 + ≥300 units/6m. Manual tier override clears the flag.

**The definition (module-level `_lifecycle_tier(style_name, brand, age_weeks,
reorder_count, months_active_12)`), evaluated top-down:**
- Retired — HARD retirement ONLY: on the manual-retirement list OR a Zoya style.
  (No aged-out / gated auto-retirement.)
- Tier 1 — NOOS best performer: sold in >= 11 of the trailing 12 calendar months
  (`months_active_12 >= 11`). This is the "never out of stock" proxy, e.g. Vivo
  Basic Leggings.
- Tier 2 — established repeat: `age_weeks >= 39` (~9 months) AND `reorder_count > 3`.
- Tier 3 — has completed >= 1 reorder cycle (`reorder_count >= 1`).
- Tier 4 — new / test (everything else).

`reorder_count` is faked from age: `age_weeks // 12` (the user explicitly chose
this proxy — there is no real reorder feed). `months_active_12` = COUNT(DISTINCT
YYYY-MM of sale_date over trailing 365d), computed in each endpoint's SQL.

**Every in-scope style gets exactly one bucket**, so the banner math holds:
Active [Tier 1..4] + Retired == Total; sum(Tier 1..4 counts) == Active.

# Where it's used (all consistent, no divergence)

- **Range Management** `/api/range-mgmt/classify` (`range_mgmt_classify`): `tier` =
  `_lifecycle_tier`; only hard-retired (manual/Zoya) styles go to `retired[]`;
  `_RANGE_OVERRIDES` (Tier 1..4 only) re-buckets within Active and records
  `auto_tier`. `flagged_for_retirement` + `flag_reason` = the advisory overlay
  above (real values again). NOTE: the row still ALSO carries display-only
  SOR columns (`sor_since_launch`, `sor_6m`, `woc`, `status` = On Track / At Risk /
  Overdue / Retire) — those drive the operational **status/action text**, NOT the
  tier. That is allowed; just never let SOR back into `tier`.
- **Product Analysis** (`analytics_product_analysis`): the `tier` column AND the
  descriptive `life_cycle` word BOTH derive from `_lifecycle_tier`. `life_cycle` is
  a pure mapping of the final (override-adjusted) tier: Tier 1->Core, Tier
  2->Core Performer, Tier 3->Recent Performer, Tier 4->New / Test, Retired->
  Retired. It is set from `tier_by_style` in the second row loop so the Life Cycle
  and Tier columns can never disagree. The soft "Retire" value is gone.
  Product Analysis ALSO has a SEPARATE Pareto "top revenue contributors by %"
  filter (`rev_pct`) — that is a revenue-share selector, NOT a tier; don't conflate.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
