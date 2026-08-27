import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR:"+str(e)[:80]

# Try likely model names for the custom attribute-value store
candidates=['x_vivo_product_attribute_value','x_vivo_attribute_value','x_product_attribute_value',
            'x_vivo_attr_value','product.attribute.value','x_vivo_attribute','x_tier','x_status',
            'x_vivo_tier','x_vivo_status']
print("=== probing candidate models ===")
for c in candidates:
    r=ex(c,'search_count',[[]])
    print(f"  {c:38s} -> {r}")

# Definitive: read the tier field with its full option label from a known product,
# then try to read that option id back from a few candidate models
print("\n=== resolve option id 61038 (a 'Retired' tier) across models ===")
for c in candidates:
    r=ex(c,'read',[61038],fields=['id','display_name'])
    if not (isinstance(r,str) and r.startswith('ERR')):
        print(f"  FOUND in {c}: {r}")

# Fallback that ALWAYS works: enumerate distinct tier values from products directly
print("\n=== distinct Tier values in use (from products) ===")
ids=ex('product.template','search',[['x_vivo_attr_99','!=',False]],{'limit':4000})
rows=ex('product.template','read',ids,fields=['x_vivo_attr_99']) if isinstance(ids,list) else []
from collections import Counter
c=Counter()
for r in rows:
    v=r.get('x_vivo_attr_99')
    if isinstance(v,list): c[(v[0],v[1])]+=1
for (oid,name),n in sorted(c.items(), key=lambda x:-x[1]):
    print(f"  id={oid:6d}  {name!r:30s}  used by {n} products")
