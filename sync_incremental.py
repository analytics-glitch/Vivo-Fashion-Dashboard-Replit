import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta
import time
import logging
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']


def ensure_heartbeat_table(conn):
    with conn.cursor() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS sync_heartbeat (
                id            INT PRIMARY KEY DEFAULT 1,
                last_cycle_at TIMESTAMPTZ,
                last_status   TEXT,
                CONSTRAINT sync_heartbeat_single CHECK (id = 1)
            )
        """)
    conn.commit()


def write_heartbeat(conn, status):
    """Record that the sync loop is alive and making progress.

    Deliberately decoupled from data freshness (all_sales.loaded_at): during
    quiet periods with no new sales, loaded_at stops advancing even though the
    loop is perfectly healthy. The watchdog keys off this heartbeat so it never
    restarts a working sync just because business was slow.
    """
    try:
        with conn.cursor() as c:
            c.execute("""
                INSERT INTO sync_heartbeat (id, last_cycle_at, last_status)
                VALUES (1, now(), %s)
                ON CONFLICT (id) DO UPDATE
                    SET last_cycle_at = now(), last_status = EXCLUDED.last_status
            """, (status,))
        conn.commit()
    except Exception as e:
        log.warning("heartbeat write failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


STORES = [
    {
        "store_id":  "vivowoman",
        "store_url": os.environ["SHOPIFY_KENYA_STORE"],
        "token":     os.environ["SHOPIFY_KENYA_TOKEN"],
        "country":   "Kenya",
        "currency":  "KES",
        "vat":       1.16,
    },
    {
        "store_id":  "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token":     os.environ["SHOPIFY_UGANDA_TOKEN"],
        "country":   "Uganda",
        "currency":  "UGX",
        "vat":       1.18,
    },
    {
        "store_id":  "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token":     os.environ["SHOPIFY_RWANDA_TOKEN"],
        "country":   "Rwanda",
        "currency":  "RWF",
        "vat":       1.18,
    },
    # shop-zetu handled separately via ShopifyQL
]

UGANDA_LOCATIONS = {
    59649392798:  "The Oasis Mall",
    111194112366: "Vivo Acacia",
}
RWANDA_LOCATIONS = {
    65931444396: "Vivo Kigali Heights",
    69236097196: "Vivo M-peace Plaza",
}

SITE_LOCATION_MAP = {
    'Vivo Junction':        'Vivo Junction',
    'Vivo Sarit Centre':    'Vivo Sarit',
    'Vivo Village Market':  'Vivo Village Market',
    'Vivo Westgate':        'Vivo T- Mall',
    'Vivo Garden City':     'Vivo Garden City',
    'Vivo Two Rivers':      'Vivo Two Rivers',
    'Vivo Galleria':        'Vivo Galleria',
    'Vivo Hub Karen':       'Vivo Hub',
    'Vivo Greenspan':       'Vivo Greenspan',
    'Vivo Capital Centre':  'Vivo Capital Centre',
    'Vivo Yaya':            'Vivo Yaya',
    'Vivo Mama Ngina':      'Vivo Mama Ngina St',
    'Vivo TRM':             'Vivo TRM',
    'Vivo Kisumu':          'Vivo Kisumu',
    'Vivo Nakuru':          'Vivo Nakuru',
    'Vivo Meru':            'Vivo Meru',
    'Vivo Eldoret':         'Vivo Eldoret',
    'Vivo Mombasa Digo':    'Vivo MSA Digo Road',
    'Vivo City Mall':       'Vivo City Mall',
    'Vivo Signature':       'Vivo Signature Mall',
    'Vivo Runda':           'Vivo Runda',
    'Vivo Kileleshwa':      'Vivo Kileleshwa',
    'Vivo Imaara':          'Vivo Imaara',
}

ODOO_LOCATION_MAP = {
    'Capital Centre':         'Vivo Capital Centre',
    'Eldoret (Rupa)':         'Vivo Eldoret',
    'Galleria':               'Vivo Galleria',
    'Garden City':            'Vivo Garden City',
    'Greenspan':              'Vivo Greenspan',
    'HQ Outlet':              'Staff purchases',
    'Hub':                    'Vivo Hub',
    'Imaara':                 'Vivo Imaara',
    'Junction':               'Vivo Junction',
    'Kileleshwa':             'Vivo Kileleshwa',
    'Kisumu (United Mall)':   'Vivo Kisumu',
    'Mama Ngina':             'Vivo Mama Ngina St',
    'Meru (Green Wood)':      'Vivo Meru',
    'Moi Avenue':             'Vivo Moi Avenue',
    'Mombasa (City Mall)':    'Vivo City Mall',
    'Mombasa CBD':            'Vivo MSA Digo Road',
    'Nakuru (Westside Mall)': 'Vivo Nakuru',
    'Runda Mall':             'Vivo Runda',
    'Sarit':                  'Vivo Sarit',
    'Sarit Safari':           'Safari Sarit',
    'Signature Mall':         'Vivo Signature Mall',
    'Thika Road Mall':        'Vivo TRM',
    'Tmall':                  'Vivo T- Mall',
    'Two Rivers':             'Vivo Two Rivers',
    'Village Market':         'Vivo Village Market',
    'Yaya':                   'Vivo Yaya',
    'Zoya Sarit':             'Zoya Sarit',
    'Shopzetu Online':        'Online - Shop Zetu',
}

UGANDA_VAT_LOCATIONS = {'The Oasis Mall', 'Vivo Acacia'}
RWANDA_VAT_LOCATIONS = {'Vivo Kigali Heights', 'Vivo M-peace Plaza'}

def get_exchange_rates(cur):
    """Get latest exchange rates from currency_rates table"""
    cur.execute("""
        SELECT DISTINCT ON (country) country, rate
        FROM currency_rates
        ORDER BY country, month DESC
    """)
    rates = {row[0]: float(row[1]) for row in cur.fetchall()}
    return rates

def get_vat(pos_location, store_vat=1.16):
    if pos_location in UGANDA_VAT_LOCATIONS:
        return 1.18
    if pos_location in RWANDA_VAT_LOCATIONS:
        return 1.18
    return store_vat

# How many days before the last known sale to re-pull each run. Defaults to 2
# (incremental overlap); the watchdog widens this for recovery backfills via the
# --days flag / SYNC_LOOKBACK_DAYS env var.
LOOKBACK_DAYS = int(os.environ.get("SYNC_LOOKBACK_DAYS", "2"))

def get_last_sync(cur, store_id):
    cur.execute("SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = %s", (store_id,))
    result = cur.fetchone()[0]
    if result:
        since = result - timedelta(days=LOOKBACK_DAYS)
        return since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"

def fetch_orders(store_url, token, since, limit=250):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/orders.json"
    params = {
        "status": "any",
        "updated_at_min": since,
        "limit": limit,
        "order": "updated_at asc",
    }
    all_orders = []
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    time.sleep(int(resp.headers.get("Retry-After", 10)))
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt + 1, e)
                time.sleep(10)
        orders = resp.json().get("orders", [])
        all_orders.extend(orders)
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_orders

KENYA_LOCATION_ID_MAP = {
    36310057056:  'Vivo Sarit',
    36309925984:  'Vivo Junction',
    36309958752:  'Vivo Mama Ngina St',
    49383899291:  'Vivo Moi Avenue',
    36309893216:  'Vivo Garden City',
    36309991520:  'Vivo Capital Centre',
    62460067995:  'Vivo Imaara',
    50320343195:  'Vivo Eldoret',
    61614751899:  'Vivo Kisumu',
    36478648416:  'Vivo Galleria',
    49363222683:  'Vivo Hub',
    50320408731:  'Vivo City Mall',
    50320277659:  'Vivo Nakuru',
    73530376347:  'Vivo Runda',
    66861301915:  'Vivo Greenspan',
    66839806107:  'Vivo Kileleshwa',
    66799567003:  'Vivo Meru',
    69343084699:  'Vivo MSA Digo Road',
    71464648859:  'Safari Sarit',
    66820767899:  'Staff purchases',
    66799599771:  'vivowoman',
    49363320987:  'Vivo Village Market',
    36478582880:  'Vivo Yaya',
    49383833755:  'Vivo Two Rivers',
    71464747163:  'Vivo Village Market',
    63040127131:  'Vivo TRM',
    61123592347:  'Vivo Signature Mall',
    49363550363:  'Vivo T- Mall',
    71464485019:  'Zoya Sarit',
}

def get_pos_location(store, order):
    store_id = store["store_id"]
    location_id = order.get("location_id")
    fulfillments = order.get("fulfillments", [])
    if not location_id and fulfillments:
        location_id = fulfillments[0].get("location_id")
    if store_id == "vivo-uganda":
        return UGANDA_LOCATIONS.get(location_id, "Uganda")
    if store_id == "vivo-rwanda":
        return RWANDA_LOCATIONS.get(location_id, "Rwanda")
    if store_id == "shop-zetu":
        return "Online - Shop Zetu"
    if store_id == "vivowoman":
        return KENYA_LOCATION_ID_MAP.get(location_id, "vivowoman")
    return "vivowoman"

def process_shopify_store(store, cur, now, rates):
    store_id = store["store_id"]
    since = get_last_sync(cur, store_id)
    log.info("Syncing %s since %s", store_id, since[:10])

    orders = fetch_orders(store["store_url"], store["token"], since)
    if not orders:
        log.info("%s — no new orders", store_id)
        return 0

    order_ids = [str(o["id"]) for o in orders]
    rows = []

    for order in orders:
        order_id      = str(order["id"])
        order_name    = order.get("name", "")
        created_at    = order.get("created_at", "")[:10]
        customer      = order.get("customer") or {}
        customer_id   = str(customer.get("id", "")) or None
        customer_type = "walk-in" if not customer_id else "registered"
        pos_location  = get_pos_location(store, order)
        financial_status = order.get("financial_status", "")
        is_return  = financial_status in ("refunded", "partially_refunded")
        sale_kind  = "return" if is_return else "order"

        # Get exchange rate for this store's country
        rate = rates.get(store["country"], 1.0)
        vat  = get_vat(pos_location, store["vat"])

        for line in order.get("line_items", []):
            sku   = line.get("sku") or ""
            title = line.get("title", "")
            qty   = int(line.get("quantity", 0))
            price = float(line.get("price", 0))  # VAT-inclusive in store currency
            disc  = float(line.get("total_discount", 0))

            # Match BigQuery: total_sales = price * qty (VAT-inclusive, store currency)
            total_sales   = price * qty
            gross_sales   = total_sales  # before discounts
            discounts     = disc
            net_sales     = total_sales  # Shopify net_sales = total after discount
            returns       = total_sales if is_return else 0.0
            total_out     = 0.0 if is_return else total_sales

            # Convert to KES using exchange rate (matching BigQuery formula)
            total_sales_kes   = round(total_sales / rate, 2)
            gross_sales_kes   = round(gross_sales / rate, 2)
            discounts_kes     = round(discounts / rate, 2)
            returns_kes       = round(returns / rate, 2)
            net_sales_kes     = round(total_sales / vat / rate, 2)
            product_price_kes = round(price / rate, 2)

            rows.append((
                str(uuid.uuid4()),
                store_id, order_id, order_name,
                created_at, created_at,
                pos_location, store["country"],
                "POS" if (store_id == "vivowoman" and pos_location != "vivowoman") else "Online",
                customer_id, customer_type, sale_kind,
                title, sku, qty,
                product_price_kes, price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                round(total_out / rate, 2),
                qty if not is_return else 0,
                returns_kes,
                now,
            ))

    cur.execute("DELETE FROM all_sales WHERE store_id = %s AND order_id = ANY(%s)", (store_id, order_ids))

    if rows:
        execute_values(cur, """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """, rows, page_size=500)

    log.info("✅ %s — %d orders, %d lines synced", store_id, len(orders), len(rows))
    return len(rows)

def sync_odoo(cur, now, rates):
    import xmlrpc.client

    ODOO_URL  = os.environ["ODOO_URL"]
    ODOO_DB   = os.environ["ODOO_DB"]
    ODOO_USER = os.environ["ODOO_USER"]
    ODOO_PASS = os.environ["ODOO_PASSWORD"]

    cur.execute("SELECT MAX(loaded_at::date) FROM all_sales WHERE store_id = 'vivofashiongroup'")
    result = cur.fetchone()[0]
    since  = (result - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S") if result else "2026-03-19 00:00:00"

    log.info("Odoo sync since %s", since[:10])

    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid    = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    orders = models.execute_kw(ODOO_DB, uid, ODOO_PASS, "pos.order", "search_read",
        [[["write_date", ">=", since], ["state", "in", ["done", "invoiced", "paid", "posted"]]]],
        {"fields": ["id","name","date_order","write_date","amount_total","amount_tax",
                    "partner_id","config_id","lines","session_id"],
         "limit": 5000})

    if not orders:
        log.info("Odoo — no new orders")
        return 0

    order_ids = [str(o["id"]) for o in orders]

    line_ids_all = [lid for o in orders for lid in o.get("lines", [])]
    lines_data = {}
    if line_ids_all:
        lines = models.execute_kw(ODOO_DB, uid, ODOO_PASS, "pos.order.line", "search_read",
            [[["id", "in", line_ids_all]]],
            {"fields": ["order_id","product_id","qty","price_unit","price_subtotal_incl",
                        "discount","product_uom_id"]})
        for l in lines:
            oid = str(l["order_id"][0])
            lines_data.setdefault(oid, []).append(l)
        # Fetch product SKUs (default_code) for all products in these lines
        prod_ids = list({l["product_id"][0] for l in lines if l.get("product_id")})
        sku_map = {}
        if prod_ids:
            prods = models.execute_kw(ODOO_DB, uid, ODOO_PASS, "product.product", "search_read",
                [[["id", "in", prod_ids]]],
                {"fields": ["id", "default_code"]})
            sku_map = {p["id"]: (p.get("default_code") or "") for p in prods}

    config_ids = list(set(o["config_id"][0] for o in orders if o.get("config_id")))
    configs = {}
    if config_ids:
        cfg_data = models.execute_kw(ODOO_DB, uid, ODOO_PASS, "pos.config", "search_read",
            [[["id", "in", config_ids]]],
            {"fields": ["id","name"]})
        configs = {c["id"]: c["name"] for c in cfg_data}

    kenya_rate = rates.get("Kenya", 1.0)

    rows = []
    for order in orders:
        order_id      = str(order["id"])
        order_name    = order.get("name", "")
        # Convert date_order from UTC to EAT (UTC+3) to match BigQuery
        from datetime import datetime as dt
        date_order_utc = order.get("date_order", "")
        try:
            date_order = (dt.strptime(date_order_utc[:19], "%Y-%m-%d %H:%M:%S") + timedelta(hours=3)).strftime("%Y-%m-%d")
        except:
            date_order = date_order_utc[:10]
        partner       = order.get("partner_id")
        customer_id   = str(partner[0]) if partner else None
        customer_type = "walk-in" if not customer_id else "registered"
        config_name   = configs.get(order["config_id"][0], "") if order.get("config_id") else ""
        pos_location  = ODOO_LOCATION_MAP.get(config_name, config_name)

        # Odoo Kenya only — rate=1, but use correct VAT per location
        rate = kenya_rate  # always 1.0 for Kenya
        vat  = get_vat(pos_location, 1.16)

        for line in lines_data.get(order_id, []):
            product    = line.get("product_id")
            title      = product[1] if product else ""
            qty        = float(line.get("qty", 0))
            price_unit = float(line.get("price_unit", 0))       # VAT-inclusive unit price
            total_incl = float(line.get("price_subtotal_incl", 0))  # VAT-inclusive line total
            disc_pct   = float(line.get("discount", 0))

            # Skip shopping bags (match BigQuery filter)
            if 'shopping bag' in title.lower():
                continue

            is_return  = qty < 0
            sale_kind  = "return" if is_return else "order"

            # Match BigQuery: total_sales = price_subtotal_incl (VAT-inclusive)
            total_sales = total_incl  # keep sign — negative qty = return
            gross_sales = price_unit * qty          # before discount
            discounts   = gross_sales - total_sales if not is_return else 0.0
            discounts   = max(discounts, 0.0)
            returns     = abs(total_sales) if is_return else 0.0
            total_out   = total_sales if not is_return else 0.0

            # KES conversion (rate=1 for Kenya, formula matches BigQuery)
            total_sales_kes   = round(total_out / rate, 2)
            gross_sales_kes   = round((gross_sales if not is_return else 0.0) / rate, 2)
            discounts_kes     = round(discounts / rate, 2)
            returns_kes       = round(returns / rate, 2)
            net_sales_kes     = round(total_out / vat / rate, 2)
            product_price_kes = round(price_unit / rate, 2)

            sku = sku_map.get(product[0], "") if product else ""
            rows.append((
                str(uuid.uuid4()),
                "vivofashiongroup", order_id, order_name,
                date_order, date_order,
                pos_location, "Kenya", "POS",
                customer_id, customer_type, sale_kind,
                title, sku,
                int(abs(qty)), product_price_kes, price_unit,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes,
                int(abs(qty)) if not is_return else 0,
                returns_kes,
                now,
            ))

    cur.execute("DELETE FROM all_sales WHERE store_id = 'vivofashiongroup' AND order_id = ANY(%s)", (order_ids,))

    if rows:
        execute_values(cur, """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """, rows, page_size=500)

    log.info("✅ Odoo — %d orders, %d lines synced", len(orders), len(rows))
    return len(rows)

def sync_footfall(cur, now):
    FOOTFALL_URL = "https://v9.footfallcam.com"
    CUBE_URL     = "https://cube.footfallcam.com/API/v1"
    EMAIL    = os.environ.get("FOOTFALLCAM_EMAIL", "charles@vivofashiongroup.com")
    PASSWORD = os.environ.get("FOOTFALLCAM_PASSWORD", "Vivo@2030")

    expiration = (datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%d")
    resp = requests.post(f"{FOOTFALL_URL}/account/GenerateAccessToken",
        json={"email": EMAIL, "password": PASSWORD, "expiration": expiration}, timeout=30)
    resp.raise_for_status()
    token = resp.json().get("AToken")
    if not token:
        log.error("Footfall auth failed")
        return 0

    headers = {"Authorization": f"Bearer {token}"}

    cur.execute("SELECT MAX(time::date) FROM footfall")
    result = cur.fetchone()[0]
    since   = (result - timedelta(days=2)).strftime("%Y-%m-%d") if result else (now - timedelta(days=7)).strftime("%Y-%m-%d")
    date_to = now.strftime("%Y-%m-%d")

    log.info("Footfall sync %s → %s", since, date_to)

    payload = {
        "query": {
            "measures": ["ffc_site_summary.A01", "ffc_site_summary.A05"],
            "timeDimensions": [{
                "dimension": "ffc_site_summary.Time",
                "granularity": "day",
                "dateRange": [since, date_to],
            }],
            "dimensions": ["ffc_site_summary.SiteName"],
            "limit": 50000,
        }
    }

    resp = requests.post(CUBE_URL + "/load", json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json().get("data", [])

    if not data:
        log.info("No footfall data")
        return 0

    rows = []
    seen = set()
    for rec in data:
        site    = rec.get("ffc_site_summary.SiteName", "")
        pos_loc = SITE_LOCATION_MAP.get(site, site)
        day     = (rec.get("ffc_site_summary.Time") or rec.get("ffc_site_summary.Time.day", ""))[:10]
        ff_in   = int(float(rec.get("ffc_site_summary.A01") or 0))
        outside = int(float(rec.get("ffc_site_summary.A05") or 0))
        key = (day, site)
        if key in seen:
            continue
        seen.add(key)
        rows.append((f"{site}_{day}", day, site, pos_loc, ff_in, outside))

    if rows:
        cur.execute("DELETE FROM footfall WHERE time >= %s AND time <= %s", (since, date_to))
        execute_values(cur, """
            INSERT INTO footfall (site_id, time, site_name, pos_location_name,
                a01_footfall_in, a05_outside_traffic)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, rows, page_size=500)
        log.info("✅ Footfall — %d rows", len(rows))

    return len(rows)


