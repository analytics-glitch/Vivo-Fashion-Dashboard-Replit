---
name: Manual style retirement (effective-retired predicate)
description: Durable code-level list that force-retires specific styles across all active/retired endpoints; why it's code not DB, and the consistency rule.
---

# Durable manual style retirement

There is a code-level list of style names that are force-treated as **retired**,
overriding the automatic age/sales/SOR retirement rules. Lives in `api_pg.py` as
`_MANUAL_RETIRED_STYLES` → `_RETIRED_STYLE_NORM` (frozenset of normalized names)
→ `_is_manually_retired(style_name)` predicate, with `_norm_style()` doing the
matching.

**Why code, not a DB table / not `_RANGE_OVERRIDES` / not `all_products_clean.active`:**
- Prod is a SEPARATE database (see `prod-separate-db-rebuild.md`); a DB row written
  in dev never reaches prod. A code constant ships with a publish.
- `_RANGE_OVERRIDES` is in-memory only (wiped on every API restart).
- `all_products_clean.active` is sourced from Odoo and **overwritten on every product
  sync**, so any manual edit there is transient.
A code constant survives restarts, data syncs, and ships to prod — the only durable
option without new infra.

**Matching is whitespace/encoding-insensitive** via `_norm_style()`: NFKC, NBSP→space,
the `\u00ac\u2020` mojibake-of-NBSP→space, collapse whitespace, trim, lowercase. The
source list was matched against catalog `style_name`s through this same norm. Watch for
catalog names that carry a real NBSP (e.g. "… Kimono\u00a0- Black") vs. a source file
with the mojibake or a plain space — they only reconcile after normalization, which is
why raw SQL equality on `style_name` cannot express this match.

**Consistency rule (the trap):** retirement is determined in MULTIPLE endpoints, and
they must ALL honor `_is_manually_retired`, or one screen shows a style retired while
another shows it active. Known sites that were wired:
- `/api/range-mgmt/classify` (after the "all Zoya is retired" rule)
- `/api/analytics/product-analysis` (active/retired toggle keep-loop)
- `/api/analytics/sor-all-styles` (active/retired filter)
- `/api/inventory-style-counts` (counts computed in Python from the sold/instock sets
  because the normalized match can't be done in SQL; keep buckets disjoint so
  active + retired == total)
**How to apply:** any NEW endpoint that buckets styles active-vs-retired must call the
same predicate. A style only ever surfaces if it exists in that endpoint's dataset —
listed styles with zero sales AND zero inventory simply don't appear anywhere (nothing
to show), which is expected, not a gap.
