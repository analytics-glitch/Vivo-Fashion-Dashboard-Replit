import os, psycopg2, time, api_pg
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()

# get the REAL select_sql from the engine (no reconstruction)
defs = {n:(t,s) for n,t,s in api_pg._rollup_defs()}
table, select_sql = defs['merch_style_day']
select_recent = select_sql.replace(
    "GROUP BY p.style_name",
    "AND s.sale_date::date >= (CURRENT_DATE - 95)\n        GROUP BY p.style_name", 1)
assert "CURRENT_DATE - 95" in select_recent, "date bound not injected"

# build a TEST copy of live, apply Path 2 to it, diff vs live
cur.execute("DROP TABLE IF EXISTS rollup_msd_p2test")
cur.execute("CREATE TABLE rollup_msd_p2test (LIKE rollup_merch_style_day INCLUDING DEFAULTS)")
cur.execute("INSERT INTO rollup_msd_p2test SELECT * FROM rollup_merch_style_day")  # start = live
# watermark bound (use a far-future so all current rows qualify, matching a settled state)
cur.execute("SELECT set_config('merch.build_wm', %s, TRUE)", ("2999-01-01 00:00:00",))
t0=time.time()
cur.execute("DELETE FROM rollup_msd_p2test WHERE sale_day >= (CURRENT_DATE - 95)")
deleted=cur.rowcount
# recompute recent into the test table (redirect the INSERT target)
cur.execute("INSERT INTO rollup_msd_p2test " + select_recent.replace(" FROM all_sales s", " FROM all_sales s", 1))
inserted=cur.rowcount
conn.commit()
print(f"deleted {deleted} recent, reinserted {inserted} in {time.time()-t0:.1f}s")

# DIFF test vs live
cur.execute("""SELECT COUNT(*) FROM (SELECT * FROM rollup_merch_style_day EXCEPT SELECT * FROM rollup_msd_p2test) a""")
missing=cur.fetchone()[0]
cur.execute("""SELECT COUNT(*) FROM (SELECT * FROM rollup_msd_p2test EXCEPT SELECT * FROM rollup_merch_style_day) a""")
extra=cur.fetchone()[0]
print(f"DIFF vs live: missing={missing} extra={extra}")
# where do diffs fall — recent vs old window?
cur.execute("""SELECT COUNT(*) FROM (
  SELECT * FROM rollup_msd_p2test WHERE sale_day < (CURRENT_DATE-95)
  EXCEPT SELECT * FROM rollup_merch_style_day WHERE sale_day < (CURRENT_DATE-95)) a""")
old_diff=cur.fetchone()[0]
print(f"old-window diffs (should be 0 — we didn't touch old rows): {old_diff}")
cur.execute("DROP TABLE rollup_msd_p2test"); conn.commit(); conn.close()
