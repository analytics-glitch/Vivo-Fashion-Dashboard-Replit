"""
Odoo check: products in category '2. Finished Goods', brands Vivo/Safari/Zoya,
that are MISSING style name and/or style number.
Style number fields: x_vivo_attr_18 (m2o) OR x_style_number_text (char)
Style name fields:    x_studio_style_name_gi (m2o) OR x_vivo_attr_16 (m2o)
"""
import xmlrpc.client, os
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# 1) find the category id(s) matching '2. Finished Goods'
cats=ex("product.category","search_read",[["name","ilike","Finished Goods"]],fields=["id","name","complete_name"])
print("Matching categories:")
for c in cats: print(f"   id={c['id']}  name={c['name']!r}  full={c.get('complete_name')!r}")
cat_ids=[c["id"] for c in cats]
if not cat_ids:
    print("!! No 'Finished Goods' category found — check the name."); raise SystemExit

# 2) pull templates in those categories
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16","categ_id"]
tids=ex("product.template","search",[["categ_id","in",cat_ids]])
print(f"\nTemplates in Finished Goods: {len(tids)}")
recs=ex("product.template","read",tids,fields=FIELDS) if tids else []

def has_num(r):
    return bool((r.get("x_style_number_text") or "").strip()) or bool(r.get("x_vivo_attr_18"))
def has_name(r):
    return bool(r.get("x_studio_style_name_gi")) or bool(r.get("x_vivo_attr_16"))
def brand_of(r):
    nm=(r.get("name") or "")
    for b in ("Vivo","Safari","Zoya"):
        if nm.strip().lower().startswith(b.lower()): return b
    return "Other"

# 3) filter to Vivo/Safari/Zoya, count missing
miss_num=[]; miss_name=[]; miss_both=[]
brand_counts={"Vivo":0,"Safari":0,"Zoya":0,"Other":0}
for r in recs:
    b=brand_of(r); brand_counts[b]+=1
    if b=="Other": continue
    hn=has_num(r); ha=has_name(r)
    if not hn and not ha: miss_both.append((b,r["name"]))
    elif not hn: miss_num.append((b,r["name"]))
    elif not ha: miss_name.append((b,r["name"]))

print(f"\nBrand spread (by name prefix): {brand_counts}")
print(f"\n(Vivo/Safari/Zoya only)")
print(f"  Missing BOTH name & number : {len(miss_both)}")
print(f"  Missing style NUMBER only  : {len(miss_num)}")
print(f"  Missing style NAME only    : {len(miss_name)}")

def show(lbl,lst):
    print(f"\n--- {lbl} ({len(lst)}) ---")
    for b,nm in lst[:40]:
        print(f"   [{b}] {nm}")
    if len(lst)>40: print(f"   ...and {len(lst)-40} more")
show("Missing BOTH", miss_both)
show("Missing NUMBER only", miss_num)
show("Missing NAME only", miss_name)

# write full CSV
with open("/home/runner/workspace/missing_style_fields.csv","w",encoding="utf-8") as f:
    f.write("brand,missing,product_name\n")
    for b,nm in miss_both: f.write(f'"{b}","both","{nm}"\n')
    for b,nm in miss_num:  f.write(f'"{b}","number","{nm}"\n')
    for b,nm in miss_name: f.write(f'"{b}","name","{nm}"\n')
print("\nFull list -> missing_style_fields.csv")
