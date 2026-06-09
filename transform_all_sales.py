import os
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']

LOCATION_MAP = {
    'Sarit':                  'Vivo Sarit',
    'Moi Avenue':             'Vivo Moi Avenue',
    'Mama Ngina':             'Vivo Mama Ngina St',
    'Yaya':                   'Vivo Yaya',
    'Village Market':         'Vivo Village Market',
    'Junction':               'Vivo Junction',
    'Capital Centre':         'Vivo Capital Centre',
    'Imaara':                 'Vivo Imaara',
    'Nakuru (Westside Mall)': 'Vivo Nakuru',
    'Garden City':            'Vivo Garden City',
    'Eldoret (Rupa)':         'Vivo Eldoret',
    'Kisumu (United Mall)':   'Vivo Kisumu',
    'Two Rivers':             'Vivo Two Rivers',
    'Thika Road Mall':        'Vivo TRM',
    'Hub':                    'Vivo Hub',
    'Galleria':               'Vivo Galleria',
    'Runda Mall':             'Vivo Runda',
    'Signature Mall':         'Vivo Signature Mall',
    'Greenspan':              'Vivo Greenspan',
    'Mombasa (City Mall)':    'Vivo City Mall',
    'Tmall':                  'Vivo T- Mall',
    'Zoya Sarit':             'Zoya Sarit',
    'Mombasa CBD':            'Vivo MSA Digo Road',
    'Kileleshwa':             'Vivo Kileleshwa',
    'Meru (Green Wood)':      'Vivo Meru',
    'Sarit Safari':           'Safari Sarit',
    'HQ Outlet':              'Staff purchases',
}

CHANNEL_MAP = {
    'Online - shop-zetu':      'Online - Shop Zetu',
    'POS - 67096608987':       'Online - Shop Zetu',
    'Online - safari-by-vivo': 'Online - Safari',
}

UGANDA_LOCATIONS = {'The Oasis Mall', 'Vivo Acacia'}
RWANDA_LOCATIONS = {'Vivo Kigali Heights', 'Vivo M-peace Plaza'}
ONLINE_LOCATIONS = {
    'Online - Shop Zetu', 'Online - Safari',
    'Online - shop-zetu', 'POS - 67096608987',
    'Online - safari-by-vivo'
}

VAT_UGANDA_RWANDA = 1.18
VAT_KENYA         = 1.16


def get_country(location):
    if location in RWANDA_LOCATIONS:
        return 'Rwanda'
    if location in UGANDA_LOCATIONS:
        return 'Uganda'
    if location in ONLINE_LOCATIONS:
        return 'Online'
    return 'Kenya'


def get_vat(location):
    if location in UGANDA_LOCATIONS or location in RWANDA_LOCATIONS:
        return VAT_UGANDA_RWANDA
    return VAT_KENYA


def _bulk_insert(cur, rows):
    if not rows:
        return
    execute_values(cur, """
        INSERT INTO all_sales (
            id, store_id, day, order_id, order_name,
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
            discounts_kes, returns_kes, net_sales_kes, sale_date
        ) VALUES %s
        ON CONFLICT (id, store_id) DO UPDATE SET
            last_synced = EXCLUDED.last_synced,
            total_sales_kes = EXCLUDED.total_sales_kes
    """, rows, page_size=1000)


