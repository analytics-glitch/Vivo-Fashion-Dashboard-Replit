"""
AI Insights Router — daily digest, Ask the Dashboard, learned baselines.

Registered via register_ai_routes(app, api_pg_module) called from api_pg.py.
Also callable standalone from sync_incremental.py (nightly_run / compute_baselines /
generate_digest) — uses DATABASE_URL directly when api_pg module is not set.

9 tracked metrics per store:
  net_sales  · transactions · avg_basket   · returns_rate
  footfall   · conversion   · redemptions  · signups · reactivations

Baselines: 12-week rolling, DOW + month seasonality.
Digest:    LLM prose ONLY for anomalous days (|z| ≥ threshold); claude-haiku-3-5.
Ask:       snapshot-grounded single-shot Q&A; claude-sonnet-4-5.
Degrades gracefully when ANTHROPIC_API_KEY is absent.
"""

import json
import logging
import os
import threading
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger("ai_insights")

# api_pg module reference — set in register_ai_routes(); None in standalone mode.
A = None

# ── Anthropic client (lazy singleton) ─────────────────────────────────────────

_ai_lock = threading.Lock()
_ai_inst = None


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
        import anthropic  # installed: uv pip install anthropic
        _ai_inst = anthropic.Anthropic(api_key=key)
        return _ai_inst


HAIKU  = "claude-haiku-3-5"
SONNET = "claude-sonnet-4-5"

METRIC_LABELS = {
    "net_sales":     "Net Sales (KES)",
    "transactions":  "Transactions",
    "avg_basket":    "Avg Basket (KES)",
    "returns_rate":  "Returns Rate (%)",
    "footfall":      "Footfall (visitors)",
    "conversion":    "Conversion Rate (%)",
    "redemptions":   "Loyalty Redemptions",
    "signups":       "Loyalty Signups",
    "reactivations": "Member Reactivations",
}

# Severity weight per metric for revenue-impact ranking
METRIC_WEIGHT = {
    "net_sales":     10.0,
    "transactions":   3.0,
    "avg_basket":     3.0,
    "returns_rate":   4.0,
    "footfall":       2.0,
    "conversion":     5.0,
    "redemptions":    1.0,
    "signups":        1.0,
    "reactivations":  1.5,
}

# ── DB access — dual mode (API / standalone) ──────────────────────────────────

def _db_exec(sql, params=None, fetch=True):
    """
    Execute SQL via api_pg._users_exec when A is set (API mode),
    or directly via psycopg2 from DATABASE_URL (standalone / nightly mode).
    Always returns list-of-dict when fetch=True, None otherwise.
    """
    if A is not None:
        return A._users_exec(sql, params, fetch=fetch)

    # Standalone mode: own psycopg2 connection
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


# ── Schema DDL ────────────────────────────────────────────────────────────────

_DDL = [
    """CREATE TABLE IF NOT EXISTS ai_daily_insights (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE        NOT NULL,
        store           TEXT        NOT NULL,
        metric          TEXT        NOT NULL,
        insight_type    TEXT,
        headline        TEXT        NOT NULL,
        body            TEXT,
        evidence        JSONB,
        sigma           FLOAT,
        revenue_impact  FLOAT       DEFAULT 0,
        generated_at    TIMESTAMPTZ DEFAULT now(),
        model           TEXT,
        UNIQUE (date, store, metric)
    )""",
    """CREATE TABLE IF NOT EXISTS ai_insight_feedback (
        id          BIGSERIAL PRIMARY KEY,
        insight_id  BIGINT REFERENCES ai_daily_insights(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        signal      TEXT NOT NULL CHECK (signal IN ('useful','not_useful')),
        created_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (insight_id, user_id)
    )""",
    """CREATE TABLE IF NOT EXISTS ai_insight_views (
        id          BIGSERIAL PRIMARY KEY,
        insight_id  BIGINT REFERENCES ai_daily_insights(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        viewed_at   TIMESTAMPTZ DEFAULT now(),
        UNIQUE (insight_id, user_id)
    )""",
    """CREATE TABLE IF NOT EXISTS ai_learned_baselines (
        store       TEXT NOT NULL,
        metric      TEXT NOT NULL,
        dow         INT  NOT NULL,
        month       INT  NOT NULL,
        baseline    FLOAT,
        sigma       FLOAT,
        sample_n    INT,
        computed_at TIMESTAMPTZ,
        PRIMARY KEY (store, metric, dow, month)
    )""",
    """CREATE TABLE IF NOT EXISTS ai_anomaly_thresholds (
        store               TEXT  NOT NULL,
        metric              TEXT  NOT NULL,
        sigma_threshold     FLOAT NOT NULL DEFAULT 2.0,
        false_positive_rate FLOAT DEFAULT 0.0,
        computed_at         TIMESTAMPTZ,
        PRIMARY KEY (store, metric)
    )""",
    """CREATE TABLE IF NOT EXISTS ai_data_gap_register (
        id         BIGSERIAL PRIMARY KEY,
        date       DATE NOT NULL,
        store      TEXT NOT NULL,
        metric     TEXT NOT NULL,
        gap_reason TEXT NOT NULL,
        logged_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (date, store, metric)
    )""",
]


