---
name: Range Mgmt tier model (Pareto vs age)
description: Why /api/range-mgmt/classify carries TWO tier notions and how they must stay separated
---

# Two distinct "tier" notions in Range Mgmt classify

`/api/range-mgmt/classify` computes two different tier concepts that must NOT be conflated:

1. **Range tier** (`tier` / `auto_tier`, the doc-conformant one) — cumulative sales-share
   Pareto over the ACTIVE range (doc 6.5 / 03 metrics): sort active styles by lifetime
   net sales desc, walk cumulative share → T1 ≤ 20%, T2 ≤ 60%, T3 ≤ 90%, T4 = long tail.
   Styles never sold (no first_sale) or zero lifetime sales fall straight to Tier 4.
2. **Age lifecycle stage** (`age_tier`, internal) — bucketed by weeks since launch
   (≥104 T1 / ≥39 T2 / ≥13 T3 / else T4). Drives only the age-gated lifecycle:
   `status`, graduation gates, retirement, `approaching_decision_gates`, action copy.

**Why:** the docs define tiers by sales share, but the whole lifecycle subsystem
(status / retirement pipeline / 9-month graduation gate / overrides) was originally
built on age buckets. A blind swap to Pareto would have turned every age-based gate
into nonsense. Keeping `age_tier` separate preserves the lifecycle while making the
visible tier conform to the docs.

**How to apply:** when touching classify, never reuse `tier` for age logic or `age_tier`
for the visible/RAG tier. `marketing-candidates` filters on the *Range* `tier` (3/4)
plus reactivation (`units_14d ≥ 1` AND `units_prior_30d == 0`, i.e. sold in last 14d
after 30d dormant — doc 03.8.1).

## Deliberate gaps (not bugs)
- **RAG target bands** (`_RANGE_TARGETS`) are app-only cosmetics, NOT in the docs. They
  must bracket the measured *active* Pareto distribution (steep long tail: T1 tiny, T4
  large). Re-measure and re-bracket if the data shifts, or the page will read all-red.
- **style_number dedup** (doc: "dedup earliest first_sale wins") is intentionally SKIPPED:
  ~1096 style_numbers map to multiple style_names, so blind dedup risks collapsing
  legit colorways. Each style_name is tiered independently.
- **Marketing action persistence** (log action / in_flight lifecycle) was Mongo-backed —
  infrastructure intentionally not replicated, so `in_flight` is always `[]`.
