"""
transform_all_sales.py
Mirrors BigQuery all_sales view exactly:
  1. shopify_deduped  → shopify_sales (dedup by line_item_id, order_id, day, store_id, product_title)
  2. shopzetu_clean   → raw_shopify_vendor_sales (no dedup)
  3. odoo_mapped      → raw_odoo_pos_order_lines + raw_odoo_pos_orders (dedup by unique line id l.id; latest _synced_at wins)
UNION ALL → all_sales physical table
"""

import os, logging, hashlib
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]

UGANDA_LOCATIONS = {"The Oasis Mall", "Vivo Acacia"}
RWANDA_LOCATIONS = {"Vivo Kigali Heights", "Vivo M-peace Plaza"}

ODOO_LOCATION_MAP = {
    "Sarit": "Vivo Sarit",
    "Moi Avenue": "Vivo Moi Avenue",
    "Mama Ngina": "Vivo Mama Ngina St",
    "Yaya": "Vivo Yaya",
    "Village Market": "Vivo Village Market",
    "Junction": "Vivo Junction",
    "Capital Centre": "Vivo Capital Centre",
    "Imaara": "Vivo Imaara",
    "Nakuru (Westside Mall)": "Vivo Nakuru",
    "Garden City": "Vivo Garden City",
    "Eldoret (Rupa)": "Vivo Eldoret",
    "Kisumu (United Mall)": "Vivo Kisumu",
    "Two Rivers": "Vivo Two Rivers",
    "Thika Road Mall": "Vivo TRM",
    "Hub": "Vivo Hub",
    "Galleria": "Vivo Galleria",
    "Runda Mall": "Vivo Runda",
    "Signature Mall": "Vivo Signature Mall",
    "Greenspan": "Vivo Greenspan",
    "Mombasa (City Mall)": "Vivo City Mall",
    "Tmall": "Vivo T- Mall",
    "Zoya Sarit": "Zoya Sarit",
    "Mombasa CBD": "Vivo MSA Digo Road",
    "Kileleshwa": "Vivo Kileleshwa",
    "Meru (Green Wood)": "Vivo Meru",
    "Sarit Safari": "Safari Sarit",
    "HQ Outlet": "Staff purchases",
}


def get_country(loc):
    if loc in RWANDA_LOCATIONS:
        return "Rwanda"
    if loc in UGANDA_LOCATIONS:
        return "Uganda"
    if "online" in loc.lower() or "shop zetu" in loc.lower():
        return "Online"
    return "Kenya"


def get_vat(loc):
    if loc in UGANDA_LOCATIONS or loc in RWANDA_LOCATIONS:
        return 1.18
    return 1.16


def get_channel(loc):
    if loc in ("Online - shop-zetu", "POS - 67096608987"):
        return "Online - Shop Zetu"
    if loc == "Online - safari-by-vivo":
        return "Online - Safari"
    return loc


def bulk_insert(cur, conn, rows, label):
    if not rows:
        log.info("%s: no rows to insert", label)
        return
    execute_values(
        cur,
        """
        INSERT INTO all_sales (
            id, store_id, sale_date, order_id, order_name,
            purchase_option, sale_kind, sale_line_type,
            pos_location_name, channel,
            product_price, product_title, product_type, product_vendor,
            variant_id, variant_sku, variant_title,
            customer_type, customer_id,
            total_sales, orders,
            gross_sales, discounts, returns, net_sales,
            net_quantity, ordered_item_quantity, returned_item_quantity,
            year, last_synced, loaded_at, line_item_id, restock_type,
            country, exchange_rate,
            product_price_kes, total_sales_kes, gross_sales_kes,
            discounts_kes, returns_kes, net_sales_kes
        ) VALUES %s
        ON CONFLICT (id, store_id) DO UPDATE SET
            last_synced       = EXCLUDED.last_synced,
            total_sales_kes   = EXCLUDED.total_sales_kes,
            pos_location_name = EXCLUDED.pos_location_name
    """,
        rows,
        page_size=1000,
    )
    conn.commit()
    log.info("✅ %s: inserted %d rows", label, len(rows))


