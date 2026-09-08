import os, psycopg2, time
import customer_identity as ci
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
conn.autocommit = False
cur = conn.cursor()
try:
    t0 = time.time()
    nodes = ci.read_nodes(cur)
    rows = ci.resolve(cur, nodes)
    elapsed = time.time() - t0
    people = set(r[0] for r in rows if r[9] != 'pseudo')
    print(f"resolve() ran in {elapsed:.1f}s")
    print("total rows:", len(rows))
    print("real people (non-pseudo):", len(people))
    marthe = [r for r in rows if r[7] == '254722700387' and r[9] != 'pseudo']
    print("Marthe records:", len(marthe), "-> people:", len(set(r[0] for r in marthe)))
finally:
    conn.rollback()
    conn.close()
    print("rolled back — production untouched")
