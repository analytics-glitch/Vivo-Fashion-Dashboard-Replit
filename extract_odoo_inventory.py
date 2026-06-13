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

LOCATION_COUNTRY_MAP = {
    "Sarit":                  ("Vivo Sarit",           "Kenya"),
    "Moi Avenue":             ("Vivo Moi Avenue",       "Kenya"),
    "Mama Ngina":             ("Vivo Mama Ngina St",    "Kenya"),
    "Yaya":                   ("Vivo Yaya",             "Kenya"),
    "Village Market":         ("Vivo Village Market",   "Kenya"),
    "Junction":               ("Vivo Junction",         "Kenya"),
    "Capital Centre":         ("Vivo Capital Centre",   "Kenya"),
    "Imaara":                 ("Vivo Imaara",           "Kenya"),
    "Nakuru (Westside Mall)": ("Vivo Nakuru",           "Kenya"),
    "Garden City":            ("Vivo Garden City",      "Kenya"),
    "Eldoret (Rupa)":         ("Vivo Eldoret",          "Kenya"),
    "Kisumu (United Mall)":   ("Vivo Kisumu",           "Kenya"),
    "Two Rivers":             ("Vivo Two Rivers",       "Kenya"),
    "Thika Road Mall":        ("Vivo TRM",              "Kenya"),
    "Hub":                    ("Vivo Hub",              "Kenya"),
    "Galleria":               ("Vivo Galleria",         "Kenya"),
    "Runda Mall":             ("Vivo Runda",            "Kenya"),
    "Signature Mall":         ("Vivo Signature Mall",   "Kenya"),
    "Greenspan":              ("Vivo Greenspan",        "Kenya"),
    "Mombasa (City Mall)":    ("Vivo City Mall",        "Kenya"),
    "Tmall":                  ("Vivo T- Mall",          "Kenya"),
    "Zoya Sarit":             ("Zoya Sarit",            "Kenya"),
    "Mombasa CBD":            ("Vivo MSA Digo Road",    "Kenya"),
    "Kileleshwa":             ("Vivo Kileleshwa",       "Kenya"),
    "Meru (Green Wood)":      ("Vivo Meru",             "Kenya"),
    "Sarit Safari":           ("Safari Sarit",          "Kenya"),
    "HQ Outlet":              ("Staff purchases",       "Kenya"),
    "Warehouse":              ("Warehouse",             "Kenya"),
    # Odoo short codes
    "JUNCT":  ("Vivo Junction",        "Kenya"),
    "MNS":    ("Vivo Mama Ngina St",   "Kenya"),
    "MOIAV":  ("Vivo Moi Avenue",      "Kenya"),
    "YAYA":   ("Vivo Yaya",            "Kenya"),
    "VMKT":   ("Vivo Village Market",  "Kenya"),
    "CAPIT":  ("Vivo Capital Centre",  "Kenya"),
    "IMAAR":  ("Vivo Imaara",          "Kenya"),
    "NAKUR":  ("Vivo Nakuru",          "Kenya"),
    "GCITY":  ("Vivo Garden City",     "Kenya"),
    "ELDOR":  ("Vivo Eldoret",         "Kenya"),
    "KISM":   ("Vivo Kisumu",          "Kenya"),
    "TWORV":  ("Vivo Two Rivers",      "Kenya"),
    "TRM":    ("Vivo TRM",             "Kenya"),
    "GALLE":  ("Vivo Galleria",        "Kenya"),
    "RUNDA":  ("Vivo Runda",           "Kenya"),
    "SIGNA":  ("Vivo Signature Mall",  "Kenya"),
    "GRENS":  ("Vivo Greenspan",       "Kenya"),
    "CITYM":  ("Vivo City Mall",       "Kenya"),
    "MSACB":  ("Vivo MSA Digo Road",   "Kenya"),
    "KILEL":  ("Vivo Kileleshwa",      "Kenya"),
    "MERU":   ("Vivo Meru",            "Kenya"),
    "ACHO":   ("Safari Sarit",         "Kenya"),
    "SAFAR":  ("Safari Sarit",         "Kenya"),
    "STPUR":  ("Staff purchases",      "Kenya"),
    "WHFIN":  ("Warehouse Finished Goods", "Kenya"),
    "ZOYA":   ("Zoya Sarit",           "Kenya"),
    # Exact name matches for already-mapped locations
    "Vivo Sarit":  ("Vivo Sarit",      "Kenya"),
    "Vivo Hub":    ("Vivo Hub",        "Kenya"),
    "Vivo Yaya":   ("Vivo Yaya",       "Kenya"),
    "Vivo T- Mall":("Vivo T- Mall",    "Kenya"),

}

