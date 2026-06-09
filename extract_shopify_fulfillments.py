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
        "store_id":  "vivowoman",
        "store_url": os.environ["SHOPIFY_KENYA_STORE"],
        "token":     os.environ["SHOPIFY_KENYA_TOKEN"],
        "cutoff":    "2026-03-19",
    },
    {
        "store_id":  "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token":     os.environ["SHOPIFY_UGANDA_TOKEN"],
        "cutoff":    None,
    },
    {
        "store_id":  "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token":     os.environ["SHOPIFY_RWANDA_TOKEN"],
        "cutoff":    None,
    },
]

def get_last_sync(cur, store_id):
    cur.execute("""
        SELECT MAX(_loaded_at) FROM raw_shopify_fulfillments
        WHERE store_id = %s
    """, (store_id,))
    result = cur.fetchone()[0]
    if result:
        return (result - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    for store in STORES:
        store_id  = store["store_id"]
        store_url = store["store_url"]
        token     = store["token"]
        cutoff    = store.get("cutoff")

        since = get_last_sync(cur, store_id)
        if cutoff and since[:10] >= cutoff:
            log.info("✅ %s already fully synced", store_id)
            continue

        log.info("Fetching fulfillments for %s since %s", store_id, since[:10])

        headers = {"X-Shopify-Access-Token": token}
        url = f"https://{store_url}/admin/api/2025-10/orders.json"
        params = {
            "status": "any",
            "updated_at_min": since,
            "limit": BATCH_SIZE,
            "fields": "id,fulfillments",
            "order": "updated_at asc",
        }
        if cutoff:
            params["created_at_max"] = f"{cutoff}T23:59:59Z"

        total_orders = 0
        total_rows   = 0

        while url:
            for attempt in range(5):
                try:
                    resp = requests.get(url, headers=headers, params=params, timeout=60)
                    if resp.status_code == 429:
                        wait = int(resp.headers.get("Retry-After", 10))
                        time.sleep(wait)
                        continue
                    resp.raise_for_status()
                    break
                except (requests.exceptions.ChunkedEncodingError,
                        requests.exceptions.ConnectionError,
                        requests.exceptions.Timeout) as e:
                    log.warning("Network error attempt %d: %s", attempt+1, e)
                    time.sleep(10)
                    if attempt == 4:
                        raise

            orders = resp.json().get("orders", [])
            if not orders:
                break

            rows = []
            order_ids = [str(o["id"]) for o in orders]

            for order in orders:
                order_id = str(order["id"])
                for fulfillment in order.get("fulfillments", []):
                    fulfillment_id = str(fulfillment["id"])
                    location_id    = fulfillment.get("location_id")
                    location_name  = fulfillment.get("location_name")
                    status         = fulfillment.get("status")
                    for line in fulfillment.get("line_items", []):
                        rows.append((
                            store_id,
                            order_id,
                            fulfillment_id,
                            str(line["id"]),
                            int(location_id) if location_id else None,
                            location_name,
                            line.get("sku"),
                            int(line.get("quantity", 0)),
                            status,
                            now,
                        ))

            # Delete and reinsert per batch
            if order_ids:
                cur.execute("""
                    DELETE FROM raw_shopify_fulfillments
                    WHERE store_id = %s AND order_id = ANY(%s)
                """, (store_id, order_ids))

            if rows:
                execute_values(cur, """
                    INSERT INTO raw_shopify_fulfillments (
                        store_id, order_id, fulfillment_id, line_item_id,
                        location_id, location_name, sku, quantity,
                        fulfillment_status, _loaded_at
                    ) VALUES %s
                    ON CONFLICT (fulfillment_id, line_item_id, store_id) DO UPDATE SET
                        location_name = EXCLUDED.location_name,
                        _loaded_at = EXCLUDED._loaded_at
                """, rows, page_size=500)

            # Commit every batch
            conn.commit()
            total_orders += len(orders)
            total_rows   += len(rows)
            log.info("%s — %d orders, %d fulfillment rows committed", store_id, total_orders, total_rows)

            link = resp.headers.get("Link", "")
            next_url = None
            for part in link.split(","):
                if 'rel="next"' in part:
                    next_url = part.split(";")[0].strip().strip("<>")
            url = next_url
            params = {}

        log.info("✅ %s done — %d orders, %d rows", store_id, total_orders, total_rows)

    cur.execute("""
        SELECT store_id, COUNT(*) FROM raw_shopify_fulfillments
        GROUP BY store_id ORDER BY store_id
    """)
    print("\n=== raw_shopify_fulfillments summary ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} rows")

    conn.close()

if __name__ == "__main__":
    main()