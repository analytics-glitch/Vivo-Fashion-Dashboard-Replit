#!/usr/bin/env python3
"""
sync_production_tracker.py
--------------------------
Populates the production tracker from Odoo.

A "buying order" = a DPS document (Odoo `mrp.production.day`), identified by the
`origin` field on its Manufacturing Orders (e.g. DPS00324). Each DPS bundles all
the MOs for one style run (every colour x size). We reconstruct one order header
per DPS by grouping MOs on `origin`, then write an intake movement so that the
'buying_order' stage holds the full ordered quantity, ready for the dashboard to
move units through cutting -> sewing -> finishing -> warehouse.

Idempotent:
  - production_orders is upserted on order_ref.
  - Intake is appended only for the *delta* between the DPS quantity and what has
    already been taken in, so re-running never double-counts; a DPS that grows
    (more MOs added) simply gets the extra units appended.

Run:
    python sync_production_tracker.py
"""

import os
import re
import logging
import xmlrpc.client
from collections import defaultdict

import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_production_tracker")

ODOO_URL = os.environ["ODOO_URL"]
ODOO_DB = os.environ["ODOO_DB"]
ODOO_USER = os.environ["ODOO_USER"]
ODOO_PASSWORD = os.environ["ODOO_PASSWORD"]
DATABASE_URL = os.environ["DATABASE_URL"]

# Matches "[SKU] Product name" as returned by Odoo many2one display names.
SKU_RE = re.compile(r"^\[([^\]]+)\]\s*(.*)$")


# ----------------------------------------------------------------------
# Odoo
# ----------------------------------------------------------------------
def odoo_connect():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models


def fetch_mos(uid, models):
    """All Manufacturing Orders that belong to a DPS buying order."""
    domain = [["origin", "=like", "DPS%"], ["state", "!=", "cancel"]]
    fields = [
        "name",
        "origin",
        "dps_id",
        "product_id",
        "product_qty",
        "date_start",
        "state",
    ]
    mos = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "mrp.production",
        "search_read",
        [domain],
        {"fields": fields},
    )
    log.info("Fetched %s MOs across DPS buying orders", len(mos))
    return mos


# ----------------------------------------------------------------------
# Reshape MOs -> one order header per DPS
# ----------------------------------------------------------------------
def parse_sku_name(product_field):
    if not product_field:
        return None, None
    label = (
        product_field[1]
        if isinstance(product_field, (list, tuple))
        else str(product_field)
    )
    m = SKU_RE.match(label.strip())
    if m:
        return m.group(1), m.group(2).strip()
    return None, label.strip()


def strip_variant_suffix(name):
    """'Vivo Straight Leg Pants in Satin - Rust (S)' -> 'Vivo Straight Leg Pants in Satin'"""
    if not name:
        return name
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name)  # trailing (size)
    name = re.sub(r"\s*-\s*[^-]+$", "", name).strip()  # trailing - colour
    return name or None


def common_prefix(skus):
    """Style number = longest common prefix of the DPS's variant SKUs."""
    skus = [s for s in skus if s]
    if not skus:
        return None
    return os.path.commonprefix(skus) or None


def build_orders(mos):
    groups = defaultdict(
        lambda: {
            "order_qty": 0.0,
            "dps_id": None,
            "skus": [],
            "names": [],
            "date_ordered": None,
        }
    )
    for m in mos:
        ref = m["origin"]
        g = groups[ref]
        g["order_qty"] += m.get("product_qty") or 0.0
        if m.get("dps_id"):
            g["dps_id"] = m["dps_id"][0]
        sku, name = parse_sku_name(m.get("product_id"))
        if sku:
            g["skus"].append(sku)
        if name:
            g["names"].append(name)
        ds = m.get("date_start")
        if ds:
            d = ds[:10]
            if g["date_ordered"] is None or d < g["date_ordered"]:
                g["date_ordered"] = d

    orders = []
    for ref, g in groups.items():
        orders.append(
            {
                "order_ref": ref,
                "odoo_id": g["dps_id"],
                "style_number": common_prefix(g["skus"]),
                "product_name": strip_variant_suffix(g["names"][0])
                if g["names"]
                else None,
                "product_sku": g["skus"][0] if g["skus"] else None,
                "order_qty": round(g["order_qty"], 2),
                "date_ordered": g["date_ordered"],
            }
        )
    log.info("Reconstructed %s buying orders (DPS)", len(orders))
    return orders


# ----------------------------------------------------------------------
# Postgres
# ----------------------------------------------------------------------
def upsert_orders(cur, orders):
    rows = [
        (
            o["order_ref"],
            o["odoo_id"],
            o["style_number"],
            o["product_name"],
            o["product_sku"],
            o["order_qty"],
            o["date_ordered"],
            "odoo",
        )
        for o in orders
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_orders
            (order_ref, odoo_id, style_number, product_name, product_sku,
             order_qty, date_ordered, source, updated_at)
        VALUES %s
        ON CONFLICT (order_ref) DO UPDATE SET
            odoo_id      = EXCLUDED.odoo_id,
            style_number = COALESCE(EXCLUDED.style_number, production_orders.style_number),
            product_name = COALESCE(EXCLUDED.product_name, production_orders.product_name),
            product_sku  = COALESCE(EXCLUDED.product_sku,  production_orders.product_sku),
            order_qty    = EXCLUDED.order_qty,
            date_ordered = COALESCE(EXCLUDED.date_ordered, production_orders.date_ordered),
            updated_at   = now()
    """,
        rows,
        template="(%s,%s,%s,%s,%s,%s,%s,%s,now())",
    )
    log.info("Upserted %s production_orders", len(rows))


def sync_intake(cur, orders):
    """Append intake movements so buying_order balance == order_qty.
    Only the delta is inserted on re-run, keeping the ledger append-only."""
    inserted = 0
    for o in orders:
        cur.execute(
            """
            SELECT COALESCE(SUM(qty), 0)
            FROM stage_movements
            WHERE order_ref = %s AND from_stage IS NULL
        """,
            (o["order_ref"],),
        )
        existing = float(cur.fetchone()[0] or 0)
        delta = round(float(o["order_qty"]) - existing, 2)
        if delta > 0:
            cur.execute(
                """
                INSERT INTO stage_movements
                    (order_ref, from_stage, to_stage, qty, moved_by, note)
                VALUES (%s, NULL, 'buying_order', %s, 'odoo_sync', 'Intake from Odoo')
            """,
                (o["order_ref"], delta),
            )
            inserted += 1
        elif delta < 0:
            log.warning(
                "DPS %s quantity shrank (was %.1f, now %.1f) - left as-is",
                o["order_ref"],
                existing,
                o["order_qty"],
            )
    log.info("Inserted intake movements for %s orders", inserted)


# ----------------------------------------------------------------------
def main():
    uid, models = odoo_connect()
    mos = fetch_mos(uid, models)
    orders = build_orders(mos)

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                upsert_orders(cur, orders)
                sync_intake(cur, orders)
        log.info("Done: %s buying orders synced", len(orders))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
