import xmlrpc.client, os, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

def sname(r): return (r.get("x_studio_style_name_gi") or [None,None])[1] or (r.get("x_vivo_attr_16") or [None,None])[1]
def snum(r):  return (r.get("x_style_number_text") or None) or (r.get("x_vivo_attr_18") or [None,None])[1]
FIELDS=["id","name","x_vivo_attr_16","x_studio_style_name_gi","x_vivo_attr_18","x_style_number_text"]
def base_of(nm): return re.sub(r"\s*-\s*[^-]+$","",nm).strip()

total_num=0; total_name=0
for batch,dt in [("BATCH 1","2026-06-29"),("BATCH 2","2026-08-03")]:
    ids=models.execute_kw(db,uid,pw,"product.template","search",[[["x_studio_date_retired","=",dt]]])
    recs=models.execute_kw(db,uid,pw,"product.template","read",[ids],{"fields":FIELDS})

    known_num={}
    for r in recs:
        n=snum(r)
        if n: known_num.setdefault(base_of(r["name"]), n)
    known_name={}
    for r in recs:
        sn=r.get("x_studio_style_name_gi") or r.get("x_vivo_attr_16")
        if sn: known_name.setdefault(base_of(r["name"]), sn[0])  # option id

    for r in recs:
        if not snum(r) and base_of(r["name"]) in known_num:
            models.execute_kw(db,uid,pw,"product.template","write",
                [[r["id"]], {"x_style_number_text": known_num[base_of(r["name"])]}])
            total_num+=1
        if not sname(r) and base_of(r["name"]) in known_name:
            models.execute_kw(db,uid,pw,"product.template","write",
                [[r["id"]], {"x_studio_style_name_gi": known_name[base_of(r["name"])]}])
            total_name+=1
    print(f"{batch}: backfilled")

print(f"\nDONE. Numbers backfilled: {total_num}, Names backfilled: {total_name}")
