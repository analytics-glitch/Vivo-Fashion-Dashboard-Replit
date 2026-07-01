"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
import datetime
import os
import re
import psycopg2.extras
from fastapi import APIRouter, Query, Request, Body, HTTPException

import fabric_sheet_override as ov

fabric_router = APIRouter(tags=["fabric"])


def _odoo_product_url(product_id):
    """Build a deep link to an Odoo product.product form so a buyer can open the
    fabric and fill in its Width/GSM or a stored kg/m. `product_id` is the Odoo
    product.product id (= raw_fabric_products.id / mo_fabric_consumption.component_id).
    Returns None when there is no id or ODOO_URL is not configured (so the UI can
    simply omit the link rather than render a broken one)."""
    base = (os.environ.get("ODOO_URL") or "").rstrip("/")
    if not base or not product_id:
        return None
    return f"{base}/web#id={int(product_id)}&model=product.product&view_type=form"

# Manual buying-team reservations are stored in an app-owned table created lazily
# (idempotent) the first time a reservation endpoint is hit. This is distinct from
# Odoo's own `raw_fabric_inventory.reserved_qty` (ERP allocations).
_FABRIC_TABLES_READY = False

# The Jan–Apr 2026 consumption/returns sheet override (see fabric_sheet_override.py)
# replaces Odoo's inflated moves for that window. Every consumption/returns read
# goes through the `fabric_moves_effective` view (= ov.EFFECTIVE_MOVES) instead of
# raw_fabric_moves; the view is created lazily here, mirroring _ensure_fabric_tables.
EFFECTIVE_MOVES = ov.EFFECTIVE_MOVES
_FABRIC_SHEET_READY = False

def _ensure_fabric_sheet(conn):
    """Create the override tables + the unified view (idempotent, once per process).
    The view needs raw_fabric_moves/products to exist; if they don't yet (fresh DB),
    create the tables now and retry the view on a later call."""
    global _FABRIC_SHEET_READY
    if _FABRIC_SHEET_READY:
        return
    with conn.cursor() as cur:
        ov.ensure_tables(cur)
        ready = ov.base_tables_exist(cur)
        if ready:
            ov.ensure_view(cur)
    conn.commit()
    if ready:
        _FABRIC_SHEET_READY = True

def _ensure_fabric_tables(conn):
    global _FABRIC_TABLES_READY
    if _FABRIC_TABLES_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_reservations (
                id               SERIAL PRIMARY KEY,
                product_id       INTEGER NOT NULL,
                qty              NUMERIC NOT NULL,
                uom              TEXT NOT NULL,
                qty_kg           NUMERIC NOT NULL,
                style_name       TEXT NOT NULL,
                note             TEXT,
                status           TEXT NOT NULL DEFAULT 'active',
                reserved_by      TEXT,
                reserved_by_name TEXT,
                reserved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                used_at          TIMESTAMPTZ,
                used_by          TEXT
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_resv_product "
                    "ON fabric_reservations(product_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_resv_status "
                    "ON fabric_reservations(status)")
    conn.commit()
    _FABRIC_TABLES_READY = True

def _fabric_actor(request):
    """(user_id, name) for the current signed-in user, mirroring CRM's actor helper."""
    u = getattr(request.state, "user", None) or {}
    uid = u.get("user_id") or u.get("id") or "system"
    name = u.get("name") or u.get("email") or "system"
    return uid, name

def _fabric_actor_email(request):
    """The signed-in user's email (for the change-log audit trail), '' if unknown."""
    u = getattr(request.state, "user", None) or {}
    return u.get("email") or ""

def _log_fabric_change(action, resv, request):
    """Best-effort: file a reservation change into the Google-Sheet audit log.
    NEVER raises (the helper swallows/logs errors in a daemon thread)."""
    try:
        import fabric_change_log
        _uid, name = _fabric_actor(request)
        fabric_change_log.log_change(action, resv, name,
                                     _fabric_actor_email(request))
    except Exception:
        pass

def _resv_for_log(conn, resv_id):
    """Reservation row enriched with the fabric product name, for the audit log."""
    rows = q(conn, """
        SELECT r.id, r.qty, r.uom, r.style_name, r.note, r.status,
               p.name AS product
        FROM fabric_reservations r
        LEFT JOIN raw_fabric_products p ON p.id = r.product_id
        WHERE r.id=%s
    """, (resv_id,))
    return rows[0] if rows else None

def _get_conn():
    """Use the main app's connection pool."""
    import sys, os
    sys.path.insert(0, '/home/runner/workspace')
    # Import lazily to avoid circular import at module load time
    import importlib
    api = importlib.import_module('api_pg')
    return api.get_conn()

def q(conn, sql, params=()):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]

# ── Consumption / returns model ─────────────────────────────
# Consumption is measured strictly at the raw-material EXIT point — the moment
# fabric leaves the raw-material store RMAT/Stock:
#   * consumption (adds) — an INTERNAL move RMAT/Stock → PROD/Stock (into production)
#     or RMAT/Stock → Samp/Fabric (pulled to make samples). A plain OUT move (e.g. a
#     downstream PROD/Stock → Virtual Locations/Production leg) does NOT count.
# Some of it comes back as a return:
#   * returns (nets off) — an INTERNAL move whose location_to is RMAT/Stock, coming
#     from production (Virtual Locations/Production) OR any real (non-virtual) stock
#     location. Inventory-adjustment write-ons
#     (Virtual Locations/Inventory adjustment → RMAT/Stock) are stock-count
#     corrections, not returned fabric, and are excluded.
# Net consumption = (RMAT→PROD/Stock + RMAT→Samp) − (genuine returns into RMAT/Stock).
# Location literals are single fixed values (returns use split_part, never LIKE '%'),
# which also avoids the psycopg2 literal-% trap on the no-param queries.
PROD_LOC = "Virtual Locations/Production"
STOCK_LOC = "RMAT/Stock"          # the raw-material fabric store (consumption exits here)
PROD_STOCK_LOC = "PROD/Stock"     # the production real-stock location (an RMAT exit target)
SAMP_LOC = "Samp/Fabric"          # the sampling location (an RMAT exit target)

def _kg(alias="m"):
    return f"(CASE WHEN {alias}.uom='g' THEN {alias}.qty/1000 ELSE {alias}.qty END)"

def _consume_pred(alias="m"):
    """Consumption is booked at the raw-material EXIT point: an INTERNAL move OUT of
    RMAT/Stock into production real-stock (PROD/Stock) or the sampling location
    (Samp/Fabric). Nothing else counts — a plain 'OUT' move (e.g.
    PROD/Stock → Virtual Locations/Production) is a downstream leg, not the
    raw-material exit, and is deliberately excluded. All location literals are single
    fixed values (no LIKE), so the no-param q() queries dodge the literal-% trap."""
    return (f"{alias}.move_type='INTERNAL' "
            f"AND {alias}.location_from = '{STOCK_LOC}' "
            f"AND {alias}.location_to IN ('{PROD_STOCK_LOC}', '{SAMP_LOC}')")

def _rmat_return_pred(alias="m"):
    """A genuine physical return INTO the raw-material store: an INTERNAL move whose
    location_to = RMAT/Stock, coming from production ('Virtual Locations/Production')
    OR from any real (non-virtual) stock location (PROD/Stock, FABPR/Stock,
    Samp/Fabric, …). Inventory-adjustment write-ons
    ('Virtual Locations/Inventory adjustment' → RMAT/Stock) are stock-count
    corrections, NOT returned fabric, and are excluded — we keep the production
    virtual location but drop every other 'Virtual Locations/...' source.
    `split_part(..., '/', 1)` (not LIKE '%') dodges the psycopg2 literal-% trap on
    the no-param queries."""
    return (f"{alias}.move_type='INTERNAL' "
            f"AND {alias}.location_to = '{STOCK_LOC}' "
            f"AND (split_part({alias}.location_from, '/', 1) <> 'Virtual Locations' "
            f"OR {alias}.location_from = '{PROD_LOC}')")

def _net_kg(alias="m"):
    """Signed kg per move row: +kg for consumption (RMAT/Stock → PROD/Stock or
    Samp/Fabric), −kg for genuine returns back into RMAT/Stock. Inventory-adjustment
    write-ons into RMAT/Stock are excluded from the return leg. Kept in lockstep with
    `_net_cons_where`."""
    kg = _kg(alias)
    return (f"CASE WHEN {_consume_pred(alias)} THEN {kg} "
            f"WHEN {_rmat_return_pred(alias)} THEN -{kg} "
            f"ELSE 0 END")

def _net_cons_where(alias="m"):
    """Rows that make up net consumption: the RMAT-exit consumption legs plus the
    genuine returns back into RMAT/Stock (inventory-adjustment write-ons excluded).
    Identical leg definitions to `_net_kg` so every dependent metric stays
    consistent."""
    return (f"(({_consume_pred(alias)}) "
            f"OR ({_rmat_return_pred(alias)})) "
            f"AND {alias}.uom IN ('g','kg') "
            f"AND {alias}.is_fabric")

# Number of weeks in a calendar month, used to turn a monthly average run-rate
# into a weekly run-rate for weeks-of-cover.
WEEKS_PER_MONTH = 52.0 / 12.0
DAYS_PER_MONTH = 30.4375

# ── Vivo Colour Directory 2025 ──────────────────────────────
# Canonical fabric-colour → primary-colour map (98 fabric colours → 14 primary
# colours). Used to derive a clean colour breakdown of fabric stock from the
# messy source columns (the DB `primary_color` is empty and `fabric_color` is
# inconsistent), primarily by parsing each product's name. Casing here IS the
# canonical output casing.
_FABRIC_COLOR_DIRECTORY = {
    "Black": "Black",
    "Baby Blue": "Blue", "Blue": "Blue", "Dark Blue": "Blue", "Dark Teal": "Blue",
    "Denim Blue": "Blue", "Light Blue": "Blue", "Light Teal": "Blue",
    "Navy Blue": "Blue", "Royal Blue": "Blue", "Teal": "Blue", "Turquoise": "Blue",
    "Beige": "Brown", "Brown": "Brown", "Caramel": "Brown", "Chocolate Brown": "Brown",
    "Dark Beige": "Brown", "Dark Brown": "Brown", "Dark Tan": "Brown", "Dark Taupe": "Brown",
    "Khaki Beige": "Brown", "Khaki Brown": "Brown", "Light Beige": "Brown",
    "Light Brown": "Brown", "Light Tan": "Brown", "Light Taupe": "Brown",
    "Sand": "Brown", "Tan": "Brown", "Taupe": "Brown",
    "Army Green": "Green", "Dark Green": "Green", "Dark Olive Green": "Green",
    "Emerald Green": "Green", "Forest Green": "Green", "Green": "Green",
    "Hunters Green": "Green", "Jungle Green": "Green", "Khaki Green": "Green",
    "Light Green": "Green", "Light Olive Green": "Green", "Lime Green": "Green",
    "Neon Green": "Green", "Olive Green": "Green", "Sea Green": "Green",
    "Dark Grey": "Grey", "Grey": "Grey", "Khaki Grey": "Grey", "Light Grey": "Grey",
    "Brass": "Metallic", "Copper": "Metallic", "Gold": "Metallic", "Silver": "Metallic",
    "Multicolor": "Multicolor",
    "None": "None",
    "Burnt Orange": "Orange", "Coral": "Orange", "Dark Orange": "Orange",
    "Dark Rust": "Orange", "Light Orange": "Orange", "Light Rust": "Orange",
    "Orange": "Orange", "Peach": "Orange", "Rust": "Orange",
    "Dark Pink": "Pink", "Dusty Pink": "Pink", "Fuchsia": "Pink", "Light Pink": "Pink",
    "Magenta": "Pink", "Neon Pink": "Pink", "Pink": "Pink", "Rose Pink": "Pink",
    "Bright Purple": "Purple", "Dark Purple": "Purple", "Light Purple": "Purple",
    "Lilac": "Purple", "Plum": "Purple", "Purple": "Purple", "Violet": "Purple",
    "Burgundy": "Red", "Dark Burgundy": "Red", "Dark Maroon": "Red", "Dark Red": "Red",
    "Light Burgundy": "Red", "Light Red": "Red", "Maroon": "Red", "Red": "Red",
    "Cream": "White", "Ivory": "White", "Off White": "White", "White": "White",
    "Bright Yellow": "Yellow", "Buttermilk": "Yellow", "Dark Mustard": "Yellow",
    "Light Mustard": "Yellow", "Lime Yellow": "Yellow", "Marigold": "Yellow",
    "Mustard": "Yellow", "Yellow": "Yellow",
}

# Common short forms found in product names → canonical directory fabric colour.
_FABRIC_COLOR_ALIASES = {
    "navy": "Navy Blue",
    "olive": "Olive Green",
    "chocolate": "Chocolate Brown",
    "denim": "Denim Blue",
    "royal": "Royal Blue",
    "emerald": "Emerald Green",
    "forest": "Forest Green",
    "army": "Army Green",
    "jungle": "Jungle Green",
    "hunter": "Hunters Green",
    "hunters": "Hunters Green",
    "lime": "Lime Green",
    "charcoal": "Dark Grey",
    "wine": "Burgundy",
    "dusty rose": "Dusty Pink",
    "aqua": "Turquoise",
}

def _build_color_match_list():
    """Match candidates = every directory fabric colour + every alias, lowercased,
    sorted longest-first so the most-specific phrase wins (e.g. 'Olive Green'
    before 'Green', 'Light Blue' before 'Blue')."""
    cands = {}
    for canon in _FABRIC_COLOR_DIRECTORY:
        if canon == "None":
            continue
        cands[canon.lower()] = canon
    for alias, canon in _FABRIC_COLOR_ALIASES.items():
        cands.setdefault(alias.lower(), canon)
    return sorted(cands.items(), key=lambda kv: len(kv[0]), reverse=True)

_COLOR_MATCH_LIST = _build_color_match_list()

def _match_fabric_color(text):
    """Scan free text (case-insensitive) for any directory fabric colour or alias,
    returning the canonical fabric colour (most-specific/longest match wins).
    Matching is token-aware (non-alphanumerics become word breaks) so a colour
    never matches inside another word. Returns None when nothing resolves."""
    if not text:
        return None
    norm = " " + re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip() + " "
    for phrase, canon in _COLOR_MATCH_LIST:
        if " " + phrase + " " in norm:
            return canon
    return None

def _derive_fabric_colors(name, fabric_color):
    """Resolve (fabric_color, primary_color) for a fabric product: first parse the
    product name, then fall back to the source `fabric_color` column run through
    the same matcher. Returns (None, None) when neither resolves."""
    fc = _match_fabric_color(name)
    if not fc:
        fc = _match_fabric_color(fabric_color)
    if not fc:
        return None, None
    return fc, _FABRIC_COLOR_DIRECTORY.get(fc)

def _months_of_cover(conn, fabric_stock_kg, scope="main", product_ids=None):
    """Months-of-cover from a trailing 6-fully-completed-months average monthly
    run-rate (no current-month projection).

    The window is the 6 most-recent COMPLETED calendar months (M-6 .. M-1); the
    current, in-progress month is excluded entirely. The denominator is total net
    consumption over those 6 months ÷ 6, so it rolls automatically and self-heals
    as months advance (e.g. in August the window becomes Feb–Jul). Consumption
    stays net-of-production-returns + fabric-only via the shared net-consumption
    model.
    """
    fabric_stock_kg = float(fabric_stock_kg or 0)
    # When a curated product-id set is supplied (e.g. the Basic Fabrics KPI) the
    # consumption universe is JUST those products — the support/main scope filter
    # is bypassed entirely. Ids come straight from the DB (integers), so inlining
    # them is injection-safe.
    if product_ids is not None:
        if not product_ids:
            cons_scope = "FALSE"
        else:
            ids_csv = ",".join(str(int(i)) for i in product_ids)
            cons_scope = f"m.product_id IN ({ids_csv})"
    else:
        cons_scope = _scope_sql(scope)
    months = q(conn, f"""
        SELECT to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
               SUM({_net_kg('m')})::numeric AS kg
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE {_net_cons_where('m')}
          AND {cons_scope}
          AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date
          AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
        GROUP BY 1
    """)
    mon_kg = {r['mon']: float(r['kg'] or 0) for r in months}
    today = q(conn, "SELECT CURRENT_DATE AS today")[0]['today']

    def _key(delta):
        idx = today.year * 12 + (today.month - 1) + delta
        return f"{idx // 12:04d}-{idx % 12 + 1:02d}"

    complete = [_key(d) for d in range(-6, 0)]   # M-6 .. M-1 (last 6 completed months)

    sum_complete = sum(mon_kg.get(k, 0.0) for k in complete)
    avg_monthly = sum_complete / 6.0
    cover_now = (fabric_stock_kg / avg_monthly) if avg_monthly > 0 else None

    # Status lets the frontend degrade gracefully instead of collapsing a card
    # with real stock to a bare "—". Three cases:
    #   "ok"          – run-rate present, months_of_cover is a real number.
    #   "overstocked" – stock on hand but ZERO consumption over the trailing 6
    #                   completed months, so the divide is undefined yet cover is
    #                   effectively "very high" (a genuinely slow staple, or
    #                   mid-rebuild). Render a capped "12+"/"no recent use"
    #                   marker, not a dash.
    #   "no_data"     – neither stock nor consumption (truly nothing to show).
    if avg_monthly > 0:
        cover_status = "ok"
    elif fabric_stock_kg > 0:
        cover_status = "overstocked"
    else:
        cover_status = "no_data"

    return {
        "months_of_cover": round(cover_now, 2) if cover_now is not None else None,
        "months_of_cover_status": cover_status,
        "months_of_cover_stock_kg": round(fabric_stock_kg, 1),
        "avg_monthly_consumption_kg": round(avg_monthly, 1),
        "cover_window_months": 6,
    }

# ── Location filter ─────────────────────────────────────────
# The business only tracks real fabric stock in two locations. "All"/empty must
# resolve to the SET of these two (never every warehouse location); a specific
# location filters to just that one. Any other/unknown location falls back to the
# two-location set so excluded locations (FABRR/HQ/PROD/Samp/…) never leak in.
_ALL_LOC = {"", "all", "__all__"}
_FABRIC_LOCATIONS = ("RMAT/Stock", "Dead/Stock Fabric")

