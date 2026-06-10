from fastapi import FastAPI, Query, Request, Body
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

import threading
from psycopg2 import pool as _pg_pool

# Cap concurrent DB connections. The dashboard fires bursts of ~20+ parallel
# requests (KPI sparkline windows + compare + bootstrap), so a fresh
# connect()/close() per query used to exhaust Postgres connections and spike
# latency until the platform health probe killed the server. A bounded pool
# reuses connections; request concurrency is capped below MAX_DB_CONNECTIONS at
# startup so getconn() can never overflow the pool.
MAX_DB_CONNECTIONS = 20

_POOL = None
_POOL_LOCK = threading.Lock()

def _get_pool():
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                _POOL = _pg_pool.ThreadedConnectionPool(
                    minconn=2, maxconn=MAX_DB_CONNECTIONS,
                    dsn=os.environ['DATABASE_URL'],
                    # SECURITY: pin standard_conforming_strings=on for every
                    # pooled connection. SQL is built by concatenation and string
                    # values are escaped by doubling single quotes; that escaping
                    # is only sufficient when backslashes are literal (this
                    # setting on). Enforcing it per-connection means the injection
                    # defenses can't be weakened by a server/role default drift.
                    options='-c standard_conforming_strings=on')
    return _POOL

def get_conn():
    return psycopg2.connect(
        os.environ['DATABASE_URL'],
        options='-c standard_conforming_strings=on')

def run_query(query, date_to=None):
    key = hashlib.md5(query.encode()).hexdigest()
    cached = cache_get(key)
    if cached is not None:
        return cached
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = True  # read-only BI; never leave idle-in-transaction
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query)
        rows = [dict(r) for r in cur.fetchall()]
        cur.close()
    except Exception:
        # A broken connection must not return to the pool poisoned.
        pool.putconn(conn, close=True)
        raise
    else:
        pool.putconn(conn)
    cache_set(key, rows, ttl=smart_ttl(date_to))
    return rows

app = FastAPI(title="Vivo Fashion Group BI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Clerk auth gate ───────────────────────────────────────────────────────────
# Every /api/* request must carry a valid Clerk session whose verified email is
# on the company-domain allowlist (vivofashiongroup.com / shopzetu.com). The
# health root and the Clerk Frontend-API proxy are exempt. Verification is pure
# stdlib (see clerk_auth.py) — no SDK, because this env's u-root-cmds shadows
# coreutils and breaks the wheels' builds.
import clerk_auth
from fastapi.responses import JSONResponse

# Exact /api paths reachable without a session (health probes + proxy prefix).
_AUTH_PUBLIC_EXACT = {"/api", "/api/", "/api/healthz"}

# Query params that are concatenated into SQL as date literals. We validate them
# to strict ISO dates at the edge so they can never carry SQL-injection payloads
# (a value that parses as a date contains only digits/'-'/':'/'T' — none can
# break out of a '...' string literal). This guards every date-filtered endpoint
# in one place without touching the (heavily '%'-laden) query strings.
_DATE_QUERY_PARAMS = ("date_from", "date_to", "compare_from", "compare_to")


def _is_iso_date(v):
    try:
        date.fromisoformat(v)
        return True
    except (ValueError, TypeError):
        return False


@app.middleware("http")
async def clerk_auth_gate(request: Request, call_next):
    path = request.url.path
    # Non-API routes (static assets, SPA fallback) are not gated here.
    if not path.startswith("/api"):
        return await call_next(request)
    # CORS preflight and the Clerk proxy / health endpoints bypass the gate.
    if request.method == "OPTIONS":
        return await call_next(request)
    if path in _AUTH_PUBLIC_EXACT or path.startswith("/api/__clerk"):
        return await call_next(request)
    user, status, detail = clerk_auth.authenticate(request)
    if user is None:
        return JSONResponse({"detail": detail}, status_code=status)
    request.state.user = user
    # Reject any non-ISO date filter before it reaches a query string literal.
    for _k in _DATE_QUERY_PARAMS:
        _v = request.query_params.get(_k)
        if _v not in (None, "") and not _is_iso_date(_v):
            return JSONResponse(
                {"detail": f"Invalid {_k}: expected ISO date (YYYY-MM-DD)"},
                status_code=400,
            )
    return await call_next(request)

@app.on_event("startup")
def _cap_threadpool():
    # Sync endpoints run in Starlette's thread pool (default 40). Each can hold a
    # pooled DB connection, so keep concurrency strictly below MAX_DB_CONNECTIONS
    # to guarantee getconn() never overflows the pool under request bursts.
    try:
        import anyio
        anyio.to_thread.current_default_thread_limiter().total_tokens = MAX_DB_CONNECTIONS - 2
    except Exception:
        pass


@app.on_event("startup")
def _assert_standard_conforming_strings():
    # Fail fast if quote-doubling escaping (csv_to_sql et al.) is not backed by
    # standard_conforming_strings=on. We pin it per-connection via libpq options;
    # this asserts it actually took effect rather than trusting the default.
    pool = _get_pool()
    conn = pool.getconn()
    try:
        cur = conn.cursor()
        cur.execute("SHOW standard_conforming_strings")
        setting = cur.fetchone()[0]
        cur.close()
    finally:
        pool.putconn(conn)
    if setting != "on":
        raise RuntimeError(
            "standard_conforming_strings must be 'on' for SQL-injection escaping "
            f"to be sound, got {setting!r}")

BASE_FILTERS = """
    s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda')
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

# In-memory operational state. The warehouse has no audit tables for these,
# so allocation runs and the replenishment roster live for the server session.
_ALLOC_RUNS = []
_REPLEN_OWNERS = ["Matthew", "Teddy", "Alvi", "Emma"]
# Replenishment marks overlay. The report is computed on the fly with no audit
# table, so marks persist for the server session. Callers identify a row by
# either sku or barcode, so keys are namespaced: (pos_location, "sku", sku) and
# (pos_location, "barcode", barcode) -> {replenished, actual_units_replenished}.
_REPLEN_MARKS = {}
# Range-management manual tier overrides, keyed by style_name -> {"tier", "reason"}.
# Applied on top of the age-based auto-tier in /range-mgmt/classify.
_RANGE_OVERRIDES = {}

def csv_to_sql(val):
    # Escape embedded single quotes (double them) so comma-separated filter
    # values (country / channel / location) cannot break out of the SQL string
    # literal. Safe because the server runs with standard_conforming_strings=on
    # (backslashes are literal), so doubling quotes is sufficient.
    return "'" + "','".join(v.strip().replace("'", "''") for v in val.split(",")) + "'"

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

@app.get("/api/healthz")
def healthz():
    # Lightweight liveness probe — deliberately does NOT touch the DB so it
    # stays green even if Postgres is briefly saturated, and is whitelisted in
    # _AUTH_PUBLIC_EXACT so the platform probe never gets a 401.
    return {"status": "ok"}

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
        ORDER BY available DESC
        LIMIT 100000
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
                AND sale_date::date < CURRENT_DATE - INTERVAL '3 months'
            ) s1
            WHERE s1.customer_id NOT IN (
                SELECT DISTINCT customer_id FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                AND sale_date::date >= CURRENT_DATE - INTERVAL '3 months'
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
                MAX(s.sale_date::date) AS last_purchase_date,
                MIN(s.sale_date::date) AS first_purchase_date,
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


# ── Auth endpoints (Clerk-verified) ───────────────────────────────────────────
# The auth gate has already verified the Clerk session + domain allowlist by the
# time these run, so `request.state.user` is the authenticated company account.
@app.get("/api/auth/me")
def auth_me(request: Request):
    return getattr(request.state, "user", None) or {}

@app.get("/api/auth/me/status")
def auth_me_status():
    return {"status":"active"}

@app.post("/api/auth/login")
def auth_login(request: Request):
    user = getattr(request.state, "user", None) or {}
    return {"token": "clerk-session", "user": user}

@app.post("/api/auth/logout")
def auth_logout():
    return {"ok":True}

# ══════════════════════════════════════════════════════════════════════════════
# PART A — REAL DATA endpoints (appended)
# ══════════════════════════════════════════════════════════════════════════════

def _country_summary_q(date_from, date_to, country=None, channel=None):
    if not date_from or not date_to:
        return []
    where = build_filters(date_from, date_to, country, channel)
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

def _daily_by_country_q(date_from, date_to, country=None, channel=None):
    if not date_from or not date_to:
        return {}
    where = build_filters(date_from, date_to, country, channel, extra="s.sale_kind IN ('sale','order')")
    rows = run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            SUM(s.ordered_item_quantity) AS units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.sale_date, s.country
        ORDER BY s.sale_date, s.country
    """, date_to=date_to)
    out = {}
    for r in rows:
        c = r.get("country") or "Other"
        out.setdefault(c, []).append({
            "day": r.get("day"),
            "total_sales": r.get("total_sales"),
            "orders": r.get("orders"),
            "units": r.get("units"),
        })
    return out

@app.get("/api/bootstrap/overview")
def bootstrap_overview(
    date_from:    str = Query(default=str(date.today().replace(day=1))),
    date_to:      str = Query(default=str(date.today())),
    country:      str = Query(default=None),
    channel:      str = Query(default=None),
    compare_from: str = Query(default=None),
    compare_to:   str = Query(default=None),
):
    has_prev = bool(compare_from and compare_to)
    return {
        "country_summary":      _country_summary_q(date_from, date_to, country, channel),
        "country_summary_prev": _country_summary_q(compare_from, compare_to, country, channel) if has_prev else [],
        "sales_summary":        get_sales_summary(date_from, date_to, country, channel),
        "sales_summary_prev":   get_sales_summary(compare_from, compare_to, country, channel) if has_prev else [],
        "top_styles":           get_top_skus(date_from, date_to, country, channel, 10),
        "subcategory_sales":      get_subcategory_sales(date_from, date_to, country, channel),
        "subcategory_sales_prev": get_subcategory_sales(compare_from, compare_to, country, channel) if has_prev else [],
        "footfall":             get_footfall(date_from, date_to, channel),
        "footfall_prev":        get_footfall(compare_from, compare_to, channel) if has_prev else [],
        "locations":            get_locations(),
        "daily_by_country":      _daily_by_country_q(date_from, date_to, country, channel),
        "daily_by_country_prev": _daily_by_country_q(compare_from, compare_to, country, channel) if has_prev else {},
    }

