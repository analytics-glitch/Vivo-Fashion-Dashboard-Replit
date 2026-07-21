#!/usr/bin/env python3
"""
Style Lifecycle Report
======================
Generates a comprehensive per-style report with sales, stock, and lifecycle metrics.
Run: python3 export_style_lifecycle.py
Output: style_lifecycle_report.csv in the workspace root.
"""
import psycopg2, csv, os
from datetime import date

conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()

cur.execute("""
WITH
styles AS (
    SELECT DISTINCT ON (style_number)
        style_number,
        style_name,
        status,
        tier,
        brand,
        category,
        product_type AS subcategory,
        ROUND(AVG(price) OVER (PARTITION BY style_number)) AS original_price
    FROM all_products_clean
    WHERE style_number IS NOT NULL AND style_number <> ''
    ORDER BY style_number,
        CASE WHEN category = 'Accessories' THEN 1 ELSE 0 END,
        CASE WHEN product_name ~ ' / [A-Z0-9]+ / ' THEN 1 ELSE 0 END,
        sku
),
launch AS (
    SELECT p.style_number, MIN(s.sale_date::date) AS launch_date
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_kind IN ('sale','order') AND p.style_number IS NOT NULL
    GROUP BY p.style_number
),
last_activity AS (
    SELECT p.style_number,
           MAX(s.sale_date::date) AS last_sale_date,
           MAX(CASE WHEN s.sale_kind = 'order' THEN s.sale_date::date END) AS last_order_date
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE p.style_number IS NOT NULL
    GROUP BY p.style_number
),
sales_6m AS (
    SELECT p.style_number,
           SUM(s.ordered_item_quantity) FILTER (WHERE s.sale_kind IN ('sale','order')) AS units_6m,
           ROUND(SUM(s.total_sales_kes::numeric - s.discounts_kes::numeric)
               FILTER (WHERE s.sale_kind IN ('sale','order'))) AS revenue_6m,
           ROUND(SUM(s.total_sales_kes::numeric)
               FILTER (WHERE s.sale_kind IN ('sale','order')
                         AND s.discounts_kes::numeric = 0)) AS full_price_rev,
           ROUND(SUM(s.total_sales_kes::numeric)
               FILTER (WHERE s.sale_kind IN ('sale','order'))) AS gross_rev_6m
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '182 days'
      AND p.style_number IS NOT NULL
    GROUP BY p.style_number
),
sales_3w AS (
    SELECT p.style_number,
           SUM(s.ordered_item_quantity) FILTER (WHERE s.sale_kind IN ('sale','order')) AS units_3w
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '21 days'
      AND p.style_number IS NOT NULL
    GROUP BY p.style_number
),
stock AS (
    SELECT p.style_number,
           SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (
               'Warehouse Finished Goods','Warehouse Receiving','In Transit',
               'Holding Warehouse Finished Goods','Finished Goods Production',
               'Production','Buying & Merchandise','Raw Materials','Fabric Trimming',
               'Dead Stock Fabric','Cutting - Spreading','Washing','Wandia',
               'Galleria Holding','Studio Location','Product Development','Repairs',
               'Sampling Fabric','Sampling','Sale Stock','Shopping Bags',
               'Recall Location','Fabric Production','Defects Location',
               'Staff purchases','Sew/Stock/A','Sew/Stock/B','Sew/Stock/C',
               'Sew/Stock/D','Sew/Stock/E')) AS soh_stores,
           SUM(i.available) FILTER (WHERE i.pos_location_name IN (
               'Warehouse Finished Goods','Warehouse Receiving','In Transit',
               'Holding Warehouse Finished Goods')
               AND i.pos_location_name NOT IN (
               'Fabric Trimming','Finished Goods Production','Sew/Stock/A',
               'Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E')) AS soh_wh,
           SUM(i.available) AS soh_total
    FROM all_inventory i
    JOIN all_products_clean p ON p.sku = i.sku
    WHERE p.style_number IS NOT NULL AND i.available > 0
    GROUP BY p.style_number
)
SELECT
    st.style_number,
    st.style_name,
    COALESCE(st.status, '') AS status,
    COALESCE(st.tier, '') AS tier,
    la.launch_date,
    act.last_order_date,
    ROUND(COALESCE(sk.soh_total, 0)) AS soh_total,
    ROUND(COALESCE(s6.units_6m, 0) / 26.0, 1) AS sor_6m_weekly,
    COALESCE(s6.revenue_6m, 0) AS revenue_6m,
    st.brand,
    st.category,
    st.subcategory,
    ROUND((CURRENT_DATE - la.launch_date) / 365.25, 1) AS age_years,
    (CURRENT_DATE - la.launch_date) / 7 AS age_weeks,
    COALESCE(s6.units_6m, 0) AS units_6m,
    CASE WHEN COALESCE(s6.units_6m, 0) > 0
         THEN ROUND(s6.gross_rev_6m / s6.units_6m) ELSE 0 END AS asp,
    CASE WHEN act.last_order_date IS NOT NULL
         THEN (CURRENT_DATE - act.last_order_date) ELSE NULL END AS days_since_last_order,
    COALESCE(s3.units_3w, 0) AS units_3w,
    ROUND(COALESCE(sk.soh_wh, 0)) AS soh_wh,
    COALESCE(st.original_price, 0) AS original_price,
    CASE WHEN COALESCE(s6.gross_rev_6m, 0) > 0
         THEN ROUND(100.0 * COALESCE(s6.full_price_rev, 0) / s6.gross_rev_6m, 1)
         ELSE 0 END AS pct_full_price,
    CASE WHEN act.last_sale_date IS NOT NULL
         THEN (CURRENT_DATE - act.last_sale_date) ELSE NULL END AS days_since_last_sale,
    ROUND(COALESCE(s3.units_3w, 0) / 3.0, 1) AS weekly_avg_3w,
    CASE WHEN COALESCE(s3.units_3w, 0) > 0
         THEN ROUND(COALESCE(sk.soh_total, 0) / (COALESCE(s3.units_3w, 0) / 3.0), 1)
         ELSE NULL END AS weeks_of_cover,
    ROUND(COALESCE(sk.soh_total, 0) * COALESCE(st.original_price, 0)) AS inventory_value
FROM styles st
LEFT JOIN launch la ON la.style_number = st.style_number
LEFT JOIN last_activity act ON act.style_number = st.style_number
LEFT JOIN sales_6m s6 ON s6.style_number = st.style_number
LEFT JOIN sales_3w s3 ON s3.style_number = st.style_number
LEFT JOIN stock sk ON sk.style_number = st.style_number
ORDER BY COALESCE(s6.revenue_6m, 0) DESC NULLS LAST
""")

rows = cur.fetchall()
conn.close()

out = "/home/runner/workspace/style_lifecycle_report.csv"
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow([
        "Style Number","Style Name","Status","Tier","Style Launch Date",
        "Last Order Date","Stock On Hand","6M SOR (weekly)","6M Revenue (KES)",
        "Brand","Category","Sub Category","Style Age (Years)","Style Age (Weeks)",
        "6M Units Sold","ASP","Days Since Last Order","3 Wks Units Sold",
        "Stock in W/H","Original Price","% Full Price","Days Since Last Sale",
        "Weekly Average","Weeks of Cover","Inventory Value (KES)"
    ])
    w.writerows(rows)

print(f"Wrote {out}")
print(f"{len(rows)} styles exported")
print(f"Run date: {date.today()}")
