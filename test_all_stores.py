import os, requests
API = "2025-10"

pairs = [
    ("SHOPIFY_KENYA_STORE","SHOPIFY_KENYA_TOKEN"),
    ("SHOPZETU_STORE","SHOPZETU_TOKEN"),
    ("SHOPIFY_UGANDA_STORE","SHOPIFY_UGANDA_TOKEN"),
    ("SHOPIFY_RWANDA_STORE","SHOPIFY_RWANDA_TOKEN"),
]
for s_env, t_env in pairs:
    store = os.environ.get(s_env,"")
    token = os.environ.get(t_env,"")
    if not store or not token:
        print(f"{s_env}/{t_env}: missing"); continue
    r = requests.get(f"https://{store}/admin/api/{API}/shop.json",
                     headers={"X-Shopify-Access-Token": token}, timeout=30)
    if r.status_code == 200:
        shop = r.json().get("shop", {})
        print(f"{s_env} ({store}) + {t_env}: ✅ connects to '{shop.get('name')}' [{shop.get('myshopify_domain')}]")
    else:
        print(f"{s_env} ({store}) + {t_env}: ❌ {r.status_code}")