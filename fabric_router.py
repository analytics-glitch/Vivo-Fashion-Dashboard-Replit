"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
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

def _months_of_cover(conn, fabric_stock_kg):
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
        WHERE {_net_cons_where('m')}
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

# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary(location: str = Query(default="RMAT/Stock")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # Stock by location
        stock = q(conn, """
            SELECT 
              i.location_name,
              p.category,
              COUNT(DISTINCT i.product_id) as products,
              ROUND(SUM(i.quantity)::numeric,1) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0
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
        
        # POs outstanding
        pos = q(conn, """
            SELECT COUNT(DISTINCT po_name) as count,
              ROUND(SUM((qty_ordered-qty_received)*price_unit)::numeric,0) as value
            FROM raw_fabric_purchase_orders
            WHERE qty_ordered > qty_received AND state != 'cancel'
        """)[0]
        
        # Consumption last 30 days — net of fabric returned from production
        cons = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg
            FROM {EFFECTIVE_MOVES} m
            WHERE {_net_cons_where('m')}
              AND m.date >= NOW() - INTERVAL '30 days'
        """)[0]

        # Consumption so far today — net of production returns (m.date is a date/ts)
        cons_today = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg
            FROM {EFFECTIVE_MOVES} m
            WHERE {_net_cons_where('m')}
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
        cover = _months_of_cover(conn, rmat_stock_kg)

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
            "consumption_30d_kg": cons['kg'] or 0,
            "consumption_today_kg": cons_today['kg'] or 0,
            "styles_with_bom": bom['styles'] or 0,
            **cover,
        }

