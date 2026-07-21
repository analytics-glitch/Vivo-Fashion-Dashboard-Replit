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

import asyncio
import json
import logging
import math
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
import desk_utils as du

log = logging.getLogger("retail_desk")

A = None  # api_pg module ref — set in register_retail_desk_routes()

# ── AI client (shared lazy singleton pattern) ──────────────────────────────────

_ai_lock = threading.Lock()
_ai_inst = None

# ── Module-level TTL cache for heavy read functions ───────────────────────────
_FC_LOCK = threading.Lock()
_FC: dict = {}  # key -> {"data": ..., "at": float}

HAIKU  = "claude-haiku-4-5"
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


def _fc(key: str, ttl: float, fn):
    """Thread-safe TTL cache. Returns cached data if fresh, else calls fn()."""
    now = time.time()
    with _FC_LOCK:
        entry = _FC.get(key)
        if entry and now - entry["at"] < ttl:
            return entry["data"]
    data = fn()
    with _FC_LOCK:
        _FC[key] = {"data": data, "at": time.time()}
    return data


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
    "ALTER TABLE IF EXISTS retail_desk_coaching_log ADD COLUMN IF NOT EXISTS analysis JSONB",
    """CREATE TABLE IF NOT EXISTS retail_desk_predictions (
        id                  BIGSERIAL PRIMARY KEY,
        store               TEXT NOT NULL,
        run_date            DATE NOT NULL DEFAULT CURRENT_DATE,
        metric_name         TEXT,
        prediction_text     TEXT NOT NULL,
        current_value       TEXT,
        predicted_value     TEXT,
        time_horizon        TEXT,
        confidence          TEXT DEFAULT 'medium',
        rationale           TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accurate','inaccurate','partial')),
        actual_value        TEXT,
        actual_recorded_at  TIMESTAMPTZ,
        recorded_by         TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS rdp_store_date ON retail_desk_predictions (store, run_date DESC)",
    """CREATE TABLE IF NOT EXISTS retail_desk_corrections (
        id              BIGSERIAL PRIMARY KEY,
        store           TEXT NOT NULL,
        analysis_date   DATE NOT NULL DEFAULT CURRENT_DATE,
        correction_text TEXT NOT NULL,
        submitted_by    TEXT,
        submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied         BOOLEAN DEFAULT FALSE
    )""",
    "CREATE INDEX IF NOT EXISTS rdc_store ON retail_desk_corrections (store, analysis_date DESC)",
    # v2 — enriched issue register
    "ALTER TABLE IF EXISTS retail_desk_issues ADD COLUMN IF NOT EXISTS rule_key TEXT",
    "ALTER TABLE IF EXISTS retail_desk_issues ADD COLUMN IF NOT EXISTS kes_impact FLOAT",
    "ALTER TABLE IF EXISTS retail_desk_issues ADD COLUMN IF NOT EXISTS owner_role TEXT",
    "ALTER TABLE IF EXISTS retail_desk_issues ADD COLUMN IF NOT EXISTS auto_resolved BOOLEAN DEFAULT FALSE",
    # v2 — actions queue
    """CREATE TABLE IF NOT EXISTS retail_desk_actions (
        id              BIGSERIAL PRIMARY KEY,
        store           TEXT NOT NULL,
        action_text     TEXT NOT NULL,
        owner           TEXT,
        due_date        DATE,
        status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_progress','done','deferred')),
        expected_kes    FLOAT,
        source          TEXT DEFAULT 'manual',
        issue_id        BIGINT,
        created_at      TIMESTAMPTZ DEFAULT now(),
        updated_at      TIMESTAMPTZ DEFAULT now(),
        closed_at       TIMESTAMPTZ,
        closed_by       TEXT,
        outcome         TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS rda_store ON retail_desk_actions (store, status, due_date)",
]

# ── Non-selling location exclusion ────────────────────────────────────────────

_HOLDING_KEYWORDS = (
    "warehouse", "wh ", "holding", " wh", "transit", "hub",
    "offsite", "off site", "stockroom", "distribution",
)

def _is_holding_location(name: str) -> bool:
    n = (name or "").lower()
    return any(kw in n for kw in _HOLDING_KEYWORDS)

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

        bf  = _base_filters().replace("%", "%%")
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
    """Cached (5 min) fleet-level sales aggregates — the heaviest query on this router."""
    return _fc("store_t12m", 300, _store_t12m_query)


def _store_t12m_query():
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
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - 90
                      THEN {_NET_S} ELSE 0 END), 0) AS t3m_net,
            ROUND(SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - 180
                           AND s.sale_date::date < CURRENT_DATE - 90
                      THEN {_NET_S} ELSE 0 END), 0) AS t3m_prev_net,
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
            "store":            r["store"],
            "country":          r["country"],
            "t12m_net":         float(r.get("t12m_net")         or 0),
            "mtd_net":          float(r.get("mtd_net")          or 0),
            "l28d_net":         float(r.get("l28d_net")         or 0),
            "prev28d_net":      float(r.get("prev28d_net")      or 0),
            "t3m_net":          float(r.get("t3m_net")          or 0),
            "t3m_prev_net":     float(r.get("t3m_prev_net")     or 0),
            "mtd_transactions": int(r.get("mtd_transactions")   or 0),
            "mtd_avg_basket":   float(r.get("mtd_avg_basket")   or 0),
        }
        for r in rows
        if r.get("store")
           and r["store"] not in ("Staff purchases",)
           and not _is_holding_location(r["store"])
    ]


