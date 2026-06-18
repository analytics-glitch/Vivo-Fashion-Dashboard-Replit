---
name: Fabric dashboard innerHTML / XSS
description: The static fabric dashboard renders ERP text via innerHTML — interpolated fields must be escaped.
---

# Fabric dashboard renders ERP text via innerHTML

`fabric_dashboard_live.html` is a static dashboard (served by api_pg's catch-all, gated)
whose JS builds every table/legend/bar by string-templating into `.innerHTML`. The data
includes free-text ERP fields from Odoo (`name`, `supplier`, `fiber_content`,
`primary_color`, `product_name`/move period, etc.).

**Rule:** any data-derived string interpolated into innerHTML must go through the `esc()`
helper; any value used to build a CSS class fragment (e.g. `badge-${plain_print}`) must go
through `badgeClass()` (lowercases + strips non-alpha). Numbers via `fmt`/`fmtKES` are safe.

**Why:** authenticated BI session + unescaped ERP text = stored XSS. A code review caught
this when the register gained a dynamic, user-selectable column model (a localStorage-backed
column picker over ~21 product attributes) that widened the unescaped surface.

**How to apply:** when adding columns/labels/legends to the fabric dashboard, wrap text in
`esc(...)` (both the cell text and any `title="..."` attribute). The constrained-enum
backend params (consumption `group_by` ∈ category/fabric/day/week/month) are safe to
interpolate into SQL only because they are allowlisted before reaching the query.
