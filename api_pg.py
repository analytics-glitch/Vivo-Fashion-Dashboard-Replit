from fastapi import FastAPI, Query, Request, Body
from fastapi.middleware.cors import CORSMiddleware
import calendar
from datetime import date, timedelta
import psycopg2
import psycopg2.extras
import os
import json
import time
import hashlib
import hmac
import base64

# ── PII reveal (step-up) tokens ───────────────────────────────────────────────
# Customer contact PII (phone/email) is masked in every response by default.
# A short-lived, HMAC-signed reveal token — issued by POST /api/auth/verify-password
# after the caller proves the shared ops password — unmasks it for ~10 minutes.
# The token is bound to the caller's user id so it cannot be replayed by another
# session. Signing key is SESSION_SECRET; the ops password is PII_REVEAL_PASSWORD.
_PII_REVEAL_TTL = 10 * 60  # seconds


def _pii_signing_key() -> bytes:
    return (os.environ.get("SESSION_SECRET") or "").encode("utf-8")


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_reveal_token(user_id: str) -> str:
    payload = f"{user_id}:{int(time.time()) + _PII_REVEAL_TTL}"
    sig = hmac.new(_pii_signing_key(), payload.encode("utf-8"), hashlib.sha256).digest()
    return _b64u(payload.encode("utf-8")) + "." + _b64u(sig)


def _reveal_token_valid(token: str, user_id: str) -> bool:
    if not token or not user_id:
        return False
    key = _pii_signing_key()
    if not key:
        # Fail closed: with no signing secret configured, an attacker could forge a
        # token signed with the empty key. Reject all reveal tokens so PII stays masked.
        return False
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        payload = _b64u_dec(payload_b64)
        expected = hmac.new(key, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64u_dec(sig_b64)):
            return False
        tok_user, tok_exp = payload.decode("utf-8").rsplit(":", 1)
        if tok_user != user_id:
            return False
        return int(tok_exp) > int(time.time())
    except (ValueError, TypeError):
        return False


def pii_revealed(request) -> bool:
    """True when the request carries a valid reveal token for its own user."""
    if request is None:
        return False
    token = request.headers.get("X-PII-Reveal-Token")
    if not token:
        return False
    user = getattr(request.state, "user", None) or {}
    return _reveal_token_valid(token, str(user.get("id") or ""))


def mask_phone(p):
    if not p:
        return p
    s = str(p)
    return s if len(s) <= 7 else s[:4] + "***" + s[-3:]


def mask_email(e):
    if not e:
        return e
    s = str(e)
    at = s.find("@")
    return s if at < 1 else s[0] + "***" + s[at:]


def mask_pii_rows(rows, request, phone_keys=("phone",), email_keys=("email",)):
    """Mask phone/email columns in-place unless the request is reveal-authorized."""
    if pii_revealed(request):
        return rows
    for r in rows or []:
        for k in phone_keys:
            if k in r and r[k]:
                r[k] = mask_phone(r[k])
        for k in email_keys:
            if k in r and r[k]:
                r[k] = mask_email(r[k])
    return rows


_cache = {}
# Lightweight counters so the admin Cache pill can show a real hit rate.
_cache_stats = {"hits": 0, "misses": 0, "sets": 0, "evictions": 0}
# Soft cap on the in-process query cache so memory stays bounded in production;
# oldest entries are evicted first. max_entries is surfaced in the Cache pill.
_CACHE_MAX_ENTRIES = 2000
_BOOT_TS = time.time()
# Wall-clock of the last successful DB query — drives the Upstream health pill
# (here "upstream" is the Postgres data source the API reads from directly).
_last_db_success_ts = None

def smart_ttl(date_to=None):
    if not date_to:
        return 120
    try:
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        if date_to >= today:       return 120
        elif date_to >= yesterday: return 600
        else:                      return 3600
    except Exception:
        return 120

def cache_get(key):
    if key in _cache:
        val, ts, ttl = _cache[key]
        if time.time() - ts < ttl:
            _cache_stats["hits"] += 1
            return val
        del _cache[key]
        _cache_stats["evictions"] += 1
    _cache_stats["misses"] += 1
    return None

def cache_set(key, val, ttl=120):
    _cache[key] = (val, time.time(), ttl)
    _cache_stats["sets"] += 1
    # Bound memory: evict the oldest entries once over the soft cap.
    if len(_cache) > _CACHE_MAX_ENTRIES:
        overflow = len(_cache) - _CACHE_MAX_ENTRIES
        for old_key in sorted(_cache, key=lambda k: _cache[k][1])[:overflow]:
            del _cache[old_key]
            _cache_stats["evictions"] += 1

import threading
import contextlib
from psycopg2 import pool as _pg_pool

# Cap concurrent DB connections. The dashboard fires bursts of ~20+ parallel
# requests (KPI sparkline windows + compare + bootstrap), so a fresh
# connect()/close() per query used to exhaust Postgres connections and spike
# latency until the platform health probe killed the server. A bounded pool
# reuses connections; request concurrency is capped below MAX_DB_CONNECTIONS at
# startup so getconn() can never overflow the pool.
MAX_DB_CONNECTIONS = 20

_POOL = None
_POOL_LOCK = threading.Lock()

def _get_pool():
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                _POOL = _pg_pool.ThreadedConnectionPool(
                    minconn=2, maxconn=MAX_DB_CONNECTIONS,
                    dsn=os.environ['DATABASE_URL'],
                    # SECURITY: pin standard_conforming_strings=on for every
                    # pooled connection. SQL is built by concatenation and string
                    # values are escaped by doubling single quotes; that escaping
                    # is only sufficient when backslashes are literal (this
                    # setting on). Enforcing it per-connection means the injection
                    # defenses can't be weakened by a server/role default drift.
                    options='-c standard_conforming_strings=on')
    return _POOL

def get_conn():
    return psycopg2.connect(
        os.environ['DATABASE_URL'],
        options='-c standard_conforming_strings=on')

def run_query(query, date_to=None):
    key = hashlib.md5(query.encode()).hexdigest()
    cached = cache_get(key)
    if cached is not None:
        return cached
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = True  # read-only BI; never leave idle-in-transaction
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query)
        rows = [dict(r) for r in cur.fetchall()]
        cur.close()
    except Exception:
        # A broken connection must not return to the pool poisoned.
        pool.putconn(conn, close=True)
        raise
    else:
        pool.putconn(conn)
    global _last_db_success_ts
    _last_db_success_ts = time.time()
    cache_set(key, rows, ttl=smart_ttl(date_to))
    return rows


def _process_rss_mb():
    # Current resident set size in MB from /proc (Linux), else None.
    try:
        with open("/proc/self/statm") as f:
            pages = int(f.read().split()[1])
        return round(pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024), 1)
    except Exception:
        return None


def _cache_stats_payload():
    # Build the real Cache-health contract the admin pill expects from the
    # in-process query cache and the since-boot counters.
    hits = _cache_stats["hits"]
    misses = _cache_stats["misses"]
    total = hits + misses
    hit_rate = round(hits / total * 100, 1) if total else 0.0

    now = time.time()
    buckets = {"today_120s": 0, "yesterday_600s": 0,
               "historical_3600s": 0, "legacy_or_no_date": 0}
    ages = []
    for _val, ts, ttl in _cache.values():
        ages.append(now - ts)
        if ttl == 120:
            buckets["today_120s"] += 1
        elif ttl == 600:
            buckets["yesterday_600s"] += 1
        elif ttl == 3600:
            buckets["historical_3600s"] += 1
        else:
            buckets["legacy_or_no_date"] += 1
    avg_age = round(sum(ages) / len(ages)) if ages else 0

    return {
        "counters_since_boot": {
            "l1_hits": hits,
            "l2_redis_hits": 0,           # no Redis tier in this deployment
            "misses": misses,
            "hit_rate_pct": hit_rate,
            "inflight_joins": 0,          # no request-coalescing layer
        },
        "miss_analysis": {
            "distinct_keys_missed": 0,    # per-key miss tracking not retained
            "repeat_misses": 0,
            "repeat_miss_pct": 0,
            "top_repeat_offenders": [],
        },
        "in_process_cache": {
            "entries": len(_cache),
            "max_entries": _CACHE_MAX_ENTRIES,
            "ttl_buckets": buckets,
            "avg_age_sec": avg_age,
        },
        "mongo_snapshots": 0,             # snapshots served live from Postgres
        "heavy_guard": {
            "limits": {},
            "in_use": {},
            "rejections_since_boot": {},
        },
        "process": {
            "rss_mb": _process_rss_mb(),
            "uptime_sec": round(now - _BOOT_TS),
        },
    }


app = FastAPI(title="Vivo Fashion Group BI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Clerk auth gate ───────────────────────────────────────────────────────────
# Every /api/* request must carry a valid Clerk session whose verified email is
# on the company-domain allowlist (vivofashiongroup.com / shopzetu.com). The
# health root and the Clerk Frontend-API proxy are exempt. Verification is pure
# stdlib (see clerk_auth.py) — no SDK, because this env's u-root-cmds shadows
# coreutils and breaks the wheels' builds.
import clerk_auth
from fastapi.responses import JSONResponse

# Exact /api paths reachable without a session (health probes + proxy prefix).
_AUTH_PUBLIC_EXACT = {"/api", "/api/", "/api/healthz", "/api/sync-status"}

# Query params that are concatenated into SQL as date literals. We validate them
# to strict ISO dates at the edge so they can never carry SQL-injection payloads
# (a value that parses as a date contains only digits/'-'/':'/'T' — none can
# break out of a '...' string literal). This guards every date-filtered endpoint
# in one place without touching the (heavily '%'-laden) query strings.
_DATE_QUERY_PARAMS = ("date_from", "date_to", "compare_from", "compare_to")

# ── App user store: roles + admin approval ────────────────────────────────────
# Every Clerk-verified, domain-allowed identity gets a row in `app_users` the
# first time we see it. New sign-ups land as `pending` with a default role and
# can only reach their own auth/identity endpoints until an admin approves them.
# Roles persist here (NOT in Clerk) so an admin can grant least-privilege access.
VALID_ROLES = ("viewer", "store_manager", "warehouse", "analyst", "exec", "admin")
VALID_STATUSES = ("pending", "active", "rejected", "disabled")
DEFAULT_NEW_ROLE = "store_manager"
# Paths a signed-in but not-yet-active user may still reach (so the frontend can
# read its own status and poll for approval / sign out).
_AUTH_SELF_PATHS = {
    "/api/auth/me", "/api/auth/me/status",
    "/api/auth/login", "/api/auth/logout", "/api/auth/heartbeat",
}

_USER_CACHE_TTL = 30  # seconds — bounds how long a role/status change lags
_user_cache = {}      # sub -> (record, ts)
_user_cache_lock = threading.Lock()


def _admin_bootstrap_emails():
    raw = os.environ.get("ADMIN_BOOTSTRAP_EMAILS") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _users_exec(query, params=None, fetch=False):
    """Run a parameterised write/read against the user store (never cached)."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params or ())
        rows = [dict(r) for r in cur.fetchall()] if fetch else None
        cur.close()
    except Exception:
        pool.putconn(conn, close=True)
        raise
    else:
        pool.putconn(conn)
    return rows


# Single fixed key for a Postgres transaction-level advisory lock that serializes
# every admin-membership critical section (bootstrap + role/status/delete). This
# turns check-then-write sequences into atomic operations so concurrent requests
# can never both pass a last-admin guard (or both bootstrap a first admin).
_ADMIN_LOCK_KEY = 0x5669766F  # "Vivo"


@contextlib.contextmanager
def _users_tx(lock=False):
    """Run statements atomically against the user store in one transaction.

    When ``lock`` is true, acquire the shared admin advisory lock first so the
    whole critical section is mutually exclusive across requests/threads. The
    advisory lock is transaction-scoped and released automatically on
    commit/rollback. Yields a RealDict cursor; commits on success, rolls back on
    error."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = False
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if lock:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_ADMIN_LOCK_KEY,))
        yield cur
        conn.commit()
        cur.close()
    except Exception:
        try:
            conn.rollback()
            conn.autocommit = True
        except Exception:
            pool.putconn(conn, close=True)
            raise
        pool.putconn(conn)
        raise
    else:
        conn.autocommit = True
        pool.putconn(conn)


def _active_admins_excluding(cur, exclude_user_id=None):
    """Count active admins using an existing transaction cursor (for atomic guards)."""
    if exclude_user_id:
        cur.execute(
            "SELECT COUNT(*) AS n FROM app_users WHERE role='admin' AND status='active' AND user_id <> %s",
            (exclude_user_id,))
    else:
        cur.execute(
            "SELECT COUNT(*) AS n FROM app_users WHERE role='admin' AND status='active'")
    row = cur.fetchone()
    return int(row["n"]) if row else 0


def _ensure_users_table():
    _users_exec("""
        CREATE TABLE IF NOT EXISTS app_users (
            user_id       TEXT PRIMARY KEY,
            email         TEXT UNIQUE NOT NULL,
            name          TEXT,
            role          TEXT NOT NULL DEFAULT 'store_manager',
            status        TEXT NOT NULL DEFAULT 'pending',
            auth_method   TEXT DEFAULT 'google',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            approved_at   TIMESTAMPTZ,
            approved_by   TEXT,
            last_login_at TIMESTAMPTZ
        )
    """)


def _resolve_app_user_db(sub, email, name):
    rows = _users_exec(
        "SELECT user_id, email, name, role, status FROM app_users WHERE user_id=%s",
        (sub,), fetch=True)
    if rows:
        rec = rows[0]
        # Refresh last-login + keep email/name in sync with the IdP, throttled by
        # the cache TTL (this only runs on a cache miss, ~once per 30s per user).
        try:
            _users_exec(
                "UPDATE app_users SET last_login_at=now(), email=%s, "
                "name=COALESCE(NULLIF(%s,''), name) WHERE user_id=%s",
                (email, name or "", sub))
        except Exception:
            pass
        return rec
    # First time we've seen this identity — decide whether to bootstrap an admin.
    # The very first user (or anyone in ADMIN_BOOTSTRAP_EMAILS) becomes an active
    # admin so the system is never left with nobody able to approve others. The
    # "is there an admin yet?" check and the insert run inside one advisory-locked
    # transaction so concurrent first logins cannot each elect themselves admin.
    forced_admin = email.lower() in _admin_bootstrap_emails()
    with _users_tx(lock=True) as cur:
        bootstrap = forced_admin or (_active_admins_excluding(cur) == 0)
        role = "admin" if bootstrap else DEFAULT_NEW_ROLE
        status = "active" if bootstrap else "pending"
        cur.execute("""
            INSERT INTO app_users (user_id, email, name, role, status, auth_method,
                                   last_login_at, approved_at, approved_by)
            VALUES (%s, %s, %s, %s, %s, 'google', now(),
                    CASE WHEN %s='active' THEN now() ELSE NULL END,
                    CASE WHEN %s='active' THEN 'system:bootstrap' ELSE NULL END)
            ON CONFLICT (user_id) DO UPDATE SET last_login_at=now()
            RETURNING user_id, email, name, role, status
        """, (sub, email, name or "", role, status, status, status))
        row = cur.fetchone()
    return dict(row) if row else {
        "user_id": sub, "email": email, "name": name, "role": role, "status": status,
    }


def resolve_app_user(sub, email, name):
    """Return the persisted {user_id,email,name,role,status} for a Clerk identity,
    creating the row on first sight. Cached briefly to spare the DB on request
    bursts; admin mutations invalidate the cache for instant effect."""
    now = time.time()
    with _user_cache_lock:
        cached = _user_cache.get(sub)
        if cached and (now - cached[1]) < _USER_CACHE_TTL:
            return cached[0]
    rec = _resolve_app_user_db(sub, email, name)
    with _user_cache_lock:
        _user_cache[sub] = (rec, now)
    return rec


def _invalidate_user_cache(sub=None):
    with _user_cache_lock:
        if sub:
            _user_cache.pop(sub, None)
        else:
            _user_cache.clear()


def _is_iso_date(v):
    try:
        date.fromisoformat(v)
        return True
    except (ValueError, TypeError):
        return False


@app.middleware("http")
async def clerk_auth_gate(request: Request, call_next):
    path = request.url.path
    # Non-API routes (static assets, SPA fallback) are not gated here.
    if not path.startswith("/api"):
        return await call_next(request)
    # CORS preflight and the Clerk proxy / health endpoints bypass the gate.
    if request.method == "OPTIONS":
        return await call_next(request)
    if path in _AUTH_PUBLIC_EXACT or path.startswith("/api/__clerk"):
        return await call_next(request)
    user, status, detail = clerk_auth.authenticate(request)
    if user is None:
        return JSONResponse({"detail": detail}, status_code=status)
    # Enrich the verified identity with its PERSISTED role + approval status.
    # Fail closed: if the user store is unreachable, deny rather than fall back
    # to the previous "everyone is admin" behaviour.
    try:
        app_user = resolve_app_user(user["id"], user["email"], user.get("name"))
    except Exception:
        return JSONResponse({"detail": "Account store temporarily unavailable"}, status_code=503)
    role = app_user.get("role") or DEFAULT_NEW_ROLE
    ustatus = app_user.get("status") or "pending"
    user["role"] = role
    user["status"] = ustatus
    user["active"] = (ustatus == "active")
    user["user_id"] = user["id"]
    if ustatus != "active":
        user["_restrictionReason"] = ustatus
    request.state.user = user
    # Approval gate: a signed-in but not-active user may only read its own
    # identity / sign out. Everything else (all data + admin) is blocked.
    if ustatus != "active" and path not in _AUTH_SELF_PATHS:
        return JSONResponse(
            {"detail": "Your account is awaiting administrator approval.", "status": ustatus},
            status_code=403,
        )
    # Admin-area gate: only admins may touch /api/admin/*.
    if path.startswith("/api/admin/") and role != "admin":
        return JSONResponse({"detail": "Administrator access required."}, status_code=403)
    # Reject any non-ISO date filter before it reaches a query string literal.
    for _k in _DATE_QUERY_PARAMS:
        _v = request.query_params.get(_k)
        if _v not in (None, "") and not _is_iso_date(_v):
            return JSONResponse(
                {"detail": f"Invalid {_k}: expected ISO date (YYYY-MM-DD)"},
                status_code=400,
            )
    return await call_next(request)

@app.on_event("startup")
def _init_user_store():
    # Idempotently create the app_users table so role/approval state has a home.
    try:
        _ensure_users_table()
    except Exception:
        pass


