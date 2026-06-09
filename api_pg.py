from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from datetime import date, timedelta
import psycopg2
import psycopg2.extras
import os
import time
import hashlib

_cache = {}

def smart_ttl(date_to=None):
    if not date_to:
        return 120
    try:
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        if date_to >= today:       return 120
        elif date_to >= yesterday: return 600
        else:                      return 3600
    except Exception:
        return 120

def cache_get(key):
    if key in _cache:
        val, ts, ttl = _cache[key]
        if time.time() - ts < ttl:
            return val
        del _cache[key]
    return None

def cache_set(key, val, ttl=120):
    _cache[key] = (val, time.time(), ttl)

def get_conn():
    return psycopg2.connect(os.environ['DATABASE_URL'])

def run_query(query, date_to=None):
    key = hashlib.md5(query.encode()).hexdigest()
    cached = cache_get(key)
    if cached is not None:
        return cached
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    cache_set(key, rows, ttl=smart_ttl(date_to))
    return rows

app = FastAPI(title="Vivo Fashion Group BI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_FILTERS = """
    s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda','vivowoman')
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%shopping bag%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%gift card%'
    AND LOWER(COALESCE(s.variant_sku,'')) NOT LIKE '%vb00%'
"""

PRODUCT_SUBCATS = [
    "Knee Length Dresses","Full Length Pants","Fitted Tops","Loose Tops",
    "Maxi Dresses","Waterfalls & Kimonos","Sweaters & Ponchos","Midi & Capri Dresses",
    "T-shirts & Tank Tops","Bodysuits","Jackets & Coats","Leggings",
    "Shorts & Skorts","Knee Length Skirts","Jumpsuits & Playsuits","Midriff & Crop Tops",
    "Maxi Skirts","Short & Mini Dresses","Culottes & Capri Pants",
    "Hoodies & Sweatshirts","Two-Piece Sets","Scarves","Accessories",
]

WAREHOUSE_LOCATIONS = (
    "'Warehouse Finished Goods','Warehouse Receiving','In Transit',"
    "'Holding Warehouse Finished Goods','Finished Goods Production','Production',"
    "'Buying & Merchandise','Raw Materials','Fabric Trimming','Dead Stock Fabric',"
    "'Cutting - Spreading','Washing','Wandia','Galleria Holding','Studio Location',"
    "'Product Development','Repairs','Sampling Fabric','Sampling','Sale Stock',"
    "'Shopping Bags','Recall Location','Fabric Production','Defects Location',"
    "'Staff purchases'"
)

def csv_to_sql(val):
    return "'" + "','".join([v.strip() for v in val.split(",")]) + "'"

def build_filters(date_from, date_to, country=None, channel=None, extra=None):
    parts = [
        "s.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "'",
        BASE_FILTERS,
    ]
    if country:
        parts.append("s.country IN (" + csv_to_sql(country) + ")")
    if channel:
        parts.append("s.pos_location_name IN (" + csv_to_sql(channel) + ")")
    if extra:
        parts.append(extra)
    return " AND ".join(parts)

@app.get("/api/")
def root():
    return {"status": "ok", "service": "Vivo BI API (PostgreSQL)"}

@app.get("/api/locations")
def get_locations():
    return run_query("""
        SELECT location_name, country, city, store_type, brand
        FROM pos_locations
        WHERE active = TRUE
        ORDER BY country, location_name
    """)

@app.get("/api/kpis")
def get_kpis(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS total_discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_returns,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS total_orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS total_units,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0), 0) AS avg_selling_price,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)
                / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) * 100, 2) AS return_rate
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {}

@app.get("/api/country-summary")
def get_country_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
):
    where = build_filters(date_from, date_to)
    return run_query("""
        SELECT s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/sales-summary")
def get_sales_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    return run_query("""
        SELECT s.pos_location_name AS channel, s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/daily-trend")
def get_daily_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, extra="s.sale_kind IN ('sale','order')")
    return run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            SUM(s.ordered_item_quantity) AS units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.gross_sales_kes::numeric), 0) AS gross_sales
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.sale_date, s.country
        ORDER BY s.sale_date, s.country
    """, date_to=date_to)

@app.get("/api/subcategory-sales")
def get_subcategory_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.product_type IN (" + subcat_list + ")")
    return run_query("""
        SELECT p.product_type AS subcategory,
            SUM(s.ordered_item_quantity) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.gross_sales_kes::numeric), 0) AS gross_sales,
            COUNT(DISTINCT s.order_id) AS orders
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        GROUP BY p.product_type
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/top-skus")
def get_top_skus(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        SELECT p.style_name, p.collection, p.brand, p.product_type,
            SUM(s.ordered_item_quantity) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.gross_sales_kes::numeric), 0) AS gross_sales,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(SUM(s.ordered_item_quantity), 0), 0) AS avg_price
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        GROUP BY p.style_name, p.collection, p.brand, p.product_type
        ORDER BY units_sold DESC
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/inventory")
def get_inventory(
    location: str = Query(default=None),
    country:  str = Query(default=None),
    product:  str = Query(default=None),
):
    filters = ["i.available > 0"]
    if location:
        filters.append("i.pos_location_name IN (" + csv_to_sql(location) + ")")
    if country:
        filters.append("i.country IN (" + csv_to_sql(country) + ")")
    if product:
        filters.append("LOWER(COALESCE(i.product_name,'')) LIKE '%" + product.lower().replace("'","") + "%'")
    where = " AND ".join(filters)
    return run_query("""
        SELECT i.country, i.pos_location_name AS location_name,
            i.product_name, i.sku,
            p.brand, p.product_type, p.style_name,
            p.color_print, p.size, p.barcode,
            SUM(i.available) AS available
        FROM all_inventory i
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where + """
        GROUP BY i.country, i.pos_location_name, i.product_name, i.sku,
                 p.brand, p.product_type, p.style_name, p.color_print, p.size, p.barcode
        ORDER BY i.pos_location_name, i.product_name
        LIMIT 2000
    """)

@app.get("/api/inventory-summary")
def get_inventory_summary(country: str = Query(default=None)):
    filters = ["i.available > 0", "i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"]
    if country:
        filters.append("i.country IN (" + csv_to_sql(country) + ")")
    where = " AND ".join(filters)
    return run_query("""
        SELECT i.pos_location_name AS location, i.country,
            COUNT(DISTINCT i.sku) AS skus,
            SUM(i.available) AS available,
            SUM(i.on_hand) AS on_hand
        FROM all_inventory i
        WHERE """ + where + """
        GROUP BY i.pos_location_name, i.country
        ORDER BY available DESC
    """)

@app.get("/api/footfall")
def get_footfall(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    channel:   str = Query(default=None),
):
    ff_filters = ["f.time BETWEEN '" + date_from + "' AND '" + date_to + "'"]
    if channel:
        ff_filters.append("f.pos_location_name IN (" + csv_to_sql(channel) + ")")
    ff_where = " AND ".join(ff_filters)
    sales_where = "s.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "' AND " + BASE_FILTERS
    return run_query("""
        WITH footfall AS (
            SELECT f.pos_location_name,
                SUM(f.a01_footfall_in) AS total_footfall,
                SUM(f.a05_outside_traffic) AS outside_traffic
            FROM footfall f
            WHERE """ + ff_where + """
            GROUP BY f.pos_location_name
        ),
        sales AS (
            SELECT s.pos_location_name,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
                ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket
            FROM all_sales s
            WHERE """ + sales_where + """
            GROUP BY s.pos_location_name
        )
        SELECT f.pos_location_name AS location,
            f.total_footfall, f.outside_traffic,
            ROUND(f.total_footfall * 100.0 / NULLIF(f.outside_traffic, 0), 1) AS turn_in_rate,
            COALESCE(s.orders, 0) AS orders,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(s.avg_basket, 0) AS avg_basket,
            ROUND(COALESCE(s.orders, 0) * 100.0 / NULLIF(f.total_footfall, 0), 1) AS conversion_rate
        FROM footfall f
        LEFT JOIN sales s ON f.pos_location_name = s.pos_location_name
        ORDER BY total_footfall DESC
    """, date_to=date_to)

@app.get("/api/footfall/weekday-pattern")
def get_footfall_weekday(
    date_from: str = Query(default=str((date.today() - timedelta(days=30)).isoformat())),
    date_to:   str = Query(default=str(date.today())),
    channel:   str = Query(default=None),
):
    filters = ["f.time BETWEEN '" + date_from + "' AND '" + date_to + "'"]
    if channel:
        filters.append("f.pos_location_name IN (" + csv_to_sql(channel) + ")")
    where = " AND ".join(filters)
    return run_query("""
        SELECT TO_CHAR(f.time, 'Day') AS weekday,
            EXTRACT(DOW FROM f.time) AS dow,
            ROUND(AVG(f.a01_footfall_in), 0) AS avg_footfall,
            ROUND(AVG(f.a05_outside_traffic), 0) AS avg_outside_traffic
        FROM footfall f
        WHERE """ + where + """
        GROUP BY weekday, dow
        ORDER BY dow
    """, date_to=date_to)

@app.get("/api/customers")
def get_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    channel_filter = ("AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    rows = run_query("""
        WITH period_customers AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND s.customer_id IS NOT NULL
            AND s.customer_id NOT IN ('None','null','')
            AND """ + BASE_FILTERS + " " + country_filter + " " + channel_filter + """
            GROUP BY s.customer_id
        ),
        all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_ever_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        churned AS (
            SELECT COUNT(DISTINCT s1.customer_id) AS churned_count
            FROM (
                SELECT DISTINCT customer_id FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                AND sale_date < CURRENT_DATE - INTERVAL '3 months'
            ) s1
            WHERE s1.customer_id NOT IN (
                SELECT DISTINCT customer_id FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                AND sale_date >= CURRENT_DATE - INTERVAL '3 months'
            )
        )
        SELECT
            COUNT(DISTINCT p.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN p.order_count = 1
                AND a.first_ever_purchase BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                THEN p.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN p.order_count > 1 THEN p.customer_id END) AS repeat_customers,
            COUNT(DISTINCT CASE WHEN p.order_count = 1
                AND a.first_ever_purchase < '""" + date_from + """'
                THEN p.customer_id END) AS returning_customers,
            MAX(c.churned_count) AS churned_customers,
            ROUND(AVG(p.total_spend), 0) AS avg_customer_spend,
            ROUND(AVG(p.order_count), 2) AS avg_orders_per_customer,
            ROUND(MAX(c.churned_count) * 100.0 / NULLIF(COUNT(DISTINCT p.customer_id), 0), 2) AS churn_rate
        FROM period_customers p
        LEFT JOIN all_time a ON p.customer_id = a.customer_id
        CROSS JOIN churned c
    """, date_to=date_to)
    return rows[0] if rows else {}

@app.get("/api/top-customers")
def get_top_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        SELECT
            ROW_NUMBER() OVER (ORDER BY SUM(s.total_sales_kes::numeric) DESC) AS rank,
            s.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone,
            c.email, c.city, c.country AS customer_country,
            COUNT(DISTINCT s.order_id) AS total_orders,
            SUM(s.ordered_item_quantity) AS total_units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.order_id), 0), 0) AS avg_basket,
            MAX(s.sale_date) AS last_purchase_date,
            MIN(s.sale_date) AS first_purchase_date
        FROM all_sales s
        LEFT JOIN all_customers c ON s.customer_id = c.customer_id
        WHERE """ + where + """
        GROUP BY s.customer_id, c.first_name, c.last_name, c.phone, c.email, c.city, c.country
        ORDER BY total_sales DESC
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/customer-search")
def get_customer_search(
    q:         str = Query(default=""),
    date_from: str = Query(default="2020-01-01"),
    date_to:   str = Query(default=str(date.today())),
):
    if not q or len(q) < 2:
        return []
    search = q.lower().replace("'", "")
    return run_query("""
        WITH sales AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS total_orders,
                SUM(s.ordered_item_quantity) AS total_units,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
                ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.order_id), 0), 0) AS avg_basket,
                MAX(s.sale_date) AS last_purchase_date,
                MIN(s.sale_date) AS first_purchase_date
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL
            AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            GROUP BY s.customer_id
        )
        SELECT sa.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone,
            c.email, c.city, c.country AS customer_country,
            sa.total_orders, sa.total_units, sa.total_sales,
            sa.avg_basket, sa.last_purchase_date, sa.first_purchase_date
        FROM sales sa
        LEFT JOIN all_customers c ON sa.customer_id = c.customer_id
        WHERE (LOWER(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) LIKE '%""" + search + """%'
            OR LOWER(COALESCE(c.phone,'')) LIKE '%""" + search + """%'
            OR LOWER(COALESCE(c.email,'')) LIKE '%""" + search + """%')
        ORDER BY sa.total_sales DESC
        LIMIT 10
    """, date_to=date_to)

@app.get("/api/customer-products")
def get_customer_products(customer_id: str = Query(default="")):
    if not customer_id:
        return []
    cid = customer_id.replace("'", "")
    return run_query("""
        SELECT p.style_name, p.product_type AS subcategory, p.brand,
            SUM(s.ordered_item_quantity) AS units_bought,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend,
            MAX(s.sale_date) AS last_bought
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE s.customer_id = '""" + cid + """'
        AND s.sale_kind IN ('sale','order') AND p.style_name IS NOT NULL
        GROUP BY p.style_name, p.product_type, p.brand
        ORDER BY units_bought DESC
        LIMIT 10
    """)

@app.get("/api/customer-frequency")
def get_customer_frequency(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH order_counts AS (
            SELECT customer_id, COUNT(DISTINCT order_id) AS order_count
            FROM all_sales s WHERE """ + where + """
            GROUP BY customer_id
        )
        SELECT
            CASE WHEN order_count = 1 THEN '1 order'
                 WHEN order_count = 2 THEN '2 orders'
                 WHEN order_count = 3 THEN '3 orders'
                 WHEN order_count = 4 THEN '4 orders'
                 ELSE '5+ orders' END AS frequency_bucket,
            COUNT(*) AS customer_count
        FROM order_counts
        GROUP BY frequency_bucket
        ORDER BY MIN(order_count)
    """, date_to=date_to)