def _get_store_weekly_trend(store: str, weeks: int = 8):
    bf  = _base_filters().replace("%", "%%")
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
    bf  = _base_filters().replace("%", "%%")
    sql = f"""
        SELECT
            COALESCE(p.product_type, 'Unknown') AS category,
            ROUND(SUM({_NET_S}), 0) AS net_sales
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
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


# ── Composite status model (v2 — 4 buckets) ───────────────────────────────────

def _composite_status(
    gap_pct: float,
    mom_pct: float | None,
    run_rate_gap_pct: float | None,
    weeks_behind: int,
) -> str:
    """
    Compute a discriminating 4-bucket status:
      act_now      — structural underperformance, needs immediate management action
      watch        — slipping or mixed signals; monitor closely
      on_track     — meeting or near growth path with stable trend
      outperforming — materially ahead of path AND accelerating
    """
    gp = gap_pct if gap_pct is not None else 0.0
    mp = mom_pct if mom_pct is not None else 0.0
    rr = run_rate_gap_pct if run_rate_gap_pct is not None else 0.0

    # Hard escalation to Act Now
    if weeks_behind >= 4:
        return "act_now"
    if gp <= -25:
        return "act_now"
    if gp <= -15 and mp <= -10:
        return "act_now"
    if gp <= -10 and mp <= -20:
        return "act_now"

    # Watch — path negative OR falling fast despite being ahead
    if gp <= -15:
        return "watch"
    if gp >= 0 and mp <= -15:
        return "watch"      # ahead-on-path but declining sharply
    if -15 < gp < 0 and mp <= -5:
        return "watch"
    if weeks_behind >= 2:
        return "watch"
    if gp >= 0 and rr <= -15:
        return "watch"      # run-rate crumbling even if MTD OK

    # Outperforming — materially ahead + accelerating
    if gp >= 20 and mp >= 8:
        return "outperforming"
    if gp >= 15 and mp >= 5 and rr >= 0:
        return "outperforming"

    # Marginal recovery: small gap but trend improving
    if -10 <= gp < 0 and mp >= 10:
        return "on_track"

    # Default positive
    if gp >= 0:
        return "on_track"

    return "watch"


# ── Batch extended metrics (all retail stores in one query) ────────────────────

def _get_batch_extended_metrics() -> dict:
    """Single L28D query for basket, UPT, discount depth, returns across all stores."""
    return _fc("batch_ext", 600, _batch_ext_query)


def _batch_ext_query() -> dict:
    bf = _base_filters().replace("%", "%%")
    try:
        rows = _db_exec(
            f"""
            SELECT
                s.pos_location_name                                            AS store,
                COUNT(*) FILTER (WHERE s.sale_kind IN ('sale','order'))        AS sale_txns,
                COUNT(*) FILTER (WHERE s.sale_kind = 'return')                 AS return_txns,
                COALESCE(SUM(s.ordered_item_quantity)
                    FILTER (WHERE s.sale_kind IN ('sale','order')), 0)         AS units_sold,
                COALESCE(SUM(s.total_sales_kes::numeric)
                    FILTER (WHERE s.sale_kind IN ('sale','order')), 0)         AS gross,
                COALESCE(SUM(COALESCE(s.discounts_kes,0)::numeric), 0)        AS disc,
                COALESCE(SUM(COALESCE(s.returns_kes,0)::numeric)
                    FILTER (WHERE s.sale_kind = 'return'), 0)                  AS ret_kes
            FROM all_sales s
            WHERE s.sale_date::date >= CURRENT_DATE - 28
              AND {_IS_RETAIL}
              AND {bf}
            GROUP BY s.pos_location_name
            HAVING COUNT(*) > 10
            """,
            fetch=True,
        ) or []
    except Exception as e:
        log.warning("_batch_ext_query error: %s", e)
        return {}
    out = {}
    for r in rows:
        store     = r.get("store") or ""
        if not store or _is_holding_location(store):
            continue
        sale_txns   = int(r.get("sale_txns")   or 0)
        return_txns = int(r.get("return_txns") or 0)
        units_sold  = float(r.get("units_sold") or 0)
        gross       = float(r.get("gross")      or 0)
        disc        = float(r.get("disc")       or 0)
        ret_kes     = float(r.get("ret_kes")    or 0)
        total_txns  = sale_txns + return_txns
        out[store] = {
            "sale_txns":       sale_txns,
            "discount_depth":  round(disc / gross * 100, 1) if gross > 0 else None,
            "returns_rate":    round(return_txns / total_txns * 100, 1) if total_txns > 0 else None,
            "upt":             round(units_sold / sale_txns, 2) if sale_txns > 0 else None,
            "avg_basket_net":  round((gross - disc - ret_kes) / sale_txns, 0) if sale_txns > 0 else None,
        }
    return out


def _get_batch_dead_stock() -> dict:
    """Dead-stock units per store (no sale in 90d). Pre-aggregates inventory by SKU first."""
    return _fc("batch_dead", 600, _batch_dead_query)


def _batch_dead_query() -> dict:
    try:
        rows = _db_exec(
            """
            WITH store_soh AS (
                SELECT pos_location_name AS store, sku, SUM(COALESCE(available,0)) AS soh
                FROM all_inventory
                WHERE COALESCE(available, 0) > 0
                GROUP BY pos_location_name, sku
            ),
            recent_sales AS (
                SELECT variant_sku AS sku, pos_location_name AS store,
                       MAX(sale_date::date) AS last_sold
                FROM all_sales
                WHERE sale_kind IN ('sale','order')
                  AND sale_date::date >= CURRENT_DATE - 365
                GROUP BY variant_sku, pos_location_name
            )
            SELECT
                ss.store,
                SUM(ss.soh)                                                       AS total_soh,
                SUM(CASE WHEN rs.last_sold IS NULL OR rs.last_sold < CURRENT_DATE - 90
                         THEN ss.soh ELSE 0 END)                                  AS dead_soh
            FROM store_soh ss
            LEFT JOIN recent_sales rs ON rs.sku = ss.sku AND rs.store = ss.store
            GROUP BY ss.store
            """,
            fetch=True,
        ) or []
    except Exception as e:
        log.warning("_batch_dead_query error: %s", e)
        return {}
    return {
        r["store"]: {
            "total_soh": int(r.get("total_soh") or 0),
            "dead_soh":  int(r.get("dead_soh")  or 0),
            "dead_pct":  round(float(r["dead_soh"] or 0) / float(r["total_soh"]) * 100, 1)
                         if (r.get("total_soh") or 0) > 0 else 0.0,
        }
        for r in rows
        if r.get("store") and not _is_holding_location(r["store"])
    }


def _get_batch_unknown_category() -> dict:
    """Unknown-category sales fraction per store (L28D)."""
    return _fc("batch_unkcat", 600, _batch_unkcat_query)


def _batch_unkcat_query() -> dict:
    bf = _base_filters().replace("%", "%%")
    try:
        rows = _db_exec(
            f"""
            SELECT
                s.pos_location_name AS store,
                COUNT(*) AS total_lines,
                COUNT(*) FILTER (WHERE p.product_type IS NULL
                                    OR TRIM(p.product_type) = ''
                                    OR LOWER(p.product_type) = 'unknown') AS unk_lines
            FROM all_sales s
            LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_date::date >= CURRENT_DATE - 28
              AND {_IS_RETAIL}
              AND {bf}
            GROUP BY s.pos_location_name
            HAVING COUNT(*) > 50
            """,
            fetch=True,
        ) or []
    except Exception as e:
        log.warning("_batch_unkcat_query error: %s", e)
        return {}
    return {
        r["store"]: round(float(r["unk_lines"] or 0) / float(r["total_lines"]) * 100, 1)
        for r in rows
        if r.get("store") and (r.get("total_lines") or 0) > 0
    }


# ── Deterministic issue scanner (v2, replaces _auto_flag_issues) ───────────────

_SCAN_CACHE_TTL = 600  # 10 minutes — scan runs once per TTL window
_SCAN_LOCK      = threading.Lock()
_SCAN_LAST_AT   = 0.0


def _deterministic_scan_all(stores_data: list, path_data: dict, bench: dict):
    """
    Run the deterministic rule engine across all retail stores.
    Creates issues for triggered rules (deduped by rule_key + store + 14-day window).
    Auto-closes issues where the triggering metric has normalised.
    Throttled to once per _SCAN_CACHE_TTL seconds.
    """
    global _SCAN_LAST_AT
    now = time.time()
    with _SCAN_LOCK:
        if now - _SCAN_LAST_AT < _SCAN_CACHE_TTL:
            return
        _SCAN_LAST_AT = now

    try:
        ext   = _get_batch_extended_metrics()
        dead  = _get_batch_dead_stock()
        unkcat = _get_batch_unknown_category()
        fleet_basket = bench.get("avg_basket", 0)
        fleet_disc   = bench.get("avg_disc_depth_pct", 11.0)
        fleet_upt    = bench.get("avg_upt", 2.2)
    except Exception as e:
        log.warning("_deterministic_scan_all prep error: %s", e)
        return

    for s in stores_data:
        store    = s["store"]
        pd_s     = path_data.get(store, {})
        gap_pct  = pd_s.get("gap_pct", 0)
        gap_kes  = pd_s.get("gap_kes", 0)
        l28d     = s.get("l28d_net", 0)
        prev28d  = s.get("prev28d_net", 0)
        t3m      = s.get("t3m_net", 0)
        t3m_prev = s.get("t3m_prev_net", 0)
        mom_pct  = round((l28d - prev28d) / prev28d * 100, 1) if prev28d else None
        rr_gap   = round((t3m - t3m_prev) / t3m_prev * 100, 1) if t3m_prev else None
        weeks_b  = _weeks_behind_count(store)

        ex   = ext.get(store, {})
        ds   = dead.get(store, {})
        unk  = unkcat.get(store, 0)

        upt       = ex.get("upt")
        disc_d    = ex.get("discount_depth")
        ret_rate  = ex.get("returns_rate")
        basket    = ex.get("avg_basket_net")
        dead_pct  = ds.get("dead_pct", 0)
        dead_soh  = ds.get("dead_soh", 0)

        rules = []  # (rule_key, title, body, severity, kes_impact, owner_role, active)

        # R1: consecutive weeks behind path
        if weeks_b >= 3:
            sev    = "high" if weeks_b >= 5 else "medium"
            k_imp  = abs(gap_kes) if gap_kes < 0 else 0
            rules.append((
                "consecutive_weeks_behind",
                f"{weeks_b} consecutive weeks behind growth path",
                f"MTD gap: KES {gap_kes:,.0f} ({gap_pct:+.1f}%%) vs prorated target. {weeks_b} weeks running.",
                sev, k_imp, "Store Manager", True,
            ))
        else:
            rules.append(("consecutive_weeks_behind", None, None, None, None, None, False))

        # R2: MoM critical decline
        mom_active = mom_pct is not None and mom_pct <= -15
        rules.append((
            "mom_critical",
            f"Revenue falling sharply: {mom_pct:+.1f}%% MoM" if mom_active else None,
            (f"L28D net KES {l28d:,.0f} vs prior 28D KES {prev28d:,.0f} — "
             f"{mom_pct:+.1f}%% MoM. Persistent decline signals structural issue.") if mom_active else None,
            "high" if mom_active else None,
            abs(l28d - prev28d) if mom_active else None,
            "Area Manager", mom_active,
        ))

        # R3: MoM moderate decline (only if not also R2)
        mom_med_active = mom_pct is not None and -15 < mom_pct <= -10
        rules.append((
            "mom_declining",
            f"Revenue declining: {mom_pct:+.1f}%% MoM" if mom_med_active else None,
            f"L28D vs prior 28D: {mom_pct:+.1f}%%. Trend needs attention." if mom_med_active else None,
            "medium", abs(l28d - prev28d) * 0.5 if mom_med_active and prev28d else None,
            "Store Manager", mom_med_active,
        ))

        # R4: Low basket vs fleet
        basket_active = basket is not None and fleet_basket > 0 and basket < fleet_basket * 0.70
        basket_gap_kes = (fleet_basket - basket) * ex.get("sale_txns", 0) if basket_active else None
        rules.append((
            "basket_low",
            f"Basket below fleet avg: KES {basket:,.0f} vs {fleet_basket:,.0f} fleet" if basket_active else None,
            (f"Store average basket KES {basket:,.0f} is {round((fleet_basket-basket)/fleet_basket*100,1)}%% "
             f"below fleet avg KES {fleet_basket:,.0f}. Cross-sell opportunity.") if basket_active else None,
            "medium", basket_gap_kes, "Floor Supervisor", basket_active,
        ))

        # R5: UPT critically low (near single-item checkout)
        upt_active = upt is not None and upt <= 1.10
        upt_opp = (fleet_upt - upt) * ex.get("sale_txns", 0) * (basket / (upt or 1)) if upt_active and basket else None
        rules.append((
            "upt_low",
            f"Low units per transaction: {upt:.2f} UPT (fleet {fleet_upt:.2f})" if upt_active else None,
            f"Average {upt:.2f} units per sale — nearly all transactions single-item. Cross-sell training required." if upt_active else None,
            "medium", round(upt_opp, 0) if upt_opp else None, "Floor Supervisor", upt_active,
        ))

        # R6: Discount depth excessive
        disc_active = disc_d is not None and fleet_disc > 0 and disc_d > fleet_disc + 8
        disc_excess_kes = (disc_d - fleet_disc) / 100 * l28d * 4 if disc_active and l28d else None
        rules.append((
            "discount_heavy",
            f"Excessive discounting: {disc_d:.1f}%% depth (fleet {fleet_disc:.1f}%%)" if disc_active else None,
            (f"Discount depth {disc_d:.1f}%% — {round(disc_d-fleet_disc,1)}pp above fleet average. "
             f"Review markdowns and cashier authorisation levels.") if disc_active else None,
            "medium", round(disc_excess_kes, 0) if disc_excess_kes else None,
            "Store Manager", disc_active,
        ))

        # R7: Dead stock critical
        dead_hi = dead_pct > 30
        dead_md = 15 < dead_pct <= 30
        dead_kes_trapped = dead_soh * 800 if (dead_hi or dead_md) else None  # rough cost estimate
        if dead_hi:
            rules.append((
                "dead_stock_critical",
                f"Dead stock crisis: {dead_pct:.0f}%% of SOH not sold in 90+ days",
                f"{dead_soh:,} units ({dead_pct:.0f}%% of SOH) with no sale in 90 days. Cash trapped in stale stock.",
                "high", dead_kes_trapped, "Area Manager", True,
            ))
        else:
            rules.append(("dead_stock_critical", None, None, None, None, None, False))
        if dead_md:
            rules.append((
                "dead_stock_elevated",
                f"Dead stock elevated: {dead_pct:.0f}%% of SOH aged >90 days",
                f"{dead_soh:,} units ({dead_pct:.0f}%% SOH) with no recent sale. Consider IBT or clearance.",
                "medium", dead_kes_trapped, "Store Manager", True,
            ))
        else:
            rules.append(("dead_stock_elevated", None, None, None, None, None, False))

        # R8: Run-rate structural decline
        rr_active = rr_gap is not None and rr_gap <= -15
        rules.append((
            "run_rate_declining",
            f"Run-rate declining {rr_gap:+.1f}%% vs prior quarter" if rr_active else None,
            (f"T3M KES {t3m:,.0f} vs prior T3M KES {t3m_prev:,.0f} — "
             f"{rr_gap:+.1f}%%. Sustained underperformance beyond a single month.") if rr_active else None,
            "high", abs(t3m - t3m_prev) if rr_active else None, "Area Manager", rr_active,
        ))

        # R9: Unknown category data quality
        unk_active = unk > 15
        rules.append((
            "unknown_category",
            f"Data quality: {unk:.0f}%% of sales have no product category" if unk_active else None,
            f"{unk:.0f}%% of L28D sale lines have no product_type. Reports and replenishment signals are unreliable." if unk_active else None,
            "low", None, "Merchandising", unk_active,
        ))

        # Apply rules: upsert open issues / auto-close resolved ones
        for rule_key, title, body, severity, kes_impact, owner_role, active in rules:
            try:
                existing = _db_exec(
                    """SELECT id, status FROM retail_desk_issues
                       WHERE store = %s AND rule_key = %s
                         AND opened_at >= NOW() - INTERVAL '30 days'
                       ORDER BY opened_at DESC LIMIT 1""",
                    (store, rule_key), fetch=True,
                )
                existing_open = next((r for r in (existing or []) if r.get("status") == "open"), None)
                if active and not existing_open and title:
                    _db_exec(
                        """INSERT INTO retail_desk_issues
                               (store, title, body, source, severity, gap_kes, gap_pct,
                                week_behind, rule_key, kes_impact, owner_role)
                           VALUES (%s,%s,%s,'auto',%s,%s,%s,%s,%s,%s,%s)""",
                        (store, title, body, severity, gap_kes, gap_pct,
                         weeks_b, rule_key, kes_impact, owner_role),
                        fetch=False,
                    )
                    log.info("Issue created: %s / %s", store, rule_key)
                elif not active and existing_open:
                    # Auto-resolve — metric has normalised
                    _db_exec(
                        """UPDATE retail_desk_issues
                           SET status='closed', closed_at=NOW(), auto_resolved=TRUE,
                               body = body || E'\n\n[Auto-resolved: metric normalised]'
                           WHERE id = %s""",
                        (existing_open["id"],), fetch=False,
                    )
                    log.info("Auto-resolved issue: %s / %s", store, rule_key)
            except Exception as e:
                log.warning("Issue rule error %s/%s: %s", store, rule_key, e)


def _build_store_path_data():
    """Cached (5 min) growth-path distribution per store."""
    return _fc("store_path", 300, _store_path_query)


def _store_path_query():
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


# ── AI Retail Analyst ─────────────────────────────────────────────────────────

_STORE_ANALYST_SYSTEM = """You are an autonomous AI Retail Analyst embedded in the Vivo BI dashboard.
Vivo Fashion Group is a vertically-integrated fashion retailer across East Africa (Kenya ~84%% of POS revenue, Uganda, Rwanda, Online). All amounts in KES.