def ensure_ai_tables():
    """Idempotent DDL — called from @_deferred_startup in api_pg.py."""
    for ddl in _DDL:
        _db_exec(ddl, fetch=False)
    log.info("AI insight tables: OK")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _today_eat():
    return (datetime.now(timezone.utc) + timedelta(hours=3)).date()


def _dow_name(dow):
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][int(dow) % 7]


def _ff_helpers():
    """Return (ff_canon_sql, ff_store_predicate) from api_pg or plain fallbacks."""
    if A is not None:
        return A.ff_canon_sql(), A.ff_store_master_predicate()
    # Standalone fallback — minimal canonicalization (no rename aliases in nightly).
    return "f.pos_location_name", "TRUE"


def _base_filters():
    return A.BASE_FILTERS if A is not None else "TRUE"


# ── Baseline computation ──────────────────────────────────────────────────────

def compute_baselines():
    """
    Recompute 12-week rolling baselines per (store, metric, dow, month).
    Upserts into ai_learned_baselines. Idempotent / safe to re-run.
    Returns count of rows upserted.
    """
    today  = _today_eat()
    since  = today - timedelta(days=84)
    d_str  = str(today)
    s_str  = str(since)
    base_f = _base_filters()
    ff_canon, ff_pred = _ff_helpers()

    log.info("AI baselines: computing since %s ...", s_str)

    sales_sql = f"""
        WITH daily AS (
            SELECT
                s.pos_location_name AS store,
                s.sale_date::date   AS d,
                EXTRACT(DOW   FROM s.sale_date::date)::int AS dow,
                EXTRACT(MONTH FROM s.sale_date::date)::int AS month,
                ROUND(SUM(s.total_sales_kes - COALESCE(s.discounts_kes,0))/1.16, 0) AS net_sales,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS transactions,
                ROUND(
                    CASE WHEN COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)>0
                    THEN SUM(s.total_sales_kes - COALESCE(s.discounts_kes,0))/1.16/
                         COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)
                    ELSE 0 END, 0) AS avg_basket,
                ROUND(
                    CASE WHEN SUM(ABS(s.ordered_item_quantity))>0
                    THEN SUM(CASE WHEN s.sale_kind='return' THEN ABS(s.ordered_item_quantity) ELSE 0 END)
                         *100.0/SUM(ABS(s.ordered_item_quantity))
                    ELSE 0 END, 1) AS returns_rate
            FROM all_sales s
            WHERE s.sale_date::date >= '{s_str}'
              AND s.sale_date::date <  '{d_str}'
              AND {base_f}
            GROUP BY 1, 2, 3, 4
        )
        SELECT store, dow, month, metric, AVG(val) AS baseline, STDDEV(val) AS sigma, COUNT(*) AS sample_n
        FROM daily
        CROSS JOIN LATERAL (VALUES
            ('net_sales',    net_sales::float),
            ('transactions', transactions::float),
            ('avg_basket',   avg_basket::float),
            ('returns_rate', returns_rate::float)
        ) AS m(metric, val)
        WHERE val IS NOT NULL
        GROUP BY store, dow, month, metric
        HAVING COUNT(*) >= 3
    """

    ff_sql = f"""
        WITH ff_daily AS (
            SELECT {ff_canon} AS store,
                   f.time::date AS d,
                   EXTRACT(DOW   FROM f.time::date)::int AS dow,
                   EXTRACT(MONTH FROM f.time::date)::int AS month,
                   SUM(f.a01_footfall_in) AS footfall
            FROM footfall f
            WHERE f.time::date >= '{s_str}'
              AND f.time::date <  '{d_str}'
              AND {ff_pred}
            GROUP BY 1, 2, 3, 4
        ),
        txn_daily AS (
            SELECT s.pos_location_name AS store, s.sale_date::date AS d,
                   COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS txn
            FROM all_sales s
            WHERE s.sale_date::date >= '{s_str}'
              AND s.sale_date::date <  '{d_str}'
              AND {base_f}
            GROUP BY 1, 2
        ),
        joined AS (
            SELECT ff.store, ff.d, ff.dow, ff.month, ff.footfall,
                   ROUND(COALESCE(t.txn,0)*100.0/NULLIF(ff.footfall,0),1) AS conversion
            FROM ff_daily ff
            LEFT JOIN txn_daily t ON t.store=ff.store AND t.d=ff.d
            WHERE ff.footfall > 0
        )
        SELECT store, dow, month, metric, AVG(val) AS baseline, STDDEV(val) AS sigma, COUNT(*) AS sample_n
        FROM joined
        CROSS JOIN LATERAL (VALUES
            ('footfall',   footfall::float),
            ('conversion', conversion::float)
        ) AS m(metric, val)
        WHERE val IS NOT NULL
        GROUP BY store, dow, month, metric
        HAVING COUNT(*) >= 3
    """

    upsert = """
        INSERT INTO ai_learned_baselines (store, metric, dow, month, baseline, sigma, sample_n, computed_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,now())
        ON CONFLICT (store, metric, dow, month) DO UPDATE
          SET baseline=EXCLUDED.baseline, sigma=EXCLUDED.sigma,
              sample_n=EXCLUDED.sample_n, computed_at=EXCLUDED.computed_at
    """

    total = 0
    for sql in (sales_sql, ff_sql):
        try:
            rows = _db_exec(sql, fetch=True) or []
            for r in rows:
                _db_exec(upsert, (
                    r["store"], r["metric"], int(r["dow"]), int(r["month"]),
                    float(r["baseline"]), float(r.get("sigma") or 0), int(r["sample_n"])
                ), fetch=False)
                total += 1
        except Exception as e:
            log.error("AI baselines SQL error: %s", e)

    log.info("AI baselines: %d rows upserted", total)
    return total


