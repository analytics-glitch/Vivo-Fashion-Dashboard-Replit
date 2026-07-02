---
name: PA cache snapshot coherence & cross-call identity checks
description: Why product-analysis response cache is keyed on the all_inventory snapshot, and why validator cross-call identities retry once before flagging.
---

**Rule:** Any response cache over a stock-driven universe (product-analysis 600s cache) must include the inventory snapshot version (`MAX(all_inventory._loaded_at)`, via `_inventory_version()` with a ~5s memo) in its cache key. And any validator check that compares numbers from TWO separate HTTP responses must refetch once and re-compare before recording a finding.

**Why:** all_inventory refreshes every ~5 min while PA cached each param set for 10 min — so PA[all], PA[active], PA[retired] and live-computed range-mgmt/classify could each freeze a DIFFERENT inventory snapshot. Cross-surface identity checks (active+retired==all, PA total==RM rows+retired) then "broke" (595 vs 640, 1146 vs 1160) with zero calculation drift — every response was internally consistent. Verified live: identities reconcile exactly on a single snapshot.

**How to apply:** If a cross-page style-count mismatch is reported, first check whether both sides came from the same inventory snapshot before hunting a definitional break. A real break reproduces on refetch; snapshot skew heals. The active/retired partition itself is computed in Python from one shared rollup and is algebraically exact.
