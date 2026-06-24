---
name: IBT minimum-range gate (≥3 SKUs post-transfer)
description: Why/how IBT suppresses allocating a style to a store unless the receiver holds ≥3 distinct SKUs after the transfer.
---

# IBT minimum-range gate

**Rule:** IBT must NOT allocate a style to a receiving store unless that store will
hold **≥ 3 distinct SKUs** of that style *after* the transfer. Enforced at the
suggestion level in BOTH allocators in `api_pg.py`: `_ibt_suggestions_sql`
(store→store) and `ibt_warehouse_to_store` (warehouse→store). Both filter
`projected_skus >= 3`.

**Why:** A style sitting in a store as only 1–2 SKUs/sizes presents as a broken
size run and doesn't merchandise; the business wants a viable mini-range or none.

**How the projection is computed (must stay in lockstep with the SKU breakdown):**
post-transfer SKU set at the receiver =
`receiver already stocks (av>=1)` UNION `donor will send (donor av>=2 AND receiver av<=1)`.
This mirrors `ibt-sku-breakdown`'s actual per-SKU send rule
`suggested_qty = LEAST(from_av-1, max(2-to_av,0))` (send>0 ⇔ from_av>=2 and to_av<=1).
Both flows share the same `/analytics/ibt-sku-breakdown` (warehouse passes
`from_store='Warehouse Finished Goods'`), so gating at the suggestion level keeps the
drilldown consistent — no second gate in the breakdown.

**Edge cases handled:** country filter applied via `c_inv` in the projection CTEs;
warehouses excluded from receiver/donor `sku_av`; `pair_count` window is computed
*after* the gate so it reflects only eligible pairs.

**If you change the breakdown's send formula, change this projection too**, or the
gate and the drilldown will disagree (pairs shown that can't actually reach 3 SKUs,
or valid pairs hidden).
