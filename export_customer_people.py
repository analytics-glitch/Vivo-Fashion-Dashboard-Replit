import os, csv, psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()
cur.execute("""
    SELECT person_id, name, email, phone, source_records, systems,
           is_pseudo, total_orders, total_spend_kes,
           first_purchase, last_purchase, customer_type, needs_review
    FROM customer_people
    ORDER BY total_spend_kes DESC NULLS LAST
""")
rows = cur.fetchall()
conn.close()
with open("customer_people_export.csv","w",newline="",encoding="utf-8") as fh:
    w=csv.writer(fh)
    w.writerow(["person_id","name","email","phone","source_records","systems",
                "is_pseudo","total_orders","total_spend_kes",
                "first_purchase","last_purchase","customer_type","needs_review"])
    for r in rows: w.writerow(r)
print(f"DONE -> customer_people_export.csv ({len(rows)} rows)")