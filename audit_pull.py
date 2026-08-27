import xmlrpc.client, os, csv
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

# m2o -> "id||name" so duplicate-label-different-id is detectable; text stays raw
def cell(v):
    if isinstance(v,list) and len(v)==2 and isinstance(v[0],int): return str(v[0])+"||"+str(v[1])
    if v in (False,None): return ""
    return str(v)

FIELDS=[
 'id','name','active','default_code','barcode','categ_id','product_variant_count',
 'x_vivo_attr_18','x_style_number_text',           # style number m2o + char
 'x_studio_style_name_gi','x_vivo_attr_16','x_style_name_text',  # style name m2o + m2o + char
 'x_vivo_attr_97',                                  # status
 'x_vivo_attr_99',                                  # tier
 'x_colour_way_sku_text','x_vivo_attr_112',         # colour-way sku char + m2o
 'x_studio_fabric_ref',                             # fabric barcode
 'x_studio_brand','x_vivo_attr_22',                 # brand
 'x_studio_categories','x_vivo_categories',         # category
 # fabric attrs (studio) + their vivo mirrors
 'x_studio_fab_100','x_vivo_attr_100',
 'x_studio_fab_101','x_vivo_attr_101',
 'x_studio_fab_102','x_vivo_attr_102',
 'x_studio_fab_103','x_vivo_attr_103',
 'x_studio_fab_124','x_vivo_attr_124',
 'x_studio_fab_125','x_vivo_attr_125',
 'x_studio_fab_25','x_vivo_attr_25',
 'x_studio_fab_38','x_vivo_attr_38',
 'x_studio_fab_43','x_vivo_attr_43',
 'x_studio_fab_48','x_vivo_attr_48',
 'x_vivo_duplicate_key','x_vivo_duplicate_cleanup_state',
]

print("searching ALL products (not just FG)...")
ids=ex('product.template','search',[])   # ALL templates so we catch dupes across categories
print(str(len(ids))+" products")

rows=[]; B=500
for i in range(0,len(ids),B):
    rows+=ex('product.template','read',ids[i:i+B],fields=FIELDS)
    print("  read "+str(min(i+B,len(ids)))+"/"+str(len(ids)))

out='product_audit_raw.csv'
with open(out,'w',newline='',encoding='utf-8') as fh:
    w=csv.writer(fh); w.writerow(FIELDS)
    for r in rows:
        w.writerow([cell(r.get(f)) for f in FIELDS])
print("DONE -> "+out+"  ("+str(len(rows))+" rows)")
