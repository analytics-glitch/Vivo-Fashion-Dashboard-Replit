"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
import psycopg2.extras
from fastapi import APIRouter, Query

fabric_router = APIRouter(tags=["fabric"])

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
            f"AND {alias}.uom IN ('g','kg')")

# Number of weeks in a calendar month, used to turn a monthly average run-rate
# into a weekly run-rate for weeks-of-cover.
WEEKS_PER_MONTH = 52.0 / 12.0
DAYS_PER_MONTH = 30.4375

# ── Location filter ─────────────────────────────────────────
# A location of "All" (or empty) means aggregate across every location.
_ALL_LOC = {"", "all", "__all__"}

def _loc_filter(location, alias="i"):
    """Return (sql_fragment, params) for an optional location_name filter."""
    if location is None or str(location).strip().lower() in _ALL_LOC:
        return ("", [])
    return (f" AND {alias}.location_name = %s", [location])

# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary(location: str = Query(default="RMAT/Stock")):
    with _get_conn() as conn:
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
        
        all_loc = location is None or str(location).strip().lower() in _ALL_LOC
        # For "All", fabric stock is every Fabric row except the dead-stock
        # location (reported separately); otherwise just the chosen location.
        rmat = [r for r in stock if r['category'] == 'Fabric'
                and (r['location_name'] != 'Dead/Stock Fabric' if all_loc
                     else r['location_name'] == location)]
        dead = [r for r in stock if r['location_name'] == 'Dead/Stock Fabric']
        trim = [r for r in stock if r['category'] == 'Trim']
        
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
            FROM raw_fabric_moves m
            WHERE {_net_cons_where('m')}
              AND m.date >= NOW() - INTERVAL '30 days'
        """)[0]
        
        # BOM styles
        bom = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as styles FROM raw_fabric_boms")[0]
        
        # "All" yields one row per location — aggregate; a single location is one row.
        return {
            "fabric_stock_kg": round(sum(r['qty_kg'] or 0 for r in rmat), 1),
            "fabric_stock_metres": round(sum(r['qty_metres'] or 0 for r in rmat)),
            "fabric_stock_value": round(sum(r['value_kes'] or 0 for r in rmat)),
            "fabric_products": sum(r['products'] or 0 for r in rmat),
            "dead_stock_value": sum(r['value_kes'] or 0 for r in dead),
            "dead_stock_kg": sum(r['qty_kg'] or 0 for r in dead),
            "outstanding_pos": pos['count'] or 0,
            "outstanding_po_value": pos['value'] or 0,
            "consumption_30d_kg": cons['kg'] or 0,
            "styles_with_bom": bom['styles'] or 0,
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
    location: str = Query(default="RMAT/Stock"),
    search: str = Query(default=None),
    min_qty: float = Query(default=0),
    sort: str = Query(default="value_kes"),
    dir: str = Query(default="desc"),
    limit: int = Query(default=200),
    offset: int = Query(default=0),
):
    with _get_conn() as conn:
        # Whitelist of sortable output columns (aliases in the SELECT below) so the
        # client can drive ORDER BY without any SQL-injection surface.
        ALLOWED_SORT = {
            "default_code", "barcode", "name", "fabric_category", "fabric_subcategory",
            "plain_print", "weight_range", "fabric_structure", "gsm", "width_m",
            "kg_per_mtr", "fiber_content", "fabric_type", "supplier", "primary_color",
            "qty_kg", "available_kg", "qty_metres", "available_metres", "value_kes",
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
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

        rows = q(conn, f"""
            SELECT 
              p.id, p.name, p.default_code, p.barcode, p.fabric_category, p.fabric_subcategory,
              p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
              p.width_m, p.kg_per_mtr, p.fiber_content, p.fabric_type,
              p.supplier, p.primary_color, p.standard_price, p.uom,
              ROUND(i.quantity::numeric,2) as qty_kg,
              ROUND(i.reserved_qty::numeric,2) as reserved_kg,
              ROUND(i.available::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE NULL END::numeric,1) as qty_metres,
              ROUND(CASE WHEN p.kg_per_mtr>0 THEN i.available/p.kg_per_mtr ELSE NULL END::numeric,1) as available_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as last_move,
              CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id) as days_since_move
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
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
                FROM raw_fabric_moves m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {base_where}
                GROUP BY 1 ORDER BY qty_kg DESC NULLS LAST {limit}
            """, (since, until))
        trunc = {"day": "day", "week": "week"}.get(group_by, "month")
        return q(conn, f"""
            SELECT DATE_TRUNC('{trunc}', m.date)::date as period, {metrics}
            FROM raw_fabric_moves m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {base_where}
            GROUP BY 1 ORDER BY 1
        """, (since, until))

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
        # weeks_cover uses the average monthly run-rate: total net consumption over
        # the window ÷ number of months in the window = monthly average, converted
        # to a weekly rate (÷ weeks/month), then stock ÷ weekly rate.
        return q(conn, f"""
            WITH out_moves AS (
              SELECT product_id,
                MAX(product_name) FILTER (WHERE move_type='OUT') as product_name,
                SUM({_net_kg('raw_fabric_moves')}) as consumed_kg,
                COUNT(*) FILTER (WHERE move_type='OUT') as moves,
                MAX(date) FILTER (WHERE move_type='OUT')::date as last_out
              FROM raw_fabric_moves
              WHERE {_net_cons_where('raw_fabric_moves')}
                AND date >= NOW() - (%s || ' days')::interval
              GROUP BY product_id
              HAVING SUM({_net_kg('raw_fabric_moves')}) > 0
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
        return q(conn, """
            SELECT DATE_TRUNC('month', date)::date as period,
              ROUND(SUM(CASE WHEN move_type='IN'       THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as in_kg,
              ROUND(SUM(CASE WHEN move_type='OUT'      THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as out_kg,
              ROUND(SUM(CASE WHEN move_type='INTERNAL' THEN (CASE WHEN uom='g' THEN qty/1000 ELSE qty END) ELSE 0 END)::numeric,1) as internal_kg
            FROM raw_fabric_moves
            WHERE uom IN ('g','kg')
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
        return {
            "categories": [r['value'] for r in cats],
            "subcategories": subcats,
            "locations": [r['value'] for r in locs],
            "plain_print": ["Plain", "Print"],
            "weight_range": ["Light", "Medium", "Heavy"],
        }
