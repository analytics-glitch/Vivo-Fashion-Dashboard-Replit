#!/usr/bin/env python3
"""Pull 512px product images from Odoo -> product_images table (base64, deduped by template)."""
import xmlrpc.client, os, psycopg2, logging, time
from psycopg2.extras import execute_values
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("img")
ODOO_URL=os.environ['ODOO_URL']; ODOO_DB=os.environ['ODOO_DB']
ODOO_USER=os.environ['ODOO_USER']; ODOO_PW=os.environ['ODOO_PASSWORD']
DB=os.environ['DATABASE_URL']

def main():
    common=xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid=common.authenticate(ODOO_DB,ODOO_USER,ODOO_PW,{})
    models=xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    log.info("Connected uid=%s", uid)
    conn=psycopg2.connect(DB); cur=conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS product_images(
        tmpl_id BIGINT PRIMARY KEY, image_512 TEXT, updated_at TIMESTAMP DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS product_image_map(
        sku TEXT PRIMARY KEY, product_id BIGINT, tmpl_id BIGINT)""")
    conn.commit()

    cur.execute("SELECT sku, product_id FROM all_products_clean WHERE product_id IS NOT NULL")
    rows=cur.fetchall()
    variant_ids=list({pid for _,pid in rows})
    log.info("Resolving %d variants -> templates", len(variant_ids))

    # variant -> tmpl, and pick ONE representative variant id per template
    var_to_tmpl={}; tmpl_to_variant={}
    for i in range(0,len(variant_ids),500):
        recs=models.execute_kw(ODOO_DB,uid,ODOO_PW,'product.product','read',
            [variant_ids[i:i+500]],{'fields':['product_tmpl_id']})
        for r in recs:
            t=r.get('product_tmpl_id')
            if t:
                var_to_tmpl[r['id']]=t[0]
                tmpl_to_variant.setdefault(t[0], r['id'])
    log.info("%d variants, %d templates", len(var_to_tmpl), len(tmpl_to_variant))

    # write sku->tmpl map
    map_rows=[(sku,pid,var_to_tmpl.get(pid)) for sku,pid in rows]
    execute_values(cur,"""INSERT INTO product_image_map(sku,product_id,tmpl_id) VALUES %s
        ON CONFLICT(sku) DO UPDATE SET product_id=EXCLUDED.product_id, tmpl_id=EXCLUDED.tmpl_id""",
        map_rows, page_size=1000)
    conn.commit()
    log.info("map written: %d", len(map_rows))

    # fetch image_512 from product.product (the representative variant) — confirmed to return real bytes
    items=list(tmpl_to_variant.items())  # (tmpl_id, variant_id)
    stored=0; skipped=0
    for i in range(0,len(items),100):
        chunk=items[i:i+100]
        vid_list=[v for _,v in chunk]
        recs=models.execute_kw(ODOO_DB,uid,ODOO_PW,'product.product','read',
            [vid_list],{'fields':['image_512']})
        img_by_vid={r['id']:r.get('image_512') for r in recs}
        batch=[]
        for tmpl_id,vid in chunk:
            img=img_by_vid.get(vid)
            if img and len(img)>100: batch.append((tmpl_id,img))
            else: skipped+=1
        if batch:
            execute_values(cur,"""INSERT INTO product_images(tmpl_id,image_512,updated_at) VALUES %s
                ON CONFLICT(tmpl_id) DO UPDATE SET image_512=EXCLUDED.image_512, updated_at=now()""",
                batch, page_size=50, template="(%s,%s,now())")
            conn.commit(); stored+=len(batch)
        log.info("checked %d/%d, stored %d", min(i+100,len(items)), len(items), stored)
        time.sleep(0.1)
    log.info("DONE: %d images stored, %d templates without image", stored, skipped)
    conn.close()

if __name__=="__main__":
    main()
