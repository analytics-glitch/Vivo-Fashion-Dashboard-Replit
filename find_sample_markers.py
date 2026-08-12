import os, re, psycopg2, psycopg2.extras
from collections import Counter
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# products currently in the 'Sample & Sale Items' bucket — what markers appear in their SKU/name?
cur.execute("""SELECT sku, product_name FROM all_products_clean
    WHERE style_number ILIKE 'Sample%' LIMIT 500""")
rows=cur.fetchall()
print(f"'Sample & Sale Items' products sampled: {len(rows)}")
markers=Counter()
for r in rows:
    sku=(r["sku"] or "").upper(); nm=(r["product_name"] or "").upper()
    for mk in ["SAMPLE","FS","RFS","MD","MSD","VS","SALE","- FS","SAMPLE "]:
        if mk in sku or mk in nm: markers[mk]+=1
print("Marker frequency in sample bucket:")
for m,c in markers.most_common(): print(f"   {m:<10} {c}")
print("\nSample SKU prefixes (first chars):")
pre=Counter()
for r in rows:
    sku=(r["sku"] or "")
    m=re.match(r"^([A-Za-z]+)", sku)
    if m: pre[m.group(1).upper()]+=1
for p,c in pre.most_common(12): print(f"   {p:<8} {c}")
print("\nExamples:")
for r in rows[:20]:
    print(f"   sku={r['sku']:<18} {r['product_name'][:45]}")
conn.close()
