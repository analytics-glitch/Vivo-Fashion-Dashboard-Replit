"""Durable product-master corrections (WS8 T810).

The Odoo attribute data carries a handful of wrong brand / subcategory values
(e.g. "Safari by Vivo …" styles tagged BRAND=Vivo, Soko earrings and the Vivo
Basic A-line Maxi Skirt tagged subcategory "Maxi Dresses"). The source of truth
is Odoo, so a re-extract would resurrect them — these idempotent UPDATEs are
applied BOTH at the end of transform_all_products_clean.py AND on API boot
(deferred startup), so dev, prod and any rebuild all self-heal.
"""

# (description, sql) — every statement must be idempotent (guarded WHERE).
OVERRIDE_STATEMENTS = [
    ("Safari-prefixed styles carry brand=Safari (matches guess_brand rule; "
     "fixes 'Safari by Vivo …' styles Odoo tags as Vivo)",
     """
     UPDATE all_products_clean
     SET brand = 'Safari'
     WHERE style_name ILIKE 'safari%'
       AND brand IS DISTINCT FROM 'Safari'
     """),
    ("Soko earrings are Accessories, not Maxi Dresses",
     """
     UPDATE all_products_clean
     SET product_type = 'Accessories', category = 'Accessories'
     WHERE style_name ILIKE 'soko%earring%'
       AND product_type IS DISTINCT FROM 'Accessories'
     """),
    ("Vivo Basic A-line Maxi Skirt is a Maxi Skirt, not a Maxi Dress",
     """
     UPDATE all_products_clean
     SET product_type = 'Maxi Skirts', category = 'Skirts'
     WHERE style_name ILIKE '%basic a-line maxi skirt%'
       AND product_type IS DISTINCT FROM 'Maxi Skirts'
     """),
    ("A-line knee-length DRESSES mis-tagged as Fitted Tops "
     "(RFS/sample-era mapping; 'Dress Top' styles are genuinely tops and untouched)",
     """
     UPDATE all_products_clean
     SET product_type = 'Knee Length Dresses', category = 'Dresses'
     WHERE product_type = 'Fitted Tops'
       AND style_name ILIKE '%dress%'
       AND style_name NOT ILIKE '%dress top%'
     """),
]


def apply_overrides(conn, log=None):
    """Run all override statements on an open psycopg2 connection. Caller commits."""
    total = 0
    with conn.cursor() as cur:
        for desc, sql in OVERRIDE_STATEMENTS:
            cur.execute(sql)
            if log and cur.rowcount:
                log.info("product-master override [%s]: %d rows", desc[:60], cur.rowcount)
            total += cur.rowcount
    return total
