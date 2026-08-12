---
name: Style status source of truth (sheet overrides > Odoo base)
description: style_tier_overrides (imported buying sheet) is the authoritative Active/Retired layer on RM + PA; Odoo status is only the base model. Precedence rules, the PA projection trap, and which endpoints still diverge.
---

# Style Active/Retired: `style_tier_overrides` wins; Odoo status is the base

Since Aug 2026 the imported buying-sheet table `style_tier_overrides`
(style_number → status Active/Retired/Archived + tier) is the SOURCE OF TRUTH
for Active vs Retired on **Range Management AND Product Analysis** (PA powers
the PA page, Store Detail cockpit, Style Cockpit, exec summary). Precedence,
applied LAST after the base model, identical on both surfaces:

- Active + tier → use the sheet tier (CAN un-retire an Odoo-retired style)
- Retired / Archived → Retired
- not on the sheet → Retired, but ONLY when the table is populated
  (probe = any override row observed in the result set, same as RM)

Business-wide PA "active" can read one or two BELOW RM's Active count: RM
force-includes zero-stock sheet-Active styles (`OR tov.status='Active'` in its
universe); PA's universe still requires stock or in-window sales.

**Base model (fallback / legacy consumers):** Odoo product status
(`all_products_clean.status`, hourly sync). Style-level rule: Retired iff ≥1
SKU 'Retired' AND none 'Active' (Active wins mixed; NULL never retires) —
`_ODOO_RETIRED_STYLES_SQL` / `_is_manually_retired`. The old manual list and
"all Zoya retired" rules stay REMOVED.

**Known divergent endpoints (still Odoo-base only):**
`/api/analytics/sor-all-styles` (SOR report), `/api/inventory-style-counts`,
`/api/analytics/warehouse-return-candidates`. If a user reports a style
Active on one screen and Retired on another, check which layer that surface
uses before touching data.

**The PA projection trap:** `analytics_product_analysis` RE-PROJECTS raw SQL
rows into explicit dicts before the style-grouping/classification loops. A new
SQL output column that is not added to that projection dict silently vanishes
downstream (the override layer no-ops and status falls back to the base model
with NO error). When adding columns to the PA SQL, thread them through the
projection too, then verify counts via the live endpoint, not just the SQL.

**How to apply:** any NEW endpoint bucketing active-vs-retired must apply the
override precedence above on top of the shared base predicate — never
re-derive from `active`, sales recency, or brand.