def _loc_filter(location, alias="i"):
    """Return (sql_fragment, params) for the location_name filter.

    A recognised specific location → that location only. "All"/empty/unknown →
    the two real fabric-stock locations (RMAT/Stock + Dead/Stock Fabric)."""
    loc = None if location is None else str(location).strip()
    if loc and loc.lower() not in _ALL_LOC and loc in _FABRIC_LOCATIONS:
        return (f" AND {alias}.location_name = %s", [loc])
    placeholders = ", ".join(["%s"] * len(_FABRIC_LOCATIONS))
    return (f" AND {alias}.location_name IN ({placeholders})", list(_FABRIC_LOCATIONS))

# ── Support-fabric scope (Lining + Fusable Interfacing) ─────────────
# "Support fabrics" = EXACTLY the two Odoo categories the user defined:
# 'Lining' and 'Fusable Interfacing'. Matched on a NORMALIZED (lower/trim,
# NULL→'') EXACT category equality — NOT a substring — so near-named variants
# like 'Crepe Lining' deliberately stay in the MAIN dashboard. Every aggregating
# endpoint takes a `scope` query param:
#   'main'   (default) → EXCLUDES support fabrics  (the existing dashboard tabs)
#   'support'          → keeps ONLY support fabrics (the new Support Fabrics tab)
# Rows with no classifiable category (NULL/'' — e.g. sheet-override moves whose
# product_id didn't resolve to a product master) normalize to '' → NOT support →
# they stay in MAIN. That preserves the reconciliation main + support == the old
# all-fabric totals (and honours the "sheet rows always count" rule).
def _support_match(col):
    # Support fabrics = EXACTLY the two Odoo categories the user defined:
    # "Lining" and "Fusable Interfacing". Matched case-insensitively and trimmed.
    # An exact IN (not a substring LIKE) so near-named categories like
    # "Crepe Lining" stay in the MAIN dashboard, per the user's explicit scope.
    c = f"LOWER(BTRIM(COALESCE({col},'')))"
    return f"({c} IN ('lining', 'fusable interfacing'))"

def _scope_sql(scope, col="p.fabric_category"):
    """SQL boolean fragment restricting rows to the requested support-fabric scope."""
    m = _support_match(col)
    return m if str(scope or "").lower() == "support" else f"NOT {m}"

# ── Basic (core staple) fabrics ─────────────────────────────
# A curated set of staple fabrics the buying team always wants to keep in stock,
# identified by a (vendor/supplier → fabric-code) pairing. SINGLE SOURCE OF TRUTH
# for the "Basic Fabrics — Months of Cover" Overview KPI; edit here to change it.
# A row qualifies only when its supplier matches the listed vendor AND its
# name/default_code/barcode contains the listed code — code alone is not enough,
# so an unrelated fabric sharing a number is never pulled in. Matching is
# case-insensitive and tolerant of surrounding text (the code is embedded in a
# longer fabric name) and supplier-name casing variants. '367#' carries a literal
# '#' handled as plain text. A listed pairing that matches nothing simply
# contributes zero (the KPI never errors); the matched-count is surfaced.
BASIC_FABRICS = {
    "Runfeng":            ["8003", "8004", "8224"],
    "Yat Taj Hong":       ["CA10091", "CA12220"],
    "Reeyon":             ["LY001", "LY004", "LY470"],
    "Yitai Cloth Trade":  ["91005"],
    "Dong Sheng (DS)":    ["82033"],
    "Fashion Knitted":    ["1629"],
    "Shunwang Textiles":  ["367#"],
    "Yajun":              ["HS8912"],
    "Worldview":          ["Interfacing"],
    "Lexin":              ["Interlining"],
    "Yun Xiang":          ["A1507"],
}

def _resolve_basic_fabrics(conn):
    """Resolve the curated supplier→codes map to matching raw_fabric_products.

    Returns (product_ids, matched_pairs, total_pairs):
      product_ids  – distinct ids across every matched pairing (the KPI universe)
      matched_pairs – count of (supplier, code) entries that matched ≥1 product
      total_pairs   – total curated (supplier, code) entries
    Matching is per-pair so the matched-count is meaningful (an unmatched code is
    visible in the KPI sub-line). Supplier is matched case-insensitively/trimmed;
    the code is matched as a substring of name/default_code/barcode (ILIKE), with
    LIKE wildcards in the code escaped so '%'/'_' (and the literal '#') are inert.
    """
    ids = set()
    matched = 0
    total = 0
    for supplier, codes in BASIC_FABRICS.items():
        for code in codes:
            total += 1
            esc = (str(code).replace("\\", "\\\\")
                            .replace("%", "\\%")
                            .replace("_", "\\_"))
            like = f"%{esc}%"
            rows = q(conn, r"""
                SELECT id FROM raw_fabric_products p
                WHERE lower(btrim(COALESCE(p.supplier,''))) = lower(btrim(%s))
                  AND (COALESCE(p.name,'')         ILIKE %s ESCAPE '\'
                    OR COALESCE(p.default_code,'') ILIKE %s ESCAPE '\'
                    OR COALESCE(p.barcode,'')      ILIKE %s ESCAPE '\')
            """, [supplier, like, like, like])
            if rows:
                matched += 1
                ids.update(r["id"] for r in rows)
    return list(ids), matched, total

# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary(location: str = Query(default="RMAT/Stock"),
            scope: str = Query(default="main")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # Capture the requested support-scope BEFORE `scope` is reused below as the
        # location-bucket row list (rmat/dead) — they share the name historically.
        scope_param = str(scope or "main")
        scope_sql = _scope_sql(scope_param)
        # Stock by location
        stock = q(conn, f"""
            SELECT 
              i.location_name,
              p.category,
              COUNT(DISTINCT i.product_id) as products,
              ROUND(SUM(i.quantity)::numeric,1) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND {scope_sql}
            GROUP BY i.location_name, p.category
        """)
        
        sel = None if location is None else str(location).strip()
        all_loc = sel is None or sel.lower() in _ALL_LOC or sel not in _FABRIC_LOCATIONS
        # The two real fabric-stock buckets. Everything else (FABRR/HQ/PROD/Samp/…)
        # is excluded entirely from the headline figures.
        rmat = [r for r in stock if r['category'] == 'Fabric'
                and r['location_name'] == 'RMAT/Stock']
        dead = [r for r in stock if r['location_name'] == 'Dead/Stock Fabric']
        trim = [r for r in stock if r['category'] == 'Trim']
        # Selected scope feeds the three headline KPIs. "All" = RMAT + Dead;
        # a specific location = just that bucket (so totals reconcile: All = RMAT + Dead).
        if all_loc:
            scope = rmat + dead
        elif sel == 'Dead/Stock Fabric':
            scope = dead
        else:  # RMAT/Stock
            scope = rmat
        
        # POs outstanding (product-matched so it can honour the support scope)
        pos = q(conn, f"""
            SELECT COUNT(DISTINCT po.po_name) as count,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as value
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.qty_ordered > po.qty_received AND po.state != 'cancel'
              AND {scope_sql}
        """)[0]

        # Average cost per metre — STOCK ON HAND. Blended cost of the LIVE
        # RMAT/Stock fabric base (excludes Dead/Production/Virtual — same base as
        # the on-hand headline & Months of cover): stock value (KES) ÷ stock metres,
        # computed ONLY over fabrics that have a kg→metre conversion (kg_per_mtr_eff>0).
        # BOTH the value (numerator) and the metres (denominator) are restricted to
        # convertible fabrics so the figure is not distorted by value that has no
        # matching metres. Fabrics missing Width/GSM are excluded and reported as a
        # coverage signal (count + value) rather than blanking the headline figure.
        acpm_stock = q(conn, f"""
            SELECT ROUND(SUM(i.total_value) FILTER (WHERE p.kg_per_mtr_eff>0)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as metres,
                   COUNT(DISTINCT p.id) FILTER (WHERE p.kg_per_mtr_eff IS NULL) as excluded_count,
                   ROUND(SUM(i.total_value) FILTER (WHERE p.kg_per_mtr_eff IS NULL)::numeric,0) as excluded_value
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
              AND {scope_sql}
        """)[0]
        acpm_stock_excluded_count = int(acpm_stock['excluded_count'] or 0)
        acpm_stock_excluded_value = round(float(acpm_stock['excluded_value'] or 0))
        acpm_stock_metres = float(acpm_stock['metres'] or 0)
        acpm_stock_value = float(acpm_stock['value_kes'] or 0)
        avg_cost_per_metre_stock = (
            round(acpm_stock_value / acpm_stock_metres, 2)
            if acpm_stock_metres > 0 else None)

        # Average cost per metre — PURCHASES. SUM(received qty × unit price) ÷
        # SUM(received metres) over ALL non-cancelled POs (entire history), using
        # RECEIVED quantity (what actually landed), converted to metres via the
        # product master's kg_per_mtr. Per-supplier breakdown lets a supplier whose
        # fabrics lack the conversion be pinpointed (its row + the headline → "—").
        # Scoped to category='Fabric' (Raw Materials-Fabric) only, identically to
        # the STOCK side above — Trim/unmatched PO lines are excluded entirely.
        pur_rows = q(conn, f"""
            SELECT po.supplier as supplier,
                   ROUND(SUM(po.qty_received*po.price_unit) FILTER (WHERE p.kg_per_mtr_eff>0)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN po.qty_received/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as metres,
                   COUNT(DISTINCT p.id) FILTER (WHERE p.kg_per_mtr_eff IS NULL) as excluded_count,
                   ROUND(SUM(po.qty_received*po.price_unit) FILTER (WHERE p.kg_per_mtr_eff IS NULL)::numeric,0) as excluded_value
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
              AND {scope_sql}
            GROUP BY po.supplier
        """)
        # Culprit fabrics behind every "incomplete" supplier: received fabrics whose
        # kg→metre conversion is missing (kg_per_mtr_eff IS NULL) so their value lands
        # in the numerator but contributes no metres. Same base/filters as pur_rows
        # above so the per-supplier counts line up with the `incomplete` flag. Grouped
        # per (supplier, product) so a fabric received over multiple POs shows once.
        missing_rows = q(conn, f"""
            SELECT po.supplier as supplier,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as name,
                   p.default_code as sku,
                   ROUND(SUM(po.qty_received)::numeric,1) as qty_kg,
                   ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) as value_kes
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
              AND p.kg_per_mtr_eff IS NULL
              AND {scope_sql}
            GROUP BY po.supplier, p.name, p.default_code
            ORDER BY value_kes DESC
        """)
        missing_by_supplier = {}
        for m in missing_rows:
            missing_by_supplier.setdefault(m['supplier'], []).append({
                "name": m['name'],
                "sku": m['sku'],
                "qty_kg": float(m['qty_kg'] or 0),
                "value_kes": round(float(m['value_kes'] or 0)),
            })

        purchases_by_supplier = []
        pur_total_value = 0.0
        pur_total_metres = 0.0
        pur_excluded_count = 0
        pur_excluded_value = 0.0
        for r in pur_rows:
            exc = int(r['excluded_count'] or 0)
            exc_val = float(r['excluded_value'] or 0)
            val = float(r['value_kes'] or 0)
            met = float(r['metres'] or 0)
            pur_total_value += val
            pur_total_metres += met
            pur_excluded_count += exc
            pur_excluded_value += exc_val
            purchases_by_supplier.append({
                "supplier": r['supplier'] or "(unknown)",
                "value_kes": round(val),
                "metres": round(met, 1),
                # Cost/metre now computed over the supplier's CONVERTIBLE fabrics only
                # (value & metres both restricted), so a supplier with some missing
                # Width/GSM still shows a figure; the gap is surfaced via incomplete.
                "cost_per_metre": (round(val / met, 2) if met > 0 else None),
                "incomplete": exc > 0,
                "excluded_count": exc,
                "excluded_value": round(exc_val),
                "missing_fabrics": missing_by_supplier.get(r['supplier'], []),
            })
        # Sort by cost per metre desc; rows with no figure (no convertible metres)
        # sink to the bottom.
        purchases_by_supplier.sort(
            key=lambda x: (x['cost_per_metre'] is None, -(x['cost_per_metre'] or 0)))
        avg_cost_per_metre_purchases = (
            round(pur_total_value / pur_total_metres, 2)
            if pur_total_metres > 0 else None)
        pur_excluded_value = round(pur_excluded_value)
        
        # Consumption last 30 days — net of fabric returned from production.
        # Metres = each move's net kg ÷ the fabric's kg-per-metre (skip rows with
        # no/zero kg_per_mtr — negligible; RMAT/Stock has zero fabrics missing it).
        cons = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= NOW() - INTERVAL '30 days'
        """)[0]

        # Consumption so far today — net of production returns (m.date is a date/ts)
        cons_today = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= CURRENT_DATE
        """)[0]

        # Most recent day an actual consumption move (RMAT/Stock exit) was posted
        # within scope. Lets the UI distinguish a legitimate quiet-day 0 from a
        # stalled feed. NULL when there is no consumption history for this scope.
        last_cons = q(conn, f"""
            SELECT MAX(m.date::date) as d
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE ({_consume_pred('m')})
              AND m.uom IN ('g','kg')
              AND m.is_fabric
              AND {scope_sql}
        """)[0]

        # BOM styles
        bom = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as styles FROM raw_fabric_boms")[0]

        # Fabric-feed freshness — the most recent SUCCESSFUL Odoo fabric pull, used
        # by the page to show a real "last updated" age (not the browser clock) and
        # to flag a frozen feed (e.g. Odoo "Access Denied"). `_loaded_at` is written
        # by extract_fabric.py as a NAIVE UTC timestamp (datetime.utcnow()), so the
        # age is measured against UTC `now()` to stay correct regardless of the DB
        # session timezone. The extract normally runs many times a day, so >6h with
        # no successful pull means the feed is genuinely frozen.
        STALE_THRESHOLD_HOURS = 6
        fresh = q(conn, """
            SELECT MAX(_loaded_at) AS last_loaded,
                   EXTRACT(EPOCH FROM (timezone('UTC', now()) - MAX(_loaded_at))) AS secs
            FROM raw_fabric_products
        """)[0]
        fresh_secs = float(fresh['secs']) if fresh and fresh['secs'] is not None else None
        fresh_hours = round(fresh_secs / 3600.0, 2) if fresh_secs is not None else None
        # No successful pull at all (empty table / never loaded) is treated as stale.
        fabric_stale = (fresh_hours is None) or (fresh_hours > STALE_THRESHOLD_HOURS)

        # Months of cover — 6-month average monthly run-rate with the in-progress
        # month projected to its end-of-month figure (fabric consumption is lumpy
        # — production-run driven — so a single 30-day denominator swings wildly).
        # Cover always tracks the LIVE RMAT/Stock base (dead stock isn't "cover"),
        # so it doesn't change with the selected scope.
        rmat_stock_kg = round(sum(r['qty_kg'] or 0 for r in rmat), 1)
        rmat_stock_value = round(sum(r['value_kes'] or 0 for r in rmat))
        dead_stock_value = sum(r['value_kes'] or 0 for r in dead)
        cover = _months_of_cover(conn, rmat_stock_kg, scope_param)

        # Basic Fabrics — Months of Cover. One combined cover figure across the
        # curated staple-fabric set ONLY (supplier+code pairs in BASIC_FABRICS),
        # computed with the SAME method as the headline cover: live RMAT/Stock kg
        # base ÷ the average net run-rate over the last 6 fully completed months,
        # restricted to the curated product
        # ids. Bypasses the support/main scope (the curated set is its own
        # universe). Never errors — an unmatched pairing just contributes nothing;
        # the matched/total counts are surfaced so a gap is noticeable.
        basic_ids, basic_matched, basic_total = _resolve_basic_fabrics(conn)
        if basic_ids:
            basic_stock_kg = q(conn, f"""
                SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name='RMAT/Stock'
                  AND i.product_id IN ({",".join(str(int(x)) for x in basic_ids)})
            """)[0]['kg'] or 0
            _basic = _months_of_cover(
                conn, basic_stock_kg, scope_param, product_ids=basic_ids
            )
            basic_cover = _basic['months_of_cover']
            basic_cover_status = _basic['months_of_cover_status']
        else:
            # No curated pairing matched any product (e.g. mid-rebuild): there is
            # genuinely nothing to compute. Surface this distinctly from a
            # stock-but-no-usage "overstocked" state so the card stays legible.
            basic_stock_kg = 0
            basic_cover = None
            basic_cover_status = "no_match"

        # Headline KPIs reflect the selected scope; All = RMAT + Dead.
        return {
            "fabric_stock_kg": round(sum(r['qty_kg'] or 0 for r in scope), 1),
            "fabric_stock_metres": round(sum(r['qty_metres'] or 0 for r in scope)),
            "fabric_stock_value": round(sum(r['value_kes'] or 0 for r in scope)),
            "fabric_products": sum(r['products'] or 0 for r in scope),
            # Stable grand total (RMAT + Dead) for the dead-stock % regardless of scope.
            "total_fabric_value": rmat_stock_value + dead_stock_value,
            "dead_stock_value": dead_stock_value,
            "dead_stock_kg": sum(r['qty_kg'] or 0 for r in dead),
            "outstanding_pos": pos['count'] or 0,
            "outstanding_po_value": pos['value'] or 0,
            "avg_cost_per_metre_stock": avg_cost_per_metre_stock,
            "avg_cost_per_metre_stock_incomplete": acpm_stock_excluded_count > 0,
            "avg_cost_per_metre_stock_excluded_count": acpm_stock_excluded_count,
            "avg_cost_per_metre_stock_excluded_value": acpm_stock_excluded_value,
            "avg_cost_per_metre_purchases": avg_cost_per_metre_purchases,
            "avg_cost_per_metre_purchases_incomplete": pur_excluded_count > 0,
            "avg_cost_per_metre_purchases_excluded_count": pur_excluded_count,
            "avg_cost_per_metre_purchases_excluded_value": pur_excluded_value,
            "purchases_by_supplier": purchases_by_supplier,
            "consumption_30d_kg": cons['kg'] or 0,
            "consumption_30d_metres": cons['metres'] or 0,
            "consumption_today_kg": cons_today['kg'] or 0,
            "consumption_today_metres": cons_today['metres'] or 0,
            "last_consumption_date": (last_cons['d'].isoformat() if last_cons['d'] else None),
            "styles_with_bom": bom['styles'] or 0,
            "basic_months_of_cover": basic_cover,
            "basic_months_of_cover_status": basic_cover_status,
            "basic_fabrics_matched": basic_matched,
            "basic_fabrics_total": basic_total,
            "basic_fabrics_stock_kg": round(float(basic_stock_kg or 0), 1),
            # Fabric-feed freshness (display-only; same value regardless of scope).
            "fabric_last_loaded_secs": round(fresh_secs) if fresh_secs is not None else None,
            "fabric_last_loaded_hours": fresh_hours,
            "fabric_data_stale": fabric_stale,
            "fabric_stale_threshold_hours": STALE_THRESHOLD_HOURS,
            **cover,
        }