@app.get("/api/analytics/canonical-units-sold")
def analytics_canonical_units_sold(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Total units sold under BASE_FILTERS (which already excludes shopping bags,
    # staff purchases, manual orders and the Uganda online channel). We do NOT
    # restrict by product_type here. The variant_sku -> all_products_clean.sku
    # join is actually sound (~98% of sale rows match), but all_sales.product_type
    # is ~97% NULL and joined product_type only covers ~70% of sold units, so any
    # product_type filter would drop ~30% of real units and contradict the ASP /
    # transactions KPIs computed off the same base.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0")
    rows = run_query("""
        SELECT COALESCE(SUM(s.ordered_item_quantity), 0) AS units_sold
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return {"units_sold": int((rows[0].get("units_sold") if rows and rows[0].get("units_sold") is not None else 0))}

@app.get("/api/analytics/inventory-summary")
def analytics_inventory_summary(country: str = Query(default=None)):
    return get_inventory_summary(country)

@app.get("/api/analytics/total-sales-summary")
def analytics_total_sales_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0), 0) AS net_sales,
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0), 0) AS gross_sales,
            COALESCE(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0) AS orders,
            COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0) AS units
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {"total_sales": 0, "net_sales": 0, "gross_sales": 0, "orders": 0, "units": 0}

@app.get("/api/analytics/active-pos")
def analytics_active_pos(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")")
    return run_query("""
        SELECT s.pos_location_name AS channel, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(SUM(s.ordered_item_quantity), 0) AS units_sold
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        HAVING SUM(s.total_sales_kes::numeric) > 0
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/analytics/sell-through-by-location")
def analytics_sell_through_by_location(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    sales_where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")")
    inv_country_filter = ("AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH sales AS (
            SELECT s.pos_location_name AS location, s.country,
                SUM(s.ordered_item_quantity) AS units_sold
            FROM all_sales s
            WHERE """ + sales_where + """
            GROUP BY s.pos_location_name, s.country
        ),
        inv AS (
            SELECT i.pos_location_name AS location, i.country,
                SUM(i.available) AS available
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            """ + inv_country_filter + """
            GROUP BY i.pos_location_name, i.country
        )
        SELECT COALESCE(s.location, i.location) AS location,
            COALESCE(s.country, i.country) AS country,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(i.available, 0) AS available,
            ROUND(COALESCE(s.units_sold, 0) * 100.0 /
                NULLIF(COALESCE(s.units_sold, 0) + COALESCE(i.available, 0), 0), 1) AS sell_through
        FROM sales s
        FULL OUTER JOIN inv i ON s.location = i.location
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/analytics/sor-all-styles")
def analytics_sor_all_styles(
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
        LIMIT 5000
    """, date_to=date_to)

@app.get("/api/analytics/stock-to-sales-by-category")
def analytics_sts_by_category(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.category IS NOT NULL AND p.category <> ''")
    return run_query("""
        WITH sales AS (
            SELECT p.category AS category,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.category
        ),
        stock AS (
            SELECT p.category AS category, SUM(i.available) AS current_stock
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.category IS NOT NULL AND p.category <> ''
            GROUP BY p.category
        )
        SELECT COALESCE(s.category, st.category) AS category,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(st.current_stock, 0) AS current_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0),2) AS pct_of_total_sold,
            ROUND(COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0),2) AS pct_of_total_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(COALESCE(s.units_sold,0)+COALESCE(st.current_stock,0),0),1) AS sor_percent,
            ROUND(
                COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0)
                - COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0)
            , 2) AS variance
        FROM sales s
        FULL OUTER JOIN stock st ON s.category = st.category
        WHERE COALESCE(s.category, st.category) IS NOT NULL
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/analytics/stock-to-sales-by-subcat")
def analytics_sts_by_subcat(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    rows = get_subcategory_stock_sales(date_from, date_to, country, channel)
    for r in rows:
        sold = r.get("pct_of_total_sold") or 0
        stock = r.get("pct_of_total_stock") or 0
        try:
            r["variance"] = round(float(sold) - float(stock), 2)
        except (TypeError, ValueError):
            r["variance"] = 0
    return rows

@app.get("/api/analytics/new-styles")
def analytics_new_styles(
    days:  int = Query(default=90),
    limit: int = Query(default=200),
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Sell-Out Rate is computed launch-to-date (units sold since launch vs the
    # units sold plus current store stock), so the re-order list reflects how
    # much of the launch buy has already sold through.
    if date_from and date_to:
        period_extra = "s2.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "'"
    else:
        period_extra = "TRUE"
    return run_query("""
        WITH new_styles AS (
            SELECT p.style_name,
                MAX(p.brand) AS brand,
                MAX(p.product_type) AS product_type,
                MAX(p.product_type) AS subcategory,
                MIN(p.style_launch_date) AS style_launch_date
            FROM all_products_clean p
            WHERE p.style_name IS NOT NULL
              AND p.style_launch_date IS NOT NULL
              AND substring(p.style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND substring(p.style_launch_date, 1, 10)::date >= CURRENT_DATE - (""" + str(int(days)) + """ || ' days')::interval
            GROUP BY p.style_name
        ),
        launch AS (
            SELECT p.style_name,
                COALESCE(SUM(s.net_quantity), 0) AS units_sold_launch,
                COALESCE(ROUND(SUM(s.net_sales_kes::numeric)), 0) AS total_sales_launch
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku AND s.sale_kind IN ('sale','order')
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
            GROUP BY p.style_name
        ),
        period AS (
            SELECT p.style_name,
                COALESCE(ROUND(SUM(s2.net_sales_kes::numeric)), 0) AS total_sales_period
            FROM all_products_clean p
            JOIN all_sales s2 ON s2.variant_sku = p.sku AND s2.sale_kind IN ('sale','order')
            WHERE p.style_name IN (SELECT style_name FROM new_styles) AND """ + period_extra + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT p.style_name, COALESCE(SUM(i.available), 0) AS current_stock
            FROM all_products_clean p
            JOIN all_inventory i ON i.sku = p.sku
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
              AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p.style_name
        )
        SELECT ns.style_name, ns.brand, ns.product_type, ns.subcategory, ns.style_launch_date,
            COALESCE(l.units_sold_launch, 0) AS units_sold,
            COALESCE(l.total_sales_launch, 0) AS total_sales,
            COALESCE(l.units_sold_launch, 0) AS units_sold_launch,
            COALESCE(l.total_sales_launch, 0) AS total_sales_launch,
            COALESCE(pr.total_sales_period, 0) AS total_sales_period,
            COALESCE(st.current_stock, 0) AS current_stock,
            COALESCE(st.current_stock, 0) AS stock_available,
            ROUND(100.0 * COALESCE(l.units_sold_launch, 0)
                  / NULLIF(COALESCE(l.units_sold_launch, 0) + COALESCE(st.current_stock, 0), 0), 1) AS sor_percent
        FROM new_styles ns
        LEFT JOIN launch l USING (style_name)
        LEFT JOIN period pr USING (style_name)
        LEFT JOIN stock st USING (style_name)
        ORDER BY ns.style_launch_date DESC, units_sold_launch DESC
        LIMIT """ + str(int(limit)))

@app.get("/api/analytics/aged-stock")
def analytics_aged_stock(days: int = Query(default=90)):
    return run_query("""
        WITH last_sale AS (
            SELECT variant_sku AS sku, MAX(sale_date) AS last_sold
            FROM all_sales
            WHERE sale_kind IN ('sale','order')
            GROUP BY variant_sku
        )
        SELECT i.sku,
            MAX(i.style_name) AS style_name,
            i.location_name, i.country,
            SUM(i.available) AS available,
            MAX(ls.last_sold) AS last_sold
        FROM all_inventory i
        LEFT JOIN last_sale ls ON i.sku = ls.sku
        WHERE i.available > 0
        AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
        AND (ls.last_sold IS NULL
             OR ls.last_sold::date < CURRENT_DATE - (""" + str(int(days)) + """ || ' days')::interval)
        GROUP BY i.sku, i.location_name, i.country
        ORDER BY available DESC
        LIMIT 200
    """)

@app.get("/api/analytics/weeks-of-cover")
def analytics_weeks_of_cover(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    return run_query("""
        WITH sales AS (
            SELECT p.product_type AS subcategory, p.style_name,
                SUM(s.ordered_item_quantity) AS units_90
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order')
            AND s.sale_date::date >= CURRENT_DATE - INTERVAL '90 days'
            AND """ + BASE_FILTERS + """
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name
        ),
        stock AS (
            SELECT p.product_type AS subcategory, p.style_name,
                SUM(i.available) AS available
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name
        )
        SELECT COALESCE(st.subcategory, sa.subcategory) AS subcategory,
            COALESCE(st.style_name, sa.style_name) AS style_name,
            COALESCE(st.available, 0) AS available,
            COALESCE(st.available, 0) AS current_stock,
            ROUND(COALESCE(sa.units_90, 0) / 13.0, 2) AS weekly_units,
            COALESCE(sa.units_90, 0) AS units_sold_3m,
            ROUND(COALESCE(st.available, 0) / NULLIF(COALESCE(sa.units_90, 0) / 13.0, 0), 1) AS weeks_of_cover
        FROM stock st
        FULL OUTER JOIN sales sa
            ON st.subcategory = sa.subcategory AND st.style_name = sa.style_name
        WHERE COALESCE(st.style_name, sa.style_name) IS NOT NULL
        ORDER BY available DESC
        LIMIT 2000
    """)

@app.get("/api/analytics/repeat-customers")
def analytics_repeat_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH cust AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend_kes,
                MIN(s.sale_date) AS first_order_date,
                MAX(s.sale_date) AS last_order_date,
                SUM(s.ordered_item_quantity) AS total_units
            FROM all_sales s
            WHERE """ + where + """
            GROUP BY s.customer_id
            HAVING COUNT(DISTINCT s.order_id) >= 2
        )
        SELECT c.customer_id,
            CONCAT(COALESCE(cu.first_name,''), ' ', COALESCE(cu.last_name,'')) AS customer_name,
            COALESCE(cu.phone,'') AS mobile,
            cu.email,
            c.order_count, c.total_spend_kes, c.total_units,
            c.first_order_date, c.last_order_date
        FROM cust c
        LEFT JOIN all_customers cu ON c.customer_id = cu.customer_id
        ORDER BY c.total_spend_kes DESC
        LIMIT 500
    """, date_to=date_to)

@app.get("/api/analytics/customer-retention")
def analytics_customer_retention(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    cust = get_customers(date_from, date_to, country, channel)
    total = cust.get("total_customers") or 0
    repeat = cust.get("repeat_customers") or 0
    new = cust.get("new_customers") or 0
    try:
        repeat_rate = round(float(repeat) * 100.0 / float(total), 2) if total else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        repeat_rate = 0.0
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    months = run_query("""
        SELECT substring(s.sale_date, 1, 7) AS month,
            COUNT(DISTINCT s.customer_id) AS customers
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY substring(s.sale_date, 1, 7)
        ORDER BY month
    """, date_to=date_to)
    return {
        "repeat_rate_pct": repeat_rate,
        "repeat_customers": repeat,
        "new_customers": new,
        "total_customers": total,
        "months": months,
    }

@app.get("/api/analytics/customer-crosswalk")
def analytics_customer_crosswalk(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    top:       int = Query(default=15),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','') AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")")
    return run_query("""
        WITH cust_stores AS (
            SELECT DISTINCT s.customer_id, s.pos_location_name
            FROM all_sales s
            WHERE """ + where + """
        ),
        totals AS (
            SELECT pos_location_name, COUNT(DISTINCT customer_id) AS n
            FROM cust_stores GROUP BY pos_location_name
        )
        SELECT a.pos_location_name AS store_a,
            b.pos_location_name AS store_b,
            COUNT(DISTINCT a.customer_id) AS shared_customers,
            ROUND(COUNT(DISTINCT a.customer_id) * 100.0 / NULLIF(LEAST(ta.n, tb.n), 0), 2) AS pct_overlap
        FROM cust_stores a
        JOIN cust_stores b
            ON a.customer_id = b.customer_id AND a.pos_location_name < b.pos_location_name
        JOIN totals ta ON ta.pos_location_name = a.pos_location_name
        JOIN totals tb ON tb.pos_location_name = b.pos_location_name
        GROUP BY a.pos_location_name, b.pos_location_name, ta.n, tb.n
        ORDER BY shared_customers DESC
        LIMIT 100
    """, date_to=date_to)

@app.get("/api/customers/churn-rate")
def customers_churn_rate():
    rows = run_query("""
        WITH churned AS (
            SELECT COUNT(DISTINCT s1.customer_id) AS churned_count
            FROM (
                SELECT DISTINCT customer_id FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                AND customer_id NOT IN ('None','null','')
                AND sale_date::date < CURRENT_DATE - INTERVAL '3 months'
            ) s1
            WHERE s1.customer_id NOT IN (
                SELECT DISTINCT customer_id FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                AND sale_date::date >= CURRENT_DATE - INTERVAL '3 months'
            )
        ),
        base AS (
            SELECT COUNT(DISTINCT customer_id) AS n FROM all_sales
            WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            AND customer_id NOT IN ('None','null','')
        )
        SELECT c.churned_count, b.n AS base,
            ROUND(c.churned_count * 100.0 / NULLIF(b.n, 0), 2) AS churn_rate
        FROM churned c CROSS JOIN base b
    """)
    if not rows:
        return {"churn_rate": 0, "churned_count": 0, "churned_customers": 0, "base": 0}
    r = rows[0]
    r["churned_customers"] = r.get("churned_count")
    return r

@app.get("/api/customers/walk-ins")
def customers_walk_ins(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND (s.customer_id IS NULL OR s.customer_id IN ('None','null',''))")
    rows = run_query("""
        SELECT COALESCE(COUNT(DISTINCT s.order_id), 0) AS orders,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(SUM(s.ordered_item_quantity), 0) AS units
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {"orders": 0, "total_sales": 0, "units": 0}


# ══════════════════════════════════════════════════════════════════════════════
# IBT (Inter-Branch Transfer) — real data
#   Store-to-store moves a SKU from a store where the style is barely selling
#   (≤ low_pct of the style's per-store average) but has stock, to a store
#   selling strongly (≥ high_pct of average) but running low. Warehouses are
#   excluded. Warehouse-to-store covers shop-floor gaps from warehouse stock.
# ══════════════════════════════════════════════════════════════════════════════

def _sql_str(s):
    return (s or "").replace("'", "''")

@app.get("/api/analytics/ibt-suggestions")
def ibt_suggestions(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    limit:     int = Query(default=300),
    low_pct:   float = Query(default=20),
    high_pct:  float = Query(default=150),
):
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    low = float(low_pct) / 100.0
    high = float(high_pct) / 100.0
    lim = max(1, min(int(limit), 1000))
    c_sales = ("AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = ("AND i.country = '" + _sql_str(country) + "'") if country else ""
    q = f"""
    WITH sv AS (
      SELECT p.style_name AS style, s.pos_location_name AS store,
             SUM(s.net_quantity) AS units_sold,
             CASE WHEN SUM(s.net_quantity) > 0
                  THEN SUM(s.net_sales_kes) / SUM(s.net_quantity) END AS asp
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date BETWEEN '{date_from}' AND '{date_to}'
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT IN ('Manual Order','Online - vivo-uganda')
        AND COALESCE(p.style_name,'') <> '' {c_sales}
      GROUP BY 1, 2
    ),
    inv AS (
      SELECT p.style_name AS style, i.pos_location_name AS store,
             SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2
    ),
    combined AS (
      SELECT COALESCE(sv.style, inv.style) AS style,
             COALESCE(sv.store, inv.store) AS store,
             COALESCE(sv.units_sold, 0) AS units_sold,
             COALESCE(inv.available, 0) AS available, sv.asp
      FROM sv FULL OUTER JOIN inv ON sv.style = inv.style AND sv.store = inv.store
    ),
    stats AS (
      SELECT style, AVG(units_sold) AS avg_u, MAX(asp) AS asp
      FROM combined GROUP BY style HAVING COUNT(*) >= 2 AND AVG(units_sold) > 0
    ),
    froms AS (
      SELECT c.style, c.store, c.available
      FROM combined c JOIN stats st ON st.style = c.style
      WHERE c.available >= 3 AND c.units_sold <= {low} * st.avg_u
    ),
    tos AS (
      SELECT c.style, c.store, c.available, c.units_sold
      FROM combined c JOIN stats st ON st.style = c.style
      WHERE c.units_sold >= {high} * st.avg_u AND c.available <= 2
    ),
    pairs AS (
      SELECT DISTINCT ON (f.style)
             f.style, f.store AS from_store, f.available AS from_avail,
             t.store AS to_store, t.available AS to_avail, t.units_sold AS to_sold
      FROM froms f JOIN tos t ON t.style = f.style AND t.store <> f.store
      ORDER BY f.style, f.available DESC, t.units_sold DESC
    )
    SELECT pr.style AS style_name, pp.brand, pp.category AS subcategory,
           pr.from_store, pr.to_store,
           GREATEST(LEAST(pr.from_avail - 2, GREATEST(pr.to_sold - pr.to_avail, 1)), 1)::int AS units_to_move,
           ROUND(GREATEST(LEAST(pr.from_avail - 2, GREATEST(pr.to_sold - pr.to_avail, 1)), 1)
                 * COALESCE(st.asp, 0))::numeric AS estimated_uplift,
           COALESCE(fsv.units_sold, 0)::int AS from_qty_sold_28d,
           pr.to_sold::int AS to_qty_sold_28d
    FROM pairs pr
    JOIN stats st ON st.style = pr.style
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = pr.style LIMIT 1
    ) pp ON TRUE
    LEFT JOIN combined fsv ON fsv.style = pr.style AND fsv.store = pr.from_store
    ORDER BY estimated_uplift DESC NULLS LAST
    LIMIT {lim}
    """
    return run_query(q, date_to=date_to)


@app.get("/api/analytics/ibt-sku-breakdown")
def ibt_sku_breakdown(
    style_name:    str = Query(...),
    from_store:    str = Query(...),
    to_store:      str = Query(...),
    units_to_move: int = Query(default=0),
):
    st = _sql_str(style_name)
    fs = _sql_str(from_store)
    ts = _sql_str(to_store)
    q = f"""
    WITH skus AS (
      SELECT DISTINCT p.sku, p.color_print AS color, p.size, p.barcode
      FROM all_products_clean p WHERE p.style_name = '{st}'
    ),
    fi AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{fs}' GROUP BY sku),
    ti AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{ts}' GROUP BY sku)
    SELECT s.sku, s.color, s.size, s.barcode,
           COALESCE(fi.av, 0)::int AS from_available,
           COALESCE(ti.av, 0)::int AS to_available,
           LEAST(
             CASE WHEN COALESCE(fi.av,0) > 2 THEN COALESCE(fi.av,0) - 1 ELSE 0 END,
             GREATEST(2 - COALESCE(ti.av,0), 0)
           )::int AS suggested_qty
    FROM skus s
    LEFT JOIN fi ON fi.sku = s.sku
    LEFT JOIN ti ON ti.sku = s.sku
    WHERE COALESCE(fi.av,0) > 0 OR COALESCE(ti.av,0) > 0
    ORDER BY suggested_qty DESC, from_available DESC
    """
    skus = run_query(q)
    return {
        "from_store": from_store,
        "to_store": to_store,
        "from_total": sum(r["from_available"] for r in skus),
        "to_total": sum(r["to_available"] for r in skus),
        "suggested_total": sum(r["suggested_qty"] for r in skus),
        "skus": skus,
    }


@app.get("/api/analytics/ibt-warehouse-to-store")
def ibt_warehouse_to_store(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    limit:     int = Query(default=300),
):
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    lim = max(1, min(int(limit), 1000))
    c_sales = ("AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = ("AND i.country = '" + _sql_str(country) + "'") if country else ""
    q = f"""
    WITH sv AS (
      SELECT p.style_name AS style, s.pos_location_name AS store,
             SUM(s.net_quantity) AS units_sold
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date BETWEEN '{date_from}' AND '{date_to}'
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT IN ('Manual Order','Online - vivo-uganda')
        AND COALESCE(p.style_name,'') <> '' {c_sales}
      GROUP BY 1, 2 HAVING SUM(s.net_quantity) >= 3
    ),
    si AS (
      SELECT p.style_name AS style, i.pos_location_name AS store,
             SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2
    ),
    wh AS (
      SELECT p.style_name AS style, SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name = 'Warehouse Finished Goods'
        AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1
    )
    SELECT sv.style AS style_name, pp.brand, pp.category AS subcategory,
           sv.store AS to_store,
           GREATEST(LEAST(wh.available, sv.units_sold - COALESCE(si.available, 0)), 1)::int AS suggested_qty,
           sv.units_sold::int AS to_qty_sold_28d
    FROM sv
    JOIN wh ON wh.style = sv.style AND wh.available > 0
    LEFT JOIN si ON si.style = sv.style AND si.store = sv.store
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = sv.style LIMIT 1
    ) pp ON TRUE
    WHERE COALESCE(si.available, 0) <= 2
    ORDER BY suggested_qty DESC
    LIMIT {lim}
    """
    return run_query(q, date_to=date_to)


# ══════════════════════════════════════════════════════════════════════════════
# PART B — STUB endpoints (non-crashing typed payloads)
# ══════════════════════════════════════════════════════════════════════════════

# --- GET stubs returning [] ---
@app.get("/api/admin/active-sessions")
def stub_admin_active_sessions(): return []
@app.get("/api/admin/activity-logs")
def stub_admin_activity_logs(): return []
@app.get("/api/admin/audit-log")
def stub_admin_audit_log(): return []
@app.get("/api/admin/store-clusters")
def admin_store_clusters(forceFresh: bool = Query(default=False)):
    rows = run_query("""
        WITH base AS (
            SELECT s.pos_location_name AS store, s.country, s.order_id, s.net_quantity,
                s.net_sales_kes::numeric AS rev, s.product_type, s.variant_sku
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'
        )
        SELECT b.store, MAX(b.country) AS country,
            ROUND(SUM(b.rev) / NULLIF(SUM(b.net_quantity), 0)) AS asp,
            ROUND(SUM(b.net_quantity)::numeric / NULLIF(COUNT(DISTINCT b.order_id), 0), 2) AS avg_basket_units,
            ROUND(SUM(b.rev)) AS revenue_90d,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%top%' OR b.product_type ILIKE '%shirt%' OR b.product_type ILIKE '%blouse%' OR b.product_type ILIKE '%bodysuit%' OR b.product_type ILIKE '%sweater%' OR b.product_type ILIKE '%hood%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_tops,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%pant%' OR b.product_type ILIKE '%skirt%' OR b.product_type ILIKE '%short%' OR b.product_type ILIKE '%legging%' OR b.product_type ILIKE '%culotte%' OR b.product_type ILIKE '%dress%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_bottoms,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%accessor%' OR b.product_type ILIKE '%scar%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_accessories,
            MODE() WITHIN GROUP (ORDER BY p.size) FILTER (WHERE p.size IS NOT NULL AND p.size <> '') AS size_cog
        FROM base b
        LEFT JOIN all_products_clean p ON p.sku = b.variant_sku
        GROUP BY b.store
        HAVING SUM(b.net_quantity) > 0
        ORDER BY revenue_90d DESC
    """)
    for r in rows:
        for k in ("asp", "avg_basket_units", "revenue_90d", "pct_tops", "pct_bottoms", "pct_accessories"):
            r[k] = float(r[k]) if r.get(k) is not None else 0.0
    n = len(rows)

    def tier_for(idx):
        if n == 0:
            return "C"
        if idx < max(1, n // 3):
            return "A"
        if idx < max(2, (2 * n) // 3):
            return "B"
        return "C"

    tier_meta = {
        "A": ("A - Flagship", "Top-revenue stores driving the bulk of group sales over the last 90 days."),
        "B": ("B - Core", "Mid-tier stores with steady, dependable throughput."),
        "C": ("C - Developing", "Smaller-volume stores still building traction."),
    }
    clusters, by_store = {}, {}
    for i, r in enumerate(rows):
        t = tier_for(i)
        label, explainer = tier_meta[t]
        cid = "cluster_" + t
        c = clusters.setdefault(cid, {"id": cid, "tier": label, "size": 0, "explainer": explainer, "members": []})
        c["members"].append(r["store"])
        c["size"] += 1
        by_store[r["store"]] = {
            "tier": label, "cluster_id": cid, "country": r.get("country"),
            "asp": r["asp"], "avg_basket_units": r["avg_basket_units"],
            "size_cog": r.get("size_cog") or "-",
            "pct_tops": r["pct_tops"], "pct_bottoms": r["pct_bottoms"],
            "pct_accessories": r["pct_accessories"], "revenue_90d": r["revenue_90d"],
        }
    return {
        "ok": True,
        "computed_at": (date.today()).isoformat(),
        "n_stores": n,
        "tier_window": "90d",
        "clusters": clusters,
        "by_store": by_store,
    }
@app.get("/api/admin/users")
def stub_admin_users(): return []
@app.get("/api/admin/replenishment-config")
def admin_replenishment_config():
    return {"owners": list(_REPLEN_OWNERS)}
@app.get("/api/admin/snapshot-freshness")
def stub_admin_snapshot_freshness(): return []
@app.get("/api/allocations/runs")
def allocations_runs(status: str = Query(default=None)):
    runs = _ALLOC_RUNS
    if status:
        runs = [r for r in runs if r.get("status") == status]
    return runs
@app.get("/api/allocations/sizes")
def allocations_sizes():
    rows = run_query("""
        SELECT size, COUNT(*) AS n
        FROM all_products_clean
        WHERE size IS NOT NULL AND size <> '' AND size NOT LIKE '%/%'
        GROUP BY size ORDER BY n DESC LIMIT 8
    """)
    if not rows:
        return {"pack_table": {"S": 2, "M": 3, "L": 3, "1X": 2}}
    mn = min(float(r["n"]) for r in rows) or 1
    pack = {}
    for r in rows:
        pack[r["size"]] = max(1, min(4, int(round(float(r["n"]) / mn))))
    return {"pack_table": pack}
@app.get("/api/allocations/stores")
def allocations_stores():
    rows = run_query("""
        SELECT DISTINCT s.pos_location_name AS store
        FROM all_sales s
        WHERE """ + BASE_FILTERS + """
          AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
          AND s.pos_location_name NOT ILIKE '%online%'
        ORDER BY 1
    """)
    return {"stores": [r["store"] for r in rows if r.get("store")]}
@app.get("/api/allocations/styles")
def allocations_styles(subcategory: str = Query(default=None)):
    extra = ""
    if subcategory:
        extra = " AND p.product_type = '" + subcategory.replace("'", "''") + "'"
    rows = run_query("""
        SELECT DISTINCT p.style_name AS style
        FROM all_products_clean p
        WHERE p.style_name IS NOT NULL AND p.style_name <> ''""" + extra + """
        ORDER BY 1
    """)
    return {"styles": [r["style"] for r in rows if r.get("style")]}
@app.get("/api/analytics/allocations")
def stub_analytics_allocations(): return []
@app.get("/api/analytics/annual-targets")
def analytics_annual_targets(year: int = Query(default=None)):
    # Targets are derived as prior-year actuals + a 15% stretch (no separate
    # targets table exists in the warehouse).
    yr = int(year) if year else date.today().year
    growth = 1.15

    def actuals(y):
        return run_query("""
            SELECT
                CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' THEN 'Online'
                     ELSE COALESCE(NULLIF(s.country, ''), 'Other') END AS bucket,
                EXTRACT(QUARTER FROM s.sale_date::date)::int AS q,
                ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + str(y) + """-01-01' AND '""" + str(y) + """-12-31'
              AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
            GROUP BY 1, 2
        """)

    def to_map(rows):
        m = {}
        for r in rows:
            q = int(r["q"]) if r["q"] else 0
            m.setdefault(r["bucket"], {1: 0, 2: 0, 3: 0, 4: 0})
            if q in (1, 2, 3, 4):
                m[r["bucket"]][q] += float(r["net"] or 0)
        return m

    cur_m, prev_m = to_map(actuals(yr)), to_map(actuals(yr - 1))
    names = sorted(set(list(cur_m.keys()) + list(prev_m.keys())))
    start, end = date(yr, 1, 1), date(yr, 12, 31)
    days_total = (end - start).days + 1
    today = date.today()
    days_elapsed = 0 if today < start else days_total if today > end else (today - start).days + 1
    frac = days_elapsed / days_total if days_total else 1

    def make_bucket(name):
        pq = prev_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        cq = cur_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        target_annual = round(sum(pq.values()) * growth)
        actual_ytd = round(sum(cq.values()))
        projected_year = round(actual_ytd / frac) if frac else actual_ytd
        return {
            "bucket": name, "target_annual": target_annual, "actual_ytd": actual_ytd,
            "pct_of_target_ytd": round(100.0 * actual_ytd / target_annual, 1) if target_annual else 0.0,
            "projected_year": projected_year,
            "pct_of_target_projected": round(100.0 * projected_year / target_annual, 1) if target_annual else 0.0,
            "variance_projected": projected_year - target_annual,
            "quarters": {("Q%d" % q): round(pq[q] * growth) for q in (1, 2, 3, 4)},
            "actual_quarters": {("Q%d" % q): round(cq[q]) for q in (1, 2, 3, 4)},
        }

    buckets = [make_bucket(n) for n in names]
    tt_target = sum(b["target_annual"] for b in buckets)
    tt_actual = sum(b["actual_ytd"] for b in buckets)
    tt_proj = round(tt_actual / frac) if frac else tt_actual
    total = {
        "target_annual": tt_target, "actual_ytd": tt_actual,
        "pct_of_target_ytd": round(100.0 * tt_actual / tt_target, 1) if tt_target else 0.0,
        "projected_year": tt_proj,
        "pct_of_target_projected": round(100.0 * tt_proj / tt_target, 1) if tt_target else 0.0,
        "variance_projected": tt_proj - tt_target,
    }
    return {
        "total": total, "buckets": buckets,
        "completion_pct": round(100.0 * days_elapsed / days_total, 1),
        "days_elapsed": days_elapsed, "days_total": days_total, "as_of": today.isoformat(),
    }
@app.get("/api/analytics/monthly-targets")
def analytics_monthly_targets(month: str = Query(default=None)):
    # Per-market daily target tracker. Target = prior-year same-month
    # actual + 15% stretch, spread evenly across the days of the month.
    mstart = (date.fromisoformat(month[:10]).replace(day=1) if month
              else date.today().replace(day=1))
    nstart = (date(mstart.year + 1, 1, 1) if mstart.month == 12
              else date(mstart.year, mstart.month + 1, 1))
    mend = nstart - timedelta(days=1)
    days_in_month = mend.day
    today = date.today()
    growth = 1.15
    py_start = mstart.replace(year=mstart.year - 1)
    py_end = mend.replace(year=mend.year - 1)
    market = ("CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' "
              "THEN 'Online' ELSE COALESCE(NULLIF(s.country, ''), 'Other') END")
    py = run_query("""
        SELECT """ + market + """ AS channel,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(py_start) + """' AND '""" + str(py_end) + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1
    """)
    daily = run_query("""
        SELECT """ + market + """ AS channel, s.sale_date::date AS d,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units,
            COUNT(DISTINCT s.order_id) AS orders
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(mstart) + """' AND '""" + str(mend) + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1, 2
    """)
    py_map = {r["channel"]: float(r["net"] or 0) for r in py}
    dmap = {}
    for r in daily:
        dmap.setdefault(r["channel"], {})[str(r["d"])] = {
            "net": float(r["net"] or 0), "units": float(r["units"] or 0), "orders": float(r["orders"] or 0)}
    channels = sorted(set(list(py_map.keys()) + list(dmap.keys())))
    if mstart.year == today.year and mstart.month == today.month:
        days_complete = today.day
    elif today < mstart:
        days_complete = 0
    else:
        days_complete = days_in_month
    days_remaining = days_in_month - days_complete
    stores = []
    for ch in channels:
        sales_target = round(py_map.get(ch, 0) * growth)
        daily_target = sales_target / days_in_month if days_in_month else 0
        ch_daily = dmap.get(ch, {})
        days, mtd_actual, mtd_units, mtd_orders, cum_var = [], 0.0, 0.0, 0.0, 0.0
        for dd in range(1, days_in_month + 1):
            day = date(mstart.year, mstart.month, dd)
            a = ch_daily.get(str(day))
            actual = a["net"] if a else 0.0
            is_future = day > today
            if not is_future:
                mtd_actual += actual
                if a:
                    mtd_units += a["units"]
                    mtd_orders += a["orders"]
            dt = round(daily_target)
            ksh_var = round(actual - dt)
            cum_var += ksh_var
            days.append({
                "date": str(day), "day_of_week": day.strftime("%a"),
                "ratio": round(100.0 / days_in_month, 1),
                "daily_target": dt, "suggested_daily_target": dt,
                "actual": round(actual),
                "variance_pct": round(100.0 * (actual - dt) / dt, 1) if dt else 0.0,
                "ksh_variance": ksh_var, "ksh_variance_cumulative": round(cum_var),
                "is_future": is_future, "is_today": day == today,
            })
        mtd_target = round(daily_target * days_complete)
        projected = round(mtd_actual / days_complete * days_in_month) if days_complete else 0
        gap = sales_target - round(mtd_actual)
        stores.append({
            "channel": ch, "sales_target": sales_target, "mtd_actual": round(mtd_actual),
            "mtd_target": mtd_target, "projected_landing": projected,
            "pct_of_target_projected": round(100.0 * projected / sales_target, 1) if sales_target else 0.0,
            "ksh_variance_total": round(mtd_actual) - mtd_target,
            "days_complete": days_complete, "days_in_month": days_in_month,
            "days_remaining": days_remaining,
            "avg_suggested_remaining": round(gap / days_remaining) if days_remaining > 0 else 0,
            "gap_to_target": gap,
            "asp": round(mtd_actual / mtd_units) if mtd_units else 0,
            "basket_kes": round(mtd_actual / mtd_orders) if mtd_orders else 0,
            "daily": days,
        })
    stores.sort(key=lambda x: x["sales_target"], reverse=True)
    return {"month": str(mstart), "stores": stores}
# IBT (Inter-Branch Transfer) endpoints — see PART A region below for the
# real implementations (ibt_suggestions / ibt_sku_breakdown /
# ibt_warehouse_to_store). Kept out of the stub block intentionally.
@app.get("/api/analytics/insights")
def stub_analytics_insights(): return []
@app.get("/api/analytics/re-order-list")
def stub_analytics_re_order_list(): return []
@app.get("/api/analytics/recently-unchurned")
def analytics_recently_unchurned(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    min_gap_days: int = Query(default=90),
    limit: int = Query(default=100),
):
    # Win-back signal: customers whose latest purchase follows a long dormant
    # gap (>= min_gap_days) and landed in the last 60 days.
    return run_query("""
        WITH purch AS (
            SELECT s.customer_id, s.sale_date::date AS d
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.customer_id IS NOT NULL AND s.customer_id <> ''
              AND s.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        ),
        gaps AS (
            SELECT customer_id, d,
                LAG(d) OVER (PARTITION BY customer_id ORDER BY d) AS prev_d
            FROM purch
        ),
        winback AS (
            SELECT customer_id, d AS return_date, (d - prev_d) AS gap_days
            FROM gaps
            WHERE prev_d IS NOT NULL
              AND (d - prev_d) >= """ + str(int(min_gap_days)) + """
              AND d >= CURRENT_DATE - INTERVAL '60 days'
        )
        SELECT w.customer_id,
            NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
            c.phone, c.email,
            MAX(w.return_date) AS last_order_date,
            MAX(w.gap_days) AS gap_days,
            COALESCE(MAX(c.total_orders), 0) AS total_orders,
            COALESCE(ROUND(MAX(c.total_spend_kes)), 0) AS total_spend,
            (CURRENT_DATE - MAX(w.return_date)) AS days_since_last
        FROM winback w
        LEFT JOIN all_customers c ON c.customer_id = w.customer_id
        GROUP BY w.customer_id, c.first_name, c.last_name, c.phone, c.email
        ORDER BY last_order_date DESC, gap_days DESC
        LIMIT """ + str(int(limit)))
@app.get("/api/analytics/replenish-by-color")
def analytics_replenish_by_color(
    country: str = Query(default=None),
    channel: str = Query(default=None),
    max_weeks_of_cover: float = Query(default=6.0),
    min_sor_percent: float = Query(default=40.0),
):
    sales_extra = ""
    if country:
        sales_extra += " AND s.country = '" + country.replace("'", "''") + "'"
    if channel:
        sales_extra += " AND s.channel IN (" + csv_to_sql(channel) + ")"
    inv_country = ""
    if country:
        inv_country = " AND i.country = '" + country.replace("'", "''") + "'"
    rows = run_query("""
        WITH sales30 AS (
            SELECT p.style_name, MAX(p.brand) AS brand, MAX(p.product_type) AS subcategory,
                COALESCE(NULLIF(TRIM(p.color_print), ''), 'Unspecified') AS color,
                SUM(s.net_quantity) AS units_30d
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '30 days')::text
              AND """ + BASE_FILTERS + sales_extra + """
              AND p.style_name IS NOT NULL
            GROUP BY p.style_name, color
        ),
        soh AS (
            SELECT p.style_name,
                COALESCE(NULLIF(TRIM(i.color_print), ''), 'Unspecified') AS color,
                SUM(i.available) AS soh_total
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND p.style_name IS NOT NULL""" + inv_country + """
            GROUP BY p.style_name, color
        )
        SELECT COALESCE(s.style_name, h.style_name) AS style_name,
            COALESCE(s.color, h.color) AS color,
            MAX(s.brand) AS brand, MAX(s.subcategory) AS subcategory,
            COALESCE(SUM(s.units_30d), 0) AS units_30d,
            COALESCE(SUM(h.soh_total), 0) AS soh_total
        FROM sales30 s
        FULL OUTER JOIN soh h ON h.style_name = s.style_name AND h.color = s.color
        GROUP BY COALESCE(s.style_name, h.style_name), COALESCE(s.color, h.color)
    """)
    styles = {}
    for r in rows:
        sn = r.get("style_name")
        if not sn:
            continue
        st = styles.setdefault(sn, {"brand": None, "subcategory": None, "colors": []})
        if r.get("brand"):
            st["brand"] = r["brand"]
        if r.get("subcategory"):
            st["subcategory"] = r["subcategory"]
        st["colors"].append({
            "color": r["color"],
            "units_30d": int(float(r["units_30d"] or 0)),
            "soh_total": int(float(r["soh_total"] or 0)),
        })
    out = []
    weeks_target = 4.0
    for sn, st in styles.items():
        total_u = sum(c["units_30d"] for c in st["colors"])
        total_soh = sum(c["soh_total"] for c in st["colors"])
        for c in st["colors"]:
            weekly = c["units_30d"] / 4.0
            target = int(round(weekly * weeks_target))
            c["target_qty"] = target
            c["recommended_qty"] = max(0, target - c["soh_total"])
            c["pct_of_style_sales"] = round(100.0 * c["units_30d"] / total_u, 1) if total_u else 0.0
        style_weekly = total_u / 4.0
        woc = round(total_soh / style_weekly, 1) if style_weekly else 999.0
        sor = round(100.0 * total_u / (total_u + total_soh), 1) if (total_u + total_soh) else 0.0
        total_rec = sum(c["recommended_qty"] for c in st["colors"])
        if sor < min_sor_percent or woc > max_weeks_of_cover or total_rec <= 0:
            continue
        st["colors"].sort(key=lambda c: c["recommended_qty"], reverse=True)
        out.append({
            "style_name": sn, "brand": st["brand"], "subcategory": st["subcategory"],
            "sor_percent": sor, "weeks_of_cover": woc,
            "total_units_30d": total_u, "total_soh": total_soh,
            "total_recommended_qty": total_rec, "colors": st["colors"],
        })
    out.sort(key=lambda x: x["total_recommended_qty"], reverse=True)
    return out
@app.get("/api/analytics/replenishment-completed")
def stub_analytics_replenishment_completed(): return []
@app.get("/api/analytics/replenishment-report")
def analytics_replenishment_report(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    limit: int = Query(default=400),
):
    if not date_from or not date_to:
        date_to = str(date.today())
        date_from = str(date.today() - timedelta(days=30))
    rows = run_query("""
        WITH sold AS (
            SELECT s.pos_location_name, s.variant_sku,
                MAX(s.country) AS country,
                MAX(s.product_title) AS product_name,
                SUM(s.net_quantity) AS units_sold,
                MAX(s.sale_date) AS last_sale
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'
              AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
            GROUP BY s.pos_location_name, s.variant_sku
            HAVING SUM(s.net_quantity) > 0
        ),
        store_soh AS (
            SELECT i.pos_location_name, i.sku,
                SUM(i.available) AS soh_store,
                MAX(i.location_name) AS bin, MAX(i.size) AS size
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY i.pos_location_name, i.sku
        ),
        wh_soh AS (
            SELECT i.sku, SUM(i.available) AS soh_wh
            FROM all_inventory i
            WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY i.sku
        )
        SELECT sold.pos_location_name AS pos_location, sold.country,
            sold.product_name, sold.variant_sku AS sku, sold.units_sold, sold.last_sale,
            COALESCE(p.size, ss.size) AS size, p.barcode,
            COALESCE(ss.soh_store, 0) AS soh_store, COALESCE(ss.bin, '') AS bin,
            COALESCE(w.soh_wh, 0) AS soh_wh
        FROM sold
        LEFT JOIN store_soh ss ON ss.pos_location_name = sold.pos_location_name AND ss.sku = sold.variant_sku
        LEFT JOIN wh_soh w ON w.sku = sold.variant_sku
        LEFT JOIN all_products_clean p ON p.sku = sold.variant_sku
        WHERE COALESCE(ss.soh_store, 0) < sold.units_sold AND COALESCE(w.soh_wh, 0) > 0
        ORDER BY (sold.units_sold - COALESCE(ss.soh_store, 0)) DESC
        LIMIT """ + str(int(limit)))
    owners = list(_REPLEN_OWNERS) or ["Matthew", "Teddy", "Alvi", "Emma"]
    today = date.today()
    out_rows = []
    for idx, r in enumerate(rows):
        units_sold = int(r["units_sold"] or 0)
        soh_store = int(r["soh_store"] or 0)
        soh_wh = int(r["soh_wh"] or 0)
        replenish = max(0, min(units_sold - soh_store, soh_wh))
        days_lapsed = 0
        if r.get("last_sale"):
            try:
                days_lapsed = (today - date.fromisoformat(str(r["last_sale"])[:10])).days
            except ValueError:
                days_lapsed = 0
        mark = (_REPLEN_MARKS.get((r.get("pos_location"), "sku", r.get("sku")))
                or _REPLEN_MARKS.get((r.get("pos_location"), "barcode", r.get("barcode")))
                or {})
        out_rows.append({
            "owner": owners[idx % len(owners)], "country": r.get("country"),
            "pos_location": r.get("pos_location"), "product_name": r.get("product_name"),
            "size": r.get("size") or "", "barcode": r.get("barcode") or "",
            "sku": r.get("sku"), "bin": r.get("bin") or "",
            "units_sold": units_sold, "soh_store": soh_store, "soh_wh": soh_wh,
            "replenish": replenish, "replenished": bool(mark.get("replenished", False)),
            "actual_units_replenished": int(mark.get("actual_units_replenished", 0)),
            "days_lapsed": days_lapsed,
        })
    by_owner = {}
    for r in out_rows:
        o = by_owner.setdefault(r["owner"], {"owner": r["owner"], "lines": 0, "units": 0, "stores": set()})
        o["lines"] += 1
        o["units"] += r["replenish"]
        o["stores"].add(r["pos_location"])
    by_owner_list = sorted(
        [{"owner": o["owner"], "lines": o["lines"], "units": o["units"], "stores": len(o["stores"])} for o in by_owner.values()],
        key=lambda x: x["units"], reverse=True)
    return {
        "rows": out_rows,
        "summary": {
            "by_owner": by_owner_list,
            "total_units": sum(r["replenish"] for r in out_rows),
            "total_rows": len(out_rows),
            "completed": sum(1 for r in out_rows if r["replenished"]),
        },
    }
@app.get("/api/analytics/sales-projection")
def analytics_sales_projection(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                                    WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END)), 0) AS actual_sales,
            MAX(s.sale_date) AS last_day
        FROM all_sales s WHERE """ + where + """
    """)
    actual = float(rows[0]["actual_sales"]) if rows and rows[0]["actual_sales"] is not None else 0.0
    last_day = rows[0].get("last_day") if rows else None
    d0 = date.fromisoformat(date_from[:10])
    d1 = date.fromisoformat(date_to[:10])
    total_days = max(1, (d1 - d0).days + 1)
    eff = min(d1, date.today())
    if last_day:
        try:
            ld = date.fromisoformat(str(last_day)[:10])
            if ld < eff:
                eff = ld
        except ValueError:
            pass
    days_elapsed = min(max(1, (eff - d0).days + 1), total_days)
    daily_run_rate = actual / days_elapsed if days_elapsed else 0
    projected = daily_run_rate * total_days
    return {
        "total_days": total_days,
        "days_elapsed": days_elapsed,
        "completion_pct": round(100.0 * days_elapsed / total_days, 1),
        "actual_sales": round(actual),
        "daily_run_rate": round(daily_run_rate),
        "projected_sales": round(projected),
    }
def _style_filters(country=None, channel=None, alias="s"):
    cf = chf = ""
    if country:
        cs = [c.strip().lower() for c in country.split(",") if c.strip()]
        if cs:
            cf = " AND LOWER(" + alias + ".country) IN (" + ",".join(
                "'" + c.replace("'", "''") + "'" for c in cs) + ")"
    if channel:
        chs = [c.strip() for c in channel.split(",") if c.strip()]
        if chs:
            chf = " AND " + alias + ".pos_location_name IN (" + ",".join(
                "'" + c.replace("'", "''") + "'" for c in chs) + ")"
    return cf, chf


def _sku_breakdown(style_names, country=None, channel=None):
    names = [n for n in style_names if n]
    if not names:
        return {}
    names_sql = ",".join("'" + n.replace("'", "''") + "'" for n in names)
    cf, chf = _style_filters(country, channel, "s")
    inv_cf, _ = _style_filters(country, None, "i")
    six = str(date.today() - timedelta(days=182))
    three = str(date.today() - timedelta(days=21))
    sales = run_query("""
        SELECT p.style_name, p.sku, p.color_print AS color, p.size,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units_6m,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END) AS sales_6m,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') AND s.sale_date >= '""" + three + """' THEN s.net_quantity ELSE 0 END) AS units_3w
        FROM all_products_clean p
        LEFT JOIN all_sales s ON s.variant_sku = p.sku
            AND s.sale_date BETWEEN '""" + six + """' AND '""" + str(date.today()) + """'
            AND """ + BASE_FILTERS + cf + chf + """
        WHERE p.style_name IN (""" + names_sql + """)
        GROUP BY p.style_name, p.sku, p.color_print, p.size
    """)
    inv = run_query("""
        SELECT p.sku,
            SUM(i.available) AS soh_total,
            SUM(CASE WHEN i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """) THEN i.available ELSE 0 END) AS soh_wh
        FROM all_products_clean p
        LEFT JOIN all_inventory i ON i.sku = p.sku""" + inv_cf + """
        WHERE p.style_name IN (""" + names_sql + """)
        GROUP BY p.sku
    """)
    inv_map = {r["sku"]: r for r in inv}
    out = {}
    for r in sales:
        soh = inv_map.get(r["sku"], {})
        soh_total = float(soh.get("soh_total") or 0)
        soh_wh = float(soh.get("soh_wh") or 0)
        u6 = float(r["units_6m"] or 0)
        u3 = float(r["units_3w"] or 0)
        if u6 == 0 and u3 == 0 and soh_total == 0:
            continue
        out.setdefault(r["style_name"], []).append({
            "color": r["color"] or "—", "size": r["size"] or "—", "sku": r["sku"],
            "units_6m": int(u6), "units_3w": int(u3),
            "sales_6m": round(float(r["sales_6m"] or 0)),
            "soh_total": int(soh_total), "soh_wh": int(soh_wh),
            "pct_in_wh": round(100.0 * soh_wh / soh_total, 1) if soh_total else 0.0,
        })
    return out


