import xmlrpc.client, os, json, re, sys
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

rows=json.load(open("/home/runner/workspace/tier_map.json",encoding="utf-8"))

def match(sn,nm):
    if ex("product.template","search",[["x_vivo_attr_18.name","=",sn]]): return "attr_18",None
    if ex("product.template","search",[["x_style_number_text","=",sn]]): return "style_text",None
    if ex("product.product","search_read",[["default_code","=like",sn+"%"]],fields=["id"]): return "default_code",None
    m=re.match(r"^[A-Za-z](\d.*)$",sn)
    if m and ex("product.product","search_read",[["default_code","=like",m.group(1)+"%"]],fields=["id"]):
        return "default_code_noletter",None
    ids=ex("product.template","search",[["name","=like",nm+"%"]])
    if ids: return "name",ids
    return "UNMATCHED",None

print("Scanning for the name-fallback styles...", flush=True)
found=0
for r in rows:
    how,ids=match(r["sn"],r["nm"])
    if how=="name":
        found+=1
        names=ex("product.template","read",ids,fields=["name"])
        print(f"\n[{r['tier']}] {r['sn']} '{r['nm']}' -> {len(ids)} templates:", flush=True)
        for n in names:
            print("    - "+str(n["name"]), flush=True)
        if found>=10: break
print(f"\nDone. Found {found} name-fallback styles.", flush=True)
