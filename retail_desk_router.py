"""
Retail Desk Router — per-store AI coaching engine.

Phase 3 of the Vivo AI Desks roadmap. Surfaces the Growth Model's path
requirements at individual store level, flags persistent underperformers,
maintains a per-store issue register, and runs a daily LLM coaching pass.

Endpoints (all gated leadership + admin via clerk_auth_gate):
  GET  /api/retail-desk/overview          — all-stores snapshot (cards + flash)
  GET  /api/retail-desk/store/{store}     — deep-dive for one store
  GET  /api/retail-desk/issues            — full issue register
  POST /api/retail-desk/issues            — create / update issue
  POST /api/retail-desk/issues/{id}/close — close issue

Registered via register_retail_desk_routes(app, api_pg_module) from api_pg.py.
Desk coaching uses claude-haiku-3-5 (daily, fast). Chair uses sonnet (weekly).
"""

import json
import logging
import math
import os
import threading
from datetime import date, datetime, timedelta, timezone
import desk_utils as du

log = logging.getLogger("retail_desk")

A = None  # api_pg module ref — set in register_retail_desk_routes()

# ── AI client (shared lazy singleton pattern) ──────────────────────────────────

_ai_lock = threading.Lock()
_ai_inst = None

HAIKU  = "claude-haiku-3-5"
SONNET = "claude-sonnet-4-5"


def _ai_key():
    return os.environ.get("ANTHROPIC_API_KEY") or None


def _ai_configured():
    return bool(_ai_key())


def _ai_client():
    global _ai_inst
    if _ai_inst:
        return _ai_inst
    with _ai_lock:
        if _ai_inst:
            return _ai_inst
        key = _ai_key()
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")
        import anthropic
        _ai_inst = anthropic.Anthropic(api_key=key)
        return _ai_inst


# ── DB exec (dual mode: API / standalone) ────────────────────────────────────

def _db_exec(sql, params=None, fetch=True):
    if A is not None:
        return A._users_exec(sql, params, fetch=fetch)
    import psycopg2
    import psycopg2.extras
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set")
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            if fetch:
                rows = [dict(r) for r in cur.fetchall()]
                conn.commit()
                return rows
            conn.commit()
            return None
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _base_filters():
    return A.BASE_FILTERS if A is not None else "TRUE"


# ── Net-sales expression (mirrors NET_SALES_CANON) ────────────────────────────

_VAT_DIV = "(CASE WHEN s.country IN ('Uganda','Rwanda') THEN 1.18 ELSE 1.16 END)"
_NET_S   = (
    f"CASE WHEN s.sale_kind IN ('sale','order') "
    f"THEN (s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric) / {_VAT_DIV} "
    f"WHEN s.sale_kind = 'return' "
    f"THEN -COALESCE(s.returns_kes,0)::numeric / {_VAT_DIV} "
    f"ELSE 0 END"
)
_IS_RETAIL = "s.country IN ('Kenya','Uganda','Rwanda')"


# ── DDL ───────────────────────────────────────────────────────────────────────

_DDL = [
    """CREATE TABLE IF NOT EXISTS retail_desk_issues (
        id              BIGSERIAL PRIMARY KEY,
        store           TEXT NOT NULL,
        title           TEXT NOT NULL,
        body            TEXT,
        source          TEXT NOT NULL DEFAULT 'manual',
        severity        TEXT NOT NULL DEFAULT 'medium',
        status          TEXT NOT NULL DEFAULT 'open',
        owner_email     TEXT,
        opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at       TIMESTAMPTZ,
        closed_by       TEXT,
        ai_coaching     TEXT,
        coaching_date   DATE,
        week_behind     INT NOT NULL DEFAULT 0,
        gap_kes         FLOAT,
        gap_pct         FLOAT
    )""",
    """CREATE INDEX IF NOT EXISTS retail_desk_issues_store
       ON retail_desk_issues (store, status)""",
    """CREATE TABLE IF NOT EXISTS retail_desk_coaching_log (
        id          BIGSERIAL PRIMARY KEY,
        store       TEXT NOT NULL,
        run_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        summary     TEXT,
        flags       JSONB,
        model       TEXT,
        created_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (store, run_date)
    )""",
]

