import os, psycopg2, re
from collections import defaultdict
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()
cur.execute("""SELECT customer_id, store_id, first_name, last_name, email, phone
               FROM all_customers WHERE customer_id IS NOT NULL AND store_id IS NOT NULL""")
def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None
def norm_email(e): return (e or '').strip().lower() or None
PSEUDO = re.compile(r'walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception', re.I)
def is_pseudo(name,email):
    if name and PSEUDO.search(name): return True
    if email and (email.lower().endswith('@vivofashiongroup.com') or email.lower().endswith('@vivoactivewear.com')): return True
    return False
nodes=[]
for cid,store,fn,ln,email,phone in cur.fetchall():
    disp=("%s %s"%(fn or '',ln or '')).strip()
    nodes.append(dict(phone=phone,email=norm_email(email),name=norm_name(disp),
                      pseudo=is_pseudo(disp,email)))
parent={}
def find(x):
    parent.setdefault(x,x)
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
def union(a,b):
    ra,rb=find(a),find(b)
    if ra!=rb: parent[rb]=ra
real=[i for i,n in enumerate(nodes) if not n['pseudo']]
for i in real: find(i)
# 1. PHONE primary
pg=defaultdict(list)
for i in real:
    if nodes[i]['phone']: pg[nodes[i]['phone']].append(i)
for idxs in pg.values():
    for j in idxs[1:]: union(idxs[0],j)
# 2. EMAIL secondary — ONLY for records with NO phone
eg=defaultdict(list)
for i in real:
    if not nodes[i]['phone'] and nodes[i]['email']:
        eg[nodes[i]['email']].append(i)
for idxs in eg.values():
    for j in idxs[1:]: union(idxs[0],j)
roots=set(find(i) for i in real)
print("real people under YOUR rule (phone primary + email-for-phoneless):", len(roots))
print("total nodes:",len(nodes)," non-pseudo:",len(real)," pseudo:",sum(1 for n in nodes if n['pseudo']))
m=[i for i in real if nodes[i]['phone']=='254722700387']
print("Marthe:",len(m),"records ->",len(set(find(i) for i in m)),"person")
conn.close()
