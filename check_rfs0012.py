import os, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

print("=== How the write script tries to match 'RFS0012' ===")
for label,dom in [
    ("x_vivo_attr_18.name = RFS0012",[["x_vivo_attr_18.name","=","RFS0012"]]),
    ("x_style_number_text = RFS0012",[["x_style_number_text","=","RFS0012"]]),
]:
    ids=ex("product.template","search",[dom[0]])
    print(f"  {label}: {len(ids)} templates")

print("\n=== Products whose NAME is 'Vivo Fitted Tops' ===")
ids=ex("product.template","search",[["name","like","Vivo Fitted Tops"]])
recs=ex("product.template","read",ids,fields=["id","name","x_style_number_text","x_vivo_attr_99","x_vivo_attr_97","default_code"])
for r in recs:
    tier=r["x_vivo_attr_99"][1] if isinstance(r.get("x_vivo_attr_99"),list) else None
    st=r["x_vivo_attr_97"][1] if isinstance(r.get("x_vivo_attr_97"),list) else None
    print(f"  [{r['id']}] {r['name']!r} styleno={r.get('x_style_number_text')!r} tier={tier} status={st}")

print("\n=== Does 'RFS0012' appear anywhere as a style number text? ===")
ids=ex("product.template","search",[["x_style_number_text","like","RFS"]])
print(f"  templates with 'RFS' in style number text: {len(ids)}")
for r in ex("product.template","read",ids[:10],fields=["name","x_style_number_text"]):
    print(f"     {r.get('x_style_number_text')!r}  {r['name']}")
