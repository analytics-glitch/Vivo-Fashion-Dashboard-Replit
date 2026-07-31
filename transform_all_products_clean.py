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

CATEGORY_MAP = {
    'Fitted Tops':              'Tops',
    'Loose Tops':               'Tops',
    'T-shirts & Tank Tops':     'Tops',
    'Bodysuits':                'Tops',
    'Midriff & Crop Tops':      'Tops',
    'Knee Length Dresses':      'Dresses',
    'Maxi Dresses':             'Dresses',
    'Midi & Capri Dresses':     'Dresses',
    'Short & Mini Dresses':     'Dresses',
    'Knee Length Skirts':       'Skirts',
    'Maxi Skirts':              'Skirts',
    'Midi & Capri Skirts':      'Skirts',
    'Short & Mini Skirts':      'Skirts',
    'Full Length Pants':        'Bottoms',
    'Leggings':                 'Bottoms',
    'Shorts & Skorts':          'Bottoms',
    'Culottes & Capri Pants':   'Bottoms',
    'Jumpsuits & Playsuits':    'Bottoms',
    'Jackets & Coats':          'Outerwear',
    'Waterfalls & Kimonos':     'Outerwear',
    'Hoodies & Sweatshirts':    'Outerwear',
    'Sweaters & Ponchos':       'Outerwear',
    'Two-Piece Sets':           'Two-Piece Sets',
    'Pants & Top Set':          'Two-Piece Sets',
    'Skirts & Top Set':         'Two-Piece Sets',
    'Pants & Waterfall Set':    'Two-Piece Sets',
    "Men's Tops":               'Tops',
    "Men's Bottoms":            'Bottoms',
    'Scarves':                  'Accessories',
    'Accessories':              'Accessories',
    'Earrings':                 'Accessories',
    'Necklaces':                'Accessories',
    'Rings':                    'Accessories',
    'Belts':                    'Accessories',
    'Bangles & Bracelets':      'Accessories',
    'Body Mists & Fragrances':  'Accessories',
    'Sample & Sale Items':      'Sale',
    'Gift Vouchers':            'Gift Vouchers',
}

VALID_SUBCATS = set(CATEGORY_MAP.keys())

# SQL CASE fragment generated from CATEGORY_MAP so the in-Python mapping and
# the SQL category-sync passes can never drift apart. Names/labels contain no
# untrusted input; single quotes are escaped defensively anyway.
CATEGORY_CASE_SQL = "CASE product_type " + " ".join(
    "WHEN '{}' THEN '{}'".format(k.replace("'", "''"), v.replace("'", "''"))
    for k, v in CATEGORY_MAP.items()
) + " ELSE category END"


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
    name = re.sub(r' -([^ ])', r' - \1', name)
    if ' - ' in name:
        return name.split(' - ')[0].strip()
    return name.strip()


def extract_color_from_name(name):
    if not name:
        return None
    # Normalize hyphen separators to ' - ' regardless of surrounding spaces:
    #   'Ponte- Black'  -> 'Ponte - Black'
    #   'Ponte -Black'  -> 'Ponte - Black'
    #   'Ponte-Black'   -> left alone (hyphen inside a word/color like Off-White)
    name = re.sub(r'(?<=\S)\s*-\s+', ' - ', name)  # nospace/space before, space after
    name = re.sub(r'\s+-\s*(?=\S)', ' - ', name)   # space before, nospace/space after
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


def is_sample(name, sku):
    n = (name or '').upper()
    s = (sku or '').upper()
    return (
        'SAMPLE' in n or 'TEST' in n or
        s.startswith('FS') or s.startswith('SD') or
        s.startswith('CS') or s.startswith('SALE') or
        s.startswith('TT') or 'SAL' in s[:4]
    )


def is_gift_voucher(name):
    n = (name or '').lower()
    return 'gift voucher' in n or 'gift card' in n


