"""Incremental Shopify customer-profile sync for non-Kenya markets.

Uganda, Rwanda and Shop Zetu are sourced from Shopify. Kenya is deliberately
excluded: its active customer feed is Odoo-backed.
"""

import argparse
import logging
import os
import time
from datetime import datetime, timezone

import psycopg2
import requests
from psycopg2.extras import execute_values

from transform_all_customers import ensure_customer_profile_columns, upsert_shopify_store


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]
BATCH_SIZE = 250
API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2025-10")
FIRST_SYNC_AT = "2019-01-01T00:00:00Z"
MAX_RETRIES = int(os.environ.get("SHOPIFY_CUSTOMER_MAX_RETRIES", "5"))
REQUEST_TIMEOUT_SEC = int(os.environ.get("SHOPIFY_CUSTOMER_TIMEOUT_SEC", "60"))

STORES = (
    {
        "store_id": "vivo-uganda",
        "store_url_env": "SHOPIFY_UGANDA_STORE",
        "token_env": "SHOPIFY_UGANDA_TOKEN",
        "country": "Uganda",
    },
    {
        "store_id": "vivo-rwanda",
        "store_url_env": "SHOPIFY_RWANDA_STORE",
        "token_env": "SHOPIFY_RWANDA_TOKEN",
        "country": "Rwanda",
    },
    {
        "store_id": "shop-zetu",
        "store_url_env": "SHOPZETU_STORE",
        "token_env": "SHOPZETU_TOKEN",
        "country": "Online",
    },
)

CUSTOMER_FIELDS = (
    "id,email,first_name,last_name,phone,default_address,state,total_spent,"
    "orders_count,accepts_marketing,email_marketing_consent,"
    "sms_marketing_consent,created_at,updated_at"
)


def active_stores():
    return [
        {
            **store,
            "store_url": os.environ[store["store_url_env"]],
            "token": os.environ[store["token_env"]],
        }
        for store in STORES
    ]