def adjust_thresholds_from_feedback():
    """
    Nudge sigma_threshold based on 28-day not_useful rate per (store, metric).
    Clamps to [1.5, 3.5]. Requires ≥5 votes to act.
    """
    sql = """
        WITH stats AS (
            SELECT i.store, i.metric,
                   COUNT(f.id) AS total,
                   COUNT(CASE WHEN f.signal='not_useful' THEN 1 END) AS bad
            FROM ai_daily_insights i
            JOIN ai_insight_feedback f ON f.insight_id=i.id
            WHERE i.date >= (now() AT TIME ZONE 'Africa/Nairobi')::date - 28
            GROUP BY i.store, i.metric
            HAVING COUNT(f.id) >= 5
        )
        INSERT INTO ai_anomaly_thresholds (store, metric, sigma_threshold, false_positive_rate, computed_at)
        SELECT store, metric,
               GREATEST(1.5, LEAST(3.5,
                 COALESCE((SELECT sigma_threshold FROM ai_anomaly_thresholds t
                           WHERE t.store=stats.store AND t.metric=stats.metric), 2.0)
                 + CASE
                     WHEN bad*1.0/NULLIF(total,0) > 0.6 THEN  0.2
                     WHEN bad*1.0/NULLIF(total,0) < 0.2 THEN -0.1
                     ELSE 0
                   END
               )),
               bad*1.0/NULLIF(total,0),
               now()
        FROM stats
        ON CONFLICT (store, metric) DO UPDATE
          SET sigma_threshold=EXCLUDED.sigma_threshold,
              false_positive_rate=EXCLUDED.false_positive_rate,
              computed_at=EXCLUDED.computed_at
    """
    try:
        _db_exec(sql, fetch=False)
        log.info("AI thresholds: adjusted from feedback")
    except Exception as e:
        log.error("AI threshold adjust error: %s", e)


# ── Anomaly detection ─────────────────────────────────────────────────────────

