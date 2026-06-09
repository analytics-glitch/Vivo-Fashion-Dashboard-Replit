import os
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
import re
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']

SIZE_PATTERN = re.compile(
    r'(XS/S|S/M|M/L|L/XL|XL/2X|1X/2X|2X/3X|3X/4X|4X/5X|L/1X|XXS|'
    r'2XL|3XL|4XL|5XL|XXL|XXXL|1X|2X|3X|4X|5X|OS|XL|XS|F|S|M|L)$'
)

SIZE_NORM = {
    '2XL': '2X', '3XL': '3X', '4XL': '4X', '5XL': '5X',
    'XXL': '2X', 'XXXL': '3X', 'XL': '1X', 'L/XL': 'L/1X',
    'XL/2X': '1X/2X', 'OS': 'F',
}

SUBCAT_RULES = [
    (['fitness bra', 'sports bra'],                          'Fitted Tops'),
    (['biker'],                                              'Leggings'),
    (['catsuit', 'unitard', 'romper'],                       'Jumpsuits & Playsuits'),
    (['shawl', 'scarf', 'sarong', 'yoga wrap'],              'Scarves'),
    (['blazer', 'shacket', 'jacket', 'coat'],                'Jackets & Coats'),
    (['poncho', 'sweater'],                                  'Sweaters & Ponchos'),
    (['waterfall', 'kimono', 'cover up', 'cover-up'],        'Waterfalls & Kimonos'),
    (['hoodie', 'sweatshirt'],                               'Hoodies & Sweatshirts'),
    (['bodysuit', 'body suit'],                              'Bodysuits'),
    (['jumpsuit', 'playsuit'],                               'Jumpsuits & Playsuits'),
    (['legging'],                                            'Leggings'),
    (['culotte', 'cullote'],                                 'Culottes & Capri Pants'),
    (['palazzo', 'jogger', 'trouser'],                       'Full Length Pants'),
    (['skort'],                                              'Shorts & Skorts'),
    (['maxi', 'dress'],                                      'Maxi Dresses'),
    (['midi', 'dress'],                                      'Midi & Capri Dresses'),
    (['mini', 'dress'],                                      'Short & Mini Dresses'),
    (['knee', 'dress'],                                      'Knee Length Dresses'),
    (['bodycon'],                                            'Knee Length Dresses'),
    (['kaftan'],                                             'Maxi Dresses'),
    (['maxi', 'skirt'],                                      'Maxi Skirts'),
    (['dress'],                                              'Knee Length Dresses'),
    (['skirt'],                                              'Knee Length Skirts'),
    (['tee', 't-shirt', 'tank'],                             'T-shirts & Tank Tops'),
    (['tunic', 'blouse', 'camisole', 'cowl', 'vest', 'chiffon'], 'Loose Tops'),
    (['shirt'],                                              'Loose Tops'),
    (['top'],                                                'Loose Tops'),
    (['short'],                                              'Shorts & Skorts'),
    (['pant'],                                               'Full Length Pants'),
    (['maxi'],                                               'Maxi Dresses'),
]

CATEGORY_MAP = {
    'Skirts & Top Set': 'Two-Piece Sets',
    'Pants & Top Set': 'Two-Piece Sets',
    'Two-Piece Sets': 'Two-Piece Sets',
    'Bangles & Bracelets': 'Accessories',
    'Belts': 'Accessories',
    'Scarves': 'Accessories',
    'Accessories': 'Accessories',
    'Bodysuits': 'Tops',
    'Fitted Tops': 'Tops',
    'Loose Tops': 'Tops',
    'T-shirts & Tank Tops': 'Tops',
    'Midriff & Crop Tops': 'Tops',
    'Culottes & Capri Pants': 'Bottoms',
    'Full Length Pants': 'Bottoms',
    'Jumpsuits & Playsuits': 'Bottoms',
    'Leggings': 'Bottoms',
    'Shorts & Skorts': 'Bottoms',
    'Knee Length Dresses': 'Dresses',
    'Maxi Dresses': 'Dresses',
    'Midi & Capri Dresses': 'Dresses',
    'Short & Mini Dresses': 'Dresses',
    'Knee Length Skirts': 'Skirts',
    'Maxi Skirts': 'Skirts',
    'Hoodies & Sweatshirts': 'Outerwear',
    'Jackets & Coats': 'Outerwear',
    'Sweaters & Ponchos': 'Outerwear',
    'Waterfalls & Kimonos': 'Outerwear',
    'Sample & Sale Items': 'Sale',
}

