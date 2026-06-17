"""Clienteling CRM backend endpoints for the ported `vivo-crm` frontend.

The frontend (artifacts/vivo-crm, served at /crm/) is a faithful port of
github.com/analytics-glitch/CRM whose original backend ran on MongoDB +
BigQuery. Here every endpoint is re-implemented against THIS project's live
Postgres (all_sales / all_customers + the crm_* tables) so the data pages render
with real figures. Surfaces that have no data source in this project (e.g.
multi-platform social listening, training/L&D) return well-formed, designed
empty states rather than 404s.

All routes are registered into the main FastAPI app by
`register_clienteling_routes(app)`, called from api_pg.py immediately BEFORE the
StaticFiles SPA catch-all (route match order matters — the catch-all would
otherwise swallow GET /api/* and 404). Auth: the shared `clerk_auth_gate`
middleware already requires an active signed-in staff user for every /api/*
path EXCEPT the /api/loyalty prefix (member-token bypass), so the loyalty
manager endpoints below re-assert a staff session manually via `_staff`.
"""

import json
import re
import time
import secrets
from datetime import datetime, date, timedelta

from fastapi import Request, Body, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response

# Set in register_clienteling_routes() to the fully-loaded api_pg module. Routes
# only dereference it at request time, by which point it is populated.
A = None

# Text-date guard: all_sales.sale_date / all_customers.last_order_date are TEXT.
_ISO = "~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'"
_DEF = "vivo"


# --------------------------------------------------------------------------- #
# Small shared helpers                                                         #
# --------------------------------------------------------------------------- #
def _ex(sql, params=None, fetch=False):
    return A._users_exec(sql, params, fetch=fetch)


def _one(sql, params=None, fetch=True):
    rows = _ex(sql, params, fetch=True) or []
    return rows[0] if rows else None


def _actor(request):
    return A._crm_actor(request)


def _staff(request, roles=None):
    """Re-assert a staff session for /api/loyalty/* (which the global gate
    bypasses for member-token auth). For every other prefix the gate has already
    populated request.state.user, so we reuse it."""
    u = getattr(request.state, "user", None)
    if not u:
        tok = A._extract_session_token(request)
        try:
            u = A._user_for_session(tok) if tok else None
        except Exception:
            u = None
    if not u:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if u.get("status") != "active":
        raise HTTPException(status_code=403, detail="account_inactive")
    if roles and u.get("role") not in roles:
        raise HTTPException(status_code=403, detail="Insufficient role")
    return u


def _num(v, d=0):
    try:
        if v is None:
            return d
        return float(v)
    except (TypeError, ValueError):
        return d