def _detect_anomalies(target_date):
    """
    Single SQL pass: compute today's per-store actuals and join with baselines.
    Returns list of anomaly dicts sorted by revenue_impact desc.
    """
    d      = target_date
    d_str  = str(d)
    dow    = d.weekday()
    month  = d.month
    base_f = _base_filters()
    ff_canon, ff_pred = _ff_helpers()

    sql = f"""
        WITH today_sales AS (
            SELECT
                s.pos_location_name AS store,
                ROUND(SUM(s.total_sales_kes - COALESCE(s.discounts_kes,0))/1.16, 0) AS net_sales,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS transactions,
                ROUND(
                    CASE WHEN COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)>0
                    THEN SUM(s.total_sales_kes - COALESCE(s.discounts_kes,0))/1.16/
                         COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)
                    ELSE 0 END, 0) AS avg_basket,
                ROUND(
                    CASE WHEN SUM(ABS(s.ordered_item_quantity))>0
                    THEN SUM(CASE WHEN s.sale_kind='return' THEN ABS(s.ordered_item_quantity) ELSE 0 END)
                         *100.0/SUM(ABS(s.ordered_item_quantity))
                    ELSE 0 END, 1) AS returns_rate
            FROM all_sales s
            WHERE s.sale_date::date = '{d_str}' AND {base_f}
            GROUP BY 1
        ),
        today_ff AS (
            SELECT {ff_canon} AS store, SUM(f.a01_footfall_in) AS footfall
            FROM footfall f
            WHERE f.time::date = '{d_str}' AND {ff_pred}
            GROUP BY 1
        ),
        today_ff_conv AS (
            SELECT ff.store, ff.footfall,
                   ROUND(COALESCE(ts.transactions,0)*100.0/NULLIF(ff.footfall,0),1) AS conversion
            FROM today_ff ff
            LEFT JOIN today_sales ts ON ts.store=ff.store
            WHERE ff.footfall > 0
        ),
        actuals AS (
            SELECT store, 'net_sales'    AS metric, net_sales::float    AS actual FROM today_sales WHERE net_sales > 0
            UNION ALL
            SELECT store, 'transactions', transactions::float            FROM today_sales WHERE transactions > 0
            UNION ALL
            SELECT store, 'avg_basket',   avg_basket::float              FROM today_sales WHERE avg_basket > 0
            UNION ALL
            SELECT store, 'returns_rate', returns_rate::float            FROM today_sales
            UNION ALL
            SELECT store, 'footfall',     footfall::float                FROM today_ff_conv WHERE footfall > 0
            UNION ALL
            SELECT store, 'conversion',   conversion::float              FROM today_ff_conv WHERE footfall > 0
        )
        SELECT
            a.store,
            a.metric,
            a.actual,
            b.baseline,
            b.sigma,
            COALESCE(t.sigma_threshold, 2.0)                           AS threshold,
            (a.actual - b.baseline) / NULLIF(b.sigma, 0)               AS z_score
        FROM actuals a
        JOIN ai_learned_baselines b
          ON b.store=a.store AND b.metric=a.metric
             AND b.dow={dow} AND b.month={month}
        LEFT JOIN ai_anomaly_thresholds t ON t.store=a.store AND t.metric=a.metric
        WHERE b.sigma > 0.001
          AND b.sample_n >= 3
          AND ABS((a.actual - b.baseline) / NULLIF(b.sigma, 0)) >= COALESCE(t.sigma_threshold, 2.0)
        ORDER BY ABS((a.actual - b.baseline) / NULLIF(b.sigma, 0)) DESC
    """

    rows = _db_exec(sql, fetch=True) or []

    # Log footfall gaps (stores with sales but no sensor data today)
    try:
        sales_stores_sql = f"""
            SELECT DISTINCT pos_location_name AS store FROM all_sales
            WHERE sale_date::date='{d_str}' AND {base_f}
        """
        ff_stores_sql = f"""
            SELECT DISTINCT {ff_canon} AS store FROM footfall
            WHERE time::date='{d_str}' AND {ff_pred}
        """
        s_stores = {r["store"] for r in (_db_exec(sales_stores_sql, fetch=True) or [])}
        f_stores  = {r["store"] for r in (_db_exec(ff_stores_sql,   fetch=True) or [])}
        for store in (s_stores - f_stores):
            _db_exec(
                "INSERT INTO ai_data_gap_register (date,store,metric,gap_reason) "
                "VALUES (%s,%s,%s,%s) ON CONFLICT (date,store,metric) DO NOTHING",
                (d_str, store, "footfall", "No FootfallCam data for this store/date"),
                fetch=False
            )
    except Exception as e:
        log.warning("AI gap register error: %s", e)

    result = []
    for r in rows:
        z      = float(r.get("z_score") or 0)
        impact = abs(z) * METRIC_WEIGHT.get(r["metric"], 1.0)
        result.append({
            "store":          r["store"],
            "metric":         r["metric"],
            "actual":         float(r.get("actual") or 0),
            "baseline":       float(r.get("baseline") or 0),
            "sigma":          float(r.get("sigma") or 0),
            "z_score":        round(z, 2),
            "revenue_impact": round(impact, 2),
            "insight_type":   "spike" if z > 0 else "dip",
        })

    result.sort(key=lambda x: x["revenue_impact"], reverse=True)
    return result