# ── Avg metres of fabric consumed per garment ──────────────
# Derived from Done DPS manufacturing orders (mo_fabric_consumption, populated by
# extract_mo_fabric_consumption.py). Metric = Σ(main-fabric metres consumed across
# qualifying MOs) ÷ Σ(garments produced across those MOs), rolling last `days`
# (default 30) by MO completion date. kg→metres via each fabric SKU's
# kg_per_mtr_eff (metres = kg / kg_per_mtr_eff; consumed qty in grams is /1000
# first; a UoM already in metres is used as-is). A fabric with no kg_per_mtr_eff
# (no stored value, no Width/GSM) is converted with the overall fabric-average
# Kg/Mtr fallback so its MO is still counted rather than dropped. An MO is
# excluded ONLY when it produced 0 garments or had no fabric; the count of MOs
# that relied on the fallback (and the fallback value) is reported separately.
@fabric_router.get("/api/fabric/metres-per-garment")
def metres_per_garment(days: int = Query(default=30)):
    days = max(1, min(int(days or 30), 730))
    with _get_conn() as conn:
        # Fallback Kg/Mtr — the overall average kg_per_mtr_eff across every fabric
        # that HAS a usable value (stored, or derived from Width × GSM ÷ 1000).
        # ~1,017 fabrics have no Kg/Mtr at all (no stored value, no Width/GSM);
        # a production order using one of those used to be dropped from the
        # average, quietly shrinking the basis. We instead convert those kg with
        # this fallback average so the order is still counted. Computed once.
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
        """, [days])

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "has_fabric": False, "used_fallback": False},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        if u in M_UOMS:
            # Already in metres — keep exactly as-is.
            d["metres"] += qty
        else:
            # kg/g-unit fabric (or a component absent from the master with no
            # metre uom): convert kg→metres. Use the fabric's own Kg/Mtr when it
            # has one; otherwise fall back to the overall average so the order is
            # still counted instead of being dropped.
            kg = qty / 1000.0 if u == "g" else qty
            if kpm and float(kpm) > 0:
                d["metres"] += kg / float(kpm)
            elif fallback_kpm:
                d["metres"] += kg / fallback_kpm
                d["used_fallback"] = True
            # If there is no fallback at all (no fabric has a Kg/Mtr), this
            # component contributes 0 metres but the order is still counted.

    total_metres = 0.0
    total_garments = 0.0
    n_mos = 0
    fallback_mos = 0
    for d in mos.values():
        # An order is excluded ONLY when it produced 0 garments or had no fabric.
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        total_metres += d["metres"]
        total_garments += d["produced"]
        n_mos += 1
        if d["used_fallback"]:
            fallback_mos += 1

    value = round(total_metres / total_garments, 2) if total_garments > 0 else None
    return {
        "metres_per_garment": value,
        "total_metres": round(total_metres, 1),
        "garments": round(total_garments),
        "mos": n_mos,
        "mos_using_fallback": fallback_mos,
        "fallback_kg_per_mtr": round(fallback_kpm, 4) if fallback_kpm else None,
        "window_days": days,
    }


# ── Avg metres / garment: downloadable .xlsx calculations report ─────────
# A full audit trail behind the "Avg metres / garment" KPI card: every qualifying
# Done-DPS MO, its fabric components, the kg→metre conversion applied, and how it
# all rolls up to the headline value. The per-MO conversion + exclusion logic MUST
# mirror metres_per_garment EXACTLY (same window, same UoM handling, same own-vs-
# fallback kg/m, same NULL-kpm-as-missing treatment) so the workbook reconciles to
# the card. The Summary sheet reuses metres_per_garment's own totals so it is
# guaranteed identical to what the card shows.
@fabric_router.get("/api/fabric/metres-per-garment.xlsx")
def metres_per_garment_xlsx(days: int = Query(default=30)):
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    days = max(1, min(int(days or 30), 730))

    # Reuse the headline endpoint's totals so the Summary sheet matches the card.
    summary = metres_per_garment(days=days)
    fallback_kpm = None  # recomputed below for the per-component "kg/m used" column

    with _get_conn() as conn:
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.mo_ref,
                   c.dps_ref,
                   c.done_date,
                   c.produced_qty,
                   c.style_name,
                   c.finished_sku,
                   c.component_id,
                   c.fabric_sku,
                   c.fabric_name,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   p.kg_per_mtr AS kpm_stored,
                   p.width_m,
                   p.gsm,
                   p.supplier
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
            ORDER BY c.done_date DESC, c.odoo_mo_id, c.fabric_sku
        """, [days])

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    # Fold component rows -> per-MO (identical maths to metres_per_garment), while
    # keeping every component's contribution for the detail sheet.
    mos = {}
    components = []
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"mo_ref": r["mo_ref"], "dps_ref": r["dps_ref"],
             "done_date": r["done_date"],
             "style": (r["style_name"] or "").strip() or None,
             "finished_sku": r["finished_sku"],
             "produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "has_fabric": False, "used_fallback": False},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        comp = {
            "odoo_mo_id": r["odoo_mo_id"], "mo_ref": r["mo_ref"],
            "component_id": r["component_id"],
            "fabric_sku": r["fabric_sku"], "fabric_name": r["fabric_name"],
            "supplier": r["supplier"],
            "width_m": r["width_m"], "gsm": r["gsm"], "kpm_stored": r["kpm_stored"],
            "uom": r["uom"], "consumed_qty": qty,
            "kpm_used": None, "used_fallback": False, "metres": 0.0,
        }
        if u in M_UOMS:
            d["metres"] += qty
            comp["metres"] = qty  # already metres; no conversion applied
        else:
            kg = qty / 1000.0 if u == "g" else qty
            if kpm and float(kpm) > 0:
                m = kg / float(kpm)
                d["metres"] += m
                comp["kpm_used"] = float(kpm)
                comp["metres"] = m
            elif fallback_kpm:
                m = kg / fallback_kpm
                d["metres"] += m
                d["used_fallback"] = True
                comp["kpm_used"] = fallback_kpm
                comp["used_fallback"] = True
                comp["metres"] = m
            # No fallback at all: contributes 0 metres (MO still counted).
        components.append(comp)

    # Per-MO rows (only qualifying MOs — excluded exactly as the KPI does).
    per_mo = []
    qualifying_mo_ids = set()
    for mo_id, d in mos.items():
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        qualifying_mo_ids.add(mo_id)
        per_mo.append({
            "odoo_mo_id": mo_id, "mo_ref": d["mo_ref"], "dps_ref": d["dps_ref"],
            "done_date": d["done_date"], "style": d["style"],
            "finished_sku": d["finished_sku"], "garments": d["produced"],
            "total_metres": d["metres"],
            "metres_per_garment": (d["metres"] / d["produced"]) if d["produced"] > 0 else None,
            "used_fallback": d["used_fallback"],
        })
    per_mo.sort(key=lambda x: (x["done_date"] is None, x["done_date"], x["odoo_mo_id"]), reverse=True)

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    R = Alignment(horizontal="right")

    def _style_header(ws, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Avg metres / garment — calculations report"
    ws["A1"].font = TITLE
    kpi_val = summary.get("metres_per_garment")
    srows = [
        ("Rolling window (days)", summary.get("window_days")),
        ("Avg metres / garment (KPI)", kpi_val),
        ("Total main-fabric metres", summary.get("total_metres")),
        ("Total garments", summary.get("garments")),
        ("MOs counted", summary.get("mos")),
        ("MOs using fallback conversion", summary.get("mos_using_fallback")),
        ("Fallback kg per metre", summary.get("fallback_kg_per_mtr")),
        ("Basis", "Done DPS manufacturing orders, main-fabric components only"),
        ("Reconciliation", "Total metres ÷ Total garments = Avg metres / garment"),
    ]
    r0 = 3
    for i, (label, val) in enumerate(srows):
        ws.cell(row=r0 + i, column=1, value=label).font = LBL
        ws.cell(row=r0 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 56

    # Per-MO sheet
    ws2 = wb.create_sheet("Per-MO")
    mo_cols = ["MO ref", "DPS ref", "Done date", "Finished style",
               "Finished SKU", "Garments produced", "Total metres",
               "Metres / garment", "Used fallback conversion"]
    ws2.append(mo_cols)
    _style_header(ws2, len(mo_cols))
    for m in per_mo:
        ws2.append([
            m["mo_ref"], m["dps_ref"],
            (m["done_date"].isoformat() if hasattr(m["done_date"], "isoformat") else m["done_date"]),
            m["style"], m["finished_sku"],
            round(m["garments"], 2),
            round(m["total_metres"], 3),
            (round(m["metres_per_garment"], 3) if m["metres_per_garment"] is not None else None),
            "Yes" if m["used_fallback"] else "No",
        ])
    for col, w in zip("ABCDEFGHI", [16, 22, 12, 34, 16, 16, 14, 16, 22]):
        ws2.column_dimensions[col].width = w

    # Per-component sheet (only components of qualifying MOs, to reconcile).
    # The "Open in Odoo" column deep-links the fabric so a buyer can jump straight
    # to the product and fill in its Width/GSM or a stored kg/m.
    ws3 = wb.create_sheet("Per-component")
    comp_cols = ["MO ref", "Fabric SKU", "Fabric name", "UoM",
                 "Consumed qty", "Kg per metre used", "Used fallback",
                 "Metres contributed", "Open in Odoo"]
    ws3.append(comp_cols)
    _style_header(ws3, len(comp_cols))
    LINK = Font(color="1A5C38", underline="single")
    for c in components:
        if c["odoo_mo_id"] not in qualifying_mo_ids:
            continue
        ws3.append([
            c["mo_ref"], c["fabric_sku"], c["fabric_name"], c["uom"],
            round(c["consumed_qty"], 3),
            (round(c["kpm_used"], 4) if c["kpm_used"] is not None else None),
            "Yes" if c["used_fallback"] else "No",
            round(c["metres"], 3),
            None,
        ])
        # Only fabrics on the fallback need fixing — link those.
        if c["used_fallback"]:
            url = _odoo_product_url(c["component_id"])
            if url:
                cell = ws3.cell(row=ws3.max_row, column=len(comp_cols))
                cell.value = "Open in Odoo"
                cell.hyperlink = url
                cell.font = LINK
    for col, w in zip("ABCDEFGHI", [16, 18, 40, 8, 14, 18, 14, 18, 14]):
        ws3.column_dimensions[col].width = w

    # ── "Fabrics to fix" sheet — the companion view the buyers actually act on ──
    # One row per fabric that forced the fallback (no own kg→metre conversion),
    # ranked by impact, with what's missing and a direct Odoo link.
    fix = {}
    for c in components:
        if c["odoo_mo_id"] not in qualifying_mo_ids or not c["used_fallback"]:
            continue
        cid = c["component_id"]
        f = fix.setdefault(cid, {
            "component_id": cid, "sku": c["fabric_sku"], "name": c["fabric_name"],
            "supplier": c["supplier"], "width_m": c["width_m"], "gsm": c["gsm"],
            "kpm_stored": c["kpm_stored"], "_mos": set(),
            "metres": 0.0, "consumed_qty": 0.0,
        })
        f["_mos"].add(c["odoo_mo_id"])
        f["metres"] += c["metres"]
        f["consumed_qty"] += c["consumed_qty"]

    def _missing_str(f):
        # Kg/Mtr is now derived PURELY from Width × GSM ÷ 1000 (the stored Odoo
        # value is ignored), so the only thing a buyer can fill in to clear a
        # fabric is its Width and/or GSM.
        m = []
        if not (f["width_m"] and float(f["width_m"]) > 0):
            m.append("Width")
        if not (f["gsm"] and float(f["gsm"]) > 0):
            m.append("GSM")
        return ", ".join(m)

    fix_rows = sorted(fix.values(), key=lambda f: (len(f["_mos"]), f["metres"]), reverse=True)
    ws4 = wb.create_sheet("Fabrics to fix")
    ws4["A1"] = "Fabrics driving the fallback conversion — fill in Width/GSM or a kg/m in Odoo"
    ws4["A1"].font = TITLE
    fix_cols = ["Fabric SKU", "Fabric name", "Supplier", "Missing",
                "MOs affected", "Fallback metres", "Consumed (kg)", "Open in Odoo"]
    ws4.append([])  # spacer row 2
    ws4.append(fix_cols)  # header on row 3
    for col in range(1, len(fix_cols) + 1):
        cell = ws4.cell(row=3, column=col)
        cell.font = HEAD
        cell.fill = HEAD_FILL
    if not fix_rows:
        ws4.append(["No fabrics relied on the fallback in this window. 🎉"])
    for f in fix_rows:
        ws4.append([
            f["sku"], f["name"], f["supplier"], _missing_str(f),
            len(f["_mos"]), round(f["metres"], 1), round(f["consumed_qty"], 1),
            None,
        ])
        url = _odoo_product_url(f["component_id"])
        if url:
            cell = ws4.cell(row=ws4.max_row, column=len(fix_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEFGH", [18, 40, 22, 16, 14, 16, 14, 14]):
        ws4.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    fname = "avg-metres-per-garment-%dd.xlsx" % days
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


# ── Basic Fabrics — Months of Cover: downloadable .xlsx calculations report ──
# The full audit trail behind the "Basic Fabrics — Months of Cover" Overview KPI:
# every curated (vendor, fabric-code) pairing and whether it matched a product,
# each matched product with its RMAT/Stock on-hand kg, and the 6-month net
# consumption that drives the run-rate denominator. The cover figure and the
# stock/run-rate it divides MUST mirror the summary KPI exactly (same resolver,
# same RMAT/Stock base, same _months_of_cover projection over the curated ids) so
# the workbook reconciles to the card.
@fabric_router.get("/api/fabric/basic-fabrics-cover.xlsx")
def basic_fabrics_cover_xlsx():
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    with _get_conn() as conn:
        # Per-pair resolution — same matching as _resolve_basic_fabrics, but the
        # per-pairing product ids are kept so the "Curated fabrics" sheet can show
        # exactly which pairings matched and what each one holds in stock.
        pair_rows = []   # {supplier, code, ids:set}
        all_ids = set()
        for supplier, codes in BASIC_FABRICS.items():
            for code in codes:
                esc = (str(code).replace("\\", "\\\\")
                                .replace("%", "\\%")
                                .replace("_", "\\_"))
                like = f"%{esc}%"
                rows = q(conn, r"""
                    SELECT id FROM raw_fabric_products p
                    WHERE lower(btrim(COALESCE(p.supplier,''))) = lower(btrim(%s))
                      AND (COALESCE(p.name,'')         ILIKE %s ESCAPE '\'
                        OR COALESCE(p.default_code,'') ILIKE %s ESCAPE '\'
                        OR COALESCE(p.barcode,'')      ILIKE %s ESCAPE '\')
                """, [supplier, like, like, like])
                ids = {r["id"] for r in rows}
                all_ids.update(ids)
                pair_rows.append({"supplier": supplier, "code": code, "ids": ids})

        basic_ids = list(all_ids)
        matched = sum(1 for p in pair_rows if p["ids"])
        total = len(pair_rows)

        # Per-product master info + RMAT/Stock on-hand kg (the cover stock base).
        prod_info, stock_by_pid = {}, {}
        if basic_ids:
            ids_csv = ",".join(str(int(x)) for x in basic_ids)
            for r in q(conn, f"""
                SELECT id, default_code AS sku, name, supplier,
                       fabric_category AS category
                FROM raw_fabric_products WHERE id IN ({ids_csv})
            """):
                prod_info[r["id"]] = r
            for r in q(conn, f"""
                SELECT i.product_id AS pid, ROUND(SUM(i.quantity)::numeric, 1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name = 'RMAT/Stock'
                  AND i.product_id IN ({ids_csv})
                GROUP BY i.product_id
            """):
                stock_by_pid[r["pid"]] = float(r["kg"] or 0)
            # Headline stock MUST use the SAME single-aggregate ROUND(SUM(...))
            # the KPI uses (NOT SUM of per-product ROUNDs — that drifts by a few
            # tenths and breaks reconciliation). Per-product values above stay for
            # the detail sheet only.
            basic_stock_kg = q(conn, f"""
                SELECT ROUND(SUM(i.quantity)::numeric, 1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name = 'RMAT/Stock'
                  AND i.product_id IN ({ids_csv})
            """)[0]["kg"] or 0
            basic_stock_kg = round(float(basic_stock_kg), 1)
        else:
            basic_stock_kg = 0.0

        # Cover + run-rate (identical to the summary KPI: bypasses main/support
        # scope, restricted to the curated ids, RMAT/Stock kg base).
        if basic_ids:
            cov = _months_of_cover(conn, basic_stock_kg, "main",
                                   product_ids=basic_ids)
            status = cov["months_of_cover_status"]
        else:
            cov = {"months_of_cover": None, "months_of_cover_status": "no_match",
                   "avg_monthly_consumption_kg": 0.0}
            status = "no_match"

        # 6-month net consumption by month for the curated set (same window/model
        # as _months_of_cover so the run-rate denominator is auditable).
        if basic_ids:
            ids_csv = ",".join(str(int(x)) for x in basic_ids)
            month_rows = q(conn, f"""
                SELECT to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
                       SUM({_net_kg('m')})::numeric AS kg
                FROM {EFFECTIVE_MOVES} m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {_net_cons_where('m')}
                  AND m.product_id IN ({ids_csv})
                  AND m.date::date >= (date_trunc('month', CURRENT_DATE)
                                       - INTERVAL '6 months')::date
                  AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
                GROUP BY 1 ORDER BY 1
            """)
        else:
            month_rows = []

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    LINK = Font(color="1A5C38", underline="single")

    def _style_header(ws, ncols, row=1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    _status_text = {
        "ok": "OK — computed from run-rate",
        "overstocked": "Overstocked — stock on hand but no recent consumption",
        "no_data": "No data — no curated stock or consumption",
        "no_match": "No match — no curated fabric resolved to a product",
    }
    cover_disp = (cov["months_of_cover"] if status == "ok"
                  and cov["months_of_cover"] is not None
                  else ("12+ (overstocked)" if status == "overstocked" else "—"))

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Basic Fabrics — Months of Cover — calculations report"
    ws["A1"].font = TITLE
    srows = [
        ("Basic Fabrics — Months of Cover (KPI)", cover_disp),
        ("Status", _status_text.get(status, status)),
        ("Curated fabrics matched", "%d of %d" % (matched, total)),
        ("RMAT/Stock on hand (kg)", basic_stock_kg),
        ("Avg monthly net consumption (kg)", cov.get("avg_monthly_consumption_kg")),
        ("Cover window (months)", 6),
        ("Basis", "RMAT/Stock on-hand kg ÷ average net monthly consumption over "
                  "the last 6 fully completed months, restricted to the curated "
                  "staple fabrics"),
        ("Reconciliation", "Stock on hand ÷ Avg monthly net consumption "
                           "= Months of cover"),
    ]
    for i, (label, val) in enumerate(srows):
        ws.cell(row=3 + i, column=1, value=label).font = LBL
        ws.cell(row=3 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 58

    # Curated fabrics sheet (one row per vendor+code pairing)
    ws2 = wb.create_sheet("Curated fabrics")
    cur_cols = ["Vendor / supplier", "Fabric code", "Matched",
                "Products matched", "Stock on hand (kg)"]
    ws2.append(cur_cols)
    _style_header(ws2, len(cur_cols))
    for p in pair_rows:
        pkg = round(sum(stock_by_pid.get(pid, 0.0) for pid in p["ids"]), 1)
        ws2.append([
            p["supplier"], str(p["code"]),
            "Yes" if p["ids"] else "No",
            len(p["ids"]),
            pkg if p["ids"] else None,
        ])
    for col, w in zip("ABCDE", [24, 18, 10, 18, 18]):
        ws2.column_dimensions[col].width = w

    # Matched products sheet (one row per resolved product; reconciles to stock)
    ws3 = wb.create_sheet("Matched products")
    prod_cols = ["Fabric SKU", "Fabric name", "Supplier", "Category",
                 "Stock on hand (kg)", "Open in Odoo"]
    ws3.append(prod_cols)
    _style_header(ws3, len(prod_cols))
    prod_sorted = sorted(
        basic_ids, key=lambda pid: stock_by_pid.get(pid, 0.0), reverse=True)
    if not prod_sorted:
        ws3.append(["No curated fabric currently resolves to a product."])
    for pid in prod_sorted:
        info = prod_info.get(pid, {})
        ws3.append([
            info.get("sku"), info.get("name"), info.get("supplier"),
            info.get("category"), round(stock_by_pid.get(pid, 0.0), 1), None,
        ])
        url = _odoo_product_url(pid)
        if url:
            cell = ws3.cell(row=ws3.max_row, column=len(prod_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEF", [18, 40, 22, 18, 18, 14]):
        ws3.column_dimensions[col].width = w

    # Monthly consumption sheet (the 6-month net run-rate detail)
    ws4 = wb.create_sheet("Monthly consumption")
    mc_cols = ["Month", "Net consumption (kg)"]
    ws4.append(mc_cols)
    _style_header(ws4, len(mc_cols))
    for r in month_rows:
        ws4.append([r["mon"], round(float(r["kg"] or 0), 1)])
    ws4.append([])
    ws4.append(["Avg monthly net consumption (kg)",
                cov.get("avg_monthly_consumption_kg")])
    ws4.cell(row=ws4.max_row, column=1).font = LBL
    for col, w in zip("AB", [34, 22]):
        ws4.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="basic-fabrics-months-of-cover.xlsx"'},
    )


# ── Data quality: fabrics driving the metres/garment fallback ──────────
# The "Avg metres / garment" KPI converts any Done-DPS MO whose main fabric has
# no usable kg→metre conversion using the overall fabric-average (fallback) so the
# MO is still counted — but the figure is then approximate. This lists the fabric
# SKUs responsible, how many MOs and garments each one affects, what's missing
# (Width/GSM or a stored kg/m), and a deep link to its Odoo product so a buyer can
# fill it in and make the KPI exact. The bad-MO determination MUST mirror
# metres_per_garment exactly (same window, same convertibility test, NULL kpm
# treated as missing). A garment/MO can be affected by more than one fabric, so
# per-fabric counts can sum to more than the total.
@fabric_router.get("/api/fabric/data-quality/mo-missing-conversion")
def mo_missing_conversion(days: int = Query(default=90)):
    days = max(1, min(int(days or 90), 730))
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   c.component_id,
                   c.fabric_sku,
                   c.fabric_name,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   p.kg_per_mtr AS kpm_stored,
                   p.width_m,
                   p.gsm,
                   p.fabric_category,
                   p.fabric_subcategory,
                   p.supplier
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
        """, [days])

    KG_UOMS = {"kg", "g"}
    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    # Pass 1: per-MO bad flag + produced qty (identical logic to metres_per_garment).
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "bad": False, "has_fabric": False},
        )
        d["has_fabric"] = True
        u = r["uom"]
        kpm = r["kpm"]
        convertible = (u in M_UOMS) or (u in KG_UOMS and kpm and float(kpm) > 0)
        if not convertible:
            d["bad"] = True

    excluded = sum(
        1 for d in mos.values()
        if d["produced"] > 0 and d["has_fabric"] and d["bad"]
    )

    # Pass 2: attribute each excluded MO to the unconvertible fabric(s) inside it.
    fabrics = {}
    for r in rows:
        mo = mos.get(r["odoo_mo_id"])
        if not mo or mo["produced"] <= 0 or not mo["bad"]:
            continue
        u = r["uom"]
        kpm = r["kpm"]
        convertible = (u in M_UOMS) or (u in KG_UOMS and kpm and float(kpm) > 0)
        if convertible:
            continue
        cid = r["component_id"]
        f = fabrics.setdefault(cid, {
            "component_id": cid,
            "sku": r["fabric_sku"],
            "name": r["fabric_name"],
            "fabric_category": r["fabric_category"],
            "fabric_subcategory": r["fabric_subcategory"],
            "supplier": r["supplier"],
            "in_master": r["kpm"] is not None or r["fabric_category"] is not None,
            "width_m": r["width_m"],
            "gsm": r["gsm"],
            "kpm_stored": r["kpm_stored"],
            "_mos": set(),
            "garments": 0.0,
            "consumed_kg": 0.0,
        })
        if r["odoo_mo_id"] not in f["_mos"]:
            f["_mos"].add(r["odoo_mo_id"])
            f["garments"] += mo["produced"]
        qty = float(r["consumed_qty"] or 0)
        f["consumed_kg"] += qty / 1000.0 if u == "g" else qty

    items = []
    for f in fabrics.values():
        # What a buyer needs to fill in on the Odoo product to clear this fabric:
        # both Width and GSM (Kg/Mtr = Width × GSM ÷ 1000 — the stored Odoo
        # Kg/Mtr value is ignored, so it can no longer rescue a fabric).
        missing = []
        if not (f["width_m"] and float(f["width_m"]) > 0):
            missing.append("Width")
        if not (f["gsm"] and float(f["gsm"]) > 0):
            missing.append("GSM")
        items.append({
            "component_id": f["component_id"],
            "sku": f["sku"],
            "name": f["name"],
            "fabric_category": f["fabric_category"],
            "fabric_subcategory": f["fabric_subcategory"],
            "supplier": f["supplier"],
            "in_master": f["in_master"],
            "missing_fields": missing,
            "odoo_url": _odoo_product_url(f["component_id"]),
            "mos_blocked": len(f["_mos"]),
            "garments_blocked": round(f["garments"]),
            "consumed_kg": round(f["consumed_kg"], 1),
        })
    items.sort(key=lambda x: (x["mos_blocked"], x["garments_blocked"]), reverse=True)
    return {
        "count": len(items),
        "mos_excluded_missing_conversion": excluded,
        "window_days": days,
        "items": items,
    }


# ── Metres per garment, broken down by finished style ──────
# Same per-MO conversion + exclusion rule as the headline KPI above, but the
# qualifying MOs are grouped by their finished-product style (mo_fabric_consumption
# .style_name, captured from mrp.production.product_id's template in the extract).
# Returns one row per style: total metres, garments produced, MO count, and the
# style's metres-per-garment — so the team can spot the heaviest fabric consumers.
@fabric_router.get("/api/fabric/metres-per-garment-by-style")
def metres_per_garment_by_style(days: int = Query(default=90),
                                limit: int = Query(default=100)):
    days = max(1, min(int(days or 90), 730))
    limit = max(1, min(int(limit or 100), 1000))
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   c.style_name,
                   c.finished_sku,
                   p.kg_per_mtr_eff AS kpm
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
        """, [days])

    KG_UOMS = {"kg", "g"}
    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
    # First fold rows -> per-MO (metres + bad flag), carrying the MO's style.
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "bad": False, "has_fabric": False,
             "style": (r["style_name"] or "").strip() or None,
             "sku": r["finished_sku"]},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        if u in M_UOMS:
            d["metres"] += qty
        elif u in KG_UOMS and kpm and float(kpm) > 0:
            kg = qty / 1000.0 if u == "g" else qty
            d["metres"] += kg / float(kpm)
        else:
            d["bad"] = True

    # Then roll qualifying MOs up by style (excluded MOs counted but not summed).
    styles = {}
    for d in mos.values():
        key = d["style"] or "(unknown style)"
        s = styles.setdefault(
            key, {"style": key, "metres": 0.0, "garments": 0.0,
                  "mos": 0, "mos_excluded": 0, "sku": d["sku"]},
        )
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        if d["bad"]:
            s["mos_excluded"] += 1
            continue
        s["metres"] += d["metres"]
        s["garments"] += d["produced"]
        s["mos"] += 1

    out = []
    for s in styles.values():
        if s["garments"] <= 0:
            continue
        out.append({
            "style": s["style"],
            "finished_sku": s["sku"],
            "metres_per_garment": round(s["metres"] / s["garments"], 2),
            "total_metres": round(s["metres"], 1),
            "garments": round(s["garments"]),
            "mos": s["mos"],
            "mos_excluded_missing_conversion": s["mos_excluded"],
        })
    out.sort(key=lambda r: r["metres_per_garment"], reverse=True)
    return {"rows": out[:limit], "window_days": days, "styles": len(out)}


# ── Stock by category ──────────────────────────────────────
@fabric_router.get("/api/fabric/by-category")
def by_category(location: str = Query(default="RMAT/Stock"),
                scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        return q(conn, f"""
            SELECT 
              p.fabric_category as category,
              p.fabric_subcategory as subcategory,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(i.quantity)::numeric,1) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes,
              -- Weighted-average cost per Kg = Σ(standard_price × kg) ÷ Σ(kg),
              -- consistent with the register's per-product cost_per_kg (standard_price).
              ROUND(CASE WHEN SUM(i.quantity) > 0
                   THEN SUM(p.standard_price*i.quantity)/SUM(i.quantity)
                   ELSE NULL END::numeric,2) as cost_per_kg,
              -- Weighted-average cost per metre = Σ(standard_price × kg) ÷ Σ(metres)
              -- over products with a kg→metre conversion, consistent with the
              -- register's per-product cost_metre (standard_price × kg_per_mtr_eff).
              ROUND(CASE WHEN SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END) > 0
                   THEN SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*i.quantity ELSE 0 END)
                        /SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)
                   ELSE NULL END::numeric,2) as cost_metre
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0
              {loc_sql}
              AND p.fabric_category IS NOT NULL
              AND {_scope_sql(scope)}
            GROUP BY p.fabric_category, p.fabric_subcategory
            ORDER BY value_kes DESC
        """, loc_params)

# ── Fabric register (full list) ────────────────────────────
@fabric_router.get("/api/fabric/register")
def register(
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    plain_print: str = Query(default=None),
    weight_range: str = Query(default=None),
    fabric_color: str = Query(default=None),
    location: str = Query(default="RMAT/Stock"),
    search: str = Query(default=None),
    min_qty: float = Query(default=0),
    sort: str = Query(default="value_kes"),
    dir: str = Query(default="desc"),
    days: int = Query(default=90),
    limit: int = Query(default=200),
    offset: int = Query(default=0),
    scope: str = Query(default="main"),
):
    # Consumption window for the cover columns — same preset set as the Fabric mix
    # page (30/90/180/365), clamped identically so both pages reconcile.
    days = max(1, min(int(days or 90), 730))
    with _get_conn() as conn:
        # The register's `resv` CTE reads fabric_reservations; ensure it exists even
        # on a fresh DB where no reservation endpoint has been hit yet.
        _ensure_fabric_tables(conn)
        _ensure_fabric_sheet(conn)
        # Whitelist of sortable output columns (aliases in the SELECT below) so the
        # client can drive ORDER BY without any SQL-injection surface.
        ALLOWED_SORT = {
            "default_code", "barcode", "name", "fabric_category", "fabric_subcategory",
            "plain_print", "weight_range", "fabric_structure", "gsm", "width_m",
            "kg_per_mtr", "m_per_kg", "fiber_content", "fabric_type", "supplier", "primary_color", "fabric_color", "color",
            "qty_kg", "available_kg", "qty_metres", "available_metres", "value_kes",
            "cost_kes", "cost_per_kg", "cost_metre", "weeks_cover", "months_cover",
            "team_reserved_kg", "team_reserved_metres",
            "last_move", "days_since_move",
        }
        sort_col = sort if sort in ALLOWED_SORT else "value_kes"
        sort_dir = "ASC" if str(dir).lower() == "asc" else "DESC"
        order_by = f"ORDER BY {sort_col} {sort_dir} NULLS LAST"
        where = ["i.quantity > %s"]
        params = [min_qty]
        loc_sql, loc_params = _loc_filter(location)
        if loc_sql:
            where.append(loc_sql.replace(" AND ", "", 1)); params.extend(loc_params)
        if category:
            where.append("p.fabric_category = %s"); params.append(category)
        if subcategory:
            where.append("p.fabric_subcategory = %s"); params.append(subcategory)
        if plain_print:
            where.append("p.plain_print = %s"); params.append(plain_print)
        if weight_range:
            where.append("p.weight_range = %s"); params.append(weight_range)
        if fabric_color:
            where.append("UPPER(BTRIM(p.fabric_color)) = UPPER(BTRIM(%s))"); params.append(fabric_color)
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        # Support-fabric scope: main excludes Lining/Interfacing, support keeps only them.
        where.append(_scope_sql(scope))

        # Cover columns aligned with the Fabric mix page, using IDENTICAL maths so the
        # two pages reconcile for the same scope/period:
        #   weeks of cover  = on-hand kg ÷ (consumption ÷ weeks-in-window),  weeks  = days/7
        #   months of cover = on-hand kg ÷ (consumption ÷ months-in-window), months = days/DAYS_PER_MONTH
        # Same location-scoped on-hand numerator and warehouse-wide net consumption
        # (effective-moves view) the mix page uses; `days` is the selected consumption
        # period (30/90/180/365). Cover is NULL when there was no consumption in the
        # window (matches the mix page's c>0 guard) — shown as "—".
        # `resv` = sum of OPEN (active) buying-team reservations, in kg, per fabric.
        rows = q(conn, f"""
            WITH cons_win AS (
              SELECT m.product_id, SUM({_net_kg('m')}) as consumed_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
                AND m.date >= NOW() - INTERVAL '{days} days'
              GROUP BY m.product_id
            ), resv AS (
              SELECT product_id, SUM(qty_kg) as reserved_kg
              FROM fabric_reservations
              WHERE status='active'
              GROUP BY product_id
            )
            SELECT 
              p.id, p.name, p.default_code, p.barcode, p.fabric_category, p.fabric_subcategory,
              p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
              p.width_m, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.fiber_content, p.fabric_type,
              p.supplier, p.primary_color, INITCAP(BTRIM(p.fabric_color)) as fabric_color,
              NULLIF(INITCAP(BTRIM(p.color)),'') as color,
              p.standard_price, p.uom,
              ROUND(p.standard_price::numeric,2) as cost_kes,
              ROUND(p.standard_price::numeric,2) as cost_per_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*p.kg_per_mtr_eff ELSE NULL END::numeric,2) as cost_metre,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN 1.0/p.kg_per_mtr_eff ELSE NULL END::numeric,3) as m_per_kg,
              ROUND(i.quantity::numeric,2) as qty_kg,
              ROUND(i.reserved_qty::numeric,2) as reserved_kg,
              ROUND(i.available::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.available/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as weeks_cover,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as months_cover,
              ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as team_reserved_metres,
              (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as last_move,
              CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as days_since_move
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN cons_win c ON c.product_id = i.product_id
            LEFT JOIN resv rv ON rv.product_id = i.product_id
            WHERE {' AND '.join(where)}
            {order_by}
            LIMIT %s OFFSET %s
        """, params + [limit, offset])

        total = q(conn, f"""
            SELECT COUNT(*) as n FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {' AND '.join(where)}
        """, params)[0]['n']

        return {"total": total, "items": rows}

# ── Ageing ──────────────────────────────────────────────────
@fabric_router.get("/api/fabric/ageing")
def ageing(location: str = Query(default="RMAT/Stock"),
           scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        return q(conn, f"""
            SELECT 
              CASE 
                WHEN days_since <= 90  THEN '0-3 months'
                WHEN days_since <= 180 THEN '3-6 months'
                WHEN days_since <= 365 THEN '6-12 months'
                ELSE '12+ months'
              END as age_band,
              CASE 
                WHEN days_since <= 90  THEN 1
                WHEN days_since <= 180 THEN 2
                WHEN days_since <= 365 THEN 3
                ELSE 4
              END as sort_order,
              COUNT(DISTINCT product_id) as fabrics,
              ROUND(SUM(qty_kg)::numeric,1) as qty_kg,
              ROUND(SUM(qty_metres)::numeric,0) as qty_metres,
              ROUND(SUM(value_kes)::numeric,0) as value_kes
            FROM (
              SELECT 
                i.product_id,
                i.quantity as qty_kg,
                CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END as qty_metres,
                i.total_value as value_kes,
                COALESCE(
                  CURRENT_DATE - MAX(m.date::date),
                  999
                ) as days_since
              FROM raw_fabric_inventory i
              JOIN raw_fabric_products p ON p.id = i.product_id
              LEFT JOIN raw_fabric_moves m ON m.product_id = i.product_id
              WHERE i.quantity > 0 {loc_sql}
                AND {_scope_sql(scope)}
              GROUP BY i.product_id, i.quantity, p.kg_per_mtr_eff, i.total_value
            ) sub
            GROUP BY age_band, sort_order
            ORDER BY sort_order
        """, loc_params)

# ── Consumption over time ───────────────────────────────────
@fabric_router.get("/api/fabric/consumption")
def consumption(
    since: str = Query(default="2026-01-01"),
    until: str = Query(default="2099-12-31"),
    group_by: str = Query(default="month"),
    scope: str = Query(default="main"),
):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        kg_expr = _net_kg("m")  # net of returns: +OUT, −production returns
        mtr_expr = f"CASE WHEN p.kg_per_mtr_eff>0 THEN ({kg_expr})/p.kg_per_mtr_eff ELSE 0 END"
        base_where = (f"{_net_cons_where('m')} "
                      f"AND {_scope_sql(scope)} "
                      "AND m.date BETWEEN %s AND %s")
        metrics = (f"COUNT(DISTINCT m.product_id) FILTER (WHERE {_consume_pred('m')}) as fabrics_used, "
                   f"ROUND(SUM({kg_expr})::numeric,1) as qty_kg, "
                   f"ROUND(SUM({mtr_expr})::numeric,0) as qty_metres, "
                   f"COUNT(*) FILTER (WHERE {_consume_pred('m')}) as moves")
        # Dimension breakdowns (by fabric category or individual fabric) vs.
        # the default time-series (day/week/month).
        if group_by in ("category", "fabric"):
            dim = ("COALESCE(NULLIF(p.fabric_category,''),'Unknown')"
                   if group_by == "category"
                   else "COALESCE(NULLIF(m.product_name,''),'Unknown')")
            limit = "" if group_by == "category" else "LIMIT 50"
            return q(conn, f"""
                SELECT {dim} as period, {metrics}
                FROM {EFFECTIVE_MOVES} m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {base_where}
                GROUP BY 1 ORDER BY qty_kg DESC NULLS LAST {limit}
            """, (since, until))
        trunc = {"day": "day", "week": "week"}.get(group_by, "month")
        return q(conn, f"""
            SELECT DATE_TRUNC('{trunc}', m.date)::date as period, {metrics}
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {base_where}
            GROUP BY 1 ORDER BY 1
        """, (since, until))

# ── Consumption sources: today's move-level audit CSV ───────
@fabric_router.get("/api/fabric/consumption-sources.csv")
def consumption_sources_csv(scope: str = Query(default="main")):
    """Flat, move-level list of TODAY's rows that make up the net "Consumed today"
    KPI — one row per move — so a user can audit exactly what the figure is built
    from. Uses the EXACT SAME predicates as the KPI (`_net_cons_where` + `_net_kg`)
    and honours the same main/support `scope`, so the signed net kg column sums to
    the value shown on the card. Positive = consumption (OUT to production or
    RMAT→Samp sampling), negative = a netted return (Production→stock, Samp→stock)."""
    import csv, io
    from fastapi.responses import Response
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        rows = q(conn, f"""
            SELECT m.date::date as move_date,
                   COALESCE(NULLIF(m.product_name,''), NULLIF(p.name,''), '(unknown)') as fabric,
                   COALESCE(NULLIF(m.product_sku,''), NULLIF(p.default_code,''), '') as sku,
                   m.location_from as from_loc,
                   m.location_to as to_loc,
                   m.move_type as move_type,
                   ROUND(({_net_kg('m')})::numeric,3) as net_kg,
                   ROUND((CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as net_metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date >= CURRENT_DATE
            ORDER BY fabric, m.location_from, m.location_to
        """)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Fabric", "SKU", "From location", "To location",
                "Move type", "Net kg", "Net metres"])
    for r in rows:
        w.writerow([r["move_date"], r["fabric"], r["sku"], r["from_loc"],
                    r["to_loc"], r["move_type"], r["net_kg"], r["net_metres"]])
    scope_tag = "support" if str(scope or "").lower() == "support" else "main"
    fname = f"consumption-sources-today-{scope_tag}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )

# ── Stock vs consumption by category/subcategory ────────────
@fabric_router.get("/api/fabric/category-stock-consumption")
def category_stock_consumption(
    location: str = Query(default="RMAT/Stock"),
    days: int = Query(default=30),
    scope: str = Query(default="main"),
):
    """Nested category→subcategory stock (location-scoped) vs net consumption
    (warehouse-wide, trailing N days). Derived %s / cover / SOR / variance / risk
    are computed client-side from these raw kg figures + the returned totals."""
    days = max(1, min(int(days or 30), 730))
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        loc_sql, loc_params = _loc_filter(location)
        stock = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   ROUND(SUM(i.quantity)::numeric,1) as stock_kg
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2
        """, loc_params)
        cons = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   ROUND(SUM({_net_kg('m')})::numeric,1) as consumed_kg
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date >= NOW() - (%s || ' days')::interval
            GROUP BY 1, 2
        """, (days,))

        cats = {}
        def _cat(name):
            return cats.setdefault(name, {"category": name, "stock_kg": 0.0,
                                          "consumed_kg": 0.0, "_subs": {}})
        def _sub(cat, name):
            c = _cat(cat)
            return c["_subs"].setdefault(name, {"subcategory": name,
                                                "stock_kg": 0.0, "consumed_kg": 0.0})
        for r in stock:
            v = float(r["stock_kg"] or 0)
            _cat(r["category"])["stock_kg"] += v
            _sub(r["category"], r["subcategory"])["stock_kg"] += v
        for r in cons:
            v = float(r["consumed_kg"] or 0)
            _cat(r["category"])["consumed_kg"] += v
            _sub(r["category"], r["subcategory"])["consumed_kg"] += v

        out = []
        for c in cats.values():
            subs = sorted(c.pop("_subs").values(),
                          key=lambda s: s["consumed_kg"], reverse=True)
            c["stock_kg"] = round(c["stock_kg"], 1)
            c["consumed_kg"] = round(c["consumed_kg"], 1)
            c["subcategories"] = subs
            out.append(c)
        out.sort(key=lambda c: c["consumed_kg"], reverse=True)

        return {
            "days": days,
            "total_stock_kg": round(sum(c["stock_kg"] for c in out), 1),
            "total_consumed_kg": round(sum(c["consumed_kg"] for c in out), 1),
            "categories": out,
        }

# ── Fabric mix (consumption share vs stock share) ───────────
# A group is "idle" when it holds available stock but recorded ~zero net
# consumption over the window. Use the canonical kg figure (no metres-conversion
# gap) so a fabric consumed only in unconvertible kg is never mislabelled idle.
IDLE_KG_EPS = 0.1

def _parse_date_range(date_from: str, date_to: str):
    """Return (date, date) for a valid YYYY-MM-DD from/to pair (swapped if
    reversed), else (None, None). strptime both validates and sanitises, so the
    values are safe to pass as query parameters."""
    try:
        f = datetime.datetime.strptime((date_from or "").strip(), "%Y-%m-%d").date()
        t = datetime.datetime.strptime((date_to or "").strip(), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None, None
    return (f, t) if f <= t else (t, f)


@fabric_router.get("/api/fabric/mix")
def fabric_mix(
    group_by: str = Query(default="category"),
    days: int = Query(default=90),
    location: str = Query(default="RMAT/Stock"),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
    scope: str = Query(default="main"),
):
    """The fabric equivalent of the BI app's Stock Mix: compare each fabric
    category's (or sub-category's) share of CONSUMPTION against its share of
    AVAILABLE stock, and flag short / overstocked / idle groups.

    Available stock is location-scoped (default RMAT/Stock); net consumption is
    warehouse-wide and ALWAYS reads through the effective-moves view so the
    Jan–Apr 2026 Odoo correction applies. The consumption window is either the
    trailing `days` preset OR an explicit `date_from`/`date_to` range (the custom
    range, when both are valid, wins and resets `days`/`months` to its span).
    Metres are derived per fabric via its kg-per-metre; kg with no kg-per-metre
    cannot be converted, so each group carries the unconvertible kg (cons/avail)
    and a `metres_incomplete` flag instead of silently showing 0. Derived columns
    use metres (the spreadsheet's primary unit); the raw kg + metres figures +
    totals let the client re-derive everything for the Kg toggle.

    Gap (`gap_pp`) follows the house convention: % Available − % Consumption, so
    POSITIVE = overstock. `variance_pp` (% Consumption − % Available) is kept for
    backward compatibility only. When grouping by category each row carries a
    nested `subcategories` array (same fields) for in-place drill-down; the
    sub-rows' percentages share the grand totals so they stay comparable."""
    group_by = "subcategory" if str(group_by).lower().startswith("sub") else "category"
    win_from, win_to = _parse_date_range(date_from, date_to)
    if win_from and win_to:
        days = max(1, min((win_to - win_from).days + 1, 1825))
    else:
        days = max(1, min(int(days or 90), 730))
    months = days / DAYS_PER_MONTH
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # The per-product detail query (below) joins fabric_reservations, which is
        # created lazily — ensure it exists even on a fresh DB.
        _ensure_fabric_tables(conn)
        loc_sql, loc_params = _loc_filter(location)
        stock = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   i.product_id as product_id,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as product_name,
                   ROUND(SUM(i.quantity)::numeric,1) as available_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as available_metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN i.quantity ELSE 0 END)::numeric,1) as available_kg_nometre,
                   ROUND(SUM(i.total_value)::numeric,0) as tied_up_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category = 'Fabric' {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3, 4
        """, loc_params)
        net = _net_kg('m')
        kg = _kg('m')
        if win_from and win_to:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= %s AND m.date < (%s::date + 1)"
            cons_params = (win_from, win_to)
        else:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= NOW() - (%s || ' days')::interval"
            cons_params = (days,)
        # Net consumption = OUT − production returns. We also pull the raw OUT
        # ("sent to production") and the production-return credit separately so the
        # UI can explain a net figure that has been floored to 0 (a window-aligned
        # return can otherwise read as "negative usage").
        cons = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   m.product_id as product_id,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as product_name,
                   ROUND(SUM({net})::numeric,1) as consumption_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as consumption_metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN ({net}) ELSE 0 END)::numeric,1) as consumption_kg_nometre,
                   ROUND(SUM(CASE WHEN {_consume_pred('m')} THEN {kg} ELSE 0 END)::numeric,1) as out_kg,
                   ROUND(SUM(CASE WHEN ({_consume_pred('m')}) AND p.kg_per_mtr_eff>0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as out_metres,
                   ROUND(SUM(CASE WHEN {_rmat_return_pred('m')} THEN {kg} ELSE 0 END)::numeric,1) as return_kg,
                   ROUND(SUM(CASE WHEN ({_rmat_return_pred('m')}) AND p.kg_per_mtr_eff>0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as return_metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {cons_where}
            GROUP BY 1, 2, 3, 4
        """, cons_params)

        # Smoothed 6-month run-rate per group (for Weeks/Months of Cover). This is
        # deliberately INDEPENDENT of the selected consumption window so cover
        # reflects sustained usage rather than a short window where a single
        # return can zero out (or invert) net consumption. The run-rate mirrors
        # _months_of_cover (warehouse-wide) exactly — the trailing 6 fully
        # completed months, no current-month projection — and because every step
        # is a linear combination of the group's monthly net kg, the category
        # run-rates sum back to the warehouse-wide run-rate (so covers reconcile).
        rr_rows = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   m.product_id as product_id,
                   to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
                   SUM({net})::numeric as kg,
                   SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date
              AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
            GROUP BY 1, 2, 3, 4
        """)
        rr_cal = q(conn, """
            SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS yr,
                   EXTRACT(MONTH FROM CURRENT_DATE)::int AS mo
        """)[0]

        def _rr_key(delta):
            idx = rr_cal['yr'] * 12 + (rr_cal['mo'] - 1) + delta
            return f"{idx // 12:04d}-{idx % 12 + 1:02d}"
        rr_complete = [_rr_key(d) for d in range(-6, 0)]  # M-6 .. M-1 (completed)

        def _runrate(mon_map):
            """Trailing 6-fully-completed-months average monthly run-rate from a
            {YYYY-MM: value} map, matching _months_of_cover. No current-month
            projection."""
            return sum(mon_map.get(k, 0.0) for k in rr_complete) / 6.0

        def _node(name):
            return {"group": name, "consumption_kg": 0.0, "consumption_metres": 0.0,
                    "available_kg": 0.0, "available_metres": 0.0, "tied_up_kes": 0.0,
                    "_cons_kg_nometre": 0.0, "_avail_kg_nometre": 0.0,
                    "out_kg": 0.0, "out_metres": 0.0, "return_kg": 0.0, "return_metres": 0.0,
                    "_mon_kg": {}, "_mon_m": {}}
        cats = {}
        def _cat(name):
            return cats.setdefault(name, {"_node": _node(name), "_subs": {}})
        def _sub(cat, name):
            return _cat(cat)["_subs"].setdefault(name, {"_node": _node(name), "_prods": {}})
        def _prod(cat, sub, pid, name):
            prods = _sub(cat, sub)["_prods"]
            node = prods.get(pid)
            if node is None:
                node = _node(name)
                node["_pid"] = pid
                prods[pid] = node
            return node
        for r in cons:
            cv_kg = float(r["consumption_kg"] or 0)
            cv_m = float(r["consumption_metres"] or 0)
            cv_nm = float(r["consumption_kg_nometre"] or 0)
            o_kg = float(r["out_kg"] or 0)
            o_m = float(r["out_metres"] or 0)
            rt_kg = float(r["return_kg"] or 0)
            rt_m = float(r["return_metres"] or 0)
            for x in (_cat(r["category"])["_node"],
                      _sub(r["category"], r["subcategory"])["_node"],
                      _prod(r["category"], r["subcategory"], r["product_id"], r["product_name"])):
                x["consumption_kg"] += cv_kg
                x["consumption_metres"] += cv_m
                x["_cons_kg_nometre"] += cv_nm
                x["out_kg"] += o_kg
                x["out_metres"] += o_m
                x["return_kg"] += rt_kg
                x["return_metres"] += rt_m
        for r in stock:
            av_kg = float(r["available_kg"] or 0)
            av_m = float(r["available_metres"] or 0)
            av_nm = float(r["available_kg_nometre"] or 0)
            kes = float(r["tied_up_kes"] or 0)
            for x in (_cat(r["category"])["_node"],
                      _sub(r["category"], r["subcategory"])["_node"],
                      _prod(r["category"], r["subcategory"], r["product_id"], r["product_name"])):
                x["available_kg"] += av_kg
                x["available_metres"] += av_m
                x["tied_up_kes"] += kes
                x["_avail_kg_nometre"] += av_nm
        # Fold the 6-month monthly run-rate into the EXISTING tree nodes only — a
        # product that moved months ago but has no current stock and no usage in
        # the selected window must not spawn a phantom row, so we look nodes up
        # rather than creating them.
        for r in rr_rows:
            catw = cats.get(r["category"])
            if not catw:
                continue
            targets = [catw["_node"]]
            subw = catw["_subs"].get(r["subcategory"])
            if subw:
                targets.append(subw["_node"])
                prodn = subw["_prods"].get(r["product_id"])
                if prodn is not None:
                    targets.append(prodn)
            mon = r["mon"]
            m_kg = float(r["kg"] or 0)
            m_m = float(r["metres"] or 0)
            for t in targets:
                t["_mon_kg"][mon] = t["_mon_kg"].get(mon, 0.0) + m_kg
                t["_mon_m"][mon] = t["_mon_m"].get(mon, 0.0) + m_m

        cat_nodes = [c["_node"] for c in cats.values()]
        sub_nodes = [s["_node"] for c in cats.values() for s in c["_subs"].values()]
        # Consumption is floored at 0 per group (a window-aligned return can push
        # net negative), so the page Total is the sum of the FLOORED rows at the
        # level being displayed. Flooring is non-linear, so the floored-subcategory
        # sum ≠ the floored-category sum; we base the total (and the % denominator)
        # on the displayed level so the Total reconciles with the rows above it and
        # each level's shares add to 100%. Available/tied aren't floored, so they
        # sum identically at either level (computed from categories).
        cons_nodes = sub_nodes if group_by == "subcategory" else cat_nodes
        tot_cons_kg = sum(max(0.0, x["consumption_kg"]) for x in cons_nodes)
        tot_cons_m = sum(max(0.0, x["consumption_metres"]) for x in cons_nodes)
        tot_avail_kg = sum(x["available_kg"] for x in cat_nodes)
        tot_avail_m = sum(x["available_metres"] for x in cat_nodes)
        tot_kes = sum(x["tied_up_kes"] for x in cat_nodes)

        def _finalize(x):
            # Floor net consumption at 0 (negative = window-aligned production
            # return outran the OUT it cancels); keep the gross OUT + return credit
            # for the UI to explain a floored row.
            c = max(0.0, x["consumption_metres"])
            c_kg = max(0.0, x["consumption_kg"])
            a = x["available_metres"]
            pct_c = (c / tot_cons_m * 100) if tot_cons_m > 0 else 0.0
            pct_a = (a / tot_avail_m * 100) if tot_avail_m > 0 else 0.0
            gap = pct_a - pct_c
            shortfall = a - c
            # Weeks/Months of Cover use the smoothed 6-month run-rate (not the raw
            # selected window) so cover populates for rows with sustained usage.
            rr_m = _runrate(x["_mon_m"])
            rr_kg = _runrate(x["_mon_kg"])
            covers = (a / rr_m) if rr_m > 0 else None
            idle = (x["available_kg"] > 0 and abs(x["consumption_kg"]) <= IDLE_KG_EPS)
            status = "Shortage" if (shortfall < 0 or (covers is not None and covers < 1)) else "OK"
            return {
                "group": x["group"],
                "consumption_kg": round(c_kg, 1),
                "consumption_metres": round(c, 1),
                "available_kg": round(x["available_kg"], 1),
                "available_metres": round(a, 1),
                "out_kg": round(x["out_kg"], 1),
                "out_metres": round(x["out_metres"], 1),
                "return_kg": round(x["return_kg"], 1),
                "return_metres": round(x["return_metres"], 1),
                "runrate_monthly_kg": round(rr_kg, 3),
                "runrate_monthly_metres": round(rr_m, 3),
                "tied_up_kes": round(x["tied_up_kes"]),
                "pct_consumption": round(pct_c, 1),
                "pct_available": round(pct_a, 1),
                "gap_pp": round(gap, 1),
                "variance_pp": round(-gap, 1),
                "shortfall_metres": round(shortfall, 1),
                "monthly_covers": round(covers, 2) if covers is not None else None,
                "idle": idle,
                "status": status,
                "metres_incomplete": (x["_cons_kg_nometre"] > 0.05 or x["_avail_kg_nometre"] > 0.05),
                "cons_kg_nometre": round(x["_cons_kg_nometre"], 1),
                "avail_kg_nometre": round(x["_avail_kg_nometre"], 1),
            }

        # Per-product register detail (same data source/maths as the register page)
        # so each product drill-down row can open the shared fabric detail card.
        # Keyed by product_id; location-scoped + same consumption window as the
        # cover columns. m_per_kg (metres per kg) is the inverse of kg_per_mtr.
        pids = sorted({p["_pid"] for c in cats.values()
                       for s in c["_subs"].values()
                       for p in s["_prods"].values()
                       if p.get("_pid") is not None})
        det_by_pid = {}
        if pids:
            # Anchor on the product master (the ids already collected from the mix
            # tree) and LEFT JOIN the location-scoped inventory, so every product
            # in the tree gets a detail row (carrying default_code/name/identity)
            # even when it has no stock in the selected location — that is what
            # lets consumption-only / zero-stock rows still show a barcode. The
            # inventory is pre-aggregated per product within the location (inv CTE)
            # so multi-row products don't duplicate and no-row products yield NULL
            # metrics that degrade gracefully.
            det_rows = q(conn, f"""
                WITH cons_win AS (
                  SELECT m.product_id, SUM({_net_kg('m')}) as consumed_kg
                  FROM {EFFECTIVE_MOVES} m
                  WHERE {_net_cons_where('m')}
                    AND m.date >= NOW() - INTERVAL '{days} days'
                  GROUP BY m.product_id
                ), resv AS (
                  SELECT product_id, SUM(qty_kg) as reserved_kg
                  FROM fabric_reservations
                  WHERE status='active'
                  GROUP BY product_id
                ), inv AS (
                  SELECT i.product_id,
                         SUM(i.quantity) as quantity,
                         SUM(i.available) as available,
                         SUM(i.total_value) as total_value
                  FROM raw_fabric_inventory i
                  WHERE i.product_id = ANY(%s) {loc_sql}
                  GROUP BY i.product_id
                )
                SELECT
                  p.id, p.name, p.default_code, p.barcode, p.fabric_category, p.fabric_subcategory,
                  p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
                  p.width_m, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.fiber_content, p.fabric_type,
                  p.supplier, p.primary_color, p.source_city, p.source_country,
                  INITCAP(BTRIM(p.fabric_color)) as fabric_color,
                  NULLIF(INITCAP(BTRIM(p.color)),'') as color,
                  ROUND(p.standard_price::numeric,2) as cost_kes,
                  ROUND(p.standard_price::numeric,2) as cost_per_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*p.kg_per_mtr_eff ELSE NULL END::numeric,2) as cost_metre,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN 1.0/p.kg_per_mtr_eff ELSE NULL END::numeric,3) as m_per_kg,
                  ROUND(inv.quantity::numeric,2) as qty_kg,
                  ROUND(inv.available::numeric,2) as available_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN inv.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN inv.available/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres,
                  ROUND(inv.total_value::numeric,0) as value_kes,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as weeks_cover,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as months_cover,
                  ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as team_reserved_metres,
                  (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id) as last_move,
                  CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id) as days_since_move
                FROM raw_fabric_products p
                LEFT JOIN inv ON inv.product_id = p.id
                LEFT JOIN cons_win c ON c.product_id = p.id
                LEFT JOIN resv rv ON rv.product_id = p.id
                WHERE p.id = ANY(%s)
            """, [pids] + list(loc_params) + [pids])
            for dr in det_rows:
                if dr["id"] not in det_by_pid:
                    det_by_pid[dr["id"]] = dr

        def _finalize_sub(s):
            srow = _finalize(s["_node"])
            prods = []
            for p in s["_prods"].values():
                prow = _finalize(p)
                pid = p.get("_pid")
                prow["id"] = pid
                det = det_by_pid.get(pid)
                if det:
                    prow["default_code"] = det.get("default_code")
                    fc, pc = _derive_fabric_colors(det.get("name"), det.get("fabric_color"))
                    det["derived_fabric_color"] = fc
                    det["derived_primary_color"] = pc
                    prow["detail"] = det
                prods.append(prow)
            prods.sort(key=lambda r: r["consumption_metres"], reverse=True)
            srow["products"] = prods
            return srow

        if group_by == "subcategory":
            out = []
            for c in cats.values():
                cat_name = c["_node"]["group"]
                for s in c["_subs"].values():
                    srow = _finalize_sub(s)
                    srow["category"] = cat_name
                    out.append(srow)
            out.sort(key=lambda r: r["consumption_metres"], reverse=True)
        else:
            out = []
            for c in cats.values():
                row = _finalize(c["_node"])
                subs = [_finalize_sub(s) for s in c["_subs"].values()]
                subs.sort(key=lambda r: r["consumption_metres"], reverse=True)
                row["subcategories"] = subs
                out.append(row)
            out.sort(key=lambda r: r["consumption_metres"], reverse=True)
        return {
            "group_by": group_by,
            "days": days,
            "months": round(months, 2),
            "date_from": win_from.isoformat() if win_from else None,
            "date_to": win_to.isoformat() if win_to else None,
            "total_consumption_kg": round(tot_cons_kg, 1),
            "total_consumption_metres": round(tot_cons_m, 1),
            "total_available_kg": round(tot_avail_kg, 1),
            "total_available_metres": round(tot_avail_m, 1),
            "total_out_kg": round(sum(x["out_kg"] for x in cat_nodes), 1),
            "total_out_metres": round(sum(x["out_metres"] for x in cat_nodes), 1),
            "total_return_kg": round(sum(x["return_kg"] for x in cat_nodes), 1),
            "total_return_metres": round(sum(x["return_metres"] for x in cat_nodes), 1),
            "total_tied_up_kes": round(tot_kes),
            "rows": out,
        }

# ── Data quality: fabrics missing kg-per-metre ──────────────
@fabric_router.get("/api/fabric/data-quality/missing-kg-per-metre")
def missing_kg_per_metre(scope: str = Query(default="main")):
    """Every fabric product with NO usable kg-per-metre on the Odoo product master
    (kg_per_mtr missing or <= 0) that still has stock on hand OR recorded usage —
    i.e. real quantities that can only be shown in kg, never metres. Stock is the
    on-hand quantity across the two real fabric-stock locations; usage is net
    consumption (OUT − production returns) through the same effective-moves source
    every other fabric view uses, so the numbers reconcile. A `source` flag marks
    each row as stock-only / usage-only / both. Aggregate count + total
    unconvertible kg are returned so progress is visible as conversions get
    backfilled in Odoo."""
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # Stock across the two real fabric-stock locations (the "All" resolution).
        loc_sql, loc_params = _loc_filter("All")
        rows = q(conn, f"""
            WITH stock AS (
              SELECT i.product_id, SUM(i.quantity) AS stock_kg,
                     STRING_AGG(DISTINCT i.location_name, ', '
                                ORDER BY i.location_name) AS locations
              FROM raw_fabric_inventory i
              WHERE i.quantity > 0 {loc_sql}
              GROUP BY i.product_id
            ), usage AS (
              SELECT m.product_id, SUM({_net_kg('m')}) AS usage_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
              GROUP BY m.product_id
            ), last_loc AS (
              -- Last-known REAL stock location: the destination of the most recent
              -- move that landed in a recognised fabric-stock location. Used as a
              -- historical fallback for usage-only rows that have no current stock.
              SELECT DISTINCT ON (mm.product_id)
                     mm.product_id, mm.location_to AS last_known_location
              FROM raw_fabric_moves mm
              WHERE mm.location_to IN ({", ".join(["%s"] * len(_FABRIC_LOCATIONS))})
              ORDER BY mm.product_id, mm.date DESC NULLS LAST
            )
            SELECT
              p.id, p.default_code, p.name,
              COALESCE(NULLIF(p.fabric_category,''),'Unknown') AS fabric_category,
              COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') AS fabric_subcategory,
              p.supplier, p.width_m, p.gsm, p.fiber_content, p.kg_per_mtr_src,
              st.locations AS location,
              ll.last_known_location AS last_known_location,
              ROUND(COALESCE(st.stock_kg,0)::numeric,1) AS stock_kg,
              ROUND(GREATEST(COALESCE(us.usage_kg,0),0)::numeric,1) AS usage_kg,
              (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id) AS last_move
            FROM raw_fabric_products p
            LEFT JOIN stock st ON st.product_id = p.id
            LEFT JOIN usage us ON us.product_id = p.id
            LEFT JOIN last_loc ll ON ll.product_id = p.id
            WHERE p.kg_per_mtr_eff IS NULL
              AND {_scope_sql(scope)}
              AND (COALESCE(st.stock_kg,0) > 0 OR COALESCE(us.usage_kg,0) > 0.05)
        """, list(_FABRIC_LOCATIONS) + list(loc_params))

        tot_stock = 0.0
        tot_usage = 0.0
        for r in rows:
            sk = float(r["stock_kg"] or 0)
            uk = float(r["usage_kg"] or 0)
            tot_stock += sk
            tot_usage += uk
            if sk > 0 and uk > 0.05:
                r["source"] = "both"
            elif uk > 0.05:
                r["source"] = "usage"
            else:
                r["source"] = "stock"
            r["last_move"] = r["last_move"].isoformat() if r.get("last_move") else None
        # Most material gaps first (biggest unconvertible quantity).
        rows.sort(key=lambda r: (float(r["stock_kg"] or 0) + float(r["usage_kg"] or 0)),
                  reverse=True)
        return {
            "count": len(rows),
            "total_stock_kg": round(tot_stock, 1),
            "total_usage_kg": round(tot_usage, 1),
            "total_unconvertible_kg": round(tot_stock + tot_usage, 1),
            "items": rows,
        }

@fabric_router.get("/api/fabric/data-quality/unmatched-purchase-lines")
def unmatched_purchase_lines(scope: str = Query(default="main")):
    """Received, non-cancelled purchase-order lines whose product is NOT counted in
    the fabric metrics — either the product has no row in the fabric master, or the
    matched master product is not categorized as 'Fabric' (e.g. it is a Trim). The
    supplier totals and avg cost-per-metre only sum lines that JOIN the master with
    category='Fabric', so these lines' received quantity and value are silently
    dropped and never trigger the missing-kg/m warning. Grouped per (supplier,
    product) so a line received over several POs shows once; a `reason` flag marks
    each as 'not_in_master' vs 'not_fabric'. The fix is to correct the product's
    category / master record in Odoo, after which the value flows into the supplier
    figures automatically. Returns the rows plus an excluded line count and total
    KES so the size of the gap is visible."""
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT po.supplier AS supplier,
                   COALESCE(NULLIF(po.product_name,''), NULLIF(p.name,''), 'Unknown') AS name,
                   COALESCE(NULLIF(po.product_sku,''), p.default_code) AS sku,
                   ROUND(SUM(po.qty_received)::numeric,1) AS qty_kg,
                   ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) AS value_kes,
                   CASE WHEN p.id IS NULL THEN 'not_in_master' ELSE 'not_fabric' END AS reason
            FROM raw_fabric_purchase_orders po
            LEFT JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0
              AND (p.id IS NULL OR p.category <> 'Fabric')
              AND {_scope_sql(scope)}
            GROUP BY po.supplier, po.product_id, po.product_name, p.name,
                     po.product_sku, p.default_code,
                     (CASE WHEN p.id IS NULL THEN 'not_in_master' ELSE 'not_fabric' END)
            ORDER BY value_kes DESC NULLS LAST
        """)
        total_value = sum(float(r["value_kes"] or 0) for r in rows)
        return {
            "count": len(rows),
            "total_value_kes": round(total_value, 0),
            "items": rows,
        }

