"""Customer identity resolver (Step 6 — phone-first + junk blocklist before matching).
Reads normalised all_customers + raw_odoo_customers link. Blocklist tags pseudo
accounts BEFORE matching so they never merge with real people. Writes ONLY to
customer_identity / _review. Live pipeline untouched."""
import os, re, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None

# ---- JUNK BLOCKLIST (applied BEFORE matching) ----
PSEUDO = re.compile(
    r'walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|'
    r'sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception',
    re.I)
def is_pseudo(name, email):
    if name and PSEUDO.search(name): return True
    if email and email.endswith('@vivofashiongroup.com'): return True
    return False

print("reading all_customers (normalised)...")
cur.execute("SELECT customer_id, store_id, first_name, last_name, email, phone FROM all_customers")
custs = cur.fetchall()

cur.execute("""SELECT DISTINCT ON (id) id, shopify_user_id FROM raw_odoo_customers
    WHERE shopify_user_id IS NOT NULL ORDER BY id, write_date DESC""")
odoo_link = {str(r[0]): str(r[1]) for r in cur.fetchall()}

cur.execute("SELECT source_system, source_customer_id, force_person_id FROM customer_identity_override")
overrides = {(r[0], r[1]): r[2] for r in cur.fetchall()}
print(f"customers={len(custs)} odoo_links={len(odoo_link)} overrides={len(overrides)}")

# ---- Build nodes, tagging pseudo up front ----
nodes = []
for (cid, store, fn, ln, email, phone) in custs:
    system = 'odoo' if store == 'vivofashiongroup' else 'shopify'
    disp = ((fn or '')+' '+(ln or '')).strip()
    full = norm_name(disp)
    pseudo = is_pseudo(disp, email)
    nodes.append([system, str(cid), store, disp, (email or None),
                  (phone or None), full, pseudo])

real  = [n for n in nodes if not n[7]]   # matched
pseudo_nodes = [n for n in nodes if n[7]] # NOT matched — each stays its own person
print(f"real nodes: {len(real)}  |  pseudo (blocklisted, not matched): {len(pseudo_nodes)}")

parent = {}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb: parent[rb] = ra
def key(n): return (n[0], n[1])
for n in real: find(key(n))

# 1. shopify_user_id link (structural — always safe)
shop_ids = set(n[1] for n in real if n[0]=='shopify')
for n in real:
    if n[0]=='odoo' and n[1] in odoo_link and odoo_link[n[1]] in shop_ids:
        union(key(n), ('shopify', odoo_link[n[1]]))

def group_by(idx):
    d = defaultdict(list)
    for n in real:
        if n[idx]: d[n[idx]].append(n)
    return d

review_rows = []
# 2. PHONE FIRST (country-prefixed, globally unique). Flag same-phone/diff-name.
for val, members in group_by(5).items():
    names = set(m[6] for m in members if m[6])
    if len(names) > 1:
        review_rows.append((val, 'phone', [m[1] for m in members], sorted(names)))
        continue
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 3. EMAIL second
for val, members in group_by(4).items():
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 4. exact name third (only when no phone conflict)
for val, members in group_by(6).items():
    if len(members) > 1 and len(set(m[5] for m in members if m[5])) <= 1:
        for i in range(1, len(members)):
            union(key(members[0]), key(members[i]))

ov_person = {}
for (sys, sid), pid in overrides.items():
    ov_person[find((sys, sid))] = pid

root_to_person = {}; next_pid = 1; out = []
# real people first
for n in real:
    r = find(key(n))
    if r in ov_person:
        pid = ov_person[r]; method='override'
    else:
        if r not in root_to_person:
            root_to_person[r] = next_pid; next_pid += 1
        pid = root_to_person[r]; method='resolved'
    out.append((pid, n[0], n[1], n[2], n[3], n[4], n[5], n[6], method))
# pseudo accounts: each its OWN person, method='pseudo' (never merged)
for n in pseudo_nodes:
    pid = next_pid; next_pid += 1
    out.append((pid, n[0], n[1], n[2], n[3], n[4], n[5], n[6], 'pseudo'))

print("writing customer_identity...")
cur.execute("TRUNCATE customer_identity")
execute_values(cur, """
    INSERT INTO customer_identity
      (person_id, source_system, source_customer_id, store_id, display_name,
       email_n, phone9, name_n, match_method)
    VALUES %s
""", out, page_size=1000)
cur.execute("TRUNCATE customer_identity_review RESTART IDENTITY")
if review_rows:
    execute_values(cur, """
        INSERT INTO customer_identity_review (match_key, key_type, source_ids, names)
        VALUES %s
    """, review_rows, page_size=500)
conn.commit()

cur.execute("SELECT COUNT(*), COUNT(DISTINCT person_id) FROM customer_identity")
total, people = cur.fetchone()
cur.execute("SELECT COUNT(*) FROM customer_identity WHERE match_method='pseudo'")
pseudo_ct = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM customer_identity_review")
rev = cur.fetchone()[0]
cur.execute("SELECT COUNT(DISTINCT person_id) FROM customer_identity WHERE match_method<>'pseudo'")
real_people = cur.fetchone()[0]
print(f"\n=== IDENTITY BUILT (phone-first + blocklist) ===")
print(f"source rows:        {total}")
print(f"distinct people:    {people}")
print(f"  real people:      {real_people}")
print(f"  pseudo accounts:  {pseudo_ct} (blocklisted, each its own, not merged)")
print(f"review queue:       {rev}")
conn.close()
print("\nDONE — identity tables only. Live untouched.")