FLEET BENCHMARKS (apply as reference — do not override with provided actuals):
• Discount depth: 11%% fleet avg; >18%% = margin risk; >22%% = critical
• Returns rate (transactions): 8%% avg; >14%% = product/fit/ops issue
• Units per transaction (UPT): 2.2 avg; <1.8 = cross-sell miss; >2.8 = strong attach
• Returning customer %%: >30%% healthy; <20%% = retention risk
• Dead stock %%: <10%% healthy; 10-15%% elevated; >15%% = cash trap
• Conversion (footfall sensor): typical 20-30%%; <15%% = floor execution issue; >35%% = strong
• MoM growth: >=0%% on trend; -10%% or worse = structural concern

STANDING RULES — apply every analysis, no exceptions:
1. Lead with the verdict: one of "performing", "underperforming", or "mixed" — and state the single most important action.
2. Show both sides: report what is working AND what is misbehaving. A winning store has a leak; a losing store has a strength.
3. Name the metric, not the mood: every claim must have metric + actual value + benchmark + variance + driver.
4. Separate signal from noise: flag which movements are real/actionable vs seasonal, one-off, or low-confidence.
5. Trace to root cause, not symptom: falling revenue is a symptom — is it footfall, conversion, basket, stock depth, or pricing?
6. Surface the opportunity: always quantify the biggest upside in KES. If you can't quantify exactly, estimate a range.
7. Prescribe, don't describe: every misbehaving metric must end in a concrete action with an owner and deadline.
8. Never guess: if data is missing, say so and name what it would have told you.
9. Justify each metric you select: one line explaining why this metric matters for this store.
10. Rank by impact, not by convenience: lead with the biggest lever, not the easiest one to spot.
11. Escalate consecutive-weeks-behind: if weeks_behind >= 3, the top_action must name escalation + a specific manager intervention.
12. Stale issues are a system failure: if open issues are unflagged >7 days, call this out explicitly in misbehaving or actions.
13. Only report actuals from the data provided — never fabricate or extrapolate values not given.
14. Keep predictions falsifiable: every prediction must state the metric, the predicted value, the time horizon, and the rationale.
15. Corrections are binding: if prior corrections are provided, do NOT repeat flagged mistakes — apply them immediately.
16. Limit output: max 3 items each in what_working, what_misbehaving, signal_vs_noise, actions; max 2 predictions.