def transform_shopify(cur, conn, rates):
    """Transform raw_shopify_sales → all_sales (Kenya/Uganda/Rwanda)."""
    log.info("Transforming Shopify sales...")

    cur.execute("""
        SELECT
            s.id, s.store_id, s.day, s.order_id, s.order_name,
            s.purchase_option, s.sale_kind, s.sale_line_type,
            s.pos_location_name, s.product_price, s.product_title,
            s.product_type, s.product_vendor, s.variant_id,
            s.variant_sku, s.variant_title, s.customer_type,
            o.customer_id,
            s.total_sales, s.orders, s.gross_sales, s.discounts,
            s.returns, s.net_sales, s.net_quantity,
            s.ordered_item_quantity, s.returned_item_quantity,
            s.year, s.line_item_id, s.restock_type, s._loaded_at,
            ROW_NUMBER() OVER (
                PARTITION BY s.order_id::text, s.day::text, s.variant_sku
                ORDER BY s._loaded_at DESC
            ) AS rn
        FROM raw_shopify_sales s
        LEFT JOIN raw_shopify_orders o
            ON s.order_id = o.id AND s.store_id = o.store_id
        WHERE s.store_id != 'shop-zetu'
        AND (
            s.store_id != 'vivowoman'
            OR s.day <= '2026-03-19'
        )
        AND LOWER(COALESCE(s.product_title, '')) NOT LIKE '%shopping bag%'
    """)

    rows = cur.fetchall()
    log.info("Shopify raw rows: %d", len(rows))

    now = datetime.now(timezone.utc)
    insert_rows = []

    for r in rows:
        (id_, store_id, day, order_id, order_name, purchase_option,
         sale_kind, sale_line_type, pos_location_name, product_price,
         product_title, product_type, product_vendor, variant_id,
         variant_sku, variant_title, customer_type, customer_id,
         total_sales, orders, gross_sales, discounts, returns_,
         net_sales, net_quantity, ordered_qty, returned_qty,
         year, line_item_id, restock_type, loaded_at, rn) = r

        if rn != 1:
            continue

        channel = CHANNEL_MAP.get(pos_location_name, pos_location_name)
        country = get_country(channel)
        rate    = rates.get(country, 1.0)
        vat     = get_vat(channel)

        price = float(product_price or 0)
        total = float(total_sales or 0)
        gross = float(gross_sales or 0)
        disc  = float(discounts or 0)
        ret   = float(returns_ or 0)
        net   = round(total / vat, 2)

        insert_rows.append((
            str(id_), store_id, str(day), str(order_id), order_name,
            purchase_option or 'web', sale_kind, sale_line_type or 'product',
            pos_location_name, channel,
            round(price / rate, 2) if rate != 1 else price,
            product_title, product_type, product_vendor,
            str(variant_id) if variant_id else None,
            variant_sku, variant_title, customer_type,
            str(customer_id) if customer_id else None,
            round(total / rate, 2), int(orders or 1),
            round(gross / rate, 2), round(disc / rate, 2),
            round(ret / rate, 2), round(net / rate, 2),
            int(net_quantity or 0), int(ordered_qty or 0), int(returned_qty or 0),
            int(year) if year else None,
            now, now,
            str(line_item_id) if line_item_id else None,
            restock_type, country, rate,
            round(price / rate, 2) if rate != 1 else price,
            round(total / rate, 2), round(gross / rate, 2), round(disc / rate, 2),
            round(ret / rate, 2), round(net / rate, 2),
            str(day),
        ))

    log.info("Shopify rows to insert: %d", len(insert_rows))
    _bulk_insert(cur, insert_rows)
    conn.commit()
    log.info("✅ Shopify transform done")


