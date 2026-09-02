import os, csv, psycopg2, random
random.seed(20260902)
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()

# already-allocated person_ids (from the At-Risk run) — exclude them
used = set()
with open('atrisk_allocation.csv') as f:
    r=csv.DictReader(f)
    for row in r: used.add(row['person_id'])
print("already allocated (At-Risk):", len(used))

# Pull contactable TRUE CHURN (12+ months), clean, has phone, not already used
cur.execute("""
    SELECT person_id, name, phone, email, total_spend_kes
    FROM customer_people
    WHERE NOT is_pseudo
      AND last_purchase IS NOT NULL
      AND (CURRENT_DATE - last_purchase) > 365
      AND phone IS NOT NULL AND phone <> ''
""")
pool = [dict(person_id=str(r[0]), name=r[1], phone=r[2], email=r[3], spend=float(r[4] or 0))
        for r in cur.fetchall() if str(r[0]) not in used]
conn.close()
print("True Churn pool (clean, phone, unused):", len(pool))

def band(s):
    if s>=100000: return 'High'
    if s>=20000:  return 'Medium'
    return 'Low'
for p in pool: p['band']=band(p['spend'])
random.shuffle(pool)

# stratified draw without replacement
from collections import defaultdict
def draw(n):
    avail=[p for p in pool if p['person_id'] not in used]
    total=len(avail)
    if total<n: n=total
    ab=defaultdict(list)
    for p in avail: ab[p['band']].append(p)
    picked=[]
    for b in ['High','Medium','Low']:
        picked += ab[b][:round(n*len(ab[b])/total)]
    if len(picked)<n:
        picked += [p for p in avail if p not in picked][:n-len(picked)]
    picked=picked[:n]
    for p in picked: used.add(p['person_id'])
    return picked

rows=[]
for arm in ['Test1','Test2']:
    got=draw(800)
    if len(got)<800: print(f"SHORT {arm}: {len(got)}/800")
    for p in got:
        rows.append(["M1 · Relevant/newness vs generic", arm, "True Churn",
                     p['person_id'], p['name'], p['phone'], p['email'], round(p['spend']), p['band']])

out="m1_truechurn_add.csv"
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["test","arm","cohort","person_id","name","phone","email","spend_kes","value_band"])
    w.writerows(rows)
print(f"allocated True Churn to M1: {len(rows)} (Test1+Test2)")
print(f"DONE -> {out}")