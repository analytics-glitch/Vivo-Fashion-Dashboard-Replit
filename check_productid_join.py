"""
Verify we can match Odoo's missing-field products to all_products_clean by an
EXACT key (product_id), and that clean has a real style number/name for them.
This avoids the dangerous name-prefix mismatch.
"""
import os, psycopg2, psycopg2.extras, xmlrpc.client
# --- Replit side ---
conn=psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit=True
cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# --- Odoo side ---
url=os.environ["ODOO_URL"]; db=os.environ["ODOO_DB"]
user=os.environ["ODOO_USER"]; pw=os.environ["ODOO_PASSWORD"]
common=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
uid=common.authenticate(db,user,pw,{})
models=xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
def ex(m,meth,*a,**k): return models.execute_kw(db,uid,pw,m,meth,list(a),k or {})

# Odoo finished-goods templates missing style number
cats=ex("product.category","search",[["name","ilike","Finished Goods"]])
tids=ex("product.template","search",[["categ_id","in",cats]])
recs=ex("product.template","read",tids,fields=["id","name","x_vivo_attr_18","x_style_number_text","product_variant_ids"])
missing=[r for r in recs if not ((r.get("x_style_number_text") or "").strip() or r.get("x_vivo_attr_18"))]
print(f"Odoo FG templates missing style number: {len(missing)}")

# For each, get its variant product ids, and look up all_products_clean by product_id
checked=0; clean_has_real=0; clean_has_sample=0; clean_none=0
examples=[]
for r in missing[:300]:
    vids=r.get("product_variant_ids") or []
    if not vids: 
        clean_none+=1; continue
    # all_products_clean.product_id is likely the variant id (product.product id)
    cur.execute("""SELECT style_number, style_name FROM all_products_clean
                   WHERE product_id = ANY(%s) AND style_number IS NOT NULL
                   AND style_number <> '' LIMIT 1""", ([int(v) for v in vids],))
    row=cur.fetchone()
    checked+=1
    if not row:
        clean_none+=1
    elif (row["style_number"] or "").strip().lower().startswith("sample"):
        clean_has_sample+=1
    else:
        clean_has_real+=1
        if len(examples)<15:
            examples.append((r["name"], row["style_number"], row["style_name"]))
print(f"\nOf {checked} checked (by product_id exact join):")
print(f"   clean has REAL style number : {clean_has_real}")
print(f"   clean has 'Sample' bucket    : {clean_has_sample}")
print(f"   clean has nothing            : {clean_none}")
print("\nExamples (odoo name -> clean.style_number / clean.style_name):")
for nm,sn,snm in examples:
    print(f"   {nm[:45]:<45} -> {sn} / {snm}")
conn.close()
