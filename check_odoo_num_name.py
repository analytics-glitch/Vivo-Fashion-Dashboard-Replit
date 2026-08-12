"""
Odoo check: does any style number map to >1 distinct style name?
Reads Finished Goods templates, groups by style number (x_style_number_text
or x_vivo_attr_18), collects distinct style names (x_studio_style_name_gi /
x_vivo_attr_16). Flags conflicts.
"""
import os, re, xmlrpc.client
from collections import defaultdict
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates...", flush=True)
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16"]
recs=[]
for i in range(0,len(tids),500):
    recs+=ex("product.template","read",tids[i:i+500],fields=FIELDS)

def snum(r): return ((r.get("x_style_number_text") or "").strip()) or (r["x_vivo_attr_18"][1] if r.get("x_vivo_attr_18") else "")
def sname(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][1]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][1]
    return ""

num_to_names=defaultdict(set)
for r in recs:
    n=snum(r); nm=sname(r)
    if n and nm and not n.lower().startswith("sample"):
        num_to_names[n].add(nm.strip())

conflicts={n:names for n,names in num_to_names.items() if len(names)>1}
print(f"\nStyle numbers with >1 distinct style name: {len(conflicts)}")
for n,names in sorted(conflicts.items())[:40]:
    print(f"   {n}: {sorted(names)}")
if len(conflicts)>40: print(f"   ...and {len(conflicts)-40} more")

# save full list
import csv
with open("/home/runner/workspace/odoo_num_name_conflicts.csv","w",encoding="utf-8",newline="") as f:
    w=csv.writer(f); w.writerow(["style_number","distinct_names"])
    for n,names in sorted(conflicts.items()):
        w.writerow([n," | ".join(sorted(names))])
print("\nFull list -> odoo_num_name_conflicts.csv")
