---
name: Online pseudo-country in sales & inventory
description: all_sales and all_inventory hold Shop Zetu online rows under country='Online', not Kenya — country filters must fold it in.
---
Both `all_sales` and `all_inventory` store the Shop Zetu online feed under the pseudo-country **'Online'** (Rwanda's online sales are country='Rwanda'; online-held stock exists only under 'Online').

**Why:** A naive `country = 'Kenya'` filter silently drops all Kenyan online sales and all online SOH, producing zero online revenue / degenerate SOR for Kenya, and dividing country-scoped sales by all-country stock if only one side is filtered.

**How to apply:** Any channel-split query that accepts a country filter must (1) fold 'Online' into the selection when Kenya is selected, on BOTH the sales and the inventory side, in lockstep; (2) never country-filter one side of a ratio (SOR/WOC) without the other.