# ── Consecutive-weeks-behind tracker (inline, no extra table) ─────────────────

def _weeks_behind_count(store: str) -> int:
    """
    Count how many of the last 8 ISO weeks the store was behind its
    prorated growth-path milestone at week-end (Sunday).
    Uses weekly actual vs weekly_req derived from monthly growth target.
    """
    try:
        from growth_router import (
            _get_t12m_baseline, _get_current_assumption, compute_milestones,
            _current_month_start, _add_months,
        )
        baseline   = _get_t12m_baseline()
        assumption = _get_current_assumption()
        if not assumption:
            return 0
        bm = baseline["t12m_monthly"]
        milestones, _ = compute_milestones(assumption, bm)

        bf  = _base_filters()
        sql = f"""
            SELECT
                DATE_TRUNC('week', s.sale_date::date)::date AS wk,
                ROUND(SUM({_NET_S}), 0) AS actual_wk
            FROM all_sales s
            WHERE s.sale_date::date >= CURRENT_DATE - 63
              AND s.pos_location_name = %s
              AND {_IS_RETAIL}
              AND {bf}
            GROUP BY 1
            ORDER BY 1
        """
        rows = _db_exec(sql, (store,), fetch=True) or []

        # Build a map of month_start → monthly_req for lookup
        ms_map = {m["month_start"]: m["monthly_target"] for m in milestones}
        behind = 0
        for r in rows:
            wk = r["wk"]
            if not wk:
                continue
            # Find the monthly milestone for this week's month
            wk_date = wk if isinstance(wk, date) else date.fromisoformat(str(wk))
            month_key = str(date(wk_date.year, wk_date.month, 1))
            mt = ms_map.get(month_key)
            if not mt:
                continue
            weekly_req = mt / 4.33  # approx weeks per month
            # Get store's T12M retail share for the milestone split
            stores = _get_store_t12m_and_mtd_raw()
            total  = sum(s["t12m_net"] for s in stores)
            sr     = next((s for s in stores if s["store"] == store), None)
            if not sr or not total:
                continue
            store_weekly_req = weekly_req * (sr["t12m_net"] / total) * (assumption.get("same_store_pct", 60) / 100.0)
            if float(r.get("actual_wk") or 0) < store_weekly_req:
                behind += 1
        return behind
    except Exception as e:
        log.warning("_weeks_behind_count error for %s: %s", store, e)
        return 0


# ── Core data reads ───────────────────────────────────────────────────────────

def _get_store_t12m_and_mtd_raw():
    bf  = _base_filters()
    sql = f"""
        SELECT
            s.pos_location_name AS store,
            s.country,
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
                      THEN {_NET_S} ELSE 0 END), 0) AS t12m_net,
            ROUND(SUM(CASE WHEN DATE_TRUNC('month', s.sale_date::date) = DATE_TRUNC('month', CURRENT_DATE)
                      THEN {_NET_S} ELSE 0 END), 0) AS mtd_net,
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - 28
                      THEN {_NET_S} ELSE 0 END), 0) AS l28d_net,
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - 56
                           AND s.sale_date::date < CURRENT_DATE - 28
                      THEN {_NET_S} ELSE 0 END), 0) AS prev28d_net,
            COUNT(DISTINCT CASE WHEN DATE_TRUNC('month', s.sale_date::date) = DATE_TRUNC('month', CURRENT_DATE)
                           THEN s.id END) AS mtd_transactions,
            ROUND(AVG(CASE WHEN DATE_TRUNC('month', s.sale_date::date) = DATE_TRUNC('month', CURRENT_DATE)
                      THEN {_NET_S} END), 0) AS mtd_avg_basket
        FROM all_sales s
        WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
          AND {_IS_RETAIL}
          AND {bf}
        GROUP BY s.pos_location_name, s.country
        HAVING SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
                   THEN ABS({_NET_S}) ELSE 0 END) > 1000
        ORDER BY t12m_net DESC
    """
    rows = _db_exec(sql, fetch=True) or []
    return [
        {
            "store":           r["store"],
            "country":         r["country"],
            "t12m_net":        float(r.get("t12m_net")         or 0),
            "mtd_net":         float(r.get("mtd_net")          or 0),
            "l28d_net":        float(r.get("l28d_net")         or 0),
            "prev28d_net":     float(r.get("prev28d_net")      or 0),
            "mtd_transactions": int(r.get("mtd_transactions")  or 0),
            "mtd_avg_basket":  float(r.get("mtd_avg_basket")   or 0),
        }
        for r in rows
        if r.get("store") and r["store"] not in ("Staff purchases",)
    ]


