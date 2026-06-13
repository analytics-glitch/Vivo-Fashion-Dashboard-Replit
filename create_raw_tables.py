import psycopg2, os

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()

tables = [
    """CREATE TABLE IF NOT EXISTS raw_odoo_pos_orders (
        id BIGINT PRIMARY KEY, name TEXT, pos_reference TEXT,
        tracking_number TEXT, date_order TEXT, state TEXT,
        config_id BIGINT, config_name TEXT, session_id BIGINT,
        partner_id BIGINT, partner_name TEXT, employee_id BIGINT,
        cashier TEXT, user_id BIGINT, company_id BIGINT,
        amount_total NUMERIC, amount_tax NUMERIC, amount_paid NUMERIC,
        amount_return NUMERIC, margin NUMERIC, margin_percent NUMERIC,
        is_invoiced BOOLEAN, email TEXT, write_date TEXT, _synced_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS raw_odoo_pos_order_lines (
        id BIGINT PRIMARY KEY, order_id BIGINT, product_id BIGINT,
        full_product_name TEXT, qty NUMERIC, price_unit NUMERIC,
        price_subtotal NUMERIC, price_subtotal_incl NUMERIC,
        discount NUMERIC, is_reward_line BOOLEAN,
        write_date TEXT, _synced_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS raw_odoo_products (
        id BIGINT PRIMARY KEY, name TEXT, default_code TEXT, barcode TEXT,
        list_price NUMERIC, standard_price NUMERIC, categ_name TEXT,
        sub_category TEXT, style_name TEXT, style_number TEXT,
        collection TEXT, color TEXT, brand TEXT, vendor TEXT,
        category TEXT, gender TEXT, season TEXT, active BOOLEAN,
        write_date TEXT, _synced_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS raw_odoo_customers (
        id BIGINT PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
        mobile TEXT, street TEXT, city TEXT, state_name TEXT,
        country_name TEXT, shopify_user_id BIGINT, store_id TEXT,
        write_date TEXT, _synced_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS raw_shopify_sales (
        id TEXT, store_id TEXT, day DATE, order_id TEXT, order_name TEXT,
        purchase_option TEXT, sale_kind TEXT, sale_line_type TEXT,
        pos_location_name TEXT, product_price NUMERIC, product_title TEXT,
        product_type TEXT, product_vendor TEXT, variant_id TEXT,
        variant_sku TEXT, variant_title TEXT, customer_type TEXT,
        customer_id TEXT, total_sales NUMERIC, orders INTEGER,
        gross_sales NUMERIC, discounts NUMERIC, returns NUMERIC,
        net_sales NUMERIC, net_quantity INTEGER,
        ordered_item_quantity INTEGER, returned_item_quantity INTEGER,
        year INTEGER, line_item_id TEXT, restock_type TEXT,
        _loaded_at TIMESTAMP,
        PRIMARY KEY (line_item_id, store_id)
    )""",
    """CREATE TABLE IF NOT EXISTS raw_shopify_vendor_sales (
        order_id TEXT, order_name TEXT, day DATE,
        product_title_at_time_of_sale TEXT, product_type TEXT,
        product_vendor TEXT, product_variant_id TEXT,
        product_variant_sku TEXT,
        product_variant_title_at_time_of_sale TEXT,
        product_variant_price NUMERIC, gross_sales NUMERIC,
        discounts NUMERIC, returns NUMERIC, net_sales NUMERIC,
        total_sales NUMERIC, orders INTEGER, net_items_sold INTEGER,
        quantity_ordered INTEGER, reversed_quantity INTEGER,
        new_or_returning_customer TEXT, is_reversal_row BOOLEAN,
        is_totals_row BOOLEAN, _loaded_at TIMESTAMP,
        PRIMARY KEY (order_id, day, product_variant_sku, is_reversal_row)
    )""",
    """CREATE TABLE IF NOT EXISTS raw_shopify_orders (
        id TEXT, store_id TEXT, name TEXT, created_at TEXT,
        updated_at TEXT, customer_id TEXT, customer_email TEXT,
        customer_first_name TEXT, customer_last_name TEXT,
        total_price NUMERIC, financial_status TEXT,
        fulfillment_status TEXT, source_name TEXT,
        billing_city TEXT, billing_country TEXT,
        shipping_city TEXT, shipping_country TEXT,
        _loaded_at TIMESTAMP,
        PRIMARY KEY (id, store_id)
    )""",
    """CREATE TABLE IF NOT EXISTS raw_shopify_customers (
        id TEXT, store_id TEXT, email TEXT, first_name TEXT,
        last_name TEXT, phone TEXT, default_address_phone TEXT,
        state TEXT, total_spent NUMERIC, orders_count INTEGER,
        accepts_sms_marketing BOOLEAN, accepts_email_marketing BOOLEAN,
        created_at TEXT, updated_at TEXT, _loaded_at TIMESTAMP,
        PRIMARY KEY (id, store_id)
    )""",
    """CREATE TABLE IF NOT EXISTS currency_rates (
        country TEXT, month TEXT, rate NUMERIC,
        PRIMARY KEY (country, month)
    )""",
]

for sql in tables:
    cur.execute(sql)
    print(f"✅ Created: {sql.split('EXISTS')[1].split('(')[0].strip()}")

conn.commit()
conn.close()
print("All raw tables created!")