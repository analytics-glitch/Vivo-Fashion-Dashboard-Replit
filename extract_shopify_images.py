#!/usr/bin/env python3
"""Pull product image URLs (full gallery, ordered) from Shopify into product_image_urls."""
import os, requests, time, psycopg2, logging, re
from psycopg2.extras import execute_values
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("shopimg")
DB = os.environ["DATABASE_URL"]
STORES = [
    {"id":"kenya","url":os.environ["SHOPIFY_KENYA_STORE"],"token":os.environ["SHOPIFY_KENYA_TOKEN"]},
    {"id":"uganda","url":os.environ["SHOPIFY_UGANDA_STORE"],"token":os.environ["SHOPIFY_UGANDA_TOKEN"]},
    {"id":"rwanda","url":os.environ["SHOPIFY_RWANDA_STORE"],"token":os.environ["SHOPIFY_RWANDA_TOKEN"]},
]
SKIP = re.compile(r"sizeguide|size-guide|size_guide|greyvideobutton|videobutton", re.I)

def fetch_store(store):
    url = f"https://{store['url']}/admin/api/2025-10/products.json"
    hdr = {"X-Shopify-Access-Token": store["token"]}
    params = {"limit":250, "fields":"id,title,variants,images"}
    sku_gallery = {}  # sku -> list of (sku, src, pos, is_primary)
    while url:
        for attempt in range(5):
            try:
                r = requests.get(url, headers=hdr, params=params, timeout=60)
                if r.status_code == 429:
                    w=int(r.headers.get("Retry-After",10)); log.warning("[%s] 429 wait %ds",store["id"],w); time.sleep(w); continue
                r.raise_for_status(); break
            except Exception as e:
                log.warning("[%s] attempt %d: %s",store["id"],attempt+1,e); time.sleep(10)
                if attempt==4: raise
        for p in r.json().get("products", []):
            photos = [im for im in sorted(p.get("images",[]), key=lambda x:x.get("position",0))
                      if im.get("src") and not SKIP.search(im["src"])]
            if not photos: continue
            for v in p.get("variants", []):
                sku = (v.get("sku") or "").strip()
                if not sku: continue
                prim_id = v.get("image_id")
                rows=[]
                for i, im in enumerate(photos, start=1):
                    is_prim = (im.get("id")==prim_id) if prim_id else (i==1)
                    rows.append((sku, im["src"], i, is_prim))
                sku_gallery[sku] = rows  # last variant wins within product (same gallery anyway)
        link=r.headers.get("Link",""); nxt=None
        for part in link.split(","):
            if 'rel="next"' in part: nxt=part.split(";")[0].strip().strip("<>")
        url=nxt; params={}
    log.info("[%s] %d SKUs with images", store["id"], len(sku_gallery))
    return sku_gallery

def main():
    conn=psycopg2.connect(DB); cur=conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS product_image_urls(
        sku TEXT NOT NULL, image_url TEXT NOT NULL, position INT NOT NULL,
        is_primary BOOLEAN DEFAULT false, PRIMARY KEY (sku, image_url))""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_piu_sku ON product_image_urls(sku)")
    conn.commit()
    seen=set(); all_rows=[]
    for store in STORES:
        log.info("Fetching %s...", store["id"])
        gallery = fetch_store(store)
        for sku, rows in gallery.items():
            if sku in seen: continue   # first store with this SKU wins
            seen.add(sku); all_rows.extend(rows)
    log.info("Total: %d images across %d SKUs", len(all_rows), len(seen))
    cur.execute("TRUNCATE product_image_urls")
    execute_values(cur, """INSERT INTO product_image_urls(sku,image_url,position,is_primary)
        VALUES %s ON CONFLICT (sku,image_url) DO UPDATE SET position=EXCLUDED.position, is_primary=EXCLUDED.is_primary""",
        all_rows, page_size=1000)
    conn.commit()
    cur.execute("SELECT COUNT(DISTINCT sku), COUNT(*) FROM product_image_urls")
    s,i = cur.fetchone(); log.info("DONE: %d images across %d SKUs", i, s)
    conn.close()

if __name__=="__main__":
    main()
