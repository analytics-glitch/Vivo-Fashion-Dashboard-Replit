---
name: Avg metres per garment KPI
description: How the Fabric Overview "Avg metres / garment" KPI is sourced from Done DPS MOs, and the Odoo field + SQL-NULL gotchas behind it.
---

# Avg metres of fabric consumed per garment

KPI on the Fabric Overview = Σ(main-fabric metres consumed across qualifying Done DPS MOs) ÷ Σ(garments produced across those MOs), rolling last 90 days by MO completion date. Source table `mo_fabric_consumption` (populated by `extract_mo_fabric_consumption.py`, wired into the sync loop on the 30-min production cadence with self-bootstrap; prod is a separate DB so it stays empty until publish).

## Odoo field facts (this Odoo version)
- DPS link on a manufacturing order = `mrp.production.dps_id` (many2one → DPS, label like `DPS00332`). `origin` also carries the DPS string but `dps_id` is the structured filter (`['dps_id','!=',False]`).
- Done component qty = `stock.move.quantity` (the field `quantity_done` was REMOVED — reading it raises `ValueError: Invalid field 'quantity_done'`).
- Garments produced = `mrp.production.qty_produced`; completion date = `date_finished`; raw components = `move_raw_ids`.
- Main fabric = product `categ_id == 18` ("Raw Materials-Fabric" = FABRIC_CATS[0] in extract_fabric.py). Trims/accessories = categ 19, excluded. Fabric consumed UoM is `kg` (and some `g`).

## Conversion + distortion guard
- kg→metres at READ time via `raw_fabric_products.kg_per_mtr_eff` (join on product id = component_id); grams ÷1000 first; a metre UoM is used as-is.
- An MO is counted ONLY if EVERY fabric component is convertible AND it produced >0 garments. MOs with any unconvertible fabric are excluded and reported as `mos_excluded_missing_conversion` (so the avg isn't silently understated).

## Per-style breakdown (heaviest fabric consumers)
- `mo_fabric_consumption` also stores the MO's finished product (`finished_product_id`/`finished_sku`/`finished_name`) and its template (`finished_tmpl_id`/`style_name`). `style_name` = `mrp.production.product_id`'s `product_tmpl_id` NAME (size/colour variants share a template), falling back to the variant name. Columns are added via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `create_table` so existing tables (and prod via the sync-loop self-bootstrap) migrate in place.
- `/api/fabric/metres-per-garment-by-style` reuses the EXACT per-MO conversion + exclusion rule of the headline KPI, then rolls qualifying MOs up by `style_name` → one row per style {metres_per_garment, total_metres, garments, mos, mos_excluded}. Summing qualifying MOs by style reconciles to the KPI totals (each MO maps to one style).
- This breakdown surfaces data anomalies by design: a single bad fabric move (kg recorded as a huge number / wrong UoM) shows as a wildly high m/garment outlier (e.g. one style at ~1700 m/garment that also dominates the KPI's total_metres). That is the source data, not a code bug — the breakdown is the tool to spot & fix it in Odoo.

## Fallback-driving fabrics → Odoo deep link
- `/api/fabric/data-quality/mo-missing-conversion` + the metres-per-garment.xlsx "Fabrics to fix" sheet surface every fabric that forced the fallback, each with `missing_fields` (Width/GSM/Kg-Mtr) and an Odoo deep link.
- Odoo product link = `f"{ODOO_URL}/web#id={component_id}&model=product.product&view_type=form"` — `component_id` (mo_fabric_consumption) == `raw_fabric_products.id` == Odoo product.product id. Helper `_odoo_product_url` returns None when ODOO_URL unset (omit link, don't render a broken one).
- The endpoint still returns the field `mos_excluded_missing_conversion`, but that count is now "MOs that fell back" (the KPI no longer drops them); keep the field name for the frontend even though the user-facing wording says "fell back".

## By-category breakdown join rule
Garment category (Margin Analysis taxonomy: Dresses/Bottoms/Tops/Outerwear/Skirts…) must be looked up via `all_products_clean.sku = mo_fabric_consumption.finished_sku` — NEVER via style_name: MO style names embed fabric + colour ("… in Rib - Dark Olive") and match 0 product-master styles. Shared `_MPG_CATEGORY_SUBQ` + `_mpg_category_where` in fabric_router; MOs with no SKU match go to an explicit "Uncategorised" bucket so the breakdown reconciles to the headline (user-confirmed choice).

## SQL three-valued-logic trap (why the flagging is in Python, not SQL)
A naive `bool_or(NOT ((uom IN kg AND kpm>0) OR uom IN metres))` SILENTLY MISSES rows where `kpm IS NULL` (fabric not in raw_fabric_products): `kpm>0` is NULL → the whole NOT is NULL → `bool_or` ignores NULL, so those MOs are wrongly treated as fully-convertible. The endpoint loops in Python and treats `kpm` None/0 as "bad" — this is why 90-day shows ~332 excluded MOs that a SQL bool_or reported as 0.
**Why:** preserves the "skip/flag components with no usable conversion" requirement. **How to apply:** any future aggregate that flags "missing conversion" must treat NULL kpm as missing explicitly, not rely on bool_or over a NULL-producing comparison.
