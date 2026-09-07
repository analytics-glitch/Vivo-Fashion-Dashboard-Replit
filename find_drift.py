import os, psycopg2
conn = psycopg2.connect(os.environ['VIVO_DATABASE_URL'])
cur = conn.cursor()
# rows in snapshot (old) but NOT in current live old-window = changed/gone
cur.execute("""
  SELECT style_name, sale_day, country, pos_location_name,
         gross_units, net_revenue, units_fp, gross_sales_value
  FROM _msd_snapshot
  EXCEPT
  SELECT style_name, sale_day, country, pos_location_name,
         gross_units, net_revenue, units_fp, gross_sales_value
  FROM rollup_merch_style_day WHERE sale_day < (CURRENT_DATE - 95)
  ORDER BY sale_day DESC LIMIT 10""")
print("=== rows as they WERE (snapshot) ===")
for r in cur.fetchall(): print("  OLD:", r)
# same keys as they are NOW
cur.execute("""
  SELECT style_name, sale_day, country, pos_location_name,
         gross_units, net_revenue, units_fp, gross_sales_value
  FROM rollup_merch_style_day WHERE sale_day < (CURRENT_DATE - 95)
  EXCEPT
  SELECT style_name, sale_day, country, pos_location_name,
         gross_units, net_revenue, units_fp, gross_sales_value
  FROM _msd_snapshot
  ORDER BY sale_day DESC LIMIT 10""")
print("=== same rows as they ARE NOW (after rebuild) ===")
for r in cur.fetchall(): print("  NEW:", r)
conn.close()
