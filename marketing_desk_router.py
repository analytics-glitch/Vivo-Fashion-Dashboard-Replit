"""
marketing_desk_router.py — Phase 7: Marketing Desk
Social inbox stats, loyalty programme health, data gap register.
NOTE: crm_campaigns has 0 rows; Meta Ads requires FACEBOOK_ADS_ACCOUNT_TOKEN (Gap Register).
Gate: /api/marketing-desk/* — leadership + admin only.
"""
import os, logging, requests
from datetime import date
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "marketing"

_SOCIAL_SQL = """
SELECT platform,
       COUNT(*)                                                    AS total_items,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - 7)     AS items_7d,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - 30)    AS items_30d,
       COUNT(*) FILTER (WHERE sentiment = 'positive')             AS positive,
       COUNT(*) FILTER (WHERE sentiment = 'negative')             AS negative,
       COUNT(*) FILTER (WHERE sentiment = 'neutral')              AS neutral,
       COUNT(*) FILTER (WHERE replied_at IS NULL)                   AS needs_reply,
       COUNT(*) FILTER (WHERE replied_at IS NOT NULL)             AS replied
FROM crm_social_feedback
GROUP BY platform
ORDER BY total_items DESC
"""

_SOCIAL_TREND_SQL = """
SELECT TO_CHAR(DATE_TRUNC('week', created_at::date), 'Mon DD') AS week_label,
       platform,
       COUNT(*) AS items
FROM crm_social_feedback
WHERE created_at >= CURRENT_DATE - 56
GROUP BY 1, 2
ORDER BY DATE_TRUNC('week', created_at::date), platform
"""

_LOYALTY_SQL = """
SELECT
    COUNT(*)                                               AS total_members,
    COUNT(*) FILTER (WHERE last_login_at >= CURRENT_DATE - 30)
                                                           AS active_30d,
    COUNT(*) FILTER (WHERE created_at::date >= CURRENT_DATE - 30)
                                                           AS new_30d,
    ROUND(AVG(spend_kes))                                 AS avg_spend,
    COUNT(*) FILTER (WHERE brand_code = 'vivo')           AS vivo_members,
    COUNT(*) FILTER (WHERE brand_code = 'sz')             AS sz_members
FROM crm_loyalty_member
"""

