import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta
import time
import logging
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]


def ensure_heartbeat_table(conn):
    with conn.cursor() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS sync_heartbeat (
                id            INT PRIMARY KEY DEFAULT 1,
                last_cycle_at TIMESTAMPTZ,
                last_status   TEXT,
                CONSTRAINT sync_heartbeat_single CHECK (id = 1)
            )
        """)
    conn.commit()


def write_heartbeat(conn, status):
    """Record that the sync loop is alive and making progress.

    Deliberately decoupled from data freshness (all_sales.loaded_at): during
    quiet periods with no new sales, loaded_at stops advancing even though the
    loop is perfectly healthy. The watchdog keys off this heartbeat so it never
    restarts a working sync just because business was slow.
    """
    try:
        with conn.cursor() as c:
            c.execute(
                """
                INSERT INTO sync_heartbeat (id, last_cycle_at, last_status)
                VALUES (1, now(), %s)
                ON CONFLICT (id) DO UPDATE
                    SET last_cycle_at = now(), last_status = EXCLUDED.last_status
            """,
                (status,),
            )
        conn.commit()
    except Exception as e:
        log.warning("heartbeat write failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


STORES = [
    {
        "store_id": "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token": os.environ["SHOPIFY_UGANDA_TOKEN"],
        "country": "Uganda",
        "currency": "UGX",
        "vat": 1.18,
    },
    {
        "store_id": "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token": os.environ["SHOPIFY_RWANDA_TOKEN"],
        "country": "Rwanda",
        "currency": "RWF",
        "vat": 1.18,
    },
    # shop-zetu handled separately via ShopifyQL
]

UGANDA_LOCATIONS = {
    59649392798: "The Oasis Mall",
    111194112366: "Vivo Acacia",
}
RWANDA_LOCATIONS = {
    65931444396: "Vivo Kigali Heights",
    69236097196: "Vivo M-peace Plaza",
}

SITE_LOCATION_MAP = {
    "Vivo Junction": "Vivo Junction",
    "Vivo Sarit Centre": "Vivo Sarit",
    "Vivo Village Market": "Vivo Village Market",
    "Vivo Westgate": "Vivo T- Mall",
    "Vivo Garden City": "Vivo Garden City",
    "Vivo Two Rivers": "Vivo Two Rivers",
    "Vivo Galleria": "Vivo Galleria",
    "Vivo Hub Karen": "Vivo Hub",
    "Vivo Greenspan": "Vivo Greenspan",
    "Vivo Capital Centre": "Vivo Capital Centre",
    "Vivo Yaya": "Vivo Yaya",
    "Vivo Mama Ngina": "Vivo Mama Ngina St",
    "Vivo TRM": "Vivo TRM",
    "Vivo Kisumu": "Vivo Kisumu",
    "Vivo Nakuru": "Vivo Nakuru",
    "Vivo Meru": "Vivo Meru",
    "Vivo Eldoret": "Vivo Eldoret",
    "Vivo Mombasa Digo": "Vivo MSA Digo Road",
    "Vivo City Mall": "Vivo City Mall",
    "Vivo Signature": "Vivo Signature Mall",
    "Vivo Runda": "Vivo Runda",
    "Vivo Kileleshwa": "Vivo Kileleshwa",
    "Vivo Imaara": "Vivo Imaara",
}

ODOO_LOCATION_MAP = {
    "Capital Centre": "Vivo Capital Centre",
    "Eldoret (Rupa)": "Vivo Eldoret",
    "Galleria": "Vivo Galleria",
    "Garden City": "Vivo Garden City",
    "Greenspan": "Vivo Greenspan",
    "HQ Outlet": "Staff purchases",
    "Hub": "Vivo Hub",
    "Imaara": "Vivo Imaara",
    "Junction": "Vivo Junction",
    "Kileleshwa": "Vivo Kileleshwa",
    "Kisumu (United Mall)": "Vivo Kisumu",
    "Mama Ngina": "Vivo Mama Ngina St",
    "Meru (Green Wood)": "Vivo Meru",
    "Moi Avenue": "Vivo Moi Avenue",
    "Mombasa (City Mall)": "Vivo City Mall",
    "Mombasa CBD": "Vivo MSA Digo Road",
    "Nakuru (Westside Mall)": "Vivo Nakuru",
    "Runda Mall": "Vivo Runda",
    "Sarit": "Vivo Sarit",
    "Sarit Safari": "Safari Sarit",
    "Signature Mall": "Vivo Signature Mall",
    "Thika Road Mall": "Vivo TRM",
    "Tmall": "Vivo T- Mall",
    "Two Rivers": "Vivo Two Rivers",
    "Village Market": "Vivo Village Market",
    "Yaya": "Vivo Yaya",
    "Zoya Sarit": "Zoya Sarit",
    "Shopzetu Online": "Online - Shop Zetu",
}

UGANDA_VAT_LOCATIONS = {"The Oasis Mall", "Vivo Acacia"}
RWANDA_VAT_LOCATIONS = {"Vivo Kigali Heights", "Vivo M-peace Plaza"}


def get_exchange_rates(cur):
    """Get latest exchange rates from currency_rates table"""
    cur.execute("""
        SELECT DISTINCT ON (country) country, rate
        FROM currency_rates
        ORDER BY country, month DESC
    """)
    rates = {row[0]: float(row[1]) for row in cur.fetchall()}
    return rates


def get_vat(pos_location, store_vat=1.16):
    if pos_location in UGANDA_VAT_LOCATIONS:
        return 1.18
    if pos_location in RWANDA_VAT_LOCATIONS:
        return 1.18
    return store_vat


# How many days before the last known sale to re-pull each run. Defaults to 2
# (incremental overlap); the watchdog widens this for recovery backfills via the
# --days flag / SYNC_LOOKBACK_DAYS env var.
LOOKBACK_DAYS = int(os.environ.get("SYNC_LOOKBACK_DAYS", "2"))
# Module-level guard so the fabric (Odoo) extract runs at most once per minute even
# though main() is invoked every 60s by the supervising loop. Persists for the
# lifetime of the process.
_LAST_FABRIC_EXTRACT = None
# Same once-per-minute guard for the fabric consumption/returns sheet override loader.
_LAST_FABRIC_SHEET_EXTRACT = None
# Guards the production tracker (Odoo DPS buying & manufacturing orders) sync to
# once per 30 minutes even though main() runs every 60s.
_LAST_PRODUCTION_SYNC = None
# Module-level guard so attendance syncs at most once per hour even though main()
# runs every 60s. None on boot so the first cycle after a (re)start refreshes
# immediately. Persists for the lifetime of the process.
_LAST_ATTENDANCE_SYNC = None
# Guards the BI sales-rollup refresh (build_sales_rollups.py) to once per hour even
# though main() runs every 60s. The rollup windows are CURRENT_DATE-relative, so a
# daily refresh is the floor; hourly keeps them comfortably inside the read-path
# freshness gate. None on boot so the first cycle bootstraps immediately.
_LAST_ROLLUP_REFRESH = None
# Guards the product image extract (extract_product_images.py — base64 512px
# product photos from Odoo, feeding the /gallery thumbnails) to once per 24h
# even though main() runs every 60s. Product photos change rarely and this is
# the heaviest Odoo pull (full image fetch per template), so a daily cadence is
# plenty. None on boot so a fresh prod DB bootstraps on the first cycle.
_LAST_PRODUCT_IMAGES_EXTRACT = None
# Guards the data-validation agent (validation_agent.run) to once per hour even
# though main() runs every 60s. The agent self-skips outside its active window
# (06:00-22:00 Africa/Nairobi), so this hourly cadence yields one audit per hour
# inside that window. None on boot so the first cycle runs immediately (the agent
# itself decides whether it is within active hours).
_LAST_VALIDATION_RUN = None
# ── Attendance Sync ───────────────────────────────────────────────────────────
ATTENDANCE_API_URL = os.environ.get(
    "ATTENDANCE_API_URL", "https://beverly-noncontending-bertram.ngrok-free.dev"
)


def ensure_attendance_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS vivo_attendance (
            user_id             INTEGER,
            employee_name       TEXT,
            privilege_level     TEXT,
            branch_name         TEXT,
            branch_country      TEXT,
            location            TEXT,
            device_type         TEXT,
            device_ip           TEXT,
            device_port         INTEGER,
            device_status       TEXT,
            device_fail_count   INTEGER,
            device_last_seen    TIMESTAMPTZ,
            attendance_date     DATE,
            check_in_time       TIMESTAMPTZ,
            check_out_time      TIMESTAMPTZ,
            hours_worked        FLOAT,
            is_complete         BOOLEAN,
            punch_count         INTEGER,
            attendance_status   TEXT,
            synced_at           TIMESTAMPTZ,
            pushed_at           TIMESTAMPTZ,
            PRIMARY KEY (user_id, branch_name, attendance_date)
        );
        CREATE INDEX IF NOT EXISTS idx_vivo_att_date     ON vivo_attendance (attendance_date);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_branch   ON vivo_attendance (branch_name);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_employee ON vivo_attendance (employee_name);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_location ON vivo_attendance (location);
    """)


