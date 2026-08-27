import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR:"+str(e)[:100]

# 1. Can we read product.attribute.value fully?
print("product.attribute.value count:", ex('product.attribute.value','search_count',[[]]))
print("sample:", ex('product.attribute.value','search_read',[[]],{'fields':['id','name','attribute_id'],'limit':5}))

# 2. Find the 'Tier' attribute + all its values (duplicate detection at the SOURCE)
print("\n=== product.attribute list (find Tier/Status) ===")
attrs=ex('product.attribute','search_read',[[]],{'fields':['id','name']})
if isinstance(attrs,list):
    for a in attrs:
        if any(k in (a['name'] or '').lower() for k in ['tier','status','fabric','style']):
            print(f"  attr id={a['id']} {a['name']!r}")

# 3. Why was the bulk tier read empty? Re-check with a known product id (345298)
print("\n=== known product 345298 tier/status raw ===")
r=ex('product.template','read',[345298],fields=['x_vivo_attr_99','x_vivo_attr_97','name'])
print(r)

# 4. Bulk search WITHOUT the !=False (just read first 50 FG products' tier)
print("\n=== first 50 FG products, tier values ===")
ids=ex('product.template','search',[['categ_id','=',17]],{'limit':50})
rows=ex('product.template','read',ids,fields=['x_vivo_attr_99'])
from collections import Counter
c=Counter()
for r in (rows if isinstance(rows,list) else []):
    v=r.get('x_vivo_attr_99')
    c[tuple(v) if isinstance(v,list) else v]+=1
for k,n in c.items(): print(f"  {k} -> {n}")
