"""
For the products Odoo is missing style number/name on, check whether
all_products_clean (Replit) HAS a style number/name we could write back.
Joins the missing-list (by product name) to all_products_clean.
"""
import os, csv, psycopg2, psycopg2.extras
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# what columns exist?
cur.execute("""SELECT column_name FROM information_schema.columns
               WHERE table_name='all_products_clean' ORDER BY ordinal_position""")
cols=[r["column_name"] for r in cur.fetchall()]
print("all_products_clean columns:", cols)

# load missing product names
miss=list(csv.DictReader(open("/home/runner/workspace/missing_style_fields.csv",encoding="utf-8")))
names=[m["product_name"].strip() for m in miss]
print(f"\nMissing products to check: {len(names)}")

# For a sample, see if all_products_clean has style_number/style_name for the same product_name
# (all_products_clean is per-SKU; product_name there includes the colour suffix, so match on prefix)
sample=names[:200]
found_num=found_name=0
examples=[]
for nm in sample:
    cur.execute("""
        SELECT style_number, style_name, product_name, sku
        FROM all_products_clean
        WHERE product_name ILIKE %s
        LIMIT 1
    """, (nm.split(" - ")[0].strip()+"%",))
    r=cur.fetchone()
    if r:
        if (r["style_number"] or "").strip(): found_num+=1
        if (r["style_name"] or "").strip(): found_name+=1
        if len(examples)<15:
            examples.append((nm, r["style_number"], r["style_name"]))
print(f"\nOf {len(sample)} sampled missing products, all_products_clean had:")
print(f"   style_number present: {found_num}")
print(f"   style_name present:   {found_name}")
print("\nExamples (odoo_missing_name -> clean.style_number / clean.style_name):")
for nm,sn,snm in examples:
    print(f"   {nm[:45]:<45} -> {sn!r} / {snm!r}")
conn.close()