_INSERT_SQL = """
    INSERT INTO all_products_clean (
        sku, product_name, barcode, price, cost,
        brand, vendor, color_print, style_number,
        collection, style_name, print_plain,
        product_type, category, gender, season, size,
        stock_on_hand, stock_available, active, product_id, ever_sold,
        status, tier, is_noos, fabric_structure,
        plain_print, source_country, source_city, fabric_category, fabric_subcategory,
        fabric_width, gsm, supplier_fabric_code, noos_fabric, fiber_content
    ) VALUES %s
    ON CONFLICT (sku) DO UPDATE SET
        product_name    = EXCLUDED.product_name,
        price           = EXCLUDED.price,
        cost            = EXCLUDED.cost,
        is_noos = EXCLUDED.is_noos,
        fabric_structure = EXCLUDED.fabric_structure,
        plain_print = EXCLUDED.plain_print,
        source_country = EXCLUDED.source_country,
        source_city = EXCLUDED.source_city,
        fabric_category = EXCLUDED.fabric_category,
        fabric_subcategory = EXCLUDED.fabric_subcategory,
        fabric_width = EXCLUDED.fabric_width,
        gsm = EXCLUDED.gsm,
        supplier_fabric_code = EXCLUDED.supplier_fabric_code,
        noos_fabric = EXCLUDED.noos_fabric,
        fiber_content = EXCLUDED.fiber_content,
        active          = EXCLUDED.active
"""

_INSERT_SQL_NOOP = """
    INSERT INTO all_products_clean (
        sku, product_name, barcode, price, cost,
        brand, vendor, color_print, style_number,
        collection, style_name, print_plain,
        product_type, category, gender, season, size,
        stock_on_hand, stock_available, active, product_id, ever_sold,
        status, tier, is_noos, fabric_structure,
        plain_print, source_country, source_city, fabric_category, fabric_subcategory,
        fabric_width, gsm, supplier_fabric_code, noos_fabric, fiber_content
    ) VALUES %s
    ON CONFLICT (sku) DO NOTHING
"""

_BATCH = 1000  # rows flushed per commit — keeps Python heap bounded


