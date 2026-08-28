---
name: Colour-style status is derived
description: Colour-style lifecycle is derived from that colourway's own Odoo rows; sibling statuses must never bleed across colourways.
---

# Colour-style status uses only that colourway's Odoo rows

**Rule:** derive lifecycle independently at `(style, colour)` grain from the
Odoo status values on that colourway's own SKU rows. Precedence is Active,
then Retired, then Archived, then no status. Sibling colourways never
participate.

The Active Colour Styles KPI/export includes a colourway only when its own
derived status is Active and its scoped stores + sellable-warehouse SOH is
positive. Stock does not define lifecycle status; it only gates this KPI.

**Why:** Odoo can retire/archive one colourway while a sibling keeps the parent
style Active. Parent status + stock incorrectly counted that retired colourway
as Active.

**How to apply:** aggregate status flags from `all_products_clean` at
`(style_name, color_print)` before joining inventory. Keep parent STYLE status
as its separate all-colour roll-up (Active > Retired > Archived). Use
product-master colour via SKU, never the inventory colour column.
