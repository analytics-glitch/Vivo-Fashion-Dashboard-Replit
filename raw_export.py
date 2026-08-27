import os, requests, csv, json, time
store=os.environ["SHOPIFY_RAW_MATERIAL_STORE"]; token=os.environ["SHOPIFY_RAW_MATERIAL_TOKEN"]
headers={"X-Shopify-Access-Token":token}; API="2025-10"
BASE=f"https://{store}/admin/api/{API}"

def get_all():
    out=[]; url=f"{BASE}/products.json?limit=250"
    while url:
        r=requests.get(url,headers=headers,timeout=60)
        if r.status_code==429:
            time.sleep(int(r.headers.get("Retry-After",5))); continue
        r.raise_for_status()
        out+=r.json().get("products",[])
        link=r.headers.get("Link",""); url=None
        for part in link.split(","):
            if 'rel="next"' in part:
                url=part[part.find("<")+1:part.find(">")]
        print("  fetched",len(out),"...")
    return out

print("store:",store)
prods=get_all()
print("TOTAL raw-material products:",len(prods))

keys=set()
for p in prods: keys.update(p.keys())
vkeys=set()
for p in prods:
    for v in p.get("variants",[]): vkeys.update(v.keys())
scalar=sorted([k for k in keys if k not in ("variants","options","images","image")])
print("product-level fields:",scalar)
print("variant-level fields:",sorted(vkeys))

mf_keys=set(); mf_by_prod={}
for i,p in enumerate(prods):
    mr=requests.get(f"{BASE}/products/{p['id']}/metafields.json",headers=headers,timeout=60)
    if mr.status_code==429:
        time.sleep(int(mr.headers.get("Retry-After",5))); mr=requests.get(f"{BASE}/products/{p['id']}/metafields.json",headers=headers,timeout=60)
    mfs=mr.json().get("metafields",[]) if mr.status_code==200 else []
    d={}
    for m in mfs:
        k=f"mf:{m['namespace']}.{m['key']}"; d[k]=m['value']; mf_keys.add(k)
    mf_by_prod[p['id']]=d
    if (i+1)%50==0: print("  metafields",i+1,"/",len(prods))
mf_keys=sorted(mf_keys)
print("metafield keys:",len(mf_keys))

def flat(v):
    if isinstance(v,(dict,list)): return json.dumps(v,ensure_ascii=False)
    return "" if v is None else str(v)
cols=scalar+["variant_"+k for k in sorted(vkeys)]+mf_keys
out="raw_materials_export.csv"
with open(out,"w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh); w.writerow(cols)
    for p in prods:
        prow=[flat(p.get(k)) for k in scalar]
        mfd=mf_by_prod.get(p['id'],{})
        mfrow=[flat(mfd.get(k)) for k in mf_keys]
        for v in (p.get("variants",[]) or [{}]):
            vrow=[flat(v.get(k)) for k in sorted(vkeys)]
            w.writerow(prow+vrow+mfrow)
print("DONE ->",out,"| products:",len(prods),"| columns:",len(cols))
