"""Find all templates where my backfill may have mis-cut a VE number by
swallowing a colour-code letter (VE0034A from VE0034ALM...).
Compares stored style number to what the variant SKU actually implies."""
import os, re, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# all templates whose style number looks like VE + 4 digits + 1 letter (suspect)
ids=ex("product.template","search",[["x_style_number_text","like","VE%"]])
recs=ex("product.template","read",ids,fields=["id","name","x_style_number_text","product_variant_ids"])
print(f"Templates with VE-prefixed style number: {len(recs)}")

suspect=[]
for r in recs:
    sn=(r.get("x_style_number_text") or "").strip()
    # pattern VE + 4 digits + exactly 1 trailing letter = the buggy shape
    if re.match(r"^VE\d{4}[A-Za-z]$", sn):
        vids=r.get("product_variant_ids") or []
        vs=ex("product.product","read",vids[:1],fields=["default_code"]) if vids else []
        vsku=(vs[0].get("default_code") if vs else "") or ""
        # what does the SKU say? VE + 4 digits, then colour letters
        m=re.match(r"^(VE\d{4})([A-Za-z]{2,})", vsku)
        implied = m.group(1) if m else "?"
        suspect.append((r["id"],r["name"],sn,vsku,implied))

print(f"\nSUSPECT (VE+4digits+1letter, likely swallowed colour letter): {len(suspect)}")
for tid,nm,sn,vsku,imp in suspect[:40]:
    flag = "  <-- MISCUT" if imp!="?" and sn!=imp else ""
    print(f"   {sn:<10} (sku {vsku:<14} -> should be {imp}) {nm[:32]}{flag}")
if len(suspect)>40: print(f"   ...and {len(suspect)-40} more")

# group by corrected number to see collisions
from collections import defaultdict
byimp=defaultdict(list)
for tid,nm,sn,vsku,imp in suspect:
    if imp!="?": byimp[imp].append(nm)
print(f"\nDistinct corrected VE numbers: {len(byimp)}")
coll={k:v for k,v in byimp.items() if len(set(v))>1}
print(f"Corrected numbers with >1 distinct style (real collisions to check): {len(coll)}")
for k,v in list(coll.items())[:15]:
    print(f"   {k}: {sorted(set(v))}")
