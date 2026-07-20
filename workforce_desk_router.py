"""
workforce_desk_router.py — Phase 5: Workforce Desk
Branch-level attendance efficiency, sales-per-labour-hour (approximate), daily AI coaching.
Gate: /api/workforce-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "workforce"

_BRANCH_SQL = f"""
WITH att AS (
    SELECT branch_name, branch_country,
           COUNT(DISTINCT employee_name)                                        AS headcount,
           ROUND(AVG(hours_worked) FILTER (
               WHERE hours_worked BETWEEN 1 AND 14), 1)                        AS avg_hours,
           COUNT(*) FILTER (WHERE LOWER(attendance_status)='present')          AS present_count,
           COUNT(*)                                                             AS total_records,
           ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(attendance_status)='present')
               / NULLIF(COUNT(*), 0), 1)                                       AS attendance_rate
    FROM vivo_attendance
    WHERE attendance_date >= CURRENT_DATE - 28
      AND branch_name IS NOT NULL
      AND LOWER(branch_name) NOT LIKE '%%hq%%'
      AND LOWER(branch_name) NOT LIKE '%%head office%%'
      AND LOWER(branch_name) NOT LIKE '%%warehouse%%'
    GROUP BY branch_name, branch_country
),
sales AS (
    SELECT pos_location_name,
           SUM(total_sales_kes - COALESCE(discount_kes,0) - COALESCE(return_amount_kes,0))
               / 1.16                                                           AS net_sales_l28d,
           COUNT(DISTINCT sale_date::date)                                      AS trading_days
    FROM all_sales
    WHERE sale_date::date >= CURRENT_DATE - 28
      AND pos_location_name NOT IN ({du.SALES_EXCLUSIONS})
      AND pos_location_name NOT ILIKE '%%online%%'
    GROUP BY pos_location_name
)
SELECT a.*,
       s.net_sales_l28d,
       s.trading_days,
       CASE WHEN a.headcount > 0 AND a.avg_hours > 0 AND s.net_sales_l28d > 0
            THEN ROUND(s.net_sales_l28d
                 / (a.headcount::numeric * 28 * COALESCE(a.avg_hours, 7)), 0)
            ELSE NULL END                                                       AS rev_per_staff_hr
FROM att a
LEFT JOIN sales s ON
    -- approximate fuzzy join: normalize common suffixes
    REGEXP_REPLACE(LOWER(a.branch_name), ' (centre|mall|street|plaza|square|towers|avenue)$','','g')
  = REGEXP_REPLACE(LOWER(s.pos_location_name), ' (centre|mall|street|plaza|square|towers|avenue)$','','g')
    OR LOWER(a.branch_name) ILIKE '%%' ||
       SPLIT_PART(LOWER(REGEXP_REPLACE(s.pos_location_name,'Vivo ','','i')), ' ', 1) || '%%'
ORDER BY COALESCE(s.net_sales_l28d, 0) DESC
"""

_KPI_SQL = """
SELECT
    COUNT(DISTINCT branch_name)                                   AS branches_tracked,
    ROUND(AVG(hours_worked) FILTER (WHERE hours_worked BETWEEN 1 AND 14), 1)
                                                                  AS avg_hours_per_day,
    ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(attendance_status)='present')
          / NULLIF(COUNT(*),0), 1)                                AS fleet_attendance_rate,
    COUNT(DISTINCT employee_name)                                 AS total_staff_tracked
FROM vivo_attendance
WHERE attendance_date >= CURRENT_DATE - 28
  AND branch_name IS NOT NULL
