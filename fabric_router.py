"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
import datetime
import re
import psycopg2.extras
from fastapi import APIRouter, Query, Request, Body, HTTPException

import fabric_sheet_override as ov

fabric_router = APIRouter(tags=["fabric"])

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
# Fabric is "consumed" by an OUT move to production. Some of it comes back as a
# return — an INTERNAL move whose location_from is the production virtual
# location. Net consumption = OUT − returns. The production location is a single
# fixed value (no LIKE needed), which also avoids the psycopg2 literal-% trap.
PROD_LOC = "Virtual Locations/Production"

def _kg(alias="m"):
    return f"(CASE WHEN {alias}.uom='g' THEN {alias}.qty/1000 ELSE {alias}.qty END)"

def _net_kg(alias="m"):
    """Signed kg per move row: +kg for OUT (consumption), −kg for production returns.
    A return is specifically an INTERNAL move out of the production location."""
    kg = _kg(alias)
    return (f"CASE WHEN {alias}.move_type='OUT' THEN {kg} "
            f"WHEN {alias}.move_type='INTERNAL' AND {alias}.location_from = '{PROD_LOC}' THEN -{kg} "
            f"ELSE 0 END")

def _net_cons_where(alias="m"):
    """Rows that make up net consumption: OUT moves plus INTERNAL production returns."""
    return (f"({alias}.move_type='OUT' "
            f"OR ({alias}.move_type='INTERNAL' AND {alias}.location_from = '{PROD_LOC}')) "
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

def _months_of_cover(conn, fabric_stock_kg, scope="main"):
    """Months-of-cover from a 6-month average monthly run-rate with the in-progress
    month projected to its end-of-month figure, plus a prior-period value for a
    trend indicator.

    The current 6-month window is the 6 calendar months ending this month: the 5
    completed months are taken as-is, and the current (incomplete) month is
    projected = month-to-date + (days remaining × trailing daily rate), where the
    trailing daily rate = total net consumption over the whole window ÷ elapsed
    days in the window. The prior value uses the same current stock against the
    average of the prior 6 completed months (window shifted back one month) so the
    trend isolates the change in run-rate. Both windows divide by 6 and self-heal
    as months roll forward. Consumption stays net-of-production-returns + fabric-only
    via the shared net-consumption model.
    """
    fabric_stock_kg = float(fabric_stock_kg or 0)
    months = q(conn, f"""
        SELECT to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
               SUM({_net_kg('m')})::numeric AS kg
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE {_net_cons_where('m')}
          AND {_scope_sql(scope)}
          AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date
        GROUP BY 1
    """)
    mon_kg = {r['mon']: float(r['kg'] or 0) for r in months}
    cal = q(conn, """
        SELECT CURRENT_DATE AS today,
               EXTRACT(DAY FROM CURRENT_DATE)::int AS dom,
               EXTRACT(DAY FROM (date_trunc('month',CURRENT_DATE)+INTERVAL '1 month - 1 day'))::int AS dim,
               (CURRENT_DATE - (date_trunc('month',CURRENT_DATE) - INTERVAL '5 months')::date + 1)::int AS win_days
    """)[0]
    today, dom, dim, win_days = cal['today'], cal['dom'], cal['dim'], cal['win_days']

    def _key(delta):
        idx = today.year * 12 + (today.month - 1) + delta
        return f"{idx // 12:04d}-{idx % 12 + 1:02d}"

    cur_key = _key(0)
    complete = [_key(d) for d in range(-5, 0)]   # M-5 .. M-1 (completed months in window)
    prior = [_key(d) for d in range(-6, 0)]      # M-6 .. M-1 (prior 6-month window)

    mtd = mon_kg.get(cur_key, 0.0)
    sum_complete = sum(mon_kg.get(k, 0.0) for k in complete)
    sum_window = sum_complete + mtd              # total actual net consumption over last 6 months
    trailing_daily = (sum_window / win_days) if win_days else 0.0
    remaining = max(dim - dom, 0)
    projected_month = mtd + remaining * trailing_daily
    avg_monthly = (sum_complete + projected_month) / 6.0
    cover_now = (fabric_stock_kg / avg_monthly) if avg_monthly > 0 else None

    sum_prior = sum(mon_kg.get(k, 0.0) for k in prior)
    avg_prior = sum_prior / 6.0
    cover_prior = (fabric_stock_kg / avg_prior) if avg_prior > 0 else None

    import calendar as _calmod
    return {
        "months_of_cover": round(cover_now, 2) if cover_now is not None else None,
        "months_of_cover_prior": round(cover_prior, 2) if cover_prior is not None else None,
        "avg_monthly_consumption_kg": round(avg_monthly, 1),
        "projected_month_kg": round(projected_month, 1),
        "projected_month_mtd_kg": round(mtd, 1),
        "projected_month_label": _calmod.month_abbr[today.month],
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
              ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
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
        # the on-hand headline & Months of cover): total stock value (KES) ÷ total
        # stock metres. If ANY in-scope fabric WITH stock is missing its kg→metre
        # conversion (kg_per_mtr null/0), the figure is "incomplete" → render "—"
        # (its value would be in the numerator but no metres in the denominator).
        acpm_stock = q(conn, f"""
            SELECT ROUND(SUM(i.total_value)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,2) as metres,
                   BOOL_OR(COALESCE(p.kg_per_mtr,0)<=0) as incomplete
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
              AND {scope_sql}
        """)[0]
        acpm_stock_incomplete = bool(acpm_stock['incomplete'])
        acpm_stock_metres = float(acpm_stock['metres'] or 0)
        acpm_stock_value = float(acpm_stock['value_kes'] or 0)
        avg_cost_per_metre_stock = (
            round(acpm_stock_value / acpm_stock_metres, 2)
            if (not acpm_stock_incomplete and acpm_stock_metres > 0) else None)

        # Average cost per metre — PURCHASES. SUM(received qty × unit price) ÷
        # SUM(received metres) over ALL non-cancelled POs (entire history), using
        # RECEIVED quantity (what actually landed), converted to metres via the
        # product master's kg_per_mtr. Per-supplier breakdown lets a supplier whose
        # fabrics lack the conversion be pinpointed (its row + the headline → "—").
        # Scoped to category='Fabric' (Raw Materials-Fabric) only, identically to
        # the STOCK side above — Trim/unmatched PO lines are excluded entirely.
        pur_rows = q(conn, f"""
            SELECT po.supplier as supplier,
                   ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN po.qty_received/p.kg_per_mtr ELSE 0 END)::numeric,2) as metres,
                   BOOL_OR(po.qty_received>0 AND COALESCE(p.kg_per_mtr,0)<=0) as incomplete
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
              AND {scope_sql}
            GROUP BY po.supplier
        """)
        purchases_by_supplier = []
        pur_total_value = 0.0
        pur_total_metres = 0.0
        pur_any_incomplete = False
        for r in pur_rows:
            inc = bool(r['incomplete'])
            val = float(r['value_kes'] or 0)
            met = float(r['metres'] or 0)
            pur_total_value += val
            pur_total_metres += met
            pur_any_incomplete = pur_any_incomplete or inc
            purchases_by_supplier.append({
                "supplier": r['supplier'] or "(unknown)",
                "value_kes": round(val),
                "metres": round(met, 1),
                "cost_per_metre": (round(val / met, 2) if (not inc and met > 0) else None),
                "incomplete": inc,
            })
        # Sort by cost per metre desc; incomplete (no figure) rows sink to bottom.
        purchases_by_supplier.sort(
            key=lambda x: (x['cost_per_metre'] is None, -(x['cost_per_metre'] or 0)))
        avg_cost_per_metre_purchases = (
            round(pur_total_value / pur_total_metres, 2)
            if (not pur_any_incomplete and pur_total_metres > 0) else None)
        
        # Consumption last 30 days — net of fabric returned from production.
        # Metres = each move's net kg ÷ the fabric's kg-per-metre (skip rows with
        # no/zero kg_per_mtr — negligible; RMAT/Stock has zero fabrics missing it).
        cons = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN ({_net_kg('m')})/p.kg_per_mtr ELSE 0 END)::numeric,0) as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= NOW() - INTERVAL '30 days'
        """)[0]

        # Consumption so far today — net of production returns (m.date is a date/ts)
        cons_today = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN ({_net_kg('m')})/p.kg_per_mtr ELSE 0 END)::numeric,0) as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= CURRENT_DATE
        """)[0]

        # BOM styles
        bom = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as styles FROM raw_fabric_boms")[0]

        # Months of cover — 6-month average monthly run-rate with the in-progress
        # month projected to its end-of-month figure (fabric consumption is lumpy
        # — production-run driven — so a single 30-day denominator swings wildly).
        # Cover always tracks the LIVE RMAT/Stock base (dead stock isn't "cover"),
        # so it doesn't change with the selected scope.
        rmat_stock_kg = round(sum(r['qty_kg'] or 0 for r in rmat), 1)
        rmat_stock_value = round(sum(r['value_kes'] or 0 for r in rmat))
        dead_stock_value = sum(r['value_kes'] or 0 for r in dead)
        cover = _months_of_cover(conn, rmat_stock_kg, scope_param)

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
            "avg_cost_per_metre_stock_incomplete": acpm_stock_incomplete,
            "avg_cost_per_metre_purchases": avg_cost_per_metre_purchases,
            "avg_cost_per_metre_purchases_incomplete": pur_any_incomplete,
            "purchases_by_supplier": purchases_by_supplier,
            "consumption_30d_kg": cons['kg'] or 0,
            "consumption_30d_metres": cons['metres'] or 0,
            "consumption_today_kg": cons_today['kg'] or 0,
            "consumption_today_metres": cons_today['metres'] or 0,
            "styles_with_bom": bom['styles'] or 0,
            **cover,
        }

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
              ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
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
              p.width_m, p.kg_per_mtr, p.fiber_content, p.fabric_type,
              p.supplier, p.primary_color, INITCAP(BTRIM(p.fabric_color)) as fabric_color,
              NULLIF(INITCAP(BTRIM(p.color)),'') as color,
              p.standard_price, p.uom,
              ROUND(p.standard_price::numeric,2) as cost_kes,
              ROUND(p.standard_price::numeric,2) as cost_per_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN p.standard_price*p.kg_per_mtr ELSE NULL END::numeric,2) as cost_metre,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN 1.0/p.kg_per_mtr ELSE NULL END::numeric,3) as m_per_kg,
              ROUND(i.quantity::numeric,2) as qty_kg,
              ROUND(i.reserved_qty::numeric,2) as reserved_kg,
              ROUND(i.available::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.available/p.kg_per_mtr ELSE NULL END::numeric,1) as available_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as weeks_cover,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as months_cover,
              ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr ELSE NULL END::numeric,1) as team_reserved_metres,
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
                CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END as qty_metres,
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
              GROUP BY i.product_id, i.quantity, p.kg_per_mtr, i.total_value
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
        mtr_expr = f"CASE WHEN p.kg_per_mtr>0 THEN ({kg_expr})/p.kg_per_mtr ELSE 0 END"
        base_where = (f"{_net_cons_where('m')} "
                      f"AND {_scope_sql(scope)} "
                      "AND m.date BETWEEN %s AND %s")
        metrics = (f"COUNT(DISTINCT m.product_id) FILTER (WHERE m.move_type='OUT') as fabrics_used, "
                   f"ROUND(SUM({kg_expr})::numeric,1) as qty_kg, "
                   f"ROUND(SUM({mtr_expr})::numeric,0) as qty_metres, "
                   f"COUNT(*) FILTER (WHERE m.move_type='OUT') as moves")
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
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,1) as available_metres,
                   ROUND(SUM(CASE WHEN COALESCE(p.kg_per_mtr,0)<=0 THEN i.quantity ELSE 0 END)::numeric,1) as available_kg_nometre,
                   ROUND(SUM(i.total_value)::numeric,0) as tied_up_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category = 'Fabric' {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3, 4
        """, loc_params)
        net = _net_kg('m')
        if win_from and win_to:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= %s AND m.date < (%s::date + 1)"
            cons_params = (win_from, win_to)
        else:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= NOW() - (%s || ' days')::interval"
            cons_params = (days,)
        cons = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   m.product_id as product_id,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as product_name,
                   ROUND(SUM({net})::numeric,1) as consumption_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN ({net})/p.kg_per_mtr ELSE 0 END)::numeric,1) as consumption_metres,
                   ROUND(SUM(CASE WHEN COALESCE(p.kg_per_mtr,0)<=0 THEN ({net}) ELSE 0 END)::numeric,1) as consumption_kg_nometre
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {cons_where}
            GROUP BY 1, 2, 3, 4
        """, cons_params)

        def _node(name):
            return {"group": name, "consumption_kg": 0.0, "consumption_metres": 0.0,
                    "available_kg": 0.0, "available_metres": 0.0, "tied_up_kes": 0.0,
                    "_cons_kg_nometre": 0.0, "_avail_kg_nometre": 0.0}
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
            for x in (_cat(r["category"])["_node"],
                      _sub(r["category"], r["subcategory"])["_node"],
                      _prod(r["category"], r["subcategory"], r["product_id"], r["product_name"])):
                x["consumption_kg"] += cv_kg
                x["consumption_metres"] += cv_m
                x["_cons_kg_nometre"] += cv_nm
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

        cat_nodes = [c["_node"] for c in cats.values()]
        tot_cons_kg = sum(x["consumption_kg"] for x in cat_nodes)
        tot_cons_m = sum(x["consumption_metres"] for x in cat_nodes)
        tot_avail_kg = sum(x["available_kg"] for x in cat_nodes)
        tot_avail_m = sum(x["available_metres"] for x in cat_nodes)
        tot_kes = sum(x["tied_up_kes"] for x in cat_nodes)

        def _finalize(x):
            c = x["consumption_metres"]
            a = x["available_metres"]
            pct_c = (c / tot_cons_m * 100) if tot_cons_m > 0 else 0.0
            pct_a = (a / tot_avail_m * 100) if tot_avail_m > 0 else 0.0
            gap = pct_a - pct_c
            shortfall = a - c
            covers = (a / (c / months)) if c > 0 else None
            idle = (x["available_kg"] > 0 and abs(x["consumption_kg"]) <= IDLE_KG_EPS)
            status = "Shortage" if (shortfall < 0 or (covers is not None and covers < 1)) else "OK"
            return {
                "group": x["group"],
                "consumption_kg": round(x["consumption_kg"], 1),
                "consumption_metres": round(c, 1),
                "available_kg": round(x["available_kg"], 1),
                "available_metres": round(a, 1),
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
                  p.width_m, p.kg_per_mtr, p.fiber_content, p.fabric_type,
                  p.supplier, p.primary_color, INITCAP(BTRIM(p.fabric_color)) as fabric_color,
                  NULLIF(INITCAP(BTRIM(p.color)),'') as color,
                  ROUND(p.standard_price::numeric,2) as cost_kes,
                  ROUND(p.standard_price::numeric,2) as cost_per_kg,
                  ROUND(CASE WHEN p.kg_per_mtr>0 THEN p.standard_price*p.kg_per_mtr ELSE NULL END::numeric,2) as cost_metre,
                  ROUND(CASE WHEN p.kg_per_mtr>0 THEN 1.0/p.kg_per_mtr ELSE NULL END::numeric,3) as m_per_kg,
                  ROUND(inv.quantity::numeric,2) as qty_kg,
                  ROUND(inv.available::numeric,2) as available_kg,
                  ROUND(CASE WHEN p.kg_per_mtr>0 THEN inv.quantity/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
                  ROUND(CASE WHEN p.kg_per_mtr>0 THEN inv.available/p.kg_per_mtr ELSE NULL END::numeric,1) as available_metres,
                  ROUND(inv.total_value::numeric,0) as value_kes,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as weeks_cover,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as months_cover,
                  ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
                  ROUND(CASE WHEN p.kg_per_mtr>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr ELSE NULL END::numeric,1) as team_reserved_metres,
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
              SELECT i.product_id, SUM(i.quantity) AS stock_kg
              FROM raw_fabric_inventory i
              WHERE i.quantity > 0 {loc_sql}
              GROUP BY i.product_id
            ), usage AS (
              SELECT m.product_id, SUM({_net_kg('m')}) AS usage_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
              GROUP BY m.product_id
            )
            SELECT
              p.id, p.default_code, p.name,
              COALESCE(NULLIF(p.fabric_category,''),'Unknown') AS fabric_category,
              COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') AS fabric_subcategory,
              p.supplier, p.width_m, p.gsm, p.fiber_content,
              ROUND(COALESCE(st.stock_kg,0)::numeric,1) AS stock_kg,
              ROUND(GREATEST(COALESCE(us.usage_kg,0),0)::numeric,1) AS usage_kg,
              (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id) AS last_move
            FROM raw_fabric_products p
            LEFT JOIN stock st ON st.product_id = p.id
            LEFT JOIN usage us ON us.product_id = p.id
            WHERE COALESCE(p.kg_per_mtr,0) <= 0
              AND {_scope_sql(scope)}
              AND (COALESCE(st.stock_kg,0) > 0 OR COALESCE(us.usage_kg,0) > 0.05)
        """, list(loc_params))

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

# ── Dead stock ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/dead-stock")
def dead_stock(scope: str = Query(default="main")):
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT 
              i.product_name, p.fabric_category, p.fabric_subcategory,
              p.kg_per_mtr, p.width_m, p.gsm, p.plain_print,
              ROUND(i.quantity::numeric,1) as qty_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              MAX(m.date)::date as last_move,
              CURRENT_DATE - MAX(m.date)::date as days_since_move
            FROM raw_fabric_inventory i
            LEFT JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN raw_fabric_moves m ON m.product_id = i.product_id
            WHERE i.location_name = 'Dead/Stock Fabric' AND i.quantity > 0
              AND {_scope_sql(scope)}
            GROUP BY i.product_name, p.fabric_category, p.fabric_subcategory,
                     p.kg_per_mtr, p.width_m, p.gsm, p.plain_print,
                     i.quantity, i.total_value
            ORDER BY i.total_value DESC
        """)
        total_value = sum(r['value_kes'] or 0 for r in rows)
        return {"total_value": total_value, "items": rows}

