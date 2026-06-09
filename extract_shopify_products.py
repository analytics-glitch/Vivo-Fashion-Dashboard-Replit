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
]

def fetch_all_variants(store_url, token):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/products.json"
    params = {
        "limit": 250,
        "fields": "id,title,variants,product_type,vendor"
    }
    all_variants = []
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
            except Exception as e:
                log.warning("Attempt %d failed: %s", attempt+1, e)
                time.sleep(10)
                if attempt == 4:
                    raise

        products = resp.json().get("products", [])
        for p in products:
            for v in p.get("variants", []):
                all_variants.append({
                    "sku":          v.get("sku"),
                    "barcode":      v.get("barcode"),
                    "title":        v.get("title"),
                    "product_title": p.get("title"),
                    "product_type": p.get("product_type"),
                    "vendor":       p.get("vendor"),
                    "price":        float(v.get("price", 0) or 0),
                })

        log.info("Fetched %d variants so far", len(all_variants))

        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}

    return all_variants

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Collect all barcodes across stores — SKU → barcode
    sku_barcode = {}
    sku_price   = {}

    for store in STORES:
        log.info("Fetching products from %s...", store["store_id"])
        variants = fetch_all_variants(store["store_url"], store["token"])
        log.info("✅ %s — %d variants", store["store_id"], len(variants))

        for v in variants:
            sku     = v.get("sku")
            barcode = v.get("barcode")
            price   = v.get("price")

            if not sku:
                continue

            if barcode and sku not in sku_barcode:
                sku_barcode[sku] = barcode

            if price and sku not in sku_price:
                sku_price[sku] = price

    log.info("Total unique SKUs with barcodes: %d", len(sku_barcode))

    # Update all_products_clean with barcodes
    updated = 0
    for sku, barcode in sku_barcode.items():
        cur.execute("""
            UPDATE all_products_clean
            SET barcode = %s
            WHERE sku = %s AND barcode IS NULL
        """, (str(barcode), sku))
        updated += cur.rowcount

    conn.commit()
    log.info("✅ Updated %d products with Shopify barcodes", updated)

    # Check coverage
    cur.execute("""
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN barcode IS NOT NULL THEN 1 ELSE 0 END) as has_barcode,
            ROUND(100.0 * SUM(CASE WHEN barcode IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as pct
        FROM all_products_clean
        WHERE ever_sold = TRUE
    """)
    row = cur.fetchone()
    log.info("Barcode coverage: %d/%d (%.1f%%)", row[1], row[0], row[2])

    conn.close()

if __name__ == "__main__":
    main()