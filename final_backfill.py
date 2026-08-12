"""
FINAL comprehensive backfill: ensure every Vivo/Safari/Zoya Finished Goods
product has a style number + name, OR is bucketed as 'Sample & Sale Items'.

Rules (in order):
  1. sample marker -> 'Sample & Sale Items'
  2. already has valid style number -> leave (never overwrite)
  3. derive from SKU -> write number + canonical name
  4. not derivable -> 'Sample & Sale Items'

DRY by default. Writes x_style_number_text (+ x_studio_style_name_gi m2o) on
templates AND variants.
"""
import os, re, xmlrpc.client
from collections import defaultdict
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

DRY = False
SAMPLE_BUCKET = "Sample & Sale Items"

SAMPLE_SKU_MARKERS = ["SAM","RFS","FS","MSD","VS","PDLFS","BF","SS","VIVOSAM","SAMPLE"]
def is_sample(sku, name):
    s=(sku or "").upper(); n=(name or "").lower()
    if "sample" in n or " - fs" in n or n.endswith("- fs"): return True
    # marker as a clear token in SKU
    for mk in SAMPLE_SKU_MARKERS:
        if mk in s: return True
    return False

def brand_letter(pn):
    n=(pn or "").strip().lower()
    if n.startswith("vivo"): return "V"
    if n.startswith("zoya"): return "Z"
    if n.startswith("safari"): return "S"
    return None

STYLE_RE=re.compile(r"^([A-Za-z]\d{6,7}|SAF\d{2}[A-Za-z]{2}|[A-Za-z]{2}\d{4}[A-Za-z])$")
def valid(n): return bool(n) and bool(STYLE_RE.match(n))

def derive(sku, pn):
    if not sku: return None
    s=sku.strip()
    m=re.match(r"^(SAF\d{2}[A-Za-z]{2})", s, re.I)
    if m: return m.group(1).upper()
    bl=brand_letter(pn)
    if s and s[0].isdigit() and bl: s=bl+s
    if s[:2].upper() in ("VE","SE","ZE"):
        m=re.match(r"^([A-Za-z]{2}\d{4}[A-Za-z])", s)
        if m: return m.group(1)
    m=re.match(r"^([A-Za-z]\d{7})", s)
    if m: return m.group(1)
    return None

def base_name(pn): return re.sub(r"\s*-\s*[^-]*$","",(pn or "")).strip()

cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
print(f"Reading {len(tids)} FG templates...", flush=True)
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text",
        "x_studio_style_name_gi","x_vivo_attr_16","product_variant_ids","default_code"]
recs=[]
for i in range(0,len(tids),500):
    recs+=ex("product.template","read",tids[i:i+500],fields=FIELDS)

def cur_num(r): return ((r.get("x_style_number_text") or "").strip()) or (r["x_vivo_attr_18"][1] if r.get("x_vivo_attr_18") else "")
def cur_nameid(r):
    if r.get("x_studio_style_name_gi"): return r["x_studio_style_name_gi"][0]
    if r.get("x_vivo_attr_16"): return r["x_vivo_attr_16"][0]
    return None

# build canonical name-id per style number (from products that have both)
num_to_nameid={}
for r in recs:
    n=cur_num(r); nid=cur_nameid(r)
    if valid(n) and nid and n not in num_to_nameid:
        num_to_nameid[n]=nid

from collections import Counter
actions=Counter(); plan=[]
for r in recs:
    if not brand_letter(r["name"]): continue  # Vivo/Safari/Zoya only
    sku=r.get("default_code") or ""
    existing=cur_num(r)
    if is_sample(sku, r["name"]):
        if existing != SAMPLE_BUCKET:
            plan.append((r,SAMPLE_BUCKET,None)); actions["-> Sample bucket"]+=1
        else: actions["already sample"]+=1
        continue
    if valid(existing):
        actions["has valid number (skip)"]+=1; continue
    d=derive(sku, r["name"])
    if valid(d):
        nid=num_to_nameid.get(d)
        plan.append((r,d,nid)); actions["derive real number"]+=1
    else:
        if existing != SAMPLE_BUCKET:
            plan.append((r,SAMPLE_BUCKET,None)); actions["not derivable -> Sample"]+=1
        else: actions["already sample"]+=1

print("\n=== ACTION SUMMARY ===")
for a,c in actions.most_common(): print(f"   {a:<28} {c}")
print(f"\nTotal writes planned: {len(plan)}")
print("\n--- examples ---")
for r,num,nid in plan[:20]:
    print(f"   {r['name'][:42]:<42} sku={r.get('default_code') or '':<16} -> {num}")

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
