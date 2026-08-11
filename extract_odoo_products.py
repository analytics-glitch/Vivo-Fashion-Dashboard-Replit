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
        "x_vivo_attr_101",  # Fabric Structure (Knit / Woven) — Fabric Details tab
        "x_vivo_attr_100",  # Plain/Print
        "x_vivo_attr_125",  # Source Country
        "x_vivo_attr_124",  # Source City
        "x_vivo_attr_102",  # Fabric Category
        "x_vivo_attr_103",  # Fabric Sub-Category
        "x_vivo_attr_25",   # Width (m)
        "x_vivo_attr_38",   # GSM
        "x_vivo_attr_43",   # Supplier Fabric Code
        "x_vivo_attr_45",   # NOOS Fabric
        "x_vivo_attr_46",   # Fiber Content %
        "x_vivo_collection",
        "x_vivo_color",
        "x_vivo_categories",
        "active", "write_date",
        "product_tmpl_id",  # needed for template-level tier/status fallback
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

        # ── Template-level tier/status fallback ──────────────────────────────
        # x_vivo_attr_97 (status) and x_vivo_attr_99 (tier) may be defined as
        # related fields on product.template that are not stored on
        # product.product, causing search_read to return False for those
        # variants even when the template has the correct value.  Read the
        # template values for the whole batch and use them as a fallback when
        # the variant-level read returns nothing.
        tmpl_ids = list({
            r["product_tmpl_id"][0]
            for r in records
            if isinstance(r.get("product_tmpl_id"), list)
        })
        tmpl_tier_map = {}   # tmpl_id -> tier name
        tmpl_status_map = {} # tmpl_id -> status name
        if tmpl_ids:
            tmpl_records = models.execute_kw(
                ODOO_DB, uid, ODOO_PASSWORD,
                "product.template", "read",
                [tmpl_ids],
                {"fields": ["id", "x_vivo_attr_99", "x_vivo_attr_97"]}
            )
            for tr in tmpl_records:
                tmpl_tier_map[tr["id"]]   = get_m2o_name(tr.get("x_vivo_attr_99"))
                tmpl_status_map[tr["id"]] = get_m2o_name(tr.get("x_vivo_attr_97"))
        # ─────────────────────────────────────────────────────────────────────

        rows = []
        for r in records:
            tmpl_id = (
                r["product_tmpl_id"][0]
                if isinstance(r.get("product_tmpl_id"), list)
                else r.get("product_tmpl_id")
            )
            # Variant value wins; fall back to template value when variant
            # returns None (covers the non-stored related case and any future
            # field-storage changes in Odoo).
            pp_tier   = get_m2o_name(r.get("x_vivo_attr_99"))
            pp_status = get_m2o_name(r.get("x_vivo_attr_97"))
            tier   = pp_tier   or (tmpl_tier_map.get(tmpl_id)   if tmpl_id else None)
            status = pp_status or (tmpl_status_map.get(tmpl_id) if tmpl_id else None)

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
                status,                                  # status (variant ∪ template)
                tier,                                    # tier   (variant ∪ template)
                get_m2o_name(r.get("x_vivo_attr_101")), # fabric_structure
                get_m2o_name(r.get("x_vivo_attr_100")), # plain_print
                get_m2o_name(r.get("x_vivo_attr_125")), # source_country
                get_m2o_name(r.get("x_vivo_attr_124")), # source_city
                get_m2o_name(r.get("x_vivo_attr_102")), # fabric_category
                get_m2o_name(r.get("x_vivo_attr_103")), # fabric_subcategory
                get_m2o_name(r.get("x_vivo_attr_25")),  # fabric_width
                get_m2o_name(r.get("x_vivo_attr_38")),  # gsm
                get_m2o_name(r.get("x_vivo_attr_43")),  # supplier_fabric_code
                get_m2o_name(r.get("x_vivo_attr_45")),  # noos_fabric
                get_m2o_name(r.get("x_vivo_attr_46")),  # fiber_content
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
                category, gender, season, status, tier,
                fabric_structure, plain_print, source_country, source_city,
                fabric_category, fabric_subcategory, fabric_width, gsm,
                supplier_fabric_code, noos_fabric, fiber_content, active,
                write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                list_price = EXCLUDED.list_price,
                standard_price = EXCLUDED.standard_price,
                status = EXCLUDED.status,
                tier = EXCLUDED.tier,
                fabric_structure = EXCLUDED.fabric_structure,
                plain_print = EXCLUDED.plain_print,
                source_country = EXCLUDED.source_country,
                source_city = EXCLUDED.source_city,
                fabric_category = EXCLUDED.fabric_category,
                fabric_subcategory = EXCLUDED.fabric_subcategory,
                fabric_width = EXCLUDED.fabric_width,
                gsm = EXCLUDED.gsm,
                supplier_fabric_code = EXCLUDED.supplier_fabric_code,
                noos_fabric = EXCLUDED.noos_fabric,
                fiber_content = EXCLUDED.fiber_content,
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
    # Update planner stats after TRUNCATE+reload — see note in extract_odoo_inventory.py
    cur.execute("ANALYZE raw_odoo_products")
    conn.commit()
    log.info("✅ ANALYZE raw_odoo_products complete")
    conn.close()

if __name__ == "__main__":
    main()