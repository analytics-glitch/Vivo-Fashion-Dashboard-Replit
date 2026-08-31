import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR:"+str(e)[:120]

def flat(v):
    if isinstance(v,list) and len(v)==2 and isinstance(v[0],int): return v[1]
    if v in (False,None): return ''
    return v

# 1. Direct read of partner 378566
print("=== res.partner 378566 (Marthe's Odoo row) ===")
fields=['id','name','email','phone','mobile','street','city','country_id',
        'shopify_user_id','customer_rank','create_date','write_date','parent_id','company_type']
r=ex('res.partner','read',[378566],fields=fields)
if isinstance(r,list) and r:
    for k in fields: print(f"  {k}: {flat(r[0].get(k))}")
else:
    print("  ",r)

# 2. Search ALL partners matching her phone / name (how many Marthe partners in Odoo?)
print("\n=== all res.partner matching phone 722700387 ===")
for dom in [[['phone','ilike','722700387']],[['mobile','ilike','722700387']],
            [['name','ilike','Marthe Mui']]]:
    ids=ex('res.partner','search',dom)
    print(f"  domain {dom} -> ids {ids}")
    if isinstance(ids,list) and ids:
        rr=ex('res.partner','read',ids,fields=['id','name','phone','mobile','email','shopify_user_id'])
        for x in (rr if isinstance(rr,list) else []):
            print(f"     [{x['id']}] {flat(x.get('name'))} | ph:{flat(x.get('phone'))} mob:{flat(x.get('mobile'))} | {flat(x.get('email'))} | shopify:{flat(x.get('shopify_user_id'))}")

# 3. Her POS / sale orders in Odoo
print("\n=== sale.order count for partner 378566 ===")
so=ex('sale.order','search_count',[['partner_id','=',378566]])
print("  sale.order:",so)
po=ex('pos.order','search_count',[['partner_id','=',378566]])
print("  pos.order:",po)
