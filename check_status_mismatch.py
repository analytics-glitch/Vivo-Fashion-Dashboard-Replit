"""Read-only: compare sheet Status vs Odoo x_vivo_attr_97. No pandas — reads tier_map.json."""
import xmlrpc.client, os, json, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

rows=json.load(open("/home/runner/workspace/tier_map.json",encoding="utf-8"))

def match_tmpls(sn,nm):
    ids=ex("product.template","search",[["x_vivo_attr_18.name","=",sn]])
    if ids: return ids
    ids=ex("product.template","search",[["x_style_number_text","=",sn]])
    if ids: return ids
    v=ex("product.product","search_read",[["default_code","=like",sn+"%"]],fields=["product_tmpl_id"])
    if v: return list({x["product_tmpl_id"][0] for x in v})
    m=re.match(r"^[A-Za-z](\d.*)$",sn)
    if m:
        v=ex("product.product","search_read",[["default_code","=like",m.group(1)+"%"]],fields=["product_tmpl_id"])
        if v: return list({x["product_tmpl_id"][0] for x in v})
    ids=ex("product.template","search",[["name","=like",nm+"%"]])
    return ids or []

active_but_retired=[]; retired_but_active=[]; checked=0
for r in rows:
    sheet_status=str(r["status"]).strip().lower()
    sn=r["sn"]; nm=r["nm"]
    tids=match_tmpls(sn,nm)
    if not tids: continue
    recs=ex("product.template","read",tids,fields=["x_vivo_attr_97"])
    st=set()
    for rec in recs:
        v=rec.get("x_vivo_attr_97")
        st.add(v[1] if isinstance(v,list) else None)
    odoo_retired=any((s or "").lower()=="retired" for s in st)
    odoo_active =any((s or "").lower()=="active"  for s in st)
    if sheet_status=="active" and odoo_retired:
        active_but_retired.append((sn,nm,r["tier"],sorted(str(x) for x in st)))
    if sheet_status=="retired" and odoo_active and not odoo_retired:
        retired_but_active.append((sn,nm,sorted(str(x) for x in st)))
    checked+=1
    if checked%200==0: print(f"  ...{checked} checked",flush=True)

print(f"\n=== SHEET=Active but ODOO=Retired: {len(active_but_retired)} ===",flush=True)
for sn,nm,tier,st in active_but_retired[:60]:
    print(f"   {sn}  {nm}  [{tier}]  odoo={st}")
if len(active_but_retired)>60: print(f"   ...and {len(active_but_retired)-60} more")
print(f"\n=== SHEET=Retired but ODOO=Active: {len(retired_but_active)} ===",flush=True)
for sn,nm,st in retired_but_active[:30]:
    print(f"   {sn}  {nm}  odoo={st}")
if len(retired_but_active)>30: print(f"   ...and {len(retired_but_active)-30} more")

with open("/home/runner/workspace/status_mismatch.csv","w",encoding="utf-8") as f:
    f.write("kind,style_number,style_name,sheet_tier,odoo_status\n")
    for sn,nm,tier,st in active_but_retired:
        f.write(f'"active_but_retired","{sn}","{nm}","{tier}","{st}"\n')
    for sn,nm,st in retired_but_active:
        f.write(f'"retired_but_active","{sn}","{nm}","","{st}"\n')
print("\nFull list -> status_mismatch.csv",flush=True)