def transform_shopify(cur, conn, rates):
    """Mirror BigQuery shopify_deduped exactly.

    Streams the deduped rows in batches via a server-side cursor on a
    SEPARATE read connection (a plain fetchall of ~1.4M wide rows plus the
    rebuilt insert tuples peaked past available memory and got the process
    OOM-killed with no traceback).
    """
    log.info("Transforming Shopify sales...")
    rconn = psycopg2.connect(DATABASE_URL)
    try:
        _transform_shopify_stream(cur, conn, rates, rconn)
    finally:
        rconn.close()


def _transform_shopify_stream(cur, conn, rates, rconn):
    rcur = rconn.cursor(name="shopify_stream")
    rcur.itersize = 50000
    rcur.execute("""
        SELECT
            s.line_item_id AS id, s.store_id, s.day, s.order_id, s.order_name,
            s.purchase_option, s.sale_kind, s.sale_line_type,
            s.pos_location_name,
            s.product_price, s.product_title, s.product_type, s.product_vendor,
            s.variant_id, s.variant_sku, s.variant_title,
            s.customer_type, o.customer_id,
            s.total_sales, s.orders,
            s.gross_sales, s.discounts, s.returns, s.net_sales,
            s.net_quantity, s.ordered_item_quantity, s.returned_item_quantity,
            s.year, s.line_item_id, s.restock_type
        FROM (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY s2.line_item_id, s2.order_id, s2.day, s2.store_id, s2.product_title
                ORDER BY s2.ctid
            ) AS rn
            FROM shopify_sales s2
            WHERE s2.store_id != 'shop-zetu'
            AND (s2.store_id != 'vivowoman' OR s2.day <= '2026-03-19')
            AND LOWER(COALESCE(s2.product_title, '')) NOT LIKE '%%shopping bag%%'
        ) s
        LEFT JOIN (
            SELECT DISTINCT ON (id::text, store_id) id, store_id, customer_id
            FROM raw_shopify_orders
            ORDER BY id::text, store_id, _loaded_at DESC
        ) o ON s.order_id::text = o.id::text AND s.store_id = o.store_id
        WHERE s.rn = 1
    """)
    now = datetime.now(timezone.utc)
    total_rows = 0
    insert_rows = []
    for r in rcur:
        (
            id_,
            store_id,
            day,
            order_id,
            order_name,
            purchase_option,
            sale_kind,
            sale_line_type,
            pos_location_name,
            product_price,
            product_title,
            product_type,
            product_vendor,
            variant_id,
            variant_sku,
            variant_title,
            customer_type,
            customer_id,
            total_sales,
            orders,
            gross_sales,
            discounts,
            returns_,
            net_sales,
            net_quantity,
            ordered_qty,
            returned_qty,
            year,
            line_item_id,
            restock_type,
        ) = r

        channel = get_channel(pos_location_name)
        country = get_country(channel)
        rate = rates.get(country, 1.0)
        vat = get_vat(channel)

        price = float(product_price or 0)
        total = float(total_sales or 0)
        gross = float(gross_sales or 0)
        disc = float(discounts or 0)
        ret = float(returns_ or 0)
        net = round(total / vat, 2)

        # BigQuery keeps a line item's sale and its later return as separate
        # rows (its dedup grain is line_item_id+order_id+day+store_id+
        # product_title). The all_sales PK is (id, store_id), so reusing
        # line_item_id as id would collide those pairs and drop one. Mirror BQ's
        # row set with a unique surrogate id derived from that same grain
        # (store_id is the other PK column), consistent with the live sync's
        # per-row unique id.
        row_id = hashlib.md5(
            f"{line_item_id}|{order_id}|{day}|{product_title}".encode("utf-8")
        ).hexdigest()

        insert_rows.append(
            (
                row_id,
                store_id,
                str(day),
                str(order_id),
                order_name,
                purchase_option or "web",
                sale_kind,
                sale_line_type or "product",
                pos_location_name,
                channel,
                round(price / rate, 2),
                product_title,
                product_type,
                product_vendor,
                str(variant_id) if variant_id else None,
                variant_sku,
                variant_title,
                customer_type,
                str(customer_id) if customer_id else None,
                round(total / rate, 2),
                int(orders or 1),
                round(gross / rate, 2),
                round(disc / rate, 2),
                round(ret / rate, 2),
                round(net / rate, 2),
                int(net_quantity or 0),
                int(ordered_qty or 0),
                int(returned_qty or 0),
                int(year) if year else None,
                now,
                now,
                str(line_item_id) if line_item_id else None,
                restock_type,
                country,
                rate,
                round(price / rate, 2),
                round(total / rate, 2),
                round(gross / rate, 2),
                round(disc / rate, 2),
                round(ret / rate, 2),
                round(net / rate, 2),
            )
        )
        total_rows += 1
        if len(insert_rows) >= 50000:
            bulk_insert(cur, conn, insert_rows, "Shopify batch")
            insert_rows = []

    bulk_insert(cur, conn, insert_rows, "Shopify final batch")
    rcur.close()
    log.info("Shopify deduped rows: %d", total_rows)


