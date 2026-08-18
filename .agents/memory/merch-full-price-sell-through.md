---
name: Merchandising full-price sell-through
description: The strict unit-based full-price SOR KPI shared by merchandising surfaces.
---

Full-price SOR is selected-period sale/order gross units with `discounts_kes` NULL or exactly zero divided by those full-price units plus remaining SOH. Returns are excluded; it is distinct from style-level `avg_full_price_pct`.

**Why:** The merchandising surfaces need price-behaviour SOR without changing the existing total-SOR headline or inheriting the older trailing-six-month, style-level price-realisation definition.

**How to apply:** Keep the metric in each surface's scoped payload; show `Discounted` as total SOR minus full-price SOR, coloured green at ≤5pp, amber through 15pp, and red above 15pp. Return null when the full-price-plus-SOH denominator is zero.