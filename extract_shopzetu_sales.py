import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta
import time
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']
STORE_URL    = os.environ['SHOPZETU_STORE']
TOKEN        = os.environ['SHOPZETU_TOKEN']
BATCH_SIZE   = 250

VIVO_VENDORS = {
    'safari', 'vivo', 'zoya', 'sowairina by vivo',
    'vivo woman', 'zoya essentials', 'safari by vivo'
}

def get_last_sync(cur):
    cur.execute("SELECT MAX(day) FROM raw_shopify_vendor_sales")
    result = cur.fetchone()[0]
    if result:
        return (result - timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2022-01-01T00:00:00Z"

def fetch_orders(since):
    headers = {"X-Shopify-Access-Token": TOKEN}
    url = f"https://{STORE_URL}/admin/api/2025-10/orders.json"
    params = {
        "status": "any",
        "updated_at_min": since,
        "limit": BATCH_SIZE,
        "fields": "id,name,created_at,financial_status,line_items,customer,refunds"
    }
    all_orders = []
    while url:
        for attempt in range(3):
            resp = requests.get(url, headers=headers, params=params)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", 10))
                log.warning("Rate limited — waiting %ds", wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            break
        orders = resp.json().get("orders", [])
        all_orders.extend(orders)
        log.info("Fetched %d orders so far", len(all_orders))
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_orders

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    since     = get_last_sync(cur)
    date_from = since[:10]
    date_to   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log.info("Syncing Shop Zetu from %s to %s", date_from, date_to)

    orders = fetch_orders(since)
    log.info("Total orders fetched: %d", len(orders))

    if not orders:
        log.info("No data found")
        conn.close()
        return

    now = datetime.now(timezone.utc)
    pg_rows = []

    for order in orders:
        order_id    = str(order["id"])
        order_name  = order.get("name")
        day_str     = order.get("created_at", "")[:10]
        fin_status  = order.get("financial_status", "")
        is_refunded = fin_status in ("refunded", "partially_refunded")
        customer    = order.get("customer") or {}
        customer_type = "Returning" if customer.get("orders_count", 0) > 1 else "New"

        for line in order.get("line_items", []):
            vendor = (line.get("vendor") or "").lower()
            title  = (line.get("title") or "").lower()
            if vendor not in VIVO_VENDORS:
                continue
            if "shopping bag" in title:
                continue

            qty   = float(line.get("quantity", 0))
            price = float(line.get("price", 0))
            gross = round(qty * price, 2)
            total = -gross if is_refunded else gross

            pg_rows.append((
                order_id,                               # 0  order_id
                order_name,                             # 1  order_name
                day_str,                                # 2  day
                line.get("title"),                      # 3  product_title_at_time_of_sale
                line.get("product_type"),               # 4  product_type
                line.get("vendor"),                     # 5  product_vendor
                str(line.get("product_id", "")),        # 6  product_variant_id
                line.get("sku") or "",                  # 7  product_variant_sku
                line.get("variant_title"),              # 8  product_variant_title_at_time_of_sale
                price,                                  # 9  product_variant_price
                gross if not is_refunded else 0,        # 10 gross_sales
                0,                                      # 11 discounts
                gross if is_refunded else 0,            # 12 returns
                total,                                  # 13 net_sales
                total,                                  # 14 total_sales
                1 if not is_refunded else 0,            # 15 orders
                int(qty) if not is_refunded else -int(qty),  # 16 net_items_sold
                int(qty) if not is_refunded else 0,     # 17 quantity_ordered
                int(qty) if is_refunded else 0,         # 18 reversed_quantity
                customer_type,                          # 19 new_or_returning_customer
                is_refunded,                            # 20 is_reversal_row
                False,                                  # 21 is_totals_row
                now,                                    # 22 _loaded_at
            ))

    if not pg_rows:
        log.info("No rows to insert")
        conn.close()
        return

    # Deduplicate by primary key (order_id, day, sku, is_reversal_row)
    seen = set()
    deduped_rows = []
    for row in pg_rows:
        key = (row[0], row[2], row[7], row[20])
        if key not in seen:
            seen.add(key)
            deduped_rows.append(row)
    pg_rows = deduped_rows
    log.info("After dedup: %d rows", len(pg_rows))

    # Delete then reinsert for date range
    cur.execute("""
        DELETE FROM raw_shopify_vendor_sales
        WHERE day >= %s AND day <= %s
    """, (date_from, date_to))

    execute_values(cur, """
        INSERT INTO raw_shopify_vendor_sales (
            order_id, order_name, day,
            product_title_at_time_of_sale, product_type, product_vendor,
            product_variant_id, product_variant_sku,
            product_variant_title_at_time_of_sale,
            product_variant_price, gross_sales, discounts, returns,
            net_sales, total_sales, orders, net_items_sold,
            quantity_ordered, reversed_quantity,
            new_or_returning_customer, is_reversal_row, is_totals_row,
            _loaded_at
        ) VALUES %s
        ON CONFLICT (order_id, day, product_variant_sku, is_reversal_row) DO UPDATE SET
            _loaded_at = EXCLUDED._loaded_at,
            net_sales = EXCLUDED.net_sales
    """, pg_rows, page_size=500)

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM raw_shopify_vendor_sales")
    log.info("✅ raw_shopify_vendor_sales: %d rows total", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()