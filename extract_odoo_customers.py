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

def get_m2o_name(v):
    if isinstance(v, list) and len(v) > 1:
        return str(v[1])
    return None

def get_last_sync(cur):
    cur.execute("SELECT MAX(_synced_at) FROM raw_odoo_customers")
    result = cur.fetchone()[0]
    if result:
        return result.strftime("%Y-%m-%d %H:%M:%S")
    return "2019-01-01 00:00:00"

def main():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)

    fields = [
        "id", "name", "email", "phone", "mobile",
        "street", "city", "state_id", "country_id",
        "x_studio_shopify_user_id",
        "write_date"
    ]

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    since = get_last_sync(cur)
    log.info("Fetching customers since %s...", since)

    domain = [
        ["customer_rank", ">", 0],
        ["write_date", ">=", since]
    ]
    batch_size = 1000
    offset = 0
    total = 0
    now = datetime.now(timezone.utc)

    while True:
        records = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            "res.partner", "search_read",
            [domain],
            {"fields": fields, "limit": batch_size, "offset": offset,
             "order": "write_date asc"}
        )
        if not records:
            break

        rows = []
        for r in records:
            shopify_id = r.get("x_studio_shopify_user_id")
            if shopify_id is False:
                shopify_id = None

            rows.append((
                r["id"],
                r.get("name"),
                r.get("email") or None,
                r.get("phone") or None,
                r.get("mobile") or None,
                r.get("street") or None,
                r.get("city") or None,
                get_m2o_name(r.get("state_id")),
                get_m2o_name(r.get("country_id")),
                int(shopify_id) if shopify_id else None,
                "vivofashiongroup",
                r.get("write_date"),
                now,
            ))

        execute_values(cur, """
            INSERT INTO raw_odoo_customers (
                id, name, email, phone, mobile,
                street, city, state_name, country_name,
                shopify_user_id, store_id,
                write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                shopify_user_id = EXCLUDED.shopify_user_id,
                write_date = EXCLUDED.write_date,
                _synced_at = EXCLUDED._synced_at
        """, rows)

        total += len(rows)
        offset += batch_size
        log.info("Customers: %d synced so far", total)

        if len(records) < batch_size:
            break

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM raw_odoo_customers")
    log.info("✅ raw_odoo_customers: %d rows", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()