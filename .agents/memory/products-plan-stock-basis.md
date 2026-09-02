---
name: Products Plan stock basis
description: Canonical stock, WOC, and stock-to-sales formulas for the Product Development Products Plan report.
---

The Stock to Sales — Products Plan report uses current Stores SOH plus dispatch-ready Warehouse Finished Goods SOH as Total Opening Stock. Production pipeline, receiving, holding, and in-transit stock are excluded.

Opening WOC = Total Opening Stock ÷ (Units Sold ÷ 4.28).

Total Stock to Sales Ratio = % Total SOH − % Units Sold.

Inventory and sales must be aggregated independently before they are joined.

**Why:** The report is used to compare product-mix demand with sellable opening stock. Including non-sellable pipeline stock or joining raw inventory to sales inflates stock and makes the mix variance misleading.

**How to apply:** Keep these definitions aligned in the API response, on-screen totals, and CSV export whenever this Product Development report is changed.