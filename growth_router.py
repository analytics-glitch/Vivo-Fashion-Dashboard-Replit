"""
Growth Model Router — KES 5 Billion / 5-year north star.

Revenue bridge · trajectory tracking · store contribution paths · learning levers.

Registered via register_growth_routes(app, api_pg_module) from api_pg.py.
Gate: /api/growth/* requires leadership or admin role (enforced in clerk_auth_gate).

Math:
  baseline_monthly = T12M_net_annual / 12
  r = (target_kes / T12M_net_annual)^(1/target_months) - 1  [compound monthly]
  month_n_target   = baseline_monthly * (1+r)^n             (n=0 → last complete month)
  n > 0 → future, n < 0 → backfill path for history

Data gaps logged to ai_data_gap_register (never fabricated):
  · new_store_pipeline: no planned-store data → lever shows estimate-only
  · margin_by_channel : cost/margin data not available at channel level
"""

import logging
import math
import os
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger("growth_model")

A = None  # api_pg module reference — set in register_growth_routes()

TARGET_KES_DEFAULT    = 5_000_000_000.0
TARGET_MONTHS_DEFAULT = 60

_DEFAULT_SAME_STORE_PCT = 60.0
_DEFAULT_NEW_STORES_PCT = 25.0
_DEFAULT_ONLINE_PCT     = 15.0

# Net-sales expression (mirrors NET_SALES_CANON in api_pg.py).
_VAT_DIV = "(CASE WHEN s.country IN ('Uganda','Rwanda') THEN 1.18 ELSE 1.16 END)"
_NET_S   = (
    f"CASE WHEN s.sale_kind IN ('sale','order') "
    f"THEN (s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric) / {_VAT_DIV} "
    f"WHEN s.sale_kind = 'return' "
    f"THEN -COALESCE(s.returns_kes,0)::numeric / {_VAT_DIV} "
    f"ELSE 0 END"
)
# Online = Shop Zetu (country = 'Online'). Retail = physical stores.
_IS_ONLINE = "s.country = 'Online'"
_IS_RETAIL = "s.country IN ('Kenya','Uganda','Rwanda')"

_DDL = [
    """CREATE TABLE IF NOT EXISTS growth_model_assumptions (
        id              BIGSERIAL PRIMARY KEY,
        version         INT NOT NULL DEFAULT 1,
        target_kes      FLOAT NOT NULL DEFAULT 5000000000,
        target_months   INT NOT NULL DEFAULT 60,
        same_store_pct  FLOAT NOT NULL DEFAULT 60,
        new_stores_pct  FLOAT NOT NULL DEFAULT 25,
        online_pct      FLOAT NOT NULL DEFAULT 15,
        notes           TEXT,
        author_email    TEXT,
        created_at      TIMESTAMPTZ DEFAULT now(),
        is_current      BOOLEAN NOT NULL DEFAULT FALSE
    )""",
    # Only one row may be is_current=TRUE at a time (partial unique index).
    """CREATE UNIQUE INDEX IF NOT EXISTS growth_assumptions_one_current
       ON growth_model_assumptions (is_current) WHERE is_current""",
]


# ── DB exec (dual mode: API / standalone) ─────────────────────────────────────

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


# ── Date helpers ──────────────────────────────────────────────────────────────

def _add_months(d, n):
    """Return the first day of the month n months from d (which must be a first-of-month)."""
    m   = d.month - 1 + n
    yr  = d.year + m // 12
    mo  = m % 12 + 1
    return date(yr, mo, 1)


def _last_complete_month_start():
    """First day of the last complete calendar month."""
    today = date.today()
    first = date(today.year, today.month, 1)
    prev  = first - timedelta(days=1)
    return date(prev.year, prev.month, 1)


def _current_month_start():
    today = date.today()
    return date(today.year, today.month, 1)


def _days_elapsed_this_month():
    today = date.today()
    return today.day


def _days_in_month(d):
    return monthrange(d.year, d.month)[1]


