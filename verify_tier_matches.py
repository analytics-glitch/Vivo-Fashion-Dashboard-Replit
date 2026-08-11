import xmlrpc.client, os, json, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

rows=json.load(open("/home/runner/workspace/tier_map.json",encoding="utf-8"))

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

detail=[]
for r in rows:
    tids,how=match(r["sn"],r["nm"])
    detail.append((len(tids),how,r["sn"],r["nm"],tids))
detail.sort(reverse=True)

print("=== TOP 8 styles by template count (check for over-broad matches) ===")
for cnt,how,sn,nm,tids in detail[:8]:
    names=ex("product.template","read",tids[:12],fields=["name"])
    print(f"\n{sn} '{nm}' [{how}] -> {cnt} templates:")
    for n in names:
        print("    - " + str(n['name']))

print("\n\n=== the 4 NAME-fallback matches (highest risk) ===")
for cnt,how,sn,nm,tids in detail:
    if how=="name":
        names=ex("product.template","read",tids,fields=["name"])
        print(f"\n{sn} '{nm}' -> {cnt} templates:")
        for n in names:
            print("    - " + str(n['name']))
