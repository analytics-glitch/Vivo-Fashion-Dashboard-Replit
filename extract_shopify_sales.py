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
BATCH_SIZE   = 250

STORES = [
    {
        "store_id":    "vivowoman",
        "store_url":   os.environ["SHOPIFY_KENYA_STORE"],
        "token":       os.environ["SHOPIFY_KENYA_TOKEN"],
        "cutoff_date": "2026-03-19",
    },
    {
        "store_id":  "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token":     os.environ["SHOPIFY_UGANDA_TOKEN"],
        "cutoff_date": None,
    },
    {
        "store_id":  "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token":     os.environ["SHOPIFY_RWANDA_TOKEN"],
        "cutoff_date": None,
    },
]

def get_last_sync(cur, store_id):
    """Use MAX(day) as cursor so we always resume from last saved date."""
    cur.execute("""
        SELECT MAX(day) FROM raw_shopify_sales
        WHERE store_id = %s
    """, (store_id,))
    result = cur.fetchone()[0]
    if result:
        # Go back 2 days to catch late-arriving orders
        return (result - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"

def fetch_and_save_batch(store, cur, conn, since, until=None):
    store_id  = store["store_id"]
    store_url = store["store_url"]
    token     = store["token"]

    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/orders.json"
    params = {
        "status": "any",
        "created_at_min": since,
        "limit": BATCH_SIZE,
        "fields": "id,name,created_at,updated_at,financial_status,line_items,customer,location_name",
        "order": "created_at asc",
    }
    if until:
        params["created_at_max"] = until

    total_orders = 0
    total_lines  = 0
    now = datetime.now(timezone.utc)

    while url:
        for attempt in range(5):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", 10))
                    log.warning("Rate limited — waiting %ds", wait)
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            except (requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout) as e:
                log.warning("Network error attempt %d: %s — retrying in 10s", attempt+1, e)
                time.sleep(10)
                if attempt == 4:
                    raise

        orders = resp.json().get("orders", [])
        if not orders:
            break

        sale_rows  = []
        order_rows = []
        order_ids  = []

        for order in orders:
            order_id      = str(order["id"])
            order_name    = order.get("name")
            created_at    = order.get("created_at", "")[:10]
            fin_status    = order.get("financial_status", "")
            customer      = order.get("customer") or {}
            customer_id   = str(customer.get("id", "")) if customer.get("id") else None
            customer_type = "Returning" if customer.get("orders_count", 0) > 1 else "New"
            is_refunded   = fin_status in ("refunded", "partially_refunded")
            location_name = order.get("location_name") or store_id
            order_ids.append(order_id)

            order_rows.append((
                order_id, store_id, order_name,
                order.get("created_at"), order.get("updated_at"),
                customer_id,
                customer.get("email"),
                customer.get("first_name"),
                customer.get("last_name"),
                float(order.get("total_price", 0) or 0),
                fin_status,
                order.get("fulfillment_status"),
                order.get("source_name"),
                None, None, None, None,
                now,
            ))

            for line in order.get("line_items", []):
                title = (line.get("title") or "").lower()
                if "shopping bag" in title:
                    continue
                qty   = float(line.get("quantity", 0))
                price = float(line.get("price", 0))
                total = round(qty * price, 2)
                sale_kind    = "return" if is_refunded else "order"
                signed_total = -total if is_refunded else total

                sale_rows.append((
                    str(line["id"]), store_id, created_at,
                    order_id, order_name, "web", sale_kind, "product",
                    location_name, price,
                    line.get("title"), line.get("product_type"),
                    line.get("vendor"),
                    str(line.get("product_id", "")),
                    line.get("sku"), line.get("variant_title"),
                    customer_type, customer_id,
                    signed_total, 1,
                    total if not is_refunded else 0,
                    0,
                    total if is_refunded else 0,
                    signed_total,
                    int(qty) if not is_refunded else -int(qty),
                    int(qty) if not is_refunded else 0,
                    int(qty) if is_refunded else 0,
                    int(created_at[:4]) if created_at else None,
                    str(line["id"]),
                    "return" if is_refunded else None,
                    now,
                ))

        if order_ids:
            cur.execute(
                "DELETE FROM raw_shopify_sales WHERE store_id = %s AND order_id = ANY(%s)",
                (store_id, order_ids)
            )
            cur.execute(
                "DELETE FROM raw_shopify_orders WHERE store_id = %s AND id = ANY(%s)",
                (store_id, order_ids)
            )

        if sale_rows:
            execute_values(cur, """
                INSERT INTO raw_shopify_sales (
                    id, store_id, day, order_id, order_name, purchase_option,
                    sale_kind, sale_line_type, pos_location_name, product_price,
                    product_title, product_type, product_vendor, variant_id,
                    variant_sku, variant_title, customer_type, customer_id,
                    total_sales, orders, gross_sales, discounts, returns,
                    net_sales, net_quantity, ordered_item_quantity,
                    returned_item_quantity, year, line_item_id, restock_type,
                    _loaded_at
                ) VALUES %s
                ON CONFLICT (line_item_id, store_id) DO UPDATE SET
                    _loaded_at = EXCLUDED._loaded_at
            """, sale_rows)

        if order_rows:
            execute_values(cur, """
                INSERT INTO raw_shopify_orders (
                    id, store_id, name, created_at, updated_at,
                    customer_id, customer_email, customer_first_name,
                    customer_last_name, total_price, financial_status,
                    fulfillment_status, source_name,
                    billing_city, billing_country, shipping_city, shipping_country,
                    _loaded_at
                ) VALUES %s
                ON CONFLICT (id, store_id) DO UPDATE SET
                    _loaded_at = EXCLUDED._loaded_at
            """, order_rows)

        conn.commit()
        total_orders += len(orders)
        total_lines  += len(sale_rows)
        log.info("%s — %d orders, %d lines saved", store_id, total_orders, total_lines)

        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}

    log.info("✅ %s done — %d orders, %d lines", store_id, total_orders, total_lines)

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    for store in STORES:
        store_id  = store["store_id"]
        cutoff    = store.get("cutoff_date")
        since     = get_last_sync(cur, store_id)

        # Skip if already fully synced up to cutoff
        if cutoff and since[:10] >= cutoff:
            log.info("✅ %s already fully synced up to cutoff %s", store_id, cutoff)
            continue

        log.info("Syncing %s from %s to %s", store_id, since[:10], cutoff or "today")
        fetch_and_save_batch(
            store, cur, conn, since,
            until=f"{cutoff}T23:59:59Z" if cutoff else None
        )

    cur.execute("""
        SELECT store_id, COUNT(*), MIN(day), MAX(day)
        FROM raw_shopify_sales
        GROUP BY store_id ORDER BY store_id
    """)
    print("\n=== raw_shopify_sales summary ===")
    for row in cur.fetchall():
        log.info("%s: %d rows (%s to %s)", row[0], row[1], row[2], row[3])

    conn.close()

if __name__ == "__main__":
    main()