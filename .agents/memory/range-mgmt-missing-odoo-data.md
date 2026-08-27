---
name: Range Management missing-status/tier export
description: How "genuinely missing" Odoo status/tier is defined and detected for Range Management, and why it's a separate lightweight query rather than a change to range_mgmt_classify.
---

# Missing Odoo status/tier detection

The user's rule: Range Management must use Odoo's own per-style Status and
Tier fields directly (already true — see `_lifecycle_tier`); anything Odoo
has genuinely NOT set should be flagged for the team to fill in, not guessed
or silently defaulted.

**Definition of "missing" (not just "non-live"):**
- Missing status = NONE of a style's SKU rows carry any status value at all.
  An explicit non-live value (Archived, Partner Brand, Sample, Retired) is
  real Odoo data, not a gap.
- Missing tier = style is Odoo-status Active (live) but no SKU row carries a
  recognized tier value — i.e. exactly the condition that makes
  `_lifecycle_tier` fall back to Tier 4.

**Measured baseline (2026-08-27):** 1,740 of 3,699 styles (47%) have no Odoo
status at all; 0 Active styles are missing a tier (that half of the ask was
already satisfied before this work).

**Why a separate query instead of touching `range_mgmt_classify`:** that
function is a heavy, rollup-backed query (`rollup_rm_prod` fast path +
live-query fallback) that already reconciles with the dashboard's displayed
counts. Bolting gap-detection onto it risks rollup-schema churn for a feature
that's read rarely (an on-demand Excel export). Built as an independent
lightweight helper (`_odoo_status_tier_gaps`) scoped identically to
`classify()`'s universe (non-blank style_name, non-third-party brand) so the
two stay comparable without sharing implementation.

**How to apply:** any future "why is Odoo data missing/wrong on this
dashboard" request should reuse this missing-vs-non-live distinction rather
than treating a non-live status as a data quality bug.

**Correction (2026-08-27, user report "can't find these in Odoo"):** measured
against live Odoo via XML-RPC, ALL 1,740 flagged styles turned out to have
ZERO product record in Odoo at all (not archived — genuinely absent, verified
both by direct Odoo API search and by an empty `raw_odoo_products` join).
Root cause: `transform_all_products_clean.py` has a "Sales-only SKUs" insert
path that keeps historical `all_sales` SKUs visible in `all_products_clean`
even after their Odoo product record is fully deleted, so past reporting
doesn't vanish when a style is discontinued/removed upstream. That fallback
is why these ghosts kept surfacing as "missing status" — there was nothing
to "fix" in Odoo since no record exists there to edit. Fixed by adding an
`in_odoo_now` flag (LEFT JOIN against `raw_odoo_products` by style_number) to
`_odoo_status_tier_gaps()` so the export distinguishes real Odoo data-entry
gaps (record exists, status/tier blank) from sales-only ghosts (no record at
all) — see `all-products-clean-sales-only-fallback.md`.
