import os, re, psycopg2, psycopg2.extras
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

def brand_letter(pn):
    n=(pn or "").strip().lower()
    if n.startswith("vivo"): return "V"
    if n.startswith("zoya"): return "Z"
    if n.startswith("safari"): return "S"
    return None

def derive_style_number(sku, pn):
    if not sku: return None
    s=sku.strip()
    # SAF pattern first (SAF + 2 digits + 2 letters)
    m=re.match(r"^(SAF\d{2}[A-Za-z]{2})", s, re.I)
    if m: return m.group(1).upper()
    bl=brand_letter(pn)
    # strip a leading 'FS' sample marker if present before digits
    if s[:2].upper()=="FS" and len(s)>2 and s[2].isdigit():
        pass  # FS-prefixed = sample, skip (return None below unless valid after)
    # if SKU starts with a digit, prepend brand letter
    if s and s[0].isdigit() and bl:
        s = bl + s
    # VE / essentials: 2 letters + 4 digits + 1 letter (VE0056B)
    if s[:2].upper() in ("VE","SE","ZE"):
        m=re.match(r"^([A-Za-z]{2}\d{4}[A-Za-z])", s)
        if m: return m.group(1)
    # standard: letter + 7 digits
    m=re.match(r"^([A-Za-z]\d{7})", s)
    if m: return m.group(1)
    m=re.match(r"^([A-Za-z]\d{6})", s)
    if m: return m.group(1)
    return None

STYLE_RE=re.compile(r"^([A-Za-z]\d{6,7}|SAF\d{2}[A-Za-z]{2}|[A-Za-z]{2}\d{4}[A-Za-z])$")
def valid(n): return bool(n) and bool(STYLE_RE.match(n))

cur.execute("""SELECT sku, style_number, product_name FROM all_products_clean
    WHERE sku IS NOT NULL AND sku<>'' AND style_number IS NOT NULL AND style_number<>''
      AND (LOWER(product_name) LIKE 'vivo%' OR LOWER(product_name) LIKE 'zoya%' OR LOWER(product_name) LIKE 'safari%')""")
rows=cur.fetchall()
ok=bad=sample_recovered=0; examples=[]
for r in rows:
    d=derive_style_number(r["sku"], r["product_name"])
    act=r["style_number"].strip()
    if d==act: ok+=1
    elif act.lower().startswith("sample") and valid(d):
        sample_recovered+=1  # we derive a real number where stored was 'Sample bucket'
    else:
        bad+=1
        if len(examples)<20: examples.append((r["sku"],act,d,r["product_name"][:32]))
print(f"Correct: {ok}/{len(rows)} ({100*ok//len(rows)}%)")
print(f"Sample-bucket -> real number recovered: {sample_recovered}")
print(f"Genuine mismatches: {bad}")
for sku,act,der,nm in examples:
    print(f"   {sku:<18} act={act:<10} der={str(der):<10} {nm}")
conn.close()
