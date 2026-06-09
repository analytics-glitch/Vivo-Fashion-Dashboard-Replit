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

STORES = [
    {
        "store_id":  "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token":     os.environ["SHOPIFY_UGANDA_TOKEN"],
        "locations": {
            59649392798:  "The Oasis Mall",
            111194112366: "Vivo Acacia",
        }
    },
    {
        "store_id":  "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token":     os.environ["SHOPIFY_RWANDA_TOKEN"],
        "locations": {
            65931444396: "Vivo Kigali Heights",
            69236097196: "Vivo M-peace Plaza",
        }
    },
    {
        "store_id":  "shop-zetu",
        "store_url": os.environ["SHOPZETU_STORE"],
        "token":     os.environ["SHOPZETU_TOKEN"],
        "locations": {}  # will fetch all locations
    },
]

def get_locations(store_url, token):
    resp = requests.get(
        f"https://{store_url}/admin/api/2025-10/locations.json",
        headers={"X-Shopify-Access-Token": token},
        timeout=30
    )
    resp.raise_for_status()
    return {loc["id"]: loc["name"] for loc in resp.json().get("locations", [])}

def fetch_inventory(store_url, token, location_id):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/inventory_levels.json"
    params = {
        "location_ids": location_id,
        "limit": 250,
    }
    all_levels = []
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", 10))
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt+1, e)
                time.sleep(10)
        levels = resp.json().get("inventory_levels", [])
        all_levels.extend(levels)
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_levels

def fetch_variants_map(store_url, token):
    """Build inventory_item_id → sku mapping."""
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/products.json"
    params = {"limit": 250, "fields": "id,variants"}
    item_to_sku = {}
    while url:
        resp = requests.get(url, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        for p in resp.json().get("products", []):
            for v in p.get("variants", []):
                if v.get("sku") and v.get("inventory_item_id"):
                    item_to_sku[v["inventory_item_id"]] = v["sku"]
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    log.info("Variant map: %d items", len(item_to_sku))
    return item_to_sku

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    # Remove existing Shopify inventory rows
    cur.execute("""
        DELETE FROM all_inventory
        WHERE pos_location_name IN (
            'The Oasis Mall', 'Vivo Acacia',
            'Vivo Kigali Heights', 'Vivo M-peace Plaza',
            'Online - Shop Zetu'
        )
    """)
    log.info("Cleared existing Shopify inventory rows: %d", cur.rowcount)

    for store in STORES:
        store_id  = store["store_id"]
        store_url = store["store_url"]
        token     = store["token"]
        locations = store["locations"]

        log.info("Processing %s...", store_id)

        # Build variant map
        item_to_sku = fetch_variants_map(store_url, token)

        # If no locations defined, fetch them
        if not locations:
            all_locs = get_locations(store_url, token)
            # Filter to relevant ones only
            locations = {
                lid: name for lid, name in all_locs.items()
                if any(k in name.lower() for k in ['vivo', 'safari', 'zoya', 'oasis', 'kigali', 'acacia'])
            }
            if not locations:
                locations = all_locs
            log.info("%s locations: %s", store_id, locations)

        rows = []
        for location_id, location_name in locations.items():
            levels = fetch_inventory(store_url, token, location_id)
            log.info("%s — %s: %d inventory levels", store_id, location_name, len(levels))

            for level in levels:
                item_id   = level.get("inventory_item_id")
                sku       = item_to_sku.get(item_id)
                available = int(level.get("available") or 0)
                on_hand   = available  # Shopify only gives available

                if not sku or available <= 0:
                    continue

                rows.append((
                    sku,
                    None,  # style_name
                    None,  # product_name
                    None,  # size
                    None,  # color_print
                    None,  # brand
                    None,  # sub_category
                    location_name,
                    location_name,  # pos_location_name
                    'Uganda' if store_id == 'vivo-uganda' else
                    'Rwanda' if store_id == 'vivo-rwanda' else 'Online',
                    available,
                    on_hand,
                    now,
                ))

        if rows:
            execute_values(cur, """
                INSERT INTO all_inventory (
                    sku, style_name, product_name, size, color_print,
                    brand, sub_category, location_name, pos_location_name,
                    country, available, on_hand, _loaded_at
                ) VALUES %s
            """, rows, page_size=500)
            conn.commit()
            log.info("✅ %s — inserted %d rows", store_id, len(rows))

    cur.execute("""
        SELECT pos_location_name, COUNT(DISTINCT sku) as skus,
               SUM(on_hand) as on_hand
        FROM all_inventory
        WHERE pos_location_name IN (
            'The Oasis Mall', 'Vivo Acacia',
            'Vivo Kigali Heights', 'Vivo M-peace Plaza',
            'Online - Shop Zetu'
        )
        GROUP BY pos_location_name ORDER BY on_hand DESC
    """)
    print("\n=== Shopify inventory ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} SKUs, {row[2]} units")

    conn.close()

if __name__ == "__main__":
    main()