# ── Stock by category ──────────────────────────────────────
@fabric_router.get("/api/fabric/by-category")
def by_category(location: str = Query(default="RMAT/Stock")):
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
    limit: int = Query(default=200),
    offset: int = Query(default=0),
):
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
            "kg_per_mtr", "fiber_content", "fabric_type", "supplier", "primary_color", "fabric_color", "color",
            "qty_kg", "available_kg", "qty_metres", "available_metres", "value_kes",
            "cost_kes", "cost_per_kg", "cost_metre", "weeks_cover",
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

        # Trailing-30-day net consumption per product → weekly run-rate → weeks of cover.
        # `resv` = sum of OPEN (active) buying-team reservations, in kg, per fabric.
        rows = q(conn, f"""
            WITH cons30 AS (
              SELECT m.product_id, SUM({_net_kg('m')}) as consumed_30d_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
                AND m.date >= NOW() - INTERVAL '30 days'
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
              ROUND(i.quantity::numeric,2) as qty_kg,
              ROUND(i.reserved_qty::numeric,2) as reserved_kg,
              ROUND(i.available::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.available/p.kg_per_mtr ELSE NULL END::numeric,1) as available_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              ROUND((i.quantity / NULLIF((COALESCE(c.consumed_30d_kg,0) / ({DAYS_PER_MONTH}/7.0)), 0))::numeric,1) as weeks_cover,
              ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr ELSE NULL END::numeric,1) as team_reserved_metres,
              (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as last_move,
              CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as days_since_move
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN cons30 c ON c.product_id = i.product_id
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
def ageing(location: str = Query(default="RMAT/Stock")):
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
):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        kg_expr = _net_kg("m")  # net of returns: +OUT, −production returns
        mtr_expr = f"CASE WHEN p.kg_per_mtr>0 THEN ({kg_expr})/p.kg_per_mtr ELSE 0 END"
        base_where = (f"{_net_cons_where('m')} "
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
            GROUP BY 1, 2
        """, loc_params)
        cons = q(conn, f"""
            SELECT COALESCE(NULLIF(p.fabric_category,''),'Unknown') as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   ROUND(SUM({_net_kg('m')})::numeric,1) as consumed_kg
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
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
@fabric_router.get("/api/fabric/mix")
def fabric_mix(
    group_by: str = Query(default="category"),
    days: int = Query(default=90),
    location: str = Query(default="RMAT/Stock"),
):
    """The fabric equivalent of the BI app's Stock Mix: compare each fabric
    category's (or sub-category's) share of CONSUMPTION against its share of
    AVAILABLE stock, and flag shortages/overstock.

    Available stock is location-scoped (default RMAT/Stock); net consumption is
    warehouse-wide over the trailing `days` window and ALWAYS reads through the
    effective-moves view so the Jan–Apr 2026 Odoo correction applies. Metres are
    derived per fabric via its kg-per-metre; kg with no kg-per-metre cannot be
    converted, so each group carries the unconvertible kg (cons/avail) and a
    `metres_incomplete` flag instead of silently showing 0. Derived columns are
    returned in metres (the spreadsheet's primary unit); the raw kg + metres
    figures + totals let the client re-derive everything for the Kg toggle."""
    group_by = "subcategory" if str(group_by).lower().startswith("sub") else "category"
    days = max(1, min(int(days or 90), 730))
    months = days / DAYS_PER_MONTH
    dimcol = "fabric_subcategory" if group_by == "subcategory" else "fabric_category"
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        loc_sql, loc_params = _loc_filter(location)
        stock = q(conn, f"""
            SELECT COALESCE(NULLIF(p.{dimcol},''),'Unknown') as grp,
                   ROUND(SUM(i.quantity)::numeric,1) as available_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,1) as available_metres,
                   ROUND(SUM(CASE WHEN COALESCE(p.kg_per_mtr,0)<=0 THEN i.quantity ELSE 0 END)::numeric,1) as available_kg_nometre,
                   ROUND(SUM(i.total_value)::numeric,0) as tied_up_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
            GROUP BY 1
        """, loc_params)
        net = _net_kg('m')
        cons = q(conn, f"""
            SELECT COALESCE(NULLIF(p.{dimcol},''),'Unknown') as grp,
                   ROUND(SUM({net})::numeric,1) as consumption_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN ({net})/p.kg_per_mtr ELSE 0 END)::numeric,1) as consumption_metres,
                   ROUND(SUM(CASE WHEN COALESCE(p.kg_per_mtr,0)<=0 THEN ({net}) ELSE 0 END)::numeric,1) as consumption_kg_nometre
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND m.date >= NOW() - (%s || ' days')::interval
            GROUP BY 1
        """, (days,))

        groups = {}
        def g(name):
            return groups.setdefault(name, {
                "group": name, "consumption_kg": 0.0, "consumption_metres": 0.0,
                "available_kg": 0.0, "available_metres": 0.0, "tied_up_kes": 0.0,
                "_cons_kg_nometre": 0.0, "_avail_kg_nometre": 0.0})
        for r in cons:
            x = g(r["grp"])
            x["consumption_kg"] += float(r["consumption_kg"] or 0)
            x["consumption_metres"] += float(r["consumption_metres"] or 0)
            x["_cons_kg_nometre"] += float(r["consumption_kg_nometre"] or 0)
        for r in stock:
            x = g(r["grp"])
            x["available_kg"] += float(r["available_kg"] or 0)
            x["available_metres"] += float(r["available_metres"] or 0)
            x["tied_up_kes"] += float(r["tied_up_kes"] or 0)
            x["_avail_kg_nometre"] += float(r["available_kg_nometre"] or 0)

        tot_cons_kg = sum(x["consumption_kg"] for x in groups.values())
        tot_cons_m = sum(x["consumption_metres"] for x in groups.values())
        tot_avail_kg = sum(x["available_kg"] for x in groups.values())
        tot_avail_m = sum(x["available_metres"] for x in groups.values())
        tot_kes = sum(x["tied_up_kes"] for x in groups.values())

        out = []
        for x in groups.values():
            c = x["consumption_metres"]
            a = x["available_metres"]
            pct_c = (c / tot_cons_m * 100) if tot_cons_m > 0 else 0.0
            pct_a = (a / tot_avail_m * 100) if tot_avail_m > 0 else 0.0
            variance = pct_c - pct_a
            shortfall = a - c
            covers = (a / (c / months)) if c > 0 else None
            status = "Shortage" if (shortfall < 0 or (covers is not None and covers < 1)) else "OK"
            metres_incomplete = (x["_cons_kg_nometre"] > 0.05 or x["_avail_kg_nometre"] > 0.05)
            out.append({
                "group": x["group"],
                "consumption_kg": round(x["consumption_kg"], 1),
                "consumption_metres": round(c, 1),
                "available_kg": round(x["available_kg"], 1),
                "available_metres": round(a, 1),
                "tied_up_kes": round(x["tied_up_kes"]),
                "pct_consumption": round(pct_c, 1),
                "pct_available": round(pct_a, 1),
                "variance_pp": round(variance, 1),
                "shortfall_metres": round(shortfall, 1),
                "monthly_covers": round(covers, 2) if covers is not None else None,
                "status": status,
                "metres_incomplete": metres_incomplete,
                "cons_kg_nometre": round(x["_cons_kg_nometre"], 1),
                "avail_kg_nometre": round(x["_avail_kg_nometre"], 1),
            })
        out.sort(key=lambda r: r["consumption_metres"], reverse=True)
        return {
            "group_by": group_by,
            "days": days,
            "months": round(months, 2),
            "total_consumption_kg": round(tot_cons_kg, 1),
            "total_consumption_metres": round(tot_cons_m, 1),
            "total_available_kg": round(tot_avail_kg, 1),
            "total_available_metres": round(tot_avail_m, 1),
            "total_tied_up_kes": round(tot_kes),
            "rows": out,
        }

# ── Dead stock ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/dead-stock")
def dead_stock():
    with _get_conn() as conn:
        rows = q(conn, """
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
            GROUP BY i.product_name, p.fabric_category, p.fabric_subcategory,
                     p.kg_per_mtr, p.width_m, p.gsm, p.plain_print,
                     i.quantity, i.total_value
            ORDER BY i.total_value DESC
        """)
        total_value = sum(r['value_kes'] or 0 for r in rows)
        return {"total_value": total_value, "items": rows}

# ── Purchase orders ─────────────────────────────────────────
@fabric_router.get("/api/fabric/purchase-orders")
def purchase_orders(supplier: str = Query(default=None)):
    with _get_conn() as conn:
        where = "1=1"
        params = []
        if supplier:
            where = "supplier ILIKE %s"; params.append(f"%{supplier}%")
        return q(conn, f"""
            SELECT po_name, supplier, order_date, state,
              COUNT(*) as lines,
              ROUND(SUM(total_value)::numeric,0) as po_value,
              ROUND(SUM(qty_ordered)::numeric,2) as qty_ordered,
              ROUND(SUM(qty_received)::numeric,2) as qty_received,
              ROUND(SUM(qty_ordered-qty_received)::numeric,2) as outstanding
            FROM raw_fabric_purchase_orders
            WHERE {where}
            GROUP BY po_name, supplier, order_date, state
            ORDER BY order_date DESC
        """, params)

# ── BOM lookup ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/bom")
def bom_lookup(sku: str = Query(default=None), style: str = Query(default=None)):
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
            ORDER BY b.finished_product_name, b.component_name
        """, params)

