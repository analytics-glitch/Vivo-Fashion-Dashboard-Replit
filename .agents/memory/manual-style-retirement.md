---
name: Style status source of truth (SUPERSEDED 2026-08-27 — overrides removed)
description: HISTORICAL — style_tier_overrides used to be an authoritative override layer on top of Odoo status/tier. As of 2026-08-27 all overrides were removed dashboard-wide by explicit user instruction; Odoo (_lifecycle_tier) alone is now the source of truth everywhere. See range-tier-model.md for the current model.
---

# Overrides removed (2026-08-27) — read range-tier-model.md instead

The user instructed: "In every report with Tier and Status, it MUST read
from odoo and match Range Management. Remove any other rule, including in
merchandising." Confirmed: "Yes, remove all overrides everywhere — proceed."

As a result, everything below this line is **historical** and no longer
reflects the running code — kept only so a future agent doesn't reintroduce
the same override precedence by mistake:

- The `style_tier_overrides` imported-buying-sheet table is no longer read by
  Range Management, Product Analysis, or Merchandising Hub. Its DB table and
  seed/ensure infra (`_ensure_style_tier_overrides_table`,
  `_seed_style_tier_overrides`) are still physically present (low risk,
  simply unconsumed) — do not treat their continued existence as evidence
  the override layer is still active.
- The in-memory `_RANGE_OVERRIDES` dict (manual Tier 1-4 promotion) in
  `api_pg.py` was deleted entirely, including its Range Management
  application block and the `/api/range-mgmt/overrides/bulk-promote`
  endpoint (now returns HTTP 410) and the corresponding
  `RangeManagement.jsx` promote UI (removed).
- Merchandising Hub's own independent reorder-cycle `_compute_tier()` model
  was replaced with a thin delegate to `api_pg._lifecycle_tier`.

**Known consequence:** Product Analysis lost the ability for the buying-sheet
override to un-retire a style or override its tier; Range Management lost the
manual "promote to Tier 2" feature; Merchandising Hub's tier numbers shifted
substantially (moved from reorder-count-based tiering to Odoo-tier-based, and
now fully excludes ghost/no-status styles via the `None` sentinel — see
range-tier-model.md).

**Still true / unaffected by this change:** the endpoints noted as
"divergent" below (SOR report, inventory-style-counts,
warehouse-return-candidates) still use the Odoo-status-only base model they
always did — they were never on the override layer to begin with, so nothing
changed for them.

---

*(Original historical content preserved below for archaeology only — do not
follow this precedence in new code.)*

Since Aug 2026 the imported buying-sheet table `style_tier_overrides`
(style_number → status Active/Retired/Archived + tier) was the SOURCE OF
TRUTH for Active vs Retired on Range Management AND Product Analysis, applied
LAST after the base Odoo-status model: Active+tier → sheet tier (could
un-retire); Retired/Archived → Retired; not-on-sheet → Retired (only when the
table was populated). This precedence is REMOVED as of 2026-08-27.

**The PA projection trap (still a real, general risk — not override-specific):**
`analytics_product_analysis` re-projects raw SQL rows into explicit dicts
before the style-grouping/classification loops. A new SQL output column that
is not added to that projection dict silently vanishes downstream with no
error. When adding columns to the PA SQL, thread them through the projection
too, then verify counts via the live endpoint, not just the SQL.
