"""Customer-facing Vivo Community app backend (/api/community/*).

Public, self-authenticating endpoints for the standalone customer app at
/app/ (artifacts/vivo-community). Auth model mirrors /api/loyalty: the
api_pg middleware lets /api/community/* through WITHOUT a staff session and
every member-scoped handler here validates its own Bearer token (sha256 of
the token is stored in community_sessions) and fails closed with 401.

Auth flow (per product spec): phone -> SMS one-time code -> app.
SMS DEMO MODE: no SMS provider is connected yet. When no provider is
configured (_sms_configured() is False) the stored OTP is the fixed demo
code 123456 and responses carry {"demo": true} so the UI can say so.
To plug in a real provider later: implement _send_otp_sms() and make
_sms_configured() detect the provider secret — verify logic is unchanged
(a random code is generated first; demo mode merely overwrites it).

Data: products come from the live catalogue (all_products_clean +
product_images, stock from all_inventory); members are matched to real
customers in all_customers by phone (right-9-digit match) so the profile
shows real purchase-derived stats. PII: /me only ever returns the
logged-in member's OWN record.
"""

import base64
import collections
import hashlib
import logging
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime

import psycopg2
import psycopg2.extras
from fastapi import Body, HTTPException, Request
from fastapi.responses import JSONResponse, Response

log = logging.getLogger("community_app")

# Set in register_community_routes() to the fully-loaded api_pg module.
A = None

DEMO_CODE = "123456"
OTP_TTL_SEC = 10 * 60          # code valid 10 minutes
OTP_MAX_ATTEMPTS = 5
OTP_RESEND_GAP_SEC = 30
SIGNUP_TOKEN_TTL_SEC = 30 * 60
SESSION_TTL_SEC = 60 * 24 * 3600   # 60 days

WELCOME_BONUS_PTS = 200
KES_PER_POINT = 50             # matches the "1 pt per 50 KES" earn rule
TIER_LADDER = [("Bronze", 0), ("Silver", 500), ("Gold", 1000)]

_tables_ready = False
_tables_lock = threading.Lock()

# Small in-process caches (products list is identical for every member).
# All caches are size-capped: keys can be influenced by public callers, so
# unbounded growth would be a memory-DoS vector.
_products_cache = {}           # key -> (ts, payload)
_PRODUCTS_TTL = 600
_me_cache = {}                 # member_id -> (ts, payload)
_ME_TTL = 300

_IMG_CACHE = collections.OrderedDict()   # sku -> (ts, jpeg bytes | None=404)
_IMG_LOCK = threading.Lock()
_IMG_TTL = 3600
_IMG_CAP = 400                 # ~40KB/img -> <=~16MB
_IMG_MAX_BYTES = 300 * 1024    # never cache abnormally large blobs

# ---- public-endpoint abuse guards (in-process sliding windows) ----------
# These endpoints bypass the staff-auth middleware, so they need their own
# IP / phone / global budgets: without them anyone could mint unlimited OTP
# rows (and, once a real SMS provider is connected, pump SMS spend).
_RL_LOCK = threading.Lock()
_RL_HITS = {}                  # bucket key -> deque[hit unix ts]
_RL_MAX_KEYS = 20000           # hard memory valve


# ---------------------------------------------------------------- helpers

def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=5,
                            options="-c statement_timeout=15000")


@contextmanager
def _db():
    """Bounded DB access. Borrow from the host API server's connection pool
    (A._acquire_conn waits briefly then 503s cleanly when saturated) so
    public traffic can never exhaust raw Postgres connections; fall back to
    a short-lived direct connection when running outside api_pg."""
    if A is not None and hasattr(A, "_acquire_conn"):
        pool, conn = A._acquire_conn()
        try:
            conn.autocommit = False    # pool conns may arrive autocommit=True
            yield conn
            try:
                conn.rollback()        # drop any uncommitted (read-only) tx
            except Exception:
                pass
        except HTTPException:
            # Application-level error (400/401/429…): connection is healthy.
            try:
                conn.rollback()
                pool.putconn(conn)
            except Exception:
                pool.putconn(conn, close=True)
            raise
        except Exception:
            # Unknown failure: never return a possibly-poisoned conn.
            pool.putconn(conn, close=True)
            raise
        else:
            pool.putconn(conn)
    else:
        conn = _conn()
        try:
            yield conn
        finally:
            conn.close()


