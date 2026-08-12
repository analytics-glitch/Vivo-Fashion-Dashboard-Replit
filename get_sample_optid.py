import os, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# read distinct x_vivo_attr_99 options currently on templates (incl the new 'Sample')
ids=ex("product.template","search",[["x_vivo_attr_99","!=",False]])
recs=ex("product.template","read",ids,fields=["x_vivo_attr_99"])
seen={}
for r in recs:
    v=r.get("x_vivo_attr_99")
    if v and isinstance(v,list): seen[v[0]]=seen.get(v[0],[v[1],0]); seen[v[0]][1]+=1
print("Tier (x_vivo_attr_99) options in use:")
for oid,(nm,c) in sorted(seen.items()):
    mark = "  <-- SAMPLE?" if "sample" in (nm or "").lower() else ""
    print(f"   id={oid:>6}  {nm!r}  used={c}{mark}")

# also check the tier attribute's full option list via the relation (may need a product with it set)
print("\nIf 'Sample' not shown above, it has 0 products yet — set it on ONE product in Odoo, then re-run.")
