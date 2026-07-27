---
name: Fabric Product Costing tab
description: Costing sheets on /fabric — email-allowlist gate, DPS labour cost source, MO→style matching rule
---
- Access is a strict email allowlist `_FABRIC_COSTING_EMAILS` in fabric_router.py (admin role does NOT qualify); enforced in api_pg clerk_auth_gate middleware for all `/api/fabric/costing/*`; UI tab hiding is UX only and fails closed via GET /costing/access.
- Labour/CMT cost lives on the Odoo DPS model `mrp.production.day` (`total_labour_cost`, `total_production_cost`, `cost_per_unit`), reached via `mrp.production.dps_id`; stored on mo_fabric_consumption (dps_cost_per_unit etc.). Labour per garment = produced-qty-weighted avg.
- **MO→style matching:** never match mo_fabric_consumption.style_name to the product master (Odoo MO names embed fabric+colour); match `finished_sku = all_products_clean.sku` — 99.9% join when master intact.
- One sheet per style (unique on lower(style_name)); POST returns 409; line totals recomputed server-side; edits append fabric_costing_history rows.
- Cost basis for fabric AND accessory suggestions = DPS/MO-recorded cost (`mo_fabric_consumption.unit_cost_mo`; per kg → per metre via kg_per_mtr_eff), latest-PO price only as fallback for fabric (PO pricing for accessories explicitly rejected). Odoo stock.move.price_unit is 0 and valuation layers are gated to inventory admins, so the extract records the component's average/standard cost (product.standard_price) — the cost Odoo values MO consumption at.
- mo_fabric_consumption now also holds Accessories & Trims components (Odoo categ 19) flagged `is_main_fabric=FALSE`; EVERY fabric-only reader (metres/garment KPIs, category breakdowns, movements) must filter `AND c.is_main_fabric`. fabric_router lazily ensures the columns via `_ensure_mo_cons_cols()` in q().
- New-sheet form has a style-scoped DPS # picker (GET /costing/dps lists Done DPS by dps_ref); `suggest?dps_ref=` scopes ALL suggestions (fabric metres, accessories, labour) to that one DPS (validated to belong to the style, else 404); blank = 365-day Done-DPS average. Chosen dps_ref persists on fabric_costing_sheets.dps_ref and shows read-only on reopen.
- Accessory suggestion lines: kind='trim', qty/garment = Σconsumed ÷ Σproduced per component, unit cost = consumed-weighted avg unit_cost_mo, AUTO badge; capped at 25 components.
