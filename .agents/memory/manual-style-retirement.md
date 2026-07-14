---
name: Style retirement source (Odoo status field)
description: Retirement now comes ONLY from Odoo product status (all_products_clean.status); rule, mixed-style handling, and the multi-endpoint consistency trap.
---

# Style retirement = Odoo status field

Retirement is sourced from the Odoo product status attribute (x_vivo_attr_97 →
`raw_odoo_products.status` → `all_products_clean.status`, values
'Active'/'Retired', synced hourly). The old durable code-level manual list AND
the "all Zoya is retired" rule were REMOVED at the user's request (July 2026) —
Odoo is the single source of truth; the merch team maintains it there, and the
hourly sync propagates it to dev AND prod (no code-ship needed anymore).

**Style-level rule:** a style is Retired iff at least one of its SKUs has
`status='Retired'` AND none has `status='Active'` (Active wins for mixed
styles; NULL/blank status alone never retires). Expressed once as
`_ODOO_RETIRED_STYLES_SQL` in `api_pg.py`, shared verbatim by:
- the cached Python set `_odoo_retired_styles()` (300s TTL, normalized via
  `_norm_style`) backing the predicate `_is_manually_retired(style)` — the
  function KEPT its legacy name so the many call sites needed no change;
- the Warehouse Returns retired-mode SQL (`IN (subquery)`), so Python and SQL
  consumers can never drift.

**Consistency rule (the trap):** retirement is determined in MULTIPLE endpoints
and they must ALL go through `_is_manually_retired` / `_ODOO_RETIRED_STYLES_SQL`,
or one screen shows a style retired while another shows it active. Known sites:
`/api/range-mgmt/classify`, `/api/analytics/product-analysis`,
`/api/analytics/sor-all-styles`, `/api/inventory-style-counts` (Python-side
because the normalized match can't be raw SQL equality),
`/api/analytics/warehouse-return-candidates` (retired mode force-includes
Odoo-Retired styles even if still selling; aged mode excludes them).

**How to apply:** any NEW endpoint bucketing active-vs-retired must use the
shared predicate/SQL, never re-derive from `active`, sales recency, or brand.
Zoya styles are NOT auto-retired anymore — 35+ are Odoo-Active by design.
