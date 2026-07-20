"""
product_desk_router.py — Phase 4: Product Desk
Markdown risk board, range vitality, newness ratio, daily AI coaching, issue register.
Gate: /api/product-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)

DESK = "product"

# ── SQL helpers ───────────────────────────────────────────────────────────────

_RISK_SQL = f"""
WITH soh AS (
    SELECT i.sku,
           SUM(i.available)      AS store_soh,
           MAX(p.price)          AS price,
           MAX(p.cost)           AS cost,
           MAX(p.style_name)     AS style_name,
           MAX(p.product_type)   AS product_type,
           MAX(p.brand)          AS brand
    FROM all_inventory i
    JOIN all_products_clean p ON i.sku = p.sku
    WHERE i.pos_location_name NOT IN ({du.WAREHOUSE_LOCATIONS})
      AND COALESCE(p.brand,'') NOT IN {du.THIRD_PARTY_BRANDS}
    GROUP BY i.sku
),
vel AS (
    SELECT p.sku,
           SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_date::date >= CURRENT_DATE - 28) AS units_4w,
           SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_date::date >= CURRENT_DATE - 84) AS units_12w
    FROM all_sales s
    JOIN all_products_clean p ON s.barcode = p.barcode
    WHERE s.sale_date::date >= CURRENT_DATE - 84
      AND s.pos_location_name NOT IN ({du.SALES_EXCLUSIONS})
    GROUP BY p.sku
),
by_style AS (
    SELECT COALESCE(NULLIF(s.style_name,''), s.sku) AS style_name,
           MAX(s.product_type)                      AS product_type,
           MAX(s.brand)                             AS brand,
           MAX(s.price)                             AS price,
           MAX(s.cost)                              AS cost,
           SUM(s.store_soh)                         AS soh,
           SUM(COALESCE(v.units_4w, 0))             AS units_4w,
           SUM(COALESCE(v.units_12w, 0))            AS units_12w
    FROM soh s
    LEFT JOIN vel v ON s.sku = v.sku
    WHERE s.store_soh > 0
    GROUP BY COALESCE(NULLIF(s.style_name,''), s.sku)
)
SELECT style_name, product_type, brand,
       ROUND(soh)         AS soh,
       ROUND(units_4w)    AS units_4w,
       ROUND(units_12w)   AS units_12w,
       CASE WHEN units_4w > 0
            THEN ROUND(soh::numeric / (units_4w / 4.0), 1)
            ELSE 999 END  AS woc,
       CASE WHEN units_12w > 0
            THEN ROUND((1.0 - (units_4w / NULLIF(units_12w / 3.0, 0))) * 100, 1)
            ELSE 100 END  AS vel_decline_pct,
       ROUND(COALESCE(price,0) * soh) AS stock_value,
       COALESCE(cost,0)  AS cost_unit
FROM by_style
WHERE soh > 0
ORDER BY woc DESC NULLS LAST, vel_decline_pct DESC
LIMIT 50
"""

_KPI_SQL = f"""
SELECT
    COUNT(*)                                                   AS styles_with_stock,
    COUNT(*) FILTER (WHERE units_4w = 0)                      AS zero_sales_28d,
    ROUND(AVG(CASE WHEN units_4w > 0
              THEN soh::numeric / (units_4w / 4.0) END), 1)  AS avg_woc,
    SUM(CASE WHEN units_4w = 0 THEN ROUND(COALESCE(price,0)*soh) ELSE 0 END)
                                                              AS dead_stock_value
