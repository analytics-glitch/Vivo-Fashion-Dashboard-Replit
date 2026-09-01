"""Weekly duplicate-cluster monitor. Reads v_duplicate_clusters, tracks the
actionable real-duplicate count week-over-week, flags regressions.
Reads identity view only. Writes to a small tracking table."""
import os, psycopg2, datetime
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

# tracking table (persistent, tiny)
cur.execute("""
    CREATE TABLE IF NOT EXISTS duplicate_monitor_history (
        run_date        DATE PRIMARY KEY,
        real_dup_clusters   INT,
        suspicious_clusters INT,
        shared_junk_clusters INT,
        people_in_real_dups INT
    )
""")

# current counts from the view
cur.execute("""
    SELECT
      COUNT(*) FILTER (WHERE people BETWEEN 2 AND 4)  AS real_dup,
      COUNT(*) FILTER (WHERE people BETWEEN 5 AND 9)  AS suspicious,
      COUNT(*) FILTER (WHERE people >= 10)            AS shared_junk,
      COALESCE(SUM(people) FILTER (WHERE people BETWEEN 2 AND 4),0) AS ppl_real
    FROM v_duplicate_clusters
""")
real_dup, suspicious, shared_junk, ppl_real = cur.fetchone()
today = datetime.date.today()

# prior run for comparison
cur.execute("""SELECT real_dup_clusters FROM duplicate_monitor_history
               WHERE run_date < %s ORDER BY run_date DESC LIMIT 1""", (today,))
prior = cur.fetchone()
prior_real = prior[0] if prior else None

# store this run
cur.execute("""
    INSERT INTO duplicate_monitor_history
      (run_date, real_dup_clusters, suspicious_clusters, shared_junk_clusters, people_in_real_dups)
    VALUES (%s,%s,%s,%s,%s)
    ON CONFLICT (run_date) DO UPDATE SET
      real_dup_clusters=EXCLUDED.real_dup_clusters,
      suspicious_clusters=EXCLUDED.suspicious_clusters,
      shared_junk_clusters=EXCLUDED.shared_junk_clusters,
      people_in_real_dups=EXCLUDED.people_in_real_dups
""", (today, real_dup, suspicious, shared_junk, ppl_real))
conn.commit()

print("="*50)
print(f"DUPLICATE MONITOR — {today}")
print("="*50)
print(f"Actionable real-duplicate clusters (2-4 names): {real_dup:,}  ({ppl_real:,} people)")
print(f"Suspicious (5-9 names):                          {suspicious:,}")
print(f"Shared/junk phones (10+ names):                  {shared_junk:,}")
if prior_real is not None:
    delta = real_dup - prior_real
    if delta > 0:
        print(f"\n⚠️  REGRESSION: real-duplicate clusters UP {delta:,} vs last run ({prior_real:,} → {real_dup:,})")
        print("    Duplicates are reforming — check recent syncs / new data source.")
    elif delta < 0:
        print(f"\n✅ IMPROVED: real-duplicate clusters DOWN {abs(delta):,} ({prior_real:,} → {real_dup:,}) — review work is landing.")
    else:
        print(f"\n✅ STABLE: no change vs last run ({real_dup:,}).")
else:
    print("\n(First run — baseline recorded. Future runs compare against this.)")
conn.close()