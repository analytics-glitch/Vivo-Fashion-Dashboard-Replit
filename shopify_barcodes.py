import os, requests, csv, json, time
# Kenya / Shop Zetu store — the working token
store=os.environ["SHOPIFY_KENYA_STORE"]; token=os.environ["SHOPIFY_KENYA_TOKEN"]
headers={"X-Shopify-Access-Token":token}; API="2025-10"
BASE=f"https://{store}/admin/api/{API}"

# Pull ALL variants (sku -> barcode) across the catalogue via products pagination.
# Shopify REST products include variants with sku+barcode.
sku_barcode={}
url=f"{BASE}/products.json?limit=250&fields=id,variants"
pages=0
while url:
    r=requests.get(url,headers=headers,timeout=60)
    if r.status_code==429:
        time.sleep(int(r.headers.get("Retry-After",5))); continue
    if r.status_code!=200:
        print("ERROR",r.status_code,r.text[:200]); break
    for p in r.json().get("products",[]):
        for v in p.get("variants",[]):
            sku=(v.get("sku") or "").strip()
            bc=(v.get("barcode") or "").strip()
            if sku and bc and sku not in sku_barcode:
                sku_barcode[sku]=bc
    pages+=1
    link=r.headers.get("Link",""); url=None
    for part in link.split(","):
        if 'rel="next"' in part: url=part[part.find("<")+1:part.find(">")]
    if pages%10==0: print(f"  page {pages}, {len(sku_barcode)} sku->barcode so far")
print("TOTAL sku->barcode from Shopify Kenya:",len(sku_barcode))

# write full map
with open("shopify_sku_barcode.csv","w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh); w.writerow(["sku","barcode"])
    for s,b in sku_barcode.items(): w.writerow([s,b])
print("DONE -> shopify_sku_barcode.csv")