def _flush(cur, conn, rows, sql=_INSERT_SQL):
    """Write accumulated rows to DB, commit, and clear the list in-place."""
    if not rows:
        return
    execute_values(cur, sql, rows, page_size=_BATCH)
    conn.commit()
    rows.clear()


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    now  = datetime.now(timezone.utc)

    log.info("Building all_products_clean...")
    cur.execute("TRUNCATE all_products_clean")
    conn.commit()  # release the exclusive lock immediately; subsequent inserts use row locks only

    # ── Sales enrichment data ────────────────────────────────────────────────
    # This is a grouped aggregate (one row per unique SKU), so it's much
    # smaller than the raw sales table — safe to load into a dict in one shot.
    cur.execute("""
        SELECT variant_sku,
            MAX(product_vendor) AS vendor,
            MAX(product_type)   AS sale_product_type,
            MAX(product_title)  AS sale_product_name
        FROM all_sales
        WHERE variant_sku IS NOT NULL AND variant_sku != ''
        GROUP BY variant_sku
    """)
    sales_data = {r[0]: r for r in cur.fetchall()}
    log.info("Sales enrichment data: %d SKUs", len(sales_data))

    # ── Dominant subcat per style name from Odoo ─────────────────────────────
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
        if sc not in VALID_SUBCATS:
            continue
        if sn not in subcat_counts or subcat_counts[sn][1] < freq:
            subcat_counts[sn] = (sc, freq)
    style_subcat = {k: v[0] for k, v in subcat_counts.items()}

    # ── Odoo products — streamed via server-side cursor ──────────────────────
    # Use a named cursor so Postgres streams rows to us in _BATCH-sized chunks
    # instead of loading all 20k+ rows into Python memory at once.
    seen_skus = set()
    rows      = []
    total_odoo = 0

    # withhold=True: _flush() commits on this same connection every _BATCH
    # rows, and a commit closes a plain named cursor mid-iteration
    # ("named cursor isn't valid anymore" — truncated all_products_clean to
    # 1000 rows). WITH HOLD keeps the server-side cursor alive across commits.
    with conn.cursor(name="odoo_products_cursor", withhold=True) as sc:
        sc.itersize = _BATCH
        sc.execute("""
            SELECT DISTINCT ON (default_code)
                id, name, default_code, barcode,
                list_price, standard_price, categ_name,
                sub_category, style_name, style_number,
                collection, color, brand, vendor,
                category, gender, season, status, tier, active,
                fabric_structure,
                plain_print, source_country, source_city,
                fabric_category, fabric_subcategory, fabric_width, gsm,
                supplier_fabric_code, noos_fabric, fiber_content,
                write_date
            FROM raw_odoo_products
            WHERE default_code IS NOT NULL
            AND categ_name IN ('2. Finished Goods Inventory', '01. Finished Goods Inventory', '2. Finished Goods Inventory ')
            AND LOWER(name) NOT LIKE '%%shopping bag%%'
            AND LOWER(name) NOT LIKE '%%gift voucher%%'
            AND LOWER(name) NOT LIKE '%%gift card%%'
            ORDER BY default_code, write_date DESC
        """)

        for p in sc:
            (pid, name, sku, barcode, price, cost, categ_name,
             sub_category, style_name, style_number, collection,
             color, brand, vendor, category, gender, season,
             status, tier, active, fabric_structure,
             plain_print, source_country, source_city,
             fabric_category, fabric_subcategory, fabric_width, gsm,
             supplier_fabric_code, noos_fabric, fiber_content,
             write_date) = p

            if sku in seen_skus:
                continue
            seen_skus.add(sku)

            s = sales_data.get(sku)

            # Style name and color
            # The Odoo source style_name is corrupt for some styles (e.g. 32 unrelated
            # styles all stamped "Vivo Knee Length Kaftan in Satin"). The product name
            # is authoritative, so always derive style_name from it rather than trusting
            # the source. (Post-processing then canonicalises one name per style_number.)
            sname = extract_style_name(name)
            clr   = color or extract_color_from_name(name)
            if clr:
                clr = clr.title()

            # Product name
            product_name = name  # use Odoo name directly — reconstruction from sname+clr introduced wrong colors

            # Brand
            br   = brand or guess_brand(name)
            # The Odoo source style_number is reliable when present and well-formed,
            # but ~187 rows carry a garbage single-letter "V" that, if trusted,
            # collapses many unrelated styles into one bucket and corrupts style_name.
            # Only trust a source value that looks like a real style number; else derive.
            snum = style_number if (style_number and re.match(r'^[A-Za-z]?\d{6,8}$', str(style_number).strip())) else extract_style_number(sku, name)
            size = extract_size(sku)

            # Subcategory
            if is_gift_voucher(name):
                subcat = 'Gift Vouchers'
            elif is_sample(name, sku):
                subcat = 'Sample & Sale Items'
            elif sub_category and sub_category in VALID_SUBCATS:
                subcat = sub_category
            elif style_subcat.get(sname):
                subcat = style_subcat[sname]
            else:
                subcat = None

            cat = CATEGORY_MAP.get(subcat)

            # Print/plain
            name_upper = (name or '').upper()
            clr_upper  = (clr or '').upper()
            if 'PRINT' in clr_upper or 'PRINT' in name_upper or \
               'ANKARA' in name_upper or 'KITENGE' in name_upper or \
               'TIE DYE' in name_upper:
                print_plain = 'Print'
            else:
                print_plain = 'Plain'

            rows.append((
                sku, product_name, str(barcode) if barcode else None,
                float(price or 0), float(cost or 0),
                br, vendor,
                clr, snum, collection, sname,
                print_plain, subcat, cat,
                gender, season, size,
                0, 0,
                bool(active), pid,
                s is not None,
                status, tier,
                (tier == "NOOS"),  # is_noos
                fabric_structure or None,
                plain_print or None, source_country or None, source_city or None,
                fabric_category or None, fabric_subcategory or None,
                fabric_width or None, gsm or None,
                supplier_fabric_code or None, noos_fabric or None, fiber_content or None,
            ))
            total_odoo += 1

            # Flush every _BATCH rows so the accumulator never holds the full set
            if len(rows) >= _BATCH:
                _flush(cur, conn, rows)
                log.info("  %d Odoo products inserted so far…", total_odoo)

    _flush(cur, conn, rows)  # final partial batch
    log.info("Odoo products inserted: %d", total_odoo)

    # ── SKUs from sales not in Odoo ──────────────────────────────────────────
    sales_only = 0
    for sku, s in sales_data.items():
        if sku in seen_skus:
            continue
        sale_name   = s[3]
        sale_vendor = s[1]

        br    = guess_brand(sale_name)
        sname = extract_style_name(sale_name)
        clr   = extract_color_from_name(sale_name)
        if clr:
            clr = clr.title()
        snum  = extract_style_number(sku, sale_name)
        size  = extract_size(sku)

        if is_gift_voucher(sale_name or ''):
            subcat = 'Gift Vouchers'
        elif is_sample(sale_name or '', sku):
            subcat = 'Sample & Sale Items'
        else:
            subcat = None

        cat = CATEGORY_MAP.get(subcat)

        name_upper = (sale_name or '').upper()
        clr_upper  = (clr or '').upper()
        print_plain = 'Print' if ('PRINT' in clr_upper or 'PRINT' in name_upper or
                                   'ANKARA' in name_upper or 'KITENGE' in name_upper) else 'Plain'

        rows.append((
            sku, sale_name, None, 0.0, 0.0,
            br, sale_vendor, clr, snum, None, sname,
            print_plain, subcat, cat,
            None, None, size, 0, 0,
            None, None, True,
            None, None,  # status, tier
            False,  # is_noos
            None, None, None, None, None, None, None, None, None, None, None,  # fabric fields
        ))
        seen_skus.add(sku)
        sales_only += 1

        if len(rows) >= _BATCH:
            _flush(cur, conn, rows)

    _flush(cur, conn, rows)
    log.info("Sales-only SKUs inserted: %d", sales_only)
    log.info("Total products inserted: %d", total_odoo + sales_only)

    cur.execute("SELECT COUNT(*) FROM all_products_clean")
    log.info("✅ all_products_clean before inventory: %d rows", cur.fetchone()[0])

    # ── Add inventory SKUs not in products ───────────────────────────────────
    cur.execute("""
        SELECT DISTINCT i.sku, i.style_name, i.product_name,
               i.size, i.color_print, i.brand, i.sub_category
        FROM all_inventory i
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        WHERE p.sku IS NULL AND i.sku IS NOT NULL
    """)
    inv_rows = cur.fetchall()
    log.info("Inventory SKUs to add: %d", len(inv_rows))

    inv_insert = []
    for r in inv_rows:
        sku, style_name, product_name, size, color, brand, subcat = r
        br    = brand or guess_brand(product_name or '')
        snum  = extract_style_number(sku, product_name or '')
        sname = style_name or extract_style_name(product_name or '')
        if subcat not in VALID_SUBCATS:
            subcat = None
        cat   = CATEGORY_MAP.get(subcat)
        s     = sales_data.get(sku)

        name_upper = (product_name or '').upper()
        clr_upper  = (color or '').upper()
        print_plain = 'Print' if ('PRINT' in clr_upper or 'PRINT' in name_upper or
                                   'ANKARA' in name_upper or 'KITENGE' in name_upper) else 'Plain'

        inv_insert.append((
            sku, product_name, None, 0.0, 0.0,
            br, None, color, snum, None, sname,
            print_plain, subcat, cat,
            None, None, size, 0, 0,
            None, None, s is not None,
            None, None,  # status, tier
            False,  # is_noos
            None, None, None, None, None, None, None, None, None, None, None,  # fabric fields
        ))

        if len(inv_insert) >= _BATCH:
            _flush(cur, conn, inv_insert, sql=_INSERT_SQL_NOOP)

    inv_added = len(inv_rows)
    _flush(cur, conn, inv_insert, sql=_INSERT_SQL_NOOP)
    if inv_added:
        log.info("✅ Added %d inventory SKUs", inv_added)

    # ── Re-derive style_name from product_name (AUTHORITATIVE) ───────────────
    # The upstream style_name source was corrupting whole styles (e.g. 32
    # unrelated styles stamped "Vivo Knee Length Kaftan in Satin"). product_name
    # is reliable, so derive style_name as the text before the colour separator.
    log.info("Re-deriving style_name from product_name...")
    cur.execute("""
        UPDATE all_products_clean
        SET style_name = TRIM(SPLIT_PART(regexp_replace(product_name, ' -([^ ])', ' - \1'), ' - ', 1))
        WHERE product_name IS NOT NULL AND product_name <> ''
          AND TRIM(SPLIT_PART(regexp_replace(product_name, ' -([^ ])', ' - \1'), ' - ', 1))
              IS DISTINCT FROM style_name
    """)
    log.info("style_name re-derived: %d rows updated", cur.rowcount)
    conn.commit()
    cur.execute("ANALYZE all_products_clean")
    conn.commit()
    log.info("✅ ANALYZE all_products_clean complete")

    # ── Canonicalise style_name to ONE per style_number ──────────────────────
    # Minor name variants within a style_number (casing, "Basic" prefix, colour
    # suffixes) get unified to the dominant name. Tie-break: frequency, then the
    # longer (more descriptive) name, then alphabetical.
    log.info("Canonicalising style_name per style_number...")
    cur.execute("""
        WITH ranked AS (
            SELECT style_number, style_name,
                   ROW_NUMBER() OVER (
                       PARTITION BY style_number
                       ORDER BY COUNT(*) DESC, LENGTH(style_name) DESC, style_name ASC
                   ) AS rn
            FROM all_products_clean
            WHERE style_number IS NOT NULL AND style_name IS NOT NULL
            GROUP BY style_number, style_name
        ),
        dominant AS (SELECT style_number, style_name FROM ranked WHERE rn = 1)
        UPDATE all_products_clean a
        SET style_name = d.style_name
        FROM dominant d
        WHERE a.style_number = d.style_number
          AND a.style_name IS DISTINCT FROM d.style_name
    """)
    log.info("style_name canonicalised: %d rows updated", cur.rowcount)

    # ── Enforce dominant subcat per style number ─────────────────────────────
    log.info("Enforcing dominant subcat per style number...")
    cur.execute("""
        WITH global_freq AS (
            -- how common each subcat is overall, used as a deterministic tie-break
            SELECT product_type, COUNT(*) AS gfreq
            FROM all_products_clean
            WHERE product_type IS NOT NULL
            GROUP BY product_type
        ),
        dominant AS (
            SELECT d.style_number,
                   d.product_type,
                   ROW_NUMBER() OVER (
                       PARTITION BY d.style_number
                       ORDER BY d.cnt DESC, COALESCE(g.gfreq,0) DESC, d.product_type ASC
                   ) as rn
            FROM (
                SELECT style_number, product_type, COUNT(*) AS cnt
                FROM all_products_clean
                WHERE style_number IS NOT NULL
                AND product_type IS NOT NULL
                AND product_type != 'Sample & Sale Items'
                AND product_type != 'Gift Vouchers'
                GROUP BY style_number, product_type
            ) d
            LEFT JOIN global_freq g ON g.product_type = d.product_type
        )
        UPDATE all_products_clean p
        SET product_type = d.product_type
        FROM dominant d
        WHERE p.style_number = d.style_number
        AND d.rn = 1
        AND p.product_type NOT IN ('Sample & Sale Items', 'Gift Vouchers')
    """)
    log.info("Dominant subcat enforced: %d rows updated", cur.rowcount)

    # ── Sync category to match subcat ────────────────────────────────────────
    cur.execute("""
        UPDATE all_products_clean
        SET category = """ + CATEGORY_CASE_SQL + """
        WHERE product_type IS NOT NULL
    """)
    log.info("Categories synced to subcats")

    # ── Force sample/test products into Sample & Sale Items ───────────────────
    # Products whose name carries a sample marker as a whole word (sample, fs,
    # ms, msd) are fitting/style-development samples, not sellable stock. Stamp
    # all identity fields so they group cleanly and never pollute real styles.
    log.info("Classifying sample products...")
    cur.execute("""
        UPDATE all_products_clean
        SET product_type = 'Sample & Sale Items',
            category     = 'Sale',
            style_name   = 'Sample & Sale Items',
            style_number = 'Sample & Sale Items'
        WHERE product_name ~* '\msample\M' OR product_name ~* '\mfs\M'
           OR product_name ~* '\mms\M' OR product_name ~* '\mmsd\M'
           OR sku ~* '^BF[0-9]' OR style_number ~* '^BF[0-9]'
    """)
    log.info("Sample products classified: %d rows updated", cur.rowcount)

    # ── Canonicalise collection & brand to ONE value per style_name ──────────
    # A style_name is set per-SKU upstream, so SKUs of the same style can carry
    # different collection/brand values (376 styles split on collection). That
    # makes a style appear as multiple rows in SOR / Products / any grouped view.
    # Force each style to its DOMINANT (most common) collection and brand so one
    # style = one collection = one brand everywhere. Idempotent; runs each build.
    for col in ("collection", "brand"):
        cur.execute("""
            WITH ranked AS (
                SELECT style_name, {c} AS val,
                       ROW_NUMBER() OVER (
                           PARTITION BY style_name
                           ORDER BY COUNT(*) DESC, {c} ASC
                       ) AS rn
                FROM all_products_clean
                WHERE style_name IS NOT NULL AND {c} IS NOT NULL
                GROUP BY style_name, {c}
            ),
            dominant AS (SELECT style_name, val FROM ranked WHERE rn = 1)
            UPDATE all_products_clean a
            SET {c} = d.val
            FROM dominant d
            WHERE a.style_name = d.style_name
              AND a.{c} IS DISTINCT FROM d.val
        """.format(c=col))
        log.info("Canonicalised %s: %d rows updated", col, cur.rowcount)
    conn.commit()

    # ── Update barcodes from Shopify (already loaded) ────────────────────────
    conn.commit()

    cur.execute("SELECT COUNT(*) FROM all_products_clean")
    log.info("✅ all_products_clean final: %d rows", cur.fetchone()[0])

    cur.execute("""
        SELECT brand, COUNT(*) FROM all_products_clean
        GROUP BY brand ORDER BY COUNT(*) DESC
    """)
    for row in cur.fetchall():
        log.info("  %s: %d", row[0], row[1])

    # ── FINAL consolidation: one subcat + category per style_number ──────────
    # Run last so no earlier pass can leave a style split. Deterministic winner:
    # most common subcat in the style, ties broken by global subcat frequency
    # then alphabetical. Samples/gift vouchers are left untouched (kept separate).
    log.info("Final subcat consolidation (looped to convergence)...")
    consolidation_sql = """
        WITH global_freq AS (
            SELECT product_type, COUNT(*) AS gfreq FROM all_products_clean
            WHERE product_type IS NOT NULL GROUP BY product_type
        ),
        dominant AS (
            SELECT d.style_number, d.product_type,
                   ROW_NUMBER() OVER (PARTITION BY d.style_number
                       ORDER BY d.cnt DESC, COALESCE(g.gfreq,0) DESC, d.product_type ASC) AS rn
            FROM (SELECT style_number, product_type, COUNT(*) AS cnt
                  FROM all_products_clean
                  WHERE style_number IS NOT NULL AND product_type IS NOT NULL
                    AND product_type NOT IN ('Sample & Sale Items','Gift Vouchers')
                  GROUP BY style_number, product_type) d
            LEFT JOIN global_freq g ON g.product_type=d.product_type
        )
        UPDATE all_products_clean p
        SET product_type = d.product_type
        FROM dominant d
        WHERE p.style_number = d.style_number AND d.rn = 1
          AND p.product_type NOT IN ('Sample & Sale Items','Gift Vouchers')
          AND p.product_type IS DISTINCT FROM d.product_type
    """
    # Commit between iterations so each pass sees the previous pass's result
    # (avoids a CTE-snapshot interaction that left some styles split when run
    # as a single mid-transform statement). Converges fast; cap as a safety net.
    for _i in range(10):
        cur.execute(consolidation_sql)
        n = cur.rowcount
        conn.commit()
        log.info("  consolidation pass %d: %d rows updated", _i + 1, n)
        if n == 0:
            break
    cur.execute("""
        UPDATE all_products_clean
        SET category = """ + CATEGORY_CASE_SQL + """
        WHERE product_type IS NOT NULL
    """)
    log.info("Final category sync done")

    # ── Durable product-master overrides (WS8 T810) ──────────────────────────
    # Odoo attribute data carries a few wrong brand/subcategory values; the
    # shared override list (also applied on API boot) corrects them here so a
    # re-extract never resurrects them.
    from product_master_overrides import apply_overrides
    fixed = apply_overrides(conn, log)
    log.info("Product-master overrides applied: %d rows", fixed)
    conn.commit()

    # ── Verify no style number has multiple subcats ──────────────────────────
    cur.execute("""
        SELECT COUNT(*) FROM (
            SELECT style_number
            FROM all_products_clean
            WHERE style_number IS NOT NULL
            AND product_type IS NOT NULL
            AND product_type NOT IN ('Sample & Sale Items', 'Gift Vouchers')
            GROUP BY style_number
            HAVING COUNT(DISTINCT product_type) > 1
        ) x
    """)
    conflicts = cur.fetchone()[0]
    log.info("Style numbers with multiple subcats: %d", conflicts)

    conn.close()


if __name__ == "__main__":
    main()