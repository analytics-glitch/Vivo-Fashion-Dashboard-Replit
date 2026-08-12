"""Find templates just set to 'Sample & Sale Items' that are likely REAL styles
(blank template SKU but variants have a valid SKU, or a false FS/SS/BF match)."""
import os, re, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# templates whose style number text is now the sample bucket
tids=ex("product.template","search",[["x_style_number_text","=","Sample & Sale Items"]])
print(f"Templates currently = 'Sample & Sale Items': {len(tids)}")
recs=ex("product.template","read",tids,fields=["id","name","default_code","product_variant_ids"])

def brand(pn):
    n=(pn or "").lower()
    return n.startswith(("vivo","zoya","safari"))

# check how many have variants with a REAL sku (meaning they're likely real styles)
suspect=[]
for r in recs[:800]:
    vids=r.get("product_variant_ids") or []
    if not vids: continue
    vs=ex("product.product","read",vids,fields=["default_code"])
    for v in vs:
        dc=(v.get("default_code") or "")
        # a real style sku: starts with letter+digits or digits, and no obvious SAM
        if dc and "SAM" not in dc.upper() and re.match(r"^[A-Za-z]?\d{6,7}", dc):
            suspect.append((r["name"], dc)); break
print(f"\nLikely REAL styles wrongly bucketed (variant has real SKU, no SAM): {len(suspect)}")
for nm,dc in suspect[:30]:
    print(f"   {nm[:45]:<45} variant_sku={dc}")
