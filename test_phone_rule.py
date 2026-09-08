import os, psycopg2
from collections import defaultdict
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()

# Read the SAME nodes the publish reads
cur.execute("""SELECT customer_id, store_id, first_name, last_name, email, phone
               FROM all_customers WHERE customer_id IS NOT NULL AND store_id IS NOT NULL""")
import re
def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None
PSEUDO = re.compile(r'walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception', re.I)
def is_pseudo(name,email):
    if name and PSEUDO.search(name): return True
    if email and (email.lower().endswith('@vivofashiongroup.com') or email.lower().endswith('@vivoactivewear.com')): return True
    return False

nodes=[]
for cid,store,fn,ln,email,phone in cur.fetchall():
    disp=("%s %s"%(fn or '',ln or '')).strip()
    nodes.append(dict(cid=str(cid),store=store,phone=phone,email=email,disp=disp,
                      name=norm_name(disp),pseudo=is_pseudo(disp,email)))

# YOUR RULE: phone = one person (merge ALL same-phone, NO ambiguous split)
parent={}
def find(x):
    parent.setdefault(x,x)
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
def union(a,b):
    ra,rb=find(a),find(b)
    if ra!=rb: parent[rb]=ra
for i,n in enumerate(nodes): find(i)
phone_groups=defaultdict(list)
for i,n in enumerate(nodes):
    if not n['pseudo'] and n['phone']:
        phone_groups[n['phone']].append(i)
for phone,idxs in phone_groups.items():
    for j in idxs[1:]:
        union(idxs[0],j)   # merge ALL same-phone, no name check

# count distinct people among non-pseudo
real_roots=set(find(i) for i,n in enumerate(nodes) if not n['pseudo'])
print("real people under YOUR rule:", len(real_roots))
print("total nodes:", len(nodes), "pseudo:", sum(1 for n in nodes if n['pseudo']))

# Marthe check
marthe=[i for i,n in enumerate(nodes) if n['phone']=='254722700387' and not n['pseudo']]
print("Marthe records:", len(marthe), "-> people:", len(set(find(i) for i in marthe)))
conn.close()
