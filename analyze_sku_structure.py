"""Read-only: understand SKU -> style number structure in all_products_clean."""
import os, re, psycopg2, psycopg2.extras
from collections import Counter
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# sample SKUs with their existing style_number to learn the split
cur.execute("""SELECT sku, style_number, product_name, style_name
               FROM all_products_clean
               WHERE sku IS NOT NULL AND sku<>'' AND style_number IS NOT NULL
               AND style_number <> '' LIMIT 40""")
rows=cur.fetchall()
print("SKU  ->  style_number  (does SKU start with style_number?)")
match=0
for r in rows:
    sku=r["sku"]; sn=(r["style_number"] or "").strip()
    starts = sku.startswith(sn) if sn else False
    if starts: match+=1
    print(f"   {sku:<18} sn={sn:<12} prod={r['product_name'][:40]}")
print(f"\n{match}/{len(rows)} SKUs start with their style_number")

# check the style number format distribution
cur.execute("""SELECT style_number FROM all_products_clean
               WHERE style_number IS NOT NULL AND style_number<>''""")
sns=[r["style_number"].strip() for r in cur.fetchall()]
patt=Counter()
for sn in sns:
    if re.match(r"^[A-Za-z]\d{7}$",sn): patt["L+7digits"]+=1
    elif re.match(r"^[A-Za-z]\d{6}$",sn): patt["L+6digits"]+=1
    elif re.match(r"^[A-Za-z]{2}\d+",sn): patt["2L+digits"]+=1
    else: patt["other"]+=1
print("\nStyle number format distribution:", dict(patt))

# does one style_number ever map to multiple style_names? (the constraint check)
cur.execute("""SELECT style_number, COUNT(DISTINCT style_name) nnames,
               array_agg(DISTINCT style_name) names
               FROM all_products_clean
               WHERE style_number IS NOT NULL AND style_number<>''
               AND style_name IS NOT NULL AND style_name<>''
               GROUP BY style_number HAVING COUNT(DISTINCT style_name)>1
               LIMIT 20""")
conflicts=cur.fetchall()
print(f"\nStyle numbers mapping to >1 style name (constraint violations): checking...")
for c in conflicts[:15]:
    print(f"   {c['style_number']}: {c['nnames']} names -> {c['names'][:3]}")
conn.close()
