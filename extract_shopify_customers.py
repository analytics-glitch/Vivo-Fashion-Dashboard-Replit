import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
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
    },
    {
        "store_id":  "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token":     os.environ["SHOPIFY_UGANDA_TOKEN"],
    },
    {
        "store_id":  "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token":     os.environ["SHOPIFY_RWANDA_TOKEN"],
    },
    {
        "store_id":  "shop-zetu",
        "store_url": os.environ["SHOPZETU_STORE"],
        "token":     os.environ["SHOPZETU_TOKEN"],
    },
]

def get_last_sync(cur, store_id):
    cur.execute("""
        SELECT MAX(_loaded_at) FROM raw_shopify_customers
        WHERE store_id = %s
    """, (store_id,))
    result = cur.fetchone()[0]
    if result:
        return result.strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"

def fetch_customers(store_url, token, since):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/customers.json"
    params = {
        "updated_at_min": since,
        "limit": BATCH_SIZE,
        "fields": "id,email,first_name,last_name,phone,default_address,"
                  "state,total_spent,orders_count,"
                  "accepts_marketing,sms_marketing_consent,"
                  "created_at,updated_at"
    }
    all_customers = []
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
        customers = resp.json().get("customers", [])
        all_customers.extend(customers)
        log.info("Fetched %d customers so far from %s", len(all_customers), store_url)
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_customers

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    for store in STORES:
        store_id  = store["store_id"]
        store_url = store["store_url"]
        token     = store["token"]

        since = get_last_sync(cur, store_id)
        log.info("Syncing customers for %s since %s", store_id, since)

        customers = fetch_customers(store_url, token, since)
        if not customers:
            log.info("No new customers for %s", store_id)
            continue

        rows = []
        customer_ids = []

        for c in customers:
            customer_ids.append(str(c["id"]))
            address = c.get("default_address") or {}
            sms = c.get("sms_marketing_consent") or {}

            rows.append((
                str(c["id"]),                                   # id
                store_id,                                       # store_id
                c.get("email"),                                 # email
                c.get("first_name"),                           # first_name
                c.get("last_name"),                            # last_name
                c.get("phone") or address.get("phone"),        # phone
                address.get("phone"),                          # default_address_phone
                c.get("state"),                                # state
                float(c.get("total_spent", 0) or 0),           # total_spent
                int(c.get("orders_count", 0) or 0),            # orders_count
                bool(c.get("accepts_marketing", False)),        # accepts_email_marketing
                sms.get("state") == "subscribed",              # accepts_sms_marketing
                c.get("created_at"),                           # created_at
                c.get("updated_at"),                           # updated_at
                now,                                           # _loaded_at
            ))

        # Delete then reinsert
        cur.execute(
            "DELETE FROM raw_shopify_customers WHERE store_id = %s AND id = ANY(%s)",
            (store_id, customer_ids)
        )

        execute_values(cur, """
            INSERT INTO raw_shopify_customers (
                id, store_id, email, first_name, last_name,
                phone, default_address_phone, state,
                total_spent, orders_count,
                accepts_email_marketing, accepts_sms_marketing,
                created_at, updated_at, _loaded_at
            ) VALUES %s
            ON CONFLICT (id, store_id) DO UPDATE SET
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                total_spent = EXCLUDED.total_spent,
                orders_count = EXCLUDED.orders_count,
                _loaded_at = EXCLUDED._loaded_at
        """, rows, page_size=500)

        conn.commit()
        log.info("✅ %s — %d customers synced", store_id, len(rows))

    cur.execute("""
        SELECT store_id, COUNT(*) FROM raw_shopify_customers
        GROUP BY store_id ORDER BY store_id
    """)
    for row in cur.fetchall():
        log.info("raw_shopify_customers %s: %d rows", row[0], row[1])

    conn.close()

if __name__ == "__main__":
    main()