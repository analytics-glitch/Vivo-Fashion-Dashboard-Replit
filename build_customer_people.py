"""build_customer_people.py — Build the clean one-row-per-person master.
Reads customer_identity + all_sales. Writes customer_people. Idempotent.
Part of the sync so the clean master stays current."""
import os, psycopg2, logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

log.info("Building customer_people (clean one-row-per-person master)...")
cur.execute("DROP TABLE IF EXISTS customer_people")
cur.execute("""
CREATE TABLE customer_people AS
WITH person_sales AS (
    SELECT ci.person_id,
           COUNT(DISTINCT s.order_id)               AS total_orders,
           ROUND(SUM(s.total_sales_kes)::numeric,2) AS total_spend_kes,
           MIN(s.sale_date::date)                    AS first_purchase,
           MAX(s.sale_date::date)                    AS last_purchase
    FROM customer_identity ci
    JOIN all_sales s ON s.customer_id = ci.source_customer_id
    WHERE s.sale_kind IN ('sale','order')
    GROUP BY ci.person_id
),
person_attrs AS (
    SELECT ci.person_id,
           (ARRAY_AGG(ci.display_name ORDER BY LENGTH(COALESCE(ci.display_name,'')) DESC)
              FILTER (WHERE ci.display_name IS NOT NULL AND ci.display_name<>''))[1] AS name,
           (ARRAY_AGG(ci.email_n ORDER BY LENGTH(COALESCE(ci.email_n,'')) DESC)
              FILTER (WHERE ci.email_n IS NOT NULL AND ci.email_n<>''))[1]           AS email,
           (ARRAY_AGG(ci.phone9 ORDER BY LENGTH(COALESCE(ci.phone9,'')) DESC)
              FILTER (WHERE ci.phone9 IS NOT NULL AND ci.phone9<>''))[1]             AS phone,
           COUNT(*)                                  AS source_records,
           STRING_AGG(DISTINCT ci.source_system,'+' ORDER BY ci.source_system) AS systems,
           BOOL_OR(ci.match_method='pseudo')         AS is_pseudo
    FROM customer_identity ci
    GROUP BY ci.person_id
)
SELECT a.person_id, a.name, a.email, a.phone, a.source_records, a.systems, a.is_pseudo,
       COALESCE(ps.total_orders,0)    AS total_orders,
       COALESCE(ps.total_spend_kes,0) AS total_spend_kes,
       ps.first_purchase, ps.last_purchase,
       CASE WHEN COALESCE(ps.total_orders,0)>1 THEN 'Returning'
            WHEN COALESCE(ps.total_orders,0)=1 THEN 'New'
            ELSE 'No purchase' END     AS customer_type,
       EXISTS (SELECT 1 FROM customer_identity_review r
               WHERE a.phone IS NOT NULL AND r.match_key=a.phone) AS needs_review
FROM person_attrs a
LEFT JOIN person_sales ps ON ps.person_id = a.person_id
""")
cur.execute("CREATE INDEX idx_cp_person ON customer_people (person_id)")
cur.execute("CREATE INDEX idx_cp_phone  ON customer_people (phone)")
cur.execute("CREATE INDEX idx_cp_email  ON customer_people (email)")
conn.commit()

cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE NOT is_pseudo) FROM customer_people")
total, real = cur.fetchone()
log.info("✅ customer_people built: %d rows (%d real people)", total, real)
conn.close()