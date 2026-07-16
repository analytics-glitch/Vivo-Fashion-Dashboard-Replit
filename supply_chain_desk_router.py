"""
supply_chain_desk_router.py — Phase 8: Supply Chain Desk
Fabric PO performance, supplier on-time rates, overdue POs, fabric stock coverage.
Gate: /api/supply-chain-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "supply_chain"

_KPI_SQL = """
SELECT
    COUNT(DISTINCT po_name)                                               AS total_pos,
    COUNT(DISTINCT supplier)                                              AS total_suppliers,
    ROUND(SUM(total_value))                                               AS total_value_kes,
    COUNT(*) FILTER (WHERE state NOT IN ('done','cancel')
                       AND date_planned < CURRENT_DATE
                       AND qty_received < qty_ordered)                    AS overdue_lines,
    COUNT(DISTINCT po_name) FILTER (
        WHERE state NOT IN ('done','cancel')
          AND date_planned < CURRENT_DATE)                                AS overdue_pos,
    ROUND(100.0 * SUM(qty_received) FILTER (WHERE qty_ordered > 0)
          / NULLIF(SUM(qty_ordered), 0), 1)                               AS receipt_fill_rate,
    ROUND(SUM(total_value) FILTER (WHERE state NOT IN ('done','cancel'))) AS open_po_value
FROM raw_fabric_purchase_orders
"""

_SUPPLIER_SQL = """
SELECT supplier,
       COUNT(DISTINCT po_name)                             AS pos,
       ROUND(SUM(total_value))                            AS total_value,
       ROUND(SUM(qty_ordered))                            AS qty_ordered,
       ROUND(SUM(qty_received))                           AS qty_received,
       ROUND(100.0 * SUM(qty_received)
             / NULLIF(SUM(qty_ordered), 0), 1)            AS fill_rate,
       COUNT(*) FILTER (WHERE state NOT IN ('done','cancel')
                          AND date_planned < CURRENT_DATE
                          AND qty_received < qty_ordered)  AS overdue_lines,
       MAX(order_date)                                    AS last_order_date
FROM raw_fabric_purchase_orders
WHERE supplier IS NOT NULL
GROUP BY supplier
ORDER BY total_value DESC
LIMIT 20
"""

_OVERDUE_SQL = """
SELECT po_name, supplier, product_name,
       ROUND(qty_ordered)  AS qty_ordered,
       ROUND(qty_received) AS qty_received,
       ROUND(total_value)  AS total_value,
       date_planned,
       (CURRENT_DATE - date_planned) AS days_overdue,
       state
FROM raw_fabric_purchase_orders
WHERE state NOT IN ('done','cancel')
  AND date_planned < CURRENT_DATE
  AND qty_received < qty_ordered
ORDER BY days_overdue DESC, total_value DESC
LIMIT 30
"""

_FABRIC_STOCK_SQL = """
SELECT
    COUNT(*) FILTER (WHERE available > 0)    AS fabric_skus_in_stock,
    ROUND(SUM(available) FILTER (
        WHERE available > 0))                AS total_available_units,
    ROUND(SUM(on_hand))                      AS total_on_hand
FROM all_inventory
WHERE pos_location_name ILIKE '%%warehouse%%'
   OR pos_location_name ILIKE '%%raw%%'
   OR pos_location_name ILIKE '%%fabric%%'
"""

_GAPS = [
    ("supply_chain","supplier_lead_time_standards",
     "No agreed lead-time standards per supplier in DB. "
     "Can't compute on-time delivery rate (only fill rate). "
     "Action: buying team to capture agreed lead times in Odoo vendor master or a lead_time_standards table.",
     "high"),
    ("supply_chain","customs_freight_data",
     "No customs clearance or freight cost data in DB. "
     "Action: create a shipment_tracking table fed from freight forwarder API or manual entry.",
     "medium"),
    ("supply_chain","quality_inspection_results",
     "No incoming QC/inspection pass-fail results in DB. "
     "Action: capture QC results in a fabric_qc_results table at goods receipt.",
     "medium"),
    ("supply_chain","reorder_point_standards",
     "No formal reorder points or safety stock levels defined in DB. "
     "Action: buying team to populate reorder_points table per fabric SKU.",
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
        f"- {r.get('po_name')} / {r.get('supplier')}: {r.get('days_overdue')} days overdue,"
        f" KES {r.get('total_value','0'):,}"
        for r in worst
    )
    gap_list = ", ".join(g["gap_name"] for g in gaps[:3])
    prompt = (
        f"You are a supply chain analyst for Vivo Fashion Group, East Africa.\n"
        f"Date: {date.today().isoformat()}\n\n"
        f"Fabric PO fleet KPIs:\n"
        f"- Total POs: {kpi.get('total_pos')}, Suppliers: {kpi.get('total_suppliers')}\n"
        f"- Total value: KES {kpi.get('total_value_kes','0'):,}\n"
        f"- Open PO value: KES {kpi.get('open_po_value','0'):,}\n"
        f"- Overdue POs: {kpi.get('overdue_pos')}\n"
        f"- Receipt fill rate: {kpi.get('receipt_fill_rate')}%%\n\n"
        f"Top overdue POs:\n{ov_str or '  None overdue'}\n\n"
        f"Key data gaps: {gap_list}\n\n"
        "Write a concise (3–5 sentences) coaching note for leadership. "
        "Highlight supply risk, suggest one procurement action, and name the most urgent data gap. "
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
        log.warning("supply-chain coaching: %s", e)
        return {"note": "Coaching temporarily unavailable.", "model": None,
                "generated_for": date.today().isoformat()}


def ensure_supply_chain_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
        for domain, gap_name, details, impact in _GAPS:
            du.register_gap(conn, domain, gap_name, details, impact)
    finally:
        conn.close()


def register_supply_chain_desk_routes(app, A):
    _A = A

    @app.get("/api/supply-chain-desk/overview")
    async def supply_chain_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            kpi_raw = _db_exec(_A, _KPI_SQL)
            supplier_raw = _db_exec(_A, _SUPPLIER_SQL)
            overdue_raw = _db_exec(_A, _OVERDUE_SQL)

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

            # Auto-flag if >5 overdue POs
            if kpi.get("overdue_pos", 0) > 5:
                du.auto_flag_issue(conn, DESK, "fleet",
                    f"{int(kpi['overdue_pos'])} overdue fabric POs",
                    f"Open value at risk: KES {int(kpi.get('open_po_value',0)):,}. "
                    "Chase suppliers and update ETA in Odoo.",
                    severity="high" if kpi["overdue_pos"] > 10 else "medium")

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
                    "suppliers": _c(supplier_raw), "overdue": overdue,
                    "gaps": gaps, "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/supply-chain-desk/issues")
    async def sc_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/supply-chain-desk/issues")
    async def sc_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return du.create_issue(conn, DESK, title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"))
        finally: conn.close()

    @app.post("/api/supply-chain-desk/issues/{issue_id}/close")
    async def sc_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
