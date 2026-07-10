"""Canonical Odoo POS config_name → all_sales.pos_location_name map.

Kept in its own tiny, env-free module so BOTH the sync loop
(sync_incremental.py) and the API (api_pg.py, e.g. /api/analytics/
sales-by-hour channel filtering) import the SAME map without api_pg having
to import sync_incremental — that module reads SHOPIFY_*/DATABASE_URL env
vars at import time and would crash (or silently degrade) an API process
that lacks those secrets.
"""

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
