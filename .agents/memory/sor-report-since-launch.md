---
name: SOR report "since launch" + units basis
description: How the catalog SOR report defines lifetime units/SOR and which units basis it uses.
---

The Exports "SOR Report" (frontend reads `/api/analytics/sor-all-styles`) shows
both 6-month and lifetime ("since launch") figures.

- **Units basis = net_quantity (returns-netted), NOT gross `_UNITS`.** `units_6m`,
  `sor_6m`, `units_since_launch`, and `sor_since_launch` all use `SUM(net_quantity)`.
  This deliberately differs from the canonical "units sold" headline
  (`/api/kpis.total_units`, country-summary) which is GROSS
  `ordered_item_quantity`. Keep them aligned with each other (all net) so the
  report's own 6m-vs-lifetime columns stay internally consistent.
  **Why:** the SOR/sell-through lens is a velocity/lifecycle view, like the
  Product Analysis cockpit, which also uses net units.

- **"Since launch" = no date filter** (lifetime over the style's full history),
  but still scoped by the country/channel filter. `sor_since_launch` mirrors the
  6m formula: `100 * units_since_launch / (units_since_launch + soh_total)`.

- **Watch the layers:** this endpoint aggregates in Python over a SQL result, so
  any new measure must be threaded through all three: the CTE, the outer SELECT,
  AND the output dict. A field present in the CTE but absent from the outer
  SELECT raises a KeyError; absent from the output dict shows blank in the UI
  (this is exactly how category/original_price/units_since_launch/sor_since_launch
  were silently missing).
