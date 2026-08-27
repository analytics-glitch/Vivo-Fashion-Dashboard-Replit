import os, requests
store="zoyaathleisure.myshopify.com"   # correct API domain (override the wrong secret)
token=os.environ["SHOPIFY_RAW_MATERIAL_TOKEN"]
headers={"X-Shopify-Access-Token":token}; API="2025-10"
url=f"https://{store}/admin/api/{API}/products.json?limit=2"
r=requests.get(url,headers=headers,timeout=60)
print("status:",r.status_code,"| store:",store)
if r.status_code==200:
    ps=r.json().get("products",[])
    print("OK. sample titles:",[p["title"] for p in ps])
    # count via shop.json
    sc=requests.get(f"https://{store}/admin/api/{API}/products/count.json",headers=headers,timeout=60)
    print("total products:", sc.json() if sc.status_code==200 else sc.status_code)
else:
    print("body:",r.text[:300])
    print("\nIf still 401: the token may belong to a different store, or the myshopify subdomain isn't 'zoyaathleisure'. Check Settings in the Shopify admin for the exact .myshopify.com domain.")
