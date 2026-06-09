import os
import xmlrpc.client
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL  = os.environ['DATABASE_URL']
ODOO_URL      = os.environ['ODOO_URL']
ODOO_DB       = os.environ['ODOO_DB']
ODOO_USER     = os.environ['ODOO_USER']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']

def odoo_connect():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models

def get_id(v):
    if isinstance(v, list):
        return v[0] if v else None
    return v if v else None

def get_name(v):
    if isinstance(v, list) and len(v) > 1:
        return v[1]
    return None

def get_last_sync(cur, table):
    cur.execute(f"SELECT MAX(_synced_at) FROM {table}")
    result = cur.fetchone()[0]
    if result:
        return result.strftime("%Y-%m-%d %H:%M:%S")
    return "2026-03-20 00:00:00"

def sync_orders(uid, models, cur, since):
    log.info("Fetching pos.order since %s...", since)
    fields = [
        "id", "name", "pos_reference", "tracking_number", "date_order",
        "state", "config_id", "session_id", "partner_id",
        "employee_id", "user_id", "company_id",
        "amount_total", "amount_tax", "amount_paid", "amount_return",
        "margin", "margin_percent", "is_invoiced", "write_date"
    ]
    domain = [["write_date", ">=", since], ["state", "in", ["done", "paid", "invoiced"]]]
    batch_size = 1000
    offset = 0
    total = 0
    now = datetime.now(timezone.utc)

    while True:
        records = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            "pos.order", "search_read",
            [domain],
            {"fields": fields, "limit": batch_size, "offset": offset, "order": "write_date asc"}
        )
        if not records:
            break

        rows = []
        for r in records:
            rows.append((
                r["id"],                           # id
                r.get("name"),                     # name
                r.get("pos_reference"),            # pos_reference
                r.get("tracking_number") or None,  # tracking_number
                r.get("date_order"),               # date_order
                r.get("state"),                    # state
                get_id(r.get("config_id")),        # config_id
                get_name(r.get("config_id")),      # config_name
                get_id(r.get("session_id")),       # session_id
                get_id(r.get("partner_id")),       # partner_id
                get_name(r.get("partner_id")),     # partner_name
                get_id(r.get("employee_id")),      # employee_id
                None,                              # cashier
                get_id(r.get("user_id")),          # user_id
                get_id(r.get("company_id")),       # company_id
                r.get("amount_total"),             # amount_total
                r.get("amount_tax"),               # amount_tax
                r.get("amount_paid"),              # amount_paid
                r.get("amount_return"),            # amount_return
                r.get("margin"),                   # margin
                r.get("margin_percent"),           # margin_percent
                bool(r.get("is_invoiced")),        # is_invoiced
                None,                              # email
                r.get("write_date"),               # write_date
                now,                               # _synced_at
            ))

        execute_values(cur, """
            INSERT INTO raw_odoo_pos_orders (
                id, name, pos_reference, tracking_number, date_order,
                state, config_id, config_name, session_id, partner_id,
                partner_name, employee_id, cashier, user_id, company_id,
                amount_total, amount_tax, amount_paid, amount_return,
                margin, margin_percent, is_invoiced, email,
                write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                state = EXCLUDED.state,
                amount_total = EXCLUDED.amount_total,
                write_date = EXCLUDED.write_date,
                _synced_at = EXCLUDED._synced_at
        """, rows)

        total += len(rows)
        offset += batch_size
        log.info("Orders: %d synced so far", total)

        if len(records) < batch_size:
            break

    log.info("✅ Orders sync done — %d rows", total)
    return total

def sync_order_lines(uid, models, cur, since):
    log.info("Fetching pos.order.line since %s...", since)
    fields = [
        "id", "order_id", "product_id", "full_product_name",
        "qty", "price_unit", "price_subtotal", "price_subtotal_incl",
        "discount", "is_reward_line", "write_date"
    ]
    domain = [["write_date", ">=", since]]
    batch_size = 2000
    offset = 0
    total = 0
    now = datetime.now(timezone.utc)

    while True:
        records = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            "pos.order.line", "search_read",
            [domain],
            {"fields": fields, "limit": batch_size, "offset": offset, "order": "write_date asc"}
        )
        if not records:
            break

        rows = []
        for r in records:
            rows.append((
                r["id"],                           # id
                get_id(r.get("order_id")),         # order_id
                get_id(r.get("product_id")),       # product_id
                r.get("full_product_name"),        # full_product_name
                r.get("qty"),                      # qty
                r.get("price_unit"),               # price_unit
                r.get("price_subtotal"),           # price_subtotal
                r.get("price_subtotal_incl"),      # price_subtotal_incl
                r.get("discount"),                 # discount
                bool(r.get("is_reward_line")),     # is_reward_line
                r.get("write_date"),               # write_date
                now,                               # _synced_at
            ))

        execute_values(cur, """
            INSERT INTO raw_odoo_pos_order_lines (
                id, order_id, product_id, full_product_name,
                qty, price_unit, price_subtotal, price_subtotal_incl,
                discount, is_reward_line, write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                qty = EXCLUDED.qty,
                price_unit = EXCLUDED.price_unit,
                write_date = EXCLUDED.write_date,
                _synced_at = EXCLUDED._synced_at
        """, rows)

        total += len(rows)
        offset += batch_size
        log.info("Order lines: %d synced so far", total)

        if len(records) < batch_size:
            break

    log.info("✅ Order lines sync done — %d rows", total)
    return total

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    uid, models = odoo_connect()

    since_orders = get_last_sync(cur, "raw_odoo_pos_orders")
    since_lines  = get_last_sync(cur, "raw_odoo_pos_order_lines")

    sync_orders(uid, models, cur, since_orders)
    sync_order_lines(uid, models, cur, since_lines)

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM raw_odoo_pos_orders")
    log.info("raw_odoo_pos_orders: %d rows", cur.fetchone()[0])
    cur.execute("SELECT COUNT(*) FROM raw_odoo_pos_order_lines")
    log.info("raw_odoo_pos_order_lines: %d rows", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()