# ── Digest prose generation ───────────────────────────────────────────────────

def _generate_prose(store, metric, actual, baseline, sigma, z_score, d_str):
    """
    One claude-haiku-3-5 call → (headline, body).
    Falls back to plain-text if LLM fails — never raises.
    """
    label = METRIC_LABELS.get(metric, metric)
    pct   = round(abs(actual - baseline) / max(abs(baseline), 1) * 100, 1)
    dirn  = "above" if z_score > 0 else "below"

    prompt = (
        f"Store: {store}\nDate: {d_str}\nMetric: {label}\n"
        f"Today: {actual:,.1f}\nBaseline (same-DOW 12-wk avg): {baseline:,.1f}\n"
        f"Deviation: {pct}%% {dirn} baseline ({abs(z_score):.1f}σ)\n\n"
        "Write a concise retail insight for Vivo Fashion Group (multi-brand fashion retailer, East Africa). "
        "Respond with ONLY this JSON (no markdown, no other text):\n"
        '{ "headline": "...", "body": "..." }\n'
        "headline: max 90 chars, cite the %% and direction.\n"
        "body: exactly 2 sentences — explain the deviation, then the business implication."
    )

    try:
        msg  = _ai_client().messages.create(
            model=HAIKU, max_tokens=256,
            system=(
                "You are a senior retail analytics analyst for Vivo Fashion Group. "
                "Cite exact numbers. Reply ONLY with valid JSON, nothing else."
            ),
            messages=[{"role": "user", "content": prompt}],
        )
        text = (msg.content[0].text if msg.content else "").strip()
        s, e = text.find("{"), text.rfind("}")
        if s >= 0 and e > s:
            parsed = json.loads(text[s : e + 1])
            hl = (parsed.get("headline") or "").strip()
            bd = (parsed.get("body") or "").strip()
            if hl and bd:
                return hl, bd
    except Exception as ex:
        log.warning("AI prose failed for %s/%s: %s", store, metric, ex)

    # Plain-text fallback (no LLM cost)
    hl = f"{store}: {label} {pct}%% {'above' if z_score > 0 else 'below'} baseline ({abs(z_score):.1f}σ)"
    bd = (
        f"Actual: {actual:,.1f} vs. baseline {baseline:,.1f} "
        f"({abs(z_score):.1f} standard deviations from the 12-week same-DOW average). "
        f"Review the store's activity for {d_str} to identify the driver."
    )
    return hl, bd


def generate_digest(target_date=None, force=False):
    """
    Generate and store the AI daily digest. Idempotent (ON CONFLICT DO NOTHING).
    Returns count of new insights written.
    """
    if not _ai_configured():
        log.warning("AI digest: ANTHROPIC_API_KEY not set — skipped")
        return 0

    d     = target_date or _today_eat()
    d_str = str(d)

    if not force:
        existing = _db_exec(
            "SELECT COUNT(*) AS n FROM ai_daily_insights WHERE date=%s",
            (d_str,), fetch=True
        )
        if existing and int(existing[0].get("n") or 0) > 0:
            log.info("AI digest: already exists for %s", d_str)
            return 0

    anomalies = _detect_anomalies(d)
    if not anomalies:
        log.info("AI digest: no anomalies detected for %s", d_str)
        return 0

    cap = min(len(anomalies), 20)
    log.info("AI digest: generating %d insights for %s ...", cap, d_str)

    generated = 0
    for a in anomalies[:cap]:
        headline, body = _generate_prose(
            a["store"], a["metric"], a["actual"], a["baseline"],
            a["sigma"], a["z_score"], d_str
        )
        if not headline:
            continue
        evidence = {
            "today":          round(a["actual"], 2),
            "baseline":       round(a["baseline"], 2),
            "sigma":          round(a["sigma"], 2),
            "z_score":        round(a["z_score"], 2),
            "delta_pct":      round((a["actual"] - a["baseline"]) / max(abs(a["baseline"]), 1) * 100, 1),
            "window":         f"{_dow_name(d.weekday())} 12-wk avg",
            "revenue_impact": round(a["revenue_impact"], 2),
        }
        try:
            _db_exec(
                """INSERT INTO ai_daily_insights
                       (date, store, metric, insight_type, headline, body,
                        evidence, sigma, revenue_impact, model)
                   VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                   ON CONFLICT (date, store, metric) DO NOTHING""",
                (d_str, a["store"], a["metric"], a["insight_type"],
                 headline, body, json.dumps(evidence),
                 a["z_score"], a["revenue_impact"], HAIKU),
                fetch=False,
            )
            generated += 1
        except Exception as ex:
            log.error("AI digest insert error: %s", ex)

    log.info("AI digest: %d insights stored for %s", generated, d_str)
    return generated


