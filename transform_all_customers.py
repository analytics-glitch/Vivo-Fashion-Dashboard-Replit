import os
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    log.info("Building all_customers from raw tables...")
    cur.execute("TRUNCATE all_customers")

    # ── 1. Shopify customers (Kenya, Uganda, Rwanda, Shop Zetu) ──────────────
    cur.execute("""
        SELECT DISTINCT ON (id, store_id)
            id, store_id, email, first_name, last_name,
            phone, state, total_spent, orders_count,
            accepts_email_marketing, accepts_sms_marketing,
            created_at, updated_at
        FROM raw_shopify_customers
        ORDER BY id, store_id, _loaded_at DESC
    """)
    shopify_customers = cur.fetchall()
    log.info("Shopify customers: %d", len(shopify_customers))

    # ── 2. Odoo customers with Shopify ID mapping ────────────────────────────
    cur.execute("""
        SELECT DISTINCT ON (id)
            id, shopify_user_id, email, name,
            phone, mobile, street, city,
            state_name, country_name, store_id
        FROM raw_odoo_customers
        ORDER BY id, write_date DESC
    """)
    odoo_customers = {r[0]: r for r in cur.fetchall()}
    log.info("Odoo customers: %d", len(odoo_customers))

    # Build Shopify ID → Odoo customer map
    shopify_to_odoo = {}
    for odoo_id, r in odoo_customers.items():
        shopify_id = r[1]
        if shopify_id:
            shopify_to_odoo[str(shopify_id)] = r

    rows = []

    # Insert Shopify customers
    for c in shopify_customers:
        (cid, store_id, email, first_name, last_name,
         phone, state, total_spent, orders_count,
         accepts_email, accepts_sms,
         created_at, updated_at) = c

        # Try to enrich with Odoo data
        odoo = shopify_to_odoo.get(str(cid))
        city    = odoo[7] if odoo else None
        country = odoo[9] if odoo else None

        # Determine country from store
        if not country:
            if store_id == 'vivo-uganda':
                country = 'Uganda'
            elif store_id == 'vivo-rwanda':
                country = 'Rwanda'
            elif store_id == 'shop-zetu':
                country = 'Online'
            else:
                country = 'Kenya'

        customer_type = 'Returning' if (orders_count or 0) > 1 else 'New'
        total_kes = float(total_spent or 0)
        avg_kes   = round(total_kes / orders_count, 2) if orders_count else 0

        rows.append((
            str(cid),           # customer_id
            store_id,           # store_id
            first_name,         # first_name
            last_name,          # last_name
            email,              # email
            phone,              # phone
            city,               # city
            country,            # country
            customer_type,      # customer_type
            orders_count or 0,  # total_orders
            total_kes,          # total_spend_kes
            avg_kes,            # avg_order_value_kes
            created_at[:10] if created_at else None,  # first_order_date
            updated_at[:10] if updated_at else None,  # last_order_date
            None,               # preferred_size
            now,                # last_synced
        ))

    # Insert Odoo customers keyed by their Odoo partner_id.
    # all_sales stores Kenya POS customer_id = Odoo partner_id, so we MUST
    # key by Odoo ID here — not shopify_user_id — or the join never matches.
    # Shopify customers that also exist in Odoo are already inserted above under
    # their Shopify ID; these Odoo rows give a second lookup path by Odoo ID.
    for odoo_id, r in odoo_customers.items():
        (oid, shopify_uid, email, name, phone, mobile,
         street, city, state_name, country_name, store_id) = r

        country = country_name or 'Kenya'
        parts   = (name or '').split(' ', 1)
        first   = parts[0] if parts else None
        last    = parts[1] if len(parts) > 1 else None

        # Always insert under the Odoo ID (what all_sales uses for POS orders)
        rows.append((
            str(oid),
            store_id or 'vivofashiongroup',
            first, last, email,
            phone or mobile,
            city, country,
            'New', 0, 0.0, 0.0,
            None, None, None, now,
        ))

    log.info("Total customer rows to insert: %d", len(rows))

    execute_values(cur, """
        INSERT INTO all_customers (
            customer_id, store_id, first_name, last_name, email, phone,
            city, country, customer_type, total_orders, total_spend_kes,
            avg_order_value_kes, first_order_date, last_order_date,
            preferred_size, last_synced
        ) VALUES %s
        ON CONFLICT (customer_id, store_id) DO UPDATE SET
            email = EXCLUDED.email,
            total_orders = EXCLUDED.total_orders,
            total_spend_kes = EXCLUDED.total_spend_kes,
            last_synced = EXCLUDED.last_synced
    """, rows, page_size=1000)

    # ── Backfill order stats for Odoo-keyed customers from all_sales ───────────
    # Shopify customers already have accurate stats from raw_shopify_customers.
    # Odoo rows were inserted with 0/NULL stats; compute them from all_sales now.
    log.info("Backfilling order stats for Odoo customers from all_sales...")
    cur.execute("""
        UPDATE all_customers ac
        SET
            total_orders        = agg.order_count,
            total_spend_kes     = agg.total_kes,
            avg_order_value_kes = CASE WHEN agg.order_count > 0
                                       THEN ROUND(agg.total_kes / agg.order_count, 2)
                                       ELSE 0 END,
            first_order_date    = agg.first_date,
            last_order_date     = agg.last_date,
            customer_type       = CASE WHEN agg.order_count > 1 THEN 'Returning' ELSE 'New' END
        FROM (
            SELECT
                s.customer_id,
                COUNT(DISTINCT s.order_id)    AS order_count,
                ROUND(SUM(s.total_sales_kes)::numeric, 2) AS total_kes,
                MIN(s.sale_date)              AS first_date,
                MAX(s.sale_date)              AS last_date
            FROM all_sales s
            WHERE s.customer_id IS NOT NULL
              AND s.sale_kind IN ('sale','order')
              AND s.store_id   = 'vivofashiongroup'
            GROUP BY s.customer_id
        ) agg
        WHERE ac.customer_id = agg.customer_id
          AND ac.store_id    = 'vivofashiongroup'
    """)
    log.info("Updated %d Odoo customer stat rows", cur.rowcount)

    conn.commit()

    cur.execute("""
        SELECT store_id, COUNT(*) FROM all_customers
        GROUP BY store_id ORDER BY COUNT(*) DESC
    """)
    print("\n=== all_customers summary ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} customers")

    cur.execute("SELECT COUNT(*) FROM all_customers")
    log.info("✅ all_customers total: %d", cur.fetchone()[0])
    conn.close()

if __name__ == "__main__":
    main()