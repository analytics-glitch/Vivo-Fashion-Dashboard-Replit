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

## SQL three-valued-logic trap (why the flagging is in Python, not SQL)
A naive `bool_or(NOT ((uom IN kg AND kpm>0) OR uom IN metres))` SILENTLY MISSES rows where `kpm IS NULL` (fabric not in raw_fabric_products): `kpm>0` is NULL → the whole NOT is NULL → `bool_or` ignores NULL, so those MOs are wrongly treated as fully-convertible. The endpoint loops in Python and treats `kpm` None/0 as "bad" — this is why 90-day shows ~332 excluded MOs that a SQL bool_or reported as 0.
**Why:** preserves the "skip/flag components with no usable conversion" requirement. **How to apply:** any future aggregate that flags "missing conversion" must treat NULL kpm as missing explicitly, not rely on bool_or over a NULL-producing comparison.