# ── Growth math ───────────────────────────────────────────────────────────────

def _monthly_rate(baseline_annual, target_kes, target_months):
    """Compound monthly growth rate so baseline_annual grows to target_kes over target_months."""
    if baseline_annual <= 0 or target_months <= 0:
        return 0.0
    return (target_kes / baseline_annual) ** (1.0 / target_months) - 1.0


def _monthly_target(baseline_monthly, r, offset):
    """Revenue target for a month offset steps from the baseline month (n=0 = last complete month)."""
    return baseline_monthly * ((1.0 + r) ** offset)


def compute_milestones(assumption, baseline_monthly):
    """
    Pure function — returns list of monthly milestone dicts.
    offset=0 = last complete month (the baseline anchor).
    offset=1 = current month, offset=60 = target month.
    Backfill covers offsets -24 to 0.
    Forward covers offsets 0 to 61.
    """
    target_kes    = float(assumption.get("target_kes")    or TARGET_KES_DEFAULT)
    target_months = int(assumption.get("target_months")   or TARGET_MONTHS_DEFAULT)
    ss_pct        = float(assumption.get("same_store_pct") or _DEFAULT_SAME_STORE_PCT)
    ns_pct        = float(assumption.get("new_stores_pct") or _DEFAULT_NEW_STORES_PCT)
    on_pct        = float(assumption.get("online_pct")    or _DEFAULT_ONLINE_PCT)
    baseline_annual = baseline_monthly * 12

    r         = _monthly_rate(baseline_annual, target_kes, target_months)
    base_date = _last_complete_month_start()

    results = []
    for offset in range(-24, target_months + 2):
        month_start   = _add_months(base_date, offset)
        mt            = _monthly_target(baseline_monthly, r, offset)
        results.append({
            "month_start":     str(month_start),
            "month_offset":    offset,
            "monthly_target":  round(mt, 0),
            "same_store_req":  round(mt * ss_pct / 100.0, 0),
            "new_stores_req":  round(mt * ns_pct / 100.0, 0),
            "online_req":      round(mt * on_pct / 100.0, 0),
        })
    return results, r


# ── DB reads ──────────────────────────────────────────────────────────────────

def _get_t12m_baseline():
    """
    Trailing 12-month net sales (ex-VAT, post-discounts, post-returns).
    Returns dict: {t12m_total, t12m_retail, t12m_online, t12m_monthly}.
    """
    bf = _base_filters()
    sql = f"""
        SELECT
            ROUND(SUM({_NET_S}), 0)  AS t12m_total,
            ROUND(SUM(CASE WHEN {_IS_ONLINE} THEN {_NET_S} ELSE 0 END), 0) AS t12m_online,
            ROUND(SUM(CASE WHEN NOT ({_IS_ONLINE}) THEN {_NET_S} ELSE 0 END), 0) AS t12m_retail
        FROM all_sales s
        WHERE s.sale_date::date >= (CURRENT_DATE - INTERVAL '366 days')
          AND {bf}
    """
    rows = _db_exec(sql, fetch=True) or [{}]
    r    = rows[0]
    total  = float(r.get("t12m_total")  or 0)
    online = float(r.get("t12m_online") or 0)
    retail = float(r.get("t12m_retail") or 0)
    return {
        "t12m_total":   total,
        "t12m_retail":  retail,
        "t12m_online":  online,
        "t12m_monthly": round(total / 12.0, 0),
    }


def _get_current_assumption():
    rows = _db_exec(
        "SELECT * FROM growth_model_assumptions WHERE is_current=TRUE LIMIT 1",
        fetch=True
    )
    if rows:
        return dict(rows[0])
    # Fallback: latest version
    rows = _db_exec(
        "SELECT * FROM growth_model_assumptions ORDER BY version DESC LIMIT 1",
        fetch=True
    )
    return dict(rows[0]) if rows else {}


