import os, re, psycopg2, psycopg2.extras
from collections import Counter, defaultdict
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# 1) CONSTRAINT: does any style_number map to >1 style_name?
cur.execute("""SELECT COUNT(*) AS violations FROM (
    SELECT style_number FROM all_products_clean
    WHERE style_number IS NOT NULL AND style_number<>''
      AND style_name IS NOT NULL AND style_name<>''
    GROUP BY style_number HAVING COUNT(DISTINCT style_name)>1
) t""")
print("Style numbers with >1 distinct style_name:", cur.fetchone()["violations"])

# show a few if any
cur.execute("""SELECT style_number, array_agg(DISTINCT style_name) names
    FROM all_products_clean
    WHERE style_number IS NOT NULL AND style_number<>''
      AND style_name IS NOT NULL AND style_name<>''
    GROUP BY style_number HAVING COUNT(DISTINCT style_name)>1 LIMIT 12""")
for r in cur.fetchall():
    print(f"   {r['style_number']}: {r['names']}")

# 2) Reverse constraint: does any style_NAME map to >1 style_number? (also matters)
cur.execute("""SELECT COUNT(*) AS v FROM (
    SELECT style_name FROM all_products_clean
    WHERE style_number IS NOT NULL AND style_number<>''
      AND style_name IS NOT NULL AND style_name<>''
    GROUP BY style_name HAVING COUNT(DISTINCT style_number)>1) t""")
print("\nStyle names with >1 distinct style_number:", cur.fetchone()["v"])

# 3) SKU prefix rule: how well does 'SKU starts with style_number' hold overall?
cur.execute("""SELECT sku, style_number FROM all_products_clean
    WHERE sku IS NOT NULL AND sku<>'' AND style_number IS NOT NULL AND style_number<>''""")
rows=cur.fetchall()
starts=sum(1 for r in rows if r["sku"].startswith(r["style_number"].strip()))
print(f"\nSKU starts with style_number: {starts}/{len(rows)} ({100*starts//max(len(rows),1)}%)")

# 4) For the ones that DON'T start-match, what's the pattern?
mismatch=[(r["sku"],r["style_number"]) for r in rows if not r["sku"].startswith(r["style_number"].strip())]
print(f"Mismatches: {len(mismatch)}")
for sku,sn in mismatch[:15]:
    print(f"   sku={sku:<18} sn={sn}")
conn.close()
