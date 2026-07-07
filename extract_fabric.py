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

def _props_by_label(props):
    """Odoo `properties`-type field → {label: value}. The fabric master carries its
    dedicated Fabric Name / Fabric Supplier Name / Fabric Colour custom fields inside
    `product_properties` (a list of {name,string,value} dicts keyed off a parent
    definition), NOT as top-level x_vivo_* columns. Blank/False → dropped so callers
    can COALESCE cleanly to their fallback."""
    out = {}
    if isinstance(props, list):
        for p in props:
            if isinstance(p, dict) and p.get("string") is not None:
                v = p.get("value")
                if isinstance(v, str):
                    v = v.strip() or None
                if v:
                    out[p["string"]] = v
    return out

def extract_products(uid, models, cur, now, since=None):
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
        ADD COLUMN IF NOT EXISTS supplier_fabric_code TEXT,
        ADD COLUMN IF NOT EXISTS primary_color TEXT,
        ADD COLUMN IF NOT EXISTS source_city TEXT,
        ADD COLUMN IF NOT EXISTS source_country TEXT,
        ADD COLUMN IF NOT EXISTS fabric_name TEXT,
        ADD COLUMN IF NOT EXISTS fabric_supplier_name TEXT,
        ADD COLUMN IF NOT EXISTS odoo_fabric_color TEXT,
        ADD COLUMN IF NOT EXISTS write_date TIMESTAMP
    """)

    # Effective Kg/Mtr + source flag — code-defined derived columns (generated,
    # so they stay in lockstep with the stored attributes on every extract and
    # auto-populate on dev AND prod). The conversion is PURELY the standard
    # formula Kg/Mtr = Width (m) × GSM ÷ 1000 when BOTH width_m and gsm are
    # present; the stored Odoo kg_per_mtr value is intentionally IGNORED so every
    # metre/cost/cover figure derives from a single transparent calculation.
    # kg_per_mtr_src marks each row: 'derived' (Width+GSM present) / 'incomplete'.
    # NOTE: these are STORED GENERATED columns, so ADD COLUMN IF NOT EXISTS will
    # NOT change an existing column's expression — on a DB where they already
    # exist with the old formula, migration 003 drops + re-adds them. This block
    # is what gives a FRESH DB the correct expression from the first extract.
    cur.execute("""
        ALTER TABLE raw_fabric_products
        ADD COLUMN IF NOT EXISTS kg_per_mtr_eff NUMERIC
          GENERATED ALWAYS AS (
            CASE
              WHEN COALESCE(width_m,0) > 0 AND COALESCE(gsm,0) > 0
                   THEN width_m * gsm / 1000.0
              ELSE NULL
            END
          ) STORED,
        ADD COLUMN IF NOT EXISTS kg_per_mtr_src TEXT
          GENERATED ALWAYS AS (
            CASE
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
        "x_vivo_attr_43",   # Supplier Fabric Code
        "x_vivo_attr_48",   # Primary Color
        "x_vivo_attr_124",  # Source City
        "x_vivo_attr_125",  # Source Country
        "barcode",
        "x_vivo_color",
        "product_properties",  # dedicated Fabric Name / Fabric Supplier Name / Fabric Colour live here
        "write_date",       # Odoo last-modified time (UTC) — drives the category tracker
    ]
    
    def get_m2o(val):
        if isinstance(val, list) and len(val) > 1:
            return str(val[1])
        return None

    # Incremental (fast-path) pull: only products whose Odoo write_date advanced
    # since the last successful pull (plus a small overlap for clock skew). This
    # is usually 0–few records, so the 60s cadence stays cheap. `since=None`
    # (bootstrap / heavy reconcile) pulls every product.
    domain = [["categ_id", "in", FABRIC_CATS]]
    if since is not None:
        since_str = since.strftime("%Y-%m-%d %H:%M:%S")
        domain.append(["write_date", ">=", since_str])
        log.info("Incremental product pull since %s (UTC)", since_str)

    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "product.product", "search_read",
            [domain],
            {"fields": FABRIC_FIELDS, "limit": batch_size, "offset": offset,
             "context": {"active_test": False}})
        if not records:
            break
        for r in records:
            cat = r.get("categ_id")
            cat_name = cat[1] if cat else ""
            category = "Fabric" if "Raw" in str(cat_name) else "Trim"
            
            kg_mtr = get_m2o(r.get("x_vivo_attr_39"))
            width  = get_m2o(r.get("x_vivo_attr_25"))
            gsm    = get_m2o(r.get("x_vivo_attr_38"))

            props = _props_by_label(r.get("product_properties"))
            fabric_name_odoo     = props.get("Fabric Name")
            fabric_supplier_odoo = props.get("Fabric Supplier Name")
            fabric_color_odoo    = props.get("Fabric Colour")

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
                get_m2o(r.get("x_vivo_attr_43")),   # supplier fabric code
                get_m2o(r.get("x_vivo_attr_48")),   # primary color
                get_m2o(r.get("x_vivo_attr_124")),  # source city
                get_m2o(r.get("x_vivo_attr_125")),  # source country
                r.get("barcode") or None,
                r["x_vivo_color"][1] if isinstance(r.get("x_vivo_color"), list) else None,
                _derive_color(r.get("name","")),
                (r["x_vivo_color"][1] if isinstance(r.get("x_vivo_color"), list) else None) or _derive_color(r.get("name","")),
                fabric_name_odoo,
                fabric_supplier_odoo,
                fabric_color_odoo,
                r.get("write_date") or None,
                now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break

    # Full pull replaces the whole table (also reconciles hard-deletes); the
    # incremental fast path upserts only the changed rows and leaves the rest.
    if since is None:
        cur.execute("TRUNCATE raw_fabric_products")
    if rows:
        execute_values(cur, """
        INSERT INTO raw_fabric_products (
            id, name, default_code, category, uom, standard_price, active,
            kg_per_mtr, width_m, gsm, plain_print, fabric_structure,
            fabric_category, fabric_subcategory, stretch_type, weight_range,
            fiber_content, fabric_type, supplier, supplier_fabric_code, primary_color,
            source_city, source_country, barcode, color,
            derived_color, fabric_color,
            fabric_name, fabric_supplier_name, odoo_fabric_color,
            write_date, _loaded_at
        ) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, default_code=EXCLUDED.default_code,
            category=EXCLUDED.category, uom=EXCLUDED.uom,
            standard_price=EXCLUDED.standard_price, active=EXCLUDED.active,
            kg_per_mtr=EXCLUDED.kg_per_mtr, width_m=EXCLUDED.width_m,
            gsm=EXCLUDED.gsm, plain_print=EXCLUDED.plain_print,
            fabric_structure=EXCLUDED.fabric_structure,
            fabric_category=EXCLUDED.fabric_category,
            fabric_subcategory=EXCLUDED.fabric_subcategory,
            stretch_type=EXCLUDED.stretch_type, weight_range=EXCLUDED.weight_range,
            fiber_content=EXCLUDED.fiber_content, fabric_type=EXCLUDED.fabric_type,
            supplier=EXCLUDED.supplier,
            supplier_fabric_code=EXCLUDED.supplier_fabric_code,
            primary_color=EXCLUDED.primary_color,
            source_city=EXCLUDED.source_city, source_country=EXCLUDED.source_country,
            barcode=EXCLUDED.barcode, color=EXCLUDED.color,
            derived_color=EXCLUDED.derived_color, fabric_color=EXCLUDED.fabric_color,
            fabric_name=EXCLUDED.fabric_name,
            fabric_supplier_name=EXCLUDED.fabric_supplier_name,
            odoo_fabric_color=EXCLUDED.odoo_fabric_color,
            write_date=EXCLUDED.write_date,
            _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=200)
    if since is not None:
        # Advance the freshness clock for the WHOLE table so the page's
        # MAX(_loaded_at) age reflects this successful sync even on cycles where
        # nothing changed (0 changed rows is the normal steady state).
        cur.execute("UPDATE raw_fabric_products SET _loaded_at = %s", (now,))
    log.info("✅ raw_fabric_products: %d changed rows (incremental=%s)",
             len(rows), since is not None)

def extract_inventory(uid, models, cur, now):
    log.info("Extracting fabric inventory...")
    # Product price / category / uom come from the already-refreshed
    # raw_fabric_products table (populated earlier in THIS run) instead of a
    # second full product.product pull from Odoo — that redundant pull was one of
    # the biggest slow points in the cycle. Tuple order: (price, category, uom).
    cur.execute("SELECT id, standard_price, category, uom FROM raw_fabric_products")
    prices = {r[0]: (float(r[1]) if r[1] is not None else 0, r[2], r[3])
              for r in cur.fetchall()}
    if not prices:
        # Bootstrap fallback: products table empty (should not happen because
        # products run first) — pull straight from Odoo, deriving the category.
        for r in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'product.product', 'search_read',
                [[['categ_id','in',FABRIC_CATS]]],
                {'fields': ['standard_price','categ_id','uom_id']}):
            catn = str((r.get('categ_id') or [None, ''])[1] or '')
            prices[r['id']] = (r.get('standard_price', 0),
                               'Fabric' if 'Raw' in catn else 'Trim',
                               (r.get('uom_id') or [None, None])[1])

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
            price_info = prices.get(pid, (0, 'Trim', None))
            qty = r.get('quantity', 0)
            res = r.get('reserved_quantity', 0)
            # price_info[1] is already the mapped 'Fabric'/'Trim' category.
            category = price_info[1] or 'Trim'
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

def main(mode="full"):
    """Fabric extract with three cadences (see the sync loop):

    - "fast"  (every ~60s): product master (INCREMENTAL via write_date) + fabric
      inventory (stock.quant). Feeds the Stock Mix table + "All products" export;
      reflects an Odoo product edit within ~60s. Prices reuse the just-refreshed
      products table, so there is no second full product.product pull.
    - "heavy" (slow cadence): a FULL product reconcile (catches archives/hard
      deletes the incremental path would miss) plus the genuinely heavy,
      slow-changing history — BOMs, stock moves, purchase orders.
    - "full"  (bootstrap / standalone default): everything, all full pulls.

    Every mode is idempotent (TRUNCATE+upsert or ON CONFLICT), so re-running is
    always safe.
    """
    uid, models = odoo_connect()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.utcnow()
    create_tables(cur)
    conn.commit()

    # Concurrency guard: ONE fabric extract touches the raw_fabric_* tables at a
    # time. The sync loop now runs the fast pull on its own ~60s thread and
    # launches the heavy reconcile fire-and-forget, so a fast pull can fire while
    # a previous heavy pull is still running; an operator may also kick off a
    # standalone run. A single pg session advisory lock (shared by BOTH fast and
    # heavy) makes them mutually exclusive so a fast incremental upsert can never
    # overlap a heavy full-product TRUNCATE+reconcile. If the lock is already
    # held, the losing run skips this pass rather than piling on (the fast path
    # simply retries on its next ~60s tick — well under the 180s staleness
    # banner). "full" (bootstrap) is a one-shot standalone run by design and is
    # NOT gated (nothing else runs against an empty fresh DB at that point).
    lock_key = 0x7FAB12C0  # arbitrary, fabric-extract specific
    have_lock = True
    if mode in ("fast", "heavy"):
        cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,))
        have_lock = cur.fetchone()[0]
        conn.commit()
    if not have_lock:
        log.info("Fabric extract (mode=%s) — another fabric run holds the lock, skipping.", mode)
        conn.close()
        return

    try:
        if mode in ("fast", "full"):
            since = None
            if mode == "fast":
                # Incremental window = last stored write_date minus a small overlap
                # (guards clock skew / a mid-write pull). Empty table → full pull.
                cur.execute("SELECT MAX(write_date) FROM raw_fabric_products")
                last_wd = cur.fetchone()[0]
                if last_wd is not None:
                    since = last_wd - timedelta(minutes=5)
            extract_products(uid, models, cur, now, since=since)
            conn.commit()
            extract_inventory(uid, models, cur, now)
            conn.commit()

        if mode in ("heavy", "full"):
            if mode == "heavy":
                # Full product reconcile on the slow cadence so archives / rare
                # hard deletes the incremental fast path can't see get cleared.
                extract_products(uid, models, cur, now, since=None)
                conn.commit()
            extract_boms(uid, models, cur, now)
            extract_moves(uid, models, cur, now)
            extract_purchase_orders(uid, models, cur, now)
            conn.commit()
    finally:
        if mode in ("fast", "heavy"):
            cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
            conn.commit()

    # Summary
    for table in ['raw_fabric_products','raw_fabric_inventory','raw_fabric_boms',
                  'raw_fabric_moves','raw_fabric_purchase_orders']:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        log.info("%s: %d rows", table, cur.fetchone()[0])
    conn.close()

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description="Fabric BI Odoo extract")
    ap.add_argument("--mode", choices=["fast", "heavy", "full"], default="full",
                    help="fast=product+inventory (60s), heavy=boms/moves/pos + full "
                         "product reconcile, full=everything (bootstrap/standalone)")
    args = ap.parse_args()
    main(mode=args.mode)