OUTPUT: Return valid JSON only. No markdown fences. No commentary outside the JSON object.

JSON SCHEMA (follow exactly — output fields in this order):
{
  "verdict": "performing|underperforming|mixed",
  "top_action": "single most important action — specific, named owner, actionable today",
  "what_working": [
    {
      "metric": "string",
      "value": "string with unit",
      "benchmark": "string with unit",
      "variance": "string e.g. +9%% or +7pp",
      "driver": "one specific cause",
      "why_chosen": "why this metric matters for this store"
    }
  ],
  "what_misbehaving": [
    {
      "metric": "string",
      "value": "string with unit",
      "benchmark": "string with unit",
      "variance": "string e.g. -12%% or +7pp",
      "root_cause": "specific root cause, not a symptom",
      "action": "concrete prescriptive action",
      "owner": "specific role or person",
      "expected_impact": "quantified where possible",
      "why_chosen": "why this metric matters for this store"
    }
  ],
  "signal_vs_noise": [
    {
      "type": "signal|noise",
      "item": "what the pattern is",
      "reason": "why it is signal or noise"
    }
  ],
  "opportunity": {
    "description": "string",
    "kes_upside": 0,
    "lever": "string",
    "how": "string — concrete steps"
  },
  "actions": [
    {
      "action": "string",
      "owner": "string",
      "deadline": "string e.g. this week / by Friday",
      "expected_impact": "string",
      "kes_impact": null
    }
  ],
  "predictions": [
    {
      "metric": "string",
      "current_value": "string with unit",
      "predicted_value": "string with unit",
      "time_horizon": "4 weeks",
      "rationale": "string",
      "confidence": "high|medium|low"
    }
  ],
  "metric_map": {
    "available": ["list of metrics you can actually compute from the data provided"],
    "absent": [{"metric": "name", "would_have_told_you": "what this gap hides"}]
  },
  "data_gaps": "string — what additional data would most improve this analysis"
}"""


def _run_store_analysis(
    store: str,
    store_data: dict,
    path_data: dict,
    issues: list,
    categories: list,
) -> dict:
    """Full 6-part structured analysis. Returns parsed dict (may be empty on failure)."""
    if not _ai_configured():
        return {}
    import json as _json

    try:
        weeks_behind  = _weeks_behind_count(store)
        open_issues   = [i for i in issues if i.get("status") == "open"]
        stale_issues  = [
            i for i in open_issues
            if i.get("opened_at") and
               (datetime.now(timezone.utc) - (
                   i["opened_at"] if hasattr(i["opened_at"], "tzinfo")
                   else datetime.fromisoformat(str(i["opened_at"])).replace(tzinfo=timezone.utc)
               )).days > 7
        ]

        pd_store   = path_data.get(store, {})
        ext        = _get_store_extended_metrics(store)
        ff         = _get_store_footfall_l28d(store)
        stock      = _get_store_stock_metrics(store)
        bench      = _get_network_benchmarks()
        corrections = _get_store_corrections(store)

        def _fmt(v, default="unavailable"):
            if v is None:
                return default
            if isinstance(v, float):
                return f"{v:,.1f}"
            if isinstance(v, int):
                return f"{v:,}"
            return str(v)

        corrections_block = "None"
        if corrections:
            corrections_block = "\n".join(
                f"  [{c['date']}] {c['text']}" for c in corrections
            )

        weekly_rows = store_data.get("weekly", []) or []
        weekly_block = "  No data"
        if weekly_rows:
            weekly_block = "\n".join(
                f"  {w.get('week_start','?')}: KES {float(w.get('net_sales',0)):,.0f}"
                for w in weekly_rows[-8:]
            )

        ff_block = "  Footfall sensor: not available for this store"
        if ff.get("available"):
            ff_block = (
                f"  Visitors L28D: {_fmt(ff.get('visitors_l28d'))}\n"
                f"  Avg conversion: {_fmt(ff.get('avg_conversion_pct'))}%%"
            )

        stock_block = "  Stock data: not available"
        if stock.get("available"):
            stock_block = (
                f"  Store SOH (units): {_fmt(stock.get('total_soh'))}\n"
                f"  Active SKUs with stock: {_fmt(stock.get('sku_count'))}\n"
                f"  Dead stock (no sale L90D): {_fmt(stock.get('dead_soh'))} units "
                f"({_fmt(stock.get('dead_pct'))}%% of SOH)"
            )

        context = f"""STORE: {store}
COUNTRY: {store_data.get('country','?')}
ANALYSIS DATE: {date.today().isoformat()}
CONSECUTIVE WEEKS BEHIND MILESTONE: {weeks_behind}

