import os, re, csv, psycopg2

def last9(s):
    d=re.sub(r'[^0-9]','',s or ''); return d[-9:] if len(d)>=9 else ''
def nemail(s): return (s or '').strip().lower()

conn=psycopg2.connect(os.environ['DATABASE_URL']); cur=conn.cursor()

# Odoo match-set (same as before)
print("loading Odoo match-set...")
cur.execute("SELECT shopify_user_id, phone, mobile, email FROM raw_odoo_customers")
odoo_sids=set(); odoo_phones=set(); odoo_emails=set()
for sid,phone,mobile,email in cur.fetchall():
    if sid: odoo_sids.add(str(sid))
    p=last9(phone) or last9(mobile)
    if p: odoo_phones.add(p)
    e=nemail(email)
    if e: odoo_emails.add(e)
print(f"Odoo: {len(odoo_sids)} ids, {len(odoo_phones)} phones, {len(odoo_emails)} emails")

# vivowoman customers from raw_shopify_customers
print("pulling vivowoman from raw_shopify_customers...")
cur.execute("""
    SELECT DISTINCT ON (id, store_id)
        id, first_name, last_name, email, phone, total_spent, orders_count, created_at
    FROM raw_shopify_customers
    WHERE store_id = 'vivowoman'
    ORDER BY id, store_id, _loaded_at DESC
""")
custs=cur.fetchall()
conn.close()
print(f"vivowoman: {len(custs)} customers")

# APPEND to the same CSV the live script wrote
n_linked=n_idmatch=n_not=0
with open("shopify_live_not_in_odoo.csv","a",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    for (cid,fn,ln,email,phone,spent,oc,created) in custs:
        sid=str(cid)
        linked = sid in odoo_sids
        idmatch = (last9(phone)!='' and last9(phone) in odoo_phones) or (nemail(email)!='' and nemail(email) in odoo_emails)
        if linked:
            n_linked+=1; continue
        if idmatch:
            n_idmatch+=1; cls="in Odoo by identity (not linked)"
        else:
            n_not+=1; cls="NOT in Odoo at all"
        w.writerow([cls,"vivowoman",sid,fn,ln,email,phone,spent,oc,str(created)[:10]])
print("\n=== VIVOWOMAN RESULTS ===")
print(f"linked to Odoo:                   {n_linked}")
print(f"in Odoo by identity (not linked): {n_idmatch}")
print(f"NOT in Odoo at all:               {n_not}")
print("appended to shopify_live_not_in_odoo.csv")