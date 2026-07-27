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

# Main fabric only — categ_id 18 ("Raw Materials-Fabric") = FABRIC_CATS[0] in
# extract_fabric.py. Trims/accessories (19) and other categories are excluded.
MAIN_FABRIC_CATEG = 18

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
        """
    )


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
    if not move_ids:
        log.info("No raw component moves found — nothing to write.")
        return 0

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
            {"fields": ["product_id", "quantity", "product_uom"]},
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
            {"fields": ["default_code", "categ_id", "name"]},
        ):
            prods[p["id"]] = p

    # Aggregate consumed qty per (MO, fabric component) — sum across multiple moves
    # of the same fabric in one MO so the (odoo_mo_id, component_id) PK holds.
    agg = defaultdict(lambda: {"qty": 0.0, "uom": None, "name": None, "sku": None})
    for mv in moves:
        if not mv.get("product_id"):
            continue
        pid = mv["product_id"][0]
        prod = prods.get(pid)
        if not prod:
            continue
        categ_id = prod["categ_id"][0] if prod.get("categ_id") else None
        if categ_id != MAIN_FABRIC_CATEG:
            continue  # main fabric only
        mo_id = move_to_mo.get(mv["id"])
        if mo_id is None:
            continue
        key = (mo_id, pid)
        rec = agg[key]
        rec["qty"] += mv.get("quantity") or 0.0
        if mv.get("product_uom"):
            rec["uom"] = mv["product_uom"][1]
        rec["name"] = prod.get("name")
        rec["sku"] = prod.get("default_code")

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
                now,
            )
        )

    if not rows:
        log.info("No main-fabric components on the in-window MOs — nothing to write.")
        return 0

    execute_values(
        cur,
        """
        INSERT INTO mo_fabric_consumption
            (odoo_mo_id, mo_ref, dps_ref, done_date, produced_qty,
             component_id, fabric_sku, fabric_name, consumed_qty, uom,
             finished_product_id, finished_sku, finished_name, finished_tmpl_id,
             style_name, dps_odoo_id, dps_labour_cost, dps_total_cost,
             dps_cost_per_unit, _loaded_at)
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
            _loaded_at=EXCLUDED._loaded_at
        """,
        rows,
        page_size=500,
    )
    log.info("✅ mo_fabric_consumption: upserted %d (MO, fabric) rows", len(rows))
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
    conn.commit()

    cur.execute("SELECT COUNT(*) FROM mo_fabric_consumption")
    log.info("mo_fabric_consumption total rows: %d", cur.fetchone()[0])
    conn.close()


if __name__ == "__main__":
    main()