def get_attendance_cursor(cur):
    cur.execute("SELECT MAX(attendance_date) FROM vivo_attendance")
    result = cur.fetchone()[0]
    if result:
        from datetime import timedelta

        return (result - timedelta(days=2)).strftime("%Y-%m-%d")
    return "2000-01-01"


def sync_attendance(cur):
        since = get_attendance_cursor(cur)
        log.info("Syncing attendance since %s", since)
        headers = {"ngrok-skip-browser-warning": "true"}

        # Retry up to 3 times on SSL/connection errors
        for attempt in range(3):
            try:
                resp = requests.get(
                    f"{ATTENDANCE_API_URL}/attendance",
                    params={"since": since},
                    headers=headers,
                    timeout=120,
                    verify=False,  # skip SSL verification for ngrok
                )
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Attendance fetch attempt %d failed: %s", attempt + 1, e)
                if attempt == 2:
                    raise
                time.sleep(10)

        data = resp.json()
        rows = data.get("rows", [])
        if not rows:
            log.info("Attendance — no new records")
            return 0

        # Deduplicate
        seen = set()
        deduped = []
        for r in rows:
            key = (r["user_id"], r["branch_name"], r["attendance_date"])
            if key not in seen:
                seen.add(key)
                deduped.append(r)
        log.info(
            "Attendance — %d records after dedup (from %d)", len(deduped), len(rows)
        )

        values = [
            (
                r["user_id"],
                r["employee_name"],
                r["privilege_level"],
                r["branch_name"],
                r["branch_country"],
                r["location"],
                r["device_type"],
                r["device_ip"],
                r["device_port"],
                r["device_status"],
                r["device_fail_count"],
                r["device_last_seen"],
                r["attendance_date"],
                r["check_in_time"],
                r["check_out_time"],
                r["hours_worked"],
                r["is_complete"],
                r["punch_count"],
                r["attendance_status"],
                r["synced_at"],
                r["pushed_at"],
            )
            for r in deduped
        ]
        execute_values(
            cur,
            """
            INSERT INTO vivo_attendance (
                user_id, employee_name, privilege_level,
                branch_name, branch_country, location,
                device_type, device_ip, device_port,
                device_status, device_fail_count, device_last_seen,
                attendance_date, check_in_time, check_out_time,
                hours_worked, is_complete, punch_count,
                attendance_status, synced_at, pushed_at
            ) VALUES %s
            ON CONFLICT (user_id, branch_name, attendance_date)
            DO UPDATE SET
                check_in_time     = EXCLUDED.check_in_time,
                check_out_time    = EXCLUDED.check_out_time,
                hours_worked      = EXCLUDED.hours_worked,
                is_complete       = EXCLUDED.is_complete,
                punch_count       = EXCLUDED.punch_count,
                attendance_status = EXCLUDED.attendance_status,
                device_status     = EXCLUDED.device_status,
                device_fail_count = EXCLUDED.device_fail_count,
                device_last_seen  = EXCLUDED.device_last_seen,
                synced_at         = EXCLUDED.synced_at,
                pushed_at         = EXCLUDED.pushed_at
        """,
            values,
            page_size=500,
        )
        log.info("✅ Attendance — %d records upserted", len(rows))
        return len(rows)


def get_last_sync(cur, store_id):
    cur.execute(
        "SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = %s", (store_id,)
    )
    result = cur.fetchone()[0]
    if result:
        since = result - timedelta(days=LOOKBACK_DAYS)
        return since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"


def fetch_orders(store_url, token, since, limit=250):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/orders.json"
    params = {
        "status": "any",
        "updated_at_min": since,
        "limit": limit,
        "order": "updated_at asc",
    }
    all_orders = []
    seen_ids = set()
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    time.sleep(int(resp.headers.get("Retry-After", 10)))
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt + 1, e)
                time.sleep(10)
        orders = resp.json().get("orders", [])
        for o in orders:
            if o["id"] not in seen_ids:
                seen_ids.add(o["id"])
                all_orders.append(o)
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_orders


