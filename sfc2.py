import os, json
import requests
store=os.environ["SHOPIFY_KENYA_STORE"]
token=os.environ["SHOPIFY_KENYA_TOKEN"]
headers={"X-Shopify-Access-Token":token}
API="2025-10"

# 1. get 3 products (REST, exact working pattern)
url=f"https://{store}/admin/api/{API}/products.json"
r=requests.get(url,headers=headers,params={"limit":3},timeout=60)
print("products.json status:",r.status_code)
if r.status_code!=200:
    print("body:",r.text[:300]); raise SystemExit
prods=r.json().get("products",[])
for p in prods:
    print(f"\n=== {p['title']} (id {p['id']}) ===")
    print("  product_type:",p.get("product_type"),"| tags:",p.get("tags"))
    print("  body_html (first 200):",(p.get("body_html") or "")[:200].replace("\n"," "))
    # 2. metafields for this product
    murl=f"https://{store}/admin/api/{API}/products/{p['id']}/metafields.json"
    mr=requests.get(murl,headers=headers,timeout=60)
    if mr.status_code==200:
        mfs=mr.json().get("metafields",[])
        if not mfs: print("  (no metafields)")
        for m in mfs:
            print(f"  metafield {m['namespace']}.{m['key']} ({m.get('type')}): {str(m['value'])[:80]}")
    else:
        print("  metafields status:",mr.status_code, mr.text[:150])
