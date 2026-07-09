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

Matching is **EXACT normalized category equality** (`_support_match`/`_scope_sql`):
`LOWER(BTRIM(COALESCE(category,''))) IN ('lining','fusable interfacing')`. It was
deliberately tightened FROM a substring `LIKE '%lining%' OR '%interfacing%'` because
the substring form wrongly pulled in the near-named category "Crepe Lining". Support
Fabrics is defined as EXACTLY the two Odoo categories **Lining** and **Fusable
Interfacing** — nothing else. "Crepe Lining" stays in MAIN.

**Product-level overrides:** the category rule is OR'd with an admin-editable list of
case-insensitive product-NAME prefixes (`fabric_support_overrides` table, lazily
ensured + code-seeded from `_SUPPORT_OVERRIDE_SEED`, CRUD at
`/api/fabric/support-overrides`, writes admin-gated in the api_pg auth gate like
rolls). These force whole fabric families (e.g. sampling-only Dexing/Yiyi lines whose
Odoo category is a main-fabric one) into SUPPORT regardless of category. The match
uses `starts_with()` (never `LIKE '%'` — psycopg2 literal-% trap) and is wrapped in
`COALESCE(id IN (…), FALSE)` so NULL-product rows still land in MAIN (reconciliation).
In support-scope responses, override-only products are relabelled **"Lining/Sampling"**
via `_category_label_sql(scope, col)` — every category-displaying endpoint must use it
or the Support tab surfaces confusing main-category names. The seed matched 55
products in dev (the request estimated ~45 — prefix families are bigger than eyeballed).

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
