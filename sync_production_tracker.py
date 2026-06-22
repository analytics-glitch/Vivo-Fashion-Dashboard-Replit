#!/usr/bin/env python3
"""
sync_production_tracker.py
--------------------------
Populates the production tracker from Odoo buying orders.

A "buying order" = a `vivo.buying.order` record (e.g. BO00334). Each BO has a
buyer, order date, style name, expected delivery date, production/lifecycle type,
a fabric/trims spec in notes, and one line per colour (`vivo.buying.order.line`)
with a total_qty. We load:
  - one production_orders row per BO (full header)
  - one production_order_lines row per colour line
  - an intake movement so the 'buying_order' stage holds the BO's total quantity,
    ready for the dashboard to move units through the stages.

Chain in Odoo: vivo.buying.order (BO) -> mrp.production.day (DPS) -> mrp.production (MO).
We anchor on the BO.

Idempotent: orders and lines are upserted; intake appends only the delta between
the BO quantity and what has already been taken in, so re-running never
double-counts and a BO whose quantity grows simply gets the extra units appended.

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


def fetch_buying_orders(uid, models):
    bos = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "vivo.buying.order",
        "search_read",
        [[]],
        {
            "fields": [
                "name",
                "buyer_id",
                "order_date",
                "x_studio_style_name",
                "x_studio_expected_delivery_date",
                "x_studio_production_type",
                "x_studio_product_lifecycle_type",
                "state",
                "notes",
                "line_ids",
            ]
        },
    )
    log.info("Fetched %s buying orders", len(bos))
    return bos


def fetch_lines(uid, models, line_ids):
    if not line_ids:
        return []
    lines = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "vivo.buying.order.line",
        "read",
        [line_ids],
        {
            "fields": [
                "order_id",
                "product_tmpl_id",
                "total_qty",
                "planned_qty",
                "remaining_qty",
                "state",
            ]
        },
    )
    log.info("Fetched %s buying order lines", len(lines))
    return lines


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def parse_label(product_field):
    """[id, '[SKU] Name - Colour'] -> (sku, full_name, colour)"""
    if not product_field:
        return None, None, None
    label = (
        product_field[1]
        if isinstance(product_field, (list, tuple))
        else str(product_field)
    )
    label = label.strip()
    m = SKU_RE.match(label)
    sku = m.group(1).strip() if m else None
    name = m.group(2).strip() if m else label
    colour = name.split(" - ")[-1].strip() if " - " in name else None
    return sku, name, colour


def common_prefix(skus):
    skus = [s for s in skus if s]
    return (os.path.commonprefix(skus) or None) if skus else None


def as_date(v):
    return v[:10] if v else None


# ----------------------------------------------------------------------
# Reshape
# ----------------------------------------------------------------------
def build(bos, lines):
    lines_by_bo = defaultdict(list)
    for ln in lines:
        bo_id = ln["order_id"][0] if ln.get("order_id") else None
        if bo_id is not None:
            lines_by_bo[bo_id].append(ln)

    orders, order_lines = [], []
    for b in bos:
        blines = lines_by_bo.get(b["id"], [])
        skus, total = [], 0.0
        for ln in blines:
            sku, name, colour = parse_label(ln.get("product_tmpl_id"))
            if sku:
                skus.append(sku)
            total += ln.get("total_qty") or 0.0
            order_lines.append(
                {
                    "order_ref": b["name"],
                    "odoo_line_id": ln["id"],
                    "product_sku": sku,
                    "product_name": name,
                    "colour": colour,
                    "total_qty": ln.get("total_qty") or 0.0,
                    "planned_qty": ln.get("planned_qty") or 0.0,
                    "remaining_qty": ln.get("remaining_qty") or 0.0,
                    "line_state": ln.get("state"),
                }
            )

        orders.append(
            {
                "order_ref": b["name"],
                "odoo_id": b["id"],
                "style_number": common_prefix(skus),
                "style_name": b.get("x_studio_style_name") or None,
                "product_name": b.get("x_studio_style_name") or None,
                "product_sku": skus[0] if skus else None,
                "order_qty": round(total, 2),
                "date_ordered": as_date(b.get("order_date")),
                "expected_delivery_date": as_date(
                    b.get("x_studio_expected_delivery_date")
                ),
                "buyer": b["buyer_id"][1] if b.get("buyer_id") else None,
                "production_type": b.get("x_studio_production_type") or None,
                "lifecycle_type": b.get("x_studio_product_lifecycle_type") or None,
                "bo_state": b.get("state"),
                "notes_html": b.get("notes") or None,
            }
        )

    log.info("Built %s orders and %s order lines", len(orders), len(order_lines))
    return orders, order_lines


# ----------------------------------------------------------------------
# Postgres
# ----------------------------------------------------------------------
def upsert_orders(cur, orders):
    rows = [
        (
            o["order_ref"],
            o["odoo_id"],
            o["style_number"],
            o["style_name"],
            o["product_name"],
            o["product_sku"],
            o["order_qty"],
            o["date_ordered"],
            o["expected_delivery_date"],
            o["buyer"],
            o["production_type"],
            o["lifecycle_type"],
            o["bo_state"],
            o["notes_html"],
            "odoo",
        )
        for o in orders
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_orders
            (order_ref, odoo_id, style_number, style_name, product_name, product_sku,
             order_qty, date_ordered, expected_delivery_date, buyer, production_type,
             lifecycle_type, bo_state, notes_html, source, updated_at)
        VALUES %s
        ON CONFLICT (order_ref) DO UPDATE SET
            odoo_id                = EXCLUDED.odoo_id,
            style_number           = COALESCE(EXCLUDED.style_number, production_orders.style_number),
            style_name             = EXCLUDED.style_name,
            product_name           = EXCLUDED.product_name,
            product_sku            = COALESCE(EXCLUDED.product_sku, production_orders.product_sku),
            order_qty              = EXCLUDED.order_qty,
            date_ordered           = EXCLUDED.date_ordered,
            expected_delivery_date = EXCLUDED.expected_delivery_date,
            buyer                  = EXCLUDED.buyer,
            production_type        = EXCLUDED.production_type,
            lifecycle_type         = EXCLUDED.lifecycle_type,
            bo_state               = EXCLUDED.bo_state,
            notes_html             = EXCLUDED.notes_html,
            updated_at             = now()
    """,
        rows,
        template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
    )
    log.info("Upserted %s production_orders", len(rows))


