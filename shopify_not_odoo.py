import xmlrpc.client, os, re, csv, psycopg2
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR:"+str(e)[:120]
def last9(s):
    d=re.sub(r'[^0-9]','',s or ''); return d[-9:] if len(d)>=9 else ''
def nemail(s): return (s or '').strip().lower()

# 1. Pull Odoo partner match keys, resilient to per-batch errors
print("reading Odoo partners...")
ids=ex('res.partner','search',[['customer_rank','>',0]])
odoo=[]; B=500
for i in range(0,len(ids),B):
    batch=ex('res.partner','read',ids[i:i+B],fields=['id','shopify_user_id','phone','mobile','email'])
    if isinstance(batch,list):
        odoo+=[r for r in batch if isinstance(r,dict)]
    else:
        print("  ! batch",i,"error:",batch,"- retrying once")
        batch=ex('res.partner','read',ids[i:i+B],fields=['id','shopify_user_id','phone','mobile','email'])
        if isinstance(batch,list):
            odoo+=[r for r in batch if isinstance(r,dict)]
        else:
            print("  ! batch",i,"failed again, skipping")
    print("  odoo",min(i+B,len(ids)),"/",len(ids))
print("odoo records read:",len(odoo))

odoo_shopify_ids=set(); odoo_phones=set(); odoo_emails=set()
for r in odoo:
    sid=r.get('shopify_user_id')
    if sid: odoo_shopify_ids.add(str(sid))
    p=last9(r.get('phone')) or last9(r.get('mobile'))
    if p: odoo_phones.add(p)
    e=nemail(r.get('email'))
    if e: odoo_emails.add(e)
print(f"Odoo: {len(odoo_shopify_ids)} shopify-linked, {len(odoo_phones)} phones, {len(odoo_emails)} emails")

# 2. Pull Shopify customers from the DB
print("reading Shopify customers from DB...")
conn=psycopg2.connect(os.environ['DATABASE_URL'])
cur=conn.cursor()
cur.execute("""
    SELECT DISTINCT ON (id, store_id)
       id, store_id, first_name, last_name, email, phone,
       total_spent, orders_count, created_at
    FROM raw_shopify_customers
    ORDER BY id, store_id, _loaded_at DESC
""")
shop=cur.fetchall()
conn.close()
print("shopify customers:",len(shop))

# 3. Classify
out="shopify_not_in_odoo.csv"
n_linked=n_idmatch=n_notinodoo=0
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["classification","shopify_id","store_id","first_name","last_name","email","phone",
                "total_spent","orders_count","created_at"])
    for (cid,store,fn,ln,email,phone,spent,oc,created) in shop:
        sid=str(cid)
        linked = sid in odoo_shopify_ids
        idmatch = (last9(phone)!='' and last9(phone) in odoo_phones) or (nemail(email)!='' and nemail(email) in odoo_emails)
        if linked:
            n_linked+=1; continue
        if idmatch:
            n_idmatch+=1; cls="in Odoo by identity (not linked)"
        else:
            n_notinodoo+=1; cls="NOT in Odoo at all"
        w.writerow([cls,sid,store,fn,ln,email,phone,spent,oc,str(created)[:10]])
print("\n=== RESULTS ===")
print(f"Shopify total: {len(shop)}")
print(f"  linked to Odoo (shopify_user_id): {n_linked}")
print(f"  NOT linked but match Odoo by phone/email: {n_idmatch}")
print(f"  NOT in Odoo at all (strict): {n_notinodoo}")
print(f"\nLink-based 'not in Odoo' = {n_idmatch + n_notinodoo}")
print(f"Identity-based 'not in Odoo' = {n_notinodoo}")
print("DONE ->",out)