def _get_store_weekly_trend(store: str, weeks: int = 8):
    bf  = _base_filters()
    sql = f"""
        SELECT
            DATE_TRUNC('week', s.sale_date::date)::date AS week_start,
            ROUND(SUM({_NET_S}), 0) AS net_sales,
            COUNT(DISTINCT s.id) AS transactions
        FROM all_sales s
        WHERE s.sale_date::date >= CURRENT_DATE - ({weeks} * 7)
          AND s.pos_location_name = %s
          AND {_IS_RETAIL}
          AND {bf}
        GROUP BY 1
        ORDER BY 1
    """
    rows = _db_exec(sql, (store,), fetch=True) or []
    return [
        {
            "week_start":   str(r["week_start"]),
            "net_sales":    float(r.get("net_sales")    or 0),
            "transactions": int(r.get("transactions")   or 0),
        }
        for r in rows
    ]


def _get_top_categories_for_store(store: str):
    """Top-5 selling categories for the store (L28D)."""
    bf  = _base_filters()
    sql = f"""
        SELECT
            COALESCE(p.product_type, 'Unknown') AS category,
            ROUND(SUM({_NET_S}), 0) AS net_sales
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.default_code = s.sku
        WHERE s.sale_date::date >= CURRENT_DATE - 28
          AND s.pos_location_name = %s
          AND {_IS_RETAIL}
          AND {bf}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 5
    """
    rows = _db_exec(sql, (store,), fetch=True) or []
    return [
        {"category": r["category"], "net_sales": float(r.get("net_sales") or 0)}
        for r in rows
    ]


def _get_open_issues(store: str = None):
    where = "WHERE status = 'open'"
    params = []
    if store:
        where += " AND store = %s"
        params.append(store)
    rows = _db_exec(
        f"SELECT * FROM retail_desk_issues {where} ORDER BY opened_at DESC",
        params or None, fetch=True
    ) or []
    return [dict(r) for r in rows]


def _build_store_path_data():
    """
    Pull growth model path requirements for current month, distribute
    to stores by T12M share. Returns dict keyed by store name.
    """
    try:
        from growth_router import (
            _get_t12m_baseline, _get_current_assumption, compute_milestones,
            _current_month_start, _days_elapsed_this_month, _days_in_month,
        )
        from calendar import monthrange
        baseline   = _get_t12m_baseline()
        assumption = _get_current_assumption()
        if not assumption:
            return {}
        bm = baseline["t12m_monthly"]
        milestones, _ = compute_milestones(assumption, bm)
        cm_start_s = str(_current_month_start())
        cm_row     = next((m for m in milestones if m["month_start"] == cm_start_s), None)
        ss_monthly = cm_row["same_store_req"] if cm_row else bm * (assumption.get("same_store_pct", 60) / 100.0)
        elapsed    = _days_elapsed_this_month()
        total_days = _days_in_month(_current_month_start())

        stores     = _get_store_t12m_and_mtd_raw()
        total_ret  = sum(s["t12m_net"] for s in stores)

        out = {}
        for s in stores:
            share     = s["t12m_net"] / total_ret if total_ret > 0 else 0.0
            mo_req    = round(share * ss_monthly, 0)
            mtd_req   = round(mo_req * elapsed / total_days, 0)
            gap_kes   = round(s["mtd_net"] - mtd_req, 0)
            gap_pct   = round(gap_kes / mtd_req * 100, 1) if mtd_req else 0.0
            status    = (
                "ahead"   if gap_pct >= 0
                else "at_risk" if gap_pct >= -15
                else "behind"
            )
            out[s["store"]] = {
                "monthly_req":  mo_req,
                "mtd_req":      mtd_req,
                "gap_kes":      gap_kes,
                "gap_pct":      gap_pct,
                "status":       status,
                "share_pct":    round(share * 100, 1),
            }
        return out
    except Exception as e:
        log.warning("_build_store_path_data error: %s", e)
        return {}


