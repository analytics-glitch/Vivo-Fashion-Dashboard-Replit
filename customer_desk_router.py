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


def _run_coaching(kpi: dict) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY","")
    if not api_key:
        return {"note": "AI coaching not configured.", "model": None,
                "generated_for": date.today().isoformat()}
    prompt = (
        f"You are a customer analytics expert for Vivo Fashion Group, East Africa.\n"
        f"Date: {date.today().isoformat()}\n\n"
        f"Customer base KPIs:\n"
        f"- Total identified customers: {kpi.get('total_customers')}\n"
        f"- Repeat rate (≥2 orders): {kpi.get('repeat_rate')}%\n"
        f"- Avg CLV: KES {kpi.get('avg_clv','0'):,}\n"
        f"- Median CLV: KES {kpi.get('median_clv','0'):,}\n"
        f"- Churned (no purchase 90d+): {kpi.get('churned_90d')}\n"
        f"- Reactivated last 30d: {kpi.get('reactivated_30d')}\n"
        f"- New customers last 30d: {kpi.get('new_30d')}\n\n"
        "Write a concise (3–5 sentences) coaching note for leadership. "
        "Focus on retention health, CLV growth opportunities, and one clear action. "
        "Plain text only, no markdown."
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
        log.warning("customer coaching: %s", e)
        return {"note": "Coaching temporarily unavailable.", "model": None,
                "generated_for": date.today().isoformat()}


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
                coaching = _run_coaching(kpi)
                if coaching.get("note"):
                    du.save_coaching(conn, DESK, coaching["note"],
                                     model=coaching.get("model",""))

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

    @app.post("/api/customer-desk/issues/{issue_id}/close")
    async def customer_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
