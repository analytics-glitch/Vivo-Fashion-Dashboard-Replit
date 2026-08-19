---
name: Product Workspace PLM and Assortment sources
description: Separate canonical universes for Style Development and the Assortment Plan
---

Style Development's default universe must be the active Product Development `pd_styles` rows, not the editable `product_workspace.styles` seed table. Use the workspace style matched by style number as the compatibility adapter for detail drawers, ownership, and stage transitions.

**Why:** The two tables can contain different universes and use different identifiers; reading the workspace table made the board count diverge from the PLM Catalogue and dropped valid product-development styles.

**How to apply:** Keep this source choice scoped to Style Development. Normalize raw PLM stages into the board's canonical columns before grouping or calculating Pulse metrics.

Kanban grouping is a presentation projection over the already filtered `pd_styles` response: it must not alter a card's detailed stage or transition behavior. The default board collapses detailed fit/approval/development states into the stakeholder pipeline labels, while other groupings use source-owned designer, season (Collection), theme (Edit), brand, tier, and launch-week values.

**Why:** The tracker has more detailed operational stages than the planning board, and card actions depend on those detailed stages. Replacing them to make the board prettier would break valid transitions and reporting.

**How to apply:** Filter first, then build/count columns from the filtered rows. Keep fixed pipeline and tier order, sort launch weeks chronologically, and use explicit missing-value columns rather than dropping styles.

Assortment Plan deliberately uses a different universe: mirror BI Range Management's catalogue style-name grain, SKU-to-style fallback for inventory, store/sellable-warehouse stock eligibility, and `style_tier_overrides` status/tier. Do not add `pd_styles` rows or calculate tiers from stock volume. Q3/Q4 share this baseline and differ only through explicit quarter exclusions.

**Why:** Mixing PLM development rows inflated the range and produced frontend-invented tiers. The Range Management total is stock-sensitive, so a historical “about 1,201” count is not a permanent assertion; the active tier split remains database-owned while eligible retired styles move with inventory.

**How to apply:** Keep tier display labels as a presentation mapping of Tier 1–4 plus Retired. Preserve active styles with a null database tier in the unfiltered universe, but do not match them when a Tier filter is selected.

Full Catalogue performance metrics and sorting must preserve style identity by normalized style number (with SKU fallback for the BI/Odoo mirror). Do not substitute the existing merchandising lifetime rollups for Full Catalogue because those rollups are keyed only by style name and can merge distinct style numbers that share a name.

**Why:** Full Catalogue is paginated globally, so performance sorts must be applied to the complete filtered style-number universe before the page slice. PLM may have styles that do not yet map to a launched catalogue style; their missing metrics belong at the end rather than being borrowed from a same-named style.

**How to apply:** Aggregate sales and inventory separately before joining to avoid fan-out. Use database null-last ordering with stable style-name/style-number tie-breakers, and keep Full Catalogue and PLM source universes separate even when they expose the same sort menu.

Assortment Plan is the deliberate exception: it mirrors BI Range Management's style-name row grain, so its performance sorts use the merchandising style-name rollup plus the post-watermark incremental bridge. Matching Full Catalogue there means matching filter/sort interactions and labels, not changing the Assortment universe to style-number grain.

**Why:** The Assortment cards and tier/status overrides are already defined at the BI style-name grain; attaching style-number metrics would silently change that product universe. The rollup bridge keeps lifetime sorting responsive without dropping sales loaded after the rollup snapshot.

**How to apply:** Keep sales and stock separately aggregated at style-name grain before joining. Derive earliest launch with first-sale fallback, sort missing metrics last, and recompute both quarter counts from each quarter's filtered rows.