_GAPS = [
    ("marketing","meta_ads_spend",
     "No Meta Ads (Facebook/Instagram) spend or reach data. "
     "Requires FACEBOOK_ADS_ACCOUNT_TOKEN and ads account ID. "
     "Action: Stephen to provide Meta Ads Manager access token.",
     "high"),
    ("marketing","email_campaigns",
     "crm_campaigns table exists but has 0 rows — no campaign history synced. "
     "Action: connect Mailchimp/Klaviyo or push campaign data to crm_campaigns table.",
     "high"),
    ("marketing","google_ads_spend",
     "No Google Ads conversion or spend data in DB. "
     "Action: export Google Ads reports to a google_ads_daily table via API.",
     "medium"),
    ("marketing","influencer_tracking",
     "No influencer/affiliate performance data. "
     "Action: create influencer_posts table with UTM-linked revenue attribution.",
     "low"),
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


def _run_coaching(api_key: str, social: list, loyalty: dict, gaps: list, conn) -> dict:
    social_rows = "\n".join(
        f"  {r.get('platform','?')}: {r.get('total_items',0)} items total, "
        f"{r.get('positive',0)} positive / {r.get('negative',0)} negative / "
        f"{r.get('neutral',0)} neutral, {r.get('needs_reply',0)} needing reply, "
        f"sentiment score: {r.get('sentiment_score','n/a')}"
        for r in social
    )
    total_backlog = sum(r.get("needs_reply", 0) or 0 for r in social)
    negative_total = sum(r.get("negative", 0) or 0 for r in social)
    top_gaps = [g["gap_name"].replace("_", " ") for g in gaps[:3]]
    loyalty_eng_rate = round(
        (loyalty.get("active_30d") or 0) / (loyalty.get("total_members") or 1) * 100, 1
    )
    context = (
        f"MARKETING DESK INTELLIGENCE — {date.today().isoformat()}\n\n"
        f"SOCIAL INBOX (all-time accumulation):\n{social_rows or '  No social data'}\n\n"
        f"SOCIAL FLAGS:\n"
        f"  Total unanswered backlog: {total_backlog} (SLA risk if >48h)\n"
        f"  Total negative items: {negative_total} (reputation risk if unaddressed)\n\n"
        f"LOYALTY PROGRAMME:\n"
        f"  Total enrolled members: {loyalty.get('total_members', 0):,}\n"
        f"  Active last 30d: {loyalty.get('active_30d', 0):,} ({loyalty_eng_rate}%% engagement)\n"
        f"  New enrolments last 30d: {loyalty.get('new_30d', 0):,}\n"
        f"  (Target: >=30%% monthly engagement rate, >=5%% growth in enrolments)\n\n"
        f"KEY DATA GAPS: {', '.join(top_gaps) if top_gaps else 'None flagged'}\n\n"
        f"Analyse this marketing data. Identify reputation risks from the social backlog, "
        f"loyalty engagement risks (if engagement <30%%), and opportunities to grow the programme. "
        f"Propose concrete actions: who should reply to what, what campaign could drive loyalty sign-ups, "
        f"which data gap blocks the most valuable insight."
    )
    return du.call_llm_structured(api_key, context, DESK, "overview", conn)


def ensure_marketing_desk_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
        for domain, gap_name, details, impact in _GAPS:
            du.register_gap(conn, domain, gap_name, details, impact)
    finally:
        conn.close()


def register_marketing_desk_routes(app, A):
    _A = A

    @app.get("/api/marketing-desk/overview")
    async def marketing_desk_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            social_raw = _db_exec(_A, _SOCIAL_SQL)
            loyalty_raw = _db_exec(_A, _LOYALTY_SQL)

            def _c(rows):
                return [{k: (int(v) if hasattr(v,"__int__") else v)
                         for k, v in r.items() if v is not None} for r in rows]

            social = _c(social_raw)
            loyalty = {}
            if loyalty_raw:
                for k, v in loyalty_raw[0].items():
                    loyalty[k] = float(v) if hasattr(v,"__float__") else (v or 0)

            gaps = [{"domain": g[0], "gap_name": g[1], "details": g[2],
                     "impact": g[3]} for g in _GAPS]

            # Flag if >10 unanswered social items (basic responsiveness check)
            total_needs_reply = sum(r.get("needs_reply", 0) for r in social)
            if total_needs_reply > 10:
                du.auto_flag_issue(conn, DESK, "social",
                    f"{total_needs_reply} social items need a reply",
                    "Review CRM Inbox to respond to customers.",
                    severity="medium")

            coaching = du.get_coaching(conn, DESK)
            if not coaching:
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                coaching = _run_coaching(api_key, social, loyalty, gaps, conn)
                if coaching.get("note") or coaching.get("structured"):
                    du.save_coaching(conn, DESK, coaching.get("note", ""),
                                     structured=coaching.get("structured"),
                                     model=coaching.get("model", ""))

            issues = du.list_issues(conn, DESK)
            return {"as_of": date.today().isoformat(),
                    "social": social, "loyalty": loyalty,
                    "gaps": gaps, "coaching": coaching, "issues": issues}
        finally:
            conn.close()

    @app.get("/api/marketing-desk/issues")
    async def marketing_desk_issues():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try: return {"issues": du.list_issues(conn, DESK)}
        finally: conn.close()

    @app.post("/api/marketing-desk/issues")
    async def marketing_desk_create_issue(request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return du.create_issue(conn, DESK, title=body.get("title","Untitled"),
                body=body.get("body"), severity=body.get("severity","medium"),
                owner_email=body.get("owner_email"))
        finally: conn.close()

    @app.post("/api/marketing-desk/issues/{issue_id}/close")
    async def marketing_desk_close_issue(issue_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            return {"ok": du.close_issue(conn, issue_id, body.get("closed_by",""))}
        finally: conn.close()
