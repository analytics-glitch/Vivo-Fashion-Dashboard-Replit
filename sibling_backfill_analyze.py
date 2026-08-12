"""
Sibling backfill (read-only analysis), Vivo/Safari/Zoya only.
For FG templates missing style number/name, find a sibling template
(same base style name = name minus trailing ' - <colour>') that HAS a
style number, and propose copying it. Flags ambiguous (siblings disagree)
and orphaned (no sibling with data) cases.
"""
import os, re, xmlrpc.client
from collections import defaultdict, Counter
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates...")
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16"]
# read in chunks to avoid size limits
recs=[]
for i in range(0,len(tids),500):
    recs+=ex("product.template","read",tids[i:i+500],fields=FIELDS)

def brand_of(nm):
    nm=(nm or "").strip().lower()
    for b in ("vivo","safari","zoya"):
        if nm.startswith(b): return b.capitalize()
    return "Other"
def snum(r): return ((r.get("x_style_number_text") or "").strip()) or (r["x_vivo_attr_18"][1] if r.get("x_vivo_attr_18") else "")
def sname(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][1]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][1]
    return ""
STYLE_RE = re.compile(r"^[A-Za-z]\d{6,7}$")
def valid_num(n):
    return bool(n) and bool(STYLE_RE.match(n.strip()))

# generic placeholder base names that are NOT real styles (category buckets)
PLACEHOLDER_BASES = {
    "vivo knee length skirts","vivo jumpsuit","safari full length pants",
    "vivo full length pants","vivo shorts","vivo loose tops","vivo maxi dress",
    "vivo joggers","vivo wide-leg pants","vivo trench coat","vivo sleeveless blazer",
    "vivo long sleeve blazer","vivo knee length dress","vivo knee length skirts",
    "vivo bodysuits t- shirts & tank tops","vivo waterfalls & kimonos","safari reversible shirt jacket",
}
def is_placeholder(base): return base.strip().lower() in PLACEHOLDER_BASES

def base_of(nm):
    return re.sub(r"\s*-\s*[^-]+$","",(nm or "")).strip()

# index style number by base name (from products that HAVE a number), Vivo/Safari/Zoya only
base_to_nums=defaultdict(set); base_to_names=defaultdict(set)
for r in recs:
    if brand_of(r["name"])=="Other": continue
    n=snum(r)
    b_=base_of(r["name"]).lower()
    if valid_num(n) and not is_placeholder(b_):
        base_to_nums[b_].add(n.strip())
        nm=sname(r)
        if nm: base_to_names[b_].add(nm)

# now classify the MISSING ones
recoverable=[]; ambiguous=[]; orphaned=[]
for r in recs:
    b=brand_of(r["name"])
    if b=="Other": continue
    if snum(r): continue  # not missing
    base=base_of(r["name"]).lower()
    if is_placeholder(base):
        orphaned.append((b,r["name"])); continue
    cand=base_to_nums.get(base,set())
    if len(cand)==1:
        num=next(iter(cand))
        names=base_to_names.get(base,set())
        recoverable.append((r["id"],r["name"],num,(next(iter(names)) if len(names)==1 else "")))
    elif len(cand)>1:
        ambiguous.append((r["name"],sorted(cand)))
    else:
        orphaned.append((b,r["name"]))

print(f"\n=== Vivo/Safari/Zoya missing-number recovery ===")
print(f"  RECOVERABLE from a single sibling : {len(recoverable)}")
print(f"  AMBIGUOUS (siblings disagree)      : {len(ambiguous)}")
print(f"  ORPHANED (no sibling with number)  : {len(orphaned)}")
print(f"\n--- recoverable examples ---")
for tid,nm,num,snm in recoverable[:20]:
    print(f"   {nm[:45]:<45} -> {num}  ({snm})")
print(f"\n--- ambiguous examples ---")
for nm,nums in ambiguous[:15]:
    print(f"   {nm[:45]:<45} -> {nums}")
print(f"\n--- orphaned examples ---")
for b,nm in orphaned[:20]:
    print(f"   [{b}] {nm}")

# save
import csv
with open("/home/runner/workspace/sibling_backfill_plan.csv","w",encoding="utf-8",newline="") as f:
    w=csv.writer(f); w.writerow(["kind","template_id","product_name","proposed_number","proposed_name_or_alts"])
    for tid,nm,num,snm in recoverable: w.writerow(["recoverable",tid,nm,num,snm])
    for nm,nums in ambiguous: w.writerow(["ambiguous","",nm,"","|".join(nums)])
    for b,nm in orphaned: w.writerow(["orphaned","",nm,"",""])
print("\nFull plan -> sibling_backfill_plan.csv")