def ensure_sync_schema(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shopify_customer_sync_state (
            store_id TEXT PRIMARY KEY,
            watermark TIMESTAMPTZ,
            last_attempt_at TIMESTAMPTZ,
            last_success_at TIMESTAMPTZ,
            last_fetched_count INTEGER NOT NULL DEFAULT 0,
            last_upserted_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )
    """)
    cur.execute(
        "ALTER TABLE raw_shopify_customers "
        "ADD COLUMN IF NOT EXISTS default_address_city TEXT"
    )
    cur.execute(
        "ALTER TABLE raw_shopify_customers "
        "ADD COLUMN IF NOT EXISTS default_address_province TEXT"
    )
    cur.execute(
        "ALTER TABLE raw_shopify_customers "
        "ADD COLUMN IF NOT EXISTS default_address_country TEXT"
    )
    ensure_customer_profile_columns(cur)


def get_last_sync(cur, store_id):
    """Return the durable per-store Shopify updated_at watermark."""
    cur.execute(
        "SELECT watermark FROM shopify_customer_sync_state WHERE store_id = %s",
        (store_id,),
    )
    row = cur.fetchone()
    if row and row[0]:
        return row[0].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Upgrade path from the old extractor, which had no state table.
    cur.execute(
        """
        SELECT MAX(NULLIF(updated_at, '')::timestamptz)
        FROM raw_shopify_customers
        WHERE store_id = %s
        """,
        (store_id,),
    )
    row = cur.fetchone()
    if row and row[0]:
        return row[0].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return FIRST_SYNC_AT


def needs_full_read_model_reconcile(cur, store_id):
    """True until this source has completed at least one managed sync."""
    cur.execute(
        "SELECT last_success_at FROM shopify_customer_sync_state "
        "WHERE store_id = %s",
        (store_id,),
    )
    row = cur.fetchone()
    return row is None or row[0] is None


def _next_link(link_header):
    for part in (link_header or "").split(","):
        if 'rel="next"' in part:
            return part.split(";", 1)[0].strip().strip("<>")
    return None


def _request_page(session, url, headers, params, sleep=time.sleep, heartbeat=None):
    last_error = None
    for attempt in range(MAX_RETRIES):
        if heartbeat:
            heartbeat(f"request_attempt:{attempt + 1}")
        try:
            response = session.get(
                url,
                headers=headers,
                params=params,
                timeout=REQUEST_TIMEOUT_SEC,
            )
            if response.status_code == 429 or 500 <= response.status_code < 600:
                wait = float(
                    response.headers.get("Retry-After")
                    or min(2 ** attempt, 30)
                )
                last_error = requests.HTTPError(
                    f"Shopify transient HTTP {response.status_code}",
                    response=response,
                )
                if attempt + 1 < MAX_RETRIES:
                    log.warning(
                        "Shopify HTTP %s; retrying in %.1fs",
                        response.status_code,
                        wait,
                    )
                    if heartbeat:
                        heartbeat(f"retry_http:{response.status_code}")
                    sleep(wait)
                    continue
            response.raise_for_status()
            return response
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = exc
            if attempt + 1 < MAX_RETRIES:
                wait = min(2 ** attempt, 30)
                log.warning("Shopify request failed; retrying in %ss: %s", wait, exc)
                if heartbeat:
                    heartbeat("retry_connection")
                sleep(wait)
                continue
            raise
    raise last_error or RuntimeError("Shopify request failed")


def fetch_customers(store_url, token, since, session=requests, sleep=time.sleep,
                    heartbeat=None):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/{API_VERSION}/customers.json"
    params = {
        "updated_at_min": since,
        "limit": BATCH_SIZE,
        "fields": CUSTOMER_FIELDS,
    }
    customers = []
    page = 0
    while url:
        response = _request_page(
            session,
            url,
            headers,
            params,
            sleep=sleep,
            heartbeat=heartbeat,
        )
        batch = response.json().get("customers", [])
        customers.extend(batch)
        page += 1
        if heartbeat:
            heartbeat(f"shopify_customers:{store_url}:page:{page}")
        log.info(
            "Fetched Shopify customer page %d (+%d, total %d) from %s",
            page,
            len(batch),
            len(customers),
            store_url,
        )
        url = _next_link(response.headers.get("Link"))
        params = {}
    return customers


def _email_marketing(c):
    consent = c.get("email_marketing_consent") or {}
    if consent:
        return consent.get("state") == "subscribed"
    return bool(c.get("accepts_marketing", False))


def customer_row(c, store_id, loaded_at):
    address = c.get("default_address") or {}
    sms = c.get("sms_marketing_consent") or {}
    return (
        str(c["id"]),
        store_id,
        c.get("email"),
        c.get("first_name"),
        c.get("last_name"),
        c.get("phone") or address.get("phone"),
        address.get("phone"),
        address.get("city"),
        address.get("province"),
        address.get("country"),
        c.get("state"),
        float(c.get("total_spent", 0) or 0),
        int(c.get("orders_count", 0) or 0),
        _email_marketing(c),
        sms.get("state") == "subscribed",
        c.get("created_at"),
        c.get("updated_at"),
        loaded_at,
    )


RAW_UPSERT_SQL = """
    INSERT INTO raw_shopify_customers (
        id, store_id, email, first_name, last_name,
        phone, default_address_phone, default_address_city,
        default_address_province, default_address_country, state,
        total_spent, orders_count,
        accepts_email_marketing, accepts_sms_marketing,
        created_at, updated_at, _loaded_at
    ) VALUES %s
    ON CONFLICT (id, store_id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        phone = EXCLUDED.phone,
        default_address_phone = EXCLUDED.default_address_phone,
        default_address_city = EXCLUDED.default_address_city,
        default_address_province = EXCLUDED.default_address_province,
        default_address_country = EXCLUDED.default_address_country,
        state = EXCLUDED.state,
        total_spent = EXCLUDED.total_spent,
        orders_count = EXCLUDED.orders_count,
        accepts_email_marketing = EXCLUDED.accepts_email_marketing,
        accepts_sms_marketing = EXCLUDED.accepts_sms_marketing,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        _loaded_at = EXCLUDED._loaded_at
"""


def sync_store(store, connection_factory=psycopg2.connect, session=requests,
               sleep=time.sleep, heartbeat=None):
    """Sync and commit one market atomically; a caller can safely continue."""
    conn = connection_factory(DATABASE_URL)
    store_id = store["store_id"]
    attempted_at = datetime.now(timezone.utc)
    try:
        with conn.cursor() as cur:
            ensure_sync_schema(cur)
            first_managed_run = needs_full_read_model_reconcile(cur, store_id)
            since = get_last_sync(cur, store_id)
        conn.commit()

        log.info("Syncing Shopify customers for %s since %s", store_id, since)
        customers = fetch_customers(
            store["store_url"],
            store["token"],
            since,
            session=session,
            sleep=sleep,
            heartbeat=heartbeat,
        )
        loaded_at = datetime.now(timezone.utc)
        rows = [customer_row(c, store_id, loaded_at) for c in customers]
        customer_ids = [row[0] for row in rows]
        with conn.cursor() as cur:
            if rows:
                execute_values(cur, RAW_UPSERT_SQL, rows, page_size=500)
            upserted = upsert_shopify_store(
                cur,
                store_id,
                # On adoption, reconcile every existing raw profile into the BI
                # model once. Later runs stay cheap and touch only changed IDs.
                customer_ids=None if first_managed_run else customer_ids,
                synced_at=loaded_at,
            )
            watermark = max(
                [since] + [
                    c["updated_at"] for c in customers if c.get("updated_at")
                ]
            )
            cur.execute(
                """
                INSERT INTO shopify_customer_sync_state (
                    store_id, watermark, last_attempt_at, last_success_at,
                    last_fetched_count, last_upserted_count, last_error
                ) VALUES (%s, %s::timestamptz, %s, %s, %s, %s, NULL)
                ON CONFLICT (store_id) DO UPDATE SET
                    watermark = EXCLUDED.watermark,
                    last_attempt_at = EXCLUDED.last_attempt_at,
                    last_success_at = EXCLUDED.last_success_at,
                    last_fetched_count = EXCLUDED.last_fetched_count,
                    last_upserted_count = EXCLUDED.last_upserted_count,
                    last_error = NULL
                """,
                (
                    store_id,
                    watermark,
                    attempted_at,
                    loaded_at,
                    len(customers),
                    upserted,
                ),
            )
        conn.commit()
        result = {
            "store_id": store_id,
            "since": since,
            "watermark": watermark,
            "fetched": len(customers),
            "upserted": upserted,
            "success": True,
        }
        log.info("%s Shopify customers: %s", store_id, result)
        return result
    except Exception as exc:
        conn.rollback()
        try:
            with conn.cursor() as cur:
                ensure_sync_schema(cur)
                cur.execute(
                    """
                    INSERT INTO shopify_customer_sync_state (
                        store_id, last_attempt_at, last_error
                    ) VALUES (%s, %s, %s)
                    ON CONFLICT (store_id) DO UPDATE SET
                        last_attempt_at = EXCLUDED.last_attempt_at,
                        last_error = EXCLUDED.last_error
                    """,
                    (store_id, attempted_at, str(exc)[:800]),
                )
            conn.commit()
        except Exception:
            conn.rollback()
        raise
    finally:
        conn.close()


def sync_all_stores(stores=None, **kwargs):
    reports = []
    for store in stores or active_stores():
        try:
            reports.append(sync_store(store, **kwargs))
        except Exception as exc:
            report = {
                "store_id": store["store_id"],
                "success": False,
                "error": str(exc),
                "fetched": 0,
                "upserted": 0,
            }
            reports.append(report)
            log.error("%s Shopify customer sync failed: %s", store["store_id"], exc)
    return reports


def verify_coverage(connection_factory=psycopg2.connect):
    """Return non-PII freshness and recent visibility checks per market."""
    conn = connection_factory(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                WITH markets(store_id, country) AS (
                    VALUES
                        ('vivo-uganda', 'Uganda'),
                        ('vivo-rwanda', 'Rwanda'),
                        ('shop-zetu', 'Online')
                ),
                raw AS (
                    SELECT store_id, COUNT(*) AS raw_rows,
                           MAX(NULLIF(updated_at, '')::timestamptz) AS raw_updated_at
                    FROM raw_shopify_customers
                    GROUP BY store_id
                ),
                model AS (
                    SELECT store_id, COUNT(*) AS model_rows,
                           MAX(profile_updated_at) AS model_updated_at,
                           COUNT(*) FILTER (
                               WHERE profile_updated_at >= now() - interval '30 days'
                                 AND (
                                   NULLIF(BTRIM(COALESCE(first_name, '') || ' ' ||
                                                COALESCE(last_name, '')), '') IS NOT NULL
                                   OR NULLIF(BTRIM(COALESCE(email, '')), '') IS NOT NULL
                                   OR NULLIF(BTRIM(COALESCE(phone, '')), '') IS NOT NULL
                                 )
                           ) AS recent_visible_profiles
                    FROM all_customers
                    GROUP BY store_id
                ),
                recent_sales AS (
                    SELECT s.store_id,
                           COUNT(DISTINCT s.customer_id) AS identified,
                           COUNT(DISTINCT s.customer_id) FILTER (
                               WHERE c.customer_id IS NOT NULL
                           ) AS matched
                    FROM all_sales s
                    LEFT JOIN all_customers c
                      ON c.store_id = s.store_id
                     AND c.customer_id = s.customer_id
                    WHERE s.sale_date::date >= CURRENT_DATE - 30
                      AND s.sale_kind IN ('sale', 'order')
                      AND s.customer_id IS NOT NULL
                      AND s.customer_id NOT IN ('', 'None', 'null')
                    GROUP BY s.store_id
                )
                SELECT m.store_id, m.country,
                       st.watermark, st.last_success_at, st.last_error,
                       COALESCE(r.raw_rows, 0) AS raw_rows, r.raw_updated_at,
                       COALESCE(md.model_rows, 0) AS model_rows,
                       md.model_updated_at,
                       COALESCE(md.recent_visible_profiles, 0)
                           AS recent_visible_profiles,
                       COALESCE(rs.identified, 0) AS recent_identified_sales,
                       COALESCE(rs.matched, 0) AS recent_matched_profiles
                FROM markets m
                LEFT JOIN shopify_customer_sync_state st USING (store_id)
                LEFT JOIN raw r USING (store_id)
                LEFT JOIN model md USING (store_id)
                LEFT JOIN recent_sales rs USING (store_id)
                ORDER BY m.store_id
            """)
            columns = [d[0] for d in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--store",
        action="append",
        choices=[s["store_id"] for s in STORES],
        help="limit the run to one or more active Shopify customer sources",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="print non-PII per-market freshness and recent profile coverage",
    )
    args = parser.parse_args()
    if args.verify:
        for row in verify_coverage():
            log.info("VERIFY %s", row)
        return
    stores = active_stores()
    if args.store:
        wanted = set(args.store)
        stores = [s for s in stores if s["store_id"] in wanted]
    reports = sync_all_stores(stores)
    for report in reports:
        log.info("RESULT %s", report)
    if any(not report["success"] for report in reports):
        raise SystemExit(1)


if __name__ == "__main__":
    main()