import os, psycopg2
import customer_identity as ci

conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
conn.autocommit = False
cur = conn.cursor()
try:
    # Read nodes exactly as publish does, run the EDITED resolve()
    nodes = ci.read_nodes(cur)
    rows = ci.resolve(cur, nodes)   # <-- your edited logic, writes to registry within this txn
    # rows = list of (pid, key, system, cid, store, display, email, phone, name, method)
    people = set(r[0] for r in rows if r[9] != 'pseudo')
    print("total rows:", len(rows))
    print("real people (non-pseudo) under EDITED resolve:", len(people))
    # Marthe check
    marthe = [r for r in rows if r[7] == '254722700387' and r[9] != 'pseudo']
    print("Marthe records:", len(marthe), "-> people:", len(set(r[0] for r in marthe)))
    print("Marthe person_ids:", sorted(set(r[0] for r in marthe)))
finally:
    conn.rollback()   # discard ALL writes — nothing persists
    conn.close()
    print("rolled back — no changes written to production")
