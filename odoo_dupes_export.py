import xmlrpc.client, os, re, csv
from collections import defaultdict
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
def last9(s):
    d=re.sub(r'[^0-9]','',s or ''); return d[-9:] if len(d)>=9 else ''

print("reading customer partners...")
ids=ex('res.partner','search',[['customer_rank','>',0]])
print("total:",len(ids))
rows=[]; B=1000
fields=['id','name','email','phone','mobile','city','create_date','write_date','customer_rank']
for i in range(0,len(ids),B):
    rows+=ex('res.partner','read',ids[i:i+B],fields=fields)
    print("  read",min(i+B,len(ids)),"/",len(ids))

by_phone=defaultdict(list); by_email=defaultdict(list)
for r in rows:
    p=last9(r.get('phone')) or last9(r.get('mobile'))
    if p: by_phone[p].append(r)
    e=(r.get('email') or '').strip().lower()
    if e: by_email[e].append(r)

# write duplicate groups to CSV
out="odoo_duplicates.csv"
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["match_type","match_key","group_size","odoo_id","name","email","phone","mobile","city","create_date","customer_rank","odoo_link"])
    gid=0
    for key,members in sorted(by_phone.items(), key=lambda x:-len(x[1])):
        if len(members)<2: continue
        for r in members:
            w.writerow(["phone",key,len(members),r['id'],flat(r.get('name')),flat(r.get('email')),
                        flat(r.get('phone')),flat(r.get('mobile')),flat(r.get('city')),
                        str(r.get('create_date'))[:10],r.get('customer_rank'),
                        f"{url}/web#model=res.partner&id={r['id']}"])
    for key,members in sorted(by_email.items(), key=lambda x:-len(x[1])):
        if len(members)<2: continue
        for r in members:
            w.writerow(["email",key,len(members),r['id'],flat(r.get('name')),flat(r.get('email')),
                        flat(r.get('phone')),flat(r.get('mobile')),flat(r.get('city')),
                        str(r.get('create_date'))[:10],r.get('customer_rank'),
                        f"{url}/web#model=res.partner&id={r['id']}"])
print("DONE ->",out)