def extract_size(sku):
    if not sku:
        return None
    m = SIZE_PATTERN.search(sku)
    if m:
        raw = m.group(1)
        return SIZE_NORM.get(raw, raw)
    return None

def extract_style_number(sku, name=''):
    if not sku:
        return None
    if re.match(r'^[A-Za-z]\d{7}', sku):
        return sku[:8]
    if re.match(r'^\d{7}', sku):
        n = (name or '').upper()
        if n.startswith('SAFARI'):
            return 'S' + sku[:7]
        if n.startswith('ZOYA'):
            return 'Z' + sku[:7]
        return 'V' + sku[:7]
    return sku[:7]

def extract_style_name(name):
    if not name:
        return name
    name = re.sub(r'- ', ' - ', name)
    name = re.sub(r' -([^ ])', r' - \1', name)
    if ' - ' in name:
        return name.split(' - ')[0].strip()
    return name.strip()

def extract_color_from_name(name):
    if not name:
        return None
    name = re.sub(r'- ', ' - ', name)
    name = re.sub(r' -([^ ])', r' - \1', name)
    if ' - ' in name:
        return name.split(' - ', 1)[1].strip()
    return None

def guess_brand(name):
    n = (name or '').upper()
    if n.startswith('SAFARI'):
        return 'Safari'
    if n.startswith('ZOYA'):
        return 'Zoya'
    if n.startswith('VIVO'):
        return 'Vivo'
    return 'Third Party Brands'

def guess_subcat(name):
    n = (name or '').lower()
    for keywords, subcat in SUBCAT_RULES:
        if all(kw in n for kw in keywords):
            return subcat
        if any(kw in n for kw in keywords[:1]):
            if len(keywords) == 1 or any(kw in n for kw in keywords[1:]):
                return subcat
    return None