# ── LLM coaching ─────────────────────────────────────────────────────────────

_COACHING_SYSTEM = """You are the Vivo Retail Desk — an expert retail operations advisor for Vivo Fashion Group, a vertically-integrated fashion retailer across East Africa.

Your job is to analyse one store's performance data and produce a concise, actionable daily coaching note.

RULES:
- Be direct and specific. Name the numbers. Use KES throughout.
- Do NOT make up data that isn't in the provided context.
- If a metric is missing, say "data unavailable" — never fabricate.
- Maximum 4 bullet points. Each bullet: one observation + one specific recommended action.
- If the store is ahead of path: one bullet on sustaining it, one on what's driving it.
- If behind: identify the likely root cause, recommend the single most impactful lever.
- Flag if a consecutive-weeks-behind count is ≥ 3 — this needs escalation language.
- Flag if there are open issues that haven't moved in >7 days.
- Never output HTML. Plain text bullets only (use • as bullet character).
- End with a confidence qualifier: LOW (missing >2 key metrics) / MEDIUM / HIGH.
"""

def _run_coaching(store: str, store_data: dict, path_data: dict, issues: list, categories: list) -> str:
    if not _ai_configured():
        return ""
    try:
        weeks_behind = _weeks_behind_count(store)
        open_issues  = [i for i in issues if i.get("status") == "open"]
        stale_issues = [
            i for i in open_issues
            if i.get("opened_at") and
               (datetime.now(timezone.utc) - (
                   i["opened_at"] if hasattr(i["opened_at"], "tzinfo")
                   else datetime.fromisoformat(str(i["opened_at"])).replace(tzinfo=timezone.utc)
               )).days > 7
        ]

        pd = path_data.get(store, {})
        context = f"""STORE: {store}
COUNTRY: {store_data.get('country','?')}
DATE: {date.today().isoformat()}

GROWTH PATH (current month):
  Monthly target (store share): KES {pd.get('monthly_req', 0):,.0f}
  MTD required (prorated to today): KES {pd.get('mtd_req', 0):,.0f}
  MTD actual: KES {store_data.get('mtd_net', 0):,.0f}
  Gap vs path: KES {pd.get('gap_kes', 0):,.0f}  ({pd.get('gap_pct', 0):+.1f}%)
  Path status: {pd.get('status','unknown').upper()}
  Consecutive weeks behind milestone: {weeks_behind}

RECENT PERFORMANCE (L28D vs prior 28D):
  L28D net sales: KES {store_data.get('l28d_net', 0):,.0f}
  Prior 28D net sales: KES {store_data.get('prev28d_net', 0):,.0f}
  MTD transactions: {store_data.get('mtd_transactions', 0):,}
  MTD avg basket: KES {store_data.get('mtd_avg_basket', 0):,.0f}

TOP CATEGORIES (L28D by net sales):
{chr(10).join(f"  {c['category']}: KES {c['net_sales']:,.0f}" for c in categories) or "  No category data"}

OPEN ISSUES ({len(open_issues)} total, {len(stale_issues)} stale >7d):
{chr(10).join(f"  [{i.get('severity','?').upper()}] {i.get('title','?')} — opened {str(i.get('opened_at','?'))[:10]}" for i in open_issues[:5]) or "  None"}
"""
        client = _ai_client()
        resp   = client.messages.create(
            model=HAIKU,
            max_tokens=400,
            system=_COACHING_SYSTEM,
            messages=[{"role": "user", "content": context}],
        )
        return resp.content[0].text.strip() if resp.content else ""
    except Exception as e:
        log.warning("Retail desk coaching error for %s: %s", store, e)
        return ""