def _int(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


def _clamp(v, lo, hi, d):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return d
    return max(lo, min(hi, n))


def _dt(v):
    """ISO-ify a timestamp/date for JSON."""
    if v is None:
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return str(v)


def _name_sql(alias):
    """SQL scalar expression resolving a display name for {alias}.customer_id,
    preferring the CRM override row then the transactional customer record."""
    return (
        "COALESCE("
        "(SELECT NULLIF(TRIM(COALESCE(cc.first_name,'')||' '||COALESCE(cc.last_name,'')),'') "
        "FROM crm_customer cc WHERE cc.customer_id=%(a)s.customer_id LIMIT 1),"
        "(SELECT NULLIF(TRIM(COALESCE(ac.first_name,'')||' '||COALESCE(ac.last_name,'')),'') "
        "FROM all_customers ac WHERE ac.customer_id=%(a)s.customer_id LIMIT 1),"
        "'Guest')"
    ).replace("%(a)s", alias)


# Loyalty tier from trailing-12-month KES spend (mirrors _crm_tier_for_spend
# defaults). Used as a fallback when the customer is not formally enrolled.
def _tier_case(spend_expr):
    return (
        "CASE WHEN " + spend_expr + " >= 100000 THEN 'Gold' "
        "WHEN " + spend_expr + " >= 50000 THEN 'Silver' ELSE 'Bronze' END"
    )


# RFM-style behavioural tier from order count + recency (days). NULL recency is
# treated as very stale.
def _rfm_case(orders_expr, rec_expr):
    r = "COALESCE(" + rec_expr + ", 99999)"
    o = orders_expr
    return (
        "CASE "
        "WHEN " + o + " >= 5 AND " + r + " <= 90 THEN 'Champion' "
        "WHEN " + o + " >= 3 AND " + r + " <= 180 THEN 'Loyal' "
        "WHEN " + o + " >= 2 AND " + r + " <= 365 THEN 'Promising' "
        "WHEN " + r + " > 365 AND " + o + " >= 2 THEN 'At Risk' "
        "WHEN " + o + " <= 1 AND " + r + " <= 180 THEN 'New' "
        "ELSE 'Dormant' END"
    )


def _base_filters():
    return A.BASE_FILTERS


# --------------------------------------------------------------------------- #
# Idempotent supporting tables (features with no existing crm_* home)          #
# --------------------------------------------------------------------------- #
def _ensure_cl_tables():
    stmts = [
        "CREATE TABLE IF NOT EXISTS crm_assignment ("
        " customer_id text PRIMARY KEY, assignee_user_id text, assignee_name text,"
        " assigned_by text, assigned_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_preferences ("
        " customer_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb,"
        " updated_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_consent ("
        " id serial PRIMARY KEY, customer_id text NOT NULL, channel text,"
        " opted_in boolean, method text, user_name text,"
        " created_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_template ("
        " id serial PRIMARY KEY, name text, channel text, body text,"
        " bsp_status text DEFAULT 'approved', created_by text,"
        " created_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_lookbook ("
        " id serial PRIMARY KEY, customer_id text, title text, description text,"
        " items jsonb DEFAULT '[]'::jsonb, created_by text,"
        " created_at timestamptz DEFAULT now())",
        "ALTER TABLE crm_lookbook ADD COLUMN IF NOT EXISTS share_token text",
        "ALTER TABLE crm_lookbook ADD COLUMN IF NOT EXISTS views int DEFAULT 0",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_lookbook_share_token "
        " ON crm_lookbook(share_token) WHERE share_token IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS crm_lookbook_interest ("
        " id serial PRIMARY KEY, lookbook_id int, customer_id text, sku text,"
        " product_title text, created_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_wishlist ("
        " id serial PRIMARY KEY, customer_id text, product_title text, note text,"
        " fulfilled boolean DEFAULT false, created_by text,"
        " created_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_user_goal ("
        " user_id text PRIMARY KEY, daily_goal int DEFAULT 10,"
        " updated_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_moment ("
        " id serial PRIMARY KEY, customer_id text NOT NULL, label text,"
        " moment_type text, moment_date date, recurring_annual boolean DEFAULT false,"
        " created_by text, created_at timestamptz DEFAULT now())",
        "ALTER TABLE crm_moment ADD COLUMN IF NOT EXISTS moment_type text",
        "ALTER TABLE crm_moment ADD COLUMN IF NOT EXISTS recurring_annual boolean DEFAULT false",
        "ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS completed_at timestamptz",
        "CREATE TABLE IF NOT EXISTS crm_social_handle ("
        " id serial PRIMARY KEY, customer_id text NOT NULL, platform text NOT NULL,"
        " handle text, added_at timestamptz DEFAULT now(),"
        " UNIQUE (customer_id, platform))",
        "CREATE TABLE IF NOT EXISTS crm_social_feedback ("
        " id serial PRIMARY KEY, platform text, type text DEFAULT 'mention',"
        " author_name text, author_handle text, body text,"
        " sentiment text, themes jsonb DEFAULT '[]'::jsonb,"
        " customer_id text, reply_body text, replied_at timestamptz,"
        " posted_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now())",
        "CREATE TABLE IF NOT EXISTS crm_template ("
        " id serial PRIMARY KEY, name text, channel text, body text,"
        " bsp_status text DEFAULT 'approved', created_by text,"
        " created_at timestamptz DEFAULT now())",
    ]
    for s in stmts:
        try:
            _ex(s)
        except Exception as e:  # pragma: no cover - best effort DDL
            try:
                A.log.warning("clienteling DDL skipped: %s", e)
            except Exception:
                pass


# --------------------------------------------------------------------------- #
# STAGE 1 — Dashboard / outreach                                              #
# --------------------------------------------------------------------------- #
def _reg_dashboard(app):
    @app.get("/api/dashboard/me")
    def cl_dashboard_me(request: Request):
        uid, name, _role = _actor(request)
        goal_row = _one(
            "SELECT daily_goal FROM crm_user_goal WHERE user_id=%s", (uid,))
        daily_goal = _int(goal_row["daily_goal"], 10) if goal_row else 10

        agg = _one(
            "SELECT "
            " COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today, "
            " COUNT(DISTINCT customer_id) FILTER ("
            "   WHERE created_at >= date_trunc('week', now())) AS week_cust, "
            " COUNT(DISTINCT customer_id) FILTER ("
            "   WHERE created_at >= date_trunc('week', now()) - interval '7 days' "
            "   AND created_at < date_trunc('week', now())) AS prev_cust, "
            " COUNT(*) FILTER (WHERE type='message' "
            "   AND created_at >= date_trunc('week', now())) AS week_msg, "
            " COUNT(*) FILTER (WHERE type='message' "
            "   AND created_at >= date_trunc('week', now()) - interval '7 days' "
            "   AND created_at < date_trunc('week', now())) AS prev_msg "
            "FROM crm_interactions WHERE user_name=%s", (name,)) or {}

        def _delta(cur, prev):
            cur, prev = _num(cur), _num(prev)
            if prev <= 0:
                return 100.0 if cur > 0 else 0.0
            return round((cur - prev) / prev * 100.0, 1)

        tasks_agg = _one(
            "SELECT COUNT(*) FILTER (WHERE status <> 'done') AS open, "
            " COUNT(*) FILTER (WHERE status <> 'done' AND due_date IS NOT NULL "
            "   AND due_date::date < CURRENT_DATE) AS overdue "
            "FROM crm_tasks WHERE assignee_user_id=%s", (uid,)) or {}

        notes = _ex(
            "SELECT notes AS body FROM crm_interactions "
            "WHERE user_name=%s AND type='note' AND COALESCE(notes,'')<>'' "
            "ORDER BY created_at DESC LIMIT 5", (name,), fetch=True) or []

        trows = _ex(
            "SELECT t.id, t.title, t.customer_id, t.due_date, " +
            _name_sql("t") + " AS customer_name "
            "FROM crm_tasks t WHERE t.assignee_user_id=%s AND t.status <> 'done' "
            "ORDER BY (t.due_date IS NULL), t.due_date ASC LIMIT 12",
            (uid,), fetch=True) or []

        return {
            "daily_goal": daily_goal,
            "contacts_today": _int(agg.get("today")),
            "customers_contacted_this_week": _int(agg.get("week_cust")),
            "customers_delta_pct": _delta(agg.get("week_cust"), agg.get("prev_cust")),
            "messages_this_week": _int(agg.get("week_msg")),
            "messages_delta_pct": _delta(agg.get("week_msg"), agg.get("prev_msg")),
            "open_tasks": _int(tasks_agg.get("open")),
            "overdue_tasks": _int(tasks_agg.get("overdue")),
            "recent_notes": [{"body": r["body"]} for r in notes],
            "tasks": [{
                "task_id": str(r["id"]),
                "title": r["title"],
                "customer_id": r["customer_id"],
                "customer_name": r["customer_name"],
                "due_date": _dt(r["due_date"]),
            } for r in trows],
        }

    @app.put("/api/dashboard/me/goal")
    def cl_dashboard_goal(request: Request, payload: dict = Body(default=None)):
        uid, _name, _role = _actor(request)
        goal = _clamp((payload or {}).get("daily_goal"), 1, 1000, 10)
        _ex(
            "INSERT INTO crm_user_goal (user_id, daily_goal, updated_at) "
            "VALUES (%s,%s,now()) ON CONFLICT (user_id) DO UPDATE "
            "SET daily_goal=EXCLUDED.daily_goal, updated_at=now()", (uid, goal))
        return {"ok": True, "daily_goal": goal}

    @app.get("/api/dashboard/call-list")
    def cl_call_list(request: Request, with_nba: bool = Query(False)):
        # Buckets of customers who deserve outreach, derived from recency +
        # 12-month value. Each row carries enough for the card + a quick NBA.
        rec = ("CASE WHEN c.last_order_date " + _ISO +
               " THEN (CURRENT_DATE - c.last_order_date::date) END")
        cust = (
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " SUM(total_orders) AS orders, SUM(total_spend_kes::numeric) AS spend, "
            " MAX(last_order_date) AS last_order_date "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, "
            " COALESCE(orders,0) AS total_orders, COALESCE(spend,0) AS total_sales, "
            " last_order_date AS last_purchase_date, (" + rec + ") AS recency, " +
            _rfm_case("COALESCE(orders,0)", rec) + " AS rfm_tier "
            "FROM c")

        def _bucket(where, order, limit=15):
            rows = A.run_query(
                cust + " WHERE " + where + " ORDER BY " + order +
                " LIMIT " + str(limit)) or []
            out = []
            for r in rows:
                out.append({
                    "customer_id": r["customer_id"],
                    "customer_name": r["customer_name"],
                    "rfm_tier": r["rfm_tier"],
                    "nba_urgency": _nba_urgency(r),
                    "nba_action": _nba_action(r),
                    "total_orders": _int(r["total_orders"]),
                    "last_purchase_date": r["last_purchase_date"],
                    "total_sales": round(_num(r["total_sales"]), 2),
                })
            return out

        anniversaries = _bucket(
            "last_order_date " + _ISO + " AND EXTRACT(MONTH FROM last_order_date::date)="
            "EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(DAY FROM last_order_date::date) "
            "BETWEEN EXTRACT(DAY FROM CURRENT_DATE)-3 AND EXTRACT(DAY FROM CURRENT_DATE)+3 "
            "AND COALESCE(orders,0) >= 2", "spend DESC")
        vip_silent = _bucket(
            "COALESCE(spend,0) >= 50000 AND (" + rec + ") BETWEEN 60 AND 180",
            "spend DESC")
        at_risk = _bucket(
            "(" + rec + ") BETWEEN 90 AND 365 AND COALESCE(orders,0) >= 2",
            "spend DESC")
        churned = _bucket(
            "(" + rec + ") > 365 AND COALESCE(orders,0) >= 2", "spend DESC")
        return {
            "ai_pending": 0,
            "anniversaries": anniversaries,
            "vip_silent": vip_silent,
            "at_risk": at_risk,
            "churned": churned,
        }


def _nba_urgency(r):
    rec = _num(r.get("recency"), 9999)
    spend = _num(r.get("total_sales"))
    if rec > 365 and spend >= 30000:
        return "high"
    if 90 <= rec <= 365:
        return "medium"
    return "low"


def _nba_action(r):
    rec = _num(r.get("recency"), 9999)
    tier = r.get("rfm_tier")
    if tier == "Champion":
        return "Invite to a private styling preview"
    if rec > 365:
        return "Win-back: personal note + a returning-guest offer"
    if rec > 180:
        return "Re-engage with new-arrivals tailored to their style"
    if tier in ("Loyal", "Promising"):
        return "Thank-you check-in + complete-the-look suggestion"
    return "Welcome follow-up and size/fit confirmation"


# --------------------------------------------------------------------------- #
# STAGE 1 — Customers grid, 360 profile, NBA, timeline, churn, assignment      #
# --------------------------------------------------------------------------- #
def _grid_base():
    """Cached per-customer aggregation backing the customers grid (one row per
    customer_id). No user input → executed via run_query (cached, no param
    binding so BASE_FILTERS' literal % is safe). Excludes assignment, which is
    merged live per request."""
    rec = ("CASE WHEN b.last_order_date " + _ISO +
           " THEN (CURRENT_DATE - b.last_order_date::date) END")
    sql = (
        "WITH s12 AS ("
        " SELECT s.customer_id, SUM(s.total_sales_kes::numeric) AS spend12 "
        " FROM all_sales s WHERE s.customer_id IS NOT NULL AND s.customer_id<>'' "
        " AND s.sale_date " + _ISO +
        " AND s.sale_date::date >= CURRENT_DATE - INTERVAL '12 months' AND " +
        A.BASE_FILTERS + " GROUP BY s.customer_id), "
        "b AS ("
        " SELECT ac.customer_id, "
        "  NULLIF(TRIM(MAX(COALESCE(ac.first_name,''))||' '||MAX(COALESCE(ac.last_name,''))),'') AS nm, "
        "  SUM(ac.total_orders) AS orders, SUM(ac.total_spend_kes::numeric) AS spend, "
        "  MAX(NULLIF(ac.email,'')) AS email, MAX(NULLIF(ac.phone,'')) AS phone, "
        "  MAX(NULLIF(ac.city,'')) AS city, MAX(ac.last_order_date) AS last_order_date "
        " FROM all_customers ac GROUP BY ac.customer_id) "
        "SELECT b.customer_id, COALESCE(b.nm,'Guest') AS customer_name, "
        " COALESCE(b.orders,0) AS total_orders, COALESCE(b.spend,0) AS total_sales, "
        " CASE WHEN COALESCE(b.orders,0)>0 THEN ROUND(COALESCE(b.spend,0)/b.orders,2) ELSE 0 END AS avg_order_value, "
        " b.last_order_date AS last_purchase_date, (" + rec + ") AS days_since_last_purchase, "
        " b.city, b.email, b.phone, (b.email IS NOT NULL) AS has_email, (b.phone IS NOT NULL) AS has_phone, "
        " COALESCE(s.spend12,0) AS spend_12mo_kes, "
        " COALESCE(le.tier, " + _tier_case("COALESCE(s.spend12,0)") + ") AS loyalty_tier, " +
        _rfm_case("COALESCE(b.orders,0)", rec) + " AS rfm_tier "
        "FROM b LEFT JOIN s12 s ON s.customer_id=b.customer_id "
        "LEFT JOIN crm_loyalty_enrolment le ON le.customer_id=b.customer_id")
    return A.run_query(sql) or []


def _grid_matched(flt, request):
    """Apply the customer-grid filter contract (identical for the grid + the CSV
    export) to the cached invariant base, merging live assignments. Returns a
    list of (row, assignee_name) tuples in base order."""
    flt = flt or {}
    base = _grid_base()
    asg_map = {r["customer_id"]: r for r in (_ex(
        "SELECT customer_id, assignee_user_id, assignee_name FROM crm_assignment",
        fetch=True) or [])}

    q = (flt.get("q") or "").strip().lower()
    cities = set(str(c) for c in (flt.get("cities") or []) if isinstance(flt.get("cities"), list))
    lts = set(str(c) for c in (flt.get("loyalty_tiers") or []) if isinstance(flt.get("loyalty_tiers"), list))
    rts = set(str(c) for c in (flt.get("rfm_tiers") or []) if isinstance(flt.get("rfm_tiers"), list))
    has_phone = bool(flt.get("has_phone"))
    has_email = bool(flt.get("has_email"))
    min_spend = _num(flt.get("min_spend_12mo")) if flt.get("min_spend_12mo") not in (None, "") else None
    min_orders = _int(flt.get("min_orders")) if flt.get("min_orders") not in (None, "") else None
    within = _int(flt.get("last_purchase_within_days")) if flt.get("last_purchase_within_days") not in (None, "") else None
    beyond = _int(flt.get("last_purchase_beyond_days")) if flt.get("last_purchase_beyond_days") not in (None, "") else None
    assignment = (flt.get("assignment") or "").strip().lower()
    my_uid = None
    if assignment == "mine":
        my_uid, _n, _r = _actor(request)

    matched = []
    for r in base:
        asg = asg_map.get(r["customer_id"])
        assignee_uid = asg["assignee_user_id"] if asg else None
        assignee_name = asg["assignee_name"] if asg else None
        if q:
            hay = (str(r.get("customer_name") or "").lower() + "\x00" +
                   str(r.get("email") or "").lower() + "\x00" +
                   str(r.get("phone") or "") + "\x00" + str(r["customer_id"]))
            if q not in hay:
                continue
        if cities and (r.get("city") or "") not in cities:
            continue
        if lts and (r.get("loyalty_tier") or "") not in lts:
            continue
        if rts and (r.get("rfm_tier") or "") not in rts:
            continue
        if has_phone and not r.get("has_phone"):
            continue
        if has_email and not r.get("has_email"):
            continue
        if min_spend is not None and _num(r.get("spend_12mo_kes")) < min_spend:
            continue
        if min_orders is not None and _int(r.get("total_orders")) < min_orders:
            continue
        dsl = r.get("days_since_last_purchase")
        if within is not None and (dsl is None or dsl > within):
            continue
        if beyond is not None and (dsl is None or dsl < beyond):
            continue
        if assignment == "assigned" and not assignee_name:
            continue
        if assignment == "unassigned" and assignee_name:
            continue
        if assignment == "mine" and assignee_uid != my_uid:
            continue
        matched.append((r, assignee_name))
    return matched


def _reg_customers(app):
    @app.post("/api/customers/grid")
    def cl_customers_grid(request: Request, payload: dict = Body(default=None)):
        payload = payload or {}
        flt = payload.get("filters") or {}
        limit = _clamp(payload.get("limit"), 1, 200, 50)
        offset = max(_int(payload.get("offset"), 0), 0)
        sort_map = {
            "customer_name": "customer_name",
            "total_sales": "total_sales",
            "total_orders": "total_orders",
            "avg_order_value": "avg_order_value",
            "last_purchase_date": "last_purchase_date",
            "days_since_last_purchase": "days_since_last_purchase",
            "spend_12mo_kes": "spend_12mo_kes",
        }
        sort_col = sort_map.get(str(payload.get("sort") or ""), "total_sales")
        order = "ASC" if str(payload.get("order") or "desc").lower() == "asc" else "DESC"

        # Heavy invariant base (per-customer aggregation over all_sales 12mo +
        # all_customers) is identical for every caller, so it is computed once and
        # served from run_query's cache. User filters / sort / pagination are
        # applied in Python. Live assignments are merged in fresh each call so the
        # assignment column and its filters are never stale.
        matched = _grid_matched(flt, request)
        total = len(matched)
        present = [m for m in matched if m[0].get(sort_col) is not None]
        absent = [m for m in matched if m[0].get(sort_col) is None]
        present.sort(key=lambda m: m[0].get(sort_col), reverse=(order == "DESC"))
        ordered = present + absent
        page = ordered[offset:offset + limit]
        out = []
        for r, assignee_name in page:
            out.append({
                "customer_id": r["customer_id"],
                "customer_name": r["customer_name"],
                "loyalty_tier": r["loyalty_tier"],
                "rfm_tier": r["rfm_tier"],
                "spend_12mo_kes": round(_num(r["spend_12mo_kes"]), 2),
                "total_sales": round(_num(r["total_sales"]), 2),
                "total_orders": _int(r["total_orders"]),
                "avg_order_value": round(_num(r["avg_order_value"]), 2),
                "last_purchase_date": r["last_purchase_date"],
                "days_since_last_purchase": r["days_since_last_purchase"],
                "city": r["city"],
                "assignee_name": assignee_name,
                "has_phone": bool(r["has_phone"]),
                "has_email": bool(r["has_email"]),
            })
        return {"total": total, "rows": out}

    @app.get("/api/customers/grid/facets")
    def cl_customers_facets(request: Request):
        total = A.run_query(
            "SELECT COUNT(DISTINCT customer_id) AS n FROM all_customers") or [{}]
        cities = A.run_query(
            "SELECT NULLIF(city,'') AS city, COUNT(*) n FROM all_customers "
            "WHERE NULLIF(city,'') IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 100") or []
        return {
            "total_in_cache": _int(total[0].get("n")) if total else 0,
            "cities": [c["city"] for c in cities],
        }

    @app.get("/api/customers/freshness")
    def cl_customers_freshness(request: Request):
        row = A.run_query(
            "SELECT MAX(last_synced) AS last FROM all_customers") or [{}]
        return {
            "last_synced_at": _dt(row[0].get("last")) if row else None,
            "last_sync_kind": "odoo",
            "running": False,
        }

    @app.post("/api/customers/refresh")
    def cl_customers_refresh(request: Request):
        # Customer data is read live from Postgres on every query; there is no
        # separate cache to rebuild here. Acknowledge so the UI clears its state.
        return {"ok": True, "running": False,
                "message": "Customer data is read live from the warehouse."}

    @app.get("/api/customers/grid/export", response_class=PlainTextResponse)
    def cl_customers_export(request: Request):
        rows = A.run_query(
            "SELECT customer_id, "
            " COALESCE(NULLIF(TRIM(MAX(COALESCE(first_name,''))||' '||MAX(COALESCE(last_name,''))),''),'Guest') AS name, "
            " MAX(NULLIF(email,'')) AS email, MAX(NULLIF(phone,'')) AS phone, "
            " MAX(NULLIF(city,'')) AS city, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS last_order "
            "FROM all_customers GROUP BY customer_id ORDER BY spend DESC NULLS LAST "
            "LIMIT 5000") or []
        lines = ["customer_id,name,email,phone,city,total_orders,total_spend_kes,last_order_date"]

        def _csv(v):
            s = "" if v is None else str(v)
            return '"' + s.replace('"', '""') + '"' if ("," in s or '"' in s) else s
        for r in rows:
            lines.append(",".join(_csv(x) for x in [
                r["customer_id"], r["name"], r["email"], r["phone"], r["city"],
                _int(r["orders"]), round(_num(r["spend"]), 2), r["last_order"]]))
        return "\n".join(lines)

    @app.post("/api/customers/grid/export")
    def cl_customers_grid_export(request: Request, payload: dict = Body(default=None)):
        # Same filter contract as POST /grid, but emits the full matched set as a
        # downloadable CSV (the frontend requests it as a blob). Bounded so a
        # large unfiltered export still completes within HTTP limits.
        payload = payload or {}
        flt = payload.get("filters") or {}
        cap = _clamp(payload.get("limit"), 1, 50000, 50000)
        matched = _grid_matched(flt, request)
        cols = ["customer_id", "customer_name", "loyalty_tier", "rfm_tier",
                "spend_12mo_kes", "total_sales", "total_orders", "avg_order_value",
                "last_purchase_date", "days_since_last_purchase", "city",
                "assignee_name", "phone", "email"]
        lines = [",".join(cols)]

        def _csv(v):
            s = "" if v is None else str(v)
            return ('"' + s.replace('"', '""') + '"'
                    if ("," in s or '"' in s or "\n" in s) else s)
        for r, assignee_name in matched[:cap]:
            lines.append(",".join(_csv(x) for x in [
                r["customer_id"], r.get("customer_name"), r.get("loyalty_tier"),
                r.get("rfm_tier"), round(_num(r.get("spend_12mo_kes")), 2),
                round(_num(r.get("total_sales")), 2), _int(r.get("total_orders")),
                round(_num(r.get("avg_order_value")), 2), r.get("last_purchase_date"),
                r.get("days_since_last_purchase"), r.get("city"), assignee_name,
                r.get("phone"), r.get("email")]))
        csv = "\n".join(lines)
        fname = "vivo-customers-" + _today() + ".csv"
        return Response(content=csv, media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="' + fname + '"'})

    @app.get("/api/my-customers")
    def cl_my_customers(request: Request):
        uid, _n, _r = _actor(request)
        rows = _ex(
            "WITH a AS (SELECT customer_id FROM crm_assignment WHERE assignee_user_id=%s) "
            "SELECT a.customer_id, " + _name_sql("a") + " AS customer_name, "
            " (SELECT SUM(total_spend_kes::numeric) FROM all_customers ac WHERE ac.customer_id=a.customer_id) AS total_sales, "
            " (SELECT SUM(total_orders) FROM all_customers ac WHERE ac.customer_id=a.customer_id) AS total_orders, "
            " (SELECT MAX(last_order_date) FROM all_customers ac WHERE ac.customer_id=a.customer_id) AS last_purchase_date "
            "FROM a ORDER BY total_sales DESC NULLS LAST LIMIT 500",
            (uid,), fetch=True) or []
        return [{
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "total_sales": round(_num(r["total_sales"]), 2),
            "total_orders": _int(r["total_orders"]),
            "last_purchase_date": r["last_purchase_date"],
        } for r in rows]

    @app.get("/api/bi/customer/{cid}")
    def cl_bi_customer(request: Request, cid: str):
        prof = _customer_profile(cid)
        if not prof:
            raise HTTPException(status_code=404, detail="Customer not found")
        products = _ex(
            "SELECT s.product_title, "
            " COALESCE(MAX(inv.style_name), s.product_title) AS style_name, "
            " MAX(NULLIF(s.variant_title,'')) AS size, "
            " MAX(inv.color_print) AS color, "
            " COALESCE(MAX(inv.sub_category), MAX(s.product_type)) AS subcategory, "
            " MAX(s.sale_date) AS last_purchase_date, "
            " SUM(s.total_sales_kes::numeric) AS total_sales, "
            " SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS quantity "
            "FROM all_sales s LEFT JOIN ("
            "  SELECT sku, MAX(style_name) style_name, MAX(color_print) color_print, "
            "  MAX(sub_category) sub_category FROM all_inventory GROUP BY sku) inv "
            "  ON inv.sku = s.variant_sku "
            "WHERE s.customer_id=%s AND s.sale_kind IN ('sale','order') "
            "GROUP BY s.product_title ORDER BY total_sales DESC NULLS LAST LIMIT 100",
            (cid,), fetch=True) or []
        return {
            "profile": prof,
            "products": [{
                "product_title": p["product_title"],
                "style_name": p["style_name"],
                "size": p["size"],
                "color": p["color"],
                "subcategory": p["subcategory"],
                "last_purchase_date": p["last_purchase_date"],
                "total_sales": round(_num(p["total_sales"]), 2),
                "quantity": _int(p["quantity"]),
            } for p in products],
        }

    @app.get("/api/customers/{cid}/nba")
    def cl_customer_nba(request: Request, cid: str):
        prof = _customer_profile(cid) or {}
        rec = _recency_days(prof.get("last_purchase_date"))
        ctx = {"recency": rec, "total_sales": prof.get("total_sales"),
               "rfm_tier": prof.get("rfm_tier")}
        action = _nba_action(ctx)
        urg = _nba_urgency(ctx)
        nm = prof.get("customer_name") or "the customer"
        why = _nba_why(prof, rec)
        script = (
            "Hi " + nm.split(" ")[0] + ", it's your stylist at Vivo. " +
            ("We've missed you — " if (rec or 0) > 180 else "Thanks for shopping with us — ") +
            "I picked a few new pieces I think you'll love based on your past favourites. "
            "Would you like me to set them aside for you?")
        return {"action": action, "why": why, "script": script, "urgency": urg}

    @app.get("/api/customers/{cid}/timeline")
    def cl_customer_timeline(request: Request, cid: str):
        events = []
        purchases = _ex(
            "SELECT s.sale_date AS ts, COUNT(DISTINCT s.order_id) AS orders, "
            " SUM(s.total_sales_kes::numeric) AS amt, "
            " STRING_AGG(DISTINCT s.product_title, ', ') AS items "
            "FROM all_sales s WHERE s.customer_id=%s AND s.sale_kind IN ('sale','order') "
            " AND s.sale_date " + _ISO +
            " GROUP BY s.sale_date ORDER BY s.sale_date DESC LIMIT 50",
            (cid,), fetch=True) or []
        for p in purchases:
            items = (p["items"] or "")[:120]
            events.append({
                "kind": "purchase",
                "label": "Purchase · KES " + format(round(_num(p["amt"])), ","),
                "ts": p["ts"],
                "detail": items,
            })
        inter = _ex(
            "SELECT type, channel, notes, user_name, created_at FROM crm_interactions "
            "WHERE customer_id=%s ORDER BY created_at DESC LIMIT 50",
            (cid,), fetch=True) or []
        for i in inter:
            kind = "note" if i["type"] == "note" else (
                "message" if i["type"] == "message" else "note")
            events.append({
                "kind": kind,
                "label": (i["type"] or "note").title() +
                         ((" · " + i["channel"]) if i["channel"] else ""),
                "ts": _dt(i["created_at"]),
                "detail": (i["notes"] or "") + (
                    (" — " + i["user_name"]) if i["user_name"] else ""),
            })
        tasks = _ex(
            "SELECT title, due_date, status, created_at FROM crm_tasks "
            "WHERE customer_id=%s ORDER BY created_at DESC LIMIT 25",
            (cid,), fetch=True) or []
        for t in tasks:
            events.append({
                "kind": "task",
                "label": "Task · " + (t["title"] or ""),
                "ts": _dt(t["created_at"]),
                "detail": "Due " + (_dt(t["due_date"]) or "—") +
                          " · " + (t["status"] or "open"),
            })
        events.sort(key=lambda e: str(e["ts"] or ""), reverse=True)
        return {"events": events[:120]}

    @app.get("/api/customers/{cid}/churn-reasoning")
    def cl_customer_churn(request: Request, cid: str):
        prof = _customer_profile(cid) or {}
        rec = _recency_days(prof.get("last_purchase_date")) or 0
        orders = _int(prof.get("total_orders"))
        cadence = _cadence_days(prof.get("first_purchase_date"),
                                prof.get("last_purchase_date"), orders)
        score = 0
        reasons = []
        if cadence and rec > cadence * 2:
            score += 45
            reasons.append("Gone " + str(rec) + " days since last purchase — over twice "
                           "their usual " + str(cadence) + "-day cadence.")
        elif rec > 365:
            score += 45
            reasons.append("No purchase in over a year (" + str(rec) + " days).")
        elif rec > 180:
            score += 25
            reasons.append("No purchase in " + str(rec) + " days.")
        if orders <= 1:
            score += 25
            reasons.append("Only a single purchase on record — not yet a habit.")
        if _num(prof.get("total_sales")) < 5000:
            score += 10
            reasons.append("Low lifetime value so far.")
        if not reasons:
            reasons.append("Healthy, recent and repeat purchasing — low churn risk.")
        score = max(0, min(100, score))
        band = "high" if score >= 60 else ("medium" if score >= 30 else "low")
        return {
            "risk_score": score,
            "risk_band": band,
            "reasons": reasons,
            "days_since_last_purchase": rec,
            "avg_cadence_days": cadence,
        }

    @app.get("/api/customers/{cid}/assignment")
    def cl_customer_assignment_get(request: Request, cid: str):
        row = _one(
            "SELECT assignee_user_id, assignee_name FROM crm_assignment WHERE customer_id=%s",
            (cid,))
        return {
            "assignee_user_id": row["assignee_user_id"] if row else None,
            "assignee_name": row["assignee_name"] if row else None,
        }

    @app.post("/api/customers/{cid}/assignment")
    def cl_customer_assignment_set(request: Request, cid: str,
                                   payload: dict = Body(default=None)):
        uid, name, _r = _actor(request)
        payload = payload or {}
        target_uid = payload.get("assignee_user_id") or uid
        urow = _one("SELECT name, email FROM app_users WHERE user_id=%s", (target_uid,))
        target_name = (urow.get("name") or urow.get("email")) if urow else name
        if not payload.get("assignee_user_id"):
            target_name = name
        _ex(
            "INSERT INTO crm_assignment (customer_id, assignee_user_id, assignee_name, assigned_by) "
            "VALUES (%s,%s,%s,%s) ON CONFLICT (customer_id) DO UPDATE "
            "SET assignee_user_id=EXCLUDED.assignee_user_id, "
            "assignee_name=EXCLUDED.assignee_name, assigned_by=EXCLUDED.assigned_by, "
            "assigned_at=now()", (cid, target_uid, target_name, name))
        A._crm_audit("customer", cid, "assign", "→ " + str(target_name), request)
        return {"ok": True, "assignee_user_id": target_uid, "assignee_name": target_name}

    @app.put("/api/customers/{cid}/assignment")
    def cl_customer_assignment_put(request: Request, cid: str,
                                   payload: dict = Body(default=None)):
        # The grid/profile UI sends PUT to assign (assignee_user_id + name) and
        # to unassign (assignee_user_id: null).
        _uid, name, _r = _actor(request)
        payload = payload or {}
        target_uid = payload.get("assignee_user_id")
        if not target_uid:
            _ex("DELETE FROM crm_assignment WHERE customer_id=%s", (cid,))
            A._crm_audit("customer", cid, "unassign", "cleared", request)
            return {"ok": True, "assignee_user_id": None, "assignee_name": None}
        target_name = (payload.get("assignee_name") or "").strip()
        if not target_name:
            urow = _one("SELECT name, email FROM app_users WHERE user_id=%s",
                        (target_uid,))
            target_name = (urow.get("name") or urow.get("email")) if urow else target_uid
        _ex(
            "INSERT INTO crm_assignment (customer_id, assignee_user_id, assignee_name, assigned_by) "
            "VALUES (%s,%s,%s,%s) ON CONFLICT (customer_id) DO UPDATE "
            "SET assignee_user_id=EXCLUDED.assignee_user_id, "
            "assignee_name=EXCLUDED.assignee_name, assigned_by=EXCLUDED.assigned_by, "
            "assigned_at=now()", (cid, target_uid, target_name, name))
        A._crm_audit("customer", cid, "assign", "→ " + str(target_name), request)
        return {"ok": True, "assignee_user_id": target_uid, "assignee_name": target_name}

    @app.post("/api/customers/{cid}/forget")
    def cl_customer_forget(request: Request, cid: str):
        # GDPR erasure of CRM-held personal data for this customer (the
        # read-only warehouse rows are not mutated here).
        for tbl in ("crm_assignment", "crm_preferences", "crm_consent",
                    "crm_interactions", "crm_wishlist", "crm_lookbook",
                    "crm_moment", "crm_customer_tags"):
            try:
                _ex("DELETE FROM " + tbl + " WHERE customer_id=%s", (cid,))
            except Exception:
                pass
        try:
            _ex("UPDATE crm_customer SET first_name=NULL, last_name=NULL, phone=NULL, "
                "email=NULL, dob=NULL WHERE customer_id=%s", (cid,))
        except Exception:
            pass
        A._crm_audit("customer", cid, "forget", "GDPR erasure", request)
        return {"ok": True}


def _customer_profile(cid):
    row = _one(
        "SELECT customer_id, "
        " COALESCE(NULLIF(TRIM(MAX(COALESCE(first_name,''))||' '||MAX(COALESCE(last_name,''))),''),'Guest') AS customer_name, "
        " MAX(NULLIF(phone,'')) AS phone, MAX(NULLIF(email,'')) AS email, "
        " MAX(NULLIF(country,'')) AS country, SUM(total_orders) AS orders, "
        " SUM(total_spend_kes::numeric) AS spend, MIN(NULLIF(first_order_date,'')) AS first_order, "
        " MAX(last_order_date) AS last_order "
        "FROM all_customers WHERE customer_id=%s GROUP BY customer_id", (cid,))
    if not row:
        return None
    # CRM override (manual contacts / edits)
    ov = _one("SELECT first_name, last_name, phone, email FROM crm_customer WHERE customer_id=%s", (cid,))
    name = row["customer_name"]
    phone = row["phone"]
    email = row["email"]
    if ov:
        nm = ((ov.get("first_name") or "") + " " + (ov.get("last_name") or "")).strip()
        if nm:
            name = nm
        phone = ov.get("phone") or phone
        email = ov.get("email") or email
    spend12 = _crm_spend12(cid)
    enr = _one("SELECT tier FROM crm_loyalty_enrolment WHERE customer_id=%s", (cid,))
    orders = _int(row["orders"])
    spend = _num(row["spend"])
    rec = _recency_days(row["last_order"])
    return {
        "customer_id": cid,
        "customer_name": name,
        "phone": phone,
        "email": email,
        "customer_country": row["country"],
        "first_purchase_date": row["first_order"],
        "last_purchase_date": row["last_order"],
        "total_sales": round(spend, 2),
        "total_orders": orders,
        "avg_basket": round(spend / orders, 2) if orders else 0,
        "loyalty_tier": (enr["tier"] if enr else _tier_for_spend(spend12)),
        "rfm_tier": _rfm_tier(orders, rec),
    }


def _crm_spend12(cid):
    row = _one(
        "SELECT COALESCE(SUM(total_sales_kes::numeric),0) AS s FROM all_sales "
        "WHERE customer_id=%s AND sale_kind IN ('sale','order') AND sale_date " + _ISO +
        " AND sale_date::date >= CURRENT_DATE - INTERVAL '12 months'", (cid,))
    return _num(row["s"]) if row else 0


def _tier_for_spend(spend):
    s = _num(spend)
    if s >= 100000:
        return "Gold"
    if s >= 50000:
        return "Silver"
    return "Bronze"


def _rfm_tier(orders, rec):
    rec = 99999 if rec is None else rec
    if orders >= 5 and rec <= 90:
        return "Champion"
    if orders >= 3 and rec <= 180:
        return "Loyal"
    if orders >= 2 and rec <= 365:
        return "Promising"
    if rec > 365 and orders >= 2:
        return "At Risk"
    if orders <= 1 and rec <= 180:
        return "New"
    return "Dormant"


def _recency_days(last_order):
    if not last_order:
        return None
    try:
        d = date.fromisoformat(str(last_order)[:10])
    except ValueError:
        return None
    return (date.today() - d).days


def _cadence_days(first_order, last_order, orders):
    if not first_order or not last_order or orders <= 1:
        return None
    try:
        f = date.fromisoformat(str(first_order)[:10])
        l = date.fromisoformat(str(last_order)[:10])
    except ValueError:
        return None
    span = (l - f).days
    if span <= 0:
        return None
    return max(1, round(span / (orders - 1)))


def _nba_why(prof, rec):
    tier = prof.get("rfm_tier")
    if tier == "Champion":
        return "One of your most valuable, most loyal customers — worth a VIP touch."
    if (rec or 0) > 365:
        return "Lapsed for over a year; a personal win-back has the highest upside."
    if (rec or 0) > 180:
        return "Cooling off — re-engage before they churn."
    if tier in ("Loyal", "Promising"):
        return "Repeat buyer on a healthy cadence; nurture the relationship."
    return "Early in their journey — a warm follow-up builds the habit."


# --------------------------------------------------------------------------- #
# STAGE 1 — Tasks, notes, users, audit                                         #
# --------------------------------------------------------------------------- #
def _reg_tasks_notes(app):
    @app.get("/api/tasks")
    def cl_tasks(request: Request, mine: bool = Query(False),
                 customer_id: str = Query(None)):
        uid, _n, _r = _actor(request)
        where = []
        params = []
        if mine:
            where.append("t.assignee_user_id=%s")
            params.append(uid)
        if customer_id:
            where.append("t.customer_id=%s")
            params.append(customer_id)
        wh = (" WHERE " + " AND ".join(where)) if where else ""
        rows = _ex(
            "SELECT t.id, t.title, t.customer_id, t.due_date, t.completed_at, t.status, " +
            _name_sql("t") + " AS customer_name FROM crm_tasks t" + wh +
            " ORDER BY (t.status='done'), (t.due_date IS NULL), t.due_date ASC LIMIT 300",
            tuple(params), fetch=True) or []
        return [{
            "task_id": str(r["id"]),
            "title": r["title"],
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "due_date": _dt(r["due_date"]),
            "completed_at": _dt(r["completed_at"]),
        } for r in rows]

    @app.post("/api/tasks")
    def cl_task_create(request: Request, payload: dict = Body(default=None)):
        uid, name, _r = _actor(request)
        payload = payload or {}
        title = (payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required")
        cid = payload.get("customer_id")
        due = payload.get("due_date") or None
        row = _one(
            "INSERT INTO crm_tasks (customer_id, title, due_date, status, "
            "assignee_user_id, brand_code, created_at) "
            "VALUES (%s,%s,%s,'open',%s,%s,now()) RETURNING id",
            (cid, title, due, uid, _DEF))
        A._crm_audit("task", row["id"] if row else "", "create", title, request)
        return {"ok": True, "task_id": str(row["id"]) if row else None}

    @app.post("/api/tasks/{task_id}/complete")
    def cl_task_complete(request: Request, task_id: str):
        tid = _int(task_id, -1)
        _ex("UPDATE crm_tasks SET status='done', completed_at=now() WHERE id=%s", (tid,))
        A._crm_audit("task", task_id, "complete", "", request)
        return {"ok": True}

    @app.get("/api/notes")
    def cl_notes(request: Request, customer_id: str = Query(None)):
        where = "WHERE i.type='note'"
        params = []
        if customer_id:
            where += " AND i.customer_id=%s"
            params.append(customer_id)
        rows = _ex(
            "SELECT i.id, i.customer_id, i.notes AS body, i.user_name, i.created_at, " +
            _name_sql("i") + " AS customer_name FROM crm_interactions i " + where +
            " ORDER BY i.created_at DESC LIMIT 200", tuple(params), fetch=True) or []
        return [{
            "id": str(r["id"]),
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "body": r["body"],
            "user_name": r["user_name"],
            "created_at": _dt(r["created_at"]),
        } for r in rows]

    @app.post("/api/notes")
    def cl_note_create(request: Request, payload: dict = Body(default=None)):
        _uid, name, _r = _actor(request)
        payload = payload or {}
        body = (payload.get("body") or "").strip()
        cid = payload.get("customer_id")
        if not body or not cid:
            raise HTTPException(status_code=400, detail="customer_id and body required")
        row = _one(
            "INSERT INTO crm_interactions (customer_id, type, notes, user_name, created_at) "
            "VALUES (%s,'note',%s,%s,now()) RETURNING id", (cid, body, name))
        A._crm_audit("note", row["id"] if row else "", "create", body[:120], request)
        return {"ok": True, "id": str(row["id"]) if row else None}

    @app.delete("/api/notes/{note_id}")
    def cl_note_delete(request: Request, note_id: str):
        _ex("DELETE FROM crm_interactions WHERE id=%s AND type='note'",
            (_int(note_id, -1),))
        return {"ok": True}

    @app.get("/api/messages")
    def cl_messages(request: Request, customer_id: str = Query(None)):
        where = "WHERE i.type='message'"
        params = []
        if customer_id:
            where += " AND i.customer_id=%s"
            params.append(customer_id)
        rows = _ex(
            "SELECT i.id, i.customer_id, i.channel, i.notes AS body, i.user_name, "
            "i.created_at, " + _name_sql("i") + " AS customer_name "
            "FROM crm_interactions i " + where +
            " ORDER BY i.created_at DESC LIMIT 200", tuple(params), fetch=True) or []
        return [{
            "id": str(r["id"]),
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "channel": r["channel"],
            "body": r["body"],
            "user_name": r["user_name"],
            "created_at": _dt(r["created_at"]),
        } for r in rows]

    @app.post("/api/messages")
    def cl_message_create(request: Request, payload: dict = Body(default=None)):
        _uid, name, _r = _actor(request)
        payload = payload or {}
        cid = payload.get("customer_id")
        body = (payload.get("body") or "").strip()
        channel = (payload.get("channel") or "whatsapp").strip()
        if not cid or not body:
            raise HTTPException(status_code=400, detail="customer_id and body required")
        # No outbound BSP/SMS gateway is wired in this project — the message is
        # logged as an interaction so it appears on the timeline and dashboards.
        row = _one(
            "INSERT INTO crm_interactions (customer_id, type, channel, notes, outcome, user_name, created_at) "
            "VALUES (%s,'message',%s,%s,'logged',%s,now()) RETURNING id",
            (cid, channel, body, name))
        A._crm_audit("message", cid, "send", channel + ": " + body[:80], request)
        return {"ok": True, "id": str(row["id"]) if row else None, "delivery": "logged"}

    @app.get("/api/users")
    def cl_users(request: Request):
        rows = _ex(
            "SELECT user_id, name, email, role FROM app_users "
            "WHERE status='active' ORDER BY name NULLS LAST, email", fetch=True) or []
        return [{
            "user_id": r["user_id"],
            "name": r["name"] or r["email"],
            "email": r["email"],
            "role": r["role"],
        } for r in rows]

    @app.get("/api/audit")
    def cl_audit(request: Request, limit: int = Query(200)):
        lim = _clamp(limit, 1, 1000, 200)
        rows = _ex(
            "SELECT id, entity, entity_id, action, detail, user_name, created_at "
            "FROM crm_audit ORDER BY created_at DESC LIMIT %s", (lim,), fetch=True) or []
        return [{
            "id": str(r["id"]),
            "entity": r["entity"],
            "entity_id": r["entity_id"],
            "action": r["action"],
            "detail": r["detail"],
            "user_name": r["user_name"],
            "created_at": _dt(r["created_at"]),
        } for r in rows]


# --------------------------------------------------------------------------- #
# Shared analytics helpers (BI / insights / loyalty)                           #
# --------------------------------------------------------------------------- #
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TOK_RE = re.compile(r"^[\w \-&'./]+$")


def _safe_date(v, default):
    v = str(v) if v is not None else ""
    return v if _DATE_RE.match(v) else default


def _today():
    return date.today().isoformat()


def _ago(n):
    return (date.today() - timedelta(days=int(n))).isoformat()


def _bf():
    return A.BASE_FILTERS


def _in_clause(col, csv):
    """Safe `AND col IN (...)` from a comma list; returns '' when empty.
    Tokens are whitelist-validated and single-quote escaped."""
    toks = [t.strip() for t in str(csv or "").split(",") if t.strip()]
    toks = [t for t in toks if _TOK_RE.match(t)]
    if not toks:
        return ""
    vals = ",".join("'" + t.replace("'", "''") + "'" for t in toks)
    return " AND " + col + " IN (" + vals + ")"


def _q(sql):
    """Cached, parameter-free query (literal % in BASE_FILTERS is safe here)."""
    return A.run_query(sql) or []


def _q1(sql):
    rows = _q(sql)
    return rows[0] if rows else {}


# --------------------------------------------------------------------------- #
# STAGE 2 — Manager dashboard + BI summaries                                  #
# --------------------------------------------------------------------------- #
def _reg_bi(app):
    @app.get("/api/dashboard/manager")
    def cl_mgr_dashboard(request: Request):
        _staff(request)
        tot = _one(
            "SELECT "
            " COUNT(*) FILTER (WHERE type='message' AND created_at>=now()-interval '7 days') AS msg_week, "
            " COUNT(DISTINCT customer_id) FILTER (WHERE created_at>=now()-interval '7 days') AS cust_week, "
            " COUNT(*) FILTER (WHERE type='message' AND created_at>=now()-interval '14 days' "
            "   AND created_at<now()-interval '7 days') AS msg_prev "
            "FROM crm_interactions", fetch=True) or {}
        lb_week = _int((tot or {}).get("msg_week"))
        prev = _int((tot or {}).get("msg_prev"))
        delta = 100.0 if prev <= 0 and lb_week > 0 else (
            0.0 if prev <= 0 else round((lb_week - prev) / prev * 100.0, 1))
        open_tasks = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_tasks WHERE status<>'done'",
            fetch=True) or {}).get("n"))
        lb = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_lookbook "
            "WHERE created_at>=now()-interval '7 days'", fetch=True) or {}).get("n"))
        assoc = _ex(
            "SELECT user_id, COALESCE(name,email) AS name, email, role "
            "FROM app_users WHERE status='active' ORDER BY name NULLS LAST",
            fetch=True) or []
        by = _ex(
            "SELECT COALESCE(user_name,'—') AS associate, "
            " COUNT(*) FILTER (WHERE type='message') AS messages, "
            " COUNT(DISTINCT customer_id) AS customers_contacted "
            "FROM crm_interactions WHERE created_at>=now()-interval '30 days' "
            "GROUP BY user_name ORDER BY messages DESC LIMIT 25", fetch=True) or []
        return {
            "totals": {
                "messages_week": lb_week,
                "messages_delta_pct": delta,
                "lookbooks_week": lb,
                "open_tasks": open_tasks,
                "associates": len(assoc),
            },
            "by_associate": [{
                "associate": r["associate"],
                "messages": _int(r["messages"]),
                "customers_contacted": _int(r["customers_contacted"]),
            } for r in by],
            "associates": [{
                "user_id": r["user_id"], "name": r["name"],
                "email": r["email"], "role": r["role"],
            } for r in assoc],
        }

    @app.get("/api/dashboard/attribution")
    def cl_attribution(request: Request, days: int = Query(30)):
        _staff(request)
        d = _clamp(days, 1, 365, 30)
        since = _ago(d)
        # Customers messaged in the window who then transacted after first
        # contact. Joins the interaction log to all_sales by customer_id.
        rows = _ex(
            "WITH msg AS (SELECT customer_id, user_name, MIN(created_at) AS first_msg "
            " FROM crm_interactions WHERE type='message' AND created_at>=%s "
            " AND customer_id IS NOT NULL GROUP BY customer_id, user_name), "
            "conv AS (SELECT m.customer_id, m.user_name, "
            "   EXISTS (SELECT 1 FROM all_sales s WHERE s.customer_id=m.customer_id "
            "     AND s.sale_date >= to_char(m.first_msg,'YYYY-MM-DD')) AS bought "
            " FROM msg m) "
            "SELECT user_name, COUNT(*) AS messaged, "
            " COUNT(*) FILTER (WHERE bought) AS purchased FROM conv "
            "GROUP BY user_name", (since,), fetch=True) or []
        messaged = sum(_int(r["messaged"]) for r in rows)
        purchased = sum(_int(r["purchased"]) for r in rows)
        # Rough revenue: net sales attributable to those buyers in window.
        rev = _num((_one(
            "SELECT COALESCE(SUM(s.net_sales_kes),0) AS v FROM all_sales s "
            "WHERE s.sale_date>=%s AND s.customer_id IN ("
            "  SELECT DISTINCT customer_id FROM crm_interactions "
            "  WHERE type='message' AND created_at>=%s AND customer_id IS NOT NULL) ",
            (since, since), fetch=True) or {}).get("v"))
        return {
            "messaged_customers": messaged,
            "purchased_within_window": purchased,
            "estimated_revenue_kes": round(rev, 2),
            "conversion_rate": round(purchased / messaged * 100.0, 1) if messaged else 0.0,
            "by_associate": [{
                "associate": r["user_name"] or "—",
                "messages": _int(r["messaged"]),
                "customers_contacted": _int(r["messaged"]),
                "customers_purchased": _int(r["purchased"]),
                "conversion_rate": round(
                    _int(r["purchased"]) / _int(r["messaged"]) * 100.0, 1)
                if _int(r["messaged"]) else 0.0,
            } for r in rows],
        }

    def _sales_where(date_from, date_to, country=None, channel=None):
        f = _safe_date(date_from, _ago(90))
        t = _safe_date(date_to, _today())
        w = ("s.sale_date BETWEEN '" + f + "' AND '" + t + "' AND " + _bf() +
             _in_clause("s.country", country) +
             _in_clause("s.pos_location_name", channel))
        return w

    @app.get("/api/bi/kpis")
    def cl_bi_kpis(request: Request, date_from: str = Query(None),
                   date_to: str = Query(None), country: str = Query(None),
                   channel: str = Query(None)):
        _staff(request)
        w = _sales_where(date_from, date_to, country, channel)
        r = _q1(
            "SELECT COALESCE(SUM(s.total_sales_kes),0) AS sales, "
            " COUNT(DISTINCT s.order_id) AS orders, "
            " COALESCE(SUM(s.returns_kes),0) AS returns, "
            " COALESCE(SUM(s.gross_sales_kes),0) AS gross, "
            " COUNT(DISTINCT s.customer_id) AS customers "
            "FROM all_sales s WHERE " + w)
        f = _safe_date(date_from, _ago(90))
        nc = _int((_q1(
            "SELECT COUNT(*) AS n FROM (SELECT s.customer_id FROM all_sales s "
            "WHERE " + w + " AND s.customer_id IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM all_sales s2 WHERE s2.customer_id=s.customer_id "
            " AND s2.sale_date < '" + f + "') GROUP BY s.customer_id) q")).get("n"))
        sales, orders = _num(r.get("sales")), _int(r.get("orders"))
        gross, returns = _num(r.get("gross")), _num(r.get("returns"))
        return {
            "total_sales": round(sales, 2),
            "total_orders": orders,
            "avg_basket": round(sales / orders, 2) if orders else 0.0,
            "new_customers": nc,
            "return_rate": round(abs(returns) / gross * 100.0, 1) if gross else 0.0,
        }

    @app.get("/api/bi/sales-summary")
    def cl_bi_sales_summary(request: Request, date_from: str = Query(None),
                            date_to: str = Query(None)):
        _staff(request)
        w = _sales_where(date_from, date_to)
        r = _q1(
            "SELECT COALESCE(SUM(s.total_sales_kes),0) AS sales, "
            " COALESCE(SUM(s.net_sales_kes),0) AS net, "
            " COUNT(DISTINCT s.order_id) AS orders, "
            " COALESCE(SUM(s.ordered_item_quantity),0) AS units "
            "FROM all_sales s WHERE " + w)
        return {
            "sales": round(_num(r.get("sales")), 2),
            "net_sales": round(_num(r.get("net")), 2),
            "orders": _int(r.get("orders")),
            "units": _int(r.get("units")),
        }

    @app.get("/api/bi/country-summary")
    def cl_bi_country_summary(request: Request, date_from: str = Query(None),
                              date_to: str = Query(None)):
        _staff(request)
        w = _sales_where(date_from, date_to)
        rows = _q(
            "SELECT COALESCE(NULLIF(s.country,''),'Unknown') AS country, "
            " COALESCE(SUM(s.total_sales_kes),0) AS sales, "
            " COUNT(DISTINCT s.order_id) AS orders "
            "FROM all_sales s WHERE " + w +
            " GROUP BY 1 ORDER BY sales DESC")
        return [{
            "country": r["country"], "sales": round(_num(r["sales"]), 2),
            "orders": _int(r["orders"]),
        } for r in rows]

    @app.get("/api/bi/daily-trend")
    def cl_bi_daily_trend(request: Request, date_from: str = Query(None),
                          date_to: str = Query(None)):
        _staff(request)
        w = _sales_where(date_from, date_to)
        rows = _q(
            "SELECT s.sale_date AS date, "
            " COALESCE(SUM(s.total_sales_kes),0) AS sales, "
            " COUNT(DISTINCT s.order_id) AS orders "
            "FROM all_sales s WHERE " + w +
            " GROUP BY s.sale_date ORDER BY s.sale_date")
        return [{
            "date": r["date"], "sales": round(_num(r["sales"]), 2),
            "orders": _int(r["orders"]),
        } for r in rows]

    @app.get("/api/bi/top-customers")
    def cl_bi_top_customers(request: Request, date_from: str = Query(None),
                            date_to: str = Query(None), limit: int = Query(20)):
        _staff(request)
        w = _sales_where(date_from, date_to)
        lim = _clamp(limit, 1, 200, 20)
        rows = _q(
            "WITH agg AS (SELECT s.customer_id, "
            " SUM(s.total_sales_kes) AS sales, COUNT(DISTINCT s.order_id) AS orders, "
            " MAX(s.sale_date) AS last_sale "
            " FROM all_sales s WHERE " + w + " AND s.customer_id IS NOT NULL "
            " GROUP BY s.customer_id ORDER BY sales DESC LIMIT " + str(lim) + ") "
            "SELECT a.customer_id, a.sales, a.orders, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(ac.first_name,'')||' '||"
            "   COALESCE(ac.last_name,'')),'') FROM all_customers ac "
            "   WHERE ac.customer_id=a.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM agg a")
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "total_sales": round(_num(r["sales"]), 2),
            "total_orders": _int(r["orders"]),
            "rfm_tier": _tier_label(_num(r["sales"])),
        } for r in rows]

    @app.get("/api/bi/top-skus")
    def cl_bi_top_skus(request: Request, date_from: str = Query(None),
                       date_to: str = Query(None), limit: int = Query(20)):
        _staff(request)
        w = _sales_where(date_from, date_to)
        lim = _clamp(limit, 1, 200, 20)
        rows = _q(
            "SELECT COALESCE(NULLIF(s.variant_sku,''),'—') AS sku, "
            " MAX(s.product_title) AS product_title, "
            " COALESCE(SUM(s.ordered_item_quantity),0) AS units, "
            " COALESCE(SUM(s.total_sales_kes),0) AS revenue "
            "FROM all_sales s WHERE " + w + " AND COALESCE(s.variant_sku,'')<>'' "
            "GROUP BY 1 ORDER BY revenue DESC LIMIT " + str(lim))
        return [{
            "sku": r["sku"], "product_title": r["product_title"] or r["sku"],
            "units": _int(r["units"]), "revenue": round(_num(r["revenue"]), 2),
            "image_url": None,
        } for r in rows]

    @app.get("/api/bi/churned-customers")
    def cl_bi_churned(request: Request, days: int = Query(180),
                      limit: int = Query(50)):
        _staff(request)
        d = _clamp(days, 30, 1095, 180)
        lim = _clamp(limit, 1, 500, 50)
        rows = _q(
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " SUM(total_orders) AS orders, SUM(total_spend_kes::numeric) AS spend, "
            " MAX(last_order_date) AS last_order_date FROM all_customers "
            " GROUP BY customer_id) "
            "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, "
            " COALESCE(orders,0) AS orders, COALESCE(spend,0) AS spend, last_order_date "
            "FROM c WHERE last_order_date " + _ISO +
            " AND (CURRENT_DATE - last_order_date::date) > " + str(d) +
            " AND COALESCE(orders,0) >= 2 ORDER BY spend DESC LIMIT " + str(lim))
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "total_sales": round(_num(r["spend"]), 2),
            "total_orders": _int(r["orders"]),
            "last_purchase_date": r["last_order_date"],
            "rfm_tier": "At Risk",
        } for r in rows]

    @app.get("/api/bi/return-rate-trend")
    def cl_bi_return_trend(request: Request):
        _staff(request)
        out = []
        for label, n in (("7d", 7), ("30d", 30), ("90d", 90)):
            r = _q1(
                "SELECT COALESCE(SUM(s.returns_kes),0) AS ret, "
                " COALESCE(SUM(s.gross_sales_kes),0) AS gross, "
                " COUNT(DISTINCT s.order_id) AS orders, "
                " COUNT(DISTINCT s.order_id) FILTER (WHERE s.returns_kes < 0) AS rorders "
                "FROM all_sales s WHERE s.sale_date >= '" + _ago(n) +
                "' AND " + _bf())
            gross = _num(r.get("gross"))
            out.append({
                "window": label,
                "return_rate_pct": round(abs(_num(r.get("ret"))) / gross * 100.0, 1)
                if gross else 0.0,
                "returns": _int(r.get("rorders")),
                "orders": _int(r.get("orders")),
            })
        return {"windows": out}

    @app.get("/api/bi/channel-attribution")
    def cl_bi_channel_attr(request: Request, days: int = Query(90)):
        _staff(request)
        d = _clamp(days, 1, 730, 90)
        rows = _q(
            "SELECT COALESCE(NULLIF(s.pos_location_name,''),'Unknown') AS channel, "
            " COUNT(DISTINCT s.customer_id) AS customers, "
            " COALESCE(SUM(s.net_sales_kes),0) AS revenue "
            "FROM all_sales s WHERE s.sale_date >= '" + _ago(d) + "' AND " + _bf() +
            " GROUP BY 1 ORDER BY revenue DESC LIMIT 30")
        return {"rows": [{
            "channel": r["channel"], "customers": _int(r["customers"]),
            "revenue_kes": round(_num(r["revenue"]), 2),
        } for r in rows]}

    @app.get("/api/bi/customer-search")
    def cl_bi_customer_search(request: Request, q: str = Query(""),
                              limit: int = Query(20)):
        _staff(request)
        term = (q or "").strip()
        lim = _clamp(limit, 1, 100, 20)
        if not term:
            return []
        like = "%" + term + "%"
        rows = _ex(
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " MAX(phone) AS phone, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, phone, "
            " COALESCE(spend,0) AS spend FROM c "
            "WHERE nm ILIKE %s OR phone ILIKE %s OR customer_id ILIKE %s "
            "ORDER BY spend DESC NULLS LAST LIMIT %s",
            (like, like, like, lim), fetch=True) or []
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "phone": r["phone"], "rfm_tier": _tier_label(_num(r["spend"])),
        } for r in rows]


