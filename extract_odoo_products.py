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
    """Extract name from many2one field [id, name] or return None."""
    if isinstance(v, list) and len(v) > 1:
        return str(v[1])
    return None

def main():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)

    fields = [
        "id", "name", "default_code", "barcode",
        "list_price", "standard_price", "categ_id",
        "x_vivo_attr_14",   # Sub Category
        "x_vivo_attr_16",   # Style Name
        "x_vivo_attr_18",   # Style Number
        "x_vivo_attr_20",   # Vendor
        "x_vivo_attr_22",   # Brand
        "x_vivo_attr_83",   # Gender
        "x_vivo_attr_92",   # Season
        "x_vivo_attr_97",   # Status  (Active / Retired)
        "x_vivo_attr_99",   # Tier    (Core Performer / New / NOOS / Recent Performer / N/A / Retired)
        "x_vivo_collection",
        "x_vivo_color",
        "x_vivo_categories",
        "active", "write_date"
    ]

    # Keyset pagination on the immutable id (NOT offset over a write_date sort):
    # offset paging over a mutable sort key skips rows whenever a product is
    # edited in Odoo mid-extract (rows shift between pages), which silently
    # dropped ~350 products (missing barcodes downstream). id is stable, so
    # every product is visited exactly once regardless of concurrent edits.
    batch_size = 1000
    last_id = 0
    total = 0
    now = datetime.now(timezone.utc)

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute("TRUNCATE raw_odoo_products")

    while True:
        records = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            "product.product", "search_read",
            [[["default_code", "!=", False], ["id", ">", last_id]]],
            {"fields": fields, "limit": batch_size,
             "order": "id asc", "context": {"active_test": False}}
        )
        if not records:
            break

        rows = []
        for r in records:
            rows.append((
                r["id"],
                r.get("name"),
                r.get("default_code"),
                str(r["barcode"]) if r.get("barcode") else None,
                r.get("list_price"),
                r.get("standard_price"),
                get_m2o_name(r.get("categ_id")),        # categ_name
                get_m2o_name(r.get("x_vivo_attr_14")),  # sub_category
                get_m2o_name(r.get("x_vivo_attr_16")),  # style_name
                get_m2o_name(r.get("x_vivo_attr_18")),  # style_number
                get_m2o_name(r.get("x_vivo_collection")),# collection
                get_m2o_name(r.get("x_vivo_color")),    # color
                get_m2o_name(r.get("x_vivo_attr_22")),  # brand
                get_m2o_name(r.get("x_vivo_attr_20")),  # vendor
                get_m2o_name(r.get("x_vivo_categories")),# category
                get_m2o_name(r.get("x_vivo_attr_83")),  # gender
                get_m2o_name(r.get("x_vivo_attr_92")),  # season
                get_m2o_name(r.get("x_vivo_attr_97")),  # status
                get_m2o_name(r.get("x_vivo_attr_99")),  # tier
                bool(r.get("active")),
                r.get("write_date"),
                now,
            ))

        execute_values(cur, """
            INSERT INTO raw_odoo_products (
                id, name, default_code, barcode,
                list_price, standard_price, categ_name,
                sub_category, style_name, style_number,
                collection, color, brand, vendor,
                category, gender, season, status, tier, active,
                write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                list_price = EXCLUDED.list_price,
                standard_price = EXCLUDED.standard_price,
                active = EXCLUDED.active,
                write_date = EXCLUDED.write_date,
                _synced_at = EXCLUDED._synced_at
        """, rows)

        total += len(rows)
        last_id = records[-1]["id"]
        log.info("Products: %d synced so far", total)

        if len(records) < batch_size:
            break

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM raw_odoo_products")
    log.info("✅ raw_odoo_products: %d rows", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()