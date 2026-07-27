---
name: Fabric Product Costing tab
description: Costing sheets on /fabric — email-allowlist gate, DPS labour cost source, MO→style matching rule
---
- Access is a strict email allowlist `_FABRIC_COSTING_EMAILS` in fabric_router.py (admin role does NOT qualify); enforced in api_pg clerk_auth_gate middleware for all `/api/fabric/costing/*`; UI tab hiding is UX only and fails closed via GET /costing/access.
- Labour/CMT cost lives on the Odoo DPS model `mrp.production.day` (`total_labour_cost`, `total_production_cost`, `cost_per_unit`), reached via `mrp.production.dps_id`; stored on mo_fabric_consumption (dps_cost_per_unit etc.). Labour per garment = produced-qty-weighted avg.
- **MO→style matching:** never match mo_fabric_consumption.style_name to the product master (Odoo MO names embed fabric+colour); match `finished_sku = all_products_clean.sku` — 99.9% join when master intact.
- One sheet per style (unique on lower(style_name)); POST returns 409; line totals recomputed server-side; edits append fabric_costing_history rows.
- Fabric cost/m suggestion = latest PO price_unit per kg × kg_per_mtr_eff, fallback fabric master standard_price; weighted across the style's fabrics by metres used.
