---
name: Product Workspace fabric linkage
description: Canonical Fabric BI hierarchy, inventory, reservation, classification, and cost rules for Product Workspace.
---

Product styles link to one canonical Level 3 base fabric. Weekly colour allocations select Level 4 records by barcode; names are display labels, not identity.

**Why:** Free-text fabric and colour names drift from Fabric BI and cannot safely support availability, reservation, warning, or cost calculations. Uncertain historical names must remain unlinked rather than being guessed.

**How to apply:** Read Fabric BI source tables without writing to them. Treat inventory `available` as already net of inventory reservations, then subtract active team reservation `qty_kg` once after converting with effective kg/metre. Required metres are `ceil(colour units × subcategory rate)` and shortages warn without blocking. Cost figures are fabric-only, never full COGS. Derive Print/Plain and Knit/Woven from the linked fabric; label only differing saved values as overrides, and do not enforce a colour minimum while classification is unknown.