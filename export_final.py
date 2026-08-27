import xmlrpc.client, os, csv
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

def flat(v):
    if isinstance(v,list) and len(v)==2 and isinstance(v[0],int): return v[1]
    if v in (False,None): return ''
    return v

COLS = [
    ('name','Product Name'),
    ('x_studio_style_name_gi','Style Name'),
    ('x_vivo_attr_18','Style Number'),
    ('x_vivo_attr_97','Status'),
    ('x_studio_fabric_ref','Fabric Barcode'),
    ('x_studio_fab_100','Fabric Plain/Print'),
    ('x_studio_fab_125','Fabric Source Country'),
    ('x_studio_fab_124','Fabric Source City'),
    ('x_studio_fab_101','Fabric Structure'),
    ('x_studio_fab_102','Fabric Category'),
    ('x_studio_fab_103','Fabric Sub-Category'),
    ('x_studio_fab_48','Fabric Primary Color'),
    ('x_studio_fab_25','Fabric Width (m)'),
    ('x_studio_fab_38','Fabric GSM'),
    ('x_studio_fab_43','Supplier Fabric Code'),
    ('x_studio_supplier_fab_colour_code','Supplier Fabric Colour Code'),
]
read_fields=['id']+[f for f,_ in COLS]

print("searching finished-goods products...")
ids=ex('product.template','search',[['categ_id','=',17]])
print(str(len(ids))+" products")

rows=[]
B=500
for i in range(0,len(ids),B):
    rows+=ex('product.template','read',ids[i:i+B],fields=read_fields)
    print("  read "+str(min(i+B,len(ids)))+"/"+str(len(ids)))

base=url+"/web#model=product.template&view_type=form&id="
out='product_fabric_export.csv'
with open(out,'w',newline='',encoding='utf-8') as fh:
    w=csv.writer(fh)
    w.writerow(['Odoo ID','Odoo Link']+[lbl for _,lbl in COLS])
    for r in rows:
        w.writerow([r['id'], base+str(r['id'])]+[flat(r.get(f)) for f,_ in COLS])
print("DONE -> "+out+"  ("+str(len(rows))+" rows)")