@app.get("/api/analytics/style-sku-breakdown")
def analytics_style_sku_breakdown(style_name: str = Query(...),
                                  country: str = Query(default=None),
                                  channel: str = Query(default=None)):
    out = _sku_breakdown([style_name], country, channel)
    return {"skus": out.get(style_name, [])}


@app.get("/api/analytics/style-sku-breakdown-bulk")
def analytics_style_sku_breakdown_bulk(style_names: str = Query(...),
                                       country: str = Query(default=None),
                                       channel: str = Query(default=None)):
    names = [n.strip() for n in style_names.split(",") if n.strip()]
    return {"styles": _sku_breakdown(names, country, channel)}


@app.get("/api/analytics/style-location-breakdown")
def analytics_style_location_breakdown(style_name: str = Query(...),
                                       country: str = Query(default=None),
                                       channel: str = Query(default=None),
                                       color: str = Query(default=None),
                                       size: str = Query(default=None)):
    name_sql = "'" + style_name.replace("'", "''") + "'"
    extra = ""
    if color:
        extra += " AND p.color_print = '" + color.replace("'", "''") + "'"
    if size:
        extra += " AND p.size = '" + size.replace("'", "''") + "'"
    cf, chf = _style_filters(country, channel, "s")
    inv_cf, _ = _style_filters(country, None, "i")
    six = str(date.today() - timedelta(days=182))
    sales = run_query("""
        SELECT s.pos_location_name AS location,
            SUM(s.net_quantity) AS units_6m,
            SUM(s.net_sales_kes::numeric) AS sales_6m
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE p.style_name = """ + name_sql + extra + """
          AND s.sale_kind IN ('sale','order')
          AND s.sale_date BETWEEN '""" + six + """' AND '""" + str(date.today()) + """'
          AND """ + BASE_FILTERS + cf + chf + """
        GROUP BY s.pos_location_name
    """)
    inv = run_query("""
        SELECT i.pos_location_name AS location, SUM(i.available) AS soh_total
        FROM all_inventory i
        JOIN all_products_clean p ON p.sku = i.sku
        WHERE p.style_name = """ + name_sql + extra + inv_cf + """
        GROUP BY i.pos_location_name
    """)
    merged = {}
    for r in sales:
        merged[r["location"]] = {
            "location": r["location"], "units_6m": int(float(r["units_6m"] or 0)),
            "sales_6m": round(float(r["sales_6m"] or 0)), "soh_total": 0}
    for r in inv:
        loc = r["location"]
        m = merged.setdefault(loc, {"location": loc, "units_6m": 0, "sales_6m": 0, "soh_total": 0})
        m["soh_total"] = int(float(r["soh_total"] or 0))
    rows = []
    for m in merged.values():
        denom = m["units_6m"] + m["soh_total"]
        m["sor_6m"] = round(100.0 * m["units_6m"] / denom, 1) if denom else 0.0
        if m["units_6m"] or m["soh_total"]:
            rows.append(m)
    rows.sort(key=lambda x: x["units_6m"], reverse=True)
    return {"locations": rows}
