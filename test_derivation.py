"""Test SKU->style_number derivation against products that ALREADY have a
style_number, to prove the rule reproduces the correct value before we write."""
import os, re, psycopg2, psycopg2.extras
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

def brand_letter(product_name):
    n=(product_name or "").strip().lower()
    if n.startswith("vivo"): return "V"
    if n.startswith("zoya"): return "Z"
    if n.startswith("safari"): return "S"
    return None

def derive_style_number(sku, product_name):
    if not sku: return None
    s=sku.strip()
    bl=brand_letter(product_name)
    # if SKU starts with a digit, prepend the brand letter
    if s and s[0].isdigit() and bl:
        s = bl + s
    # VE / essentials style: 2 letters + 4 digits + 1 letter (e.g. VE0056B)
    m = re.match(r"^([A-Za-z]{2}\d{4}[A-Za-z])", s)
    if m and s[:2].upper() in ("VE","SE","ZE"):
        return m.group(1)
    # standard: letter + 7 digits
    m = re.match(r"^([A-Za-z]\d{7})", s)
    if m: return m.group(1)
    # fallback letter + 6 digits
    m = re.match(r"^([A-Za-z]\d{6})", s)
    if m: return m.group(1)
    return None

def derive_style_name(product_name):
    return re.sub(r"\s*-\s*[^-]*$","",(product_name or "")).strip()

# test against known-good
cur.execute("""SELECT sku, style_number, product_name, style_name
    FROM all_products_clean
    WHERE sku IS NOT NULL AND sku<>'' AND style_number IS NOT NULL AND style_number<>''
      AND (LOWER(product_name) LIKE 'vivo%' OR LOWER(product_name) LIKE 'zoya%' OR LOWER(product_name) LIKE 'safari%')
    """)
rows=cur.fetchall()
ok=bad=0; examples=[]
for r in rows:
    d=derive_style_number(r["sku"], r["product_name"])
    if d==r["style_number"].strip(): ok+=1
    else:
        bad+=1
        if len(examples)<25: examples.append((r["sku"],r["style_number"],d,r["product_name"][:35]))
print(f"Style NUMBER derivation: {ok}/{ok+bad} correct ({100*ok//max(ok+bad,1)}%)")
print("Mismatches (sku / actual / derived / name):")
for sku,act,der,nm in examples:
    print(f"   {sku:<18} act={act:<10} der={str(der):<10} {nm}")
conn.close()
