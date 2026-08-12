import os, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})
# all templates carrying VE0034A
ids=ex("product.template","search",[["x_style_number_text","=","VE0034A"]])
recs=ex("product.template","read",ids,fields=["id","name","default_code","product_variant_ids"])
print(f"Templates with VE0034A: {len(recs)}")
for r in recs:
    vids=r.get("product_variant_ids") or []
    vs=ex("product.product","read",vids,fields=["default_code"]) if vids else []
    skus=[v.get("default_code") for v in vs]
    print(f"   [{r['id']}] {r['name']}  tmpl_sku={r.get('default_code')}  variant_skus={skus[:3]}")
