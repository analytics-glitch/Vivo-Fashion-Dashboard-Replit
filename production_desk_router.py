"""
production_desk_router.py — Phase 9: Production (Garment) Desk
Buying order pipeline, overdue orders, by-buyer breakdown, data gap register.
Gate: /api/production-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "production_garment"

_KPI_SQL = """
SELECT
    COUNT(*)                                                        AS total_orders,
    COUNT(*) FILTER (WHERE expected_delivery_date >= CURRENT_DATE)  AS active_orders,
    COUNT(*) FILTER (WHERE expected_delivery_date < CURRENT_DATE)   AS overdue_orders,
    COUNT(*) FILTER (WHERE expected_delivery_date
                     BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)    AS due_next_30d,
    ROUND(SUM(order_qty))                                           AS total_units,
    ROUND(SUM(order_qty) FILTER (
        WHERE expected_delivery_date < CURRENT_DATE))               AS overdue_units,
    COUNT(DISTINCT supplier) FILTER (
        WHERE supplier IS NOT NULL)                                  AS suppliers,
    COUNT(DISTINCT buyer) FILTER (WHERE buyer IS NOT NULL)          AS buyers
FROM production_orders
WHERE date_ordered >= CURRENT_DATE - INTERVAL '18 months'
"""

_BUYER_SQL = """
SELECT COALESCE(buyer, 'Unassigned')     AS buyer,
       COUNT(*)                          AS orders,
       ROUND(SUM(order_qty))             AS total_units,
       COUNT(*) FILTER (
           WHERE expected_delivery_date < CURRENT_DATE) AS overdue,
       MIN(expected_delivery_date)       AS earliest_due
FROM production_orders
WHERE date_ordered >= CURRENT_DATE - INTERVAL '18 months'
GROUP BY buyer
ORDER BY overdue DESC, total_units DESC
"""

_STATE_SQL = """
SELECT COALESCE(bo_state, 'unknown')    AS state,
       COUNT(*)                         AS orders,
       ROUND(SUM(order_qty))            AS units
FROM production_orders
WHERE date_ordered >= CURRENT_DATE - INTERVAL '18 months'
GROUP BY bo_state
ORDER BY units DESC
"""

_OVERDUE_SQL = """
SELECT order_ref, buyer, style_name, product_name,
       ROUND(order_qty)                     AS order_qty,
       date_ordered,
       expected_delivery_date,
       (CURRENT_DATE - expected_delivery_date) AS days_overdue,
       bo_state, production_type
FROM production_orders
WHERE expected_delivery_date < CURRENT_DATE
  AND date_ordered >= CURRENT_DATE - INTERVAL '18 months'
ORDER BY days_overdue DESC
LIMIT 30
"""

_UPCOMING_SQL = """
SELECT order_ref, buyer, style_name, product_name,
       ROUND(order_qty)      AS order_qty,
       expected_delivery_date,
       bo_state
