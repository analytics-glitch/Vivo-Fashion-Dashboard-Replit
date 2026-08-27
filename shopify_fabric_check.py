import os, json, urllib.request
STORE=os.environ.get('SHOPIFY_KENYA_STORE','')
TOKEN=os.environ.get('SHOPIFY_KENYA_TOKEN','')
if STORE and not STORE.startswith('http'): STORE="https://"+STORE
if not STORE.endswith('.myshopify.com') and 'myshopify' not in STORE:
    print("STORE domain:",STORE,"(check format)")

API="2024-10"
def gql(q):
    url=f"{STORE}/admin/api/{API}/graphql.json"
    data=json.dumps({"query":q}).encode()
    req=urllib.request.Request(url,data=data,headers={
        "Content-Type":"application/json","X-Shopify-Access-Token":TOKEN})
    return json.loads(urllib.request.urlopen(req,timeout=30).read())

# 1. grab a few products with ALL their metafields
q="""{ products(first:3){ edges{ node{ 
  id title handle tags productType
  metafields(first:40){ edges{ node{ namespace key type value } } }
}}}}"""
try:
    r=gql(q)
    for e in r.get("data",{}).get("products",{}).get("edges",[]):
        n=e["node"]
        print("\n=== ",n["title"]," ===")
        print("  productType:",n.get("productType"),"| tags:",n.get("tags"))
        mfs=n.get("metafields",{}).get("edges",[])
        if not mfs: print("  (no metafields)")
        for m in mfs:
            md=m["node"]
            print(f"  metafield {md['namespace']}.{md['key']} ({md['type']}): {str(md['value'])[:80]}")
except Exception as ex:
    print("ERROR:",ex)
    print("If this is a network block, we'll run it from the deployed app instead.")