@app.get("/api/customer-trend")
def get_customer_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT s.sale_date AS day,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase = s.sale_date THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < s.sale_date THEN s.customer_id END) AS returning_customers
        FROM all_sales s
        LEFT JOIN all_time a ON s.customer_id = a.customer_id
        WHERE """ + where + """
        GROUP BY s.sale_date ORDER BY s.sale_date
    """, date_to=date_to)

@app.get("/api/customers-by-location")
def get_customers_by_location(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT s.pos_location_name, s.country,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase BETWEEN '""" + date_from + """' AND '""" + date_to + """' THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < '""" + date_from + """' THEN s.customer_id END) AS returning_customers,
            ROUND(COUNT(DISTINCT s.customer_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT s.customer_id)) OVER(), 0), 1) AS pct_of_total
        FROM all_sales s
        LEFT JOIN all_time a ON s.customer_id = a.customer_id
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        ORDER BY total_customers DESC
    """, date_to=date_to)

@app.get("/api/churned-customers")
def get_churned_customers(
    days:  int = Query(default=90),
    limit: int = Query(default=20),
):
    return run_query("""
        WITH last_purchase AS (
            SELECT s.customer_id,
                MAX(s.sale_date) AS last_purchase_date,
                MIN(s.sale_date) AS first_purchase_date,
                COUNT(DISTINCT s.order_id) AS total_orders,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS lifetime_spend
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL
            AND s.customer_id NOT IN ('None','null','')
            AND """ + BASE_FILTERS + """
            GROUP BY s.customer_id
        )
        SELECT lp.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone, c.email,
            lp.last_purchase_date, lp.first_purchase_date,
            lp.total_orders, lp.lifetime_spend,
            CURRENT_DATE - lp.last_purchase_date AS days_since_last_purchase
        FROM last_purchase lp
        LEFT JOIN all_customers c ON lp.customer_id = c.customer_id
        WHERE CURRENT_DATE - lp.last_purchase_date > """ + str(days) + """
        ORDER BY lp.lifetime_spend DESC
        LIMIT """ + str(limit))

