import os, requests, uuid, psycopg2, logging, time
from psycopg2.extras import execute_values
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']
STORE_URL    = os.environ['SHOPIFY_KENYA_STORE']
TOKEN        = os.environ['SHOPIFY_KENYA_TOKEN']
SINCE        = "2026-01-01"
UNTIL        = "2026-03-19"
PAGE_SIZE    = 500
VAT          = 1.16

def run_shopifyql(query):
    escaped = query.replace('"', '\\"')
    gql = 'query { shopifyqlQuery(query: "' + escaped + '") { tableData { columns { name dataType } rows } parseErrors } }'
    for attempt in range(3):
        resp = requests.post(
            f'https://{STORE_URL}/admin/api/2025-10/graphql.json',
            headers={'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json'},
            json={'query': gql},
            timeout=60
        )
        if resp.status_code == 429:
            wait = int(resp.headers.get('Retry-After', 10))
            log.warning("Rate limited, waiting %ds", wait)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        data = resp.json()
        # Check ShopifyQL rate limit
        sq_cost = (data.get('extensions') or {}).get('shopifyqlCost', {})
        available = sq_cost.get('currentlyAvailable', 1000)
        if available < 50:
            reset = sq_cost.get('windowResetAt', '')
            log.warning("ShopifyQL quota low (%d), sleeping 12s", available)
            time.sleep(12)
        return data
    raise RuntimeError("Failed after 3 attempts")

def fetch_all():
    rows = []
    offset = 0
    while True:
        query = (
            f"FROM sales SHOW order_id, order_name, day, pos_location_name, "
            f"product_title, product_variant_sku, gross_sales, net_sales, "
            f"returns, discounts, quantity_ordered, net_items_sold "
            f"SINCE {SINCE} UNTIL {UNTIL} "
            f"GROUP BY order_id, order_name, day, pos_location_name, "
            f"product_title, product_variant_sku "
            f"ORDER BY day LIMIT {PAGE_SIZE} OFFSET {offset}"
        )
        data = run_shopifyql(query)
        ql = (data.get('data') or {}).get('shopifyqlQuery') or {}
        parse_errors = ql.get('parseErrors') or []
        if parse_errors:
            log.error('ShopifyQL parse errors: %s', parse_errors)
            break
        td = ql.get('tableData')
        if td is None:
            log.warning('tableData is None at offset=%d, retrying after 60s', offset)
            time.sleep(60)
            continue
        batch = td.get('rows') or []
        if not batch:
            break
        rows.extend(batch)
        log.info("Fetched %d rows (offset=%d)", len(rows), offset)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(12)  # ShopifyQL quota: 1000 points, resets per minute
    return rows

def main():
    rows = fetch_all()
    log.info("Total rows: %d", len(rows))

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    # Delete existing ShopifyQL + REST physical store rows for this period
    cur.execute("""
        DELETE FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name != 'vivowoman'
    """, (SINCE, UNTIL))
    log.info("Deleted %d existing rows", cur.rowcount)

    EXCLUDE = {'vivowoman', 'Staff purchases', 'HQ Outlet',
               'Online Orders Location', 'Sale Stock Location',
               'Shopping Bags Location'}

    insert_rows = []
    for r in rows:
        loc   = r.get('pos_location_name') or ''
        if loc in EXCLUDE:
            continue
        title = r.get('product_title') or ''
        if 'shopping bag' in title.lower():
            continue

        order_id  = str(r.get('order_id') or '')
        order_name= str(r.get('order_name') or '')
        day       = str(r.get('day') or '')[:10]
        sku       = str(r.get('product_variant_sku') or '')
        gross     = float(r.get('gross_sales') or 0)
        net       = float(r.get('net_sales') or 0)
        returns_v = float(r.get('returns') or 0)
        discounts = float(r.get('discounts') or 0)
        qty_ord   = int(float(r.get('quantity_ordered') or 0))
        net_qty   = int(float(r.get('net_items_sold') or 0))

        is_return = returns_v < 0 or net_qty < 0
        sale_kind = 'return' if is_return else 'order'

        # ShopifyQL returns ex-VAT values — gross up ×1.16
        gross_kes = round(gross * VAT, 2)
        net_kes   = round(net * VAT, 2)
        ret_kes   = round(abs(returns_v) * VAT, 2)
        disc_kes  = round(abs(discounts) * VAT, 2)
        total_out = gross_kes if not is_return else 0.0

        insert_rows.append((
            str(uuid.uuid4()), 'vivowoman', day,
            order_id, order_name,
            None, sale_kind, 'POS',
            loc, 'Kenya',
            sku, title, 1.0,
            gross_kes, disc_kes, net_kes,
            total_out,
            abs(qty_ord) if not is_return else 0,
            abs(net_qty),
            ret_kes,
            now,
        ))

    if insert_rows:
        execute_values(cur, """
            INSERT INTO all_sales (
                id, store_id, sale_date,
                order_id, order_name,
                customer_id, sale_kind, channel,
                pos_location_name, country,
                variant_sku, product_title, exchange_rate,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes,
                ordered_item_quantity,
                net_quantity,
                returns_kes,
                loaded_at
            ) VALUES %s
            ON CONFLICT DO NOTHING
        """, insert_rows, page_size=500)
        conn.commit()
        log.info("✅ Inserted %d rows", len(insert_rows))

    cur.execute("""
        SELECT COUNT(*), COUNT(DISTINCT order_id),
               ROUND(SUM(total_sales_kes)::numeric,0)
        FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name != 'vivowoman'
    """, (SINCE, UNTIL))
    row = cur.fetchone()
    log.info("Result: %d lines, %d orders, KES %s", row[0], row[1], row[2])
    conn.close()

if __name__ == '__main__':
    main()
