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
just shows the team what is due for retirement. SOR was REMOVED from the flag
gates too (user, July 2026 — it punished deep-stocked NOOS bestsellers like
Vivo Basic Bodycon: heavy stock caps units/(units+stock) regardless of volume).
Gates = recency/reorders/volume only. Boundaries follow the ORIGINAL SOP:
read window ≤12wk never flagged, ~9mo = 36wk (NOT the tier model's 39), 24mo =
96wk; Week-8 = sale ≤7d + WoC≤8 (missing WoC skipped); 9-24mo = ≥3 reorders;
24mo+ hero-core = ≥5 reorders + sale ≤30d + ≥300 units/6m. Manual tier
override clears the flag.

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

**Tier 4 catch-all must be status-gated (2026-08-27 fix).** The Odoo `tier`
field's fallback (no recognized Tier 1-3 string) used to default unconditionally
to Tier 4. But `all_products_clean.status` has values beyond 'Active'/'Retired'
— 'Archived', 'Partner Brand', 'Sample', or blank — that Odoo uses to mean "not
in the live range" without ever setting status='Retired'. Since
`_is_manually_retired` only checks `status='Retired'`, those styles weren't
excluded, and blindly defaulting them to Tier 4 inflated it ~20x (2642 vs a
genuine ~130-230 target). Fix: the no-recognized-tier fallback now only lands in
Tier 4 when `_odoo_active_status_styles()` (BOOL_OR(status='Active')) is true.
Explicit Tier 1-3 (and explicit Tier 4/"New") values are matched before this
fallback and are unaffected — don't conflate a "my tier count looks wrong"
report with the explicit-tier data itself, which is usually fine; check the
catch-all default population by status first.

**Retired vs Archived are two separate hard Odoo-status buckets (2026-08-27,
same-day follow-up).** The fallback above briefly landed non-Active/no-tier
styles in "Retired" (see above), which conflated real discontinuations with
catalog debris — user asked to split them. Final shape: `_lifecycle_tier`
returns "Retired" ONLY for `status='Retired'` (via `_is_manually_retired` /
`_odoo_retired_styles`, unchanged); everything else with no recognized tier AND
no live Active status (blank/Archived/Partner Brand/Sample) now returns
"Archived" instead. At style-name grain (not SKU/product grain) this Archived
bucket is large — roughly 2-3x the Retired count on this catalog — because one
style_name can span many Odoo product rows and most of the non-tiered catalog
debris sits there, not in explicit status='Retired'. A big Archived number is
expected, not a bug; sanity-check by calling `range_mgmt_classify(country=None,
channel=None)` directly (plain function call, bypassing FastAPI's `Query()`
default marker) and confirming `active+retired+archived == total` and per-tier
counts sum to `active`.
`_TIER4_FALLBACK_EXCLUSIONS` (ZZ TEST, Sample & Sale Items) resolve to
"Archived" too, not "Retired". Every consumer of `_lifecycle_tier` /
`range_mgmt_classify` output that special-cased "Retired" needed a matching
Archived branch or its totals silently drop or double-count: Range Management's
summary banner + drill-down + tier_export + store_tier_mix + the dead-stock %
calc, and Product Analysis (which folds Archived into its existing binary
Retired bucket by design — PA has no separate Archived card). Grep every
`retired_rows` / `"Retired"` literal near `_lifecycle_tier` output before
calling a related change done.

# Spreadsheet override layer (Aug 2026) — `style_tier_overrides` WINS

The imported buying-sheet table (style_number → status + tier) is applied LAST
on BOTH Range Management and Product Analysis, after `_lifecycle_tier` and
`_RANGE_OVERRIDES`: Active+tier → sheet tier (can un-retire); Retired/Archived
→ Retired; not-on-sheet → Retired (only when the table is populated; probe =
any override row in the result set). See manual-style-retirement.md for full
precedence, the PA row-projection trap, and which endpoints still diverge.

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
