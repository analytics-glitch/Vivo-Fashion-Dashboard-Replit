import os, csv, psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()
# master with per-person order/spend rolled up from all_sales
cur.execute("""
    SELECT cm.person_id, cm.source_system, cm.source_customer_id, cm.store_id,
           cm.display_name, cm.email_n, cm.phone9, cm.needs_review, cm.review_reason,
           COALESCE(agg.orders,0), COALESCE(agg.spend_kes,0), agg.first_sale, agg.last_sale
    FROM customer_master cm
    LEFT JOIN (
        SELECT customer_id, COUNT(DISTINCT order_id) orders,
               ROUND(SUM(total_sales_kes)::numeric,0) spend_kes,
               MIN(sale_date::date) first_sale, MAX(sale_date::date) last_sale
        FROM all_sales WHERE sale_kind IN ('sale','order') GROUP BY customer_id
    ) agg ON agg.customer_id = cm.source_customer_id
    ORDER BY cm.person_id, cm.source_system
""")
rows = cur.fetchall()
conn.close()
with open("customer_master_export.csv","w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["person_id","source_system","source_id","store","name","email","phone9",
                "needs_review","review_reason","orders","spend_kes","first_sale","last_sale"])
    for r in rows: w.writerow(r)
print(f"DONE -> customer_master_export.csv ({len(rows)} rows)")