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

**`esc()` is HTML-escaping, NOT JS-string-escaping.** Never interpolate ERP text into an
inline event handler (`onclick="fn('${esc(v)}')"`) — HTML entities are decoded before the
JS string is evaluated, so a crafted value (quotes/backslashes) breaks out and executes.
For row/element handlers carrying untrusted values (e.g. the collapsible category table's
`toggleConsCat`), put the value in a `data-*` attribute (`esc()`'d, attribute context) and
read it back via a single delegated `addEventListener` on the container. A code review
caught this on the new cat/subcat consumption-stock table.
