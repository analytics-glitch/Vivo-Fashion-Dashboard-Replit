"""
customer_desk_router.py — Phase 6: Customer Desk
Cohort retention, repeat rate, CLV, reactivation, loyalty health, daily AI coaching.
Gate: /api/customer-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "customer"

_NOT_WALKIN = (
    "LOWER(customer_type) IN ('new','returning','registered')"
)

_KPI_SQL = f"""
SELECT
    COUNT(*)                                                          AS total_customers,
    COUNT(*) FILTER (WHERE total_orders >= 2)                        AS repeat_customers,
    ROUND(100.0 * COUNT(*) FILTER (WHERE total_orders >= 2)
          / NULLIF(COUNT(*), 0), 1)                                  AS repeat_rate,
    ROUND(AVG(total_spend_kes))                                      AS avg_clv,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_spend_kes))
                                                                      AS median_clv,
    COUNT(*) FILTER (WHERE last_order_date::date < CURRENT_DATE - 90)
                                                                      AS churned_90d,
    COUNT(*) FILTER (WHERE last_order_date::date >= CURRENT_DATE - 30
                       AND (first_order_date::date) <= CURRENT_DATE - 91)
                                                                      AS reactivated_30d,
    COUNT(*) FILTER (WHERE first_order_date::date >= CURRENT_DATE - 30)
                                                                      AS new_30d
FROM all_customers
WHERE {_NOT_WALKIN}
"""

_COHORT_SQL = f"""
WITH monthly AS (
    SELECT DATE_TRUNC('month', first_order_date::date) AS cohort_month,
           COUNT(*)                                     AS cohort_size,
           COUNT(*) FILTER (WHERE total_orders >= 2)    AS returned_at_least_once,
           ROUND(AVG(total_spend_kes))                  AS avg_spend
    FROM all_customers
    WHERE {_NOT_WALKIN}
      AND first_order_date IS NOT NULL
      AND first_order_date::date >= CURRENT_DATE - INTERVAL '12 months'
    GROUP BY 1
)
SELECT TO_CHAR(cohort_month,'Mon YYYY') AS label,
       cohort_size, returned_at_least_once, avg_spend,
       ROUND(100.0 * returned_at_least_once / NULLIF(cohort_size, 0), 1) AS retention_pct
FROM monthly
ORDER BY cohort_month
"""

_CLV_BANDS_SQL = f"""
SELECT
    CASE
        WHEN total_spend_kes < 5000  THEN '< KES 5k'
        WHEN total_spend_kes < 20000 THEN 'KES 5k–20k'
        WHEN total_spend_kes < 50000 THEN 'KES 20k–50k'
        WHEN total_spend_kes < 100000 THEN 'KES 50k–100k'
        ELSE 'KES 100k+'
    END AS band,
    COUNT(*) AS customers,
    ROUND(AVG(total_spend_kes))   AS avg_spend,
    ROUND(SUM(total_spend_kes))   AS total_spend
FROM all_customers
WHERE {_NOT_WALKIN}
GROUP BY 1
ORDER BY MIN(total_spend_kes)
"""

_COUNTRY_SQL = f"""
SELECT country,
       COUNT(*) AS customers,
       ROUND(AVG(total_spend_kes)) AS avg_clv,
       ROUND(SUM(total_spend_kes)) AS total_spend
FROM all_customers
WHERE {_NOT_WALKIN} AND country IS NOT NULL
GROUP BY country
ORDER BY total_spend DESC
"""

_LOYALTY_SQL = """
SELECT COUNT(*) AS members,
       ROUND(AVG(spend_kes)) AS avg_spend,
       COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE - 30) AS active_30d
