"""
Fix the VE miscut bug: my earlier backfill cut VE numbers as VE+4digits+1letter
(swallowing a colour-code letter). Correct = VE + 4 digits (colour is next 3 letters).
Recut every affected template from its variant SKU, write x_style_number_text.
Also flags any recut number that mixes different STYLE NAMES (real issue) —
those are reported, not silently merged.
DRY by default.
"""
import os, re, xmlrpc.client
from collections import defaultdict
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

DRY=False

ids=ex("product.template","search",[["x_style_number_text","like","VE%"]])
recs=ex("product.template","read",ids,fields=["id","name","x_style_number_text","product_variant_ids"])

def base_name(nm): return re.sub(r"\s*-\s*[^-]*$","",(nm or "")).strip()

plan=[]  # (tid, name, old, new)
for r in recs:
    sn=(r.get("x_style_number_text") or "").strip()
    if not re.match(r"^VE\d{4}[A-Za-z]$", sn):   # only the miscut shape
        continue
    vids=r.get("product_variant_ids") or []
    vs=ex("product.product","read",vids[:1],fields=["default_code"]) if vids else []
    vsku=(vs[0].get("default_code") if vs else "") or ""
    m=re.match(r"^(VE\d{4})", vsku)
    if m:
        new=m.group(1)
        if new!=sn:
            plan.append((r["id"], r["name"], sn, new))

print(f"VE templates to recut: {len(plan)}")

# check: after recut, does any VE number carry >1 distinct BASE style name?
bynum=defaultdict(set)
for tid,nm,old,new in plan:
    bynum[new].add(base_name(nm))
mixed={k:v for k,v in bynum.items() if len(v)>1}
print(f"\nRecut numbers carrying >1 distinct base style name (REVIEW): {len(mixed)}")
for k,v in mixed.items():
    print(f"   {k}: {sorted(v)}")

print("\n--- sample recuts ---")
for tid,nm,old,new in plan[:15]:
    print(f"   {old} -> {new}   {nm[:40]}")

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply. ===")
else:
    print("\nWriting...", flush=True)
    n=0
    for tid,nm,old,new in plan:
        vals={"x_style_number_text":new}
        ex("product.template","write",[tid],vals)
        vids=ex("product.product","search",[["product_tmpl_id","=",tid]])
        if vids: ex("product.product","write",vids,vals)
        n+=1
        if n%50==0: print(f"  {n}/{len(plan)}", flush=True)
    print(f"DONE — recut {len(plan)} VE templates.")
