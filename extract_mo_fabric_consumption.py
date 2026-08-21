#!/usr/bin/env python3
"""
extract_mo_fabric_consumption.py
--------------------------------
Extracts MAIN-FABRIC consumption from Done DPS manufacturing orders in Odoo
(`mrp.production`) to feed the "Avg metres per garment" KPI on the Fabric Overview.

For each manufacturing order with state='done' AND a DPS reference (`dps_id` set),
within a trailing window by completion date (`date_finished`), we read its raw
component moves (`move_raw_ids` -> stock.move) and keep ONLY the main-fabric
components — products in the Odoo "Raw Materials-Fabric" category
(categ_id 18 = FABRIC_CATS[0] in extract_fabric.py). Accessories & Trims (categ 19)
and everything else are excluded. We store the ACTUAL consumed quantity
(stock.move.quantity, the done qty on a done move) and its UoM, plus the MO's
produced quantity in pieces (`qty_produced`) as the per-garment denominator.

Idempotent: rows are upserted on (odoo_mo_id, component_id); consumed qty is summed
per (MO, component) before write so multiple component moves of the same fabric in
one MO don't collide on the PK. Safe to run standalone for a one-time prod backfill.

kg->metres conversion is NOT done here — it is applied at read time in
fabric_router.py via each fabric SKU's `kg_per_mtr_eff` on raw_fabric_products, so
this extract stays a faithful copy of Odoo's consumed quantity + UoM.

Run:
    python extract_mo_fabric_consumption.py [--days N]   # default window 180 days
"""
import argparse
import logging
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta

import psycopg2
import xmlrpc.client
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

ODOO_URL = os.environ["ODOO_URL"]
ODOO_DB = os.environ["ODOO_DB"]
ODOO_USER = os.environ["ODOO_USER"]
ODOO_PASSWORD = os.environ["ODOO_PASSWORD"]
DATABASE_URL = os.environ["DATABASE_URL"]

# categ_id 18 ("Raw Materials-Fabric") = FABRIC_CATS[0] in extract_fabric.py.
# categ_id 19 ("03. Accessories & Trims") — captured too (flagged
# is_main_fabric=FALSE) for the Product Costing accessory suggestions. Other
# categories stay excluded. Existing fabric-only readers filter on
# is_main_fabric so they are unaffected by the accessory rows.
MAIN_FABRIC_CATEG = 18
ACCESSORIES_CATEG = 19
KEEP_CATEGS = {MAIN_FABRIC_CATEG, ACCESSORIES_CATEG}

# Default trailing window (days, by MO completion date). The KPI itself is a
# rolling 90 days; we extract a wider window so a 90-day read always has full
# coverage and a re-run can correct recently-closed MOs. Override with --days.
DEFAULT_WINDOW_DAYS = 180


def odoo_connect():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models


