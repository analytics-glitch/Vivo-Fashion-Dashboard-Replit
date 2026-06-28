---
name: Fabric Trend Analysis builder
description: The /fabric "Trend Analysis" tab — multi-panel KPI-over-time builder, its 6 metres-only KPIs, and the stock back-cast convention.
---

The Fabric BI "Trend Analysis" tab (formerly "Movement & Use") is a multi-panel
KPI-over-time builder modelled on main BI's Trend Analysis. Backend:
`/api/fabric/trend-series` + `/api/fabric/trend-options` in `fabric_router.py`.

**Metres only, never kg.** All 6 KPIs are reported in metres: consumption (gross
OUT), net_consumption (OUT − internal prod returns), received (IN), stock_on_hand,
returns (prod→stock), metres_per_garment (MO-based). Each row carries an
`incomplete` flag using the NULL-kg-per-metre convention (`kg_per_mtr_eff` missing →
that bucket understates metres; surfaced as amber points/bars + a footnote).

**stock_on_hand is BACK-CAST, not a stored snapshot.** There is no historical stock
table. The series is computed in Python from the *current* on-hand total minus the
net flow (received − net_consumption) walked backwards bucket by bucket, so the
latest bucket equals the live snapshot. **Why:** Odoo inventory is point-in-time
only; any historical stock line must be derived, and the only anchor is "now".

**Page-local date range.** This tab owns its own preset (3/6/12/24 mo, default 12)
+ custom range and is intentionally NOT wired to the topbar Date range
(`onDateRangeChange` no longer touches the movement page). Other date-driven tabs
(Stock Mix, Overview colour mix) still follow the topbar.

**Scope priority** (server-side): product_id > subcategory > category, applied on
the product master `p`; location filters moves (from OR to) and inventory
(location_name) but metres_per_garment ignores location (MO-grain, no location).
trend-options surfaces categories/subcategories/fabrics(id,name)/locations for the
scope dropdown.

Frontend is the vanilla-JS `fabric_dashboard_live.html` builder (no charting lib —
SVG line/bar drawn by `tpChart`). All interpolated text goes through `esc()`
(stored-XSS rule, see fabric-dashboard-xss.md).
