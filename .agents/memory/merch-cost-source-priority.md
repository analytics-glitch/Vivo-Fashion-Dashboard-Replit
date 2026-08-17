---
name: Merchandising margin cost source priority
description: Cost precedence and freshness metadata used by the style-level Gross Margin Waterfall.
---

The style-level margin cost must prefer the newest non-zero buying-order/reorder cost, then the product-master cost, then completed manufacturing/DPS costing. The response should carry the source and effective date; a missing value must explain all checked sources.

**Why:** Product-master standard cost is empty or stale for some long-running reordered styles, so using it alone produces misleading N/A margins or outdated profitability.

**How to apply:** Preserve this precedence for future margin, costing, and style-detail surfaces. Never use sales `price_unit` as garment cost.