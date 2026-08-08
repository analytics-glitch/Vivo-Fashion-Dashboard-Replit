import xmlrpc.client, os, csv, re
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

# Load the leftovers CSV we just made
gaps=list(csv.DictReader(open("/home/runner/workspace/style_field_gaps.csv")))
print(f"Leftover templates: {len(gaps)}")

# We need the batch sheets' Name->Number map. Those live on the analyst side, not here.
# Instead, derive base style name from each leftover's product name and show it,
# so we can see how many are real styles vs placeholders.
def base_of(nm): return re.sub(r"\s*-\s*[^-]+$","",nm).strip()
placeholder=0; real=0
bases={}
for g in gaps:
    nm=g["Product Name"]
    if re.search(r"(RFS|FS)\s*\d*\s*$", nm) or "Sample" in nm or "Special Offer" in nm:
        placeholder+=1
    else:
        real+=1
    bases.setdefault(base_of(nm), []).append(g["Product Name"])

print(f"Looks like placeholder/RFS/FS/sample: {placeholder}")
print(f"Looks like real styles: {real}")
print(f"\nDistinct base style names among leftovers: {len(bases)}")
for b in sorted(bases)[:40]:
    print(f"   {b}")