@app.get("/api/new-customer-products")
def get_new_customer_products(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        WITH new_customers AS (
            SELECT customer_id FROM all_sales
            WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
            HAVING MIN(sale_date) BETWEEN '""" + date_from + """' AND '""" + date_to + """'
        )
        SELECT p.style_name, p.product_type AS subcategory, p.brand,
            SUM(s.ordered_item_quantity) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.total_sales_kes::numeric) * 100.0 / NULLIF(SUM(SUM(s.total_sales_kes::numeric)) OVER(), 0), 1) AS pct_of_new_customer_sales
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        AND s.customer_id IN (SELECT customer_id FROM new_customers)
        GROUP BY p.style_name, p.product_type, p.brand
        ORDER BY units_sold DESC
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/sor")
def get_sor(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        SELECT p.style_name, p.collection, p.brand, p.product_type,
            SUM(s.ordered_item_quantity) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            COALESCE(MAX(i.current_stock), 0) AS current_stock,
            ROUND(SUM(s.ordered_item_quantity) * 100.0 /
                NULLIF(SUM(s.ordered_item_quantity) + COALESCE(MAX(i.current_stock), 0), 0), 1) AS sor_percent
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        LEFT JOIN (
            SELECT p2.style_name, SUM(i2.available) AS current_stock
            FROM all_inventory i2
            LEFT JOIN all_products_clean p2 ON i2.sku = p2.sku
            WHERE i2.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p2.style_name
        ) i ON p.style_name = i.style_name
        WHERE """ + where + """
        GROUP BY p.style_name, p.collection, p.brand, p.product_type
        ORDER BY units_sold DESC
        LIMIT 200
    """, date_to=date_to)

@app.get("/api/subcategory-stock-sales")
def get_subcategory_stock_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.product_type IN (" + subcat_list + ")")
    return run_query("""
        WITH sales AS (
            SELECT p.product_type AS subcategory,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.product_type
        ),
        stock AS (
            SELECT p.product_type AS subcategory, SUM(i.available) AS current_stock
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type
        )
        SELECT COALESCE(s.subcategory, st.subcategory) AS subcategory,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(st.current_stock, 0) AS current_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0),2) AS pct_of_total_sold,
            ROUND(COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0),2) AS pct_of_total_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(COALESCE(s.units_sold,0)+COALESCE(st.current_stock,0),0),1) AS sor_percent
        FROM sales s
        FULL OUTER JOIN stock st ON s.subcategory = st.subcategory
        WHERE COALESCE(s.subcategory, st.subcategory) IS NOT NULL
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/orders")
def get_orders(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=1000),
):
    where = build_filters(date_from, date_to, country, channel)
    return run_query("""
        SELECT s.order_id, s.order_name, s.sale_date AS order_date,
            s.pos_location_name, s.country,
            s.customer_id, s.customer_type, s.sale_kind,
            s.product_title, s.variant_sku AS sku,
            p.style_name, p.brand, p.collection,
            p.product_type AS subcategory, p.color_print AS color, p.size,
            s.ordered_item_quantity AS quantity,
            ROUND(s.product_price_kes::numeric, 0) AS unit_price_kes,
            ROUND(s.total_sales_kes::numeric, 0) AS total_sales_kes,
            ROUND(s.gross_sales_kes::numeric, 0) AS gross_sales_kes,
            ROUND(s.discounts_kes::numeric, 0) AS discount_kes,
            ROUND(s.returns_kes::numeric, 0) AS returns_kes,
            ROUND(s.net_sales_kes::numeric, 0) AS net_sales_kes
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        ORDER BY s.sale_date DESC, s.order_id
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/stock-to-sales")
def get_stock_to_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    inv_country_filter = ("AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH sales AS (
            SELECT s.pos_location_name, s.country,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND """ + BASE_FILTERS + " " + country_filter + """
            GROUP BY s.pos_location_name, s.country
        ),
        inventory AS (
            SELECT i.pos_location_name, i.country, SUM(i.available) AS total_stock
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            """ + inv_country_filter + """
            GROUP BY i.pos_location_name, i.country
        )
        SELECT s.pos_location_name AS location, s.country,
            s.units_sold, s.total_sales,
            COALESCE(i.total_stock, 0) AS current_stock,
            ROUND(COALESCE(i.total_stock,0)::numeric / NULLIF(s.units_sold, 0), 2) AS stock_to_sales_ratio
        FROM sales s
        LEFT JOIN inventory i ON s.pos_location_name = i.pos_location_name
        ORDER BY stock_to_sales_ratio DESC
    """, date_to=date_to)

@app.get("/api/customer-type-spend")
def get_customer_type_spend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH first_purchase AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase_date
            FROM all_sales WHERE sale_kind = 'order' AND customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        window_sales AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS orders,
                SUM(s.total_sales_kes::numeric) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind = 'order' AND s.customer_id IS NOT NULL
            """ + country_filter + """
            GROUP BY s.customer_id
        )
        SELECT
            CASE WHEN f.first_purchase_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                THEN 'New' ELSE 'Returning' END AS customer_segment,
            COUNT(DISTINCT w.customer_id) AS customers,
            SUM(w.orders) AS orders,
            ROUND(SUM(w.total_sales), 0) AS total_sales,
            ROUND(SUM(w.total_sales) / NULLIF(COUNT(DISTINCT w.customer_id), 0), 0) AS spend_per_customer,
            ROUND(SUM(w.total_sales) / NULLIF(SUM(w.orders), 0), 0) AS avg_basket_value
        FROM window_sales w
        JOIN first_purchase f ON w.customer_id = f.customer_id
        GROUP BY customer_segment
        ORDER BY customer_segment
    """, date_to=date_to)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))