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
    {
        "store_id":  "shop-zetu",
        "store_url": os.environ["SHOPZETU_STORE"],
        "token":     os.environ["SHOPZETU_TOKEN"],
        "country":   "Online",
        "currency":  "KES",
        "vat":       1.0,
    },
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

def get_last_sync(cur, store_id):
    cur.execute("SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = %s", (store_id,))
    result = cur.fetchone()[0]
    if result:
        since = result - timedelta(days=2)
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

def get_pos_location(store, order):
    store_id = store["store_id"]
    fulfillments = order.get("fulfillments", [])
    location_id = fulfillments[0].get("location_id") if fulfillments else None
    if store_id == "vivo-uganda":
        return UGANDA_LOCATIONS.get(location_id, "Uganda")
    if store_id == "vivo-rwanda":
        return RWANDA_LOCATIONS.get(location_id, "Rwanda")
    if store_id == "shop-zetu":
        return "Online - Shop Zetu"
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
                "POS" if store_id == "vivowoman" else "Online",
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

            rows.append((
                str(uuid.uuid4()),
                "vivofashiongroup", order_id, order_name,
                date_order, date_order,
                pos_location, "Kenya", "POS",
                customer_id, customer_type, sale_kind,
                title, "",
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

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    # Load exchange rates once per sync cycle
    rates = get_exchange_rates(cur)
    log.info("Exchange rates: %s", rates)

    log.info("=== Starting incremental sync ===")

    for store in STORES:
        try:
            process_shopify_store(store, cur, now, rates)
            conn.commit()
        except Exception as e:
            log.error("Error syncing %s: %s", store["store_id"], e)
            conn.rollback()

    try:
        sync_odoo(cur, now, rates)
        conn.commit()
    except Exception as e:
        log.error("Odoo sync error: %s", e)
        conn.rollback()

    try:
        sync_footfall(cur, now)
        conn.commit()
    except Exception as e:
        log.error("Footfall sync error: %s", e)
        conn.rollback()

    conn.close()
    log.info("=== Sync complete ===")

if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as e:
            log.error("Fatal sync error: %s", e)
        log.info("Sleeping 1 minute...")
        time.sleep(60)
