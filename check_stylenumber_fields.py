import os, xmlrpc.client
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# Take a KNOWN real style (e.g. V0822077) and a sample, dump ALL style-number-ish fields
for sn_name in ["Vivo Fitted Tops - FS 1","Vivo Tana Puff Sleeve Bodysuit"]:
    ids=ex("product.template","search",[["name","=",sn_name]])
    if not ids:
        ids=ex("product.template","search",[["name","like",sn_name]])
    if not ids:
        print(f"\n{sn_name}: not found"); continue
    r=ex("product.template","read",ids[:1],fields=[
        "name","x_style_number_text","x_vivo_attr_18","x_studio_style_name_gi","x_vivo_attr_16"])[0]
    print(f"\n{r['name']}:")
    print(f"   x_style_number_text (char) = {r.get('x_style_number_text')!r}")
    print(f"   x_vivo_attr_18 (m2o)       = {r.get('x_vivo_attr_18')!r}")
    print(f"   x_studio_style_name_gi     = {r.get('x_studio_style_name_gi')!r}")
    print(f"   x_vivo_attr_16 (m2o)       = {r.get('x_vivo_attr_16')!r}")

# Which field is labeled 'Style Number' in the UI? check field metadata if accessible
print("\n=== Trying to read field labels (may fail if no access) ===")
try:
    flds=ex("ir.model.fields","search_read",
        [["model","=","product.template"],["field_description","like","Style Number"]],
        fields=["name","field_description","ttype","relation"])
    for f in flds:
        print(f"   {f['name']} : {f['field_description']!r} ({f['ttype']} {f.get('relation')})")
except Exception as e:
    print("   no access to ir.model.fields:", str(e)[:80])