def _get_actuals_by_month(months_back=26):
    """Monthly actual net sales, split by channel, for the past N months + current MTD."""
    bf  = _base_filters()
    sql = f"""
        SELECT
            DATE_TRUNC('month', s.sale_date::date)::date AS month_start,
            ROUND(SUM({_NET_S}), 0) AS actual_total,
            ROUND(SUM(CASE WHEN {_IS_ONLINE} THEN {_NET_S} ELSE 0 END), 0) AS actual_online,
            ROUND(SUM(CASE WHEN NOT ({_IS_ONLINE}) THEN {_NET_S} ELSE 0 END), 0) AS actual_retail,
            (DATE_TRUNC('month', s.sale_date::date) = DATE_TRUNC('month', CURRENT_DATE)) AS is_mtd
        FROM all_sales s
        WHERE s.sale_date::date >= (CURRENT_DATE - ({months_back} * INTERVAL '1 month'))
          AND {bf}
        GROUP BY 1, 5
        ORDER BY 1
    """
    rows = _db_exec(sql, fetch=True) or []
    return [
        {
            "month_start":    str(r["month_start"]),
            "actual_total":   float(r.get("actual_total")  or 0),
            "actual_retail":  float(r.get("actual_retail") or 0),
            "actual_online":  float(r.get("actual_online") or 0),
            "is_mtd":         bool(r.get("is_mtd")),
        }
        for r in rows
    ]


def _get_store_t12m_and_mtd():
    """Per-store T12M and MTD net sales (retail only)."""
    bf  = _base_filters()
    sql = f"""
        SELECT
            s.pos_location_name AS store,
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
                      THEN {_NET_S} ELSE 0 END), 0) AS t12m_net,
            ROUND(SUM(CASE WHEN DATE_TRUNC('month', s.sale_date::date) = DATE_TRUNC('month', CURRENT_DATE)
                      THEN {_NET_S} ELSE 0 END), 0) AS mtd_net
        FROM all_sales s
        WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
          AND {_IS_RETAIL}
          AND {bf}
        GROUP BY 1
        HAVING SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - INTERVAL '366 days'
                   THEN ABS({_NET_S}) ELSE 0 END) > 1000
        ORDER BY t12m_net DESC
    """
    rows = _db_exec(sql, fetch=True) or []
    return [
        {
            "store":    r["store"],
            "t12m_net": float(r.get("t12m_net") or 0),
            "mtd_net":  float(r.get("mtd_net")  or 0),
        }
        for r in rows
    ]


# ── Path-impact helper (AI digest integration) ────────────────────────────────

def get_path_impact(delta_kes: float, target_date=None, store: str = None):
    """
    Returns the impact of a KES delta on the current growth path.
    Used by ai_insights_router to enrich anomaly evidence.

    Returns dict:
      monthly_milestone_kes — the required revenue for that month
      store_milestone_kes   — store-level required (if store provided)
      delta_kes             — the delta passed in
      impact_pct            — delta / milestone × 100
      store_impact_pct      — delta / store_milestone × 100 (if store provided)
      month_str             — "Jul 2026" label
      ahead_behind_kes      — estimated gap for that month (MTD actual - prorated required)
    """
    try:
        d = date.fromisoformat(str(target_date)) if target_date else date.today()
        baseline    = _get_t12m_baseline()
        assumption  = _get_current_assumption()
        if not assumption:
            return {}
        bm = baseline["t12m_monthly"]
        milestones, _ = compute_milestones(assumption, bm)
        month_start_str = str(date(d.year, d.month, 1))
        mrow = next((m for m in milestones if m["month_start"] == month_start_str), None)
        if not mrow:
            return {}
        mt      = mrow["monthly_target"]
        ss_req  = mrow["same_store_req"]
        impact  = round(delta_kes / mt * 100, 2) if mt else 0.0
        out = {
            "monthly_milestone_kes": round(mt, 0),
            "delta_kes":             round(delta_kes, 0),
            "impact_pct":            impact,
            "month_str":             d.strftime("%b %Y"),
        }
        if store:
            stores = _get_store_t12m_and_mtd()
            total_retail = sum(s["t12m_net"] for s in stores)
            sr = next((s for s in stores if s["store"] == store), None)
            if sr and total_retail > 0:
                store_share = sr["t12m_net"] / total_retail
                store_milestone = round(store_share * ss_req, 0)
                out["store_milestone_kes"] = store_milestone
                out["store_impact_pct"]    = round(delta_kes / store_milestone * 100, 2) if store_milestone else 0.0
        return out
    except Exception as e:
        log.warning("path_impact error: %s", e)
        return {}


