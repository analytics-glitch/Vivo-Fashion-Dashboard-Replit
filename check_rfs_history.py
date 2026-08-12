import os, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# Look at the actual variant SKUs of the 'Vivo Fitted Tops' templates
ids=ex("product.template","search",[["name","like","Vivo Fitted Tops"]])
recs=ex("product.template","read",ids,fields=["id","name","product_variant_ids"])
print("Variant SKUs of 'Vivo Fitted Tops' templates:")
for r in recs:
    vids=r.get("product_variant_ids") or []
    vs=ex("product.product","read",vids,fields=["default_code"]) if vids else []
    skus=[v.get("default_code") for v in vs if v.get("default_code")]
    print(f"  {r['name']:<32} skus={skus[:4]}")

# Does RFS0012 exist as a style number in all_products_clean (the Replit source)?
print("\n(Check Replit all_products_clean for RFS0012 separately with SQL)")