# ── Attribute split (plain/print, weight, structure) ────────
@fabric_router.get("/api/fabric/attribute-split")
def attribute_split(location: str = Query(default="RMAT/Stock")):
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
def top_consumed(days: int = Query(default=90), limit: int = Query(default=20)):
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
              WHERE {_net_cons_where('m')}
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
def movement_flow(months: int = Query(default=6)):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        return q(conn, f"""
            SELECT DATE_TRUNC('month', date)::date as period,
              ROUND(SUM(CASE WHEN move_type='IN'       THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as in_kg,
              ROUND(SUM(CASE WHEN move_type='OUT'      THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as out_kg,
              ROUND(SUM(CASE WHEN move_type='INTERNAL' THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as internal_kg
            FROM {EFFECTIVE_MOVES}
            WHERE is_fabric AND uom IN ('g','kg')
              AND date >= DATE_TRUNC('month', NOW() - (%s || ' months')::interval)
            GROUP BY 1 ORDER BY 1
        """, (months,))

# ── BOM styles (default explorer view) ──────────────────────
@fabric_router.get("/api/fabric/bom-styles")
def bom_styles(search: str = Query(default=None), limit: int = Query(default=300)):
    with _get_conn() as conn:
        where = "b.finished_product_name IS NOT NULL AND b.finished_product_name <> ''"
        params = []
        if search:
            where += " AND (b.finished_product_name ILIKE %s OR b.finished_product_sku ILIKE %s)"
            params = [f"%{search}%", f"%{search}%"]
        rows = q(conn, f"""
            SELECT b.finished_product_name as style, b.finished_product_sku as sku,
              COUNT(*) as components,
              COUNT(*) FILTER (WHERE b.component_uom IN ('kg','g')) as fabric_components,
              ROUND(SUM(CASE WHEN b.component_uom='g' THEN b.component_qty/1000
                             WHEN b.component_uom='kg' THEN b.component_qty ELSE 0 END)::numeric,3) as fabric_kg,
              COUNT(*) FILTER (WHERE b.component_uom='Pcs') as trim_pieces
            FROM raw_fabric_boms b
            WHERE {where}
            GROUP BY 1,2
            ORDER BY fabric_kg DESC NULLS LAST
            LIMIT %s
        """, params + [limit])
        total = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as n FROM raw_fabric_boms")[0]['n']
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
def po_performance():
    with _get_conn() as conn:
        kpis = q(conn, """
            SELECT
              COUNT(DISTINCT po_name) as pos,
              COUNT(*) as lines,
              COUNT(DISTINCT po_name) FILTER (WHERE state='done') as done_pos,
              ROUND(SUM(total_value)::numeric,0) as ordered_value,
              ROUND(SUM(qty_received*price_unit)::numeric,0) as received_value,
              ROUND((SUM(qty_received)/NULLIF(SUM(qty_ordered),0)*100)::numeric,1) as fill_rate,
              ROUND(AVG(date_planned - order_date)::numeric,0) as avg_lead_days,
              COUNT(DISTINCT po_name) FILTER (WHERE date_planned < CURRENT_DATE AND qty_ordered>qty_received) as overdue_open
            FROM raw_fabric_purchase_orders
            WHERE state != 'cancel'
        """)[0]
        by_month = q(conn, """
            SELECT DATE_TRUNC('month', order_date)::date as period,
              COUNT(DISTINCT po_name) as pos,
              ROUND(SUM(total_value)::numeric,0) as value_kes
            FROM raw_fabric_purchase_orders
            WHERE state != 'cancel' AND order_date IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """)
        return {"kpis": kpis, "by_month": by_month}