"""

_GAPS = [
    ("workforce","rota_scheduling",
     "No shift-rota DB table (data lives in a Google Sheet). "
     "Cannot compute planned-vs-actual staffing or overtime. "
     "Action: export rota to vivo_rota DB table nightly from the HR Google Sheet.",
     "high"),
    ("workforce","per_hour_footfall_staff",
     "Footfall data is daily-grain; attendance punches are timestamped. "
     "Cannot compute optimal staffing by hour. "
     "Action: aggregate footfall to hourly from device-level data.",
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


def _run_coaching(api_key: str, kpi: dict, branches: list, conn) -> dict:
    branches_sorted = sorted(branches, key=lambda b: b.get("attendance_rate") or 100)
    low_att = [b for b in branches if (b.get("attendance_rate") or 100) < 75]
    low_hrs = [b for b in branches if (b.get("avg_hours") or 8) < 5]
    branch_rows = "\n".join(
        f"  - {b.get('branch_name')} ({b.get('branch_country','')}): "
        f"headcount={b.get('headcount')}, avg_hours/day={b.get('avg_hours')}, "
        f"attendance={b.get('attendance_rate')}%, "
        f"rev_L28D=KES {b.get('net_sales_l28d',0):,.0f}, "
        f"rev/staff-hr={b.get('rev_per_staff_hr') or 'n/a'}"
        for b in branches_sorted[:12]
    )
    context = (
        f"WORKFORCE DESK INTELLIGENCE — {date.today().isoformat()}\n"
        f"Data window: last 28 days\n\n"
        f"FLEET KPIs:\n"
        f"  Branches tracked: {kpi.get('branches_tracked')}\n"
        f"  Fleet attendance rate: {kpi.get('fleet_attendance_rate')}% "
        f"(threshold: 85% healthy, <75% critical)\n"
        f"  Avg hours per staff per day: {kpi.get('avg_hours_per_day')} "
        f"(normal retail = 7–9h)\n"
        f"  Total staff tracked: {kpi.get('total_staff_tracked')}\n\n"
        f"BRANCHES (sorted by attendance, worst first):\n{branch_rows or '  No branch data'}\n\n"
        f"FLAGS:\n"
        f"  Below 75%% attendance: {len(low_att)} branches — {', '.join(b['branch_name'] for b in low_att[:5])}\n"
        f"  Below 5h avg/day: {len(low_hrs)} branches — {', '.join(b['branch_name'] for b in low_hrs[:5])}\n\n"
        f"DATA LIMITATIONS: No rota/schedule data. Rev/staff-hr is approximate (fuzzy name matching).\n\n"
        f"Analyse this workforce data. Identify attendance risks, staffing efficiency gaps, "
        f"and revenue-per-hour outliers (both high potential and underperformers). "
        f"Propose concrete actions for leadership."
    )
    return du.call_llm_structured(api_key, context, DESK, "overview", conn)


def ensure_workforce_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
        for domain, gap_name, details, impact in _GAPS:
            du.register_gap(conn, domain, gap_name, details, impact)
    finally:
        conn.close()


def register_workforce_desk_routes(app, A):
    _A = A

    @app.get("/api/workforce-desk/overview")
    async def workforce_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            branches_raw = _db_exec(_A, _BRANCH_SQL)
            kpi_raw = _db_exec(_A, _KPI_SQL)
            kpi = {}
            if kpi_raw:
                for k, v in kpi_raw[0].items():
                    kpi[k] = float(v) if hasattr(v, "__float__") else (v or 0)
            branches = []
            for b in branches_raw:
                row = {k: (float(v) if hasattr(v,"__float__") else v)
                       for k, v in b.items() if v is not None}
                branches.append(row)

            # Auto-flag branches with very low attendance
            bad = [b for b in branches if (b.get("attendance_rate") or 100) < 70]
            if bad:
                du.auto_flag_issue(conn, DESK, "fleet",
                    f"{len(bad)} branches below 70%% attendance (L28D)",
                    "Branches: " + ", ".join(b["branch_name"] for b in bad[:5]),
                    severity="high")

            coaching = du.get_coaching(conn, DESK)
            if not coaching:
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                coaching = _run_coaching(api_key, kpi, branches, conn)
                if coaching.get("note") or coaching.get("structured"):
                    du.save_coaching(conn, DESK, coaching.get("note", ""),
                                     structured=coaching.get("structured"),
                                     model=coaching.get("model", ""))

            issues = du.list_issues(conn, DESK)
            gaps = [{"domain": g[0], "gap_name": g[1], "details": g[2],
                     "impact": g[3]} for g in _GAPS]
            return {"as_of": date.today().isoformat(), "kpis": kpi,
                    "branches": branches, "gaps": gaps,
                    "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/workforce-desk/issues")
    async def workforce_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/workforce-desk/issues")
    async def workforce_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return du.create_issue(conn, DESK, title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"))
        finally: conn.close()

    @app.post("/api/workforce-desk/issues/{issue_id}/close")
    async def workforce_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
