---
name: Product order-history cutover
description: Durable source-of-truth rule for buying-order evidence in the Product Workspace.
---

Use a single configurable “Odoo order history start date” for every Product Workspace calculation based on the combined buying-order feed. Before that date, include Central Tracker rows only. On and after that date, include Odoo rows only. Do not fuzzy-match orders, add date or quantity tolerances, or match colourway suffixes.

**Why:** The business chose a clean authority boundary because exact/fuzzy deduplication inflated lifecycle evidence and monthly ordered units. Keeping one boundary also makes Assortment, Range, and Weekly Order Plan agree.

**How to apply:** Filter at the Product Workspace BI adapter/projection boundary before any consumer counts distinct order references, sums quantities, or derives first/last order dates. Preserve existing lifecycle thresholds and Range Refreshed reset semantics.