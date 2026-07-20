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


def _run_coaching(api_key: str, kpi: dict, overdue: list, gaps: list,
                   suppliers_raw: list, conn) -> dict:
    overdue_sorted = sorted(overdue, key=lambda r: r.get("days_overdue") or 0, reverse=True)
    ov_rows = "\n".join(
        f"  - {r.get('po_name','?')} / {r.get('supplier','?')}: "
        f"{r.get('days_overdue')} days overdue, value KES {r.get('total_value',0):,.0f}, "
        f"fabric: {r.get('fabric_name','?')}, status: {r.get('status','?')}"
        for r in overdue_sorted[:8]
    )
    supplier_rows = "\n".join(
        f"  - {s.get('supplier','?')}: {s.get('total_pos',0)} POs, "
        f"KES {s.get('total_value',0):,.0f} value, "
        f"overdue: {s.get('overdue_pos',0)}, fill rate: {s.get('fill_rate','n/a')}%%"
        for s in (suppliers_raw or [])[:6]
    )
    overdue_count = kpi.get("overdue_pos") or len(overdue)
    fill_rate = kpi.get("receipt_fill_rate") or 0
    open_value = kpi.get("open_po_value") or 0
    top_gaps = [g["gap_name"].replace("_", " ") for g in gaps[:3]]
    context = (
        f"SUPPLY CHAIN DESK INTELLIGENCE — {date.today().isoformat()}\n\n"
        f"FABRIC PO FLEET KPIs:\n"
        f"  Total POs tracked: {kpi.get('total_pos',0)}\n"
        f"  Total suppliers: {kpi.get('total_suppliers',0)}\n"
        f"  Total PO value: KES {kpi.get('total_value_kes',0):,.0f}\n"
        f"  Open PO value: KES {open_value:,.0f}\n"
        f"  Overdue POs: {overdue_count} "
        f"({'CRITICAL — >15 overdue' if overdue_count > 15 else 'HIGH — >5 overdue' if overdue_count > 5 else 'normal'})\n"
        f"  Receipt fill rate: {fill_rate}%% "
        f"({'LOW — production risk' if fill_rate < 70 else 'acceptable' if fill_rate < 90 else 'healthy'})\n\n"
        f"TOP OVERDUE POs (by days overdue):\n{ov_rows or '  None overdue — all POs on schedule'}\n\n"
        f"SUPPLIER PERFORMANCE:\n{supplier_rows or '  No supplier breakdown available'}\n\n"
        f"KEY DATA GAPS: {', '.join(top_gaps) if top_gaps else 'None'}\n\n"
        f"Analyse supply chain risk comprehensively. Identify: fabric delivery risks threatening "
        f"production deadlines, supplier concentration risks, fill rate deterioration. "
        f"Propose specific escalation actions with named suppliers and timelines. "
        f"Flag if any single supplier accounts for >30%% of open value."
    )
    return du.call_llm_structured(api_key, context, DESK, "overview", conn)


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
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                coaching = _run_coaching(api_key, kpi, overdue, gaps,
                                         _c(supplier_raw), conn)
                if coaching.get("note") or coaching.get("structured"):
                    du.save_coaching(conn, DESK, coaching.get("note", ""),
                                     structured=coaching.get("structured"),
                                     model=coaching.get("model", ""))

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
