import xmlrpc.client, os, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

m={}
for line in open("/home/runner/workspace/b2_leftover_map.tsv",encoding="utf-8"):
    if "\t" in line:
        k,v=line.rstrip("\n").split("\t"); m[k.strip().lower()]=v.strip()

def snum(r): return (r.get("x_style_number_text") or None) or (r.get("x_vivo_attr_18") or [None,None])[1]
def base_of(nm): return re.sub(r"\s*-\s*[^-]+$","",nm).strip()
FIELDS=["id","name","x_vivo_attr_18","x_style_number_text","x_studio_date_retired","x_vivo_attr_97"]

for base_lower, num in m.items():
    # ALL templates (retired or not) whose base name matches
    # search by name begins-with the base (case-insensitive-ish via ilike)
    ids=models.execute_kw(db,uid,pw,"product.template","search",[[["name","=ilike", base_lower+"%"]]])
    recs=models.execute_kw(db,uid,pw,"product.template","read",[ids],{"fields":FIELDS})
    # keep only those whose computed base matches exactly (avoid "Vivo Trench Coat Dress" catching "Vivo Trench Coat")
    exact=[r for r in recs if base_of(r["name"]).lower()==base_lower]
    retired=[r for r in exact if r.get("x_studio_date_retired")=="2026-08-03"]
    active =[r for r in exact if r.get("x_studio_date_retired")!="2026-08-03"]
    # distinct existing numbers among exact matches
    nums=set(filter(None,(snum(r) for r in exact)))
    flag=""
    if active: flag+=f" ⚠️ {len(active)} NOT-in-batch templates share this name"
    if len(nums)>1: flag+=f" ⚠️ multiple existing numbers: {nums}"
    print(f"{base_lower[:40]:<40} -> {num} | exact={len(exact)} retired={len(retired)} active={len(active)} blanks={sum(1 for r in exact if not snum(r))}{flag}")