=== GROWTH PATH (current month) ===
Monthly target: KES {pd_store.get('monthly_req', 0):,.0f}
MTD required (prorated): KES {pd_store.get('mtd_req', 0):,.0f}
MTD actual: KES {store_data.get('mtd_net', 0):,.0f}
Gap vs path: KES {pd_store.get('gap_kes', 0):,.0f} ({pd_store.get('gap_pct', 0):+.1f}%%)
Path status: {pd_store.get('status','unknown').upper()}
Store share of retail fleet: {pd_store.get('share_pct', 0):.1f}%%

=== SALES PERFORMANCE ===
L28D net sales: KES {store_data.get('l28d_net', 0):,.0f}
Prior 28D net sales: KES {store_data.get('prev28d_net', 0):,.0f}
MoM change: {store_data.get('mom_pct', 0):+.1f}%%
T12M net sales: KES {store_data.get('t12m_net', 0):,.0f}
MTD transactions: {store_data.get('mtd_transactions', 0):,}
MTD avg basket: KES {store_data.get('mtd_avg_basket', 0):,.0f}
Fleet avg basket: KES {bench.get('avg_basket', 0):,.0f}

=== 8-WEEK WEEKLY TREND ===
{weekly_block}

=== OPERATIONAL METRICS (L28D, this store) ===
Discount depth: {_fmt(ext.get('discount_depth_pct'))}%% (fleet avg {bench.get('avg_disc_depth_pct', 11.0):.1f}%%)
Returns rate (transaction %%): {_fmt(ext.get('returns_rate_pct'))}%% (fleet avg {bench.get('avg_returns_rate_pct', 8.0):.1f}%%)
Returns (KES %% of gross): {_fmt(ext.get('returns_kes_pct'))}%%
Units per transaction (UPT): {_fmt(ext.get('upt'))} (fleet avg {bench.get('avg_upt', 2.2):.2f})
Returning customer %%: {_fmt(ext.get('returning_pct'))}%% (fleet avg {bench.get('avg_returning_pct', 25.0):.1f}%%)
New customer %%: {_fmt(ext.get('new_pct'))}%%

=== FOOTFALL & CONVERSION ===
{ff_block}

=== STOCK ===
{stock_block}

=== TOP CATEGORIES (L28D by net sales) ===
{chr(10).join(f"  {c['category']}: KES {c['net_sales']:,.0f}" for c in categories[:5]) or "  No category data"}

=== OPEN ISSUES ({len(open_issues)} total, {len(stale_issues)} stale >7d) ===
{chr(10).join(f"  [{i.get('severity','?').upper()}] {i.get('title','?')} — opened {str(i.get('opened_at','?'))[:10]}" for i in open_issues[:5]) or "  None"}

