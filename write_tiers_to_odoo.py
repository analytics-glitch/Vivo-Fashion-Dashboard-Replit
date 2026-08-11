"""
Write style Tier -> Odoo x_vivo_attr_99 (templates AND variants).

Source: tier_map.json  (list of {sn, nm, tier, opt})
  sn  = style number (as in sheet)
  nm  = style name
  tier= 'Tier 1'/'Tier 2'/'Tier 3'/'Tier 4'/'RETIRED'
  opt = Odoo option id for x_vivo_attr_99

Matching (robust, mirrors the retirement write-back): per style, try in order
  1. x_vivo_attr_18.name = sn           (dot-notation on the m2o)
  2. x_style_number_text = sn
  3. variant default_code LIKE 'sn%'    (via product.product)
  4. variant default_code LIKE '<sn without leading letter>%'
  5. product.template name =like 'nm%'  (name fallback)
Writes x_vivo_attr_99 = opt on the matched template(s) AND their variants.

DRY RUN by default. Set DRY = False to apply.
"""
import xmlrpc.client, os, json, sys, re

DRY = True   # <-- flip to False to write

url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

def ex(model, method, *args, **kw):
    return models.execute_kw(db, uid, pw, model, method, list(args), kw or {})

rows = json.load(open("/home/runner/workspace/tier_map.json", encoding="utf-8"))
print(f"Loaded {len(rows)} tier rows")

def tmpl_ids_for(sn, nm):
    """Return (set of template ids, how_matched)."""
    # 1. x_vivo_attr_18.name
    ids = ex("product.template","search",[["x_vivo_attr_18.name","=",sn]])
    if ids: return set(ids), "attr_18"
    # 2. x_style_number_text
    ids = ex("product.template","search",[["x_style_number_text","=",sn]])
    if ids: return set(ids), "style_text"
    # 3. variant default_code LIKE sn%
    v = ex("product.product","search_read",[["default_code","=like",sn+"%"]],
           fields=["product_tmpl_id"])
    if v:
        return set(x["product_tmpl_id"][0] for x in v), "default_code"
    # 4. numeric part (drop leading letter) default_code
    m = re.match(r"^[A-Za-z](\d.*)$", sn)
    if m:
        v = ex("product.product","search_read",[["default_code","=like",m.group(1)+"%"]],
               fields=["product_tmpl_id"])
        if v:
            return set(x["product_tmpl_id"][0] for x in v), "default_code_noletter"
    # 5. name fallback
    ids = ex("product.template","search",[["name","=like", nm+"%"]])
    if ids: return set(ids), "name"
    return set(), "UNMATCHED"

def variant_ids_for(tmpl_ids):
    if not tmpl_ids: return []
    return ex("product.product","search",[["product_tmpl_id","in",list(tmpl_ids)]])

from collections import Counter
match_stats=Counter()
unmatched=[]
plan=[]  # (opt, tmpl_ids, var_ids, sn, nm)

for i,r in enumerate(rows,1):
    sn,nm,opt = r["sn"], r["nm"], r["opt"]
    tids,how = tmpl_ids_for(sn,nm)
    match_stats[how]+=1
    if not tids:
        unmatched.append((sn,nm,r["tier"])); continue
    vids = variant_ids_for(tids)
    plan.append((opt, sorted(tids), vids, sn, nm))
    if i % 100 == 0:
        print(f"  ...{i}/{len(rows)} processed")

tot_t=sum(len(p[1]) for p in plan)
tot_v=sum(len(p[2]) for p in plan)
print(f"\nMatched {len(plan)}/{len(rows)} styles -> {tot_t} templates, {tot_v} variants")
print("Match method breakdown:", dict(match_stats))
print(f"UNMATCHED: {len(unmatched)}")
for sn,nm,t in unmatched[:40]:
    print(f"   [{t}] {sn}  {nm}")
if len(unmatched)>40:
    print(f"   ... and {len(unmatched)-40} more")

# write unmatched to a file for review
with open("/home/runner/workspace/tier_unmatched.csv","w",encoding="utf-8") as f:
    f.write("style_number,style_name,tier\n")
    for sn,nm,t in unmatched:
        f.write(f'"{sn}","{nm}","{t}"\n')

if DRY:
    print("\n=== DRY RUN — no writes. Set DRY=False to apply. ===")
else:
    print("\nApplying writes...")
    n=0
    for opt,tids,vids,sn,nm in plan:
        if tids:
            ex("product.template","write",tids,{"x_vivo_attr_99":opt})
        if vids:
            ex("product.product","write",vids,{"x_vivo_attr_99":opt})
        n+=1
        if n % 100 == 0:
            print(f"  wrote {n}/{len(plan)}")
    print(f"DONE — wrote tier to {len(plan)} styles ({tot_t} templates, {tot_v} variants)")
