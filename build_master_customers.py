"""Build ONE corrected master customer table with person_id + needs_review flag.
Reads customer_identity + customer_identity_review (already built) and all_customers
for display fields. Writes only to customer_master. Live tables untouched."""
import os, psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

# Create the master table (drop+recreate so it's always a clean rebuild)
cur.execute("DROP TABLE IF EXISTS customer_master")
cur.execute("""
    CREATE TABLE customer_master (
        person_id          BIGINT,
        source_system      TEXT,
        source_customer_id TEXT,
        store_id           TEXT,
        display_name       TEXT,
        email_n            TEXT,
        phone9             TEXT,
        needs_review       BOOLEAN DEFAULT FALSE,
        review_reason      TEXT,
        PRIMARY KEY (source_system, source_customer_id)
    )
""")

# Set of phone keys that are flagged ambiguous in the review queue
cur.execute("SELECT match_key FROM customer_identity_review WHERE key_type='phone'")
flagged_phones = set(r[0] for r in cur.fetchall())
print(f"flagged phone clusters: {len(flagged_phones)}")

# Pull the resolved identity
cur.execute("""
    SELECT person_id, source_system, source_customer_id, store_id,
           display_name, email_n, phone9
    FROM customer_identity
""")
rows = cur.fetchall()

from psycopg2.extras import execute_values
out = []
for (pid, sys, sid, store, name, email, ph) in rows:
    review = ph in flagged_phones and ph != ''
    reason = 'same phone, different names' if review else None
    out.append((pid, sys, sid, store, name, email, ph, review, reason))

execute_values(cur, """
    INSERT INTO customer_master
      (person_id, source_system, source_customer_id, store_id,
       display_name, email_n, phone9, needs_review, review_reason)
    VALUES %s
""", out, page_size=1000)
conn.commit()

# Stats
cur.execute("SELECT COUNT(*), COUNT(DISTINCT person_id), COUNT(*) FILTER (WHERE needs_review) FROM customer_master")
total, people, flagged = cur.fetchone()
print(f"\n=== CUSTOMER MASTER BUILT ===")
print(f"rows:            {total}")
print(f"distinct people: {people}")
print(f"flagged for review: {flagged} rows")

# Marthe check
cur.execute("""
    SELECT person_id, source_system, source_customer_id, display_name, needs_review, review_reason
    FROM customer_master WHERE phone9='722700387' ORDER BY person_id
""")
print("\nMarthe rows in master:")
for r in cur.fetchall(): print("  ", r)
conn.close()
print("\nDONE — customer_master built. Live tables untouched.")