FROM (
  SELECT COALESCE(NULLIF(s.style_name,''),s.sku) AS sname,
         MAX(s.price) AS price,
         SUM(i_agg.store_soh) AS soh,
         SUM(COALESCE(v.units_4w,0)) AS units_4w
  FROM (
    SELECT i.sku, SUM(i.available) AS store_soh,
           MAX(p.price) AS price, MAX(p.style_name) AS style_name
    FROM all_inventory i JOIN all_products_clean p ON i.sku=p.sku
    WHERE i.pos_location_name NOT IN ({du.WAREHOUSE_LOCATIONS})
      AND COALESCE(p.brand,'') NOT IN {du.THIRD_PARTY_BRANDS}
    GROUP BY i.sku
  ) s
  JOIN (
    SELECT i.sku, SUM(i.available) AS store_soh FROM all_inventory i
    WHERE i.pos_location_name NOT IN ({du.WAREHOUSE_LOCATIONS})
    GROUP BY i.sku
  ) i_agg ON s.sku = i_agg.sku
  LEFT JOIN (
    SELECT p.sku, SUM(s2.ordered_item_quantity) FILTER (
        WHERE s2.sale_date::date >= CURRENT_DATE - 28) AS units_4w
    FROM all_sales s2 JOIN all_products_clean p ON s2.barcode=p.barcode
    WHERE s2.sale_date::date >= CURRENT_DATE - 28
      AND s2.pos_location_name NOT IN ({du.SALES_EXCLUSIONS})
    GROUP BY p.sku
  ) v ON s.sku = v.sku
  WHERE i_agg.store_soh > 0
  GROUP BY COALESCE(NULLIF(s.style_name,''),s.sku)
) t
"""

_NEWNESS_SQL = f"""
WITH style_first AS (
    SELECT p.style_name,
           MIN(s.sale_date::date) AS first_sale
    FROM all_sales s
    JOIN all_products_clean p ON s.barcode = p.barcode
    WHERE s.pos_location_name NOT IN ({du.SALES_EXCLUSIONS})
      AND COALESCE(p.brand,'') NOT IN {du.THIRD_PARTY_BRANDS}
    GROUP BY p.style_name
),
recent_rev AS (
    SELECT p.style_name,
           SUM(s.total_sales_kes) AS rev_l90d
    FROM all_sales s
    JOIN all_products_clean p ON s.barcode = p.barcode
    WHERE s.sale_date::date >= CURRENT_DATE - 90
      AND s.pos_location_name NOT IN ({du.SALES_EXCLUSIONS})
    GROUP BY p.style_name
)
SELECT
    ROUND(100.0 * SUM(r.rev_l90d) FILTER (WHERE f.first_sale >= CURRENT_DATE - 84)
                / NULLIF(SUM(r.rev_l90d), 0), 1) AS newness_pct
