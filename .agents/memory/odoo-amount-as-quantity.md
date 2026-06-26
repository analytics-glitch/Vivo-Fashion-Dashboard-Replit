---
name: Odoo amount-as-quantity unit inflation
description: Why Units Sold / MSI / ASP can spike from a single Odoo POS line, and the clamp that fixes it
---

# Odoo "amount-as-quantity" lines inflate Units Sold / MSI / ASP

Some Odoo POS order lines use a **nominal catch-all product priced at KES 1 (or 0)**
and encode the charged *amount* in the quantity field — e.g. a line
`price_unit=1, qty=8600` to ring up a KES 8,600 charge. The **revenue is real**
(the money columns derive from `price_subtotal_incl`, so totals stay correct), but
the **unit count is not** — one such line counted 8,600 "units" and on a single day
drove Total Units Sold ~10×, MSI (units/orders) to ~16.7 (vs a normal ~2), and
crushed ASP (sales/units).

**Fix — clamp the unit count, never the money.** In *both* Odoo write paths
(`transform_all_sales.transform_odoo` for the rebuild and `sync_incremental.sync_odoo`
for live/prod) the unit columns (`ordered_item_quantity` / `net_quantity`) are
collapsed to a single line-unit when `abs(qty) >= 20 AND price_unit <= 1.0`. Sign is
preserved (returns stay returns). The money fields are untouched.

**Why both paths:** units is the canonical GROSS metric copied (not centralized) across
~all `/api/*` aggregations, so correcting it at the row-write layer keeps every
endpoint consistent (kpis, country-summary, products, snapshot). A query-layer-only
clamp would make kpis disagree with the others (recon drift).

**How to apply / gotchas:**
- Gift cards already happen to carry huge quantities too, but they are excluded from
  *reporting* by BASE_FILTERS (`%gift card%`/`%gift voucher%`), so they were never the
  visible offender — the offending line is a *real product* at a nominal price.
- `sync_odoo` re-syncs recent days (DELETE+INSERT), so after the fix the live/dev rows
  self-correct on the next sync cycle (~1 min). No full rebuild needed for recent data.
- Prod is a separate DB: the correction reaches prod only after the next publish (its
  own sync loop then rewrites recent days). Historical prod rows would need the
  REBUILD_ON_BOOT gate, but only one non-gift-card offender existed, and it was recent.
- Threshold is deliberately conservative (price ≤ 1 AND qty ≥ 20) to never clamp a
  genuine multi-unit sale (those have real unit prices, so the price gate excludes them).
