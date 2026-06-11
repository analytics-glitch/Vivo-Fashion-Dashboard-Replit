import os, requests, uuid, psycopg2, logging
from psycopg2.extras import execute_values
from datetime import datetime, timezone, date, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']
STORE_URL    = os.environ['SHOPIFY_KENYA_STORE']
TOKEN        = os.environ['SHOPIFY_KENYA_TOKEN']
SINCE        = "2026-01-01"
UNTIL        = "2026-03-19"
PAGE_SIZE    = 500
VAT          = 1.16

EXCLUDE_LOCATIONS = {
    'vivowoman', 'Staff purchases', 'HQ Outlet',
    'Online Orders Location', 'Sale Stock Location',
    'Shopping Bags Location',
}

def run_shopifyql(query):
    escaped = query.replace('"', '\\"')
    gql = 'query { shopifyqlQuery(query: "' + escaped + '") { tableData { columns { name dataType } rows } parseErrors } }'
    resp = requests.post(
        f'https://{STORE_URL}/admin/api/2025-10/graphql.json',
        headers={'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json'},
        json={'query': gql},
        timeout=60
    )
    resp.raise_for_status()
    return resp.json()

def fetch_all():
    rows = []
    offset = 0
    while True:
        query = (
            f"FROM sales SHOW pos_location_name, day, gross_sales, net_sales, "
            f"returns, discounts, orders, net_items_sold "
            f"SINCE {SINCE} UNTIL {UNTIL} "
            f"GROUP BY pos_location_name, day ORDER BY day "
            f"LIMIT {PAGE_SIZE} OFFSET {offset}"
        )
        data = run_shopifyql(query)
        td = data['data']['shopifyqlQuery']['tableData']
        batch = td.get('rows') or []
        if not batch:
            break
        rows.extend(batch)
        log.info("Fetched %d rows so far (offset=%d)", len(rows), offset)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows

def main():
    rows = fetch_all()
    log.info("Total ShopifyQL rows: %d", len(rows))

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    # Delete existing vivowoman physical store rows for this period
    cur.execute("""
        DELETE FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name != 'vivowoman'
    """, (SINCE, UNTIL))
    log.info("Deleted %d existing rows", cur.rowcount)

    insert_rows = []
    for r in rows:
        loc = r.get('pos_location_name') or ''
        if loc in EXCLUDE_LOCATIONS:
            continue
        day         = str(r.get('day') or '')[:10]
        gross       = float(r.get('gross_sales') or 0)
        net         = float(r.get('net_sales') or 0)
        returns_val = abs(float(r.get('returns') or 0))
        discounts   = abs(float(r.get('discounts') or 0))
        orders      = int(float(r.get('orders') or 0))
        units       = int(float(r.get('net_items_sold') or 0))

        # ShopifyQL returns ex-VAT — gross up to match REST API KES values
        gross_kes   = round(gross * VAT, 2)
        net_kes     = round(net * VAT, 2)
        ret_kes     = round(returns_val * VAT, 2)
        disc_kes    = round(discounts * VAT, 2)

        is_return = returns_val > 0 and net < 0
        sale_kind = 'return' if is_return else 'order'
        total_out = gross_kes if not is_return else 0.0

        insert_rows.append((
            str(uuid.uuid4()), 'vivowoman', day, f'shopifyql-{loc}-{day}', f'{loc}/{day}',
            None, sale_kind, None,
            loc, 'POS',
            None, None, 'Kenya', 1.0,
            0.0, None, None, None, None,
            gross_kes, disc_kes, net_kes,
            total_out,
            units if not is_return else 0,
            ret_kes,
            now,
        ))

    if insert_rows:
        execute_values(cur, """
            INSERT INTO all_sales (
                id, store_id, sale_date, order_id, order_name,
                customer_id, sale_kind, channel,
                pos_location_name, purchase_option,
                customer_type, variant_sku, country, exchange_rate,
                product_price_kes, product_title, product_type, product_vendor, variant_title,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes,
                net_quantity,
                returns_kes,
                loaded_at
            ) VALUES %s
            ON CONFLICT DO NOTHING
        """, insert_rows, page_size=500)
        conn.commit()
        log.info("✅ Inserted %d rows", len(insert_rows))

    cur.execute("""
        SELECT COUNT(*), ROUND(SUM(total_sales_kes)::numeric,0) as sales
        FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name != 'vivowoman'
    """, (SINCE, UNTIL))
    row = cur.fetchone()
    log.info("vivowoman physical stores %s-%s: %d rows, KES %s", SINCE, UNTIL, row[0], row[1])
    conn.close()

if __name__ == '__main__':
    main()
