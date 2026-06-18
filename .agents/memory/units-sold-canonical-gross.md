---
name: Units-sold canonical definition is GROSS
description: The one true "units sold" metric is gross ordered_item_quantity on sale/order rows; net_quantity is velocity-only. Why the recon units check drifts if you mix them.
---

# "Units sold" = GROSS, everywhere it is a sales headline

The single canonical sales-grain units measure is `_UNITS` =
`SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END)`
— **gross** units on sale/order rows, returns NOT subtracted.

Used by: `/api/kpis.total_units`, `/api/country-summary`, `/api/sales-summary`,
products, the report builder (`_REPORT_MEASURES`), and
`/api/analytics/canonical-units-sold` (which the web Overview prefers, falling
back to `kpis.n`).

**Why:** the admin reconciliation pill (`/api/admin/reconciliation-check`)
asserts Σ(per-country units_sold) == kpis.total_units. `/api/kpis` historically
computed `total_units = SUM(s.net_quantity)` (returns-netted) while every
per-country/products aggregate used the gross `_UNITS`. That mismatch made the
"country units sum eq kpis" check fail permanently by exactly the return volume
(e.g. ~4% / ~900 units), even though no aggregation was actually broken. Fixed by
making `/api/kpis.total_units` use the gross `_UNITS` definition.

**How to apply:** any new "units sold" headline/aggregate must use the gross
`sale_kind IN ('sale','order') THEN ordered_item_quantity` form so the same
metric name means the same number everywhere. Reserve `SUM(net_quantity)` for
**velocity / weeks-of-cover / lifecycle** math (replenish, IBT, and the Product
Analysis cockpit, which intentionally reports net-of-returns units and therefore
differs from the gross headline by the return volume — documented in its header
comment). Do NOT "fix" that PA divergence thinking it's a bug.