def transform_shopzetu(cur, conn, rates):
    """Mirror BigQuery shopzetu_clean — no dedup, raw table is clean."""
    log.info("Transforming Shop Zetu sales...")
    cur.execute("""
        SELECT
            sv.order_id, sv.order_name, sv.day,
            sv.product_title_at_time_of_sale, sv.product_type, sv.product_vendor,
            sv.product_variant_id, sv.product_variant_sku,
            sv.product_variant_title_at_time_of_sale,
            sv.product_variant_price,
            sv.gross_sales, sv.discounts, sv.returns, sv.net_sales, sv.total_sales,
            sv.orders, sv.net_items_sold, sv.quantity_ordered, sv.reversed_quantity,
            sv.new_or_returning_customer, sv.is_reversal_row,
            COALESCE(sv.customer_id, o.customer_id) AS customer_id
        FROM raw_shopify_vendor_sales sv
        LEFT JOIN raw_shopify_orders o
            ON sv.order_id = o.id AND o.store_id = 'shop-zetu'
        WHERE sv.is_totals_row = FALSE
        AND LOWER(COALESCE(sv.product_title_at_time_of_sale, '')) NOT LIKE '%%shopping bag%%'
    """)
    rows = cur.fetchall()
    log.info("Shop Zetu rows: %d", len(rows))

    now = datetime.now(timezone.utc)
    insert_rows = []
    for r in rows:
        (
            order_id,
            order_name,
            day,
            product_title,
            product_type,
            product_vendor,
            variant_id,
            variant_sku,
            variant_title,
            product_price,
            gross_sales,
            discounts,
            returns_,
            net_sales,
            total_sales,
            orders,
            net_items_sold,
            qty_ordered,
            qty_returned,
            customer_type,
            is_reversal,
            customer_id,
        ) = r

        sale_kind = "return" if is_reversal else "order"
        price = float(product_price or 0)
        total = float(total_sales or 0)
        gross = float(gross_sales or 0) if not is_reversal else 0.0
        disc = float(abs(discounts or 0)) if not is_reversal else 0.0
        ret = float(abs(returns_ or 0)) if is_reversal else 0.0
        net = float(net_sales or 0)
        sku = variant_sku or ""
        day_str = str(day)
        row_id = f"{order_id}_{sku}_{day_str}_{'1' if is_reversal else '0'}"

        insert_rows.append(
            (
                row_id,
                "shop-zetu",
                day_str,
                str(order_id),
                order_name,
                "web",
                sale_kind,
                "product",
                "Online - Shop Zetu",
                "Online - Shop Zetu",
                price,
                product_title,
                product_type,
                product_vendor,
                str(variant_id) if variant_id else None,
                sku,
                variant_title,
                customer_type,
                str(customer_id) if customer_id else None,
                total,
                int(orders or 0),
                gross,
                disc,
                ret,
                net,
                int(net_items_sold or 0),
                int(qty_ordered or 0),
                int(qty_returned or 0),
                int(day_str[:4]) if day_str else None,
                now,
                now,
                str(order_id),
                None,
                "Online",
                1.0,
                price,
                total,
                gross,
                disc,
                ret,
                net,
            )
        )

    bulk_insert(cur, conn, insert_rows, "Shop Zetu")