KENYA_LOCATION_ID_MAP = {
    36310057056: "Vivo Sarit",
    36309925984: "Vivo Junction",
    36309958752: "Vivo Mama Ngina St",
    49383899291: "Vivo Moi Avenue",
    36309893216: "Vivo Garden City",
    36309991520: "Vivo Capital Centre",
    62460067995: "Vivo Imaara",
    50320343195: "Vivo Eldoret",
    61614751899: "Vivo Kisumu",
    36478648416: "Vivo Galleria",
    49363222683: "Vivo Hub",
    50320408731: "Vivo City Mall",
    50320277659: "Vivo Nakuru",
    73530376347: "Vivo Runda",
    66861301915: "Vivo Greenspan",
    66839806107: "Vivo Kileleshwa",
    66799567003: "Vivo Meru",
    69343084699: "Vivo MSA Digo Road",
    71464648859: "Safari Sarit",
    66820767899: "Staff purchases",
    66799599771: "vivowoman",
    49363320987: "Vivo Village Market",
    36478582880: "Vivo Yaya",
    49383833755: "Vivo Two Rivers",
    71464747163: "Vivo Village Market",
    63040127131: "Vivo TRM",
    61123592347: "Vivo Signature Mall",
    49363550363: "Vivo T- Mall",
    71464485019: "Zoya Sarit",
}


def get_pos_location(store, order):
    store_id = store["store_id"]
    location_id = order.get("location_id")
    fulfillments = order.get("fulfillments", [])
    if not location_id and fulfillments:
        location_id = fulfillments[0].get("location_id")
    if store_id == "vivo-uganda":
        return UGANDA_LOCATIONS.get(location_id, "Uganda")
    if store_id == "vivo-rwanda":
        return RWANDA_LOCATIONS.get(location_id, "Rwanda")
    if store_id == "shop-zetu":
        return "Online - Shop Zetu"
    if store_id == "vivowoman":
        return KENYA_LOCATION_ID_MAP.get(location_id, "vivowoman")
    return "vivowoman"


def process_shopify_store(store, cur, now, rates):
    store_id = store["store_id"]
    since = get_last_sync(cur, store_id)
    log.info("Syncing %s since %s", store_id, since[:10])

    orders = fetch_orders(store["store_url"], store["token"], since)
    if not orders:
        log.info("%s — no new orders", store_id)
        return 0

    order_ids = [str(o["id"]) for o in orders]
    rows = []

    for order in orders:
        order_id = str(order["id"])
        order_name = order.get("name", "")
        created_at = order.get("created_at", "")[:10]
        customer = order.get("customer") or {}
        customer_id = str(customer.get("id", "")) or None
        customer_type = "walk-in" if not customer_id else "registered"
        pos_location = get_pos_location(store, order)
        financial_status = order.get("financial_status", "")
        is_return = financial_status in ("refunded", "partially_refunded")
        sale_kind = "return" if is_return else "order"

        # Get exchange rate for this store's country
        rate = rates.get(store["country"], 1.0)
        vat = get_vat(pos_location, store["vat"])

        for line in order.get("line_items", []):
            sku = line.get("sku") or ""
            title = line.get("title", "")
            qty = int(line.get("quantity", 0))
            price = float(line.get("price", 0))  # VAT-inclusive in store currency
            disc = float(line.get("total_discount", 0))

            # Match BigQuery: total_sales = price * qty (VAT-inclusive, store currency)
            total_sales = price * qty
            gross_sales = total_sales  # before discounts
            discounts = disc
            net_sales = total_sales  # Shopify net_sales = total after discount
            returns = total_sales if is_return else 0.0
            total_out = 0.0 if is_return else total_sales

            # Convert to KES using exchange rate (matching BigQuery formula)
            total_sales_kes = round(total_sales / rate, 2)
            gross_sales_kes = round(gross_sales / rate, 2)
            discounts_kes = round(discounts / rate, 2)
            returns_kes = round(returns / rate, 2)
            net_sales_kes = round(total_sales / vat / rate, 2)
            product_price_kes = round(price / rate, 2)

            rows.append(
                (
                    str(uuid.uuid4()),
                    store_id,
                    order_id,
                    order_name,
                    created_at,
                    created_at,
                    pos_location,
                    store["country"],
                    (
                        "POS"
                        if (store_id == "vivowoman" and pos_location != "vivowoman")
                        else pos_location
                        if store_id == "vivo-uganda"
                        else "Online"
                    ),
                    customer_id,
                    customer_type,
                    sale_kind,
                    title,
                    sku,
                    qty,
                    product_price_kes,
                    price,
                    gross_sales_kes,
                    discounts_kes,
                    net_sales_kes,
                    round(total_out / rate, 2),
                    qty if not is_return else 0,
                    returns_kes,
                    now,
                )
            )

    cur.execute(
        "DELETE FROM all_sales WHERE store_id = %s AND order_id = ANY(%s)",
        (store_id, order_ids),
    )

    if rows:
        execute_values(
            cur,
            """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """,
            _dedup_all_sales_rows(rows),
            page_size=500,
        )

    log.info("✅ %s — %d orders, %d lines synced", store_id, len(orders), len(rows))
    return len(rows)


