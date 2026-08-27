import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

# The exact product in your screenshot (Hatua Print) - it HAD all fabric fields filled
ids=ex('product.template','search',[['name','ilike','Tafari Highlow Top in Kitenge - Hatua']])
print("Hatua ids:",ids)
# read a few products, dump every x_vivo_attr_* and x_studio_fab_* with values
sample=ids[:1] if ids else ex('product.template','search',[['categ_id','=',17]],{'limit':1})
for pid in sample:
    row=ex('product.template','read',[pid])[0]
    print(f"\n=== {row.get('name')} (id {pid}) ===")
    for k in sorted(row):
        if (k.startswith('x_vivo_attr_') or k.startswith('x_studio_fab') or k.endswith('_text') or 'gsm' in k or 'supplier' in k):
            v=row[k]
            if v not in (False,None,'',[]): print(f"  {k}: {v!r}")
