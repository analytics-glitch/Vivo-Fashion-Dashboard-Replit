"""build_customer_identity.py — PHONE = IDENTITY (no chaining).
Each record's person = its own phone9. No phone -> email -> name -> self.
NO transitive union. Pseudo/junk accounts excluded. Build-then-swap.
Reads normalised all_customers. Writes customer_identity only."""
import os, re, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None
PSEUDO = re.compile(r'walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception', re.I)
def is_pseudo(name, email):
    if name and PSEUDO.search(name): return True
    if email and email.endswith('@vivofashiongroup.com'): return True
    if email and email.endswith('@vivoactivewear.com'): return True
    return False

print("reading all_customers (normalised)...")
cur.execute("SELECT customer_id, store_id, first_name, last_name, email, phone FROM all_customers")
custs = cur.fetchall()
cur.execute("SELECT source_system, source_customer_id, force_person_id FROM customer_identity_override")
overrides = {(r[0], r[1]): r[2] for r in cur.fetchall()}
print(f"customers={len(custs)} overrides={len(overrides)}")

nodes = []
for (cid, store, fn, ln, email, phone) in custs:
    system = 'odoo' if store == 'vivofashiongroup' else 'shopify'
    disp = ((fn or '')+' '+(ln or '')).strip()
    nodes.append({'sys':system,'id':str(cid),'store':store,'disp':disp,
                  'email':(email or None),'phone':(phone or None),
                  'name_n':norm_name(disp),'pseudo':is_pseudo(disp, email)})

def group_key(n):
    if n['phone']:  return ('phone', n['phone'])
    if n['email']:  return ('email', n['email'])
    if n['name_n']: return ('name',  n['name_n'])
    return ('self', n['id'])

real = [n for n in nodes if not n['pseudo']]
pseudo_nodes = [n for n in nodes if n['pseudo']]
print(f"real: {len(real)} | pseudo (excluded): {len(pseudo_nodes)}")

groups = defaultdict(list)
for n in real:
    groups[group_key(n)].append(n)

out = []
next_pid = 1
for gk, members in groups.items():
    forced = None
    for m in members:
        if (m['sys'], m['id']) in overrides:
            forced = overrides[(m['sys'], m['id'])]; break
    pid = forced if forced is not None else next_pid
    if forced is None: next_pid += 1
    for m in members:
        out.append((pid, m['sys'], m['id'], m['store'], m['disp'],
                    m['email'], m['phone'], m['name_n'], 'resolved'))
for n in pseudo_nodes:
    pid = next_pid; next_pid += 1
    out.append((pid, n['sys'], n['id'], n['store'], n['disp'],
                n['email'], n['phone'], n['name_n'], 'pseudo'))

print("building customer_identity_new...")
cur.execute("DROP TABLE IF EXISTS customer_identity_new CASCADE")
cur.execute("""CREATE TABLE customer_identity_new (
    person_id BIGINT, source_system TEXT, source_customer_id TEXT, store_id TEXT,
    display_name TEXT, email_n TEXT, phone9 TEXT, name_n TEXT, match_method TEXT)""")
execute_values(cur, """INSERT INTO customer_identity_new
    (person_id,source_system,source_customer_id,store_id,display_name,email_n,phone9,name_n,match_method)
    VALUES %s""", out, page_size=2000)
cur.execute("CREATE INDEX idx_cin_person_n ON customer_identity_new(person_id)")
cur.execute("CREATE INDEX idx_cin_srcid_n ON customer_identity_new(source_customer_id)")
cur.execute("CREATE INDEX idx_cin_phone_n ON customer_identity_new(phone9)")
cur.execute("CREATE INDEX idx_cin_email_n ON customer_identity_new(email_n)")
conn.commit()
print(f"built {len(out)} rows. swapping in...")

cur.execute("""
BEGIN;
DROP VIEW IF EXISTS v_duplicate_clusters;
DROP TABLE IF EXISTS customer_identity_old;
ALTER TABLE customer_identity RENAME TO customer_identity_old;
ALTER TABLE customer_identity_new RENAME TO customer_identity;
DROP TABLE customer_identity_old;
CREATE VIEW v_duplicate_clusters AS
 SELECT 'phone' AS key_type, phone9 AS match_key, COUNT(DISTINCT person_id) AS people,
        ARRAY_AGG(DISTINCT person_id) AS person_ids, ARRAY_AGG(DISTINCT display_name) AS names
 FROM customer_identity WHERE match_method<>'pseudo' AND phone9 IS NOT NULL AND phone9<>''
 GROUP BY phone9 HAVING COUNT(DISTINCT person_id)>1;
COMMIT;
""")
conn.commit()
cur.execute("TRUNCATE customer_identity_review RESTART IDENTITY")
conn.commit()

cur.execute("SELECT COUNT(*), COUNT(DISTINCT person_id), COUNT(*) FILTER (WHERE match_method='pseudo') FROM customer_identity")
t,p,ps=cur.fetchone()
print(f"=== IDENTITY (phone=identity, no chaining) ===")
print(f"rows: {t}  people: {p}  pseudo: {ps}")
cur.execute("SELECT COUNT(*) FROM v_duplicate_clusters")
print(f"phones split across >1 person (should be 0): {cur.fetchone()[0]}")
conn.close()
print("DONE.")