def create_table(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS mo_fabric_consumption (
            odoo_mo_id    BIGINT  NOT NULL,
            mo_ref        TEXT,
            dps_ref       TEXT,
            done_date     DATE,
            produced_qty  NUMERIC,
            component_id  BIGINT  NOT NULL,
            fabric_sku    TEXT,
            fabric_name   TEXT,
            consumed_qty  NUMERIC,
            uom           TEXT,
            finished_product_id  BIGINT,
            finished_sku         TEXT,
            finished_name        TEXT,
            finished_tmpl_id     BIGINT,
            style_name           TEXT,
            _loaded_at    TIMESTAMP,
            PRIMARY KEY (odoo_mo_id, component_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mo_fab_cons_done ON mo_fabric_consumption(done_date);
        CREATE INDEX IF NOT EXISTS idx_mo_fab_cons_sku  ON mo_fabric_consumption(fabric_sku);
        -- Finished-product / style columns (added later for the per-style
        -- metres-per-garment breakdown); ADD IF NOT EXISTS migrates existing tables.
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS finished_product_id BIGINT;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS finished_sku        TEXT;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS finished_name       TEXT;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS finished_tmpl_id    BIGINT;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS style_name          TEXT;
        CREATE INDEX IF NOT EXISTS idx_mo_fab_cons_style ON mo_fabric_consumption(style_name);
        -- DPS labour-cost columns (added for the Product Costing tab). The DPS
        -- (mrp.production.day) carries the day's total labour cost and a cost
        -- per unit; stored per MO row (DPS-level values, repeated per component)
        -- so labour cost per garment can be derived per style at read time.
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS dps_odoo_id        BIGINT;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS dps_labour_cost    NUMERIC;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS dps_total_cost     NUMERIC;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS dps_cost_per_unit  NUMERIC;
        -- Accessories & Trims support (Product Costing): non-fabric component
        -- rows are flagged is_main_fabric=FALSE so every pre-existing
        -- fabric-only reader (which filters on the flag) stays unchanged.
        -- unit_cost_mo = the component cost as valued on the MO move
        -- (stock.move.price_unit, per UoM unit) — the DPS-recorded cost basis
        -- for costing suggestions (never latest-PO pricing).
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS is_main_fabric BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE mo_fabric_consumption ADD COLUMN IF NOT EXISTS unit_cost_mo   NUMERIC;
        CREATE TABLE IF NOT EXISTS mo_open_component_requirements (
            odoo_mo_id BIGINT NOT NULL,
            mo_ref TEXT,
            dps_ref TEXT,
            order_state TEXT NOT NULL,
            component_id BIGINT NOT NULL,
            component_sku TEXT,
            component_name TEXT,
            required_qty NUMERIC NOT NULL DEFAULT 0,
            reserved_qty NUMERIC NOT NULL DEFAULT 0,
            uom TEXT,
            source_location TEXT,
            finished_product_id BIGINT,
            finished_sku TEXT,
            finished_name TEXT,
            style_name TEXT,
            date_planned TEXT,
            source_move_ids BIGINT[] NOT NULL DEFAULT '{}',
            _loaded_at TIMESTAMP NOT NULL,
            PRIMARY KEY (odoo_mo_id, component_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mo_open_component
            ON mo_open_component_requirements(component_id);
        CREATE INDEX IF NOT EXISTS idx_mo_open_state
            ON mo_open_component_requirements(order_state);
        CREATE TABLE IF NOT EXISTS mo_component_reservation_contributors (
            move_id BIGINT PRIMARY KEY,
            component_id BIGINT NOT NULL,
            component_sku TEXT,
            component_name TEXT,
            quantity NUMERIC NOT NULL DEFAULT 0,
            uom TEXT,
            state TEXT,
            source_location TEXT,
            move_reference TEXT,
            move_origin TEXT,
            transaction_ref TEXT,
            odoo_mo_id BIGINT,
            mo_ref TEXT,
            dps_ref TEXT,
            _loaded_at TIMESTAMP NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mo_res_component_location
            ON mo_component_reservation_contributors(component_id, source_location);
        """
    )
    cur.execute("ALTER TABLE mo_open_component_requirements "
                "ADD COLUMN IF NOT EXISTS date_planned TEXT")


def _chunks(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def extract(uid, models, cur, since_str, now):
    log.info("Fetching Done DPS manufacturing orders since %s ...", since_str)
    mos = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "mrp.production",
        "search_read",
        [[["state", "=", "done"], ["dps_id", "!=", False], ["date_finished", ">=", since_str]]],
        {
            "fields": ["name", "dps_id", "date_finished", "qty_produced",
                       "product_id", "move_raw_ids"],
            "order": "date_finished asc",
        },
    )
    log.info("Done DPS MOs in window: %d", len(mos))

    # Map each raw-component move -> its MO, and stash MO metadata (including the
    # finished product produced by the MO so consumption can be grouped by style).
    move_to_mo = {}
    mo_meta = {}
    finished_pids = set()
    dps_ids = set()
    for mo in mos:
        fpid = mo["product_id"][0] if mo.get("product_id") else None
        if fpid:
            finished_pids.add(fpid)
        dps_id = mo["dps_id"][0] if mo.get("dps_id") else None
        if dps_id:
            dps_ids.add(dps_id)
        mo_meta[mo["id"]] = {
            "mo_ref": mo.get("name"),
            "dps_ref": mo["dps_id"][1] if mo.get("dps_id") else None,
            "dps_id": dps_id,
            "done_date": (mo.get("date_finished") or "")[:10] or None,
            "produced_qty": mo.get("qty_produced") or 0,
            "finished_product_id": fpid,
        }
        for mid in mo.get("move_raw_ids") or []:
            move_to_mo[mid] = mo["id"]

    # Read each referenced DPS (mrp.production.day) once for its labour-cost
    # summary. Best-effort: a missing field or read error leaves the labour
    # columns NULL (the Costing tab then falls back to manual entry).
    dps_cost = {}
    try:
        for chunk in _chunks(sorted(dps_ids), 500):
            for d in models.execute_kw(
                ODOO_DB, uid, ODOO_PASSWORD,
                "mrp.production.day", "read", [chunk],
                {"fields": ["total_labour_cost", "total_production_cost",
                            "cost_per_unit"]},
            ):
                dps_cost[d["id"]] = d
    except Exception as e:  # noqa: BLE001 — labour cost is optional enrichment
        log.warning("DPS labour-cost read failed (labour columns stay NULL): %s", e)
        dps_cost = {}

    # Resolve finished products -> sku/name + template (the style: variants in
    # different sizes/colours share one product.template).
    finished = {}
    for chunk in _chunks(sorted(finished_pids), 500):
        for p in models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "product.product",
            "read",
            [chunk],
            {"fields": ["default_code", "name", "product_tmpl_id"]},
        ):
            finished[p["id"]] = p

    move_ids = list(move_to_mo.keys())

    # Read all raw component moves (done qty + UoM + product).
    moves = []
    for chunk in _chunks(move_ids, 500):
        moves += models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "stock.move",
            "read",
            [chunk],
            {"fields": ["product_id", "quantity", "product_uom", "price_unit"]},
        )

    # Resolve product categories so we can keep only main fabric (categ 18).
    prod_ids = sorted({m["product_id"][0] for m in moves if m.get("product_id")})
    prods = {}
    for chunk in _chunks(prod_ids, 500):
        for p in models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "product.product",
            "read",
            [chunk],
            {"fields": ["default_code", "categ_id", "name", "standard_price"]},
        ):
            prods[p["id"]] = p

    # Aggregate consumed qty per (MO, component) — sum across multiple moves
    # of the same component in one MO so the (odoo_mo_id, component_id) PK
    # holds. Keeps main fabric (18) AND accessories/trims (19); the flag says
    # which. unit_cost_mo = consumed-qty-weighted average of the moves'
    # price_unit (the cost the MO valued the component at).
    agg = defaultdict(lambda: {"qty": 0.0, "uom": None, "name": None,
                               "sku": None, "is_fabric": True,
                               "cost_amt": 0.0, "cost_qty": 0.0})
    for mv in moves:
        if not mv.get("product_id"):
            continue
        pid = mv["product_id"][0]
        prod = prods.get(pid)
        if not prod:
            continue
        categ_id = prod["categ_id"][0] if prod.get("categ_id") else None
        if categ_id not in KEEP_CATEGS:
            continue  # main fabric + accessories/trims only
        mo_id = move_to_mo.get(mv["id"])
        if mo_id is None:
            continue
        key = (mo_id, pid)
        rec = agg[key]
        qty = mv.get("quantity") or 0.0
        rec["qty"] += qty
        # Cost as valued on the MO consumption: stock.move.price_unit when the
        # move carries one (it is 0.0 across this Odoo — valuation layers are
        # not exposed to the API user), else the component's average/standard
        # cost (product.standard_price) — the unit cost Odoo values MO
        # consumption at under average costing. Never latest-PO pricing.
        pu = mv.get("price_unit") or prod.get("standard_price")
        if pu and qty > 0:
            rec["cost_amt"] += float(pu) * qty
            rec["cost_qty"] += qty
        if mv.get("product_uom"):
            rec["uom"] = mv["product_uom"][1]
        rec["name"] = prod.get("name")
        rec["sku"] = prod.get("default_code")
        rec["is_fabric"] = categ_id == MAIN_FABRIC_CATEG

    rows = []
    for (mo_id, pid), rec in agg.items():
        meta = mo_meta[mo_id]
        fp = finished.get(meta.get("finished_product_id")) or {}
        tmpl = fp.get("product_tmpl_id")
        tmpl_id = tmpl[0] if tmpl else None
        # Style = finished-product template name (its variants in different sizes /
        # colours share one template); fall back to the variant name if unset.
        style = (tmpl[1] if tmpl else None) or fp.get("name")
        dc = dps_cost.get(meta.get("dps_id")) or {}
        rows.append(
            (
                mo_id,
                meta["mo_ref"],
                meta["dps_ref"],
                meta["done_date"],
                meta["produced_qty"],
                pid,
                rec["sku"],
                rec["name"],
                rec["qty"],
                rec["uom"],
                meta.get("finished_product_id"),
                fp.get("default_code"),
                fp.get("name"),
                tmpl_id,
                style,
                meta.get("dps_id"),
                dc.get("total_labour_cost"),
                dc.get("total_production_cost"),
                dc.get("cost_per_unit"),
                rec["is_fabric"],
                (rec["cost_amt"] / rec["cost_qty"]) if rec["cost_qty"] > 0 else None,
                now,
            )
        )

    if rows:
        _upsert_rows(cur, rows)
        log.info("✅ mo_fabric_consumption: upserted %d (MO, fabric) rows", len(rows))
    else:
        log.info("No fabric/accessory components on the in-window MOs — nothing to upsert.")

    # Prune stale rows in the refreshed window so the table mirrors Odoo
    # exactly: a component removed from an MO, or an MO that lost its Done/DPS
    # status, must not linger (the Costing tab builds a DPS's component list
    # strictly from these rows). Only rows whose done_date falls inside the
    # window we just re-fetched are candidates — history outside the window is
    # never touched. This runs even when the fresh read yielded zero rows: by
    # this point every Odoo read completed successfully (any failure raises
    # and aborts before commit), so "zero rows" means Odoo genuinely has no
    # in-window Done/DPS consumption and lingering rows are stale.
    since_date = since_str[:10]
    keep = list(agg.keys())
    cur.execute("CREATE TEMP TABLE IF NOT EXISTS _mfc_keep (odoo_mo_id BIGINT, component_id BIGINT)")
    cur.execute("TRUNCATE _mfc_keep")
    if keep:
        execute_values(cur, "INSERT INTO _mfc_keep (odoo_mo_id, component_id) VALUES %s",
                       keep, page_size=1000)
    cur.execute(
        """
        DELETE FROM mo_fabric_consumption t
        WHERE t.done_date >= %s::date
          AND NOT EXISTS (SELECT 1 FROM _mfc_keep k
                          WHERE k.odoo_mo_id = t.odoo_mo_id
                            AND k.component_id = t.component_id)
        """,
        (since_date,),
    )
    if cur.rowcount:
        log.info("🧹 pruned %d stale in-window rows no longer on Odoo's Done DPS MOs",
                 cur.rowcount)
    return len(rows)


def _upsert_rows(cur, rows):
    execute_values(
        cur,
        """
        INSERT INTO mo_fabric_consumption
            (odoo_mo_id, mo_ref, dps_ref, done_date, produced_qty,
             component_id, fabric_sku, fabric_name, consumed_qty, uom,
             finished_product_id, finished_sku, finished_name, finished_tmpl_id,
             style_name, dps_odoo_id, dps_labour_cost, dps_total_cost,
             dps_cost_per_unit, is_main_fabric, unit_cost_mo, _loaded_at)
        VALUES %s
        ON CONFLICT (odoo_mo_id, component_id) DO UPDATE SET
            mo_ref=EXCLUDED.mo_ref,
            dps_ref=EXCLUDED.dps_ref,
            done_date=EXCLUDED.done_date,
            produced_qty=EXCLUDED.produced_qty,
            fabric_sku=EXCLUDED.fabric_sku,
            fabric_name=EXCLUDED.fabric_name,
            consumed_qty=EXCLUDED.consumed_qty,
            uom=EXCLUDED.uom,
            finished_product_id=EXCLUDED.finished_product_id,
            finished_sku=EXCLUDED.finished_sku,
            finished_name=EXCLUDED.finished_name,
            finished_tmpl_id=EXCLUDED.finished_tmpl_id,
            style_name=EXCLUDED.style_name,
            dps_odoo_id=EXCLUDED.dps_odoo_id,
            dps_labour_cost=EXCLUDED.dps_labour_cost,
            dps_total_cost=EXCLUDED.dps_total_cost,
            dps_cost_per_unit=EXCLUDED.dps_cost_per_unit,
            is_main_fabric=EXCLUDED.is_main_fabric,
            unit_cost_mo=EXCLUDED.unit_cost_mo,
            _loaded_at=EXCLUDED._loaded_at
        """,
        rows,
        page_size=500,
    )


def extract_open_requirements(uid, models, cur, now):
    """Snapshot raw components on open/in-progress DPS MOs.

    Odoo exposes the demand and reservation on stock.move as
    product_uom_qty/reserved_availability.  We deliberately aggregate duplicate
    moves at (MO, component), retain the source locations and refresh the whole
    snapshot so cancelled/done MOs cannot linger.
    """
    prod_fields = models.execute_kw(
        ODOO_DB, uid, ODOO_PASSWORD, "mrp.production", "fields_get", [],
        {"attributes": ["type"]})
    mo_fields = ["name", "state", "product_id", "move_raw_ids"]
    if "dps_id" in prod_fields:
        mo_fields.append("dps_id")
    if "date_planned" in prod_fields:
        mo_fields.append("date_planned")
    mos = models.execute_kw(
        ODOO_DB, uid, ODOO_PASSWORD, "mrp.production", "search_read",
        [[["state", "in", ["confirmed", "progress"]], ["dps_id", "!=", False]]],
        {"fields": mo_fields, "order": "id asc"})
    move_to_mo, meta = {}, {}
    finished_ids, dps_ids = set(), set()
    for mo in mos:
        fpid = mo.get("product_id", [None])[0] if mo.get("product_id") else None
        if fpid: finished_ids.add(fpid)
        dps = mo.get("dps_id")
        did = dps[0] if dps else None
        if did: dps_ids.add(did)
        meta[mo["id"]] = {
            "mo_ref": mo.get("name"), "dps_ref": dps[1] if dps else None,
            "state": mo.get("state") or "unknown", "finished_product_id": fpid,
            "date_planned": mo.get("date_planned")}
        for move_id in mo.get("move_raw_ids") or []:
            move_to_mo[move_id] = mo["id"]
    move_fields = models.execute_kw(
        ODOO_DB, uid, ODOO_PASSWORD, "stock.move", "fields_get", [],
        {"attributes": ["type"]})
    qty_field = "product_uom_qty" if "product_uom_qty" in move_fields else "quantity"
    reserve_field = "reserved_availability" if "reserved_availability" in move_fields else None
    wanted = ["product_id", qty_field, "product_uom", "location_id", "state"]
    if reserve_field: wanted.append(reserve_field)
    moves = []
    move_ids = list(move_to_mo)
    for chunk in _chunks(move_ids, 500):
        moves += models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "stock.move",
                                   "read", [chunk], {"fields": wanted})
    pids = sorted({m["product_id"][0] for m in moves if m.get("product_id")})
    products = {}
    for chunk in _chunks(pids, 500):
        for p in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "product.product",
                                   "read", [chunk],
                                   {"fields": ["default_code", "name", "categ_id"]}):
            products[p["id"]] = p
    finished = {}
    for chunk in _chunks(sorted(finished_ids), 500):
        for p in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "product.product",
                                   "read", [chunk],
                                   {"fields": ["default_code", "name", "product_tmpl_id"]}):
            finished[p["id"]] = p
    agg = defaultdict(lambda: {"required": 0.0, "reserved": 0.0, "uom": None,
                               "name": None, "sku": None, "locs": set(), "moves": []})
    for mv in moves:
        if mv.get("state") in ("done", "cancel") or not mv.get("product_id"):
            continue
        pid = mv["product_id"][0]
        p = products.get(pid)
        if not p or (p.get("categ_id") and p["categ_id"][0] not in KEEP_CATEGS):
            continue
        mo_id = move_to_mo.get(mv["id"])
        if mo_id is None: continue
        rec = agg[(mo_id, pid)]
        rec["required"] += float(mv.get(qty_field) or 0)
        rec["reserved"] += float(mv.get(reserve_field) or 0) if reserve_field else 0
        rec["uom"] = (mv.get("product_uom") or [None, None])[1] or rec["uom"]
        rec["name"], rec["sku"] = p.get("name"), p.get("default_code")
        loc = (mv.get("location_id") or [None, None])[1]
        if loc: rec["locs"].add(loc)
        rec["moves"].append(mv["id"])
    rows = []
    for (mo_id, pid), rec in agg.items():
        m, fp = meta[mo_id], finished.get(meta[mo_id]["finished_product_id"]) or {}
        tmpl = fp.get("product_tmpl_id") or [None, None]
        rows.append((mo_id, m["mo_ref"], m["dps_ref"], m["state"], pid, rec["sku"],
                     rec["name"], rec["required"], rec["reserved"], rec["uom"],
                     ", ".join(sorted(rec["locs"])) or None, m["finished_product_id"],
                     fp.get("default_code"), fp.get("name"), tmpl[1],
                     m.get("date_planned"), rec["moves"], now))
    cur.execute("TRUNCATE mo_open_component_requirements")
    if rows:
        execute_values(cur, """
            INSERT INTO mo_open_component_requirements
            (odoo_mo_id,mo_ref,dps_ref,order_state,component_id,component_sku,
             component_name,required_qty,reserved_qty,uom,source_location,
             finished_product_id,finished_sku,finished_name,style_name,date_planned,
             source_move_ids,_loaded_at) VALUES %s
        """, rows, page_size=500)
    log.info("mo_open_component_requirements: refreshed %d rows from %d open MOs",
             len(rows), len(mos))
    return len(rows)


def extract_reservation_contributors(uid, models, cur, now):
    """Snapshot active Odoo reservations at component/source-location grain."""
    fields = models.execute_kw(
        ODOO_DB, uid, ODOO_PASSWORD, "stock.move", "fields_get", [],
        {"attributes": ["type"]})
    reserve_field = ("reserved_availability"
                     if "reserved_availability" in fields else None)
    if not reserve_field:
        cur.execute("TRUNCATE mo_component_reservation_contributors")
        return 0
    optional = ["raw_material_production_id", "production_id", "picking_id",
                "reference", "origin", "name"]
    wanted = [x for x in optional if x in fields]
    wanted += ["product_id", "product_uom", "location_id", reserve_field, "state"]
    domain = [["state", "in", ["confirmed", "waiting", "assigned",
                                "partially_available"]],
              ["product_id.categ_id", "in", list(KEEP_CATEGS)],
              ["location_id.usage", "=", "internal"]]
    moves, offset = [], 0
    while True:
        batch = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD, "stock.move", "search_read",
            [domain], {"fields": wanted, "limit": 500, "offset": offset,
                       "order": "id asc"})
        if not batch:
            break
        moves.extend(batch)
        offset += len(batch)
        if len(batch) < 500:
            break
    pids = sorted({m["product_id"][0] for m in moves if m.get("product_id")})
    products = {}
    for chunk in _chunks(pids, 500):
        for p in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
                                   "product.product", "read", [chunk],
                                   {"fields": ["default_code", "name"]}):
            products[p["id"]] = p
    mo_ids = set()
    for mv in moves:
        for field in ("raw_material_production_id", "production_id"):
            value = mv.get(field)
            if value:
                mo_ids.add(value[0] if isinstance(value, list) else value)
    mo_meta = {}
    for chunk in _chunks(sorted(mo_ids), 500):
        for mo in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
                                    "mrp.production", "read", [chunk],
                                    {"fields": ["name", "dps_id"]}):
            dps = mo.get("dps_id") or [None, None]
            mo_meta[mo["id"]] = (mo.get("name"), dps[1])
    rows = []
    for mv in moves:
        product, loc = mv.get("product_id"), mv.get("location_id")
        qty = float(mv.get(reserve_field) or 0)
        if not product or not loc or qty <= 0:
            continue
        mo_id = None
        for field in ("raw_material_production_id", "production_id"):
            value = mv.get(field)
            if value:
                mo_id = value[0] if isinstance(value, list) else value
                break
        mo_ref, dps_ref = mo_meta.get(mo_id, (None, None))
        transaction = mv.get("reference") or mv.get("picking_id") or \
            mv.get("origin") or mv.get("name")
        if isinstance(transaction, list):
            transaction = transaction[1]
        p = products.get(product[0], {})
        rows.append((mv["id"], product[0], p.get("default_code"), p.get("name"),
                     qty, (mv.get("product_uom") or [None, None])[1],
                     mv.get("state"), loc[1], mv.get("reference"), mv.get("origin"),
                     transaction, mo_id, mo_ref, dps_ref, now))
    cur.execute("TRUNCATE mo_component_reservation_contributors")
    if rows:
        execute_values(cur, """
            INSERT INTO mo_component_reservation_contributors
            (move_id,component_id,component_sku,component_name,quantity,uom,state,
             source_location,move_reference,move_origin,transaction_ref,odoo_mo_id,
             mo_ref,dps_ref,_loaded_at) VALUES %s
        """, rows, page_size=500)
    log.info("mo_component_reservation_contributors: refreshed %d rows", len(rows))
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--days",
        type=int,
        default=DEFAULT_WINDOW_DAYS,
        help="trailing window in days by MO completion date (default %d)" % DEFAULT_WINDOW_DAYS,
    )
    args = ap.parse_args()
    days = max(1, int(args.days or DEFAULT_WINDOW_DAYS))

    uid, models = odoo_connect()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.utcnow()
    create_table(cur)
    conn.commit()

    since = datetime.now() - timedelta(days=days)
    since_str = since.strftime("%Y-%m-%d %H:%M:%S")
    extract(uid, models, cur, since_str, now)
    extract_open_requirements(uid, models, cur, now)
    extract_reservation_contributors(uid, models, cur, now)
    conn.commit()

    cur.execute("SELECT COUNT(*) FROM mo_fabric_consumption")
    log.info("mo_fabric_consumption total rows: %d", cur.fetchone()[0])
    conn.close()


if __name__ == "__main__":
    main()
