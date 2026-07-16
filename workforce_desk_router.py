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


def _run_coaching(kpi: dict, branches: list) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY","")
    if not api_key:
        return {"note": "AI coaching not configured.", "model": None,
                "generated_for": date.today().isoformat()}
    flagged = [b for b in branches if (b.get("attendance_rate") or 100) < 75
               or (b.get("avg_hours") or 8) < 5]
    snippet = "\n".join(
        f"- {b['branch_name']} ({b.get('branch_country','')}): "
        f"headcount={b.get('headcount')}, avg_hours={b.get('avg_hours')}, "
        f"attendance={b.get('attendance_rate')}%"
        for b in flagged[:8]
    )
    prompt = (
        f"You are a workforce analytics consultant for Vivo Fashion Group, East Africa.\n"
        f"Date: {date.today().isoformat()}\n\n"
        f"Fleet KPIs (last 28 days):\n"
        f"- Branches tracked: {kpi.get('branches_tracked')}\n"
        f"- Fleet attendance rate: {kpi.get('fleet_attendance_rate')}%\n"
        f"- Avg hours/staff/day: {kpi.get('avg_hours_per_day')}\n"
        f"- Total staff tracked: {kpi.get('total_staff_tracked')}\n\n"
        f"Flagged branches (low attendance or hours):\n{snippet or '  None flagged'}\n\n"
        "Write a concise (3–5 sentences) coaching note for leadership. "
        "Focus on coverage risks, patterns, and one clear action. "
        "Note data limitations (no rota data). Plain text only."
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
        log.warning("workforce coaching: %s", e)
        return {"note": "Coaching temporarily unavailable.", "model": None,
                "generated_for": date.today().isoformat()}


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
                coaching = _run_coaching(kpi, branches)
                if coaching.get("note"):
                    du.save_coaching(conn, DESK, coaching["note"],
                                     model=coaching.get("model",""))

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
