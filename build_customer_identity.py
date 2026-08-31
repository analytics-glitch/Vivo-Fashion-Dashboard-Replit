"""Customer identity resolver. Reads live tables (read-only), writes ONLY to
customer_identity / _review. Never touches all_customers or the live pipeline."""
import os, re, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

def phone9(*vals):
    for v in vals:
        d = re.sub(r'[^0-9]', '', v or '')
        if len(d) >= 9:
            return d[-9:]
    return ''
def norm_email(s): return (s or '').strip().lower() or None
def norm_name(s):  return re.sub(r'\s+', ' ', (s or '').strip()).lower() or None

print("reading raw_shopify_customers...")
cur.execute("""
    SELECT DISTINCT ON (id, store_id)
        id, store_id, email, first_name, last_name, phone, default_address_phone
    FROM raw_shopify_customers
    ORDER BY id, store_id, _loaded_at DESC
""")
shop = cur.fetchall()

print("reading raw_odoo_customers...")
cur.execute("""
    SELECT DISTINCT ON (id)
        id, name, email, phone, mobile, shopify_user_id, store_id
    FROM raw_odoo_customers
    ORDER BY id, write_date DESC
""")
odoo = cur.fetchall()

cur.execute("SELECT source_system, source_customer_id, force_person_id FROM customer_identity_override")
overrides = {(r[0], r[1]): r[2] for r in cur.fetchall()}
print(f"shopify={len(shop)} odoo={len(odoo)} overrides={len(overrides)}")

nodes = []
for (cid, store, email, fn, ln, phone, addr_phone) in shop:
    nm = ((fn or '') + ' ' + (ln or '')).strip()
    nodes.append(["shopify", str(cid), store, nm,
                  norm_email(email), phone9(phone, addr_phone), norm_name(nm), None])
for (oid, name, email, phone, mobile, shopify_uid, store) in odoo:
    nodes.append(["odoo", str(oid), store, name,
                  norm_email(email), phone9(phone, mobile), norm_name(name),
                  str(shopify_uid) if shopify_uid else None])

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

# 1. shopify_user_id link
shop_ids = set(n[1] for n in nodes if n[0] == 'shopify')
for n in nodes:
    if n[0] == 'odoo' and n[7] and n[7] in shop_ids:
        union(key(n), ('shopify', n[7]))

def group_by(idx):
    d = defaultdict(list)
    for n in nodes:
        if n[idx]: d[n[idx]].append(n)
    return d

# 2. email
for val, members in group_by(4).items():
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 3. phone (flag ambiguous same-phone/different-name into review)
review_rows = []
for val, members in group_by(5).items():
    names = set(m[6] for m in members if m[6])
    if len(names) > 1:
        review_rows.append((val, 'phone', [m[1] for m in members], sorted(names)))
        continue
    for i in range(1, len(members)):
        union(key(members[0]), key(members[i]))

# 4. exact name (only when no phone conflict)
for val, members in group_by(6).items():
    if len(members) > 1 and len(set(m[5] for m in members if m[5])) <= 1:
        for i in range(1, len(members)):
            union(key(members[0]), key(members[i]))

ov_person = {}
for (sys, sid), pid in overrides.items():
    ov_person[find((sys, sid))] = pid

root_to_person = {}
next_pid = 1
rows = []
for n in nodes:
    r = find(key(n))
    if r in ov_person:
        pid = ov_person[r]; method = 'override'
    else:
        if r not in root_to_person:
            root_to_person[r] = next_pid; next_pid += 1
        pid = root_to_person[r]; method = 'resolved'
    rows.append((pid, n[0], n[1], n[2], n[3], n[4], n[5], n[6], method))

print("writing customer_identity...")
cur.execute("TRUNCATE customer_identity")
execute_values(cur, """
    INSERT INTO customer_identity
      (person_id, source_system, source_customer_id, store_id, display_name,
       email_n, phone9, name_n, match_method)
    VALUES %s
""", rows, page_size=1000)

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
print(f"\n=== IDENTITY BUILT ===")
print(f"source rows:     {total}")
print(f"distinct people: {people}")
print(f"collapsed:       {total-people} duplicate rows folded")
print(f"review queue:    {rev} ambiguous phone clusters")

print("\n=== MARTHE TEST ===")
cur.execute("""
    SELECT person_id, source_system, source_customer_id, display_name, phone9, match_method
    FROM customer_identity WHERE phone9 = '722700387'
    ORDER BY person_id, source_system
""")
mr = cur.fetchall()
for r in mr: print("  ", r)
pids = set(r[0] for r in mr)
print(f"  --> {len(mr)} source rows map to {len(pids)} person_id(s): {pids}")

conn.close()
print("\nDONE — only identity tables written. Live tables untouched.")