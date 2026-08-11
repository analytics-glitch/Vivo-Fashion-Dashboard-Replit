"""
TEST APPLY: write x_vivo_attr_99 for just a few styles, to verify in Odoo UI
before the full run. Uses same matching as write_tiers_to_odoo.py.
"""
import xmlrpc.client, os, json, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# Pick 3 test styles across different tiers (edit here if you want others)
TEST_SNS = {"V0822077",  # Tier 2 -> Core Performer 60010
            "V0725043",  # Tier 3 -> Recent Performer 60011
            "V0126025"}  # Tier 4 -> New 60012

rows=json.load(open("/home/runner/workspace/tier_map.json",encoding="utf-8"))
sub=[r for r in rows if r["sn"] in TEST_SNS]

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

DRY=False  # flip to False to write the test styles

for r in sub:
    tids,how=match(r["sn"],r["nm"])
    vids=ex("product.product","search",[["product_tmpl_id","in",tids]]) if tids else []
    print(f"{r['sn']} '{r['nm']}' {r['tier']}->opt {r['opt']} [{how}] : {len(tids)} tmpl, {len(vids)} var")
    if not DRY and tids:
        ex("product.template","write",tids,{"x_vivo_attr_99":r["opt"]})
        if vids: ex("product.product","write",vids,{"x_vivo_attr_99":r["opt"]})
        # read back one template to confirm
        chk=ex("product.template","read",[tids[0]],fields=["name","x_vivo_attr_99"])
        print(f"   WROTE. readback: {chk[0]['x_vivo_attr_99']}")
print("\nDRY RUN" if DRY else "\nTEST WRITE DONE — check these 3 styles' Tier field in Odoo UI")
