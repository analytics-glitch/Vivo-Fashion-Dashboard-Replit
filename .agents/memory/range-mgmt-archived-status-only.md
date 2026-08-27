---
name: Range Management Archived bucket = Odoo Status='Archived' only
description: What the Range Management "Archived" tier means after the 2026-08-27 tightening, and where the styles that used to fall into it now go.
---

# Archived bucket definition (tightened 2026-08-27)

`_lifecycle_tier`'s original fallback ("no recognized tier and status not
Active") was a broad catch-all that the Range Management endpoint labeled
"Archived", but it actually swept together several different Odoo states:
genuinely Status='Archived' styles, Sample, Partner Brand, blank status, AND
"ghost" styles with zero Odoo record at all (see
`all-products-clean-sales-only-fallback.md`).

**User rule (2026-08-27):** in Range Management specifically, "Archived" must
mean literally Odoo Status='Archived' on the style — nothing else. Styles
that fall into the old broad fallback but do NOT have a real Status='Archived'
row (the ~1,945 ghosts/blank/Sample/Partner-Brand styles) must not appear
anywhere in Range Management — not in any tier, not in Total.

**Where implemented:** `range_mgmt_classify` (the `/api/range-mgmt/classify`
endpoint, used by every Range Management view including the CSV/tier export
which calls it directly) — after computing `is_archived = (life_tier ==
"Archived")`, it additionally checks the style against
`_odoo_archived_status_styles()` (a cached set built from
`all_products_clean` `BOOL_OR(status='Archived')`, mirroring
`_odoo_active_status_styles()`). If the style isn't in that set, the row is
skipped entirely (`continue`) before being added to any bucket — it doesn't
count toward Total.

**Deliberately scoped to Range Management only:** `_lifecycle_tier` itself was
NOT changed, so Product Analysis (which folds "Archived" into its Retired
binary and only uses the word for a per-row display label) is unaffected.
Measured impact on the Range Management universe: Active 411 / Retired 777 /
Archived 614 (down from a combined ~2,562 non-Active bucket that used to
include ~1,945 ghost/blank/Sample/Partner-Brand styles).

**How to apply:** if PA or another surface is later asked to adopt the same
strict definition, don't just point it at `_lifecycle_tier` — it will still
return the broad "Archived" label. Either reuse the same
`_odoo_archived_status_styles()` post-filter, or revisit whether
`_lifecycle_tier`'s contract itself should change (that would require
auditing every call site, since some currently assume it never returns
anything other than a real tier/Retired/Archived string).
