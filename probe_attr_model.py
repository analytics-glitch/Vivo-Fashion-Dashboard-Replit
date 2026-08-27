import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR: "+str(e)[:120]

# The tier field x_vivo_attr_99 is a m2o -> what model does it point to?
f=ex('product.template','fields_get',['x_vivo_attr_99'],{'attributes':['relation','type','string']})
print("x_vivo_attr_99 (Tier) ->", f)
f2=ex('product.template','fields_get',['x_vivo_attr_97'],{'attributes':['relation','type','string']})
print("x_vivo_attr_97 (Status) ->", f2)

# Try reading the related model (whatever it is)
rel=None
if isinstance(f,dict): rel=f.get('x_vivo_attr_99',{}).get('relation')
print("\nTier relation model:", rel)
if rel:
    cnt=ex(rel,'search_count',[[]])
    print(f"  {rel} total records:", cnt)
    sample=ex(rel,'search_read',[[]],{'fields':['id','display_name'],'limit':8})
    print("  sample:", sample)
