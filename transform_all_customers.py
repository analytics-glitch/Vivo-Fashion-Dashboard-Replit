"""Build and incrementally maintain the BI customer read model."""

import logging
import os
import re
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("VIVO_DATABASE_URL") or os.environ["DATABASE_URL"]

SHOPIFY_COUNTRIES = {
    "vivo-uganda": "Uganda",
    "vivo-rwanda": "Rwanda",
    "shop-zetu": "Online",
}
COUNTRY_DIAL = {"Kenya": "254", "Uganda": "256", "Rwanda": "250", "Online": "254"}


def norm_email(value):
    value = (value or "").strip().lower()
    return value or None


def norm_phone(country, *values):
    """Return a country-prefixed canonical phone number."""
    for value in values:
        digits = re.sub(r"[^0-9]", "", value or "")
        if len(digits) >= 9:
            return COUNTRY_DIAL.get(country, "254") + digits[-9:]
    return None


def norm_name(value):
    return re.sub(r"\s+", " ", (value or "").strip()) or None


def ensure_customer_profile_columns(cur):
    """Additive columns used by the Shopify profile read model."""
    cur.execute("ALTER TABLE all_customers ADD COLUMN IF NOT EXISTS state TEXT")
    cur.execute(
        "ALTER TABLE all_customers "
        "ADD COLUMN IF NOT EXISTS accepts_email_marketing BOOLEAN"
    )
    cur.execute(
        "ALTER TABLE all_customers "
        "ADD COLUMN IF NOT EXISTS accepts_sms_marketing BOOLEAN"
    )
    cur.execute(
        "ALTER TABLE all_customers "
        "ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ"
    )


def upsert_shopify_store(cur, store_id, customer_ids=None, synced_at=None):
    """Atomically refresh one active Shopify market without touching Odoo."""
    if store_id not in SHOPIFY_COUNTRIES:
        raise ValueError(f"Unsupported Shopify customer store: {store_id}")
    ensure_customer_profile_columns(cur)
    country = SHOPIFY_COUNTRIES[store_id]
    dial = COUNTRY_DIAL[country]
    synced_at = synced_at or datetime.now(timezone.utc)
    id_filter = ""
    params = [dial, country, synced_at, store_id]
    if customer_ids is not None:
        if not customer_ids:
            return 0
        id_filter = "AND r.id = ANY(%s)"
        params.append(customer_ids)
    cur.execute(
        f"""
        INSERT INTO all_customers (
            customer_id, store_id, first_name, last_name, email, phone,
            city, country, state, customer_type, total_orders,
            total_spend_kes, avg_order_value_kes, first_order_date,
            last_order_date, preferred_size, accepts_email_marketing,
            accepts_sms_marketing, profile_updated_at, last_synced
        )
        SELECT
            r.id,
            r.store_id,
            NULLIF(REGEXP_REPLACE(TRIM(COALESCE(r.first_name, '')), '\\s+', ' ', 'g'), ''),
            NULLIF(REGEXP_REPLACE(TRIM(COALESCE(r.last_name, '')), '\\s+', ' ', 'g'), ''),
            NULLIF(LOWER(TRIM(COALESCE(r.email, ''))), ''),
            CASE
                WHEN LENGTH(REGEXP_REPLACE(
                    COALESCE(r.phone, r.default_address_phone, ''), '[^0-9]', '', 'g'
                )) >= 9
                THEN %s || RIGHT(REGEXP_REPLACE(
                    COALESCE(r.phone, r.default_address_phone, ''), '[^0-9]', '', 'g'
                ), 9)
                ELSE NULL
            END,
            r.default_address_city,
            %s,
            r.default_address_province,
            CASE WHEN COALESCE(r.orders_count, 0) > 1
                 THEN 'Returning' ELSE 'New' END,
            COALESCE(r.orders_count, 0),
            COALESCE(r.total_spent, 0),
            CASE WHEN COALESCE(r.orders_count, 0) > 0
                 THEN ROUND(r.total_spent / r.orders_count, 2) ELSE 0 END,
            LEFT(r.created_at, 10),
            LEFT(r.updated_at, 10),
            NULL,
            r.accepts_email_marketing,
            r.accepts_sms_marketing,
            NULLIF(r.updated_at, '')::timestamptz,
            %s
        FROM raw_shopify_customers r
        WHERE r.store_id = %s
          {id_filter}
        ON CONFLICT (customer_id, store_id) DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            state = EXCLUDED.state,
            customer_type = EXCLUDED.customer_type,
            total_orders = EXCLUDED.total_orders,
            total_spend_kes = EXCLUDED.total_spend_kes,
            avg_order_value_kes = EXCLUDED.avg_order_value_kes,
            first_order_date = EXCLUDED.first_order_date,
            last_order_date = EXCLUDED.last_order_date,
            preferred_size = EXCLUDED.preferred_size,
            accepts_email_marketing = EXCLUDED.accepts_email_marketing,
            accepts_sms_marketing = EXCLUDED.accepts_sms_marketing,
            profile_updated_at = EXCLUDED.profile_updated_at,
            last_synced = EXCLUDED.last_synced
        """,
        tuple(params),
    )
    return cur.rowcount


