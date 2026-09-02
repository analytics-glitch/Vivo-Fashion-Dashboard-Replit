---
name: Range Plan mix and tier separation
description: Defines the shared planning grain and the boundary between tier health and commercial plan totals.
---

Quarterly and monthly Range Plans must use the same category/subcategory Mix Matrix. New/reorder/replenishment splits are attributes of those rows, not separate planning rows. Tier-filtered views may project the splits but must not duplicate the underlying commercial plan.

**Why:** Tier planning rows created a second, incompatible plan grain and could multiply style health counts into commercial units and revenue.

**How to apply:** Derive units and gross revenue from category rows only. Tier 4 new units use an editable per-row new-style AOS (default 300); reorder/replenishment use the subcategory AOS. Newness is a unit share. Committed orders come from dated production orders mapped to product-master subcategories.