# ── Supplier rollup (outstanding exposure) ──────────────────
@fabric_router.get("/api/fabric/suppliers")
def suppliers():
    with _get_conn() as conn:
        return q(conn, """
            SELECT
              COALESCE(NULLIF(supplier,''),'Unknown') as supplier,
              COUNT(DISTINCT po_name) as pos,
              ROUND(SUM(total_value)::numeric,0) as po_value,
              ROUND(SUM((qty_ordered-qty_received)*price_unit)::numeric,0) as outstanding_value,
              ROUND(SUM(qty_ordered-qty_received)::numeric,1) as outstanding_qty
            FROM raw_fabric_purchase_orders
            WHERE state != 'cancel'
            GROUP BY 1
            ORDER BY outstanding_value DESC NULLS LAST
        """)

# ── Filter options ──────────────────────────────────────────
@fabric_router.get("/api/fabric/filters")
def filters():
    with _get_conn() as conn:
        cats = q(conn, """
            SELECT DISTINCT fabric_category as value FROM raw_fabric_products 
            WHERE fabric_category IS NOT NULL ORDER BY 1
        """)
        subcats = q(conn, """
            SELECT DISTINCT fabric_category, fabric_subcategory FROM raw_fabric_products
            WHERE fabric_subcategory IS NOT NULL ORDER BY 1, 2
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
            "plain_print": ["Plain", "Print"],
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