def categorise_products(cur):
    """Fill missing product_type and category based on product name keywords."""
    cur.execute("""
        UPDATE all_products_clean
        SET product_type = CASE
            WHEN UPPER(product_name) LIKE '%SAMPLE%' OR UPPER(product_name) LIKE '%GIFT VOUCHER%'
                OR UPPER(product_name) LIKE '%GIFT CARD%' OR UPPER(sku) LIKE '%FS%'
                OR UPPER(sku) LIKE 'CS%' OR UPPER(sku) LIKE 'SALE%' THEN 'Sample & Sale Items'
            WHEN LOWER(product_name) LIKE '%fitness bra%' OR LOWER(product_name) LIKE '%sports bra%'
                OR LOWER(product_name) LIKE '%bralette%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%fitness tights%' OR LOWER(product_name) LIKE '%legging%'
                OR LOWER(product_name) LIKE '%biker%' THEN 'Leggings'
            WHEN LOWER(product_name) LIKE '%catsuit%' OR LOWER(product_name) LIKE '%jumpsuit%'
                OR LOWER(product_name) LIKE '%playsuit%' OR LOWER(product_name) LIKE '%romper%' THEN 'Jumpsuits & Playsuits'
            WHEN LOWER(product_name) LIKE '%scarf%' OR LOWER(product_name) LIKE '%hijab%'
                OR LOWER(product_name) LIKE '%shawl%' OR LOWER(product_name) LIKE '%sarong%'
                OR LOWER(product_name) LIKE '%wrap%' OR LOWER(product_name) LIKE '%scarve%' THEN 'Scarves'
            WHEN LOWER(product_name) LIKE '%blazer%' OR LOWER(product_name) LIKE '%jacket%'
                OR LOWER(product_name) LIKE '%cardigan%' OR LOWER(product_name) LIKE '%coat%' THEN 'Jackets & Coats'
            WHEN LOWER(product_name) LIKE '%poncho%' OR LOWER(product_name) LIKE '%sweater%' THEN 'Sweaters & Ponchos'
            WHEN LOWER(product_name) LIKE '%waterfall%' OR LOWER(product_name) LIKE '%kimono%'
                OR LOWER(product_name) LIKE '%shrug%' OR LOWER(product_name) LIKE '%cover%' THEN 'Waterfalls & Kimonos'
            WHEN LOWER(product_name) LIKE '%hoodie%' OR LOWER(product_name) LIKE '%sweatshirt%' THEN 'Hoodies & Sweatshirts'
            WHEN LOWER(product_name) LIKE '%bodysuit%' OR LOWER(product_name) LIKE '%bdodysuit%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%culotte%' THEN 'Culottes & Capri Pants'
            WHEN LOWER(product_name) LIKE '%palazzo%' OR LOWER(product_name) LIKE '%jogger%'
                OR LOWER(product_name) LIKE '%trouser%' OR LOWER(product_name) LIKE '%jeans%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%full%' AND LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%skort%' OR (LOWER(product_name) LIKE '%short%'
                AND LOWER(product_name) NOT LIKE '%top%' AND LOWER(product_name) NOT LIKE '%sleeve%') THEN 'Shorts & Skorts'
            WHEN LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%knee%' AND LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%midi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Midi & Capri Dresses'
            WHEN LOWER(product_name) LIKE '%mini%' AND LOWER(product_name) LIKE '%dress%' THEN 'Short & Mini Dresses'
            WHEN LOWER(product_name) LIKE '%bodycon%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%kaftan%' OR LOWER(product_name) LIKE '%maxi%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%skirt%' THEN 'Maxi Skirts'
            WHEN LOWER(product_name) LIKE '%skirt%' THEN 'Knee Length Skirts'
            WHEN LOWER(product_name) LIKE '%tee%' OR LOWER(product_name) LIKE '%t-shirt%'
                OR LOWER(product_name) LIKE '%tank%' THEN 'T-shirts & Tank Tops'
            WHEN LOWER(product_name) LIKE '%fitted%' AND LOWER(product_name) LIKE '%top%' THEN 'Fitted Tops'
            WHEN LOWER(product_name) LIKE '%loose%' AND LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%tunic%' OR LOWER(product_name) LIKE '%blouse%'
                OR LOWER(product_name) LIKE '%vest%' OR LOWER(product_name) LIKE '%chiffon%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%earring%' OR LOWER(product_name) LIKE '%bracelet%'
                OR LOWER(product_name) LIKE '%necklace%' OR LOWER(product_name) LIKE '%ring%'
                OR LOWER(product_name) LIKE '%belt%' OR LOWER(product_name) LIKE '%hat%'
                OR LOWER(product_name) LIKE '%cap%' OR LOWER(product_name) LIKE '%bag%'
                OR LOWER(product_name) LIKE '%sock%' OR LOWER(product_name) LIKE '%accessori%' THEN 'Accessories'
            WHEN LOWER(product_name) LIKE '%shirt%' OR LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            ELSE 'Accessories'
        END
        WHERE product_type IS NULL OR TRIM(product_type) = ''
    """)

    cur.execute("""
        UPDATE all_products_clean
        SET category = CASE
            WHEN product_type IN ('Bodysuits','Fitted Tops','Loose Tops','Midriff & Crop Tops','T-shirts & Tank Tops') THEN 'Tops'
            WHEN product_type IN ('Culottes & Capri Pants','Full Length Pants','Jumpsuits & Playsuits','Leggings','Shorts & Skorts') THEN 'Bottoms'
            WHEN product_type IN ('Knee Length Dresses','Maxi Dresses','Midi & Capri Dresses','Short & Mini Dresses') THEN 'Dresses'
            WHEN product_type IN ('Knee Length Skirts','Maxi Skirts','Midi & Capri Skirts','Short & Mini Skirts') THEN 'Skirts'
            WHEN product_type IN ('Hoodies & Sweatshirts','Jackets & Coats','Sweaters & Ponchos','Waterfalls & Kimonos') THEN 'Outerwear'
            WHEN product_type IN ('Skirts & Top Set','Pants & Top Set','Two-Piece Sets') THEN 'Two-Piece Sets'
            WHEN product_type IN ('Accessories','Scarves','Belts','Earrings','Necklaces') THEN 'Accessories'
            WHEN product_type = 'Sample & Sale Items' THEN 'Sale'
            ELSE 'Accessories'
        END
        WHERE category IS NULL OR TRIM(category) = ''
    """)
    log.info("✅ Product categorisation done")

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    ensure_heartbeat_table(conn)
    write_heartbeat(conn, "cycle_start")

    # Load exchange rates once per sync cycle
    rates = get_exchange_rates(cur)
    log.info("Exchange rates: %s", rates)

    log.info("=== Starting incremental sync ===")

    for store in STORES:
        try:
            process_shopify_store(store, cur, now, rates)
            conn.commit()
            write_heartbeat(conn, f"store:{store['store_id']}")
        except Exception as e:
            log.error("Error syncing %s: %s", store["store_id"], e)
            conn.rollback()

    # Shop Zetu via ShopifyQL
    try:
        import subprocess, sys
        subprocess.run([sys.executable, '/home/runner/workspace/extract_shopzetu_shopifyql.py'], check=True)
        log.info('Shop Zetu ShopifyQL sync done')
    except Exception as e:
        log.error('Shop Zetu ShopifyQL sync error: %s', e)

    try:
        sync_odoo(cur, now, rates)
        conn.commit()
        write_heartbeat(conn, "odoo")
    except Exception as e:
        log.error("Odoo sync error: %s", e)
        conn.rollback()

    # Categorise any new products
    try:
        categorise_products(cur)
        conn.commit()
    except Exception as e:
        log.error("Categorisation error: %s", e)
        conn.rollback()

    try:
        sync_footfall(cur, now)
        conn.commit()
        write_heartbeat(conn, "footfall")
    except Exception as e:
        log.error("Footfall sync error: %s", e)
        conn.rollback()

    # Inventory sync — once a day at midnight EAT (21:00 UTC)
    now_utc = datetime.now(timezone.utc)
    if 21 <= now_utc.hour < 22:
        try:
            import subprocess, sys
            log.info("Running nightly inventory sync...")
            subprocess.run([sys.executable, '/home/runner/workspace/extract_odoo_inventory.py'], check=True)
            subprocess.run([sys.executable, '/home/runner/workspace/extract_shopify_inventory.py'], check=True)
            subprocess.run([sys.executable, '/home/runner/workspace/extract_shopzetu_inventory.py'], check=True)
            log.info("✅ Nightly inventory sync complete")
        except Exception as e:
            log.error("Inventory sync error: %s", e)

    # Chronic-stockout snapshot — once a day around midnight EAT (21:00 UTC).
    # The API endpoint dedupes to a weekly cadence, so running it on every cycle
    # in this window is harmless; we only narrow to the hour to avoid pointless
    # calls the rest of the day. It authenticates with the shared SESSION_SECRET.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/replenishment/snapshot",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info("Stockout snapshot — HTTP %s %s",
                         resp.status_code, resp.text[:200])
            else:
                log.warning("Stockout snapshot skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Stockout snapshot error: %s", e)

    # Data-quality log — once a day in the same 21:00 UTC window. Records the
    # current overall data-quality score onto a sync_health_log row so quality
    # is tracked alongside sync health. Authenticates with the shared secret.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/data-quality/log",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info("Data-quality log — HTTP %s %s",
                         resp.status_code, resp.text[:200])
            else:
                log.warning("Data-quality log skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Data-quality log error: %s", e)

    write_heartbeat(conn, "ok")
    conn.close()
    log.info("=== Sync complete ===")

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Vivo incremental sync")
    ap.add_argument("--once", action="store_true",
                    help="run a single sync cycle and exit (used for recovery)")
    ap.add_argument("--days", type=int, default=None,
                    help="re-pull this many days before the last known sale")
    cli = ap.parse_args()
    if cli.days is not None:
        LOOKBACK_DAYS = cli.days
        log.info("Lookback window overridden to %d days", LOOKBACK_DAYS)

    if cli.once:
        main()
    else:
        while True:
            try:
                main()
            except Exception as e:
                log.error("Fatal sync error: %s", e)
            log.info("Sleeping 1 minute...")
            time.sleep(60)
