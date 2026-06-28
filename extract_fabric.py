import xmlrpc.client, os, psycopg2, logging
from psycopg2.extras import execute_values
from datetime import datetime, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

ODOO_URL      = os.environ['ODOO_URL']
ODOO_DB       = os.environ['ODOO_DB']
ODOO_USER     = os.environ['ODOO_USER']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']
DATABASE_URL  = os.environ['DATABASE_URL']
FABRIC_CATS   = [18, 19]  # 18=Raw Materials-Fabric, 19=Accessories & Trims

def odoo_connect():
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models

def create_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS raw_fabric_products (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            default_code    TEXT,
            category        TEXT,
            uom             TEXT,
            standard_price  NUMERIC,
            active          BOOLEAN,
            write_date      TIMESTAMP,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_inventory (
            id              BIGINT PRIMARY KEY,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            location_id     BIGINT,
            location_name   TEXT,
            quantity        NUMERIC,
            reserved_qty    NUMERIC,
            available       NUMERIC,
            uom             TEXT,
            standard_price  NUMERIC,
            total_value     NUMERIC,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_boms (
            id                      BIGINT PRIMARY KEY,
            bom_id                  BIGINT,
            finished_product_name   TEXT,
            finished_product_sku    TEXT,
            component_id            BIGINT,
            component_name          TEXT,
            component_sku           TEXT,
            component_qty           NUMERIC,
            component_uom           TEXT,
            _loaded_at              TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_moves (
            id              BIGINT PRIMARY KEY,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            qty             NUMERIC,
            uom             TEXT,
            location_from   TEXT,
            location_to     TEXT,
            move_type       TEXT,
            date            TIMESTAMP,
            reference       TEXT,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_purchase_orders (
            id              BIGINT PRIMARY KEY,
            po_id           BIGINT,
            po_name         TEXT,
            supplier        TEXT,
            order_date      DATE,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            qty_ordered     NUMERIC,
            qty_received    NUMERIC,
            qty_invoiced    NUMERIC,
            price_unit      NUMERIC,
            total_value     NUMERIC,
            uom             TEXT,
            date_planned    DATE,
            state           TEXT,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
    """)
    log.info("Tables ready")

FABRIC_COLORS = [
    'Black','White','Navy Blue','Navy','Red','Dark Red','Burgundy','Maroon',
    'Mustard','Yellow','Olive','Dark Olive','Light Olive','Olive Green',
    'Green','Dark Green','Light Green','Sea Green','Mint Green','Mint',
    'Blue','Dark Blue','Light Blue','Sky Blue','Teal','Dark Teal','Turquoise',
    'Pink','Dark Pink','Light Pink','Dusty Pink','Hot Pink','Rose',
    'Purple','Lilac','Lavender','Plum','Mauve',
    'Orange','Dark Orange','Rust','Burnt Orange','Coral',
    'Brown','Dark Brown','Chocolate','Caramel','Tan','Taupe','Dark Taupe',
    'Grey','Gray','Dark Grey','Light Grey','Mid Grey','Charcoal',
    'Cream','Ivory','Off White','Beige','Sand','Nude','Ecru',
    'Camel','Khaki','Stone','Blush','Salmon','Peach',
    'Multicolor','Multi','Print','Stripe','Check','Checked',
    'Light Navy','Dark Navy','Dark Mustard','Light Mustard',
]
_COLORS_SORTED = sorted(set(FABRIC_COLORS), key=len, reverse=True)

def _derive_color(name):
    import re
    for color in _COLORS_SORTED:
        if re.search(r"\b" + re.escape(color) + r"\b", name or "", re.IGNORECASE):
            return color.title()
    return None

def extract_products(uid, models, cur, now):
    log.info("Extracting fabric products with attributes...")
    
    # First ensure table has new columns
    cur.execute("""
        ALTER TABLE raw_fabric_products
        ADD COLUMN IF NOT EXISTS derived_color TEXT,
        ADD COLUMN IF NOT EXISTS fabric_color TEXT;
        ALTER TABLE raw_fabric_products 
        ADD COLUMN IF NOT EXISTS kg_per_mtr NUMERIC,
        ADD COLUMN IF NOT EXISTS width_m NUMERIC,
        ADD COLUMN IF NOT EXISTS gsm NUMERIC,
        ADD COLUMN IF NOT EXISTS plain_print TEXT,
        ADD COLUMN IF NOT EXISTS fabric_structure TEXT,
        ADD COLUMN IF NOT EXISTS fabric_category TEXT,
        ADD COLUMN IF NOT EXISTS fabric_subcategory TEXT,
        ADD COLUMN IF NOT EXISTS stretch_type TEXT,
        ADD COLUMN IF NOT EXISTS weight_range TEXT,
        ADD COLUMN IF NOT EXISTS fiber_content TEXT,
        ADD COLUMN IF NOT EXISTS fabric_type TEXT,
        ADD COLUMN IF NOT EXISTS supplier TEXT,
        ADD COLUMN IF NOT EXISTS primary_color TEXT,
        ADD COLUMN IF NOT EXISTS source_city TEXT,
        ADD COLUMN IF NOT EXISTS source_country TEXT,
        ADD COLUMN IF NOT EXISTS write_date TIMESTAMP
    """)

    # Effective Kg/Mtr + source flag — code-defined derived columns (generated,
    # so they stay in lockstep with the stored attributes on every extract and
    # auto-populate on dev AND prod). The stored kg_per_mtr is authoritative when
    # present (> 0); otherwise fall back to the confirmed formula
    # Kg/Mtr = Width (m) × GSM ÷ 1000 when BOTH width_m and gsm are present.
    # kg_per_mtr_src marks each row: 'stored' / 'derived' / 'incomplete'.
    cur.execute("""
        ALTER TABLE raw_fabric_products
        ADD COLUMN IF NOT EXISTS kg_per_mtr_eff NUMERIC
          GENERATED ALWAYS AS (
            CASE
              WHEN COALESCE(kg_per_mtr,0) > 0 THEN kg_per_mtr
              WHEN COALESCE(width_m,0) > 0 AND COALESCE(gsm,0) > 0
                   THEN width_m * gsm / 1000.0
              ELSE NULL
            END
          ) STORED,
        ADD COLUMN IF NOT EXISTS kg_per_mtr_src TEXT
          GENERATED ALWAYS AS (
            CASE
              WHEN COALESCE(kg_per_mtr,0) > 0 THEN 'stored'
              WHEN COALESCE(width_m,0) > 0 AND COALESCE(gsm,0) > 0 THEN 'derived'
              ELSE 'incomplete'
            END
          ) STORED
    """)

    batch_size = 200
    offset = 0
    rows = []
    
    FABRIC_FIELDS = [
        "name", "default_code", "categ_id", "uom_id", 
        "standard_price", "active",
        "x_vivo_attr_39",   # Kg/Mtr
        "x_vivo_attr_25",   # Width (m)
        "x_vivo_attr_38",   # GSM
        "x_vivo_attr_100",  # Plain/Print
        "x_vivo_attr_101",  # Fabric Structure
        "x_vivo_attr_102",  # Fabric Category
        "x_vivo_attr_103",  # Fabric Sub-Category
        "x_vivo_attr_40",   # Stretch Type
        "x_vivo_attr_45",   # Weight Range
        "x_vivo_attr_46",   # Fiber Content %
        "x_vivo_attr_47",   # Fabric Type
        "x_vivo_attr_42",   # Vendor/Supplier
        "x_vivo_attr_48",   # Primary Color
        "x_vivo_attr_124",  # Source City
        "x_vivo_attr_125",  # Source Country
        "barcode",
        "x_vivo_color",
        "write_date",       # Odoo last-modified time (UTC) — drives the category tracker
    ]
    
    def get_m2o(val):
        if isinstance(val, list) and len(val) > 1:
            return str(val[1])
        return None

    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "product.product", "search_read",
            [[["categ_id", "in", FABRIC_CATS]]],
            {"fields": FABRIC_FIELDS, "limit": batch_size, "offset": offset})
        if not records:
            break
        for r in records:
            cat = r.get("categ_id")
            cat_name = cat[1] if cat else ""
            category = "Fabric" if "Raw" in str(cat_name) else "Trim"
            
            kg_mtr = get_m2o(r.get("x_vivo_attr_39"))
            width  = get_m2o(r.get("x_vivo_attr_25"))
            gsm    = get_m2o(r.get("x_vivo_attr_38"))
            
            rows.append((
                r["id"],
                r["name"],
                r.get("default_code"),
                category,
                r["uom_id"][1] if r.get("uom_id") else None,
                r.get("standard_price", 0),
                r.get("active", True),
                float(kg_mtr) if kg_mtr else None,
                float(width) if width else None,
                float(gsm) if gsm else None,
                get_m2o(r.get("x_vivo_attr_100")),  # plain/print
                get_m2o(r.get("x_vivo_attr_101")),  # structure
                get_m2o(r.get("x_vivo_attr_102")),  # category
                get_m2o(r.get("x_vivo_attr_103")),  # subcategory
                get_m2o(r.get("x_vivo_attr_40")),   # stretch
                get_m2o(r.get("x_vivo_attr_45")),   # weight range
                get_m2o(r.get("x_vivo_attr_46")),   # fiber content
                get_m2o(r.get("x_vivo_attr_47")),   # fabric type
                get_m2o(r.get("x_vivo_attr_42")),   # supplier
                get_m2o(r.get("x_vivo_attr_48")),   # primary color
                get_m2o(r.get("x_vivo_attr_124")),  # source city
                get_m2o(r.get("x_vivo_attr_125")),  # source country
                r.get("barcode") or None,
                r["x_vivo_color"][1] if isinstance(r.get("x_vivo_color"), list) else None,
                _derive_color(r.get("name","")),
                (r["x_vivo_color"][1] if isinstance(r.get("x_vivo_color"), list) else None) or _derive_color(r.get("name","")),
                r.get("write_date") or None,
                now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break

    cur.execute("TRUNCATE raw_fabric_products")
    execute_values(cur, """
        INSERT INTO raw_fabric_products (
            id, name, default_code, category, uom, standard_price, active,
            kg_per_mtr, width_m, gsm, plain_print, fabric_structure,
            fabric_category, fabric_subcategory, stretch_type, weight_range,
            fiber_content, fabric_type, supplier, primary_color,
            source_city, source_country, barcode, color,
            derived_color, fabric_color, write_date, _loaded_at
        ) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, standard_price=EXCLUDED.standard_price,
            kg_per_mtr=EXCLUDED.kg_per_mtr, width_m=EXCLUDED.width_m,
            gsm=EXCLUDED.gsm, plain_print=EXCLUDED.plain_print,
            fabric_structure=EXCLUDED.fabric_structure,
            fabric_category=EXCLUDED.fabric_category,
            fabric_subcategory=EXCLUDED.fabric_subcategory,
            stretch_type=EXCLUDED.stretch_type, weight_range=EXCLUDED.weight_range,
            fiber_content=EXCLUDED.fiber_content, fabric_type=EXCLUDED.fabric_type,
            supplier=EXCLUDED.supplier, primary_color=EXCLUDED.primary_color,
            source_city=EXCLUDED.source_city, source_country=EXCLUDED.source_country,
            derived_color=EXCLUDED.derived_color, fabric_color=EXCLUDED.fabric_color,
            write_date=EXCLUDED.write_date,
            _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=200)
    log.info("✅ raw_fabric_products: %d rows", len(rows))

def extract_inventory(uid, models, cur, now):
    log.info("Extracting fabric inventory...")
    # Get product prices
    prices = {r['id']: (r.get('standard_price',0), r.get('categ_id',[None,None])[1], r.get('uom_id',[None,None])[1])
              for r in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'product.product', 'search_read',
                [[['categ_id','in',FABRIC_CATS]]],
                {'fields': ['standard_price','categ_id','uom_id']})}

    batch_size = 500
    offset = 0
    rows = []
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'stock.quant', 'search_read',
            [[['product_id.categ_id','in',FABRIC_CATS],['location_id.usage','=','internal']]],
            {'fields': ['product_id','location_id','quantity','reserved_quantity','lot_id'],
             'limit': batch_size, 'offset': offset})
        if not records:
            break
        for r in records:
            pid = r['product_id'][0] if r.get('product_id') else None
            pname = r['product_id'][1] if r.get('product_id') else None
            price_info = prices.get(pid, (0, None, None))
            qty = r.get('quantity', 0)
            res = r.get('reserved_quantity', 0)
            cat_name = str(price_info[1] or '')
            category = 'Fabric' if 'Raw' in cat_name else 'Trim'
            rows.append((
                r['id'], pid, pname, None,
                r['location_id'][0] if r.get('location_id') else None,
                r['location_id'][1] if r.get('location_id') else None,
                qty, res, qty - res,
                price_info[2],
                price_info[0],
                qty * price_info[0],
                category, now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break
    cur.execute("TRUNCATE raw_fabric_inventory")
    execute_values(cur, """
        INSERT INTO raw_fabric_inventory
        (id,product_id,product_name,product_sku,location_id,location_name,
         quantity,reserved_qty,available,uom,standard_price,total_value,category,_loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            quantity=EXCLUDED.quantity, reserved_qty=EXCLUDED.reserved_qty,
            available=EXCLUDED.available, total_value=EXCLUDED.total_value, _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
    log.info("✅ raw_fabric_inventory: %d rows", len(rows))

def extract_boms(uid, models, cur, now):
    log.info("Extracting BOMs...")
    boms = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'mrp.bom', 'search_read',
        [[]], {'fields': ['product_tmpl_id','product_id','product_qty','code']})
    
    # Get all BOM lines for fabric/trim components
    lines = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'mrp.bom.line', 'search_read',
        [[['product_id.categ_id','in',FABRIC_CATS]]],
        {'fields': ['bom_id','product_id','product_qty','product_uom_id']})
    
    bom_map = {b['id']: b for b in boms}
    rows = []
    for l in lines:
        bom = bom_map.get(l['bom_id'][0] if l.get('bom_id') else None, {})
        fp = bom.get('product_tmpl_id')
        rows.append((
            l['id'],
            l['bom_id'][0] if l.get('bom_id') else None,
            fp[1] if fp else None,
            bom.get('code'),
            l['product_id'][0] if l.get('product_id') else None,
            l['product_id'][1] if l.get('product_id') else None,
            None,
            l.get('product_qty', 0),
            l['product_uom_id'][1] if l.get('product_uom_id') else None,
            now
        ))
    cur.execute("TRUNCATE raw_fabric_boms")
    execute_values(cur, """
        INSERT INTO raw_fabric_boms
        (id,bom_id,finished_product_name,finished_product_sku,
         component_id,component_name,component_sku,component_qty,component_uom,_loaded_at)
        VALUES %s ON CONFLICT (id) DO NOTHING
    """, rows, page_size=500)
    log.info("✅ raw_fabric_boms: %d rows", len(rows))

def extract_moves(uid, models, cur, now):
    log.info("Extracting fabric stock moves...")
    # Get last move date for incremental
    cur.execute("SELECT MAX(date) FROM raw_fabric_moves")
    last = cur.fetchone()[0]
    since = last - timedelta(days=2) if last else datetime.now() - timedelta(days=730)
    since_str = since.strftime('%Y-%m-%d %H:%M:%S')
    log.info("Fetching moves since %s", since_str)

    batch_size = 1000
    offset = 0
    rows = []
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'stock.move', 'search_read',
            [[['product_id.categ_id','in',FABRIC_CATS],
              ['state','=','done'],
              ['date','>=',since_str]]],
            {'fields': ['product_id','product_uom_qty','product_uom','location_id',
                        'location_dest_id','date','reference','name'],
             'limit': batch_size, 'offset': offset,
             'order': 'date asc'})
        if not records:
            break
        for r in records:
            loc_from = r['location_id'][1] if r.get('location_id') else ''
            loc_to   = r['location_dest_id'][1] if r.get('location_dest_id') else ''
            if 'Vendor' in loc_from or 'Suppliers' in loc_from:
                move_type = 'IN'
            elif 'Customer' in loc_to or 'Production' in loc_to:
                move_type = 'OUT'
            else:
                move_type = 'INTERNAL'
            rows.append((
                r['id'],
                r['product_id'][0] if r.get('product_id') else None,
                r['product_id'][1] if r.get('product_id') else None,
                None,
                r.get('product_uom_qty', 0),
                r['product_uom'][1] if r.get('product_uom') else None,
                loc_from, loc_to, move_type,
                r.get('date'), r.get('reference'),
                None, now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break
    if rows:
        execute_values(cur, """
            INSERT INTO raw_fabric_moves
            (id,product_id,product_name,product_sku,qty,uom,
             location_from,location_to,move_type,date,reference,category,_loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                qty=EXCLUDED.qty, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
    log.info("✅ raw_fabric_moves: %d rows", len(rows))

def extract_purchase_orders(uid, models, cur, now):
    log.info("Extracting fabric purchase orders...")
    # Get PO headers
    pos = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'purchase.order', 'search_read',
        [[]], {'fields': ['name','partner_id','date_order','state']})
    po_map = {p['id']: p for p in pos}

    lines = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'purchase.order.line', 'search_read',
        [[['product_id.categ_id','in',FABRIC_CATS]]],
        {'fields': ['order_id','product_id','product_qty','price_unit',
                    'product_uom','qty_received','qty_invoiced','date_planned']})
    rows = []
    for l in lines:
        po = po_map.get(l['order_id'][0] if l.get('order_id') else None, {})
        pid = l['product_id'][0] if l.get('product_id') else None
        qty = l.get('product_qty', 0)
        price = l.get('price_unit', 0)
        rows.append((
            l['id'],
            l['order_id'][0] if l.get('order_id') else None,
            l['order_id'][1] if l.get('order_id') else None,
            po.get('partner_id',[None,''])[1],
            po.get('date_order','')[:10] if po.get('date_order') else None,
            pid,
            l['product_id'][1] if l.get('product_id') else None,
            None,
            qty,
            l.get('qty_received', 0),
            l.get('qty_invoiced', 0),
            price,
            qty * price,
            l['product_uom'][1] if l.get('product_uom') else None,
            l.get('date_planned','')[:10] if l.get('date_planned') else None,
            po.get('state'),
            None, now
        ))
    cur.execute("TRUNCATE raw_fabric_purchase_orders")
    execute_values(cur, """
        INSERT INTO raw_fabric_purchase_orders
        (id,po_id,po_name,supplier,order_date,product_id,product_name,product_sku,
         qty_ordered,qty_received,qty_invoiced,price_unit,total_value,
         uom,date_planned,state,category,_loaded_at)
        VALUES %s ON CONFLICT (id) DO NOTHING
    """, rows, page_size=500)
    log.info("✅ raw_fabric_purchase_orders: %d rows", len(rows))

def main():
    uid, models = odoo_connect()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.utcnow()
    create_tables(cur)
    conn.commit()
    extract_products(uid, models, cur, now)
    extract_inventory(uid, models, cur, now)
    extract_boms(uid, models, cur, now)
    extract_moves(uid, models, cur, now)
    extract_purchase_orders(uid, models, cur, now)
    conn.commit()

    # Summary
    for table in ['raw_fabric_products','raw_fabric_inventory','raw_fabric_boms',
                  'raw_fabric_moves','raw_fabric_purchase_orders']:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        log.info("%s: %d rows", table, cur.fetchone()[0])
    conn.close()

if __name__ == '__main__':
    main()
