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

def extract_products(uid, models, cur, now):
    log.info("Extracting fabric products...")
    batch_size = 500
    offset = 0
    rows = []
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'product.product', 'search_read',
            [[['categ_id', 'in', FABRIC_CATS]]],
            {'fields': ['name','default_code','categ_id','uom_id','standard_price','active'],
             'limit': batch_size, 'offset': offset})
        if not records:
            break
        for r in records:
            cat = r['categ_id'][1] if r.get('categ_id') else None
            category = 'Fabric' if '18' in str(r.get('categ_id','')) or 'Raw' in str(cat) else 'Trim'
            rows.append((
                r['id'], r['name'], r.get('default_code'),
                category,
                r['uom_id'][1] if r.get('uom_id') else None,
                r.get('standard_price', 0),
                r.get('active', True),
                now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break
    cur.execute("TRUNCATE raw_fabric_products")
    execute_values(cur, """
        INSERT INTO raw_fabric_products (id,name,default_code,category,uom,standard_price,active,_loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, standard_price=EXCLUDED.standard_price, _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
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
