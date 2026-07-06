---
name: IBT cluster tiering must be country-scoped
description: Why the IBT "All countries" view can under-produce vs a single country, and the invariant that fixes it.
---

# IBT store-cluster tiers must be scoped WITHIN each country

The IBT candidate qualifier (`_ibt_base_ctes` in `api_pg.py`) ranks stores into
A/B/C clusters by 90-day revenue and only allows transfers between tier-adjacent
stores (`ABS(from_tier - to_tier) <= 1`) with cluster-average demand thresholds.

**The trap:** if those store tiers are computed network-wide (a single
`NTILE(3) OVER (ORDER BY rev90 DESC)` across all countries), then the
**"All countries"** view tiers, e.g., Kenya stores against Uganda/Rwanda
revenue, and cluster-average stats pool across markets. The tier-adjacency
filter + cluster thresholds then suppress valid **intra-country** transfers that
DO qualify when the view is scoped to that one country — so the network-wide
solve returns FEWER suggestions than a single-country subset (the user report:
"All" showed 2, Kenya alone showed 4). Confirmed diagnostically: with clustering
OFF, All == country; only clustering ON diverged.

**The rule:** tier stores WITHIN their own country — `NTILE(3) OVER
(PARTITION BY country ORDER BY rev90 DESC)`, and scope cluster stats by
`(style, country, tier_n)`, joining `store_tier` on BOTH `store` AND `country`.

**Why:** a store's cluster must reflect its rank in its own market. Cross-market
tiering is only meaningful for cross-border moves, which are separately gated by
the high `IBT_MIN_TRANSFER_CROSS` (24-unit) minimum.

**How to apply:** country partitioning is a **no-op for any single-country
view** (the `c_sales`/`c_inv` filter collapses each partition to one country), so
single-country results stay byte-identical and only the "All" aggregate changes —
it becomes a proper **superset** of the per-country solves. Whenever you touch
IBT tiering, preserve that invariant: `len(All) >= max(len(per-country))`.
Depends on `pos_location_name` mapping 1:1 to a country (join on both keys so a
drift can't silently contaminate tiers).
