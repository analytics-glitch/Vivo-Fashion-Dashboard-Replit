---
name: Validation metrics must mirror reporting BASE_FILTERS
description: Why validation_agent learned_range flags reconcile only when its recompute excludes the same non-merchandise lines the BI pages do.
---

# Validation recompute must use the reporting definition

`validation_agent/metrics.py` recomputes the per-store/day metrics straight from
`all_sales`. The canonical reporting metric on **every** BI page excludes
non-merchandise POS lines via `api_pg.BASE_FILTERS`: gift cards / gift vouchers /
any `%voucher%`, shopping bags, the `%on specific products%` discount line, the
`vb00` catch-all SKU, and the pseudo-locations `Staff purchases` / `Manual Order`
/ `Online - vivo-uganda`. The validation recompute MUST apply the identical
exclusion (`_REPORTING_FILTERS`, kept byte-for-byte in step with BASE_FILTERS).

**Why:** without it the agent computes a *different* metric than the pages it is
meant to reconcile against, so `learned_range` (Tier-2) flags phantom anomalies.
Gift cards are the usual culprit on recent (incremental-sync) days:
- gift-card **sales** inflate `units_sold` / `msi` / `abv`;
- gift-card **redemptions** post as negative-value `sale_kind='order'` lines
  (blank SKU, title like "Gift Card 1000") that deflate `asp` and inflate
  `return_rate`;
- a bulk gift-card line (e.g. qty 69 of "Gift Card KES 1,000/=") spikes
  `units_sold` / `msi`;
- gift-card-only orders inflate `COUNT(DISTINCT order_id)` (`transactions`).

**How to apply:** any new metric grain or aggregate added to the validation agent
must inherit `_REPORTING_FILTERS`. If BASE_FILTERS changes, update both. The
stored `metric_baselines` are folded from the same `compute()`, so the bands
self-clean over the baseline window once the fixed agent runs.

## Not every learned_range flag is a code bug
The LLM diagnosis attached to a finding infers "duplicate rows" from *sampled*
rows, but a repeated `order_id` in the sample is normal for a multi-line basket.
Confirmed-genuine cases that correctly stay flagged (data already reconciles
across pages — do NOT suppress): a real single-receipt 31-distinct-SKU basket
(one wholesale-style customer), a genuine high-return amount on a low-volume day
(return_rate spikes because the denominator is tiny), and a genuinely busy day
nudging the transaction ceiling. Verify each flagged order against `all_sales`
(distinct SKUs vs identical-row dups; `sale_kind='return'` rows vs negative
`order` lines) before deciding bug-vs-real.
