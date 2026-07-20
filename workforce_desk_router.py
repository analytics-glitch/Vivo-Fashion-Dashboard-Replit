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
    from datetime import date as _date
    today = _date.today()
    day_of_month = today.day
    days_in_month = 28 if today.month in (2,) else 30 if today.month in (4,6,9,11) else 31
    month_pct = round(day_of_month / days_in_month * 100)
    month_phase = "early month — gaps are still recoverable" if day_of_month <= 10 else \
                  "mid-month — trajectory is now largely locked in" if day_of_month <= 20 else \
                  "end of month — every gap is now permanent"

    branches_sorted = sorted(branches, key=lambda b: b.get("attendance_rate") or 100)
    low_att    = [b for b in branches if (b.get("attendance_rate") or 100) < 75]
    watch_att  = [b for b in branches if 75 <= (b.get("attendance_rate") or 100) < 85]
    low_hrs    = [b for b in branches if (b.get("avg_hours") or 8) < 5]
    zero_staff = [b for b in branches if (b.get("headcount") or 0) == 0]

    # Revenue-per-staff-hour analysis
    rph_values = [b.get("rev_per_staff_hr") for b in branches
                  if b.get("rev_per_staff_hr") and b.get("rev_per_staff_hr") > 0]
    rph_median = sorted(rph_values)[len(rph_values)//2] if rph_values else None
    efficiency_crisis = [b for b in branches
                         if rph_median and (b.get("rev_per_staff_hr") or 0) > 0
                         and b.get("rev_per_staff_hr") < rph_median * 0.5]

    # Country-level aggregation
    by_country: dict = {}
    for b in branches:
        c = b.get("branch_country", "Unknown")
        by_country.setdefault(c, {"att_sum": 0, "n": 0, "rev": 0})
        by_country[c]["att_sum"] += (b.get("attendance_rate") or 0)
        by_country[c]["n"] += 1
        by_country[c]["rev"] += (b.get("net_sales_l28d") or 0)
    country_rows = "\n".join(
        f"  {c}: avg attendance {round(v['att_sum']/v['n'],1)}%%, "
        f"L28D revenue KES {v['rev']:,.0f} across {v['n']} branches"
        for c, v in sorted(by_country.items())
    )

    branch_rows = "\n".join(
        f"  {'[CRITICAL]' if (b.get('attendance_rate') or 100) < 75 else '[WATCH]' if (b.get('attendance_rate') or 100) < 85 else '[OK]'} "
        f"{b.get('branch_name')} ({b.get('branch_country','')}): "
        f"attendance={b.get('attendance_rate')}%, "
        f"headcount={b.get('headcount')}, avg_hrs/day={b.get('avg_hours')}, "
        f"L28D rev=KES {b.get('net_sales_l28d',0):,.0f}, "
        f"rev/staff-hr=KES {b.get('rev_per_staff_hr') or 'n/a'}"
        f"{' ← EFFICIENCY CRISIS (<50% of fleet median)' if rph_median and (b.get('rev_per_staff_hr') or 0) > 0 and b.get('rev_per_staff_hr') < rph_median * 0.5 else ''}"
        for b in branches_sorted[:12]
    )
    context = (
        f"WORKFORCE DESK INTELLIGENCE — {today.isoformat()}\n"
        f"Data window: last 28 days | Today: day {day_of_month}/{days_in_month} ({month_pct}% through month — {month_phase})\n\n"
        f"FLEET KPIs:\n"
        f"  Branches tracked: {kpi.get('branches_tracked')}\n"
        f"  Total staff tracked: {kpi.get('total_staff_tracked')}\n"
        f"  Fleet attendance rate: {kpi.get('fleet_attendance_rate')}% "
        f"(85%+ healthy · 75-85% watch · <75% critical)\n"
        f"  Avg hours per staff per day: {kpi.get('avg_hours_per_day')} "
        f"(normal retail = 7-9h)\n"
        f"  Fleet revenue/staff-hour median: KES {rph_median:,.0f} per hr\n"
        f"  Branches in efficiency crisis (<50%% of fleet median): {len(efficiency_crisis)}\n"
        f"  Branches with ZERO headcount data (possible data gap): {len(zero_staff)}\n\n"
        f"BY COUNTRY:\n{country_rows or '  No country breakdown'}\n\n"
        f"BRANCHES (sorted by attendance, worst → best):\n{branch_rows or '  No branch data'}\n\n"
        f"ATTENDANCE FLAGS:\n"
        f"  Critical (<75%%): {len(low_att)} branches: {', '.join(b['branch_name'] for b in low_att[:5]) or 'none'}\n"
        f"  Watch (75-85%%): {len(watch_att)} branches: {', '.join(b['branch_name'] for b in watch_att[:5]) or 'none'}\n"
        f"  Below 5h avg/day: {len(low_hrs)} branches: {', '.join(b['branch_name'] for b in low_hrs[:5]) or 'none'}\n"
        f"  Efficiency crisis (<50%% fleet median RPH): {', '.join(b['branch_name'] for b in efficiency_crisis[:4]) or 'none'}\n\n"
        f"DATA NOTE: No schedule/rota data. Rev/staff-hr uses fuzzy name matching — treat as directional.\n\n"
        f"Analyse this workforce data through the MANDATORY THINKING SEQUENCE. "
        f"Identify the attendance crisis most likely to hurt sales this month given we are {month_phase}. "
        f"Surface the revenue-per-staff-hour outliers — both the worst-performing branches "
        f"(where the same headcount could generate much more revenue) and the best "
        f"(what are they doing right?). Estimate KES at risk from attendance gaps."
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
