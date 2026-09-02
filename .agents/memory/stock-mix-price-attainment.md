---
name: Stock Mix price attainment
description: Defines the Stock Mix ASP-to-full-retail percentage and distinguishes it from full-price sell-through.
---

Stock Mix `% Full Price` is the selected-period VAT-inclusive achieved selling value after discounts divided by the full retail value of the gross sale/order units. Aggregate the numerator and denominator before dividing so category, subcategory, and total rows remain unit-weighted. Returns are excluded. A value above 100% is valid when the current product-master retail price is below the historical achieved selling value.

**Why:** Merchandising also has a separate “full-price sell-through” KPI that counts zero-discount units. Reusing that metric would answer a different question and would make Stock Mix aggregates misleading.

**How to apply:** Keep the two metrics explicitly separate. Stock Mix should return a dash when no units sold or no valid full retail price exists; date presets change this sales-period measure but never current SOH.