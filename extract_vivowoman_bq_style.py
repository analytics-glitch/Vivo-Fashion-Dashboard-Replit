"""
Extract vivowoman Shopify sales Jan 1 - Mar 19 2026 using BigQuery-style logic:
- Uses location_id from order (not fulfillments)
- Fetches full location map from /locations.json
- Creates separate return rows per refund with original order location
- Keyed by line_item_id for clean dedup
"""
import os, requests, uuid, psycopg2, logging, time
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']
STORE_URL    = os.environ['SHOPIFY_KENYA_STORE']
TOKEN        = os.environ['SHOPIFY_KENYA_TOKEN']
STORE_ID     = 'vivowoman'
START_DATE   = '2026-01-01'
END_DATE     = '2026-03-19'
VAT          = 1.16

def fetch_location_map():
    resp = requests.get(
        f'https://{STORE_URL}/admin/api/2025-10/locations.json',
        headers={'X-Shopify-Access-Token': TOKEN},
        timeout=30
    )
    resp.raise_for_status()
    locs = resp.json().get('locations', [])
    m = {loc['id']: loc['name'] for loc in locs if loc.get('id') and loc.get('name')}
    log.info("Loaded %d locations", len(m))
    return m

def get_pos_location(location_id, source_name, location_map):
    if location_id and location_id in location_map:
        return location_map[location_id]
    source = (source_name or '').lower().strip()
    if source == 'shopify_draft_order':
        return 'Manual Order'
    if source and source.isdigit():
        return 'Third-party App'
    return f'Online - {STORE_ID}'

def fetch_orders(since, until):
    headers = {'X-Shopify-Access-Token': TOKEN}
    url = f'https://{STORE_URL}/admin/api/2025-10/orders.json'
    params = {
        'status': 'any',
        'limit': 250,
        'created_at_min': since + 'T00:00:00Z',
        'created_at_max': until + 'T23:59:59Z',
        'fields': 'id,name,created_at,customer,source_name,location_id,line_items,refunds',
    }
    all_orders = []
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    time.sleep(int(resp.headers.get('Retry-After', 10)))
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt+1, e)
                time.sleep(10)
        orders = resp.json().get('orders', [])
        all_orders.extend(orders)
        log.info("Fetched %d orders so far", len(all_orders))
        link = resp.headers.get('Link', '')
        next_url = None
        for part in link.split(','):
            if 'rel="next"' in part:
                next_url = part.split(';')[0].strip().strip('<>')
        url = next_url
        params = {}
    return all_orders

def build_rows(orders, location_map):
    rows = []
    now = datetime.now(timezone.utc)
    for order in orders:
        order_id   = str(order['id'])
        order_name = order.get('name', '')
        created_at = order.get('created_at', '')
        try:
            dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        except Exception:
            dt = datetime.now(timezone.utc)
        day  = dt.strftime('%Y-%m-%d')
        year = dt.year
        source_name = order.get('source_name')
        location_id = order.get('location_id')
        pos_loc = get_pos_location(location_id, source_name, location_map)

        # Skip online orders (no physical location)
        if pos_loc.startswith('Online -') or pos_loc in ('Manual Order', 'Third-party App', 'Staff purchases'):
            continue

        # Build refund map per line_item_id
        refunds_by_line = defaultdict(list)
        for refund in (order.get('refunds') or []):
            ref_dt_str = refund.get('created_at', '')
            try:
                ref_dt = datetime.fromisoformat(ref_dt_str.replace('Z', '+00:00'))
            except Exception:
                ref_dt = dt
            for rli in (refund.get('refund_line_items') or []):
                li = rli.get('line_item') or {}
                li_id = li.get('id')
                qty   = rli.get('quantity', 0)
                rtype = rli.get('restock_type')
                if li_id and qty > 0:
                    refunds_by_line[li_id].append({
                        'quantity': int(qty),
                        'refund_dt': ref_dt,
                        'restock_type': rtype,
                    })

        for li in (order.get('line_items') or []):
            title  = li.get('name') or li.get('title') or ''
            if 'shopping bag' in title.lower():
                continue
            sku    = li.get('sku') or ''
            price  = float(li.get('price') or 0)
            qty    = int(li.get('quantity') or 0)
            li_id  = str(li.get('id') or uuid.uuid4())
            vendor = li.get('vendor') or ''
            ptype  = li.get('product_type') or ''

            disc = sum(float(a.get('amount', 0)) for a in (li.get('discount_allocations') or []))
            gross = price * qty
            total = gross - disc

            # ORDER row — use line_item_id as id for dedup
            rows.append((
                li_id, STORE_ID, day, order_id, order_name,
                source_name or 'pos', 'order', 'product',
                pos_loc, pos_loc,
                round(price * VAT, 2), title, ptype, vendor,
                str(li.get('variant_id') or ''), sku,
                None, None, None,
                round(total * VAT, 2), 1,
                round(gross * VAT, 2), round(disc * VAT, 2),
                0.0, round(total * VAT / VAT, 2),  # net_sales = total/VAT = ex-VAT
                qty, qty, 0,
                year, now, now, li_id, None,
                'Kenya', 1.0,
                round(price * VAT, 2),
                round(total * VAT, 2),
                round(gross * VAT, 2),
                round(disc * VAT, 2),
                0.0,
                round(total, 2),  # net_sales_kes = ex-VAT
            ))

            # RETURN rows
            for ref in refunds_by_line.get(li.get('id'), []):
                if ref['restock_type'] == 'cancel':
                    continue
                rqty   = ref['quantity']
                rdt    = ref['refund_dt']
                rday   = rdt.strftime('%Y-%m-%d')
                ryear  = rdt.year
                ret_amt = price * rqty

                rows.append((
                    f"{li_id}_ret_{rday}", STORE_ID, rday, order_id, order_name,
                    source_name or 'pos', 'return', 'product',
                    pos_loc, pos_loc,
                    round(price * VAT, 2), title, ptype, vendor,
                    str(li.get('variant_id') or ''), sku,
                    None, None, None,
                    round(-ret_amt * VAT, 2), 0,
                    0.0, 0.0,
                    round(ret_amt * VAT, 2), round(-ret_amt, 2),
                    -rqty, 0, rqty,
                    ryear, now, now, li_id, ref['restock_type'],
                    'Kenya', 1.0,
                    round(price * VAT, 2),
                    0.0, 0.0, 0.0,
                    round(ret_amt * VAT, 2),
                    round(-ret_amt, 2),
                    rday,
                ))
    return rows

