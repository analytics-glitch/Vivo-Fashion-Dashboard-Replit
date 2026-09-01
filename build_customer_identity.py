"""Customer identity resolver (Step 5 — reads NORMALISED all_customers).
Reads all_customers (already normalised: country-prefixed phone, lowercased email,
clean names) + raw_odoo_customers (for shopify_user_id link). Writes ONLY to
customer_identity / _review. Never touches live pipeline tables."""
import os, re, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

def norm_name(s): return re.sub(r'\s+',' ',(s or '').strip()).lower() or None

# ---- Read the NORMALISED customer table ----
print("reading all_customers (normalised)...")
cur.execute("""
    SELECT customer_id, store_id, first_name, last_name, email, phone
    FROM all_customers
""")
custs = cur.fetchall()

# ---- Read Odoo shopify_user_id links (for cross-system unification) ----
cur.execute("""
    SELECT DISTINCT ON (id) id, shopify_user_id
    FROM raw_odoo_customers WHERE shopify_user_id IS NOT NULL
    ORDER BY id, write_date DESC
""")
odoo_link = {str(r[0]): str(r[1]) for r in cur.fetchall()}

# ---- Overrides ----
cur.execute("SELECT source_system, source_customer_id, force_person_id FROM customer_identity_override")
overrides = {(r[0], r[1]): r[2] for r in cur.fetchall()}
print(f"customers={len(custs)} odoo_links={len(odoo_link)} overrides={len(overrides)}")

# ---- Build nodes ----
# system: 'odoo' if store_id=vivofashiongroup (Odoo partner ids), else 'shopify'
nodes = []
for (cid, store, fn, ln, email, phone) in custs:
    system = 'odoo' if store == 'vivofashiongroup' else 'shopify'
    full = norm_name((fn or '') + ' ' + (ln or ''))
    nodes.append([system, str(cid), store, ((fn or '')+' '+(ln or '')).strip(),
                  (email or None), (phone or None), full])

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
for n in nodes: find(key(n))

# 1. shopify_user_id link (odoo id -> its shopify id)
shop_ids = set(n[1] for n in nodes if n[0]=='shopify')
for n in nodes:
    if n[0]=='odoo' and n[1] in odoo_link and odoo_link[n[1]] in shop_ids:
        union(key(n), ('shopify', odoo_link[n[1]]))

def group_by(idx):
    d = defaultdict(list)
    for n in nodes:
        if n[idx]: d[n[idx]].append(n)
    return d

# 2. email
for val, members in group_by(4).items():
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 3. phone (country-prefixed already, so globally unique). Flag same-phone/diff-name.
review_rows = []
for val, members in group_by(5).items():
    names = set(m[6] for m in members if m[6])
    if len(names) > 1:
        review_rows.append((val, 'phone', [m[1] for m in members], sorted(names)))
        continue
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 4. exact full name only when no phone conflict
for val, members in group_by(6).items():
    if len(members) > 1 and len(set(m[5] for m in members if m[5])) <= 1:
        for i in range(1, len(members)):
            union(key(members[0]), key(members[i]))

# overrides win
ov_person = {}
for (sys, sid), pid in overrides.items():
    ov_person[find((sys, sid))] = pid

root_to_person = {}; next_pid = 1; out = []
for n in nodes:
    r = find(key(n))
    if r in ov_person:
        pid = ov_person[r]; method='override'
    else:
        if r not in root_to_person:
            root_to_person[r] = next_pid; next_pid += 1
        pid = root_to_person[r]; method='resolved'
    out.append((pid, n[0], n[1], n[2], n[3], n[4], n[5], n[6], method))

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
cur.execute("SELECT COUNT(*) FROM customer_identity_review")
rev = cur.fetchone()[0]
print(f"\n=== IDENTITY BUILT (normalised keys) ===")
print(f"source rows:     {total}")
print(f"distinct people: {people}")
print(f"collapsed:       {total-people}")
print(f"review queue:    {rev}")

print("\n=== MARTHE TEST ===")
cur.execute("""SELECT person_id, source_system, source_customer_id, display_name, phone9, match_method
    FROM customer_identity WHERE phone9 LIKE '%722700387' ORDER BY person_id""")
mr = cur.fetchall()
for r in mr: print("  ", r)
print(f"  --> {len(mr)} rows, {len(set(r[0] for r in mr))} person_id(s)")
conn.close()
print("\nDONE — identity tables only. Live untouched.")