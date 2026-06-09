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
STORE_URL    = os.environ['SHOPZETU_STORE']
TOKEN        = os.environ['SHOPZETU_TOKEN']

VIVO_BRANDS = {'vivo', 'safari', 'zoya', 'shiv'}

def fetch_variants_with_inventory(store_url, token):
    """Fetch all products with variants and inventory_item_id, filtered by brand."""
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/products.json"
    params = {"limit": 250, "fields": "id,title,product_type,vendor,variants"}
    item_to_variant = {}

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

        for p in resp.json().get("products", []):
            title  = (p.get("title") or "").lower()
            vendor = (p.get("vendor") or "").lower()

            # Filter — only Vivo brands
            if not any(brand in title or brand in vendor for brand in VIVO_BRANDS):
                continue

            for v in p.get("variants", []):
                item_id = v.get("inventory_item_id")
                sku     = v.get("sku")
                if item_id and sku:
                    item_to_variant[item_id] = {
                        "sku":          sku,
                        "title":        p.get("title"),
                        "product_type": p.get("product_type"),
                        "vendor":       p.get("vendor"),
                    }

        log.info("Products fetched so far: %d variants matched", len(item_to_variant))

        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}

    return item_to_variant

def get_locations(store_url, token):
    resp = requests.get(
        f"https://{store_url}/admin/api/2025-10/locations.json",
        headers={"X-Shopify-Access-Token": token},
        timeout=30
    )
    resp.raise_for_status()
    return {loc["id"]: loc["name"] for loc in resp.json().get("locations", [])}

def fetch_inventory_levels(store_url, token, location_id):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/inventory_levels.json"
    params = {"location_ids": location_id, "limit": 250}
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
        all_levels.extend(resp.json().get("inventory_levels", []))
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_levels

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    # Remove existing Shop Zetu inventory
    cur.execute("DELETE FROM all_inventory WHERE pos_location_name = 'Online - Shop Zetu'")
    log.info("Cleared %d existing Shop Zetu rows", cur.rowcount)

    # Get filtered variants
    log.info("Fetching Shop Zetu products (Vivo/Safari/Zoya/Shiv only)...")
    item_to_variant = fetch_variants_with_inventory(STORE_URL, TOKEN)
    log.info("Matched variants: %d", len(item_to_variant))

    # Get locations
    locations = get_locations(STORE_URL, TOKEN)
    log.info("Locations: %s", locations)

    rows = []
    for location_id, location_name in locations.items():
        levels = fetch_inventory_levels(STORE_URL, TOKEN, location_id)
        log.info("%s: %d inventory levels", location_name, len(levels))

        for level in levels:
            item_id   = level.get("inventory_item_id")
            variant   = item_to_variant.get(item_id)
            if not variant:
                continue

            available = int(float(level.get("available") or 0))
            if available <= 0:
                continue

            rows.append((
                variant["sku"],
                None,
                variant["title"],
                None,
                None,
                None,
                variant["product_type"],
                location_name,
                'Online - Shop Zetu',
                'Online',
                available,
                available,
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
        log.info("✅ Inserted %d Shop Zetu inventory rows", len(rows))

    cur.execute("""
        SELECT COUNT(DISTINCT sku), SUM(available), SUM(on_hand)
        FROM all_inventory WHERE pos_location_name = 'Online - Shop Zetu'
    """)
    row = cur.fetchone()
    log.info("Shop Zetu inventory: %d SKUs, %d available, %d on hand", row[0], row[1] or 0, row[2] or 0)

    conn.close()

if __name__ == "__main__":
    main()