def transform_odoo(cur, conn, rates):
    """Mirror BigQuery odoo_mapped exactly."""
    log.info("Transforming Odoo POS sales...")
    cur.execute("""
        SELECT
            l.id, o.id AS order_id, o.name AS order_name,
            DATE(o.date_order) AS day,
            o.config_name AS pos_location_name,
            l.full_product_name, l.qty, l.price_unit,
            l.price_subtotal, l.price_subtotal_incl,
            l.discount,
            p.default_code AS variant_sku,
            p.name AS variant_title,
            p.sub_category AS product_type,
            p.vendor AS product_vendor,
            l.product_id AS variant_id,
            o.partner_id AS customer_id,
            COALESCE(c.shopify_user_id::text, o.partner_id::text) AS universal_customer_id,
            o.partner_name,
            o._synced_at,
            ROW_NUMBER() OVER (
                PARTITION BY l.id
                ORDER BY o._synced_at DESC
            ) AS rn
        FROM raw_odoo_pos_order_lines l
        JOIN raw_odoo_pos_orders o ON l.order_id = o.id
        LEFT JOIN (
            SELECT DISTINCT ON (id) id, default_code, name,
                sub_category, vendor, write_date
            FROM raw_odoo_products
            ORDER BY id, write_date DESC
        ) p ON l.product_id = p.id
        LEFT JOIN raw_odoo_customers c ON o.partner_id = c.id
        WHERE DATE(o.date_order) >= '2026-03-20'
        AND o.state IN ('done', 'paid', 'invoiced')
        AND LOWER(COALESCE(l.full_product_name, '')) NOT LIKE '%%shopping bag%%'
        AND o.id::text != '16547'
        -- Reward/loyalty lines (is_reward_line = TRUE) are INCLUDED but
        -- treated as pure discount rows: their negative price_subtotal_incl
        -- becomes discounts_kes while total_sales_kes is zeroed out, so that
        -- total_sales - discounts_kes = what the customer actually paid (matching
        -- Odoo's order total). Previously dropped entirely, which overstated both
        -- Total Sales and Net Sales by the full reward amount on promo orders.
    """)
    rows = cur.fetchall()
    log.info("Odoo raw rows: %d", len(rows))

    now = datetime.now(timezone.utc)
    insert_rows = []
    for r in rows:
        (
            line_id,
            order_id,
            order_name,
            day,
            pos_location_name,
            product_title,
            qty,
            price_unit,
            price_subtotal,
            price_subtotal_incl,
            discount,
            variant_sku,
            variant_title,
            product_type,
            product_vendor,
            variant_id,
            customer_id,
            universal_customer_id,
            partner_name,
            synced_at,
            rn,
        ) = r

        if rn != 1:
            continue

        qty = float(qty or 0)
        price = float(price_unit or 0)
        subtotal = float(price_subtotal or 0)
        subtotal_i = float(price_subtotal_incl or 0)

        # Amount-as-quantity guard: some Odoo POS lines use a nominal KES-1 (or 0)
        # catch-all product and encode the charged AMOUNT in the quantity field
        # (e.g. price_unit=1, qty=8600 to ring up KES 8,600). The revenue is real
        # but the unit count is not — left unclamped one such line inflates Units
        # Sold / MSI / ASP for the whole period. Collapse the unit count to a
        # single line-unit while leaving the money (derived from price_subtotal*)
        # untouched. Sign is preserved so returns stay returns.
        units_qty = qty
        if abs(qty) >= 20 and price <= 1.0:
            units_qty = 1.0 if qty > 0 else -1.0

        sale_kind = "return" if qty < 0 else "order"
        # total/gross must be GROSS (pre-discount, VAT-inclusive) to match the
        # Shopify convention: KPI SQL computes net = total_sales_kes −
        # discounts_kes, so storing the post-discount price_subtotal_incl here
        # double-subtracted discounts. (The old disc = incl − excl was the VAT
        # amount, not the discount.) Mirrors sync_incremental's Odoo path.
        raw_gross = price * qty
        # Reward/loyalty lines: qty > 0 but price_unit and subtotal_incl are
        # negative (the whole discount in one line). Route to disc, zero total.
        is_reward = (qty > 0 and subtotal_i < 0)
        if is_reward:
            disc = abs(subtotal_i)
            gross = 0.0
            ret = 0.0
            total = 0.0
            net = 0.0
            units_qty = 0.0
        else:
            disc = max(round(raw_gross - subtotal_i, 2), 0.0) if qty >= 0 else 0.0
            gross = (subtotal_i + disc) if qty >= 0 else 0.0
            ret = abs(subtotal_i) if qty < 0 else 0.0
            total = (subtotal_i + disc) if qty >= 0 else -abs(subtotal_i)
            net = subtotal if qty >= 0 else -abs(subtotal)

        mapped = ODOO_LOCATION_MAP.get(pos_location_name, pos_location_name)
        country = get_country(mapped)
        rate = rates.get(country, 1.0)
        day_str = str(day)

        insert_rows.append(
            (
                str(line_id),
                "vivofashiongroup",
                day_str,
                str(order_id),
                order_name,
                "pos",
                sale_kind,
                "product",
                mapped,
                mapped,
                round(price / rate, 2),
                product_title,
                product_type,
                product_vendor,
                str(variant_id) if variant_id else None,
                variant_sku,
                variant_title,
                "Returning" if partner_name else "New",
                universal_customer_id,
                round(total / rate, 2),
                1,
                round(gross / rate, 2),
                round(disc / rate, 2),
                round(ret / rate, 2),
                round(net / rate, 2),
                int(units_qty),
                int(units_qty) if units_qty > 0 else 0,
                int(abs(units_qty)) if units_qty < 0 else 0,
                int(day_str[:4]) if day_str else None,
                now,
                now,
                str(line_id),
                "return" if qty < 0 else None,
                country,
                rate,
                round(price / rate, 2),
                round(total / rate, 2),
                round(gross / rate, 2),
                round(disc / rate, 2),
                round(ret / rate, 2),
                round(net / rate, 2),
            )
        )

    bulk_insert(cur, conn, insert_rows, "Odoo")


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Load latest exchange rates (one per country)
    rates = {"Kenya": 1.0, "Online": 1.0}
    cur.execute("SELECT country, rate FROM currency_rates ORDER BY month DESC")
    seen = set()
    for row in cur.fetchall():
        if row[0] not in seen:
            rates[row[0]] = float(row[1])
            seen.add(row[0])
    log.info("Rates: %s", rates)

    cur.execute("TRUNCATE all_sales")
    conn.commit()
    log.info("all_sales truncated")

    transform_shopify(cur, conn, rates)
    transform_shopzetu(cur, conn, rates)
    transform_odoo(cur, conn, rates)

    cur.execute("""
        SELECT store_id, COUNT(*) as rows,
               MIN(sale_date) as first, MAX(sale_date) as last,
               ROUND(SUM(total_sales_kes::numeric)/1000000, 2) AS total_m
        FROM all_sales
        GROUP BY store_id ORDER BY store_id
    """)
    print("\n=== all_sales summary ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} rows, {row[2]} to {row[3]}, {row[4]}M KES")

    conn.close()


if __name__ == "__main__":
    main()
