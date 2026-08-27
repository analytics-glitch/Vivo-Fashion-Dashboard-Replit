import requests
store="zoyaathleisure.myshopify.com"
token="atkn_c0fb5945f81dcafdb6f23da75438e2d23cb84756dfa916ae8dd16c7d05705a53"
API="2025-10"
# try as standard access token header
for hdr in ["X-Shopify-Access-Token"]:
    r=requests.get(f"https://{store}/admin/api/{API}/products.json?limit=1",
                   headers={hdr:token},timeout=30)
    print(hdr,"->",r.status_code, r.text[:150])
# try bearer
r=requests.get(f"https://{store}/admin/api/{API}/products.json?limit=1",
               headers={"Authorization":f"Bearer {token}"},timeout=30)
print("Bearer ->",r.status_code, r.text[:150])