# ── Nightly runner (sync_incremental.py calls this) ──────────────────────────

def nightly_run():
    """
    Called from sync_incremental.py once per EAT calendar day.
    Uses _db_exec in standalone mode (DATABASE_URL direct) — no api_pg needed.
    """
    today = _today_eat()
    log.info("AI nightly: starting for %s", today)
    try:
        compute_baselines()
    except Exception as e:
        log.error("AI nightly: baselines failed: %s", e)
    try:
        adjust_thresholds_from_feedback()
    except Exception as e:
        log.error("AI nightly: threshold adjust failed: %s", e)
    try:
        n = generate_digest(today)
        log.info("AI nightly: digest complete (%d new insights)", n)
    except Exception as e:
        log.error("AI nightly: digest failed: %s", e)


# ── Snapshot for Ask endpoint ─────────────────────────────────────────────────

def _build_ask_snapshot():
    """Build a compact text snapshot grounding the Ask prompt."""
    d      = _today_eat()
    d_str  = str(d)
    base_f = _base_filters()
    ff_canon, ff_pred = _ff_helpers()

    today_sql = f"""
        SELECT
            pos_location_name AS store,
            ROUND(SUM(total_sales_kes - COALESCE(discounts_kes,0))/1.16, 0) AS net_sales,
            COUNT(DISTINCT CASE WHEN sale_kind IN ('sale','order') THEN order_id END) AS transactions,
            ROUND(
                CASE WHEN COUNT(DISTINCT CASE WHEN sale_kind IN ('sale','order') THEN order_id END)>0
                THEN SUM(total_sales_kes - COALESCE(discounts_kes,0))/1.16/
                     COUNT(DISTINCT CASE WHEN sale_kind IN ('sale','order') THEN order_id END)
                ELSE 0 END, 0) AS avg_basket
        FROM all_sales
        WHERE sale_date::date='{d_str}' AND {base_f}
        GROUP BY 1
        ORDER BY net_sales DESC
    """

    ff_sql = f"""
        SELECT {ff_canon} AS store, SUM(f.a01_footfall_in) AS footfall
        FROM footfall f
        WHERE f.time::date='{d_str}' AND {ff_pred}
        GROUP BY 1
    """

    since7 = str(d - timedelta(days=6))
    trend_sql = f"""
        SELECT
            ROUND(SUM(total_sales_kes - COALESCE(discounts_kes,0))/1.16, 0) AS net_sales_7d,
            COUNT(DISTINCT CASE WHEN sale_kind IN ('sale','order') THEN order_id END) AS txn_7d
        FROM all_sales
        WHERE sale_date::date BETWEEN '{since7}' AND '{d_str}' AND {base_f}
    """

    lines = [f"Vivo Fashion Group — business snapshot for {d_str} (East Africa Time, all figures in KES)"]

    try:
        ff_map     = {r["store"]: int(r.get("footfall") or 0) for r in (_db_exec(ff_sql, fetch=True) or [])}
        store_rows = _db_exec(today_sql, fetch=True) or []
        total_ns   = sum(float(r.get("net_sales") or 0) for r in store_rows)
        total_tx   = sum(int(r.get("transactions") or 0) for r in store_rows)
        lines.append(f"\nAll-store totals today:")
        lines.append(f"  Net Sales: KES {total_ns:,.0f}  |  Transactions: {total_tx:,}")
        lines.append(f"\nPer-store breakdown (sorted by sales, top 8):")
        for r in store_rows[:8]:
            store = r["store"]
            ns    = float(r.get("net_sales") or 0)
            tx    = int(r.get("transactions") or 0)
            ab    = float(r.get("avg_basket") or 0)
            ff    = ff_map.get(store)
            cv    = round(tx * 100.0 / ff, 1) if ff else None
            parts = [f"KES {ns:,.0f}", f"{tx} txns", f"avg basket KES {ab:,.0f}"]
            if ff:
                parts.append(f"{ff:,} visitors")
            if cv is not None:
                parts.append(f"{cv}%% conversion")
            lines.append(f"  {store}: " + " · ".join(parts))
        if len(store_rows) > 8:
            lines.append(f"  ... and {len(store_rows)-8} more stores")
    except Exception as e:
        lines.append(f"[Sales data unavailable: {e}]")

    try:
        t7 = (_db_exec(trend_sql, fetch=True) or [{}])[0]
        lines.append(f"\n7-day rolling window ({since7} to {d_str}):")
        lines.append(f"  Net Sales: KES {float(t7.get('net_sales_7d') or 0):,.0f}")
        lines.append(f"  Transactions: {int(t7.get('txn_7d') or 0):,}")
    except Exception:
        pass

    try:
        recent = _db_exec(
            "SELECT headline FROM ai_daily_insights WHERE date=%s ORDER BY revenue_impact DESC LIMIT 3",
            (d_str,), fetch=True
        ) or []
        if recent:
            lines.append(f"\nToday's top AI insights (by severity):")
            for r in recent:
                lines.append(f"  • {r['headline']}")
    except Exception:
        pass

    return "\n".join(lines)


