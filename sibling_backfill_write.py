"""
Sibling backfill WRITE-BACK, Vivo/Safari/Zoya only.
For FG templates missing style number, copy from a single valid sibling
(same base style name) its style number (-> x_style_number_text) and style
name (-> x_studio_style_name_gi m2o, copying the sibling's option ID).
Writes templates AND their variants. DRY by default.

Safety:
  - only VALID style numbers (Letter + 6-7 digits)
  - excludes placeholder base names
  - only when EXACTLY ONE sibling number exists (unambiguous)
  - name copied as the sibling's m2o id (not a string)
"""
import os, re, xmlrpc.client
from collections import defaultdict
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

DRY = True   # flip to False to write

STYLE_RE = re.compile(r"^[A-Za-z]\d{6,7}$")
def valid_num(n): return bool(n) and bool(STYLE_RE.match((n or "").strip()))
PLACEHOLDER_BASES = {
    "vivo knee length skirts","vivo jumpsuit","safari full length pants",
    "vivo full length pants","vivo shorts","vivo loose tops","vivo maxi dress",
    "vivo joggers","vivo wide-leg pants","vivo trench coat","vivo sleeveless blazer",
    "vivo long sleeve blazer","vivo knee length dress",
    "vivo bodysuits t- shirts & tank tops","vivo waterfalls & kimonos",
    "safari reversible shirt jacket","safari knee length dress",
    "safari mini dress","safari mini skirts","safari midi & capri skirts","safari jumpsuit",
}
def is_placeholder(base): return (base or "").strip().lower() in PLACEHOLDER_BASES
def base_of(nm): return re.sub(r"\s*-\s*[^-]+$","",(nm or "")).strip()
def brand_of(nm):
    nm=(nm or "").strip().lower()
    for b in ("vivo","safari","zoya"):
        if nm.startswith(b): return b
    return None

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates...", flush=True)
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16","product_variant_ids"]
recs=[]
for i in range(0,len(tids),500):
    recs+=ex("product.template","read",tids[i:i+500],fields=FIELDS)

def snum(r): return ((r.get("x_style_number_text") or "").strip()) or (r["x_vivo_attr_18"][1] if r.get("x_vivo_attr_18") else "")
def name_id(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][0]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][0]
    return None

# index: base -> set of valid numbers; base -> a representative name m2o id
base_nums=defaultdict(set); base_nameid={}
for r in recs:
    if not brand_of(r["name"]): continue
    b=base_of(r["name"]).lower()
    if is_placeholder(b): continue
    n=snum(r)
    if valid_num(n):
        base_nums[b].add(n.strip())
        nid=name_id(r)
        if nid and b not in base_nameid: base_nameid[b]=nid

plan=[]
for r in recs:
    if not brand_of(r["name"]): continue
    if snum(r): continue
    b=base_of(r["name"]).lower()
    if is_placeholder(b): continue
    nums=base_nums.get(b,set())
    if len(nums)==1:
        num=next(iter(nums))
        nid=base_nameid.get(b)
        plan.append((r["id"], r["name"], num, nid, r.get("product_variant_ids") or []))

print(f"Recoverable to write: {len(plan)}", flush=True)
for tid,nm,num,nid,vids in plan[:15]:
    print(f"   {nm[:45]:<45} -> num={num} name_id={nid} ({len(vids)}v)")

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply. ===")
else:
    print("\nWriting...", flush=True)
    n=0
    for tid,nm,num,nid,vids in plan:
        vals={"x_style_number_text":num}
        if nid: vals["x_studio_style_name_gi"]=nid
        ex("product.template","write",[tid],vals)
        if vids: ex("product.product","write",vids,vals)
        n+=1
        if n%100==0: print(f"  wrote {n}/{len(plan)}", flush=True)
    print(f"DONE — backfilled {len(plan)} styles.")
