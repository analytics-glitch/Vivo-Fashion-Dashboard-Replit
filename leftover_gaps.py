import xmlrpc.client, os, csv
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

def sname(r): return (r.get("x_studio_style_name_gi") or [None,None])[1] or (r.get("x_vivo_attr_16") or [None,None])[1]
def snum(r):  return (r.get("x_style_number_text") or None) or (r.get("x_vivo_attr_18") or [None,None])[1]
FIELDS=["id","name","x_vivo_attr_16","x_studio_style_name_gi","x_vivo_attr_18","x_style_number_text"]

rows=[]
for batch,dt in [("Batch 1","2026-06-29"),("Batch 2","2026-08-03")]:
    ids=models.execute_kw(db,uid,pw,"product.template","search",[[["x_studio_date_retired","=",dt]]])
    recs=models.execute_kw(db,uid,pw,"product.template","read",[ids],{"fields":FIELDS})
    for r in recs:
        miss=[]
        if not sname(r): miss.append("Style Name")
        if not snum(r):  miss.append("Style Number")
        if miss:
            rows.append([batch, r["id"], r["name"], "; ".join(miss),
                         sname(r) or "", snum(r) or ""])

with open("/home/runner/workspace/style_field_gaps.csv","w",newline="",encoding="utf-8") as f:
    w=csv.writer(f)
    w.writerow(["Batch","Template ID","Product Name","Missing","Current Style Name","Current Style Number"])
    w.writerows(rows)
print(f"Wrote style_field_gaps.csv with {len(rows)} rows")
# quick summary
from collections import Counter
c=Counter((r[0], r[3]) for r in rows)
for k,v in sorted(c.items()): print(f"  {k[0]} — {k[1]}: {v}")
