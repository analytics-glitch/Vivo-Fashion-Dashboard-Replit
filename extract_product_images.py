#!/usr/bin/env python3
"""Pull 512px product images from Odoo -> product_images table (base64, deduped by template)."""
import xmlrpc.client, os, psycopg2, logging, time
from psycopg2.extras import execute_values
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("img")
ODOO_URL=os.environ['ODOO_URL']; ODOO_DB=os.environ['ODOO_DB']
ODOO_USER=os.environ['ODOO_USER']; ODOO_PW=os.environ['ODOO_PASSWORD']
DB=os.environ.get('VIVO_DATABASE_URL') or os.environ['DATABASE_URL']

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

    # Resolve every variant. Images are variant-owned in Odoo, so never assume
    # that one arbitrary representative carries the style/colour photograph.
    var_to_tmpl={}
    for i in range(0,len(variant_ids),500):
        recs=models.execute_kw(ODOO_DB,uid,ODOO_PW,'product.product','read',
            [variant_ids[i:i+500]],{'fields':['product_tmpl_id']})
        for r in recs:
            t=r.get('product_tmpl_id')
            if t:
                var_to_tmpl[r['id']]=t[0]
    log.info("%d variants, %d templates", len(var_to_tmpl), len(set(var_to_tmpl.values())))

    # write sku->tmpl map
    map_rows=[(sku,pid,var_to_tmpl.get(pid)) for sku,pid in rows]
    execute_values(cur,"""INSERT INTO product_image_map(sku,product_id,tmpl_id) VALUES %s
        ON CONFLICT(sku) DO UPDATE SET product_id=EXCLUDED.product_id, tmpl_id=EXCLUDED.tmpl_id""",
        map_rows, page_size=1000)
    conn.commit()
    log.info("map written: %d", len(map_rows))

    # Fetch all variants and retain the first photographed variant per template,
    # preferring variants with stock and then SKU order for a stable choice.
    sku_by_id={pid:sku for sku,pid in rows}
    items=sorted(var_to_tmpl)
    stored=0; skipped=0
    chosen={}
    for i in range(0,len(items),100):
        chunk=items[i:i+100]
        recs=models.execute_kw(ODOO_DB,uid,ODOO_PW,'product.product','read',
            [chunk],{'fields':['image_512','qty_available']})
        for r in recs:
            img=r.get('image_512')
            if not img or len(img)<=100:
                skipped+=1
                continue
            tmpl_id=var_to_tmpl.get(r['id'])
            score=(float(r.get('qty_available') or 0)>0, sku_by_id.get(r['id'],''))
            current=chosen.get(tmpl_id)
            if current is None or score[0] > current[0][0] or (score[0] == current[0][0] and score[1] < current[0][1]):
                chosen[tmpl_id]=(score,img)
        log.info("checked %d/%d, stored %d", min(i+100,len(items)), len(items), stored)
        time.sleep(0.1)
    batch=[(tmpl_id,value[1]) for tmpl_id,value in chosen.items()]
    if batch:
        execute_values(cur,"""INSERT INTO product_images(tmpl_id,image_512,updated_at) VALUES %s
            ON CONFLICT(tmpl_id) DO UPDATE SET image_512=EXCLUDED.image_512, updated_at=now()""",
            batch, page_size=50, template="(%s,%s,now())")
        conn.commit(); stored=len(batch)
    log.info("DONE: %d images stored, %d templates without image", stored, skipped)
    conn.close()

if __name__=="__main__":
    main()