def _odoo_rows(cur, synced_at):
    cur.execute("""
        SELECT DISTINCT ON (id)
            id, email, name, phone, mobile, city, state_name,
            country_name, store_id
        FROM raw_odoo_customers
        ORDER BY id, write_date DESC
    """)
    rows = []
    for (
        oid,
        email,
        name,
        phone,
        mobile,
        city,
        state_name,
        country_name,
        store_id,
    ) in cur.fetchall():
        country = country_name or "Kenya"
        # Keep the complete Odoo name together; splitting multi-word names
        # weakens canonical identity matching.
        rows.append(
            (
                str(oid),
                store_id or "vivofashiongroup",
                norm_name(name),
                None,
                norm_email(email),
                norm_phone(country, phone, mobile),
                city,
                country,
                state_name,
                "New",
                0,
                0.0,
                0.0,
                None,
                None,
                None,
                None,
                None,
                synced_at,
            )
        )
    return rows


def _backfill_order_stats(cur):
    """Preserve the existing cross-store customer-stat semantics."""
    log.info("Backfilling order stats from all_sales...")
    cur.execute("""
        UPDATE all_customers ac
        SET
            total_orders = agg.order_count,
            total_spend_kes = agg.total_kes,
            avg_order_value_kes = CASE
                WHEN agg.order_count > 0
                THEN ROUND(agg.total_kes / agg.order_count, 2)
                ELSE 0
            END,
            first_order_date = agg.first_date,
            last_order_date = agg.last_date,
            customer_type = CASE
                WHEN agg.order_count > 1 THEN 'Returning' ELSE 'New'
            END
        FROM (
            SELECT
                s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes)::numeric, 2) AS total_kes,
                MIN(s.sale_date) AS first_date,
                MAX(s.sale_date) AS last_date
            FROM all_sales s
            WHERE s.customer_id IS NOT NULL
              AND s.customer_id NOT IN ('', 'None', 'null')
              AND s.sale_kind IN ('sale', 'order')
            GROUP BY s.customer_id
        ) agg
        WHERE ac.customer_id = agg.customer_id
    """)
    log.info("Updated %d customer stat rows", cur.rowcount)


def main():
    """Full rebuild: active Shopify markets plus Kenya's Odoo feed."""
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.now(timezone.utc)
    try:
        log.info("Building all_customers from raw tables...")
        ensure_customer_profile_columns(cur)
        cur.execute("TRUNCATE all_customers")

        # Kenya comes only from Odoo. Retired `vivowoman` Shopify profiles are
        # intentionally excluded from the active BI read model.
        odoo_rows = _odoo_rows(cur, now)
        if odoo_rows:
            execute_values(
                cur,
                """
                INSERT INTO all_customers (
                    customer_id, store_id, first_name, last_name, email, phone,
                    city, country, state, customer_type, total_orders,
                    total_spend_kes, avg_order_value_kes, first_order_date,
                    last_order_date, preferred_size, accepts_email_marketing,
                    accepts_sms_marketing, last_synced
                ) VALUES %s
                ON CONFLICT (customer_id, store_id) DO UPDATE SET
                    first_name = EXCLUDED.first_name,
                    last_name = EXCLUDED.last_name,
                    email = EXCLUDED.email,
                    phone = EXCLUDED.phone,
                    city = EXCLUDED.city,
                    country = EXCLUDED.country,
                    state = EXCLUDED.state,
                    last_synced = EXCLUDED.last_synced
                """,
                odoo_rows,
                page_size=1000,
            )

        # Full rebuilds and ongoing syncs share the complete projection.
        for store_id in SHOPIFY_COUNTRIES:
            count = upsert_shopify_store(cur, store_id, synced_at=now)
            log.info("Shopify %s: %d rows materialized", store_id, count)

        _backfill_order_stats(cur)
        conn.commit()

        cur.execute("""
            SELECT store_id, COUNT(*)
            FROM all_customers
            GROUP BY store_id
            ORDER BY COUNT(*) DESC
        """)
        for store_id, count in cur.fetchall():
            log.info("all_customers %s: %d rows", store_id, count)

        try:
            conn.set_isolation_level(0)
            with conn.cursor() as vacuum_cur:
                vacuum_cur.execute("VACUUM ANALYZE all_customers")
            log.info("VACUUM ANALYZE all_customers complete")
        except Exception as exc:
            log.warning("VACUUM all_customers failed (non-fatal): %s", exc)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()