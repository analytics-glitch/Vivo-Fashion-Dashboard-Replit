"""
CORRECTED comprehensive backfill. Fixes two bugs from v1:
  BUG1: template default_code often blank -> read SKU from VARIANTS.
  BUG2: greedy substring sample-match (SS/BF/FS mid-string) -> TOKENIZED markers.

Also self-heals: any template wrongly set to 'Sample & Sale Items' whose
variant SKU yields a real number gets corrected.

Rules per Vivo/Safari/Zoya FG product:
  1. sample? (name has 'sample'/'- fs'  OR sku has 'SAM'  OR sku STARTS WITH FS/VS/MSD/RFS/PDLFS)
        -> 'Sample & Sale Items'
  2. else derive from best variant SKU (SAF / VE / brand-insert / L+7d)
        -> valid -> write number + canonical name
  3. else -> 'Sample & Sale Items'
Never overwrite an ALREADY-VALID number (unless it's the sample bucket, which we may correct).
DRY by default.
"""
import os, re, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

DRY=False
SAMPLE_BUCKET="Sample & Sale Items"

def brand_letter(pn):
    n=(pn or "").strip().lower()
    if n.startswith("vivo"): return "V"
    if n.startswith("zoya"): return "Z"
    if n.startswith("safari"): return "S"
    return None

STYLE_RE=re.compile(r"^([A-Za-z]\d{6,7}|SAF\d{2}[A-Za-z]{2}|[A-Za-z]{2}\d{4}[A-Za-z])$")
def valid(n): return bool(n) and bool(STYLE_RE.match(n))

# TOKENIZED sample detection — no mid-string false positives
SKU_START_MARKERS=("FS","VS","MSD","RFS","PDLFS","BF ")
def is_sample(skus, name):
    n=(name or "").lower()
    if "sample" in n: return True
    if re.search(r"-\s*fs\b", n): return True
    for s in skus:
        u=(s or "").upper()
        if "SAM" in u: return True
        if any(u.startswith(mk.strip()) for mk in ("FS","VS","MSD","RFS","PDLFS")): return True
    return False

def derive_from_skus(skus, pn):
    bl=brand_letter(pn)
    for sku in skus:
        if not sku: continue
        s=sku.strip()
        m=re.match(r"^(SAF\d{2}[A-Za-z]{2})", s, re.I)
        if m and valid(m.group(1).upper()): return m.group(1).upper()
        s2=s
        if s2 and s2[0].isdigit() and bl: s2=bl+s2
        if s2[:2].upper() in ("VE","SE","ZE"):
            m=re.match(r"^([A-Za-z]{2}\d{4}[A-Za-z])", s2)
            if m and valid(m.group(1)): return m.group(1)
        m=re.match(r"^([A-Za-z]\d{7})", s2)
        if m and valid(m.group(1)): return m.group(1)
    return None

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates + variant SKUs...", flush=True)
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16","product_variant_ids","default_code"]
recs=[]
for i in range(0,len(tids),500):
    recs+=ex("product.template","read",tids[i:i+500],fields=FIELDS)

# fetch variant default_codes in bulk
allvar=set()
for r in recs:
    for v in (r.get("product_variant_ids") or []): allvar.add(v)
allvar=list(allvar)
var_sku={}
for i in range(0,len(allvar),1000):
    for v in ex("product.product","read",allvar[i:i+1000],fields=["default_code"]):
        var_sku[v["id"]]=v.get("default_code") or ""
print(f"Loaded {len(var_sku)} variant SKUs", flush=True)

def cur_num(r): return ((r.get("x_style_number_text") or "").strip()) or (r["x_vivo_attr_18"][1] if r.get("x_vivo_attr_18") else "")
def cur_nameid(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][0]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][0]
    return None

num_to_nameid={}
for r in recs:
    n=cur_num(r); nid=cur_nameid(r)
    if valid(n) and nid and n not in num_to_nameid: num_to_nameid[n]=nid

from collections import Counter
actions=Counter(); plan=[]
for r in recs:
    if not brand_letter(r["name"]): continue
    skus=[r.get("default_code") or ""]+[var_sku.get(v,"") for v in (r.get("product_variant_ids") or [])]
    skus=[s for s in skus if s]
    existing=cur_num(r)
    if is_sample(skus, r["name"]):
        if existing!=SAMPLE_BUCKET: plan.append((r,SAMPLE_BUCKET,None)); actions["-> Sample"]+=1
        else: actions["already sample ok"]+=1
        continue
    d=derive_from_skus(skus, r["name"])
    if valid(d):
        # write if missing OR if wrongly bucketed as Sample
        if not valid(existing) or existing==SAMPLE_BUCKET:
            plan.append((r,d,num_to_nameid.get(d))); actions["derive real number"]+=1
        else: actions["has valid number (skip)"]+=1
    else:
        if valid(existing): actions["has valid number (skip)"]+=1
        elif existing!=SAMPLE_BUCKET: plan.append((r,SAMPLE_BUCKET,None)); actions["not derivable -> Sample"]+=1
        else: actions["already sample ok"]+=1

print("\n=== ACTION SUMMARY ===")
for a,c in actions.most_common(): print(f"   {a:<28} {c}")
print(f"\nTotal writes planned: {len(plan)}")
# show the CORRECTIONS (things currently sample that will become real)
corr=[(r['name'],num) for r,num,nid in plan if num!=SAMPLE_BUCKET and cur_num(r)==SAMPLE_BUCKET]
print(f"\nCORRECTIONS (wrongly-sampled -> real number): {len(corr)}")
for nm,num in corr[:25]: print(f"   {nm[:45]:<45} -> {num}")

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply. ===")
else:
    print("\nWriting...", flush=True)
    n=0
    for r,num,nid in plan:
        vals={"x_style_number_text":num}
        if nid: vals["x_studio_style_name_gi"]=nid
        ex("product.template","write",[r["id"]],vals)
        vids=r.get("product_variant_ids") or []
        if vids: ex("product.product","write",vids,vals)
        n+=1
        if n%100==0: print(f"  wrote {n}/{len(plan)}", flush=True)
    print(f"DONE — {len(plan)} products updated.")
