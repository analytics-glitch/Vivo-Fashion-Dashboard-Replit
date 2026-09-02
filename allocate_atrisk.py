import os, csv, psycopg2, random
random.seed(20260902)
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()

# Pull contactable At-Risk (clean master, real people, has phone), with value band
cur.execute("""
    SELECT person_id, name, phone, email, total_spend_kes
    FROM customer_people
    WHERE NOT is_pseudo
      AND last_purchase IS NOT NULL
      AND (CURRENT_DATE - last_purchase) BETWEEN 182 AND 365
      AND phone IS NOT NULL AND phone <> ''
""")
pool = [dict(person_id=r[0], name=r[1], phone=r[2], email=r[3],
             spend=float(r[4] or 0)) for r in cur.fetchall()]
conn.close()

def band(s):
    if s >= 100000: return 'High'
    if s >= 20000:  return 'Medium'
    return 'Low'
for p in pool: p['band'] = band(p['spend'])
random.shuffle(pool)

# tests: (name, arm_size). CH4 smaller. Arms are always Test1/Test2/Control.
tests = [
    ("M1 · Relevant/newness vs generic",575),("M2 · Newness-led vs relationship-led",575),
    ("M3 · Store-specific vs Vivo-wide",575),("I1 · No incentive vs 5%",575),
    ("I2 · 5% vs 10%",575),("I3 · Recognition vs small gift",575),
    ("C1 · Emotional vs commercial",575),("C2 · Short vs longer copy",575),
    ("C3 · Product image vs text-only",575),("J1 · One vs two vs no-contact",575),
    ("J2 · 3-4d vs 7-10d reminder",575),("CH1 · WhatsApp vs SMS",575),
    ("CH2 · WhatsApp vs Email",575),("CH3 · SMS vs Email",575),
    ("CH4 · Best digital vs phone call",100),
]
ARMS = ["Test1","Test2","Control"]
EMAIL_TESTS = {"CH2 · WhatsApp vs Email","CH3 · SMS vs Email"}  # email arm needs email

# stratified draw without replacement
from collections import defaultdict
by_band = defaultdict(list)
for p in pool: by_band[p['band']].append(p)
used = set()

def draw(n, need_email=False):
    """draw n people, proportional to available band mix, without replacement."""
    avail = [p for b in by_band for p in by_band[b]
             if p['person_id'] not in used and (not need_email or (p['email'] and p['email'].strip()))]
    # proportional by band
    total = len(avail)
    if total < n: n = total
    # group avail by band, take proportional
    ab = defaultdict(list)
    for p in avail: ab[p['band']].append(p)
    picked = []
    for b in ['High','Medium','Low']:
        share = round(n * len(ab[b]) / total) if total else 0
        picked += ab[b][:share]
    # top up rounding gaps
    if len(picked) < n:
        extra = [p for p in avail if p not in picked]
        picked += extra[:n-len(picked)]
    picked = picked[:n]
    for p in picked: used.add(p['person_id'])
    return picked

rows = []
short = []
for tname, size in tests:
    for arm in ARMS:
        need_email = (tname in EMAIL_TESTS and arm in ("Test2",))  # email is the 2nd arm ("vs Email")
        got = draw(size, need_email=need_email)
        if len(got) < size:
            short.append(f"{tname}/{arm}: {len(got)}/{size}")
        for p in got:
            rows.append([tname, arm, p['person_id'], p['name'], p['phone'],
                         p['email'], round(p['spend']), p['band']])

out = "atrisk_allocation.csv"
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["test","arm","person_id","name","phone","email","spend_kes","value_band"])
    w.writerows(rows)

print(f"pool (phone, At-Risk clean): {len(pool)}")
print(f"allocated: {len(rows)}  |  unique people: {len(used)}")
print("shortfalls:", short if short else "none")
# arm balance sample
from collections import Counter
c = Counter((r[0],r[1]) for r in rows)
print("sample arm sizes:", dict(list(c.items())[:6]))
print(f"DONE -> {out}")