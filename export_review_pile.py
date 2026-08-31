"""Export the needs_review rows to CSV, grouped by phone cluster so a reviewer
can work each cluster together. Reads customer_master + all_sales (read-only)."""
import os, csv, psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

# Pull flagged rows + per-source order/spend so reviewer can see who's the real customer
cur.execute("""
    SELECT cm.phone9, cm.person_id, cm.source_system, cm.source_customer_id,
           cm.store_id, cm.display_name, cm.email_n,
           COALESCE(agg.orders,0) AS orders,
           COALESCE(agg.spend_kes,0) AS spend_kes,
           agg.first_sale, agg.last_sale
    FROM customer_master cm
    LEFT JOIN (
        SELECT customer_id,
               COUNT(DISTINCT order_id) AS orders,
               ROUND(SUM(total_sales_kes)::numeric,0) AS spend_kes,
               MIN(sale_date::date) AS first_sale,
               MAX(sale_date::date) AS last_sale
        FROM all_sales
        WHERE sale_kind IN ('sale','order')
        GROUP BY customer_id
    ) agg ON agg.customer_id = cm.source_customer_id
    WHERE cm.needs_review
    ORDER BY cm.phone9, cm.display_name, cm.source_system
""")
rows = cur.fetchall()
conn.close()

out = "review_pile.csv"
with open(out, "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["cluster_phone","current_person_id","source_system","source_id",
                "store","name","email","orders","spend_kes","first_sale","last_sale",
                "REVIEWER_DECISION"])
    for r in rows:
        w.writerow(list(r) + [""])   # blank column for the reviewer to fill
print(f"DONE -> {out}  ({len(rows)} rows)")