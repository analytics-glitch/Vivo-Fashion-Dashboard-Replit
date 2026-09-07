---
name: Product Workspace fabric linkage
description: Canonical Fabric BI hierarchy, inventory, reservation, classification, and cost rules for Product Workspace.
---

Product styles link to one canonical Level 3 base fabric. Supplier + supplier fabric code is the identity and must collapse repetitive `fabric_name` variants; the shortest authoritative `fabric_name` is the display label. Derive the supplier code from the Level 4 product name only when its explicit field is blank. Weekly colour allocations select Level 4 records by barcode; names are display labels, not identity.

**Why:** Free-text fabric and colour names drift from Fabric BI, and one supplier code can appear under bare, category-suffixed, or spacing-variant names even though it is one quality. Splitting those labels understates Level 3 stock. Uncertain supplier-code matches must remain unlinked rather than being guessed.

**How to apply:** Read Fabric BI source tables without writing to them. Display `quantity` as total available/on-hand, inventory `reserved_qty` plus active team reservations as reserved, and `available` minus active team reservation `qty_kg` as free; convert each through effective kg/metre. Required metres are `ceil(colour units × subcategory rate)` and shortages warn without blocking. Cost figures are fabric-only, never full COGS. Derive Print/Plain and Knit/Woven from the linked fabric; label only differing saved values as overrides, and do not enforce a colour minimum while classification is unknown.