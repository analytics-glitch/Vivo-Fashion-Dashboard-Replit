import xmlrpc.client, os
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
cats=models.execute_kw(db,uid,pw,"product.category","search_read",[[]],
    {"fields":["id","name","complete_name"],"limit":200})
print("ALL product categories:")
for c in sorted(cats,key=lambda x:x.get("complete_name") or ""):
    print(f"   id={c['id']:>4}  {c.get('complete_name') or c['name']}")
