---
name: Range tier model
description: How range-mgmt classify assigns T1-T4 (and the walk-in customer exclusion rule that lives nearby)
---

# Range tier classification = 2026 PPT age-based lifecycle (NOT Pareto)

`/api/range-mgmt/classify` assigns each active style a tier purely from catalog
age (the `age_tier`): Tier 4 = New/Test (< 8 weeks), Tier 3 = Recent Performer
(8 weeks–39 weeks ≈ 9 months), Tier 2 = Core Performer (39–104 weeks, with the
3+ reorder graduation gate), Tier 1 = Core Basics (≥ 104 weeks / 24+ months).
Hard-retire (manual list, Zoya brand, aged non-selling auto-retire) still
overrides the tier. `_RANGE_TARGETS` are the strategy's per-tier style-count
bands (total 500–700) and are only an app RAG indicator.

**Why:** The cockpit originally tiered by cumulative sales-share Pareto, but the
2026 Range Strategy (PPT) defines tiers as a lifecycle, and the frontend copy
already (incorrectly) claimed age-based — so the Pareto pass was removed and
`tier = age_tier`, making backend, frontend copy, and the PPT consistent.

**How to apply:** Do not re-introduce a Pareto/sales-share pass for `tier`. If a
sales-rank view is ever needed, add it as a separate field, not by overwriting
the lifecycle tier. The Tier 3→Tier 2 graduation candidate gate (≈39 weeks, 3+
reorders, SOR > 60, full-price > 90) is intentional and stays.

# Walk-in / brand pseudo-account exclusion (customer counts)

Customer-universe endpoints exclude pseudo-accounts whose name matches
`_WALKIN_NAME_REGEX = (walk[ -]?in|vivo|safari|zoya)` (case-insensitive `~*`).
Applied in `/api/customers` (an `excluded` CTE) and `/api/customer-trend` (a
NOT IN subquery in the `build_filters` extra). These are placeholder/brand
records, not real identified shoppers, so they must not inflate new/returning/
repeat/total. The "Incomplete Profile" metric counts identified period
customers whose `crm`/`all_customers` profile is missing name OR phone OR email
(or has no profile row at all).