def _tier_label(spend):
    s = _num(spend)
    if s >= 100000:
        return "Gold"
    if s >= 50000:
        return "Silver"
    return "Bronze"


# --------------------------------------------------------------------------- #
# STAGE 2 — Insights (overview, briefs, cohorts, wishlists, LTV, etc.)        #
# --------------------------------------------------------------------------- #
def _reg_insights(app):
    @app.get("/api/insights/overview")
    def cl_ins_overview(request: Request):
        _staff(request)
        r = _q1(
            "WITH c AS (SELECT customer_id, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT "
            " COUNT(*) FILTER (WHERE lod " + _ISO +
            "   AND (CURRENT_DATE - lod::date) <= 365) AS active, "
            " COUNT(*) FILTER (WHERE COALESCE(spend,0) >= 100000) AS vip, "
            " COUNT(*) FILTER (WHERE lod " + _ISO +
            "   AND (CURRENT_DATE - lod::date) BETWEEN 180 AND 540 "
            "   AND COALESCE(orders,0) >= 2) AS at_risk, "
            " COALESCE(AVG(NULLIF(spend,0)),0) AS avg_ltv FROM c")
        return {
            "active_customers": _int(r.get("active")),
            "vip_count": _int(r.get("vip")),
            "at_risk_count": _int(r.get("at_risk")),
            "avg_ltv": round(_num(r.get("avg_ltv")), 2),
        }

    @app.get("/api/insights/daily-brief")
    def cl_ins_daily_brief(request: Request):
        _staff(request)
        hp = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_tasks WHERE status<>'done' "
            "AND priority IN ('high','urgent')", fetch=True) or {}).get("n"))
        bd = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_moment WHERE moment_date IS NOT NULL "
            "AND EXTRACT(MONTH FROM moment_date)=EXTRACT(MONTH FROM CURRENT_DATE) "
            "AND EXTRACT(DAY FROM moment_date) BETWEEN EXTRACT(DAY FROM CURRENT_DATE) "
            "AND EXTRACT(DAY FROM CURRENT_DATE)+7", fetch=True) or {}).get("n"))
        nv = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_loyalty_enrolment "
            "WHERE tier='Gold' AND tier_updated_at::date = CURRENT_DATE",
            fetch=True) or {}).get("n"))
        return {"high_priority_tasks": hp, "upcoming_birthdays": bd,
                "new_vips_today": nv}

    @app.get("/api/insights/leaderboard")
    def cl_ins_leaderboard(request: Request, days: int = Query(30)):
        _staff(request)
        d = _clamp(days, 1, 365, 30)
        rows = _ex(
            "SELECT COALESCE(user_name,'—') AS associate, "
            " COUNT(*) AS interactions, "
            " COUNT(*) FILTER (WHERE type='message') AS messages, "
            " COUNT(DISTINCT customer_id) AS customers "
            "FROM crm_interactions WHERE created_at>=now()-(%s||' days')::interval "
            "GROUP BY user_name ORDER BY interactions DESC LIMIT 25",
            (d,), fetch=True) or []
        return [{
            "associate": r["associate"], "interactions": _int(r["interactions"]),
            "messages": _int(r["messages"]), "customers": _int(r["customers"]),
        } for r in rows]

    @app.get("/api/insights/new-customers")
    def cl_ins_new_customers(request: Request, days: int = Query(30),
                             limit: int = Query(50)):
        _staff(request)
        d = _clamp(days, 1, 365, 30)
        lim = _clamp(limit, 1, 300, 50)
        rows = _q(
            "WITH firsts AS (SELECT s.customer_id, MIN(s.sale_date) AS first_sale, "
            "  SUM(s.total_sales_kes) AS spend "
            "  FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY s.customer_id) "
            "SELECT f.customer_id, f.first_sale, COALESCE(f.spend,0) AS spend, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(ac.first_name,'')||' '||"
            "   COALESCE(ac.last_name,'')),'') FROM all_customers ac "
            "   WHERE ac.customer_id=f.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM firsts f WHERE f.first_sale >= '" + _ago(d) + "' "
            "ORDER BY f.first_sale DESC LIMIT " + str(lim))
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "first_purchase_date": r["first_sale"],
            "total_sales": round(_num(r["spend"]), 2),
        } for r in rows]

    @app.get("/api/insights/purchase-frequency")
    def cl_ins_freq(request: Request):
        _staff(request)
        rows = _q(
            "WITH c AS (SELECT customer_id, COUNT(DISTINCT order_id) AS orders, "
            "  (MAX(sale_date::date) - MIN(sale_date::date)) AS span "
            "  FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY customer_id HAVING COUNT(DISTINCT order_id) >= 2) "
            "SELECT width_bucket(GREATEST(span/NULLIF(orders-1,0),0),0,365,12) AS b, "
            " COUNT(*) AS n FROM c GROUP BY b ORDER BY b")
        dist = []
        for r in rows:
            b = _int(r["b"])
            lo = (b - 1) * 30 if b >= 1 else 0
            dist.append({"days": lo, "count": _int(r["n"])})
        return {"distribution": dist}

    @app.get("/api/insights/upcoming-events")
    def cl_ins_events(request: Request, days: int = Query(30)):
        _staff(request)
        d = _clamp(days, 1, 365, 30)
        rows = _ex(
            "SELECT m.id, m.customer_id, m.moment_type, m.label, m.moment_date, "
            " m.recurring_annual, " + _name_sql("m") + " AS customer_name "
            "FROM crm_moment m WHERE m.moment_date IS NOT NULL AND ("
            " (m.moment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+%s) OR "
            " (m.recurring_annual AND to_char(m.moment_date,'MM-DD') BETWEEN "
            "   to_char(CURRENT_DATE,'MM-DD') AND to_char(CURRENT_DATE+%s,'MM-DD'))) "
            "ORDER BY m.moment_date LIMIT 100", (d, d), fetch=True) or []
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "type": r["moment_type"] or "event", "title": r["label"],
            "date": _dt(r["moment_date"]), "recurring_annual": bool(r["recurring_annual"]),
        } for r in rows]

    @app.get("/api/insights/reorder-candidates")
    def cl_ins_reorder(request: Request, window_days: int = Query(30),
                       limit: int = Query(50)):
        _staff(request)
        lim = _clamp(limit, 1, 300, 50)
        rows = _q(
            "WITH c AS (SELECT s.customer_id, COUNT(DISTINCT s.order_id) AS orders, "
            "  MAX(s.sale_date) AS last_sale, "
            "  (MAX(s.sale_date::date)-MIN(s.sale_date::date))/NULLIF(COUNT(DISTINCT s.order_id)-1,0) AS cadence "
            "  FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY s.customer_id "
            "  HAVING COUNT(DISTINCT s.order_id) >= 3) "
            "SELECT c.customer_id, c.last_sale, c.cadence, "
            " (c.last_sale::date + (COALESCE(c.cadence,30)||' days')::interval)::date AS predicted, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(ac.first_name,'')||' '||"
            "   COALESCE(ac.last_name,'')),'') FROM all_customers ac "
            "   WHERE ac.customer_id=c.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM c WHERE (c.last_sale::date + (COALESCE(c.cadence,30)||' days')::interval)::date "
            "  BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE + " + str(_clamp(window_days, 1, 120, 30)) +
            " ORDER BY predicted ASC LIMIT " + str(lim))
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "last_purchase_date": r["last_sale"],
            "cadence_days": _int(r["cadence"]),
            "predicted_reorder_date": _dt(r["predicted"]),
        } for r in rows]

    @app.get("/api/insights/ltv/top")
    def cl_ins_ltv_top(request: Request, limit: int = Query(20)):
        _staff(request)
        lim = _clamp(limit, 1, 200, 20)
        rows = _q(
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " SUM(total_orders) AS orders, SUM(total_spend_kes::numeric) AS spend "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, "
            " COALESCE(orders,0) AS orders, COALESCE(spend,0) AS spend "
            "FROM c ORDER BY spend DESC NULLS LAST LIMIT " + str(lim))
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "ltv": round(_num(r["spend"]), 2), "total_orders": _int(r["orders"]),
            "rfm_tier": _tier_label(_num(r["spend"])),
        } for r in rows]

    @app.get("/api/insights/lookalikes/{cid}")
    def cl_ins_lookalikes(request: Request, cid: str, limit: int = Query(15)):
        _staff(request)
        lim = _clamp(limit, 1, 100, 15)
        anchor = _one(
            "SELECT MAX(city) AS city, SUM(total_spend_kes::numeric) AS spend "
            "FROM all_customers WHERE customer_id=%s", (cid,)) or {}
        spend = _num(anchor.get("spend"))
        lo, hi = spend * 0.5, spend * 1.5 if spend else 0
        rows = _ex(
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " MAX(city) AS city, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend FROM all_customers "
            " GROUP BY customer_id) "
            "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, city, "
            " COALESCE(spend,0) AS spend, COALESCE(orders,0) AS orders FROM c "
            "WHERE customer_id<>%s AND spend BETWEEN %s AND %s "
            "ORDER BY ABS(spend-%s) ASC LIMIT %s",
            (cid, lo, hi if hi else 1e12, spend, lim), fetch=True) or []
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "city": r["city"], "ltv": round(_num(r["spend"]), 2),
            "total_orders": _int(r["orders"]),
            "rfm_tier": _tier_label(_num(r["spend"])),
        } for r in rows]

    @app.get("/api/insights/dropoff-forecast")
    def cl_ins_dropoff(request: Request, days: int = Query(30)):
        _staff(request)
        rows = _q(
            "WITH c AS (SELECT customer_id, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT CASE "
            "  WHEN (CURRENT_DATE-lod::date) BETWEEN 90 AND 180 THEN 'cooling' "
            "  WHEN (CURRENT_DATE-lod::date) BETWEEN 181 AND 365 THEN 'at_risk' "
            "  WHEN (CURRENT_DATE-lod::date) > 365 THEN 'lapsed' END AS band, "
            " COUNT(*) AS n, COALESCE(SUM(spend),0) AS spend "
            "FROM c WHERE lod " + _ISO + " AND COALESCE(orders,0) >= 2 "
            "GROUP BY band HAVING CASE "
            "  WHEN (0=0) THEN true END")
        bands = {b["band"]: b for b in rows if b.get("band")}
        out = []
        for key in ("cooling", "at_risk", "lapsed"):
            b = bands.get(key) or {}
            out.append({"band": key, "customers": _int(b.get("n")),
                        "value_at_risk_kes": round(_num(b.get("spend")), 2)})
        return {"bands": out}

    # ---- Cohorts -------------------------------------------------------- #
    def _cohort_triangle():
        return _q(
            "WITH firsts AS (SELECT s.customer_id, "
            "  to_char(MIN(s.sale_date)::date,'YYYY-MM') AS cohort "
            "  FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY s.customer_id), "
            "acts AS (SELECT DISTINCT s.customer_id, "
            "  to_char(s.sale_date::date,'YYYY-MM') AS m FROM all_sales s "
            "  WHERE s.sale_date " + _ISO +
            "  AND s.sale_date >= '" + _ago(560) + "' AND " + _bf() +
            "  AND s.customer_id IS NOT NULL) "
            "SELECT f.cohort, a.m, COUNT(DISTINCT a.customer_id) AS n "
            "FROM firsts f JOIN acts a USING (customer_id) "
            "WHERE f.cohort >= to_char((CURRENT_DATE - interval '18 months'),'YYYY-MM') "
            "GROUP BY f.cohort, a.m ORDER BY f.cohort, a.m")

    @app.get("/api/insights/cohorts/triangle")
    def cl_cohorts_triangle(request: Request):
        _staff(request)
        rows = _cohort_triangle()
        cohorts = {}
        sizes = {}
        for r in rows:
            c, m, n = r["cohort"], r["m"], _int(r["n"])
            if m < c:
                continue
            off = (int(m[:4]) - int(c[:4])) * 12 + (int(m[5:7]) - int(c[5:7]))
            cohorts.setdefault(c, {})[off] = n
            if off == 0:
                sizes[c] = n
        out = []
        for c in sorted(cohorts):
            size = sizes.get(c, 0) or 0
            cells = []
            for off in sorted(cohorts[c]):
                n = cohorts[c][off]
                cells.append({"month_offset": off, "customers": n,
                              "retention_pct": round(n / size * 100.0, 1) if size else 0.0})
            out.append({"cohort": c, "size": size, "cells": cells})
        return {"cohorts": out}

    @app.get("/api/insights/cohorts/retention")
    def cl_cohorts_retention(request: Request):
        _staff(request)
        tri = cl_cohorts_triangle(request)["cohorts"]
        curve = {}
        for c in tri:
            for cell in c["cells"]:
                o = cell["month_offset"]
                curve.setdefault(o, []).append(cell["retention_pct"])
        return {"curve": [{
            "month_offset": o,
            "avg_retention_pct": round(sum(v) / len(v), 1) if v else 0.0,
        } for o, v in sorted(curve.items())]}

    @app.get("/api/insights/cohorts/by-channel")
    def cl_cohorts_by_channel(request: Request):
        _staff(request)
        rows = _q(
            "WITH firsts AS (SELECT s.customer_id, "
            "  to_char(MIN(s.sale_date)::date,'YYYY-MM') AS cohort, "
            "  (array_agg(s.pos_location_name ORDER BY s.sale_date))[1] AS channel "
            "  FROM all_sales s WHERE s.sale_date >= '" + _ago(560) + "' AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY s.customer_id) "
            "SELECT COALESCE(NULLIF(channel,''),'Unknown') AS channel, "
            " COUNT(*) AS customers FROM firsts GROUP BY 1 ORDER BY customers DESC LIMIT 30")
        return {"rows": [{"channel": r["channel"], "customers": _int(r["customers"])}
                         for r in rows]}

    @app.get("/api/insights/cohorts/tier-flow")
    def cl_cohorts_tier_flow(request: Request):
        _staff(request)
        rows = _q(
            "SELECT tier, COUNT(*) AS n FROM crm_loyalty_enrolment GROUP BY tier")
        return {"tiers": [{"tier": r["tier"], "members": _int(r["n"])} for r in rows]}

    @app.get("/api/insights/cohorts/customers")
    def cl_cohorts_customers(request: Request, cohort_month: str = Query(None),
                             limit: int = Query(100)):
        _staff(request)
        cm = cohort_month if cohort_month and re.match(r"^\d{4}-\d{2}$", cohort_month) else None
        if not cm:
            return {"customers": []}
        lim = _clamp(limit, 1, 500, 100)
        rows = _q(
            "WITH firsts AS (SELECT s.customer_id, "
            "  to_char(MIN(s.sale_date)::date,'YYYY-MM') AS cohort, "
            "  SUM(s.total_sales_kes) AS spend, COUNT(DISTINCT s.order_id) AS orders "
            "  FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
            "  AND s.customer_id IS NOT NULL GROUP BY s.customer_id) "
            "SELECT f.customer_id, COALESCE(f.spend,0) AS spend, COALESCE(f.orders,0) AS orders, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(ac.first_name,'')||' '||"
            "   COALESCE(ac.last_name,'')),'') FROM all_customers ac "
            "   WHERE ac.customer_id=f.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM firsts f WHERE f.cohort = '" + cm + "' "
            "ORDER BY spend DESC LIMIT " + str(lim))
        return {"customers": [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "total_sales": round(_num(r["spend"]), 2), "total_orders": _int(r["orders"]),
            "rfm_tier": _tier_label(_num(r["spend"])),
        } for r in rows]}

    @app.post("/api/insights/cohorts/bulk-task")
    def cl_cohorts_bulk_task(request: Request, payload: dict = Body(default=None)):
        u = _staff(request)
        p = payload or {}
        ids = [str(x) for x in (p.get("customer_ids") or []) if x][:500]
        title = (p.get("title") or "Cohort follow-up").strip()[:200]
        notes = (p.get("notes") or "").strip()
        if not ids:
            raise HTTPException(status_code=400, detail="customer_ids required")
        uid, name = u.get("user_id"), (u.get("name") or u.get("email"))
        created = 0
        for cid in ids:
            _ex(
                "INSERT INTO crm_tasks (customer_id,title,description,status,priority,"
                " assignee_user_id,assignee_name,created_by,created_by_name) "
                "VALUES (%s,%s,%s,'open','normal',%s,%s,%s,%s)",
                (cid, title, notes, uid, name, uid, name))
            created += 1
        A._crm_audit("task", "bulk", "create", title + " ×" + str(created), request)
        return {"created": created}

    # ---- Wishlists ------------------------------------------------------ #
    @app.get("/api/insights/wishlists")
    def cl_wishlists(request: Request, limit: int = Query(100)):
        _staff(request)
        lim = _clamp(limit, 1, 500, 100)
        rows = _ex(
            "SELECT w.id, w.customer_id, w.product_title, w.note, w.fulfilled, "
            " w.created_at, " + _name_sql("w") + " AS customer_name "
            "FROM crm_wishlist w WHERE NOT w.fulfilled "
            "ORDER BY w.created_at DESC LIMIT %s", (lim,), fetch=True) or []
        return [{
            "id": str(r["id"]), "customer_id": r["customer_id"],
            "customer_name": r["customer_name"], "product_name": r["product_title"],
            "note": r["note"], "added_at": _dt(r["created_at"]),
        } for r in rows]

    @app.get("/api/insights/wishlists/{cid}")
    def cl_wishlist_for(request: Request, cid: str):
        _staff(request)
        rows = _ex(
            "SELECT id, product_title, note, fulfilled, created_at "
            "FROM crm_wishlist WHERE customer_id=%s ORDER BY created_at DESC",
            (cid,), fetch=True) or []
        return [{
            "id": str(r["id"]), "wishlist_id": str(r["id"]), "sku": None,
            "product_name": r["product_title"], "note": r["note"],
            "fulfilled": bool(r["fulfilled"]), "added_at": _dt(r["created_at"]),
        } for r in rows]

    @app.post("/api/insights/wishlists")
    def cl_wishlist_add(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        _uid, name, _r = _actor(request)
        p = payload or {}
        cid = (p.get("customer_id") or "").strip()
        product = (p.get("product_title") or p.get("product_name") or "").strip()
        if not cid or not product:
            raise HTTPException(status_code=400,
                                detail="customer_id and product_title required")
        note = (p.get("note") or "").strip() or None
        row = _one(
            "INSERT INTO crm_wishlist (customer_id, product_title, note, created_by) "
            "VALUES (%s,%s,%s,%s) RETURNING id, product_title, note, fulfilled, created_at",
            (cid, product, note, name))
        A._crm_audit("customer", cid, "wishlist.add", product, request)
        return {
            "id": str(row["id"]), "wishlist_id": str(row["id"]),
            "customer_id": cid, "sku": None, "product_name": row["product_title"],
            "note": row["note"], "fulfilled": bool(row["fulfilled"]),
            "added_at": _dt(row["created_at"]),
        }

    @app.delete("/api/insights/wishlists/{wishlist_id}")
    def cl_wishlist_delete(request: Request, wishlist_id: str):
        _staff(request)
        wid = _int(wishlist_id)
        if not wid:
            raise HTTPException(status_code=404, detail="Wishlist item not found")
        row = _one("SELECT customer_id FROM crm_wishlist WHERE id=%s", (wid,))
        if not row:
            return {"deleted": 0}
        _ex("DELETE FROM crm_wishlist WHERE id=%s", (wid,))
        A._crm_audit("customer", row["customer_id"], "wishlist.remove",
                     "wishlist #" + str(wid), request)
        return {"deleted": 1}

    @app.post("/api/insights/wishlists/{wishlist_id}/fulfill")
    def cl_wishlist_fulfill(request: Request, wishlist_id: str):
        # The frontend marks a single wishlist row fulfilled by its id (no body).
        _staff(request)
        wid = _int(wishlist_id)
        if not wid:
            raise HTTPException(status_code=404, detail="Wishlist item not found")
        row = _one("SELECT customer_id FROM crm_wishlist WHERE id=%s", (wid,))
        if not row:
            raise HTTPException(status_code=404, detail="Wishlist item not found")
        _ex("UPDATE crm_wishlist SET fulfilled=true WHERE id=%s", (wid,))
        A._crm_audit("customer", row["customer_id"], "wishlist.fulfill",
                     "wishlist #" + str(wid), request)
        return {"status": "fulfilled"}


# --------------------------------------------------------------------------- #
# STAGE 2 — Loyalty (manager-facing, under /api/loyalty/* → _staff)           #
# --------------------------------------------------------------------------- #
def _reg_loyalty_mgr(app):
    @app.get("/api/loyalty/pulse")
    def cl_loy_pulse(request: Request):
        _staff(request)
        m = _one(
            "SELECT COUNT(*) AS members, "
            " COALESCE(SUM(points_balance),0) AS points "
            "FROM crm_loyalty_enrolment") or {}
        v = _one(
            "SELECT COUNT(*) FILTER (WHERE issued_at>=now()-interval '30 days') AS issued, "
            " COALESCE(SUM(kes_value) FILTER (WHERE code_status='used' "
            "   AND used_at>=now()-interval '30 days'),0) AS redeemed_kes "
            "FROM crm_redemptions") or {}
        return {
            "active_members": _int(m.get("members")),
            "points_outstanding": _int(m.get("points")),
            "vouchers_issued_30d": _int(v.get("issued")),
            "revenue_from_vouchers": round(_num(v.get("redeemed_kes")), 2),
        }

    @app.get("/api/loyalty/distribution")
    def cl_loy_distribution(request: Request):
        _staff(request)
        rows = _ex(
            "SELECT tier, COUNT(*) AS n FROM crm_loyalty_enrolment GROUP BY tier",
            fetch=True) or []
        out = {"bronze": 0, "silver": 0, "gold": 0}
        for r in rows:
            key = str(r["tier"] or "").lower()
            if key in out:
                out[key] = _int(r["n"])
        out["tiers"] = [{"tier": k.title(), "members": v}
                        for k, v in (("bronze", out["bronze"]),
                                     ("silver", out["silver"]), ("gold", out["gold"]))]
        return out

    @app.get("/api/loyalty/config")
    def cl_loy_config_get(request: Request):
        _staff(request)
        cfg = A._crm_config_dict()
        return {
            "earn_rate_kes": _num(cfg.get("loyalty.earn_rate_kes"), 100),
            "point_value_kes": _num(cfg.get("loyalty.point_value_kes"), 1),
            "points_expiry_months": _int(cfg.get("loyalty.points_expiry_months"), 12),
            "tiers": {
                "silver": {"min_spend": _int(cfg.get("loyalty.tier_silver_kes"), 50000)},
                "gold": {"min_spend": _int(cfg.get("loyalty.tier_gold_kes"), 100000)},
            },
            "earn_multipliers": {
                "bronze": _num(cfg.get("loyalty.earn_multiplier_bronze"), 1),
                "silver": _num(cfg.get("loyalty.earn_multiplier_silver"), 2),
                "gold": _num(cfg.get("loyalty.earn_multiplier_gold"), 3),
            },
        }

    @app.put("/api/loyalty/config")
    def cl_loy_config_put(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("admin",))
        p = payload or {}
        mapping = {
            "earn_rate_kes": "loyalty.earn_rate_kes",
            "point_value_kes": "loyalty.point_value_kes",
            "points_expiry_months": "loyalty.points_expiry_months",
        }
        for k, ck in mapping.items():
            if k in p:
                _ex(
                    "INSERT INTO crm_config (key,value) VALUES (%s,%s) "
                    "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
                    (ck, str(p[k])))
        A._crm_audit("loyalty", "config", "update", "loyalty config updated", request)
        return cl_loy_config_get(request)

    @app.post("/api/loyalty/recompute")
    def cl_loy_recompute(request: Request):
        _staff(request, roles=("admin",))
        # Re-derive each member's tier from their trailing spend snapshot.
        cfg = A._crm_config_dict()
        rows = _ex(
            "SELECT e.customer_id, COALESCE(m.spend_kes,0) AS spend "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id",
            fetch=True) or []
        updated = 0
        for r in rows:
            tier = A._crm_tier_for_spend(_num(r["spend"]), cfg)
            _ex("UPDATE crm_loyalty_enrolment SET tier=%s, tier_updated_at=now() "
                "WHERE customer_id=%s AND tier<>%s", (tier, r["customer_id"], tier))
            updated += 1
        return {"recomputed": updated}

    @app.get("/api/loyalty/anniversary-queue")
    def cl_loy_anniv(request: Request, limit: int = Query(50)):
        _staff(request)
        lim = _clamp(limit, 1, 300, 50)
        rows = _ex(
            "SELECT e.customer_id, e.enrolment_date, e.tier, "
            + _name_sql("e") + " AS customer_name "
            "FROM crm_loyalty_enrolment e "
            "WHERE to_char(e.enrolment_date,'MM-DD') BETWEEN "
            " to_char(CURRENT_DATE,'MM-DD') AND to_char(CURRENT_DATE+30,'MM-DD') "
            "ORDER BY to_char(e.enrolment_date,'MM-DD') LIMIT %s", (lim,), fetch=True) or []
        return [{
            "customer_id": r["customer_id"], "customer_name": r["customer_name"],
            "tier": r["tier"], "enrolment_date": _dt(r["enrolment_date"]),
            "days_to_anniversary": None,
        } for r in rows]

    @app.get("/api/loyalty/approaching-upgrade")
    def cl_loy_approaching(request: Request, limit: int = Query(50)):
        _staff(request)
        lim = _clamp(limit, 1, 300, 50)
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 100000)
        rows = _ex(
            "SELECT e.customer_id, e.tier, COALESCE(m.spend_kes,0) AS spend, "
            + _name_sql("e") + " AS customer_name "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE (e.tier='Bronze' AND COALESCE(m.spend_kes,0) BETWEEN %s AND %s) "
            "   OR (e.tier='Silver' AND COALESCE(m.spend_kes,0) BETWEEN %s AND %s) "
            "ORDER BY spend DESC LIMIT %s",
            (silver * 0.7, silver, gold * 0.7, gold, lim), fetch=True) or []
        out = []
        for r in rows:
            spend = _num(r["spend"])
            target = silver if r["tier"] == "Bronze" else gold
            nxt = "Silver" if r["tier"] == "Bronze" else "Gold"
            out.append({
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "tier": r["tier"], "next_tier": nxt,
                "spend_needed": round(max(target - spend, 0), 2),
            })
        return out

    @app.get("/api/loyalty/audit")
    def cl_loy_audit(request: Request, limit: int = Query(100)):
        _staff(request)
        lim = _clamp(limit, 1, 500, 100)
        rows = _ex(
            "SELECT id, entity, entity_id, action, detail, user_name, created_at "
            "FROM crm_audit WHERE entity IN ('loyalty','redemption') "
            "ORDER BY created_at DESC LIMIT %s", (lim,), fetch=True) or []
        return [{
            "id": str(r["id"]), "action": r["action"], "detail": r["detail"],
            "entity_id": r["entity_id"], "user_name": r["user_name"],
            "created_at": _dt(r["created_at"]),
        } for r in rows]

    @app.get("/api/loyalty/vouchers")
    def cl_loy_vouchers(request: Request, limit: int = Query(100),
                        offset: int = Query(0)):
        _staff(request)
        lim = _clamp(limit, 1, 500, 100)
        off = _clamp(offset, 0, 100000, 0)
        rows = _ex(
            "SELECT r.id, r.customer_id, r.discount_code, r.kes_value, r.points_redeemed, "
            " r.code_status, r.issued_at, r.used_at, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(cc.first_name,'')||' '||"
            "   COALESCE(cc.last_name,'')),'') FROM crm_customer cc "
            "   WHERE cc.customer_id=r.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM crm_redemptions r ORDER BY r.issued_at DESC LIMIT %s OFFSET %s",
            (lim, off), fetch=True) or []
        return [{
            "voucher_id": str(r["id"]), "customer_id": r["customer_id"],
            "customer_name": r["customer_name"], "code": r["discount_code"],
            "amount_kes": round(_num(r["kes_value"]), 2),
            "points_redeemed": _int(r["points_redeemed"]),
            "status": r["code_status"], "issued_at": _dt(r["issued_at"]),
            "used_at": _dt(r["used_at"]),
        } for r in rows]

    @app.get("/api/loyalty/voucher-cost")
    def cl_loy_voucher_cost(request: Request, days: int = Query(90)):
        _staff(request)
        d = _clamp(days, 1, 730, 90)
        r = _one(
            "SELECT COUNT(*) FILTER (WHERE issued_at>=now()-(%s||' days')::interval) AS issued, "
            " COALESCE(SUM(kes_value) FILTER (WHERE code_status='used' "
            "   AND used_at>=now()-(%s||' days')::interval),0) AS cost "
            "FROM crm_redemptions", (d, d)) or {}
        return {"issued": _int(r.get("issued")),
                "realized_cost_kes": round(_num(r.get("cost")), 2)}

    @app.get("/api/loyalty/customer/{cid}")
    def cl_loy_customer(request: Request, cid: str):
        _staff(request)
        e = _one(
            "SELECT e.tier, e.points_balance, e.points_lifetime, e.enrolment_date, "
            " COALESCE(m.spend_kes,0) AS spend FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE e.customer_id=%s", (cid,))
        if not e:
            sp = _num((_one(
                "SELECT SUM(total_spend_kes::numeric) AS s FROM all_customers "
                "WHERE customer_id=%s", (cid,)) or {}).get("s"))
            return {"enrolled": False, "tier": _tier_label(sp),
                    "spend_12mo_kes": round(sp, 2), "points_balance": 0,
                    "progress": None, "voucher": None, "styling": {"remaining": 0}}
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 100000)
        spend = _num(e["spend"])
        if e["tier"] == "Gold":
            progress = {"next_tier": None, "percent": 100}
        else:
            target = silver if e["tier"] == "Bronze" else gold
            progress = {"next_tier": "Silver" if e["tier"] == "Bronze" else "Gold",
                        "percent": int(min(spend / target * 100, 100)) if target else 0}
        v = _one(
            "SELECT discount_code, code_status, kes_value FROM crm_redemptions "
            "WHERE customer_id=%s AND code_status='issued' ORDER BY issued_at DESC LIMIT 1",
            (cid,))
        return {
            "enrolled": True, "tier": e["tier"],
            "points_balance": _int(e["points_balance"]),
            "points_lifetime": _int(e["points_lifetime"]),
            "spend_12mo_kes": round(spend, 2),
            "enrolment_date": _dt(e["enrolment_date"]),
            "progress": progress,
            "voucher": ({"code": v["discount_code"], "status": v["code_status"],
                         "amount_kes": round(_num(v["kes_value"]), 2)} if v else None),
            "styling": {"remaining": 1 if e["tier"] in ("Silver", "Gold") else 0},
        }

    @app.get("/api/loyalty/mobile/me/{cid}")
    def cl_loy_mobile_me(request: Request, cid: str):
        # Staff-facing preview of the customer's mobile loyalty card. Gate is
        # bypassed for /api/loyalty/*, so enforce a staff session explicitly.
        _staff(request)
        e = _one(
            "SELECT e.tier, e.points_balance, e.points_lifetime, e.enrolment_date, "
            " COALESCE(m.spend_kes,0) AS spend, m.name, m.membership_code "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE e.customer_id=%s", (cid,))
        nm = _one(
            "SELECT " + _name_sql("c") + " AS customer_name "
            "FROM all_customers c WHERE c.customer_id=%s", (cid,))
        name = (e or {}).get("name") or (nm or {}).get("customer_name") or "Member"
        if not e:
            sp = _num((_one(
                "SELECT SUM(total_spend_kes::numeric) AS s FROM all_customers "
                "WHERE customer_id=%s", (cid,)) or {}).get("s"))
            return {"enrolled": False, "name": name, "tier": _tier_label(sp),
                    "points_balance": 0, "points_value_kes": 0.0,
                    "membership_code": None, "spend_kes": round(sp, 2),
                    "recent_activity": []}
        cfg = A._crm_config_dict()
        pt_val = _num(cfg.get("loyalty.point_value_kes"), 1)
        pts = _int(e["points_balance"])
        ledger = _ex(
            "SELECT reason, points_change, created_at FROM crm_loyalty_ledger "
            "WHERE customer_id=%s ORDER BY created_at DESC LIMIT 10",
            (cid,), fetch=True) or []
        return {
            "enrolled": True, "name": name, "tier": e["tier"],
            "membership_code": e.get("membership_code"),
            "points_balance": pts, "points_lifetime": _int(e["points_lifetime"]),
            "points_value_kes": round(pts * pt_val, 2),
            "spend_kes": round(_num(e["spend"]), 2),
            "enrolment_date": _dt(e["enrolment_date"]),
            "recent_activity": [
                {"reason": r["reason"], "points": _int(r["points_change"]),
                 "date": _dt(r["created_at"])} for r in ledger],
        }

    @app.post("/api/loyalty/customer/{cid}/voucher/issue")
    def cl_loy_issue_voucher(request: Request, cid: str,
                             payload: dict = Body(default=None)):
        _staff(request, roles=("admin",))
        p = payload or {}
        kes = _num(p.get("amount_kes"), 0)
        pts = _int(p.get("points"), 0)
        if kes <= 0:
            raise HTTPException(status_code=400, detail="amount_kes required")
        code = "VFG-" + secrets.token_hex(4).upper()
        _ex(
            "INSERT INTO crm_redemptions (customer_id,points_redeemed,kes_value,"
            " discount_code,code_status,issued_by) VALUES (%s,%s,%s,%s,'issued',%s)",
            (cid, pts, kes, code, _actor(request)[1]))
        A._crm_audit("loyalty", cid, "voucher_issue", code + " " + str(kes), request)
        return {"code": code, "amount_kes": round(kes, 2), "status": "issued"}

    @app.post("/api/loyalty/customer/{cid}/styling/book")
    def cl_loy_book_styling(request: Request, cid: str,
                            payload: dict = Body(default=None)):
        u = _staff(request)
        p = payload or {}
        when = (p.get("date") or "").strip()
        title = "Styling session" + ((" — " + when) if when else "")
        uid, name = u.get("user_id"), (u.get("name") or u.get("email"))
        _ex(
            "INSERT INTO crm_tasks (customer_id,title,description,status,priority,"
            " assignee_user_id,assignee_name,created_by,created_by_name) "
            "VALUES (%s,%s,%s,'open','high',%s,%s,%s,%s)",
            (cid, title, (p.get("notes") or ""), uid, name, uid, name))
        A._crm_audit("loyalty", cid, "styling_book", title, request)
        return {"ok": True, "title": title}

    @app.post("/api/loyalty/voucher/{vid}/redeem")
    def cl_loy_redeem_voucher(request: Request, vid: str):
        _staff(request)
        r = _one("SELECT code_status FROM crm_redemptions WHERE id=%s",
                 (_int(vid),))
        if not r:
            raise HTTPException(status_code=404, detail="voucher not found")
        if r["code_status"] == "used":
            raise HTTPException(status_code=409, detail="already redeemed")
        _ex("UPDATE crm_redemptions SET code_status='used', used_at=now() WHERE id=%s",
            (_int(vid),))
        A._crm_audit("redemption", vid, "redeem", "voucher redeemed", request)
        return {"status": "used"}

    # ---- Push (no push infra in this project → designed empty outbox) ---- #
    @app.get("/api/loyalty/push/outbox")
    def cl_loy_push_outbox(request: Request):
        _staff(request)
        return {"messages": [], "scheduled": 0, "sent_30d": 0,
                "note": "Push delivery is not configured for this workspace."}

    @app.post("/api/loyalty/push/send")
    def cl_loy_push_send(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        return {"queued": 0,
                "note": "Push delivery is not configured for this workspace."}

    @app.post("/api/loyalty/push/dispatch-now")
    def cl_loy_push_dispatch(request: Request):
        _staff(request)
        return {"dispatched": 0}

    @app.post("/api/loyalty/push/cancel-all-scheduled")
    def cl_loy_push_cancel(request: Request):
        _staff(request)
        return {"cancelled": 0}


# --------------------------------------------------------------------------- #
# STAGE 2 — Segments & campaigns                                              #
# --------------------------------------------------------------------------- #
def _reg_segments(app):
    @app.get("/api/segments/filters")
    def cl_seg_filters(request: Request):
        _staff(request)
        cities = _q(
            "SELECT DISTINCT city FROM all_customers WHERE COALESCE(city,'')<>'' "
            "ORDER BY city LIMIT 200")
        return {
            "rfm_tiers": ["Champion", "Loyal", "Promising", "New", "At Risk", "Dormant"],
            "loyalty_tiers": ["Bronze", "Silver", "Gold"],
            "cities": [r["city"] for r in cities],
        }

    def _segment_sql(p):
        rec = "(CURRENT_DATE - c.lod::date)"
        where = ["1=1"]
        if _num(p.get("min_total_sales")) > 0:
            where.append("COALESCE(c.spend,0) >= " + str(_num(p.get("min_total_sales"))))
        if _int(p.get("min_orders")) > 0:
            where.append("COALESCE(c.orders,0) >= " + str(_int(p.get("min_orders"))))
        if _int(p.get("not_contacted_days")) > 0:
            nd = _int(p.get("not_contacted_days"))
            where.append(
                "NOT EXISTS (SELECT 1 FROM crm_interactions i "
                "WHERE i.customer_id=c.customer_id "
                "AND i.created_at >= now()-(" + str(nd) + "||' days')::interval)")
        if _int(p.get("recency_days_min")) > 0:
            where.append("c.lod " + _ISO + " AND " + rec + " >= " + str(_int(p.get("recency_days_min"))))
        if _int(p.get("recency_days_max")) > 0:
            where.append("c.lod " + _ISO + " AND " + rec + " <= " + str(_int(p.get("recency_days_max"))))
        cities = p.get("cities")
        if cities:
            where.append("1=1" + _in_clause("c.city", ",".join(cities)))
        return " AND ".join(where)

    @app.post("/api/segments/preview")
    def cl_seg_preview(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        where = _segment_sql(p)
        base = (
            "WITH c AS (SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " MAX(city) AS city, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
            " FROM all_customers GROUP BY customer_id) ")
        total = _int((_q1(base + "SELECT COUNT(*) AS n FROM c WHERE " + where)).get("n"))
        rows = _q(
            base + "SELECT customer_id, COALESCE(nm,'Guest') AS customer_name, city, "
            " COALESCE(orders,0) AS orders, COALESCE(spend,0) AS spend "
            "FROM c WHERE " + where + " ORDER BY spend DESC NULLS LAST LIMIT 50")
        return {
            "total_matches": total,
            "customers": [{
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "city": r["city"], "total_orders": _int(r["orders"]),
                "total_sales": round(_num(r["spend"]), 2),
                "rfm_tier": _tier_label(_num(r["spend"])),
            } for r in rows],
        }

    @app.post("/api/campaigns/preview")
    def cl_campaign_preview(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        ids = [str(x) for x in (p.get("customer_ids") or []) if x][:200]
        template = (p.get("template") or
                    "Hi {name}, we've picked a few new arrivals we think you'll love. "
                    "Pop in and we'll have them ready for you.")
        if not ids:
            return {"messages": []}
        rows = _ex(
            "SELECT customer_id, "
            " COALESCE(MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||"
            "   COALESCE(last_name,'')),'')),'there') AS nm "
            "FROM all_customers WHERE customer_id = ANY(%s) GROUP BY customer_id",
            (ids,), fetch=True) or []
        name_by = {r["customer_id"]: r["nm"] for r in rows}
        msgs = []
        for cid in ids:
            nm = name_by.get(cid, "there")
            first = nm.split(" ")[0] if nm else "there"
            msgs.append({
                "customer_id": cid, "customer_name": nm,
                "message": template.replace("{name}", first).replace("{first_name}", first),
            })
        return {"messages": msgs}

    @app.post("/api/campaigns/send")
    def cl_campaign_send(request: Request, payload: dict = Body(default=None)):
        u = _staff(request)
        p = payload or {}
        msgs = p.get("messages") or []
        name = u.get("name") or u.get("email")
        uid = u.get("user_id")
        sent = 0
        for m in msgs:
            cid = m.get("customer_id")
            if not cid:
                continue
            _ex(
                "INSERT INTO crm_interactions (customer_id,type,channel,notes,"
                " user_id,user_name) VALUES (%s,'message','campaign',%s,%s,%s)",
                (str(cid), (m.get("message") or "")[:2000], uid, name))
            sent += 1
        A._crm_audit("campaign", "send", "send", str(sent) + " messages logged", request)
        return {"sent": sent}


# --------------------------------------------------------------------------- #
# STAGE 3 — Social (CRM listening surface). Reuses real Facebook data via the  #
# existing api_pg /api/social/* where present; the multi-platform listening    #
# tables below are this project's own (crm_social_*), empty until populated.   #
# NOTE: paths already owned by api_pg (status, posts, post, comments,          #
# insights, diagnostics) are intentionally NOT re-registered here.            #
# --------------------------------------------------------------------------- #
def _reg_social(app):
    _SENT = ("positive", "neutral", "negative")

    @app.get("/api/social/summary")
    def cl_soc_summary(request: Request, date_from: str = Query(None),
                       date_to: str = Query(None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        f = _safe_date(date_from, _ago(30))
        t = _safe_date(date_to, _today())
        agg = _one(
            "SELECT COUNT(*) AS feedback, "
            " COUNT(*) FILTER (WHERE customer_id IS NULL) AS unmatched, "
            " COUNT(*) FILTER (WHERE sentiment IS NOT NULL) AS classified, "
            " COUNT(*) FILTER (WHERE sentiment='positive') AS pos, "
            " COUNT(*) FILTER (WHERE sentiment='neutral') AS neu, "
            " COUNT(*) FILTER (WHERE sentiment='negative') AS neg "
            "FROM crm_social_feedback WHERE posted_at::date BETWEEN %s AND %s",
            (f, t)) or {}
        by = _ex(
            "SELECT COALESCE(platform,'other') AS platform, COUNT(*) AS feedback, "
            " COUNT(*) FILTER (WHERE sentiment='positive') AS positive "
            "FROM crm_social_feedback WHERE posted_at::date BETWEEN %s AND %s "
            "GROUP BY platform", (f, t), fetch=True) or []
        return {
            "totals": {"feedback": _int(agg.get("feedback")), "posts": 0,
                       "unmatched": _int(agg.get("unmatched")),
                       "classified": _int(agg.get("classified"))},
            "engagement": {"likes": 0, "comments": 0, "shares": 0, "reach": 0},
            "sentiment": {"positive": _int(agg.get("pos")),
                          "neutral": _int(agg.get("neu")),
                          "negative": _int(agg.get("neg"))},
            "by_platform": {r["platform"]: {"feedback": _int(r["feedback"]),
                                            "positive": _int(r["positive"])} for r in by},
            "top_themes": [],
        }

    @app.get("/api/social/mentions")
    def cl_soc_mentions(request: Request, date_from: str = Query(None),
                        date_to: str = Query(None), limit: int = Query(50)):
        _staff(request, roles=("analyst", "exec", "admin"))
        f = _safe_date(date_from, _ago(30))
        t = _safe_date(date_to, _today())
        lim = _clamp(limit, 1, 200, 50)
        rows = _ex(
            "SELECT id, platform, author_handle, author_name, body, sentiment, "
            " posted_at FROM crm_social_feedback "
            "WHERE posted_at::date BETWEEN %s AND %s ORDER BY posted_at DESC LIMIT %s",
            (f, t, lim), fetch=True) or []
        return [{
            "feedback_id": str(r["id"]), "platform": r["platform"],
            "author_handle": r["author_handle"], "author_name": r["author_name"],
            "body": r["body"], "sentiment": r["sentiment"],
            "posted_at": _dt(r["posted_at"]),
        } for r in rows]

    @app.get("/api/social/influencers")
    def cl_soc_influencers(request: Request, limit: int = Query(15)):
        _staff(request, roles=("analyst", "exec", "admin"))
        lim = _clamp(limit, 1, 100, 15)
        rows = _ex(
            "SELECT COALESCE(author_handle,author_name,'unknown') AS handle, "
            " MAX(author_name) AS name, COUNT(*) AS feedback_count, "
            " array_agg(DISTINCT platform) AS platforms "
            "FROM crm_social_feedback GROUP BY 1 ORDER BY feedback_count DESC LIMIT %s",
            (lim,), fetch=True) or []
        return [{
            "handle": r["handle"], "name": r["name"],
            "platforms": [p for p in (r["platforms"] or []) if p],
            "feedback_count": _int(r["feedback_count"]),
            "engagement": _int(r["feedback_count"]), "sentiment_score": 0.0,
        } for r in rows]

    @app.get("/api/social/platforms/status")
    def cl_soc_platforms_status(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        fb_ok = bool(A._fb_enabled()) if hasattr(A, "_fb_enabled") else bool(
            __import__("os").environ.get("FACEBOOK_PAGE_ACCESS_TOKEN"))
        connected = ["facebook"] if fb_ok else []
        available = ["instagram", "tiktok", "x", "google"]
        return {"connected": connected, "available": available,
                "sync_status": {"facebook": {"last_sync": None,
                                             "status": "connected" if fb_ok else "not_configured"}}}

    @app.post("/api/social/platforms/{platform}/connect")
    def cl_soc_platform_connect(request: Request, platform: str,
                                payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"status": "unavailable", "platform": platform,
                "note": "Connect this platform from workspace secrets."}

    @app.delete("/api/social/platforms/{platform}")
    def cl_soc_platform_disconnect(request: Request, platform: str):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"ok": True, "platform": platform, "status": "disconnected"}

    @app.get("/api/social/handles/{cid}")
    def cl_soc_handles(request: Request, cid: str):
        _staff(request, roles=("analyst", "exec", "admin"))
        rows = _ex(
            "SELECT platform, handle, added_at FROM crm_social_handle "
            "WHERE customer_id=%s ORDER BY platform", (cid,), fetch=True) or []
        return [{"platform": r["platform"], "handle": r["handle"],
                 "added_at": _dt(r["added_at"])} for r in rows]

    @app.post("/api/social/handles/{cid}")
    def cl_soc_handle_add(request: Request, cid: str,
                          payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        p = payload or {}
        plat = (p.get("platform") or "").strip().lower()[:40]
        handle = (p.get("handle") or "").strip()[:120]
        if not plat or not handle:
            raise HTTPException(status_code=400, detail="platform and handle required")
        _ex(
            "INSERT INTO crm_social_handle (customer_id,platform,handle) "
            "VALUES (%s,%s,%s) ON CONFLICT (customer_id,platform) "
            "DO UPDATE SET handle=EXCLUDED.handle", (cid, plat, handle))
        _ex("UPDATE crm_social_feedback SET customer_id=%s "
            "WHERE customer_id IS NULL AND lower(author_handle)=lower(%s)",
            (cid, handle))
        return {"ok": True}

    @app.delete("/api/social/handles/{cid}/{platform}")
    def cl_soc_handle_del(request: Request, cid: str, platform: str):
        _staff(request, roles=("analyst", "exec", "admin"))
        _ex("DELETE FROM crm_social_handle WHERE customer_id=%s AND platform=%s",
            (cid, platform.lower()))
        return {"ok": True}

    @app.get("/api/social/timeline/{cid}")
    def cl_soc_timeline(request: Request, cid: str):
        _staff(request, roles=("analyst", "exec", "admin"))
        handles = _ex(
            "SELECT platform, handle, added_at FROM crm_social_handle "
            "WHERE customer_id=%s", (cid,), fetch=True) or []
        items = _ex(
            "SELECT id, platform, type, body, sentiment, themes, posted_at "
            "FROM crm_social_feedback WHERE customer_id=%s "
            "ORDER BY posted_at DESC LIMIT 100", (cid,), fetch=True) or []
        return {
            "handles": [{"platform": h["platform"], "handle": h["handle"],
                         "added_at": _dt(h["added_at"])} for h in handles],
            "items": [{
                "feedback_id": str(i["id"]), "platform": i["platform"],
                "type": i["type"], "body": i["body"], "sentiment": i["sentiment"],
                "themes": i["themes"] or [], "posted_at": _dt(i["posted_at"]),
            } for i in items],
        }

    @app.get("/api/social/feedback")
    def cl_soc_feedback(request: Request, platform: str = Query(None),
                        sentiment: str = Query(None), customer_id: str = Query(None),
                        unmatched: bool = Query(False), q: str = Query(None),
                        limit: int = Query(100)):
        _staff(request, roles=("analyst", "exec", "admin"))
        lim = _clamp(limit, 1, 500, 100)
        conds, params = ["1=1"], []
        if platform:
            conds.append("platform=%s")
            params.append(platform)
        if sentiment in _SENT:
            conds.append("sentiment=%s")
            params.append(sentiment)
        if customer_id:
            conds.append("customer_id=%s")
            params.append(customer_id)
        if unmatched:
            conds.append("customer_id IS NULL")
        if q:
            conds.append("body ILIKE %s")
            params.append("%" + q + "%")
        params.append(lim)
        rows = _ex(
            "SELECT id, platform, type, author_name, author_handle, body, sentiment, "
            " themes, customer_id, reply_body, replied_at, posted_at "
            "FROM crm_social_feedback WHERE " + " AND ".join(conds) +
            " ORDER BY posted_at DESC LIMIT %s", tuple(params), fetch=True) or []
        return [{
            "feedback_id": str(r["id"]), "platform": r["platform"], "type": r["type"],
            "author_name": r["author_name"], "author_handle": r["author_handle"],
            "body": r["body"], "sentiment": r["sentiment"], "themes": r["themes"] or [],
            "customer_id": r["customer_id"], "reply_body": r["reply_body"],
            "replied_at": _dt(r["replied_at"]), "posted_at": _dt(r["posted_at"]),
        } for r in rows]

    @app.post("/api/social/feedback")
    def cl_soc_feedback_add(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        p = payload or {}
        rid = _ex(
            "INSERT INTO crm_social_feedback (platform,type,author_name,author_handle,"
            " body,sentiment,customer_id,posted_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
            ((p.get("platform") or "other"), (p.get("type") or "mention"),
             p.get("author_name"), p.get("author_handle"), (p.get("body") or ""),
             p.get("sentiment"), p.get("customer_id")), fetch=True)
        return {"ok": True, "feedback_id": str(rid[0]["id"]) if rid else None}

    @app.post("/api/social/feedback/{fid}/link")
    def cl_soc_feedback_link(request: Request, fid: str,
                             payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        cid = (payload or {}).get("customer_id")
        _ex("UPDATE crm_social_feedback SET customer_id=%s WHERE id=%s",
            (cid, _int(fid)))
        return {"ok": True}

    @app.post("/api/social/feedback/{fid}/reply")
    def cl_soc_feedback_reply(request: Request, fid: str,
                              payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        body = (payload or {}).get("body") or ""
        _ex("UPDATE crm_social_feedback SET reply_body=%s, replied_at=now() WHERE id=%s",
            (body, _int(fid)))
        A._crm_audit("social", fid, "reply", "feedback reply", request)
        return {"feedback_id": fid, "reply_body": body, "replied_at": _today()}

    @app.get("/api/social/auto-tasks")
    def cl_soc_auto_tasks(request: Request, include_completed: bool = Query(False)):
        _staff(request, roles=("analyst", "exec", "admin"))
        return []

    @app.get("/api/social/auto-tasks/kpi")
    def cl_soc_auto_tasks_kpi(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"open": 0, "completed_14d": 0, "top_themes": []}

    @app.post("/api/social/auto-tasks/run")
    def cl_soc_auto_tasks_run(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"already_run": False, "tasks_created": 0, "themes": []}

    @app.post("/api/social/classify-pending")
    def cl_soc_classify_pending(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        rows = _ex(
            "SELECT id, body FROM crm_social_feedback WHERE sentiment IS NULL LIMIT 50",
            fetch=True) or []
        classified = 0
        for r in rows:
            s = _quick_sentiment(r["body"])
            _ex("UPDATE crm_social_feedback SET sentiment=%s WHERE id=%s", (s, r["id"]))
            classified += 1
        return {"classified": classified}

    @app.get("/api/social/facebook/status")
    def cl_soc_fb_status(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        import os
        ok = bool(os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN")
                  and os.environ.get("FACEBOOK_PAGE_ID"))
        return {"pages": [], "total_posts": 0, "total_feedback": 0, "config_ok": ok}

    @app.post("/api/social/facebook/discover")
    def cl_soc_fb_discover(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"discovered": []}

    @app.get("/api/social/facebook/pages")
    def cl_soc_fb_pages(request: Request):
        _staff(request, roles=("analyst", "exec", "admin"))
        return []

    @app.delete("/api/social/facebook/pages/{page_id}")
    def cl_soc_fb_page_del(request: Request, page_id: str):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"ok": True, "page_id": page_id}

    @app.post("/api/social/facebook/sync")
    def cl_soc_fb_sync(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        return {"status": "skipped", "synced_pages": 0, "new_posts": 0,
                "new_feedback": 0,
                "note": "Use the BI app Social page for live Facebook posting."}


def _quick_sentiment(text):
    t = (text or "").lower()
    neg = ("bad", "poor", "worst", "hate", "broken", "refund", "late", "rude",
           "disappoint", "never", "wrong", "delay")
    pos = ("love", "great", "amazing", "excellent", "perfect", "best", "happy",
           "beautiful", "thank", "recommend", "good", "nice")
    if any(w in t for w in neg):
        return "negative"
    if any(w in t for w in pos):
        return "positive"
    return "neutral"


# --------------------------------------------------------------------------- #
# STAGE 3 — Training / L&D. No training data source exists in this project,    #
# so every endpoint returns a well-formed, empty analytics shape.             #
# --------------------------------------------------------------------------- #
def _reg_training(app):
    @app.get("/api/training/filters")
    def cl_tr_filters(request: Request):
        _staff(request)
        return {"categories": [], "training_names": [], "departments": [],
                "delivery_methods": []}

    @app.get("/api/training/overview")
    def cl_tr_overview(request: Request):
        _staff(request)
        return {"total_trainings": 0, "total_attendees": 0, "total_hours": 0.0,
                "avg_score": 0.0}

    @app.get("/api/training/budget")
    def cl_tr_budget(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/by-delivery-method")
    def cl_tr_delivery(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/by-department")
    def cl_tr_department(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/duration")
    def cl_tr_duration(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/facilitators")
    def cl_tr_facilitators(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/lateness")
    def cl_tr_lateness(request: Request):
        _staff(request)
        return {"by_training": [], "detail": []}

    @app.get("/api/training/monthly-trend")
    def cl_tr_monthly(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/top-employees")
    def cl_tr_top_emps(request: Request):
        _staff(request)
        return []

    @app.get("/api/training/training-status")
    def cl_tr_status(request: Request):
        _staff(request)
        return []


# --------------------------------------------------------------------------- #
# STAGE 3 — Templates, lookbooks, consent, preferences, customer extras       #
# --------------------------------------------------------------------------- #
def _reg_misc(app):
    # ---- Templates ------------------------------------------------------ #
    @app.get("/api/templates")
    def cl_templates(request: Request):
        _staff(request)
        rows = _ex(
            "SELECT id, name, channel, body, bsp_status FROM crm_template "
            "ORDER BY created_at DESC", fetch=True) or []
        return [{
            "template_id": str(r["id"]), "name": r["name"], "channel": r["channel"],
            "body": r["body"], "bsp_status": r["bsp_status"],
        } for r in rows]

    @app.post("/api/templates")
    def cl_template_create(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        rid = _ex(
            "INSERT INTO crm_template (name,channel,body,bsp_status,created_by) "
            "VALUES (%s,%s,%s,%s,%s) RETURNING id",
            ((p.get("name") or "Untitled"), (p.get("channel") or "whatsapp"),
             (p.get("body") or ""), (p.get("bsp_status") or "approved"),
             _actor(request)[1]), fetch=True)
        return {"template_id": str(rid[0]["id"]) if rid else None,
                "name": p.get("name"), "channel": p.get("channel"),
                "body": p.get("body"), "bsp_status": p.get("bsp_status") or "approved"}

    @app.put("/api/templates/{tid}")
    def cl_template_update(request: Request, tid: str,
                           payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        _ex("UPDATE crm_template SET name=%s, channel=%s, body=%s WHERE id=%s",
            ((p.get("name") or ""), (p.get("channel") or ""), (p.get("body") or ""),
             _int(tid)))
        return {"template_id": tid, "name": p.get("name"), "channel": p.get("channel"),
                "body": p.get("body")}

    @app.delete("/api/templates/{tid}")
    def cl_template_delete(request: Request, tid: str):
        _staff(request)
        _ex("DELETE FROM crm_template WHERE id=%s", (_int(tid),))
        return {"deleted": 1}

    @app.put("/api/templates/{tid}/bsp-status")
    def cl_template_bsp(request: Request, tid: str, payload: dict = Body(default=None)):
        _staff(request)
        st = (payload or {}).get("bsp_status") or "approved"
        _ex("UPDATE crm_template SET bsp_status=%s WHERE id=%s", (st, _int(tid)))
        return {"template_id": tid, "bsp_status": st}

    @app.get("/api/templates/{tid}/bsp-status")
    def cl_template_bsp_get(request: Request, tid: str):
        _staff(request)
        r = _one("SELECT bsp_status FROM crm_template WHERE id=%s", (_int(tid),))
        return {"template_id": tid, "bsp_status": (r or {}).get("bsp_status", "approved")}

    # ---- Lookbooks ------------------------------------------------------ #
    @app.get("/api/lookbooks")
    def cl_lookbooks(request: Request, customer_id: str = Query(None)):
        _staff(request)
        if customer_id:
            rows = _ex(
                "SELECT l.id, l.customer_id, l.title, l.description, l.items, "
                " l.created_at, " + _name_sql("l") + " AS customer_name "
                "FROM crm_lookbook l WHERE l.customer_id=%s ORDER BY l.created_at DESC",
                (customer_id,), fetch=True) or []
        else:
            rows = _ex(
                "SELECT l.id, l.customer_id, l.title, l.description, l.items, "
                " l.created_at, " + _name_sql("l") + " AS customer_name "
                "FROM crm_lookbook l ORDER BY l.created_at DESC LIMIT 200",
                fetch=True) or []
        out = []
        for r in rows:
            items = r["items"]
            if isinstance(items, str):
                try:
                    items = json.loads(items)
                except Exception:
                    items = []
            out.append({
                "lookbook_id": str(r["id"]), "customer_id": r["customer_id"],
                "customer_name": r["customer_name"], "title": r["title"],
                "note": r["description"], "items": items or [], "views": 0,
                "created_at": _dt(r["created_at"]),
            })
        return out

    @app.post("/api/lookbooks")
    def cl_lookbook_create(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        items = p.get("items") or []
        token = secrets.token_urlsafe(10)
        rid = _ex(
            "INSERT INTO crm_lookbook "
            "(customer_id,title,description,items,created_by,share_token) "
            "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (p.get("customer_id"), (p.get("title") or "Lookbook"),
             (p.get("note") or ""), json.dumps(items), _actor(request)[1], token),
            fetch=True)
        return {"lookbook_id": str(rid[0]["id"]) if rid else None,
                "share_token": token, "items": items}

    # ---- Public (no-auth) lookbook share links -------------------------- #
    @app.get("/api/public/lookbooks/{token}")
    def cl_public_lookbook(token: str):
        row = _one(
            "SELECT id, customer_id, title, description, items, share_token "
            "FROM crm_lookbook WHERE share_token=%s", (token,))
        if not row:
            raise HTTPException(status_code=404, detail="Lookbook not found")
        _ex("UPDATE crm_lookbook SET views=COALESCE(views,0)+1 WHERE id=%s",
            (row["id"],))
        items = row["items"]
        if isinstance(items, str):
            try:
                items = json.loads(items)
            except Exception:
                items = []
        return {"lookbook_id": str(row["id"]), "title": row["title"],
                "note": row["description"], "items": items or []}

    @app.post("/api/public/lookbooks/{token}/interest")
    def cl_public_lookbook_interest(token: str, payload: dict = Body(default=None)):
        row = _one(
            "SELECT id, customer_id FROM crm_lookbook WHERE share_token=%s",
            (token,))
        if not row:
            raise HTTPException(status_code=404, detail="Lookbook not found")
        p = payload or {}
        _ex(
            "INSERT INTO crm_lookbook_interest "
            "(lookbook_id,customer_id,sku,product_title) VALUES (%s,%s,%s,%s)",
            (row["id"], row["customer_id"],
             (p.get("sku") or "")[:120], (p.get("product_title") or "")[:300]))
        return {"ok": True}

    # ---- Consent -------------------------------------------------------- #
    @app.get("/api/consent/{cid}")
    def cl_consent_get(request: Request, cid: str):
        _staff(request)
        rows = _ex(
            "SELECT id, channel, opted_in, method, created_at FROM crm_consent "
            "WHERE customer_id=%s ORDER BY created_at DESC", (cid,), fetch=True) or []
        return [{
            "consent_id": str(r["id"]), "channel": r["channel"],
            "opted_in": bool(r["opted_in"]), "method": r["method"],
            "timestamp": _dt(r["created_at"]),
        } for r in rows]

    @app.post("/api/consent")
    def cl_consent_set(request: Request, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        cid = p.get("customer_id")
        if not cid:
            raise HTTPException(status_code=400, detail="customer_id required")
        rid = _ex(
            "INSERT INTO crm_consent (customer_id,channel,opted_in,method,user_name) "
            "VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (cid, (p.get("channel") or "whatsapp"), bool(p.get("opted_in")),
             (p.get("method") or "manual"), _actor(request)[1]), fetch=True)
        return {"consent_id": str(rid[0]["id"]) if rid else None, "ok": True}

    @app.delete("/api/consent/{rid}")
    def cl_consent_del(request: Request, rid: str):
        _staff(request)
        _ex("DELETE FROM crm_consent WHERE id=%s", (_int(rid),))
        return {"deleted": 1}

    # ---- Preferences ---------------------------------------------------- #
    @app.get("/api/preferences/{cid}")
    def cl_prefs_get(request: Request, cid: str):
        _staff(request)
        r = _one("SELECT data FROM crm_preferences WHERE customer_id=%s", (cid,))
        data = (r or {}).get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except Exception:
                data = {}
        data.setdefault("customer_id", cid)
        return data

    @app.put("/api/preferences/{cid}")
    def cl_prefs_set(request: Request, cid: str, payload: dict = Body(default=None)):
        _staff(request)
        data = payload or {}
        _ex(
            "INSERT INTO crm_preferences (customer_id,data,updated_at) "
            "VALUES (%s,%s::jsonb,now()) ON CONFLICT (customer_id) "
            "DO UPDATE SET data=EXCLUDED.data, updated_at=now()",
            (cid, json.dumps(data)))
        data.setdefault("customer_id", cid)
        return data

    # ---- Customer extras ------------------------------------------------ #
    @app.get("/api/customers/{cid}/brief")
    def cl_cust_brief(request: Request, cid: str):
        _staff(request)
        c = _one(
            "SELECT customer_id, "
            " MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm, "
            " MAX(city) AS city, MAX(phone) AS phone, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
            "FROM all_customers WHERE customer_id=%s GROUP BY customer_id", (cid,)) or {}
        spend = _num(c.get("spend"))
        orders = _int(c.get("orders"))
        nba = []
        rec = None
        lod = c.get("lod")
        if lod and re.match(r"^\d{4}-\d{2}-\d{2}", str(lod)):
            try:
                rec = (date.today() - datetime.strptime(str(lod)[:10], "%Y-%m-%d").date()).days
            except Exception:
                rec = None
        if rec is not None and rec > 365 and spend >= 30000:
            nba.append({"title": "Win-back outreach",
                        "reason": "High-value but lapsed >12 months"})
        elif spend >= 100000:
            nba.append({"title": "VIP styling invite",
                        "reason": "Top-tier lifetime spend"})
        else:
            nba.append({"title": "Personal check-in",
                        "reason": "Keep the relationship warm"})
        sentiment = _num((_one(
            "SELECT AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' "
            "THEN -1 ELSE 0 END) AS s FROM crm_social_feedback WHERE customer_id=%s",
            (cid,)) or {}).get("s"))
        return {
            "customer": {"customer_id": cid, "customer_name": c.get("nm") or "Guest",
                         "city": c.get("city"), "phone": c.get("phone")},
            "nba": nba,
            "metrics": {"ltv": round(spend, 2), "orders": orders,
                        "frequency": round(orders / max((rec or 365) / 365.0, 0.1), 2)
                        if orders else 0.0,
                        "tier": _tier_label(spend)},
            "sentiment_net": round(sentiment, 2),
        }

    @app.get("/api/customers/{cid}/moments")
    def cl_moments_get(request: Request, cid: str):
        _staff(request)
        rows = _ex(
            "SELECT id, moment_type, label, moment_date, recurring_annual "
            "FROM crm_moment WHERE customer_id=%s ORDER BY moment_date NULLS LAST",
            (cid,), fetch=True) or []
        return [{
            "id": str(r["id"]), "type": r["moment_type"] or "event",
            "title": r["label"], "date": _dt(r["moment_date"]),
            "recurring_annual": bool(r["recurring_annual"]),
        } for r in rows]

    @app.post("/api/customers/{cid}/moments")
    def cl_moments_add(request: Request, cid: str, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        md = _safe_date(p.get("date"), None)
        rid = _ex(
            "INSERT INTO crm_moment (customer_id,moment_type,label,moment_date,"
            " recurring_annual,created_by) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (cid, (p.get("type") or "event"), (p.get("title") or ""),
             md, bool(p.get("recurring_annual")), _actor(request)[1]), fetch=True)
        return {"id": str(rid[0]["id"]) if rid else None, "type": p.get("type"),
                "title": p.get("title"), "date": md,
                "recurring_annual": bool(p.get("recurring_annual"))}

    @app.delete("/api/customers/{cid}/moments/{mid}")
    def cl_moments_del(request: Request, cid: str, mid: str):
        _staff(request)
        _ex("DELETE FROM crm_moment WHERE id=%s AND customer_id=%s", (_int(mid), cid))
        return {"deleted": 1}

    @app.post("/api/customers/{cid}/draft-message")
    def cl_draft_message(request: Request, cid: str, payload: dict = Body(default=None)):
        _staff(request)
        p = payload or {}
        body = p.get("body")
        if not body and p.get("template_id"):
            r = _one("SELECT body FROM crm_template WHERE id=%s",
                     (_int(p.get("template_id")),))
            body = (r or {}).get("body")
        nm = (_one(
            "SELECT MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||"
            "COALESCE(last_name,'')),'')) AS nm FROM all_customers WHERE customer_id=%s",
            (cid,)) or {}).get("nm") or "there"
        first = nm.split(" ")[0]
        body = (body or "Hi {name}, just checking in — let me know if you'd like a "
                "hand finding something new.").replace("{name}", first).replace(
            "{first_name}", first)
        return {"draft_id": secrets.token_hex(6), "body": body, "channel": p.get("channel")}

    @app.post("/api/customers/{cid}/voice-note")
    def cl_voice_note(request: Request, cid: str):
        _staff(request)
        return {"voice_note_id": secrets.token_hex(6), "url": None,
                "transcription": "",
                "note": "Voice capture is not configured for this workspace."}

    @app.get("/api/customers/duplicates")
    def cl_duplicates(request: Request, limit: int = Query(50)):
        _staff(request)
        lim = _clamp(limit, 1, 200, 50)
        rows = _q(
            "WITH p AS (SELECT NULLIF(TRIM(phone),'') AS phone, customer_id, "
            "  MAX(NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS nm "
            "  FROM all_customers WHERE NULLIF(TRIM(phone),'') IS NOT NULL "
            "  GROUP BY phone, customer_id), "
            "d AS (SELECT phone FROM p GROUP BY phone HAVING COUNT(DISTINCT customer_id) > 1 "
            "  LIMIT " + str(lim) + ") "
            "SELECT p.phone, p.customer_id, COALESCE(p.nm,'Guest') AS nm "
            "FROM p JOIN d USING (phone) ORDER BY p.phone")
        groups = {}
        for r in rows:
            groups.setdefault(r["phone"], []).append(
                {"customer_id": r["customer_id"], "customer_name": r["nm"]})
        return {"groups": [{"match_on": "phone", "value": k, "customers": v}
                           for k, v in groups.items()],
                "total_groups": len(groups), "scanning": False}

    @app.post("/api/dropoff/winback-bulk")
    def cl_winback_bulk(request: Request, payload: dict = Body(default=None)):
        u = _staff(request)
        p = payload or {}
        band = (p.get("band") or "at_risk")
        lim = _clamp(p.get("limit"), 1, 200, 25)
        ranges = {"cooling": (90, 180), "at_risk": (181, 365), "lapsed": (366, 3650)}
        lo, hi = ranges.get(band, (181, 365))
        rows = _q(
            "WITH c AS (SELECT customer_id, SUM(total_orders) AS orders, "
            " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
            " FROM all_customers GROUP BY customer_id) "
            "SELECT customer_id FROM c WHERE lod " + _ISO +
            " AND (CURRENT_DATE-lod::date) BETWEEN " + str(lo) + " AND " + str(hi) +
            " AND COALESCE(orders,0) >= 2 ORDER BY spend DESC LIMIT " + str(lim))
        uid, name = u.get("user_id"), (u.get("name") or u.get("email"))
        tasks = []
        for r in rows:
            rid = _ex(
                "INSERT INTO crm_tasks (customer_id,title,description,status,priority,"
                " assignee_user_id,assignee_name,created_by,created_by_name) "
                "VALUES (%s,%s,%s,'open','high',%s,%s,%s,%s) RETURNING id",
                (r["customer_id"], "Win-back outreach",
                 "Auto-generated from drop-off band: " + band, uid, name, uid, name),
                fetch=True)
            tasks.append({"task_id": str(rid[0]["id"]) if rid else None,
                          "customer_id": r["customer_id"]})
        A._crm_audit("task", "winback", "create", band + " ×" + str(len(tasks)), request)
        return {"created": len(tasks), "tasks": tasks}

    @app.get("/api/manager/data-deletion-requests")
    def cl_data_deletion(request: Request):
        _staff(request, roles=("admin", "exec"))
        recent = _ex(
            "SELECT entity_id, created_at FROM crm_audit "
            "WHERE entity='customer' AND action='forget' "
            "ORDER BY created_at DESC LIMIT 50", fetch=True) or []
        return {"pending": [], "pending_count": 0,
                "recent_forgotten": [{"customer_id": r["entity_id"],
                                      "at": _dt(r["created_at"])} for r in recent]}

    @app.post("/api/admin/customer-cache/full-sync")
    def cl_cache_full_sync(request: Request):
        _staff(request, roles=("admin",))
        return {"started": False,
                "job": {"status": "not_required", "progress": 100},
                "note": "Customer data is queried live from Postgres; no cache to sync."}

    @app.get("/api/admin/customer-cache/full-sync/status")
    def cl_cache_status(request: Request):
        _staff(request, roles=("admin",))
        n = _int((_q1("SELECT COUNT(DISTINCT customer_id) AS n FROM all_customers")).get("n"))
        return {"status": "live", "customers_in_cache": n, "started_at": None,
                "progress": 100}

    @app.post("/api/insights/social/suggest-reply")
    def cl_suggest_reply(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("analyst", "exec", "admin"))
        p = payload or {}
        fid = p.get("feedback_id")
        fb = _one("SELECT body, sentiment, author_name, platform "
                  "FROM crm_social_feedback WHERE id=%s",
                  (_int(fid),)) if fid else None
        body = (fb or {}).get("body") or (p.get("body") or "")
        sentiment = (fb or {}).get("sentiment") or "neutral"

        def _template():
            if sentiment == "negative":
                return ("We're sorry to hear this and want to make it right. Please "
                        "DM us your order details and we'll follow up personally.")
            if sentiment == "positive":
                return ("Thank you so much! We're thrilled you love it — see you "
                        "again soon at Vivo.")
            return ("Thanks for reaching out! Let us know how we can help and "
                    "we'll be glad to assist.")

        reply = None
        if body.strip():
            author = (fb or {}).get("author_name") or "the customer"
            prompt = (
                "You are a social-media community manager for Vivo Fashion Group, a "
                "premium multi-brand fashion retailer in East Africa. Draft a short, "
                "warm, on-brand public reply (max 60 words, no hashtags, no emojis) "
                "to this " + sentiment + " comment from " + author + ":\n\n\"" +
                body.strip()[:1000] + "\"\n\nReply with the message text only.")
            try:
                out = A._chat_llm(
                    [{"role": "user", "content": prompt}], max_tokens=160)
                if out and out.strip():
                    reply = out.strip().strip('"')
            except Exception:
                reply = None
        if not reply:
            reply = _template()
        return {"reply": reply, "tone": sentiment}


# --------------------------------------------------------------------------- #
# Registration                                                                 #
# --------------------------------------------------------------------------- #
def register_clienteling_routes(app):
    global A
    import api_pg as _api
    A = _api
    _ensure_cl_tables()
    _reg_dashboard(app)
    _reg_customers(app)
    _reg_tasks_notes(app)
    _reg_bi(app)
    _reg_insights(app)
    _reg_loyalty_mgr(app)
    _reg_segments(app)
    _reg_social(app)
    _reg_training(app)
    _reg_misc(app)
    try:
        A.log.info("Clienteling CRM routes registered")
    except Exception:
        pass