def upsert_lines(cur, order_lines):
    if not order_lines:
        return
    rows = [
        (
            l["order_ref"],
            l["odoo_line_id"],
            l["product_sku"],
            l["product_name"],
            l["colour"],
            l["total_qty"],
            l["planned_qty"],
            l["remaining_qty"],
            l["line_state"],
        )
        for l in order_lines
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_order_lines
            (order_ref, odoo_line_id, product_sku, product_name, colour,
             total_qty, planned_qty, remaining_qty, line_state)
        VALUES %s
        ON CONFLICT (order_ref, odoo_line_id) DO UPDATE SET
            product_sku   = EXCLUDED.product_sku,
            product_name  = EXCLUDED.product_name,
            colour        = EXCLUDED.colour,
            total_qty     = EXCLUDED.total_qty,
            planned_qty   = EXCLUDED.planned_qty,
            remaining_qty = EXCLUDED.remaining_qty,
            line_state    = EXCLUDED.line_state
    """,
        rows,
    )
    log.info("Upserted %s production_order_lines", len(rows))


def sync_intake(cur, orders):
    inserted = 0
    for o in orders:
        cur.execute(
            """
            SELECT COALESCE(SUM(qty), 0) FROM stage_movements
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
                "BO %s quantity shrank (was %.1f, now %.1f) - left as-is",
                o["order_ref"],
                existing,
                o["order_qty"],
            )
    log.info("Inserted intake movements for %s orders", inserted)


# ----------------------------------------------------------------------
def main():
    uid, models = odoo_connect()
    bos = fetch_buying_orders(uid, models)
    all_line_ids = [lid for b in bos for lid in b.get("line_ids", [])]
    lines = fetch_lines(uid, models, all_line_ids)
    orders, order_lines = build(bos, lines)

    # Only orders with a quantity get an intake movement.
    orders_with_qty = [o for o in orders if o["order_qty"] > 0]

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                upsert_orders(cur, orders)
                upsert_lines(cur, order_lines)
                sync_intake(cur, orders_with_qty)
        log.info("Done: %s buying orders synced", len(orders))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