FROM crm_loyalty_member
"""

_GAPS = [
    ("customer","email_open_rates",
     "No email campaign send/open/click data in DB. Cannot measure campaign reach. "
     "Action: integrate Mailchimp/Klaviyo send metrics into crm_campaign_messages.",
     "high"),
    ("customer","nps_csat_scores",
     "No NPS or CSAT survey results captured. "
     "Action: set up post-purchase survey and sync results to a crm_survey_responses table.",
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


def _run_coaching(api_key: str, kpi: dict, cohort: list, bands: list,
                   by_country: list, loyalty: dict, conn) -> dict:
    repeat_rate = kpi.get("repeat_rate", 0) or 0
    churned     = kpi.get("churned_90d", 0) or 0
    reactivated = kpi.get("reactivated_30d", 0) or 0
    reactivation_rate = round(reactivated / churned * 100, 1) if churned > 0 else 0

    # Cohort retention trend: compare oldest vs newest cohorts
    cohort_sorted = sorted(cohort or [], key=lambda c: c.get("cohort_month", ""))
    cohort_oldest = cohort_sorted[:2]
    cohort_newest = cohort_sorted[-2:]
    oldest_ret  = sum(c.get("repeat_rate_pct") or 0 for c in cohort_oldest) / max(len(cohort_oldest), 1)
    newest_ret  = sum(c.get("repeat_rate_pct") or 0 for c in cohort_newest) / max(len(cohort_newest), 1)
    ret_trend   = "IMPROVING" if newest_ret > oldest_ret + 2 else \
                  "DECLINING" if oldest_ret > newest_ret + 2 else "FLAT"

    cohort_rows = "\n".join(
        f"  {c.get('cohort_month','?')}: {c.get('customers_acquired',0):,} acquired · "
        f"repeat rate {c.get('repeat_rate_pct')}%% · "
        f"avg CLV KES {c.get('avg_clv',0):,.0f}"
        for c in (cohort or [])[-6:]
    )
    # CLV band analysis
    total_customers = sum(b.get("customer_count") or 0 for b in (bands or []))
    band_rows = "\n".join(
        f"  {b.get('band','?')}: {b.get('customer_count',0):,} customers "
        f"({b.get('pct_of_total')}%% of base) · avg CLV KES {b.get('avg_clv',0):,.0f} · "
        f"total CLV KES {(b.get('customer_count') or 0) * (b.get('avg_clv') or 0):,.0f}"
        for b in (bands or [])
    )
    # Top-decile KES concentration (highest CLV band)
    top_band = max((bands or []), key=lambda b: b.get("avg_clv") or 0, default=None)
    top_band_kes = ((top_band.get("customer_count") or 0) * (top_band.get("avg_clv") or 0)) if top_band else 0

    country_rows = "\n".join(
        f"  {c.get('country','?')}: {c.get('customers',0):,} customers · "
        f"repeat {c.get('repeat_rate')}%% · avg CLV KES {c.get('avg_clv',0):,.0f}"
        for c in (by_country or [])
    )
    loyalty_eng_rate = round(
        (loyalty.get("active_30d") or 0) / (loyalty.get("total_members") or 1) * 100, 1
    )
    loyalty_eng_status = "HEALTHY (>30%%)" if loyalty_eng_rate > 30 else \
                         "WATCH (15-30%%)" if loyalty_eng_rate > 15 else "RISK (<15%%)"
    context = (
        f"CUSTOMER DESK INTELLIGENCE — {date.today().isoformat()}\n\n"
        f"BASE KPIs (all-time identified customer base):\n"
        f"  Total identified customers: {kpi.get('total_customers',0):,}\n"
        f"  Repeat rate (>=2 orders): {repeat_rate}%% "
        f"({'HEALTHY >30%%' if repeat_rate > 30 else 'WATCH 20-30%%' if repeat_rate > 20 else 'CRISIS <20%%'})\n"
        f"  Avg CLV: KES {kpi.get('avg_clv',0):,.0f} · Median CLV: KES {kpi.get('median_clv',0):,.0f}\n"
        f"  Churned (no purchase 90d+): {churned:,} customers\n"
        f"  Reactivated last 30d: {reactivated:,} ({reactivation_rate}%% win-back rate)\n"
        f"  New customers last 30d: {kpi.get('new_30d',0):,}\n\n"
        f"COHORT RETENTION TREND: {ret_trend}\n"
        f"  Oldest cohorts avg repeat rate: {oldest_ret:.1f}%%\n"
        f"  Newest cohorts avg repeat rate: {newest_ret:.1f}%%\n"
        f"  Direction: {'retention is IMPROVING — new acquisition quality is rising' if ret_trend=='IMPROVING' else 'retention is DECLINING — newer customers are lower quality or less engaged' if ret_trend=='DECLINING' else 'retention is FLAT — no improvement trend'}\n\n"
        f"COHORT DETAIL (last 6 cohorts, most recent first):\n{cohort_rows or '  No cohort data'}\n\n"
        f"CLV BANDS (wealth concentration):\n{band_rows or '  No band data'}\n"
        f"  → Top CLV band total value: KES {top_band_kes:,.0f} "
        f"({'HIGH concentration risk — if top band churns, revenue impact is severe' if top_band and (top_band.get('pct_of_total') or 0) < 15 else 'distributed base'})\n\n"
        f"BY COUNTRY:\n{country_rows or '  No country data'}\n\n"
        f"LOYALTY PROGRAMME:\n"
        f"  Total members: {loyalty.get('total_members',0):,} · "
        f"Active 30d: {loyalty.get('active_30d',0):,} ({loyalty_eng_rate}%% engagement — {loyalty_eng_status}) · "
        f"New 30d: {loyalty.get('new_30d',0):,}\n"
        f"  Benchmark: 30%%+ engagement is healthy; enrolment growth >5%%/month is strong\n\n"
        f"CONTEXT: The ~97%% raw churn rate reflects a largely historical one-time-buyer dataset — "
        f"focus on the DIRECTION of cohort retention and the reactivation rate, not the absolute churn figure.\n\n"
        f"Apply the MANDATORY THINKING SEQUENCE. Surface: the cohort trend signal (improving or decaying, "
        f"and what this implies for revenue 6 months out), the CLV concentration risk "
        f"(what happens if top-band customers churn?), and the most actionable reactivation opportunity."
    )
    return du.call_llm_structured(api_key, context, DESK, "overview", conn)


def ensure_customer_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
        for domain, gap_name, details, impact in _GAPS:
            du.register_gap(conn, domain, gap_name, details, impact)
    finally:
        conn.close()


def register_customer_desk_routes(app, A):
    _A = A

    @app.get("/api/customer-desk/overview")
    async def customer_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            kpi_raw = _db_exec(_A, _KPI_SQL)
            cohort_raw = _db_exec(_A, _COHORT_SQL)
            bands_raw = _db_exec(_A, _CLV_BANDS_SQL)
            country_raw = _db_exec(_A, _COUNTRY_SQL)
            loyalty_raw = _db_exec(_A, _LOYALTY_SQL)

            kpi = {}
            if kpi_raw:
                for k, v in kpi_raw[0].items():
                    kpi[k] = float(v) if hasattr(v,"__float__") else (v or 0)

            def _coerce(rows):
                out = []
                for r in rows:
                    out.append({k: (float(v) if hasattr(v,"__float__") else v)
                                for k, v in r.items() if v is not None})
                return out

            # Auto-flag if repeat rate < 20%
            if kpi.get("repeat_rate", 100) < 20:
                du.auto_flag_issue(conn, DESK, "fleet",
                    f"Repeat purchase rate low at {kpi.get('repeat_rate')}%",
                    "Consider loyalty activation or win-back campaign.",
                    severity="high")

            loyalty = {}
            if loyalty_raw:
                for k, v in loyalty_raw[0].items():
                    loyalty[k] = float(v) if hasattr(v,"__float__") else (v or 0)

            coaching = du.get_coaching(conn, DESK)
            if not coaching:
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                coaching = _run_coaching(api_key, kpi,
                                         _coerce(cohort_raw), _coerce(bands_raw),
                                         _coerce(country_raw), loyalty, conn)
                if coaching.get("note") or coaching.get("structured"):
                    du.save_coaching(conn, DESK, coaching.get("note", ""),
                                     structured=coaching.get("structured"),
                                     model=coaching.get("model", ""))

            issues = du.list_issues(conn, DESK)
            gaps = [{"domain": g[0], "gap_name": g[1], "details": g[2],
                     "impact": g[3]} for g in _GAPS]
            return {"as_of": date.today().isoformat(), "kpis": kpi,
                    "cohort": _coerce(cohort_raw), "clv_bands": _coerce(bands_raw),
                    "by_country": _coerce(country_raw), "loyalty": loyalty,
                    "gaps": gaps, "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/customer-desk/issues")
    async def customer_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/customer-desk/issues")
    async def customer_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return du.create_issue(conn, DESK, title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"))
        finally: conn.close()

    @app.get("/api/customer-desk/report/latest")
    async def customer_desk_report_latest():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            result = du.get_latest_report(conn, DESK)
            return result or {"report": None}
        finally:
            conn.close()

    @app.post("/api/customer-desk/report")
    async def customer_desk_report_generate(request):
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            ctx = du.get_latest_coaching_context(conn, DESK)
            if not ctx:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    {"error": "No coaching context yet. Open the Customer Desk overview first."},
                    status_code=400)
            user = getattr(request.state, "user", {}) or {}
            return du.generate_report(api_key, ctx, DESK, conn,
                                       generated_by=user.get("email", "system"))
        finally:
            conn.close()

    @app.post("/api/customer-desk/issues/{issue_id}/close")
    async def customer_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
