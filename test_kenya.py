import os, requests
STORE = "vivowoman.myshopify.com"
API = "2025-10"

# Test every token we have against the vivowoman store
tokens = {
    "SHOPIFY_KENYA_TOKEN":  os.environ.get("SHOPIFY_KENYA_TOKEN",""),
    "SHOPZETU_TOKEN":       os.environ.get("SHOPZETU_TOKEN",""),
    "SHOPIFY_UGANDA_TOKEN": os.environ.get("SHOPIFY_UGANDA_TOKEN",""),
    "SHOPIFY_RWANDA_TOKEN": os.environ.get("SHOPIFY_RWANDA_TOKEN",""),
}
for name, tok in tokens.items():
    if not tok:
        print(f"{name}: (empty)"); continue
    r = requests.get(f"https://{STORE}/admin/api/{API}/shop.json",
                     headers={"X-Shopify-Access-Token": tok}, timeout=30)
    if r.status_code == 200:
        shop = r.json().get("shop", {})
        print(f"{name}: ✅ 200 — connects to '{shop.get('name')}' ({shop.get('myshopify_domain')})")
    else:
        print(f"{name}: ❌ {r.status_code}")