# ── Dead stock ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/dead-stock")
def dead_stock(scope: str = Query(default="main")):
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT 
              i.product_name, p.fabric_category, p.fabric_subcategory,
              p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.width_m, p.gsm, p.plain_print,
              ROUND(i.quantity::numeric,1) as qty_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              MAX(m.date)::date as last_move,
              CURRENT_DATE - MAX(m.date)::date as days_since_move
            FROM raw_fabric_inventory i
            LEFT JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN raw_fabric_moves m ON m.product_id = i.product_id
            WHERE i.location_name = 'Dead/Stock Fabric' AND i.quantity > 0
              AND {_scope_sql(scope)}
            GROUP BY i.product_name, p.fabric_category, p.fabric_subcategory,
                     p.kg_per_mtr_eff, p.kg_per_mtr_src, p.width_m, p.gsm, p.plain_print,
                     i.quantity, i.total_value
            ORDER BY i.total_value DESC
        """)
        total_value = sum(r['value_kes'] or 0 for r in rows)
        return {"total_value": total_value, "items": rows}

# ── Purchase orders ─────────────────────────────────────────
@fabric_router.get("/api/fabric/purchase-orders")
def purchase_orders(supplier: str = Query(default=None), month: str = Query(default=None), scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = f"p.category = 'Fabric' AND {_scope_sql(scope)}"
        params = []
        if supplier:
            where += " AND po.supplier ILIKE %s"; params.append(f"%{supplier}%")
        if month:
            where += " AND DATE_TRUNC('month', po.order_date)::date = %s"; params.append(month)
        return q(conn, f"""
            SELECT po.po_name, po.supplier, po.order_date, po.state,
              COUNT(*) as lines,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM(po.qty_ordered)::numeric,2) as qty_ordered,
              ROUND(SUM(po.qty_received)::numeric,2) as qty_received,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,2) as outstanding
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE {where}
            GROUP BY po.po_name, po.supplier, po.order_date, po.state
            ORDER BY po.order_date DESC
        """, params)

# ── BOM lookup ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/bom")
def bom_lookup(sku: str = Query(default=None), style: str = Query(default=None),
               scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = "1=1"
        params = []
        if sku:
            where = "b.finished_product_sku ILIKE %s"; params.append(f"%{sku}%")
        elif style:
            where = "b.finished_product_name ILIKE %s"; params.append(f"%{style}%")
        return q(conn, f"""
            SELECT b.finished_product_name, b.finished_product_sku,
              b.component_name, b.component_qty, b.component_uom,
              p.fabric_category, p.fabric_subcategory, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src,
              i.quantity as stock_kg,
              CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END as stock_metres,
              i.location_name
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            LEFT JOIN raw_fabric_inventory i ON i.product_id = b.component_id AND i.quantity > 0
            WHERE {where}
              AND {_scope_sql(scope)}
            ORDER BY b.finished_product_name, b.component_name
        """, params)

# ── Attribute split (plain/print, weight, structure) ────────
@fabric_router.get("/api/fabric/attribute-split")
def attribute_split(location: str = Query(default="RMAT/Stock"), scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        def split(col):
            return q(conn, f"""
                SELECT COALESCE(NULLIF(p.{col},''),'Unknown') as value,
                  COUNT(DISTINCT i.product_id) as fabrics,
                  ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
                  ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
                  ROUND(SUM(i.total_value)::numeric,0) as value_kes
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 {loc_sql}
                  AND {_scope_sql(scope)}
                GROUP BY 1
                ORDER BY value_kes DESC NULLS LAST
            """, loc_params)
        # Solid vs Print: the Odoo `plain_print` attribute is blank for the vast
        # majority of fabrics, so trusting it alone collapses ~94% into "Unknown".
        # Instead DERIVE the split: an explicit "Print" tag OR a name that clearly
        # signals a print (PRINT/AOP/FLORAL/STRIPE/ANKARA/etc.) → Print; an explicit
        # "Plain" tag OR otherwise genuine fabric (it carries a fabric_category) →
        # Solid; only rows with no category and no print signal (indeterminate junk
        # e.g. "ASSORTED FABRIC RETURNS/DEFECTS") remain a small "Unknown" residual.
        def split_plain_print():
            return q(conn, f"""
                SELECT CASE
                    WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'Print'
                    WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'Print'
                    WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'Solid'
                    WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'Solid'
                    ELSE 'Unknown'
                  END as value,
                  COUNT(DISTINCT i.product_id) as fabrics,
                  ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
                  ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
                  ROUND(SUM(i.total_value)::numeric,0) as value_kes
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 {loc_sql}
                  AND {_scope_sql(scope)}
                GROUP BY 1
                ORDER BY value_kes DESC NULLS LAST
            """, loc_params)
        # Fiber content: many rows blank — keep only fabrics that declare a fiber,
        # rolled up to the top values by stock value.
        fiber = q(conn, f"""
            SELECT p.fiber_content as value,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
              AND p.fiber_content IS NOT NULL AND p.fiber_content <> ''
            GROUP BY 1
            ORDER BY value_kes DESC NULLS LAST
            LIMIT 8
        """, loc_params)
        return {
            "plain_print": split_plain_print(),
            "weight_range": split("weight_range"),
            "structure": split("fabric_structure"),
            "fiber": fiber,
        }

# ── Solid vs Print: downloadable .xlsx calculations report ──────────────
# The full audit trail behind the "Solid vs Print" donut: every fabric product
# that contributes, its derived classification (Solid/Print/Unknown), WHICH rule
# matched it, its on-hand kg, the kg→metre conversion applied, its derived metres
# and KES value. The classification CASE + filters (i.quantity > 0, location,
# scope) MUST mirror attribute_split's split_plain_print EXACTLY so the workbook
# reconciles to the donut. The Summary sheet reuses the SAME single-aggregate
# GROUP BY query the donut is fed, so its totals are guaranteed identical.
@fabric_router.get("/api/fabric/solid-vs-print.xlsx")
def solid_vs_print_xlsx(location: str = Query(default="RMAT/Stock"),
                        scope: str = Query(default="main")):
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    # The exact classification CASE from attribute_split.split_plain_print — kept
    # verbatim so the workbook reconciles to the donut.
    CLASS_CASE = """CASE
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'Print'
        WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'Print'
        WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'Solid'
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'Solid'
        ELSE 'Unknown'
      END"""
    # The matching rule that fired, in the SAME priority order, for the audit trail.
    RULE_CASE = """CASE
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'plain_print=print'
        WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'name matched print regex'
        WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'has fabric_category'
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'plain_print=plain'
        ELSE 'fell through -> Unknown'
      END"""

    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        # Summary — the SAME aggregated query the donut is fed (split_plain_print).
        summary = q(conn, f"""
            SELECT {CLASS_CASE} as value,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1
            ORDER BY value_kes DESC NULLS LAST
        """, loc_params)

        # Detail — one row per contributing fabric product, with its rule.
        detail = q(conn, f"""
            SELECT i.product_id,
              p.name, p.default_code AS sku, p.supplier,
              p.plain_print, p.fabric_category, p.kg_per_mtr_eff,
              {CLASS_CASE} as classification,
              {RULE_CASE} as rule,
              ROUND(SUM(i.quantity)::numeric,2) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY i.product_id, p.name, p.default_code, p.supplier,
                     p.plain_print, p.fabric_category, p.kg_per_mtr_eff,
                     {CLASS_CASE}, {RULE_CASE}
            ORDER BY value_kes DESC NULLS LAST
        """, loc_params)

    # Grand totals (reconcile to the donut centre / legend).
    tot_kg = sum(float(r["qty_kg"] or 0) for r in summary)
    tot_metres = sum(float(r["qty_metres"] or 0) for r in summary)
    tot_value = sum(float(r["value_kes"] or 0) for r in summary)
    tot_fabrics = sum(int(r["fabrics"] or 0) for r in summary)

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    LINK = Font(color="1A5C38", underline="single")

    def _style_header(ws, ncols, row=1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    _loc_label = (location or "").strip() or "All fabric stock"
    _scope_label = "Support fabrics" if str(scope or "").lower() == "support" else "Main fabrics"

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Solid vs Print — calculations report"
    ws["A1"].font = TITLE
    ws["A2"] = "Location: %s    Scope: %s" % (_loc_label, _scope_label)
    sum_cols = ["Classification", "Fabrics", "Total kg", "Total metres",
                "Value (KES)", "% of value", "% of metres (chart)"]
    ws.append([])  # spacer row 3
    ws.append(sum_cols)  # header on row 4
    _style_header(ws, len(sum_cols), row=4)
    for r in summary:
        val = float(r["value_kes"] or 0)
        met = float(r["qty_metres"] or 0)
        ws.append([
            r["value"], int(r["fabrics"] or 0),
            float(r["qty_kg"] or 0), met, val,
            round(val / tot_value * 100, 1) if tot_value else 0.0,
            round(met / tot_metres * 100, 1) if tot_metres else 0.0,
        ])
    grand = ws.max_row + 1
    ws.append(["Grand total", tot_fabrics, round(tot_kg, 0),
               round(tot_metres, 0), round(tot_value, 0),
               100.0 if tot_value else 0.0,
               100.0 if tot_metres else 0.0])
    for c in range(1, len(sum_cols) + 1):
        ws.cell(row=grand, column=c).font = LBL
    ws.append([])
    note = ws.max_row + 1
    ws.cell(row=note, column=1,
            value="Reconciliation: Value (KES) grand total matches the figure "
                  "in the donut centre; '% of metres (chart)' matches the "
                  "donut legend percentages.").font = LBL
    for col, w in zip("ABCDEFG", [22, 10, 14, 16, 16, 12, 18]):
        ws.column_dimensions[col].width = w

    # Detail sheet — one row per contributing fabric product
    ws2 = wb.create_sheet("Detail")
    det_cols = ["Fabric name", "Fabric SKU", "Supplier", "Classification",
                "Rule matched", "plain_print", "fabric_category",
                "On-hand kg", "Kg per metre", "Derived metres", "Value (KES)",
                "Open in Odoo"]
    ws2.append(det_cols)
    _style_header(ws2, len(det_cols))
    if not detail:
        ws2.append(["No contributing fabric for this location / scope."])
    for r in detail:
        kpm = r["kg_per_mtr_eff"]
        ws2.append([
            r["name"], r["sku"], r["supplier"], r["classification"], r["rule"],
            r["plain_print"], r["fabric_category"],
            float(r["qty_kg"] or 0),
            (round(float(kpm), 4) if kpm and float(kpm) > 0 else None),
            float(r["qty_metres"] or 0),
            float(r["value_kes"] or 0),
            None,
        ])
        url = _odoo_product_url(r["product_id"])
        if url:
            cell = ws2.cell(row=ws2.max_row, column=len(det_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEFGHIJKL",
                      [40, 18, 22, 14, 26, 12, 18, 12, 14, 14, 14, 14]):
        ws2.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="solid-vs-print-calculations.xlsx"'},
    )

# ── Fabric base by primary colour ──────────────────────────
@fabric_router.get("/api/fabric/color-mix")
def color_mix(
    location: str = Query(default="RMAT/Stock"),
    days: int = Query(default=90),
    scope: str = Query(default="main"),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
):
    """Fabric base broken down by PRIMARY COLOUR for the merged Overview table:
    per colour, ON-HAND stock (location-scoped, same basis as the
    attribute-split / Stock-on-hand KPI — category='Fabric'), net CONSUMPTION
    over a FIXED trailing 30-day window (warehouse-wide via the effective-moves
    view), and MONTHLY COVERS (stock metres ÷ 30-day consumption metres).

    The consumption window is fixed at the trailing 30 days and DOES NOT follow
    the page's `days`/`date_from`/`date_to` consumption filter (those params are
    accepted for backward compatibility but no longer scope this view), so the
    merged covers figure always reflects a one-month run-rate.

    The primary colour is DERIVED in Python via the Vivo Colour Directory 2025
    (`_derive_fabric_colors`) — the DB `primary_color` column is empty — so we
    aggregate raw per-product kg/metres in SQL, then bucket by derived colour.
    Metres come from each fabric's kg-per-metre; kg that can't be converted are
    carried per panel as `*_kg_nometre` + a `*_metres_incomplete` flag rather
    than silently showing 0 (same convention as the Stock Mix blocks). Colours
    are sorted by on-hand metres descending; unresolved colours bucket to
    'Unknown'. Colours with stock but ~no 30-day consumption return
    `covers_months: null` (rendered as "no usage / ∞") rather than a misleading
    huge number or 0."""
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        # On-hand stock per product (Fabric only, location-scoped) — same basis as
        # the Stock-on-hand KPI so the panel totals reconcile with the page.
        stock = q(conn, f"""
            SELECT i.product_id as product_id,
                   COALESCE(NULLIF(p.name,''),'') as name,
                   COALESCE(NULLIF(p.fabric_color,''),'') as fabric_color,
                   ROUND(SUM(i.quantity)::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN i.quantity ELSE 0 END)::numeric,1) as kg_nometre
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category = 'Fabric' {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3
        """, loc_params)
        net = _net_kg('m')
        # Consumption is FIXED at the trailing 30 days for the merged covers view —
        # it deliberately ignores the page's days/date_from/date_to filter so the
        # one-month run-rate (and therefore Monthly Covers) is stable.
        cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= NOW() - interval '30 days'"
        cons = q(conn, f"""
            SELECT m.product_id as product_id,
                   COALESCE(NULLIF(p.name,''),'') as name,
                   COALESCE(NULLIF(p.fabric_color,''),'') as fabric_color,
                   ROUND(SUM({net})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN ({net}) ELSE 0 END)::numeric,1) as kg_nometre
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {cons_where}
            GROUP BY 1, 2, 3
        """, None)

        buckets = {}
        def _b(color):
            return buckets.setdefault(color, {
                "color": color,
                "stock_kg": 0.0, "stock_metres": 0.0, "stock_kg_nometre": 0.0,
                "cons_kg": 0.0, "cons_metres": 0.0, "cons_kg_nometre": 0.0,
            })
        for r in stock:
            _, primary = _derive_fabric_colors(r["name"], r["fabric_color"])
            b = _b(primary or "Unknown")
            b["stock_kg"] += float(r["kg"] or 0)
            b["stock_metres"] += float(r["metres"] or 0)
            b["stock_kg_nometre"] += float(r["kg_nometre"] or 0)
        for r in cons:
            _, primary = _derive_fabric_colors(r["name"], r["fabric_color"])
            b = _b(primary or "Unknown")
            b["cons_kg"] += float(r["kg"] or 0)
            b["cons_metres"] += float(r["metres"] or 0)
            b["cons_kg_nometre"] += float(r["kg_nometre"] or 0)

        rows = []
        for b in buckets.values():
            stock_m = round(b["stock_metres"], 1)
            cons_m = round(b["cons_metres"], 1)
            # Monthly Covers = on-hand stock metres ÷ 30-day consumption metres
            # (30 days ≈ one month). Colours with stock but ~no consumption in the
            # window get a null sentinel so the frontend can show "no usage / ∞"
            # instead of a divide-by-zero or a misleading huge number.
            covers_months = round(stock_m / cons_m, 1) if cons_m > 0.05 else None
            rows.append({
                "color": b["color"],
                "stock_kg": round(b["stock_kg"], 1),
                "stock_metres": stock_m,
                "stock_metres_incomplete": b["stock_kg_nometre"] > 0.05,
                "cons_kg": round(b["cons_kg"], 1),
                "cons_metres": cons_m,
                "cons_metres_incomplete": b["cons_kg_nometre"] > 0.05,
                "covers_months": covers_months,
            })
        # Sort by on-hand metres desc; colours with stock only in kg (no metres)
        # fall back to kg so they don't all pile at the bottom in metre order.
        rows.sort(key=lambda x: (x["stock_metres"], x["stock_kg"]), reverse=True)
        return {
            "days": days,
            "rows": rows,
            "total_stock_kg": round(sum(r["stock_kg"] for r in rows), 1),
            "total_stock_metres": round(sum(r["stock_metres"] for r in rows), 1),
            "total_cons_kg": round(sum(r["cons_kg"] for r in rows), 1),
            "total_cons_metres": round(sum(r["cons_metres"] for r in rows), 1),
        }

# ── Top consumed fabrics (what's actually moving out) ───────
@fabric_router.get("/api/fabric/top-consumed")
def top_consumed(days: int = Query(default=90), limit: int = Query(default=20), scope: str = Query(default="main")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # weeks_cover uses the average monthly run-rate: total net consumption over
        # the window ÷ number of months in the window = monthly average, converted
        # to a weekly rate (÷ weeks/month), then stock ÷ weekly rate.
        # product_id IS NOT NULL drops sheet rows whose barcode didn't match a
        # product master — this is a per-fabric view that needs a product identity.
        return q(conn, f"""
            WITH out_moves AS (
              SELECT m.product_id,
                MAX(m.product_name) FILTER (WHERE {_consume_pred('m')}) as product_name,
                SUM({_net_kg('m')}) as consumed_kg,
                COUNT(*) FILTER (WHERE {_consume_pred('m')}) as moves,
                MAX(m.date) FILTER (WHERE {_consume_pred('m')})::date as last_out
              FROM {EFFECTIVE_MOVES} m
              LEFT JOIN raw_fabric_products p ON p.id = m.product_id
              WHERE {_net_cons_where('m')}
                AND {_scope_sql(scope)}
                AND m.product_id IS NOT NULL
                AND m.date >= NOW() - (%s || ' days')::interval
              GROUP BY m.product_id
              HAVING SUM({_net_kg('m')}) > 0
            ), stock AS (
              SELECT product_id, SUM(quantity) as qty_kg
              FROM raw_fabric_inventory WHERE quantity>0 GROUP BY 1
            )
            SELECT o.product_name,
              ROUND(o.consumed_kg::numeric,1) as consumed_kg,
              o.moves, o.last_out,
              ROUND(COALESCE(s.qty_kg,0)::numeric,1) as stock_kg,
              ROUND((COALESCE(s.qty_kg,0) / NULLIF(
                (o.consumed_kg / ((%s)::numeric/{DAYS_PER_MONTH})) / {WEEKS_PER_MONTH}, 0))::numeric,1) as weeks_cover
            FROM out_moves o
            LEFT JOIN stock s ON s.product_id = o.product_id
            ORDER BY o.consumed_kg DESC
            LIMIT %s
        """, (days, days, limit))

# ── Movement flow (IN / OUT / INTERNAL by month) ────────────
@fabric_router.get("/api/fabric/movement-flow")
def movement_flow(months: int = Query(default=6), scope: str = Query(default="main")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        return q(conn, f"""
            SELECT DATE_TRUNC('month', m.date)::date as period,
              ROUND(SUM(CASE WHEN m.move_type='IN'       THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as in_kg,
              ROUND(SUM(CASE WHEN m.move_type='OUT'      THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as out_kg,
              ROUND(SUM(CASE WHEN m.move_type='INTERNAL' THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as internal_kg
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE m.is_fabric AND m.uom IN ('g','kg')
              AND {_scope_sql(scope)}
              AND m.date >= DATE_TRUNC('month', NOW() - (%s || ' months')::interval)
            GROUP BY 1 ORDER BY 1
        """, (months,))

# ── Trend Analysis builder (multi-panel KPI-over-time, METRES only) ──────────
# Backs the Fabric dashboard's "Trend Analysis" tab. ONE endpoint returns a time
# series for a chosen KPI at a chosen granularity (day/week/month), date range and
# scope (Overall / fabric category / sub-category / specific fabric / location).
# EVERY KPI is reported in METRES (never kg) via the established kg_per_mtr_eff
# conversion, and surfaces an `incomplete` flag where a fabric has no usable
# Kg/Mtr (NULL/<=0) — the same "incomplete, never silently dropped" convention
# used elsewhere in this module.
_TREND_KPIS = {
    "consumption", "net_consumption", "received",
    "stock_on_hand", "returns", "metres_per_garment",
}
_TREND_TRUNC = {"day": "day", "week": "week", "month": "month"}

def _trend_prod_scope(category, subcategory, product_id):
    """Product-attribute WHERE fragment (for the `p` = raw_fabric_products alias)
    + params, narrowing to a fabric category / sub-category / specific fabric.
    Mutually exclusive in priority product_id > subcategory > category."""
    sql, params = "", []
    pid = None
    if product_id not in (None, "", "0"):
        try:
            pid = int(product_id)
        except (TypeError, ValueError):
            pid = None
    if pid is not None:
        sql += " AND p.id = %s"; params.append(pid)
    elif subcategory:
        sql += " AND p.fabric_subcategory = %s"; params.append(subcategory)
        if category:
            sql += " AND p.fabric_category = %s"; params.append(category)
    elif category:
        sql += " AND p.fabric_category = %s"; params.append(category)
    return sql, params

def _trend_move_loc(location):
    """Location scope for MOVE-based KPIs: a move "touches" a location when it is
    either side of the transfer (location_from OR location_to)."""
    loc = (location or "").strip()
    if loc and loc.lower() not in _ALL_LOC:
        return " AND (m.location_from = %s OR m.location_to = %s)", [loc, loc]
    return "", []

def _trend_inv_loc(location):
    """Location scope for the INVENTORY snapshot (stock on hand). Honours ANY
    selected location; "All"/empty falls back to the two real fabric-stock
    locations (RMAT/Stock + Dead/Stock Fabric)."""
    loc = (location or "").strip()
    if loc and loc.lower() not in _ALL_LOC:
        return " AND i.location_name = %s", [loc]
    ph = ", ".join(["%s"] * len(_FABRIC_LOCATIONS))
    return f" AND i.location_name IN ({ph})", list(_FABRIC_LOCATIONS)

def _trend_move_series(conn, trunc, where_pred, value_expr,
                       scope_sql, scope_params, loc_sql, loc_params, since, until):
    """Bucketed metres series for a move-based KPI. `value_expr` is the per-row
    metres expression; `where_pred` selects the KPI's rows. The support-fabric
    'main' scope is always applied (this tab replaces the old main movement page)."""
    sql = f"""
        SELECT DATE_TRUNC('{trunc}', m.date)::date AS period,
               ROUND(COALESCE(SUM({value_expr}), 0)::numeric, 1) AS value,
               BOOL_OR(p.kg_per_mtr_eff IS NULL OR p.kg_per_mtr_eff <= 0) AS incomplete
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE ({where_pred})
          AND {_scope_sql('main')}
          {scope_sql}{loc_sql}
          AND m.date::date BETWEEN %s AND %s
        GROUP BY 1 ORDER BY 1
    """
    return q(conn, sql, list(scope_params) + list(loc_params) + [since, until])

def _trend_norm(rows):
    """Normalize SQL rows → JSON-friendly {period,value,incomplete}."""
    out = []
    for r in rows:
        p = r["period"]
        out.append({
            "period": p.isoformat() if hasattr(p, "isoformat") else str(p),
            "value": float(r["value"] or 0),
            "incomplete": bool(r["incomplete"]),
        })
    return out

def _bucket_start(d, trunc):
    if trunc == "month":
        return d.replace(day=1)
    if trunc == "week":  # DATE_TRUNC('week') = Monday
        return d - datetime.timedelta(days=d.weekday())
    return d

def _next_bucket(d, trunc):
    if trunc == "month":
        return (d.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    if trunc == "week":
        return d + datetime.timedelta(days=7)
    return d + datetime.timedelta(days=1)

@fabric_router.get("/api/fabric/trend-series")
def trend_series(
    kpi: str = Query(default="consumption"),
    bucket: str = Query(default="month"),
    since: str = Query(default=None),
    until: str = Query(default=None),
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    product_id: str = Query(default=None),
    location: str = Query(default=None),
):
    kpi = (kpi or "").strip()
    if kpi not in _TREND_KPIS:
        return {"kpi": kpi, "error": "unknown_kpi", "rows": [], "incomplete": False, "unit": "m"}
    trunc = _TREND_TRUNC.get((bucket or "month").strip(), "month")
    # Date range: default last 12 months.
    today = datetime.date.today()
    try:
        until_d = datetime.date.fromisoformat(until) if until else today
    except ValueError:
        until_d = today
    try:
        since_d = datetime.date.fromisoformat(since) if since else (until_d.replace(day=1) - datetime.timedelta(days=365))
    except ValueError:
        since_d = until_d - datetime.timedelta(days=365)
    if since_d > until_d:
        since_d, until_d = until_d, since_d
    since, until = since_d.isoformat(), until_d.isoformat()

    scope_sql, scope_params = _trend_prod_scope(category, subcategory, product_id)
    mloc_sql, mloc_params = _trend_move_loc(location)
    kg = _kg("m")
    metres = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END"

    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)

        if kpi == "consumption":  # gross consumption (RMAT/Stock exit), metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, f"({_consume_pred('m')}) AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "net_consumption":  # consumption − genuine returns into RMAT, metres
            net = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END"
            rows = _trend_norm(_trend_move_series(
                conn, trunc, _net_cons_where("m"),
                net, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "received":  # IN moves, metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, "m.move_type='IN' AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "returns":  # genuine returns back into RMAT/Stock, metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, f"({_rmat_return_pred('m')}) AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "stock_on_hand":
            # No historical inventory snapshots exist, so back-cast from the CURRENT
            # snapshot using the net physical flow (received − net consumption):
            #   stock(end of bucket b) = stock_at_start + Σ flow up to b
            #   stock_at_start         = current_total − Σ flow over ALL history
            # The latest bucket therefore always equals the true current snapshot;
            # earlier buckets are the current value minus the moves that came after.
            iloc_sql, iloc_params = _trend_inv_loc(location)
            inv = q(conn, f"""
                SELECT COALESCE(SUM(CASE WHEN p.kg_per_mtr_eff > 0
                                         THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END), 0) AS metres,
                       BOOL_OR(p.kg_per_mtr_eff IS NULL OR p.kg_per_mtr_eff <= 0) AS incomplete
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 AND {_scope_sql('main')}
                  {scope_sql}{iloc_sql}
            """, list(scope_params) + list(iloc_params))[0]
            current_m = float(inv["metres"] or 0)
            # Net flow per bucket over ALL history (wide range), scoped the same way.
            recv_rows = _trend_move_series(
                conn, trunc, "m.move_type='IN' AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, "2000-01-01", "2100-01-01")
            net = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END"
            nc_rows = _trend_move_series(
                conn, trunc, _net_cons_where("m"),
                net, scope_sql, scope_params, mloc_sql, mloc_params, "2000-01-01", "2100-01-01")
            recv = {r["period"]: float(r["value"] or 0) for r in recv_rows}
            ncon = {r["period"]: float(r["value"] or 0) for r in nc_rows}
            flow = {k: recv.get(k, 0) - ncon.get(k, 0) for k in set(recv) | set(ncon)}
            total_flow = sum(flow.values())
            stock_at_start = current_m - total_flow
            inc = bool(inv["incomplete"]) or any(r["incomplete"] for r in recv_rows) \
                or any(r["incomplete"] for r in nc_rows)
            rows = []
            b, end = _bucket_start(since_d, trunc), _bucket_start(until_d, trunc)
            items = sorted(flow.items())
            while b <= end:
                cum = sum(v for k, v in items if k <= b)
                rows.append({"period": b.isoformat(),
                             "value": round(stock_at_start + cum, 1),
                             "incomplete": inc})
                b = _next_bucket(b, trunc)

        else:  # metres_per_garment — done-MO fabric metres ÷ garments, in Python
            fb = q(conn, """
                SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
                FROM raw_fabric_products WHERE kg_per_mtr_eff > 0
            """)[0]
            fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None
            mrows = q(conn, f"""
                SELECT DATE_TRUNC('{trunc}', c.done_date)::date AS bucket,
                       c.odoo_mo_id, c.produced_qty, c.consumed_qty,
                       lower(coalesce(c.uom,'')) AS uom, p.kg_per_mtr_eff AS kpm
                FROM mo_fabric_consumption c
                LEFT JOIN raw_fabric_products p ON p.id = c.component_id
                WHERE c.done_date BETWEEN %s AND %s {scope_sql}
            """, [since, until] + list(scope_params))
            M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
            by_bucket = {}
            for r in mrows:
                bk = r["bucket"]
                mos = by_bucket.setdefault(bk, {})
                d = mos.setdefault(r["odoo_mo_id"], {
                    "produced": float(r["produced_qty"] or 0), "metres": 0.0,
                    "has_fabric": False, "used_fallback": False})
                d["has_fabric"] = True
                qty = float(r["consumed_qty"] or 0)
                u, kpm = r["uom"], r["kpm"]
                if u in M_UOMS:
                    d["metres"] += qty
                else:
                    kgv = qty / 1000.0 if u == "g" else qty
                    if kpm and float(kpm) > 0:
                        d["metres"] += kgv / float(kpm)
                    elif fallback_kpm:
                        d["metres"] += kgv / fallback_kpm
                        d["used_fallback"] = True
            rows = []
            for bk in sorted(by_bucket):
                tm = tg = 0.0
                inc = False
                for d in by_bucket[bk].values():
                    if d["produced"] <= 0 or not d["has_fabric"]:
                        continue
                    tm += d["metres"]; tg += d["produced"]
                    if d["used_fallback"]:
                        inc = True
                if tg > 0:
                    rows.append({"period": bk.isoformat(),
                                 "value": round(tm / tg, 2), "incomplete": inc})

    return {
        "kpi": kpi, "bucket": trunc, "unit": "m",
        "since": since, "until": until,
        "rows": rows, "incomplete": any(r["incomplete"] for r in rows),
    }

@fabric_router.get("/api/fabric/trend-options")
def trend_options():
    """Scope-selector option lists for the Trend Analysis panels: fabric
    categories, sub-categories (with parent), the fabric list, and locations.
    All restricted to the 'main' (non-support) scope to match the rest of the
    dashboard tabs that this builder replaces."""
    with _get_conn() as conn:
        cats = q(conn, f"""
            SELECT DISTINCT fabric_category AS value
            FROM raw_fabric_products p
            WHERE fabric_category IS NOT NULL AND btrim(fabric_category) <> ''
              AND {_scope_sql('main')}
            ORDER BY 1
        """)
        subs = q(conn, f"""
            SELECT DISTINCT fabric_category AS category, fabric_subcategory AS subcategory
            FROM raw_fabric_products p
            WHERE fabric_subcategory IS NOT NULL AND btrim(fabric_subcategory) <> ''
              AND {_scope_sql('main')}
            ORDER BY 1, 2
        """)
        fabrics = q(conn, f"""
            SELECT p.id, p.name
            FROM raw_fabric_products p
            WHERE p.id IN (SELECT DISTINCT product_id FROM raw_fabric_inventory WHERE quantity > 0)
              AND {_scope_sql('main')}
            ORDER BY p.name
            LIMIT 2000
        """)
        locs = q(conn, """
            SELECT DISTINCT location_name AS value
            FROM raw_fabric_inventory
            WHERE quantity > 0 AND location_name IS NOT NULL AND btrim(location_name) <> ''
            ORDER BY 1
        """)
    return {
        "categories": [r["value"] for r in cats],
        "subcategories": subs,
        "fabrics": [{"id": r["id"], "name": r["name"]} for r in fabrics],
        "locations": [r["value"] for r in locs],
    }

# ── BOM styles (default explorer view) ──────────────────────
@fabric_router.get("/api/fabric/bom-styles")
def bom_styles(search: str = Query(default=None), limit: int = Query(default=300),
               scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = "b.finished_product_name IS NOT NULL AND b.finished_product_name <> ''"
        params = []
        if search:
            where += " AND (b.finished_product_name ILIKE %s OR b.finished_product_sku ILIKE %s)"
            params = [f"%{search}%", f"%{search}%"]
        scope_clause = _scope_sql(scope)
        rows = q(conn, f"""
            SELECT b.finished_product_name as style, b.finished_product_sku as sku,
              COUNT(*) as components,
              COUNT(*) FILTER (WHERE b.component_uom IN ('kg','g')) as fabric_components,
              ROUND(SUM(CASE WHEN b.component_uom='g' THEN b.component_qty/1000
                             WHEN b.component_uom='kg' THEN b.component_qty ELSE 0 END)::numeric,3) as fabric_kg,
              COUNT(*) FILTER (WHERE b.component_uom='Pcs') as trim_pieces
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            WHERE {where}
              AND {scope_clause}
            GROUP BY 1,2
            ORDER BY fabric_kg DESC NULLS LAST
            LIMIT %s
        """, params + [limit])
        total = q(conn, f"""
            SELECT COUNT(DISTINCT b.finished_product_name) as n
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            WHERE b.finished_product_name IS NOT NULL AND b.finished_product_name <> ''
              AND {scope_clause}
        """)[0]['n']
        return {"total_styles": total, "items": rows}

# ── Where-used (reverse BOM: styles using a fabric) ─────────
@fabric_router.get("/api/fabric/where-used")
def where_used(component: str = Query(...)):
    with _get_conn() as conn:
        return q(conn, """
            SELECT b.finished_product_name as style, b.finished_product_sku as sku,
              b.component_name, ROUND(b.component_qty::numeric,3) as component_qty, b.component_uom
            FROM raw_fabric_boms b
            WHERE b.component_name ILIKE %s
            ORDER BY b.finished_product_name
            LIMIT 300
        """, (f"%{component}%",))

# ── Purchase-order delivery performance ─────────────────────
@fabric_router.get("/api/fabric/po-performance")
def po_performance(scope: str = Query(default="main")):
    with _get_conn() as conn:
        kpis = q(conn, f"""
            SELECT
              COUNT(DISTINCT po.po_name) as pos,
              COUNT(*) as lines,
              COUNT(DISTINCT po.po_name) FILTER (WHERE po.state='done') as done_pos,
              ROUND(SUM(po.total_value)::numeric,0) as ordered_value,
              ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) as received_value,
              ROUND((SUM(po.qty_received)/NULLIF(SUM(po.qty_ordered),0)*100)::numeric,1) as fill_rate,
              ROUND(AVG(po.date_planned - po.order_date)::numeric,0) as avg_lead_days,
              COUNT(DISTINCT po.po_name) FILTER (WHERE po.date_planned < CURRENT_DATE AND po.qty_ordered>po.qty_received) as overdue_open
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)}
        """)[0]
        by_month = q(conn, f"""
            SELECT DATE_TRUNC('month', po.order_date)::date as period,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as value_kes
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)} AND po.order_date IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """)
        return {"kpis": kpis, "by_month": by_month}

# ── Supplier rollup (outstanding exposure) ──────────────────
@fabric_router.get("/api/fabric/suppliers")
def suppliers(scope: str = Query(default="main")):
    with _get_conn() as conn:
        return q(conn, f"""
            SELECT
              COALESCE(NULLIF(po.supplier,''),'Unknown') as supplier,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as outstanding_value,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,1) as outstanding_qty
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND {_scope_sql(scope)}
            GROUP BY 1
            ORDER BY outstanding_value DESC NULLS LAST
        """)

# ── Supplier → Source City breakdown (consolidator drill-down) ──
@fabric_router.get("/api/fabric/suppliers/source-cities")
def supplier_source_cities(supplier: str = Query(...),
                           scope: str = Query(default="main")):
    """Per-Source-City breakdown of one supplier's outstanding exposure.

    Reuses the exact same filters/joins as /api/fabric/suppliers (exclude
    cancelled POs, join raw_fabric_products on product_id, respect scope) so the
    city rows reconcile back to the supplier's parent totals. Empty / 'false'
    Odoo city values are bucketed into a single 'Unknown / unset' row.
    """
    with _get_conn() as conn:
        return q(conn, f"""
            SELECT
              CASE
                WHEN NULLIF(BTRIM(LOWER(COALESCE(p.source_city,''))),'') IS NULL
                  OR LOWER(BTRIM(p.source_city)) = 'false'
                THEN 'Unknown / unset'
                ELSE BTRIM(p.source_city)
              END as source_city,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as outstanding_value,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,1) as outstanding_qty
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND {_scope_sql(scope)}
              AND COALESCE(NULLIF(po.supplier,''),'Unknown') = %s
            GROUP BY 1
            ORDER BY outstanding_value DESC NULLS LAST
        """, (supplier,))

# ── Filter options ──────────────────────────────────────────
@fabric_router.get("/api/fabric/filters")
def filters(scope: str = Query(default="main")):
    with _get_conn() as conn:
        cats = q(conn, f"""
            SELECT DISTINCT fabric_category as value FROM raw_fabric_products 
            WHERE fabric_category IS NOT NULL AND {_scope_sql(scope, 'fabric_category')} ORDER BY 1
        """)
        subcats = q(conn, f"""
            SELECT DISTINCT fabric_category, fabric_subcategory FROM raw_fabric_products
            WHERE fabric_subcategory IS NOT NULL AND {_scope_sql(scope, 'fabric_category')} ORDER BY 1, 2
        """)
        locs = q(conn, """
            SELECT DISTINCT location_name as value FROM raw_fabric_inventory
            WHERE quantity > 0 ORDER BY 1
        """)
        colors = q(conn, """
            SELECT DISTINCT INITCAP(BTRIM(fabric_color)) as value FROM raw_fabric_products
            WHERE fabric_color IS NOT NULL AND btrim(fabric_color) <> '' ORDER BY 1
        """)
        return {
            "categories": [r['value'] for r in cats],
            "subcategories": subcats,
            "locations": [r['value'] for r in locs],
            "fabric_colors": [r['value'] for r in colors],
            "plain_print": ["Solid", "Print"],
            "weight_range": ["Light", "Medium", "Heavy"],
        }

# ── Buying-team manual reservations ─────────────────────────
# Distinct from Odoo's ERP `reserved_qty`: the buying team earmarks fabric for a
# specific style, tracks how long it has been held, then marks it used.
_RESV_UOMS = {"m", "kg"}

@fabric_router.get("/api/fabric/product-search")
def product_search(q_: str = Query(default="", alias="q"), limit: int = Query(default=20)):
    """Lightweight fabric picker for the reservation form."""
    term = (q_ or "").strip()
    limit = max(1, min(int(limit or 20), 50))
    with _get_conn() as conn:
        where = "i.quantity > 0"
        params = []
        if term:
            where += " AND (p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)"
            params += [f"%{term}%", f"%{term}%", f"%{term}%"]
        return q(conn, f"""
            SELECT p.id, p.name, p.default_code, p.uom,
              ROUND(p.kg_per_mtr_eff::numeric,4) as kg_per_mtr, p.kg_per_mtr_src,
              ROUND(SUM(i.available)::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN SUM(i.available)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {where}
            GROUP BY p.id, p.name, p.default_code, p.uom, p.kg_per_mtr_eff, p.kg_per_mtr_src
            ORDER BY p.name
            LIMIT %s
        """, params + [limit])

@fabric_router.get("/api/fabric/reservations")
def list_reservations(status: str = Query(default="active"), search: str = Query(default=None)):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        where = ["1=1"]
        params = []
        if status and status.lower() != "all":
            where.append("r.status = %s"); params.append(status.lower())
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR r.style_name ILIKE %s)")
            params += [f"%{search}%", f"%{search}%", f"%{search}%"]
        # `soh` = current total stock on hand (kg) per fabric across all locations.
        rows = q(conn, f"""
            WITH soh AS (
              SELECT product_id, SUM(quantity) as soh_kg
              FROM raw_fabric_inventory
              GROUP BY product_id
            )
            SELECT r.id, r.product_id, r.qty, r.uom, r.qty_kg, r.style_name, r.note,
              r.status, r.reserved_by_name, r.reserved_at::date as reserved_on,
              r.used_at::date as used_on, r.used_by,
              p.name as fabric_name, p.default_code, p.kg_per_mtr_eff as kg_per_mtr,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN r.qty_kg/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(COALESCE(s.soh_kg,0)::numeric,2) as soh_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(s.soh_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as soh_metres,
              (CURRENT_DATE - r.reserved_at::date) as days_reserved,
              CASE WHEN r.used_at IS NOT NULL
                   THEN (r.used_at::date - r.reserved_at::date) END as days_to_use
            FROM fabric_reservations r
            LEFT JOIN raw_fabric_products p ON p.id = r.product_id
            LEFT JOIN soh s ON s.product_id = r.product_id
            WHERE {' AND '.join(where)}
            ORDER BY (r.status='active') DESC, r.reserved_at DESC
            LIMIT 500
        """, params)
        return {"items": rows}

@fabric_router.post("/api/fabric/reservations")
def create_reservation(request: Request, body: dict = Body(...)):
    product_id = body.get("product_id")
    style_name = (body.get("style_name") or "").strip()
    uom = (body.get("uom") or "").strip().lower()
    note = (body.get("note") or "").strip() or None
    try:
        qty = float(body.get("qty"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="qty must be a number")
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id is required")
    if qty <= 0:
        raise HTTPException(status_code=400, detail="qty must be greater than zero")
    if uom not in _RESV_UOMS:
        raise HTTPException(status_code=400, detail="uom must be 'm' or 'kg'")
    if not style_name:
        raise HTTPException(status_code=400, detail="style_name is required")
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        prod = q(conn, "SELECT id, name, kg_per_mtr_eff FROM raw_fabric_products WHERE id=%s",
                 (product_id,))
        if not prod:
            raise HTTPException(status_code=404, detail="fabric not found")
        kg_per_mtr = prod[0].get("kg_per_mtr_eff") or 0
        if uom == "kg":
            qty_kg = qty
        else:  # metres → kg
            if not kg_per_mtr or kg_per_mtr <= 0:
                raise HTTPException(status_code=400,
                    detail="this fabric has no kg/m factor; reserve it in kg instead")
            qty_kg = qty * float(kg_per_mtr)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO fabric_reservations
                  (product_id, qty, uom, qty_kg, style_name, note, reserved_by, reserved_by_name)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (product_id, qty, uom, round(qty_kg, 3), style_name, note, uid, name))
            new_id = cur.fetchone()["id"]
        conn.commit()
        _log_fabric_change("Created", {
            "id": new_id, "product": prod[0].get("name"),
            "style_name": style_name, "qty": qty, "uom": uom,
            "note": note, "status": "active",
        }, request)
        return {"id": new_id, "ok": True}

@fabric_router.post("/api/fabric/reservations/{resv_id}/use")
def mark_reservation_used(resv_id: int, request: Request):
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_reservations
                SET status='used', used_at=now(), used_by=%s
                WHERE id=%s AND status='active'
            """, (name, resv_id))
            updated = cur.rowcount
        conn.commit()
        if not updated:
            raise HTTPException(status_code=404,
                detail="reservation not found or already closed")
        _log_fabric_change("Marked used", _resv_for_log(conn, resv_id)
                           or {"id": resv_id, "status": "used"}, request)
        return {"ok": True}

@fabric_router.delete("/api/fabric/reservations/{resv_id}")
def delete_reservation(resv_id: int, request: Request):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        # Capture details BEFORE the row is gone so the audit log is human-readable.
        snapshot = _resv_for_log(conn, resv_id)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fabric_reservations WHERE id=%s", (resv_id,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            raise HTTPException(status_code=404, detail="reservation not found")
        log_row = snapshot or {"id": resv_id}
        log_row["status"] = "deleted"
        _log_fabric_change("Deleted", log_row, request)
        return {"ok": True}
