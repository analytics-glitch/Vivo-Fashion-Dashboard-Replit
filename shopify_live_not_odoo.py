import os, re, csv, time, requests, psycopg2

# Four stores: (env_store, env_token, label)
STORES = [
    ("SHOPIFY_KENYA_STORE","SHOPIFY_KENYA_TOKEN","vivowoman"),
    ("SHOPIFY_UGANDA_STORE","SHOPIFY_UGANDA_TOKEN","uganda"),
    ("SHOPIFY_RWANDA_STORE","SHOPIFY_RWANDA_TOKEN","rwanda"),
    ("SHOPZETU_STORE","SHOPZETU_TOKEN","shop-zetu"),
]
API="2025-10"
def last9(s):
    d=re.sub(r'[^0-9]','',s or ''); return d[-9:] if len(d)>=9 else ''
def nemail(s): return (s or '').strip().lower()

# 1. Build Odoo match sets from the DB (fast)
print("loading Odoo match-set from raw_odoo_customers...")
conn=psycopg2.connect(os.environ['DATABASE_URL']); cur=conn.cursor()
cur.execute("""
    SELECT shopify_user_id, phone, mobile, email FROM raw_odoo_customers
""")
odoo_sids=set(); odoo_phones=set(); odoo_emails=set()
for sid,phone,mobile,email in cur.fetchall():
    if sid: odoo_sids.add(str(sid))
    p=last9(phone) or last9(mobile)
    if p: odoo_phones.add(p)
    e=nemail(email)
    if e: odoo_emails.add(e)
conn.close()
print(f"Odoo: {len(odoo_sids)} linked ids, {len(odoo_phones)} phones, {len(odoo_emails)} emails")

# 2. Pull each Shopify store live
def pull_store(store,token):
    out=[]
    url=f"https://{store}/admin/api/{API}/customers.json?limit=250"
    while url:
        r=requests.get(url,headers={"X-Shopify-Access-Token":token},timeout=60)
        if r.status_code==429:
            time.sleep(int(r.headers.get("Retry-After",5))); continue
        if r.status_code!=200:
            print("  ERROR",r.status_code,r.text[:150]); break
        out+=r.json().get("customers",[])
        link=r.headers.get("Link",""); url=None
        for part in link.split(","):
            if 'rel="next"' in part: url=part[part.find("<")+1:part.find(">")]
        print(f"    {len(out)} so far...")
    return out

out="shopify_live_not_in_odoo.csv"
n_linked=n_idmatch=n_not=0
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["classification","store","shopify_id","first_name","last_name",
                "email","phone","total_spent","orders_count","created_at"])
    for env_store,env_token,label in STORES:
        store=os.environ.get(env_store,""); token=os.environ.get(env_token,"")
        if not store or not token:
            print(f"! {label}: missing secret, skipping"); continue
        print(f"pulling {label} ({store})...")
        custs=pull_store(store,token)
        print(f"  {label}: {len(custs)} customers")
        for c in custs:
            sid=str(c.get("id"))
            email=c.get("email"); phone=c.get("phone")
            # shopify customer phone can be on default_address too
            if not phone and c.get("default_address"):
                phone=c["default_address"].get("phone")
            linked = sid in odoo_sids
            idmatch = (last9(phone)!='' and last9(phone) in odoo_phones) or (nemail(email)!='' and nemail(email) in odoo_emails)
            if linked:
                n_linked+=1; continue
            if idmatch:
                n_idmatch+=1; cls="in Odoo by identity (not linked)"
            else:
                n_not+=1; cls="NOT in Odoo at all"
            w.writerow([cls,label,sid,c.get("first_name"),c.get("last_name"),
                        email,phone,c.get("total_spent"),c.get("orders_count"),
                        str(c.get("created_at"))[:10]])
print("\n=== RESULTS ===")
print(f"linked to Odoo:                       {n_linked}")
print(f"in Odoo by identity (not linked):     {n_idmatch}")
print(f"NOT in Odoo at all:                   {n_not}")
print(f"\nLink-based 'not in Odoo'     = {n_idmatch + n_not}")
print(f"Identity-based 'not in Odoo' = {n_not}")
print("DONE ->",out)