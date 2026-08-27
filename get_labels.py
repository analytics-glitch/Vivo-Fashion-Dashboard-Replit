import xmlrpc.client, os
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k): return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})

fields=['x_vivo_attr_100','x_vivo_attr_101','x_vivo_attr_102','x_vivo_attr_103',
        'x_vivo_attr_131','x_vivo_attr_18','x_vivo_attr_97','x_studio_style_name_gi',
        'x_gsm_text','x_supplier_fabric_code_text','x_studio_supplier_fab_colour_code',
        'x_print_name_text','x_secondary_colour_text','x_collection_text',
        'x_studio_fab_25','x_studio_fab_38','x_studio_fab_43','x_studio_fab_45',
        'x_studio_fab_46','x_studio_fab_48','x_studio_fab_100','x_studio_fab_101',
        'x_studio_fab_102','x_studio_fab_103','x_studio_fab_124','x_studio_fab_125',
        'x_studio_fabric_ref']
recs=ex('ir.model.fields','search_read',
        [['model','=','product.template'],['name','in',fields]],
        {'fields':['name','field_description','ttype','relation']})
for r in sorted(recs,key=lambda x:x['name']):
    print(f"  {r['name']:34s} | {r.get('ttype',''):10s} | {r.get('field_description','')!r} | {r.get('relation','') or ''}")
