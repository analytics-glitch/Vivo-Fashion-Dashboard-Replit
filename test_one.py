import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

def flat(v):
    if isinstance(v,list) and len(v)==2 and isinstance(v[0],int): return v[1]
    if v in (False,None): return ''
    return v

ids=ex('product.template','search',[['name','ilike','Tafari Highlow Top in Kitenge - Hatua']])
pid=ids[0]
row=ex('product.template','read',[pid],fields=['id','name','x_vivo_attr_18','x_vivo_attr_97','x_studio_fabric_ref'])[0]

print("=== ONE PRODUCT ===")
print("Odoo ID (database id):", row['id'])
print("Product Name        :", flat(row.get('name')))
print("Style Number        :", flat(row.get('x_vivo_attr_18')))
print("Status              :", flat(row.get('x_vivo_attr_97')))
print("Fabric Barcode      :", flat(row.get('x_studio_fabric_ref')))
print()
print("=== HOW TO MAP BACK TO ODOO ===")
print("1. Direct URL (paste in browser, logged into Odoo):")
print(f"   {url}/web#id={row['id']}&model=product.template&view_type=form")
print()
print("2. website_url (public product page):")
wu=ex('product.template','read',[pid],fields=['website_url'])[0].get('website_url')
print(f"   {url}{wu}")
print()
print("3. In Odoo UI: Products list -> filter -> the ID column, or search the name.")
