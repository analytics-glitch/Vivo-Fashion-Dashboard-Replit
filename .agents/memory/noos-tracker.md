---
name: NOOS tracker
description: Contract for the NOOS (Never Out Of Stock) tab in the Inventory hub + /api/analytics/noos-report — universe, velocity parity, gap matrix, not_ranged rule.
---

# NOOS tracker (Inventory Management hub tab)

- Universe = ALL styles with `all_products_clean.is_noos` (Odoo-synced, = Tier 1 in the
  shared lifecycle-tier model). Every flagged style always appears — zero stock + zero
  sales is the loudest alarm, never a reason to drop a row.
- Velocity/cover must stay in LOCKSTEP with /analytics/weeks-of-cover: gross
  ordered_item_quantity, trailing 56d, (u28×2 + max(u56−u28,0))/12. Thresholds derive
  from REORDER_COVER_WEEKS (critical) and 2× it (low) — never hardcode.
- Cover buckets follow the pipeline-SOH canon: total cover = stores + sellable
  warehouse; pipeline shown as "Incoming" only, NEVER in cover.
- Store-gap matrix universe = active physical stores (any current stock, minus
  warehouse/holding/online name patterns); the stores SOH bucket itself stays canonical
  so bucket totals reconcile with other SOH surfaces even when the matrix excludes a
  location (e.g. online).
- **not_ranged rule:** in a country-filtered view, zero stock (all buckets) + zero 56d
  sales in that country = "Not ranged here" (grey, no store gaps counted), NOT "out".
  **Why:** small markets range only part of the NOOS list; per-country views otherwise
  drown in false out-of-stock alarms. All-countries view keeps the true global "out".
- KPI cards must visibly sum to the tracked total — the caption line enumerates the
  quiet states (No sales, not ranged). Same additivity lesson as the Production
  Overview style cards.