@app.get("/api/analytics/ceo-report")
def stub_analytics_ceo_report(): return []
@app.get("/api/ibt/completed")
def stub_ibt_completed(): return []
@app.get("/api/ibt/completed/keys")
def stub_ibt_completed_keys(): return []
@app.get("/api/leaderboard/streaks")
def stub_leaderboard_streaks(): return []
@app.get("/api/notifications")
def stub_notifications(): return []
@app.get("/api/recommendations")
def stub_recommendations(): return []
@app.get("/api/recommendations/wins")
def stub_recommendations_wins(): return []
_RANGE_TARGETS = {
    "total": [500, 700],
    "Tier 1": [80, 150],
    "Tier 2": [150, 250],
    "Tier 3": [120, 200],
    "Tier 4": [80, 150],
}

def _parse_iso_date(s):
    if not s:
        return None
    try:
        y, m, d = (int(x) for x in str(s)[:10].split("-"))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None

def _rag(count, lo, hi):
    if lo <= count <= hi:
        return "green"
    margin = max(1, round((hi - lo) * 0.2))
    if lo - margin <= count <= hi + margin:
        return "amber"
    return "red"

def _tier_summary_block(rows, total_count):
    units = sum(r["units_since_launch"] or 0 for r in rows)
    rev = sum(r["sales_since_launch"] or 0 for r in rows)
    stock = sum(r["current_stock"] or 0 for r in rows)
    denom = units + stock
    return {
        "count": len(rows),
        "pct_styles": round(len(rows) * 100.0 / total_count, 1) if total_count else 0,
        "revenue_lifetime": round(rev),
        "units_lifetime": units,
        "sor_lifetime_pct": round(units * 100.0 / denom, 1) if denom else None,
    }

