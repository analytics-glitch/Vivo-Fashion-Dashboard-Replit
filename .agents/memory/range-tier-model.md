---
name: Range tier model
description: The ONE dashboard-wide, no-SOR, no-override style lifecycle tier model (_lifecycle_tier) shared by Range Management, Product Analysis, AND Merchandising Hub. Retired/Archived/Tier 1-4 come exclusively from Odoo. Also the walk-in customer exclusion rule nearby.
---

# One shared, NO-SOR, NO-OVERRIDE lifecycle tier model: `_lifecycle_tier`

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
override clears the flag (legacy note — the manual override mechanism itself
is gone as of 2026-08-27, see below; this only describes the flag-clearing
behavior when it existed).

**All manual overrides removed dashboard-wide (2026-08-27, explicit user
instruction: "remove all overrides everywhere").** `style_tier_overrides`
(imported buying-sheet table) and the in-memory `_RANGE_OVERRIDES` dict are no
longer consulted by ANY consumer — not Range Management, not Product
Analysis, not Merchandising Hub. `_lifecycle_tier` alone is now the single
dashboard-wide source of truth for lifecycle tier/status everywhere. The
`style_tier_overrides` table/seed infra is left physically in place
(low-risk, unconsumed) rather than deleted. Range Management's "bulk-promote"
feature (backend endpoint + `RangeManagement.jsx` UI) was fully removed; the
endpoint now returns HTTP 410. See `manual-style-retirement.md` for what the
old override precedence used to be (now historical/superseded).

**The definition (module-level `_lifecycle_tier(style_name, brand, age_weeks,
reorder_count, months_active_12, *, is_noos=False)` — the middle three
positional args are vestigial and ignored; only `style_name`/`is_noos` matter
now), evaluated top-down, sourced exclusively from Odoo:**
- `None` — sentinel meaning "no live Odoo status at all" (catalogue debris —
  blank status, no Odoo record, Sample, Partner Brand). Every consumer MUST
  exclude these styles entirely from lifecycle reports — never default them
  to Active/Tier 4/Archived. This is a NEW return value (2026-08-27); grep
  every call site for a `is None: continue`-style guard before trusting counts.
- `"Retired"` — Odoo status literally says Retired (mixed-SKU: Active wins,
  NULL never retires).
  `"Archived"` — Odoo status literally says Archived only (see
  `range-mgmt-archived-status-only.md` for the strict single-bucket rule).
- Tier 1 (NOOS) / Tier 2 / Tier 3 / Tier 4 — read directly from Odoo's own
  tier field (`x_vivo_attr_99` → `all_products_clean.tier`) and the `is_noos`
  flag. No reorder-count heuristics, no age/recency proxies.

**Every in-scope style gets exactly one bucket** (styles with `None` are
excluded from the universe entirely, not counted anywhere), so the banner
math holds: Active [Tier 1..4] + Retired + Archived == Total (of styles with
a live Odoo status).

**Tier 4 catch-all must be status-gated (2026-08-27 fix, still true).** A
no-recognized-tier style only lands in Tier 4 when
`_odoo_active_status_styles()` (BOOL_OR(status='Active')) is true; otherwise
it's Archived or excluded (`None`) per the rules above.

# Where it's used (all consistent, no divergence, verified 2026-08-27)

- **Range Management** `/api/range-mgmt/classify` (`range_mgmt_classify`):
  `tier` = `_lifecycle_tier` directly, no override re-bucketing.
  `flagged_for_retirement` + `flag_reason` = the advisory SOP overlay above
  (unrelated to tier itself). The row still ALSO carries display-only SOR
  columns (`sor_since_launch`, `sor_6m`, `woc`, `status` = On Track / At Risk /
  Overdue / Retire) — those drive the operational **status/action text**, NOT
  the tier.
- **Product Analysis** (`analytics_product_analysis`): the `tier` column AND
  the descriptive `life_cycle` word BOTH derive from `_lifecycle_tier`
  directly (no `style_tier_overrides` join). `life_cycle` is a pure mapping:
  Tier 1->Core, Tier 2->Core Performer, Tier 3->Recent Performer, Tier 4->New
  / Test, Retired->Retired.
- **Merchandising Hub** (`merch_router.py::_compute_tier(style_name,
  is_noos)`): delegates entirely to `api_pg._lifecycle_tier` via the `A`
  module reference (bound at runtime by `register_merch_routes(app,
  api_pg_module)`, called from `api_pg.py`). Merch's own independent
  reorder-cycle tier model is gone. All 5+ call sites in `_fetch_styles_sql`,
  `_fetch_styles_fast_path`, and the SOR-by-tier endpoint must skip rows where
  `_compute_tier` returns `None`. Verified by direct DB comparison
  (2026-08-27): 300-style sample, 0 mismatches between
  `api_pg._lifecycle_tier` and `merch_router._compute_tier`.
- Schema-smoke tests for merch_router (`test_merch_router_schema_smoke.py`)
  use fake style names that can never resolve through the real Odoo-backed
  classifier once `merch_router.A` is bound to the real `api_pg` module in
  the test process — they must mock `merch_router._compute_tier` directly
  (fixed return value) rather than relying on fake rows classifying for real.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