def _cache_put(cache, key, value, cap=256):
    """Insert into a ts-keyed cache, evicting the oldest entries at cap."""
    if len(cache) >= cap:
        for k in sorted(cache, key=lambda k: cache[k][0])[: max(1, cap // 8)]:
            cache.pop(k, None)
    cache[key] = (time.time(), value)


def _rate_ok(key, limit, window_sec):
    now = time.time()
    with _RL_LOCK:
        if len(_RL_HITS) > _RL_MAX_KEYS:   # memory valve: sweep stale buckets
            cutoff = now - 3600
            for k in list(_RL_HITS):
                dq = _RL_HITS[k]
                while dq and dq[0] < cutoff:
                    dq.popleft()
                if not dq:
                    _RL_HITS.pop(k, None)
        dq = _RL_HITS.setdefault(key, collections.deque())
        cut = now - window_sec
        while dq and dq[0] < cut:
            dq.popleft()
        if len(dq) >= limit:
            return False
        dq.append(now)
        return True


def _client_ip(request):
    xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if xff:
        return xff[:64]
    return request.client.host if request.client else "unknown"


def _throttle(request, scope, rules, phone=None):
    """rules: [(dim, limit, window_sec)] with dim in 'ip'|'phone'|'global'.
    Raises 429 when any bucket is exhausted."""
    ip = _client_ip(request)
    for dim, limit, window in rules:
        # window in the key: same-dimension rules must NOT share a bucket
        # (they'd double-count every hit and halve the effective limit).
        if dim == "ip":
            key = f"{scope}:ip:{ip}:{window}"
        elif dim == "phone":
            if not phone:
                continue
            key = f"{scope}:ph:{phone}:{window}"
        else:
            key = f"{scope}:g:{window}"
        if not _rate_ok(key, limit, window):
            log.warning("community throttle hit: %s", key)
            raise HTTPException(status_code=429,
                                detail="Too many requests — please try again shortly")


def _ensure_tables():
    global _tables_ready
    if _tables_ready:
        return
    with _tables_lock:
        if _tables_ready:
            return
        ddl = """
        CREATE TABLE IF NOT EXISTS community_members (
            id SERIAL PRIMARY KEY,
            phone TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL,
            dob DATE,
            consent_at TIMESTAMPTZ NOT NULL,
            customer_id TEXT,
            customer_store_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS community_otp (
            phone TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            attempts INT NOT NULL DEFAULT 0,
            last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS community_sessions (
            token_hash TEXT PRIMARY KEY,
            member_id INT,
            phone TEXT NOT NULL,
            purpose TEXT NOT NULL DEFAULT 'member',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        """
        with _db() as conn:
            with conn.cursor() as cur:
                cur.execute(ddl)
            conn.commit()
            _tables_ready = True


def _norm_phone(raw):
    """Canonicalise to bare digits with country code, e.g. 2547XXXXXXXX.

    Accepts +2547.., 2547.., 07.. (assumed Kenya), 7.. (9 digits, Kenya).
    Returns None when it can't be a sane E.164-ish number.
    """
    d = re.sub(r"\D", "", str(raw or ""))
    if d.startswith("00"):
        d = d[2:]
    if len(d) == 10 and d.startswith("0"):
        d = "254" + d[1:]
    elif len(d) == 9 and not d.startswith("0"):
        d = "254" + d
    if len(d) < 11 or len(d) > 13:
        return None
    return d


def _mask_phone(digits):
    if not digits:
        return ""
    return "+" + digits[:3] + "•••" + digits[-3:]


def _sms_configured():
    """True when a real SMS provider is wired up. Plug-in point: set
    COMMUNITY_SMS_PROVIDER (+ its credentials) and implement _send_otp_sms."""
    return bool(os.environ.get("COMMUNITY_SMS_PROVIDER"))


def _send_otp_sms(phone_digits, code):
    """Send the OTP via the configured SMS provider. Returns True on success.
    No provider is configured yet, so this is a stub that reports failure and
    the caller falls back to demo mode."""
    if not _sms_configured():
        return False
    # Future: dispatch on COMMUNITY_SMS_PROVIDER (e.g. Twilio, Africa's Talking).
    return False


def _hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_session(cur, phone, member_id=None, purpose="member"):
    token = secrets.token_urlsafe(32)
    ttl = SESSION_TTL_SEC if purpose == "member" else SIGNUP_TOKEN_TTL_SEC
    cur.execute(
        """INSERT INTO community_sessions (token_hash, member_id, phone, purpose, expires_at)
           VALUES (%s, %s, %s, %s, now() + make_interval(secs => %s))""",
        (_hash_token(token), member_id, phone, purpose, ttl),
    )
    return token


def _session_for(cur, token, purpose="member"):
    if not token:
        return None
    cur.execute(
        """SELECT token_hash, member_id, phone FROM community_sessions
           WHERE token_hash = %s AND purpose = %s AND expires_at > now()""",
        (_hash_token(token), purpose),
    )
    return cur.fetchone()


def _bearer(request: Request):
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return ""


def _require_member(cur, request: Request):
    sess = _session_for(cur, _bearer(request), purpose="member")
    if not sess or not sess["member_id"]:
        raise HTTPException(status_code=401, detail="Not signed in")
    cur.execute("SELECT * FROM community_members WHERE id = %s", (sess["member_id"],))
    m = cur.fetchone()
    if not m:
        raise HTTPException(status_code=401, detail="Not signed in")
    return m


def _initials(name):
    parts = [p for p in re.split(r"\s+", (name or "").strip()) if p]
    ini = "".join(p[0] for p in parts[:2]).upper()
    return ini or "V"


def _tier_for(points):
    tier = TIER_LADDER[0][0]
    for name, floor_pts in TIER_LADDER:
        if points >= floor_pts:
            tier = name
    nxt = None
    for name, floor_pts in TIER_LADDER:
        if points < floor_pts:
            nxt = {"name": name, "pts_needed": int(floor_pts - points)}
            break
    return tier, nxt


def _match_customer(cur, phone_digits):
    """Best matching real customer for a phone (right-9-digit equality)."""
    cur.execute(
        """SELECT customer_id, store_id, first_name, last_name,
                  COALESCE(total_orders,0) AS total_orders,
                  COALESCE(total_spend_kes,0)::float AS total_spend_kes
           FROM all_customers
           WHERE LENGTH(regexp_replace(COALESCE(phone,''), '\\D', '', 'g')) >= 9
             AND RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9) = RIGHT(%s, 9)
           ORDER BY COALESCE(total_orders,0) DESC, COALESCE(total_spend_kes,0) DESC
           LIMIT 1""",
        (phone_digits,),
    )
    return cur.fetchone()


def _month_year(val):
    """'2021-04-17' / date / datetime -> 'April 2021'."""
    if not val:
        return None
    try:
        if isinstance(val, (date, datetime)):
            d = val
        else:
            d = datetime.strptime(str(val)[:10], "%Y-%m-%d")
        return d.strftime("%B %Y")
    except Exception:
        return None


def _member_payload(cur, m):
    """Build the /me payload: member row + live purchase-derived stats."""
    cached = _me_cache.get(m["id"])
    if cached and time.time() - cached[0] < _ME_TTL:
        return cached[1]

    stats = None
    recent = []
    joined_src = m["created_at"]
    if m.get("customer_id"):
        cur.execute(
            """SELECT COALESCE(total_orders,0) AS total_orders,
                      COALESCE(total_spend_kes,0)::float AS total_spend_kes,
                      first_order_date, last_order_date, preferred_size, city
               FROM all_customers
               WHERE customer_id = %s AND store_id = %s
               LIMIT 1""",
            (m["customer_id"], m.get("customer_store_id")),
        )
        c = cur.fetchone()
        if c:
            stats = {
                "orders": int(c["total_orders"]),
                "spend_kes": float(c["total_spend_kes"]),
                "last_order": (str(c["last_order_date"])[:10] if c["last_order_date"] else None),
                "preferred_size": c["preferred_size"] or None,
                "city": (c["city"] or "").title() or None,
            }
            first_od = c["first_order_date"]
            if first_od:
                try:
                    fo = datetime.strptime(str(first_od)[:10], "%Y-%m-%d")
                    if fo.date() < m["created_at"].date():
                        joined_src = fo
                except Exception:
                    pass
            try:
                cur.execute(
                    """SELECT order_name,
                              MIN(sale_date::date) AS day,
                              SUM(COALESCE(total_sales_kes,0)
                                  - COALESCE(discounts_kes,0)
                                  - COALESCE(returns_kes,0))::float AS total_kes,
                              SUM(COALESCE(ordered_item_quantity,0))::int AS items
                       FROM all_sales
                       WHERE customer_id = %s AND store_id = %s
                         AND COALESCE(order_name,'') <> ''
                       GROUP BY order_name
                       ORDER BY MIN(sale_date::date) DESC
                       LIMIT 3""",
                    (m["customer_id"], m.get("customer_store_id")),
                )
                for r in cur.fetchall():
                    total = max(float(r["total_kes"] or 0), 0.0)
                    recent.append({
                        "order": r["order_name"],
                        "date": str(r["day"]),
                        "total_kes": round(total, 2),
                        "items": int(r["items"] or 0),
                        "pts": int(total // KES_PER_POINT),
                    })
            except Exception as e:
                log.warning("community recent orders failed: %s", e)

    spend = (stats or {}).get("spend_kes", 0.0)
    points = int(WELCOME_BONUS_PTS + spend // KES_PER_POINT)
    tier, next_tier = _tier_for(points)

    payload = {
        "id": m["id"],
        "name": m["full_name"],
        "initials": _initials(m["full_name"]),
        "phone_masked": _mask_phone(m["phone"]),
        "email": m["email"],
        "dob": str(m["dob"]) if m.get("dob") else None,
        "joined": _month_year(joined_src) or _month_year(m["created_at"]),
        "tier": tier,
        "points": points,
        "lifetime_points": points,
        "next_tier": next_tier,
        "linked": bool(m.get("customer_id")),
        "stats": stats,
        "recent_orders": recent,
        "demo_sms": not _sms_configured(),
    }
    _me_cache[m["id"]] = (time.time(), payload)
    return payload


# ---------------------------------------------------------------- routes

def register_community_routes(app, api_pg_module):
    global A
    A = api_pg_module

    # ---------- auth ----------

    @app.post("/api/community/auth/request-code")
    def community_request_code(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        phone = _norm_phone(payload.get("phone"))
        if not phone:
            raise HTTPException(status_code=400, detail="Enter a valid phone number")
        _throttle(request, "req", [("phone", 6, 3600),
                                   ("ip", 15, 600), ("ip", 40, 3600),
                                   ("global", 500, 3600)], phone=phone)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT last_sent_at FROM community_otp WHERE phone = %s", (phone,))
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "SELECT EXTRACT(EPOCH FROM (now() - %s))::int AS age",
                        (row["last_sent_at"],),
                    )
                    if cur.fetchone()["age"] < OTP_RESEND_GAP_SEC:
                        raise HTTPException(
                            status_code=429,
                            detail="Please wait a moment before requesting another code",
                        )
                code = "".join(secrets.choice("0123456789") for _ in range(6))
                sent = _send_otp_sms(phone, code)
                demo = not sent
                if demo:
                    code = DEMO_CODE
                cur.execute(
                    """INSERT INTO community_otp (phone, code, expires_at, attempts, last_sent_at)
                       VALUES (%s, %s, now() + make_interval(secs => %s), 0, now())
                       ON CONFLICT (phone) DO UPDATE
                       SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at,
                           attempts = 0, last_sent_at = now()""",
                    (phone, code, OTP_TTL_SEC),
                )
            conn.commit()
            return {"ok": True, "demo": demo, "phone_masked": _mask_phone(phone)}

    @app.post("/api/community/auth/verify")
    def community_verify(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        phone = _norm_phone(payload.get("phone"))
        code = re.sub(r"\D", "", str(payload.get("code") or ""))
        if not phone or len(code) != 6:
            raise HTTPException(status_code=400, detail="Enter the 6-digit code")
        _throttle(request, "ver", [("phone", 20, 3600),
                                   ("ip", 60, 600),
                                   ("global", 2000, 3600)], phone=phone)
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT code, attempts, expires_at > now() AS valid
                       FROM community_otp WHERE phone = %s""",
                    (phone,),
                )
                row = cur.fetchone()
                if not row or not row["valid"]:
                    raise HTTPException(status_code=400, detail="Code expired — request a new one")
                if row["attempts"] >= OTP_MAX_ATTEMPTS:
                    raise HTTPException(status_code=429, detail="Too many attempts — request a new code")
                if not secrets.compare_digest(str(row["code"]), code):
                    cur.execute(
                        "UPDATE community_otp SET attempts = attempts + 1 WHERE phone = %s",
                        (phone,),
                    )
                    conn.commit()
                    raise HTTPException(status_code=400, detail="That code doesn't match — try again")
                cur.execute("DELETE FROM community_otp WHERE phone = %s", (phone,))
                cur.execute("SELECT * FROM community_members WHERE phone = %s", (phone,))
                m = cur.fetchone()
                if m:
                    token = _new_session(cur, phone, member_id=m["id"], purpose="member")
                    cur.execute(
                        "UPDATE community_members SET last_login_at = now() WHERE id = %s",
                        (m["id"],),
                    )
                    _me_cache.pop(m["id"], None)
                    payload_out = _member_payload(cur, m)
                    conn.commit()
                    return {"token": token, "member": payload_out}
                signup_token = _new_session(cur, phone, member_id=None, purpose="signup")
                conn.commit()
                return {
                    "needs_signup": True,
                    "signup_token": signup_token,
                    "phone_masked": _mask_phone(phone),
                }

    @app.post("/api/community/auth/signup")
    def community_signup(request: Request, payload: dict = Body(...)):
        _ensure_tables()
        _throttle(request, "sup", [("ip", 20, 3600), ("global", 500, 3600)])
        token = str(payload.get("signup_token") or "")
        full_name = re.sub(r"\s+", " ", str(payload.get("full_name") or "")).strip()
        email = str(payload.get("email") or "").strip().lower()
        dob_raw = str(payload.get("dob") or "").strip()
        consent = payload.get("consent") is True
        if not consent:
            raise HTTPException(status_code=400, detail="Please accept the membership terms to continue")
        if len(full_name) < 2:
            raise HTTPException(status_code=400, detail="Enter your full name")
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        try:
            dob = datetime.strptime(dob_raw, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Enter your date of birth")
        if dob.year < 1900 or dob > date.today():
            raise HTTPException(status_code=400, detail="Enter a valid date of birth")

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                sess = _session_for(cur, token, purpose="signup")
                if not sess:
                    raise HTTPException(status_code=401, detail="Verification expired — start again")
                phone = sess["phone"]
                match = _match_customer(cur, phone)
                cur.execute(
                    """INSERT INTO community_members
                           (phone, full_name, email, dob, consent_at,
                            customer_id, customer_store_id, last_login_at)
                       VALUES (%s, %s, %s, %s, now(), %s, %s, now())
                       ON CONFLICT (phone) DO NOTHING
                       RETURNING *""",
                    (
                        phone, full_name, email, dob,
                        (match or {}).get("customer_id"),
                        (match or {}).get("store_id"),
                    ),
                )
                m = cur.fetchone()
                if not m:  # raced: member already exists for this phone
                    cur.execute("SELECT * FROM community_members WHERE phone = %s", (phone,))
                    m = cur.fetchone()
                cur.execute("DELETE FROM community_sessions WHERE token_hash = %s",
                            (_hash_token(token),))
                member_token = _new_session(cur, phone, member_id=m["id"], purpose="member")
                payload_out = _member_payload(cur, m)
                conn.commit()
                return {"token": member_token, "member": payload_out}

    @app.post("/api/community/auth/logout")
    def community_logout(request: Request):
        _ensure_tables()
        token = _bearer(request)
        if token:
            with _db() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM community_sessions WHERE token_hash = %s",
                                (_hash_token(token),))
                conn.commit()
        return {"ok": True}

    @app.get("/api/community/me")
    def community_me(request: Request):
        _ensure_tables()
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                m = _require_member(cur, request)
                return {"member": _member_payload(cur, m)}

    # ---------- live catalogue ----------

    @app.get("/api/community/products")
    def community_products(request: Request, category: str = "",
                           limit: int = 24, offset: int = 0):
        _ensure_tables()
        _throttle(request, "prod", [("ip", 120, 60)])
        limit = max(1, min(int(limit or 24), 48))
        offset = max(0, min(int(offset or 0), 960))
        category = (category or "").strip()[:60]
        key = (category, limit, offset)
        cached = _products_cache.get(key)
        if cached and time.time() - cached[0] < _PRODUCTS_TTL:
            return cached[1]

        sql = """
        WITH inv AS (
            SELECT sku, SUM(COALESCE(available,0)) AS soh
            FROM all_inventory
            GROUP BY sku
        ),
        stock AS (
            SELECT p.style_name, COALESCE(p.color_print,'') AS color,
                   SUM(COALESCE(i.soh,0)) AS soh
            FROM all_products_clean p
            LEFT JOIN inv i ON i.sku = p.sku
            GROUP BY 1, 2
        ),
        cards AS (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                p.style_name,
                COALESCE(p.color_print,'') AS color,
                p.sku,
                COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category,
                COALESCE(NULLIF(TRIM(p.product_type),''),'') AS subcategory,
                p.price::float AS price,
                NULLIF(TRIM(COALESCE(p.style_launch_date,'')),'') AS launch
            FROM all_products_clean p
            JOIN product_image_map m ON m.sku = p.sku
            JOIN product_images img ON img.tmpl_id = m.tmpl_id
                 AND COALESCE(img.image_512,'') <> ''
            WHERE p.style_name IS NOT NULL AND p.style_name <> ''
              AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
              AND p.price::float > 0
            ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
        )
        SELECT c.style_name, c.color, c.sku, c.category, c.subcategory,
               c.price, c.launch, s.soh::int AS soh
        FROM cards c
        JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
        WHERE s.soh > 0
          AND (%(cat)s = '' OR c.category = %(cat)s)
        ORDER BY c.launch DESC NULLS LAST, c.style_name, c.color
        LIMIT %(lim)s OFFSET %(off)s
        """
        facet_sql = """
        WITH inv AS (
            SELECT sku, SUM(COALESCE(available,0)) AS soh
            FROM all_inventory GROUP BY sku
        ),
        stock AS (
            SELECT p.style_name, COALESCE(p.color_print,'') AS color,
                   SUM(COALESCE(i.soh,0)) AS soh
            FROM all_products_clean p
            LEFT JOIN inv i ON i.sku = p.sku
            GROUP BY 1, 2
        ),
        cards AS (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print,''))
                p.style_name, COALESCE(p.color_print,'') AS color,
                COALESCE(NULLIF(TRIM(p.category),''),'Uncategorised') AS category
            FROM all_products_clean p
            JOIN product_image_map m ON m.sku = p.sku
            JOIN product_images img ON img.tmpl_id = m.tmpl_id
                 AND COALESCE(img.image_512,'') <> ''
            WHERE p.style_name IS NOT NULL AND p.style_name <> ''
              AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
              AND p.price::float > 0
            ORDER BY p.style_name, COALESCE(p.color_print,''), p.sku
        )
        SELECT c.category, COUNT(*) AS n
        FROM cards c
        JOIN stock s ON s.style_name = c.style_name AND s.color = c.color
        WHERE s.soh > 0
        GROUP BY c.category
        ORDER BY n DESC
        LIMIT 12
        """
        from urllib.parse import quote
        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, {"cat": category, "lim": limit + 1, "off": offset})
                rows = [dict(r) for r in cur.fetchall()]
                cur.execute(facet_sql)
                cats = [{"name": r["category"], "count": int(r["n"])} for r in cur.fetchall()]
        has_more = len(rows) > limit
        items = rows[:limit]
        for r in items:
            r["image_url"] = "/api/community/product-image/" + quote(str(r["sku"]), safe="")
            r.pop("launch", None)
        resp = {"items": items, "categories": cats, "has_more": has_more,
                "limit": limit, "offset": offset}
        _cache_put(_products_cache, key, resp)
        return resp

    @app.get("/api/community/product-image/{sku:path}")
    def community_product_image(request: Request, sku: str):
        """Public product photo (JPEG bytes) for the customer app. Resolves
        the exact SKU first, then any style+colour sibling (all sizes share
        photos). Product photos are non-sensitive; endpoint is public.
        LRU-cached (positive AND negative results) so random-SKU probing
        can't turn into a per-request DB hit."""
        sku = (sku or "").strip()[:80]
        if not sku:
            raise HTTPException(status_code=404, detail="Not found")
        _throttle(request, "img", [("ip", 400, 60)])

        def _serve(data):
            if data is None:
                raise HTTPException(status_code=404, detail="Not found")
            return Response(
                content=data,
                media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )

        with _IMG_LOCK:
            hit = _IMG_CACHE.get(sku)
            if hit and time.time() - hit[0] < _IMG_TTL:
                _IMG_CACHE.move_to_end(sku)
                cached_data = hit[1]
                hit_valid = True
            else:
                _IMG_CACHE.pop(sku, None)
                hit_valid = False
        if hit_valid:
            return _serve(cached_data)

        with _db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT i.image_512 FROM product_image_map m
                       JOIN product_images i ON i.tmpl_id = m.tmpl_id
                       WHERE m.sku = %s AND COALESCE(i.image_512,'') <> ''
                       LIMIT 1""",
                    (sku,),
                )
                row = cur.fetchone()
                if not row:
                    cur.execute(
                        """SELECT i.image_512
                           FROM all_products_clean me
                           JOIN all_products_clean sib
                             ON sib.style_name = me.style_name
                            AND COALESCE(sib.color_print,'') = COALESCE(me.color_print,'')
                           JOIN product_image_map m ON m.sku = sib.sku
                           JOIN product_images i ON i.tmpl_id = m.tmpl_id
                           WHERE me.sku = %s AND COALESCE(i.image_512,'') <> ''
                           LIMIT 1""",
                        (sku,),
                    )
                    row = cur.fetchone()
        data = None
        if row:
            try:
                data = base64.b64decode(row["image_512"])
            except Exception:
                data = None
        if data is None or len(data) <= _IMG_MAX_BYTES:
            with _IMG_LOCK:
                _IMG_CACHE[sku] = (time.time(), data)
                _IMG_CACHE.move_to_end(sku)
                while len(_IMG_CACHE) > _IMG_CAP:
                    _IMG_CACHE.popitem(last=False)
        return _serve(data)

    log.info("community app routes registered")