def _run_fleet_coaching(api_key: str, cards: list, fleet: dict, conn) -> dict:
    """Fleet-level structured intelligence for the retail overview page."""
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    day_of_month = today.day
    days_in_month = 28 if today.month == 2 else 30 if today.month in (4,6,9,11) else 31
    days_remaining = days_in_month - day_of_month
    month_pct = round(day_of_month / days_in_month * 100)
    month_phase = "early month" if day_of_month <= 10 else \
                  "mid-month" if day_of_month <= 20 else "final stretch"

    behind_stores = [c for c in cards if c["status"] == "behind"]
    at_risk_stores = [c for c in cards if c["status"] == "at_risk"]
    ahead_stores  = [c for c in cards if c["status"] == "ahead"]

    # Country-level pattern analysis
    by_country: dict = {}
    for c in cards:
        co = c.get("country", "Unknown")
        by_country.setdefault(co, {"total": 0, "behind": 0, "gap": 0.0, "mtd": 0.0})
        by_country[co]["total"] += 1
        by_country[co]["gap"]   += c.get("gap_kes") or 0
        by_country[co]["mtd"]   += c.get("mtd_net") or 0
        if c["status"] == "behind":
            by_country[co]["behind"] += 1
    country_rows = "\n".join(
        f"  {co}: {v['total']} stores · {v['behind']} behind · "
        f"combined gap KES {v['gap']:,.0f} · MTD KES {v['mtd']:,.0f}"
        for co, v in sorted(by_country.items())
    )

    # Required daily run-rate to close fleet gap
    daily_req = round(abs(fleet["total_gap_kes"]) / max(days_remaining, 1)) if days_remaining > 0 else 0

    # Sorted behind stores with momentum
    def _store_line(c):
        mom = c.get("mom_pct")
        mom_str = f"{mom:+.1f}%% MoM" if mom is not None else "MoM n/a"
        trend = "WORSENING" if (mom is not None and mom < -5) else \
                "IMPROVING" if (mom is not None and mom > 5) else "FLAT"
        return (
            f"  [{trend}] {c['store']} ({c.get('country','?')}): "
            f"MTD KES {c.get('mtd_net',0):,.0f} vs req KES {c.get('mtd_req',0):,.0f} "
            f"(gap {c.get('gap_pct',0):+.1f}%% = KES {c.get('gap_kes',0):,.0f}) · "
            f"{mom_str} · issues={c.get('open_issues',0)}"
        )

    behind_rows   = "\n".join(_store_line(c) for c in behind_stores[:8])
    at_risk_rows  = "\n".join(_store_line(c) for c in at_risk_stores[:5])
    ahead_rows    = "\n".join(
        f"  {c['store']} ({c.get('country','?')}): "
        f"+{c.get('gap_pct',0):.1f}%% ahead · MTD KES {c.get('mtd_net',0):,.0f}"
        for c in sorted(ahead_stores, key=lambda c: -(c.get("gap_pct") or 0))[:4]
    )

    # Worst behind store by KES gap
    worst = min(behind_stores, key=lambda c: c.get("gap_pct") or 0, default=None)
    total_kes_gap = abs(fleet["total_gap_kes"])

    context = (
        f"RETAIL FLEET INTELLIGENCE — {today.isoformat()}\n"
        f"Month position: day {day_of_month}/{days_in_month} ({month_pct}%% through, {days_remaining}d remaining — {month_phase})\n\n"
        f"FLEET STATUS (MTD vs prorated growth-path target):\n"
        f"  Total stores: {fleet['total_stores']}\n"
        f"  Behind path: {fleet['behind']} stores "
        f"({'CRITICAL — majority of fleet behind' if fleet['behind'] > fleet['total_stores'] // 2 else 'HIGH — >3 behind' if fleet['behind'] > 3 else 'manageable'})\n"
        f"  At risk (within -15%%): {fleet['at_risk']} stores\n"
        f"  Ahead: {fleet['ahead']} stores\n"
        f"  Fleet MTD: KES {fleet['total_mtd']:,.0f} vs target KES {fleet['total_mtd_req']:,.0f}\n"
        f"  Fleet gap: KES {fleet['total_gap_kes']:,.0f} ({fleet['total_gap_pct']:+.1f}%%)\n"
        f"  To close this gap in {days_remaining}d remaining: fleet needs KES {daily_req:,.0f}/day extra\n"
        f"  Open issues across fleet: {fleet['open_issues']}\n\n"
        f"BY COUNTRY:\n{country_rows}\n\n"
        f"BEHIND STORES (sorted by gap %, with momentum):\n{behind_rows or '  None'}\n\n"
        f"AT-RISK STORES:\n{at_risk_rows or '  None'}\n\n"
        f"AHEAD STORES (pulling the fleet forward):\n{ahead_rows or '  None'}\n\n"
        f"Apply the MANDATORY THINKING SEQUENCE. "
        f"Lead with the country-level insight: is this a Kenya problem, Uganda problem, or fleet-wide? "
        f"Name the single store whose gap has the most momentum risk "
        f"(large KES gap + worsening MoM trend + {days_remaining}d left). "
        f"What specific intervention — not 'a management visit' but exactly what action, by whom, by when — "
        f"would move the needle most on the fleet gap this week? "
        f"Note: {month_phase} — urgency framing should reflect {days_remaining} days remaining."
    )
    return du.call_llm_structured(api_key, context, "retail", "fleet_overview", conn)