FROM recent_rev r
JOIN style_first f ON r.style_name = f.style_name
"""


def _db_exec(A, sql, params=None):
    if A is not None:
        return A._users_exec(sql, params or [])
    import psycopg2, psycopg2.extras, os
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or [])
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def _run_coaching(api_key: str, kpi: dict, top_risk: list, conn) -> dict:
    dead_stock_value = kpi.get("dead_stock_value") or 0
    zero_sales = kpi.get("zero_sales_28d") or 0
    styles_with_stock = kpi.get("styles_with_stock") or 0
    zero_pct = round(zero_sales / styles_with_stock * 100, 1) if styles_with_stock else 0

    # Split risk board into high/medium
    critical_risk = [r for r in top_risk if r.get("woc", 0) > 26 and r.get("vel_decline_pct", 0) > 40]
    high_risk     = [r for r in top_risk if r not in critical_risk and r.get("woc", 0) > 20]

    risk_rows = "\n".join(
        f"  {'[CRITICAL]' if r in critical_risk else '[HIGH]'} {r.get('style_name','?')}: "
        f"WOC={r.get('woc')}w, velocity decline={r.get('vel_decline_pct')}%%, "
        f"SOH={r.get('soh')} units, stock value KES {r.get('stock_value',0):,.0f}, "
        f"last sold: {str(r.get('last_sale_date','?'))[:10]}"
        for r in top_risk[:12]
    )
    context = (
        f"PRODUCT DESK INTELLIGENCE — {date.today().isoformat()}\n\n"
        f"FLEET KPIs:\n"
        f"  Styles with active stock: {styles_with_stock:,}\n"
        f"  Zero sales in last 28d: {zero_sales:,} ({zero_pct}%% of portfolio — "
        f"{'CRITICAL — >40%% dead' if zero_pct > 40 else 'HIGH — >25%% dead' if zero_pct > 25 else 'normal'})\n"
        f"  Fleet avg weeks-of-cover: {kpi.get('avg_woc')}w\n"
        f"  Dead stock value (0 sales 90d+): KES {dead_stock_value:,.0f}\n"
        f"  Styles flagged for retirement: {kpi.get('flagged_retirement', 0)}\n\n"
        f"MARKDOWN/EXCESS RISK BOARD (sorted by risk score):\n"
        f"{risk_rows or '  No high-risk styles detected'}\n\n"
        f"Analyse product portfolio health. Identify: styles at highest markdown risk "
        f"(long WOC + declining velocity + high stock value), portfolio dead-stock concentration, "
        f"and velocity decay patterns by category if inferable. "
        f"Propose specific actions: which styles to promote/discount/IBT, "
        f"what review the buying team should conduct, and how much capital is at risk."
    )
    return du.call_llm_structured(api_key, context, DESK, "overview", conn)


def ensure_product_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
    finally:
        conn.close()


def register_product_desk_routes(app, A):
    import sys as _sys
    _A = A

    @app.get("/api/product-desk/overview")
    async def product_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            risk_rows = _db_exec(_A, _RISK_SQL)
            kpi_rows  = _db_exec(_A, _KPI_SQL)
            new_rows  = _db_exec(_A, _NEWNESS_SQL)
            kpi = dict(kpi_rows[0]) if kpi_rows else {}
            for k, v in kpi.items():
                if hasattr(v, "__float__"): kpi[k] = float(v)
                elif v is None: kpi[k] = 0
            newness_pct = float(new_rows[0].get("newness_pct") or 0) if new_rows else 0
            kpi["newness_pct"] = newness_pct

            # Coerce risk board
            board = []
            for r in risk_rows:
                row = {k: (float(v) if hasattr(v,"__float__") else v)
                       for k, v in r.items()}
                woc = row.get("woc", 999)
                vdp = max(0, row.get("vel_decline_pct", 0))
                row["risk_score"] = min(100, round((min(woc, 24) / 24) * 50 + (vdp / 100) * 50, 1))
                board.append(row)

            # Auto-flag: styles with WOC > 20 AND declining
            high_risk = [r for r in board if r["woc"] > 20 and r.get("vel_decline_pct", 0) > 30]
            if len(high_risk) >= 3:
                du.auto_flag_issue(conn, DESK, "fleet",
                    f"{len(high_risk)} styles with WOC >20w and declining velocity",
                    f"Top: {', '.join(r['style_name'] for r in high_risk[:3])}",
                    severity="high")

            # Coaching (cached daily)
            coaching = du.get_coaching(conn, DESK)
            if not coaching:
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                coaching = _run_coaching(api_key, kpi, board, conn)
                if coaching.get("note") or coaching.get("structured"):
                    du.save_coaching(conn, DESK, coaching.get("note", ""),
                                     structured=coaching.get("structured"),
                                     model=coaching.get("model", ""),
                                     tokens_used=coaching.get("tokens"))

            issues = du.list_issues(conn, DESK)
            return {"as_of": date.today().isoformat(), "kpis": kpi,
                    "risk_board": board[:30], "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/product-desk/issues")
    async def product_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/product-desk/issues")
    async def product_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            result = du.create_issue(conn, DESK,
                title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"),
                scope_key=body.get("scope_key"))
            return result
        finally: conn.close()

    @app.post("/api/product-desk/issues/{issue_id}/close")
    async def product_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            ok = du.close_issue(conn, issue_id, body.get("closed_by",""))
            return {"ok": ok}
        finally: conn.close()
