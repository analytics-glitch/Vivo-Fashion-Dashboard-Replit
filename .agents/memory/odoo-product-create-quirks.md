---
name: Odoo product-create quirks
description: Access limits and scoping rules hit when creating product.template records via XML-RPC with the integration user.
---

# Odoo product creation via the integration user

**Rules:**
- The integration user CANNOT read `ir.model.fields` ("Contact your administrator…"). Introspect fields with `fields_get` on the target model instead (returns type/relation/string, incl. presence of `is_storable`/`detailed_type`/`available_in_pos`).
- `x_vivo_attr_<N>` many2one fields point to `vivo.product.attribute.value`, whose rows are SCOPED to `vivo.product.attribute` id = N (`attribute_id` required, names repeat across attributes). Always lookup/create option values with `attribute_id = N` in the domain/vals, never by name alone.
- NOOS lives in an attribute field found by label ("NOOS Fabric", x_vivo_attr_45 today) — discover by string, don't hardcode.
- Writing `standard_price` on a tracked product with automated valuation posts a journal entry the integration user can't create → the whole create fails if cost is in the create vals. Create WITHOUT cost, then attempt a separate best-effort `standard_price` write and downgrade failure to a warning.
- Odoo 17+ here: product type Goods (tracked) = `type='consu'` + `is_storable=True` (no `detailed_type`).

**Why:** all four were hit live while building the /fabric Create Products flow; each initially failed the whole confirm request.

**How to apply:** any feature creating/updating Odoo products or attribute values over XML-RPC.