# ── Auto-issue creation (consecutive weeks behind) ────────────────────────────

def _auto_flag_issues(stores_data: list, path_data: dict):
    """
    Create an auto issue if a store has been behind its path for ≥ 3 consecutive weeks
    and doesn't already have an open auto issue within the last 14 days.
    """
    for s in stores_data:
        store  = s["store"]
        pd     = path_data.get(store, {})
        if pd.get("status") not in ("behind", "at_risk"):
            continue
        weeks_b = _weeks_behind_count(store)
        if weeks_b < 3:
            continue
        # Check for recent open auto issue
        existing = _db_exec(
            """SELECT id FROM retail_desk_issues
               WHERE store = %s AND source = 'auto' AND status = 'open'
                 AND opened_at >= NOW() - INTERVAL '14 days'
               LIMIT 1""",
            (store,), fetch=True
        )
        if existing:
            continue
        severity = "high" if weeks_b >= 5 else "medium"
        title    = f"{weeks_b} consecutive weeks behind growth path"
        body     = (
            f"Store has been behind its monthly growth-path milestone for "
            f"{weeks_b} consecutive weeks. "
            f"Current MTD gap: KES {pd.get('gap_kes', 0):,.0f} "
            f"({pd.get('gap_pct', 0):+.1f}%% vs prorated target). "
            f"Auto-flagged by Retail Desk. Requires a management review."
        )
        try:
            _db_exec(
                """INSERT INTO retail_desk_issues
                       (store, title, body, source, severity, gap_kes, gap_pct, week_behind)
                   VALUES (%s,%s,%s,'auto',%s,%s,%s,%s)""",
                (store, title, body, severity, pd.get("gap_kes"), pd.get("gap_pct"), weeks_b),
                fetch=False
            )
            log.info("Auto-issue created for %s (%d weeks behind)", store, weeks_b)
        except Exception as e:
            log.warning("Auto-issue creation error for %s: %s", store, e)


# ── Schema setup ──────────────────────────────────────────────────────────────

def ensure_retail_desk_tables():
    for ddl in _DDL:
        _db_exec(ddl, fetch=False)
    log.info("Retail desk tables: OK")


# ── Route registration ────────────────────────────────────────────────────────

