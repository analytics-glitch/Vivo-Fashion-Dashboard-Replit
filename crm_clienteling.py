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
import os
import re
import hmac
import hashlib
import base64
import urllib.parse
import threading
import time
import secrets
from datetime import datetime, date, timedelta

import requests

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


def _internal_token_ok(request):
    """True when the request carries the shared SESSION_SECRET in the
    X-Internal-Token header (constant-time compare). Lets the incremental sync
    loop drive staff-gated maintenance endpoints (the social CRM sync) with no
    user session — the same mechanism the auth gate uses for its internal-token
    snapshot endpoints."""
    sec = (os.environ.get("SESSION_SECRET") or "")
    tok = request.headers.get("x-internal-token") or ""
    return bool(sec) and hmac.compare_digest(tok, sec)


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


# --------------------------------------------------------------------------- #
# X (Twitter) API v2 — thin client for the CRM social inbox                    #
# --------------------------------------------------------------------------- #
# Reads (own posts + mentions) use an app-only Bearer token; writes (posting a
# reply) and DM reads/sends need OAuth 1.0a user-context credentials (signed
# with stdlib hmac-sha1 — no external oauth lib, matching this project's
# stdlib-first auth conventions). Every call fails loud with the API's own
# error message so a missing scope / rate-limit is surfaced, never silent.
_X_API = "https://api.twitter.com"


def _x_bearer():
    return (os.environ.get("X_BEARER_TOKEN") or "").strip()


def _x_user_id_cfg():
    return (os.environ.get("X_USER_ID") or "").strip()


def _x_username_cfg():
    return (os.environ.get("X_USERNAME") or "").strip().lstrip("@")


def _x_oauth1_creds():
    return (
        (os.environ.get("X_API_KEY") or "").strip(),
        (os.environ.get("X_API_SECRET") or "").strip(),
        (os.environ.get("X_ACCESS_TOKEN") or "").strip(),
        (os.environ.get("X_ACCESS_TOKEN_SECRET") or "").strip(),
    )


def _x_read_configured():
    """Reads need an app Bearer token plus a target account (id or handle)."""
    return bool(_x_bearer() and (_x_user_id_cfg() or _x_username_cfg()))


def _x_write_configured():
    """Replies + DM reads/sends need OAuth 1.0a user credentials (all four)."""
    ck, cs, at, ats = _x_oauth1_creds()
    return bool(ck and cs and at and ats)


def _x_err(r):
    """Extract a human-readable error from an X API v2 error response."""
    try:
        j = r.json()
        if isinstance(j, dict):
            if j.get("detail"):
                return f"X API {r.status_code}: {j.get('detail')}"
            errs = j.get("errors")
            if isinstance(errs, list) and errs:
                msgs = "; ".join(
                    str(e.get("message") or e.get("detail") or e) for e in errs)
                return f"X API {r.status_code}: {msgs}"
            if j.get("title"):
                return f"X API {r.status_code}: {j.get('title')}"
    except Exception:
        pass
    return f"X API {r.status_code}: {(r.text or '')[:200]}"


def _x_get(path, params=None):
    """App-only Bearer GET against X API v2. Raises RuntimeError on non-2xx."""
    r = requests.get(_X_API + path,
                     headers={"Authorization": "Bearer " + _x_bearer()},
                     params=params or {}, timeout=30)
    if r.status_code // 100 != 2:
        raise RuntimeError(_x_err(r))
    return r.json()


def _x_oauth1_header(method, url, params=None):
    """Build an OAuth 1.0a Authorization header (HMAC-SHA1) for a user-context
    request. `params` are the query-string params (NOT a JSON body, which does
    not participate in the signature base string)."""
    ck, cs, at, ats = _x_oauth1_creds()
    oauth = {
        "oauth_consumer_key": ck,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": at,
        "oauth_version": "1.0",
    }
    enc = lambda s: urllib.parse.quote(str(s), safe="~")
    allp = dict(params or {})
    allp.update(oauth)
    pstr = "&".join(f"{enc(k)}={enc(allp[k])}" for k in sorted(allp))
    base = "&".join([method.upper(), enc(url), enc(pstr)])
    key = enc(cs) + "&" + enc(ats)
    sig = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    oauth["oauth_signature"] = sig
    return "OAuth " + ", ".join(
        f'{enc(k)}="{enc(v)}"' for k, v in sorted(oauth.items()))


def _x_oauth1_get(path, params=None):
    url = _X_API + path
    r = requests.get(url,
                     headers={"Authorization":
                              _x_oauth1_header("GET", url, params)},
                     params=params or {}, timeout=30)
    if r.status_code // 100 != 2:
        raise RuntimeError(_x_err(r))
    return r.json()


def _x_oauth1_post(path, body=None):
    url = _X_API + path
    r = requests.post(url,
                      headers={"Authorization":
                               _x_oauth1_header("POST", url, None),
                               "Content-Type": "application/json"},
                      json=body or {}, timeout=30)
    if r.status_code // 100 != 2:
        raise RuntimeError(_x_err(r))
    return r.json()