EXCLUDED_LOCATIONS = {
    'Production Accessories', 'Raw Materials', 'Production',
    'Fabric Trimming', 'Shopping Bags', 'Dead Stock Fabric',
    'Finished Goods Production', 'Defects Location',
    'Buying & Merchandise', 'Fabric Production', 'Wandia',
    'Galleria Holding', 'Washing', 'Cutting - Spreading',
    'Recall Location', 'Holding Warehouse Finished Goods',
    'Studio Location', 'Product Development', 'Sampling Fabric',
    'Repairs', 'Sampling', 'Sale Stock',
    'PDACC', 'RMAT', 'FTRIM', 'PROD', 'SZONL', 'Dead/Stock Fabric',
    'FGPRD', 'INTRA', 'HWHFN', 'WHREC', 'KIHOL', 'OAHOL', 'GALHO',
    'OASIS', 'KIGAL', 'Buyin', 'Retir', 'WND', 'Wash', 'CUTT',
    'RCALL', 'Studi', 'PDDEV', 'Repai', 'Samp', 'SALE', 'FABPR',
    'Archv', 'Wholesale', 'Defects', 'HQ/Stock', 'ACCHO',
}

def get_m2o_name(v):
    if isinstance(v, list) and len(v) > 1:
        return str(v[1])
    return None

def main():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)

    fields = [
        "id", "product_id", "location_id",
        "quantity", "reserved_quantity", "lot_id",
        "write_date"
    ]

    # Only internal locations with stock
    domain = [
        ["location_id.usage", "=", "internal"],
        ["quantity", ">", 0]
    ]

    batch_size = 2000
    offset = 0
    total = 0
    now = datetime.now(timezone.utc)

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Ensure all_inventory table exists with right schema
    cur.execute("""
        CREATE TABLE IF NOT EXISTS all_inventory (
            sku             TEXT,
            style_name      TEXT,
            product_name    TEXT,
            size            TEXT,
            color_print     TEXT,
            brand           TEXT,
            sub_category    TEXT,
            location_name   TEXT,
            country         TEXT,
            available       NUMERIC,
            on_hand         NUMERIC,
            _loaded_at      TIMESTAMP
        )
    """)

    cur.execute("TRUNCATE all_inventory")
    log.info("Fetching stock.quant...")

    while True:
        records = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            "stock.quant", "search_read",
            [domain],
            {"fields": fields, "limit": batch_size, "offset": offset}
        )
        if not records:
            break

        # Get product details for these records
        product_ids = list({r["product_id"][0] for r in records if isinstance(r.get("product_id"), list)})
        products = {}
        if product_ids:
            prod_records = models.execute_kw(
                ODOO_DB, uid, ODOO_PASSWORD,
                "product.product", "read",
                [product_ids],
                {"fields": ["id", "default_code", "name",
                            "x_vivo_attr_14", "x_vivo_attr_16",
                            "x_vivo_attr_22", "x_vivo_color",
                            "x_vivo_attr_18"]}
            )
            for p in prod_records:
                products[p["id"]] = p

        rows = []
        for r in records:
            product_id = r["product_id"][0] if isinstance(r.get("product_id"), list) else None
            location   = get_m2o_name(r.get("location_id")) or ""
            qty        = float(r.get("quantity", 0))
            reserved   = float(r.get("reserved_quantity", 0))
            available  = qty - reserved

            # Map location to store name and country
            loc_key = None
            for key in LOCATION_COUNTRY_MAP:
                if key.lower() in location.lower():
                    loc_key = key
                    break
            mapped_location, country = LOCATION_COUNTRY_MAP.get(loc_key, (location, "Kenya"))

            p = products.get(product_id, {})
            sku        = p.get("default_code")
            name       = p.get("name", "")
            sub_cat    = get_m2o_name(p.get("x_vivo_attr_14"))
            style_name = get_m2o_name(p.get("x_vivo_attr_16"))
            brand      = get_m2o_name(p.get("x_vivo_attr_22"))
            color      = get_m2o_name(p.get("x_vivo_color"))

            if not sku:
                continue
            # Skip excluded internal locations
            if any(exc.lower() in location.lower() for exc in EXCLUDED_LOCATIONS):
                continue

            rows.append((
                sku, style_name, name, None, color,
                brand, sub_cat, location, mapped_location, country,
                available, qty, now
            ))

        if rows:
            execute_values(cur, """
                INSERT INTO all_inventory (
                    sku, style_name, product_name, size, color_print,
                    brand, sub_category, location_name, pos_location_name, country,
                    available, on_hand, _loaded_at
                ) VALUES %s
            """, rows, page_size=500)

        total += len(records)
        offset += batch_size
        log.info("Stock quant: %d processed so far", total)

        if len(records) < batch_size:
            break

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM all_inventory")
    log.info("✅ all_inventory: %d rows", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()