def register_retail_desk_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request, HTTPException
    from fastapi.responses import JSONResponse

    @app.get("/api/retail-desk/overview")
    async def retail_desk_overview(request: Request):
        """
        All-stores snapshot: path status, gap KES/%, trend, open issues count.
        Runs auto-flagging and returns a flash summary for the top-level desk view.
        """
        stores_data = _get_store_t12m_and_mtd_raw()
        path_data   = _build_store_path_data()

        # Auto-flag consecutive-weeks issues (lightweight — uses cached week calcs)
        try:
            _auto_flag_issues(stores_data, path_data)
        except Exception as e:
            log.warning("auto_flag_issues error: %s", e)

        # Open issues count per store
        all_open = _db_exec(
            "SELECT store, COUNT(*) AS n FROM retail_desk_issues WHERE status='open' GROUP BY store",
            fetch=True
        ) or []
        open_by_store = {r["store"]: int(r["n"]) for r in all_open}

        cards = []
        for s in stores_data:
            pd = path_data.get(s["store"], {})
            l28  = s["l28d_net"]
            p28  = s["prev28d_net"]
            mom  = round((l28 - p28) / p28 * 100, 1) if p28 else None
            cards.append({
                "store":            s["store"],
                "country":          s["country"],
                "t12m_net":         s["t12m_net"],
                "mtd_net":          s["mtd_net"],
                "mtd_req":          pd.get("mtd_req", 0),
                "gap_kes":          pd.get("gap_kes", 0),
                "gap_pct":          pd.get("gap_pct", 0),
                "status":           pd.get("status", "unknown"),
                "share_pct":        pd.get("share_pct", 0),
                "mom_pct":          mom,
                "open_issues":      open_by_store.get(s["store"], 0),
                "monthly_req":      pd.get("monthly_req", 0),
            })

        # Sort: behind first, then at_risk, then ahead — within each group by gap_kes
        STATUS_ORDER = {"behind": 0, "at_risk": 1, "ahead": 2, "unknown": 3}
        cards.sort(key=lambda c: (STATUS_ORDER.get(c["status"], 3), c["gap_kes"]))

        # Fleet summary
        total_stores   = len(cards)
        behind_count   = sum(1 for c in cards if c["status"] == "behind")
        at_risk_count  = sum(1 for c in cards if c["status"] == "at_risk")
        ahead_count    = sum(1 for c in cards if c["status"] == "ahead")
        total_gap_kes  = sum(c["gap_kes"] for c in cards)
        total_mtd      = sum(c["mtd_net"] for c in cards)
        total_mtd_req  = sum(c["mtd_req"] for c in cards)
        total_issues   = sum(c["open_issues"] for c in cards)
        total_gap_pct  = round(total_gap_kes / total_mtd_req * 100, 1) if total_mtd_req else 0

        # Fleet-level AI intelligence (cached daily per desk, scope "fleet_overview")
        import psycopg2 as _pg2
        _conn = _pg2.connect(os.environ["DATABASE_URL"])
        fleet_coaching = None
        try:
            fleet_coaching = du.get_coaching(_conn, "retail", "fleet_overview")
            if not fleet_coaching:
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                fleet_coaching = _run_fleet_coaching(api_key, cards, {
                    "total_stores": total_stores,
                    "behind": behind_count, "at_risk": at_risk_count, "ahead": ahead_count,
                    "total_gap_kes": total_gap_kes, "total_gap_pct": total_gap_pct,
                    "total_mtd": total_mtd, "total_mtd_req": total_mtd_req,
                    "open_issues": total_issues,
                }, _conn)
                if fleet_coaching and (fleet_coaching.get("note") or fleet_coaching.get("structured")):
                    du.save_coaching(_conn, "retail", fleet_coaching.get("note", ""),
                                     structured=fleet_coaching.get("structured"),
                                     scope_key="fleet_overview",
                                     model=fleet_coaching.get("model", ""))
        except Exception as _e:
            log.warning("fleet coaching error: %s", _e)
        finally:
            _conn.close()

        return JSONResponse({
            "stores":        cards,
            "fleet_summary": {
                "total_stores":  total_stores,
                "ahead":         ahead_count,
                "at_risk":       at_risk_count,
                "behind":        behind_count,
                "total_gap_kes": round(total_gap_kes, 0),
                "total_mtd":     round(total_mtd, 0),
                "total_mtd_req": round(total_mtd_req, 0),
                "total_gap_pct": total_gap_pct,
                "open_issues":   total_issues,
            },
            "fleet_coaching": fleet_coaching,
        })

    @app.get("/api/retail-desk/store/{store:path}")
    async def retail_desk_store(store: str, request: Request):
        """
        Deep-dive for one store: path data, 8-week trend, top categories,
        open issues, and an LLM coaching note (cached daily).
        """
        stores_data = _get_store_t12m_and_mtd_raw()
        path_data   = _build_store_path_data()

        sd = next((s for s in stores_data if s["store"] == store), None)
        if sd is None:
            raise HTTPException(status_code=404, detail=f"Store '{store}' not found")

        weekly_trend = _get_store_weekly_trend(store, weeks=8)
        categories   = _get_top_categories_for_store(store)
        issues       = _get_open_issues(store)
        pd           = path_data.get(store, {})

        # Coaching — serve from cache if today's run exists
        coaching_text = ""
        cached = _db_exec(
            "SELECT summary FROM retail_desk_coaching_log WHERE store=%s AND run_date=CURRENT_DATE LIMIT 1",
            (store,), fetch=True
        )
        if cached and cached[0].get("summary"):
            coaching_text = cached[0]["summary"]
        elif _ai_configured():
            coaching_text = _run_coaching(store, sd, path_data, issues, categories)
            if coaching_text:
                try:
                    _db_exec(
                        """INSERT INTO retail_desk_coaching_log (store, run_date, summary, model)
                           VALUES (%s, CURRENT_DATE, %s, %s)
                           ON CONFLICT (store, run_date) DO UPDATE SET summary=EXCLUDED.summary""",
                        (store, coaching_text, HAIKU), fetch=False
                    )
                except Exception as e:
                    log.warning("Coaching log insert error: %s", e)

        return JSONResponse({
            "store":        store,
            "country":      sd["country"],
            "t12m_net":     sd["t12m_net"],
            "path":         pd,
            "mtd": {
                "actual":       sd["mtd_net"],
                "transactions": sd["mtd_transactions"],
                "avg_basket":   sd["mtd_avg_basket"],
            },
            "trend": {
                "l28d_net":    sd["l28d_net"],
                "prev28d_net": sd["prev28d_net"],
                "mom_pct":     round((sd["l28d_net"] - sd["prev28d_net"]) / sd["prev28d_net"] * 100, 1)
                               if sd["prev28d_net"] else None,
                "weekly":      weekly_trend,
            },
            "categories":   categories,
            "issues":       issues,
            "coaching":     coaching_text,
            "coaching_ai":  _ai_configured(),
        })

    @app.get("/api/retail-desk/issues")
    async def retail_desk_issues_list(
        request: Request,
        store: str = None,
        status: str = "open",
    ):
        where_parts = ["1=1"]
        params = []
        if store:
            where_parts.append("store = %s")
            params.append(store)
        if status and status != "all":
            where_parts.append("status = %s")
            params.append(status)
        where = "WHERE " + " AND ".join(where_parts)
        rows = _db_exec(
            f"SELECT * FROM retail_desk_issues {where} ORDER BY opened_at DESC LIMIT 200",
            params or None, fetch=True
        ) or []
        return JSONResponse({
            "issues": [dict(r) for r in rows],
            "total":  len(rows),
        })

    @app.post("/api/retail-desk/issues")
    async def retail_desk_create_issue(request: Request):
        body = await request.json()
        store    = body.get("store", "").strip()
        title    = body.get("title", "").strip()
        if not store or not title:
            raise HTTPException(status_code=400, detail="store and title are required")
        desc     = body.get("body", "")
        severity = body.get("severity", "medium")
        owner    = body.get("owner_email", "")
        user_email = getattr(request.state, "user_email", None)
        rows = _db_exec(
            """INSERT INTO retail_desk_issues
                   (store, title, body, source, severity, owner_email)
               VALUES (%s,%s,%s,'manual',%s,%s)
               RETURNING id""",
            (store, title, desc, severity, owner or user_email),
            fetch=True
        )
        issue_id = rows[0]["id"] if rows else None
        return JSONResponse({"ok": True, "id": issue_id}, status_code=201)

    @app.post("/api/retail-desk/issues/{issue_id}/close")
    async def retail_desk_close_issue(issue_id: int, request: Request):
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
        note = body.get("note", "") if isinstance(body, dict) else ""
        user_email = getattr(request.state, "user_email", None)
        _db_exec(
            """UPDATE retail_desk_issues
               SET status='closed', closed_at=NOW(), closed_by=%s,
                   body = CASE WHEN %s != '' THEN body || E'\n\nClose note: ' || %s ELSE body END
               WHERE id=%s AND status='open'""",
            (user_email, note, note, issue_id),
            fetch=False
        )
        return JSONResponse({"ok": True})