# Performance indexes for the hot all_sales scans. The base table ships with
# indexes on sale_date / store_id / country, but the customer-analytics paths
# GROUP BY customer_id over the whole table (e.g. global first-purchase in
# exec-summary / churn) which was a full 1.5M-row scan. The partial composite
# below turns the first-purchase + per-customer aggregation into an index scan
# (exec-summary cold load dropped ~25s -> ~10s). Created idempotently so the
# optimisation also applies in production after a fresh DB sync.
# CONCURRENTLY so the build never takes an exclusive lock on the 1.5M-row table
# (a plain CREATE INDEX would block reads AND, critically, block the /api/
# startup healthcheck while it runs — which on a freshly-synced production DB
# made the deployment flap and hang on "Checking session…").
_PERF_INDEXES = [
    ("idx_as_cust_firstpurch",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_as_cust_firstpurch ON all_sales "
     "(customer_id, sale_date) "
     "WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL"),
    ("idx_as_kind_date",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_as_kind_date ON all_sales (sale_kind, sale_date)"),
]


def _build_perf_indexes():
    """Create the hot-path indexes. Runs in a background thread (see the startup
    hook) so it NEVER delays uvicorn binding / the production startup healthcheck.
    Each statement is autocommit + CONCURRENTLY, so a slow first build on a fresh
    DB happens online without blocking queries or the health probe."""
    try:
        pool = _get_pool()
        conn = pool.getconn()
    except Exception:
        return
    try:
        conn.autocommit = True
        cur = conn.cursor()
        for _, sql in _PERF_INDEXES:
            try:
                cur.execute(sql)
            except Exception:
                pass
        cur.close()
    except Exception:
        pool.putconn(conn, close=True)
        return
    pool.putconn(conn)


@app.on_event("startup")
def _ensure_perf_indexes():
    # Fire-and-forget: index maintenance must not block the server from serving
    # the startup healthcheck. A daemon thread dies with the process.
    import threading
    threading.Thread(target=_build_perf_indexes, name="perf-index-build",
                     daemon=True).start()


@app.on_event("startup")
def _cap_threadpool():
    # Sync endpoints run in Starlette's thread pool (default 40). Each can hold a
    # pooled DB connection, so keep concurrency strictly below MAX_DB_CONNECTIONS
    # to guarantee getconn() never overflows the pool under request bursts.
    try:
        import anyio
        anyio.to_thread.current_default_thread_limiter().total_tokens = MAX_DB_CONNECTIONS - 2
    except Exception:
        pass


@app.on_event("startup")
def _assert_standard_conforming_strings():
    # Fail fast if quote-doubling escaping (csv_to_sql et al.) is not backed by
    # standard_conforming_strings=on. We pin it per-connection via libpq options;
    # this asserts it actually took effect rather than trusting the default.
    pool = _get_pool()
    conn = pool.getconn()
    try:
        cur = conn.cursor()
        cur.execute("SHOW standard_conforming_strings")
        setting = cur.fetchone()[0]
        cur.close()
    finally:
        pool.putconn(conn)
    if setting != "on":
        raise RuntimeError(
            "standard_conforming_strings must be 'on' for SQL-injection escaping "
            f"to be sound, got {setting!r}")

BASE_FILTERS = """
    s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda')
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%shopping bag%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%gift card%'
    AND LOWER(COALESCE(s.variant_sku,'')) NOT LIKE '%vb00%'
"""

PRODUCT_SUBCATS = [
    "Knee Length Dresses","Full Length Pants","Fitted Tops","Loose Tops",
    "Maxi Dresses","Waterfalls & Kimonos","Sweaters & Ponchos","Midi & Capri Dresses",
    "T-shirts & Tank Tops","Bodysuits","Jackets & Coats","Leggings",
    "Shorts & Skorts","Knee Length Skirts","Jumpsuits & Playsuits","Midriff & Crop Tops",
    "Maxi Skirts","Short & Mini Dresses","Culottes & Capri Pants",
    "Hoodies & Sweatshirts","Two-Piece Sets","Scarves","Accessories",
]

# Lead-time reorder policy (Phase 1 audit A2). A style is "at risk" when its
# weeks-of-cover falls below lead time + safety stock; reorder_point is the
# recency-weighted weekly velocity carried over that same horizon.
LEAD_TIME_WEEKS = 4.0
SAFETY_WEEKS    = 1.0
REORDER_COVER_WEEKS = LEAD_TIME_WEEKS + SAFETY_WEEKS

WAREHOUSE_LOCATIONS = (
    "'Warehouse Finished Goods','Warehouse Receiving','In Transit',"
    "'Holding Warehouse Finished Goods','Finished Goods Production','Production',"
    "'Buying & Merchandise','Raw Materials','Fabric Trimming','Dead Stock Fabric',"
    "'Cutting - Spreading','Washing','Wandia','Galleria Holding','Studio Location',"
    "'Product Development','Repairs','Sampling Fabric','Sampling','Sale Stock',"
    "'Shopping Bags','Recall Location','Fabric Production','Defects Location',"
    "'Staff purchases'"
)

# Merchandise subcategories — the set of all_products_clean.product_type values
# that count as sellable apparel. MUST stay in lock-step with
# SUBCATEGORY_TO_CATEGORY in artifacts/vivo-bi/src/lib/productCategory.js:
# excludes Accessories and Sample & Sale, matching the BigQuery all_products_clean
# rule (category NOT IN ('Accessories','Sale')). If merchandising adds a new
# subcategory, update BOTH this tuple and productCategory.js.
MERCH_SUBCATEGORIES = (
    "Culottes & Capri Pants", "Full Length Pants", "Jumpsuits & Playsuits",
    "Leggings", "Shorts & Skorts", "Knee Length Dresses", "Maxi Dresses",
    "Midi & Capri Dresses", "Short & Mini Dresses", "Men's Bottoms", "Men's Tops",
    "Hoodies & Sweatshirts", "Jackets & Coats", "Sweaters & Ponchos",
    "Waterfalls & Kimonos", "Knee Length Skirts", "Maxi Skirts",
    "Midi & Capri Skirts", "Short & Mini Skirts", "Bodysuits", "Fitted Tops",
    "Loose Tops", "Midriff & Crop Tops", "T-shirts & Tank Tops", "Pants & Top Set",
    "Pants & Waterfall Set", "Skirts & Top Set",
)
MERCH_SUBCATEGORIES_SQL = "'" + "','".join(
    s.replace("'", "''") for s in MERCH_SUBCATEGORIES
) + "'"

# Subcategory (product_type) -> high-level merch category. Mirrors
# SUBCATEGORY_TO_CATEGORY in artifacts/vivo-bi/src/lib/productCategory.js and MUST
# stay in lock-step with it (and with MERCH_SUBCATEGORIES above).
SUBCATEGORY_TO_CATEGORY = {
    "Accessories": "Accessories", "Bangles & Bracelets": "Accessories",
    "Belts": "Accessories", "Body Mists & Fragrances": "Accessories",
    "Earrings": "Accessories", "Necklaces": "Accessories", "Rings": "Accessories",
    "Scarves": "Accessories",
    "Culottes & Capri Pants": "Bottoms", "Full Length Pants": "Bottoms",
    "Jumpsuits & Playsuits": "Bottoms", "Leggings": "Bottoms",
    "Shorts & Skorts": "Bottoms",
    "Knee Length Dresses": "Dresses", "Maxi Dresses": "Dresses",
    "Midi & Capri Dresses": "Dresses", "Short & Mini Dresses": "Dresses",
    "Men's Bottoms": "Mens", "Men's Tops": "Mens",
    "Hoodies & Sweatshirts": "Outerwear", "Jackets & Coats": "Outerwear",
    "Sweaters & Ponchos": "Outerwear", "Waterfalls & Kimonos": "Outerwear",
    "Sample & Sale Items": "Sale",
    "Knee Length Skirts": "Skirts", "Maxi Skirts": "Skirts",
    "Midi & Capri Skirts": "Skirts", "Short & Mini Skirts": "Skirts",
    "Bodysuits": "Tops", "Fitted Tops": "Tops", "Loose Tops": "Tops",
    "Midriff & Crop Tops": "Tops", "T-shirts & Tank Tops": "Tops",
    "Pants & Top Set": "Two-Piece Sets", "Pants & Waterfall Set": "Two-Piece Sets",
    "Skirts & Top Set": "Two-Piece Sets",
}


def merch_types_for(category=None, subcategory=None):
    """Resolve category/subcategory filter params to a list of product_type
    values, or None when no merch filter applies. An explicit subcategory wins;
    otherwise expand the category(ies) to their subcategories."""
    if subcategory:
        return [s.strip() for s in subcategory.split(",") if s.strip()]
    if category:
        cats = {c.strip() for c in category.split(",") if c.strip()}
        return [sub for sub, cat in SUBCATEGORY_TO_CATEGORY.items() if cat in cats]
    return None

# Operational state persisted in Postgres (Phase 1 audit B0) so it survives a
# server restart: allocation runs (allocation_runs), the replenishment roster
# (app_config), replenishment marks + recommendation actions
# (recommendation_actions), and completed IBT moves (ibt_completions).
_DEFAULT_REPLEN_OWNERS = ["Matthew", "Teddy", "Alvi", "Emma"]


def _replen_owners():
    """Configurable replenishment roster from app_config (falls back to default)."""
    try:
        rows = _users_exec(
            "SELECT value FROM app_config WHERE key='replenishment_owners'",
            fetch=True)
    except Exception:
        rows = None
    if rows:
        val = rows[0].get("value")
        if isinstance(val, str):
            try:
                val = json.loads(val)
            except Exception:
                val = None
        if isinstance(val, list):
            owners = [str(o).strip() for o in val if str(o).strip()]
            if owners:
                return owners
    return list(_DEFAULT_REPLEN_OWNERS)


def _set_replen_owners(owners):
    _users_exec(
        "INSERT INTO app_config (key, value, updated_at) "
        "VALUES ('replenishment_owners', %s::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (json.dumps(owners),))


def _replen_marks():
    """All replenishment marks keyed by (pos_location, kind, value)."""
    rows = _users_exec(
        "SELECT rec_key, actual_units FROM recommendation_actions "
        "WHERE rec_type='replenish' AND status='done'", fetch=True) or []
    marks = {}
    for r in rows:
        parts = (r["rec_key"] or "").split("|", 2)
        if len(parts) == 3:
            marks[(parts[0], parts[1], parts[2])] = {
                "replenished": True,
                "actual_units_replenished": int(r["actual_units"] or 0),
            }
    return marks


def _set_replen_mark(pos_location, kind, value, replenished, actual, acted_by=None):
    rec_key = f"{pos_location}|{kind}|{value}"
    if replenished:
        _users_exec(
            "INSERT INTO recommendation_actions "
            "(rec_type, rec_key, status, actual_units, acted_by, acted_at) "
            "VALUES ('replenish', %s, 'done', %s, %s, now()) "
            "ON CONFLICT (rec_type, rec_key) DO UPDATE SET "
            "status='done', actual_units=EXCLUDED.actual_units, "
            "acted_by=EXCLUDED.acted_by, acted_at=now()",
            (rec_key, actual, acted_by))
    else:
        _users_exec(
            "DELETE FROM recommendation_actions "
            "WHERE rec_type='replenish' AND rec_key=%s", (rec_key,))


def _alloc_runs(status=None):
    if status:
        rows = _users_exec(
            "SELECT payload FROM allocation_runs WHERE status=%s "
            "ORDER BY created_at DESC", (status,), fetch=True)
    else:
        rows = _users_exec(
            "SELECT payload FROM allocation_runs ORDER BY created_at DESC",
            fetch=True)
    return [r["payload"] for r in (rows or [])]


def _alloc_insert(run):
    _users_exec(
        "INSERT INTO allocation_runs (id, payload, status, created_at) "
        "VALUES (%s, %s::jsonb, %s, now())",
        (run["id"], json.dumps(run), run["status"]))


def _alloc_get(run_id):
    rows = _users_exec(
        "SELECT payload FROM allocation_runs WHERE id=%s", (run_id,), fetch=True)
    return rows[0]["payload"] if rows else None


def _alloc_update(run):
    _users_exec(
        "UPDATE allocation_runs SET payload=%s::jsonb, status=%s, "
        "fulfilled_at = CASE WHEN %s='fulfilled' THEN now() ELSE fulfilled_at END "
        "WHERE id=%s",
        (json.dumps(run), run["status"], run["status"], run["id"]))
# Range-management manual tier overrides, keyed by style_name -> {"tier", "reason"}.
# Applied on top of the age-based auto-tier in /range-mgmt/classify.
_RANGE_OVERRIDES = {}

def csv_to_sql(val):
    # Escape embedded single quotes (double them) so comma-separated filter
    # values (country / channel / location) cannot break out of the SQL string
    # literal. Safe because the server runs with standard_conforming_strings=on
    # (backslashes are literal), so doubling quotes is sufficient.
    return "'" + "','".join(v.strip().replace("'", "''") for v in val.split(",")) + "'"

def build_filters(date_from, date_to, country=None, channel=None, extra=None):
    parts = [
        "s.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "'",
        BASE_FILTERS,
    ]
    if country:
        parts.append("s.country IN (" + csv_to_sql(country) + ")")
    if channel:
        parts.append("s.pos_location_name IN (" + csv_to_sql(channel) + ")")
    if extra:
        parts.append(extra)
    return " AND ".join(parts)

@app.get("/api/")
def root():
    return {"status": "ok", "service": "Vivo BI API (PostgreSQL)"}

@app.get("/api/healthz")
def healthz():
    # Lightweight liveness probe — deliberately does NOT touch the DB so it
    # stays green even if Postgres is briefly saturated, and is whitelisted in
    # _AUTH_PUBLIC_EXACT so the platform probe never gets a 401.
    return {"status": "ok"}


@app.get("/api/sync-status")
def sync_status():
    """Sync-pipeline health for the dashboard status pill and external monitors.

    Public (whitelisted in _AUTH_PUBLIC_EXACT): it exposes only timestamps and
    health flags — no business data.

    Health is keyed off the sync-loop HEARTBEAT (sync_heartbeat.last_cycle_at),
    NOT data freshness: during a quiet sales period all_sales.loaded_at
    legitimately stops advancing, so reporting that as CRITICAL would be a false
    alarm. Data freshness (last load) is still reported separately, for info.
    WARNING after 10 min without a heartbeat, CRITICAL after 30 min.
    """
    from datetime import datetime, timezone
    WARN_MIN, CRIT_MIN = 10, 30
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Sync-loop heartbeat (liveness) — drives health.
        heartbeat = None
        cur.execute("SELECT to_regclass('public.sync_heartbeat') AS t")
        if cur.fetchone()["t"]:
            cur.execute("SELECT last_cycle_at, last_status FROM sync_heartbeat WHERE id = 1")
            heartbeat = cur.fetchone()

        # Data freshness (informational) — latest load overall + per store.
        cur.execute("SELECT MAX(loaded_at) AS last FROM all_sales")
        data_last = cur.fetchone()["last"]
        cur.execute(
            "SELECT store_id, MAX(loaded_at) AS last FROM all_sales "
            "GROUP BY store_id ORDER BY 2 DESC NULLS LAST"
        )
        store_rows = cur.fetchall()

        last_check = None
        cur.execute("SELECT to_regclass('public.sync_health_log') AS t")
        if cur.fetchone()["t"]:
            cur.execute(
                "SELECT checked_at, api_healthy, sync_healthy, action_taken, notes "
                "FROM sync_health_log ORDER BY checked_at DESC LIMIT 1"
            )
            h = cur.fetchone()
            if h:
                last_check = {
                    "checked_at": h["checked_at"].isoformat() if h["checked_at"] else None,
                    "api_healthy": h["api_healthy"],
                    "sync_healthy": h["sync_healthy"],
                    "action_taken": h["action_taken"],
                    "notes": h["notes"],
                }
        cur.close()
    except Exception:
        pool.putconn(conn, close=True)
        raise
    else:
        pool.putconn(conn)

    now = datetime.now(timezone.utc)

    def _mins(ts):
        if ts is None:
            return None
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return round((now - ts).total_seconds() / 60.0, 1)

    last_cycle = heartbeat["last_cycle_at"] if heartbeat else None
    minutes = _mins(last_cycle)
    if minutes is None or minutes > CRIT_MIN:
        health = "CRITICAL"
    elif minutes > WARN_MIN:
        health = "WARNING"
    else:
        health = "OK"

    stores = [
        {
            "store_id": r["store_id"],
            "last_sync_at": r["last"].isoformat() if r["last"] else None,
            "minutes_since": _mins(r["last"]),
        }
        for r in store_rows
    ]

    return {
        "health": health,
        "last_sync_at": last_cycle.isoformat() if last_cycle else None,
        "minutes_since": minutes,
        "last_status": heartbeat["last_status"] if heartbeat else None,
        "warning_after_min": WARN_MIN,
        "critical_after_min": CRIT_MIN,
        "data_freshness": {
            "last_loaded_at": data_last.isoformat() if data_last else None,
            "minutes_since": _mins(data_last),
        },
        "stores": stores,
        "last_check": last_check,
    }

@app.get("/api/locations")
def get_locations():
    return run_query("""
        SELECT location_name, country, city, store_type, brand
        FROM pos_locations
        WHERE active = TRUE
        ORDER BY country, location_name
    """)

# Custom report builder — a single SAFE, whitelist-driven aggregation endpoint.
# The user picks dimensions + measures from fixed sets; we never accept raw SQL.
# Any value outside the whitelist is rejected with 400, and the only free-text
# inputs (date range, country/channel filters) flow through the same validated
# build_filters/csv_to_sql escaping used by every other endpoint.
# Each dimension carries: the expression to GROUP BY on the SALES side, the
# matching expression on the INVENTORY side (None when inventory has no such
# dimension), whether it needs the all_products_clean join, a human label, and a
# group tag for the picker UI. Brand/category/subcategory are NOT columns on
# all_sales — they come from all_products_clean joined on the SKU, exactly like
# every other product breakdown in this file. "category"/"product_type" mirror
# the Products page; "store" is the POS location name.
_REPORT_DIMENSIONS = {
    "country":     {"sales": "s.country",                          "inv": "i.country",            "pjoin": False, "label": "Country",     "group": "Geography"},
    "channel":     {"sales": "s.channel",                          "inv": None,                   "pjoin": False, "label": "Channel",     "group": "Geography"},
    "store":       {"sales": "s.pos_location_name",                "inv": "i.pos_location_name",  "pjoin": False, "label": "Store",       "group": "Geography"},
    "brand":       {"sales": "p.brand",                            "inv": "p.brand",              "pjoin": True,  "label": "Brand",       "group": "Product"},
    "category":    {"sales": "p.category",                         "inv": "p.category",           "pjoin": True,  "label": "Category",    "group": "Product"},
    "subcategory": {"sales": "p.product_type",                     "inv": "p.product_type",       "pjoin": True,  "label": "Subcategory", "group": "Product"},
    "month":       {"sales": "to_char(s.sale_date::date,'YYYY-MM')", "inv": None,                 "pjoin": False, "label": "Month",       "group": "Time"},
}

# Sales-grain measures aggregate directly over all_sales (returns netted exactly
# like /api/kpis so the same metric name means the same thing everywhere). AOV
# and ASP are ratios computed inline. Inventory-grain measures (soh, sor) need
# the current stock snapshot and are only valid with inventory-compatible
# dimensions (see _INVENTORY_MEASURES below).
_UNITS = "SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END)"
_ORDERS = "COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)"
_NET = ("SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric "
        "WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END)")
_REPORT_MEASURES = {
    "revenue":      {"sql": "ROUND(SUM(s.total_sales_kes::numeric), 0)",                                                       "label": "Revenue (KES)",        "group": "Sales"},
    "net_revenue":  {"sql": f"ROUND({_NET}, 0)",                                                                               "label": "Net Revenue (KES)",    "group": "Sales"},
    "gross_revenue":{"sql": "ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0)", "label": "Gross Revenue (KES)", "group": "Sales"},
    "returns":      {"sql": "ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0)",          "label": "Returns (KES)",        "group": "Sales"},
    "discounts":    {"sql": "ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0)", "label": "Discounts (KES)",     "group": "Sales"},
    "units":        {"sql": f"COALESCE({_UNITS}, 0)",                                                                          "label": "Units Sold",           "group": "Sales"},
    "orders":       {"sql": _ORDERS,                                                                                           "label": "Orders",               "group": "Sales"},
    "customers":    {"sql": "COUNT(DISTINCT s.customer_id)",                                                                   "label": "Customers",            "group": "Customers"},
    "aov":          {"sql": f"ROUND(SUM(s.total_sales_kes::numeric) / NULLIF({_ORDERS}, 0), 0)",                              "label": "Avg Order Value (KES)","group": "Sales"},
    "asp":          {"sql": f"ROUND(SUM(s.total_sales_kes::numeric) / NULLIF({_UNITS}, 0), 0)",                               "label": "Avg Selling Price (KES)","group": "Sales"},
}
# Inventory-grain measures. soh = current store stock on hand (SUM available,
# warehouse excluded — matches the SOR convention used by /subcategory-stock-sales).
# sor = sell-through % = units sold in period / (units sold + current stock).
_INVENTORY_MEASURES = {
    "soh": {"label": "Stock on Hand", "group": "Inventory"},
    "sor": {"label": "Sell-Through %", "group": "Inventory"},
}


def _report_field_catalog():
    dims = [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _REPORT_DIMENSIONS.items()]
    meas = [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _REPORT_MEASURES.items()]
    meas += [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _INVENTORY_MEASURES.items()]
    return dims, meas


@app.get("/api/custom-report")
def custom_report(
    dimensions: str = Query(default="country"),
    measures:   str = Query(default="revenue"),
    date_from:  str = Query(default=str(date.today().replace(day=1))),
    date_to:    str = Query(default=str(date.today())),
    country:    str = Query(default=None),
    channel:    str = Query(default=None),
    sort:       str = Query(default=None),
    sort_dir:   str = Query(default="desc"),
    limit:      int = Query(default=500),
):
    from fastapi import HTTPException

    dims = [d.strip() for d in (dimensions or "").split(",") if d.strip()]
    meas = [m.strip() for m in (measures or "").split(",") if m.strip()]
    if not dims:
        raise HTTPException(status_code=400, detail="Pick at least one dimension")
    if not meas:
        raise HTTPException(status_code=400, detail="Pick at least one measure")
    all_measures = {**_REPORT_MEASURES, **_INVENTORY_MEASURES}
    bad = [d for d in dims if d not in _REPORT_DIMENSIONS] + [m for m in meas if m not in all_measures]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown field(s): {', '.join(bad)}")

    inv_meas = [m for m in meas if m in _INVENTORY_MEASURES]
    sales_meas = [m for m in meas if m in _REPORT_MEASURES]
    needs_pjoin = any(_REPORT_DIMENSIONS[d]["pjoin"] for d in dims)
    safe_limit = max(1, min(int(limit or 500), 5000))
    order_token = "ASC" if str(sort_dir).lower() == "asc" else "DESC"
    order_col = sort if sort in (dims + meas) else (meas[0] if meas else dims[0])

    def labels():
        return (
            [{"id": d, "label": _REPORT_DIMENSIONS[d]["label"]} for d in dims],
            [{"id": m, "label": all_measures[m]["label"]} for m in meas],
        )

    if not inv_meas:
        # ---- Sales-only path: one grouped scan of all_sales (+product join). ----
        select_parts, group_idx = [], []
        for idx, d in enumerate(dims, start=1):
            select_parts.append(f'{_REPORT_DIMENSIONS[d]["sales"]} AS "{d}"')
            group_idx.append(str(idx))
        for m in sales_meas:
            select_parts.append(f'{_REPORT_MEASURES[m]["sql"]} AS "{m}"')
        join_sql = " LEFT JOIN all_products_clean p ON s.variant_sku = p.sku" if needs_pjoin else ""
        where = build_filters(date_from, date_to, country, channel)
        rows = run_query(
            "SELECT " + ", ".join(select_parts) +
            " FROM all_sales s" + join_sql + " WHERE " + where +
            " GROUP BY " + ", ".join(group_idx) +
            f' ORDER BY "{order_col}" {order_token}' +
            f" LIMIT {safe_limit}",
            date_to=date_to,
        )
        dim_labels, meas_labels = labels()
        return {"dimensions": dim_labels, "measures": meas_labels, "rows": rows,
                "row_count": len(rows), "truncated": len(rows) >= safe_limit}

    # ---- Inventory path: sales aggregate FULL OUTER JOIN current-stock aggregate. ----
    # Inventory is a current snapshot with no channel / time dimension, so those
    # dimensions can't be combined with stock measures.
    incompatible = [d for d in dims if _REPORT_DIMENSIONS[d]["inv"] is None]
    if incompatible:
        names = ", ".join(_REPORT_DIMENSIONS[d]["label"] for d in incompatible)
        raise HTTPException(
            status_code=400,
            detail=f"Stock on Hand / Sell-Through can't be grouped by {names} "
                   "(inventory is a current snapshot with no channel or time). "
                   "Use Country, Store, Brand, Category, or Subcategory.",
        )

    keys = [f"k{i}" for i in range(1, len(dims) + 1)]
    sales_sel = [f'{_REPORT_DIMENSIONS[d]["sales"]} AS {keys[i]}' for i, d in enumerate(dims)]
    inv_sel   = [f'{_REPORT_DIMENSIONS[d]["inv"]} AS {keys[i]}'   for i, d in enumerate(dims)]
    # Always carry units in the sales CTE so SOR is computable even if the user
    # didn't explicitly pick Units.
    sales_measure_sql = {m: _REPORT_MEASURES[m]["sql"] for m in sales_meas}
    sales_measure_sql["__units"] = f"COALESCE({_UNITS}, 0)"
    sales_cte_measures = [f'{sql} AS "{name}"' for name, sql in sales_measure_sql.items()]
    sales_join = " LEFT JOIN all_products_clean p ON s.variant_sku = p.sku" if needs_pjoin else ""
    inv_join   = " LEFT JOIN all_products_clean p ON i.sku = p.sku" if needs_pjoin else ""
    where = build_filters(date_from, date_to, country, channel)

    grp = ", ".join(str(i + 1) for i in range(len(dims)))
    sales_cte = ("SELECT " + ", ".join(sales_sel + sales_cte_measures) +
                 " FROM all_sales s" + sales_join + " WHERE " + where +
                 " GROUP BY " + grp)
    inv_cte = ("SELECT " + ", ".join(inv_sel) + ", SUM(i.available) AS soh"
               " FROM all_inventory i" + inv_join +
               " WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"
               " AND i.available > 0 GROUP BY " + grp)

    # Postgres can't FULL JOIN on IS NOT DISTINCT FROM (not hash/merge-joinable),
    # so match on a NULL-safe COALESCE sentinel instead. All inventory-compatible
    # dimensions are text, so '' is a safe sentinel (real values are NULL, not '').
    on_clause = " AND ".join(f"COALESCE(s.{k}::text,'') = COALESCE(st.{k}::text,'')" for k in keys)
    out_parts = []
    for i, d in enumerate(dims):
        out_parts.append(f'COALESCE(s.{keys[i]}, st.{keys[i]}) AS "{d}"')
    for m in meas:
        if m == "soh":
            out_parts.append('COALESCE(st.soh, 0) AS "soh"')
        elif m == "sor":
            out_parts.append('ROUND(COALESCE(s."__units",0)*100.0 / '
                             'NULLIF(COALESCE(s."__units",0)+COALESCE(st.soh,0),0), 1) AS "sor"')
        else:
            out_parts.append(f'COALESCE(s."{m}", 0) AS "{m}"')

    sql = ("WITH sales AS (" + sales_cte + "), stock AS (" + inv_cte + ") "
           "SELECT " + ", ".join(out_parts) +
           " FROM sales s FULL OUTER JOIN stock st ON " + on_clause +
           " WHERE COALESCE(s." + keys[0] + ", st." + keys[0] + ") IS NOT NULL" +
           f' ORDER BY "{order_col}" {order_token} LIMIT {safe_limit}')
    rows = run_query(sql, date_to=date_to)
    dim_labels, meas_labels = labels()
    return {"dimensions": dim_labels, "measures": meas_labels, "rows": rows,
            "row_count": len(rows), "truncated": len(rows) >= safe_limit}

@app.get("/api/custom-report/fields")
def custom_report_fields():
    dims, meas = _report_field_catalog()
    return {"dimensions": dims, "measures": meas}

@app.get("/api/kpis")
def get_kpis(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS total_discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_returns,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS total_orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS total_units,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0), 0) AS avg_selling_price,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)
                / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) * 100, 2) AS return_rate
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {}

@app.get("/api/country-summary")
def get_country_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
):
    where = build_filters(date_from, date_to)
    return run_query("""
        SELECT s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/sales-summary")
def get_sales_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    return run_query("""
        SELECT s.pos_location_name AS channel, s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/daily-trend")
def get_daily_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, extra="s.sale_kind IN ('sale','order')")
    return run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            SUM(s.ordered_item_quantity) AS units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.gross_sales_kes::numeric), 0) AS gross_sales
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.sale_date, s.country
        ORDER BY s.sale_date, s.country
    """, date_to=date_to)

@app.get("/api/subcategory-sales")
def get_subcategory_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    # total_sales is NET of returns (gross − returns) per the metrics spec: this
    # endpoint, /top-skus and /sor report net sales. Return rows are included so
    # returns_kes is subtracted; units/orders/gross stay sale+order only.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND p.product_type IN (" + subcat_list + ")")
    return run_query("""
        SELECT p.product_type AS subcategory,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                           WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            COUNT(DISTINCT s.order_id) FILTER (WHERE s.sale_kind IN ('sale','order')) AS orders
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        GROUP BY p.product_type
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/top-skus")
def get_top_skus(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
):
    # total_sales is NET of returns (gross − returns) per the metrics spec.
    # Return rows are included so returns_kes is subtracted; units / gross /
    # avg_price stay sale+order only.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND p.style_name IS NOT NULL")
    return run_query("""
        SELECT p.style_name, p.collection, p.brand, p.product_type,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                           WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END)
                / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0), 0) AS avg_price
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        GROUP BY p.style_name, p.collection, p.brand, p.product_type
        ORDER BY units_sold DESC
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/inventory")
def get_inventory(
    location: str = Query(default=None),
    country:  str = Query(default=None),
    product:  str = Query(default=None),
):
    filters = ["i.available > 0"]
    if location:
        filters.append("i.pos_location_name IN (" + csv_to_sql(location) + ")")
    if country:
        filters.append("i.country IN (" + csv_to_sql(country) + ")")
    if product:
        filters.append("LOWER(COALESCE(i.product_name,'')) LIKE '%" + product.lower().replace("'","") + "%'")
    where = " AND ".join(filters)
    return run_query("""
        SELECT i.country, i.pos_location_name AS location_name,
            i.product_name, i.sku,
            p.brand, p.product_type, p.style_name,
            p.color_print, p.size, p.barcode,
            SUM(i.available) AS available
        FROM all_inventory i
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where + """
        GROUP BY i.country, i.pos_location_name, i.product_name, i.sku,
                 p.brand, p.product_type, p.style_name, p.color_print, p.size, p.barcode
        ORDER BY available DESC
        LIMIT 100000
    """)

@app.get("/api/inventory-summary")
def get_inventory_summary(country: str = Query(default=None), locations: str = Query(default=None)):
    # Compact merchandise inventory aggregate so the dashboard renders its KPIs
    # and summary charts from a few dozen rows instead of pulling ~50K SKU rows
    # client-side. by_location keeps ALL locations (warehouse included) so the
    # frontend can split store vs warehouse with its own location regex — that
    # classification stays single-sourced on the client and is not duplicated here.
    # Merch filter mirrors productCategory.js (see MERCH_SUBCATEGORIES).
    filters = ["i.available > 0", "p.product_type IN (" + MERCH_SUBCATEGORIES_SQL + ")"]
    if country:
        # Frontend sends lowercased country names; DB stores them capitalised, so
        # compare case-insensitively (csv_to_sql is case-sensitive).
        filters.append("LOWER(i.country) IN (" + csv_to_sql(country.lower()) + ")")
    if locations:
        filters.append("i.pos_location_name IN (" + csv_to_sql(locations) + ")")
    where = " AND ".join(filters)
    by_location = run_query("""
        SELECT i.pos_location_name AS location, i.country,
            ROUND(SUM(i.available)::numeric, 2) AS units
        FROM all_inventory i
        JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where + """
        GROUP BY i.pos_location_name, i.country
        ORDER BY units DESC
    """)
    by_subcat = run_query("""
        SELECT p.product_type, ROUND(SUM(i.available)::numeric, 2) AS units
        FROM all_inventory i
        JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where + """
        GROUP BY p.product_type
        ORDER BY units DESC
    """)
    totals = run_query("""
        SELECT ROUND(COALESCE(SUM(i.available), 0)::numeric, 2) AS total_units,
            COUNT(DISTINCT i.sku) AS sku_count,
            COUNT(DISTINCT i.pos_location_name) AS location_count
        FROM all_inventory i
        JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where)
    t = totals[0] if totals else {}
    return {
        "total_units": float(t.get("total_units") or 0),
        "sku_count": int(t.get("sku_count") or 0),
        "location_count": int(t.get("location_count") or 0),
        "by_location": [
            {"location": r["location"], "country": r["country"], "units": float(r["units"] or 0)}
            for r in by_location
        ],
        "by_subcat": [
            {"product_type": r["product_type"], "units": float(r["units"] or 0)}
            for r in by_subcat
        ],
    }

@app.get("/api/footfall")
def get_footfall(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    channel:   str = Query(default=None),
):
    ff_filters = ["f.time BETWEEN '" + date_from + "' AND '" + date_to + "'"]
    if channel:
        ff_filters.append("f.pos_location_name IN (" + csv_to_sql(channel) + ")")
    ff_where = " AND ".join(ff_filters)
    sales_where = "s.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "' AND " + BASE_FILTERS
    return run_query("""
        WITH footfall AS (
            SELECT f.pos_location_name,
                SUM(f.a01_footfall_in) AS total_footfall,
                SUM(f.a05_outside_traffic) AS outside_traffic
            FROM footfall f
            WHERE """ + ff_where + """
            GROUP BY f.pos_location_name
        ),
        sales AS (
            SELECT s.pos_location_name,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
                ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket
            FROM all_sales s
            WHERE """ + sales_where + """
            GROUP BY s.pos_location_name
        )
        SELECT f.pos_location_name AS location,
            f.total_footfall, f.outside_traffic,
            ROUND(f.total_footfall * 100.0 / NULLIF(f.outside_traffic, 0), 1) AS turn_in_rate,
            COALESCE(s.orders, 0) AS orders,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(s.avg_basket, 0) AS avg_basket,
            ROUND(COALESCE(s.orders, 0) * 100.0 / NULLIF(f.total_footfall, 0), 1) AS conversion_rate
        FROM footfall f
        LEFT JOIN sales s ON f.pos_location_name = s.pos_location_name
        ORDER BY total_footfall DESC
    """, date_to=date_to)

@app.get("/api/footfall/weekday-pattern")
def get_footfall_weekday(
    date_from: str = Query(default=str((date.today() - timedelta(days=30)).isoformat())),
    date_to:   str = Query(default=str(date.today())),
    channel:   str = Query(default=None),
):
    # LOCATION x WEEKDAY heatmap. Weekday index is 0=Mon..6=Sun (the frontend's
    # WEEKDAY_SHORT convention), derived from Postgres DOW (0=Sun) via (dow+6)%7.
    # Conversion per weekday follows doc 03.7.2: mean(daily_orders / daily_walk_ins),
    # i.e. the average of per-day ratios — NOT pooled sum/sum. Turn-in is the same
    # mean-of-daily-ratios shape (footfall_in / outside_traffic).
    ff_extra = (" AND f.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    sa_extra = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    raw = run_query("""
        WITH ff AS (
            SELECT f.pos_location_name AS location, f.time::date AS d,
                ((EXTRACT(DOW FROM f.time)::int + 6) % 7) AS wd,
                SUM(f.a01_footfall_in) AS footfall,
                SUM(f.a05_outside_traffic) AS outside
            FROM footfall f
            WHERE f.time BETWEEN '""" + date_from + """' AND '""" + date_to + """'""" + ff_extra + """
            GROUP BY f.pos_location_name, f.time::date
        ),
        sa AS (
            SELECT s.pos_location_name AS location, s.sale_date::date AS d,
                COUNT(DISTINCT s.order_id) AS orders
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + sa_extra + """
            GROUP BY s.pos_location_name, s.sale_date::date
        ),
        joined AS (
            SELECT ff.location, ff.wd, ff.footfall, ff.outside, COALESCE(sa.orders, 0) AS orders
            FROM ff LEFT JOIN sa ON sa.location = ff.location AND sa.d = ff.d
        )
        SELECT location, wd AS weekday,
            ROUND(AVG(footfall), 0) AS avg_footfall,
            ROUND(AVG(outside), 0) AS avg_outside_traffic,
            ROUND(AVG(CASE WHEN footfall > 0 THEN orders * 100.0 / footfall END)::numeric, 1) AS avg_conversion_rate,
            ROUND(AVG(CASE WHEN outside > 0 THEN footfall * 100.0 / outside END)::numeric, 1) AS avg_turn_in_rate,
            COUNT(*) AS days,
            COALESCE(SUM(outside), 0) AS sum_outside
        FROM joined
        GROUP BY location, wd
        ORDER BY location, wd
    """, date_to=date_to)

    # Assemble into per-location rows, each with a dense 7-entry by_weekday list
    # (missing weekdays filled with days=0 so the frontend renders a dashed cell).
    by_loc = {}
    for r in raw:
        loc = r["location"]
        slot = by_loc.setdefault(loc, {
            "location": loc,
            "total_outside_window": 0,
            "_cells": {},
        })
        slot["total_outside_window"] += int(r["sum_outside"] or 0)
        slot["_cells"][int(r["weekday"])] = {
            "weekday": int(r["weekday"]),
            "avg_footfall": int(r["avg_footfall"] or 0),
            "avg_outside_traffic": int(r["avg_outside_traffic"] or 0),
            "avg_conversion_rate": float(r["avg_conversion_rate"]) if r["avg_conversion_rate"] is not None else None,
            "avg_turn_in_rate": float(r["avg_turn_in_rate"]) if r["avg_turn_in_rate"] is not None else None,
            "days": int(r["days"] or 0),
        }

    rows = []
    for loc, slot in by_loc.items():
        by_weekday = []
        for wd in range(7):
            by_weekday.append(slot["_cells"].get(wd, {
                "weekday": wd, "avg_footfall": 0, "avg_outside_traffic": 0,
                "avg_conversion_rate": None, "avg_turn_in_rate": None, "days": 0,
            }))
        rows.append({
            "location": loc,
            "total_outside_window": slot["total_outside_window"],
            "by_weekday": by_weekday,
        })
    rows.sort(key=lambda x: -sum(c["avg_footfall"] for c in x["by_weekday"]))

    # Group average per weekday = mean across locations (only cells with data).
    group = []
    for wd in range(7):
        ff_vals = [c["avg_footfall"] for r in rows for c in r["by_weekday"]
                   if c["weekday"] == wd and c["days"] > 0]
        ot_vals = [c["avg_outside_traffic"] for r in rows for c in r["by_weekday"]
                   if c["weekday"] == wd and c["days"] > 0]
        cr_vals = [c["avg_conversion_rate"] for r in rows for c in r["by_weekday"]
                   if c["weekday"] == wd and c["avg_conversion_rate"] is not None]
        ti_vals = [c["avg_turn_in_rate"] for r in rows for c in r["by_weekday"]
                   if c["weekday"] == wd and c["avg_turn_in_rate"] is not None]
        group.append({
            "weekday": wd,
            "avg_footfall": round(sum(ff_vals) / len(ff_vals)) if ff_vals else 0,
            "avg_outside_traffic": round(sum(ot_vals) / len(ot_vals)) if ot_vals else 0,
            "avg_conversion_rate": round(sum(cr_vals) / len(cr_vals), 1) if cr_vals else None,
            "avg_turn_in_rate": round(sum(ti_vals) / len(ti_vals), 1) if ti_vals else None,
        })

    return {
        "rows": rows,
        "group_avg_by_weekday": group,
        "window": {"start": date_from, "end": date_to},
    }

@app.get("/api/customers")
def get_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    channel_filter = ("AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    rows = run_query("""
        WITH period_customers AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND s.customer_id IS NOT NULL
            AND s.customer_id NOT IN ('None','null','')
            AND """ + BASE_FILTERS + " " + country_filter + " " + channel_filter + """
            GROUP BY s.customer_id
        ),
        all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_ever_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        churned AS (
            -- Churn (doc 03.6.2): a customer is churned if they have not
            -- transacted in the last 90 days. The rate denominator is the
            -- "eligible base" = customers old enough to churn (first purchase
            -- before the 90-day cutoff), NOT the period customers — basing it
            -- on period customers produced an absurd ratio.
            SELECT
                COUNT(*) FILTER (WHERE last_sale < CURRENT_DATE - INTERVAL '90 days') AS churned_count,
                COUNT(*) AS eligible_base
            FROM (
                SELECT customer_id,
                    MAX(sale_date::date) AS last_sale
                FROM all_sales
                WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
                  AND customer_id NOT IN ('None','null','')
                GROUP BY customer_id
                HAVING MIN(sale_date::date) < CURRENT_DATE - INTERVAL '90 days'
            ) t
        )
        SELECT
            COUNT(DISTINCT p.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN p.order_count = 1
                AND a.first_ever_purchase BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                THEN p.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN p.order_count > 1 THEN p.customer_id END) AS repeat_customers,
            COUNT(DISTINCT CASE WHEN p.order_count = 1
                AND a.first_ever_purchase < '""" + date_from + """'
                THEN p.customer_id END) AS returning_customers,
            MAX(c.churned_count) AS churned_customers,
            ROUND(AVG(p.total_spend), 0) AS avg_customer_spend,
            ROUND(AVG(p.order_count), 2) AS avg_orders_per_customer,
            ROUND(MAX(c.churned_count) * 100.0 / NULLIF(MAX(c.eligible_base), 0), 2) AS churn_rate
        FROM period_customers p
        LEFT JOIN all_time a ON p.customer_id = a.customer_id
        CROSS JOIN churned c
    """, date_to=date_to)
    return rows[0] if rows else {}

@app.get("/api/top-customers")
def get_top_customers(
    request:   Request,
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
    reveal:    bool = Query(default=False),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    rows = run_query("""
        SELECT
            ROW_NUMBER() OVER (ORDER BY SUM(s.total_sales_kes::numeric) DESC) AS rank,
            s.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone,
            c.email, c.city, c.country AS customer_country,
            COUNT(DISTINCT s.order_id) AS total_orders,
            SUM(s.ordered_item_quantity) AS total_units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.order_id), 0), 0) AS avg_basket,
            MAX(s.sale_date) AS last_purchase_date,
            MIN(s.sale_date) AS first_purchase_date
        FROM all_sales s
        LEFT JOIN all_customers c ON s.customer_id = c.customer_id
        WHERE """ + where + """
        GROUP BY s.customer_id, c.first_name, c.last_name, c.phone, c.email, c.city, c.country
        ORDER BY total_sales DESC
        LIMIT """ + str(limit), date_to=date_to)
    return mask_pii_rows(rows, request)

@app.get("/api/customer-search")
def get_customer_search(
    request:   Request,
    q:         str = Query(default=""),
    date_from: str = Query(default="2020-01-01"),
    date_to:   str = Query(default=str(date.today())),
    reveal:    bool = Query(default=False),
):
    if not q or len(q) < 2:
        return []
    search = q.lower().replace("'", "")
    rows = run_query("""
        WITH sales AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS total_orders,
                SUM(s.ordered_item_quantity) AS total_units,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
                ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.order_id), 0), 0) AS avg_basket,
                MAX(s.sale_date) AS last_purchase_date,
                MIN(s.sale_date) AS first_purchase_date
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL
            AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            GROUP BY s.customer_id
        )
        SELECT sa.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone,
            c.email, c.city, c.country AS customer_country,
            sa.total_orders, sa.total_units, sa.total_sales,
            sa.avg_basket, sa.last_purchase_date, sa.first_purchase_date
        FROM sales sa
        LEFT JOIN all_customers c ON sa.customer_id = c.customer_id
        WHERE (LOWER(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) LIKE '%""" + search + """%'
            OR LOWER(COALESCE(c.phone,'')) LIKE '%""" + search + """%'
            OR LOWER(COALESCE(c.email,'')) LIKE '%""" + search + """%')
        ORDER BY sa.total_sales DESC
        LIMIT 10
    """, date_to=date_to)
    return mask_pii_rows(rows, request)

@app.get("/api/customer-products")
def get_customer_products(customer_id: str = Query(default="")):
    if not customer_id:
        return []
    cid = customer_id.replace("'", "")
    return run_query("""
        SELECT p.style_name, p.product_type AS subcategory, p.brand,
            SUM(s.ordered_item_quantity) AS units_bought,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend,
            MAX(s.sale_date) AS last_bought
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE s.customer_id = '""" + cid + """'
        AND s.sale_kind IN ('sale','order') AND p.style_name IS NOT NULL
        GROUP BY p.style_name, p.product_type, p.brand
        ORDER BY units_bought DESC
        LIMIT 10
    """)

@app.get("/api/customer-frequency")
def get_customer_frequency(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH order_counts AS (
            SELECT customer_id, COUNT(DISTINCT order_id) AS order_count
            FROM all_sales s WHERE """ + where + """
            GROUP BY customer_id
        )
        SELECT
            CASE WHEN order_count = 1 THEN '1 order'
                 WHEN order_count = 2 THEN '2 orders'
                 WHEN order_count = 3 THEN '3 orders'
                 WHEN order_count = 4 THEN '4 orders'
                 ELSE '5+ orders' END AS frequency_bucket,
            COUNT(*) AS customer_count
        FROM order_counts
        GROUP BY frequency_bucket
        ORDER BY MIN(order_count)
    """, date_to=date_to)

