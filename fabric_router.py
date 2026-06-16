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

# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary():
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
        
        rmat = [r for r in stock if r['location_name'] == 'RMAT/Stock' and r['category'] == 'Fabric']
        dead = [r for r in stock if r['location_name'] == 'Dead/Stock Fabric']
        trim = [r for r in stock if r['category'] == 'Trim']
        
        # POs outstanding
        pos = q(conn, """
            SELECT COUNT(DISTINCT po_name) as count,
              ROUND(SUM((qty_ordered-qty_received)*price_unit)::numeric,0) as value
            FROM raw_fabric_purchase_orders
            WHERE qty_ordered > qty_received AND state != 'cancel'
        """)[0]
        
        # Consumption last 30 days
        cons = q(conn, """
            SELECT ROUND(SUM(CASE WHEN uom='g' THEN qty/1000 ELSE qty END)::numeric,1) as kg
            FROM raw_fabric_moves
            WHERE move_type='OUT' AND uom IN ('g','kg')
              AND date >= NOW() - INTERVAL '30 days'
        """)[0]
        
        # BOM styles
        bom = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as styles FROM raw_fabric_boms")[0]
        
        rmat_row = rmat[0] if rmat else {}
        return {
            "fabric_stock_kg": rmat_row.get("qty_kg", 0),
            "fabric_stock_metres": rmat_row.get("qty_metres", 0),
            "fabric_stock_value": rmat_row.get("value_kes", 0),
            "fabric_products": rmat_row.get("products", 0),
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
        return q(conn, """
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
              AND i.location_name = %s
              AND p.fabric_category IS NOT NULL
            GROUP BY p.fabric_category, p.fabric_subcategory
            ORDER BY value_kes DESC
        """, (location,))

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
    limit: int = Query(default=200),
    offset: int = Query(default=0),
):
    with _get_conn() as conn:
        where = ["i.quantity > %s", "i.location_name = %s"]
        params = [min_qty, location]
        if category:
            where.append("p.fabric_category = %s"); params.append(category)
        if subcategory:
            where.append("p.fabric_subcategory = %s"); params.append(subcategory)
        if plain_print:
            where.append("p.plain_print = %s"); params.append(plain_print)
        if weight_range:
            where.append("p.weight_range = %s"); params.append(weight_range)
        if search:
            where.append("p.name ILIKE %s"); params.append(f"%{search}%")

        rows = q(conn, f"""
            SELECT 
              p.id, p.name, p.default_code, p.fabric_category, p.fabric_subcategory,
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
            ORDER BY i.total_value DESC
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
        return q(conn, """
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
              WHERE i.quantity > 0 AND i.location_name = %s
              GROUP BY i.product_id, i.quantity, p.kg_per_mtr, i.total_value
            ) sub
            GROUP BY age_band, sort_order
            ORDER BY sort_order
        """, (location,))

# ── Consumption over time ───────────────────────────────────
@fabric_router.get("/api/fabric/consumption")
def consumption(
    since: str = Query(default="2026-01-01"),
    until: str = Query(default="2099-12-31"),
    group_by: str = Query(default="month"),
):
    trunc = {"day":"day","week":"week"}.get(group_by, "month")
    with _get_conn() as conn:
        return q(conn, f"""
            SELECT 
              DATE_TRUNC('{trunc}', date)::date as period,
              COUNT(DISTINCT product_id) as fabrics_used,
              ROUND(SUM(CASE WHEN uom='g' THEN qty/1000 ELSE qty END)::numeric,1) as qty_kg,
              COUNT(*) as moves
            FROM raw_fabric_moves
            WHERE move_type='OUT' AND uom IN ('g','kg')
              AND date BETWEEN %s AND %s
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
        def split(col):
            return q(conn, f"""
                SELECT COALESCE(NULLIF(p.{col},''),'Unknown') as value,
                  COUNT(DISTINCT i.product_id) as fabrics,
                  ROUND(SUM(CASE WHEN p.kg_per_mtr>0 THEN i.quantity/p.kg_per_mtr ELSE 0 END)::numeric,0) as qty_metres,
                  ROUND(SUM(i.total_value)::numeric,0) as value_kes
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 AND i.location_name = %s
                GROUP BY 1
                ORDER BY value_kes DESC NULLS LAST
            """, (location,))
        return {
            "plain_print": split("plain_print"),
            "weight_range": split("weight_range"),
            "structure": split("fabric_structure"),
        }

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