def _dedup_all_sales_rows(rows):
    """Collapse duplicate sync rows on the all_sales business grain
    (store_id, order_id, product_title, variant_sku, sale_kind, sale_date),
    keeping the first occurrence. Replaces the former DB-level arbiter
    `ON CONFLICT (...) DO NOTHING` (the uq_all_sales_line unique index, which
    production never had and could not accept due to legacy duplicate rows).
    The per-order DELETE-by-window before each INSERT handles cross-run
    idempotency; this only removes intra-batch duplicates. Tuple positions
    match the INSERT column order: 1=store_id, 2=order_id, 4=sale_date,
    11=sale_kind, 12=product_title, 13=variant_sku."""
    seen = set()
    out = []
    for r in rows:
        key = (r[1], r[2], r[12], r[13] or "", r[11], r[4])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def sync_odoo(cur, now, rates):
    import xmlrpc.client

    ODOO_URL = os.environ["ODOO_URL"]
    ODOO_DB = os.environ["ODOO_DB"]
    ODOO_USER = os.environ["ODOO_USER"]
    ODOO_PASS = os.environ["ODOO_PASSWORD"]

    # Anchor `since` to the actual data coverage, NOT loaded_at alone: a full
    # rebuild (transform_all_sales) resets every row's loaded_at to "today", which
    # would push `since` ahead of the data we actually have (the raw Odoo source
    # can lag a few days), permanently skipping orders in the gap. LEAST(loaded_at,
    # sale_date) never runs ahead of real coverage, so the next sync self-heals.
    cur.execute("""
        SELECT LEAST(MAX(loaded_at::date), MAX(sale_date::date))
        FROM all_sales WHERE store_id = 'vivofashiongroup'
    """)
    result = cur.fetchone()[0]
    since = (
        (result - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
        if result
        else "2026-03-19 00:00:00"
    )

    log.info("Odoo sync since %s", since[:10])

    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    orders = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASS,
        "pos.order",
        "search_read",
        [
            [
                ["write_date", ">=", since],
                ["state", "in", ["done", "invoiced", "paid", "posted"]],
            ]
        ],
        {
            "fields": [
                "id",
                "name",
                "date_order",
                "write_date",
                "amount_total",
                "amount_tax",
                "partner_id",
                "config_id",
                "lines",
                "session_id",
            ],
            "limit": 5000,
        },
    )

    if not orders:
        log.info("Odoo — no new orders")
        return 0

    order_ids = [str(o["id"]) for o in orders]

    line_ids_all = [lid for o in orders for lid in o.get("lines", [])]
    lines_data = {}
    if line_ids_all:
        lines = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASS,
            "pos.order.line",
            "search_read",
            [[["id", "in", line_ids_all]]],
            {
                "fields": [
                    "order_id",
                    "product_id",
                    "qty",
                    "price_unit",
                    "price_subtotal_incl",
                    "discount",
                    "product_uom_id",
                ]
            },
        )
        for l in lines:
            oid = str(l["order_id"][0])
            lines_data.setdefault(oid, []).append(l)
        # Fetch product SKUs (default_code) for all products in these lines
        prod_ids = list({l["product_id"][0] for l in lines if l.get("product_id")})
        sku_map = {}
        if prod_ids:
            prods = models.execute_kw(
                ODOO_DB,
                uid,
                ODOO_PASS,
                "product.product",
                "search_read",
                [[["id", "in", prod_ids]]],
                {"fields": ["id", "default_code"]},
            )
            sku_map = {p["id"]: (p.get("default_code") or "") for p in prods}

    config_ids = list(set(o["config_id"][0] for o in orders if o.get("config_id")))
    configs = {}
    if config_ids:
        cfg_data = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASS,
            "pos.config",
            "search_read",
            [[["id", "in", config_ids]]],
            {"fields": ["id", "name"]},
        )
        configs = {c["id"]: c["name"] for c in cfg_data}

    kenya_rate = rates.get("Kenya", 1.0)

    rows = []
    for order in orders:
        order_id = str(order["id"])
        order_name = order.get("name", "")
        # Convert date_order from UTC to EAT (UTC+3) to match BigQuery
        from datetime import datetime as dt

        date_order_utc = order.get("date_order", "")
        try:
            date_order = (
                dt.strptime(date_order_utc[:19], "%Y-%m-%d %H:%M:%S")
                + timedelta(hours=3)
            ).strftime("%Y-%m-%d")
        except:
            date_order = date_order_utc[:10]
        partner = order.get("partner_id")
        customer_id = str(partner[0]) if partner else None
        customer_type = "walk-in" if not customer_id else "registered"
        config_name = (
            configs.get(order["config_id"][0], "") if order.get("config_id") else ""
        )
        pos_location = ODOO_LOCATION_MAP.get(config_name, config_name)

        # Odoo Kenya only — rate=1, but use correct VAT per location
        rate = kenya_rate  # always 1.0 for Kenya
        vat = get_vat(pos_location, 1.16)

        for line in lines_data.get(order_id, []):
            product = line.get("product_id")
            title = product[1] if product else ""
            qty = float(line.get("qty", 0))
            price_unit = float(line.get("price_unit", 0))  # VAT-inclusive unit price
            total_incl = float(
                line.get("price_subtotal_incl", 0)
            )  # VAT-inclusive line total
            disc_pct = float(line.get("discount", 0))

            # Skip shopping bags (match BigQuery filter)
            if "shopping bag" in title.lower():
                continue

            is_return = qty < 0
            sale_kind = "return" if is_return else "order"

            # Amount-as-quantity guard (mirrors transform_all_sales.transform_odoo):
            # a nominal KES-1/0 catch-all product whose quantity encodes the
            # charged amount (e.g. price_unit=1, qty=8600) must not count as real
            # units — left unclamped one such line inflates Units Sold / MSI / ASP.
            # Money fields are derived from price_subtotal_incl and stay correct.
            units_qty = abs(qty)
            if units_qty >= 20 and price_unit <= 1.0:
                units_qty = 1

            # Match BigQuery: total_sales = price_subtotal_incl (VAT-inclusive)
            total_sales = total_incl  # keep sign — negative qty = return
            gross_sales = price_unit * qty  # before discount
            discounts = gross_sales - total_sales if not is_return else 0.0
            discounts = max(discounts, 0.0)
            returns = abs(total_sales) if is_return else 0.0
            total_out = total_sales if not is_return else 0.0

            # KES conversion (rate=1 for Kenya, formula matches BigQuery)
            total_sales_kes = round(total_out / rate, 2)
            gross_sales_kes = round((gross_sales if not is_return else 0.0) / rate, 2)
            discounts_kes = round(discounts / rate, 2)
            returns_kes = round(returns / rate, 2)
            net_sales_kes = round(total_out / vat / rate, 2)
            product_price_kes = round(price_unit / rate, 2)

            sku = sku_map.get(product[0], "") if product else ""
            rows.append(
                (
                    str(uuid.uuid4()),
                    "vivofashiongroup",
                    order_id,
                    order_name,
                    date_order,
                    date_order,
                    pos_location,
                    "Kenya",
                    "POS",
                    customer_id,
                    customer_type,
                    sale_kind,
                    title,
                    sku,
                    int(units_qty),
                    product_price_kes,
                    price_unit,
                    gross_sales_kes,
                    discounts_kes,
                    net_sales_kes,
                    total_sales_kes,
                    int(units_qty) if not is_return else 0,
                    returns_kes,
                    now,
                )
            )

    cur.execute(
        "DELETE FROM all_sales WHERE store_id = 'vivofashiongroup' AND order_id = ANY(%s)",
        (order_ids,),
    )

    if rows:
        execute_values(
            cur,
            """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """,
            _dedup_all_sales_rows(rows),
            page_size=500,
        )

    log.info("✅ Odoo — %d orders, %d lines synced", len(orders), len(rows))
    return len(rows)