def transform_shopzetu(cur, conn, rates):
    """Transform raw_shopify_vendor_sales → all_sales (Shop Zetu)."""
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
            o.customer_id
        FROM raw_shopify_vendor_sales sv
        LEFT JOIN raw_shopify_orders o
            ON sv.order_id = o.id AND o.store_id = 'shop-zetu'
        WHERE sv.is_totals_row = FALSE
        AND LOWER(COALESCE(sv.product_title_at_time_of_sale, '')) NOT LIKE '%shopping bag%'
    """)

    rows = cur.fetchall()
    log.info("Shop Zetu raw rows: %d", len(rows))

    now = datetime.now(timezone.utc)
    insert_rows = []

    for r in rows:
        (order_id, order_name, day, product_title, product_type, product_vendor,
         variant_id, variant_sku, variant_title, product_price,
         gross_sales, discounts, returns_, net_sales, total_sales,
         orders, net_items_sold, qty_ordered, qty_returned,
         customer_type, is_reversal, customer_id) = r

        sale_kind       = 'return' if is_reversal else 'order'
        price           = float(product_price or 0)
        total           = float(total_sales or 0)
        gross           = float(gross_sales or 0)
        disc            = float(abs(discounts or 0))
        ret             = float(abs(returns_ or 0))
        net             = float(net_sales or 0)
        sku             = variant_sku or ''
        day_str         = str(day)
        reversal_flag   = '1' if is_reversal else '0'
        row_id          = f"{order_id}_{sku}_{day_str}_{reversal_flag}"

        insert_rows.append((
            row_id,
            'shop-zetu', day_str, str(order_id), order_name,
            'web', sale_kind, 'product',
            'Online - Shop Zetu', 'Online - Shop Zetu',
            price, product_title, product_type, product_vendor,
            str(variant_id) if variant_id else None,
            sku, variant_title, customer_type,
            str(customer_id) if customer_id else None,
            total, int(orders or 0),
            gross if not is_reversal else 0,
            disc,
            ret if is_reversal else 0,
            net,
            int(net_items_sold or 0),
            int(qty_ordered or 0),
            int(qty_returned or 0),
            int(day_str[:4]) if day_str else None,
            now, now,
            str(order_id),
            None, 'Online', 1.0,
            price, total,
            gross if not is_reversal else 0,
            disc,
            ret if is_reversal else 0,
            net,
            day_str,
        ))

    log.info("Shop Zetu rows to insert: %d", len(insert_rows))
    _bulk_insert(cur, insert_rows)
    conn.commit()
    log.info("✅ Shop Zetu transform done")


def transform_odoo(cur, conn, rates):
    """Transform raw_odoo_pos_orders + lines → all_sales (Odoo POS from Mar 20 2026)."""
    log.info("Transforming Odoo POS sales...")

    cur.execute("""
        SELECT
            l.id, o.id AS order_id, o.name AS order_name,
            DATE(o.date_order) AS day,
            o.state, o.config_name AS pos_location_name,
            l.full_product_name, l.qty, l.price_unit,
            l.price_subtotal, l.price_subtotal_incl,
            l.is_reward_line, l.discount,
            p.default_code AS variant_sku,
            p.name AS variant_title,
            p.sub_category AS product_type,
            p.vendor AS product_vendor,
            l.product_id AS variant_id,
            o.partner_id AS customer_id,
            o.partner_name,
            o._synced_at
        FROM raw_odoo_pos_order_lines l
        JOIN raw_odoo_pos_orders o ON l.order_id = o.id
        LEFT JOIN (
            SELECT DISTINCT ON (id) id, default_code, name,
                sub_category, vendor, write_date
            FROM raw_odoo_products
            ORDER BY id, write_date DESC
        ) p ON l.product_id = p.id
        WHERE DATE(o.date_order) >= '2026-03-20'
        AND o.state IN ('done', 'paid', 'invoiced')
        AND LOWER(COALESCE(l.full_product_name, '')) NOT LIKE '%shopping bag%'
        AND o.id::text != '16547'
        AND l.is_reward_line = FALSE
    """)

    rows = cur.fetchall()
    log.info("Odoo raw rows: %d", len(rows))

    now = datetime.now(timezone.utc)

    # Dedup by order_id + day + variant_sku
    seen = {}
    deduped = []
    for r in rows:
        key = (str(r[1]), str(r[3]), r[13] or '')
        if key not in seen or (r[20] and (not seen[key] or r[20] > seen[key])):
            seen[key] = r[20]
            deduped.append(r)
    rows = deduped
    log.info("After dedup: %d rows", len(rows))

    insert_rows = []

    for r in rows:
        (line_id, order_id, order_name, day, state, pos_location_name,
         product_title, qty, price_unit, price_subtotal, price_subtotal_incl,
         is_reward, discount, variant_sku, variant_title, product_type,
         product_vendor, variant_id, customer_id, partner_name,
         synced_at) = r

        qty        = float(qty or 0)
        price      = float(price_unit or 0)
        subtotal   = float(price_subtotal or 0)
        subtotal_i = float(price_subtotal_incl or 0)

        sale_kind = 'return' if qty < 0 else 'order'
        total     = round(price * qty, 2)
        gross     = subtotal if qty >= 0 else 0
        disc      = round((price * qty - subtotal_i) / VAT_KENYA, 2) if qty >= 0 else 0
        ret       = abs(subtotal) if qty < 0 else 0
        net       = -abs(subtotal) if qty < 0 else subtotal

        mapped  = LOCATION_MAP.get(pos_location_name, pos_location_name)
        country = get_country(mapped)
        rate    = rates.get(country, 1.0)
        day_str = str(day)

        insert_rows.append((
            str(line_id), 'vivofashiongroup', day_str,
            str(order_id), order_name,
            'pos', sale_kind, 'product',
            mapped, mapped,
            round(price / rate, 2) if rate != 1 else price,
            product_title, product_type, product_vendor,
            str(variant_id) if variant_id else None,
            variant_sku, variant_title,
            'Returning' if partner_name else 'New',
            str(customer_id) if customer_id else None,
            round(total / rate, 2), 1,
            round(gross / rate, 2), round(disc / rate, 2),
            round(ret / rate, 2), round(net / rate, 2),
            int(qty), int(qty) if qty > 0 else 0, int(abs(qty)) if qty < 0 else 0,
            int(day_str[:4]) if day_str else None,
            now, now,
            str(line_id),
            'return' if qty < 0 else None,
            country, rate,
            round(price / rate, 2) if rate != 1 else price,
            round(total / rate, 2), round(gross / rate, 2), round(disc / rate, 2),
            round(ret / rate, 2), round(net / rate, 2),
            str(day),
        ))

    log.info("Odoo rows to insert: %d", len(insert_rows))
    _bulk_insert(cur, insert_rows)
    conn.commit()
    log.info("✅ Odoo transform done")


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Get rates
    rates = {'Kenya': 1.0, 'Online': 1.0}
    cur.execute("SELECT country, rate FROM currency_rates")
    for row in cur.fetchall():
        rates[row[0]] = float(row[1])
    log.info("Rates loaded: %s", rates)

    # Truncate and rebuild all_sales
    cur.execute("TRUNCATE all_sales")
    conn.commit()
    log.info("all_sales truncated")

    transform_shopify(cur, conn, rates)
    transform_shopzetu(cur, conn, rates)
    transform_odoo(cur, conn, rates)

    cur.execute("""
        SELECT store_id, COUNT(*) as rows,
               MIN(sale_date) as earliest, MAX(sale_date) as latest,
               ROUND(SUM(total_sales_kes::numeric)/1000000, 2) AS total_m
        FROM all_sales
        GROUP BY store_id
        ORDER BY store_id
    """)
    print("\n=== all_sales summary ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} rows, {row[2]} to {row[3]}, {row[4]}M KES")

    conn.close()


if __name__ == "__main__":
    main()