=== PRIOR CORRECTIONS (apply immediately — do not repeat flagged mistakes) ===
{corrections_block}
"""

        client = _ai_client()
        resp = client.messages.create(
            model=HAIKU,
            max_tokens=4096,
            system=_STORE_ANALYST_SYSTEM,
            messages=[{"role": "user", "content": context}],
        )
        raw = resp.content[0].text.strip() if resp.content else ""

        # Strip accidental markdown fences
        if raw.startswith("```"):
            raw = raw.split("```", 2)[-1 if raw.count("```") == 1 else 1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rstrip("`").strip()

        try:
            analysis = _json.loads(raw)
        except Exception:
            log.warning("Analyst JSON parse failed for %s — raw: %s", store, raw[:200])
            return {}

        # Persist structured analysis in coaching log
        verdict    = analysis.get("verdict", "unknown")
        top_action = analysis.get("top_action", "")
        summary    = f"{verdict.upper()} — {top_action}"
        try:
            _db_exec(
                """INSERT INTO retail_desk_coaching_log (store, run_date, summary, analysis, model)
                   VALUES (%s, CURRENT_DATE, %s, %s, %s)
                   ON CONFLICT (store, run_date) DO UPDATE
                     SET summary = EXCLUDED.summary,
                         analysis = EXCLUDED.analysis,
                         model = EXCLUDED.model""",
                (store, summary, _json.dumps(analysis), HAIKU),
                fetch=False,
            )
        except Exception as e:
            log.warning("Analyst log save error for %s: %s", store, e)

        # Persist predictions in the learning loop table
        _save_predictions(store, analysis.get("predictions", []))

        # Mark corrections as applied
        try:
            _db_exec(
                "UPDATE retail_desk_corrections SET applied = TRUE WHERE store = %s AND applied = FALSE",
                (store,), fetch=False
            )
        except Exception:
            pass

        return analysis

    except Exception as e:
        log.warning("Store analyst error for %s: %s", store, e)
        return {}


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


# ── Extended per-store metric functions ───────────────────────────────────────

def _get_store_extended_metrics(store: str) -> dict:
    """Discount depth, returns rate, UPT, customer mix for L28D."""
    bf = _base_filters().replace("%", "%%")
    sql = f"""
        SELECT
            COUNT(*) FILTER (WHERE s.sale_kind IN ('sale','order'))         AS sale_txns,
            COUNT(*) FILTER (WHERE s.sale_kind = 'return')                  AS return_txns,
            COALESCE(SUM(s.ordered_item_quantity) FILTER (
                WHERE s.sale_kind IN ('sale','order')), 0)                   AS units_sold,
            COALESCE(SUM(s.total_sales_kes::numeric) FILTER (
                WHERE s.sale_kind IN ('sale','order')), 0)                   AS total_gross,
            COALESCE(SUM(s.discounts_kes::numeric), 0)                      AS total_disc,
            COALESCE(SUM(s.returns_kes::numeric)  FILTER (
                WHERE s.sale_kind = 'return'), 0)                            AS total_ret,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(s.customer_type,'')) = 'returning') AS ret_txns,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(s.customer_type,'')) = 'new')       AS new_txns
        FROM all_sales s
        WHERE s.sale_date::date >= CURRENT_DATE - 28
          AND s.pos_location_name = %s
          AND {_IS_RETAIL}
          AND {bf}
    """
    rows = _db_exec(sql, (store,), fetch=True) or []
    if not rows:
        return {}
    r = rows[0]
    sale_txns   = int(r.get("sale_txns") or 0)
    return_txns = int(r.get("return_txns") or 0)
    units_sold  = float(r.get("units_sold") or 0)
    total_gross = float(r.get("total_gross") or 0)
    total_disc  = float(r.get("total_disc") or 0)
    total_ret   = float(r.get("total_ret") or 0)
    ret_cust    = int(r.get("ret_txns") or 0)
    new_cust    = int(r.get("new_txns") or 0)
    total_txns  = sale_txns + return_txns
    ident_txns  = ret_cust + new_cust
    return {
        "discount_depth_pct": round(total_disc / total_gross * 100, 1) if total_gross > 0 else None,
        "returns_rate_pct":   round(return_txns / total_txns * 100, 1) if total_txns > 0 else None,
        "returns_kes_pct":    round(total_ret / total_gross * 100, 1) if total_gross > 0 else None,
        "upt":                round(units_sold / sale_txns, 2) if sale_txns > 0 else None,
        "returning_pct":      round(ret_cust / ident_txns * 100, 1) if ident_txns > 0 else None,
        "new_pct":            round(new_cust / ident_txns * 100, 1) if ident_txns > 0 else None,
    }


def _get_store_footfall_l28d(store: str) -> dict:
    """L28D footfall visitors and avg sensor-reported conversion % for the store."""
    try:
        rows = _db_exec(
            """
            SELECT
                COALESCE(SUM(a01_footfall_in), 0)          AS visitors,
                ROUND(AVG(b06_sales_conversion)::numeric, 1) AS avg_conversion_pct
            FROM footfall
            WHERE pos_location_name = %s
              AND time::date >= CURRENT_DATE - 28
              AND time::date < CURRENT_DATE
              AND a01_footfall_in > 0
            """,
            (store,), fetch=True
        ) or []
        if not rows or not rows[0].get("visitors"):
            return {"available": False}
        r = rows[0]
        return {
            "available":          True,
            "visitors_l28d":      int(r["visitors"] or 0),
            "avg_conversion_pct": float(r["avg_conversion_pct"] or 0),
        }
    except Exception as e:
        log.debug("Footfall query error for %s: %s", store, e)
        return {"available": False}


def _get_store_stock_metrics(store: str) -> dict:
    """Store-level SOH, SKU count, dead-stock units (no sale in L90D)."""
    try:
        rows = _db_exec(
            """
            WITH store_inv AS (
                SELECT
                    i.sku,
                    COALESCE(i.available, 0) AS soh,
                    MAX(s.sale_date) AS last_sold
                FROM all_inventory i
                LEFT JOIN all_sales s
                    ON s.variant_sku = i.sku
                    AND s.pos_location_name = %s
                    AND s.sale_date::date >= CURRENT_DATE - 90
                    AND s.sale_kind IN ('sale','order')
                WHERE i.pos_location_name = %s
                  AND COALESCE(i.available, 0) > 0
                GROUP BY i.sku, i.available
            )
            SELECT
                COUNT(sku)                                          AS sku_count,
                SUM(soh)                                           AS total_soh,
                COUNT(*) FILTER (WHERE last_sold IS NULL)          AS dead_sku_count,
                COALESCE(SUM(soh) FILTER (WHERE last_sold IS NULL), 0) AS dead_soh
            FROM store_inv
            """,
            (store, store), fetch=True
        ) or []
        if not rows:
            return {"available": False}
        r = rows[0]
        total_soh  = int(r.get("total_soh") or 0)
        dead_soh   = int(r.get("dead_soh") or 0)
        return {
            "available":      True,
            "sku_count":      int(r.get("sku_count") or 0),
            "total_soh":      total_soh,
            "dead_sku_count": int(r.get("dead_sku_count") or 0),
            "dead_soh":       dead_soh,
            "dead_pct":       round(dead_soh / total_soh * 100, 1) if total_soh > 0 else 0,
        }
    except Exception as e:
        log.debug("Stock metrics error for %s: %s", store, e)
        return {"available": False}


_BENCH_LOCK = threading.Lock()
_BENCH_CACHE: dict = {}

def _get_network_benchmarks() -> dict:
    """Cached 30-min fleet-wide averages: basket, discount depth, returns, UPT, returning%."""
    key = "benchmarks"
    now = time.time()
    with _BENCH_LOCK:
        e = _BENCH_CACHE.get(key)
        if e and now - e["at"] < 1800:
            return e["data"]
    bf = _base_filters()
    try:
        rows = _db_exec(
            f"""
            SELECT
                ROUND(AVG(basket_per_store)::numeric, 0)           AS avg_basket,
                ROUND(AVG(disc_depth)::numeric, 1)                 AS avg_disc_depth,
                ROUND(AVG(ret_rate)::numeric, 1)                   AS avg_returns_rate,
                ROUND(AVG(upt)::numeric, 2)                        AS avg_upt,
                ROUND(AVG(ret_pct)::numeric, 1)                    AS avg_returning_pct
            FROM (
                SELECT
                    pos_location_name,
                    SUM(total_sales_kes::numeric - COALESCE(discounts_kes,0)::numeric)
                        / NULLIF(COUNT(*) FILTER (WHERE sale_kind IN ('sale','order')), 0) AS basket_per_store,
                    SUM(COALESCE(discounts_kes,0)::numeric)
                        / NULLIF(SUM(total_sales_kes::numeric) FILTER (WHERE sale_kind IN ('sale','order')), 0) * 100 AS disc_depth,
                    COUNT(*) FILTER (WHERE sale_kind = 'return')::float
                        / NULLIF(COUNT(*)::float, 0) * 100          AS ret_rate,
                    SUM(ordered_item_quantity) FILTER (WHERE sale_kind IN ('sale','order'))::float
                        / NULLIF(COUNT(*) FILTER (WHERE sale_kind IN ('sale','order'))::float, 0) AS upt,
                    COUNT(*) FILTER (WHERE LOWER(COALESCE(customer_type,'')) = 'returning')::float
                        / NULLIF((COUNT(*) FILTER (WHERE LOWER(COALESCE(customer_type,'')) IN ('returning','new')))::float, 0) * 100 AS ret_pct
                FROM all_sales s
                WHERE s.sale_date::date >= CURRENT_DATE - 28
                  AND s.country IN ('Kenya','Uganda','Rwanda')
                  AND {bf}
                GROUP BY s.pos_location_name
                HAVING COUNT(*) > 10
            ) bench_agg
            """, fetch=True
        ) or []
        data = {}
        if rows:
            r = rows[0]
            data = {
                "avg_basket":        float(r.get("avg_basket") or 0),
                "avg_disc_depth_pct": float(r.get("avg_disc_depth") or 11.0),
                "avg_returns_rate_pct": float(r.get("avg_returns_rate") or 8.0),
                "avg_upt":           float(r.get("avg_upt") or 2.2),
                "avg_returning_pct": float(r.get("avg_returning_pct") or 25.0),
            }
    except Exception as e:
        log.warning("Benchmarks error: %s", e)
        data = {
            "avg_basket": 0, "avg_disc_depth_pct": 11.0,
            "avg_returns_rate_pct": 8.0, "avg_upt": 2.2, "avg_returning_pct": 25.0,
        }
    with _BENCH_LOCK:
        _BENCH_CACHE[key] = {"data": data, "at": time.time()}
    return data


def _get_store_corrections(store: str) -> list:
    """Return the last 5 applied corrections for this store, formatted for LLM injection."""
    try:
        rows = _db_exec(
            """SELECT correction_text, submitted_at::date AS corr_date
               FROM retail_desk_corrections
               WHERE store = %s
               ORDER BY submitted_at DESC LIMIT 5""",
            (store,), fetch=True
        ) or []
        return [{"date": str(r.get("corr_date", "")), "text": r.get("correction_text", "")}
                for r in rows]
    except Exception as e:
        log.debug("Corrections fetch error for %s: %s", store, e)
        return []


def _save_predictions(store: str, predictions: list):
    """Persist predictions from the structured analysis to retail_desk_predictions."""
    if not predictions:
        return
    for p in predictions[:3]:
        try:
            _db_exec(
                """INSERT INTO retail_desk_predictions
                       (store, metric_name, prediction_text, current_value,
                        predicted_value, time_horizon, confidence, rationale)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (store,
                 p.get("metric"),
                 p.get("metric", "?") + ": " + str(p.get("predicted_value", "?")),
                 p.get("current_value"),
                 p.get("predicted_value"),
                 p.get("time_horizon", "4 weeks"),
                 p.get("confidence", "medium"),
                 p.get("rationale")),
                fetch=False
            )
        except Exception as e:
            log.debug("Prediction save error: %s", e)


# ── Route registration ────────────────────────────────────────────────────────