# ── Schema + seed ─────────────────────────────────────────────────────────────

def ensure_growth_tables():
    for ddl in _DDL:
        _db_exec(ddl, fetch=False)
    # Seed default assumption if none exists
    existing = _db_exec(
        "SELECT COUNT(*) AS n FROM growth_model_assumptions", fetch=True
    )
    if not existing or int(existing[0].get("n") or 0) == 0:
        _db_exec(
            """INSERT INTO growth_model_assumptions
                   (version, target_kes, target_months, same_store_pct, new_stores_pct,
                    online_pct, notes, author_email, is_current)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,TRUE)""",
            (1, TARGET_KES_DEFAULT, TARGET_MONTHS_DEFAULT,
             _DEFAULT_SAME_STORE_PCT, _DEFAULT_NEW_STORES_PCT, _DEFAULT_ONLINE_PCT,
             (
                 "Default split: 60%% same-store growth, 25%% new stores (unconfigured — "
                 "no pipeline data), 15%% online/e-commerce. "
                 "Adjust levers once store pipeline data is available."
             ),
             "system"),
            fetch=False,
        )
        _register_data_gaps()
    log.info("Growth model tables: OK")


def _register_data_gaps():
    gaps = [
        (
            "growth_model",
            "new_store_pipeline",
            (
                "No pipeline data for planned store openings. "
                "The new-store lever (default 25%% of gap) is an estimate only — "
                "the required monthly contribution cannot be split by individual store. "
                "To configure: add store-opening plan data to a future growth_store_pipeline table."
            ),
        ),
        (
            "growth_model",
            "margin_by_channel",
            (
                "Gross margin / cost-of-revenue data is not available at channel level. "
                "The growth model tracks revenue (net of VAT + discounts + returns) only. "
                "A margin-weighted channel decomposition requires per-SKU/channel cost data."
            ),
        ),
    ]
    for store, metric, reason in gaps:
        try:
            _db_exec(
                """INSERT INTO ai_data_gap_register (date, store, metric, gap_reason)
                   VALUES (CURRENT_DATE, %s, %s, %s)
                   ON CONFLICT (date, store, metric) DO NOTHING""",
                (store, metric, reason),
                fetch=False,
            )
        except Exception as e:
            log.warning("Data gap register error %s/%s: %s", store, metric, e)


# ── Route registration ────────────────────────────────────────────────────────