def sync_footfall(cur, now):
    FOOTFALL_URL = "https://v9.footfallcam.com"
    CUBE_URL = "https://cube.footfallcam.com/API/v1"
    EMAIL = os.environ.get("FOOTFALLCAM_EMAIL", "charles@vivofashiongroup.com")
    PASSWORD = os.environ.get("FOOTFALLCAM_PASSWORD", "Vivo@2030")

    expiration = (datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%d")
    resp = requests.post(
        f"{FOOTFALL_URL}/account/GenerateAccessToken",
        json={"email": EMAIL, "password": PASSWORD, "expiration": expiration},
        timeout=30,
    )
    resp.raise_for_status()
    token = resp.json().get("AToken")
    if not token:
        log.error("Footfall auth failed")
        return 0

    headers = {"Authorization": f"Bearer {token}"}

    cur.execute("SELECT MAX(time::date) FROM footfall")
    result = cur.fetchone()[0]
    since = (
        (result - timedelta(days=2)).strftime("%Y-%m-%d")
        if result
        else (now - timedelta(days=7)).strftime("%Y-%m-%d")
    )
    date_to = now.strftime("%Y-%m-%d")

    log.info("Footfall sync %s → %s", since, date_to)

    payload = {
        "query": {
            "measures": ["ffc_site_summary.A01", "ffc_site_summary.A05"],
            "timeDimensions": [
                {
                    "dimension": "ffc_site_summary.Time",
                    "granularity": "day",
                    "dateRange": [since, date_to],
                }
            ],
            "dimensions": ["ffc_site_summary.SiteName"],
            "limit": 50000,
        }
    }

    resp = requests.post(CUBE_URL + "/load", json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json().get("data", [])

    if not data:
        log.info("No footfall data")
        return 0

    rows = []
    seen = set()
    for rec in data:
        site = rec.get("ffc_site_summary.SiteName", "")
        pos_loc = SITE_LOCATION_MAP.get(site, site)
        day = (
            rec.get("ffc_site_summary.Time") or rec.get("ffc_site_summary.Time.day", "")
        )[:10]
        ff_in = int(float(rec.get("ffc_site_summary.A01") or 0))
        outside = int(float(rec.get("ffc_site_summary.A05") or 0))
        key = (day, site)
        if key in seen:
            continue
        seen.add(key)
        rows.append((f"{site}_{day}", day, site, pos_loc, ff_in, outside))

    if rows:
        cur.execute(
            "DELETE FROM footfall WHERE time >= %s AND time <= %s", (since, date_to)
        )
        execute_values(
            cur,
            """
            INSERT INTO footfall (site_id, time, site_name, pos_location_name,
                a01_footfall_in, a05_outside_traffic)
            VALUES %s
            ON CONFLICT DO NOTHING
        """,
            rows,
            page_size=500,
        )
        log.info("✅ Footfall — %d rows", len(rows))

    return len(rows)


def categorise_products(cur):
    """Fill missing product_type and category based on product name keywords."""
    cur.execute("""
        UPDATE all_products_clean
        SET product_type = CASE
            WHEN UPPER(product_name) LIKE '%SAMPLE%' OR UPPER(product_name) LIKE '%GIFT VOUCHER%'
                OR UPPER(product_name) LIKE '%GIFT CARD%' OR UPPER(sku) LIKE '%FS%'
                OR UPPER(sku) LIKE 'CS%' OR UPPER(sku) LIKE 'SALE%' THEN 'Sample & Sale Items'
            WHEN LOWER(product_name) LIKE '%fitness bra%' OR LOWER(product_name) LIKE '%sports bra%'
                OR LOWER(product_name) LIKE '%bralette%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%fitness tights%' OR LOWER(product_name) LIKE '%legging%'
                OR LOWER(product_name) LIKE '%biker%' THEN 'Leggings'
            WHEN LOWER(product_name) LIKE '%catsuit%' OR LOWER(product_name) LIKE '%jumpsuit%'
                OR LOWER(product_name) LIKE '%playsuit%' OR LOWER(product_name) LIKE '%romper%' THEN 'Jumpsuits & Playsuits'
            WHEN LOWER(product_name) LIKE '%scarf%' OR LOWER(product_name) LIKE '%hijab%'
                OR LOWER(product_name) LIKE '%shawl%' OR LOWER(product_name) LIKE '%sarong%'
                OR LOWER(product_name) LIKE '%wrap%' OR LOWER(product_name) LIKE '%scarve%' THEN 'Scarves'
            WHEN LOWER(product_name) LIKE '%blazer%' OR LOWER(product_name) LIKE '%jacket%'
                OR LOWER(product_name) LIKE '%cardigan%' OR LOWER(product_name) LIKE '%coat%' THEN 'Jackets & Coats'
            WHEN LOWER(product_name) LIKE '%poncho%' OR LOWER(product_name) LIKE '%sweater%' THEN 'Sweaters & Ponchos'
            WHEN LOWER(product_name) LIKE '%waterfall%' OR LOWER(product_name) LIKE '%kimono%'
                OR LOWER(product_name) LIKE '%shrug%' OR LOWER(product_name) LIKE '%cover%' THEN 'Waterfalls & Kimonos'
            WHEN LOWER(product_name) LIKE '%hoodie%' OR LOWER(product_name) LIKE '%sweatshirt%' THEN 'Hoodies & Sweatshirts'
            WHEN LOWER(product_name) LIKE '%bodysuit%' OR LOWER(product_name) LIKE '%bdodysuit%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%culotte%' THEN 'Culottes & Capri Pants'
            WHEN LOWER(product_name) LIKE '%palazzo%' OR LOWER(product_name) LIKE '%jogger%'
                OR LOWER(product_name) LIKE '%trouser%' OR LOWER(product_name) LIKE '%jeans%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%full%' AND LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%skort%' OR (LOWER(product_name) LIKE '%short%'
                AND LOWER(product_name) NOT LIKE '%top%' AND LOWER(product_name) NOT LIKE '%sleeve%') THEN 'Shorts & Skorts'
            WHEN LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%knee%' AND LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%midi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Midi & Capri Dresses'
            WHEN LOWER(product_name) LIKE '%mini%' AND LOWER(product_name) LIKE '%dress%' THEN 'Short & Mini Dresses'
            WHEN LOWER(product_name) LIKE '%bodycon%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%kaftan%' OR LOWER(product_name) LIKE '%maxi%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%skirt%' THEN 'Maxi Skirts'
            WHEN LOWER(product_name) LIKE '%skirt%' THEN 'Knee Length Skirts'
            WHEN LOWER(product_name) LIKE '%tee%' OR LOWER(product_name) LIKE '%t-shirt%'
                OR LOWER(product_name) LIKE '%tank%' THEN 'T-shirts & Tank Tops'
            WHEN LOWER(product_name) LIKE '%fitted%' AND LOWER(product_name) LIKE '%top%' THEN 'Fitted Tops'
            WHEN LOWER(product_name) LIKE '%loose%' AND LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%tunic%' OR LOWER(product_name) LIKE '%blouse%'
                OR LOWER(product_name) LIKE '%vest%' OR LOWER(product_name) LIKE '%chiffon%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%earring%' OR LOWER(product_name) LIKE '%bracelet%'
                OR LOWER(product_name) LIKE '%necklace%' OR LOWER(product_name) LIKE '%ring%'
                OR LOWER(product_name) LIKE '%belt%' OR LOWER(product_name) LIKE '%hat%'
                OR LOWER(product_name) LIKE '%cap%' OR LOWER(product_name) LIKE '%bag%'
                OR LOWER(product_name) LIKE '%sock%' OR LOWER(product_name) LIKE '%accessori%' THEN 'Accessories'
            WHEN LOWER(product_name) LIKE '%shirt%' OR LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            ELSE 'Accessories'
        END
        WHERE product_type IS NULL OR TRIM(product_type) = ''
    """)

    cur.execute("""
        UPDATE all_products_clean
        SET category = CASE
            WHEN product_type IN ('Bodysuits','Fitted Tops','Loose Tops','Midriff & Crop Tops','T-shirts & Tank Tops') THEN 'Tops'
            WHEN product_type IN ('Culottes & Capri Pants','Full Length Pants','Jumpsuits & Playsuits','Leggings','Shorts & Skorts') THEN 'Bottoms'
            WHEN product_type IN ('Knee Length Dresses','Maxi Dresses','Midi & Capri Dresses','Short & Mini Dresses') THEN 'Dresses'
            WHEN product_type IN ('Knee Length Skirts','Maxi Skirts','Midi & Capri Skirts','Short & Mini Skirts') THEN 'Skirts'
            WHEN product_type IN ('Hoodies & Sweatshirts','Jackets & Coats','Sweaters & Ponchos','Waterfalls & Kimonos') THEN 'Outerwear'
            WHEN product_type IN ('Skirts & Top Set','Pants & Top Set','Two-Piece Sets') THEN 'Two-Piece Sets'
            WHEN product_type IN ('Accessories','Scarves','Belts','Earrings','Necklaces') THEN 'Accessories'
            WHEN product_type = 'Sample & Sale Items' THEN 'Sale'
            ELSE 'Accessories'
        END
        WHERE category IS NULL OR TRIM(category) = ''
    """)
    # Sync NOOS flag from noos_styles table
    cur.execute("""
        UPDATE all_products_clean SET is_noos = FALSE WHERE is_noos = TRUE;
        UPDATE all_products_clean p
        SET is_noos = TRUE
        FROM noos_styles n
        WHERE p.product_name = n.product_name AND n.active = TRUE;
    """)
    log.info("✅ Product categorisation done")


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.now(timezone.utc)

    ensure_heartbeat_table(conn)
    write_heartbeat(conn, "cycle_start")

    # Load exchange rates once per sync cycle
    rates = get_exchange_rates(cur)
    log.info("Exchange rates: %s", rates)

    log.info("=== Starting incremental sync ===")

    for store in STORES:
        try:
            process_shopify_store(store, cur, now, rates)
            conn.commit()
            write_heartbeat(conn, f"store:{store['store_id']}")
        except Exception as e:
            log.error("Error syncing %s: %s", store["store_id"], e)
            conn.rollback()

    # Shop Zetu via ShopifyQL
    try:
        import subprocess, sys

        subprocess.run(
            [sys.executable, "/home/runner/workspace/extract_shopzetu_shopifyql.py"],
            check=True,
        )
        log.info("Shop Zetu ShopifyQL sync done")
    except Exception as e:
        log.error("Shop Zetu ShopifyQL sync error: %s", e)

    try:
        sync_odoo(cur, now, rates)
        conn.commit()
        write_heartbeat(conn, "odoo")
    except Exception as e:
        log.error("Odoo sync error: %s", e)
        conn.rollback()

    # Categorise any new products
    try:
        categorise_products(cur)
        conn.commit()
    except Exception as e:
        log.error("Categorisation error: %s", e)
        conn.rollback()

    try:
        sync_footfall(cur, now)
        conn.commit()
        write_heartbeat(conn, "footfall")
    except Exception as e:
        log.error("Footfall sync error: %s", e)
        conn.rollback()

    # Inventory sync — once a day at midnight EAT (21:00 UTC)
    now_utc = datetime.now(timezone.utc)
    if 21 <= now_utc.hour < 22:
        try:
            import subprocess, sys

            log.info("Running nightly inventory sync...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_odoo_inventory.py"],
                check=True,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_shopify_inventory.py"],
                check=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    "/home/runner/workspace/extract_shopzetu_inventory.py",
                ],
                check=True,
            )
            log.info("✅ Nightly inventory sync complete")
        except Exception as e:
            log.error("Inventory sync error: %s", e)

    # Attendance sync — HOURLY (the HR dashboard wants near-real-time figures).
    # Rate-limited to once per hour via a module-level guard even though main()
    # runs every 60s; runs immediately on the first cycle after a (re)start.
    global _LAST_ATTENDANCE_SYNC
    attendance_due = (
        _LAST_ATTENDANCE_SYNC is None
        or (now_utc - _LAST_ATTENDANCE_SYNC).total_seconds() >= 3600
    )
    if attendance_due:
        # Stamp up front so a transient failure waits an hour before retrying.
        _LAST_ATTENDANCE_SYNC = now_utc
        try:
            ensure_attendance_table(cur)
            conn.commit()
            sync_attendance(cur)
            conn.commit()
            write_heartbeat(conn, "attendance")
        except Exception as e:
            log.error("Attendance sync error: %s", e)
            conn.rollback()

    # Data-validation agent — HOURLY during its active window (06:00-22:00 EAT).
    # Self-contained module (validation_agent/) that reads the live DB and writes
    # ONLY its own tables (metric_baselines, validation_audit, validation_exceptions).
    # Run as a subprocess via the same entry point as the standalone command so a
    # failure or a hung LLM call can never crash the sync loop. The agent self-skips
    # outside active hours, so this hourly guard yields at most one audit per hour
    # in-window. Rate-limited to once per hour even though main() runs every 60s.
    global _LAST_VALIDATION_RUN
    validation_due = (
        _LAST_VALIDATION_RUN is None
        or (now_utc - _LAST_VALIDATION_RUN).total_seconds() >= 3600
    )
    if validation_due:
        # Stamp up front so a transient failure waits an hour before retrying.
        _LAST_VALIDATION_RUN = now_utc
        try:
            import subprocess, sys

            log.info("Running data-validation agent...")
            subprocess.run(
                [sys.executable, "-m", "validation_agent.run"],
                cwd="/home/runner/workspace",
                check=True,
                timeout=900,
            )
            log.info("✅ Data-validation agent run complete")
        except Exception as e:
            log.error("Data-validation agent error: %s", e)

    # Accounting sync — nightly at 21:00 UTC
    if 21 <= now_utc.hour < 22:
        try:
            import subprocess, sys

            log.info("Running nightly accounting sync...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_accounting.py"],
                check=True,
            )
            log.info("✅ Accounting sync complete")
        except Exception as e:
            log.error("Accounting sync error: %s", e)

    # Fabric (Odoo) sync — feeds the /fabric dashboard (raw_fabric_* tables).
    # Production runs on a SEPARATE DB that never ran extract_fabric.py, so the
    # tables start empty and /fabric shows zeros. We bootstrap immediately when
    # the tables are missing/empty (first deploy) so no manual step is needed,
    # then refresh EVERY MINUTE thereafter (the dashboard wants near-real-time fabric
    # figures). extract_fabric.py does a full TRUNCATE + upsert refresh, so it is
    # safe to re-run. A module-level guard rate-limits to once per minute even
    # though main() runs every 60s.
    global _LAST_FABRIC_EXTRACT
    fabric_empty = False
    try:
        cur.execute("SELECT to_regclass('public.raw_fabric_inventory')")
        if cur.fetchone()[0] is None:
            fabric_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM raw_fabric_inventory")
            fabric_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Fabric presence check error: %s", e)
        conn.rollback()
    fabric_due = (
        _LAST_FABRIC_EXTRACT is None
        or (now_utc - _LAST_FABRIC_EXTRACT).total_seconds() >= 60
    )
    if fabric_empty or fabric_due:
        # Stamp the attempt time up front so a transient failure waits a minute
        # (when still empty, the fabric_empty branch retries on the next cycle).
        _LAST_FABRIC_EXTRACT = now_utc
        try:
            import subprocess, sys

            log.info("Running fabric (Odoo) extract (bootstrap=%s)...", fabric_empty)
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_fabric.py"], check=True
            )
            log.info("✅ Fabric extract complete")
        except Exception as e:
            log.error("Fabric extract error: %s", e)

    # Fabric sheet override — the buying team's reconciled Jan–Apr 2026 consumption &
    # returns (Google Sheet), which replace Odoo's inflated moves for that window via
    # the fabric_moves_effective view. Lives in fabric_sheet_* tables (outside
    # raw_fabric_*) so it survives the Odoo TRUNCATE/rebuild. Bootstrap when
    # the override is empty/missing (fresh prod DB), then refresh EVERY MINUTE. Runs after
    # the Odoo fabric extract so raw_fabric_* exist when the view is (re)created.
    global _LAST_FABRIC_SHEET_EXTRACT
    sheet_empty = False
    try:
        cur.execute("SELECT to_regclass('public.fabric_sheet_consumption')")
        if cur.fetchone()[0] is None:
            sheet_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM fabric_sheet_consumption")
            sheet_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Fabric sheet presence check error: %s", e)
        conn.rollback()
    sheet_due = (
        _LAST_FABRIC_SHEET_EXTRACT is None
        or (now_utc - _LAST_FABRIC_SHEET_EXTRACT).total_seconds() >= 60
    )
    if sheet_empty or sheet_due:
        _LAST_FABRIC_SHEET_EXTRACT = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running fabric sheet override extract (bootstrap=%s)...", sheet_empty
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_fabric_sheet.py"],
                check=True,
            )
            log.info("✅ Fabric sheet override extract complete")
        except Exception as e:
            log.error("Fabric sheet override extract error: %s", e)

    # Production tracker sync — feeds the /production board (production_orders +
    # stage_movements) with the buying & manufacturing orders. New Odoo buying
    # orders (DPS documents) won't appear until this runs, so fold it into the
    # supervised loop instead of the manual standalone run. Production runs on a
    # SEPARATE DB, so bootstrap immediately when production_orders is empty
    # (fresh prod DB), then refresh EVERY 30 MINUTES.
    # sync_production_tracker.py is idempotent — it upserts on order_ref and only
    # appends the intake DELTA per DPS, so re-running never doubles intake. Runs
    # as a subprocess like the other Odoo extracts. A module-level guard
    # rate-limits to once per 30 minutes even though main() runs every 60s. The
    # production_orders/stage_movements tables are created by api_pg's startup
    # hook (_ensure_production_tables), and the watchdog brings the API up before
    # this loop, so we skip entirely if the table is missing and let the next
    # cycle pick it up once it exists (avoids erroring every 60s on a cold DB).
    global _LAST_PRODUCTION_SYNC
    production_table_missing = False
    production_empty = False
    try:
        cur.execute("SELECT to_regclass('public.production_orders')")
        if cur.fetchone()[0] is None:
            production_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM production_orders")
            production_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Production tracker presence check error: %s", e)
        conn.rollback()
    production_due = (
        _LAST_PRODUCTION_SYNC is None
        or (now_utc - _LAST_PRODUCTION_SYNC).total_seconds() >= 1800
    )
    if not production_table_missing and (production_empty or production_due):
        # Stamp the attempt time up front so a transient failure waits a minute
        # (when still empty, the production_empty branch retries next cycle).
        _LAST_PRODUCTION_SYNC = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running production tracker (Odoo) sync (bootstrap=%s)...",
                production_empty,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_production_tracker.py"],
                check=True,
            )
            log.info("✅ Production tracker sync complete")
        except Exception as e:
            log.error("Production tracker sync error: %s", e)

    # Product image extract — feeds the /gallery thumbnails (product_images +
    # product_image_map: base64 512px photos keyed by Odoo template, plus a
    # sku->template map). Production runs on a SEPARATE DB that never ran the
    # manual extract_product_images.py, so /gallery shows only coloured-initials
    # placeholders until this runs. We bootstrap immediately when product_images
    # is missing/empty (fresh prod DB) so no manual step is needed, then refresh
    # EVERY 24 HOURS (photos change rarely and this is the heaviest Odoo pull —
    # a full base64 image fetch per template). The extract reads
    # all_products_clean, so we skip until that transform has populated rows (it
    # runs earlier in this same cycle) and let a later cycle pick it up — this
    # avoids writing an empty map on a cold DB. extract_product_images.py upserts
    # on tmpl_id/sku (ON CONFLICT), so re-running never duplicates. Run as a
    # subprocess like the other Odoo extracts. A module-level guard rate-limits
    # to once per 24h even though main() runs every 60s.
    global _LAST_PRODUCT_IMAGES_EXTRACT
    images_empty = False
    products_ready = False
    try:
        cur.execute("SELECT to_regclass('public.product_images')")
        if cur.fetchone()[0] is None:
            images_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM product_images")
            images_empty = cur.fetchone()[0] == 0
        cur.execute("SELECT to_regclass('public.all_products_clean')")
        if cur.fetchone()[0] is not None:
            cur.execute(
                "SELECT EXISTS(SELECT 1 FROM all_products_clean WHERE product_id IS NOT NULL)"
            )
            products_ready = bool(cur.fetchone()[0])
        conn.commit()
    except Exception as e:
        log.error("Product images presence check error: %s", e)
        conn.rollback()
    images_due = (
        _LAST_PRODUCT_IMAGES_EXTRACT is None
        or (now_utc - _LAST_PRODUCT_IMAGES_EXTRACT).total_seconds() >= 86400
    )
    if products_ready and (images_empty or images_due):
        # Stamp the attempt time up front so a transient failure waits 24h before
        # retrying — except while still empty, where the images_empty branch keeps
        # retrying every cycle until the bootstrap succeeds.
        _LAST_PRODUCT_IMAGES_EXTRACT = now_utc
        try:
            import subprocess, sys

            log.info("Running product image extract (bootstrap=%s)...", images_empty)
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_product_images.py"],
                check=True,
            )
            log.info("✅ Product image extract complete")
        except Exception as e:
            log.error("Product image extract error: %s", e)

    # BI sales-rollup refresh — feeds the pre-aggregated rollup_* tables that make
    # the Customers / Range Management / Product Analysis endpoints fast. The read
    # paths in api_pg fall back to live SQL whenever a rollup is missing or stale,
    # so this is purely a performance refresh. Production runs on a SEPARATE DB that
    # never runs the full rebuild, so we bootstrap immediately when the rollup
    # tables are empty/missing (fresh prod DB) so the endpoints get fast on first
    # deploy, then refresh EVERY HOUR (the windows are CURRENT_DATE-relative, so a
    # daily refresh is the floor; hourly keeps them inside the freshness gate).
    # build_sales_rollups.py is a thin wrapper over api_pg.run_sales_rollup_refresh
    # (build-then-swap per table, idempotent), run as a subprocess like the other
    # extracts. rollup_meta is created by api_pg's startup hook and the watchdog
    # brings the API up before this loop, so skip if missing and let a later cycle
    # pick it up once it exists.
    global _LAST_ROLLUP_REFRESH
    rollup_table_missing = False
    rollup_empty = False
    try:
        cur.execute("SELECT to_regclass('public.rollup_meta')")
        if cur.fetchone()[0] is None:
            rollup_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM rollup_meta")
            rollup_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Rollup presence check error: %s", e)
        conn.rollback()
    rollup_due = (
        _LAST_ROLLUP_REFRESH is None
        or (now_utc - _LAST_ROLLUP_REFRESH).total_seconds() >= 3600
    )
    if not rollup_table_missing and (rollup_empty or rollup_due):
        # Stamp the attempt time up front so a transient failure waits an hour
        # (when still empty, the rollup_empty branch retries on the next cycle).
        _LAST_ROLLUP_REFRESH = now_utc
        try:
            import subprocess, sys

            log.info("Refreshing BI sales rollups (bootstrap=%s)...", rollup_empty)
            subprocess.run(
                [sys.executable, "/home/runner/workspace/build_sales_rollups.py"],
                check=True,
            )
            log.info("✅ BI sales rollups refreshed")
        except Exception as e:
            log.error("BI sales rollup refresh error: %s", e)

    # HR roster bootstrap — the staff roster (hr_employees) is hand-imported from
    # a company Google Sheet and the HR attendance pages enrich raw biometric
    # attendance via hr_employee_match -> hr_employees. Production runs on a
    # SEPARATE DB that was never loaded with the roster, so a fresh prod DB shows
    # no departments/teams/job-titles until this runs. Bootstrap immediately when
    # hr_employees is empty (fresh prod DB) and re-read from the sheet (source of
    # truth), then rebuild the name-match table. Once both the roster AND the
    # name-match table are populated this stops firing (roster changes are picked
    # up on demand via POST /api/hr/employees/rematch?reimport=1) so there is no
    # recurring LLM cost. The guard is completeness-based (not just roster
    # COUNT==0): it ALSO fires when hr_employees has rows but hr_employee_match is
    # empty, so a partial/interrupted first load self-heals on a later cycle
    # rather than leaving HR enrichment permanently broken. sync_hr_roster.py is
    # an idempotent full-refresh, run as a subprocess like the other extracts; it
    # imports api_pg so we skip if the tables are missing and let a later cycle
    # pick it up once the API's startup hook has created them.
    roster_table_missing = False
    roster_incomplete = False
    try:
        cur.execute(
            "SELECT to_regclass('public.hr_employees'),"
            "       to_regclass('public.hr_employee_match')"
        )
        emp_reg, match_reg = cur.fetchone()
        if emp_reg is None or match_reg is None:
            roster_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM hr_employees")
            emp_n = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM hr_employee_match")
            match_n = cur.fetchone()[0]
            # Empty roster (fresh prod DB) OR a roster that loaded but never got
            # its name-match table rebuilt (partial first load).
            roster_incomplete = (emp_n == 0) or (emp_n > 0 and match_n == 0)
        conn.commit()
    except Exception as e:
        log.error("HR roster presence check error: %s", e)
        conn.rollback()
    if not roster_table_missing and roster_incomplete:
        try:
            import subprocess, sys

            log.info("Bootstrapping HR roster from Google Sheet...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_hr_roster.py", "--ai"],
                check=True,
            )
            log.info("✅ HR roster bootstrap complete")
        except Exception as e:
            log.error("HR roster bootstrap error: %s", e)

    # Chronic-stockout snapshot — once a day around midnight EAT (21:00 UTC).
    # The API endpoint dedupes to a weekly cadence, so running it on every cycle
    # in this window is harmless; we only narrow to the hour to avoid pointless
    # calls the rest of the day. It authenticates with the shared SESSION_SECRET.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/replenishment/snapshot",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info(
                    "Stockout snapshot — HTTP %s %s", resp.status_code, resp.text[:200]
                )
            else:
                log.warning("Stockout snapshot skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Stockout snapshot error: %s", e)

    # Data-quality log — once a day in the same 21:00 UTC window. Records the
    # current overall data-quality score onto a sync_health_log row so quality
    # is tracked alongside sync health. Authenticates with the shared secret.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/data-quality/log",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info(
                    "Data-quality log — HTTP %s %s", resp.status_code, resp.text[:200]
                )
            else:
                log.warning("Data-quality log skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Data-quality log error: %s", e)

    write_heartbeat(conn, "ok")
    conn.close()
    log.info("=== Sync complete ===")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Vivo incremental sync")
    ap.add_argument(
        "--once",
        action="store_true",
        help="run a single sync cycle and exit (used for recovery)",
    )
    ap.add_argument(
        "--days",
        type=int,
        default=None,
        help="re-pull this many days before the last known sale",
    )
    cli = ap.parse_args()
    if cli.days is not None:
        LOOKBACK_DAYS = cli.days
        log.info("Lookback window overridden to %d days", LOOKBACK_DAYS)

    if cli.once:
        main()
    else:
        while True:
            try:
                main()
            except Exception as e:
                log.error("Fatal sync error: %s", e)
            log.info("Sleeping 1 minute...")
            time.sleep(60)