@app.get("/api/customer-trend")
def get_customer_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT s.sale_date AS day,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase = s.sale_date THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < s.sale_date THEN s.customer_id END) AS returning_customers
        FROM all_sales s
        LEFT JOIN all_time a ON s.customer_id = a.customer_id
        WHERE """ + where + """
        GROUP BY s.sale_date ORDER BY s.sale_date
    """, date_to=date_to)

@app.get("/api/customers-by-location")
def get_customers_by_location(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH all_time AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase
            FROM all_sales WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT s.pos_location_name, s.country,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase BETWEEN '""" + date_from + """' AND '""" + date_to + """' THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < '""" + date_from + """' THEN s.customer_id END) AS returning_customers,
            ROUND(COUNT(DISTINCT s.customer_id) * 100.0 / NULLIF(SUM(COUNT(DISTINCT s.customer_id)) OVER(), 0), 1) AS pct_of_total
        FROM all_sales s
        LEFT JOIN all_time a ON s.customer_id = a.customer_id
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        ORDER BY total_customers DESC
    """, date_to=date_to)

@app.get("/api/churned-customers")
def get_churned_customers(
    request: Request,
    days:  int = Query(default=90),
    limit: int = Query(default=20),
    reveal: bool = Query(default=False),
):
    rows = run_query("""
        WITH last_purchase AS (
            SELECT s.customer_id,
                MAX(s.sale_date::date) AS last_purchase_date,
                MIN(s.sale_date::date) AS first_purchase_date,
                COUNT(DISTINCT s.order_id) AS total_orders,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS lifetime_spend
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL
            AND s.customer_id NOT IN ('None','null','')
            AND """ + BASE_FILTERS + """
            GROUP BY s.customer_id
        )
        SELECT lp.customer_id,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS customer_name,
            COALESCE(c.phone,'') AS phone, c.email,
            lp.last_purchase_date, lp.first_purchase_date,
            lp.total_orders, lp.lifetime_spend,
            CURRENT_DATE - lp.last_purchase_date AS days_since_last_purchase
        FROM last_purchase lp
        LEFT JOIN all_customers c ON lp.customer_id = c.customer_id
        WHERE CURRENT_DATE - lp.last_purchase_date > """ + str(days) + """
        ORDER BY lp.lifetime_spend DESC
        LIMIT """ + str(limit))
    return mask_pii_rows(rows, request)

@app.get("/api/analytics/customer-details")
def analytics_customer_details(
    request:     Request,
    date_from:   str = Query(default="2020-01-01"),
    date_to:     str = Query(default=str(date.today())),
    country:     str = Query(default=None),
    channel:     str = Query(default=None),
    category:    str = Query(default=None),
    subcategory: str = Query(default=None),
    limit:       int = Query(default=2000),
    reveal:      bool = Query(default=False),
):
    # One row per identified customer with name / contact / lifetime stats over
    # the window. Phone & email are masked unless a valid PII reveal token is
    # presented. Optional merch category / subcategory narrows to buyers of those
    # product types (requires joining the product catalogue).
    types = merch_types_for(category, subcategory)
    type_join = ""
    type_filter = ""
    if types:
        type_join = "LEFT JOIN all_products_clean p ON s.variant_sku = p.sku"
        types_sql = "'" + "','".join(t.replace("'", "''") for t in types) + "'"
        type_filter = "AND p.product_type IN (" + types_sql + ")"
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL "
              "AND s.customer_id NOT IN ('None','null','') " + type_filter)
    rows = run_query("""
        SELECT s.customer_id,
            c.first_name, c.last_name, c.email,
            COALESCE(c.phone,'') AS mobile,
            c.city, c.country AS customer_country,
            COUNT(DISTINCT s.order_id) AS total_orders,
            SUM(s.ordered_item_quantity) AS total_units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            MIN(s.sale_date) AS first_order_date,
            MAX(s.sale_date) AS last_order_date
        FROM all_sales s
        LEFT JOIN all_customers c ON s.customer_id = c.customer_id
        """ + type_join + """
        WHERE """ + where + """
        GROUP BY s.customer_id, c.first_name, c.last_name, c.email, c.phone, c.city, c.country
        ORDER BY total_sales DESC
        LIMIT """ + str(limit), date_to=date_to)
    return mask_pii_rows(rows, request, phone_keys=("mobile",), email_keys=("email",))

@app.get("/api/new-customer-products")
def get_new_customer_products(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=20),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        WITH new_customers AS (
            SELECT customer_id FROM all_sales
            WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
            HAVING MIN(sale_date) BETWEEN '""" + date_from + """' AND '""" + date_to + """'
        )
        SELECT p.style_name, p.product_type AS subcategory, p.brand,
            SUM(s.ordered_item_quantity) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.total_sales_kes::numeric) * 100.0 / NULLIF(SUM(SUM(s.total_sales_kes::numeric)) OVER(), 0), 1) AS pct_of_new_customer_sales
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        AND s.customer_id IN (SELECT customer_id FROM new_customers)
        GROUP BY p.style_name, p.product_type, p.brand
        ORDER BY units_sold DESC
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/sor")
def get_sor(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # total_sales is NET of returns (gross − returns) per the metrics spec.
    # Return rows are included so returns_kes is subtracted; units_sold (which
    # drives sor_percent) stays sale+order only.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND p.style_name IS NOT NULL")
    return run_query("""
        SELECT p.style_name, p.collection, p.brand, p.product_type,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                           WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            COALESCE(MAX(i.current_stock), 0) AS current_stock,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) * 100.0 /
                NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) + COALESCE(MAX(i.current_stock), 0), 0), 1) AS sor_percent
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        LEFT JOIN (
            SELECT p2.style_name, SUM(i2.available) AS current_stock
            FROM all_inventory i2
            LEFT JOIN all_products_clean p2 ON i2.sku = p2.sku
            WHERE i2.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p2.style_name
        ) i ON p.style_name = i.style_name
        WHERE """ + where + """
        GROUP BY p.style_name, p.collection, p.brand, p.product_type
        ORDER BY units_sold DESC
        LIMIT 200
    """, date_to=date_to)

@app.get("/api/subcategory-stock-sales")
def get_subcategory_stock_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.product_type IN (" + subcat_list + ")")
    return run_query("""
        WITH sales AS (
            SELECT p.product_type AS subcategory,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.product_type
        ),
        stock AS (
            SELECT p.product_type AS subcategory, SUM(i.available) AS current_stock
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type
        )
        SELECT COALESCE(s.subcategory, st.subcategory) AS subcategory,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(st.current_stock, 0) AS current_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0),2) AS pct_of_total_sold,
            ROUND(COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0),2) AS pct_of_total_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(COALESCE(s.units_sold,0)+COALESCE(st.current_stock,0),0),1) AS sor_percent
        FROM sales s
        FULL OUTER JOIN stock st ON s.subcategory = st.subcategory
        WHERE COALESCE(s.subcategory, st.subcategory) IS NOT NULL
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/orders")
def get_orders(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=1000),
):
    where = build_filters(date_from, date_to, country, channel)
    return run_query("""
        SELECT s.order_id, s.order_name, s.sale_date AS order_date,
            s.pos_location_name, s.country,
            s.customer_id, s.customer_type, s.sale_kind,
            s.product_title, s.variant_sku AS sku,
            p.style_name, p.brand, p.collection,
            p.product_type AS subcategory, p.color_print AS color, p.size,
            s.ordered_item_quantity AS quantity,
            ROUND(s.product_price_kes::numeric, 0) AS unit_price_kes,
            ROUND(s.total_sales_kes::numeric, 0) AS total_sales_kes,
            ROUND(s.gross_sales_kes::numeric, 0) AS gross_sales_kes,
            ROUND(s.discounts_kes::numeric, 0) AS discount_kes,
            ROUND(s.returns_kes::numeric, 0) AS returns_kes,
            ROUND(s.net_sales_kes::numeric, 0) AS net_sales_kes
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE """ + where + """
        ORDER BY s.sale_date DESC, s.order_id
        LIMIT """ + str(limit), date_to=date_to)

@app.get("/api/stock-to-sales")
def get_stock_to_sales(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    inv_country_filter = ("AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH sales AS (
            SELECT s.pos_location_name, s.country,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND """ + BASE_FILTERS + " " + country_filter + """
            GROUP BY s.pos_location_name, s.country
        ),
        inventory AS (
            SELECT i.pos_location_name, i.country, SUM(i.available) AS total_stock
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            """ + inv_country_filter + """
            GROUP BY i.pos_location_name, i.country
        )
        SELECT s.pos_location_name AS location, s.country,
            s.units_sold, s.total_sales,
            COALESCE(i.total_stock, 0) AS current_stock,
            ROUND(COALESCE(i.total_stock,0)::numeric / NULLIF(s.units_sold, 0), 2) AS stock_to_sales_ratio
        FROM sales s
        LEFT JOIN inventory i ON s.pos_location_name = i.pos_location_name
        ORDER BY stock_to_sales_ratio DESC
    """, date_to=date_to)

@app.get("/api/customer-type-spend")
def get_customer_type_spend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH first_purchase AS (
            SELECT customer_id, MIN(sale_date) AS first_purchase_date
            FROM all_sales WHERE sale_kind = 'order' AND customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        window_sales AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS orders,
                SUM(s.total_sales_kes::numeric) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind = 'order' AND s.customer_id IS NOT NULL
            """ + country_filter + """
            GROUP BY s.customer_id
        )
        SELECT
            CASE WHEN f.first_purchase_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                THEN 'New' ELSE 'Returning' END AS customer_segment,
            COUNT(DISTINCT w.customer_id) AS customers,
            SUM(w.orders) AS orders,
            ROUND(SUM(w.total_sales), 0) AS total_sales,
            ROUND(SUM(w.total_sales) / NULLIF(COUNT(DISTINCT w.customer_id), 0), 0) AS spend_per_customer,
            ROUND(SUM(w.total_sales) / NULLIF(SUM(w.orders), 0), 0) AS avg_basket_value
        FROM window_sales w
        JOIN first_purchase f ON w.customer_id = f.customer_id
        GROUP BY customer_segment
        ORDER BY customer_segment
    """, date_to=date_to)


# ── Auth endpoints (Clerk-verified) ───────────────────────────────────────────
# The auth gate has already verified the Clerk session + domain allowlist by the
# time these run, so `request.state.user` is the authenticated company account.
@app.get("/api/auth/me")
def auth_me(request: Request):
    return getattr(request.state, "user", None) or {}

@app.get("/api/auth/me/status")
def auth_me_status(request: Request):
    u = getattr(request.state, "user", None) or {}
    return {"status": u.get("status", "active")}

@app.post("/api/auth/login")
def auth_login(request: Request):
    user = getattr(request.state, "user", None) or {}
    return {"token": "clerk-session", "user": user}

@app.post("/api/auth/logout")
def auth_logout():
    return {"ok":True}

# ══════════════════════════════════════════════════════════════════════════════
# PART A — REAL DATA endpoints (appended)
# ══════════════════════════════════════════════════════════════════════════════

def _country_summary_q(date_from, date_to, country=None, channel=None):
    if not date_from or not date_to:
        return []
    where = build_filters(date_from, date_to, country, channel)
    return run_query("""
        SELECT s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

def _daily_by_country_q(date_from, date_to, country=None, channel=None):
    if not date_from or not date_to:
        return {}
    where = build_filters(date_from, date_to, country, channel, extra="s.sale_kind IN ('sale','order')")
    rows = run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            SUM(s.ordered_item_quantity) AS units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.sale_date, s.country
        ORDER BY s.sale_date, s.country
    """, date_to=date_to)
    out = {}
    for r in rows:
        c = r.get("country") or "Other"
        out.setdefault(c, []).append({
            "day": r.get("day"),
            "total_sales": r.get("total_sales"),
            "orders": r.get("orders"),
            "units": r.get("units"),
        })
    return out

@app.get("/api/bootstrap/overview")
def bootstrap_overview(
    date_from:    str = Query(default=str(date.today().replace(day=1))),
    date_to:      str = Query(default=str(date.today())),
    country:      str = Query(default=None),
    channel:      str = Query(default=None),
    compare_from: str = Query(default=None),
    compare_to:   str = Query(default=None),
):
    has_prev = bool(compare_from and compare_to)
    return {
        "country_summary":      _country_summary_q(date_from, date_to, country, channel),
        "country_summary_prev": _country_summary_q(compare_from, compare_to, country, channel) if has_prev else [],
        "sales_summary":        get_sales_summary(date_from, date_to, country, channel),
        "sales_summary_prev":   get_sales_summary(compare_from, compare_to, country, channel) if has_prev else [],
        "top_styles":           get_top_skus(date_from, date_to, country, channel, 10),
        "subcategory_sales":      get_subcategory_sales(date_from, date_to, country, channel),
        "subcategory_sales_prev": get_subcategory_sales(compare_from, compare_to, country, channel) if has_prev else [],
        "footfall":             get_footfall(date_from, date_to, channel),
        "footfall_prev":        get_footfall(compare_from, compare_to, channel) if has_prev else [],
        "locations":            get_locations(),
        "daily_by_country":      _daily_by_country_q(date_from, date_to, country, channel),
        "daily_by_country_prev": _daily_by_country_q(compare_from, compare_to, country, channel) if has_prev else {},
    }

@app.get("/api/analytics/canonical-units-sold")
def analytics_canonical_units_sold(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Total units sold under BASE_FILTERS (which already excludes shopping bags,
    # staff purchases, manual orders and the Uganda online channel). We do NOT
    # restrict by product_type here. The variant_sku -> all_products_clean.sku
    # join is actually sound (~98% of sale rows match), but all_sales.product_type
    # is ~97% NULL and joined product_type only covers ~70% of sold units, so any
    # product_type filter would drop ~30% of real units and contradict the ASP /
    # transactions KPIs computed off the same base.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0")
    rows = run_query("""
        SELECT COALESCE(SUM(s.ordered_item_quantity), 0) AS units_sold
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return {"units_sold": int((rows[0].get("units_sold") if rows and rows[0].get("units_sold") is not None else 0))}

@app.get("/api/analytics/inventory-summary")
def analytics_inventory_summary(country: str = Query(default=None), locations: str = Query(default=None)):
    return get_inventory_summary(country, locations)

@app.get("/api/analytics/total-sales-summary")
def analytics_total_sales_summary(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0), 0) AS net_sales,
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0), 0) AS gross_sales,
            COALESCE(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0) AS orders,
            COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0) AS units
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {"total_sales": 0, "net_sales": 0, "gross_sales": 0, "orders": 0, "units": 0}

@app.get("/api/analytics/active-pos")
def analytics_active_pos(
    n_days:  int = Query(default=30),
    country: str = Query(default=None),
):
    # Active POS detection (business rule 6.4): a physical store that (1) is not an
    # excluded location, (2) whose channel name does NOT contain "online" or
    # "third-party", and (3) sold >= 1 unit in the last N days (default 30). The
    # window is rolling-N-days, NOT the global date filter — the FilterBar POS
    # dropdown should list stores that *currently* trade, regardless of the view.
    date_from = str(date.today() - timedelta(days=max(1, n_days)))
    date_to   = str(date.today())
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') "
              "AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
              "AND LOWER(s.pos_location_name) NOT LIKE '%online%' "
              "AND LOWER(s.pos_location_name) NOT LIKE '%third-party%' "
              "AND LOWER(s.pos_location_name) NOT LIKE '%third party%'")
    return run_query("""
        SELECT s.pos_location_name AS channel, s.country,
            COUNT(DISTINCT s.order_id) AS orders,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(SUM(s.ordered_item_quantity), 0) AS units_sold
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.pos_location_name, s.country
        HAVING SUM(s.ordered_item_quantity) >= 1
        ORDER BY total_sales DESC
    """, date_to=date_to)

