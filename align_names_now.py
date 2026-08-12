"""
Regenerate num->name conflicts from CURRENT Odoo state (post VE recut),
then align each conflicted number's templates to a canonical name
(longest/most-specific), for Vivo/Safari/Zoya only.

Splits: cosmetic+variant -> auto-align (write). genuine-different -> worklist only.
Writes x_studio_style_name_gi (m2o) to the canonical option id where available,
and always the char-style name is left to Odoo's m2o (we set the m2o id).
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
VSZ=("vivo","safari","zoya")

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates (current state)...", flush=True)
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
def name_id(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][0]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][0]
    return None
def in_scope(nm): return (nm or "").strip().lower().startswith(VSZ)

NOISE={"in","the","basic","everyday","eveyday","cotton","jersey","linen","rib","crepe",
 "kitenge","ponte","satin","chiffon","rayon","textured","stretch","twill","blend","mg","sd",
 "double","layered","by","vivo","safari","zoya"}
def core(nm):
    x=re.sub(r"\(.*?\)"," ",nm.lower()); x=re.sub(r"[^a-z0-9/ ]"," ",x)
    fix={"sleeved":"sleeve","bodysuit":"body","suit":"body","turtleneck":"turtle","soulder":"shoulder"}
    return set(fix.get(t,t) for t in x.split() if t and t not in NOISE)
def same_style(names):
    cs=[core(n) for n in names]; base=cs[0]
    for c in cs[1:]:
        a,b=(base,c) if len(base)<=len(c) else (c,base)
        if not a.issubset(b): return False
    return True

# group templates by number (in scope, non-sample, valid-ish)
by=defaultdict(list)
for r in recs:
    n=snum(r); nm=r["name"]
    if not in_scope(nm): continue
    if not n or n.lower().startswith("sample"): continue
    by[n].append(r)

conflicts={n:rs for n,rs in by.items() if len({sname(r) for r in rs if sname(r)})>1}
align=[]; worklist=[]
for n,rs in conflicts.items():
    names=sorted({sname(r) for r in rs if sname(r)})
    if n == "VE0034":   # cross-brand (Safari vs Vivo Shorts) — user fixes manually
        worklist.append((n,names)); continue
    if same_style(names):
        # canonical = the record whose style name is longest
        best=max((r for r in rs if sname(r)), key=lambda r:(len(sname(r)),sname(r)))
        cid=name_id(best); cname=sname(best)
        targets=[r["id"] for r in rs if name_id(r)!=cid]
        if cid and targets: align.append((n,cname,cid,targets))
    else:
        worklist.append((n,names))

print(f"\nConflicted numbers: {len(conflicts)}")
print(f"  auto-align (same style): {len(align)}  templates={sum(len(t) for _,_,_,t in align)}")
print(f"  worklist (genuine diff): {len(worklist)}")
print("\n--- worklist ---")
for n,names in worklist: print(f"   {n}: {names}")
print("\n--- align samples ---")
for n,cname,cid,targets in align[:15]:
    print(f"   {n} -> '{cname}' (id {cid}) on {len(targets)} templates")

import csv
with open("/home/runner/workspace/name_worklist_final.csv","w",encoding="utf-8",newline="") as f:
    w=csv.writer(f); w.writerow(["style_number","names"])
    for n,names in worklist: w.writerow([n," | ".join(names)])

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply alignment. ===")
else:
    print("\nAligning...", flush=True)
    k=0
    for n,cname,cid,targets in align:
        ex("product.template","write",targets,{"x_studio_style_name_gi":cid})
        # also variants
        vids=ex("product.product","search",[["product_tmpl_id","in",targets]])
        if vids: ex("product.product","write",vids,{"x_studio_style_name_gi":cid})
        k+=1
        if k%25==0: print(f"  {k}/{len(align)}", flush=True)
    print(f"DONE — aligned {len(align)} numbers. Worklist: name_worklist_final.csv")