# ── Purchase orders ─────────────────────────────────────────
@fabric_router.get("/api/fabric/purchase-orders")
def purchase_orders(supplier: str = Query(default=None), scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = f"p.category = 'Fabric' AND {_scope_sql(scope)}"
        params = []
        if supplier:
            where += " AND po.supplier ILIKE %s"; params.append(f"%{supplier}%")
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
              p.fabric_category, p.fabric_subcategory, p.kg_per_mtr,
              i.quantity as stock_kg,
              CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE NULL END as stock_metres,
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
                  ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
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
              ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
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
            "plain_print": split("plain_print"),
            "weight_range": split("weight_range"),
            "structure": split("fabric_structure"),
            "fiber": fiber,
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
                MAX(m.product_name) FILTER (WHERE m.move_type='OUT') as product_name,
                SUM({_net_kg('m')}) as consumed_kg,
                COUNT(*) FILTER (WHERE m.move_type='OUT') as moves,
                MAX(m.date) FILTER (WHERE m.move_type='OUT')::date as last_out
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
              ROUND(p.kg_per_mtr::numeric,4) as kg_per_mtr,
              ROUND(SUM(i.available)::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN SUM(i.available)/p.kg_per_mtr ELSE NULL END::numeric,1) as available_metres
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {where}
            GROUP BY p.id, p.name, p.default_code, p.uom, p.kg_per_mtr
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
              p.name as fabric_name, p.default_code, p.kg_per_mtr,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN r.qty_kg/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
              ROUND(COALESCE(s.soh_kg,0)::numeric,2) as soh_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN COALESCE(s.soh_kg,0)/p.kg_per_mtr ELSE NULL END::numeric,1) as soh_metres,
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
        prod = q(conn, "SELECT id, name, kg_per_mtr FROM raw_fabric_products WHERE id=%s",
                 (product_id,))
        if not prod:
            raise HTTPException(status_code=404, detail="fabric not found")
        kg_per_mtr = prod[0].get("kg_per_mtr") or 0
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
        return {"ok": True}

@fabric_router.delete("/api/fabric/reservations/{resv_id}")
def delete_reservation(resv_id: int, request: Request):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fabric_reservations WHERE id=%s", (resv_id,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            raise HTTPException(status_code=404, detail="reservation not found")
        return {"ok": True}
