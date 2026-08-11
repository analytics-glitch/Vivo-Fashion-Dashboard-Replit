"""
Write style Tier (x_vivo_attr_99) AND Status (x_vivo_attr_97) to Odoo
from the sheet (via tier_map.json), on templates AND variants.

tier_map.json rows: {sn, nm, tier, opt(tier), status, sopt(status)}
  opt : tier option id  (60009 NOOS / 60010 Core / 60011 Recent / 60012 New / 61038 Retired)
  sopt: status option id (59958 Active / 59959 Retired)

Matching (same as retirement/tier work): x_vivo_attr_18.name -> x_style_number_text
  -> variant default_code LIKE sn% -> default_code LIKE <sn w/o leading letter>%
  -> product.template name =like nm%.

DRY = False  -> no writes (default). Set False to apply.
TEST_ONLY   -> if non-empty set of style numbers, only those are processed.
"""
import xmlrpc.client, os, json, re, sys

DRY = False
TEST_ONLY = {"V0822077","V0725043","V0126025"}

url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

rows=json.load(open("/home/runner/workspace/tier_map.json",encoding="utf-8"))
if TEST_ONLY:
    rows=[r for r in rows if r["sn"] in TEST_ONLY]

def match(sn,nm):
    ids=ex("product.template","search",[["x_vivo_attr_18.name","=",sn]])
    if ids: return ids,"attr_18"
    ids=ex("product.template","search",[["x_style_number_text","=",sn]])
    if ids: return ids,"style_text"
    v=ex("product.product","search_read",[["default_code","=like",sn+"%"]],fields=["product_tmpl_id"])
    if v: return list({x["product_tmpl_id"][0] for x in v}),"default_code"
    m=re.match(r"^[A-Za-z](\d.*)$",sn)
    if m:
        v=ex("product.product","search_read",[["default_code","=like",m.group(1)+"%"]],fields=["product_tmpl_id"])
        if v: return list({x["product_tmpl_id"][0] for x in v}),"default_code_noletter"
    ids=ex("product.template","search",[["name","=like",nm+"%"]])
    if ids: return ids,"name"
    return [],"UNMATCHED"

from collections import Counter
stats=Counter(); unmatched=[]; plan=[]
tot_t=tot_v=0
for i,r in enumerate(rows,1):
    sn,nm=r["sn"],r["nm"]
    topt,sopt=r["opt"],r["sopt"]
    tids,how=match(sn,nm)
    stats[how]+=1
    if not tids:
        unmatched.append((sn,nm,r["tier"],r["status"])); continue
    vids=ex("product.product","search",[["product_tmpl_id","in",tids]])
    # build the vals dict — only include fields we have an option for
    vals={}
    if topt is not None: vals["x_vivo_attr_99"]=topt
    if sopt is not None: vals["x_vivo_attr_97"]=sopt
    plan.append((tids,vids,vals,sn,nm,r["tier"],r["status"]))
    tot_t+=len(tids); tot_v+=len(vids)
    if i%100==0: print(f"  ...{i}/{len(rows)} matched",flush=True)

print(f"\nMatched {len(plan)}/{len(rows)} -> {tot_t} templates, {tot_v} variants")
print("Methods:",dict(stats))
print(f"UNMATCHED: {len(unmatched)}")
for sn,nm,t,s in unmatched[:30]:
    print(f"   {sn} {nm} [{t}/{s}]")

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply. ===")
    # show a few sample plans
    for tids,vids,vals,sn,nm,t,s in plan[:5]:
        print(f"   {sn} {nm}: tier={t} status={s} vals={vals} ({len(tids)}t/{len(vids)}v)")
else:
    print("\nApplying Tier + Status writes...",flush=True)
    n=0
    for tids,vids,vals,sn,nm,t,s in plan:
        ex("product.template","write",tids,vals)
        if vids: ex("product.product","write",vids,vals)
        n+=1
        if n%100==0: print(f"  wrote {n}/{len(plan)}",flush=True)
    print(f"DONE — wrote {len(plan)} styles ({tot_t} templates, {tot_v} variants)")