@app.get("/api/analytics/sell-through-by-location")
def analytics_sell_through_by_location(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    sales_where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")")
    inv_country_filter = ("AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    return run_query("""
        WITH sales AS (
            SELECT s.pos_location_name AS location, s.country,
                SUM(s.ordered_item_quantity) AS units_sold
            FROM all_sales s
            WHERE """ + sales_where + """
            GROUP BY s.pos_location_name, s.country
        ),
        inv AS (
            SELECT i.pos_location_name AS location, i.country,
                SUM(i.available) AS available
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            """ + inv_country_filter + """
            GROUP BY i.pos_location_name, i.country
        )
        SELECT COALESCE(s.location, i.location) AS location,
            COALESCE(s.country, i.country) AS country,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(i.available, 0) AS available,
            ROUND(COALESCE(s.units_sold, 0) * 100.0 /
                NULLIF(COALESCE(s.units_sold, 0) + COALESCE(i.available, 0), 0), 1) AS sell_through
        FROM sales s
        FULL OUTER JOIN inv i ON s.location = i.location
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/analytics/sor-all-styles")
def analytics_sor_all_styles(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # total_sales is NET of returns (gross − returns) per the metrics spec.
    # Return rows are included so returns_kes is subtracted; units_sold (which
    # drives sor_percent) stays sale+order only.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND p.style_name IS NOT NULL")
    return run_query("""
        SELECT p.style_name, p.collection, p.brand, p.product_type,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                           WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            COALESCE(MAX(i.current_stock), 0) AS current_stock,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) * 100.0 /
                NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) + COALESCE(MAX(i.current_stock), 0), 0), 1) AS sor_percent
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        LEFT JOIN (
            SELECT p2.style_name, SUM(i2.available) AS current_stock
            FROM all_inventory i2
            LEFT JOIN all_products_clean p2 ON i2.sku = p2.sku
            WHERE i2.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p2.style_name
        ) i ON p.style_name = i.style_name
        WHERE """ + where + """
        GROUP BY p.style_name, p.collection, p.brand, p.product_type
        ORDER BY units_sold DESC
        LIMIT 5000
    """, date_to=date_to)

@app.get("/api/analytics/stock-to-sales-by-category")
def analytics_sts_by_category(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.category IS NOT NULL AND p.category <> ''")
    return run_query("""
        WITH sales AS (
            SELECT p.category AS category,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.category
        ),
        stock AS (
            SELECT p.category AS category, SUM(i.available) AS current_stock
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.category IS NOT NULL AND p.category <> ''
            GROUP BY p.category
        )
        SELECT COALESCE(s.category, st.category) AS category,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(st.current_stock, 0) AS current_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0),2) AS pct_of_total_sold,
            ROUND(COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0),2) AS pct_of_total_stock,
            ROUND(COALESCE(s.units_sold,0)*100.0/NULLIF(COALESCE(s.units_sold,0)+COALESCE(st.current_stock,0),0),1) AS sor_percent,
            ROUND(
                COALESCE(s.units_sold,0)*100.0/NULLIF(SUM(COALESCE(s.units_sold,0)) OVER(),0)
                - COALESCE(st.current_stock,0)*100.0/NULLIF(SUM(COALESCE(st.current_stock,0)) OVER(),0)
            , 2) AS variance
        FROM sales s
        FULL OUTER JOIN stock st ON s.category = st.category
        WHERE COALESCE(s.category, st.category) IS NOT NULL
        ORDER BY units_sold DESC
    """, date_to=date_to)

@app.get("/api/analytics/stock-to-sales-by-subcat")
def analytics_sts_by_subcat(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    rows = get_subcategory_stock_sales(date_from, date_to, country, channel)
    for r in rows:
        sold = r.get("pct_of_total_sold") or 0
        stock = r.get("pct_of_total_stock") or 0
        try:
            r["variance"] = round(float(sold) - float(stock), 2)
        except (TypeError, ValueError):
            r["variance"] = 0
    return rows

def _period_weeks(date_from, date_to):
    # Number of whole-ish weeks covered by the selected range (inclusive),
    # floored at 1 so rate-of-sale never divides by zero. Computed in Python
    # and injected as a literal — sale_date is TEXT so SQL date math on it is
    # avoided here.
    try:
        d0 = date.fromisoformat(str(date_from)[:10])
        d1 = date.fromisoformat(str(date_to)[:10])
        return f"{max(1.0, ((d1 - d0).days + 1) / 7.0):.4f}"
    except Exception:
        return "1.0"

@app.get("/api/analytics/velocity")
def analytics_velocity(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Sell-through velocity by style. rate_of_sale = units sold / weeks in the
    # selected period; weeks_of_cover = current store stock / rate_of_sale.
    # sell_through follows the SOR convention (sold / (sold + current stock)).
    # Current stock excludes warehouses, matching every other stock breakdown.
    weeks = _period_weeks(date_from, date_to)
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        WITH sales AS (
            SELECT p.style_name, p.brand, p.product_type,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.style_name, p.brand, p.product_type
        ),
        stock AS (
            SELECT p.style_name, SUM(i.available) AS current_stock
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p.style_name
        )
        SELECT sa.style_name, sa.brand, sa.product_type,
            sa.units_sold, sa.total_sales,
            COALESCE(st.current_stock, 0) AS current_stock,
            ROUND(sa.units_sold / """ + weeks + """, 1) AS rate_of_sale,
            CASE WHEN sa.units_sold > 0
                 THEN ROUND(COALESCE(st.current_stock, 0) / (sa.units_sold / """ + weeks + """), 1)
                 ELSE NULL END AS weeks_of_cover,
            ROUND(sa.units_sold * 100.0 /
                NULLIF(sa.units_sold + COALESCE(st.current_stock, 0), 0), 1) AS sell_through
        FROM sales sa
        LEFT JOIN stock st ON sa.style_name = st.style_name
        ORDER BY rate_of_sale DESC
        LIMIT 5000
    """, date_to=date_to)

@app.get("/api/analytics/size-curve")
def analytics_size_curve(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Size-curve health by style: how many of a style's catalogued sizes are
    # currently in stock across selling locations (warehouses excluded). A
    # "broken" curve = catalogued sizes that are out of stock. units_sold over
    # the selected period is attached so best-sellers with broken curves surface
    # first. Only styles with a real size run (>= 2 sizes) are returned.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    return run_query("""
        WITH sales AS (
            SELECT p.style_name, SUM(s.ordered_item_quantity) AS units_sold
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.style_name
        ),
        catalog AS (
            SELECT style_name, NULLIF(TRIM(size), '') AS size
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND NULLIF(TRIM(size), '') IS NOT NULL
            GROUP BY style_name, NULLIF(TRIM(size), '')
        ),
        stock AS (
            SELECT p.style_name, NULLIF(TRIM(p.size), '') AS size, SUM(i.available) AS avail
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND p.style_name IS NOT NULL AND NULLIF(TRIM(p.size), '') IS NOT NULL
            GROUP BY p.style_name, NULLIF(TRIM(p.size), '')
        ),
        curve AS (
            SELECT c.style_name,
                COUNT(*) AS total_sizes,
                COUNT(*) FILTER (WHERE COALESCE(st.avail, 0) > 0) AS sizes_in_stock,
                string_agg(CASE WHEN COALESCE(st.avail, 0) <= 0 THEN c.size END, ', ' ORDER BY c.size) AS missing_sizes
            FROM catalog c
            LEFT JOIN stock st ON c.style_name = st.style_name AND c.size = st.size
            GROUP BY c.style_name
        ),
        meta AS (
            SELECT style_name, MAX(brand) AS brand, MAX(category) AS category,
                MAX(product_type) AS product_type
            FROM all_products_clean WHERE style_name IS NOT NULL GROUP BY style_name
        )
        SELECT cu.style_name, m.brand, m.category, m.product_type,
            COALESCE(sa.units_sold, 0) AS units_sold,
            cu.total_sizes,
            cu.sizes_in_stock,
            cu.total_sizes - cu.sizes_in_stock AS broken_sizes,
            ROUND(cu.sizes_in_stock * 100.0 / NULLIF(cu.total_sizes, 0), 0) AS health_pct,
            cu.missing_sizes
        FROM curve cu
        LEFT JOIN sales sa ON cu.style_name = sa.style_name
        LEFT JOIN meta m ON cu.style_name = m.style_name
        WHERE cu.total_sizes >= 2
        ORDER BY units_sold DESC, broken_sizes DESC
        LIMIT 3000
    """, date_to=date_to)

_MARGIN_DIMS = {
    "category":    "p.category",
    "subcategory": "p.product_type",
    "brand":       "p.brand",
    "store":       "s.pos_location_name",
    "month":       "to_char(s.sale_date::date,'YYYY-MM')",
}

@app.get("/api/analytics/margin")
def analytics_margin(
    dim:       str = Query(default="category"),
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Markdown / discount impact on gross margin. COGS uses
    # all_products_clean.cost (per-unit landed cost). cost is not known for every
    # SKU, so gross_margin / margin_pct are computed over the COSTED subset only
    # (lines with cost > 0) and cost_coverage (% of units with a known cost) is
    # returned so the margin figure is read honestly. discount_rate =
    # discounts / gross (pre-discount). net_revenue nets returns like /api/kpis.
    col = _MARGIN_DIMS.get(dim, _MARGIN_DIMS["category"])
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND COALESCE(" + col + ", '') <> ''")
    return run_query("""
        WITH base AS (
            SELECT """ + col + """ AS dim,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END) AS gross,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END) AS discounts,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                         WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END) AS net_revenue,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') AND p.cost IS NOT NULL AND p.cost > 0
                         THEN s.ordered_item_quantity ELSE 0 END) AS costed_units,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') AND p.cost IS NOT NULL AND p.cost > 0
                         THEN s.net_sales_kes::numeric ELSE 0 END) AS costed_net,
                SUM(CASE WHEN s.sale_kind IN ('sale','order') AND p.cost IS NOT NULL AND p.cost > 0
                         THEN s.ordered_item_quantity * p.cost ELSE 0 END) AS cogs
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY """ + col + """
        )
        SELECT dim,
            units,
            ROUND(gross, 0) AS gross,
            ROUND(discounts, 0) AS discounts,
            ROUND(discounts * 100.0 / NULLIF(gross, 0), 1) AS discount_rate,
            ROUND(net_revenue, 0) AS net_revenue,
            ROUND(cogs, 0) AS cogs,
            ROUND(costed_net - cogs, 0) AS gross_margin,
            ROUND((costed_net - cogs) * 100.0 / NULLIF(costed_net, 0), 1) AS margin_pct,
            ROUND(costed_units * 100.0 / NULLIF(units, 0), 0) AS cost_coverage
        FROM base
        WHERE units > 0
        ORDER BY net_revenue DESC
        LIMIT 2000
    """, date_to=date_to)

@app.get("/api/analytics/rfm")
def analytics_rfm(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
    limit:     int = Query(default=2000),
):
    # RFM segmentation over customers active in the selected period. Recency is
    # measured against date_to; R/F/M each scored 1-5 via quintiles (NTILE) and
    # combined into the canonical RFM segment grid (FM = avg of F and M). Returns
    # a per-segment summary over the FULL base plus the top customers by monetary
    # value (capped). monetary nets returns like /api/kpis.
    lim = max(1, min(int(limit or 2000), 5000))
    ref = str(date_to)[:10]
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND s.customer_id IS NOT NULL AND s.customer_id <> ''")
    monetary_expr = ("SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric "
                     "WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END)")
    freq_expr = "COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END)"
    base_cte = """
        WITH cust AS (
            SELECT s.customer_id,
                MAX(s.sale_date::date) AS last_purchase,
                """ + freq_expr + """ AS frequency,
                """ + monetary_expr + """ AS monetary
            FROM all_sales s
            WHERE """ + where + """
            GROUP BY s.customer_id
            HAVING """ + monetary_expr + """ > 0 AND """ + freq_expr + """ > 0
        ),
        scored AS (
            SELECT customer_id, last_purchase, frequency, monetary,
                ('""" + ref + """'::date - last_purchase) AS recency_days,
                NTILE(5) OVER (ORDER BY ('""" + ref + """'::date - last_purchase) DESC) AS r_score,
                NTILE(5) OVER (ORDER BY frequency ASC) AS f_score,
                NTILE(5) OVER (ORDER BY monetary ASC) AS m_score
            FROM cust
        ),
        seg AS (
            SELECT customer_id, last_purchase, frequency, monetary, recency_days,
                r_score, f_score, m_score,
                ROUND((f_score + m_score) / 2.0) AS fm,
                CASE
                    WHEN r_score >= 4 AND ROUND((f_score + m_score) / 2.0) >= 4 THEN 'Champions'
                    WHEN r_score >= 3 AND ROUND((f_score + m_score) / 2.0) >= 3 THEN 'Loyal'
                    WHEN r_score >= 4 AND ROUND((f_score + m_score) / 2.0) BETWEEN 2 AND 3 THEN 'Potential Loyalist'
                    WHEN r_score >= 4 AND ROUND((f_score + m_score) / 2.0) <= 1 THEN 'New'
                    WHEN r_score = 3 AND ROUND((f_score + m_score) / 2.0) <= 2 THEN 'Promising'
                    WHEN r_score <= 2 AND ROUND((f_score + m_score) / 2.0) >= 4 THEN 'Cant Lose Them'
                    WHEN r_score = 2 AND ROUND((f_score + m_score) / 2.0) >= 3 THEN 'At Risk'
                    WHEN r_score <= 2 AND ROUND((f_score + m_score) / 2.0) = 2 THEN 'Hibernating'
                    ELSE 'Lost'
                END AS segment
            FROM scored
        )
    """
    summary = run_query(base_cte + """
        SELECT segment,
            COUNT(*) AS customers,
            ROUND(SUM(monetary), 0) AS monetary,
            ROUND(AVG(recency_days), 0) AS avg_recency_days,
            ROUND(AVG(frequency), 1) AS avg_frequency,
            ROUND(AVG(monetary), 0) AS avg_monetary
        FROM seg
        GROUP BY segment
        ORDER BY monetary DESC
    """, date_to=date_to)
    customers = run_query(base_cte + """
        SELECT customer_id, segment, recency_days, frequency,
            ROUND(monetary, 0) AS monetary,
            r_score, f_score, m_score
        FROM seg
        ORDER BY monetary DESC
        LIMIT """ + str(lim) + """
    """, date_to=date_to)
    return {"summary": summary, "customers": customers}

@app.get("/api/analytics/new-styles")
def analytics_new_styles(
    days:  int = Query(default=90),
    limit: int = Query(default=200),
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Sell-Out Rate is computed launch-to-date (units sold since launch vs the
    # units sold plus current store stock), so the re-order list reflects how
    # much of the launch buy has already sold through.
    if date_from and date_to:
        period_extra = "s2.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "'"
    else:
        period_extra = "TRUE"
    return run_query("""
        WITH new_styles AS (
            SELECT p.style_name,
                MAX(p.brand) AS brand,
                MAX(p.product_type) AS product_type,
                MAX(p.product_type) AS subcategory,
                MIN(p.style_launch_date) AS style_launch_date
            FROM all_products_clean p
            WHERE p.style_name IS NOT NULL
              AND p.style_launch_date IS NOT NULL
              AND substring(p.style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND substring(p.style_launch_date, 1, 10)::date >= CURRENT_DATE - (""" + str(int(days)) + """ || ' days')::interval
            GROUP BY p.style_name
        ),
        launch AS (
            SELECT p.style_name,
                COALESCE(SUM(s.net_quantity), 0) AS units_sold_launch,
                COALESCE(ROUND(SUM(s.net_sales_kes::numeric)), 0) AS total_sales_launch
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku AND s.sale_kind IN ('sale','order')
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
            GROUP BY p.style_name
        ),
        period AS (
            SELECT p.style_name,
                COALESCE(ROUND(SUM(s2.net_sales_kes::numeric)), 0) AS total_sales_period
            FROM all_products_clean p
            JOIN all_sales s2 ON s2.variant_sku = p.sku AND s2.sale_kind IN ('sale','order')
            WHERE p.style_name IN (SELECT style_name FROM new_styles) AND """ + period_extra + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT p.style_name, COALESCE(SUM(i.available), 0) AS current_stock
            FROM all_products_clean p
            JOIN all_inventory i ON i.sku = p.sku
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
              AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p.style_name
        )
        SELECT ns.style_name, ns.brand, ns.product_type, ns.subcategory, ns.style_launch_date,
            COALESCE(l.units_sold_launch, 0) AS units_sold,
            COALESCE(l.total_sales_launch, 0) AS total_sales,
            COALESCE(l.units_sold_launch, 0) AS units_sold_launch,
            COALESCE(l.total_sales_launch, 0) AS total_sales_launch,
            COALESCE(pr.total_sales_period, 0) AS total_sales_period,
            COALESCE(st.current_stock, 0) AS current_stock,
            COALESCE(st.current_stock, 0) AS stock_available,
            ROUND(100.0 * COALESCE(l.units_sold_launch, 0)
                  / NULLIF(COALESCE(l.units_sold_launch, 0) + COALESCE(st.current_stock, 0), 0), 1) AS sor_percent
        FROM new_styles ns
        LEFT JOIN launch l USING (style_name)
        LEFT JOIN period pr USING (style_name)
        LEFT JOIN stock st USING (style_name)
        ORDER BY ns.style_launch_date DESC, units_sold_launch DESC
        LIMIT """ + str(int(limit)))

@app.get("/api/analytics/aged-stock")
def analytics_aged_stock(
    min_days_since_sale: int = Query(default=60),
    days:                int = Query(default=None),
):
    # Per SKU-store row of store stock that hasn't sold in >= N days at that
    # store. Shape matches AgedStockReport.jsx. `days` kept as a back-compat alias
    # for the min-days threshold. Never-sold SKUs surface with the 999 sentinel so
    # the frontend renders "Never". soh = store on-hand, soh_warehouse = WH on-hand
    # for the same SKU so the merchandiser sees the full replenishable footprint.
    n = int(days) if days is not None else int(min_days_since_sale)
    return run_query("""
        WITH last_sale AS (
            SELECT variant_sku AS sku, MAX(sale_date) AS last_sold,
                SUM(CASE WHEN sale_date::date >= CURRENT_DATE - INTERVAL '180 days'
                         THEN ordered_item_quantity ELSE 0 END) AS units_180
            FROM all_sales
            WHERE sale_kind IN ('sale','order')
            GROUP BY variant_sku
        ),
        wh AS (
            SELECT sku, SUM(available) AS soh_warehouse
            FROM all_inventory
            WHERE pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY sku
        )
        SELECT i.pos_location_name AS pos_location,
            i.sku,
            MAX(i.product_name) AS product_name,
            MAX(p.size) AS size,
            MAX(p.barcode) AS barcode,
            MAX(i.color_print) AS color,
            COALESCE(MAX(ls.units_180), 0) AS units_sold_180d,
            SUM(i.available) AS soh,
            COALESCE(MAX(wh.soh_warehouse), 0) AS soh_warehouse,
            CASE WHEN MAX(ls.last_sold) IS NULL THEN 999
                 ELSE (CURRENT_DATE - MAX(ls.last_sold)::date) END AS days_since_last_sale,
            MAX(ls.last_sold) AS last_sale_date
        FROM all_inventory i
        LEFT JOIN last_sale ls ON i.sku = ls.sku
        LEFT JOIN wh ON i.sku = wh.sku
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        WHERE i.available > 0
        AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
        AND (ls.last_sold IS NULL
             OR ls.last_sold::date < CURRENT_DATE - (""" + str(n) + """ || ' days')::interval)
        GROUP BY i.pos_location_name, i.sku
        ORDER BY days_since_last_sale DESC, soh DESC
        LIMIT 1000
    """)

@app.get("/api/inventory/freshness")
def inventory_freshness():
    rows = _users_exec("""
        SELECT pos_location_name,
            MAX(_loaded_at) AS last_updated,
            ROUND((EXTRACT(EPOCH FROM (now() - MAX(_loaded_at))) / 3600.0)::numeric, 1) AS hours_since_update,
            (now() - MAX(_loaded_at) > INTERVAL '24 hours') AS stale
        FROM all_inventory
        GROUP BY pos_location_name
        ORDER BY last_updated ASC NULLS FIRST
    """, fetch=True) or []
    for r in rows:
        if r.get("last_updated") is not None:
            r["last_updated"] = r["last_updated"].isoformat()
        if r.get("hours_since_update") is not None:
            r["hours_since_update"] = float(r["hours_since_update"])
    return rows

@app.get("/api/analytics/weeks-of-cover")
def analytics_weeks_of_cover(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
):
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    reorder_weeks = str(REORDER_COVER_WEEKS)
    # Recency-weighted weekly velocity (Phase 1 audit A1): the last 28 days count
    # double, the prior 28 days single, over a 12-week-equivalent denominator.
    return run_query("""
        WITH sales AS (
            SELECT p.product_type AS subcategory, p.style_name,
                SUM(s.ordered_item_quantity) FILTER (
                    WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '28 days') AS units_28,
                SUM(s.ordered_item_quantity) AS units_56
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order')
            AND s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
            AND """ + BASE_FILTERS + """
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name
        ),
        stock AS (
            SELECT p.product_type AS subcategory, p.style_name,
                SUM(i.available) AS available
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name
        ),
        base AS (
            SELECT COALESCE(st.subcategory, sa.subcategory) AS subcategory,
                COALESCE(st.style_name, sa.style_name) AS style_name,
                COALESCE(st.available, 0) AS available,
                COALESCE(sa.units_28, 0) AS units_28,
                COALESCE(sa.units_56, 0) AS units_56,
                ((COALESCE(sa.units_28, 0) * 2)
                  + GREATEST(COALESCE(sa.units_56, 0) - COALESCE(sa.units_28, 0), 0)) / 12.0
                  AS weekly_units
            FROM stock st
            FULL OUTER JOIN sales sa
                ON st.subcategory = sa.subcategory AND st.style_name = sa.style_name
            WHERE COALESCE(st.style_name, sa.style_name) IS NOT NULL
        )
        SELECT subcategory, style_name, available,
            available AS current_stock,
            ROUND(weekly_units, 2) AS weekly_units,
            units_28 AS units_sold_28d,
            ROUND(available / NULLIF(weekly_units, 0), 1) AS weeks_of_cover,
            ROUND(weekly_units * """ + reorder_weeks + """)::int AS reorder_point,
            (available < weekly_units * """ + reorder_weeks + """) AS at_risk
        FROM base
        ORDER BY available DESC
        LIMIT 2000
    """)

@app.get("/api/analytics/repeat-customers")
def analytics_repeat_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    return run_query("""
        WITH cust AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend_kes,
                MIN(s.sale_date) AS first_order_date,
                MAX(s.sale_date) AS last_order_date,
                SUM(s.ordered_item_quantity) AS total_units
            FROM all_sales s
            WHERE """ + where + """
            GROUP BY s.customer_id
            HAVING COUNT(DISTINCT s.order_id) >= 2
        )
        SELECT c.customer_id,
            CONCAT(COALESCE(cu.first_name,''), ' ', COALESCE(cu.last_name,'')) AS customer_name,
            COALESCE(cu.phone,'') AS mobile,
            cu.email,
            c.order_count, c.total_spend_kes, c.total_units,
            c.first_order_date, c.last_order_date
        FROM cust c
        LEFT JOIN all_customers cu ON c.customer_id = cu.customer_id
        ORDER BY c.total_spend_kes DESC
        LIMIT 500
    """, date_to=date_to)

@app.get("/api/analytics/customer-retention")
def analytics_customer_retention(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    cust = get_customers(date_from, date_to, country, channel)
    total = cust.get("total_customers") or 0
    repeat = cust.get("repeat_customers") or 0
    new = cust.get("new_customers") or 0
    try:
        repeat_rate = round(float(repeat) * 100.0 / float(total), 2) if total else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        repeat_rate = 0.0
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')")
    months = run_query("""
        SELECT substring(s.sale_date, 1, 7) AS month,
            COUNT(DISTINCT s.customer_id) AS customers
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY substring(s.sale_date, 1, 7)
        ORDER BY month
    """, date_to=date_to)
    return {
        "repeat_rate_pct": repeat_rate,
        "repeat_customers": repeat,
        "new_customers": new,
        "total_customers": total,
        "months": months,
    }

@app.get("/api/analytics/customer-crosswalk")
def analytics_customer_crosswalk(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    top:       int = Query(default=15),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','') AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")")
    return run_query("""
        WITH cust_stores AS (
            SELECT DISTINCT s.customer_id, s.pos_location_name
            FROM all_sales s
            WHERE """ + where + """
        ),
        totals AS (
            SELECT pos_location_name, COUNT(DISTINCT customer_id) AS n
            FROM cust_stores GROUP BY pos_location_name
        )
        SELECT a.pos_location_name AS store_a,
            b.pos_location_name AS store_b,
            COUNT(DISTINCT a.customer_id) AS shared_customers,
            ROUND(COUNT(DISTINCT a.customer_id) * 100.0 / NULLIF(LEAST(ta.n, tb.n), 0), 2) AS pct_overlap
        FROM cust_stores a
        JOIN cust_stores b
            ON a.customer_id = b.customer_id AND a.pos_location_name < b.pos_location_name
        JOIN totals ta ON ta.pos_location_name = a.pos_location_name
        JOIN totals tb ON tb.pos_location_name = b.pos_location_name
        GROUP BY a.pos_location_name, b.pos_location_name, ta.n, tb.n
        ORDER BY shared_customers DESC
        LIMIT 100
    """, date_to=date_to)

@app.get("/api/customers/churn-rate")
def customers_churn_rate():
    rows = run_query("""
        -- Churn (doc 03.6.2): churned = no transaction in the last 90 days.
        -- Rate = churned / eligible base (customers whose first purchase was
        -- before the 90-day cutoff, i.e. old enough to be assessed).
        WITH per_customer AS (
            SELECT customer_id,
                MAX(sale_date::date) AS last_sale,
                MIN(sale_date::date) AS first_sale
            FROM all_sales
            WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
              AND customer_id NOT IN ('None','null','')
            GROUP BY customer_id
        ),
        agg AS (
            SELECT
                COUNT(*) FILTER (WHERE last_sale < CURRENT_DATE - INTERVAL '90 days') AS churned_count,
                COUNT(*) AS eligible_base
            FROM per_customer
            WHERE first_sale < CURRENT_DATE - INTERVAL '90 days'
        )
        SELECT churned_count, eligible_base AS base,
            ROUND(churned_count * 100.0 / NULLIF(eligible_base, 0), 2) AS churn_rate
        FROM agg
    """)
    if not rows:
        return {"churn_rate": 0, "churned_count": 0, "churned_customers": 0, "base": 0}
    r = rows[0]
    r["churned_customers"] = r.get("churned_count")
    return r

@app.get("/api/customers/walk-ins")
def customers_walk_ins(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country,
        extra="s.sale_kind IN ('sale','order') AND (s.customer_id IS NULL OR s.customer_id IN ('None','null',''))")
    rows = run_query("""
        SELECT COALESCE(COUNT(DISTINCT s.order_id), 0) AS orders,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(SUM(s.ordered_item_quantity), 0) AS units
        FROM all_sales s
        WHERE """ + where, date_to=date_to)
    return rows[0] if rows else {"orders": 0, "total_sales": 0, "units": 0}


# ══════════════════════════════════════════════════════════════════════════════
# IBT (Inter-Branch Transfer) — real data
#   Store-to-store moves a SKU from a store where the style is barely selling
#   (≤ low_pct of the style's per-store average) but has stock, to a store
#   selling strongly (≥ high_pct of average) but running low. Warehouses are
#   excluded. Warehouse-to-store covers shop-floor gaps from warehouse stock.
# ══════════════════════════════════════════════════════════════════════════════

def _sql_str(s):
    return (s or "").replace("'", "''")

def _ibt_suggestions_sql(date_from, date_to, country, low, high, lim):
    """Shared IBT suggestions SQL builder (Phase 1 audit B6). Excludes
    dead-stock styles (>16 weeks cover AND <5% sell-through over 56 days) from
    both the donor and recipient sides so we never recommend moving dead stock.
    Reused by both /analytics/ibt-suggestions and /ibt/late-count."""
    c_sales = ("AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = ("AND i.country = '" + _sql_str(country) + "'") if country else ""
    return f"""
    WITH sv AS (
      SELECT p.style_name AS style, s.pos_location_name AS store,
             SUM(s.net_quantity) AS units_sold,
             CASE WHEN SUM(s.net_quantity) > 0
                  THEN SUM(s.net_sales_kes) / SUM(s.net_quantity) END AS asp
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date BETWEEN '{date_from}' AND '{date_to}'
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT IN ('Manual Order','Online - vivo-uganda')
        AND COALESCE(p.style_name,'') <> '' {c_sales}
      GROUP BY 1, 2
    ),
    inv AS (
      SELECT p.style_name AS style, i.pos_location_name AS store,
             SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2
    ),
    combined AS (
      SELECT COALESCE(sv.style, inv.style) AS style,
             COALESCE(sv.store, inv.store) AS store,
             COALESCE(sv.units_sold, 0) AS units_sold,
             COALESCE(inv.available, 0) AS available, sv.asp
      FROM sv FULL OUTER JOIN inv ON sv.style = inv.style AND sv.store = inv.store
    ),
    stats AS (
      SELECT style, AVG(units_sold) AS avg_u, MAX(asp) AS asp
      FROM combined GROUP BY style HAVING COUNT(*) >= 2 AND AVG(units_sold) > 0
    ),
    style_inv AS (
      SELECT p.style_name AS style, SUM(i.available) AS avail
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1
    ),
    style_sales56 AS (
      SELECT p.style_name AS style, SUM(s.net_quantity) AS u56
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1
    ),
    dead AS (
      SELECT iv.style
      FROM style_inv iv
      LEFT JOIN style_sales56 sa ON sa.style = iv.style
      WHERE (COALESCE(sa.u56, 0) = 0
             OR (iv.avail::numeric * 8.0 / NULLIF(sa.u56, 0)) > 16.0)
        AND (COALESCE(sa.u56, 0)::numeric
             / NULLIF(COALESCE(sa.u56, 0) + iv.avail, 0) < 0.05
             OR (COALESCE(sa.u56, 0) + iv.avail) = 0)
    ),
    froms AS (
      SELECT c.style, c.store, c.available
      FROM combined c JOIN stats st ON st.style = c.style
      WHERE c.available >= 3 AND c.units_sold <= {low} * st.avg_u
        AND NOT EXISTS (SELECT 1 FROM dead d WHERE d.style = c.style)
    ),
    tos AS (
      SELECT c.style, c.store, c.available, c.units_sold
      FROM combined c JOIN stats st ON st.style = c.style
      WHERE c.units_sold >= {high} * st.avg_u AND c.available <= 2
        AND NOT EXISTS (SELECT 1 FROM dead d WHERE d.style = c.style)
    ),
    pairs AS (
      SELECT DISTINCT ON (f.style)
             f.style, f.store AS from_store, f.available AS from_avail,
             t.store AS to_store, t.available AS to_avail, t.units_sold AS to_sold
      FROM froms f JOIN tos t ON t.style = f.style AND t.store <> f.store
      ORDER BY f.style, f.available DESC, t.units_sold DESC
    )
    SELECT pr.style AS style_name, pp.brand, pp.category AS subcategory,
           pr.from_store, pr.to_store,
           GREATEST(LEAST(pr.from_avail - 2, GREATEST(pr.to_sold - pr.to_avail, 1)), 1)::int AS units_to_move,
           ROUND(GREATEST(LEAST(pr.from_avail - 2, GREATEST(pr.to_sold - pr.to_avail, 1)), 1)
                 * COALESCE(st.asp, 0))::numeric AS estimated_uplift,
           COALESCE(fsv.units_sold, 0)::int AS from_qty_sold_28d,
           pr.to_sold::int AS to_qty_sold_28d
    FROM pairs pr
    JOIN stats st ON st.style = pr.style
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = pr.style LIMIT 1
    ) pp ON TRUE
    LEFT JOIN combined fsv ON fsv.style = pr.style AND fsv.store = pr.from_store
    ORDER BY estimated_uplift DESC NULLS LAST
    LIMIT {lim}
    """


@app.get("/api/analytics/ibt-suggestions")
def ibt_suggestions(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    limit:     int = Query(default=300),
    low_pct:   float = Query(default=20),
    high_pct:  float = Query(default=150),
):
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    low = float(low_pct) / 100.0
    high = float(high_pct) / 100.0
    lim = max(1, min(int(limit), 1000))
    q = _ibt_suggestions_sql(date_from, date_to, country, low, high, lim)
    return run_query(q, date_to=date_to)


@app.get("/api/analytics/ibt-sku-breakdown")
def ibt_sku_breakdown(
    style_name:    str = Query(...),
    from_store:    str = Query(...),
    to_store:      str = Query(...),
    units_to_move: int = Query(default=0),
):
    st = _sql_str(style_name)
    fs = _sql_str(from_store)
    ts = _sql_str(to_store)
    q = f"""
    WITH skus AS (
      SELECT DISTINCT p.sku, p.color_print AS color, p.size, p.barcode
      FROM all_products_clean p WHERE p.style_name = '{st}'
    ),
    fi AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{fs}' GROUP BY sku),
    ti AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{ts}' GROUP BY sku)
    SELECT s.sku, s.color, s.size, s.barcode,
           COALESCE(fi.av, 0)::int AS from_available,
           COALESCE(ti.av, 0)::int AS to_available,
           LEAST(
             CASE WHEN COALESCE(fi.av,0) > 2 THEN COALESCE(fi.av,0) - 1 ELSE 0 END,
             GREATEST(2 - COALESCE(ti.av,0), 0)
           )::int AS suggested_qty
    FROM skus s
    LEFT JOIN fi ON fi.sku = s.sku
    LEFT JOIN ti ON ti.sku = s.sku
    WHERE COALESCE(fi.av,0) > 0 OR COALESCE(ti.av,0) > 0
    ORDER BY suggested_qty DESC, from_available DESC
    """
    skus = run_query(q)
    return {
        "from_store": from_store,
        "to_store": to_store,
        "from_total": sum(r["from_available"] for r in skus),
        "to_total": sum(r["to_available"] for r in skus),
        "suggested_total": sum(r["suggested_qty"] for r in skus),
        "skus": skus,
    }


@app.get("/api/analytics/ibt-warehouse-to-store")
def ibt_warehouse_to_store(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    limit:     int = Query(default=300),
):
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    lim = max(1, min(int(limit), 1000))
    c_sales = ("AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = ("AND i.country = '" + _sql_str(country) + "'") if country else ""
    q = f"""
    WITH sv AS (
      SELECT p.style_name AS style, s.pos_location_name AS store,
             SUM(s.net_quantity) AS units_sold
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date BETWEEN '{date_from}' AND '{date_to}'
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT IN ('Manual Order','Online - vivo-uganda')
        AND COALESCE(p.style_name,'') <> '' {c_sales}
      GROUP BY 1, 2 HAVING SUM(s.net_quantity) >= 3
    ),
    si AS (
      SELECT p.style_name AS style, i.pos_location_name AS store,
             SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2
    ),
    wh AS (
      SELECT p.style_name AS style, SUM(i.available) AS available
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name = 'Warehouse Finished Goods'
        AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1
    )
    SELECT sv.style AS style_name, pp.brand, pp.category AS subcategory,
           sv.store AS to_store,
           GREATEST(LEAST(wh.available, sv.units_sold - COALESCE(si.available, 0)), 1)::int AS suggested_qty,
           sv.units_sold::int AS to_qty_sold_28d
    FROM sv
    JOIN wh ON wh.style = sv.style AND wh.available > 0
    LEFT JOIN si ON si.style = sv.style AND si.store = sv.store
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = sv.style LIMIT 1
    ) pp ON TRUE
    WHERE COALESCE(si.available, 0) <= 2
    ORDER BY suggested_qty DESC
    LIMIT {lim}
    """
    return run_query(q, date_to=date_to)


# ══════════════════════════════════════════════════════════════════════════════
# PART B — STUB endpoints (non-crashing typed payloads)
# ══════════════════════════════════════════════════════════════════════════════

# --- GET stubs returning [] ---
@app.get("/api/admin/active-sessions")
def stub_admin_active_sessions(): return []
@app.get("/api/admin/activity-logs")
def stub_admin_activity_logs(): return []
@app.get("/api/admin/audit-log")
def stub_admin_audit_log(): return []
@app.get("/api/admin/store-clusters")
def admin_store_clusters(forceFresh: bool = Query(default=False)):
    rows = run_query("""
        WITH base AS (
            SELECT s.pos_location_name AS store, s.country, s.order_id, s.net_quantity,
                s.net_sales_kes::numeric AS rev, s.product_type, s.variant_sku
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'
        )
        SELECT b.store, MAX(b.country) AS country,
            ROUND(SUM(b.rev) / NULLIF(SUM(b.net_quantity), 0)) AS asp,
            ROUND(SUM(b.net_quantity)::numeric / NULLIF(COUNT(DISTINCT b.order_id), 0), 2) AS avg_basket_units,
            ROUND(SUM(b.rev)) AS revenue_90d,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%top%' OR b.product_type ILIKE '%shirt%' OR b.product_type ILIKE '%blouse%' OR b.product_type ILIKE '%bodysuit%' OR b.product_type ILIKE '%sweater%' OR b.product_type ILIKE '%hood%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_tops,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%pant%' OR b.product_type ILIKE '%skirt%' OR b.product_type ILIKE '%short%' OR b.product_type ILIKE '%legging%' OR b.product_type ILIKE '%culotte%' OR b.product_type ILIKE '%dress%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_bottoms,
            ROUND(100.0 * SUM(CASE WHEN b.product_type ILIKE '%accessor%' OR b.product_type ILIKE '%scar%' THEN b.net_quantity ELSE 0 END) / NULLIF(SUM(b.net_quantity), 0), 1) AS pct_accessories,
            MODE() WITHIN GROUP (ORDER BY p.size) FILTER (WHERE p.size IS NOT NULL AND p.size <> '') AS size_cog
        FROM base b
        LEFT JOIN all_products_clean p ON p.sku = b.variant_sku
        GROUP BY b.store
        HAVING SUM(b.net_quantity) > 0
        ORDER BY revenue_90d DESC
    """)
    for r in rows:
        for k in ("asp", "avg_basket_units", "revenue_90d", "pct_tops", "pct_bottoms", "pct_accessories"):
            r[k] = float(r[k]) if r.get(k) is not None else 0.0
    n = len(rows)

    def tier_for(idx):
        if n == 0:
            return "C"
        if idx < max(1, n // 3):
            return "A"
        if idx < max(2, (2 * n) // 3):
            return "B"
        return "C"

    tier_meta = {
        "A": ("A - Flagship", "Top-revenue stores driving the bulk of group sales over the last 90 days."),
        "B": ("B - Core", "Mid-tier stores with steady, dependable throughput."),
        "C": ("C - Developing", "Smaller-volume stores still building traction."),
    }
    clusters, by_store = {}, {}
    for i, r in enumerate(rows):
        t = tier_for(i)
        label, explainer = tier_meta[t]
        cid = "cluster_" + t
        c = clusters.setdefault(cid, {"id": cid, "tier": label, "size": 0, "explainer": explainer, "members": []})
        c["members"].append(r["store"])
        c["size"] += 1
        by_store[r["store"]] = {
            "tier": label, "cluster_id": cid, "country": r.get("country"),
            "asp": r["asp"], "avg_basket_units": r["avg_basket_units"],
            "size_cog": r.get("size_cog") or "-",
            "pct_tops": r["pct_tops"], "pct_bottoms": r["pct_bottoms"],
            "pct_accessories": r["pct_accessories"], "revenue_90d": r["revenue_90d"],
        }
    return {
        "ok": True,
        "computed_at": (date.today()).isoformat(),
        "n_stores": n,
        "tier_window": "90d",
        "clusters": clusters,
        "by_store": by_store,
    }
@app.get("/api/admin/users")
def admin_users_list():
    rows = _users_exec(
        "SELECT user_id, email, name, role, status, auth_method, "
        "created_at, approved_at, approved_by, last_login_at, "
        "(status='active') AS active "
        "FROM app_users ORDER BY created_at DESC", fetch=True) or []
    for r in rows:
        for k in ("created_at", "approved_at", "last_login_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return rows
@app.get("/api/admin/replenishment-config")
def admin_replenishment_config():
    return {"owners": _replen_owners()}
@app.get("/api/admin/snapshot-freshness")
def admin_snapshot_freshness():
    # "Upstream" here is the Postgres data source the API reads from directly.
    # Health is derived from how recently a DB query last succeeded.
    age = None if _last_db_success_ts is None else round(time.time() - _last_db_success_ts)
    if age is None:
        status = "unknown"
    elif age < 120:
        status = "green"
    elif age < 600:
        status = "amber"
    else:
        status = "red"
    return {
        "upstream": {
            "status": status,
            "last_success_age_sec": age,
            "open_breakers": [],
        }
    }
@app.get("/api/allocations/runs")
def allocations_runs(status: str = Query(default=None)):
    return _alloc_runs(status)
@app.get("/api/allocations/sizes")
def allocations_sizes():
    rows = run_query("""
        SELECT size, COUNT(*) AS n
        FROM all_products_clean
        WHERE size IS NOT NULL AND size <> '' AND size NOT LIKE '%/%'
        GROUP BY size ORDER BY n DESC LIMIT 8
    """)
    if not rows:
        return {"pack_table": {"S": 2, "M": 3, "L": 3, "1X": 2}}
    mn = min(float(r["n"]) for r in rows) or 1
    pack = {}
    for r in rows:
        pack[r["size"]] = max(1, min(4, int(round(float(r["n"]) / mn))))
    return {"pack_table": pack}
@app.get("/api/allocations/stores")
def allocations_stores():
    rows = run_query("""
        SELECT DISTINCT s.pos_location_name AS store
        FROM all_sales s
        WHERE """ + BASE_FILTERS + """
          AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
          AND s.pos_location_name NOT ILIKE '%online%'
        ORDER BY 1
    """)
    return {"stores": [r["store"] for r in rows if r.get("store")]}
@app.get("/api/allocations/styles")
def allocations_styles(subcategory: str = Query(default=None)):
    extra = ""
    if subcategory:
        extra = " AND p.product_type = '" + subcategory.replace("'", "''") + "'"
    rows = run_query("""
        SELECT DISTINCT p.style_name AS style
        FROM all_products_clean p
        WHERE p.style_name IS NOT NULL AND p.style_name <> ''""" + extra + """
        ORDER BY 1
    """)
    return {"styles": [r["style"] for r in rows if r.get("style")]}
@app.get("/api/analytics/allocations")
def stub_analytics_allocations(): return []
@app.get("/api/analytics/annual-targets")
def analytics_annual_targets(year: int = Query(default=None)):
    # Targets are derived as prior-year actuals + a 15% stretch (no separate
    # targets table exists in the warehouse).
    yr = int(year) if year else date.today().year
    growth = 1.15

    def actuals(y):
        return run_query("""
            SELECT
                CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' THEN 'Online'
                     ELSE COALESCE(NULLIF(s.country, ''), 'Other') END AS bucket,
                EXTRACT(QUARTER FROM s.sale_date::date)::int AS q,
                ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + str(y) + """-01-01' AND '""" + str(y) + """-12-31'
              AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
            GROUP BY 1, 2
        """)

    def to_map(rows):
        m = {}
        for r in rows:
            q = int(r["q"]) if r["q"] else 0
            m.setdefault(r["bucket"], {1: 0, 2: 0, 3: 0, 4: 0})
            if q in (1, 2, 3, 4):
                m[r["bucket"]][q] += float(r["net"] or 0)
        return m

    cur_m, prev_m = to_map(actuals(yr)), to_map(actuals(yr - 1))
    names = sorted(set(list(cur_m.keys()) + list(prev_m.keys())))
    start, end = date(yr, 1, 1), date(yr, 12, 31)
    days_total = (end - start).days + 1
    today = date.today()
    days_elapsed = 0 if today < start else days_total if today > end else (today - start).days + 1
    frac = days_elapsed / days_total if days_total else 1

    def make_bucket(name):
        pq = prev_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        cq = cur_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        target_annual = round(sum(pq.values()) * growth)
        actual_ytd = round(sum(cq.values()))
        projected_year = round(actual_ytd / frac) if frac else actual_ytd
        return {
            "bucket": name, "target_annual": target_annual, "actual_ytd": actual_ytd,
            "pct_of_target_ytd": round(100.0 * actual_ytd / target_annual, 1) if target_annual else 0.0,
            "projected_year": projected_year,
            "pct_of_target_projected": round(100.0 * projected_year / target_annual, 1) if target_annual else 0.0,
            "variance_projected": projected_year - target_annual,
            "quarters": {("Q%d" % q): round(pq[q] * growth) for q in (1, 2, 3, 4)},
            "actual_quarters": {("Q%d" % q): round(cq[q]) for q in (1, 2, 3, 4)},
        }

    buckets = [make_bucket(n) for n in names]
    tt_target = sum(b["target_annual"] for b in buckets)
    tt_actual = sum(b["actual_ytd"] for b in buckets)
    tt_proj = round(tt_actual / frac) if frac else tt_actual
    total = {
        "target_annual": tt_target, "actual_ytd": tt_actual,
        "pct_of_target_ytd": round(100.0 * tt_actual / tt_target, 1) if tt_target else 0.0,
        "projected_year": tt_proj,
        "pct_of_target_projected": round(100.0 * tt_proj / tt_target, 1) if tt_target else 0.0,
        "variance_projected": tt_proj - tt_target,
    }
    return {
        "total": total, "buckets": buckets,
        "completion_pct": round(100.0 * days_elapsed / days_total, 1),
        "days_elapsed": days_elapsed, "days_total": days_total, "as_of": today.isoformat(),
    }
@app.get("/api/analytics/monthly-targets")
def analytics_monthly_targets(month: str = Query(default=None)):
    # Per-market daily target tracker. Target = prior-year same-month
    # actual + 15% stretch, spread evenly across the days of the month.
    mstart = (date.fromisoformat(month[:10]).replace(day=1) if month
              else date.today().replace(day=1))
    nstart = (date(mstart.year + 1, 1, 1) if mstart.month == 12
              else date(mstart.year, mstart.month + 1, 1))
    mend = nstart - timedelta(days=1)
    days_in_month = mend.day
    today = date.today()
    growth = 1.15
    py_start = mstart.replace(year=mstart.year - 1)
    py_end = mend.replace(year=mend.year - 1)
    market = ("CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' "
              "THEN 'Online' ELSE COALESCE(NULLIF(s.country, ''), 'Other') END")
    py = run_query("""
        SELECT """ + market + """ AS channel,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(py_start) + """' AND '""" + str(py_end) + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1
    """)
    daily = run_query("""
        SELECT """ + market + """ AS channel, s.sale_date::date AS d,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units,
            COUNT(DISTINCT s.order_id) AS orders
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(mstart) + """' AND '""" + str(mend) + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1, 2
    """)
    py_map = {r["channel"]: float(r["net"] or 0) for r in py}
    dmap = {}
    for r in daily:
        dmap.setdefault(r["channel"], {})[str(r["d"])] = {
            "net": float(r["net"] or 0), "units": float(r["units"] or 0), "orders": float(r["orders"] or 0)}
    channels = sorted(set(list(py_map.keys()) + list(dmap.keys())))
    if mstart.year == today.year and mstart.month == today.month:
        days_complete = today.day
    elif today < mstart:
        days_complete = 0
    else:
        days_complete = days_in_month
    days_remaining = days_in_month - days_complete
    stores = []
    for ch in channels:
        sales_target = round(py_map.get(ch, 0) * growth)
        daily_target = sales_target / days_in_month if days_in_month else 0
        ch_daily = dmap.get(ch, {})
        days, mtd_actual, mtd_units, mtd_orders, cum_var = [], 0.0, 0.0, 0.0, 0.0
        for dd in range(1, days_in_month + 1):
            day = date(mstart.year, mstart.month, dd)
            a = ch_daily.get(str(day))
            actual = a["net"] if a else 0.0
            is_future = day > today
            if not is_future:
                mtd_actual += actual
                if a:
                    mtd_units += a["units"]
                    mtd_orders += a["orders"]
            dt = round(daily_target)
            ksh_var = round(actual - dt)
            cum_var += ksh_var
            days.append({
                "date": str(day), "day_of_week": day.strftime("%a"),
                "ratio": round(100.0 / days_in_month, 1),
                "daily_target": dt, "suggested_daily_target": dt,
                "actual": round(actual),
                "variance_pct": round(100.0 * (actual - dt) / dt, 1) if dt else 0.0,
                "ksh_variance": ksh_var, "ksh_variance_cumulative": round(cum_var),
                "is_future": is_future, "is_today": day == today,
            })
        mtd_target = round(daily_target * days_complete)
        projected = round(mtd_actual / days_complete * days_in_month) if days_complete else 0
        gap = sales_target - round(mtd_actual)
        stores.append({
            "channel": ch, "sales_target": sales_target, "mtd_actual": round(mtd_actual),
            "mtd_target": mtd_target, "projected_landing": projected,
            "pct_of_target_projected": round(100.0 * projected / sales_target, 1) if sales_target else 0.0,
            "ksh_variance_total": round(mtd_actual) - mtd_target,
            "days_complete": days_complete, "days_in_month": days_in_month,
            "days_remaining": days_remaining,
            "avg_suggested_remaining": round(gap / days_remaining) if days_remaining > 0 else 0,
            "gap_to_target": gap,
            "asp": round(mtd_actual / mtd_units) if mtd_units else 0,
            "basket_kes": round(mtd_actual / mtd_orders) if mtd_orders else 0,
            "daily": days,
        })
    stores.sort(key=lambda x: x["sales_target"], reverse=True)
    return {"month": str(mstart), "stores": stores}

# ── Executive Summary ─────────────────────────────────────────────────────────
# One heavy composite endpoint that powers ExecutiveSummary.jsx. It assembles
# YTD + MTD scorecards (each metric current vs same-period-last-year), a
# per-country breakdown, store performance, category/subcategory deltas,
# yearly-target pacing, and a stock-mix table — all internally consistent because
# every block is aggregated off the same BASE_FILTERS sales base via the existing
# helper functions (get_kpis / get_customers / _country_summary_q /
# get_sales_summary / get_subcategory_sales). Targets reuse the prior-year-actual
# + 15% stretch convention from /analytics/{annual,monthly}-targets.

_ES_KPI_KEYS = ["revenue", "avg_sales_per_day", "units", "footfall",
                "avg_basket", "asp", "total_customers", "new_customers",
                "returning_customers"]

def _es_pct(cur, ly):
    # Percent delta cur-vs-ly. None when ly is missing/zero so the frontend
    # DeltaPill renders an em-dash instead of a misleading 0 / infinity.
    if cur is None or ly is None:
        return None
    cur = float(cur); ly = float(ly)
    if ly == 0:
        return None
    return (cur - ly) / ly * 100.0

def _es_cmp(cur, ly):
    return {"cur": float(cur or 0), "ly": float(ly or 0), "delta_pct": _es_pct(cur, ly)}

def _es_shift_year(d, years):
    # d with year reduced by `years`, guarding the Feb-29 -> Feb-28 edge.
    try:
        return d.replace(year=d.year - years)
    except ValueError:
        return d.replace(year=d.year - years, day=28)

def _es_footfall_by_country(date_from, date_to):
    # {country: total_footfall_in} over [from,to]. footfall has no country
    # column, so map pos_location_name -> pos_locations.country.
    rows = run_query("""
        SELECT COALESCE(pl.country, 'Other') AS country,
            SUM(f.a01_footfall_in) AS footfall
        FROM footfall f
        LEFT JOIN pos_locations pl ON f.pos_location_name = pl.location_name
        WHERE f.time BETWEEN '""" + date_from + """' AND '""" + date_to + """'
        GROUP BY COALESCE(pl.country, 'Other')
    """, date_to=date_to)
    return {r["country"]: float(r["footfall"] or 0) for r in rows}

def _es_footfall_total(ff_map, country):
    if country:
        wanted = {c.strip().lower() for c in country.split(",")}
        return sum(v for kc, v in ff_map.items() if kc.lower() in wanted)
    return sum(ff_map.values())

def _es_customer_windows(span_from, span_to, windows, country):
    # total / new / returning customer counts for several windows in ONE pass.
    # Mirrors get_customers exactly (validated): first_ever_purchase is GLOBAL
    # (no base/country filter), period membership applies BASE_FILTERS + country.
    # new = single-order-in-window customer whose first ever purchase is in the
    # window; returning = single-order customer whose first purchase predates it.
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    pc_cols, sel = [], []
    for k, (a, b) in windows.items():
        pc_cols.append("COUNT(DISTINCT s.order_id) FILTER (WHERE s.sale_date BETWEEN '"
                       + a + "' AND '" + b + "') AS oc_" + k)
        sel.append("COUNT(*) FILTER (WHERE oc_" + k + " > 0) AS total_" + k)
        sel.append("COUNT(*) FILTER (WHERE oc_" + k + " = 1 AND a.first_ever BETWEEN '"
                   + a + "' AND '" + b + "') AS new_" + k)
        sel.append("COUNT(*) FILTER (WHERE oc_" + k + " = 1 AND a.first_ever < '"
                   + a + "') AS ret_" + k)
    rows = run_query("""
        WITH at AS (
            SELECT customer_id, MIN(sale_date) AS first_ever
            FROM all_sales
            WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        pc AS (
            SELECT s.customer_id, """ + ",\n".join(pc_cols) + """
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL
              AND s.customer_id NOT IN ('None','null','')
              AND s.sale_date BETWEEN '""" + span_from + """' AND '""" + span_to + """'
              AND """ + BASE_FILTERS + " " + country_filter + """
            GROUP BY s.customer_id
        )
        SELECT """ + ",\n".join(sel) + """
        FROM pc JOIN at a ON pc.customer_id = a.customer_id
    """, date_to=span_to)
    r = rows[0] if rows else {}
    return {k: {"total": float(r.get("total_" + k) or 0),
                "new": float(r.get("new_" + k) or 0),
                "returning": float(r.get("ret_" + k) or 0)} for k in windows}

def _es_kpi_block(frm, to, country, days, footfall, cust):
    # Raw headline scalars for one window. revenue/units/basket/ASP come from
    # get_kpis; footfall + customer counts are precomputed and passed in.
    k = get_kpis(frm, to, country, None) or {}
    revenue = float(k.get("total_sales") or 0)
    return {
        "revenue": revenue,
        "avg_sales_per_day": revenue / days if days else 0.0,
        "units": float(k.get("total_units") or 0),
        "footfall": footfall,
        "avg_basket": float(k.get("avg_basket_size") or 0),
        "asp": float(k.get("avg_selling_price") or 0),
        "total_customers": cust.get("total", 0.0),
        "new_customers": cust.get("new", 0.0),
        "returning_customers": cust.get("returning", 0.0),
    }

def _es_kpis(cur_blk, ly_blk):
    return {key: _es_cmp(cur_blk[key], ly_blk[key]) for key in _ES_KPI_KEYS}

def _es_countries(cur_from, cur_to, ly_from, ly_to, country, days_cur, days_ly, ff_cur, ff_ly):
    cur = {r["country"]: r for r in _country_summary_q(cur_from, cur_to, country)}
    ly = {r["country"]: r for r in _country_summary_q(ly_from, ly_to, country)}
    names = [c for c in ["Kenya", "Uganda", "Rwanda", "Online"] if c in cur or c in ly]
    for c in list(cur.keys()) + list(ly.keys()):
        if c and c not in names:
            names.append(c)
    out = []
    for c in names:
        rc = cur.get(c, {}); rl = ly.get(c, {})
        rev_c = float(rc.get("total_sales") or 0); rev_l = float(rl.get("total_sales") or 0)
        u_c = float(rc.get("units_sold") or 0); u_l = float(rl.get("units_sold") or 0)
        o_c = float(rc.get("orders") or 0); o_l = float(rl.get("orders") or 0)
        ff_c = float(ff_cur.get(c, 0)); ff_l = float(ff_ly.get(c, 0))
        apd = _es_cmp(rev_c / days_cur if days_cur else 0, rev_l / days_ly if days_ly else 0)
        apd["days"] = days_cur
        out.append({
            "country": c,
            "revenue": _es_cmp(rev_c, rev_l),
            "avg_sales_per_day": apd,
            "units": _es_cmp(u_c, u_l),
            "orders": _es_cmp(o_c, o_l),
            "footfall": _es_cmp(ff_c, ff_l),
            "avg_basket": _es_cmp(rev_c / o_c if o_c else 0, rev_l / o_l if o_l else 0),
            "asp": _es_cmp(rev_c / u_c if u_c else 0, rev_l / u_l if u_l else 0),
        })
    return out

def _es_store_targets(ytd_ly_from, ytd_ly_to, year_ly):
    # Per-channel targets via the prior-year-actual + 15% stretch convention:
    # target_ytd = prior-year same YTD period; target_annual = prior full year.
    growth = 1.15
    ytd_rows = run_query("""
        SELECT s.pos_location_name AS channel,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + ytd_ly_from + """' AND '""" + ytd_ly_to + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY s.pos_location_name
    """, date_to=ytd_ly_to)
    ann_rows = run_query("""
        SELECT s.pos_location_name AS channel,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(year_ly) + """-01-01' AND '""" + str(year_ly) + """-12-31'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY s.pos_location_name
    """)
    out = {}
    for r in ytd_rows:
        out.setdefault(r["channel"], {})["ytd"] = round(float(r["net"] or 0) * growth)
    for r in ann_rows:
        out.setdefault(r["channel"], {})["annual"] = round(float(r["net"] or 0) * growth)
    return out

def _es_stores(cur_from, cur_to, ly_from, ly_to, country, store_targets):
    # Physical stores only — drop Online / Staff channels (the StorePerformance
    # table is store-level). cur/ly are window revenue; targets are fixed YTD.
    cur = get_sales_summary(cur_from, cur_to, country, None)
    ly = {r["channel"]: r for r in get_sales_summary(ly_from, ly_to, country, None)}
    out = []
    for r in cur:
        ch = r.get("channel") or ""
        co = r.get("country") or ""
        low = ch.lower()
        if "online" in low or "staff" in low or co == "Online":
            continue
        l = ly.get(ch, {})
        cur_v = float(r.get("total_sales") or 0)
        ly_v = float(l.get("total_sales") or 0)
        tgt = store_targets.get(ch, {})
        out.append({
            "channel": ch, "country": co,
            "cur": cur_v, "ly": ly_v, "delta_pct": _es_pct(cur_v, ly_v),
            "target_annual": tgt.get("annual", 0), "target_ytd": tgt.get("ytd", 0),
        })
    out.sort(key=lambda x: x["cur"], reverse=True)
    return out

def _es_categories(cur_from, cur_to, ly_from, ly_to, country):
    # Per-subcategory revenue + units, current vs LY. The frontend rolls these
    # up to high-level categories via productCategory.js.
    cur = {r["subcategory"]: r for r in get_subcategory_sales(cur_from, cur_to, country, None)}
    ly = {r["subcategory"]: r for r in get_subcategory_sales(ly_from, ly_to, country, None)}
    subs = []
    for sc in set(list(cur.keys()) + list(ly.keys())):
        if not sc:
            continue
        rc = cur.get(sc, {}); rl = ly.get(sc, {})
        rev_c = float(rc.get("total_sales") or 0); rev_l = float(rl.get("total_sales") or 0)
        subs.append({
            "subcategory": sc,
            "cur": rev_c, "ly": rev_l,
            "cur_units": float(rc.get("units_sold") or 0),
            "ly_units": float(rl.get("units_sold") or 0),
            "delta_pct": _es_pct(rev_c, rev_l),
        })
    subs.sort(key=lambda x: x["cur"], reverse=True)
    return {"subcategories": subs}

def _es_targets(as_of, country):
    # Yearly-target pacing per market. annual = prior full-year net * 1.15;
    # ytd = full elapsed months * 1.15 + current month * 1.15 * day-fraction.
    growth = 1.15
    year_ly = as_of.year - 1
    market = ("CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' "
              "THEN 'Online' ELSE COALESCE(NULLIF(s.country, ''), 'Other') END")
    rows = run_query("""
        SELECT """ + market + """ AS bucket,
            EXTRACT(MONTH FROM s.sale_date::date)::int AS m,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END)) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(year_ly) + """-01-01' AND '""" + str(year_ly) + """-12-31'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1, 2
    """)
    by_bucket = {}
    for r in rows:
        b = r["bucket"]; m = int(r["m"]) if r["m"] else 0
        by_bucket.setdefault(b, {})[m] = float(r["net"] or 0)
    dim = calendar.monthrange(as_of.year, as_of.month)[1]
    month_frac = as_of.day / dim if dim else 1.0
    cur_month = as_of.month

    def country_target(b):
        months = by_bucket.get(b, {})
        annual = round(sum(months.values()) * growth)
        ytd = 0.0
        for m in range(1, cur_month):
            ytd += months.get(m, 0) * growth
        ytd += months.get(cur_month, 0) * growth * month_frac
        return {"country": b, "ytd": round(ytd), "annual": annual}

    names = [b for b in ["Kenya", "Uganda", "Rwanda", "Online"] if b in by_bucket]
    for b in by_bucket:
        if b not in names:
            names.append(b)
    if country:
        cset = {c.strip() for c in country.split(",")}
        names = [b for b in names if b in cset]
    countries = [country_target(b) for b in names]
    return {
        "countries": countries,
        "total": {"ytd": sum(c["ytd"] for c in countries),
                  "annual": sum(c["annual"] for c in countries)},
    }

def _es_stock_mix(sold_from, sold_to, window_days, country):
    # Stock-vs-sales mix: on-hand units (warehouse vs stores) against units sold
    # over the window, rolled up to categories with weeks-of-cover and gap.
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    inv_country = ("AND LOWER(i.country) IN (" + csv_to_sql(country.lower()) + ")") if country else ""
    sales_country = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    inv = run_query("""
        SELECT p.product_type AS subcategory,
            SUM(CASE WHEN i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """) THEN i.available ELSE 0 END) AS wh_units,
            SUM(CASE WHEN i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """) THEN i.available ELSE 0 END) AS st_units
        FROM all_inventory i
        JOIN all_products_clean p ON i.sku = p.sku
        WHERE i.available > 0 AND p.product_type IN (""" + subcat_list + """) """ + inv_country + """
        GROUP BY p.product_type
    """)
    sales = run_query("""
        SELECT p.product_type AS subcategory,
            SUM(s.ordered_item_quantity) AS sold_units,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS sold_rev
        FROM all_sales s
        LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE s.sale_date BETWEEN '""" + sold_from + """' AND '""" + sold_to + """'
          AND s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0
          AND """ + BASE_FILTERS + " " + sales_country + """
          AND p.product_type IN (""" + subcat_list + """)
        GROUP BY p.product_type
    """, date_to=sold_to)
    inv_map = {r["subcategory"]: r for r in inv}
    sales_map = {r["subcategory"]: r for r in sales}
    weeks = (window_days / 7.0) if window_days else 1.0

    raw = []
    for sc in set(list(inv_map.keys()) + list(sales_map.keys())):
        if not sc:
            continue
        iv = inv_map.get(sc, {}); sv = sales_map.get(sc, {})
        wh = float(iv.get("wh_units") or 0); st = float(iv.get("st_units") or 0)
        raw.append({
            "subcategory": sc, "category": SUBCATEGORY_TO_CATEGORY.get(sc, "Other"),
            "wh": wh, "st": st, "stock": wh + st,
            "sold": float(sv.get("sold_units") or 0), "rev": float(sv.get("sold_rev") or 0),
        })
    tot_stock = sum(r["stock"] for r in raw)
    tot_wh = sum(r["wh"] for r in raw)
    tot_st = sum(r["st"] for r in raw)
    tot_sold = sum(r["sold"] for r in raw)

    def cover(stock, sold):
        if sold <= 0:
            return None
        weekly = sold / weeks if weeks else 0
        return round(stock / weekly, 2) if weekly else None

    def asp(rev, sold):
        return round(rev / sold) if sold else None

    def make_row(d):
        stock = d["stock"]; sold = d["sold"]; rev = d["rev"]
        stock_pct = stock / tot_stock * 100 if tot_stock else 0
        sold_pct = sold / tot_sold * 100 if tot_sold else 0
        a = asp(rev, sold)
        return {
            "stock_units": stock, "stock_pct": round(stock_pct, 2),
            "stock_units_warehouse": d["wh"],
            "stock_pct_warehouse": round(d["wh"] / tot_wh * 100, 2) if tot_wh else 0,
            "stock_units_stores": d["st"],
            "stock_pct_stores": round(d["st"] / tot_st * 100, 2) if tot_st else 0,
            "sold_units": sold, "sold_pct": round(sold_pct, 2),
            "gap_pct": round(stock_pct - sold_pct, 2),
            "weeks_of_cover": cover(stock, sold),
            "asp_mtd": a, "tied_up_kes": round(stock * a) if a else 0,
        }

    cats = {}
    for d in raw:
        c = cats.setdefault(d["category"], {"category": d["category"], "wh": 0.0,
                                            "st": 0.0, "stock": 0.0, "sold": 0.0,
                                            "rev": 0.0, "subs": []})
        c["wh"] += d["wh"]; c["st"] += d["st"]; c["stock"] += d["stock"]
        c["sold"] += d["sold"]; c["rev"] += d["rev"]; c["subs"].append(d)
    categories = []
    for c in cats.values():
        row = make_row(c)
        row["category"] = c["category"]
        row["subcategories"] = sorted(
            [dict(make_row(s), subcategory=s["subcategory"]) for s in c["subs"]],
            key=lambda x: x["stock_units"], reverse=True)
        categories.append(row)
    categories.sort(key=lambda x: x["stock_units"], reverse=True)

    return {
        "window_days": window_days, "weeks_in_window": round(weeks, 2),
        "sold_window": {"from": sold_from, "to": sold_to},
        "total_stock_units": tot_stock,
        "total_stock_units_warehouse": tot_wh,
        "total_stock_units_stores": tot_st,
        "total_stock_pct_warehouse": round(tot_wh / tot_stock * 100, 2) if tot_stock else 0,
        "total_stock_pct_stores": round(tot_st / tot_stock * 100, 2) if tot_stock else 0,
        "total_sold_units_mtd": tot_sold,
        "total_weeks_of_cover": cover(tot_stock, tot_sold),
        "categories": categories,
    }

@app.get("/api/exec-summary")
def exec_summary(
    country:     str = Query(default=None),
    window_days: int = Query(default=30),
    date_from:   str = Query(default=None),
    date_to:     str = Query(default=None),
    style_status: str = Query(default="all"),
):
    # Anchor "as of" to yesterday, but never past the latest sale in the data.
    mx = run_query("SELECT MAX(s.sale_date) AS mx FROM all_sales s WHERE s.sale_kind IN ('sale','order')")
    max_date = None
    if mx and mx[0].get("mx"):
        try:
            max_date = date.fromisoformat(str(mx[0]["mx"])[:10])
        except ValueError:
            max_date = None
    as_of = date.today() - timedelta(days=1)
    if max_date and max_date < as_of:
        as_of = max_date

    ytd_cur = (date(as_of.year, 1, 1), as_of)
    ytd_ly = (date(as_of.year - 1, 1, 1), _es_shift_year(as_of, 1))
    mtd_cur = (as_of.replace(day=1), as_of)
    mtd_ly = (_es_shift_year(as_of.replace(day=1), 1), _es_shift_year(as_of, 1))

    def ds(t):
        return (t[0].isoformat(), t[1].isoformat())
    ytd_cur_s, ytd_ly_s = ds(ytd_cur), ds(ytd_ly)
    mtd_cur_s, mtd_ly_s = ds(mtd_cur), ds(mtd_ly)

    days_ytd = (ytd_cur[1] - ytd_cur[0]).days + 1
    days_ytd_ly = (ytd_ly[1] - ytd_ly[0]).days + 1
    days_mtd = (mtd_cur[1] - mtd_cur[0]).days + 1
    days_mtd_ly = (mtd_ly[1] - mtd_ly[0]).days + 1

    # Footfall-by-country for each window: computed once and reused by both the
    # KPI blocks (totals) and the country breakdowns below.
    ff = {
        "yc": _es_footfall_by_country(ytd_cur_s[0], ytd_cur_s[1]),
        "yl": _es_footfall_by_country(ytd_ly_s[0], ytd_ly_s[1]),
        "mc": _es_footfall_by_country(mtd_cur_s[0], mtd_cur_s[1]),
        "ml": _es_footfall_by_country(mtd_ly_s[0], mtd_ly_s[1]),
    }
    ff_total = {k: _es_footfall_total(v, country) for k, v in ff.items()}

    # total/new/returning customers for all four windows in a single query span.
    cust = _es_customer_windows(ytd_ly_s[0], ytd_cur_s[1], {
        "yc": ytd_cur_s, "yl": ytd_ly_s, "mc": mtd_cur_s, "ml": mtd_ly_s,
    }, country)

    ytd_kpis = _es_kpis(
        _es_kpi_block(ytd_cur_s[0], ytd_cur_s[1], country, days_ytd, ff_total["yc"], cust["yc"]),
        _es_kpi_block(ytd_ly_s[0], ytd_ly_s[1], country, days_ytd_ly, ff_total["yl"], cust["yl"]))
    mtd_kpis = _es_kpis(
        _es_kpi_block(mtd_cur_s[0], mtd_cur_s[1], country, days_mtd, ff_total["mc"], cust["mc"]),
        _es_kpi_block(mtd_ly_s[0], mtd_ly_s[1], country, days_mtd_ly, ff_total["ml"], cust["ml"]))

    store_targets = _es_store_targets(ytd_ly_s[0], ytd_ly_s[1], as_of.year - 1)

    if date_from and date_to:
        sold_from, sold_to = date_from, date_to
        wd = (date.fromisoformat(date_to[:10]) - date.fromisoformat(date_from[:10])).days + 1
    else:
        wd = window_days or 30
        sold_from = (as_of - timedelta(days=wd - 1)).isoformat()
        sold_to = as_of.isoformat()

    return {
        "as_of": as_of.isoformat(),
        "windows": {
            "ytd": {"current": list(ytd_cur_s), "ly": list(ytd_ly_s)},
            "mtd": {"current": list(mtd_cur_s), "ly": list(mtd_ly_s)},
        },
        "ytd": {
            "kpis": ytd_kpis,
            "countries": _es_countries(ytd_cur_s[0], ytd_cur_s[1], ytd_ly_s[0], ytd_ly_s[1], country, days_ytd, days_ytd_ly, ff["yc"], ff["yl"]),
            "stores": _es_stores(ytd_cur_s[0], ytd_cur_s[1], ytd_ly_s[0], ytd_ly_s[1], country, store_targets),
            "categories": _es_categories(ytd_cur_s[0], ytd_cur_s[1], ytd_ly_s[0], ytd_ly_s[1], country),
        },
        "mtd": {
            "kpis": mtd_kpis,
            "countries": _es_countries(mtd_cur_s[0], mtd_cur_s[1], mtd_ly_s[0], mtd_ly_s[1], country, days_mtd, days_mtd_ly, ff["mc"], ff["ml"]),
            "stores": _es_stores(mtd_cur_s[0], mtd_cur_s[1], mtd_ly_s[0], mtd_ly_s[1], country, store_targets),
            "categories": _es_categories(mtd_cur_s[0], mtd_cur_s[1], mtd_ly_s[0], mtd_ly_s[1], country),
        },
        "targets": _es_targets(as_of, country),
        "stock_mix": _es_stock_mix(sold_from, sold_to, wd, country),
        "kpis": {"units": ytd_kpis["units"]},
    }
# IBT (Inter-Branch Transfer) endpoints — see PART A region below for the
# real implementations (ibt_suggestions / ibt_sku_breakdown /
# ibt_warehouse_to_store). Kept out of the stub block intentionally.
@app.get("/api/analytics/insights")
def stub_analytics_insights(): return []
@app.get("/api/analytics/re-order-list")
def stub_analytics_re_order_list(): return []
@app.get("/api/analytics/recently-unchurned")
def analytics_recently_unchurned(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    min_gap_days: int = Query(default=90),
    limit: int = Query(default=100),
):
    # Win-back signal: customers whose latest purchase follows a long dormant
    # gap (>= min_gap_days) and landed in the last 60 days.
    return run_query("""
        WITH purch AS (
            SELECT s.customer_id, s.sale_date::date AS d
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.customer_id IS NOT NULL AND s.customer_id <> ''
              AND s.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        ),
        gaps AS (
            SELECT customer_id, d,
                LAG(d) OVER (PARTITION BY customer_id ORDER BY d) AS prev_d
            FROM purch
        ),
        winback AS (
            SELECT customer_id, d AS return_date, (d - prev_d) AS gap_days
            FROM gaps
            WHERE prev_d IS NOT NULL
              AND (d - prev_d) >= """ + str(int(min_gap_days)) + """
              AND d >= CURRENT_DATE - INTERVAL '60 days'
        )
        SELECT w.customer_id,
            NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
            c.phone, c.email,
            MAX(w.return_date) AS last_order_date,
            MAX(w.gap_days) AS gap_days,
            COALESCE(MAX(c.total_orders), 0) AS total_orders,
            COALESCE(ROUND(MAX(c.total_spend_kes)), 0) AS total_spend,
            (CURRENT_DATE - MAX(w.return_date)) AS days_since_last
        FROM winback w
        LEFT JOIN all_customers c ON c.customer_id = w.customer_id
        GROUP BY w.customer_id, c.first_name, c.last_name, c.phone, c.email
        ORDER BY last_order_date DESC, gap_days DESC
        LIMIT """ + str(int(limit)))
@app.get("/api/analytics/replenish-by-color")
def analytics_replenish_by_color(
    country: str = Query(default=None),
    channel: str = Query(default=None),
    max_weeks_of_cover: float = Query(default=6.0),
    min_sor_percent: float = Query(default=40.0),
):
    sales_extra = ""
    if country:
        sales_extra += " AND s.country = '" + country.replace("'", "''") + "'"
    if channel:
        sales_extra += " AND s.channel IN (" + csv_to_sql(channel) + ")"
    inv_country = ""
    if country:
        inv_country = " AND i.country = '" + country.replace("'", "''") + "'"
    rows = run_query("""
        WITH sales30 AS (
            SELECT p.style_name, MAX(p.brand) AS brand, MAX(p.product_type) AS subcategory,
                COALESCE(NULLIF(TRIM(p.color_print), ''), 'Unspecified') AS color,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS units_28,
                SUM(s.net_quantity) AS units_56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND """ + BASE_FILTERS + sales_extra + """
              AND p.style_name IS NOT NULL
            GROUP BY p.style_name, color
        ),
        soh AS (
            SELECT p.style_name,
                COALESCE(NULLIF(TRIM(i.color_print), ''), 'Unspecified') AS color,
                SUM(i.available) AS soh_total
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND p.style_name IS NOT NULL""" + inv_country + """
            GROUP BY p.style_name, color
        )
        SELECT COALESCE(s.style_name, h.style_name) AS style_name,
            COALESCE(s.color, h.color) AS color,
            MAX(s.brand) AS brand, MAX(s.subcategory) AS subcategory,
            COALESCE(SUM(s.units_28), 0) AS units_28,
            COALESCE(SUM(s.units_56), 0) AS units_56,
            COALESCE(SUM(h.soh_total), 0) AS soh_total
        FROM sales30 s
        FULL OUTER JOIN soh h ON h.style_name = s.style_name AND h.color = s.color
        GROUP BY COALESCE(s.style_name, h.style_name), COALESCE(s.color, h.color)
    """)
    styles = {}
    for r in rows:
        sn = r.get("style_name")
        if not sn:
            continue
        st = styles.setdefault(sn, {"brand": None, "subcategory": None, "colors": []})
        if r.get("brand"):
            st["brand"] = r["brand"]
        if r.get("subcategory"):
            st["subcategory"] = r["subcategory"]
        st["colors"].append({
            "color": r["color"],
            "units_28": int(float(r["units_28"] or 0)),
            "units_56": int(float(r["units_56"] or 0)),
            "soh_total": int(float(r["soh_total"] or 0)),
        })
    out = []
    weeks_target = 4.0

    def _weekly(u28, u56):
        # Recency-weighted weekly velocity (Phase 1 audit A1): the last 28 days
        # are double-weighted over a 12-week-equivalent denominator. Identical to
        # /analytics/weeks-of-cover so cover figures agree across the app.
        return ((u28 * 2) + max(u56 - u28, 0)) / 12.0

    for sn, st in styles.items():
        total_u28 = sum(c["units_28"] for c in st["colors"])
        total_u56 = sum(c["units_56"] for c in st["colors"])
        total_soh = sum(c["soh_total"] for c in st["colors"])
        for c in st["colors"]:
            weekly = _weekly(c["units_28"], c["units_56"])
            target = int(round(weekly * weeks_target))
            c["units_30d"] = c["units_28"]
            c["weekly_units"] = round(weekly, 2)
            c["weeks_of_cover"] = round(c["soh_total"] / weekly, 1) if weekly else 999.0
            c["reorder_point"] = int(round(weekly * REORDER_COVER_WEEKS))
            c["at_risk"] = c["soh_total"] < c["reorder_point"]
            c["target_qty"] = target
            c["recommended_qty"] = max(0, target - c["soh_total"])
            c["pct_of_style_sales"] = round(100.0 * c["units_28"] / total_u28, 1) if total_u28 else 0.0
        style_weekly = _weekly(total_u28, total_u56)
        style_reorder = int(round(style_weekly * REORDER_COVER_WEEKS))
        woc = round(total_soh / style_weekly, 1) if style_weekly else 999.0
        sor = round(100.0 * total_u28 / (total_u28 + total_soh), 1) if (total_u28 + total_soh) else 0.0
        total_rec = sum(c["recommended_qty"] for c in st["colors"])
        if sor < min_sor_percent or woc > max_weeks_of_cover or total_rec <= 0:
            continue
        st["colors"].sort(key=lambda c: c["recommended_qty"], reverse=True)
        out.append({
            "style_name": sn, "brand": st["brand"], "subcategory": st["subcategory"],
            "sor_percent": sor, "weeks_of_cover": woc,
            "weekly_units": round(style_weekly, 2),
            "reorder_point": style_reorder, "at_risk": total_soh < style_reorder,
            "total_units_30d": total_u28, "total_soh": total_soh,
            "total_recommended_qty": total_rec, "colors": st["colors"],
        })
    out.sort(key=lambda x: x["total_recommended_qty"], reverse=True)
    return out
@app.get("/api/analytics/replenishment-completed")
def analytics_replenishment_completed(days: int = Query(default=30)):
    rows = _users_exec(
        "SELECT rec_key, actual_units, acted_by, acted_at "
        "FROM recommendation_actions "
        "WHERE rec_type='replenish' AND status='done' "
        "AND acted_at >= now() - (%s || ' days')::interval "
        "ORDER BY acted_at DESC LIMIT 2000",
        (str(int(days)),), fetch=True) or []
    out = []
    for r in rows:
        parts = (r["rec_key"] or "").split("|", 2)
        if len(parts) != 3:
            continue
        pos_location, kind, value = parts
        out.append({
            "pos_location": pos_location,
            "barcode": value if kind == "barcode" else None,
            "sku": value if kind == "sku" else None,
            "replenished": True,
            "actual_units_replenished": int(r["actual_units"] or 0),
            "completed_by": r["acted_by"],
            "completed_at": r["acted_at"].isoformat() if r.get("acted_at") else None,
        })
    return {"rows": out, "total": sum(x["actual_units_replenished"] for x in out)}
@app.get("/api/analytics/replenishment-report")
def analytics_replenishment_report(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    limit: int = Query(default=400),
):
    if not date_from or not date_to:
        date_to = str(date.today())
        date_from = str(date.today() - timedelta(days=30))
    rows = run_query("""
        WITH sold AS (
            SELECT s.pos_location_name, s.variant_sku,
                MAX(s.country) AS country,
                MAX(s.product_title) AS product_name,
                SUM(s.net_quantity) AS units_sold,
                MAX(s.sale_date) AS last_sale
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'
              AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
            GROUP BY s.pos_location_name, s.variant_sku
            HAVING SUM(s.net_quantity) > 0
        ),
        store_soh AS (
            SELECT i.pos_location_name, i.sku,
                SUM(i.available) AS soh_store,
                MAX(i.location_name) AS bin
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY i.pos_location_name, i.sku
        ),
        wh_soh AS (
            SELECT i.sku, SUM(i.available) AS soh_wh
            FROM all_inventory i
            WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY i.sku
        )
        SELECT sold.pos_location_name AS pos_location, sold.country,
            sold.product_name, sold.variant_sku AS sku, sold.units_sold, sold.last_sale,
            p.size AS size, p.barcode,
            COALESCE(ss.soh_store, 0) AS soh_store, COALESCE(ss.bin, '') AS bin,
            COALESCE(w.soh_wh, 0) AS soh_wh
        FROM sold
        LEFT JOIN store_soh ss ON ss.pos_location_name = sold.pos_location_name AND ss.sku = sold.variant_sku
        LEFT JOIN wh_soh w ON w.sku = sold.variant_sku
        LEFT JOIN all_products_clean p ON p.sku = sold.variant_sku
        WHERE COALESCE(ss.soh_store, 0) < sold.units_sold AND COALESCE(w.soh_wh, 0) > 0
        ORDER BY (sold.units_sold - COALESCE(ss.soh_store, 0)) DESC
        LIMIT """ + str(int(limit)))
    owners = _replen_owners()
    marks_all = _replen_marks()
    today = date.today()
    out_rows = []
    for idx, r in enumerate(rows):
        units_sold = int(r["units_sold"] or 0)
        soh_store = int(r["soh_store"] or 0)
        soh_wh = int(r["soh_wh"] or 0)
        replenish = max(0, min(units_sold - soh_store, soh_wh))
        days_lapsed = 0
        if r.get("last_sale"):
            try:
                days_lapsed = (today - date.fromisoformat(str(r["last_sale"])[:10])).days
            except ValueError:
                days_lapsed = 0
        mark = (marks_all.get((r.get("pos_location"), "sku", r.get("sku")))
                or marks_all.get((r.get("pos_location"), "barcode", r.get("barcode")))
                or {})
        out_rows.append({
            "owner": owners[idx % len(owners)], "country": r.get("country"),
            "pos_location": r.get("pos_location"), "product_name": r.get("product_name"),
            "size": r.get("size") or "", "barcode": r.get("barcode") or "",
            "sku": r.get("sku"), "bin": r.get("bin") or "",
            "units_sold": units_sold, "soh_store": soh_store, "soh_wh": soh_wh,
            "replenish": replenish, "replenished": bool(mark.get("replenished", False)),
            "actual_units_replenished": int(mark.get("actual_units_replenished", 0)),
            "days_lapsed": days_lapsed,
        })
    by_owner = {}
    for r in out_rows:
        o = by_owner.setdefault(r["owner"], {"owner": r["owner"], "lines": 0, "units": 0, "stores": set()})
        o["lines"] += 1
        o["units"] += r["replenish"]
        o["stores"].add(r["pos_location"])
    by_owner_list = sorted(
        [{"owner": o["owner"], "lines": o["lines"], "units": o["units"], "stores": len(o["stores"])} for o in by_owner.values()],
        key=lambda x: x["units"], reverse=True)
    return {
        "rows": out_rows,
        "summary": {
            "by_owner": by_owner_list,
            "total_units": sum(r["replenish"] for r in out_rows),
            "total_rows": len(out_rows),
            "completed": sum(1 for r in out_rows if r["replenished"]),
        },
    }
@app.get("/api/analytics/sales-projection")
def analytics_sales_projection(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                                    WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END)), 0) AS actual_sales,
            MAX(s.sale_date) AS last_day
        FROM all_sales s WHERE """ + where + """
    """)
    actual = float(rows[0]["actual_sales"]) if rows and rows[0]["actual_sales"] is not None else 0.0
    last_day = rows[0].get("last_day") if rows else None
    d0 = date.fromisoformat(date_from[:10])
    d1 = date.fromisoformat(date_to[:10])
    total_days = max(1, (d1 - d0).days + 1)
    eff = min(d1, date.today())
    if last_day:
        try:
            ld = date.fromisoformat(str(last_day)[:10])
            if ld < eff:
                eff = ld
        except ValueError:
            pass
    days_elapsed = min(max(1, (eff - d0).days + 1), total_days)
    daily_run_rate = actual / days_elapsed if days_elapsed else 0
    projected = daily_run_rate * total_days
    return {
        "total_days": total_days,
        "days_elapsed": days_elapsed,
        "completion_pct": round(100.0 * days_elapsed / total_days, 1),
        "actual_sales": round(actual),
        "daily_run_rate": round(daily_run_rate),
        "projected_sales": round(projected),
    }
def _style_filters(country=None, channel=None, alias="s"):
    cf = chf = ""
    if country:
        cs = [c.strip().lower() for c in country.split(",") if c.strip()]
        if cs:
            cf = " AND LOWER(" + alias + ".country) IN (" + ",".join(
                "'" + c.replace("'", "''") + "'" for c in cs) + ")"
    if channel:
        chs = [c.strip() for c in channel.split(",") if c.strip()]
        if chs:
            chf = " AND " + alias + ".pos_location_name IN (" + ",".join(
                "'" + c.replace("'", "''") + "'" for c in chs) + ")"
    return cf, chf


def _sku_breakdown(style_names, country=None, channel=None):
    names = [n for n in style_names if n]
    if not names:
        return {}
    names_sql = ",".join("'" + n.replace("'", "''") + "'" for n in names)
    cf, chf = _style_filters(country, channel, "s")
    inv_cf, _ = _style_filters(country, None, "i")
    six = str(date.today() - timedelta(days=182))
    three = str(date.today() - timedelta(days=21))
    sales = run_query("""
        SELECT p.style_name, p.sku, p.color_print AS color, p.size,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units_6m,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END) AS sales_6m,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') AND s.sale_date >= '""" + three + """' THEN s.net_quantity ELSE 0 END) AS units_3w
        FROM all_products_clean p
        LEFT JOIN all_sales s ON s.variant_sku = p.sku
            AND s.sale_date BETWEEN '""" + six + """' AND '""" + str(date.today()) + """'
            AND """ + BASE_FILTERS + cf + chf + """
        WHERE p.style_name IN (""" + names_sql + """)
        GROUP BY p.style_name, p.sku, p.color_print, p.size
    """)
    inv = run_query("""
        SELECT p.sku,
            SUM(i.available) AS soh_total,
            SUM(CASE WHEN i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """) THEN i.available ELSE 0 END) AS soh_wh
        FROM all_products_clean p
        LEFT JOIN all_inventory i ON i.sku = p.sku""" + inv_cf + """
        WHERE p.style_name IN (""" + names_sql + """)
        GROUP BY p.sku
    """)
    inv_map = {r["sku"]: r for r in inv}
    out = {}
    for r in sales:
        soh = inv_map.get(r["sku"], {})
        soh_total = float(soh.get("soh_total") or 0)
        soh_wh = float(soh.get("soh_wh") or 0)
        u6 = float(r["units_6m"] or 0)
        u3 = float(r["units_3w"] or 0)
        if u6 == 0 and u3 == 0 and soh_total == 0:
            continue
        out.setdefault(r["style_name"], []).append({
            "color": r["color"] or "—", "size": r["size"] or "—", "sku": r["sku"],
            "units_6m": int(u6), "units_3w": int(u3),
            "sales_6m": round(float(r["sales_6m"] or 0)),
            "soh_total": int(soh_total), "soh_wh": int(soh_wh),
            "pct_in_wh": round(100.0 * soh_wh / soh_total, 1) if soh_total else 0.0,
        })
    return out


@app.get("/api/analytics/style-sku-breakdown")
def analytics_style_sku_breakdown(style_name: str = Query(...),
                                  country: str = Query(default=None),
                                  channel: str = Query(default=None)):
    out = _sku_breakdown([style_name], country, channel)
    return {"skus": out.get(style_name, [])}


@app.get("/api/analytics/style-sku-breakdown-bulk")
def analytics_style_sku_breakdown_bulk(style_names: str = Query(...),
                                       country: str = Query(default=None),
                                       channel: str = Query(default=None)):
    names = [n.strip() for n in style_names.split(",") if n.strip()]
    return {"styles": _sku_breakdown(names, country, channel)}


@app.get("/api/analytics/style-location-breakdown")
def analytics_style_location_breakdown(style_name: str = Query(...),
                                       country: str = Query(default=None),
                                       channel: str = Query(default=None),
                                       color: str = Query(default=None),
                                       size: str = Query(default=None)):
    name_sql = "'" + style_name.replace("'", "''") + "'"
    extra = ""
    if color:
        extra += " AND p.color_print = '" + color.replace("'", "''") + "'"
    if size:
        extra += " AND p.size = '" + size.replace("'", "''") + "'"
    cf, chf = _style_filters(country, channel, "s")
    inv_cf, _ = _style_filters(country, None, "i")
    six = str(date.today() - timedelta(days=182))
    sales = run_query("""
        SELECT s.pos_location_name AS location,
            SUM(s.net_quantity) AS units_6m,
            SUM(s.net_sales_kes::numeric) AS sales_6m
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE p.style_name = """ + name_sql + extra + """
          AND s.sale_kind IN ('sale','order')
          AND s.sale_date BETWEEN '""" + six + """' AND '""" + str(date.today()) + """'
          AND """ + BASE_FILTERS + cf + chf + """
        GROUP BY s.pos_location_name
    """)
    inv = run_query("""
        SELECT i.pos_location_name AS location, SUM(i.available) AS soh_total
        FROM all_inventory i
        JOIN all_products_clean p ON p.sku = i.sku
        WHERE p.style_name = """ + name_sql + extra + inv_cf + """
        GROUP BY i.pos_location_name
    """)
    merged = {}
    for r in sales:
        merged[r["location"]] = {
            "location": r["location"], "units_6m": int(float(r["units_6m"] or 0)),
            "sales_6m": round(float(r["sales_6m"] or 0)), "soh_total": 0}
    for r in inv:
        loc = r["location"]
        m = merged.setdefault(loc, {"location": loc, "units_6m": 0, "sales_6m": 0, "soh_total": 0})
        m["soh_total"] = int(float(r["soh_total"] or 0))
    rows = []
    for m in merged.values():
        denom = m["units_6m"] + m["soh_total"]
        m["sor_6m"] = round(100.0 * m["units_6m"] / denom, 1) if denom else 0.0
        if m["units_6m"] or m["soh_total"]:
            rows.append(m)
    rows.sort(key=lambda x: x["units_6m"], reverse=True)
    return {"locations": rows}
@app.get("/api/analytics/ceo-report")
def stub_analytics_ceo_report(): return []
@app.get("/api/ibt/completed")
def ibt_completed():
    rows = _users_exec(
        "SELECT style_name, brand, subcategory, from_store, to_store, flow, "
        "units_to_move, actual_units_moved, sku, color, size, barcode, po_number, "
        "completed_by_name, suggested_at, transfer_date, completed_at, "
        "CASE WHEN suggested_at IS NOT NULL "
        "THEN (completed_at::date - suggested_at) END AS days_lapsed "
        "FROM ibt_completions ORDER BY completed_at DESC LIMIT 1000",
        fetch=True) or []
    for r in rows:
        for k in ("suggested_at", "transfer_date", "completed_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return rows
@app.get("/api/ibt/completed/keys")
def ibt_completed_keys():
    sku_rows = _users_exec(
        "SELECT DISTINCT style_name, to_store, sku FROM ibt_completions "
        "WHERE sku IS NOT NULL AND sku <> ''", fetch=True) or []
    all_rows = _users_exec(
        "SELECT DISTINCT style_name, to_store FROM ibt_completions "
        "WHERE sku IS NULL OR sku = ''", fetch=True) or []
    sku_keys = [f"{r['style_name']}||{r['to_store']}||{r['sku']}" for r in sku_rows]
    keys = [f"{r['style_name']}||{r['to_store']}||__all__" for r in all_rows]
    return {"keys": keys, "sku_keys": sku_keys}
@app.get("/api/leaderboard/streaks")
def stub_leaderboard_streaks(): return []
@app.get("/api/notifications")
def stub_notifications(): return []
@app.get("/api/recommendations")
def get_recommendations(item_type: str = Query(default=None)):
    if item_type:
        rows = _users_exec(
            "SELECT rec_type AS item_type, rec_key AS item_key, status, "
            "reason AS note, actual_units, acted_by, acted_at "
            "FROM recommendation_actions WHERE rec_type=%s "
            "ORDER BY acted_at DESC", (item_type,), fetch=True) or []
    else:
        rows = _users_exec(
            "SELECT rec_type AS item_type, rec_key AS item_key, status, "
            "reason AS note, actual_units, acted_by, acted_at "
            "FROM recommendation_actions ORDER BY acted_at DESC", fetch=True) or []
    for r in rows:
        if r.get("acted_at") is not None:
            r["acted_at"] = r["acted_at"].isoformat()
    return rows
@app.get("/api/recommendations/wins")
def stub_recommendations_wins(): return []
# RAG target bands for the Range tier counts. Calibrated to the cumulative
# sales-share Pareto distribution (doc 6.5): the active range is a steep long tail
# (T1 tiny, T4 large), so these bracket the observed active-style counts. RAG is an
# app-only health indicator — the docs specify the tier rule, not these target bands.
_RANGE_TARGETS = {
    "total": [1500, 2800],
    "Tier 1": [15, 60],
    "Tier 2": [120, 320],
    "Tier 3": [400, 800],
    "Tier 4": [900, 1800],
}

def _parse_iso_date(s):
    if not s:
        return None
    try:
        y, m, d = (int(x) for x in str(s)[:10].split("-"))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None

def _rag(count, lo, hi):
    if lo <= count <= hi:
        return "green"
    margin = max(1, round((hi - lo) * 0.2))
    if lo - margin <= count <= hi + margin:
        return "amber"
    return "red"

def _tier_summary_block(rows, total_count):
    units = sum(r["units_since_launch"] or 0 for r in rows)
    rev = sum(r["sales_since_launch"] or 0 for r in rows)
    stock = sum(r["current_stock"] or 0 for r in rows)
    denom = units + stock
    return {
        "count": len(rows),
        "pct_styles": round(len(rows) * 100.0 / total_count, 1) if total_count else 0,
        "revenue_lifetime": round(rev),
        "units_lifetime": units,
        "sor_lifetime_pct": round(units * 100.0 / denom, 1) if denom else None,
    }

@app.get("/api/range-mgmt/classify")
def range_mgmt_classify(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, _ = _style_filters(country, channel, "i")
    raw = run_query("""
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number,
                MAX(price) AS price,
                MIN(substring(style_launch_date, 1, 10)) FILTER (
                    WHERE substring(style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                ) AS launch_date
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''
            GROUP BY style_name
        ),
        sales AS (
            SELECT p.style_name,
                SUM(s.net_quantity) AS units_life,
                ROUND(SUM(s.net_sales_kes::numeric)) AS sales_life,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days') AS units_6m,
                ROUND(SUM(s.net_sales_kes::numeric) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days')) AS sales_6m,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days') AS units_30d,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '14 days') AS units_14d,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date::date <  CURRENT_DATE - INTERVAL '14 days'
                      AND s.sale_date::date >= CURRENT_DATE - INTERVAL '44 days') AS units_prior_30d,
                SUM(s.net_quantity) FILTER (WHERE s.pos_location_name ILIKE '%online%') AS units_online,
                SUM(s.net_quantity) FILTER (WHERE s.pos_location_name NOT ILIKE '%online%') AS units_stores,
                MAX(s.sale_date::date) AS last_sale,
                MIN(s.sale_date::date) AS first_sale
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IS NOT NULL AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT style_name,
                COALESCE(SUM(available) FILTER (WHERE pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_stores,
                COALESCE(SUM(available) FILTER (WHERE pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_warehouse
            FROM all_inventory i
            WHERE style_name IS NOT NULL""" + icf + """
            GROUP BY style_name
        )
        SELECT p.style_name, p.brand, p.subcategory, p.style_number, p.price, p.launch_date,
            COALESCE(sa.units_life, 0) AS units_life, COALESCE(sa.sales_life, 0) AS sales_life,
            COALESCE(sa.units_6m, 0) AS units_6m, COALESCE(sa.sales_6m, 0) AS sales_6m,
            COALESCE(sa.units_30d, 0) AS units_30d,
            COALESCE(sa.units_14d, 0) AS units_14d, COALESCE(sa.units_prior_30d, 0) AS units_prior_30d,
            COALESCE(sa.units_online, 0) AS units_online, COALESCE(sa.units_stores, 0) AS units_stores,
            sa.last_sale, sa.first_sale,
            COALESCE(st.soh_stores, 0) AS soh_stores, COALESCE(st.soh_warehouse, 0) AS soh_warehouse
        FROM prod p
        LEFT JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        WHERE COALESCE(sa.units_life, 0) > 0 OR COALESCE(st.soh_stores, 0) > 0 OR COALESCE(st.soh_warehouse, 0) > 0
    """)
    today = date.today()
    active, retired, pipeline, candidates = [], [], [], []
    meta = []  # parallel to `active`: (row, age_tier, first_sale, sales_life, flagged)
    for r in raw:
        units_life = int(r["units_life"] or 0)
        sales_life = float(r["sales_life"] or 0)
        units_6m = int(r["units_6m"] or 0)
        sales_6m = float(r["sales_6m"] or 0)
        units_30d = int(r["units_30d"] or 0)
        units_14d = int(r["units_14d"] or 0)
        units_prior_30d = int(r["units_prior_30d"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        current_stock = soh_stores + soh_warehouse
        last_sale = r["last_sale"]
        first_sale = r["first_sale"]
        launch = _parse_iso_date(r["launch_date"]) or first_sale
        age_weeks = round((today - launch).days / 7.0) if launch else None
        last_sale_days = (today - last_sale).days if last_sale else None
        weekly_avg = round(units_30d / (30.0 / 7.0), 1)
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        reorder_count = int(age_weeks // 12) if age_weeks else 0

        def _sor(u):
            denom = u + current_stock
            return round(u * 100.0 / denom, 1) if denom > 0 else None
        sor_life = _sor(units_life)
        sor_6m = _sor(units_6m)
        avg_price = round(sales_life / units_life) if units_life > 0 else None
        original_price = round(float(r["price"])) if r["price"] else None
        full_price_pct = round(min(100.0, avg_price * 100.0 / original_price), 1) \
            if (avg_price and original_price) else None

        # Age-based lifecycle stage. NOTE: this is NOT the Range tier — doc 6.5 defines
        # tiers by cumulative sales share (assigned in the Pareto pass below). age_tier
        # only drives the age-gated lifecycle: status, graduation gates, action copy.
        if age_weeks is None:
            age_tier = "Tier 4"
        elif age_weeks >= 104:
            age_tier = "Tier 1"
        elif age_weeks >= 39:
            age_tier = "Tier 2"
        elif age_weeks >= 13:
            age_tier = "Tier 3"
        else:
            age_tier = "Tier 4"

        is_retired = (age_weeks is not None and age_weeks >= 39 and units_6m == 0
                      and (last_sale_days is None or last_sale_days > 270))
        flagged = (not is_retired and age_weeks is not None and age_weeks >= 39
                   and sor_life is not None and sor_life < 40 and current_stock > 0)

        if flagged or is_retired:
            status = "Retire"
        elif age_tier in ("Tier 3", "Tier 4") and age_weeks is not None and age_weeks >= 12 \
                and (sor_life is None or sor_life < 25):
            status = "Overdue"
        elif sor_life is not None and sor_life < 45:
            status = "At Risk"
        else:
            status = "On Track"

        if status == "Retire":
            action = "Mark down to outlet and clear remaining stock per the SOP 4-week gap rule."
        elif status == "Overdue":
            action = "Overdue Week-8 read — review sell-through now and decide reorder or exit."
        elif status == "At Risk":
            action = "Monitor weekly; consider a marketing push or price review to lift sell-through."
        elif age_tier == "Tier 3":
            action = "On review — track toward the 9-month gate for graduation to Tier 2."
        else:
            action = "Healthy — maintain replenishment to keep the core line in stock."

        row = {
            "style_name": r["style_name"],
            "style_number": r["style_number"],
            "brand": r["brand"],
            "subcategory": r["subcategory"],
            "tier": None,
            "auto_tier": None,
            "override_reason": None,
            "status": status,
            "recommended_action": action,
            "style_age_weeks": age_weeks,
            "age_tier": age_tier,
            "launch_date": str(launch) if launch else None,
            "reorder_count": reorder_count,
            "current_stock": current_stock,
            "soh_stores": soh_stores,
            "soh_warehouse": soh_warehouse,
            "units_online": int(r["units_online"] or 0),
            "units_stores": int(r["units_stores"] or 0),
            "units_since_launch": units_life,
            "units_6m": units_6m,
            "units_14d": units_14d,
            "units_prior_30d": units_prior_30d,
            "sales_since_launch": sales_life,
            "sales_6m": sales_6m,
            "sor_since_launch": sor_life,
            "sor_6m": sor_6m,
            "lifetime_sor_pct": sor_life,
            "woc": woc,
            "weekly_avg": weekly_avg,
            "last_sale_days": last_sale_days,
            "original_price": original_price,
            "avg_price_since_launch": avg_price,
            "full_price_pct": full_price_pct,
        }

        if is_retired:
            row["tier"] = row["auto_tier"] = "Retire"
            retired.append(row)
            continue
        active.append(row)
        meta.append((row, age_tier, first_sale, sales_life, flagged))

        if (age_tier == "Tier 3" and age_weeks is not None and 0 <= (39 - age_weeks) <= 6
                and reorder_count >= 3 and sor_life is not None and sor_life > 60
                and full_price_pct is not None and full_price_pct > 90):
            candidates.append({
                "style_name": r["style_name"], "brand": r["brand"], "subcategory": r["subcategory"],
                "weeks_to_gate": 39 - age_weeks, "lifetime_sor_pct": sor_life,
                "full_price_pct": full_price_pct, "reorder_count": reorder_count,
                "current_stock": current_stock, "last_sale_days": last_sale_days,
            })

    # --- Range tier classification (doc 6.5): cumulative sales-share Pareto over the
    # ACTIVE range. T1 <= 20% cum share, T2 <= 60%, T3 <= 90%, T4 the long tail.
    # Styles never sold (no first_sale) or with zero lifetime sales fall to Tier 4.
    ranked = sorted([m for m in meta if m[2] is not None and m[3] > 0],
                    key=lambda m: m[3], reverse=True)
    total_sales = sum(m[3] for m in ranked)
    cum = 0.0
    pareto = {}
    for row, _at, _fs, sl, _fl in ranked:
        cum += sl
        share = cum / total_sales if total_sales > 0 else 1.0
        if share <= 0.20:
            pareto[id(row)] = "Tier 1"
        elif share <= 0.60:
            pareto[id(row)] = "Tier 2"
        elif share <= 0.90:
            pareto[id(row)] = "Tier 3"
        else:
            pareto[id(row)] = "Tier 4"

    for row, _at, _fs, _sl, flagged in meta:
        auto_tier = pareto.get(id(row), "Tier 4")
        ov = _RANGE_OVERRIDES.get(row["style_name"])
        if ov:
            row["tier"], row["auto_tier"], row["override_reason"] = ov["tier"], auto_tier, ov.get("reason")
        elif flagged:
            row["tier"], row["auto_tier"], row["override_reason"] = "Retire", "Retire", None
        else:
            row["tier"], row["auto_tier"], row["override_reason"] = auto_tier, auto_tier, None

        if flagged:
            rec = today + timedelta(days=14)
            pipeline.append({**row,
                "recommended_retirement_date": str(rec),
                "outlet_discount_date": str(rec + timedelta(days=28)),
                "reason": "Aged %sw at %s%% lifetime SOR with %s units remaining — below retirement threshold." % (
                    row["style_age_weeks"], row["sor_since_launch"], row["current_stock"]),
            })

    tier_counts = {t: 0 for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4", "Retire")}
    for row in active:
        tier_counts[row["tier"]] = tier_counts.get(row["tier"], 0) + 1

    total_count = len(active) + len(retired)
    tier_summary = {
        "Total": _tier_summary_block(active + retired, total_count),
        "Active": _tier_summary_block(active, total_count),
        "Retired": _tier_summary_block(retired, total_count),
    }
    for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
        tier_summary[t] = _tier_summary_block(
            [row for row in active if row["tier"] == t], total_count)

    # Approaching age-gates is an age-lifecycle metric, so it keys off age_tier.
    approaching = sum(1 for row in active
        if row["style_age_weeks"] is not None and (
            (row["age_tier"] == "Tier 3" and 0 <= (39 - row["style_age_weeks"]) <= 6) or
            (row["age_tier"] == "Tier 4" and 0 <= (13 - row["style_age_weeks"]) <= 6)))

    rag = {"total": _rag(len(active), *_RANGE_TARGETS["total"])}
    for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
        rag[t] = _rag(tier_counts.get(t, 0), *_RANGE_TARGETS[t])

    summary = {
        "total_active_styles": len(active),
        "flagged_for_retirement": len(pipeline),
        "overdue_for_week8_read": sum(1 for row in active if row["status"] == "Overdue"),
        "approaching_decision_gates": approaching,
        "tier_counts": tier_counts,
        "targets": _RANGE_TARGETS,
        "rag": rag,
        "tier_summary": tier_summary,
    }

    candidates.sort(key=lambda c: c["weeks_to_gate"])
    pipeline.sort(key=lambda p: -(p["style_age_weeks"] or 0))
    return {
        "rows": active,
        "retired_rows": retired,
        "summary": summary,
        "retirement_pipeline": pipeline,
        "recent_movements": [],
        "tier3_graduation_candidates": candidates,
    }

@app.get("/api/range-mgmt/weekly-sor")
def range_mgmt_weekly_sor(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, _ = _style_filters(country, channel, "i")
    raw = run_query("""
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number,
                MIN(substring(style_launch_date, 1, 10)) FILTER (
                    WHERE substring(style_launch_date, 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                ) AS launch_date
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''
            GROUP BY style_name
        ),
        new_styles AS (
            SELECT * FROM prod
            WHERE launch_date IS NOT NULL AND launch_date::date >= CURRENT_DATE - INTERVAL '98 days'
        ),
        sales AS (
            SELECT p.style_name, s.sale_date::date AS sd, SUM(s.net_quantity) AS units
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IN (SELECT style_name FROM new_styles)
              AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name, s.sale_date::date
        ),
        stock AS (
            SELECT style_name, COALESCE(SUM(available), 0) AS current_stock
            FROM all_inventory i
            WHERE style_name IN (SELECT style_name FROM new_styles)
              AND pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)""" + icf + """
            GROUP BY style_name
        )
        SELECT n.style_name, n.brand, n.subcategory, n.style_number, n.launch_date,
            COALESCE(st.current_stock, 0) AS current_stock, sa.sd, sa.units
        FROM new_styles n
        LEFT JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        ORDER BY n.style_name
    """)
    today = date.today()
    min_combined = 5
    styles = {}
    for r in raw:
        name = r["style_name"]
        st = styles.get(name)
        if st is None:
            launch = _parse_iso_date(r["launch_date"])
            st = styles[name] = {
                "style_name": name, "brand": r["brand"], "subcategory": r["subcategory"],
                "style_number": r["style_number"], "launch_date": r["launch_date"],
                "launch": launch, "current_stock": int(r["current_stock"] or 0), "sales": [],
            }
        if r["sd"] is not None and r["units"]:
            st["sales"].append((r["sd"], int(r["units"])))

    rows = []
    for st in styles.values():
        launch = st["launch"]
        if not launch:
            continue
        age_weeks = (today - launch).days / 7.0
        if age_weeks < 0 or age_weeks >= 14:
            continue
        lifetime_units = sum(u for _, u in st["sales"])
        denom = lifetime_units + st["current_stock"]
        if denom < min_combined:
            continue
        max_week = min(14, int(age_weeks) + 1)
        cum = [0] * 14
        for sd, u in st["sales"]:
            wk = (sd - launch).days // 7 + 1
            if 1 <= wk <= 14:
                cum[wk - 1] += u
        running = 0
        weekly_sor = []
        for n in range(1, 15):
            running += cum[n - 1]
            weekly_sor.append(round(running * 100.0 / denom, 1) if n <= max_week else None)
        rows.append({
            "style_name": st["style_name"], "brand": st["brand"], "subcategory": st["subcategory"],
            "style_number": st["style_number"], "launch_date": st["launch_date"],
            "age_weeks": round(age_weeks, 1), "current_stock": st["current_stock"],
            "weekly_sor": weekly_sor,
        })
    rows.sort(key=lambda x: x["age_weeks"])
    return {"weeks": list(range(1, 15)), "rows": rows, "min_combined": min_combined}

@app.get("/api/range-mgmt/marketing-candidates")
def range_mgmt_marketing_candidates(country: str = Query(default=None), channel: str = Query(default=None)):
    # Doc 03.8.1: a style is a marketing-push candidate if it is Tier 3/4 in the
    # current Range Mgmt classification AND it re-activated recently — sold >= 1 unit
    # in the last 14 days but was dormant for the 30 days before that. Reuses the
    # classify pass (which carries units_14d / units_prior_30d per style).
    # NOTE: action persistence was Mongo-backed (infrastructure not replicated), so
    # in_flight stays empty until an action store exists.
    cls = range_mgmt_classify(country, channel)
    cands = []
    for row in cls["rows"]:
        if row["tier"] in ("Tier 3", "Tier 4") \
                and (row.get("units_14d") or 0) >= 1 \
                and (row.get("units_prior_30d") or 0) == 0:
            cands.append({
                "style_name": row["style_name"],
                "style_number": row["style_number"],
                "brand": row["brand"],
                "subcategory": row["subcategory"],
                "tier": row["tier"],
                "launch_date": row["launch_date"],
                "age_weeks": row["style_age_weeks"],
                "sor_lifetime": row["sor_since_launch"],
                "units_online": row["units_online"],
                "units_stores": row["units_stores"],
                "soh_warehouse": row["soh_warehouse"],
                "soh_stores": row["soh_stores"],
                "current_stock": row["current_stock"],
                "days_since_last_sale": row["last_sale_days"],
                "units_14d": row.get("units_14d"),
            })
    # Sorted lowest lifetime SOR first (nulls last).
    cands.sort(key=lambda c: (c["sor_lifetime"] is None, c["sor_lifetime"] or 0))
    return {
        "candidates": cands,
        "in_flight": [],
        "action_types": ["Discount", "Email Campaign", "Social Push",
                         "Window Display", "Bundle", "Influencer", "Other"],
        "threshold_pct": 90,
        "age_min_weeks": 13,
    }
@app.get("/api/feedback")
def stub_feedback_get(): return []
@app.get("/api/feedback/mine")
def stub_feedback_mine(): return []
@app.get("/api/search")
def stub_search(): return []
@app.get("/api/search/customers")
def stub_search_customers(): return []
@app.get("/api/thumbnails")
def stub_thumbnails(): return []

# --- GET stubs returning objects ---
@app.get("/api/analytics/cache-stats")
def analytics_cache_stats(): return _cache_stats_payload()
@app.get("/api/admin/cache-stats")
def admin_cache_stats(): return _cache_stats_payload()
@app.get("/api/admin/reconciliation-check")
def admin_reconciliation_check():
    # Cross-page consistency: the Σ of per-country aggregates must equal the
    # single-shot /kpis totals over the same window (both derive from all_sales
    # under identical BASE_FILTERS, so any drift means an aggregation bug).
    rng = run_query("SELECT MAX(s.sale_date) AS d FROM all_sales s")
    max_date = (rng[0]["d"] if rng and rng[0].get("d") else None)
    if not max_date:
        return {"date": None, "checks": [], "errors": [
            {"endpoint": "/all_sales", "error": "no sale_date available"}]}
    date_to = str(max_date)[:10]
    date_from = (date.fromisoformat(date_to) - timedelta(days=30)).isoformat()

    checks = []
    errors = []
    sot = {}
    try:
        kpis = get_kpis(date_from, date_to, country=None, channel=None)
        countries = _country_summary_q(date_from, date_to)
        sot = {"total_sales_kes": float(kpis.get("total_sales") or 0)}

        def _num(x):
            try:
                return float(x or 0)
            except Exception:
                return 0.0

        def _add(name, expected, got, hint):
            exp, g = _num(expected), _num(got)
            delta = g - exp
            delta_pct = (delta / exp * 100) if exp else (0.0 if g == 0 else 100.0)
            checks.append({
                "name": name,
                "ok": abs(delta_pct) < 0.5,
                "expected": exp,
                "got": g,
                "delta": delta,
                "delta_pct": delta_pct,
                "hint": None if abs(delta_pct) < 0.5 else hint,
            })

        _add("country_sales_sum_eq_kpis",
             kpis.get("total_sales"),
             sum(_num(c.get("total_sales")) for c in countries),
             "Σ per-country net sales drifted from /kpis total — check _country_summary_q vs get_kpis filters.")
        _add("country_orders_sum_eq_kpis",
             kpis.get("total_orders"),
             sum(_num(c.get("orders")) for c in countries),
             "Σ per-country orders drifted from /kpis — order_id DISTINCT counting differs across aggregations.")
        _add("country_units_sum_eq_kpis",
             kpis.get("total_units"),
             sum(_num(c.get("units_sold")) for c in countries),
             "Σ per-country units drifted from /kpis — ordered_item_quantity summed differently.")
    except Exception as e:
        errors.append({"endpoint": "/api/kpis", "error": str(e)})

    return {
        "date": f"{date_from} → {date_to}",
        "source_of_truth": sot,
        "checks": checks,
        "errors": errors,
    }
@app.get("/api/data-freshness")
def stub_data_freshness(): return {"fresh": True, "last_updated": None}
@app.get("/api/ibt/late-count")
def ibt_late_count():
    # Outstanding IBT suggestions (default 30-day window) that are neither
    # completed nor recently acted on: treat anything not acknowledged within
    # the last 7 days as late (Phase 1 audit B6).
    today = date.today()
    df = (today - timedelta(days=30)).isoformat()
    dt = today.isoformat()
    inner = _ibt_suggestions_sql(df, dt, None, 0.20, 1.50, 1000)
    q = ("WITH suggestions AS (" + inner + ") "
         "SELECT COUNT(*) AS count FROM suggestions sg "
         "LEFT JOIN ibt_completions c "
         "ON COALESCE(c.style_name,'') = COALESCE(sg.style_name,'') "
         "AND COALESCE(c.from_store,'') = COALESCE(sg.from_store,'') "
         "AND COALESCE(c.to_store,'') = COALESCE(sg.to_store,'') "
         "LEFT JOIN recommendation_actions ra "
         "ON ra.rec_type='ibt' "
         "AND ra.rec_key = COALESCE(sg.style_name,'')||'||'||COALESCE(sg.from_store,'')"
         "||'||'||COALESCE(sg.to_store,'') "
         "WHERE c.id IS NULL "
         "AND COALESCE(ra.acted_at, now() - INTERVAL '7 days') <= now() - INTERVAL '7 days'")
    rows = _users_exec(q, fetch=True)
    return {"count": int(rows[0]["count"]) if rows else 0}
@app.get("/api/notifications/unread-count")
def stub_notifications_unread_count(): return {"unread": 0}
@app.get("/api/leaderboard/store-of-the-week")
def stub_leaderboard_store_of_the_week(): return {}
@app.get("/api/thumbnails/lookup")
def stub_thumbnails_lookup(): return {}
@app.get("/api/auth/activity-streak")
def stub_auth_activity_streak(): return {"streak": 0}
@app.get("/api/auth/allowed-domains")
def stub_auth_allowed_domains(): return {"domains": []}
@app.get("/api/auth/heartbeat")
def stub_auth_heartbeat(): return {"ok": True}
@app.get("/api/user/last-visit")
def stub_user_last_visit(): return {"last_visit": None}
@app.get("/api/chat")
def stub_chat_get(): return {"reply": ""}

def _fmt_bucket_label(d, bucket):
    if bucket == "week":
        return "Wk " + d.strftime("%b %d")
    if bucket == "month":
        return d.strftime("%b %Y")
    if bucket == "quarter":
        return "Q%d %d" % ((d.month - 1) // 3 + 1, d.year)
    return d.strftime("%b %d")

@app.get("/api/analytics/kpi-trend")
def get_kpi_trend(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    bucket:    str = Query(default="day"),
):
    bucket = bucket if bucket in ("day", "week", "month", "quarter") else "day"
    where = build_filters(date_from, date_to, country)
    rows = run_query("""
        SELECT
            date_trunc('""" + bucket + """', s.sale_date::date)::date AS bucket_date,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discount,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY 1
        ORDER BY 1
    """, date_to=date_to)
    for r in rows:
        d = r.pop("bucket_date")
        r["date"] = str(d)
        r["label"] = _fmt_bucket_label(d, bucket)
    return rows

# --- GET stub used also as POST below (marketing-actions) ---
@app.get("/api/range-mgmt/marketing-actions")
def stub_range_mgmt_marketing_actions_get(): return []

# --- POST stubs ---
@app.post("/api/auth/verify-password")
async def auth_verify_password(request: Request):
    # Step-up: verify the shared ops password and issue a short-lived, user-bound
    # reveal token that unmasks customer PII for ~10 minutes.
    configured = os.environ.get("PII_REVEAL_PASSWORD")
    if not configured:
        return JSONResponse(
            {"detail": "PII reveal is not configured. Set the PII_REVEAL_PASSWORD secret to enable it."},
            status_code=503,
        )
    if not _pii_signing_key():
        # Without a signing secret, issued tokens would be forgeable — refuse to enable
        # the reveal flow at all (defense in depth alongside _reveal_token_valid).
        return JSONResponse(
            {"detail": "PII reveal is not configured. Set the SESSION_SECRET secret to enable it."},
            status_code=503,
        )
    try:
        body = await request.json()
    except Exception:
        body = {}
    supplied = (body or {}).get("password") or ""
    if not hmac.compare_digest(str(supplied), str(configured)):
        return JSONResponse({"detail": "Incorrect password"}, status_code=403)
    user = getattr(request.state, "user", None) or {}
    return {"ok": True, "valid": True, "reveal_token": make_reveal_token(str(user.get("id") or ""))}
@app.post("/api/allocations/calculate")
async def allocations_calculate(request: Request):
    body = await request.json()
    subcategory = body.get("subcategory")
    color = body.get("color")
    sizes = body.get("sizes") or []
    units_total = int(body.get("units_total") or 0)
    vw = float(body.get("velocity_weight") or 0)
    sw = float(body.get("stock_weight") or 0)
    aw = float(body.get("asp_weight") or 0)
    wh_pct = float(body.get("warehouse_pct") or 0)
    on_pct = float(body.get("online_pct") or 0)
    excluded = set(body.get("excluded_stores") or [])
    style_name = body.get("style_name")
    alloc_type = body.get("allocation_type") or "new"
    def _iso(v, default):
        try:
            return date.fromisoformat(str(v)[:10]).isoformat()
        except (ValueError, TypeError):
            return default
    dfrom = _iso(body.get("date_from"), str(date.today() - timedelta(days=90)))
    dto = _iso(body.get("date_to"), str(date.today()))

    pack_rows = run_query("""
        SELECT size, COUNT(*) AS n FROM all_products_clean
        WHERE size IS NOT NULL AND size <> '' AND size NOT LIKE '%/%'
        GROUP BY size ORDER BY n DESC LIMIT 12
    """)
    full_pack = {}
    if pack_rows:
        mn = min(float(r["n"]) for r in pack_rows) or 1
        for r in pack_rows:
            full_pack[r["size"]] = max(1, min(4, int(round(float(r["n"]) / mn))))
    pack_breakdown = {sz: full_pack.get(sz, 1) for sz in sizes}
    pack_unit_size = sum(pack_breakdown.values()) or 1
    store_units = units_total * max(0.0, 1.0 - (wh_pct + on_pct) / 100.0)
    total_packs = int(store_units // pack_unit_size)

    extra = ""
    if subcategory:
        extra += " AND p.product_type = '" + subcategory.replace("'", "''") + "'"
    if color:
        extra += " AND p.color_print ILIKE '%" + color.replace("'", "''") + "%'"
    if alloc_type == "replenishment" and style_name:
        extra += " AND p.style_name = '" + style_name.replace("'", "''") + "'"
    rows = run_query("""
        WITH vel AS (
            SELECT s.pos_location_name AS store,
                SUM(s.net_quantity) AS units_sold, SUM(s.net_sales_kes::numeric) AS sales
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date BETWEEN '""" + dfrom + """' AND '""" + dto + """'
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND s.pos_location_name NOT ILIKE '%online%'""" + extra + """
            GROUP BY s.pos_location_name
        ),
        stk AS (
            SELECT i.pos_location_name AS store, SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND i.pos_location_name NOT ILIKE '%online%'""" + extra + """
            GROUP BY i.pos_location_name
        )
        SELECT COALESCE(v.store, k.store) AS store,
            COALESCE(v.units_sold, 0) AS units_sold, COALESCE(v.sales, 0) AS sales,
            COALESCE(k.soh, 0) AS soh
        FROM vel v FULL OUTER JOIN stk k ON k.store = v.store
        WHERE COALESCE(v.store, k.store) IS NOT NULL
    """)
    stores = [r for r in rows if r["store"] and r["store"] not in excluded]
    max_units = max((float(r["units_sold"]) for r in stores), default=0) or 1
    max_soh = max((float(r["soh"]) for r in stores), default=0) or 1

    def asp(r):
        u = float(r["units_sold"]) or 0
        return (float(r["sales"]) / u) if u else 0

    max_asp = max((asp(r) for r in stores), default=0) or 1
    wsum = (vw + sw + aw) or 1
    scored = []
    for r in stores:
        u, soh = float(r["units_sold"]), float(r["soh"])
        vel_score = u / max_units
        low_stock_score = 1.0 - (soh / max_soh)
        asp_score = asp(r) / max_asp
        score = (vw * vel_score + sw * low_stock_score + aw * asp_score) / wsum
        scored.append({
            "store": r["store"], "score": max(0.0, score),
            "velocity_score": round(vel_score, 4), "low_stock_score": round(low_stock_score, 4),
            "units_sold_window": int(u), "current_soh": int(soh),
        })
    candidates = [s for s in scored if s["score"] > 0] or scored
    tot_score = sum(s["score"] for s in candidates) or 1
    raw = [(s, total_packs * s["score"] / tot_score) for s in candidates]
    alloc = {s["store"]: int(q) for s, q in raw}
    remaining = total_packs - sum(alloc.values())
    fracs = sorted(raw, key=lambda x: (x[1] - int(x[1])), reverse=True)
    i = 0
    while remaining > 0 and fracs:
        alloc[fracs[i % len(fracs)][0]["store"]] += 1
        remaining -= 1
        i += 1
    out_rows = []
    for s in candidates:
        packs = alloc.get(s["store"], 0)
        if packs <= 0:
            continue
        out_rows.append({
            "store": s["store"], "packs_allocated": packs,
            "units_allocated": packs * pack_unit_size,
            "velocity_score": s["velocity_score"], "low_stock_score": s["low_stock_score"],
            "units_sold_window": s["units_sold_window"], "current_soh": s["current_soh"],
        })
    out_rows.sort(key=lambda r: r["packs_allocated"], reverse=True)
    return {"rows": out_rows, "pack_unit_size": pack_unit_size, "pack_breakdown": pack_breakdown}


@app.post("/api/allocations/save")
async def allocations_save(request: Request):
    body = await request.json()
    body_rows = body.get("rows") or []
    run = {
        "id": hashlib.md5((str(time.time()) + str(body.get("style_name"))).encode()).hexdigest()[:12],
        "style_name": body.get("style_name"), "color": body.get("color"),
        "allocation_type": body.get("allocation_type"), "subcategory": body.get("subcategory"),
        "units_total": body.get("units_total"),
        "pack_unit_size": body.get("pack_unit_size"), "pack_breakdown": body.get("pack_breakdown") or {},
        "status": "pending_fulfilment", "created_at": date.today().isoformat() + "T00:00",
        "created_by_name": "Planner", "created_by_email": "planner@vivo",
        "fulfilled_by_email": None, "fulfilled_at": None,
        "suggested_total": sum(int(r.get("suggested_units") or 0) for r in body_rows),
        "allocated_total": sum(int(r.get("allocated_units") or 0) for r in body_rows),
        "rows": [],
    }
    for r in body_rows:
        sizes = r.get("sizes") or {}
        run["rows"].append({
            "store": r.get("store"),
            "buying_packs": r.get("suggested_packs") or 0, "suggested_packs": r.get("suggested_packs") or 0,
            "buying_units": r.get("suggested_units") or 0, "suggested_units": r.get("suggested_units") or 0,
            "allocated_packs": r.get("allocated_packs") or 0,
            "allocated_units": r.get("allocated_units") or 0, "warehouse_units": 0,
            "buying_sizes": sizes, "warehouse_sizes": {}, "sizes": sizes,
        })
    run["delta_total"] = run["allocated_total"] - run["suggested_total"]
    _alloc_insert(run)
    return run


@app.patch("/api/allocations/runs/{run_id}/fulfil")
async def allocations_runs_fulfil(run_id: str, request: Request):
    body = await request.json()
    fulfil_rows = {r.get("store"): (r.get("sizes") or {}) for r in (body.get("rows") or [])}
    run = _alloc_get(run_id)
    if run is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Run not found")
    if run.get("status") == "fulfilled":
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Run already fulfilled")
    total = 0
    for r in run.get("rows", []):
        szs = fulfil_rows.get(r["store"])
        if szs is not None:
            szs = {k: int(v or 0) for k, v in szs.items()}
            r["warehouse_sizes"] = szs
            r["warehouse_units"] = sum(szs.values())
        else:
            r["warehouse_sizes"] = r.get("buying_sizes") or {}
            r["warehouse_units"] = r.get("buying_units") or 0
        total += r["warehouse_units"]
    run["status"] = "fulfilled"
    run["allocated_total"] = total
    run["delta_total"] = total - (run.get("suggested_total") or 0)
    run["fulfilled_by_email"] = "warehouse@vivo"
    run["fulfilled_at"] = date.today().isoformat() + "T00:00"
    _alloc_update(run)
    return run
@app.post("/api/admin/cache-clear")
async def admin_cache_clear(request: Request):
    n = len(_cache)
    _cache.clear()
    return {"ok": True, "cleared": {"stale_cache_entries": n, "redis_keys": 0}}
@app.post("/api/admin/flush-kpi-cache")
async def admin_flush_kpi_cache(request: Request):
    n = len(_cache)
    _cache.clear()
    return {"ok": True, "cleared": {"stale_cache_entries": n, "redis_keys": 0}}
@app.post("/api/admin/full-snapshot-rebuild")
async def stub_admin_full_snapshot_rebuild(request: Request): return {"ok": True}
@app.post("/api/admin/run-audit-now")
async def stub_admin_run_audit_now(request: Request): return {"ok": True}
@app.patch("/api/admin/users/{user_id}")
@app.post("/api/admin/users/{user_id}")
async def admin_users_update(user_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    acting = getattr(request.state, "user", None) or {}

    new_role = None
    if body.get("role"):
        if body["role"] not in VALID_ROLES:
            return JSONResponse({"detail": "Invalid role"}, status_code=400)
        new_role = body["role"]

    new_status = None
    if body.get("status"):
        if body["status"] not in VALID_STATUSES:
            return JSONResponse({"detail": "Invalid status"}, status_code=400)
        new_status = body["status"]
    elif "active" in body:
        new_status = "active" if body["active"] else "disabled"

    # Guard + write run in one advisory-locked transaction so two concurrent
    # demotions/deletions cannot both pass the last-admin check and leave zero
    # active admins (TOCTOU).
    try:
        with _users_tx(lock=True) as cur:
            cur.execute(
                "SELECT user_id, role, status FROM app_users WHERE user_id=%s FOR UPDATE",
                (user_id,))
            target = cur.fetchone()
            if not target:
                return JSONResponse({"detail": "User not found"}, status_code=404)

            # Lockout guard: never let the change remove the last active admin.
            would_role = new_role or target["role"]
            would_status = new_status or target["status"]
            loses_admin = (target["role"] == "admin" and target["status"] == "active"
                           and not (would_role == "admin" and would_status == "active"))
            if loses_admin and _active_admins_excluding(cur, exclude_user_id=user_id) == 0:
                return JSONResponse(
                    {"detail": "Cannot remove the last active administrator."},
                    status_code=400)

            sets, params = [], []
            if new_role is not None:
                sets.append("role=%s"); params.append(new_role)
            if new_status is not None:
                sets.append("status=%s"); params.append(new_status)
                if new_status == "active":
                    sets.append("approved_at=now()")
                    sets.append("approved_by=%s")
                    params.append(acting.get("email") or acting.get("id"))
            if not sets:
                return {"ok": True}
            params.append(user_id)
            cur.execute(
                f"UPDATE app_users SET {', '.join(sets)} WHERE user_id=%s", tuple(params))
    finally:
        _invalidate_user_cache(user_id)
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
async def admin_users_delete(user_id: str, request: Request):
    # Guard + delete run in one advisory-locked transaction so concurrent deletes
    # cannot both pass the last-admin check (TOCTOU).
    try:
        with _users_tx(lock=True) as cur:
            cur.execute(
                "SELECT role, status FROM app_users WHERE user_id=%s FOR UPDATE",
                (user_id,))
            t = cur.fetchone()
            if not t:
                return {"ok": True}
            if (t["role"] == "admin" and t["status"] == "active"
                    and _active_admins_excluding(cur, exclude_user_id=user_id) == 0):
                return JSONResponse(
                    {"detail": "Cannot delete the last active administrator."},
                    status_code=400)
            cur.execute("DELETE FROM app_users WHERE user_id=%s", (user_id,))
    finally:
        _invalidate_user_cache(user_id)
    return {"ok": True}


@app.post("/api/admin/users")
async def admin_users_create(request: Request):
    # Admin-provisioned email/password account. Clerk owns credentials, so we
    # create the identity via the Clerk Backend API, then mark it active locally.
    try:
        body = await request.json()
    except Exception:
        body = {}
    email = (body.get("email") or "").strip().lower()
    name = (body.get("name") or "").strip()
    password = body.get("password") or ""
    role = body.get("role") or "viewer"
    if role not in VALID_ROLES:
        return JSONResponse({"detail": "Invalid role"}, status_code=400)
    if not email or "@" not in email:
        return JSONResponse({"detail": "A valid email is required"}, status_code=400)
    if not clerk_auth.email_allowed(email):
        return JSONResponse(
            {"detail": "Email must be on an allowed company domain"}, status_code=400)
    if len(password) < 8:
        return JSONResponse(
            {"detail": "Password must be at least 8 characters"}, status_code=400)

    secret = os.environ.get("CLERK_SECRET_KEY")
    if not secret:
        return JSONResponse(
            {"detail": "User creation is not configured (missing Clerk secret)."},
            status_code=503)

    import requests
    parts = name.split() if name else [email.split("@")[0]]
    first = parts[0]
    last = " ".join(parts[1:]) or None
    payload = {"email_address": [email], "password": password, "first_name": first}
    if last:
        payload["last_name"] = last
    try:
        resp = requests.post(
            "https://api.clerk.com/v1/users",
            headers={"Authorization": f"Bearer {secret}",
                     "Content-Type": "application/json"},
            json=payload, timeout=15)
    except Exception:
        return JSONResponse(
            {"detail": "Could not reach the identity provider."}, status_code=502)
    if resp.status_code >= 400:
        detail = "Identity provider rejected the request."
        try:
            errs = resp.json().get("errors") or []
            if errs:
                detail = errs[0].get("long_message") or errs[0].get("message") or detail
        except Exception:
            pass
        return JSONResponse({"detail": detail}, status_code=400)

    sub = (resp.json() or {}).get("id")
    acting = getattr(request.state, "user", None) or {}
    approver = acting.get("email") or acting.get("id")
    _users_exec("""
        INSERT INTO app_users (user_id, email, name, role, status, auth_method,
                               approved_at, approved_by)
        VALUES (%s, %s, %s, %s, 'active', 'password', now(), %s)
        ON CONFLICT (user_id) DO UPDATE
            SET role=EXCLUDED.role, status='active',
                approved_at=now(), approved_by=EXCLUDED.approved_by
    """, (sub, email, name or first, role, approver))
    _invalidate_user_cache(sub)
    return {"ok": True, "user_id": sub}
@app.post("/api/analytics/replenishment-report/mark")
async def analytics_replenishment_report_mark(request: Request):
    body = await request.json()
    sku = body.get("sku")
    barcode = body.get("barcode")
    pos_location = body.get("pos_location")
    if not pos_location or (not sku and not barcode):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="pos_location and one of sku/barcode are required")
    replenished = bool(body.get("replenished", True))
    actual = int(body.get("actual_units_replenished") or 0)
    acting = getattr(request.state, "user", None) or {}
    acted_by = acting.get("name") or acting.get("email")
    # Callers identify rows by either sku (Replenishments) or barcode
    # (ReplenishmentReport); store under both so either GET row matches.
    if sku:
        _set_replen_mark(pos_location, "sku", sku, replenished, actual, acted_by)
    if barcode:
        _set_replen_mark(pos_location, "barcode", barcode, replenished, actual, acted_by)
    return {
        "ok": True, "sku": sku, "barcode": barcode, "pos_location": pos_location,
        "replenished": replenished, "actual_units_replenished": actual,
    }
@app.post("/api/ibt/complete")
async def ibt_complete(request: Request):
    body = await request.json()
    acting = getattr(request.state, "user", None) or {}

    def _d(v):
        try:
            return date.fromisoformat(str(v)[:10]).isoformat()
        except Exception:
            return None

    def _i(v):
        try:
            return int(v)
        except Exception:
            return None

    _users_exec(
        "INSERT INTO ibt_completions "
        "(style_name, brand, subcategory, from_store, to_store, flow, "
        "units_to_move, actual_units_moved, sku, color, size, barcode, "
        "po_number, completed_by_name, suggested_at, transfer_date) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (body.get("style_name"), body.get("brand"), body.get("subcategory"),
         body.get("from_store"), body.get("to_store"),
         body.get("flow") or "store_to_store",
         _i(body.get("units_to_move")), _i(body.get("actual_units_moved")),
         body.get("sku"), body.get("color"), body.get("size"), body.get("barcode"),
         body.get("po_number"),
         body.get("completed_by_name") or acting.get("name") or acting.get("email"),
         _d(body.get("suggested_at")), _d(body.get("transfer_date"))))
    return {"ok": True}
@app.post("/api/notifications/read-all")
async def stub_notifications_read_all(request: Request): return {"ok": True}
@app.post("/api/notifications/refresh")
async def stub_notifications_refresh(request: Request): return {"ok": True}
@app.post("/api/notifications/{event_id}/read")
async def stub_notifications_read(event_id: str, request: Request): return {"ok": True}
@app.post("/api/marketing/weekly-report/send")
async def stub_marketing_weekly_report_send(request: Request): return {"ok": True}
@app.post("/api/range-mgmt/overrides/bulk-promote")
async def range_mgmt_overrides_bulk_promote(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if isinstance(body, list):
        items = body
        tier = "Tier 2"
        reason = "Bulk graduation to Tier 2"
    else:
        items = body.get("styles") or body.get("style_names") or []
        tier = body.get("tier") or "Tier 2"
        reason = body.get("reason") or "Manual graduation to %s" % tier
    upserted = 0
    for it in items:
        name = it.get("style_name") if isinstance(it, dict) else it
        if not name:
            continue
        _RANGE_OVERRIDES[name] = {"tier": (it.get("tier") if isinstance(it, dict) else None) or tier,
                                  "reason": (it.get("reason") if isinstance(it, dict) else None) or reason}
        upserted += 1
    return {"ok": True, "upserted": upserted}
@app.post("/api/range-mgmt/marketing-actions")
async def stub_range_mgmt_marketing_actions_post(request: Request): return {"ok": True}
@app.patch("/api/range-mgmt/marketing-actions/{action_id}")
@app.delete("/api/range-mgmt/marketing-actions/{action_id}")
async def stub_range_mgmt_marketing_actions_modify(action_id: str, request: Request): return {"ok": True}
@app.post("/api/feedback")
async def stub_feedback_post(request: Request): return {"ok": True, "id": 1}
@app.patch("/api/feedback/{feedback_id}")
@app.delete("/api/feedback/{feedback_id}")
async def stub_feedback_modify(feedback_id: str, request: Request): return {"ok": True}
@app.post("/api/thumbnails/{style}")
async def stub_thumbnails_post(style: str, request: Request): return {"ok": True}
@app.post("/api/auth/heartbeat")
async def stub_auth_heartbeat_post(request: Request): return {"ok": True}
@app.post("/api/recommendations")
async def post_recommendations(request: Request):
    body = await request.json()
    item_type = body.get("item_type") or body.get("rec_type")
    item_key = body.get("item_key") or body.get("rec_key")
    status = body.get("status")
    if not item_type or not item_key or not status:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="item_type, item_key and status are required")
    acting = getattr(request.state, "user", None) or {}
    acted_by = acting.get("name") or acting.get("email")
    note = body.get("note")
    if status == "pending":
        _users_exec(
            "DELETE FROM recommendation_actions WHERE rec_type=%s AND rec_key=%s",
            (item_type, item_key))
        return {"ok": True, "item_type": item_type, "item_key": item_key, "status": "pending"}
    _users_exec(
        "INSERT INTO recommendation_actions "
        "(rec_type, rec_key, status, reason, acted_by, acted_at) "
        "VALUES (%s, %s, %s, %s, %s, now()) "
        "ON CONFLICT (rec_type, rec_key) DO UPDATE SET "
        "status=EXCLUDED.status, reason=EXCLUDED.reason, "
        "acted_by=EXCLUDED.acted_by, acted_at=now()",
        (item_type, item_key, status, note, acted_by))
    return {"ok": True, "item_type": item_type, "item_key": item_key, "status": status}
@app.post("/api/admin/replenishment-config")
async def admin_replenishment_config_post(request: Request):
    body = await request.json()
    owners = [str(o).strip() for o in (body.get("owners") or []) if str(o).strip()]
    owners = owners or list(_DEFAULT_REPLEN_OWNERS)
    _set_replen_owners(owners)
    return {"ok": True, "owners": owners}
# ── Conversational BI assistant (text-to-SQL over live Postgres) ──────────────
# The widget (ChatWidget.jsx) POSTs {message, session_id, context} and renders
# the {session_id, answer} reply as plain text. The assistant works in two LLM
# passes: (1) plan — answer directly or emit ONE read-only SELECT; (2) summarize
# the returned rows into executive prose. Generated SQL runs on a dedicated
# connection forced read-only with a statement timeout and a hard row cap, so it
# can never write or run away, and customer contact PII stays off-limits.
import json as _chat_json
import re as _chat_re
import uuid as _chat_uuid
import requests as _chat_requests
from starlette.concurrency import run_in_threadpool as _chat_run_in_threadpool

_CHAT_MODEL = "gpt-5.4"
_CHAT_MAX_TOKENS = 8192
_CHAT_ROW_LIMIT = 200            # hard cap on rows the generated SQL may return
_CHAT_SUMMARY_ROWS = 60          # rows actually handed to the model to summarize
_CHAT_MAX_TURNS = 10             # NL turns kept per session for follow-up context
_CHAT_SESSIONS = {}              # session_id -> list[{"role","content"}]
_CHAT_SESSIONS_LOCK = threading.Lock()

_CHAT_SCHEMA_DOC = """
You write PostgreSQL SELECT queries against a read-only retail BI database for
Vivo Fashion Group (multi-brand fashion, East Africa). Money is Kenyan Shillings.

MAIN FACT TABLE — all_sales s  (one row per sale/return line):
  s.sale_date    TEXT  'YYYY-MM-DD'  -- cast s.sale_date::date for date_trunc/EXTRACT; plain BETWEEN on the text is fine
  s.country      TEXT  -- 'Kenya','Uganda','Rwanda', and an Online channel
  s.channel      TEXT
  s.pos_location_name TEXT  -- store / point of sale
  s.sale_kind    TEXT  -- 'sale','order','return'
  s.customer_id  TEXT
  s.customer_type TEXT
  s.product_title TEXT
  s.product_type  TEXT  -- subcategory, e.g. 'Maxi Dresses'
  s.product_vendor TEXT -- brand
  s.variant_sku   TEXT
  s.ordered_item_quantity INTEGER   -- units sold (use with sale_kind in ('sale','order'))
  s.returned_item_quantity INTEGER
  -- MONEY: ALWAYS use the *_kes columns (KES). Ignore the non-kes money columns.
  s.total_sales_kes NUMERIC
  s.gross_sales_kes NUMERIC
  s.discounts_kes   NUMERIC
  s.returns_kes     NUMERIC
  s.net_sales_kes   NUMERIC

OTHER TABLES (query directly; inspect columns by selecting a few rows if unsure):
  all_inventory      -- current stock on hand by location / sku
  all_products_clean -- product master (style, category, product_type)
  all_customers      -- customer master (NEVER select phone or email)
  footfall           -- store footfall / traffic by date
  pos_locations, stores -- store metadata

MANDATORY RULES:
- Read-only. Output exactly ONE statement: a SELECT (or WITH ... SELECT). Never write.
- On all_sales ALWAYS add this noise filter to the WHERE clause:
""" + "    " + BASE_FILTERS.strip() + """
- Money is KES; round money to 0 decimals.
- Net sales = SUM(net_sales_kes) for sale/order rows minus SUM(returns_kes) for returns.
- Never select or expose customer phone or email.
- Always add a LIMIT (<= 200).
"""

_CHAT_FORBIDDEN_SQL = _chat_re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|"
    r"comment|copy|call|merge|vacuum|analyze|reindex|cluster|refresh|lock|"
    r"listen|notify|into|begin|commit|rollback|savepoint|prepare|execute|"
    r"deallocate)\b",
    _chat_re.IGNORECASE,
)
_CHAT_PII_SQL = _chat_re.compile(r"\b(phone|email|mobile|msisdn|telephone)\b", _chat_re.IGNORECASE)


def _chat_llm(messages, max_tokens=_CHAT_MAX_TOKENS):
    base = os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
    key = os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")
    if not base or not key:
        raise RuntimeError("AI assistant not configured")
    resp = _chat_requests.post(
        base.rstrip("/") + "/chat/completions",
        json={"model": _CHAT_MODEL, "messages": messages, "max_completion_tokens": max_tokens},
        headers={"Authorization": "Bearer " + key},
        timeout=90,
    )
    resp.raise_for_status()
    return (resp.json()["choices"][0]["message"].get("content") or "").strip()


def _chat_extract_json(text):
    try:
        return _chat_json.loads(text)
    except Exception:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return _chat_json.loads(text[start:end + 1])
        except Exception:
            return None
    return None


def _chat_clean_sql(sql):
    s = (sql or "").strip()
    if s.startswith("```"):
        s = _chat_re.sub(r"^```[a-zA-Z]*", "", s).strip()
        if s.endswith("```"):
            s = s[:-3].strip()
    return s.rstrip().rstrip(";").strip()


def _chat_is_safe_select(sql):
    if not sql:
        return False, "empty"
    if ";" in sql:
        return False, "multiple statements"
    low = sql.lstrip().lower()
    if not (low.startswith("select") or low.startswith("with")):
        return False, "not a select"
    if _CHAT_FORBIDDEN_SQL.search(sql):
        return False, "disallowed keyword"
    return True, None


def _chat_run_readonly_sql(sql, limit=_CHAT_ROW_LIMIT):
    conn = psycopg2.connect(
        os.environ["DATABASE_URL"],
        options=("-c standard_conforming_strings=on "
                 "-c default_transaction_read_only=on "
                 "-c statement_timeout=8000"),
    )
    try:
        conn.set_session(readonly=True, autocommit=False)
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql)
        rows = [dict(r) for r in cur.fetchmany(limit)]
        cur.close()
        conn.rollback()
        return rows
    finally:
        conn.close()


def _chat_context_line(ctx):
    parts = []
    df, dt = ctx.get("date_from"), ctx.get("date_to")
    if df or dt:
        parts.append("date range %s to %s" % (df or "?", dt or "?"))
    countries = ctx.get("countries")
    if countries:
        parts.append("countries: " + (", ".join(countries) if isinstance(countries, list) else str(countries)))
    locs = ctx.get("pos_locations")
    if locs:
        parts.append("stores: " + (", ".join(locs) if isinstance(locs, list) else str(locs)))
    if not parts:
        return ""
    return ("The user is viewing the dashboard with these filters applied: "
            + "; ".join(parts) + ". Apply them unless the user clearly asks otherwise.")


def _chat_core(message, session_id, ctx, revealed):
    with _CHAT_SESSIONS_LOCK:
        history = list(_CHAT_SESSIONS.get(session_id, []))

    ctx_line = _chat_context_line(ctx)
    plan_sys = (
        "You are the Vivo Fashion Group BI assistant, embedded in an executive "
        "retail analytics dashboard. Money is in Kenyan Shillings (KES). Decide "
        "whether the question needs data from the database.\n"
        + _CHAT_SCHEMA_DOC
        + "\nReply with ONLY a JSON object, no prose. Either "
        '{"action":"sql","sql":"<one SELECT statement>"} to fetch data, or '
        '{"action":"answer","answer":"<text>"} for greetings, metric definitions '
        "(e.g. what ABV means), or anything that needs no data."
        + (("\n" + ctx_line) if ctx_line else "")
    )
    plan_msgs = [{"role": "system", "content": plan_sys}]
    plan_msgs += history[-6:]
    plan_msgs.append({"role": "user", "content": message})

    try:
        plan = _chat_extract_json(_chat_llm(plan_msgs))
    except Exception:
        return "Sorry, I couldn't reach the assistant just now. Please try again in a moment."
    if not isinstance(plan, dict):
        return "I'm not sure how to answer that. Try asking about sales, customers, products, footfall or inventory."

    answer = None
    if plan.get("action") == "answer" and plan.get("answer"):
        answer = str(plan["answer"]).strip()
    elif plan.get("action") == "sql" and plan.get("sql"):
        sql = _chat_clean_sql(plan["sql"])
        ok, _why = _chat_is_safe_select(sql)
        if not ok:
            answer = "I can only run read-only data lookups and couldn't form a safe query for that. Could you rephrase?"
        elif _CHAT_PII_SQL.search(sql) and not revealed:
            answer = ("I can't return customer contact details (phone or email) here. "
                      "Use the Customers page, which has a secure reveal step.")
        else:
            rows = None
            try:
                rows = _chat_run_readonly_sql(sql)
            except Exception as e:
                # One self-correction attempt: hand the DB error back to the model.
                try:
                    fix_msgs = [
                        {"role": "system", "content": plan_sys},
                        {"role": "user", "content": message},
                        {"role": "assistant", "content": _chat_json.dumps({"action": "sql", "sql": sql})},
                        {"role": "user", "content": "That query failed with: "
                            + str(e)[:300] + ". Return corrected JSON with one fixed SELECT."},
                    ]
                    fixed = _chat_extract_json(_chat_llm(fix_msgs))
                    sql2 = _chat_clean_sql((fixed or {}).get("sql", ""))
                    ok2, _ = _chat_is_safe_select(sql2)
                    if ok2 and not (_CHAT_PII_SQL.search(sql2) and not revealed):
                        rows = _chat_run_readonly_sql(sql2)
                except Exception:
                    rows = None
            if rows is None:
                answer = "I tried to look that up but the query failed. Could you rephrase or be more specific?"
            else:
                sample = _chat_json.dumps(rows[:_CHAT_SUMMARY_ROWS], default=str)
                sum_sys = (
                    "You are the Vivo Fashion Group BI assistant. Summarize the query "
                    "result for a retail executive in clear, concise PLAIN TEXT (no "
                    "markdown, no tables, no code fences). Money is KES — format like "
                    "'KES 1,234,567'. Lead with the direct answer, then up to three "
                    "supporting points. If there are no rows, say no data matched the request."
                )
                try:
                    answer = _chat_llm([
                        {"role": "system", "content": sum_sys},
                        {"role": "user", "content": "Question: " + message
                            + "\n\nRows returned (" + str(len(rows)) + "): " + sample},
                    ]).strip()
                except Exception:
                    answer = "I fetched the data but couldn't summarize it. Please try again."

    if not answer:
        answer = "I'm not sure how to answer that. Try asking about sales, customers, products, footfall or inventory."

    with _CHAT_SESSIONS_LOCK:
        h = _CHAT_SESSIONS.get(session_id, [])
        h.append({"role": "user", "content": message})
        h.append({"role": "assistant", "content": answer})
        _CHAT_SESSIONS[session_id] = h[-_CHAT_MAX_TURNS * 2:]

    return answer


@app.post("/api/chat")
async def chat_post(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = (body.get("message") or "").strip()
    session_id = body.get("session_id") or _chat_uuid.uuid4().hex
    ctx = body.get("context") or {}

    if not message:
        return {"session_id": session_id,
                "answer": "Ask me about your sales, customers, products, footfall or inventory."}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {"session_id": session_id,
                "answer": "The assistant isn't configured yet. Please try again later."}

    revealed = pii_revealed(request)
    answer = await _chat_run_in_threadpool(_chat_core, message, session_id, ctx, revealed)
    return {"session_id": session_id, "answer": answer}
@app.post("/api/search/ask")
async def search_ask_post(request: Request):
    """Natural-language search — routes to the same LLM-backed assistant as
    /api/chat so the global-search "Ask" mode answers any dashboard question."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    query = (body.get("q") or body.get("message") or "").strip()
    base = {"intent": "assistant", "count": None, "link": None,
            "rows": [], "followups": []}
    if not query:
        return {**base,
                "answer": "Ask me anything about your sales, customers, products, footfall or inventory."}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {**base,
                "answer": "The assistant isn't configured yet. Please try again later."}

    revealed = pii_revealed(request)
    session_id = body.get("session_id") or _chat_uuid.uuid4().hex
    answer = await _chat_run_in_threadpool(
        _chat_core, query, session_id, body.get("context") or {}, revealed)
    return {**base, "answer": answer}


# ── Clerk Frontend-API reverse proxy (production only) ────────────────────────
# Mirrors the Node `clerkProxyMiddleware`: proxies the browser's Clerk
# Frontend-API calls through our own domain so Clerk works on .replit.app /
# custom domains without CNAME DNS. Inactive in development (Clerk proxying
# only works for production instances) and when no secret key is configured.
import requests
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response as _StarletteResponse

_CLERK_FAPI = "https://frontend-api.clerk.dev"
_CLERK_PROXY_PREFIX = "/api/__clerk"
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length",
}


def _clerk_proxy_enabled() -> bool:
    return (
        os.environ.get("REPLIT_DEPLOYMENT") == "1"
        and bool(os.environ.get("CLERK_SECRET_KEY"))
    )


@app.api_route(
    "/api/__clerk/{clerk_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def clerk_frontend_proxy(clerk_path: str, request: Request):
    if not _clerk_proxy_enabled():
        return JSONResponse({"detail": "Not found"}, status_code=404)
    target = f"{_CLERK_FAPI}/{clerk_path}"
    if request.url.query:
        target += f"?{request.url.query}"

    proto = request.headers.get("x-forwarded-proto", "https")
    fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    host = fwd_host.split(",")[0].strip()
    proxy_url = f"{proto}://{host}{_CLERK_PROXY_PREFIX}"

    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP and k.lower() not in ("host",)
    }
    fwd_headers["Clerk-Proxy-Url"] = proxy_url
    fwd_headers["Clerk-Secret-Key"] = os.environ["CLERK_SECRET_KEY"]
    # Restrict the upstream response to encodings the Python `requests`/urllib3
    # stack transparently decodes. Browsers advertise `br`/`zstd`, which
    # `requests` does NOT decompress — it would then hand us the raw compressed
    # bytes, and since we strip the `Content-Encoding` response header below
    # (it's hop-by-hop), the browser would receive compressed binary with no way
    # to decode it and try to parse it as JS. That manifests as
    # `Uncaught SyntaxError: Unexpected token '%' (at clerk.browser.js:1:2)` and
    # `Clerk: Failed to load Clerk JS`, leaving the app stuck on the auth-loading
    # screen in production (the proxy is dev-disabled, so dev never hits this).
    # gzip/deflate/identity are all decoded by `requests` into the plain bytes we
    # relay, so the browser always receives valid, uncompressed content.
    fwd_headers["Accept-Encoding"] = "gzip, deflate"
    xff = request.headers.get("x-forwarded-for")
    client_ip = (xff.split(",")[0].strip() if xff else None) or (
        request.client.host if request.client else None
    )
    if client_ip:
        fwd_headers["X-Forwarded-For"] = client_ip

    body = await request.body()

    def _do_request():
        return requests.request(
            request.method,
            target,
            headers=fwd_headers,
            data=body if body else None,
            timeout=20,
            allow_redirects=False,
        )

    upstream = await run_in_threadpool(_do_request)
    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    return _StarletteResponse(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
    )


from fastapi.staticfiles import StaticFiles
import pathlib

# Serve React build as static files
build_dir = pathlib.Path(__file__).parent / "dashboard" / "build"
if build_dir.exists():
    app.mount("/static", StaticFiles(directory=str(build_dir / "static")), name="static")

    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        from fastapi.responses import FileResponse
        from fastapi import Response
        index = build_dir / "index.html"
        response = FileResponse(str(index))
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
