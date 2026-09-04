"""Safe identity + customer_people refresh using build-then-swap (no long lock
on live tables). Reads normalised all_customers. Writes _new tables, then
atomically renames them in. Run against prod via VIVO_DATABASE_URL."""
import os, re, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict

conn = psycopg2.connect(os.environ['DATABASE_URL'])
conn.autocommit = False
cur = conn.cursor()

def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None
PSEUDO = re.compile(r'walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception', re.I)
def is_pseudo(name, email):
    if name and PSEUDO.search(name): return True
    if email and email.endswith('@vivofashiongroup.com'): return True
    return False

print("reading all_customers...")
cur.execute("SELECT customer_id, store_id, first_name, last_name, email, phone FROM all_customers")
custs = cur.fetchall()
cur.execute("SELECT DISTINCT ON (id) id, shopify_user_id FROM raw_odoo_customers WHERE shopify_user_id IS NOT NULL ORDER BY id, write_date DESC")
odoo_link = {str(r[0]): str(r[1]) for r in cur.fetchall()}
cur.execute("SELECT source_system, source_customer_id, force_person_id FROM customer_identity_override")
overrides = {(r[0], r[1]): r[2] for r in cur.fetchall()}
print(f"customers={len(custs)} odoo_links={len(odoo_link)} overrides={len(overrides)}")

nodes = []
for (cid, store, fn, ln, email, phone) in custs:
    system = 'odoo' if store == 'vivofashiongroup' else 'shopify'
    disp = ((fn or '')+' '+(ln or '')).strip()
    nodes.append([system, str(cid), store, disp, (email or None), (phone or None), norm_name(disp), is_pseudo(disp, email)])
real = [n for n in nodes if not n[7]]; pseudo_nodes = [n for n in nodes if n[7]]

parent = {}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
def union(a,b):
    ra,rb=find(a),find(b)
    if ra!=rb: parent[rb]=ra
def key(n): return (n[0], n[1])
for n in real: find(key(n))
shop_ids = set(n[1] for n in real if n[0]=='shopify')
for n in real:
    if n[0]=='odoo' and n[1] in odoo_link and odoo_link[n[1]] in shop_ids:
        union(key(n), ('shopify', odoo_link[n[1]]))
def group_by(idx):
    d=defaultdict(list)
    for n in real:
        if n[idx]: d[n[idx]].append(n)
    return d
review_rows=[]
for val,members in group_by(5).items():   # phone first
    names=set(m[6] for m in members if m[6])
    if len(names)>1:
        review_rows.append((val,'phone',[m[1] for m in members],sorted(names))); continue
    for i in range(1,len(members)): union(key(members[0]),key(members[i]))
for val,members in group_by(4).items():   # email
    for i in range(1,len(members)): union(key(members[0]),key(members[i]))
for val,members in group_by(6).items():   # name
    if len(members)>1 and len(set(m[5] for m in members if m[5]))<=1:
        for i in range(1,len(members)): union(key(members[0]),key(members[i]))
ov_person={}
for (sys,sid),pid in overrides.items(): ov_person[find((sys,sid))]=pid
root_to_person={}; next_pid=1; out=[]
for n in real:
    r=find(key(n))
    if r in ov_person: pid=ov_person[r]; method='override'
    else:
        if r not in root_to_person: root_to_person[r]=next_pid; next_pid+=1
        pid=root_to_person[r]; method='resolved'
    out.append((pid,n[0],n[1],n[2],n[3],n[4],n[5],n[6],method))
for n in pseudo_nodes:
    pid=next_pid; next_pid+=1
    out.append((pid,n[0],n[1],n[2],n[3],n[4],n[5],n[6],'pseudo'))

print("building customer_identity_new (no lock on live table)...")
cur.execute("DROP TABLE IF EXISTS customer_identity_new")
cur.execute("""CREATE TABLE customer_identity_new (
    person_id BIGINT, source_system TEXT, source_customer_id TEXT, store_id TEXT,
    display_name TEXT, email_n TEXT, phone9 TEXT, name_n TEXT, match_method TEXT)""")
execute_values(cur, """INSERT INTO customer_identity_new
    (person_id,source_system,source_customer_id,store_id,display_name,email_n,phone9,name_n,match_method)
    VALUES %s""", out, page_size=2000)
cur.execute("CREATE INDEX idx_cin_person ON customer_identity_new(person_id)")
cur.execute("CREATE INDEX idx_cin_srcid ON customer_identity_new(source_customer_id)")
conn.commit()
print(f"built {len(out)} rows. swapping in (atomic)...")

# atomic swap — millisecond lock
cur.execute("""
BEGIN;
DROP TABLE IF EXISTS customer_identity_old;
ALTER TABLE customer_identity RENAME TO customer_identity_old;
ALTER TABLE customer_identity_new RENAME TO customer_identity;
DROP TABLE customer_identity_old;
COMMIT;
""")
conn.commit()
print("✅ customer_identity swapped in.")

# refresh review queue (small, safe to truncate)
cur.execute("TRUNCATE customer_identity_review RESTART IDENTITY")
if review_rows:
    execute_values(cur, "INSERT INTO customer_identity_review (match_key,key_type,source_ids,names) VALUES %s", review_rows, page_size=500)
conn.commit()

cur.execute("SELECT COUNT(*), COUNT(DISTINCT person_id), COUNT(*) FILTER (WHERE match_method='pseudo') FROM customer_identity")
t,p,ps=cur.fetchone()
print(f"IDENTITY: {t} rows, {p} people, {ps} pseudo")
conn.close()
print("DONE (build-then-swap, no long lock).")