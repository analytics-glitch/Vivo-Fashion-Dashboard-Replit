---
name: Merchandising margin cost source priority
description: Cost precedence and freshness metadata used by the style-level Gross Margin Waterfall.
---

The style-level margin cost must prefer the newest non-zero production/buying-order unit cost, then the product-master `standard_cost_kes`. The response should carry the source and effective month; a missing value must explain both checked sources.

**Why:** Product-master standard cost is empty or stale for some long-running reordered styles, so using it alone produces misleading N/A margins or outdated profitability. Gross margin is explicitly ASP-based and per unit; do not substitute full price or a total-period margin.

**How to apply:** Preserve this precedence for future margin, costing, and style-detail surfaces. Use realised average selling price for revenue and never use sales `price_unit` or manufacturing/DPS fallback as the garment cost for this surface.