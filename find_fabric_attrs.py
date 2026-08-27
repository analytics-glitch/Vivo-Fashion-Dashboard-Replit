import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

f=ex('product.template','fields_get',[],{'attributes':['string','type','relation']})
print("TOTAL fields:", len(f))

print("\n=== ALL custom (x_/studio) fields ===")
for name,meta in sorted(f.items()):
    if name.startswith('x_') or 'studio' in name.lower():
        t=str(meta.get('type') or '?'); lbl=str(meta.get('string') or ''); rel=str(meta.get('relation') or '')
        print(f"  {name:36s} | {t:10s} | {lbl!r} | rel={rel}")

print("\n=== sample product FULL read (Safari Tafari) ===")
ids=ex('product.template','search',[['name','ilike','Tafari Highlow Top in Kitenge']])
print("found ids:", ids[:3])
if ids:
    row=ex('product.template','read',[ids[0]])[0]
    for k,v in sorted(row.items()):
        if v not in (False,None,'',[]): print(f"  {k}: {v!r}")
