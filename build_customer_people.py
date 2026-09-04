"""build_customer_people.py — clean one-row-per-person master.
Most-common name per person. Build-then-swap (no long lock). Reads customer_identity + all_sales."""
import os, psycopg2, logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

log.info("Building customer_people_new (most-common name, no lock on live)...")
cur.execute("DROP TABLE IF EXISTS customer_people_new")
cur.execute("""
CREATE TABLE customer_people_new AS
WITH person_sales AS (
    SELECT ci.person_id, COUNT(DISTINCT s.order_id) AS total_orders,
           ROUND(SUM(s.total_sales_kes)::numeric,2) AS total_spend_kes,
           MIN(s.sale_date::date) AS first_purchase, MAX(s.sale_date::date) AS last_purchase
    FROM customer_identity ci
    JOIN all_sales s ON s.customer_id = ci.source_customer_id
    WHERE s.sale_kind IN ('sale','order')
    GROUP BY ci.person_id
),
name_ranked AS (
    SELECT person_id, display_name,
           ROW_NUMBER() OVER (PARTITION BY person_id
             ORDER BY COUNT(*) DESC, LENGTH(display_name) DESC) AS rn
    FROM customer_identity
    WHERE display_name IS NOT NULL AND display_name <> ''
    GROUP BY person_id, display_name
),
person_attrs AS (
    SELECT ci.person_id,
      (SELECT display_name FROM name_ranked nr WHERE nr.person_id=ci.person_id AND nr.rn=1) AS name,
      (ARRAY_AGG(ci.email_n ORDER BY LENGTH(COALESCE(ci.email_n,'')) DESC)
         FILTER (WHERE ci.email_n IS NOT NULL AND ci.email_n<>''))[1] AS email,
      (ARRAY_AGG(ci.phone9 ORDER BY LENGTH(COALESCE(ci.phone9,'')) DESC)
         FILTER (WHERE ci.phone9 IS NOT NULL AND ci.phone9<>''))[1] AS phone,
      COUNT(*) AS source_records,
      STRING_AGG(DISTINCT ci.source_system,'+' ORDER BY ci.source_system) AS systems,
      BOOL_OR(ci.match_method='pseudo') AS is_pseudo
    FROM customer_identity ci GROUP BY ci.person_id
)
SELECT a.person_id, a.name, a.email, a.phone, a.source_records, a.systems, a.is_pseudo,
       COALESCE(ps.total_orders,0) AS total_orders,
       COALESCE(ps.total_spend_kes,0) AS total_spend_kes,
       ps.first_purchase, ps.last_purchase,
       CASE WHEN COALESCE(ps.total_orders,0)>1 THEN 'Returning'
            WHEN COALESCE(ps.total_orders,0)=1 THEN 'New' ELSE 'No purchase' END AS customer_type
FROM person_attrs a LEFT JOIN person_sales ps ON ps.person_id=a.person_id
""")
cur.execute("DROP TABLE IF EXISTS customer_people_old")
cur.execute("ALTER TABLE customer_people RENAME TO customer_people_old")
cur.execute("ALTER TABLE customer_people_new RENAME TO customer_people")
cur.execute("DROP TABLE customer_people_old")
cur.execute("DROP INDEX IF EXISTS idx_cp_person_n")
cur.execute("DROP INDEX IF EXISTS idx_cp_phone_n")
cur.execute("DROP INDEX IF EXISTS idx_cp_email_n")
cur.execute("CREATE INDEX idx_cp_person_n ON customer_people(person_id)")
cur.execute("CREATE INDEX idx_cp_phone_n ON customer_people(phone)")
cur.execute("CREATE INDEX idx_cp_email_n ON customer_people(email)")
conn.commit()
cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE NOT is_pseudo) FROM customer_people")
t,r=cur.fetchone()
log.info("✅ customer_people built: %d rows (%d real people)", t, r)
conn.close()