def _internal_ok(request):
    """True when the request carries a valid internal token (X-Internal-Token ==
    SESSION_SECRET), letting the sync loop trigger a sync without a staff
    session. Fails closed (constant-time compare) when the secret is unset."""
    try:
        sec = os.environ.get("SESSION_SECRET") or ""
        tok = request.headers.get("x-internal-token") or ""
        return bool(sec and tok and hmac.compare_digest(tok, sec))
    except Exception:
        return False


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
        "CASE WHEN " + spend_expr + " >= 300000 THEN 'VIP' "
        "WHEN " + spend_expr + " >= 150000 THEN 'Gold' "
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
        # source_id de-dupes real Facebook comments across repeated syncs.
        "ALTER TABLE crm_social_feedback ADD COLUMN IF NOT EXISTS source_id text",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_social_feedback_source "
        " ON crm_social_feedback(source_id) WHERE source_id IS NOT NULL",
        # Post/comment context: open-on-Facebook link + which post a comment is on.
        "ALTER TABLE crm_social_feedback ADD COLUMN IF NOT EXISTS permalink text",
        "ALTER TABLE crm_social_feedback ADD COLUMN IF NOT EXISTS parent_source_id text",
        "ALTER TABLE crm_social_feedback ADD COLUMN IF NOT EXISTS parent_excerpt text",
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

    @app.get("/api/customers/{cid}/transactions")
    def cl_customer_transactions(request: Request, cid: str):
        """Paginated, row-level transaction history (PRD 6.1/7.1).

        One row per (order, sale_kind) so purchases and returns surface
        distinctly. 20/page by default. ``all_sales`` carries no
        source_system column, so it is derived (Online vs Retail POS)."""
        page = _clamp(request.query_params.get("page"), 1, 100000, 1)
        page_size = _clamp(request.query_params.get("page_size"), 1, 100, 20)
        offset = (page - 1) * page_size
        cid_l = (cid or "")[:128]
        src_sql = ("CASE WHEN s.country='Online' "
                   "OR bool_or(s.channel='Online') "
                   "OR s.pos_location_name ILIKE '%%online%%' "
                   "THEN 'Online' ELSE 'Retail POS' END")
        total = _num((_ex(
            "SELECT COUNT(*) AS c FROM ("
            " SELECT 1 FROM all_sales s WHERE s.customer_id=%s "
            "  AND s.sale_date " + _ISO +
            "  GROUP BY s.order_id, s.sale_kind, s.sale_date) t",
            (cid_l,), fetch=True) or [{}])[0].get("c"))
        rows = _ex(
            "SELECT s.sale_date AS ts, s.order_id, s.sale_kind, "
            " COALESCE(NULLIF(MAX(s.channel),''), MAX(s.pos_location_name)) AS channel, "
            " " + src_sql + " AS source_system, "
            " SUM(s.total_sales_kes::numeric) AS amount, "
            " SUM(s.ordered_item_quantity) AS units, "
            " STRING_AGG(DISTINCT s.product_title, ', ') AS items "
            "FROM all_sales s WHERE s.customer_id=%s "
            " AND s.sale_date " + _ISO +
            " GROUP BY s.order_id, s.sale_kind, s.sale_date, s.country, "
            "  s.pos_location_name "
            " ORDER BY s.sale_date DESC, s.order_id DESC "
            " LIMIT %s OFFSET %s",
            (cid_l, page_size, offset), fetch=True) or []
        txns = []
        for r in rows:
            kind = (r["sale_kind"] or "").lower()
            txns.append({
                "date": _dt(r["ts"]),
                "type": "Return" if kind == "return" else "Purchase",
                "order_id": r["order_id"],
                "amount_kes": round(_num(r["amount"]), 2),
                "channel": r["channel"] or "—",
                "source_system": r["source_system"],
                "units": _int(r["units"]),
                "items": (r["items"] or "")[:240],
            })
        total_i = int(total)
        return {
            "transactions": txns,
            "page": page,
            "page_size": page_size,
            "total": total_i,
            "total_pages": (total_i + page_size - 1) // page_size if page_size else 0,
        }

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
    if s >= 300000:
        return "VIP"
    if s >= 150000:
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
    if s >= 300000:
        return "VIP"
    if s >= 150000:
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
        kpis = {
            "total_customers": 0, "new_customers_30d": 0,
            "new_customers_delta_pct": None, "active_customers_30d": 0,
            "active_customers_delta_pct": None, "vip_customers": 0,
            "at_risk_customers": 0, "avg_basket_kes": 0.0,
            "avg_basket_delta_pct": None, "messages_sent_30d": 0,
            "messages_delta_pct": None, "social_sentiment_net": 0,
            "social_feedback_30d": 0,
        }
        tier_distribution = {"Bronze": 0, "Silver": 0, "Gold": 0, "VIP": 0}
        callouts = []

        def _pct(cur, prev):
            cur, prev = _num(cur), _num(prev)
            if prev <= 0:
                return None
            return round((cur - prev) / prev * 100.0, 1)

        # Customer base: totals, tiers, VIP & at-risk counts ------------------ #
        try:
            r = _q1(
                "WITH c AS (SELECT customer_id, SUM(total_orders) AS orders, "
                " SUM(total_spend_kes::numeric) AS spend, MAX(last_order_date) AS lod "
                " FROM all_customers GROUP BY customer_id) "
                "SELECT COUNT(*) AS total, "
                " COUNT(*) FILTER (WHERE COALESCE(spend,0) < 50000) AS bronze, "
                " COUNT(*) FILTER (WHERE COALESCE(spend,0) BETWEEN 50000 AND 149999) AS silver, "
                " COUNT(*) FILTER (WHERE COALESCE(spend,0) BETWEEN 150000 AND 299999) AS gold, "
                " COUNT(*) FILTER (WHERE COALESCE(spend,0) >= 300000) AS vip, "
                " COUNT(*) FILTER (WHERE lod " + _ISO +
                "   AND (CURRENT_DATE - lod::date) BETWEEN 180 AND 540 "
                "   AND COALESCE(orders,0) >= 2) AS at_risk FROM c") or {}
            kpis["total_customers"] = _int(r.get("total"))
            kpis["vip_customers"] = _int(r.get("vip"))
            kpis["at_risk_customers"] = _int(r.get("at_risk"))
            tier_distribution = {
                "Bronze": _int(r.get("bronze")), "Silver": _int(r.get("silver")),
                "Gold": _int(r.get("gold")), "VIP": _int(r.get("vip")),
            }
        except Exception:
            pass

        # New customers (first-ever sale) in last 30d vs prior 30d ------------ #
        try:
            r = _q1(
                "WITH firsts AS (SELECT s.customer_id, MIN(s.sale_date::date) AS fs "
                " FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
                "   AND s.customer_id IS NOT NULL GROUP BY s.customer_id) "
                "SELECT COUNT(*) FILTER (WHERE fs >= CURRENT_DATE - 30) AS cur, "
                " COUNT(*) FILTER (WHERE fs >= CURRENT_DATE - 60 AND fs < CURRENT_DATE - 30) AS prev "
                "FROM firsts") or {}
            kpis["new_customers_30d"] = _int(r.get("cur"))
            kpis["new_customers_delta_pct"] = _pct(r.get("cur"), r.get("prev"))
        except Exception:
            pass

        # Active customers + avg basket, last 30d vs prior 30d --------------- #
        try:
            r = _q1(
                "SELECT "
                " COUNT(DISTINCT customer_id) FILTER (WHERE sale_date::date >= CURRENT_DATE - 30) AS act_cur, "
                " COUNT(DISTINCT customer_id) FILTER (WHERE sale_date::date >= CURRENT_DATE - 60 "
                "   AND sale_date::date < CURRENT_DATE - 30) AS act_prev, "
                " SUM(total_sales_kes) FILTER (WHERE sale_date::date >= CURRENT_DATE - 30) AS rev_cur, "
                " COUNT(DISTINCT order_id) FILTER (WHERE sale_date::date >= CURRENT_DATE - 30) AS ord_cur, "
                " SUM(total_sales_kes) FILTER (WHERE sale_date::date >= CURRENT_DATE - 60 "
                "   AND sale_date::date < CURRENT_DATE - 30) AS rev_prev, "
                " COUNT(DISTINCT order_id) FILTER (WHERE sale_date::date >= CURRENT_DATE - 60 "
                "   AND sale_date::date < CURRENT_DATE - 30) AS ord_prev "
                "FROM all_sales s WHERE s.sale_date " + _ISO + " AND " + _bf() +
                " AND s.customer_id IS NOT NULL") or {}
            kpis["active_customers_30d"] = _int(r.get("act_cur"))
            kpis["active_customers_delta_pct"] = _pct(r.get("act_cur"), r.get("act_prev"))
            ord_cur = _num(r.get("ord_cur"))
            basket_cur = (_num(r.get("rev_cur")) / ord_cur) if ord_cur > 0 else 0.0
            ord_prev = _num(r.get("ord_prev"))
            basket_prev = (_num(r.get("rev_prev")) / ord_prev) if ord_prev > 0 else 0.0
            kpis["avg_basket_kes"] = round(basket_cur, 2)
            kpis["avg_basket_delta_pct"] = _pct(basket_cur, basket_prev)
        except Exception:
            pass

        # Messages sent (CRM interactions) last 30d vs prior 30d ------------- #
        try:
            r = _one(
                "SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS cur, "
                " COUNT(*) FILTER (WHERE created_at >= now() - interval '60 days' "
                "   AND created_at < now() - interval '30 days') AS prev "
                "FROM crm_interactions WHERE type='message'", fetch=True) or {}
            kpis["messages_sent_30d"] = _int(r.get("cur"))
            kpis["messages_delta_pct"] = _pct(r.get("cur"), r.get("prev"))
        except Exception:
            pass

        # Social sentiment (net positive − negative) last 30d --------------- #
        try:
            r = _one(
                "SELECT COUNT(*) AS feedback, "
                " COUNT(*) FILTER (WHERE lower(COALESCE(sentiment,''))='positive') "
                "  - COUNT(*) FILTER (WHERE lower(COALESCE(sentiment,''))='negative') AS net "
                "FROM crm_social_feedback WHERE posted_at >= now() - interval '30 days' "
                " AND type IS DISTINCT FROM 'post'",
                fetch=True) or {}
            kpis["social_feedback_30d"] = _int(r.get("feedback"))
            kpis["social_sentiment_net"] = _int(r.get("net"))
        except Exception:
            pass

        # Derived callouts --------------------------------------------------- #
        try:
            if kpis["new_customers_delta_pct"] is not None and kpis["new_customers_delta_pct"] >= 10:
                callouts.append({"tone": "positive",
                                 "text": f"New customers up {kpis['new_customers_delta_pct']}% vs prior 30 days"})
            elif kpis["new_customers_delta_pct"] is not None and kpis["new_customers_delta_pct"] <= -10:
                callouts.append({"tone": "negative",
                                 "text": f"New customers down {abs(kpis['new_customers_delta_pct'])}% vs prior 30 days"})
            if kpis["at_risk_customers"] > 0:
                callouts.append({"tone": "negative",
                                 "text": f"{_int(kpis['at_risk_customers'])} repeat customers at risk of churn"})
            if kpis["social_sentiment_net"] < 0:
                callouts.append({"tone": "negative",
                                 "text": f"Net social sentiment negative ({kpis['social_sentiment_net']})"})
        except Exception:
            pass

        return {"kpis": kpis, "tier_distribution": tier_distribution, "callouts": callouts}

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
            "WHERE tier='VIP' AND tier_updated_at::date = CURRENT_DATE",
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
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 150000)
        vip = _num(cfg.get("loyalty.tier_vip_kes"), 300000)
        valid_days = int(_num(cfg.get("loyalty.voucher_validity_days"), 90) or 90)
        # Next-tier target for each tier that can still climb.
        _next_target = {
            "Bronze": ("Silver", silver),
            "Silver": ("Gold", gold),
            "Gold": ("VIP", vip),
        }

        # --- Close to upgrade: members in the 70–100% band of their next tier ---
        up_rows = _ex(
            "SELECT e.customer_id, e.tier, COALESCE(m.spend_kes,0) AS spend, "
            + _name_sql("e") + " AS customer_name "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE e.tier IN ('Bronze','Silver','Gold')",
            fetch=True) or []
        up_items, max_needed = [], 0.0
        for r in up_rows:
            nt = _next_target.get(r["tier"])
            if not nt:
                continue
            next_tier, target = nt
            spend = _num(r["spend"])
            if target <= 0 or spend < target * 0.7 or spend >= target:
                continue
            needed = round(max(target - spend, 0), 2)
            max_needed = max(max_needed, needed)
            up_items.append({
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "needed_kes": needed,
                "next_tier": next_tier,
            })
        up_items.sort(key=lambda x: x["needed_kes"])
        close_to_upgrade = {
            "count": len(up_items),
            "within_kes": round(max_needed, 2),
            "top": up_items[:3],
        }

        # --- Demotion risk: Silver/Gold whose enrolment anniversary is within 30
        #     days AND whose spend is below their tier retention floor. ---
        risk_rows = _ex(
            "SELECT e.customer_id, e.tier, e.enrolment_date, "
            " COALESCE(m.spend_kes,0) AS spend, " + _name_sql("e") + " AS customer_name "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE e.tier IN ('Silver','Gold','VIP')", fetch=True) or []
        today = date.today()
        _retain_floor = {"Silver": silver, "Gold": gold, "VIP": vip}

        def _days_to_anniv(enr):
            if not enr:
                return None
            mth, day = enr.month, enr.day
            for yr in (today.year, today.year + 1):
                try:
                    cand = date(yr, mth, day)
                except ValueError:
                    cand = date(yr, 3, 1)  # Feb 29 -> Mar 1
                if cand >= today:
                    return (cand - today).days
            return None

        risk_items = []
        for r in risk_rows:
            spend = _num(r["spend"])
            floor = _retain_floor.get(r["tier"], gold)
            if spend >= floor:
                continue
            dta = _days_to_anniv(r["enrolment_date"])
            if dta is None or dta > 30:
                continue
            risk_items.append({
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "days_to_anniversary": dta,
                "shortfall_kes": round(max(floor - spend, 0), 2),
            })
        risk_items.sort(key=lambda x: x["days_to_anniversary"])
        demotion_risk = {"count": len(risk_items), "top": risk_items[:3]}

        # --- Vouchers expiring within 7 days (expiry derived from issued_at +
        #     the configured validity window, since codes have no expiry column). ---
        exp_rows = _ex(
            "SELECT r.kes_value, r.customer_id, "
            " (r.issued_at + (%s||' days')::interval) AS expires_at, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(cc.first_name,'')||' '||"
            "   COALESCE(cc.last_name,'')),'') FROM crm_customer cc "
            "   WHERE cc.customer_id=r.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM crm_redemptions r "
            "WHERE r.code_status='issued' "
            " AND (r.issued_at + (%s||' days')::interval) "
            "     BETWEEN now() AND now()+interval '7 days' "
            "ORDER BY expires_at ASC",
            (valid_days, valid_days), fetch=True) or []
        vouchers_expiring = {
            "count": len(exp_rows),
            "top": [{
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "amount_kes": round(_num(r["kes_value"]), 2),
                "expires_at": _dt(r["expires_at"]),
            } for r in exp_rows[:3]],
        }

        # --- Voucher activity over the last 30 days ---
        act = _one(
            "SELECT COUNT(*) FILTER (WHERE issued_at>=now()-interval '30 days') AS issued, "
            " COUNT(*) FILTER (WHERE code_status='used' "
            "   AND used_at>=now()-interval '30 days') AS redeemed "
            "FROM crm_redemptions") or {}
        issued = _int(act.get("issued"))
        redeemed = _int(act.get("redeemed"))
        voucher_activity_30d = {
            "issued": issued, "redeemed": redeemed,
            "redemption_rate": round(redeemed / issued * 100, 1) if issued else 0,
        }

        return {
            "close_to_upgrade": close_to_upgrade,
            "demotion_risk": demotion_risk,
            "vouchers_expiring": vouchers_expiring,
            "voucher_activity_30d": voucher_activity_30d,
        }

    @app.get("/api/loyalty/distribution")
    def cl_loy_distribution(request: Request, date_from: str = Query(None),
                            date_to: str = Query(None)):
        _staff(request)
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 150000)
        targets = {
            "dormant": _num(cfg.get("loyalty.target_pct_dormant"), 25),
            "bronze": _num(cfg.get("loyalty.target_pct_bronze"), 55),
            "silver": _num(cfg.get("loyalty.target_pct_silver"), 15),
            "gold": _num(cfg.get("loyalty.target_pct_gold"), 5),
        }
        discounts = {
            "dormant": 0, "bronze": 0,
            "silver": _num(cfg.get("loyalty.discount_silver_pct"), 5),
            "gold": _num(cfg.get("loyalty.discount_gold_pct"), 10),
        }

        def _tier_of(s12):
            if s12 <= 0:
                return "dormant"
            if s12 < silver:
                return "bronze"
            if s12 < gold:
                return "silver"
            return "gold"

        # Classify EVERY customer by rolling-12-month net spend (the cached grid
        # base already aggregates spend_12mo_kes + lifetime sales/orders).
        agg = {t: {"count": 0, "sales": 0.0, "s12": 0.0, "orders": 0}
               for t in ("dormant", "bronze", "silver", "gold")}
        for r in _grid_base():
            s12 = _num(r.get("spend_12mo_kes"))
            a = agg[_tier_of(s12)]
            a["count"] += 1
            a["sales"] += _num(r.get("total_sales"))
            a["s12"] += s12
            a["orders"] += _int(r.get("total_orders"))
        total_members = sum(a["count"] for a in agg.values())

        # Optional sales window: per-tier sales realised inside [date_from,date_to]
        # (tier membership still from rolling-12-month spend, window-independent).
        def _vd(s):
            try:
                datetime.strptime(s, "%Y-%m-%d")
                return True
            except Exception:
                return False

        window_applied = bool(date_from and date_to and _vd(date_from) and _vd(date_to))
        win_sales = {}
        if window_applied:
            wrows = _ex(
                "WITH s12 AS ("
                " SELECT s.customer_id, SUM(s.total_sales_kes::numeric) AS spend12 "
                " FROM all_sales s WHERE s.customer_id IS NOT NULL AND s.customer_id<>'' "
                " AND s.sale_date " + _ISO +
                " AND s.sale_date::date >= CURRENT_DATE - INTERVAL '12 months' AND " +
                A.BASE_FILTERS + " GROUP BY s.customer_id), "
                "win AS ("
                " SELECT s.customer_id, SUM(s.total_sales_kes::numeric) AS wsales "
                " FROM all_sales s WHERE s.customer_id IS NOT NULL AND s.customer_id<>'' "
                " AND s.sale_date " + _ISO +
                " AND s.sale_date::date BETWEEN '" + date_from + "' AND '" + date_to + "' AND " +
                A.BASE_FILTERS + " GROUP BY s.customer_id) "
                "SELECT CASE WHEN COALESCE(s.spend12,0)<=0 THEN 'dormant' "
                " WHEN s.spend12 < " + str(silver) + " THEN 'bronze' "
                " WHEN s.spend12 < " + str(gold) + " THEN 'silver' ELSE 'gold' END AS tier, "
                " COALESCE(SUM(w.wsales),0) AS wsales "
                "FROM win w LEFT JOIN s12 s ON s.customer_id=w.customer_id GROUP BY 1",
                fetch=True) or []
            win_sales = {str(r["tier"]): _num(r["wsales"]) for r in wrows}

        tiers = []
        for t in ("dormant", "bronze", "silver", "gold"):
            a = agg[t]
            cnt = a["count"]
            s12sum = round(a["s12"], 2)
            disc = discounts[t]
            tiers.append({
                "tier": t,
                "count": cnt,
                "percent": round(cnt / total_members * 100, 1) if total_members else 0,
                "target_percent": round(targets[t], 1),
                "total_sales_kes": round(win_sales.get(t, 0) if window_applied else a["sales"], 2),
                "total_12mo_sales_kes": s12sum,
                "aov_kes": round(a["sales"] / a["orders"], 2) if a["orders"] else 0,
                "frequency": round(a["orders"] / cnt, 2) if cnt else 0,
                "discount_pct": disc,
                "estimated_discount_kes_12mo": round(s12sum * disc / 100, 2),
            })
        return {"total_members": total_members, "window_applied": window_applied,
                "tiers": tiers}

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
                "gold": {"min_spend": _int(cfg.get("loyalty.tier_gold_kes"), 150000)},
                "vip": {"min_spend": _int(cfg.get("loyalty.tier_vip_kes"), 300000)},
            },
            "earn_multipliers": {
                "bronze": _num(cfg.get("loyalty.earn_multiplier_bronze"), 1),
                "silver": _num(cfg.get("loyalty.earn_multiplier_silver"), 2),
                "gold": _num(cfg.get("loyalty.earn_multiplier_gold"), 3),
                "vip": _num(cfg.get("loyalty.earn_multiplier_vip"), 4),
            },
            "qualify": {
                "silver": _int(cfg.get("loyalty.tier_silver_kes"), 50000),
                "gold": _int(cfg.get("loyalty.tier_gold_kes"), 150000),
                "vip": _int(cfg.get("loyalty.tier_vip_kes"), 300000),
            },
            "retain": {
                "silver": _int(cfg.get("loyalty.retain_silver_kes"), 40000),
                "gold": _int(cfg.get("loyalty.retain_gold_kes"), 80000),
                "vip": _int(cfg.get("loyalty.retain_vip_kes"), 240000),
            },
            "voucher_kes": {
                "bronze": _int(cfg.get("loyalty.voucher_bronze_kes"), 2500),
                "silver": _int(cfg.get("loyalty.voucher_silver_kes"), 5000),
                "gold": _int(cfg.get("loyalty.voucher_gold_kes"), 10000),
                "vip": _int(cfg.get("loyalty.voucher_vip_kes"), 20000),
            },
        }

    @app.put("/api/loyalty/config")
    def cl_loy_config_put(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("admin",))
        p = payload or {}

        def _set(ck, val):
            if val is None or val == "":
                return
            _ex("INSERT INTO crm_config (key,value) VALUES (%s,%s) "
                "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
                (ck, str(val)))

        flat = {
            "earn_rate_kes": "loyalty.earn_rate_kes",
            "point_value_kes": "loyalty.point_value_kes",
            "points_expiry_months": "loyalty.points_expiry_months",
            "voucher_validity_days": "loyalty.voucher_validity_days",
            "grace_period_days": "loyalty.grace_period_days",
        }
        for k, ck in flat.items():
            if k in p:
                _set(ck, p[k])
        # Nested tier-scoped config (qualify thresholds, retention floors,
        # birthday-voucher amounts, earn multipliers) — all four tiers.
        q = p.get("qualify") or {}
        _set("loyalty.tier_silver_kes", q.get("silver"))
        _set("loyalty.tier_gold_kes", q.get("gold"))
        _set("loyalty.tier_vip_kes", q.get("vip"))
        rt = p.get("retain") or {}
        _set("loyalty.retain_silver_kes", rt.get("silver"))
        _set("loyalty.retain_gold_kes", rt.get("gold"))
        _set("loyalty.retain_vip_kes", rt.get("vip"))
        vk = p.get("voucher_kes") or {}
        _set("loyalty.voucher_bronze_kes", vk.get("bronze"))
        _set("loyalty.voucher_silver_kes", vk.get("silver"))
        _set("loyalty.voucher_gold_kes", vk.get("gold"))
        _set("loyalty.voucher_vip_kes", vk.get("vip"))
        em = p.get("earn_multipliers") or {}
        _set("loyalty.earn_multiplier_bronze", em.get("bronze"))
        _set("loyalty.earn_multiplier_silver", em.get("silver"))
        _set("loyalty.earn_multiplier_gold", em.get("gold"))
        _set("loyalty.earn_multiplier_vip", em.get("vip"))
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
    def cl_loy_anniv(request: Request, limit: int = Query(50),
                     within_days: int = Query(30)):
        _staff(request)
        lim = _clamp(limit, 1, 300, 50)
        wd = _clamp(within_days, 1, 366, 30)
        cfg = A._crm_config_dict()
        retain = {"Silver": _num(cfg.get("loyalty.retain_silver_kes"), 40000),
                  "Gold": _num(cfg.get("loyalty.retain_gold_kes"), 80000),
                  "VIP": _num(cfg.get("loyalty.retain_vip_kes"), 240000)}
        rows = _ex(
            "SELECT e.customer_id, e.enrolment_date, e.tier, "
            " COALESCE(m.spend_kes,0) AS spend, " + _name_sql("e") + " AS customer_name "
            "FROM crm_loyalty_enrolment e "
            "LEFT JOIN crm_loyalty_member m ON m.member_id=e.customer_id "
            "WHERE e.tier IN ('Silver','Gold','VIP')", fetch=True) or []
        today = date.today()

        def _dta(enr):
            if not enr:
                return None
            for yr in (today.year, today.year + 1):
                try:
                    cand = date(yr, enr.month, enr.day)
                except ValueError:
                    cand = date(yr, enr.month, 28)
                if cand >= today:
                    return (cand - today).days
            return None

        out = []
        for r in rows:
            dta = _dta(r["enrolment_date"])
            if dta is None or dta > wd:
                continue
            spend = _num(r["spend"])
            req = retain.get(r["tier"], 0)
            out.append({
                "customer_id": r["customer_id"], "customer_name": r["customer_name"],
                "loyalty_tier": str(r["tier"]).lower(),
                "spend_12mo_kes": round(spend, 2),
                "retention": {"required_kes": round(req, 2),
                              "shortfall_kes": round(max(req - spend, 0), 2)},
                "days_to_anniversary": dta,
                "demotion_risk": spend < req,
            })
        out.sort(key=lambda x: x["days_to_anniversary"])
        return out[:lim]

    @app.get("/api/loyalty/approaching-upgrade")
    def cl_loy_approaching(request: Request, limit: int = Query(50),
                           within_kes: float = Query(50000)):
        _staff(request)
        lim = _clamp(limit, 1, 300, 50)
        try:
            within = float(within_kes)
        except (TypeError, ValueError):
            within = 50000.0
        if within <= 0:
            within = 50000.0
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 150000)
        out = []
        for r in _grid_base():
            s12 = _num(r.get("spend_12mo_kes"))
            if s12 <= 0:
                continue
            if s12 < silver:
                target, cur, nxt = silver, "bronze", "silver"
            elif s12 < gold:
                target, cur, nxt = gold, "silver", "gold"
            else:
                continue
            needed = target - s12
            if needed <= 0 or needed > within:
                continue
            out.append({
                "customer_id": r["customer_id"],
                "customer_name": r.get("customer_name"),
                "city": r.get("city"),
                "loyalty_tier": cur, "next_tier": nxt,
                "needed_kes": round(needed, 2),
                "percent": int(min(s12 / target * 100, 100)) if target else 0,
            })
        out.sort(key=lambda x: x["needed_kes"])
        return out[:lim]

    @app.get("/api/loyalty/audit")
    def cl_loy_audit(request: Request, limit: int = Query(100),
                     offset: int = Query(0)):
        _staff(request)
        lim = _clamp(limit, 1, 500, 100)
        off = _clamp(offset, 0, 100000, 0)
        total = _int((_one(
            "SELECT COUNT(*) AS n FROM crm_audit "
            "WHERE entity IN ('loyalty','redemption')") or {}).get("n"))
        rows = _ex(
            "SELECT id, entity, entity_id, action, detail, user_name, created_at "
            "FROM crm_audit WHERE entity IN ('loyalty','redemption') "
            "ORDER BY created_at DESC LIMIT %s OFFSET %s", (lim, off), fetch=True) or []
        out = [{
            "audit_id": str(r["id"]), "action": r["action"], "data": r["detail"],
            "customer_id": r["entity_id"], "user_name": r["user_name"],
            "at": _dt(r["created_at"]),
        } for r in rows]
        return {"rows": out, "total": total}

    @app.get("/api/loyalty/vouchers")
    def cl_loy_vouchers(request: Request, limit: int = Query(100),
                        offset: int = Query(0)):
        _staff(request)
        lim = _clamp(limit, 1, 500, 100)
        off = _clamp(offset, 0, 100000, 0)
        cfg = A._crm_config_dict()
        valid_days = int(_num(cfg.get("loyalty.voucher_validity_days"), 90) or 90)
        total = _int((_one("SELECT COUNT(*) AS n FROM crm_redemptions") or {}).get("n"))
        rows = _ex(
            "SELECT r.id, r.customer_id, r.discount_code, r.kes_value, r.points_redeemed, "
            " r.code_status, r.issued_at, r.used_at, "
            " (r.issued_at + (%s||' days')::interval) AS expires_at, "
            " COALESCE(le.tier,'Bronze') AS tier_at_issue, "
            " COALESCE((SELECT NULLIF(TRIM(COALESCE(cc.first_name,'')||' '||"
            "   COALESCE(cc.last_name,'')),'') FROM crm_customer cc "
            "   WHERE cc.customer_id=r.customer_id LIMIT 1),'Guest') AS customer_name "
            "FROM crm_redemptions r "
            "LEFT JOIN crm_loyalty_enrolment le ON le.customer_id=r.customer_id "
            "ORDER BY r.issued_at DESC LIMIT %s OFFSET %s",
            (valid_days, lim, off), fetch=True) or []
        now = datetime.now()

        def _status(cs, exp):
            if cs == "used":
                return "redeemed"
            if exp is not None:
                ref = now.replace(tzinfo=exp.tzinfo) if exp.tzinfo else now
                if exp < ref:
                    return "expired"
            return cs or "issued"

        out = []
        for r in rows:
            exp = r["expires_at"]
            out.append({
                "voucher_id": str(r["id"]), "customer_id": r["customer_id"],
                "customer_name": r["customer_name"], "code": r["discount_code"],
                "tier_at_issue": str(r["tier_at_issue"]).lower(),
                "amount_kes": round(_num(r["kes_value"]), 2),
                "points_redeemed": _int(r["points_redeemed"]),
                "reason": "Points redemption",
                "status": _status(r["code_status"], exp),
                "issued_at": _dt(r["issued_at"]),
                "expires_at": _dt(exp),
                "used_at": _dt(r["used_at"]),
            })
        return {"total": total, "rows": out}

    @app.get("/api/loyalty/voucher-cost")
    def cl_loy_voucher_cost(request: Request, date_from: str = Query(None),
                            date_to: str = Query(None),
                            redemption_rate: float = Query(0.5)):
        _staff(request)
        cfg = A._crm_config_dict()
        silver = _num(cfg.get("loyalty.tier_silver_kes"), 50000)
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 150000)
        vkes = {"bronze": _num(cfg.get("loyalty.voucher_bronze_kes"), 2500),
                "silver": _num(cfg.get("loyalty.voucher_silver_kes"), 5000),
                "gold": _num(cfg.get("loyalty.voucher_gold_kes"), 10000)}
        try:
            rr = float(redemption_rate)
        except (TypeError, ValueError):
            rr = 0.5
        rr = max(0.0, min(1.0, rr))

        def _vd(s):
            try:
                return datetime.strptime(s, "%Y-%m-%d").date()
            except Exception:
                return None

        df = (_vd(date_from) if date_from else None) or date.today()
        dt = (_vd(date_to) if date_to else None) or (date.today() + timedelta(days=30))
        if dt < df:
            df = date.today()
            dt = df + timedelta(days=30)
        days_in_window = (dt - df).days + 1
        mmdd = {(df + timedelta(days=i)).strftime("%m-%d")
                for i in range(min(days_in_window, 366))}

        # A customer's "birthday" = the anniversary of their FIRST-EVER purchase
        # (all_customers.first_order_date). Tier from rolling-12mo net spend;
        # dormant customers (no spend in the last 12 months) fall into bronze.
        # all_customers is keyed by customer_id+store_id, so collapse to one row
        # per customer (earliest first_order_date) before matching the window.
        in_list = ",".join("'" + m + "'" for m in sorted(mmdd))
        gold_l = repr(float(gold))
        silver_l = repr(float(silver))
        agg = {"bronze": 0, "silver": 0, "gold": 0}
        if in_list:
            sql = (
                "WITH cust AS ("
                "  SELECT customer_id, MIN(first_order_date) AS fod "
                "  FROM all_customers WHERE first_order_date " + _ISO +
                "  GROUP BY customer_id"
                "), spend AS ("
                "  SELECT s.customer_id, SUM(s.total_sales_kes::numeric) AS spend12 "
                "  FROM all_sales s WHERE s.sale_date " + _ISO +
                "   AND s.sale_date::date >= CURRENT_DATE - INTERVAL '12 months' AND " +
                A.BASE_FILTERS +
                "  GROUP BY s.customer_id"
                ") "
                "SELECT CASE "
                "  WHEN COALESCE(sp.spend12,0) >= " + gold_l + " THEN 'gold' "
                "  WHEN COALESCE(sp.spend12,0) >= " + silver_l + " THEN 'silver' "
                "  ELSE 'bronze' END AS tier, COUNT(*) AS cnt "
                "FROM cust c LEFT JOIN spend sp ON sp.customer_id = c.customer_id "
                # Feb-29 anniversaries observe Feb-28 so they are not dropped in
                # non-leap-year windows (standard birthday-observed policy).
                "WHERE (CASE WHEN to_char(c.fod::date, 'MM-DD') = '02-29' "
                "  THEN '02-28' ELSE to_char(c.fod::date, 'MM-DD') END) "
                "  IN (" + in_list + ") "
                "GROUP BY 1"
            )
            for r in (_ex(sql, fetch=True) or []):
                t = str(r["tier"])
                if t in agg:
                    agg[t] = _int(r["cnt"])

        tiers = []
        gross_total = exp_total = 0.0
        cnt_total = 0
        for t in ("bronze", "silver", "gold"):
            cnt = agg[t]
            gross = cnt * vkes[t]
            exp = gross * rr
            gross_total += gross
            exp_total += exp
            cnt_total += cnt
            tiers.append({"tier": t, "count": cnt, "voucher_kes": round(vkes[t], 2),
                          "gross_cost_kes": round(gross, 2),
                          "expected_cost_kes": round(exp, 2)})
        return {
            "tiers": tiers, "days_in_window": days_in_window,
            "totals": {"count": cnt_total, "gross_cost_kes": round(gross_total, 2),
                       "expected_cost_kes": round(exp_total, 2)},
        }

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
        gold = _num(cfg.get("loyalty.tier_gold_kes"), 150000)
        vip = _num(cfg.get("loyalty.tier_vip_kes"), 300000)
        spend = _num(e["spend"])
        _nt = {"Bronze": ("Silver", silver), "Silver": ("Gold", gold),
               "Gold": ("VIP", vip)}
        nt = _nt.get(e["tier"])
        if not nt:  # VIP (top tier) or unknown
            progress = {"next_tier": None, "percent": 100}
        else:
            next_tier, target = nt
            progress = {"next_tier": next_tier,
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
            "styling": {"remaining": 1 if e["tier"] in ("Silver", "Gold", "VIP") else 0},
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
            "loyalty_tiers": ["Bronze", "Silver", "Gold", "VIP"],
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        f = _safe_date(date_from, _ago(30))
        t = _safe_date(date_to, _today())
        agg = _one(
            "SELECT COUNT(*) AS feedback, "
            " COUNT(*) FILTER (WHERE customer_id IS NULL) AS unmatched, "
            " COUNT(*) FILTER (WHERE sentiment IS NOT NULL) AS classified, "
            " COUNT(*) FILTER (WHERE sentiment='positive') AS pos, "
            " COUNT(*) FILTER (WHERE sentiment='neutral') AS neu, "
            " COUNT(*) FILTER (WHERE sentiment='negative') AS neg "
            "FROM crm_social_feedback WHERE posted_at::date BETWEEN %s AND %s "
            " AND type IS DISTINCT FROM 'post'",
            (f, t)) or {}
        by = _ex(
            "SELECT COALESCE(platform,'other') AS platform, COUNT(*) AS feedback, "
            " COUNT(*) FILTER (WHERE sentiment='positive') AS positive "
            "FROM crm_social_feedback WHERE posted_at::date BETWEEN %s AND %s "
            " AND type IS DISTINCT FROM 'post' "
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        f = _safe_date(date_from, _ago(30))
        t = _safe_date(date_to, _today())
        lim = _clamp(limit, 1, 200, 50)
        rows = _ex(
            "SELECT id, platform, author_handle, author_name, body, sentiment, "
            " posted_at FROM crm_social_feedback "
            "WHERE posted_at::date BETWEEN %s AND %s AND type IS DISTINCT FROM 'post' "
            "ORDER BY posted_at DESC LIMIT %s",
            (f, t, lim), fetch=True) or []
        return [{
            "feedback_id": str(r["id"]), "platform": r["platform"],
            "author_handle": r["author_handle"], "author_name": r["author_name"],
            "body": r["body"], "sentiment": r["sentiment"],
            "posted_at": _dt(r["posted_at"]),
        } for r in rows]

    @app.get("/api/social/influencers")
    def cl_soc_influencers(request: Request, limit: int = Query(15)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        lim = _clamp(limit, 1, 100, 15)
        rows = _ex(
            "SELECT COALESCE(author_handle,author_name,'unknown') AS handle, "
            " MAX(author_name) AS name, COUNT(*) AS feedback_count, "
            " array_agg(DISTINCT platform) AS platforms "
            "FROM crm_social_feedback WHERE type IS DISTINCT FROM 'post' "
            "GROUP BY 1 ORDER BY feedback_count DESC LIMIT %s",
            (lim,), fetch=True) or []
        return [{
            "handle": r["handle"], "name": r["name"],
            "platforms": [p for p in (r["platforms"] or []) if p],
            "feedback_count": _int(r["feedback_count"]),
            "engagement": _int(r["feedback_count"]), "sentiment_score": 0.0,
        } for r in rows]

    @app.get("/api/social/platforms/status")
    def cl_soc_platforms_status(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        return {"status": "unavailable", "platform": platform,
                "note": "Connect this platform from workspace secrets."}

    @app.delete("/api/social/platforms/{platform}")
    def cl_soc_platform_disconnect(request: Request, platform: str):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        return {"ok": True, "platform": platform, "status": "disconnected"}

    @app.get("/api/social/handles/{cid}")
    def cl_soc_handles(request: Request, cid: str):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        rows = _ex(
            "SELECT platform, handle, added_at FROM crm_social_handle "
            "WHERE customer_id=%s ORDER BY platform", (cid,), fetch=True) or []
        return [{"platform": r["platform"], "handle": r["handle"],
                 "added_at": _dt(r["added_at"])} for r in rows]

    @app.post("/api/social/handles/{cid}")
    def cl_soc_handle_add(request: Request, cid: str,
                          payload: dict = Body(default=None)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        _ex("DELETE FROM crm_social_handle WHERE customer_id=%s AND platform=%s",
            (cid, platform.lower()))
        return {"ok": True}

    @app.get("/api/social/timeline/{cid}")
    def cl_soc_timeline(request: Request, cid: str):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
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
                        type: str = Query(None), limit: int = Query(100)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        # Cap high enough that a deep-synced page (2000 posts + 2000 comments)
        # is fully visible in the inbox.
        lim = _clamp(limit, 1, 5000, 100)
        conds, params = ["1=1"], []
        if platform:
            conds.append("platform=%s")
            params.append(platform)
        if type in ("post", "comment", "mention", "dm", "review"):
            conds.append("type=%s")
            params.append(type)
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
            " themes, customer_id, reply_body, replied_at, posted_at, "
            " permalink, parent_source_id, parent_excerpt "
            "FROM crm_social_feedback WHERE " + " AND ".join(conds) +
            " ORDER BY posted_at DESC LIMIT %s", tuple(params), fetch=True) or []
        return [{
            "feedback_id": str(r["id"]), "platform": r["platform"], "type": r["type"],
            "author_name": r["author_name"], "author_handle": r["author_handle"],
            "body": r["body"], "sentiment": r["sentiment"], "themes": r["themes"] or [],
            "customer_id": r["customer_id"], "reply_body": r["reply_body"],
            "replied_at": _dt(r["replied_at"]), "posted_at": _dt(r["posted_at"]),
            "permalink": r.get("permalink"),
            "parent_source_id": r.get("parent_source_id"),
            "parent_excerpt": r.get("parent_excerpt"),
        } for r in rows]

    @app.post("/api/social/feedback")
    def cl_soc_feedback_add(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        cid = (payload or {}).get("customer_id")
        _ex("UPDATE crm_social_feedback SET customer_id=%s WHERE id=%s",
            (cid, _int(fid)))
        return {"ok": True}

    @app.post("/api/social/feedback/{fid}/reply")
    def cl_soc_feedback_reply(request: Request, fid: str,
                              payload: dict = Body(default=None)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        body = (payload or {}).get("body") or ""
        row = _one("SELECT id, platform, type, author_handle, source_id "
                   "FROM crm_social_feedback WHERE id=%s", (_int(fid),))
        if not row:
            raise HTTPException(404, "Feedback item not found.")
        delivered = False
        delivery_channel = None
        if row.get("type") == "comment" and row.get("platform") == "instagram":
            # An Instagram comment reply is DELIVERED via the Graph API comment
            # reply edge (POST /{comment-id}/replies), not just logged. The IG
            # comment id lives in source_id as "ig:<comment-id>".
            sid = (row.get("source_id") or "")
            cmt_id = sid[3:] if sid.startswith("ig:") else ""
            if not cmt_id:
                raise HTTPException(
                    400, "This comment has no Instagram reference to reply to "
                         "(re-run the Instagram sync).")
            if not A._fb_configured():
                raise HTTPException(400, "Instagram is not configured on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                A._fb_post(f"{cmt_id}/replies", {"message": body.strip()})
                delivered = True
                delivery_channel = "Instagram"
            except Exception as e:
                # Surface the real Graph error instead of a silent failure.
                raise HTTPException(502, f"Instagram rejected the reply: {e}")
        elif row.get("type") == "comment" and row.get("platform") == "facebook":
            # A Facebook comment reply is DELIVERED via the Graph API comment
            # edge (POST /{comment-id}/comments), not just logged. The FB comment
            # id lives in source_id as "fb:<comment-id>".
            sid = (row.get("source_id") or "")
            cmt_id = sid[3:] if sid.startswith("fb:") else ""
            if not cmt_id:
                raise HTTPException(
                    400, "This comment has no Facebook reference to reply to "
                         "(re-run the Facebook sync).")
            if not A._fb_configured():
                raise HTTPException(400, "Facebook is not configured on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                A._fb_post(f"{cmt_id}/comments", {"message": body.strip()})
                delivered = True
                delivery_channel = "Facebook"
            except Exception as e:
                # Surface the real Graph error instead of a silent failure.
                raise HTTPException(502, f"Facebook rejected the reply: {e}")
        elif row.get("type") == "dm" and row.get("platform") == "facebook":
            # A Facebook DM reply is DELIVERED via Messenger (Send API), not
            # just logged. author_handle holds the sender's page-scoped id.
            psid = (row.get("author_handle") or "").strip()
            if not psid:
                raise HTTPException(
                    400, "This DM has no sender reference to reply to "
                         "(re-run the Facebook sync).")
            if not A._fb_configured():
                raise HTTPException(400, "Facebook is not configured on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                A._fb_post(f"{A._fb_page_id()}/messages", {
                    "recipient": json.dumps({"id": psid}),
                    "messaging_type": "RESPONSE",
                    "message": json.dumps({"text": body.strip()}),
                })
                delivered = True
                delivery_channel = "Messenger"
            except Exception as e:
                # Surface the real Graph error — e.g. the 24-hour messaging
                # window has closed — instead of a silent failure.
                raise HTTPException(502, f"Facebook rejected the reply: {e}")
        elif row.get("type") == "dm" and row.get("platform") == "instagram":
            # An Instagram Direct reply is DELIVERED via the same Send API the
            # linked Facebook Page uses (POST /{page-id}/messages), addressed to
            # the sender's Instagram-scoped id (IGSID) held in author_handle.
            igsid = (row.get("author_handle") or "").strip()
            if not igsid:
                raise HTTPException(
                    400, "This DM has no sender reference to reply to "
                         "(re-run the Instagram sync).")
            if not A._fb_configured():
                raise HTTPException(400, "Instagram is not configured on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                A._fb_post(f"{A._fb_page_id()}/messages", {
                    "recipient": json.dumps({"id": igsid}),
                    "messaging_type": "RESPONSE",
                    "message": json.dumps({"text": body.strip()}),
                })
                delivered = True
                delivery_channel = "Instagram Direct"
            except Exception as e:
                # Surface the real Graph error — e.g. the 24-hour messaging
                # window has closed — instead of a silent failure.
                raise HTTPException(502, f"Instagram rejected the reply: {e}")
        elif row.get("platform") == "x" and row.get("type") in ("mention", "post"):
            # An X reply is DELIVERED as a tweet in reply to the target tweet
            # (POST /2/tweets with reply.in_reply_to_tweet_id), signed with the
            # OAuth 1.0a user context. The target tweet id lives in source_id as
            # "xmention:<id>" (a mention/reply) or "xpost:<id>" (our own tweet).
            sid = (row.get("source_id") or "")
            tweet_id = ""
            if sid.startswith("xmention:"):
                tweet_id = sid[len("xmention:"):]
            elif sid.startswith("xpost:"):
                tweet_id = sid[len("xpost:"):]
            if not tweet_id:
                raise HTTPException(
                    400, "This item has no X tweet reference to reply to "
                         "(re-run the X sync).")
            if not _x_write_configured():
                raise HTTPException(
                    400, "Replying on X requires OAuth 1.0a credentials "
                         "(X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / "
                         "X_ACCESS_TOKEN_SECRET) on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                _x_oauth1_post("/2/tweets", {
                    "text": body.strip(),
                    "reply": {"in_reply_to_tweet_id": str(tweet_id)},
                })
                delivered = True
                delivery_channel = "X"
            except Exception as e:
                raise HTTPException(502, f"X rejected the reply: {e}")
        elif row.get("platform") == "x" and row.get("type") == "dm":
            # An X DM reply is DELIVERED via the Direct Messages API
            # (POST /2/dm_conversations/with/{participant_id}/messages) using the
            # OAuth 1.0a user context. author_handle holds the sender's user id.
            participant = (row.get("author_handle") or "").strip()
            if not participant:
                raise HTTPException(
                    400, "This DM has no sender reference to reply to "
                         "(re-run the X sync).")
            if not _x_write_configured():
                raise HTTPException(
                    400, "Replying to X DMs requires OAuth 1.0a credentials "
                         "on the server.")
            if not body.strip():
                raise HTTPException(400, "Reply text is empty.")
            try:
                _x_oauth1_post(
                    f"/2/dm_conversations/with/{participant}/messages",
                    {"text": body.strip()})
                delivered = True
                delivery_channel = "X Direct"
            except Exception as e:
                raise HTTPException(502, f"X rejected the reply: {e}")
        _ex("UPDATE crm_social_feedback SET reply_body=%s, replied_at=now() WHERE id=%s",
            (body, _int(fid)))
        A._crm_audit("social", fid, "reply",
                     (f"reply delivered to {delivery_channel}" if delivered
                      else "reply logged (not delivered)"), request)
        return {"feedback_id": fid, "reply_body": body, "replied_at": _today(),
                "delivered": delivered, "delivery_channel": delivery_channel}

    @app.get("/api/social/auto-tasks")
    def cl_soc_auto_tasks(request: Request, include_completed: bool = Query(False)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        return []

    @app.get("/api/social/auto-tasks/kpi")
    def cl_soc_auto_tasks_kpi(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        return {"open": 0, "completed_14d": 0, "top_themes": []}

    @app.post("/api/social/auto-tasks/run")
    def cl_soc_auto_tasks_run(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        return {"already_run": False, "tasks_created": 0, "themes": []}

    @app.post("/api/social/classify-pending")
    def cl_soc_classify_pending(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        rows = _ex(
            "SELECT id, body FROM crm_social_feedback WHERE sentiment IS NULL LIMIT 50",
            fetch=True) or []
        classified = 0
        for r in rows:
            s = _quick_sentiment(r["body"])
            _ex("UPDATE crm_social_feedback SET sentiment=%s WHERE id=%s", (s, r["id"]))
            classified += 1
        return {"classified": classified}

    # ----- Live Facebook wiring -------------------------------------------- #
    # The server already holds a long-lived Page token (secrets), resolved by
    # api_pg's _fb_* helpers. We auto-report that configured Page as "connected"
    # (no user token to paste) and pull its real posts + comments into
    # crm_social_feedback so this inbox shows live data instead of demo rows.

    def _cfg_get(key):
        r = _one("SELECT value FROM crm_config WHERE key=%s", (key,))
        return r["value"] if r else None

    def _cfg_set(key, val):
        _ex("INSERT INTO crm_config (key,value) VALUES (%s,%s) "
            "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
            (key, str(val)))

    def _fb_ts(s):
        if not s:
            return None
        from datetime import datetime
        try:
            return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z")
        except Exception:
            return None

    @app.get("/api/social/facebook/status")
    def cl_soc_fb_status(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        empty = {"discovered_pages": [], "last_synced_at": None,
                 "auto_sync_minutes": 15,
                 "counts": {"real_posts": 0, "real_feedback": 0}}
        if not A._fb_configured():
            return empty
        try:
            page = A._fb_get(A._fb_page_id(), {"fields": "name"})
        except Exception:
            return empty  # token invalid/unreachable -> show connect banner
        agg = _one("SELECT count(*) AS feedback, "
                   " count(*) FILTER (WHERE type='dm') AS dms "
                   "FROM crm_social_feedback WHERE platform='facebook'") or {}
        posts_n = _int(_cfg_get("social.fb.last_sync_posts"), 0)
        comments_n = _int(_cfg_get("social.fb.last_sync_comments"), 0)
        dms_n = _int(_cfg_get("social.fb.last_sync_dms"), 0)
        scopes = [s for s in (_cfg_get("social.fb.last_scopes_missing") or "").split(",") if s]
        last_at = _cfg_get("social.fb.last_synced_at")
        run_error = (_cfg_get("social.fb.last_run_error") or "").strip()
        return {
            # True only while a sync holds the lock AND its recorded start is
            # still within the budget window — a wedged/stale lock reads as idle
            # so the banner clears instead of showing "syncing…" forever.
            "running": _fb_sync_running(),
            "discovered_pages": [{
                "page_id": A._fb_page_id(),
                "page_name": page.get("name") or "Facebook Page",
                "last_sync_posts": posts_n,
                "last_sync_comments": comments_n,
                "last_sync_dms": dms_n,
                "last_sync_scopes_missing": scopes,
            }],
            "last_synced_at": last_at or None,
            "auto_sync_minutes": None,
            "last_run_error": run_error or None,
            "counts": {"real_posts": posts_n,
                       "real_feedback": _int(agg.get("feedback"), 0),
                       "real_dms": _int(agg.get("dms"), 0)},
        }

    @app.post("/api/social/facebook/discover")
    def cl_soc_fb_discover(request: Request, payload: dict = Body(default=None)):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        # The Page is connected server-side via secrets; a pasted user token is
        # not required. Report the configured Page as discovered when reachable.
        if not A._fb_configured():
            raise HTTPException(400, "Facebook is not configured on the server.")
        try:
            A._fb_get(A._fb_page_id(), {"fields": "name"})
        except Exception as e:
            raise HTTPException(502, f"Facebook connection failed: {e}")
        return {"discovered": 1}

    @app.get("/api/social/facebook/pages")
    def cl_soc_fb_pages(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        if not A._fb_configured():
            return []
        try:
            page = A._fb_get(A._fb_page_id(), {"fields": "name"})
        except Exception:
            return []
        return [{"page_id": A._fb_page_id(),
                 "page_name": page.get("name") or "Facebook Page"}]

    @app.delete("/api/social/facebook/pages/{page_id}")
    def cl_soc_fb_page_del(request: Request, page_id: str):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        # The Page comes from server secrets, not a stored connection, so there
        # is nothing to disconnect here; clear cached sync metadata only.
        for k in ("social.fb.last_sync_posts", "social.fb.last_sync_comments",
                  "social.fb.last_sync_dms", "social.fb.last_scopes_missing"):
            _ex("DELETE FROM crm_config WHERE key=%s", (k,))
        return {"ok": True, "page_id": page_id}

    # Deep-sync targets: walk the page's history until at least this many posts
    # and comments have been pulled (or the page runs out / time budget hits).
    _FB_SYNC_POST_TARGET = 2000
    _FB_SYNC_COMMENT_TARGET = 2000
    _FB_SYNC_DM_TARGET = 2000
    _FB_SYNC_TIME_BUDGET_SEC = 240  # hard stop so the HTTP request can't hang forever
    # Reserved tail of the per-run budget guaranteed to the DM phase. The
    # posts/comments phases stop at the *soft* budget (hard − reserve) so the DM
    # phase always gets real processing time, even while the posts/comments
    # backfill is still running (otherwise DMs — which run last — are starved
    # forever and never ingest a single conversation on a fresh prod DB).
    _FB_SYNC_DM_RESERVE_SEC = 75
    # Staleness guard (mirrors the IG engine): a sync should finish within the
    # time budget. If the in-process lock is still held but the recorded start is
    # older than the budget plus this margin, the run is considered wedged/dead —
    # the lock reads as "not running" so a new sync can take over and the banner
    # clears instead of showing "syncing…" forever. The margin covers a request
    # in flight past the last budget check (each Graph call is bounded at 30s)
    # plus scheduling/finalisation overhead.
    _FB_SYNC_STALE_MARGIN_SEC = 120
    # Only one sync may run at a time: concurrent runs would race the persisted
    # deep-backfill cursor (data stays safe via source_id dedup, but progress
    # gets noisy and Graph/LLM work is duplicated). The lock lives inside a
    # mutable holder so a stale run can be abandoned by swapping in a fresh lock
    # (the zombie thread keeps its OWN old lock object and its finally-release
    # can never unlock the new run).
    _fb_sync_state = {"lock": threading.Lock()}

    def _fb_started_stale():
        """True when the recorded sync start is older than the time budget +
        margin (or there is no start record while the lock is held)."""
        from datetime import datetime, timezone
        started = (_cfg_get("social.fb.last_started_at") or "").strip()
        if not started:
            return True
        try:
            dt = datetime.fromisoformat(started)
        except Exception:
            return True
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        return age > (_FB_SYNC_TIME_BUDGET_SEC + _FB_SYNC_STALE_MARGIN_SEC)

    def _fb_sync_running():
        """A sync is 'running' only while the lock is held AND the recorded
        start is still within the budget window — a stale lock reads as idle."""
        return _fb_sync_state["lock"].locked() and not _fb_started_stale()

    def _fb_sync_bg(request, lock):
        """Run the (up to 240s) Facebook sync on a background thread so it always
        completes server-side regardless of the HTTP client / proxy timeout. The
        endpoint returns immediately; the status endpoint reports `running` (the
        lock) and the persisted `social.fb.last_*` keys reflect the finished run.
        The lock is released here (NOT in the request handler) because the handler
        returns long before the thread finishes. Each thread releases the SAME
        lock object it was started with — if a stale run was abandoned and a fresh
        lock swapped in, this release can never unlock the newer run."""
        from datetime import datetime, timezone
        try:
            _fb_sync_run(request)
            _cfg_set("social.fb.last_run_error", "")
        except HTTPException as e:
            _cfg_set("social.fb.last_run_error", str(getattr(e, "detail", e))[:500])
        except Exception as e:  # noqa: BLE001 — never let a thread crash silently
            _cfg_set("social.fb.last_run_error", str(e)[:500])
        finally:
            _cfg_set("social.fb.last_finished_at",
                     datetime.now(timezone.utc).isoformat())
            try:
                lock.release()
            except RuntimeError:
                pass  # already released (e.g. abandoned as stale) — harmless

    @app.post("/api/social/facebook/sync")
    def cl_soc_fb_sync(request: Request, payload: dict = Body(default=None)):
        if not _internal_token_ok(request):
            _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        if not A._fb_configured():
            raise HTTPException(400, "Facebook is not configured on the server.")
        from datetime import datetime, timezone
        lock = _fb_sync_state["lock"]
        if not lock.acquire(blocking=False):
            # The lock is held. If the recorded start is stale the previous run
            # is wedged/dead (a hung thread past the budget window) — abandon its
            # lock, install a fresh one and take over so a new sync can proceed.
            # The zombie keeps a reference to the OLD lock object, so its eventual
            # finally-release cannot unlock this new run.
            if not _fb_started_stale():
                raise HTTPException(409, "A Facebook sync is already running.")
            lock = threading.Lock()
            _fb_sync_state["lock"] = lock
            lock.acquire(blocking=False)
        # Kick the work onto a daemon thread and return immediately. The shared
        # proxy/gateway kills a held-open request well before the 240s budget, so
        # a synchronous run was being cut off before the DM phase (which runs last)
        # ever ingested anything. Decoupling lets every phase — including DMs —
        # run to completion. The non-blocking lock above still prevents overlap.
        _cfg_set("social.fb.last_started_at",
                 datetime.now(timezone.utc).isoformat())
        threading.Thread(target=_fb_sync_bg, args=(request, lock),
                         name="fb-sync", daemon=True).start()
        return {"started": True, "running": True}

    def _fb_sync_run(request):
        page_id = A._fb_page_id()
        started = time.monotonic()

        def _over_budget():
            return (time.monotonic() - started) > _FB_SYNC_TIME_BUDGET_SEC

        def _over_content_budget():
            # Soft budget for the non-DM (posts/comments) phases: trips earlier
            # than the hard cap so a guaranteed tail is left for the DM phase.
            return (time.monotonic() - started) > (
                _FB_SYNC_TIME_BUDGET_SEC - _FB_SYNC_DM_RESERVE_SEC)

        # Page name labels the brand's own posts/replies (commenters' real names
        # are withheld by the Graph API for privacy, so they show "Facebook user").
        try:
            page_name = (A._fb_get(page_id, {"fields": "name"}) or {}).get("name")
        except Exception:
            page_name = None
        page_name = page_name or "Our Page"

        scopes_missing = set()
        new_comments = 0
        new_posts = 0
        new_dms = 0
        total_comments = 0
        total_posts = 0
        total_dms = 0

        _C_FIELDS = "message,from,created_time,like_count,permalink_url"
        _M_FIELDS = "id,message,from,created_time"

        def _ingest_comments(craw, pid, p_link, p_excerpt):
            """Insert a batch of raw Graph comments; LLM-classify only the NEW
            ones (dedup by source_id) so a deep re-sync doesn't re-bill the LLM
            for thousands of already-stored comments."""
            nonlocal new_comments
            cand = []
            for c in craw:
                cid = c.get("id")
                body = (c.get("message") or "").strip()
                if cid and body:
                    cand.append((cid, body, c))
            if not cand:
                return
            sids = ["fb:" + str(cid) for cid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(cid, body, c) for (cid, body, c) in cand
                     if ("fb:" + str(cid)) not in existing]
            # Sentiment in chunks of 50 to keep each LLM prompt bounded.
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (cid, _, _) in enumerate(chunk):
                    sent_map[cid] = sents.get(j)
            for cid, body, c in fresh:
                frm = c.get("from") or {}
                # Author of a comment is the page itself only when it replied to
                # its own post; otherwise the Graph API withholds the identity.
                author = frm.get("name") or "Facebook user"
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('facebook','comment',%s,NULL,%s,%s,%s,%s,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, body, sent_map.get(cid), "fb:" + str(cid),
                     c.get("permalink_url") or p_link,
                     "fbpost:" + str(pid), p_excerpt,
                     _fb_ts(c.get("created_time"))), fetch=True)
                if rid:
                    new_comments += 1

        def _ingest_dms(mraw, conv_id, conv_link):
            """Insert a batch of raw Messenger messages (inbound only — the
            page's own messages are not inbox items); LLM-classify only the
            NEW ones (dedup by source_id), same as comments."""
            nonlocal new_dms
            cand = []
            for m in mraw:
                mid = m.get("id")
                frm = m.get("from") or {}
                if not mid:
                    continue
                if str(frm.get("id") or "") == str(page_id):
                    continue  # outbound (the page's own reply)
                body = (m.get("message") or "").strip()
                if not body:
                    continue  # attachment/sticker-only message
                cand.append((mid, body, m))
            if not cand:
                return
            sids = ["fbdm:" + str(mid) for mid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(mid, body, m) for (mid, body, m) in cand
                     if ("fbdm:" + str(mid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (mid, _, _) in enumerate(chunk):
                    sent_map[mid] = sents.get(j)
            for mid, body, m in fresh:
                frm = m.get("from") or {}
                author = frm.get("name") or "Messenger user"
                # author_handle carries the sender's page-scoped id (PSID) so
                # the reply endpoint can send a Messenger reply back.
                psid = str(frm.get("id") or "") or None
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('facebook','dm',%s,%s,%s,%s,%s,%s,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, psid, body, sent_map.get(mid),
                     "fbdm:" + str(mid), conv_link,
                     "fbconv:" + str(conv_id),
                     f"Messenger conversation with {author}",
                     _fb_ts(m.get("created_time"))), fetch=True)
                if rid:
                    new_dms += 1

        # The 2000/2000 targets are CUMULATIVE (what the inbox can display), so
        # they count what is already stored — each sync only fetches what's
        # still missing, and the deep-history walk resumes across syncs via a
        # persisted cursor instead of restarting from the newest post.
        stored = _one(
            "SELECT COUNT(*) FILTER (WHERE type='post') AS p, "
            " COUNT(*) FILTER (WHERE type='comment') AS c, "
            " COUNT(*) FILTER (WHERE type='dm') AS d "
            "FROM crm_social_feedback WHERE platform='facebook'") or {}
        stored_posts = _int(stored.get("p"), 0)
        stored_comments = _int(stored.get("c"), 0)
        stored_dms = _int(stored.get("d"), 0)

        def _posts_short():
            return (stored_posts + new_posts) < _FB_SYNC_POST_TARGET

        def _comments_short():
            return (stored_comments + new_comments) < _FB_SYNC_COMMENT_TARGET

        def _dms_short():
            return (stored_dms + new_dms) < _FB_SYNC_DM_TARGET

        # Posts are fetched newest-first, 100 per Graph page, with the first 100
        # comments of each post expanded inline (one HTTP call covers up to 100
        # posts AND their comments — vital for reaching the 2000/2000 targets).
        base_fields = "message,permalink_url,created_time,full_picture"
        inline_state = {"on": True}

        def _fetch_page(after):
            while True:
                fields = base_fields
                if inline_state["on"]:
                    fields += (",comments.order(reverse_chronological)"
                               ".limit(100){" + _C_FIELDS + "}")
                params = {"fields": fields, "limit": 100}
                if after:
                    params["after"] = after
                try:
                    return A._fb_get(f"{page_id}/posts", params)
                except Exception as e:
                    m = str(e).lower()
                    if inline_state["on"] and ("permission" in m or "scope" in m
                                               or "#10" in m or "#200" in m):
                        # Comment-read scope missing: retry this page without the
                        # inline comment expansion so posts still sync.
                        scopes_missing.add("pages_read_user_content")
                        inline_state["on"] = False
                        continue
                    raise

        def _process_page(feed):
            """Ingest one feed page. Returns (n_posts, n_new_posts, next_cursor,
            completed) — completed=False means the time budget interrupted the
            page (so the caller must NOT advance the resume cursor past it)."""
            nonlocal total_posts, total_comments, new_posts
            posts = feed.get("data") or []
            page_new = 0
            completed = True
            for p in posts:
                if _over_content_budget():
                    completed = False
                    break
                pid = p.get("id")
                if not pid:
                    continue
                total_posts += 1
                p_msg = (p.get("message") or "").strip()
                p_link = p.get("permalink_url")
                # A short, human label for the post so comments can show "on: …".
                p_excerpt = (p_msg[:90] + "…") if len(p_msg) > 90 else (
                    p_msg or ("[Photo post]" if p.get("full_picture") else "[Post]"))
                # Store the brand's own post as a feed item (so the inbox reflects
                # the real number of posts, not only posts that have comments).
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,posted_at) VALUES "
                    "('facebook','post',%s,NULL,%s,NULL,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (page_name, p_msg or p_excerpt, "fbpost:" + str(pid),
                     p_link, _fb_ts(p.get("created_time"))), fetch=True)
                if rid:
                    new_posts += 1
                    page_new += 1
                # Comments: inline batch first, then follow this post's own
                # comment cursor while the overall comment target is unmet.
                cnode = p.get("comments") or {}
                craw = cnode.get("data") or []
                c_after = ((cnode.get("paging") or {}).get("cursors")
                           or {}).get("after")
                c_more = bool((cnode.get("paging") or {}).get("next"))
                if not inline_state["on"] and _comments_short():
                    try:
                        cres = A._fb_get(f"{pid}/comments", {
                            "fields": _C_FIELDS,
                            "order": "reverse_chronological", "limit": 100})
                        craw = cres.get("data") or []
                        c_after = ((cres.get("paging") or {}).get("cursors")
                                   or {}).get("after")
                        c_more = bool((cres.get("paging") or {}).get("next"))
                    except Exception as e:
                        m = str(e).lower()
                        if ("permission" in m or "scope" in m
                                or "#10" in m or "#200" in m):
                            scopes_missing.add("pages_read_user_content")
                        craw, c_more = [], False
                if craw:
                    total_comments += len(craw)
                    _ingest_comments(craw, pid, p_link, p_excerpt)
                while (c_more and c_after and _comments_short()
                       and not _over_content_budget()):
                    try:
                        cres = A._fb_get(f"{pid}/comments", {
                            "fields": _C_FIELDS,
                            "order": "reverse_chronological",
                            "limit": 100, "after": c_after})
                    except Exception:
                        break
                    craw = cres.get("data") or []
                    if not craw:
                        break
                    total_comments += len(craw)
                    _ingest_comments(craw, pid, p_link, p_excerpt)
                    c_after = ((cres.get("paging") or {}).get("cursors")
                               or {}).get("after")
                    c_more = bool((cres.get("paging") or {}).get("next"))
            paging = feed.get("paging") or {}
            nxt = ((paging.get("cursors") or {}).get("after")
                   if paging.get("next") else None)
            return len(posts), page_new, nxt, completed

        try:
            # Phase A — fresh content: walk from the newest post until a page
            # adds nothing new (i.e. we've reached already-stored history).
            after = None
            exhausted = False
            first = True
            while not _over_content_budget():
                page_cursor = after
                try:
                    feed = _fetch_page(after)
                except Exception as e:
                    if first:
                        raise HTTPException(502, f"Facebook sync failed: {e}")
                    break  # keep what we already ingested
                n, page_new, nxt, completed = _process_page(feed)
                first = False
                if not completed:
                    after = page_cursor  # re-do this page next sync
                    break
                if not nxt:
                    exhausted = True
                    after = None
                    break
                after = nxt
                if n == 0 or page_new == 0:
                    break

            # Phase B — deep backfill toward the 2000/2000 stored targets,
            # resuming where the previous sync stopped (persisted cursor).
            deep_done = (_cfg_get("social.fb.deep_done") or "") == "1" or exhausted
            if not deep_done and (_posts_short() or _comments_short()):
                deep_after = (_cfg_get("social.fb.deep_cursor") or "") or after
                while (deep_after and not _over_content_budget()
                       and (_posts_short() or _comments_short())):
                    page_cursor = deep_after
                    try:
                        feed = _fetch_page(deep_after)
                    except Exception:
                        # Cursor may have expired — restart the deep walk from
                        # the top on the next sync.
                        deep_after = None
                        break
                    n, page_new, nxt, completed = _process_page(feed)
                    if not completed:
                        deep_after = page_cursor  # re-do this page next sync
                        break
                    if not nxt or n == 0:
                        deep_done = True
                        deep_after = None
                        break
                    deep_after = nxt
                _cfg_set("social.fb.deep_cursor", deep_after or "")
            if deep_done:
                _cfg_set("social.fb.deep_done", "1")
                _cfg_set("social.fb.deep_cursor", "")

            # Phase C — Messenger DMs: walk the Page's conversations (newest
            # activity first) storing each INBOUND message as a 'dm' feedback
            # row. A missing pages_messaging scope (or any Graph failure here)
            # never fails the whole sync — posts/comments above are kept and
            # the missing scope is reported like the comment scope is.
            def _dm_scope_err(e):
                m = str(e).lower()
                return ("permission" in m or "scope" in m or "#10" in m
                        or "#200" in m or "#230" in m)

            def _fetch_conv_page(after):
                params = {"fields": "id,link,updated_time,"
                          "messages.limit(100){" + _M_FIELDS + "}",
                          "limit": 25}
                if after:
                    params["after"] = after
                return A._fb_get(f"{page_id}/conversations", params)

            def _process_conv_page(feed, guarantee=0):
                """Ingest one conversations page. Returns (n_convs, n_new_dms,
                next_cursor, completed) — completed=False means the time budget
                interrupted the page (caller must not advance past it). The first
                `guarantee` conversations are ingested regardless of the budget so
                the DM phase never fetches a page and stores zero (the starvation
                bug: an over-budget DM phase used to bail before the first
                ingest)."""
                nonlocal total_dms
                convs = feed.get("data") or []
                before = new_dms
                completed = True
                for idx, conv in enumerate(convs):
                    if idx >= guarantee and _over_budget():
                        completed = False
                        break
                    conv_id = conv.get("id")
                    if not conv_id:
                        continue
                    clink = conv.get("link")
                    if clink and clink.startswith("/"):
                        clink = "https://www.facebook.com" + clink
                    mnode = conv.get("messages") or {}
                    mraw = mnode.get("data") or []
                    m_after = ((mnode.get("paging") or {}).get("cursors")
                               or {}).get("after")
                    m_more = bool((mnode.get("paging") or {}).get("next"))
                    if mraw:
                        total_dms += len(mraw)
                        _ingest_dms(mraw, conv_id, clink)
                    # Older messages of a long thread, while the target is unmet.
                    while (m_more and m_after and _dms_short()
                           and not _over_budget()):
                        try:
                            mres = A._fb_get(f"{conv_id}/messages", {
                                "fields": _M_FIELDS, "limit": 100,
                                "after": m_after})
                        except Exception:
                            break
                        mraw = mres.get("data") or []
                        if not mraw:
                            break
                        total_dms += len(mraw)
                        _ingest_dms(mraw, conv_id, clink)
                        m_after = ((mres.get("paging") or {}).get("cursors")
                                   or {}).get("after")
                        m_more = bool((mres.get("paging") or {}).get("next"))
                paging = feed.get("paging") or {}
                nxt = ((paging.get("cursors") or {}).get("after")
                       if paging.get("next") else None)
                return len(convs), new_dms - before, nxt, completed

            dm_blocked = False
            dm_error = None
            dm_after = None
            dm_exhausted = False
            dm_first = True
            # Fresh DMs: from the most recent conversations until a page adds
            # nothing new. Always attempt at least the first page, even if the
            # post phases used the whole budget, so DMs are never starved.
            while dm_first or not _over_budget():
                page_cursor = dm_after
                try:
                    feed = _fetch_conv_page(dm_after)
                except Exception as e:
                    if _dm_scope_err(e):
                        scopes_missing.add("pages_messaging")
                    dm_blocked = True
                    dm_error = str(e)[:500]
                    break  # keep posts/comments; DM phase reports the error
                n, page_new, nxt, completed = _process_conv_page(
                    feed, guarantee=1 if dm_first else 0)
                dm_first = False
                if not completed:
                    dm_after = page_cursor  # re-do this page next sync
                    break
                if not nxt:
                    dm_exhausted = True
                    dm_after = None
                    break
                dm_after = nxt
                if n == 0 or page_new == 0:
                    break

            # DM deep backfill toward the 2000 stored target, resuming where
            # the previous sync stopped (persisted cursor).
            if not dm_blocked:
                dm_deep_done = ((_cfg_get("social.fb.dm_deep_done") or "") == "1"
                                or dm_exhausted)
                if not dm_deep_done and _dms_short():
                    deep_after = (_cfg_get("social.fb.dm_deep_cursor") or "") or dm_after
                    while (deep_after and not _over_budget() and _dms_short()):
                        page_cursor = deep_after
                        try:
                            feed = _fetch_conv_page(deep_after)
                        except Exception as e:
                            # Cursor may have expired — restart next sync.
                            if dm_error is None:
                                dm_error = str(e)[:500]
                            deep_after = None
                            break
                        n, page_new, nxt, completed = _process_conv_page(feed)
                        if not completed:
                            deep_after = page_cursor
                            break
                        if not nxt or n == 0:
                            dm_deep_done = True
                            deep_after = None
                            break
                        deep_after = nxt
                    _cfg_set("social.fb.dm_deep_cursor", deep_after or "")
                if dm_deep_done:
                    _cfg_set("social.fb.dm_deep_done", "1")
                    _cfg_set("social.fb.dm_deep_cursor", "")
        except HTTPException:
            raise
        from datetime import datetime, timezone
        _cfg_set("social.fb.last_synced_at",
                 datetime.now(timezone.utc).isoformat())
        _cfg_set("social.fb.last_sync_posts", total_posts)
        _cfg_set("social.fb.last_sync_comments", total_comments)
        _cfg_set("social.fb.last_sync_dms", total_dms)
        _cfg_set("social.fb.last_dm_error", dm_error or "")
        _cfg_set("social.fb.last_scopes_missing", ",".join(sorted(scopes_missing)))
        A._crm_audit("social", page_id, "sync",
                     f"facebook sync: {total_posts} posts, "
                     f"{new_comments} new comments, {new_dms} new DMs", request)
        return {"pages_synced": 1, "posts": total_posts,
                "comments": new_comments, "dms": new_dms,
                "dms_stored": stored_dms + new_dms,
                "dm_blocked": dm_blocked,
                "dm_error": dm_error,
                "scopes_missing": sorted(scopes_missing)}

    # ----- Live Instagram wiring ------------------------------------------- #
    # Instagram Business accounts are managed through the SAME Meta Graph API
    # and the SAME long-lived Page token the server already holds (the IG
    # account is linked to the Facebook Page). We resolve the linked IG account
    # id dynamically from the Page's `instagram_business_account` field (never
    # hardcoded) and reuse api_pg's _fb_* Graph plumbing verbatim. IG, unlike
    # Facebook, EXPOSES the commenter's @username. DMs (Instagram Direct) are
    # intentionally OUT OF SCOPE here — they need extra messaging permissions —
    # so this engine ingests posts (our media), their comments, and @-mentions
    # (the /tags edge). A clean DM seam can be added later as a Phase C.

    _IG_SYNC_POST_TARGET = 2000
    _IG_SYNC_COMMENT_TARGET = 2000
    _IG_SYNC_MENTION_TARGET = 2000
    _IG_SYNC_DM_TARGET = 2000
    _IG_SYNC_TIME_BUDGET_SEC = 240
    # Reserved tails guaranteed to the later phases. Mentions AND DMs both run
    # after posts/comments (order: media → posts/comments deep → mentions → DMs),
    # so BOTH are starved on a fresh prod DB while the posts/comments backfill is
    # still running. Posts/comments stop at (hard − mention − dm reserve),
    # mentions stop at (hard − dm reserve), and DMs run against the full hard cap.
    _IG_SYNC_DM_RESERVE_SEC = 60
    _IG_SYNC_MENTION_RESERVE_SEC = 60
    _IG_M_FIELDS = "id,message,from,created_time"
    # Staleness guard: a background sync should finish within the time budget.
    # If the in-process lock is still held but the recorded start is older than
    # the budget plus this margin, the run is considered wedged/dead — the lock
    # is treated as "not running" so a new sync can start and the banner clears.
    # The margin covers a request in flight past the last budget check (each
    # Graph call is bounded at 30s) plus scheduling/finalisation overhead.
    _IG_SYNC_STALE_MARGIN_SEC = 120
    # The lock lives inside a mutable holder so a stale run can be abandoned by
    # swapping in a fresh lock (the zombie thread keeps its OWN old lock object
    # and its finally-release can never unlock the new run).
    _ig_sync_state = {"lock": threading.Lock()}

    def _ig_started_stale():
        """True when the recorded sync start is older than the time budget +
        margin (or there is no start record while the lock is held)."""
        from datetime import datetime, timezone
        started = (_cfg_get("social.ig.last_started_at") or "").strip()
        if not started:
            return True
        try:
            dt = datetime.fromisoformat(started)
        except Exception:
            return True
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        return age > (_IG_SYNC_TIME_BUDGET_SEC + _IG_SYNC_STALE_MARGIN_SEC)

    def _ig_sync_running():
        """A sync is 'running' only while the lock is held AND the recorded
        start is still within the budget window — a stale lock reads as idle."""
        return _ig_sync_state["lock"].locked() and not _ig_started_stale()
    _ig_id_cache = {"id": None, "username": None, "ts": 0.0}
    _IG_ID_TTL = 3600  # the Page↔IG link changes very rarely

    _IG_C_FIELDS = "id,text,username,timestamp,like_count"

    def _ig_user(force=False):
        """Resolve the (id, username) of the Instagram Business account linked to
        the configured Facebook Page. Cached in-process (1h TTL). Returns
        (None, None) when no IG account is linked (or the Page is unreachable)."""
        now = time.time()
        if (not force and _ig_id_cache["id"]
                and (now - _ig_id_cache["ts"]) < _IG_ID_TTL):
            return _ig_id_cache["id"], _ig_id_cache["username"]
        page = A._fb_get(A._fb_page_id(),
                         {"fields": "instagram_business_account{id,username}"})
        iga = (page or {}).get("instagram_business_account") or {}
        iid = iga.get("id")
        uname = iga.get("username")
        if iid:
            _ig_id_cache.update(id=str(iid), username=uname, ts=now)
            return str(iid), uname
        return None, None

    @app.get("/api/social/instagram/status")
    def cl_soc_ig_status(request: Request):
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        empty = {"connected": False, "account": None, "last_synced_at": None,
                 "auto_sync_minutes": None,
                 "counts": {"real_posts": 0, "real_feedback": 0,
                            "real_mentions": 0}}
        if not A._fb_configured():
            return empty
        try:
            iid, uname = _ig_user()
        except Exception:
            return empty  # token invalid/unreachable -> show connect banner
        if not iid:
            return empty  # no IG business account linked to the Page
        agg = _one("SELECT count(*) AS feedback, "
                   " count(*) FILTER (WHERE type='mention') AS mentions, "
                   " count(*) FILTER (WHERE type='dm') AS dms "
                   "FROM crm_social_feedback WHERE platform='instagram'") or {}
        posts_n = _int(_cfg_get("social.ig.last_sync_posts"), 0)
        comments_n = _int(_cfg_get("social.ig.last_sync_comments"), 0)
        mentions_n = _int(_cfg_get("social.ig.last_sync_mentions"), 0)
        dms_n = _int(_cfg_get("social.ig.last_sync_dms"), 0)
        scopes = [s for s in (_cfg_get("social.ig.last_scopes_missing") or "").split(",") if s]
        last_at = _cfg_get("social.ig.last_synced_at")
        dm_error = (_cfg_get("social.ig.last_dm_error") or "").strip()
        run_error = (_cfg_get("social.ig.last_run_error") or "").strip()
        # DMs are blocked when the messaging scope is missing OR the DM phase
        # recorded an error on its last completed run.
        dm_blocked = ("instagram_manage_messages" in scopes) or bool(dm_error)
        return {
            "connected": True,
            # True while a background sync thread holds the lock AND its start is
            # still within the budget window — the Inbox polls this to know when a
            # triggered sync has finished. A wedged/stale lock reads as idle so the
            # banner clears instead of showing "syncing…" forever.
            "running": _ig_sync_running(),
            "account": {
                "ig_user_id": iid,
                "username": uname,
                "handle": ("@" + uname) if uname else None,
                "last_sync_posts": posts_n,
                "last_sync_comments": comments_n,
                "last_sync_mentions": mentions_n,
                "last_sync_dms": dms_n,
                "last_sync_scopes_missing": scopes,
            },
            "last_synced_at": last_at or None,
            "auto_sync_minutes": None,
            "dm_blocked": dm_blocked,
            "dm_error": dm_error or None,
            "last_run_error": run_error or None,
            "counts": {"real_posts": posts_n,
                       "real_feedback": _int(agg.get("feedback"), 0),
                       "real_mentions": _int(agg.get("mentions"), 0),
                       "real_dms": _int(agg.get("dms"), 0)},
        }

    def _ig_sync_bg(request, lock):
        """Run the (up to 240s) Instagram sync on a background thread so it always
        completes server-side regardless of the HTTP client / proxy timeout. The
        endpoint returns immediately; the status endpoint reports `running` (the
        lock) and the persisted `social.ig.last_*` keys reflect the finished run.
        The lock is released here (NOT in the request handler) because the handler
        returns long before the thread finishes. Each thread releases the SAME
        lock object it was started with — if a stale run was abandoned and a fresh
        lock swapped in, this release can never unlock the newer run."""
        from datetime import datetime, timezone
        try:
            _ig_sync_run(request)
            _cfg_set("social.ig.last_run_error", "")
        except HTTPException as e:
            _cfg_set("social.ig.last_run_error", str(getattr(e, "detail", e))[:500])
        except Exception as e:  # noqa: BLE001 — never let a thread crash silently
            _cfg_set("social.ig.last_run_error", str(e)[:500])
        finally:
            _cfg_set("social.ig.last_finished_at",
                     datetime.now(timezone.utc).isoformat())
            try:
                lock.release()
            except RuntimeError:
                pass  # already released (e.g. abandoned as stale) — harmless

    @app.post("/api/social/instagram/sync")
    def cl_soc_ig_sync(request: Request, payload: dict = Body(default=None)):
        if not _internal_token_ok(request):
            _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
        if not A._fb_configured():
            raise HTTPException(400, "Instagram is not configured on the server.")
        lock = _ig_sync_state["lock"]
        if not lock.acquire(blocking=False):
            # The lock is held. If the recorded start is stale the previous run
            # is wedged/dead (a hung thread past the budget window) — abandon its
            # lock, install a fresh one and take over so a new sync can proceed.
            # The zombie keeps a reference to the OLD lock object, so its eventual
            # finally-release cannot unlock this new run.
            if not _ig_started_stale():
                raise HTTPException(409, "An Instagram sync is already running.")
            lock = threading.Lock()
            _ig_sync_state["lock"] = lock
            lock.acquire(blocking=False)
        # Kick the work onto a daemon thread and return immediately. The shared
        # proxy/gateway kills a held-open request well before the 240s budget, so
        # a synchronous run was being cut off before the DM phase (which runs last)
        # ever ingested anything. Decoupling lets every phase — including DMs —
        # run to completion. The non-blocking lock above still prevents overlap.
        from datetime import datetime, timezone
        _cfg_set("social.ig.last_started_at",
                 datetime.now(timezone.utc).isoformat())
        threading.Thread(target=_ig_sync_bg, args=(request, lock),
                         name="ig-sync", daemon=True).start()
        return {"started": True, "running": True}

    def _ig_sync_run(request):
        try:
            ig_id, ig_uname = _ig_user()
        except Exception as e:
            raise HTTPException(502, f"Instagram sync failed: {e}")
        if not ig_id:
            raise HTTPException(
                400, "No Instagram Business account is linked to the Facebook "
                     "Page. Link one in Meta Business settings and retry.")
        started = time.monotonic()

        def _over_budget():
            return (time.monotonic() - started) > _IG_SYNC_TIME_BUDGET_SEC

        def _over_content_budget():
            # Soft budget for posts/comments: leaves room for BOTH mentions & DMs.
            return (time.monotonic() - started) > (
                _IG_SYNC_TIME_BUDGET_SEC - _IG_SYNC_MENTION_RESERVE_SEC
                - _IG_SYNC_DM_RESERVE_SEC)

        def _over_mention_budget():
            # Soft budget for the mention phase: leaves the DM reserve intact.
            return (time.monotonic() - started) > (
                _IG_SYNC_TIME_BUDGET_SEC - _IG_SYNC_DM_RESERVE_SEC)

        acct_label = ("@" + ig_uname) if ig_uname else "Our Instagram"
        scopes_missing = set()
        new_comments = 0
        new_posts = 0
        new_mentions = 0
        new_dms = 0
        total_comments = 0
        total_posts = 0
        total_mentions = 0
        total_dms = 0

        def _ig_author(username):
            return (username or "Instagram user",
                    ("@" + username) if username else None)

        def _flatten_ig_comments(craw):
            """Flatten a raw IG comments batch into (id, text, username) tuples,
            expanding any inline replies so a reply is an inbox item too."""
            out = []
            for c in craw or []:
                cid = c.get("id")
                body = (c.get("text") or "").strip()
                if cid and body:
                    out.append((cid, body, c.get("username")))
                for r in ((c.get("replies") or {}).get("data") or []):
                    rid_ = r.get("id")
                    rbody = (r.get("text") or "").strip()
                    if rid_ and rbody:
                        out.append((rid_, rbody, r.get("username")))
            return out

        def _ingest_ig_comments(craw, media_id, m_link, m_excerpt):
            """Insert a batch of IG comments; LLM-classify only the NEW ones
            (dedup by source_id) so a deep re-sync doesn't re-bill the LLM."""
            nonlocal new_comments
            cand = _flatten_ig_comments(craw)
            if not cand:
                return
            sids = ["ig:" + str(cid) for cid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(cid, body, u) for (cid, body, u) in cand
                     if ("ig:" + str(cid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (cid, _, _) in enumerate(chunk):
                    sent_map[cid] = sents.get(j)
            for cid, body, username in fresh:
                author, handle = _ig_author(username)
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('instagram','comment',%s,%s,%s,%s,%s,%s,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, handle, body, sent_map.get(cid), "ig:" + str(cid),
                     m_link, "igmedia:" + str(media_id), m_excerpt, None),
                    fetch=True)
                if rid:
                    new_comments += 1

        def _ingest_ig_mentions(mraw):
            """Insert a batch of tagged-media (@-mention) rows; dedup + classify
            only the NEW ones."""
            nonlocal new_mentions
            cand = []
            for m in mraw or []:
                mid = m.get("id")
                if not mid:
                    continue
                cap = (m.get("caption") or "").strip()
                body = cap or "[Tagged " + acct_label + " in a post]"
                cand.append((mid, body, m))
            if not cand:
                return
            sids = ["igtag:" + str(mid) for mid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(mid, body, m) for (mid, body, m) in cand
                     if ("igtag:" + str(mid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (mid, _, _) in enumerate(chunk):
                    sent_map[mid] = sents.get(j)
            for mid, body, m in fresh:
                author, handle = _ig_author(m.get("username"))
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('instagram','mention',%s,%s,%s,%s,%s,%s,NULL,NULL,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, handle, body, sent_map.get(mid),
                     "igtag:" + str(mid), m.get("permalink"),
                     _fb_ts(m.get("timestamp"))), fetch=True)
                if rid:
                    new_mentions += 1

        stored = _one(
            "SELECT COUNT(*) FILTER (WHERE type='post') AS p, "
            " COUNT(*) FILTER (WHERE type='comment') AS c, "
            " COUNT(*) FILTER (WHERE type='mention') AS m, "
            " COUNT(*) FILTER (WHERE type='dm') AS d "
            "FROM crm_social_feedback WHERE platform='instagram'") or {}
        stored_posts = _int(stored.get("p"), 0)
        stored_comments = _int(stored.get("c"), 0)
        stored_mentions = _int(stored.get("m"), 0)
        stored_dms = _int(stored.get("d"), 0)

        def _posts_short():
            return (stored_posts + new_posts) < _IG_SYNC_POST_TARGET

        def _comments_short():
            return (stored_comments + new_comments) < _IG_SYNC_COMMENT_TARGET

        def _mentions_short():
            return (stored_mentions + new_mentions) < _IG_SYNC_MENTION_TARGET

        def _dms_short():
            return (stored_dms + new_dms) < _IG_SYNC_DM_TARGET

        def _ingest_ig_dms(mraw, conv_id, conv_link):
            """Insert a batch of raw Instagram Direct messages (INBOUND only —
            the account's own messages are not inbox items); LLM-classify only
            the NEW ones (dedup by source_id), mirroring the FB DM ingest."""
            nonlocal new_dms
            cand = []
            for m in mraw or []:
                mid = m.get("id")
                frm = m.get("from") or {}
                if not mid:
                    continue
                if str(frm.get("id") or "") == str(ig_id):
                    continue  # outbound (our own reply)
                body = (m.get("message") or "").strip()
                if not body:
                    continue  # attachment/sticker-only message
                cand.append((mid, body, m))
            if not cand:
                return
            sids = ["igdm:" + str(mid) for mid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(mid, body, m) for (mid, body, m) in cand
                     if ("igdm:" + str(mid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (mid, _, _) in enumerate(chunk):
                    sent_map[mid] = sents.get(j)
            for mid, body, m in fresh:
                frm = m.get("from") or {}
                author = (frm.get("username") or frm.get("name")
                          or "Instagram user")
                # author_handle carries the sender's Instagram-scoped id (IGSID)
                # so the reply endpoint can deliver a Direct reply back.
                igsid = str(frm.get("id") or "") or None
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('instagram','dm',%s,%s,%s,%s,%s,%s,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, igsid, body, sent_map.get(mid),
                     "igdm:" + str(mid), conv_link,
                     "igconv:" + str(conv_id),
                     f"Instagram conversation with {author}",
                     _fb_ts(m.get("created_time"))), fetch=True)
                if rid:
                    new_dms += 1

        # Media are fetched newest-first, 50 per Graph page, with the first 50
        # comments (and their inline replies) of each expanded inline.
        _M_BASE = ("id,caption,permalink,timestamp,media_type,like_count,"
                   "comments_count")
        inline_state = {"on": True}

        def _fetch_media_page(after):
            while True:
                fields = _M_BASE
                if inline_state["on"]:
                    fields += (",comments.limit(50){" + _IG_C_FIELDS
                               + ",replies.limit(50){" + _IG_C_FIELDS + "}}")
                params = {"fields": fields, "limit": 50}
                if after:
                    params["after"] = after
                try:
                    return A._fb_get(f"{ig_id}/media", params)
                except Exception as e:
                    m = str(e).lower()
                    if inline_state["on"] and ("permission" in m or "scope" in m
                                               or "#10" in m or "#200" in m):
                        scopes_missing.add("instagram_manage_comments")
                        inline_state["on"] = False
                        continue
                    raise

        def _process_media_page(feed):
            """Ingest one media page. Returns (n, n_new_posts, next_cursor,
            completed) — completed=False means the time budget interrupted it."""
            nonlocal total_posts, total_comments, new_posts
            media = feed.get("data") or []
            page_new = 0
            completed = True
            for p in media:
                if _over_content_budget():
                    completed = False
                    break
                mid = p.get("id")
                if not mid:
                    continue
                total_posts += 1
                cap = (p.get("caption") or "").strip()
                m_link = p.get("permalink")
                m_excerpt = (cap[:90] + "…") if len(cap) > 90 else (
                    cap or ("[" + (p.get("media_type") or "Media").title()
                            + " post]"))
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,posted_at) VALUES "
                    "('instagram','post',%s,%s,%s,NULL,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (acct_label, ("@" + ig_uname) if ig_uname else None,
                     cap or m_excerpt, "igmedia:" + str(mid), m_link,
                     _fb_ts(p.get("timestamp"))), fetch=True)
                if rid:
                    new_posts += 1
                    page_new += 1
                cnode = p.get("comments") or {}
                craw = cnode.get("data") or []
                c_after = ((cnode.get("paging") or {}).get("cursors")
                           or {}).get("after")
                c_more = bool((cnode.get("paging") or {}).get("next"))
                if not inline_state["on"] and _comments_short():
                    try:
                        cres = A._fb_get(f"{mid}/comments", {
                            "fields": _IG_C_FIELDS + ",replies.limit(50){"
                            + _IG_C_FIELDS + "}", "limit": 50})
                        craw = cres.get("data") or []
                        c_after = ((cres.get("paging") or {}).get("cursors")
                                   or {}).get("after")
                        c_more = bool((cres.get("paging") or {}).get("next"))
                    except Exception as e:
                        m = str(e).lower()
                        if ("permission" in m or "scope" in m
                                or "#10" in m or "#200" in m):
                            scopes_missing.add("instagram_manage_comments")
                        craw, c_more = [], False
                if craw:
                    total_comments += len(craw)
                    _ingest_ig_comments(craw, mid, m_link, m_excerpt)
                while (c_more and c_after and _comments_short()
                       and not _over_content_budget()):
                    try:
                        cres = A._fb_get(f"{mid}/comments", {
                            "fields": _IG_C_FIELDS + ",replies.limit(50){"
                            + _IG_C_FIELDS + "}", "limit": 50, "after": c_after})
                    except Exception:
                        break
                    craw = cres.get("data") or []
                    if not craw:
                        break
                    total_comments += len(craw)
                    _ingest_ig_comments(craw, mid, m_link, m_excerpt)
                    c_after = ((cres.get("paging") or {}).get("cursors")
                               or {}).get("after")
                    c_more = bool((cres.get("paging") or {}).get("next"))
            paging = feed.get("paging") or {}
            nxt = ((paging.get("cursors") or {}).get("after")
                   if paging.get("next") else None)
            return len(media), page_new, nxt, completed

        try:
            # Phase A — fresh media: newest-first until a page adds nothing new.
            after = None
            exhausted = False
            first = True
            while not _over_content_budget():
                page_cursor = after
                try:
                    feed = _fetch_media_page(after)
                except Exception as e:
                    if first:
                        raise HTTPException(502, f"Instagram sync failed: {e}")
                    break
                n, page_new, nxt, completed = _process_media_page(feed)
                first = False
                if not completed:
                    after = page_cursor
                    break
                if not nxt:
                    exhausted = True
                    after = None
                    break
                after = nxt
                if n == 0 or page_new == 0:
                    break

            # Phase B — deep backfill toward the stored targets, resuming from
            # the persisted cursor.
            deep_done = (_cfg_get("social.ig.deep_done") or "") == "1" or exhausted
            if not deep_done and (_posts_short() or _comments_short()):
                deep_after = (_cfg_get("social.ig.deep_cursor") or "") or after
                while (deep_after and not _over_content_budget()
                       and (_posts_short() or _comments_short())):
                    page_cursor = deep_after
                    try:
                        feed = _fetch_media_page(deep_after)
                    except Exception:
                        deep_after = None
                        break
                    n, page_new, nxt, completed = _process_media_page(feed)
                    if not completed:
                        deep_after = page_cursor
                        break
                    if not nxt or n == 0:
                        deep_done = True
                        deep_after = None
                        break
                    deep_after = nxt
                _cfg_set("social.ig.deep_cursor", deep_after or "")
            if deep_done:
                _cfg_set("social.ig.deep_done", "1")
                _cfg_set("social.ig.deep_cursor", "")

            # Phase M — @-mentions/tags: media where the account was tagged.
            # Resumable like the posts deep-backfill (Phase A + Phase B): a fresh
            # newest-first pass catches new tags each run, then a cursor-resumed
            # deep pass walks PAST already-seen pages toward the target (it must
            # NOT stop on a duplicate/zero-new page, or older mentions would never
            # be reached). A missing permission never fails the posts/comments
            # sync.
            mention_blocked = False
            mention_error = None

            def _fetch_tags_page(after):
                # Keep the field set minimal: the /tags edge raises Graph error #1
                # ("please reduce the amount of data you're asking for") when
                # aggregate fields (like_count/comments_count) are requested over
                # a large tagged-media set. We only ingest id/caption/username/
                # permalink/timestamp, so request exactly those.
                params = {"fields": "id,caption,permalink,timestamp,username",
                          "limit": 25}
                if after:
                    params["after"] = after
                return A._fb_get(f"{ig_id}/tags", params)

            def _process_tags_page(feed):
                """Ingest one /tags page. Returns (n, page_new, next_cursor)."""
                nonlocal total_mentions
                mraw = feed.get("data") or []
                page_new = 0
                if mraw:
                    total_mentions += len(mraw)
                    before = new_mentions
                    _ingest_ig_mentions(mraw)
                    page_new = new_mentions - before
                paging = feed.get("paging") or {}
                nxt = ((paging.get("cursors") or {}).get("after")
                       if paging.get("next") else None)
                return len(mraw), page_new, nxt

            # Fresh pass — newest-first until a page adds nothing new.
            m_after = None
            m_exhausted = False
            while not _over_mention_budget():
                try:
                    feed = _fetch_tags_page(m_after)
                except Exception as e:
                    msg = str(e).lower()
                    if ("permission" in msg or "scope" in msg or "#10" in msg
                            or "#200" in msg):
                        scopes_missing.add("instagram_manage_comments")
                    mention_blocked = True
                    mention_error = str(e)[:500]
                    break
                n, page_new, nxt = _process_tags_page(feed)
                if not nxt:
                    m_exhausted = True
                    m_after = None
                    break
                m_after = nxt
                if n == 0 or page_new == 0:
                    break

            # Deep pass — resume from the persisted cursor toward the target,
            # continuing past already-seen pages (do not stop on 0-new).
            mention_done = ((_cfg_get("social.ig.mention_done") or "") == "1"
                            or m_exhausted)
            if not mention_blocked and not mention_done and _mentions_short():
                deep_m = (_cfg_get("social.ig.mention_deep_cursor") or "") or m_after
                while deep_m and not _over_mention_budget() and _mentions_short():
                    page_cursor = deep_m
                    try:
                        feed = _fetch_tags_page(deep_m)
                    except Exception as e:
                        mention_error = str(e)[:500]
                        deep_m = None
                        break
                    n, page_new, nxt = _process_tags_page(feed)
                    if not nxt or n == 0:
                        mention_done = True
                        deep_m = None
                        break
                    deep_m = nxt
                _cfg_set("social.ig.mention_deep_cursor", deep_m or "")
            if mention_done:
                _cfg_set("social.ig.mention_done", "1")
                _cfg_set("social.ig.mention_deep_cursor", "")

            # Phase C — Instagram Direct messages: walk the linked account's
            # conversations (via the Page node with platform=instagram) storing
            # each INBOUND message as a 'dm' feedback row. Mirrors the FB DM
            # phase exactly: a missing instagram_manage_messages scope (or any
            # Graph failure here) never fails the posts/comments/mentions sync —
            # the missing scope is reported like the comment scope is.
            def _ig_dm_scope_err(e):
                m = str(e).lower()
                return ("permission" in m or "scope" in m or "#10" in m
                        or "#200" in m or "#230" in m)

            def _fetch_ig_conv_page(after):
                params = {"platform": "instagram",
                          "fields": "id,updated_time,"
                          "messages.limit(100){" + _IG_M_FIELDS + "}",
                          "limit": 25}
                if after:
                    params["after"] = after
                return A._fb_get(f"{A._fb_page_id()}/conversations", params)

            def _process_ig_conv_page(feed, guarantee=0):
                """Ingest one conversations page. Returns (n_convs, n_new_dms,
                next_cursor, completed) — completed=False means the time budget
                interrupted the page (caller must not advance past it). The first
                `guarantee` conversations are ingested regardless of the budget so
                the DM phase never fetches a page and stores zero."""
                nonlocal total_dms
                convs = feed.get("data") or []
                before = new_dms
                completed = True
                for idx, conv in enumerate(convs):
                    if idx >= guarantee and _over_budget():
                        completed = False
                        break
                    conv_id = conv.get("id")
                    if not conv_id:
                        continue
                    mnode = conv.get("messages") or {}
                    mraw = mnode.get("data") or []
                    m_after = ((mnode.get("paging") or {}).get("cursors")
                               or {}).get("after")
                    m_more = bool((mnode.get("paging") or {}).get("next"))
                    if mraw:
                        total_dms += len(mraw)
                        _ingest_ig_dms(mraw, conv_id, None)
                    # Older messages of a long thread, while the target is unmet.
                    while (m_more and m_after and _dms_short()
                           and not _over_budget()):
                        try:
                            mres = A._fb_get(f"{conv_id}/messages", {
                                "fields": _IG_M_FIELDS, "limit": 100,
                                "after": m_after})
                        except Exception:
                            break
                        mraw = mres.get("data") or []
                        if not mraw:
                            break
                        total_dms += len(mraw)
                        _ingest_ig_dms(mraw, conv_id, None)
                        m_after = ((mres.get("paging") or {}).get("cursors")
                                   or {}).get("after")
                        m_more = bool((mres.get("paging") or {}).get("next"))
                paging = feed.get("paging") or {}
                nxt = ((paging.get("cursors") or {}).get("after")
                       if paging.get("next") else None)
                return len(convs), new_dms - before, nxt, completed

            dm_blocked = False
            dm_error = None
            dm_after = None
            dm_exhausted = False
            dm_first = True
            # Fresh DMs: from the most recent conversations until a page adds
            # nothing new. Always attempt at least the first page, even if the
            # earlier phases used the whole budget, so DMs are never starved.
            while dm_first or not _over_budget():
                page_cursor = dm_after
                try:
                    feed = _fetch_ig_conv_page(dm_after)
                except Exception as e:
                    if _ig_dm_scope_err(e):
                        scopes_missing.add("instagram_manage_messages")
                    dm_blocked = True
                    dm_error = str(e)[:500]
                    break  # keep the earlier phases; DM phase reports the error
                n, page_new, nxt, completed = _process_ig_conv_page(
                    feed, guarantee=1 if dm_first else 0)
                dm_first = False
                if not completed:
                    dm_after = page_cursor  # re-do this page next sync
                    break
                if not nxt:
                    dm_exhausted = True
                    dm_after = None
                    break
                dm_after = nxt
                if n == 0 or page_new == 0:
                    break

            # DM deep backfill toward the 2000 stored target, resuming where the
            # previous sync stopped (persisted cursor).
            if not dm_blocked:
                dm_deep_done = ((_cfg_get("social.ig.dm_deep_done") or "") == "1"
                                or dm_exhausted)
                if not dm_deep_done and _dms_short():
                    deep_after = (_cfg_get("social.ig.dm_deep_cursor") or "") or dm_after
                    while (deep_after and not _over_budget() and _dms_short()):
                        page_cursor = deep_after
                        try:
                            feed = _fetch_ig_conv_page(deep_after)
                        except Exception as e:
                            # Cursor may have expired — restart next sync.
                            if dm_error is None:
                                dm_error = str(e)[:500]
                            deep_after = None
                            break
                        n, page_new, nxt, completed = _process_ig_conv_page(feed)
                        if not completed:
                            deep_after = page_cursor
                            break
                        if not nxt or n == 0:
                            dm_deep_done = True
                            deep_after = None
                            break
                        deep_after = nxt
                    _cfg_set("social.ig.dm_deep_cursor", deep_after or "")
                if dm_deep_done:
                    _cfg_set("social.ig.dm_deep_done", "1")
                    _cfg_set("social.ig.dm_deep_cursor", "")
        except HTTPException:
            raise
        from datetime import datetime, timezone
        _cfg_set("social.ig.last_synced_at",
                 datetime.now(timezone.utc).isoformat())
        _cfg_set("social.ig.last_sync_posts", total_posts)
        _cfg_set("social.ig.last_sync_comments", total_comments)
        _cfg_set("social.ig.last_sync_mentions", total_mentions)
        _cfg_set("social.ig.last_sync_dms", total_dms)
        _cfg_set("social.ig.last_mention_error", mention_error or "")
        _cfg_set("social.ig.last_dm_error", dm_error or "")
        _cfg_set("social.ig.last_scopes_missing", ",".join(sorted(scopes_missing)))
        A._crm_audit("social", ig_id, "sync",
                     f"instagram sync: {total_posts} posts, "
                     f"{new_comments} new comments, {new_mentions} new mentions, "
                     f"{new_dms} new DMs", request)
        return {"account": acct_label, "posts": total_posts,
                "comments": new_comments, "mentions": new_mentions,
                "mentions_stored": stored_mentions + new_mentions,
                "mention_blocked": mention_blocked,
                "mention_error": mention_error,
                "dms": new_dms,
                "dms_stored": stored_dms + new_dms,
                "dm_blocked": dm_blocked,
                "dm_error": dm_error,
                "scopes_missing": sorted(scopes_missing)}

    # ----- Live X (Twitter) wiring ----------------------------------------- #
    # X is a first-class inbox platform alongside Facebook + Instagram. The
    # server holds the app Bearer token (reads) and OAuth 1.0a user creds
    # (writes/DMs) via secrets, resolved by the module-level _x_* helpers. We
    # pull the brand account's own tweets (posts), @-mentions/replies and
    # inbound DMs into crm_social_feedback (platform='x') and deliver replies
    # back. Deep-backfill + cursor-resume + a 240s budget mirror the FB/IG
    # engines. A missing tier/scope (mentions or DM access is often gated on
    # X's paid tiers) is reported in scopes_missing and never fails the sync.
    _X_SYNC_POST_TARGET = 2000
    _X_SYNC_MENTION_TARGET = 2000
    _X_SYNC_DM_TARGET = 2000
    _X_SYNC_TIME_BUDGET_SEC = 240
    # Staleness guard (mirrors the IG/FB engines): a sync should finish within
    # the time budget. If the in-process lock is still held but the recorded
    # start is older than the budget plus this margin, the run is considered
    # wedged/dead — the lock reads as "not running" so a new sync can take over
    # and the banner clears instead of showing "syncing…" forever. Each API call
    # is bounded at 30s (timeout=30); the margin covers a request in flight past
    # the last budget check plus scheduling/finalisation overhead.
    _X_SYNC_STALE_MARGIN_SEC = 120
    # The lock lives inside a mutable holder so a stale run can be abandoned by
    # swapping in a fresh lock (the zombie thread keeps its OWN old lock object
    # and its finally-release can never unlock the new run).
    _x_sync_state = {"lock": threading.Lock()}

    def _x_started_stale():
        """True when the recorded sync start is older than the time budget +
        margin (or there is no start record while the lock is held)."""
        from datetime import datetime, timezone
        started = (_cfg_get("social.x.last_started_at") or "").strip()
        if not started:
            return True
        try:
            dt = datetime.fromisoformat(started)
        except Exception:
            return True
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        return age > (_X_SYNC_TIME_BUDGET_SEC + _X_SYNC_STALE_MARGIN_SEC)

    def _x_sync_running():
        """A sync is 'running' only while the lock is held AND the recorded
        start is still within the budget window — a stale lock reads as idle."""
        return _x_sync_state["lock"].locked() and not _x_started_stale()
    _x_id_cache = {"id": None, "username": None, "ts": 0.0}
    _X_ID_TTL = 3600  # the brand handle changes very rarely

    def _x_account():
        """Resolve (user_id, username) of the configured brand account. Prefers
        the explicit X_USER_ID/X_USERNAME secrets; otherwise resolves the id
        from the handle via the API (cached 1h + persisted in crm_config).
        Returns (None, None) when unresolved/unreachable."""
        uid = _x_user_id_cfg()
        uname = _x_username_cfg()
        if uid:
            uname = (uname or _x_id_cache["username"]
                     or _cfg_get("social.x.username") or None)
            return uid, uname
        if not uname:
            return None, None
        now = time.time()
        if (_x_id_cache["id"] and _x_id_cache["username"] == uname
                and (now - _x_id_cache["ts"]) < _X_ID_TTL):
            return _x_id_cache["id"], uname
        cached = _cfg_get("social.x.user_id")
        if cached and (_cfg_get("social.x.username") or "") == uname:
            _x_id_cache.update(id=str(cached), username=uname, ts=now)
            return str(cached), uname
        data = (_x_get("/2/users/by/username/"
                       + urllib.parse.quote(uname)) or {}).get("data") or {}
        rid = data.get("id")
        if rid:
            _x_id_cache.update(id=str(rid), username=uname, ts=now)
            _cfg_set("social.x.user_id", str(rid))
            _cfg_set("social.x.username", uname)
            return str(rid), uname
        return None, uname

    @app.get("/api/social/x/status")
    def cl_soc_x_status(request: Request):
        _staff(request, roles=("customer_service", "marketing",
                               "leadership", "admin"))
        empty = {"connected": False, "running": False, "account": None,
                 "last_synced_at": None, "write_enabled": False,
                 "counts": {"real_posts": 0, "real_feedback": 0,
                            "real_mentions": 0, "real_dms": 0}}
        if not _x_read_configured():
            return empty
        try:
            uid, uname = _x_account()
        except Exception:
            return empty  # token invalid/unreachable -> show connect banner
        if not uid:
            return empty
        agg = _one("SELECT count(*) AS feedback, "
                   " count(*) FILTER (WHERE type='post') AS posts, "
                   " count(*) FILTER (WHERE type='mention') AS mentions, "
                   " count(*) FILTER (WHERE type='dm') AS dms "
                   "FROM crm_social_feedback WHERE platform='x'") or {}
        posts_n = _int(_cfg_get("social.x.last_sync_posts"), 0)
        mentions_n = _int(_cfg_get("social.x.last_sync_mentions"), 0)
        dms_n = _int(_cfg_get("social.x.last_sync_dms"), 0)
        scopes = [s for s in
                  (_cfg_get("social.x.last_scopes_missing") or "").split(",")
                  if s]
        run_error = (_cfg_get("social.x.last_run_error") or "").strip()
        return {
            "connected": True,
            # True only while a sync holds the lock AND its recorded start is
            # still within the budget window — a wedged/stale lock reads as idle
            # so the banner clears instead of showing "syncing…" forever.
            "running": _x_sync_running(),
            "account": {
                "user_id": uid,
                "username": uname,
                "handle": ("@" + uname) if uname else None,
                "last_sync_posts": posts_n,
                "last_sync_mentions": mentions_n,
                "last_sync_dms": dms_n,
                "last_sync_scopes_missing": scopes,
            },
            "last_synced_at": _cfg_get("social.x.last_synced_at") or None,
            "write_enabled": _x_write_configured(),
            "last_run_error": run_error or None,
            "counts": {"real_posts": _int(agg.get("posts"), 0),
                       "real_feedback": _int(agg.get("feedback"), 0),
                       "real_mentions": _int(agg.get("mentions"), 0),
                       "real_dms": _int(agg.get("dms"), 0)},
        }

    def _x_sync_bg(request, lock, max_seconds):
        """Run the X sync on a background thread so it always completes
        server-side regardless of the HTTP client / proxy timeout. The endpoint
        returns immediately; the status endpoint reports `running` (the lock) and
        the persisted `social.x.last_*` keys reflect the finished run. The lock is
        released here (NOT in the request handler) because the handler returns
        long before the thread finishes. Each thread releases the SAME lock object
        it was started with — if a stale run was abandoned and a fresh lock
        swapped in, this release can never unlock the newer run."""
        from datetime import datetime, timezone
        try:
            _x_sync_run(request, max_seconds=max_seconds)
            _cfg_set("social.x.last_run_error", "")
        except HTTPException as e:
            _cfg_set("social.x.last_run_error", str(getattr(e, "detail", e))[:500])
        except Exception as e:  # noqa: BLE001 — never let a thread crash silently
            _cfg_set("social.x.last_run_error", str(e)[:500])
        finally:
            _cfg_set("social.x.last_finished_at",
                     datetime.now(timezone.utc).isoformat())
            try:
                lock.release()
            except RuntimeError:
                pass  # already released (e.g. abandoned as stale) — harmless

    @app.post("/api/social/x/sync")
    def cl_soc_x_sync(request: Request, payload: dict = Body(default=None)):
        # The internal sync loop may trigger this with X-Internal-Token (no
        # staff session); a browser call must be an authenticated marketing+
        # staff member (the /api/social role gate already applies to sessions).
        if not _internal_ok(request):
            _staff(request, roles=("customer_service", "marketing",
                                   "leadership", "admin"))
        if not _x_read_configured():
            raise HTTPException(400, "X (Twitter) is not configured on the server.")
        from datetime import datetime, timezone
        lock = _x_sync_state["lock"]
        if not lock.acquire(blocking=False):
            # The lock is held. If the recorded start is stale the previous run
            # is wedged/dead (a hung thread past the budget window) — abandon its
            # lock, install a fresh one and take over so a new sync can proceed.
            # The zombie keeps a reference to the OLD lock object, so its eventual
            # finally-release cannot unlock this new run.
            if not _x_started_stale():
                raise HTTPException(409, "An X sync is already running.")
            lock = threading.Lock()
            _x_sync_state["lock"] = lock
            lock.acquire(blocking=False)
        budget = None
        try:
            budget = int((payload or {}).get("max_seconds"))
        except (TypeError, ValueError):
            budget = None
        # Kick the work onto a daemon thread and return immediately. The shared
        # proxy/gateway kills a held-open request well before the budget, so a
        # synchronous run was being cut off before the DM phase (which runs last)
        # ever ingested anything. Decoupling lets every phase — including DMs —
        # run to completion. The non-blocking lock above still prevents overlap.
        _cfg_set("social.x.last_started_at",
                 datetime.now(timezone.utc).isoformat())
        threading.Thread(target=_x_sync_bg, args=(request, lock, budget),
                         name="x-sync", daemon=True).start()
        return {"started": True, "running": True}

    def _x_sync_run(request, max_seconds=None):
        try:
            uid, uname = _x_account()
        except Exception as e:
            raise HTTPException(502, f"X sync failed: {e}")
        if not uid:
            raise HTTPException(
                400, "Could not resolve the X account. Set X_USER_ID or "
                     "X_USERNAME (with a valid X_BEARER_TOKEN) and retry.")
        budget = _X_SYNC_TIME_BUDGET_SEC
        if max_seconds and max_seconds > 0:
            budget = min(_X_SYNC_TIME_BUDGET_SEC, max_seconds)
        started = time.monotonic()

        def _over_budget():
            return (time.monotonic() - started) > budget

        acct_label = ("@" + uname) if uname else "Our X account"
        scopes_missing = set()
        new_posts = 0
        new_mentions = 0
        new_dms = 0
        total_posts = 0
        total_mentions = 0
        total_dms = 0

        def _permalink(tweet_id, handle=None):
            h = handle or uname
            return (f"https://x.com/{h}/status/{tweet_id}" if h
                    else f"https://x.com/i/web/status/{tweet_id}")

        def _ingest_x_posts(tweets):
            """Insert the account's own tweets (type='post', sentiment NULL —
            our own voice, not customer feedback). Returns count of new rows."""
            nonlocal total_posts, new_posts
            cand = [(t.get("id"), (t.get("text") or "").strip(), t)
                    for t in (tweets or []) if t.get("id")]
            if not cand:
                return 0
            total_posts += len(cand)
            sids = ["xpost:" + str(tid) for tid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            page_new = 0
            for tid, body, t in cand:
                if ("xpost:" + str(tid)) in existing:
                    continue
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,posted_at) VALUES "
                    "('x','post',%s,%s,%s,NULL,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (acct_label, ("@" + uname) if uname else None,
                     body or "[Tweet]", "xpost:" + str(tid),
                     _permalink(tid), t.get("created_at")), fetch=True)
                if rid:
                    new_posts += 1
                    page_new += 1
            return page_new

        def _ingest_x_mentions(tweets, users_by_id):
            """Insert @-mentions/replies (type='mention'); LLM-classify only the
            NEW ones. author_handle carries the mentioner's @handle; the reply
            target is the tweet id held in source_id (xmention:<id>)."""
            nonlocal total_mentions, new_mentions
            cand = [(t.get("id"), (t.get("text") or "").strip(), t)
                    for t in (tweets or [])
                    if t.get("id") and (t.get("text") or "").strip()]
            if not cand:
                return 0
            total_mentions += len(cand)
            sids = ["xmention:" + str(tid) for tid, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(tid, body, t) for (tid, body, t) in cand
                     if ("xmention:" + str(tid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, b, _ in chunk])
                for j, (tid, _, _) in enumerate(chunk):
                    sent_map[tid] = sents.get(j)
            page_new = 0
            for tid, body, t in fresh:
                u = users_by_id.get(str(t.get("author_id") or "")) or {}
                au = u.get("username")
                author = u.get("name") or (("@" + au) if au else "X user")
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('x','mention',%s,%s,%s,%s,%s,%s,NULL,NULL,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (author, ("@" + au) if au else None, body,
                     sent_map.get(tid), "xmention:" + str(tid),
                     _permalink(tid, au), t.get("created_at")), fetch=True)
                if rid:
                    new_mentions += 1
                    page_new += 1
            return page_new

        def _ingest_x_dms(events):
            """Insert INBOUND DMs (sender != our account) as type='dm';
            author_handle carries the sender id (the DM reply participant)."""
            nonlocal total_dms, new_dms
            cand = []
            for e in (events or []):
                if (e.get("event_type") or "MessageCreate") != "MessageCreate":
                    continue
                mid = e.get("id")
                sender = str(e.get("sender_id") or "")
                body = (e.get("text") or "").strip()
                if not mid or not sender or sender == str(uid) or not body:
                    continue  # skip malformed / outbound / attachment-only
                cand.append((mid, sender, body, e))
            if not cand:
                return 0
            total_dms += len(cand)
            sids = ["xdm:" + str(mid) for mid, _, _, _ in cand]
            try:
                rows = _ex("SELECT source_id FROM crm_social_feedback "
                           "WHERE source_id = ANY(%s)", (sids,), fetch=True) or []
                existing = {r["source_id"] for r in rows}
            except Exception:
                existing = set()
            fresh = [(mid, s, b, e) for (mid, s, b, e) in cand
                     if ("xdm:" + str(mid)) not in existing]
            sent_map = {}
            for i in range(0, len(fresh), 50):
                chunk = fresh[i:i + 50]
                sents = A._fb_sentiment([b for _, _, b, _ in chunk])
                for j, (mid, _, _, _) in enumerate(chunk):
                    sent_map[mid] = sents.get(j)
            page_new = 0
            for mid, sender, body, e in fresh:
                conv = str(e.get("dm_conversation_id") or "") or None
                rid = _ex(
                    "INSERT INTO crm_social_feedback "
                    "(platform,type,author_name,author_handle,body,sentiment,"
                    " source_id,permalink,parent_source_id,parent_excerpt,"
                    " posted_at) VALUES "
                    "('x','dm',%s,%s,%s,%s,%s,NULL,%s,%s,"
                    " COALESCE(%s::timestamptz, now())) "
                    "ON CONFLICT (source_id) WHERE source_id IS NOT NULL "
                    "DO NOTHING RETURNING id",
                    (f"X user {sender}", sender, body, sent_map.get(mid),
                     "xdm:" + str(mid), ("xconv:" + conv) if conv else None,
                     "X direct message", e.get("created_at")), fetch=True)
                if rid:
                    new_dms += 1
                    page_new += 1
            return page_new

        stored = _one(
            "SELECT COUNT(*) FILTER (WHERE type='post') AS p, "
            " COUNT(*) FILTER (WHERE type='mention') AS m, "
            " COUNT(*) FILTER (WHERE type='dm') AS d "
            "FROM crm_social_feedback WHERE platform='x'") or {}
        stored_posts = _int(stored.get("p"), 0)
        stored_mentions = _int(stored.get("m"), 0)
        stored_dms = _int(stored.get("d"), 0)

        def _posts_short():
            return (stored_posts + new_posts) < _X_SYNC_POST_TARGET

        def _mentions_short():
            return (stored_mentions + new_mentions) < _X_SYNC_MENTION_TARGET

        def _dms_short():
            return (stored_dms + new_dms) < _X_SYNC_DM_TARGET

        def _fetch_posts_page(token):
            params = {"max_results": 100, "tweet.fields": "created_at",
                      "exclude": "retweets"}
            if token:
                params["pagination_token"] = token
            return _x_get(f"/2/users/{uid}/tweets", params)

        def _process_posts_page(feed):
            data = feed.get("data") or []
            page_new = _ingest_x_posts(data)
            return len(data), page_new, (feed.get("meta") or {}).get("next_token")

        def _fetch_mentions_page(token):
            params = {"max_results": 100,
                      "tweet.fields": "created_at,author_id",
                      "expansions": "author_id",
                      "user.fields": "username,name"}
            if token:
                params["pagination_token"] = token
            return _x_get(f"/2/users/{uid}/mentions", params)

        def _process_mentions_page(feed):
            data = feed.get("data") or []
            users = {}
            for u in ((feed.get("includes") or {}).get("users") or []):
                if u.get("id"):
                    users[str(u["id"])] = u
            page_new = _ingest_x_mentions(data, users)
            return len(data), page_new, (feed.get("meta") or {}).get("next_token")

        def _fetch_dm_page(token):
            params = {"max_results": 100, "event_types": "MessageCreate",
                      "dm_event.fields":
                      "created_at,sender_id,dm_conversation_id,text"}
            if token:
                params["pagination_token"] = token
            return _x_oauth1_get("/2/dm_events", params)

        def _process_dm_page(feed):
            data = feed.get("data") or []
            page_new = _ingest_x_dms(data)
            return len(data), page_new, (feed.get("meta") or {}).get("next_token")

        def _x_access_err(e):
            m = str(e).lower()
            return ("403" in m or "forbidden" in m or "not authorized" in m
                    or "access" in m or "level" in m or "dm.read" in m)

        mention_blocked = False
        mention_error = None
        dm_blocked = False
        dm_error = None
        try:
            # Phase A — fresh own tweets: newest-first until a page adds nothing.
            token = None
            exhausted = False
            first = True
            while not _over_budget():
                try:
                    feed = _fetch_posts_page(token)
                except Exception as e:
                    if first:
                        raise HTTPException(502, f"X sync failed: {e}")
                    break
                n, page_new, nxt = _process_posts_page(feed)
                first = False
                if not nxt:
                    exhausted = True
                    token = None
                    break
                token = nxt
                if n == 0 or page_new == 0:
                    break

            # Phase B — deep post backfill toward the target, resuming from the
            # persisted cursor (the /tweets timeline caps near ~3.2k tweets, at
            # which point no next_token is returned and the deep pass completes).
            deep_done = (_cfg_get("social.x.deep_done") or "") == "1" or exhausted
            if not deep_done and _posts_short():
                deep = (_cfg_get("social.x.deep_cursor") or "") or token
                while deep and not _over_budget() and _posts_short():
                    try:
                        feed = _fetch_posts_page(deep)
                    except Exception:
                        deep = None
                        break
                    n, page_new, nxt = _process_posts_page(feed)
                    if not nxt or n == 0:
                        deep_done = True
                        deep = None
                        break
                    deep = nxt
                _cfg_set("social.x.deep_cursor", deep or "")
            if deep_done:
                _cfg_set("social.x.deep_done", "1")
                _cfg_set("social.x.deep_cursor", "")

            # Phase M — @-mentions/replies. Always attempt at least one fresh
            # page (m_first) so new mentions are never starved by a long post
            # backfill. Missing access never fails the posts sync.
            m_token = None
            m_exhausted = False
            m_first = True
            while m_first or not _over_budget():
                try:
                    feed = _fetch_mentions_page(m_token)
                except Exception as e:
                    if _x_access_err(e):
                        scopes_missing.add("mentions_read")
                    mention_blocked = True
                    mention_error = str(e)[:500]
                    break
                n, page_new, nxt = _process_mentions_page(feed)
                m_first = False
                if not nxt:
                    m_exhausted = True
                    m_token = None
                    break
                m_token = nxt
                if n == 0 or page_new == 0:
                    break

            m_done = ((_cfg_get("social.x.mention_done") or "") == "1"
                      or m_exhausted)
            if not mention_blocked and not m_done and _mentions_short():
                deep_m = (_cfg_get("social.x.mention_deep_cursor") or "") or m_token
                while deep_m and not _over_budget() and _mentions_short():
                    try:
                        feed = _fetch_mentions_page(deep_m)
                    except Exception as e:
                        mention_error = str(e)[:500]
                        deep_m = None
                        break
                    n, page_new, nxt = _process_mentions_page(feed)
                    if not nxt or n == 0:
                        m_done = True
                        deep_m = None
                        break
                    deep_m = nxt
                _cfg_set("social.x.mention_deep_cursor", deep_m or "")
            if m_done:
                _cfg_set("social.x.mention_done", "1")
                _cfg_set("social.x.mention_deep_cursor", "")

            # Phase D — inbound DMs via OAuth 1.0a user context. DM read access
            # (dm.read + an elevated tier) is often unavailable; report it in
            # scopes_missing and never fail the rest of the sync.
            if not _x_write_configured():
                scopes_missing.add("dm.read")
                dm_blocked = True
                dm_error = "X DM access requires OAuth 1.0a credentials (unset)."
            else:
                d_token = None
                d_exhausted = False
                d_first = True
                while d_first or not _over_budget():
                    try:
                        feed = _fetch_dm_page(d_token)
                    except Exception as e:
                        if _x_access_err(e):
                            scopes_missing.add("dm.read")
                        dm_blocked = True
                        dm_error = str(e)[:500]
                        break
                    n, page_new, nxt = _process_dm_page(feed)
                    d_first = False
                    if not nxt:
                        d_exhausted = True
                        d_token = None
                        break
                    d_token = nxt
                    if n == 0 or page_new == 0:
                        break

                d_done = ((_cfg_get("social.x.dm_deep_done") or "") == "1"
                          or d_exhausted)
                if not dm_blocked and not d_done and _dms_short():
                    deep_d = (_cfg_get("social.x.dm_deep_cursor") or "") or d_token
                    while deep_d and not _over_budget() and _dms_short():
                        try:
                            feed = _fetch_dm_page(deep_d)
                        except Exception as e:
                            if dm_error is None:
                                dm_error = str(e)[:500]
                            deep_d = None
                            break
                        n, page_new, nxt = _process_dm_page(feed)
                        if not nxt or n == 0:
                            d_done = True
                            deep_d = None
                            break
                        deep_d = nxt
                    _cfg_set("social.x.dm_deep_cursor", deep_d or "")
                if d_done:
                    _cfg_set("social.x.dm_deep_done", "1")
                    _cfg_set("social.x.dm_deep_cursor", "")
        except HTTPException:
            raise

        from datetime import datetime, timezone
        _cfg_set("social.x.last_synced_at",
                 datetime.now(timezone.utc).isoformat())
        _cfg_set("social.x.last_sync_posts", total_posts)
        _cfg_set("social.x.last_sync_mentions", total_mentions)
        _cfg_set("social.x.last_sync_dms", total_dms)
        _cfg_set("social.x.last_mention_error", mention_error or "")
        _cfg_set("social.x.last_dm_error", dm_error or "")
        _cfg_set("social.x.last_scopes_missing", ",".join(sorted(scopes_missing)))
        try:
            A._crm_audit("social", uid, "sync",
                         f"x sync: {total_posts} posts, "
                         f"{new_mentions} new mentions, {new_dms} new DMs",
                         request)
        except Exception:
            pass
        return {"account": acct_label, "posts": total_posts,
                "posts_stored": stored_posts + new_posts,
                "mentions": new_mentions,
                "mentions_stored": stored_mentions + new_mentions,
                "mention_blocked": mention_blocked,
                "mention_error": mention_error,
                "dms": new_dms,
                "dms_stored": stored_dms + new_dms,
                "dm_blocked": dm_blocked,
                "dm_error": dm_error,
                "scopes_missing": sorted(scopes_missing)}


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
        _staff(request, roles=("admin", "leadership"))
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
        _staff(request, roles=("customer_service", "marketing", "leadership", "admin"))
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
