import xmlrpc.client, os, re
from collections import defaultdict
url,db,u,pw=os.environ['ODOO_URL'],os.environ['ODOO_DB'],os.environ['ODOO_USER'],os.environ['ODOO_PASSWORD']
uid=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common').authenticate(db,u,pw,{})
m=xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def ex(mod,meth,*a,**k):
    try: return m.execute_kw(db,uid,pw,mod,meth,list(a),k or {})
    except Exception as e: return "ERR:"+str(e)[:120]

def last9(s):
    d=re.sub(r'[^0-9]','',s or '')
    return d[-9:] if len(d)>=9 else ''

# Pull all customer-type partners (customer_rank>0 = has bought / is a customer)
print("counting customer partners...")
ids=ex('res.partner','search',[['customer_rank','>',0]])
print("customer partners:",len(ids) if isinstance(ids,list) else ids)

rows=[]
B=1000
for i in range(0,len(ids),B):
    rows+=ex('res.partner','read',ids[i:i+B],fields=['id','name','email','phone','mobile'])
    print("  read",min(i+B,len(ids)),"/",len(ids))

# group by normalised phone (last 9 digits of phone OR mobile) and by email
by_phone=defaultdict(list)
by_email=defaultdict(list)
for r in rows:
    p=last9(r.get('phone')) or last9(r.get('mobile'))
    if p: by_phone[p].append(r['id'])
    e=(r.get('email') or '').strip().lower()
    if e: by_email[e].append(r['id'])

dup_phone={k:v for k,v in by_phone.items() if len(v)>1}
dup_email={k:v for k,v in by_email.items() if len(v)>1}
excess_phone=sum(len(v)-1 for v in dup_phone.values())
excess_email=sum(len(v)-1 for v in dup_email.values())

print("\n=== ODOO DUPLICATE SCAN (customer partners) ===")
print(f"total customer partners: {len(rows)}")
print(f"phones shared by >1 partner: {len(dup_phone)}  (excess rows: {excess_phone})")
print(f"emails shared by >1 partner: {len(dup_email)}  (excess rows: {excess_email})")
print("\nsample duplicate-phone groups:")
for k,v in list(dup_phone.items())[:8]:
    names=[x['name'] for x in rows if x['id'] in v][:4]
    print(f"  phone ...{k}: ids {v[:5]} names {names}")