def register_growth_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.get("/api/growth/summary")
    async def growth_summary(request: Request):
        """
        Returns baseline T12M, current assumption, compound monthly rate,
        MTD position (ahead/behind path), and 86 monthly milestones
        (24 backfill + 62 forward).
        """
        baseline   = _get_t12m_baseline()
        assumption = _get_current_assumption()
        bm         = baseline["t12m_monthly"]

        milestones, r = compute_milestones(assumption, bm)

        # Current month position
        today       = date.today()
        cm_start    = _current_month_start()
        cm_start_s  = str(cm_start)
        elapsed     = _days_elapsed_this_month()
        total_days  = _days_in_month(cm_start)
        cm_row      = next((m for m in milestones if m["month_start"] == cm_start_s), None)
        cm_monthly  = cm_row["monthly_target"] if cm_row else bm
        prorated    = round(cm_monthly * elapsed / total_days, 0)

        # MTD actual (current month only)
        actuals    = _get_actuals_by_month(months_back=1)
        mtd_actual = 0.0
        for a in actuals:
            if a["is_mtd"] or a["month_start"] == cm_start_s:
                mtd_actual = a["actual_total"]
                break

        gap_kes  = round(mtd_actual - prorated, 0)
        gap_pct  = round(gap_kes / prorated * 100, 1) if prorated else 0

        # Target date
        base_date  = _last_complete_month_start()
        target_d   = _add_months(base_date, assumption.get("target_months") or TARGET_MONTHS_DEFAULT)

        return JSONResponse({
            "baseline": {
                "t12m_total_kes":   baseline["t12m_total"],
                "t12m_retail_kes":  baseline["t12m_retail"],
                "t12m_online_kes":  baseline["t12m_online"],
                "monthly_baseline": bm,
            },
            "assumption":     assumption,
            "monthly_rate_pct": round(r * 100, 4),
            "target_date":    str(target_d),
            "current_month": {
                "month_start":       cm_start_s,
                "monthly_milestone": cm_monthly,
                "prorated_target":   prorated,
                "mtd_actual":        mtd_actual,
                "gap_kes":           gap_kes,
                "gap_pct":           gap_pct,
                "elapsed_days":      elapsed,
                "total_days":        total_days,
            },
            "milestones":   milestones,
        })

    @app.get("/api/growth/trajectory")
    async def growth_trajectory(request: Request):
        """
        Actual monthly net sales (up to 26 months back) merged with the required
        path milestones, for the trajectory chart.
        """
        baseline   = _get_t12m_baseline()
        assumption = _get_current_assumption()
        bm         = baseline["t12m_monthly"]
        milestones, r = compute_milestones(assumption, bm)

        actuals = _get_actuals_by_month(months_back=26)
        actual_by_month = {a["month_start"]: a for a in actuals}

        # Build merged rows covering past 24 months + future 24 months
        base_date = _last_complete_month_start()
        today_cm  = str(_current_month_start())

        rows = []
        for m in milestones:
            if m["month_offset"] < -24 or m["month_offset"] > 24:
                continue
            a = actual_by_month.get(m["month_start"], {})
            row = {
                "month_start":    m["month_start"],
                "month_offset":   m["month_offset"],
                "required":       m["monthly_target"],
                "same_store_req": m["same_store_req"],
                "online_req":     m["online_req"],
                "new_stores_req": m["new_stores_req"],
                "actual_total":   a.get("actual_total"),
                "actual_retail":  a.get("actual_retail"),
                "actual_online":  a.get("actual_online"),
                "is_mtd":         a.get("is_mtd", m["month_start"] == today_cm),
            }
            rows.append(row)

        return JSONResponse({
            "monthly_rate_pct": round(r * 100, 4),
            "baseline_monthly": bm,
            "target_kes":       assumption.get("target_kes", TARGET_KES_DEFAULT),
            "rows":             rows,
        })

    @app.get("/api/growth/store-paths")
    async def growth_store_paths(request: Request):
        """
        Per-store T12M contribution and MTD vs required path.
        Only retail (physical stores). New-store lever is aggregate-only.
        """
        baseline   = _get_t12m_baseline()
        assumption = _get_current_assumption()
        bm         = baseline["t12m_monthly"]
        milestones, _ = compute_milestones(assumption, bm)

        cm_start_s = str(_current_month_start())
        cm_row     = next((m for m in milestones if m["month_start"] == cm_start_s), None)
        ss_monthly = cm_row["same_store_req"] if cm_row else bm * (assumption.get("same_store_pct", 60) / 100.0)

        stores       = _get_store_t12m_and_mtd()
        total_retail = sum(s["t12m_net"] for s in stores)
        elapsed      = _days_elapsed_this_month()
        total_days   = _days_in_month(_current_month_start())

        results = []
        for s in stores:
            share              = s["t12m_net"] / total_retail if total_retail > 0 else 0.0
            store_monthly_req  = round(share * ss_monthly, 0)
            store_mtd_req      = round(store_monthly_req * elapsed / total_days, 0)
            gap_kes            = round(s["mtd_net"] - store_mtd_req, 0)
            gap_pct            = round(gap_kes / store_mtd_req * 100, 1) if store_mtd_req else 0.0
            status = (
                "ahead"   if gap_pct >= 0
                else "at_risk" if gap_pct >= -15
                else "behind"
            )
            results.append({
                "store":           s["store"],
                "t12m_net":        s["t12m_net"],
                "retail_share_pct": round(share * 100, 1),
                "monthly_req":     store_monthly_req,
                "mtd_req":         store_mtd_req,
                "mtd_actual":      s["mtd_net"],
                "gap_kes":         gap_kes,
                "gap_pct":         gap_pct,
                "status":          status,
            })

        # Sort: behind first (most negative gap), then by gap_pct
        results.sort(key=lambda x: x["gap_kes"])

        return JSONResponse({
            "stores":          results,
            "total_retail_t12m": total_retail,
            "same_store_monthly_req": ss_monthly,
            "elapsed_days":    elapsed,
            "total_days":      total_days,
        })

    @app.get("/api/growth/assumptions")
    async def growth_assumptions_list(request: Request):
        rows = _db_exec(
            """SELECT id, version, target_kes, target_months, same_store_pct,
                      new_stores_pct, online_pct, notes, author_email,
                      created_at::text, is_current
               FROM growth_model_assumptions
               ORDER BY version DESC
               LIMIT 50""",
            fetch=True,
        ) or []
        return JSONResponse({"versions": [dict(r) for r in rows]})

    @app.post("/api/growth/assumptions")
    async def growth_save_assumptions(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        if user.get("role") not in ("admin", "leadership"):
            return JSONResponse({"error": "leadership or admin access required"}, status_code=403)

        body = await request.json()
        ss   = float(body.get("same_store_pct", _DEFAULT_SAME_STORE_PCT))
        ns   = float(body.get("new_stores_pct", _DEFAULT_NEW_STORES_PCT))
        on   = float(body.get("online_pct",     _DEFAULT_ONLINE_PCT))
        tkes = float(body.get("target_kes",     TARGET_KES_DEFAULT))
        tmo  = int(body.get("target_months",    TARGET_MONTHS_DEFAULT))
        notes  = str(body.get("notes", "")).strip()[:500]
        author = str(user.get("email") or user.get("id") or "unknown")

        if abs(ss + ns + on - 100.0) > 0.01:
            return JSONResponse(
                {"error": "same_store_pct + new_stores_pct + online_pct must sum to 100"},
                status_code=400,
            )

        # Get next version number
        vrow = _db_exec(
            "SELECT COALESCE(MAX(version), 0) AS maxv FROM growth_model_assumptions",
            fetch=True,
        ) or [{"maxv": 0}]
        next_ver = int(vrow[0].get("maxv") or 0) + 1

        # Clear current flag, insert new version
        _db_exec("UPDATE growth_model_assumptions SET is_current=FALSE", fetch=False)
        rows = _db_exec(
            """INSERT INTO growth_model_assumptions
                   (version, target_kes, target_months, same_store_pct,
                    new_stores_pct, online_pct, notes, author_email, is_current)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,TRUE)
               RETURNING id, version""",
            (next_ver, tkes, tmo, ss, ns, on, notes, author),
            fetch=True,
        )
        new_id = rows[0]["id"] if rows else None
        return JSONResponse({"ok": True, "version": next_ver, "id": new_id})

    @app.post("/api/growth/path-impact")
    async def growth_path_impact(request: Request):
        """
        AI digest helper: given a KES delta and a date, returns how that
        delta moves the needle on the monthly growth path milestone.
        """
        body     = await request.json()
        delta    = float(body.get("delta_kes", 0))
        d_str    = body.get("date")
        store    = body.get("store")
        result   = get_path_impact(delta, d_str, store)
        return JSONResponse(result if result else {"error": "no assumption configured"})

    log.info("Growth Model routes registered")