# ── HTTP endpoints ─────────────────────────────────────────────────────────────

def register_ai_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Query
    from fastapi.responses import JSONResponse
    from fastapi import Request

    @app.get("/api/ai/readyz")
    async def ai_readyz(request: Request):
        return JSONResponse({"configured": _ai_configured()})

    @app.get("/api/ai/insights")
    async def ai_get_insights(
        request: Request,
        target_date: str = Query(default=None),
        store: str = Query(default=None),
    ):
        user  = getattr(request.state, "user", None)
        d_str = target_date or str(_today_eat())
        uid   = str((user or {}).get("id") or (user or {}).get("email") or "")

        store_clause = ""
        store_param  = []
        if store:
            store_clause = " AND i.store = %s"
            store_param  = [store]

        sql = """
            SELECT
                i.id, i.date::text AS date, i.store, i.metric, i.insight_type,
                i.headline, i.body, i.evidence, i.sigma, i.revenue_impact,
                i.generated_at::text, i.model,
                COALESCE(vc.n, 0) AS view_count,
                COALESCE(fu.n, 0) AS useful_count,
                COALESCE(fn.n, 0) AS not_useful_count,
                mf.signal          AS my_feedback
            FROM ai_daily_insights i
            LEFT JOIN (SELECT insight_id, COUNT(*) AS n FROM ai_insight_views    GROUP BY 1) vc ON vc.insight_id=i.id
            LEFT JOIN (SELECT insight_id, COUNT(*) AS n FROM ai_insight_feedback WHERE signal='useful'     GROUP BY 1) fu ON fu.insight_id=i.id
            LEFT JOIN (SELECT insight_id, COUNT(*) AS n FROM ai_insight_feedback WHERE signal='not_useful' GROUP BY 1) fn ON fn.insight_id=i.id
            LEFT JOIN ai_insight_feedback mf ON mf.insight_id=i.id AND mf.user_id=%s
            WHERE i.date=%s""" + store_clause + """
            ORDER BY i.revenue_impact DESC
        """
        params = tuple([uid, d_str] + store_param)
        rows   = _db_exec(sql, params, fetch=True) or []

        week_sql = """
            SELECT
                COALESCE(SUM(CASE WHEN f.signal='useful'     THEN 1 ELSE 0 END),0) AS useful_week,
                COALESCE(SUM(CASE WHEN f.signal='not_useful' THEN 1 ELSE 0 END),0) AS not_useful_week
            FROM ai_insight_feedback f
            JOIN ai_daily_insights i ON i.id=f.insight_id
            WHERE i.date >= (now() AT TIME ZONE 'Africa/Nairobi')::date - 7
        """
        wrow = (_db_exec(week_sql, fetch=True) or [{}])[0]

        insights = []
        for r in rows:
            ev = r.get("evidence") or {}
            if isinstance(ev, str):
                try:
                    ev = json.loads(ev)
                except Exception:
                    ev = {}
            insights.append({
                "id":               r["id"],
                "date":             r["date"],
                "store":            r["store"],
                "metric":           r["metric"],
                "metric_label":     METRIC_LABELS.get(r["metric"], r["metric"]),
                "insight_type":     r["insight_type"],
                "headline":         r["headline"],
                "body":             r["body"],
                "evidence":         ev,
                "sigma":            r.get("sigma"),
                "revenue_impact":   r.get("revenue_impact"),
                "view_count":       int(r.get("view_count") or 0),
                "useful_count":     int(r.get("useful_count") or 0),
                "not_useful_count": int(r.get("not_useful_count") or 0),
                "my_feedback":      r.get("my_feedback"),
            })

        return JSONResponse({
            "date":       d_str,
            "configured": _ai_configured(),
            "insights":   insights,
            "week_stats": {
                "useful":     int(wrow.get("useful_week") or 0),
                "not_useful": int(wrow.get("not_useful_week") or 0),
            },
        })

    @app.post("/api/ai/insights/{insight_id}/feedback")
    async def ai_feedback(insight_id: int, request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        body   = await request.json()
        signal = (body or {}).get("signal")
        if signal not in ("useful", "not_useful"):
            return JSONResponse({"error": "signal must be 'useful' or 'not_useful'"}, status_code=400)
        uid = str(user.get("id") or user.get("email") or "unknown")
        _db_exec(
            """INSERT INTO ai_insight_feedback (insight_id, user_id, signal, created_at)
               VALUES (%s,%s,%s,now())
               ON CONFLICT (insight_id, user_id) DO UPDATE SET signal=EXCLUDED.signal, created_at=now()""",
            (insight_id, uid, signal), fetch=False
        )
        return JSONResponse({"ok": True})

    @app.post("/api/ai/insights/{insight_id}/view")
    async def ai_view(insight_id: int, request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            return JSONResponse({"ok": False})
        uid = str(user.get("id") or user.get("email") or "anon")
        try:
            _db_exec(
                """INSERT INTO ai_insight_views (insight_id, user_id, viewed_at)
                   VALUES (%s,%s,now()) ON CONFLICT (insight_id, user_id) DO NOTHING""",
                (insight_id, uid), fetch=False
            )
        except Exception:
            pass
        return JSONResponse({"ok": True})

    @app.post("/api/ai/ask")
    async def ai_ask(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        if not _ai_configured():
            return JSONResponse({"configured": False, "error": "AI not configured"}, status_code=503)
        body     = await request.json()
        question = (body.get("question") or "").strip()
        if not question:
            return JSONResponse({"error": "question is required"}, status_code=400)
        if len(question) > 600:
            return JSONResponse({"error": "question too long (max 600 characters)"}, status_code=400)
        try:
            snapshot_text = _build_ask_snapshot()
            msg = _ai_client().messages.create(
                model=SONNET, max_tokens=512,
                system=(
                    "You are an AI analyst for Vivo Fashion Group, a multi-brand fashion retailer "
                    "across East Africa (Kenya, Uganda, Rwanda + Online). "
                    "Answer ONLY from the business snapshot provided below. "
                    "Cite specific numbers. If the answer is not in the snapshot, say so clearly. "
                    "Be concise and precise. Money is in Kenyan Shillings (KES). "
                    "Never invent or extrapolate figures."
                ),
                messages=[{"role": "user", "content": f"{snapshot_text}\n\nQuestion: {question}"}],
            )
            answer = (msg.content[0].text if msg.content else "").strip()
            return JSONResponse({
                "answer":   answer,
                "snapshot": snapshot_text,
                "date":     str(_today_eat()),
            })
        except Exception as e:
            log.error("AI ask error: %s", e)
            return JSONResponse({"error": "AI service unavailable — please try again"}, status_code=503)

    @app.post("/api/ai/digest/run")
    async def ai_digest_run(request: Request):
        user = getattr(request.state, "user", None)
        if not user or user.get("role") != "admin":
            return JSONResponse({"error": "admin only"}, status_code=403)
        if not _ai_configured():
            return JSONResponse({"error": "ANTHROPIC_API_KEY not configured"}, status_code=503)
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        force       = bool((body or {}).get("force", False))
        date_str    = (body or {}).get("date")
        target_date = date.fromisoformat(date_str) if date_str else None
        n = generate_digest(target_date=target_date, force=force)
        return JSONResponse({"ok": True, "insights_generated": n})

    @app.post("/api/ai/baselines/recompute")
    async def ai_baselines_recompute(request: Request):
        user = getattr(request.state, "user", None)
        if not user or user.get("role") != "admin":
            return JSONResponse({"error": "admin only"}, status_code=403)
        n = compute_baselines()
        return JSONResponse({"ok": True, "rows_upserted": n})

    log.info("AI Insights routes registered")