def main():
    location_map = fetch_location_map()

    # Fetch in 30-day batches
    all_rows = []
    start = datetime.strptime(START_DATE, '%Y-%m-%d')
    end   = datetime.strptime(END_DATE, '%Y-%m-%d')
    while start <= end:
        batch_end = min(start + timedelta(days=29), end)
        log.info("Fetching %s to %s", start.strftime('%Y-%m-%d'), batch_end.strftime('%Y-%m-%d'))
        orders = fetch_orders(start.strftime('%Y-%m-%d'), batch_end.strftime('%Y-%m-%d'))
        rows = build_rows(orders, location_map)
        all_rows.extend(rows)
        log.info("Batch rows: %d, total: %d", len(rows), len(all_rows))
        start = batch_end + timedelta(days=1)
        time.sleep(1)

    log.info("Total rows to insert: %d", len(all_rows))

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Delete existing vivowoman physical store rows for this period
    cur.execute("""
        DELETE FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name NOT IN ('vivowoman', 'Online - vivowoman')
    """, (START_DATE, END_DATE))
    log.info("Deleted %d existing rows", cur.rowcount)

    if all_rows:
        execute_values(cur, """
            INSERT INTO all_sales (
                id, store_id, sale_date, order_id, order_name,
                purchase_option, sale_kind, sale_line_type,
                pos_location_name, channel,
                product_price_kes, product_title, product_type, product_vendor,
                variant_id, variant_sku,
                customer_id, customer_type, variant_title,
                total_sales_kes, orders,
                gross_sales_kes, discounts_kes,
                returns_kes, net_sales_kes,
                net_quantity, ordered_item_quantity, returned_item_quantity,
                year, loaded_at, last_synced, line_item_id, restock_type,
                country, exchange_rate,
                product_price,
                total_sales, gross_sales, discounts, returns, net_sales
            ) VALUES %s
            ON CONFLICT (id, store_id) DO UPDATE SET
                pos_location_name = EXCLUDED.pos_location_name,
                total_sales_kes = EXCLUDED.total_sales_kes,
                last_synced = EXCLUDED.last_synced
        """, all_rows, page_size=500)
        conn.commit()
        log.info("✅ Inserted %d rows", len(all_rows))

    cur.execute("""
        SELECT COUNT(DISTINCT order_id) as orders,
               ROUND(SUM(total_sales_kes)::numeric,0) as sales,
               COUNT(DISTINCT pos_location_name) as locations
        FROM all_sales
        WHERE store_id = 'vivowoman'
          AND sale_date BETWEEN %s AND %s
          AND pos_location_name NOT IN ('vivowoman','Online - vivowoman')
    """, (START_DATE, END_DATE))
    r = cur.fetchone()
    log.info("Result: %d orders, KES %s across %d locations", r[0], r[1], r[2])
    conn.close()

if __name__ == '__main__':
    main()