FROM production_orders
WHERE expected_delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
ORDER BY expected_delivery_date
LIMIT 20
"""

_GAPS = [
    ("garment_production","machine_utilization",
     "No factory machine utilization or throughput data. "
     "Action: factory floor to log machine on/off + garments-per-hour via a simple Google Form or IoT counter.",
     "high"),
    ("garment_production","cutting_room_throughput",
     "No cutting room throughput (pieces cut per day) in DB. "
     "Action: cutting supervisor to log daily cut count to a cutting_room_log sheet.",
     "high"),
    ("garment_production","qc_pass_rates",
     "No QC inspection pass/fail rates tracked per order. "
     "Action: QC team to record pass/fail counts per order in production_qc_results table.",
     "high"),
    ("garment_production","sewing_line_efficiency",
     "No sewing line efficiency or SAM data. "
     "Action: production manager to capture daily efficiency % per line.",
     "medium"),
    ("garment_production","actual_completion_date",
     "production_orders has no actual_completion_date column. "
     "Cannot compute true on-time rate. "
     "Action: sync Odoo MRP mrp.production.date_finished to production_orders.",
     "high"),
    ("garment_production","fabric_consumed_vs_planned",
     "No actual fabric consumption vs BOM standard comparison at order level. "
     "Action: sync mrp.production.move_raw_ids qty_done vs product_qty.",
     "medium"),
]


def _db_exec(A, sql, params=None):
    if A is not None:
        return A._users_exec(sql, params or [])
    import psycopg2, psycopg2.extras
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or [])
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def _run_coaching(kpi: dict, overdue: list, gaps: list) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY","")
    if not api_key:
        return {"note": "AI coaching not configured.", "model": None,
                "generated_for": date.today().isoformat()}
    worst = overdue[:5]
    ov_str = "\n".join(
        f"- {r.get('style_name') or r.get('order_ref')}: "
        f"{r.get('days_overdue')} days overdue, {r.get('order_qty')} units, buyer={r.get('buyer')}"
        for r in worst
    )
    gap_list = ", ".join(g["gap_name"] for g in gaps[:3])
    prompt = (
        f"You are a garment production analyst for Vivo Fashion Group, East Africa.\n"
        f"Date: {date.today().isoformat()}\n\n"
        f"Production order pipeline:\n"
        f"- Total orders (18m): {kpi.get('total_orders')}\n"
        f"- Active (due future): {kpi.get('active_orders')}\n"
        f"- Overdue: {kpi.get('overdue_orders')} ({kpi.get('overdue_units')} units)\n"
        f"- Due next 30d: {kpi.get('due_next_30d')}\n"
        f"- Buyers tracked: {kpi.get('buyers')}\n\n"
        f"Top overdue orders:\n{ov_str or '  None overdue'}\n\n"
        f"Key data gaps: {gap_list}\n\n"
        "Write a concise (3–5 sentences) coaching note for leadership. "
        "Focus on production risk, buyer accountability, and one data gap to close. "
        "Plain text only."
    )
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-haiku-4-5", "max_tokens": 300,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=30,
        )
        data = resp.json()
        note = data.get("content",[{}])[0].get("text","Coaching unavailable.")
        return {"note": note, "model": "claude-haiku-4-5",
                "generated_for": date.today().isoformat()}
    except Exception as e:
        log.warning("production coaching: %s", e)
        return {"note": "Coaching temporarily unavailable.", "model": None,
                "generated_for": date.today().isoformat()}


def ensure_production_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
        for domain, gap_name, details, impact in _GAPS:
            du.register_gap(conn, domain, gap_name, details, impact)
    finally:
        conn.close()


def register_production_desk_routes(app, A):
    _A = A

    @app.get("/api/production-desk/overview")
    async def production_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            kpi_raw = _db_exec(_A, _KPI_SQL)
            buyer_raw = _db_exec(_A, _BUYER_SQL)
            state_raw = _db_exec(_A, _STATE_SQL)
            overdue_raw = _db_exec(_A, _OVERDUE_SQL)
            upcoming_raw = _db_exec(_A, _UPCOMING_SQL)

            def _c(rows):
                out = []
                for r in rows:
                    out.append({k: (float(v) if hasattr(v,"__float__") else
                                    (v.isoformat() if hasattr(v,"isoformat") else v))
                                for k, v in r.items() if v is not None})
                return out

            kpi = {}
            if kpi_raw:
                for k, v in kpi_raw[0].items():
                    kpi[k] = float(v) if hasattr(v,"__float__") else (v or 0)

            overdue = _c(overdue_raw)

            # Auto-flag if >10 overdue orders
            if kpi.get("overdue_orders", 0) > 10:
                du.auto_flag_issue(conn, DESK, "fleet",
                    f"{int(kpi['overdue_orders'])} overdue production orders",
                    f"Total overdue units: {int(kpi.get('overdue_units',0))}. "
                    "Review with buyers and update expected delivery dates in Odoo.",
                    severity="high" if kpi["overdue_orders"] > 20 else "medium")

            gaps = [{"domain": g[0], "gap_name": g[1], "details": g[2],
                     "impact": g[3]} for g in _GAPS]

            coaching = du.get_coaching(conn, DESK)
            if not coaching:
                coaching = _run_coaching(kpi, overdue, gaps)
                if coaching.get("note"):
                    du.save_coaching(conn, DESK, coaching["note"],
                                     model=coaching.get("model",""))

            issues = du.list_issues(conn, DESK)
            return {"as_of": date.today().isoformat(), "kpis": kpi,
                    "by_buyer": _c(buyer_raw), "by_state": _c(state_raw),
                    "overdue": overdue, "upcoming": _c(upcoming_raw),
                    "gaps": gaps, "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/production-desk/issues")
    async def production_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/production-desk/issues")
    async def production_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return du.create_issue(conn, DESK, title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"))
        finally: conn.close()

    @app.post("/api/production-desk/issues/{issue_id}/close")
    async def production_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