def register_retail_desk_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request, HTTPException
    from fastapi.responses import JSONResponse

    @app.get("/api/retail-desk/overview")
    async def retail_desk_overview(request: Request):
        """
        All-stores snapshot: composite 4-bucket status, gap KES/%, trend, issues count.
        Runs deterministic rule scan and returns exception queues + fleet coaching.
        """
        stores_data = _get_store_t12m_and_mtd_raw()
        path_data   = _build_store_path_data()
        bench       = _get_network_benchmarks()

        # Run deterministic rule scan (throttled / cached internally)
        try:
            await asyncio.to_thread(_deterministic_scan_all, stores_data, path_data, bench)
        except Exception as e:
            log.warning("deterministic_scan error: %s", e)

        # Open issues + KES at stake per store
        all_open = _db_exec(
            """SELECT store, COUNT(*) AS n,
                      COALESCE(SUM(kes_impact) FILTER (WHERE kes_impact IS NOT NULL), 0) AS total_kes
               FROM retail_desk_issues WHERE status='open' GROUP BY store""",
            fetch=True
        ) or []
        open_by_store = {r["store"]: {"n": int(r["n"]), "kes": float(r["total_kes"] or 0)}
                         for r in all_open}

        # Get top open issue description per store (for exception queue rows)
        top_issues = _db_exec(
            """SELECT DISTINCT ON (store) store, title, severity, rule_key, kes_impact, owner_role
               FROM retail_desk_issues
               WHERE status = 'open'
               ORDER BY store, severity DESC, kes_impact DESC NULLS LAST, opened_at DESC""",
            fetch=True
        ) or []
        top_issue_by_store = {r["store"]: dict(r) for r in top_issues}

        cards = []
        for s in stores_data:
            store   = s["store"]
            pd_s    = path_data.get(store, {})
            l28     = s["l28d_net"]
            p28     = s["prev28d_net"]
            t3m     = s.get("t3m_net", 0)
            t3m_p   = s.get("t3m_prev_net", 0)
            mom_pct = round((l28 - p28) / p28 * 100, 1) if p28 else None
            rr_gap  = round((t3m - t3m_p) / t3m_p * 100, 1) if t3m_p else None
            weeks_b = _weeks_behind_count(store)
            gap_pct = pd_s.get("gap_pct", 0)
            gap_kes = pd_s.get("gap_kes", 0)
            c_status = _composite_status(gap_pct, mom_pct, rr_gap, weeks_b)
            oi      = open_by_store.get(store, {"n": 0, "kes": 0})
            ti      = top_issue_by_store.get(store)
            cards.append({
                "store":            store,
                "country":          s["country"],
                "t12m_net":         s["t12m_net"],
                "mtd_net":          s["mtd_net"],
                "l28d_net":         l28,
                "prev28d_net":      p28,
                "mtd_req":          pd_s.get("mtd_req", 0),
                "gap_kes":          gap_kes,
                "gap_pct":          gap_pct,
                "status":           c_status,
                "path_status":      pd_s.get("status", "unknown"),
                "share_pct":        pd_s.get("share_pct", 0),
                "mom_pct":          mom_pct,
                "run_rate_gap_pct": rr_gap,
                "weeks_behind":     weeks_b,
                "open_issues":      oi["n"],
                "open_issues_kes":  oi["kes"],
                "monthly_req":      pd_s.get("monthly_req", 0),
                "top_issue":        ti,
            })

        # Sort: act_now first (by KES impact), then watch, on_track, outperforming
        STATUS_ORDER = {"act_now": 0, "watch": 1, "on_track": 2, "outperforming": 3}
        cards.sort(key=lambda c: (STATUS_ORDER.get(c["status"], 2), c["gap_kes"]))

        # Fleet summary
        total_stores    = len(cards)
        act_now_count   = sum(1 for c in cards if c["status"] == "act_now")
        watch_count     = sum(1 for c in cards if c["status"] == "watch")
        on_track_count  = sum(1 for c in cards if c["status"] == "on_track")
        outperf_count   = sum(1 for c in cards if c["status"] == "outperforming")
        total_gap_kes   = sum(c["gap_kes"] for c in cards)
        total_mtd       = sum(c["mtd_net"] for c in cards)
        total_mtd_req   = sum(c["mtd_req"] for c in cards)
        total_issues    = sum(c["open_issues"] for c in cards)
        total_issues_kes= sum(c["open_issues_kes"] for c in cards)
        total_gap_pct   = round(total_gap_kes / total_mtd_req * 100, 1) if total_mtd_req else 0

        # Exception queues — pre-built for the UI
        act_now_queue = [
            c for c in cards if c["status"] == "act_now"
        ]
        watch_queue = [
            c for c in cards if c["status"] == "watch"
        ]
        wins_queue = sorted(
            [c for c in cards if c["status"] == "outperforming"],
            key=lambda c: c["gap_pct"], reverse=True
        )

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
                    "act_now": act_now_count, "watch": watch_count,
                    "on_track": on_track_count, "outperforming": outperf_count,
                    "total_gap_kes": total_gap_kes, "total_gap_pct": total_gap_pct,
                    "total_mtd": total_mtd, "total_mtd_req": total_mtd_req,
                    "open_issues": total_issues, "open_issues_kes": total_issues_kes,
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
            "exception_queues": {
                "act_now": act_now_queue,
                "watch":   watch_queue,
                "wins":    wins_queue,
            },
            "fleet_summary": {
                "total_stores":     total_stores,
                "act_now":          act_now_count,
                "watch":            watch_count,
                "on_track":         on_track_count,
                "outperforming":    outperf_count,
                "total_gap_kes":    round(total_gap_kes, 0),
                "total_mtd":        round(total_mtd, 0),
                "total_mtd_req":    round(total_mtd_req, 0),
                "total_gap_pct":    total_gap_pct,
                "open_issues":      total_issues,
                "open_issues_kes":  round(total_issues_kes, 0),
            },
            "fleet_coaching": fleet_coaching,
            "benchmarks": {
                "avg_basket":         bench.get("avg_basket", 0),
                "avg_disc_depth_pct": bench.get("avg_disc_depth_pct", 11.0),
                "avg_upt":            bench.get("avg_upt", 2.2),
            },
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

        # Analysis — serve from today's cache if it has the full structured analysis
        analysis    = {}
        coaching_text = ""
        import json as _json
        cached = _db_exec(
            """SELECT summary, analysis FROM retail_desk_coaching_log
               WHERE store=%s AND run_date=CURRENT_DATE LIMIT 1""",
            (store,), fetch=True
        )
        if cached and cached[0].get("analysis"):
            try:
                a = cached[0]["analysis"]
                analysis = a if isinstance(a, dict) else _json.loads(a)
                coaching_text = cached[0].get("summary", "")
            except Exception:
                pass

        if not analysis and _ai_configured():
            analysis = await asyncio.to_thread(
                _run_store_analysis, store, sd, path_data, issues, categories
            )
            if analysis:
                coaching_text = f"{analysis.get('verdict','').upper()} — {analysis.get('top_action','')}"

        # Backwards-compat: fall back to old summary if no structured analysis
        if not analysis and cached and cached[0].get("summary"):
            coaching_text = cached[0]["summary"]

        # Fetch predictions for this store
        preds = _db_exec(
            """SELECT id, metric_name, prediction_text, current_value, predicted_value,
                      time_horizon, confidence, rationale, status, actual_value,
                      actual_recorded_at::date AS recorded_date, run_date::text AS run_date
               FROM retail_desk_predictions
               WHERE store = %s
               ORDER BY run_date DESC, id DESC LIMIT 10""",
            (store,), fetch=True
        ) or []

        # Fetch recent corrections for this store
        corrections = _db_exec(
            """SELECT id, correction_text, submitted_at::date AS corr_date, applied
               FROM retail_desk_corrections
               WHERE store = %s ORDER BY submitted_at DESC LIMIT 10""",
            (store,), fetch=True
        ) or []

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
            "analysis":     analysis,
            "predictions":  [dict(r) for r in preds],
            "corrections":  [dict(r) for r in corrections],
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

    @app.post("/api/retail-desk/store/{store:path}/correction")
    async def retail_desk_submit_correction(store: str, request: Request):
        """Submit a correction to the AI analysis for a store."""
        body = await request.json()
        text = (body.get("correction_text") or body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="correction_text is required")
        user_email = getattr(request.state, "user_email", None)
        _db_exec(
            """INSERT INTO retail_desk_corrections
                   (store, analysis_date, correction_text, submitted_by)
               VALUES (%s, CURRENT_DATE, %s, %s)""",
            (store, text, user_email), fetch=False
        )
        # Invalidate today's cached analysis so next load re-runs with correction applied
        _db_exec(
            """UPDATE retail_desk_coaching_log
               SET analysis = NULL, summary = NULL
               WHERE store = %s AND run_date = CURRENT_DATE""",
            (store,), fetch=False
        )
        return JSONResponse({"ok": True})

    @app.post("/api/retail-desk/predictions/{pred_id}/outcome")
    async def retail_desk_record_outcome(pred_id: int, request: Request):
        """Record the actual outcome for a prediction (learning loop)."""
        body = await request.json()
        status = body.get("status", "accurate")
        if status not in ("accurate", "inaccurate", "partial"):
            raise HTTPException(status_code=400, detail="status must be accurate|inaccurate|partial")
        actual_value = (body.get("actual_value") or "").strip() or None
        user_email   = getattr(request.state, "user_email", None)
        rows = _db_exec(
            """UPDATE retail_desk_predictions
               SET status = %s,
                   actual_value = %s,
                   actual_recorded_at = now(),
                   recorded_by = %s
               WHERE id = %s
               RETURNING id""",
            (status, actual_value, user_email, pred_id), fetch=True
        )
        if not rows:
            raise HTTPException(status_code=404, detail="Prediction not found")
        return JSONResponse({"ok": True})

    @app.get("/api/retail-desk/predictions")
    async def retail_desk_predictions_list(
        request: Request,
        store: str = None,
        status: str = "pending",
    ):
        """List predictions across all stores (or one store), filtered by status."""
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
            f"""SELECT id, store, run_date::text, metric_name, prediction_text,
                       current_value, predicted_value, time_horizon, confidence, rationale,
                       status, actual_value, actual_recorded_at::date AS recorded_date,
                       recorded_by
                FROM retail_desk_predictions
                {where}
                ORDER BY run_date DESC, id DESC LIMIT 200""",
            params or None, fetch=True
        ) or []
        return JSONResponse({"predictions": [dict(r) for r in rows], "total": len(rows)})

    @app.get("/api/retail-desk/report/latest")
    async def retail_desk_report_latest():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            result = du.get_latest_report(conn, "retail", "fleet_overview")
            return JSONResponse(result or {"report": None})
        finally:
            conn.close()

    @app.post("/api/retail-desk/report")
    async def retail_desk_report_generate(request: Request):
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            ctx = du.get_latest_coaching_context(conn, "retail", "fleet_overview")
            if not ctx:
                return JSONResponse(
                    {"error": "No coaching context yet. Open the Retail Desk overview first."},
                    status_code=400)
            user = getattr(request.state, "user", {}) or {}
            result = du.generate_report(api_key, ctx, "retail", conn,
                                         scope_key="fleet_overview",
                                         generated_by=user.get("email", "system"))
            return JSONResponse(result)
        finally:
            conn.close()

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

    @app.patch("/api/retail-desk/issues/{issue_id}/status")
    async def retail_desk_update_issue_status(issue_id: int, request: Request):
        """Acknowledge or move an issue to in_progress."""
        body = await request.json()
        new_status = body.get("status", "")
        if new_status not in ("open", "acknowledged", "in_progress", "closed"):
            raise HTTPException(status_code=400, detail="status must be open|acknowledged|in_progress|closed")
        user_email = getattr(request.state, "user_email", None)
        extra_set = ""
        if new_status == "closed":
            extra_set = ", closed_at = NOW(), closed_by = %s"
            params = (new_status, user_email, issue_id)
        else:
            params = (new_status, issue_id)
        _db_exec(
            f"UPDATE retail_desk_issues SET status = %s {extra_set} WHERE id = %s",
            params, fetch=False,
        )
        return JSONResponse({"ok": True})

    @app.get("/api/retail-desk/actions")
    async def retail_desk_actions_list(
        request: Request,
        store: str = None,
        status: str = None,
        scope: str = "active",  # active | overdue | all
    ):
        """List actions queue — overdue surfaced first, then by due date."""
        parts = ["1=1"]
        params = []
        if store:
            parts.append("store = %s"); params.append(store)
        if status:
            parts.append("status = %s"); params.append(status)
        elif scope == "active":
            parts.append("status IN ('open','in_progress')")
        elif scope == "overdue":
            parts.append("status IN ('open','in_progress') AND due_date < CURRENT_DATE")
        where = "WHERE " + " AND ".join(parts)
        rows = _db_exec(
            f"""SELECT id, store, action_text, owner, due_date::text, status,
                       expected_kes, source, issue_id,
                       created_at::date::text AS created_date,
                       closed_at::date::text AS closed_date, outcome,
                       CASE WHEN due_date < CURRENT_DATE AND status IN ('open','in_progress')
                            THEN TRUE ELSE FALSE END AS overdue
                FROM retail_desk_actions
                {where}
                ORDER BY
                    CASE WHEN due_date < CURRENT_DATE AND status IN ('open','in_progress') THEN 0 ELSE 1 END,
                    due_date ASC NULLS LAST, created_at DESC
                LIMIT 200""",
            params or None, fetch=True,
        ) or []
        return JSONResponse({"actions": [dict(r) for r in rows], "total": len(rows)})

    @app.post("/api/retail-desk/actions")
    async def retail_desk_create_action(request: Request):
        """Persist an action from an AI analysis or manual entry."""
        body = await request.json()
        store       = (body.get("store") or "").strip()
        action_text = (body.get("action_text") or body.get("action") or "").strip()
        if not store or not action_text:
            raise HTTPException(status_code=400, detail="store and action_text are required")
        owner        = (body.get("owner") or "").strip() or None
        due_date_str = (body.get("due_date") or "").strip() or None
        expected_kes = body.get("expected_kes") or body.get("kes_impact") or None
        source       = (body.get("source") or "manual").strip()
        issue_id     = body.get("issue_id") or None
        rows = _db_exec(
            """INSERT INTO retail_desk_actions
                   (store, action_text, owner, due_date, expected_kes, source, issue_id)
               VALUES (%s,%s,%s,%s::date,%s,%s,%s)
               RETURNING id""",
            (store, action_text, owner, due_date_str, expected_kes, source, issue_id),
            fetch=True,
        )
        return JSONResponse({"ok": True, "id": rows[0]["id"] if rows else None}, status_code=201)

    @app.patch("/api/retail-desk/actions/{action_id}")
    async def retail_desk_update_action(action_id: int, request: Request):
        """Update action status / outcome."""
        body = await request.json()
        new_status = body.get("status")
        outcome    = body.get("outcome")
        user_email = getattr(request.state, "user_email", None)
        if new_status and new_status not in ("open", "in_progress", "done", "deferred"):
            raise HTTPException(status_code=400, detail="invalid status")
        sets, params = [], []
        if new_status:
            sets.append("status = %s"); params.append(new_status)
        if outcome is not None:
            sets.append("outcome = %s"); params.append(outcome)
        if new_status == "done":
            sets.append("closed_at = NOW()"); sets.append("closed_by = %s"); params.append(user_email)
        sets.append("updated_at = NOW()")
        params.append(action_id)
        _db_exec(
            f"UPDATE retail_desk_actions SET {', '.join(sets)} WHERE id = %s",
            params, fetch=False,
        )
        return JSONResponse({"ok": True})