@app.get("/api/range-mgmt/classify")
def range_mgmt_classify(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, _ = _style_filters(country, channel, "i")
    raw = run_query("""
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number,
                MAX(price) AS price,
                MIN(substring(style_launch_date, 1, 10)) FILTER (
                    WHERE substring(style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                ) AS launch_date
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''
            GROUP BY style_name
        ),
        sales AS (
            SELECT p.style_name,
                SUM(s.net_quantity) AS units_life,
                ROUND(SUM(s.net_sales_kes::numeric)) AS sales_life,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days') AS units_6m,
                ROUND(SUM(s.net_sales_kes::numeric) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days')) AS sales_6m,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days') AS units_30d,
                SUM(s.net_quantity) FILTER (WHERE s.pos_location_name ILIKE '%online%') AS units_online,
                SUM(s.net_quantity) FILTER (WHERE s.pos_location_name NOT ILIKE '%online%') AS units_stores,
                MAX(s.sale_date::date) AS last_sale,
                MIN(s.sale_date::date) AS first_sale
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IS NOT NULL AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT style_name,
                COALESCE(SUM(available) FILTER (WHERE pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_stores,
                COALESCE(SUM(available) FILTER (WHERE pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_warehouse
            FROM all_inventory i
            WHERE style_name IS NOT NULL""" + icf + """
            GROUP BY style_name
        )
        SELECT p.style_name, p.brand, p.subcategory, p.style_number, p.price, p.launch_date,
            COALESCE(sa.units_life, 0) AS units_life, COALESCE(sa.sales_life, 0) AS sales_life,
            COALESCE(sa.units_6m, 0) AS units_6m, COALESCE(sa.sales_6m, 0) AS sales_6m,
            COALESCE(sa.units_30d, 0) AS units_30d,
            COALESCE(sa.units_online, 0) AS units_online, COALESCE(sa.units_stores, 0) AS units_stores,
            sa.last_sale, sa.first_sale,
            COALESCE(st.soh_stores, 0) AS soh_stores, COALESCE(st.soh_warehouse, 0) AS soh_warehouse
        FROM prod p
        LEFT JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        WHERE COALESCE(sa.units_life, 0) > 0 OR COALESCE(st.soh_stores, 0) > 0 OR COALESCE(st.soh_warehouse, 0) > 0
    """)
    today = date.today()
    active, retired, pipeline, candidates = [], [], [], []
    for r in raw:
        units_life = int(r["units_life"] or 0)
        sales_life = float(r["sales_life"] or 0)
        units_6m = int(r["units_6m"] or 0)
        sales_6m = float(r["sales_6m"] or 0)
        units_30d = int(r["units_30d"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        current_stock = soh_stores + soh_warehouse
        last_sale = r["last_sale"]
        launch = _parse_iso_date(r["launch_date"]) or r["first_sale"]
        age_weeks = round((today - launch).days / 7.0) if launch else None
        last_sale_days = (today - last_sale).days if last_sale else None
        weekly_avg = round(units_30d / (30.0 / 7.0), 1)
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        reorder_count = int(age_weeks // 12) if age_weeks else 0

        def _sor(u):
            denom = u + current_stock
            return round(u * 100.0 / denom, 1) if denom > 0 else None
        sor_life = _sor(units_life)
        sor_6m = _sor(units_6m)
        avg_price = round(sales_life / units_life) if units_life > 0 else None
        original_price = round(float(r["price"])) if r["price"] else None
        full_price_pct = round(min(100.0, avg_price * 100.0 / original_price), 1) \
            if (avg_price and original_price) else None

        if age_weeks is None:
            age_tier = "Tier 4"
        elif age_weeks >= 104:
            age_tier = "Tier 1"
        elif age_weeks >= 39:
            age_tier = "Tier 2"
        elif age_weeks >= 13:
            age_tier = "Tier 3"
        else:
            age_tier = "Tier 4"

        is_retired = (age_weeks is not None and age_weeks >= 39 and units_6m == 0
                      and (last_sale_days is None or last_sale_days > 270))
        flagged = (not is_retired and age_weeks is not None and age_weeks >= 39
                   and sor_life is not None and sor_life < 40 and current_stock > 0)

        ov = _RANGE_OVERRIDES.get(r["style_name"])
        if ov:
            tier, auto_tier, override_reason = ov["tier"], age_tier, ov.get("reason")
        elif is_retired:
            tier, auto_tier, override_reason = "Retire", "Retire", None
        elif flagged:
            tier, auto_tier, override_reason = "Retire", "Retire", None
        else:
            tier, auto_tier, override_reason = age_tier, age_tier, None

        if flagged or is_retired:
            status = "Retire"
        elif age_tier in ("Tier 3", "Tier 4") and age_weeks is not None and age_weeks >= 12 \
                and (sor_life is None or sor_life < 25):
            status = "Overdue"
        elif sor_life is not None and sor_life < 45:
            status = "At Risk"
        else:
            status = "On Track"

        if status == "Retire":
            action = "Mark down to outlet and clear remaining stock per the SOP 4-week gap rule."
        elif status == "Overdue":
            action = "Overdue Week-8 read — review sell-through now and decide reorder or exit."
        elif status == "At Risk":
            action = "Monitor weekly; consider a marketing push or price review to lift sell-through."
        elif tier == "Tier 3":
            action = "On review — track toward the 9-month gate for graduation to Tier 2."
        else:
            action = "Healthy — maintain replenishment to keep the core line in stock."

        row = {
            "style_name": r["style_name"],
            "style_number": r["style_number"],
            "brand": r["brand"],
            "subcategory": r["subcategory"],
            "tier": tier,
            "auto_tier": auto_tier,
            "override_reason": override_reason,
            "status": status,
            "recommended_action": action,
            "style_age_weeks": age_weeks,
            "launch_date": str(launch) if launch else None,
            "reorder_count": reorder_count,
            "current_stock": current_stock,
            "soh_stores": soh_stores,
            "soh_warehouse": soh_warehouse,
            "units_online": int(r["units_online"] or 0),
            "units_stores": int(r["units_stores"] or 0),
            "units_since_launch": units_life,
            "units_6m": units_6m,
            "sales_since_launch": sales_life,
            "sales_6m": sales_6m,
            "sor_since_launch": sor_life,
            "sor_6m": sor_6m,
            "lifetime_sor_pct": sor_life,
            "woc": woc,
            "weekly_avg": weekly_avg,
            "last_sale_days": last_sale_days,
            "original_price": original_price,
            "avg_price_since_launch": avg_price,
            "full_price_pct": full_price_pct,
        }

        if is_retired:
            retired.append(row)
            continue
        active.append(row)

        if flagged:
            rec = today + timedelta(days=14)
            pipeline.append({**row,
                "recommended_retirement_date": str(rec),
                "outlet_discount_date": str(rec + timedelta(days=28)),
                "reason": "Aged %sw at %s%% lifetime SOR with %s units remaining — below Tier-1 threshold." % (
                    age_weeks, sor_life, current_stock),
            })

        if (age_tier == "Tier 3" and age_weeks is not None and 0 <= (39 - age_weeks) <= 6
                and reorder_count >= 3 and sor_life is not None and sor_life > 60
                and full_price_pct is not None and full_price_pct > 90):
            candidates.append({
                "style_name": r["style_name"], "brand": r["brand"], "subcategory": r["subcategory"],
                "weeks_to_gate": 39 - age_weeks, "lifetime_sor_pct": sor_life,
                "full_price_pct": full_price_pct, "reorder_count": reorder_count,
                "current_stock": current_stock, "last_sale_days": last_sale_days,
            })

    tier_counts = {t: 0 for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4", "Retire")}
    for row in active:
        tier_counts[row["tier"]] = tier_counts.get(row["tier"], 0) + 1

    total_count = len(active) + len(retired)
    tier_summary = {
        "Total": _tier_summary_block(active + retired, total_count),
        "Active": _tier_summary_block(active, total_count),
        "Retired": _tier_summary_block(retired, total_count),
    }
    for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
        tier_summary[t] = _tier_summary_block(
            [row for row in active if row["tier"] == t], total_count)

    approaching = sum(1 for row in active
        if row["style_age_weeks"] is not None and (
            (row["tier"] == "Tier 3" and 0 <= (39 - row["style_age_weeks"]) <= 6) or
            (row["tier"] == "Tier 4" and 0 <= (13 - row["style_age_weeks"]) <= 6)))

    rag = {"total": _rag(len(active), *_RANGE_TARGETS["total"])}
    for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
        rag[t] = _rag(tier_counts.get(t, 0), *_RANGE_TARGETS[t])

    summary = {
        "total_active_styles": len(active),
        "flagged_for_retirement": len(pipeline),
        "overdue_for_week8_read": sum(1 for row in active if row["status"] == "Overdue"),
        "approaching_decision_gates": approaching,
        "tier_counts": tier_counts,
        "targets": _RANGE_TARGETS,
        "rag": rag,
        "tier_summary": tier_summary,
    }

    candidates.sort(key=lambda c: c["weeks_to_gate"])
    pipeline.sort(key=lambda p: -(p["style_age_weeks"] or 0))
    return {
        "rows": active,
        "retired_rows": retired,
        "summary": summary,
        "retirement_pipeline": pipeline,
        "recent_movements": [],
        "tier3_graduation_candidates": candidates,
    }

@app.get("/api/range-mgmt/weekly-sor")
def range_mgmt_weekly_sor(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, _ = _style_filters(country, channel, "i")
    raw = run_query("""
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number,
                MIN(substring(style_launch_date, 1, 10)) FILTER (
                    WHERE substring(style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                ) AS launch_date
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''
            GROUP BY style_name
        ),
        new_styles AS (
            SELECT * FROM prod
            WHERE launch_date IS NOT NULL AND launch_date::date >= CURRENT_DATE - INTERVAL '98 days'
        ),
        sales AS (
            SELECT p.style_name, s.sale_date::date AS sd, SUM(s.net_quantity) AS units
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
              AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name, s.sale_date::date
        ),
        stock AS (
            SELECT style_name, COALESCE(SUM(available), 0) AS current_stock
            FROM all_inventory i
            WHERE style_name IN (SELECT style_name FROM new_styles)
              AND pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)""" + icf + """
            GROUP BY style_name
        )
        SELECT n.style_name, n.brand, n.subcategory, n.style_number, n.launch_date,
            COALESCE(st.current_stock, 0) AS current_stock, sa.sd, sa.units
        FROM new_styles n
        LEFT JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        ORDER BY n.style_name
    """)
    today = date.today()
    min_combined = 5
    styles = {}
    for r in raw:
        name = r["style_name"]
        st = styles.get(name)
        if st is None:
            launch = _parse_iso_date(r["launch_date"])
            st = styles[name] = {
                "style_name": name, "brand": r["brand"], "subcategory": r["subcategory"],
                "style_number": r["style_number"], "launch_date": r["launch_date"],
                "launch": launch, "current_stock": int(r["current_stock"] or 0), "sales": [],
            }
        if r["sd"] is not None and r["units"]:
            st["sales"].append((r["sd"], int(r["units"])))

    rows = []
    for st in styles.values():
        launch = st["launch"]
        if not launch:
            continue
        age_weeks = (today - launch).days / 7.0
        if age_weeks < 0 or age_weeks >= 14:
            continue
        lifetime_units = sum(u for _, u in st["sales"])
        denom = lifetime_units + st["current_stock"]
        if denom < min_combined:
            continue
        max_week = min(14, int(age_weeks) + 1)
        cum = [0] * 14
        for sd, u in st["sales"]:
            wk = (sd - launch).days // 7 + 1
            if 1 <= wk <= 14:
                cum[wk - 1] += u
        running = 0
        weekly_sor = []
        for n in range(1, 15):
            running += cum[n - 1]
            weekly_sor.append(round(running * 100.0 / denom, 1) if n <= max_week else None)
        rows.append({
            "style_name": st["style_name"], "brand": st["brand"], "subcategory": st["subcategory"],
            "style_number": st["style_number"], "launch_date": st["launch_date"],
            "age_weeks": round(age_weeks, 1), "current_stock": st["current_stock"],
            "weekly_sor": weekly_sor,
        })
    rows.sort(key=lambda x: x["age_weeks"])
    return {"weeks": list(range(1, 15)), "rows": rows, "min_combined": min_combined}

@app.get("/api/range-mgmt/marketing-candidates")
def stub_range_mgmt_marketing_candidates(): return []
@app.get("/api/feedback")
def stub_feedback_get(): return []
@app.get("/api/feedback/mine")
def stub_feedback_mine(): return []
@app.get("/api/search")
def stub_search(): return []
@app.get("/api/search/customers")
def stub_search_customers(): return []
@app.get("/api/thumbnails")
def stub_thumbnails(): return []

# --- GET stubs returning objects ---
@app.get("/api/analytics/cache-stats")
def stub_analytics_cache_stats(): return {}
@app.get("/api/admin/cache-stats")
def stub_admin_cache_stats(): return {}
@app.get("/api/admin/reconciliation-check")
def stub_admin_reconciliation_check(): return {"ok": True}
@app.get("/api/data-freshness")
def stub_data_freshness(): return {"fresh": True, "last_updated": None}
@app.get("/api/ibt/late-count")
def stub_ibt_late_count(): return {"count": 0}
@app.get("/api/notifications/unread-count")
def stub_notifications_unread_count(): return {"unread": 0}
@app.get("/api/leaderboard/store-of-the-week")
def stub_leaderboard_store_of_the_week(): return {}
@app.get("/api/thumbnails/lookup")
def stub_thumbnails_lookup(): return {}
@app.get("/api/auth/activity-streak")
def stub_auth_activity_streak(): return {"streak": 0}
@app.get("/api/auth/allowed-domains")
def stub_auth_allowed_domains(): return {"domains": []}
@app.get("/api/auth/heartbeat")
def stub_auth_heartbeat(): return {"ok": True}
@app.get("/api/user/last-visit")
def stub_user_last_visit(): return {"last_visit": None}
@app.get("/api/chat")
def stub_chat_get(): return {"reply": ""}

def _fmt_bucket_label(d, bucket):
    if bucket == "week":
        return "Wk " + d.strftime("%b %d")
    if bucket == "month":
        return d.strftime("%b %Y")
    if bucket == "quarter":
        return "Q%d %d" % ((d.month - 1) // 3 + 1, d.year)
    return d.strftime("%b %d")

@app.get("/api/analytics/kpi-trend")
def get_kpi_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    bucket:    str = Query(default="day"),
):
    bucket = bucket if bucket in ("day", "week", "month", "quarter") else "day"
    where = build_filters(date_from, date_to, country)
    rows = run_query("""
        SELECT
            date_trunc('""" + bucket + """', s.sale_date::date)::date AS bucket_date,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discount,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY 1
        ORDER BY 1
    """, date_to=date_to)
    for r in rows:
        d = r.pop("bucket_date")
        r["date"] = str(d)
        r["label"] = _fmt_bucket_label(d, bucket)
    return rows

# --- GET stub used also as POST below (marketing-actions) ---
@app.get("/api/range-mgmt/marketing-actions")
def stub_range_mgmt_marketing_actions_get(): return []

# --- POST stubs ---
@app.post("/api/auth/verify-password")
async def stub_auth_verify_password(request: Request): return {"ok": True, "valid": True}
@app.post("/api/allocations/calculate")
async def allocations_calculate(request: Request):
    body = await request.json()
    subcategory = body.get("subcategory")
    color = body.get("color")
    sizes = body.get("sizes") or []
    units_total = int(body.get("units_total") or 0)
    vw = float(body.get("velocity_weight") or 0)
    sw = float(body.get("stock_weight") or 0)
    aw = float(body.get("asp_weight") or 0)
    wh_pct = float(body.get("warehouse_pct") or 0)
    on_pct = float(body.get("online_pct") or 0)
    excluded = set(body.get("excluded_stores") or [])
    style_name = body.get("style_name")
    alloc_type = body.get("allocation_type") or "new"
    def _iso(v, default):
        try:
            return date.fromisoformat(str(v)[:10]).isoformat()
        except (ValueError, TypeError):
            return default
    dfrom = _iso(body.get("date_from"), str(date.today() - timedelta(days=90)))
    dto = _iso(body.get("date_to"), str(date.today()))

    pack_rows = run_query("""
        SELECT size, COUNT(*) AS n FROM all_products_clean
        WHERE size IS NOT NULL AND size <> '' AND size NOT LIKE '%/%'
        GROUP BY size ORDER BY n DESC LIMIT 12
    """)
    full_pack = {}
    if pack_rows:
        mn = min(float(r["n"]) for r in pack_rows) or 1
        for r in pack_rows:
            full_pack[r["size"]] = max(1, min(4, int(round(float(r["n"]) / mn))))
    pack_breakdown = {sz: full_pack.get(sz, 1) for sz in sizes}
    pack_unit_size = sum(pack_breakdown.values()) or 1
    store_units = units_total * max(0.0, 1.0 - (wh_pct + on_pct) / 100.0)
    total_packs = int(store_units // pack_unit_size)

    extra = ""
    if subcategory:
        extra += " AND p.product_type = '" + subcategory.replace("'", "''") + "'"
    if color:
        extra += " AND p.color_print ILIKE '%" + color.replace("'", "''") + "%'"
    if alloc_type == "replenishment" and style_name:
        extra += " AND p.style_name = '" + style_name.replace("'", "''") + "'"
    rows = run_query("""
        WITH vel AS (
            SELECT s.pos_location_name AS store,
                SUM(s.net_quantity) AS units_sold, SUM(s.net_sales_kes::numeric) AS sales
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date BETWEEN '""" + dfrom + """' AND '""" + dto + """'
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'""" + extra + """
            GROUP BY s.pos_location_name
        ),
        stk AS (
            SELECT i.pos_location_name AS store, SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND i.pos_location_name NOT ILIKE '%online%'""" + extra + """
            GROUP BY i.pos_location_name
        )
        SELECT COALESCE(v.store, k.store) AS store,
            COALESCE(v.units_sold, 0) AS units_sold, COALESCE(v.sales, 0) AS sales,
            COALESCE(k.soh, 0) AS soh
        FROM vel v FULL OUTER JOIN stk k ON k.store = v.store
        WHERE COALESCE(v.store, k.store) IS NOT NULL
    """)
    stores = [r for r in rows if r["store"] and r["store"] not in excluded]
    max_units = max((float(r["units_sold"]) for r in stores), default=0) or 1
    max_soh = max((float(r["soh"]) for r in stores), default=0) or 1

    def asp(r):
        u = float(r["units_sold"]) or 0
        return (float(r["sales"]) / u) if u else 0

    max_asp = max((asp(r) for r in stores), default=0) or 1
    wsum = (vw + sw + aw) or 1
    scored = []
    for r in stores:
        u, soh = float(r["units_sold"]), float(r["soh"])
        vel_score = u / max_units
        low_stock_score = 1.0 - (soh / max_soh)
        asp_score = asp(r) / max_asp
        score = (vw * vel_score + sw * low_stock_score + aw * asp_score) / wsum
        scored.append({
            "store": r["store"], "score": max(0.0, score),
            "velocity_score": round(vel_score, 4), "low_stock_score": round(low_stock_score, 4),
            "units_sold_window": int(u), "current_soh": int(soh),
        })
    candidates = [s for s in scored if s["score"] > 0] or scored
    tot_score = sum(s["score"] for s in candidates) or 1
    raw = [(s, total_packs * s["score"] / tot_score) for s in candidates]
    alloc = {s["store"]: int(q) for s, q in raw}
    remaining = total_packs - sum(alloc.values())
    fracs = sorted(raw, key=lambda x: (x[1] - int(x[1])), reverse=True)
    i = 0
    while remaining > 0 and fracs:
        alloc[fracs[i % len(fracs)][0]["store"]] += 1
        remaining -= 1
        i += 1
    out_rows = []
    for s in candidates:
        packs = alloc.get(s["store"], 0)
        if packs <= 0:
            continue
        out_rows.append({
            "store": s["store"], "packs_allocated": packs,
            "units_allocated": packs * pack_unit_size,
            "velocity_score": s["velocity_score"], "low_stock_score": s["low_stock_score"],
            "units_sold_window": s["units_sold_window"], "current_soh": s["current_soh"],
        })
    out_rows.sort(key=lambda r: r["packs_allocated"], reverse=True)
    return {"rows": out_rows, "pack_unit_size": pack_unit_size, "pack_breakdown": pack_breakdown}


@app.post("/api/allocations/save")
async def allocations_save(request: Request):
    body = await request.json()
    body_rows = body.get("rows") or []
    run = {
        "id": hashlib.md5((str(time.time()) + str(body.get("style_name"))).encode()).hexdigest()[:12],
        "style_name": body.get("style_name"), "color": body.get("color"),
        "allocation_type": body.get("allocation_type"), "subcategory": body.get("subcategory"),
        "units_total": body.get("units_total"),
        "pack_unit_size": body.get("pack_unit_size"), "pack_breakdown": body.get("pack_breakdown") or {},
        "status": "pending_fulfilment", "created_at": date.today().isoformat() + "T00:00",
        "created_by_name": "Planner", "created_by_email": "planner@vivo",
        "fulfilled_by_email": None, "fulfilled_at": None,
        "suggested_total": sum(int(r.get("suggested_units") or 0) for r in body_rows),
        "allocated_total": sum(int(r.get("allocated_units") or 0) for r in body_rows),
        "rows": [],
    }
    for r in body_rows:
        sizes = r.get("sizes") or {}
        run["rows"].append({
            "store": r.get("store"),
            "buying_packs": r.get("suggested_packs") or 0, "suggested_packs": r.get("suggested_packs") or 0,
            "buying_units": r.get("suggested_units") or 0, "suggested_units": r.get("suggested_units") or 0,
            "allocated_packs": r.get("allocated_packs") or 0,
            "allocated_units": r.get("allocated_units") or 0, "warehouse_units": 0,
            "buying_sizes": sizes, "warehouse_sizes": {}, "sizes": sizes,
        })
    run["delta_total"] = run["allocated_total"] - run["suggested_total"]
    _ALLOC_RUNS.insert(0, run)
    return run


@app.patch("/api/allocations/runs/{run_id}/fulfil")
async def allocations_runs_fulfil(run_id: str, request: Request):
    body = await request.json()
    fulfil_rows = {r.get("store"): (r.get("sizes") or {}) for r in (body.get("rows") or [])}
    for run in _ALLOC_RUNS:
        if run.get("id") == run_id:
            if run.get("status") == "fulfilled":
                from fastapi import HTTPException
                raise HTTPException(status_code=400, detail="Run already fulfilled")
            total = 0
            for r in run.get("rows", []):
                szs = fulfil_rows.get(r["store"])
                if szs is not None:
                    szs = {k: int(v or 0) for k, v in szs.items()}
                    r["warehouse_sizes"] = szs
                    r["warehouse_units"] = sum(szs.values())
                else:
                    r["warehouse_sizes"] = r.get("buying_sizes") or {}
                    r["warehouse_units"] = r.get("buying_units") or 0
                total += r["warehouse_units"]
            run["status"] = "fulfilled"
            run["allocated_total"] = total
            run["delta_total"] = total - (run.get("suggested_total") or 0)
            run["fulfilled_by_email"] = "warehouse@vivo"
            run["fulfilled_at"] = date.today().isoformat() + "T00:00"
            return run
    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail="Run not found")
@app.post("/api/admin/cache-clear")
async def stub_admin_cache_clear(request: Request): return {"ok": True}
@app.post("/api/admin/flush-kpi-cache")
async def stub_admin_flush_kpi_cache(request: Request): return {"ok": True}
@app.post("/api/admin/full-snapshot-rebuild")
async def stub_admin_full_snapshot_rebuild(request: Request): return {"ok": True}
@app.post("/api/admin/run-audit-now")
async def stub_admin_run_audit_now(request: Request): return {"ok": True}
@app.patch("/api/admin/users/{user_id}")
@app.post("/api/admin/users/{user_id}")
async def stub_admin_users_update(user_id: str, request: Request): return {"ok": True}
@app.post("/api/analytics/replenishment-report/mark")
async def analytics_replenishment_report_mark(request: Request):
    body = await request.json()
    sku = body.get("sku")
    barcode = body.get("barcode")
    pos_location = body.get("pos_location")
    if not pos_location or (not sku and not barcode):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="pos_location and one of sku/barcode are required")
    replenished = bool(body.get("replenished", True))
    actual = int(body.get("actual_units_replenished") or 0)
    # Callers identify rows by either sku (Replenishments) or barcode
    # (ReplenishmentReport); store under both so either GET row matches.
    keys = []
    if sku:
        keys.append((pos_location, "sku", sku))
    if barcode:
        keys.append((pos_location, "barcode", barcode))
    for key in keys:
        if replenished:
            _REPLEN_MARKS[key] = {"replenished": True, "actual_units_replenished": actual}
        else:
            _REPLEN_MARKS.pop(key, None)
    return {
        "ok": True, "sku": sku, "barcode": barcode, "pos_location": pos_location,
        "replenished": replenished, "actual_units_replenished": actual,
    }
@app.post("/api/ibt/complete")
async def stub_ibt_complete(request: Request): return {"ok": True}
@app.post("/api/notifications/read-all")
async def stub_notifications_read_all(request: Request): return {"ok": True}
@app.post("/api/notifications/refresh")
async def stub_notifications_refresh(request: Request): return {"ok": True}
@app.post("/api/notifications/{event_id}/read")
async def stub_notifications_read(event_id: str, request: Request): return {"ok": True}
@app.post("/api/marketing/weekly-report/send")
async def stub_marketing_weekly_report_send(request: Request): return {"ok": True}
@app.post("/api/range-mgmt/overrides/bulk-promote")
async def range_mgmt_overrides_bulk_promote(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if isinstance(body, list):
        items = body
        tier = "Tier 2"
        reason = "Bulk graduation to Tier 2"
    else:
        items = body.get("styles") or body.get("style_names") or []
        tier = body.get("tier") or "Tier 2"
        reason = body.get("reason") or "Manual graduation to %s" % tier
    upserted = 0
    for it in items:
        name = it.get("style_name") if isinstance(it, dict) else it
        if not name:
            continue
        _RANGE_OVERRIDES[name] = {"tier": (it.get("tier") if isinstance(it, dict) else None) or tier,
                                  "reason": (it.get("reason") if isinstance(it, dict) else None) or reason}
        upserted += 1
    return {"ok": True, "upserted": upserted}
@app.post("/api/range-mgmt/marketing-actions")
async def stub_range_mgmt_marketing_actions_post(request: Request): return {"ok": True}
@app.patch("/api/range-mgmt/marketing-actions/{action_id}")
@app.delete("/api/range-mgmt/marketing-actions/{action_id}")
async def stub_range_mgmt_marketing_actions_modify(action_id: str, request: Request): return {"ok": True}
@app.post("/api/feedback")
async def stub_feedback_post(request: Request): return {"ok": True, "id": 1}
@app.patch("/api/feedback/{feedback_id}")
@app.delete("/api/feedback/{feedback_id}")
async def stub_feedback_modify(feedback_id: str, request: Request): return {"ok": True}
@app.post("/api/thumbnails/{style}")
async def stub_thumbnails_post(style: str, request: Request): return {"ok": True}
@app.post("/api/auth/heartbeat")
async def stub_auth_heartbeat_post(request: Request): return {"ok": True}
@app.post("/api/recommendations")
async def stub_recommendations_post(request: Request): return {"ok": True}
@app.post("/api/admin/replenishment-config")
async def admin_replenishment_config_post(request: Request):
    global _REPLEN_OWNERS
    body = await request.json()
    owners = [str(o).strip() for o in (body.get("owners") or []) if str(o).strip()]
    _REPLEN_OWNERS = owners or ["Matthew", "Teddy", "Alvi", "Emma"]
    return {"ok": True, "owners": list(_REPLEN_OWNERS)}
@app.post("/api/chat")
async def stub_chat_post(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    return {
        "session_id": body.get("session_id") or "local",
        "answer": "The conversational assistant isn't available in this build.",
    }
@app.post("/api/search/ask")
async def stub_search_ask_post(request: Request):
    return {
        "answer": "Natural-language search isn't available in this build. Use the filters and pages to explore the data.",
        "intent": "unknown",
        "count": 0,
        "link": None,
        "rows": [],
        "followups": [],
    }


# ── Clerk Frontend-API reverse proxy (production only) ────────────────────────
# Mirrors the Node `clerkProxyMiddleware`: proxies the browser's Clerk
# Frontend-API calls through our own domain so Clerk works on .replit.app /
# custom domains without CNAME DNS. Inactive in development (Clerk proxying
# only works for production instances) and when no secret key is configured.
import requests
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response as _StarletteResponse

_CLERK_FAPI = "https://frontend-api.clerk.dev"
_CLERK_PROXY_PREFIX = "/api/__clerk"
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length",
}


def _clerk_proxy_enabled() -> bool:
    return (
        os.environ.get("REPLIT_DEPLOYMENT") == "1"
        and bool(os.environ.get("CLERK_SECRET_KEY"))
    )


@app.api_route(
    "/api/__clerk/{clerk_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def clerk_frontend_proxy(clerk_path: str, request: Request):
    if not _clerk_proxy_enabled():
        return JSONResponse({"detail": "Not found"}, status_code=404)
    target = f"{_CLERK_FAPI}/{clerk_path}"
    if request.url.query:
        target += f"?{request.url.query}"

    proto = request.headers.get("x-forwarded-proto", "https")
    fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    host = fwd_host.split(",")[0].strip()
    proxy_url = f"{proto}://{host}{_CLERK_PROXY_PREFIX}"

    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP and k.lower() not in ("host",)
    }
    fwd_headers["Clerk-Proxy-Url"] = proxy_url
    fwd_headers["Clerk-Secret-Key"] = os.environ["CLERK_SECRET_KEY"]
    xff = request.headers.get("x-forwarded-for")
    client_ip = (xff.split(",")[0].strip() if xff else None) or (
        request.client.host if request.client else None
    )
    if client_ip:
        fwd_headers["X-Forwarded-For"] = client_ip

    body = await request.body()

    def _do_request():
        return requests.request(
            request.method,
            target,
            headers=fwd_headers,
            data=body if body else None,
            timeout=20,
            allow_redirects=False,
        )

    upstream = await run_in_threadpool(_do_request)
    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    return _StarletteResponse(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
    )


from fastapi.staticfiles import StaticFiles
import pathlib

# Serve React build as static files
build_dir = pathlib.Path(__file__).parent / "dashboard" / "build"
if build_dir.exists():
    app.mount("/static", StaticFiles(directory=str(build_dir / "static")), name="static")

    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        from fastapi.responses import FileResponse
        from fastapi import Response
        index = build_dir / "index.html"
        response = FileResponse(str(index))
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
