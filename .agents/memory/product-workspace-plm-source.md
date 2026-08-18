---
name: Product Workspace PLM source
description: Canonical data source and compatibility boundary for the Style Development board
---

Style Development's default universe must be the active Product Development `pd_styles` rows, not the editable `product_workspace.styles` seed table. Use the workspace style matched by style number as the compatibility adapter for detail drawers, ownership, and stage transitions.

**Why:** The two tables can contain different universes and use different identifiers; reading the workspace table made the board count diverge from the PLM Catalogue and dropped valid product-development styles.

**How to apply:** Keep the source choice scoped to the Style Development list query so Assortment Plan and other workspace consumers retain their existing behavior. Normalize raw `pd_styles.current_stage`/`pd_stages.stage_name` values into the board's canonical columns before grouping or calculating Pulse metrics. For carry-over assortment, join `all_products_clean.sku` to `all_inventory.sku` and use summed `all_inventory.available`; the clean-table stock columns may be zero-filled.