def is_sample(name, sku):
    n = (name or '').upper()
    s = (sku or '').upper()
    return (
        'SAMPLE' in n or 'TEST' in n or 'GIFT VOUCHER' in n or
        'FS' in s or 'SD' in s or s.startswith('CS') or
        s.startswith('SALE') or s.startswith('TT') or 'SAL' in s
    )

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    log.info("Building all_products_clean...")
    cur.execute("TRUNCATE all_products_clean")

    # Get all_sales product data for enrichment
    cur.execute("""
        SELECT variant_sku,
            MAX(product_vendor) AS vendor,
            MAX(product_type) AS sale_product_type,
            MAX(product_title) AS sale_product_name
        FROM all_sales
        WHERE variant_sku IS NOT NULL
        GROUP BY variant_sku
    """)
    sales_data = {r[0]: r for r in cur.fetchall()}
    log.info("Sales enrichment data: %d SKUs", len(sales_data))

    # Get Odoo products — deduplicated by SKU
    cur.execute("""
        SELECT DISTINCT ON (default_code)
            id, name, default_code, barcode,
            list_price, standard_price, categ_name,
            sub_category, style_name, style_number,
            collection, color, brand, vendor,
            category, gender, season, active, write_date
        FROM raw_odoo_products
        WHERE default_code IS NOT NULL
        AND categ_name = '2. Finished Goods Inventory'
        AND LOWER(name) NOT LIKE '%shopping bag%'
        AND LOWER(name) NOT LIKE '%gift voucher%'
        AND LOWER(name) NOT LIKE '%gift card%'
        ORDER BY default_code, write_date DESC
    """)
    odoo_products = cur.fetchall()
    log.info("Odoo products: %d", len(odoo_products))

    # Build style → dominant subcat map
    style_subcat = {}
    cur.execute("""
        SELECT
            SPLIT_PART(name, ' - ', 1) AS style_nm,
            sub_category,
            COUNT(*) AS freq
        FROM raw_odoo_products
        WHERE sub_category IS NOT NULL
        AND sub_category != 'Sample & Sale Items'
        AND name IS NOT NULL
        GROUP BY 1, 2
    """)
    subcat_counts = {}
    for row in cur.fetchall():
        sn, sc, freq = row
        if sn not in subcat_counts or subcat_counts[sn][1] < freq:
            subcat_counts[sn] = (sc, freq)
    style_subcat = {k: v[0] for k, v in subcat_counts.items()}

    rows = []
    seen_skus = set()

    for p in odoo_products:
        (pid, name, sku, barcode, price, cost, categ_name,
         sub_category, style_name, style_number, collection,
         color, brand, vendor, category, gender, season,
         active, write_date) = p

        if sku in seen_skus:
            continue
        seen_skus.add(sku)

        s = sales_data.get(sku)
        sale_name   = s[3] if s else None
        sale_vendor = s[1] if s else None
        sale_type   = s[2] if s else None

        # Style name
        sname = style_name or extract_style_name(name)

        # Color
        clr = color or extract_color_from_name(name)
        if clr:
            clr = clr.title()

        # Product name
        if sname and clr:
            product_name = f"{sname} - {clr}"
        else:
            product_name = sname or sale_name or name

        # Brand
        br = brand or guess_brand(name)

        # Style number
        snum = style_number or extract_style_number(sku, name)

        # Size
        size = extract_size(sku)

        # Subcategory
        if is_sample(name, sku):
            subcat = 'Sample & Sale Items'
        elif style_subcat.get(sname):
            subcat = style_subcat[sname]
        elif sub_category and sub_category != 'Sample & Sale Items':
            subcat = sub_category
        elif sale_type and sale_type != 'Sample & Sale Items':
            subcat = sale_type
        else:
            subcat = guess_subcat(name or sale_name)

        # Category rollup
        cat = CATEGORY_MAP.get(subcat, category)

        # Print/plain
        clr_upper = (clr or '').upper()
        if 'PRINT' in clr_upper or (clr and '/' in clr):
            print_plain = 'Print'
        else:
            print_plain = 'Plain'

        rows.append((
            sku, product_name, str(barcode) if barcode else None,
            float(price or 0), float(cost or 0),
            br, vendor or sale_vendor,
            clr, snum, collection, sname,
            print_plain, subcat, cat,
            gender, season, size,
            int(0), int(0),  # stock_on_hand, stock_available (joined later)
            bool(active), pid,
            s is not None,  # ever_sold
        ))

    # Also add SKUs from sales that have no Odoo product
    for sku, s in sales_data.items():
        if sku in seen_skus:
            continue
        sale_name   = s[3]
        sale_vendor = s[1]
        sale_type   = s[2]

        br    = guess_brand(sale_name)
        sname = extract_style_name(sale_name)
        clr   = extract_color_from_name(sale_name)
        if clr:
            clr = clr.title()
        snum  = extract_style_number(sku, sale_name)
        size  = extract_size(sku)
        subcat = guess_subcat(sale_name)
        cat    = CATEGORY_MAP.get(subcat)

        rows.append((
            sku,
            sale_name,
            None, 0.0, 0.0,
            br, sale_vendor,
            clr, snum, None, sname,
            'Print' if clr and ('/' in clr or 'PRINT' in (clr or '').upper()) else 'Plain',
            subcat, cat,
            None, None, size,
            0, 0,
            None, None,
            True,
        ))
        seen_skus.add(sku)

    log.info("Total products to insert: %d", len(rows))

    execute_values(cur, """
        INSERT INTO all_products_clean (
            sku, product_name, barcode, price, cost,
            brand, vendor, color_print, style_number,
            collection, style_name, print_plain,
            product_type, category, gender, season, size,
            stock_on_hand, stock_available, active, product_id, ever_sold
        ) VALUES %s
        ON CONFLICT (sku) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            price = EXCLUDED.price,
            cost = EXCLUDED.cost,
            active = EXCLUDED.active
    """, rows, page_size=1000)

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM all_products_clean")
    log.info("✅ all_products_clean: %d rows", cur.fetchone()[0])

    cur.execute("""
        SELECT brand, COUNT(*) FROM all_products_clean
        GROUP BY brand ORDER BY COUNT(*) DESC LIMIT 10
    """)
    for row in cur.fetchall():
        log.info("  %s: %d", row[0], row[1])

    conn.close()

if __name__ == "__main__":
    main()