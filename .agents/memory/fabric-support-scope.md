---
name: Fabric support-fabric scope
description: How the Fabric dashboard splits "support fabrics" (Lining + Interfacing) out of the main view, and the reconciliation invariant.
---

# Fabric support-fabric scope (Lining + Interfacing)

The Fabric dashboard splits "support fabrics" — the **Lining** and **Interfacing**
categories — out of the main view into a dedicated "Support Fabrics" tab.

Rule: every aggregating fabric endpoint takes a `scope` query param (`fabric_router.py`):
- `main` (default) → EXCLUDES support fabrics (the original tabs).
- `support` → keeps ONLY support fabrics (the new tab).

Matching is a **normalized substring** (`_support_match`/`_scope_sql`): lower/trim
the category, then `LIKE '%lining%' OR '%interfacing%'` — NOT a brittle exact-string
list (catches 'Lining', 'Crepe Lining', 'Fusable Interfacing', spelling variants).

**Reconciliation invariant:** `main + support == the old all-fabric totals`.
Rows with NULL/'' category (e.g. sheet-override moves whose product_id didn't resolve)
normalize to '' → `NOT support` → they stay in MAIN. So never route unclassified rows
to support, or the reconciliation breaks.

**Why:** the buying team wanted support fabrics off the headline figures without
losing them entirely, and the two views must still sum to the historical totals so
no one thinks stock disappeared.

**How to apply:** any NEW aggregating fabric endpoint (or any that gains a product
join) must thread `scope` + `AND {_scope_sql(scope)}`. Movement endpoints over the
`fabric_moves_effective` view need a `LEFT JOIN raw_fabric_products p ON p.id=m.product_id`
to scope (the view has no category). BOM Explorer (`bom-styles`, `bom`) IS scoped —
it joins components to `raw_fabric_products` on `b.component_id` (task requires every
existing tab, incl. BOM, to exclude support fabrics from main); where-used /
reservations / product-search stay unscoped (lookups, not category totals). Verify
reconciliation with a read-only SQL FILTER split (RMAT/Stock + Dead/Stock Fabric for
stock; component-count split for BOM).
