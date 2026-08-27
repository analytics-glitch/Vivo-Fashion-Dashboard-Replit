---
name: all_products_clean sales-only fallback keeps deleted Odoo styles visible
description: Why a style can appear in all_products_clean / Range Management with blank Odoo status even though Odoo has zero record of it — and why that's not a data-entry gap to fix.
---

# Sales-only SKUs fallback

`transform_all_products_clean.py` has a "Sales-only SKUs" insert path that
keeps a style visible in `all_products_clean` using only its historical
`all_sales` rows, even after its product record is fully deleted from Odoo.
This preserves reporting continuity (past sales/stock history doesn't vanish
when a style is discontinued and removed upstream), but it means a
non-trivial share of the Range Management universe (measured 2026-08-27:
~1,943 of 3,699 styles, 47%) has NO Odoo status/tier at all — not "blank in
Odoo", genuinely absent from `raw_odoo_products`.

**Why this matters:** any dashboard logic that treats "no live status/no
recognized tier" as a single catch-all bucket (e.g. the old broad definition
of Range Management's "Archived") silently mixes these Odoo-deleted ghost
styles in with styles that Odoo genuinely marks Status=Archived. They are not
the same population — verify against `raw_odoo_products` directly (or an
Odoo-status lookup set) before treating a style as having a real Odoo status
value of any kind.

**How to apply:** for any "why is this style missing/miscategorized" question,
first check whether the style has ANY row in `raw_odoo_products` by
style_number. If not, it's a sales-only ghost — there is nothing to fix in
Odoo, and it should generally be excluded from Odoo-status-driven
classifications rather than defaulted into a catch-all bucket.
