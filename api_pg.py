from fastapi import FastAPI, Query, Request, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
import calendar
import logging
from collections import deque
from datetime import date, timedelta
import psycopg2
import psycopg2.extras
import os
import json
import time
import hashlib
import unicodedata
import hmac
import base64
import re
import secrets
import requests
from urllib.parse import urlencode, quote

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

log = logging.getLogger("api_pg")

# Slow-query telemetry: a ring buffer of the most recent slow queries (>2s),
# surfaced by GET /api/diagnostics/slow-queries. Anything over 5s is also written
# to sync_health_log with action_taken='slow_query' so it shows on the timeline.
SLOW_QUERY_WARN_SEC = 2.0
SLOW_QUERY_ERROR_SEC = 5.0
_slow_queries = deque(maxlen=20)

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

def _acquire_conn(timeout=5.0):
    """Get a pooled connection, waiting up to ``timeout`` seconds if the pool is
    momentarily exhausted. ThreadedConnectionPool.getconn() raises immediately
    when maxconn is reached, so we retry with a short backoff and surface a clean
    503 (rather than a 500) if the pool stays saturated past the deadline."""
    pool = _get_pool()
    deadline = time.time() + timeout
    while True:
        try:
            return pool, pool.getconn()
        except _pg_pool.PoolError:
            if time.time() >= deadline:
                raise HTTPException(
                    status_code=503,
                    detail={"error": "Service temporarily busy, please retry"})
            time.sleep(0.05)


def _record_slow_query(query, elapsed):
    preview = " ".join(query.split())[:200]
    entry = {"sql": preview, "duration_ms": round(elapsed * 1000, 1),
             "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _slow_queries.appendleft(entry)
    if elapsed >= SLOW_QUERY_ERROR_SEC:
        log.error("SLOW QUERY %.1fs: %s", elapsed, preview)
        try:
            with _users_tx() as cur:
                cur.execute(
                    "INSERT INTO sync_health_log "
                    "(checked_at, api_healthy, sync_healthy, action_taken, notes) "
                    "VALUES (now(), true, true, %s, %s)",
                    ("slow_query", f"{entry['duration_ms']}ms: {preview}"[:500]))
        except Exception:
            pass
    else:
        log.warning("SLOW QUERY %.1fs: %s", elapsed, preview)


def run_query(query, date_to=None):
    key = hashlib.md5(query.encode()).hexdigest()
    cached = cache_get(key)
    if cached is not None:
        return cached
    pool, conn = _acquire_conn()
    t0 = time.time()
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
    elapsed = time.time() - t0
    if elapsed >= SLOW_QUERY_WARN_SEC:
        _record_slow_query(query, elapsed)
    global _last_db_success_ts
    _last_db_success_ts = time.time()
    cache_set(key, rows, ttl=smart_ttl(date_to))
    return rows


_wb_last_attempt = 0.0
_wb_attempt_lock = threading.Lock()
_WB_ATTEMPT_THROTTLE_SEC = 300


def _warehouse_bins_refresh(force=False):
    """Trigger a best-effort BACKGROUND refresh of the warehouse_bins table. NEVER
    blocks the request (the Google fetch runs in a daemon thread) and NEVER raises.
    Throttled in-memory to at most once per _WB_ATTEMPT_THROTTLE_SEC; the real 1h
    staleness gate + a cross-thread lock live in warehouse_bins.refresh(). Called at
    the top of the Replenishment + IBT endpoints that surface warehouse bins.

    force=True bypasses BOTH the in-memory throttle and the staleness gate and
    re-fetches the WHOLE sheet now. Used once on startup so a freshly deployed
    prod (a separate DB whose bins may have been written by older, capped code)
    immediately gets the full current bin map instead of serving stale rows until
    the hourly gate lapses."""
    global _wb_last_attempt
    try:
        now = time.time()
        if not force:
            with _wb_attempt_lock:
                if now - _wb_last_attempt < _WB_ATTEMPT_THROTTLE_SEC:
                    return
                _wb_last_attempt = now
        else:
            with _wb_attempt_lock:
                _wb_last_attempt = now

        def _bg():
            try:
                import warehouse_bins
                pool = _get_pool()
                conn = pool.getconn()
                try:
                    if force:
                        warehouse_bins.refresh(conn, force=True)
                    else:
                        warehouse_bins.ensure_fresh(conn)
                finally:
                    pool.putconn(conn)
            except Exception as e:
                log.error("warehouse bins bg refresh failed: %s", e)

        threading.Thread(target=_bg, name="wh-bins-refresh", daemon=True).start()
    except Exception as e:
        log.error("warehouse bins refresh trigger failed: %s", e)


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

# Fabric BI routes
from fabric_router import fabric_router
app.include_router(fabric_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# Compress JSON responses larger than 1KB. The BI payloads (tables, multi-series
# charts) are highly compressible text, so this cuts transfer size sharply over
# slower links without measurable CPU cost on these read-only aggregates.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# ── Clerk auth gate ───────────────────────────────────────────────────────────
# Every /api/* request must carry a valid Clerk session whose verified email is
# on the company-domain allowlist (vivofashiongroup.com / shopzetu.com). The
# health root and the Clerk Frontend-API proxy are exempt. Verification is pure
# stdlib (see clerk_auth.py) — no SDK, because this env's u-root-cmds shadows
# coreutils and breaks the wheels' builds.
import clerk_auth
from fastapi.responses import JSONResponse, RedirectResponse, Response

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
# Business-friendly DEPARTMENT GROUPS (plus admin). Replaces the retired
# technical tiers (viewer/analyst/exec). See ROLE_PAGES in
# artifacts/vivo-bi/src/lib/permissions.js for the page mapping.
VALID_ROLES = (
    "product_development", "retail", "warehouse", "store_manager",
    "leadership", "customer_service", "marketing", "hr", "admin",
)
VALID_STATUSES = ("pending", "active", "rejected", "disabled")
# Lowest-access department a self-signup lands on while pending; an admin
# re-assigns the right group at approval time.
DEFAULT_NEW_ROLE = "store_manager"
# One-time idempotent migration of retired technical roles onto the new
# department groups so existing users aren't stranded after the change.
LEGACY_ROLE_MAP = {
    "viewer": "store_manager",
    "analyst": "leadership",
    "exec": "leadership",
    "manager": "leadership",
}

# ── Per-group page access (admin-editable) ────────────────────────────────────
# The group → allowed-page-ids map. This MUST mirror ROLE_PAGES in
# artifacts/vivo-bi/src/lib/permissions.js (the built-in default). An admin can
# override any group's list via /api/admin/group-pages; overrides are stored in
# app_config key 'role_pages'. When a group has no override we fall back to this
# default. The effective list is surfaced to the client as `allowed_pages` on
# /auth/me + login + status so the existing canAccessPage override path drives
# nav, Home tiles and route guarding with no client logic change.
def _dedup(seq):
    seen, out = set(), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


_VIEWER_PAGES = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "product-analysis", "customers", "customer-details", "catalogue", "gallery", "fabric"]
# NOTE: "finance" (the Finance Reports Suite) is a leadership + admin surface, so
# it lives in _LEADERSHIP_PAGES below (and therefore in ALL_PAGE_IDS, so admins
# can also grant it to other groups via Group Access). The server-side
# /api/finance gate independently restricts the API to leadership + admin.
_LEADERSHIP_PAGES = _dedup(_VIEWER_PAGES + ["exec-summary", "targets", "products", "product-analysis", "range-mgmt", "markdown-clearance", "margin", "rfm", "velocity", "size-health", "inventory", "warehouse-returns", "marketing", "social", "crm", "data-quality", "custom-report", "exports", "hr", "production", "production-report", "finance"])

DEFAULT_ROLE_PAGES = {
    "product_development": ["products", "product-analysis", "range-mgmt", "markdown-clearance", "catalogue", "gallery", "inventory", "size-health", "velocity", "data-quality", "fabric", "exports", "production", "production-report"],
    "retail": ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "customers", "products", "product-analysis", "gallery", "replenishments", "replenish-by-item", "warehouse-returns", "ibt", "exports"],
    "warehouse": ["inventory", "replenishments", "replenish-by-item", "warehouse-returns", "ibt", "re-order", "allocations", "data-quality", "exports"],
    "store_manager": ["locations", "footfall", "replenishments", "replenish-by-item", "warehouse-returns", "ibt"],
    "leadership": _LEADERSHIP_PAGES,
    "customer_service": ["customers", "customer-details", "crm", "footfall", "rfm"],
    "marketing": ["marketing", "social", "crm", "customers", "customer-details", "products", "product-analysis", "footfall", "trend-analysis", "rfm"],
    "hr": ["hr"],
}

# Admin management page ids (admin- prefix). These are route-guarded as
# adminOnly anyway and can NEVER be assigned to a non-admin group.
ADMIN_PAGE_IDS = ["admin-users", "admin-activity-logs", "admin-feedback", "admin-store-clusters", "admin-page-visibility", "admin-group-access"]

# The full catalog of valid page ids — every non-admin page that can appear in
# nav/Home plus the admin pages. Used to validate PUT payloads and to compute
# the admin (full-access) group. Built from the default group maps + a few pages
# that exist as routes/tiles but aren't in any default group.
ALL_PAGE_IDS = set(ADMIN_PAGE_IDS)
for _pages in DEFAULT_ROLE_PAGES.values():
    ALL_PAGE_IDS.update(_pages)
ALL_PAGE_IDS.update(["feedback"])  # available to admins / grantable to groups
# NOTE: "finance" (the Finance Reports Suite) IS included here via
# _LEADERSHIP_PAGES — it is a leadership + admin surface (default-granted to
# leadership, grantable to other groups via Group Access). The server-side
# /api/finance gate independently restricts the underlying API to leadership +
# admin, so a UI grant alone never leaks finance data to other roles.
# Paths a signed-in but not-yet-active user may still reach (so the frontend can
# read its own status and poll for approval / sign out).
_AUTH_SELF_PATHS = {
    "/api/auth/me", "/api/auth/me/status",
    "/api/auth/logout", "/api/auth/heartbeat",
}
# Paths reachable with no session at all: the login form, the Google OAuth
# initiator + callback, and the allowed-domains hint shown on the sign-in page.
_AUTH_PUBLIC_AUTH_PATHS = {
    "/api/auth/login",
    "/api/auth/google/login",
    "/api/auth/google/callback",
    "/api/auth/allowed-domains",
}

_USER_CACHE_TTL = 30  # seconds — bounds how long a role/status change lags
_user_cache = {}      # sub -> (record, ts)
_user_cache_lock = threading.Lock()

# Opaque session lifetime + a tiny lookup cache so a burst of requests on one
# token doesn't hammer the DB. Admin role/status mutations clear this cache so
# changes take effect immediately rather than lagging the TTL.
_SESSION_TTL = 7 * 24 * 3600   # 7 days
_SESSION_CACHE_TTL = 30        # seconds
_session_cache = {}            # token -> (user, ts)
_session_cache_lock = threading.Lock()


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
        # Pass params through as-is (None when absent). Passing an empty tuple
        # instead of None makes psycopg2 attempt %-interpolation, which raises
        # "IndexError: tuple index out of range" on any query containing a
        # literal % (e.g. the IBT late-count SQL) and no bind params.
        cur.execute(query, params)
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
    # Local email/password accounts store a PBKDF2 hash here; Google-only
    # identities leave it NULL (they authenticate via OAuth, never a password).
    _users_exec("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT")
    # Opaque server-side sessions. The token is the bearer/cookie value; we never
    # store anything derivable back to a password here.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            session_token TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at    TIMESTAMPTZ NOT NULL
        )
    """)
    _users_exec(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)")
    # Reap expired sessions on boot so the table cannot grow unbounded.
    try:
        _users_exec("DELETE FROM user_sessions WHERE expires_at <= now()")
    except Exception:
        pass


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
    # No row keyed by this exact identity. An account may already exist for this
    # email under a different identity key — e.g. an admin-created email/password
    # user (user_id "local:…") who now signs in with Google (sub "google:…"), or a
    # returning Google user. Match on the unique email so we recognize the existing
    # account instead of creating a duplicate. (A blind insert would also violate
    # the email UNIQUE constraint and error, since ON CONFLICT only covers user_id.)
    erows = _users_exec(
        "SELECT user_id, email, name, role, status FROM app_users WHERE email=%s",
        (email,), fetch=True) if email else None
    if erows:
        rec = erows[0]
        try:
            _users_exec(
                "UPDATE app_users SET last_login_at=now(), "
                "name=COALESCE(NULLIF(%s,''), name) WHERE user_id=%s",
                (name or "", rec["user_id"]))
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
    # Sessions are keyed by token (not user_id), so a targeted purge isn't cheap;
    # role/status changes are rare, so clear the whole session cache to guarantee
    # the change is reflected on the next request rather than lagging the TTL.
    with _session_cache_lock:
        _session_cache.clear()


# ── Password hashing (PBKDF2-SHA256, stdlib) ──────────────────────────────────
# We deliberately avoid passlib/bcrypt: their wheels fail to build in this env
# (u-root-cmds shadows coreutils). PBKDF2-SHA256 from hashlib is constant-time
# verified via hmac.compare_digest and is a sound password KDF at high iteration.
_PBKDF2_ITERS = 200_000


def _hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERS)
    return "pbkdf2_sha256$%d$%s$%s" % (
        _PBKDF2_ITERS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    )


def _verify_password(password, stored):
    if not stored:
        return False
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ── Opaque server-side sessions ───────────────────────────────────────────────
def _create_session(user_id):
    token = secrets.token_urlsafe(32)
    _users_exec(
        "INSERT INTO user_sessions (session_token, user_id, expires_at) "
        "VALUES (%s, %s, now() + make_interval(secs => %s))",
        (token, user_id, _SESSION_TTL))
    return token


def _destroy_session(token):
    if not token:
        return
    try:
        _users_exec("DELETE FROM user_sessions WHERE session_token=%s", (token,))
    except Exception:
        pass
    with _session_cache_lock:
        _session_cache.pop(token, None)


def _user_dict(row):
    return {
        "id": row["user_id"], "user_id": row["user_id"],
        "email": row["email"], "name": row["name"],
        "role": row["role"], "status": row["status"],
        "active": row["status"] == "active", "picture": None,
    }


def _user_for_session(token):
    """Resolve an active session token to a user dict (or None). Briefly cached."""
    if not token:
        return None
    now = time.time()
    with _session_cache_lock:
        cached = _session_cache.get(token)
        if cached and (now - cached[1]) < _SESSION_CACHE_TTL:
            return cached[0]
    rows = _users_exec(
        "SELECT u.user_id, u.email, u.name, u.role, u.status "
        "FROM user_sessions s JOIN app_users u ON u.user_id = s.user_id "
        "WHERE s.session_token=%s AND s.expires_at > now()",
        (token,), fetch=True)
    if not rows:
        return None
    user = _user_dict(rows[0])
    with _session_cache_lock:
        _session_cache[token] = (user, now)
    return user


def _extract_session_token(request):
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return request.cookies.get("session_token")


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
    # CORS preflight bypasses the gate.
    if request.method == "OPTIONS":
        return await call_next(request)

    # Reject any non-ISO date filter before it reaches a query string literal.
    # This SQL-injection guard runs for every /api request regardless of auth.
    for _k in _DATE_QUERY_PARAMS:
        _v = request.query_params.get(_k)
        if _v not in (None, "") and not _is_iso_date(_v):
            return JSONResponse(
                {"detail": f"Invalid {_k}: expected ISO date (YYYY-MM-DD)"},
                status_code=400,
            )

    # Health/proxy probes and the public auth paths (login + Google OAuth flow)
    # are reachable without a session.
    if path in _AUTH_PUBLIC_EXACT or path.startswith("/api/__clerk"):
        return await call_next(request)
    if path in _AUTH_PUBLIC_AUTH_PATHS:
        return await call_next(request)

    # Customer-facing loyalty endpoints carry their OWN member-token auth (a
    # loyalty card session, not a staff session) so members can enrol, check
    # their tier/points and redeem WITHOUT a staff login. They validate the
    # X-Member-Token header internally and fail closed with 401 when missing.
    if path.startswith("/api/loyalty"):
        return await call_next(request)

    # Customer-facing public lookbook share links (no login): a stylist sends a
    # shopper a tokenised lookbook URL; viewing it and registering interest must
    # work without any staff or member session. The handlers validate the
    # opaque share token internally and 404 on an unknown/expired token.
    if path.startswith("/api/public/"):
        return await call_next(request)

    # Resolve the session token (Bearer header or httpOnly cookie) to a user.
    # Fail closed: if the user store is unreachable we cannot prove identity, so
    # refuse with a deterministic 503 rather than leaking a generic 500.
    token = _extract_session_token(request)
    try:
        user = _user_for_session(token) if token else None
    except Exception:
        return JSONResponse(
            {"detail": "auth_store_unavailable"}, status_code=503)
    if not user:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    request.state.user = user

    status = user.get("status")
    # Self-service auth paths are reachable by any signed-in user regardless of
    # approval status (so the frontend can read its own status / sign out).
    if path in _AUTH_SELF_PATHS:
        return await call_next(request)

    # Approval gating: distinct refusals so the frontend can route correctly.
    if status == "pending":
        return JSONResponse({"detail": "account_pending_approval"}, status_code=403)
    if status == "rejected":
        return JSONResponse({"detail": "account_rejected"}, status_code=403)
    if status == "disabled":
        return JSONResponse({"detail": "account_disabled"}, status_code=403)
    if status != "active":
        return JSONResponse({"detail": "account_inactive"}, status_code=403)

    # Admin-only endpoints require the admin role.
    if path.startswith("/api/admin") and user.get("role") != "admin":
        return JSONResponse({"detail": "Admin access required"}, status_code=403)

    # CRM is a customer-facing surface (customer service / marketing / leadership
    # / admin). Enforce server-side so client-side nav/route hiding can never be
    # bypassed (e.g. direct API or mobile). Specific CRM mutations still apply
    # their own finer-grained checks (e.g. loyalty adjust / config require admin
    # via _crm_is_admin).
    if path.startswith("/api/crm") and user.get("role") not in (
        "customer_service", "marketing", "leadership", "admin"
    ):
        return JSONResponse({"detail": "CRM access requires a customer service, marketing, leadership or admin role"}, status_code=403)

    # Social (Facebook Page) management is a marketing action: publishing offers
    # and replying to customers. Marketing + leadership + admin only.
    if path.startswith("/api/social") and user.get("role") not in (
        "marketing", "leadership", "admin"
    ):
        return JSONResponse({"detail": "Social access requires a marketing, leadership or admin role"}, status_code=403)

    # Production Tracker (/api/production/*) is a work-in-progress board for the
    # product development team to move buying-order quantities through the
    # manufacturing stages. Product development + leadership + admin only;
    # enforced here so hidden web nav can't be bypassed via direct API.
    if path.startswith("/api/production") and user.get("role") not in (
        "product_development", "leadership", "admin"
    ):
        return JSONResponse({"detail": "Production tracker access requires a product development, leadership or admin role"}, status_code=403)

    # HR attendance dashboard (/api/hr/*) is a staff surface. Leadership + admin
    # get the executive/HR-manager view; store managers map to branch managers
    # (own-branch scope); retail gets a read view. Other departments have no HR
    # mandate and are blocked server-side so hidden web nav / mobile routes can't
    # be bypassed. Finer write/branch-scope checks live in hr_attendance.py.
    if path.startswith("/api/hr") and user.get("role") not in (
        "admin", "leadership", "store_manager", "retail", "hr"
    ):
        return JSONResponse({"detail": "HR dashboard access requires a staff role"}, status_code=403)

    # Finance Reports Suite (/api/finance/*) is a leadership + admin surface.
    # Enforced server-side so hidden web nav / direct API can't be bypassed by a
    # non-leadership role.
    if path.startswith("/api/finance") and user.get("role") not in ("admin", "leadership"):
        return JSONResponse({"detail": "Finance access requires a leadership or admin role"}, status_code=403)

    return await call_next(request)

@app.on_event("startup")
def _init_user_store():
    # Idempotently create the app_users table so role/approval state has a home.
    try:
        _ensure_users_table()
    except Exception:
        pass


@app.on_event("startup")
def _migrate_legacy_roles():
    # One-time idempotent migration: map retired technical roles
    # (viewer/analyst/exec/manager/hr) onto the new department groups so existing
    # users keep equivalent access. warehouse/store_manager/admin are unchanged.
    try:
        for old, new in LEGACY_ROLE_MAP.items():
            _users_exec("UPDATE app_users SET role=%s WHERE role=%s", (new, old))
    except Exception as e:
        log.error("Legacy role migration failed: %s", e)


@app.on_event("startup")
def _seed_admin():
    # Ensure there is always at least one admin who can sign in and approve
    # others. The seed credentials come from env; the email defaults to the
    # company admin address. Idempotent — re-running keeps the account in sync
    # with the env password so a known-good login always exists.
    email = (os.environ.get("SEED_ADMIN_EMAIL")
             or "admin@vivofashiongroup.com").strip().lower()
    password = os.environ.get("SEED_ADMIN_PASSWORD")
    try:
        # Defensive migration: any legacy row with a NULL status becomes active
        # so it isn't accidentally locked out by the new approval gate.
        _users_exec("UPDATE app_users SET status='active' WHERE status IS NULL")
    except Exception as e:
        log.error("Seed admin: status backfill failed: %s", e)
    if not password:
        log.info("Seed admin: SEED_ADMIN_PASSWORD not set; skipping admin seed "
                 "(set SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD to enable).")
        return
    try:
        ph = _hash_password(password)
        _users_exec("""
            INSERT INTO app_users (user_id, email, name, role, status,
                                   auth_method, password_hash, approved_at, approved_by)
            VALUES (%s, %s, %s, 'admin', 'active', 'password', %s, now(), 'system:seed')
            ON CONFLICT (email) DO UPDATE SET
                role='admin', status='active', auth_method='password',
                password_hash=EXCLUDED.password_hash
        """, ("seed:" + email, email, "Administrator", ph))
        _invalidate_user_cache()
        log.info("Seed admin ensured for %s", email)
    except Exception as e:
        log.error("Seed admin failed: %s", e)


@app.on_event("startup")
def _startup_health_check():
    # Verify DB connectivity + that every table the BI endpoints rely on exists.
    # Never crash on a missing table (the API still serves what it can — degraded
    # mode); just log a clear summary so deploys surface problems immediately.
    required = ["all_sales", "all_inventory", "all_products_clean", "pos_locations",
                "footfall", "currency_rates", "recommendation_actions",
                "ibt_completions", "allocation_runs"]
    db_ok = False
    present = 0
    try:
        pool = _get_pool()
        conn = pool.getconn()
        try:
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute("SELECT 1")
            db_ok = (cur.fetchone()[0] == 1)
            for t in required:
                cur.execute("SELECT to_regclass(%s)", (f"public.{t}",))
                if cur.fetchone()[0] is not None:
                    present += 1
                else:
                    log.error("Startup: required table missing: %s", t)
            cur.close()
        finally:
            pool.putconn(conn)
    except Exception as e:
        log.error("Startup health check failed: %s", e)
    healthy = db_ok and present == len(required)
    summary = ("Startup [%s] | DB connected: %s | Tables: %d/%d | Pool: %d-%d | "
               "Cache: ready") % ("OK" if healthy else "DEGRADED", db_ok, present,
                                  len(required), 2, MAX_DB_CONNECTIONS)
    (log.info if healthy else log.error)(summary)


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
    # Phase 7 hot-path coverage. Duplicates of pre-existing indexes (sale_date,
    # products.sku pkey, rec_actions (rec_type,rec_key) unique, sale_kind leading
    # col of idx_as_kind_date) are intentionally omitted to avoid redundant write
    # cost. CONCURRENTLY IF NOT EXISTS so production picks them up online.
    ("idx_all_sales_store_date",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_sales_store_date ON all_sales (store_id, sale_date)"),
    ("idx_all_sales_location_date",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_sales_location_date ON all_sales (pos_location_name, sale_date)"),
    ("idx_all_sales_sku",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_sales_sku ON all_sales (variant_sku)"),
    ("idx_all_sales_country_date",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_sales_country_date ON all_sales (country, sale_date)"),
    ("idx_all_inventory_sku",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_inventory_sku ON all_inventory (sku)"),
    ("idx_all_inventory_location",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_inventory_location ON all_inventory (pos_location_name)"),
    ("idx_all_inventory_country",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_inventory_country ON all_inventory (country)"),
    ("idx_all_products_style",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_products_style ON all_products_clean (style_name)"),
    ("idx_all_products_type",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_all_products_type ON all_products_clean (product_type)"),
    ("idx_rec_actions_status",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rec_actions_status ON recommendation_actions (status)"),
    ("idx_ibt_completions_style",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ibt_completions_style ON ibt_completions (style_name)"),
    ("idx_ibt_completions_stores",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ibt_completions_stores ON ibt_completions (from_store, to_store)"),
    ("idx_ibt_completions_date",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ibt_completions_date ON ibt_completions (transfer_date)"),
    ("idx_footfall_location_time",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_footfall_location_time ON footfall (pos_location_name, \"time\")"),
    ("idx_sync_health_checked",
     "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_health_checked ON sync_health_log (checked_at DESC)"),
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
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%gift voucher%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%voucher%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%on specific products%'
    AND LOWER(COALESCE(s.variant_sku,'')) NOT LIKE '%vb00%'
"""

# --- Footfall location-name canonicalisation -------------------------------
# The footfall sensor feed renamed every store on 2026-06-07 (e.g.
# "Vivo Junction" -> "VFGJUNCTION", "Vivo Sarit" -> "Sarit Centre"). The new
# spellings do NOT match all_sales.pos_location_name, so footfall->sales joins
# silently fail: orders fall to 0 for the renamed stores and conversion rate
# collapses (~1% instead of ~12%). The old names stop 2026-06-06 and the new
# names start 2026-06-07 with NO overlap, so folding the new spellings back to
# the canonical sales name is safe (it can never double-count a day). Keys are
# the footfall sensor spellings; values are the canonical all_sales name.
FOOTFALL_LOCATION_ALIASES = {
    "Vivo MoiAV": "Vivo Moi Avenue",
    "Sarit Centre": "Vivo Sarit",
    "VFGJUNCTION": "Vivo Junction",
    "Yaya Centre": "Vivo Yaya",
    "VIVO Mama Ngina": "Vivo Mama Ngina St",
    "VivoKisumu": "Vivo Kisumu",
    "VIVO Gardencity": "Vivo Garden City",
    "Two Rivers": "Vivo Two Rivers",
    "VIVO Capital": "Vivo Capital Centre",
    "VFGGALLERIAMALL": "Vivo Galleria",
    "VFGELDORET": "Vivo Eldoret",
    "VFGTHEHUB": "Vivo Hub",
    "VIVO Mombasa": "Vivo MSA Digo Road",
    "Vivo_MSA_DigoRD": "Vivo MSA Digo Road",
    "Acacia Mall": "Vivo Acacia",
    "VivoVillageMKT": "Vivo Village Market",
    "Vivo Runda Mall": "Vivo Runda",
    "Vivo Kigali ": "Vivo Kigali Heights",
    "VIVO MERU": "Vivo Meru",
    "VFGSIGNATURE": "Vivo Signature Mall",
    "KILELESHWA": "Vivo Kileleshwa",
    "VFG T-MALL": "Vivo T- Mall",
    " Oasis mall": "The Oasis Mall",
}

def ff_canon_sql(col="f.pos_location_name"):
    """Return a SQL expression that maps a footfall location column to its
    canonical all_sales name via FOOTFALL_LOCATION_ALIASES. Alias keys/values
    contain no single quotes, so static interpolation is injection-safe."""
    if not FOOTFALL_LOCATION_ALIASES:
        return col
    whens = " ".join(
        "WHEN '" + a.replace("'", "''") + "' THEN '" + c.replace("'", "''") + "'"
        for a, c in FOOTFALL_LOCATION_ALIASES.items()
    )
    return "CASE " + col + " " + whens + " ELSE " + col + " END"

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

# Canonical sku -> style map. all_inventory.style_name is free-text and often
# disagrees with all_products_clean.style_name (e.g. word-order differences like
# "Knee Length Tent" vs "Tent Knee Length"), which silently drops styles from any
# style_name-keyed stock join (stock resolves to 0, then a "soh > 0" filter
# removes the style entirely). all_inventory / all_sales carry NO barcode, but
# sku matches the product master for ~99.5% of inventory rows, so we resolve each
# inventory row's authoritative style via sku instead. DISTINCT ON keeps exactly
# one row per sku (active rows win) so the LEFT JOIN can never fan out the
# available SUM. Falls back to the raw inventory style_name for the ~0.5% of skus
# absent from the product master.
SKU_STYLE_MAP = (
    "(SELECT DISTINCT ON (sku) sku, style_name, style_number "
    "FROM all_products_clean "
    "WHERE style_name IS NOT NULL AND style_name <> '' AND sku IS NOT NULL "
    "ORDER BY sku, (active IS TRUE) DESC, style_number)"
)

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


# ── Roster editing permission ────────────────────────────────────────────────
# Saving the roster and triggering a redistribution is restricted to admins
# plus these named operators (the only people who own the picking plan).
_ROSTER_EDITOR_EMAILS = {
    "esthert@vivofashiongroup.com",
    "amos.kiliswa@vivofashiongroup.com",
}


def _can_manage_roster(user):
    """True iff the user may SAVE the roster and trigger a redistribution.

    Everyone signed-in can still VIEW the owner columns; only admins and the
    two named operators may change/redistribute them.
    """
    if not user:
        return False
    if (user.get("role") or "").strip().lower() == "admin":
        return True
    return (user.get("email") or "").strip().lower() in _ROSTER_EDITOR_EMAILS


# ── Store → owner assignment (the "redistribution") ──────────────────────────
# Each picker owns a CONTIGUOUS block of stores (POS sorted ascending). The
# assignment is persisted in app_config and is recomputed ONLY when an
# authorised user clicks "Save & redistribute" — report GETs just read the
# frozen map, so refreshing a page never reshuffles owners. New stores that
# appear after the last redistribute show as "—" until the next redistribute.
def _replen_store_universe():
    """Distinct selling stores (POS locations) eligible for replenishment,
    sorted ascending. Warehouses + online channels excluded."""
    try:
        rows = run_query(
            "SELECT DISTINCT s.pos_location_name AS store "
            "FROM all_sales s "
            "WHERE s.sale_kind IN ('sale','order') "
            "AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
            "AND s.pos_location_name NOT ILIKE '%%online%%' "
            "AND COALESCE(s.pos_location_name,'') <> '' "
            "AND " + BASE_FILTERS +
            " ORDER BY 1", date_to=date.today().isoformat())
    except Exception:
        rows = []
    return [r["store"] for r in (rows or []) if r.get("store")]


def _replen_store_unit_weights():
    """Per-store total replenishment UNITS (the same 'replenish' figure the pick
    list shows), used to balance pickers by units. Returns {store: units}.
    Best-effort: returns {} if the heavy report computation is unavailable."""
    try:
        rows = _compute_replenishment_report_rows(None, None, 400)
    except Exception:
        return {}
    weights = {}
    for r in (rows or []):
        loc = r.get("pos_location")
        if loc:
            weights[loc] = weights.get(loc, 0) + int(r.get("replenish") or 0)
    return weights


def _compute_store_owner_map(owners, stores=None, weights=None):
    """Assign each whole store to exactly ONE picker, balancing the TOTAL units
    per picker as evenly as possible (so each person picks roughly the same
    number of units). A store is never split across pickers. Returns {store: owner}.

    Balancing uses a greedy longest-processing-time heuristic: stores are taken
    heaviest-first and each is given to the picker who currently has the fewest
    units (ties broken by fewest stores, then roster order). Stores with no
    current need still get an owner (balanced by store count) so the next run
    that does need them already has a picker — nobody ever shows as '—'."""
    owners = [str(o).strip() for o in (owners or []) if str(o).strip()] \
        or list(_DEFAULT_REPLEN_OWNERS)
    if weights is None:
        weights = _replen_store_unit_weights()
    weights = weights or {}
    if stores is None:
        # Cover the full universe: every selling store PLUS any store that has
        # current replenishment need, so the frozen map never misses a store.
        universe = set(_replen_store_universe())
        universe |= set(weights.keys())
        stores = sorted(universe)
    n, k = len(stores), len(owners)
    if n == 0 or k == 0:
        return {}
    unit_load = {o: 0 for o in owners}
    count_load = {o: 0 for o in owners}
    order_index = {o: i for i, o in enumerate(owners)}
    # Heaviest stores first (LPT); deterministic tie-break by store name.
    ordered = sorted(stores, key=lambda s: (-int(weights.get(s, 0) or 0), s))
    mapping = {}
    for store in ordered:
        owner = min(
            owners,
            key=lambda o: (unit_load[o], count_load[o], order_index[o]))
        mapping[store] = owner
        unit_load[owner] += int(weights.get(store, 0) or 0)
        count_load[owner] += 1
    return mapping


def _owner_for_store(store, store_map, owners):
    """Resolve the picker for a store. Falls back to a STABLE deterministic
    pick (hash of the store name over the roster) when the store is missing
    from the frozen map — e.g. a store that started needing replenishment after
    the last redistribute — so the pick list never shows an unassigned '—'
    owner. The fallback is stable across refreshes (no reshuffle)."""
    if not store:
        return "—"
    owner = store_map.get(store)
    if owner:
        return owner
    owners = [str(o).strip() for o in (owners or []) if str(o).strip()] \
        or list(_DEFAULT_REPLEN_OWNERS)
    if not owners:
        return "—"
    h = int(hashlib.md5(str(store).encode("utf-8")).hexdigest(), 16)
    return owners[h % len(owners)]


def _assign_replen_owners_by_units(rows, owners):
    """Distribute the pick-list rows across the roster so each picker gets as
    close to EQUAL UNITS as possible. Rows are first ordered by POS location
    (then a stable SKU/barcode key) so every store's lines stay contiguous; a
    store is split between two pickers ONLY when the equal-units boundary lands
    inside it — i.e. one POS may be shared by more than one individual. Mutates
    each row in place (sets r['owner']) and returns the (now POS-sorted) rows.

    Nobody ever shows as '—': every row gets a real picker from the roster."""
    owners = [str(o).strip() for o in (owners or []) if str(o).strip()] \
        or list(_DEFAULT_REPLEN_OWNERS)
    if not rows:
        return rows
    # Group each store's lines together; sku/barcode keep ordering deterministic.
    rows.sort(key=lambda r: (str(r.get("pos_location") or ""),
                             str(r.get("sku") or ""),
                             str(r.get("barcode") or "")))
    k = len(owners)
    if k <= 1:
        for r in rows:
            r["owner"] = owners[0]
        return rows
    total = sum(int(r.get("replenish") or 0) for r in rows)
    if total <= 0:
        for i, r in enumerate(rows):
            r["owner"] = owners[i % k]
        return rows
    target = total / k          # ideal units per picker
    acc = 0                     # units assigned so far (including current row)
    owner_idx = 0
    for r in rows:
        r["owner"] = owners[owner_idx]
        acc += int(r.get("replenish") or 0)
        # Advance once this picker has met their cumulative share, always
        # leaving at least one picker for the remaining rows.
        while owner_idx < k - 1 and acc >= target * (owner_idx + 1):
            owner_idx += 1
    return rows


def _set_replen_store_owner_map(mapping):
    _users_exec(
        "INSERT INTO app_config (key, value, updated_at) "
        "VALUES ('replenishment_store_owner_map', %s::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (json.dumps(mapping),))


def _replen_store_owner_map(bootstrap=True):
    """Persisted {store: owner} map. Read on every report GET so a refresh
    never changes owners. If it has never been set, seed it once (one-time
    bootstrap, NOT a per-refresh redistribution) so the columns aren't blank."""
    try:
        rows = _users_exec(
            "SELECT value FROM app_config WHERE key='replenishment_store_owner_map'",
            fetch=True)
    except Exception:
        rows = None
    val = rows[0].get("value") if rows else None
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except Exception:
            val = None
    if isinstance(val, dict) and val:
        return {str(k): str(v) for k, v in val.items()}
    if not bootstrap:
        return {}
    mapping = _compute_store_owner_map(_replen_owners())
    if mapping:
        try:
            _set_replen_store_owner_map(mapping)
        except Exception:
            pass
    return mapping


def _line_key(pos, sku):
    """Stable identity for a pick-list line = (store, sku). Used to FREEZE the
    per-line picker assignment so a page reload never reshuffles owners."""
    pos = str(pos or "").strip()
    sku = str(sku or "").strip()
    if not pos or not sku:
        return None
    return pos + "\u0001" + sku


def _set_replen_line_owner_map(mapping):
    """Persist the frozen {line_key: owner} pick-list assignment."""
    _users_exec(
        "INSERT INTO app_config (key, value, updated_at) "
        "VALUES ('replenishment_line_owner_map', %s::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (json.dumps(mapping),))


def _compute_line_owner_map(owners=None, date_from=None, date_to=None, limit=400):
    """Equal-units per-line assignment captured at redistribute time. Builds the
    current pick list, balances it by units (POS-ordered, a store split only when
    the equal-units boundary lands inside it), and returns {line_key: owner}.
    Best-effort: returns {} if the report cannot be built."""
    owners = owners if owners is not None else _replen_owners()
    try:
        rows = _compute_replenishment_report_rows(date_from, date_to, limit)
    except Exception:
        return {}
    _assign_replen_owners_by_units(rows, owners)
    mapping = {}
    for r in rows:
        k = _line_key(r.get("pos_location"), r.get("sku"))
        if k:
            mapping[k] = r.get("owner")
    return mapping


def _replen_line_owner_map(bootstrap=True):
    """Persisted {line_key: owner} map for the pick list. Read on every report
    GET so a refresh never reshuffles owners — the balance is recomputed ONLY by
    the explicit "Save & redistribute" action. Seeded once if never set."""
    try:
        rows = _users_exec(
            "SELECT value FROM app_config WHERE key='replenishment_line_owner_map'",
            fetch=True)
    except Exception:
        rows = None
    val = rows[0].get("value") if rows else None
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except Exception:
            val = None
    if isinstance(val, dict) and val:
        return {str(k): str(v) for k, v in val.items() if v}
    if not bootstrap:
        return {}
    mapping = _compute_line_owner_map()
    if mapping:
        try:
            _set_replen_line_owner_map(mapping)
        except Exception:
            pass
    return {str(k): str(v) for k, v in mapping.items() if v}


def _owner_for_line(pos, sku, line_map, owners, store_fallback=None):
    """Resolve the FROZEN picker for a pick-list line. A line added since the
    last redistribute (not in the frozen map) falls back to that store's main
    picker, else a STABLE deterministic pick (hash of the line key over the
    roster). The fallback is stable across reloads and never yields "—"."""
    owners = [str(o).strip() for o in (owners or []) if str(o).strip()] \
        or list(_DEFAULT_REPLEN_OWNERS)
    k = _line_key(pos, sku)
    if k:
        o = line_map.get(k)
        if o:
            return o
    if store_fallback:
        o = store_fallback.get(str(pos or "").strip())
        if o:
            return o
    if not owners:
        return "—"
    key = k or (str(pos or "") + "\u0001" + str(sku or ""))
    h = int(hashlib.md5(key.encode("utf-8")).hexdigest(), 16)
    return owners[h % len(owners)]


def _redistribute_replen_owners(owners=None, date_from=None, date_to=None):
    """The explicit redistribute action: recompute BOTH the store→owner map
    (sibling single-SKU / single-style surfaces) AND the per-line owner map (the
    pick list, balanced by EQUAL UNITS over the given window) and persist them.
    Called only from a gated trigger — the pick list reads the frozen line map on
    every load, so a reload never reshuffles a picker's lines."""
    owners = owners if owners is not None else _replen_owners()
    mapping = _compute_store_owner_map(owners)
    _set_replen_store_owner_map(mapping)
    try:
        _set_replen_line_owner_map(_compute_line_owner_map(owners, date_from, date_to))
    except Exception:
        pass
    return mapping


def _hidden_pages():
    """Globally hidden page IDs (admin-controlled, applies to ALL users).

    Stored in app_config key 'hidden_pages' as a JSON array of page ids that
    match the frontend nav/permission ids. Returns [] when unset/unreadable.
    """
    try:
        rows = _users_exec(
            "SELECT value FROM app_config WHERE key='hidden_pages'", fetch=True)
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
            return [str(p).strip() for p in val if str(p).strip()]
    return []


def _set_hidden_pages(pages):
    # Never allow hiding admin management pages — that would lock admins out of
    # the control used to unhide pages.
    clean = sorted({
        str(p).strip() for p in pages
        if str(p).strip() and not str(p).strip().startswith("admin-")
    })
    _users_exec(
        "INSERT INTO app_config (key, value, updated_at) "
        "VALUES ('hidden_pages', %s::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (json.dumps(clean),))
    return clean


def _role_page_overrides():
    """Admin-saved per-group page overrides, stored in app_config key
    'role_pages' as a JSON object {role: [page_ids]}. Returns {} when unset.
    Only known groups + sanitized page ids are returned."""
    try:
        rows = _users_exec(
            "SELECT value FROM app_config WHERE key='role_pages'", fetch=True)
    except Exception:
        rows = None
    if not rows:
        return {}
    val = rows[0].get("value")
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except Exception:
            val = None
    if not isinstance(val, dict):
        return {}
    out = {}
    for role, pages in val.items():
        if role in VALID_ROLES and role != "admin" and isinstance(pages, list):
            out[role] = sorted({
                str(p).strip() for p in pages
                if str(p).strip() in ALL_PAGE_IDS and not str(p).strip().startswith("admin-")
            })
    return out


def _save_role_page_overrides(mapping):
    _users_exec(
        "INSERT INTO app_config (key, value, updated_at) "
        "VALUES ('role_pages', %s::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        (json.dumps(mapping),))


def _default_pages_for_role(role):
    role = (role or DEFAULT_NEW_ROLE).lower()
    if role == "admin":
        # Admin always has full access — every page incl. admin management.
        return sorted(ALL_PAGE_IDS)
    return list(DEFAULT_ROLE_PAGES.get(role, DEFAULT_ROLE_PAGES[DEFAULT_NEW_ROLE]))


def _effective_pages_for_role(role):
    """The page ids a member of `role` may currently see — the admin override if
    one is saved, otherwise the built-in default. Admin always resolves to the
    full catalog regardless of any stored value (cannot be locked out)."""
    role = (role or DEFAULT_NEW_ROLE).lower()
    if role == "admin":
        return sorted(ALL_PAGE_IDS)
    ov = _role_page_overrides()
    if role in ov:
        return ov[role]
    return _default_pages_for_role(role)


def _set_role_pages(role, pages):
    """Persist an override for `role`. Strips admin- pages + unknown ids. Admin
    cannot be restricted. Returns the cleaned list that was saved."""
    role = (role or "").lower()
    if role not in VALID_ROLES:
        raise ValueError("Unknown group")
    if role == "admin":
        raise ValueError("The Admin group always has full access and cannot be restricted")
    clean = sorted({
        str(p).strip() for p in pages
        if str(p).strip() in ALL_PAGE_IDS and not str(p).strip().startswith("admin-")
    })
    ov = _role_page_overrides()
    ov[role] = clean
    _save_role_page_overrides(ov)
    return clean


def _reset_role_pages(role):
    """Drop a group's override so it reverts to the built-in default."""
    role = (role or "").lower()
    if role not in VALID_ROLES:
        raise ValueError("Unknown group")
    ov = _role_page_overrides()
    if role in ov:
        del ov[role]
        _save_role_page_overrides(ov)
    return _default_pages_for_role(role)


def _replen_marks():
    """All replenishment marks keyed by (pos_location, kind, value)."""
    rows = _users_exec(
        "SELECT rec_key, actual_units, transfer_ref FROM recommendation_actions "
        "WHERE rec_type='replenish' AND status='done'", fetch=True) or []
    marks = {}
    for r in rows:
        parts = (r["rec_key"] or "").split("|", 2)
        if len(parts) == 3:
            marks[(parts[0], parts[1], parts[2])] = {
                "replenished": True,
                "actual_units_replenished": int(r["actual_units"] or 0),
                "transfer_ref": r.get("transfer_ref") or "",
            }
    return marks


def _set_replen_mark(pos_location, kind, value, replenished, actual,
                     acted_by=None, transfer_ref=None):
    rec_key = f"{pos_location}|{kind}|{value}"
    if replenished:
        _users_exec(
            "INSERT INTO recommendation_actions "
            "(rec_type, rec_key, status, actual_units, acted_by, acted_at, transfer_ref) "
            "VALUES ('replenish', %s, 'done', %s, %s, now(), %s) "
            "ON CONFLICT (rec_type, rec_key) DO UPDATE SET "
            "status='done', actual_units=EXCLUDED.actual_units, "
            "acted_by=EXCLUDED.acted_by, acted_at=now(), "
            "transfer_ref=EXCLUDED.transfer_ref",
            (rec_key, actual, acted_by, (transfer_ref or None)))
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

# Manually-retired styles. This is a DURABLE, code-level list (not the in-memory
# _RANGE_OVERRIDES, and not the Odoo-sourced all_products_clean.active flag which
# is overwritten on every product sync) so it survives API restarts + data syncs
# and ships to the production deployment. A style on this list is force-treated as
# retired everywhere retirement is determined (range-mgmt classify + the product
# analysis active/retired toggle), overriding the automatic age/sales/SOR rules.
# Matching is whitespace-insensitive via _norm_style (handles stray/double spaces,
# NBSP, the "\u00ac\u2020" mojibake of NBSP, and CRLF) so source name variants
# still resolve to the catalog style_name.
def _norm_style(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s)).replace("\u00a0", " ").replace("\u00ac\u2020", " ")
    return re.sub(r"\s+", " ", s).strip().lower()

_MANUAL_RETIRED_STYLES = [
    "Safari 3/4 Sleeve Maxi Kimono With Headwrap",
    "Safari Anga Puffy Short Sleeve Tie Top",
    "Safari Anga Wide Shorts",
    "Safari Basic Ribbed Tank Top",
    "Safari Basic Shirt Tent Dress",
    "Safari Bush 3/4 Sleeve Top",
    "Safari Bush Asymmetrical Sweater Poncho",
    "Safari Bush Drawstring Shorts",
    "Safari Bush Drop Shoulder Long Sleeve Top",
    "Safari Bush Men's Long Sleeve T-shirt",
    "Safari Bush Sweatshirt",
    "Safari by Vivo Bush Drop Shoulder Long Sleeve Top",
    "Safari by Vivo Kamari Maxi Dress",
    "Safari by Vivo Kamari Wide Leg Pants",
    "Safari by Vivo Lira Panelled Camisole Top",
    "Safari by Vivo Lira Sleeveless Coat",
    "Safari By Vivo Mens Cotton Long Sleeve Shirt",
    "Safari By Vivo Mens Cotton Pants",
    "Safari By Vivo Mens Cotton Short Sleeve Shirt",
    "Safari By Vivo Mens Cotton Shorts",
    "Safari by Vivo Naledi Bubble Midi Dress",
    "Safari by Vivo Savannah Drawstring Shacket in Linen",
    "Safari by Vivo Savannah Midi Wrap Dress",
    "Safari by Vivo Sizani Strappy Tent Top",
    "Safari Chui 3/4 Sleeve A-Line Dress",
    "Safari Chui Cropped Jacket",
    "Safari Chui Heavy Shirt",
    "Safari Chui Jodhpur Pants",
    "Safari Chui Lined Jacket",
    "Safari Chui Placket Top",
    "Safari Hawi Cargo Pants",
    "Safari Haya 0ne Shoulder Asymmetrical Side Tie Top",
    "Safari Haya Drop Shoulder Side Tie Top",
    "Safari Haya High Low Dress",
    "Safari Haya Off Shoulder Maxi Dress",
    "Safari Haya Strappy Tie Back Maxi Dress",
    "Safari Huru Halter Sleeveless High Low Dress",
    "Safari Huru Short Sleeved Shirt Dress",
    "Safari Kamari Capri Cargo Pants",
    "Safari Kamari Drop Shoulder Top",
    "Safari Kamari Front Slit Midi Skirt",
    "Safari Kamari Halter Shirt",
    "Safari Kamari Long Sleeve Drawstring Shacket",
    "Safari Kamari Mini Skirt",
    "Safari Kamari Ribbed Top",
    "Safari Kaya Long Sleeve Dolman Flounce Shirt Dress",
    "Safari Kaya Sleeveless Tent Shirt Dress",
    "Safari Kikoy 3/4 Sleeve Shirt",
    "Safari Kikoy Cullotes",
    "Safari Kikoy Joggers",
    "Safari Kikoy Long Sleeve Shacket",
    "Safari Kikoy Long Sleeved Shirt Dress",
    "Safari Kikoy Off Shoulder Crop Top",
    "Safari Kikoy Tunic High Low Top",
    "Safari Kikoy Tunic High Low Top With Side Slits",
    "Safari Kikoy Wide Elastic Shorts",
    "Safari Kikoy Wide Leg Pants",
    "Safari Kikoy Wide Leg Pants -Black",
    "Safari Kikoy Wrap Dress",
    "Safari Kitenge 3/4 sleeve Maxi Dress",
    "Safari Kitenge Men's Sweat Pants",
    "Safari Kitenge Men's Sweatshirt",
    "Safari Kitenge Side Frill Kaftan",
    "Safari Kitenge T-Shirt",
    "Safari Lira Criss",
    "Safari Lira Drawstring Jacket",
    "Safari Lira Drop Shoulder Dress",
    "Safari Lira Front Panelled Shirt Dress",
    "Safari Lira Sleeveless Coat",
    "Safari Mali 3/4 Bishop Sleeve Tie Top",
    "Safari Mali 3/4 Sleeve Tie Shirt",
    "Safari Mali Bishop Sleeve Shirt Dress",
    "Safari Mali Bishop Sleeve Tent Dress",
    "Safari Mali Gathered Flounce Sleeve Shirt Dress",
    "Safari Mali Gathered Flounce Sleeve Tent Dress",
    "Safari Mali Off",
    "Safari Mali Off Shoulder Ruffle Top",
    "Safari Mali Turn Up Hem Pants",
    "Safari Mali Wrap Lapel Top",
    "Safari Mansi Bishop Sleeve Shacket",
    "Safari Mansi Dolman Top",
    "Safari Mansi Kick Pleat A-Line Skirt",
    "Safari Mansi Mens Shorts",
    "Safari Mansi Mens Summer Shirt",
    "Safari Mansi Straight Leg Pants",
    "Safari Mara 3/4 Sleeve Flounce Tunic Top",
    "Safari Mara Cape Top",
    "Safari Mara Shirred Bishop Sleeve Dress",
    "Safari Mara Wide Bishop Sleeve Top",
    "Safari Men's Bomber Jacket",
    "Safari Men's Cargo Pants",
    "Safari Men's Chinese Collar Long Sleeve Shirt",
    "Safari Men's Kitenge Drawstring Shorts",
    "Safari Men's Long Sleeve Shirt",
    "Safari Men's Long Sleeve T-shirt",
    "Safari Men's Shacket",
    "Safari Men's Short Sleeve Shirt",
    "Safari Naledi Gathered Panel Maxi Skirt",
    "Safari Nazari Coat Dress",
    "Safari Nazari Maxi Shirt Dress",
    "Safari Nazari Off Shoulder Top",
    "Safari Nimali 3/4 Sleeve Maxi Dress",
    "Safari Nimali Bubble Sleeve Top",
    "Safari Nimali High Low Tunic Top",
    "Safari Nimali Ruffle Sleeve Top",
    "Safari Njano Front Drawstring Tunic Top",
    "Safari Njano Front Tie Dress",
    "Safari Njano Joggers",
    "Safari Njano Men's Easy Fit Kitenge Pants",
    "Safari Njano Men's Easy Fit Pants",
    "Safari Njano Men's Knee Length Shorts",
    "Safari Njano Men's Short Sleeve Shirt",
    "Safari Njano Men's Straight Leg Pants",
    "Safari Njano Mens Bound Neck Shirt",
    "Safari Njano Tie Front Wide Top",
    "Safari Njano Wide Leg Pants",
    "Safari Reversible Shirt Jacket",
    "Safari Savannah Front Slit Midi Skirt",
    "Safari Savannah Kitenge Chinese Collar Shirt",
    "Safari Savannah Kitenge Midi Wrap Dress",
    "Safari Savannah Men's Drawstring Shorts (Tall)",
    "Safari Savannah Men's Half Placket Shirt",
    "Safari Savannah Men's Jacket",
    "Safari Savannah Men's Long Sleeve Shirt",
    "Safari Savannah Men's Short Sleeve Shirt",
    "Safari Savannah Men's Straight Leg Pants",
    "Safari Savannah Midi Wrap Dress",
    "Safari Savannah Wrap Top",
    "Safari Sizani 2 Way Wrap Top",
    "Safari Sizani Barrel Pants",
    "Safari Sizani Men's Kitenge Placket Shirt",
    "Safari Sizani Men's Kitenge Tuxedo Shirt",
    "Safari Sizani Strappy Tent Top",
    "Safari Solana Sleeveless Tiered Maxi Dress",
    "Safari Spaghetti Tank Top",
    "Safari Tafari Shorts",
    "Safari Tafari Wrap Top",
    "Safari Tara Bishop Sleeve Dress",
    "Safari Tawi 3/4 Sleeve Off Shoulder Maxi",
    "Safari Tawi A-Line Long Sleeve Shirt Dress",
    "Safari Tawi Flounce Tent Dress",
    "Safari Tawi Off Shoulder Knee Length Dress",
    "Safari Tawi Shirt Collar Bishop Sleeve Tiered Dress",
    "Safari Tie Back Maxi Dress",
    "Safari Tie Knee Length Dress",
    "Safari Tiwa Barell Pants",
    "Safari Tiwa Shirred Top",
    "Safari Zene Dolman Top",
    "Safari Zene Drop Shoulder Above Knee Dress",
    "Safari Zene Drop Shoulder Top",
    "Safari Zene High Low Shirt Dress",
    "Safari Zene Off Shoulder Dress",
    "Safari Zene Off Shoulder Top",
    "Safari Zene Tiered Above Knee Dress",
    "Shiv & Shikie X Safari Barrel Pants",
    "Shiv & Shikie X Safari Cargo Pants",
    "Shiv & Shikie X Safari Faux Collar Printed Shirt",
    "Shiv & Shikie X Safari Faux Collar Shirt",
    "Shiv & Shikie X Safari Printed Short Sleeve Shirt",
    "Shiv & Shikie X Safari Short Sleeve Shirt",
    "Vivo  X This Is Essential Short Unitard",
    "Vivo 2-Way Wrap Top",
    "Vivo 3/4 Sleeve J.O Jersey A-line Knee Length Dress",
    "Vivo Adama Poncho",
    "Vivo Adisa Cold Shoulder Kaftan",
    "Vivo Ajani Blouse",
    "Vivo Ajani Long Sleeve Top",
    "Vivo Ajani V-Neck Shift Dress",
    "Vivo Alani Boat Neck Maxi Dress",
    "Vivo Alani Boat Neck Midi Dress",
    "Vivo Alani Boat Neck Top",
    "Vivo Alani Palazzo Pants",
    "Vivo Alani Plaid Midi Dress",
    "Vivo Alek Halter Neck Maxi Dress",
    "Vivo Alek Hi-low Top",
    "Vivo Aleri Coat",
    "Vivo Aleri Trench Coat Dress",
    "Vivo Alika High Waist Pants",
    "Vivo Alika Layered Dress",
    "Vivo Alma Short Sleeve Mini Bodycon",
    "Vivo Alora 3/4 Sleeve Shift Dress",
    "Vivo Alora Long Sleeve Top",
    "Vivo Alora Pleated Pants",
    "Vivo Alora Round Neck Top",
    "Vivo Alora Shift Dress",
    "Vivo Amai Cape Top",
    "Vivo Amai Knee Length Dresses",
    "Vivo Amai Side Slit Pants",
    "Vivo Amara Asymmetric Top",
    "Vivo Amara Back Pleat Dress",
    "Vivo Amara Cap Sleeve Layered Dress",
    "Vivo Amara Cap Sleeve Layered Top",
    "Vivo Amara Sleeveless High Low Top",
    "Vivo Amara V-Neck Maxi Dress",
    "Vivo Analo Sleeveless Tie Kimono",
    "Vivo Analo Wide Hem Tent Dress",
    "Vivo Analo Wide Leg Pants",
    "Vivo Arafa V-Neck Bodycon",
    "Vivo Arafa Wrap Dress",
    "Vivo Arusha Wide Drop Shoulder Tunic Top",
    "Vivo Asika Kaftan Tunic",
    "Vivo Ava 3/4 Sleeve Kimono",
    "Vivo Ava Jumpsuit",
    "Vivo Ava Panelled Tunic Top",
    "Vivo Ava Pleated Wide Leg Pants",
    "Vivo Ava Shirt Collar Tunic Top",
    "Vivo Ava Tapered Pants",
    "Vivo Ayah 3/4 Sleeve Jumpsuit",
    "Vivo Ayah Kimono",
    "Vivo Ayah Satin Pants",
    "Vivo Ayah Shirred Cuff Loose Top",
    "Vivo Ayah Shirred Neck Tent Maxi Dress",
    "Vivo Ayana Wide Top",
    "Vivo Ayla Off-Shoulder Dress",
    "Vivo Ayla Off-Shoulder Jumpsuit",
    "Vivo Ayo Tent Dress",
    "Vivo Azawi 3/4 Sleeve Top",
    "Vivo Azawi Pencil Skirt",
    "Vivo Azawi Peplum Top",
    "Vivo Azawi Sleeveless Overcoat",
    "Vivo Basic 3/4 Sleeve A-Line Wrap Maxi Dress",
    "Vivo Basic 3/4 Sleeve Cowl Double Layered Bodycon",
    "Vivo Basic 3/4 Sleeve Escape A-Line Dress",
    "Vivo Basic 3/4 Sleeve Kim Bodycon Dress",
    "Vivo Basic 3/4 Sleeve Sheath Dress",
    "Vivo Basic 3/4 Sleeve Top",
    "Vivo Basic 3/4 Sleeved Bodysuit",
    "Vivo Basic Abby Loose Top",
    "Vivo Basic Angela Cowl Loose Top",
    "Vivo Basic Boundneck Puff Sleeve Top",
    "Vivo Basic Button Down Shirt",
    "Vivo Basic Cap Sleeved Leila Dress",
    "Vivo Basic Chiffon Dropped Shoulder Top",
    "Vivo Basic Cowl Jersey Top",
    "Vivo Basic Cuffed Dolman Jersey Dress",
    "Vivo Basic Dada Poncho",
    "Vivo Basic Destiny Chiffon Top",
    "Vivo Basic Dolman Maxi Dress",
    "Vivo Basic Double Layered High Cowl Bodycon",
    "Vivo Basic Double Layered Wrap Poncho (Without Fringe)",
    "Vivo Basic Drop Shoulder Dolman Dress",
    "Vivo Basic EW Loose Top",
    "Vivo Basic Faux Pocket Leisure Pants",
    "Vivo Basic Hooded Kimono",
    "Vivo Basic Imelda Top",
    "Vivo Basic Jeggings",
    "Vivo Basic Jersey Cascade Waterfall",
    "Vivo Basic Knee Length Shirt Dress",
    "Vivo Basic Leila Long Sleeve Asymmetrical Waterfall",
    "Vivo Basic Liv Chiffon Top",
    "Vivo Basic Long A-Line Maxi Dress",
    "Vivo Basic Long Lily Waterfall",
    "Vivo Basic Long Sleeve Cascade Waterfall",
    "Vivo Basic Long Sleeved Bishop Top",
    "Vivo Basic Long Sleeved Double Layered Bodycon",
    "Vivo Basic Long Sleeved Top",
    "Vivo Basic Maternity Leggings",
    "Vivo Basic May Jersey Waterfall",
    "Vivo Basic Midi Pencil Skirt",
    "Vivo Basic Mini Butterfly Waterfall",
    "Vivo Basic Nala Dolman Cowl Sweater Top",
    "Vivo Basic Nalia High Low Jersey Top",
    "Vivo Basic Nalia High-low Chiffon Top",
    "Vivo Basic Nalia Satin High Low Top",
    "Vivo Basic Neo Extra Long Lily Waterfall",
    "Vivo Basic Neo Sienna Waterfall",
    "Vivo Basic Neo Waterfall",
    "Vivo Basic Palazzo Pants",
    "Vivo Basic Puff Sleeved Bodycon",
    "Vivo Basic RT Sleeveless Bodysuit",
    "Vivo Basic Salma Maxi Boat Neck Dress",
    "Vivo Basic Short Lily Waterfall",
    "Vivo Basic Short May Jersey Waterfall",
    "Vivo Basic Side Twist Knee Length Dress",
    "Vivo Basic Sienna Jersey Top",
    "Vivo Basic Sleeveless Double Layered Bodycon",
    "Vivo Basic Sleeveless Extra Long Lily Waterfall",
    "Vivo Basic Sleeveless Leila Bodycon Dress",
    "Vivo Basic Sleeveless Long Lily Waterfall",
    "Vivo Basic Sleeveless Midi Jersey Waterfall",
    "Vivo Basic Sleeveless Overcoat",
    "Vivo Basic Sleeveless Sienna Waterfall",
    "Vivo Basic Spaghetti Strap Tank Top",
    "Vivo Basic Straight Maxi Dress",
    "Vivo Basic Straight Skirt",
    "Vivo Basic Strappy Cowl Top",
    "Vivo Basic Tsavo Scalloped Chiffon Top",
    "Vivo Basic Tulip Sweater",
    "Vivo Basic Turtleneck Poncho",
    "Vivo Basic V-neck Cap Sleeve Top",
    "Vivo Basic V-Neck Long Sleeve Top",
    "Vivo Basic Val Cap Sleeve Top",
    "Vivo Basic Wide High Loww Jersey Top",
    "Vivo Basic Wide Jersey Top",
    "Vivo Basic Wide Liv Chiffon Maxi",
    "Vivo Beali Baby Doll Dress",
    "Vivo Beali Blazer",
    "Vivo Beali Sarong Skirt",
    "Vivo Beali Shirred Midriff Top",
    "Vivo Beali Shorts",
    "Vivo Beali Two Way Wrap Top",
    "Vivo Beali Wide Leg Pants",
    "Vivo Beali Wrap Asymmetrical Midi Dress",
    "Vivo Beali Wrap Shirt Dress",
    "Vivo Binti High Low Poncho",
    "Vivo Bodysuit",
    "Vivo Cargo Pants",
    "Vivo Chari Basic Chiffon Bishop Sleeve Top (Double Layered)",
    "Vivo Chari Basic Pencil Skirt",
    "Vivo Chari Cap Sleeve Shift Dress",
    "Vivo Chari Straight Leg Pants",
    "Vivo Chari V-Neck Top",
    "Vivo Chari Wide Leg Pants",
    "Vivo Chela Basic Cap Sleeve Top",
    "Vivo Chela Scalloped Sleeveless Top",
    "Vivo Chesi V-Neck Dress",
    "Vivo Chesi V-neck Jumpsuit",
    "Vivo Chesi V-Neck Maxi Dress",
    "Vivo Chesi Wide Leg Pants",
    "Vivo Chiffon Shorts",
    "Vivo Chiffon Wide Kimono",
    "Vivo Cowl Camisole",
    "Vivo Cowl Sweater Top",
    "Vivo Culottes",
    "Vivo Dali Drawstring Shoulder Jumpsuit",
    "Vivo Dali Tie Kimono",
    "Vivo Diella 3/4 Sleeve A-Line Dress",
    "Vivo Diella Wide Leg Pants",
    "Vivo Dua Dolman Top",
    "Vivo Dua Long Bishop Sleeve Top",
    "Vivo Essentials Biker Shorts",
    "Vivo Essentials Bodycon",
    "Vivo Essentials Dolman Maxi Dress",
    "Vivo Essentials Drop Shoulder Tunic Top",
    "Vivo Essentials High Neck Midriff Top",
    "Vivo Essentials Jersey Top",
    "Vivo Essentials Sleeveless One Shoulder Crop Top",
    "Vivo Essentials Sleeveless Tent Maxi Waterfall",
    "Vivo Essentials Strappy Cold Shoulder Top",
    "Vivo Essentials Tank Top",
    "Vivo Extra Long May Jersey Waterfall",
    "Vivo Extra Wide Kaftan",
    "Vivo Fahari 3/4 Sleeve Shirred Shirt",
    "Vivo Fahari Cowl Drape Bodycon",
    "Vivo Fahari Drop Shoulder Cowl Top",
    "Vivo Fara Dolman Cuff Top",
    "Vivo Fara Off Shoulder Flounce Sleeve Jumpsuit",
    "Vivo Faraji Side Slit Leisure Pants",
    "Vivo Fasi Strapless Top",
    "Vivo Fimi Drop Shoulder Maxi Dress",
    "Vivo Fimi Strappy Jumpsuit",
    "Vivo Fitness Bikers",
    "Vivo Fitness Capri Leggings",
    "Vivo Fitness Leggings",
    "Vivo Fitness Shorts",
    "Vivo Fitness Spaghetti Strap Tank Top",
    "Vivo Full Length Kimono",
    "Vivo Golf Fly Front Shorts",
    "Vivo Golf Long Sleeved Zip Up Jacket",
    "Vivo Hadiya Flounce Sleeve Maxi",
    "Vivo Hadiya Tie Maxi Dress",
    "Vivo Halter Maxi With Lining",
    "Vivo Hamle Bias Twist Dress",
    "Vivo Hamle Drapped Front Bodycon",
    "Vivo Hamle Front Twist Bodysuit",
    "Vivo Hamle Side Twist Tie Top",
    "Vivo Hanabi High Low Top",
    "Vivo Hanabi Off",
    "Vivo Hari Flared Sleeve Tunic",
    "Vivo Hisi Dolman Knee Length Dress",
    "Vivo Hooded Kimono With Elastic Cuff",
    "Vivo Imara Puff Sleeve Sheath Dress",
    "Vivo Imara Sleeveless Front Tie Dress",
    "Vivo Isabi Cowl Top",
    "Vivo Issa Shawl Jersey Waterfall",
    "Vivo Jamila  Side Drape Top",
    "Vivo Jamila Dolman Drawstring Tunic Top",
    "Vivo Jamila Halter Neck Knee Length Dress",
    "Vivo Jamila Halter Neck Maxi Dress",
    "Vivo Jasiri Bishop Sleeve Layered Top",
    "Vivo Jasiri Bishop Sleeve Shift Dress",
    "Vivo Jema High Low Tent Dress",
    "Vivo Jema High Slit Maxi Kimono",
    "Vivo Jema Off Shoulder Tent Knee Length Dress",
    "Vivo Jersey Drop Shoulder Top",
    "Vivo Jira Capri Leggings",
    "Vivo Jira Front Overlap Midriff Top",
    "Vivo Jira Hooded Poncho",
    "Vivo Jira Lounge Pants",
    "Vivo Jira Sleeveless Waterfall",
    "Vivo Joggers",
    "Vivo Kala Gathered Front Top",
    "Vivo Kala Hooded Poncho",
    "Vivo Kala Long Sleeve Top",
    "Vivo Kala Loose Maxi Top",
    "Vivo Kala Maxi Dress",
    "Vivo Kala Palazzo Pants",
    "Vivo Kala Side Slit Hooded Maxi Dress",
    "Vivo Kala Slit Maxi Dress",
    "Vivo Kala Slit Poncho Top",
    "Vivo Kala Wide Leg Pants",
    "Vivo Kay Sheath Dress",
    "Vivo Kelemi 4.0 Frilled Wide Top",
    "Vivo Kelemi 4.0 Halter Maxi Dress",
    "Vivo Kelemi 4.0 Kimono",
    "Vivo Kelemi 4.0 Sleeveless Dress",
    "Vivo Kelemi A-Line Knee Length Dress",
    "Vivo Kelemi Crepe Wide Leg Pants",
    "Vivo Kelemi Flared Sleeve Kimono",
    "Vivo Kelemi Halter Maxi Dress",
    "Vivo Kelemi Hooded Kimono",
    "Vivo Kelemi Knee Length Kaftan",
    "Vivo Kelemi Layered Maxi Dress",
    "Vivo Kelemi Ruffle Sleeve Top",
    "Vivo Kelemi Satin Pants",
    "Vivo Kelemi Sleeveless Overcoat",
    "Vivo Kelemi Wide Leg Pants",
    "Vivo Kitenge Bubble Sleeve Tent Dress",
    "Vivo Kitenge Infinity Jumpsuit",
    "Vivo Kitenge Midi Kimono",
    "Vivo Kitenge Strappy Jumpsuit",
    "Vivo Kitenge Strappy Tie Back Top",
    "Vivo Kitenge Strappy Tiered Maxi Dress",
    "Vivo Kitenge Wide Leg Pants",
    "Vivo Kitenge Wrap Skirt",
    "Vivo Laika Long Sleeve Mandarin Top",
    "Vivo Laika Long Sleeve Tie Top",
    "Vivo Lamu 3/4 Sleeve Double Layered Bodycon",
    "Vivo Lani Satin High Low Dress",
    "Vivo Leggings",
    "Vivo Leila 3/4 Sleeve Tent Knee Length Dress",
    "Vivo Leila Asymmetrical Angel Sleeve Top",
    "Vivo Leila Cap Sleeve Tent Knee Length Dress",
    "Vivo Leila Hip Length Waterfall",
    "Vivo Leila Short Sleeve Bodycon",
    "Vivo Lena Slim Fit Pants",
    "Vivo Lena Slim Fit Pants in Pinstripe",
    "Vivo Lero Capri Leggings",
    "Vivo Lero Fitness Leggings",
    "Vivo Lero Wide Leg Pants",
    "Vivo Liora Shorts",
    "Vivo Liv Wide Crepe Top",
    "Vivo Long Sleeve Blazer",
    "Vivo Lulu Cotton Barrel Pants",
    "Vivo Lumi Cuffed Dolman Maxi Dress",
    "Vivo Lumi Drop Shoulder Maxi Dress",
    "Vivo Lumi Drop Shoulder Side Cowl Drape Dress",
    "Vivo Luna 3/4 Sleeve High Low Top",
    "Vivo Luna Single Tiered Strappy Maxi Dress",
    "Vivo Maisha Butterfly Waterfall",
    "Vivo Maisha Kimono & Pant Set",
    "Vivo Maisha Long Sleeve High Low Kimono",
    "Vivo Maisha Strappy Maxi Cover Up Dress",
    "Vivo Maisha Strappy Maxi Dress",
    "Vivo Malindi Loose Top",
    "Vivo Malindi Tunic Dress With Frills",
    "Vivo Mandla High Neck A-Line Dress",
    "Vivo Mandla Side Flap A-Line Dress",
    "Vivo Maua Sleeveless Tent Knee Length Dress",
    "Vivo Maxi Kimono",
    "Vivo Meli Bishop Sleeve Tie Top",
    "Vivo Meli Chiffon Pants",
    "Vivo Meli Halter Neck Dress",
    "Vivo Meli Puff Sleeve Shift Dress",
    "Vivo Meli Ruffle Sleeve Top",
    "Vivo Meli Satin Pants",
    "Vivo Meli Sleeveless Coat",
    "Vivo Merika Knee Length Wrap Dress",
    "Vivo Merika Midi Wrap Dress",
    "Vivo Mira Joggers",
    "Vivo Mira Midi Kimono (Petite)",
    "Vivo Mira Reversible Wrap Top",
    "Vivo Mira Straight Leg Pants",
    "Vivo Mira V-Neck Overlap Top",
    "Vivo Mistari 3/4 Sleeve V",
    "Vivo Mock Maxi Dress",
    "Vivo Must Have Shorts",
    "Vivo Must Have Shorts in Zena Print",
    "Vivo Nala Shift Dress",
    "Vivo Nala Shirt Dress",
    "Vivo Nalia Long Sleeve High Low Top",
    "Vivo Nasinka Ruffle Sleeve Jumpsuit",
    "Vivo Nasinka V-Neck Maxi Dress",
    "Vivo Naya Cigarette Pants",
    "Vivo Naya Flounce High Low Top",
    "Vivo Naya One Shoulder Flounce Jumpsuit",
    "Vivo Naya One Shoulder Flounce Satin Crop Top",
    "Vivo Naya One Shoulder Flounce Top",
    "Vivo Naya Strappy Midi Body-Con Dress",
    "Vivo Naya Wide Leg Pants",
    "Vivo Niari Boat Neck Dress",
    "Vivo Niari Shorts",
    "Vivo Niari Sleeveless Pleated Dress",
    "Vivo Niari straight leg Pants",
    "Vivo Nimali Satin Blouse",
    "Vivo Nimali Satin Flounce Kimono - Black",
    "Vivo Nimali Satin Halter Top",
    "Vivo Nimali Satin Joggers",
    "Vivo Nimali Satin Short Kimono",
    "Vivo Nimali Satin Shorts",
    "Vivo Nimali Satin Wide-Leg Pants",
    "Vivo Nimali Side Flounce Top",
    "Vivo Nkasi Asymmetrical Top",
    "Vivo Nkasi Bubble Sleeve Maxi Dress",
    "Vivo Nkasi Maxi Kimono",
    "Vivo Nkasi Wide Leg Pants",
    "Vivo Nkasi Wide Top",
    "Vivo Nuru Maxi Kimono",
    "Vivo Paji 3/4 Sleeve Shift Dress (Tall)",
    "Vivo Paji Dress Coat",
    "Vivo Paji Pencil Skirt",
    "Vivo Paji Trench Coat",
    "Vivo Pana Cascade Waterfall",
    "Vivo Pashmina Shawl",
    "Vivo Pelia Kimono",
    "Vivo Pendo Puff Sleeve Shift Dress",
    "Vivo Pesi Basic Long Sleeve Shirt",
    "Vivo Pesi Drop Shoulder Tent Dress",
    "Vivo Pesi Drop Shoulder Tunic",
    "Vivo Raha Satin Joggers",
    "Vivo Raha Waist Tie Top",
    "Vivo Rayon Jersey Slip Dress",
    "Vivo Reba Coat Dress",
    "Vivo Reba Dolman Dress",
    "Vivo Reba Tapered Shirt Dress",
    "Vivo Reba Tent Shirt Dress",
    "Vivo Rema Drawstring Pants",
    "Vivo Rema Drawstring Turtleneck",
    "Vivo Rema High Low Maxi Dress",
    "Vivo Rema Palazzo Pants",
    "Vivo Rema Waterfall",
    "Vivo Reversible Printed Poncho",
    "Vivo Ria A-Line Dress",
    "Vivo Ruwa Flounce Sleeve Knee Length Tent Dress",
    "Vivo Safa Drawstring Wide Top",
    "Vivo Safa Pallazo Pants",
    "Vivo Safa Slit Side Top",
    "Vivo Safiya Back Pleat Dress",
    "Vivo Safiya Dolman Top",
    "Vivo Safiya Gathered Shoulder Maxi Dress",
    "Vivo Saida Bishop Sleeve Top",
    "Vivo Saida Cigarrets Pants",
    "Vivo Saida Dress Coat",
    "Vivo Saida Long Sleeve Jacket",
    "Vivo Saida Ruffle Neck Sheath Dress",
    "Vivo Saida Sheath Dress",
    "Vivo Saida Sleeveless Top",
    "Vivo Saida Straight Leg Pants",
    "Vivo Sakari Cap Sleeve Drape Top",
    "Vivo Sakari V-Neck Drop Shoulder Top",
    "Vivo Samira Maxi Kimono",
    "Vivo Sana Asymmetrical Angel Sleeve Top",
    "Vivo Sana Cape Top",
    "Vivo Sana Long Sleeved Maxi cover-Up",
    "Vivo Sanali 0ff-Shoulder Knee Length Dress",
    "Vivo Sanali Kaftan Top",
    "Vivo Sanali Off-Shoulder Knee Length Dress",
    "Vivo Sanali Tent Knee Length Dress",
    "Vivo Sanali Trench Coat",
    "Vivo Sani Long Sleeve Ruffle Placket Shirt",
    "Vivo Sanyu Boat Neck Midriff Top",
    "Vivo Sanyu Bubble Off",
    "Vivo Sanyu Bubble Sleeve Tent Dress",
    "Vivo Sanyu Maxi Tent Dress",
    "Vivo Sanyu Overlap Maxi Cover Up Top",
    "Vivo Sanyu Pleated Pants",
    "Vivo Sanyu Shift Dress",
    "Vivo Sarabi Panelled V-Neck Kaftan",
    "Vivo Sarong Skirt",
    "Vivo Satin Drawstring Pants",
    "Vivo Satin High Low Top",
    "Vivo Sawari Long Sleeve V-Neck Midriff Top",
    "Vivo Selah Midi Skirt",
    "Vivo Selah Pallazo Pants",
    "Vivo Seli Maxi Skirt",
    "Vivo Seli Shorts",
    "Vivo Seli Strappy Tent Top",
    "Vivo Seli V-Neck Midi Dress",
    "Vivo Serwa Crepe Pants",
    "Vivo Serwa Tiered Maxi Skirt",
    "Vivo Shaa Drop Shoulder Knee Length Dress",
    "Vivo Short Kaftan",
    "Vivo Short Side Pleat Sweater",
    "Vivo Shorts",
    "Vivo Sia 3/4 Bishop Sleeve Shift Dress (Petite)",
    "Vivo Sia Leisure Pants",
    "Vivo Sierra Bishop Sleeve Top",
    "Vivo Sierra Bodycon",
    "Vivo Situ Off Shoulder Tie Dress",
    "Vivo Situ Off Shoulder Top",
    "Vivo Situ Ruffle Neck Jumpsuit",
    "Vivo Situ Ruffle Neck Maxi Dress",
    "Vivo Situ Ruffle Neck Top",
    "Vivo Situ Side Slit Midi Kimono",
    "Vivo Sleeveless Blazer",
    "Vivo Sleeveless Side Slit Midi Waterfall",
    "Vivo Sleeveless Sweater Bodycon",
    "Vivo Solei Shorts(without lining)",
    "Vivo Soleil Handkerchief Drape Wide Top",
    "Vivo Soleil Shorts",
    "Vivo Soleil Sleeveless Drape Jumpsuit",
    "Vivo Soleil Sleeveless Layered Knee Length Dress",
    "Vivo Soleil Sleeveless Layered Top",
    "Vivo Studio 2-piece in Mixed Media",
    "Vivo Studio Mini Pencil Skirt in Ponte",
    "Vivo Tahisa Straight Leg Pants",
    "Vivo Taji Straight Leg Pants",
    "Vivo Talek Lap",
    "Vivo Tana 3/4 Tulip Sleeve Overlap Maxi Top",
    "Vivo Tana Jersey Tulip Back Waterfall",
    "Vivo Tana Puff Sleeve A-Line Dress",
    "Vivo Tana Puff Sleeve Bodysuit",
    "Vivo Tana Scalloped V-Neck Top",
    "Vivo Tanda Handkerchief Drape Top",
    "Vivo Tande Boat Neck Dress",
    "Vivo Tande Camisole",
    "Vivo Tande Front Drape Skirt",
    "Vivo Tatari Dropped High Neck Top",
    "Vivo Tatari Dropped Shoulder Sheath Dress",
    "Vivo Tatari Knee Length Coat",
    "Vivo Tatari Panelled Sheath Dress",
    "Vivo Tatari Panelled Skirt",
    "Vivo Tatili 3/4 Sleeve A Line Dress",
    "Vivo Tatili 3/4 Sleeve Tent Dress",
    "Vivo Tatili Drop Shoulder Cowl Top",
    "Vivo Tatili Long Sleeve Short Jacket",
    "Vivo Tiered Shirt Dress",
    "Vivo Tolani Dress",
    "Vivo Trench Coat",
    "Vivo Tsavo Scalloped Hem Dress Top",
    "Vivo Tsavo Sleeveless Scalloped Hem Dress Top",
    "Vivo Tulia Travel Jumpsuit",
    "Vivo Vinna 3/4 Seeve A-Line Dress",
    "Vivo Vinna Escape A-Line Dress",
    "Vivo Vinna Knee Length Piped Skirt",
    "Vivo Vinna Slit Sleeve Top",
    "Vivo Waridi Sleeveless Overcoat",
    "Vivo Wena High Slit Maxi Shirt",
    "Vivo Wena Maxi Shirt Dress",
    "Vivo Wena Wrap Dress",
    "Vivo Wendy Top",
    "Vivo Wide Leg Chiffon Pants",
    "Vivo Wide Leg Pants With Short Lining",
    "Vivo Wila Cowl Poncho",
    "Vivo Wila Cowl Tunic",
    "Vivo Wila Dolman Top",
    "Vivo Wila Dolman Tunic",
    "Vivo Wila Turn Up Coat",
    "Vivo Wila Wide Leg Pants",
    "Vivo Wingu Long Sleeve Side Drape Tunic Top",
    "Vivo Wingu Puff Sleeve Knee Length Dress",
    "Vivo Wingu Puff Sleeve Maxi Dress",
    "Vivo X Essence Asha Wide Leg Pants With Short Lining",
    "Vivo X Essence Ruffle Neck Jumpsuit",
    "Vivo X Pinky Full Length Fitness Leggings",
    "Vivo X Pinky Long Sleeve Cross Back Fitness Playsuit",
    "Vivo X Pinky Long Sleeve Fitness Top",
    "Vivo X Pinky Sleeveless Cross Back Fitness Bra",
    "Vivo X Pinky Sleeveless Cross Back Fitness Tank Top",
    "Vivo X Pinky Sleeveless Crossback Fitness Midriff Top",
    "Vivo X This Is Essential Leggings",
    "Vivo X This Is Essential Long Sleeve Bodysuit",
    "Vivo X This Is Essential Midi Dress",
    "Vivo X This Is Essential One Shoulder Bodysuit",
    "Vivo X This Is Essential Raceback Bralette",
    "Vivo X This Is Essential Ruched Bodysuit",
    "Vivo X This Is Essential Scooped Neck Bralette",
    "Vivo X This Is Essential Short Sleeve Bodysuit",
    "Vivo X This Is Essential Sleeveless High Neck Bodysuit",
    "Vivo X This Is Essential Sleeveless Scooped Neck Bodysuit",
    "Vivo X This Is Essential Strappy Bodysuit",
    "Vivo X This Is Essentials Long Sleeve Crew Neck Bodysuit",
    "Vivo Yene Asymmetrical Cape Top",
    "Vivo Yene High Slit Tunic Top",
    "Vivo Yene Jumpsuit",
    "Vivo Yene Layered Midi Dress",
    "Vivo Yene Layered Top",
    "Vivo Yene One Shoulder Maxi Dress",
    "Vivo Yene One Soulder Kaftan",
    "Vivo Yene V Neck Slip Dress",
    "Vivo Yoga Wrap",
    "Vivo Yumi High Waist Pants",
    "Vivo Yumi Long Sleeve Shirt Dress",
    "Vivo Yumi Long Sleeve Tent Shirt Dress",
    "Vivo Yumi Off Shoulder Top",
    "Vivo Zahari Bishop Sleeve Top With Belt",
    "Vivo Zahari Drawstring Wide Leg Pants",
    "Vivo Zahari Drop Shoulder High Low Dress",
    "Vivo Zahari Puff Sleeve Tent Dress",
    "Vivo Zahari Shift Dress",
    "Vivo Zahari Straight Leg Pants",
    "Vivo Zanzi Side Cowl Maxi Dress",
    "Vivo Zanzi Wrap Circular Dress",
    "Vivo Zaria Long Sleeve Coat",
    "Vivo Zawadi Inverted Pleat Dress",
    "Vivo Zawadi Keyhole Dress",
    "Vivo Zena Bishop Panel Long Sleeve Round Neck Dress",
    "Vivo Zena Long Sleeve Mandarin Collar Shift Dress",
    "Vivo Zena Sleeveless Shawl Collar Overcoat",
    "Vivo Ziwa Long Sleeve Ruffle Midi Kimono",
    "Vivo Ziwa Ruffle Long Sleeve Shift Dress (Petite)",
    "Vivo Zuri Long Sleeved Blouse",
    "Zoya Aridi Cropped Jacket",
    "Zoya Aridi Leggings",
    "Zoya Aridi Mens Straight Leg Pants",
    "Zoya Aridi Unisex Shacket (Corduroy)",
    "Zoya Aridi Unisex Shacket (Flannel)",
    "Zoya Athleisure One Shoulder Crop Top",
    "Zoya Banda Bandeau Asymmetrical Crop Top",
    "Zoya Banda Crop Hoodie",
    "Zoya Banda Drop Shoulder Unisex Wide Jacket",
    "Zoya Banda Halter Neck Assymetrical Crop Top",
    "Zoya Banda High Slit Maxi Skirt",
    "Zoya Banda Lantern Pants",
    "Zoya Banda Men's Cargo Pants",
    "Zoya Banda Men's Wide Pants",
    "Zoya Banda Strappy Playsuit",
    "Zoya Banda Unisex Jorts",
    "Zoya Banda Unisex Letterman Jacket",
    "Zoya Banda Unisex Shacket",
    "Zoya Banda Waist Length Zipped Jacket",
    "Zoya Basic Bodycon",
    "Zoya Basic Crop Top",
    "Zoya Basic Full Length Leggings",
    "Zoya Basic Halter Tie Top",
    "Zoya Basic Jersey Bandeau",
    "Zoya Basic Leggings",
    "Zoya Basic Long Sleeve Bodycon",
    "Zoya Basic Long Sleeve Top",
    "Zoya Basic Racer Back Crop Top",
    "Zoya Basic Ribbed V-neck Short Sleeved Thong Bodysuit",
    "Zoya Basic Short Sleeve Crop Top",
    "Zoya Basic Sleeveless Bodysuit",
    "Zoya Basic Spaghetti Tank Top",
    "Zoya Basic Tank Top",
    "Zoya Basic Val Tank Top",
    "Zoya Brave Corduroy Booty Shorts",
    "Zoya Brave Satin Joggers (Regular)",
    "Zoya Brave Satin Joggers(Regular)",
    "Zoya Capri Leggings",
    "Zoya Chill Spaghetti Strap Tank Top",
    "Zoya Essentials Basic Mini Bodycon",
    "Zoya Essentials Mini Bodycon",
    "Zoya Fitness Bra Style # 2",
    "Zoya Fitness Shorts",
    "Zoya Halter Neck Fitness Top",
    "Zoya Kyro Cropped Shirt",
    "Zoya Kyro Pleated Mini Skirt",
    "Zoya Kyro Sleeveless Bodysuit",
    "Zoya Kyro Straight Leg Pants",
    "Zoya Kyro Strappy Vest",
    "Zoya Kyro Women's Oversized Blazer",
    "Zoya Long Sleeved Fitness Crop Top",
    "Zoya Luna Cargo Pants",
    "Zoya Luna Drape Tie Top",
    "Zoya Luna Drawstring Maxi Dress",
    "Zoya Luna Halter Neck Top",
    "Zoya Luna High Slit Dress",
    "Zoya Men's Cargo Pants",
    "Zoya Men's Round Neck T-shirt",
    "Zoya Naya One Shoulder Flounce Satin Crop Top",
    "Zoya Nia Cargo Overalls",
    "Zoya Nia Cargo Shorts",
    "Zoya Nia Crop Bomber Jacket",
    "Zoya Nia Crop Oversized Jacket",
    "Zoya Nia Long Sleeved Crop Shacket",
    "Zoya Nia Off Shoulder Knee Length Dress",
    "Zoya Nia Off Shoulder Puff Sleeve Top",
    "Zoya Nia Oversized Denim Shirt",
    "Zoya Nia Puff Sleeve Off Shoulder Romper",
    "Zoya Nia Wide Cargo Pants",
    "Zoya Nia Wide Leg Denim Pants",
    "Zoya Nia Wide Leg Shorts",
    "Zoya Party Cowl Bare Back Mini Dress",
    "Zoya Party Drawstring Hoodie",
    "Zoya Party Halter Crop Top",
    "Zoya Party Low V-Neck Bodysuit",
    "Zoya Party One Sleeved Side Cut Dress",
    "Zoya Party Sheer Pants",
    "Zoya Party Sleeveless Bodysuit",
    "Zoya Party Sleeveless Side Cut Midi Dress",
    "Zoya Party Strappy One Shoulder Midi Dress",
    "Zoya Party Tie Back Bodycon",
    "Zoya Party Turtle Neck Maxi Top",
    "Zoya Sadira Bell Bottom Pants",
    "Zoya Sadira Bell Bottom Unitard",
    "Zoya Sadira Cargo Shorts",
    "Zoya Sadira Halter Neck Vest",
    "Zoya Sadira Men's Long Sleeve  T Shirt",
    "Zoya Sadira Men's Polo T-Shirt",
    "Zoya Sadira Mens' Chino Pants",
    "Zoya Sadira Mens' Chino Shorts",
    "Zoya Sadira Midriff Polo T-Shirt",
    "Zoya Sadira Mini Bubble Dress",
    "Zoya Sadira Mini Cargo Skirt",
    "Zoya Sadira Ribbed Top",
    "Zoya Sadira Strappy Bodysuit",
    "Zoya Shani Cropped Tie Top",
    "Zoya Shani Kimono",
    "Zoya Shani Men's Drawstring Shorts",
    "Zoya Shani Men's Summer Shirt",
    "Zoya Shani Off Shoulder Crop Top",
    "Zoya Shani Pleated Pants",
    "Zoya Shani Pleated Shorts",
    "Zoya Shani Sarong Wrap",
    "Zoya Shani Satin Off Shoulder Crop Top",
    "Zoya Shani Scarf Top",
    "Zoya Sitawi A-line Mini Dress",
    "Zoya Sitawi Bodycon",
    "Zoya Sitawi Cropped Jacket",
    "Zoya Sitawi Round Neck Midriff Top",
    "Zoya Sitawi Shirt Blouse",
    "Zoya Sitawi Square Neck Bodysuit",
    "Zoya Taani Easy Fit Joggers",
    "Zoya Taani Maxi Dress",
    "Zoya Taani Midriff Hoodie",
    "Zoya Taani Mini Dress",
    "Zoya Taani Side Slit Hoodie",
    "Zoya Taani Sleeveless Midriff Top",
    "Zoya Taani Wide Joggers",
    "Zoya Temo Asymmetric Front Cut Crop Top",
    "Zoya Temo Bubble Mini Skirt",
    "Zoya Temo Crop T",
    "Zoya Temo Crop T- Shirt",
    "Zoya Temo Cropped Jacket",
    "Zoya Temo Men's Knee Length Shorts",
    "Zoya Temo Men's Patched Straight Leg Pants",
    "Zoya Temo Mens Camo Shirt",
    "Zoya Temo Mens Short Sleeve T-shirt",
    "Zoya Temo Mens Zipped  Overshirt",
    "Zoya Temo Parachute Pants",
    "Zoya Temo Pleated Skirt",
    "Zoya Temo Straight Leg Pants",
    "Zoya Vasha Biker Shorts",
    "Zoya Vasha Hooded Jacket",
    "Zoya Vasha Midriff Jacket",
    "Zoya Vasha Raglan Sleeve Playsuit",
    "Zoya Vasha Short Sleeve Mesh Top",
    "Zoya Vasha Sleeveless Turtleneck Mini Bodycon",
    "Zoya Vasha Sleeveless Turtleneck Top",
    "Zoya Vasha Track Pants",
    "Zoya Vasha Track Pants With Pockets",
    "Zoya X AM Full Length Fitness Tights",
    "Zoya X Metamorphisized 143 Cropped Bomber Jacket",
    "Zoya X Metamorphisized 143 Cropped Jacket",
    "Zoya X Metamorphisized 143 Detachable Pants",
    "Zoya X Metamorphisized 143 Oversized Bowling Shirt",
    "Zoya X Metamorphisized 143 Oversized Long Sleeve Shirt",
    "Zoya X Metamorphisized 143 Pleated Flannel Mini Skirt",
    "Zoya X Metamorphisized 143 Pleated Mini Skirt",
    "Zoya X Metamorphisized 143 Raglan Sleeve Crop Top",
    "Zoya X Metamorphisized 143 Raglan Sleeve Midriff Top",
    "Zoya X Metamorphisized 143 Workman's Jacket",
    "Zoya Yuni  Men's Fleece Sweat Pants",
    "Zoya Yuni Cargo Pants",
    "Zoya Yuni Contrast Stitch Cargo Pants",
    "Zoya Yuni Contrast Stitch Crop Jacket",
    "Zoya Yuni Contrast Stitch Mini Skirt",
    "Zoya Yuni Halter Dress",
    "Zoya Yuni Halter Midriff Top",
    "Zoya Yuni Halter Neck Tie Back Top",
    "Zoya Yuni Halter Tank Top",
    "Zoya Yuni High Slit Dress",
    "Zoya Yuni Men's Long Sleeve T-shirt",
    "Zoya Yuni Men's Sweatshirt",
    "Zoya Yuni Off Shoulder Bodysuit",
    "Zoya Yuni Off Shoulder Midriff Top",
    "Zoya Yuni Off shoulder Mini Dress",
    "Zoya Yuni One",
    "Zoya Yuni Oversized Shirt",
    "Zoya Yuni Raglan Sleeve Crop Jacket",
    "Zoya Yuni Short Sleeve Midriff Top",
    "Zoya Yuni Sleeveless Turtle Neck Maxi Top",
    "Zoya Yuni Strappy Midriff Top",
    "Zoya Yuni Tank Top",
    "Zoya Yuni Wide Leg Pants",
]
_RETIRED_STYLE_NORM = frozenset(_norm_style(s) for s in _MANUAL_RETIRED_STYLES)

# SQL `IN (...)` literal of the manually-retired style names (single quotes
# doubled) so the warehouse-return "retired" mode can force-include them even
# when they still have recent sales. Falls back to '' (matches nothing) when the
# list is empty.
_MANUAL_RETIRED_IN_SQL = (
    "'" + "','".join(s.replace("'", "''") for s in _MANUAL_RETIRED_STYLES) + "'"
    if _MANUAL_RETIRED_STYLES else "''"
)

# Rec types that the shared Transfer Tracking report + assign endpoints accept.
_TRANSFER_REC_TYPES = {"replenish", "warehouse_return"}

def _is_manually_retired(style_name):
    return _norm_style(style_name) in _RETIRED_STYLE_NORM

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

def _unified_first_purchase_ctes(out_cte="first_purchase", out_col="first_purchase_date"):
    # Returns three chained CTEs (must be the LEADING CTEs in a WITH clause, i.e.
    # immediately after `WITH `) that expose <out_cte>(customer_id, <out_col>):
    # the first-EVER purchase date per customer, computed over a UNIFIED customer
    # identity that bridges the 2026-03-20 Kenya system switch.
    #
    # Background: post-cutover Kenya tags sales with short 6-7 digit Odoo customer
    # ids (e.g. '109387'), a different namespace from the legacy 13-digit Shopify
    # ids (e.g. '2625069973600'). raw_odoo_customers.shopify_user_id links an Odoo
    # customer id to its legacy Shopify id, so we collapse an Odoo id to its linked
    # Shopify id (canonical key) and take MIN(sale_date) across BOTH. A returning
    # shopper whose history sits under the legacy id is then no longer mislabelled
    # "New" when they reappear under a fresh Odoo id. Odoo ids are <=6 digits and
    # Shopify ids are 13, so the id::text join can never false-bridge a legacy id.
    #
    # The final CTE re-maps the unified date back onto every RAW all_sales
    # customer_id, so callers keep joining on s.customer_id unchanged while the
    # date reflects the bridged identity. <out_col> is a DATE.
    return ("""
        _id_bridge AS (
            SELECT DISTINCT s.customer_id,
                COALESCE(oc.shopify_user_id::text, s.customer_id) AS canon_id
            FROM all_sales s
            LEFT JOIN raw_odoo_customers oc
                   ON oc.id::text = s.customer_id
                  AND oc.shopify_user_id IS NOT NULL
            WHERE s.sale_kind IN ('sale','order')
              AND s.customer_id IS NOT NULL
              AND s.customer_id NOT IN ('None','null','')
        ),
        _canon_fp AS (
            SELECT b.canon_id, MIN(s.sale_date::date) AS first_purchase_date
            FROM all_sales s
            JOIN _id_bridge b ON b.customer_id = s.customer_id
            WHERE s.sale_kind IN ('sale','order')
            GROUP BY b.canon_id
        ),
        """ + out_cte + """ AS (
            SELECT b.customer_id, f.first_purchase_date AS """ + out_col + """
            FROM _id_bridge b
            JOIN _canon_fp f ON f.canon_id = b.canon_id
        )""")

def _country_channel_filter(country=None, channel=None):
    # BASE_FILTERS + optional country/channel, but NO date range — used for the
    # fixed trailing-window (28d/56d) recency-weighted velocity (Phase 2 A6).
    parts = [BASE_FILTERS]
    if country:
        parts.append("s.country IN (" + csv_to_sql(country) + ")")
    if channel:
        parts.append("s.pos_location_name IN (" + csv_to_sql(channel) + ")")
    return " AND ".join(parts)


# ── Pre-aggregated sales rollups ──────────────────────────────────────────────
# Several BI pages (Customers, Range Management, Product Analysis) computed their
# headline figures by full-scanning all_sales (~1.6M rows) on every COLD request,
# costing 11–28s. The lifetime / trailing-window primitives behind those pages
# change slowly, are identical for every user, and do NOT depend on the date
# filter, so we MATERIALISE them into small rollup tables and read those instead,
# falling back to the live full-scan SQL whenever the rollup is missing or stale.
#
# Design notes / invariants:
#   * Schema is defined IN CODE (ensure-on-startup) so it auto-migrates with a
#     publish and never relies on a hand-made dev-only object (see memory
#     dev-only-db-objects-block-publish).
#   * Refresh is a server-side build-then-swap (compute into a stage table with NO
#     lock on the live rollup, then a fast TRUNCATE+copy swap) so the heavy
#     aggregate never blocks concurrent reads of the rollup.
#   * The refresh SQL reuses BASE_FILTERS / _unified_first_purchase_ctes directly
#     (same module) so it can never drift from the live read path.
#   * Production runs on a SEPARATE DB that never rebuilds, so the rollups
#     self-bootstrap from the incremental sync loop (build_sales_rollups.py) and
#     refresh hourly thereafter (windows are CURRENT_DATE-relative, so a daily
#     refresh is the floor; the freshness gate below rejects anything older).
#   * Per-customer rollups store ABSOLUTE first/last sale dates, so the churn
#     CURRENT_DATE arithmetic stays correct at read time regardless of rollup age;
#     the per-style window columns (30d/180d/…) are baked at refresh time, so the
#     freshness gate bounds their drift to one refresh interval.
ROLLUP_MAX_AGE_SEC = 25 * 3600   # rollups older than this → fall back to live
# Fixed key for the session advisory lock that serialises rollup refreshes (so a
# manual run and the hourly sync subprocess never collide on the <table>_stage
# tables). Arbitrary but stable; isolated from other advisory-lock keys.
_ROLLUP_REFRESH_LOCK_KEY = 778201

# A row of all_sales contributes to PA-style sales the same CASE expression for
# its signed KES value (sale/order add total_sales, returns subtract returns).
_PA_KES_CASE = ("CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes "
                "WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END")
_PA_GROSS_CASE = ("CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity "
                  "ELSE 0 END")


def _rollup_defs():
    """Return [(meta_name, table_name, select_sql)] for every rollup. The SELECT
    column order MUST match the CREATE TABLE column order in _ensure_rollup_tables
    (the swap does INSERT INTO <table> SELECT * FROM <stage>)."""
    cust_lifetime = """
        SELECT customer_id, MIN(sale_date::date), MAX(sale_date::date)
        FROM all_sales
        WHERE sale_kind IN ('sale','order') AND customer_id IS NOT NULL
          AND customer_id NOT IN ('None','null','')
        GROUP BY customer_id
    """
    cust_first_purchase = ("WITH " + _unified_first_purchase_ctes() +
        " SELECT customer_id, first_purchase_date FROM first_purchase")
    rm_style = """
        SELECT p.style_name, COALESCE(s.country,'') AS country,
            SUM(s.net_quantity) AS units_life,
            SUM(s.net_sales_kes::numeric) AS sales_life,
            SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days') AS units_6m,
            SUM(s.net_sales_kes::numeric) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days') AS sales_6m,
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
          AND """ + BASE_FILTERS + """
        GROUP BY p.style_name, COALESCE(s.country,'')
    """
    pa_style = """
        SELECT p.style_name, COALESCE(s.country,'') AS country,
            COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days'),0) AS units_vel,
            SUM(s.net_quantity) AS units_life,
            COALESCE(SUM(""" + _PA_KES_CASE + """),0) AS sales_life,
            COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days'),0) AS units_6m,
            COALESCE(SUM(""" + _PA_KES_CASE + """) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days'),0) AS revenue_6m,
            COALESCE(SUM(""" + _PA_GROSS_CASE + """) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days'),0) AS gross_units_6m,
            COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days'),0) AS units_24m,
            COALESCE(SUM(""" + _PA_KES_CASE + """) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days'),0) AS revenue_24m,
            COALESCE(SUM(""" + _PA_GROSS_CASE + """) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days'),0) AS gross_units_24m,
            MAX(s.sale_date::date) AS last_sale,
            MIN(s.sale_date::date) FILTER (WHERE s.sale_kind IN ('sale','order')) AS first_sale,
            (array_agg(s.product_price_kes ORDER BY s.sale_date DESC) FILTER (
                WHERE s.sale_kind IN ('sale','order') AND s.product_price_kes IS NOT NULL
                  AND s.product_price_kes > 0))[1] AS current_price,
            MAX(s.sale_date::date) FILTER (
                WHERE s.sale_kind IN ('sale','order') AND s.product_price_kes IS NOT NULL
                  AND s.product_price_kes > 0) AS current_price_date
        FROM all_products_clean p JOIN all_sales s ON s.variant_sku = p.sku
        WHERE p.style_name IS NOT NULL AND p.style_name <> ''
          AND COALESCE(p.brand,'') NOT ILIKE '%third party%' AND """ + BASE_FILTERS + """
        GROUP BY p.style_name, COALESCE(s.country,'')
    """
    return [
        ("customer_lifetime",       "rollup_customer_lifetime",       cust_lifetime),
        ("customer_first_purchase", "rollup_customer_first_purchase", cust_first_purchase),
        ("rm_style",                "rollup_rm_style",                rm_style),
        ("pa_style",                "rollup_pa_style",                pa_style),
    ]


def _ensure_rollup_tables(conn):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS rollup_meta (
            name text PRIMARY KEY,
            refreshed_at timestamptz,
            row_count bigint
        );
        CREATE TABLE IF NOT EXISTS rollup_customer_lifetime (
            customer_id text PRIMARY KEY,
            first_sale date,
            last_sale date
        );
        CREATE TABLE IF NOT EXISTS rollup_customer_first_purchase (
            customer_id text PRIMARY KEY,
            first_purchase_date date
        );
        CREATE TABLE IF NOT EXISTS rollup_rm_style (
            style_name text,
            country text,
            units_life numeric, sales_life numeric,
            units_6m numeric, sales_6m numeric,
            units_30d numeric, units_14d numeric, units_prior_30d numeric,
            units_online numeric, units_stores numeric,
            last_sale date, first_sale date,
            PRIMARY KEY (style_name, country)
        );
        CREATE TABLE IF NOT EXISTS rollup_pa_style (
            style_name text,
            country text,
            units_vel numeric,
            units_life numeric, sales_life numeric,
            units_6m numeric, revenue_6m numeric, gross_units_6m numeric,
            units_24m numeric, revenue_24m numeric, gross_units_24m numeric,
            last_sale date, first_sale date,
            current_price numeric, current_price_date date,
            PRIMARY KEY (style_name, country)
        );
    """)
    conn.commit()
    cur.close()


def run_sales_rollup_refresh(only=None):
    """Rebuild the pre-aggregated rollup tables (build-then-swap per table). Safe
    to run repeatedly (idempotent full rebuild). Returns {name: row_count|error}.
    Used by the startup bootstrap and the incremental sync loop
    (build_sales_rollups.py)."""
    conn = get_conn()
    results = {}
    locked = False
    try:
        _ensure_rollup_tables(conn)
        # Serialise refreshes with a session advisory lock so a manual run and the
        # hourly sync-loop subprocess can never overlap and collide on the shared
        # <table>_stage tables (build-then-swap). try_lock so an overlapping caller
        # skips cleanly instead of blocking.
        lcur = conn.cursor()
        lcur.execute("SELECT pg_try_advisory_lock(%s)", (_ROLLUP_REFRESH_LOCK_KEY,))
        locked = bool(lcur.fetchone()[0])
        lcur.close()
        conn.commit()
        if not locked:
            log.info("Rollup refresh skipped — another refresh holds the lock")
            return {"skipped": "refresh already in progress"}
        for name, table, select_sql in _rollup_defs():
            if only and name not in only:
                continue
            stage = table + "_stage"
            try:
                cur = conn.cursor()
                cur.execute("DROP TABLE IF EXISTS " + stage)
                cur.execute("CREATE TABLE " + stage + " (LIKE " + table + " INCLUDING DEFAULTS)")
                cur.execute("INSERT INTO " + stage + " " + select_sql)
                cur.execute("TRUNCATE " + table)
                cur.execute("INSERT INTO " + table + " SELECT * FROM " + stage)
                cur.execute("DROP TABLE " + stage)
                cur.execute("SELECT COUNT(*) FROM " + table)
                n = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO rollup_meta (name, refreshed_at, row_count) "
                    "VALUES (%s, now(), %s) "
                    "ON CONFLICT (name) DO UPDATE SET refreshed_at = now(), "
                    "row_count = EXCLUDED.row_count", (name, n))
                conn.commit()
                cur.close()
                results[name] = n
            except Exception as e:
                conn.rollback()
                results[name] = "ERROR: " + str(e)
                log.error("Rollup refresh failed for %s: %s", name, e)
    finally:
        if locked:
            try:
                ucur = conn.cursor()
                ucur.execute("SELECT pg_advisory_unlock(%s)", (_ROLLUP_REFRESH_LOCK_KEY,))
                ucur.close()
                conn.commit()
            except Exception:
                pass
        conn.close()
    return results


@app.on_event("startup")
def _init_rollup_tables():
    # Ensure the schema exists on boot (fresh prod DB gets empty tables; reads
    # fall back to live until the sync loop's first refresh populates them).
    try:
        conn = get_conn()
        try:
            _ensure_rollup_tables(conn)
        finally:
            conn.close()
    except Exception as e:
        log.error("Rollup table init failed: %s", e)


def _rollup_fresh(name):
    """True iff the named rollup exists, is non-empty, and was refreshed within
    ROLLUP_MAX_AGE_SEC. Uncached (a tiny PK lookup) so a fresh refresh is adopted
    immediately and a stale one is rejected without a cache lag."""
    pool, conn = _acquire_conn()
    try:
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            "SELECT row_count, EXTRACT(EPOCH FROM (now() - refreshed_at)) "
            "FROM rollup_meta WHERE name = %s", (name,))
        r = cur.fetchone()
        cur.close()
    except Exception:
        pool.putconn(conn, close=True)
        return False
    else:
        pool.putconn(conn)
    if not r:
        return False
    row_count, age = r
    return bool(row_count and row_count > 0 and age is not None and age < ROLLUP_MAX_AGE_SEC)


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
    "country":      {"sales": "s.country",                          "inv": "i.country",            "pjoin": False, "label": "Country",       "group": "Geography"},
    "channel":      {"sales": "s.channel",                          "inv": None,                   "pjoin": False, "label": "Channel",       "group": "Geography"},
    "store":        {"sales": "s.pos_location_name",                "inv": "i.pos_location_name",  "pjoin": False, "label": "POS Location",  "group": "Geography"},
    "brand":        {"sales": "p.brand",                            "inv": "p.brand",              "pjoin": True,  "label": "Brand",         "group": "Product"},
    "category":     {"sales": "p.category",                         "inv": "p.category",           "pjoin": True,  "label": "Category",      "group": "Product"},
    "subcategory":  {"sales": "p.product_type",                     "inv": "p.product_type",       "pjoin": True,  "label": "Subcategory",   "group": "Product"},
    "style":        {"sales": "p.style_name",                       "inv": "p.style_name",         "pjoin": True,  "label": "Style",         "group": "Product"},
    "style_number": {"sales": "p.style_number",                     "inv": "p.style_number",       "pjoin": True,  "label": "Style Number",  "group": "Product"},
    "color":        {"sales": "p.color_print",                      "inv": "p.color_print",        "pjoin": True,  "label": "Colour",        "group": "Product"},
    "print":        {"sales": "p.print_plain",                      "inv": "p.print_plain",        "pjoin": True,  "label": "Print",         "group": "Product"},
    "size":         {"sales": "p.size",                             "inv": "i.size",               "pjoin": True,  "label": "Size",          "group": "Product"},
    "collection":   {"sales": "p.collection",                       "inv": "p.collection",         "pjoin": True,  "label": "Collection",    "group": "Product"},
    "season":       {"sales": "p.season",                           "inv": "p.season",             "pjoin": True,  "label": "Season",        "group": "Product"},
    "launch":       {"sales": "substring(p.style_launch_date,1,10)", "inv": "substring(p.style_launch_date,1,10)", "pjoin": True, "label": "Launch Date", "group": "Product"},
    "month":        {"sales": "to_char(s.sale_date::date,'YYYY-MM')", "inv": None,                 "pjoin": False, "label": "Month",         "group": "Time"},
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
    "price_min":    {"sql": "ROUND(MIN(CASE WHEN s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 THEN s.total_sales_kes::numeric / s.ordered_item_quantity END), 0)", "label": "Lowest Selling Price (KES)",  "group": "Sales"},
    "price_max":    {"sql": "ROUND(MAX(CASE WHEN s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 THEN s.total_sales_kes::numeric / s.ordered_item_quantity END), 0)", "label": "Highest Selling Price (KES)", "group": "Sales"},
}
# Inventory-grain measures. soh = current store stock on hand (SUM available,
# warehouse excluded — matches the SOR convention used by /subcategory-stock-sales).
# sor = sell-through % = units sold in period / (units sold + current stock).
_INVENTORY_MEASURES = {
    "soh": {"label": "Stock on Hand", "group": "Inventory"},
    "sor": {"label": "Sell-Through %", "group": "Inventory"},
}
# Lifetime ("since launch") measures ignore the report's date range — they total
# over ALL of a style's history (matching the Product Analysis page columns).
# units_since_launch = net units ever sold; sor_since_launch = lifetime
# sell-through (lifetime units / (lifetime units + current stock)). They are
# best paired with a product dimension (Style / Style Number); sor_since_launch
# needs the stock snapshot so it inherits the inventory dimension restriction.
_LIFETIME_MEASURES = {
    "units_since_launch":   {"label": "Units Sold (Since Launch)", "group": "Lifetime"},
    "revenue_since_launch": {"label": "Net Revenue (Since Launch, KES)", "group": "Lifetime"},
    "sor_since_launch":     {"label": "Sell-Through % (Since Launch)", "group": "Lifetime"},
}
# Velocity measures mirror the Product Analysis page: a recency-weighted weekly
# run-rate over the trailing 56 days (the most recent 28 days count double) and
# weeks-of-cover (current store stock / weekly velocity). These ignore the
# report's date range (they are a "current run-rate" snapshot relative to today),
# exactly like the Product Analysis columns. `woc` needs the stock snapshot so it
# inherits the inventory dimension restriction.
_VELOCITY_MEASURES = {
    "units_per_week": {"label": "Weekly Velocity (units)", "group": "Velocity"},
    "woc":            {"label": "Weeks of Cover", "group": "Velocity"},
}


def _report_field_catalog():
    dims = [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _REPORT_DIMENSIONS.items()]
    meas = [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _REPORT_MEASURES.items()]
    meas += [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _INVENTORY_MEASURES.items()]
    meas += [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _VELOCITY_MEASURES.items()]
    meas += [{"id": k, "label": v["label"], "group": v["group"]} for k, v in _LIFETIME_MEASURES.items()]
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
    all_measures = {**_REPORT_MEASURES, **_INVENTORY_MEASURES, **_VELOCITY_MEASURES, **_LIFETIME_MEASURES}
    bad = [d for d in dims if d not in _REPORT_DIMENSIONS] + [m for m in meas if m not in all_measures]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown field(s): {', '.join(bad)}")

    inv_meas = [m for m in meas if m in _INVENTORY_MEASURES]
    life_meas = [m for m in meas if m in _LIFETIME_MEASURES]
    vel_meas = [m for m in meas if m in _VELOCITY_MEASURES]
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

    if not inv_meas and not life_meas and not vel_meas:
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

    # ---- Multi-CTE path: a UNION "spine" of the distinct dimension-key combos,
    # with each measure source (period sales / lifetime sales / current stock)
    # LEFT JOINed back onto it. This generalises the old sales+stock FULL OUTER
    # JOIN so it can also carry the lifetime ("since launch") measures. ----
    needs_stock = bool(inv_meas) or ("sor_since_launch" in life_meas) or ("woc" in vel_meas)
    needs_life = bool(life_meas)
    needs_vel = bool(vel_meas)

    # Stock is a current snapshot with no channel / time dimension, so any
    # stock-dependent measure can't be grouped by those.
    if needs_stock:
        incompatible = [d for d in dims if _REPORT_DIMENSIONS[d]["inv"] is None]
        if incompatible:
            names = ", ".join(_REPORT_DIMENSIONS[d]["label"] for d in incompatible)
            raise HTTPException(
                status_code=400,
                detail=f"Stock on Hand / Sell-Through / Weeks of Cover can't be grouped by {names} "
                       "(inventory is a current snapshot with no channel or time). "
                       "Use Country, POS Location, Brand, Category, Subcategory, "
                       "Style, Style Number, Colour, Print, Size, Collection, Season or Launch Date.",
            )

    keys = [f"k{i}" for i in range(1, len(dims) + 1)]
    grp = ", ".join(str(i + 1) for i in range(len(dims)))
    sales_join = " LEFT JOIN all_products_clean p ON s.variant_sku = p.sku" if needs_pjoin else ""
    inv_join   = " LEFT JOIN all_products_clean p ON i.sku = p.sku" if needs_pjoin else ""
    where = build_filters(date_from, date_to, country, channel)
    sales_sel = [f'{_REPORT_DIMENSIONS[d]["sales"]} AS {keys[i]}' for i, d in enumerate(dims)]

    # Period sales CTE (alias `s`) — always present. Carries any period sales
    # measures plus __units so SOR stays computable even if Units wasn't picked.
    sales_measure_sql = {m: _REPORT_MEASURES[m]["sql"] for m in sales_meas}
    sales_measure_sql["__units"] = f"COALESCE({_UNITS}, 0)"
    sales_cte_measures = [f'{sql} AS "{name}"' for name, sql in sales_measure_sql.items()]
    sales_cte = ("SELECT " + ", ".join(sales_sel + sales_cte_measures) +
                 " FROM all_sales s" + sales_join + " WHERE " + where +
                 " GROUP BY " + grp)

    cte_defs = ["s AS (" + sales_cte + ")"]
    spine_sources = ["SELECT " + ", ".join(keys) + " FROM s"]

    if needs_life:
        # Lifetime sales — same grouping but NO date filter (i.e. since launch).
        life_parts = [BASE_FILTERS]
        if country:
            life_parts.append("s.country IN (" + csv_to_sql(country) + ")")
        if channel:
            life_parts.append("s.pos_location_name IN (" + csv_to_sql(channel) + ")")
        life_where = " AND ".join(life_parts)
        life_cte = ("SELECT " + ", ".join(sales_sel) +
                    ", COALESCE(SUM(s.net_quantity), 0) AS units_since_launch"
                    f", ROUND(COALESCE({_NET}, 0), 0) AS revenue_since_launch"
                    " FROM all_sales s" + sales_join + " WHERE " + life_where +
                    " GROUP BY " + grp)
        cte_defs.append("life AS (" + life_cte + ")")
        spine_sources.append("SELECT " + ", ".join(keys) + " FROM life")

    if needs_vel:
        # Weekly velocity mirrors the Product Analysis page's default: net units
        # (signed, returns included) over the trailing _VEL_DAYS days, divided by
        # that window in weeks — i.e. units_per_week = units_vel / (days/7). It is
        # a current run-rate snapshot so it ignores the report date range. No
        # sale_kind filter (net_quantity is already signed). sale_date is TEXT so
        # cast ::date.
        _VEL_DAYS = 30
        vel_parts = [BASE_FILTERS,
                     f"s.sale_date::date >= CURRENT_DATE - INTERVAL '{_VEL_DAYS} days'"]
        if country:
            vel_parts.append("s.country IN (" + csv_to_sql(country) + ")")
        if channel:
            vel_parts.append("s.pos_location_name IN (" + csv_to_sql(channel) + ")")
        vel_where = " AND ".join(vel_parts)
        weekly_sql = f"ROUND(COALESCE(SUM(s.net_quantity), 0) / ({_VEL_DAYS} / 7.0), 1)"
        vel_cte = ("SELECT " + ", ".join(sales_sel) +
                   ", " + weekly_sql + " AS weekly_units"
                   " FROM all_sales s" + sales_join + " WHERE " + vel_where +
                   " GROUP BY " + grp)
        cte_defs.append("vel AS (" + vel_cte + ")")
        spine_sources.append("SELECT " + ", ".join(keys) + " FROM vel")

    if needs_stock:
        inv_sel = [f'{_REPORT_DIMENSIONS[d]["inv"]} AS {keys[i]}' for i, d in enumerate(dims)]
        inv_cte = ("SELECT " + ", ".join(inv_sel) + ", SUM(i.available) AS soh"
                   " FROM all_inventory i" + inv_join +
                   " WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"
                   " AND i.available > 0 GROUP BY " + grp)
        cte_defs.append("stock AS (" + inv_cte + ")")
        spine_sources.append("SELECT " + ", ".join(keys) + " FROM stock")

    # Dimension spine: every distinct key combination across the sources, so a
    # style that only has stock (no period sales) or only lifetime sales still
    # appears. Postgres can't hash/merge-join on IS NOT DISTINCT FROM, so match
    # on a NULL-safe COALESCE sentinel ('' — real values are NULL, not '').
    cte_defs.append("spine AS (SELECT DISTINCT * FROM (" + " UNION ".join(spine_sources) + ") _u)")

    def _on(alias):
        return " AND ".join(
            f"COALESCE(sp.{k}::text,'') = COALESCE({alias}.{k}::text,'')" for k in keys)

    join_sql_parts = [" LEFT JOIN s ON " + _on("s")]
    if needs_life:
        join_sql_parts.append(" LEFT JOIN life ON " + _on("life"))
    if needs_vel:
        join_sql_parts.append(" LEFT JOIN vel ON " + _on("vel"))
    if needs_stock:
        join_sql_parts.append(" LEFT JOIN stock ON " + _on("stock"))

    out_parts = [f'sp.{keys[i]} AS "{d}"' for i, d in enumerate(dims)]
    for m in meas:
        if m == "soh":
            out_parts.append('COALESCE(stock.soh, 0) AS "soh"')
        elif m == "sor":
            out_parts.append('ROUND(COALESCE(s."__units",0)*100.0 / '
                             'NULLIF(COALESCE(s."__units",0)+COALESCE(stock.soh,0),0), 1) AS "sor"')
        elif m == "units_since_launch":
            out_parts.append('COALESCE(life.units_since_launch, 0) AS "units_since_launch"')
        elif m == "revenue_since_launch":
            out_parts.append('COALESCE(life.revenue_since_launch, 0) AS "revenue_since_launch"')
        elif m == "sor_since_launch":
            out_parts.append('ROUND(COALESCE(life.units_since_launch,0)*100.0 / '
                             'NULLIF(COALESCE(life.units_since_launch,0)+COALESCE(stock.soh,0),0), 1) '
                             'AS "sor_since_launch"')
        elif m == "units_per_week":
            out_parts.append('COALESCE(vel.weekly_units, 0) AS "units_per_week"')
        elif m == "woc":
            out_parts.append('ROUND(COALESCE(stock.soh,0) / '
                             'NULLIF(GREATEST(vel.weekly_units, 0), 0), 1) AS "woc"')
        else:
            out_parts.append(f'COALESCE(s."{m}", 0) AS "{m}"')

    sql = ("WITH " + ", ".join(cte_defs) + " SELECT " + ", ".join(out_parts) +
           " FROM spine sp" + "".join(join_sql_parts) +
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
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS total_discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_returns,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS total_orders,
            -- Units sold = GROSS units on sale/order rows, the single canonical
            -- definition (= _UNITS) used by country-summary, products,
            -- sales-summary, the report builder and /api/analytics/canonical-
            -- units-sold. Do NOT use SUM(net_quantity) here: that nets returned
            -- units and made the per-country Σ drift from this headline by the
            -- return volume (recon "country units sum eq kpis" failure).
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS total_units,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0), 0) AS avg_selling_price,
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
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
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
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
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
    # Net of returns so the trend sums to the headline (variant A). Return rows
    # are INCLUDED (no sale_kind filter) so returns_kes subtracts on the return's
    # own date; orders/units/gross stay sale+order only.
    where = build_filters(date_from, date_to, country)
    return run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END)
                - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales
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
            COALESCE(NULLIF(p.product_name, ''), i.product_name) AS product_name, i.sku,
            p.brand, p.product_type, p.style_name,
            p.color_print, p.size, p.barcode,
            SUM(i.available) AS available
        FROM all_inventory i
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        WHERE """ + where + """
        GROUP BY i.country, i.pos_location_name, COALESCE(NULLIF(p.product_name, ''), i.product_name), i.sku,
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
    ff_where = "f.time BETWEEN '" + date_from + "' AND '" + date_to + "'"
    # Channel filter is applied on the CANONICAL name (post-alias) so it also
    # matches the renamed sensor spellings introduced 2026-06-07.
    sales_where = "s.sale_date BETWEEN '" + date_from + "' AND '" + date_to + "' AND " + BASE_FILTERS
    # Applied after the day-level FULL OUTER JOIN, on the canonical location.
    loc_filter = (" WHERE loc IN (" + csv_to_sql(channel) + ")") if channel else ""
    # Day-level join (footfall vs sales) so we can detect "sensor-gap" days —
    # days where a store made sales but the footfall counter reported zero —
    # and recompute a clean conversion that excludes those days. Top-level
    # fields stay byte-for-byte compatible with the prior store-level query;
    # `sensor_gap_days` / `clean_orders` / `clean_conversion_rate` are additive.
    return run_query("""
        WITH ff_daily AS (
            SELECT """ + ff_canon_sql() + """ AS loc,
                f.time::date AS d,
                SUM(f.a01_footfall_in) AS ff,
                SUM(f.a05_outside_traffic) AS outside
            FROM footfall f
            WHERE """ + ff_where + """
            GROUP BY 1, 2
        ),
        sales_daily AS (
            SELECT s.pos_location_name AS loc,
                s.sale_date::date AS d,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS sales
            FROM all_sales s
            WHERE """ + sales_where + """
            GROUP BY 1, 2
        ),
        ff_locs AS (SELECT DISTINCT loc FROM ff_daily),
        joined AS (
            SELECT COALESCE(ff.loc, sd.loc) AS loc,
                COALESCE(ff.ff, 0) AS ff,
                COALESCE(ff.outside, 0) AS outside,
                COALESCE(sd.orders, 0) AS orders,
                COALESCE(sd.sales, 0) AS sales
            FROM ff_daily ff
            FULL OUTER JOIN sales_daily sd
                ON sd.loc = ff.loc AND sd.d = ff.d
            WHERE COALESCE(ff.loc, sd.loc) IN (SELECT loc FROM ff_locs)
        )
        SELECT loc AS location,
            SUM(ff) AS total_footfall,
            SUM(outside) AS outside_traffic,
            ROUND(SUM(ff) * 100.0 / NULLIF(SUM(outside), 0), 1) AS turn_in_rate,
            SUM(orders) AS orders,
            SUM(sales) AS total_sales,
            ROUND(SUM(sales) / NULLIF(SUM(orders), 0), 0) AS avg_basket,
            ROUND(SUM(orders) * 100.0 / NULLIF(SUM(ff), 0), 1) AS conversion_rate,
            COUNT(*) FILTER (WHERE ff = 0 AND orders > 0) AS sensor_gap_days,
            COALESCE(SUM(orders) FILTER (WHERE ff > 0), 0) AS clean_orders,
            ROUND(SUM(orders) FILTER (WHERE ff > 0) * 100.0 / NULLIF(SUM(ff), 0), 1) AS clean_conversion_rate
        FROM joined""" + loc_filter + """
        GROUP BY loc
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
    ff_extra = (" AND " + ff_canon_sql() + " IN (" + csv_to_sql(channel) + ")") if channel else ""
    sa_extra = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    raw = run_query("""
        WITH ff AS (
            SELECT """ + ff_canon_sql() + """ AS location, f.time::date AS d,
                ((EXTRACT(DOW FROM f.time)::int + 6) % 7) AS wd,
                SUM(f.a01_footfall_in) AS footfall,
                SUM(f.a05_outside_traffic) AS outside
            FROM footfall f
            WHERE f.time BETWEEN '""" + date_from + """' AND '""" + date_to + """'""" + ff_extra + """
            GROUP BY """ + ff_canon_sql() + """, f.time::date
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

# Walk-in / placeholder / brand pseudo-accounts (matched case-insensitively on the
# customer name) are not real identified customers and are excluded from the customer
# universe (new / returning / repeat / total) wherever those counts are computed.
_WALKIN_NAME_REGEX = r"(walk[ -]?in|vivo|safari|zoya)"


@app.get("/api/customers")
def get_customers(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    channel_filter = ("AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    # Churn + first-ever-purchase are GLOBAL (no country/channel scope), full-scan
    # all_sales and dominate this endpoint's cold latency. Serve them from the
    # pre-aggregated per-customer rollups when fresh; the freshness gate falls back
    # to the live full-scan SQL when the rollup is missing/stale (so prod is safe
    # before its first sync-loop refresh). The rollup churn read is byte-identical
    # to the live CTE (parity-verified): eligible_base = customers whose first sale
    # predates the 90d cutoff, churned = those whose last sale also predates it.
    if _rollup_fresh("customer_lifetime") and _rollup_fresh("customer_first_purchase"):
        churned_cte = """churned AS (
            SELECT
                COUNT(*) FILTER (WHERE last_sale < CURRENT_DATE - INTERVAL '90 days') AS churned_count,
                COUNT(*) AS eligible_base
            FROM rollup_customer_lifetime
            WHERE first_sale < CURRENT_DATE - INTERVAL '90 days'
        )"""
        first_purchase_cte = ("first_purchase AS ("
            "SELECT customer_id, first_purchase_date FROM rollup_customer_first_purchase)")
    else:
        churned_cte = """churned AS (
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
        )"""
        first_purchase_cte = _unified_first_purchase_ctes()
    rows = run_query("""
        WITH excluded AS (
            -- Walk-in / placeholder / brand pseudo-accounts are not real identified
            -- customers, so they are dropped from the customer universe (new, returning,
            -- repeat, total). Matched case-insensitively on the customer name.
            SELECT DISTINCT customer_id
            FROM all_customers
            WHERE customer_id IS NOT NULL
              AND (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ~* '""" + _WALKIN_NAME_REGEX + """'
        ),
        cust_profile AS (
            -- One profile row per customer_id (best non-empty value across store rows),
            -- used to flag identified customers whose profile is missing name/phone/email.
            SELECT customer_id,
                MAX(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')) AS prof_name,
                MAX(NULLIF(TRIM(COALESCE(phone,'')), '')) AS prof_phone,
                MAX(NULLIF(TRIM(COALESCE(email,'')), '')) AS prof_email
            FROM all_customers
            WHERE customer_id IS NOT NULL
            GROUP BY customer_id
        ),
        period_customers AS (
            SELECT s.customer_id,
                COUNT(DISTINCT s.order_id) AS order_count,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_spend
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND s.customer_id IS NOT NULL
            AND s.customer_id NOT IN ('None','null','')
            AND s.customer_id NOT IN (SELECT customer_id FROM excluded)
            AND """ + BASE_FILTERS + " " + country_filter + " " + channel_filter + """
            GROUP BY s.customer_id
        ),
        """ + churned_cte + """,
        -- First-ever purchase date per customer across ALL history over a UNIFIED
        -- identity that bridges the 2026-03-20 Kenya Odoo/Shopify id switch (see
        -- _unified_first_purchase_ctes). Drives BOTH the New/Returning split (seg)
        -- and the additive "first-time registered" metric below. Read from the
        -- pre-aggregated rollup when fresh, else recomputed live.
        """ + first_purchase_cte + """,
        seg AS (
            -- New vs Returning by FIRST-EVER purchase date, NOT the stored
            -- customer_type. Kenya (and most POS) tags every counter sale
            -- 'registered' and never 'new', so a customer_type='new' filter made
            -- "New" structurally 0 and dumped every genuine first-time buyer
            -- into Returning. 'registered' customer_ids are stable (~2.5
            -- orders/id), so the first-purchase recompute is reliable here: a
            -- customer whose first-EVER purchase falls in the window is New, one
            -- who bought before is Returning. The identified universe is still
            -- customer_type in new/returning/registered (walk-in / Guest / blank
            -- are excluded and surfaced separately by /api/customers/walk-ins).
            -- Counts are DISTINCT order_id, matching /api/customer-type-spend.
            SELECT
                COUNT(DISTINCT s.customer_id) FILTER (
                    WHERE fp.first_purchase_date BETWEEN '""" + date_from + """'::date AND '""" + date_to + """'::date) AS new_c,
                COUNT(DISTINCT s.customer_id) FILTER (
                    WHERE fp.first_purchase_date < '""" + date_from + """'::date) AS ret_c,
                COUNT(DISTINCT s.customer_id) AS total_c
            FROM all_sales s
            JOIN first_purchase fp ON fp.customer_id = s.customer_id
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind = 'order'
            AND LOWER(s.customer_type) IN ('new','returning','registered')
            """ + country_filter + " " + channel_filter + """
        ),
        first_time_reg AS (
            -- Additive metric: registered (POS counter) orders whose customer's
            -- first-EVER purchase falls inside the selected window. Surfaces
            -- genuine first-time registered shoppers WITHOUT changing the
            -- New/Returning split (registered still rolls into Returning in
            -- seg). Honors the same country/channel filters as the period.
            SELECT COUNT(DISTINCT s.order_id) AS first_time_registered
            FROM all_sales s
            JOIN first_purchase fp ON fp.customer_id = s.customer_id
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind = 'order'
            AND LOWER(s.customer_type) = 'registered'
            AND fp.first_purchase_date BETWEEN '""" + date_from + """'::date AND '""" + date_to + """'::date
            """ + country_filter + " " + channel_filter + """
        ),
        pc_agg AS (
            -- Identified-customer aggregates (avg spend, profile completeness)
            -- still keyed on customer_id over the cleaned period_customers set.
            -- Always returns exactly one row (aggregate, no GROUP BY).
            SELECT
                COUNT(DISTINCT CASE WHEN (cp.customer_id IS NULL
                    OR cp.prof_name IS NULL OR cp.prof_phone IS NULL OR cp.prof_email IS NULL)
                    THEN p.customer_id END) AS incomplete_profile_customers,
                ROUND(AVG(p.total_spend), 0) AS avg_customer_spend,
                ROUND(AVG(p.order_count), 2) AS avg_orders_per_customer
            FROM period_customers p
            LEFT JOIN cust_profile cp ON p.customer_id = cp.customer_id
        )
        SELECT
            sg.total_c AS total_customers,
            sg.new_c AS new_customers,
            0 AS repeat_customers,
            sg.ret_c AS returning_customers,
            ftr.first_time_registered AS first_time_registered,
            c.churned_count AS churned_customers,
            pa.incomplete_profile_customers AS incomplete_profile_customers,
            pa.avg_customer_spend AS avg_customer_spend,
            pa.avg_orders_per_customer AS avg_orders_per_customer,
            ROUND(c.churned_count * 100.0 / NULLIF(c.eligible_base, 0), 2) AS churn_rate
        FROM seg sg
        CROSS JOIN churned c
        CROSS JOIN first_time_reg ftr
        CROSS JOIN pc_agg pa
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

import base64 as _b64


def _style_color_skus(conn, sku: str):
    """Return every catalog SKU that shares the given SKU's style_name + colour
    (color_print), so product imagery resolves at STYLE+COLOUR level rather than
    per-size SKU. The given SKU is always included and listed first. Falls back
    to just the SKU itself when its style/colour is unknown or blank."""
    sku = (sku or "").strip()
    if not sku:
        return []
    cur = conn.cursor()
    cur.execute(
        "SELECT NULLIF(TRIM(style_name),''), NULLIF(TRIM(color_print),'') "
        "FROM all_products_clean WHERE sku = %s LIMIT 1",
        (sku,)
    )
    row = cur.fetchone()
    if not row or not row[0] or not row[1]:
        return [sku]
    style, color = row
    cur.execute(
        "SELECT DISTINCT sku FROM all_products_clean "
        "WHERE LOWER(TRIM(style_name)) = LOWER(%s) "
        "  AND LOWER(TRIM(color_print)) = LOWER(%s) "
        "  AND sku IS NOT NULL AND sku <> '' AND sku <> %s "
        "ORDER BY sku",
        (style, color, sku)
    )
    return [sku] + [r[0] for r in cur.fetchall()]


def _with_v_variants(skus):
    """Expand each SKU with its leading-'V' counterpart (catalog and Shopify
    disagree on the V-prefix in both directions), preserving order + de-duping."""
    out = []
    seen = set()
    for s in skus:
        forms = [s, s[1:] if s[:1] in ("V", "v") else "V" + s]
        for c in forms:
            if c and c not in seen:
                seen.add(c)
                out.append(c)
    return out


@app.get("/api/product-image/{sku:path}")
def get_product_image(sku: str):
    """Serve a product's 512px image as raw JPEG bytes, resolved SKU -> template.
    Matches at style+colour level: if the exact SKU has no mapped image, falls
    back to any sibling SKU sharing the same style_name + colour. Returns 404
    when nothing matches so the frontend can show a placeholder."""
    sku = (sku or "").strip()
    if not sku:
        return Response(status_code=404)
    conn = get_conn()
    try:
        candidates = _style_color_skus(conn, sku)
        cur = conn.cursor()
        cur.execute(
            "SELECT i.image_512 FROM product_image_map m "
            "JOIN product_images i ON i.tmpl_id = m.tmpl_id "
            "WHERE m.sku = ANY(%s) AND i.image_512 IS NOT NULL "
            "ORDER BY (m.sku = %s) DESC, m.sku ASC LIMIT 1",
            (candidates, sku)
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return Response(status_code=404)
    try:
        img = _b64.b64decode(row[0])
    except Exception:
        return Response(status_code=404)
    return Response(content=img, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/gallery/search")
def get_gallery_search(
    request: Request,
    q:       str = Query(default=""),
    limit:   int = Query(default=48),
    offset:  int = Query(default=0),
):
    """Searchable product photo gallery — one card per style + colour.

    Matches the (lower-cased) search term against style name / SKU / barcode
    with a partial, case-insensitive LIKE. Returns one representative row per
    (style, colour) (DISTINCT ON), preferring a SKU that actually has a stored image so
    the card renders a photo where one exists; cards for styles with no image
    fall back to the client-side coloured-initials placeholder.

    Pagination is offset-based; we fetch one extra row to compute ``has_more``
    instead of paying for a COUNT(*) over the whole catalog. With no term it
    returns a sensible default page (styles-with-photos first, then alpha)."""
    limit = max(1, min(int(limit or 48), 96))
    offset = max(0, int(offset or 0))
    # Same edge sanitisation as /api/customer-search: lower-case + strip single
    # quotes so the concatenated LIKE literal can't break out of its '...'.
    term = (q or "").strip().lower().replace("'", "")
    where = "p.style_name IS NOT NULL AND p.style_name <> ''"
    if term:
        like = "%" + term + "%"
        where += (" AND (LOWER(p.style_name) LIKE '" + like + "'"
                  " OR LOWER(p.sku) LIKE '" + like + "'"
                  " OR LOWER(COALESCE(p.barcode,'')) LIKE '" + like + "')")
    rows = run_query("""
        SELECT * FROM (
            SELECT DISTINCT ON (p.style_name, COALESCE(p.color_print, ''))
                p.style_name, COALESCE(p.color_print, '') AS color, p.sku, p.barcode,
                (i.image_512 IS NOT NULL AND i.image_512 <> '') AS has_image
            FROM all_products_clean p
            LEFT JOIN product_image_map m ON m.sku = p.sku
            LEFT JOIN product_images i ON i.tmpl_id = m.tmpl_id
            WHERE """ + where + """
            ORDER BY p.style_name, COALESCE(p.color_print, ''),
                     (i.image_512 IS NOT NULL AND i.image_512 <> '') DESC,
                     p.sku
        ) d
        ORDER BY d.has_image DESC, d.style_name, d.color
        LIMIT """ + str(limit + 1) + " OFFSET " + str(offset))
    has_more = len(rows) > limit
    items = rows[:limit]
    for r in items:
        r["image_url"] = (
            "/api/product-image/" + quote(str(r["sku"]), safe="")
        ) if r.get("has_image") else None
    return {"items": items, "has_more": has_more, "limit": limit, "offset": offset}


@app.get("/api/product-images/{sku:path}")
def get_product_images(sku: str):
    """Return a product's Shopify image gallery as ordered URLs, matched at
    STYLE+COLOUR level: the gallery unions the images of every SKU sharing the
    given SKU's style_name + colour (so all sizes show the same photos and a
    size whose own SKU has no image still resolves). The exact SKU's images
    are listed first. Each candidate SKU is also tried with/without a leading
    'V' (catalog and Shopify disagree on the V-prefix in both directions).
    Response: {"sku": <sku>, "images": [{"url":..., "position":N, "is_primary":bool}, ...]}.
    Empty list if none found."""
    sku = (sku or "").strip()
    if not sku:
        return {"sku": sku, "images": []}
    conn = get_conn()
    try:
        candidates = _with_v_variants(_style_color_skus(conn, sku))
        cur = conn.cursor()
        cur.execute(
            "SELECT image_url, position, is_primary FROM product_image_urls "
            "WHERE sku = ANY(%s) ORDER BY (sku = %s) DESC, is_primary DESC, position ASC",
            (candidates, sku)
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    seen = set(); images = []
    for url, pos, prim in rows:
        if url in seen:
            continue
        seen.add(url)
        images.append({"url": url, "position": pos, "is_primary": prim})
    return {"sku": sku, "images": images}


@app.get("/api/product-search")
def product_search(
    q: str = Query(default=""),
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    """Typeahead for the Products-page finder. Matches a free-text query against
    style_name / sku / barcode / product_name / colour and returns one row per
    SKU variant so the UI can group the results style > SKU/barcode.

    When a date window is supplied, each matched SKU is enriched with
    units_sold (over the window) + current_stock (excl. warehouses) so the STS
    table can render searched items as in-table rows with its own columns."""
    term = (q or "").strip()
    if len(term) < 2:
        return {"options": []}
    like = "%" + term.replace("%", "").replace("_", "") + "%"
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT p.sku, COALESCE(p.barcode,'') AS barcode, "
            "       COALESCE(p.style_name,'') AS style_name, "
            "       COALESCE(NULLIF(p.product_name,''), p.style_name) AS product_name, "
            "       COALESCE(p.color_print,'') AS color, "
            "       COALESCE(p.size,'') AS size, "
            "       COALESCE(NULLIF(p.category,''),'') AS category, "
            "       COALESCE(NULLIF(p.product_type,''),'') AS subcategory "
            "FROM all_products_clean p "
            "WHERE p.sku IS NOT NULL AND p.sku <> '' AND ("
            "      LOWER(p.sku) LIKE LOWER(%s) "
            "   OR LOWER(COALESCE(p.barcode,'')) LIKE LOWER(%s) "
            "   OR LOWER(COALESCE(p.style_name,'')) LIKE LOWER(%s) "
            "   OR LOWER(COALESCE(p.product_name,'')) LIKE LOWER(%s) "
            "   OR LOWER(COALESCE(p.color_print,'')) LIKE LOWER(%s)) "
            "ORDER BY p.style_name NULLS LAST, p.size, p.sku "
            "LIMIT 80",
            (like, like, like, like, like),
        )
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

        # Collapse any duplicate SKU rows (keep first, preserving display order).
        seen = set()
        deduped = []
        for r in rows:
            key = r.get("sku")
            if key in seen:
                continue
            seen.add(key)
            deduped.append(r)

        # Optional STS-metric enrichment for the matched SKUs.
        if deduped and date_from and date_to:
            skus = [r["sku"] for r in deduped]
            sales_where = build_filters(
                date_from, date_to, country, channel,
                extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0",
            ).replace("%", "%%")
            cur.execute(
                "SELECT s.variant_sku AS sku, SUM(s.ordered_item_quantity) AS units_sold "
                "FROM all_sales s WHERE " + sales_where +
                "  AND s.variant_sku = ANY(%s) GROUP BY s.variant_sku",
                (skus,),
            )
            sold = {r[0]: int(r[1] or 0) for r in cur.fetchall()}
            cur.execute(
                "SELECT i.sku, SUM(i.available) AS current_stock "
                "FROM all_inventory i "
                "WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
                "  AND i.sku = ANY(%s) GROUP BY i.sku",
                (skus,),
            )
            stock = {r[0]: int(r[1] or 0) for r in cur.fetchall()}
            for r in deduped:
                r["units_sold"] = sold.get(r["sku"], 0)
                r["current_stock"] = stock.get(r["sku"], 0)
    finally:
        conn.close()
    return {"options": deduped}


@app.get("/api/product-detail")
def product_detail(sku: str = Query(default=""), barcode: str = Query(default="")):
    """Full detail for one product variant for the Products-page popup: name,
    colour, style, size, brand/subcategory, SOH (split stores vs warehouse) and
    days since its last sale. Photo is resolved client-side via the shared
    thumbnail lookup (style -> override / Odoo image)."""
    from fastapi import HTTPException
    s = (sku or "").strip()
    bc = (barcode or "").strip()
    if not s and not bc:
        raise HTTPException(status_code=400, detail="sku or barcode required")
    cols_sql = (
        "SELECT p.sku, COALESCE(p.barcode,'') AS barcode, "
        "COALESCE(p.style_name,'') AS style_name, "
        "COALESCE(NULLIF(p.product_name,''), p.style_name) AS product_name, "
        "COALESCE(p.color_print,'') AS color, COALESCE(p.size,'') AS size, "
        "COALESCE(p.brand,'') AS brand, COALESCE(p.product_type,'') AS subcategory, "
        "COALESCE(p.category,'') AS category "
        "FROM all_products_clean p "
    )
    conn = get_conn()
    try:
        cur = conn.cursor()
        if s:
            cur.execute(cols_sql + "WHERE p.sku = %s LIMIT 1", (s,))
        else:
            cur.execute(cols_sql + "WHERE p.barcode = %s LIMIT 1", (bc,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="product not found")
        cols = [c[0] for c in cur.description]
        d = dict(zip(cols, row))
        sku_val = d["sku"]
        cur.execute(
            "SELECT "
            "COALESCE(SUM(available) FILTER (WHERE pos_location_name NOT IN ("
            + WAREHOUSE_LOCATIONS + ")),0) AS soh_stores, "
            "COALESCE(SUM(available) FILTER (WHERE pos_location_name IN ("
            + WAREHOUSE_LOCATIONS + ")),0) AS soh_warehouse "
            "FROM all_inventory WHERE sku = %s",
            (sku_val,),
        )
        srow = cur.fetchone()
        soh_stores = int((srow[0] if srow else 0) or 0)
        soh_warehouse = int((srow[1] if srow else 0) or 0)
        cur.execute(
            "SELECT MAX(sale_date::date) FROM all_sales "
            "WHERE variant_sku = %s AND sale_kind IN ('sale','order')",
            (sku_val,),
        )
        lrow = cur.fetchone()
        last_sale = lrow[0] if lrow else None
    finally:
        conn.close()
    today = date.today()
    return {
        "sku": d["sku"],
        "barcode": d["barcode"],
        "style_name": d["style_name"],
        "product_name": d["product_name"],
        "color": d["color"],
        "size": d["size"],
        "brand": d["brand"],
        "subcategory": d["subcategory"],
        "category": d["category"],
        "soh_stores": soh_stores,
        "soh_warehouse": soh_warehouse,
        "soh_total": soh_stores + soh_warehouse,
        "last_sale": str(last_sale) if last_sale else None,
        "days_since_last_sale": (today - last_sale).days if last_sale else None,
    }


@app.get("/api/product-tree")
def product_tree(
    category: str = Query(default=""),
    subcategory: str = Query(default=""),
    style: str = Query(default=""),
):
    """Lazy hierarchical drill-down for the Products-page finder:
    Category -> Subcategory -> Style -> SKU/Barcode variant.

    Returns the *children* of whatever level is fully specified:
      - no params              -> list of categories
      - category               -> subcategories within it
      - category+subcategory   -> styles within it
      - category+subcat+style  -> SKU/barcode variants of that style

    All filters are parameterized. Empty category/subcategory/style are
    treated as the literal "" bucket (so uncategorised products still drill)."""
    cat = (category or "").strip()
    sub = (subcategory or "").strip()
    sty = (style or "").strip()

    # COALESCE expressions so NULL and '' collapse to one stable bucket value.
    CAT = "COALESCE(NULLIF(p.category,''),'')"
    SUB = "COALESCE(NULLIF(p.product_type,''),'')"
    STY = "COALESCE(NULLIF(p.style_name,''),'')"
    BASE = "all_products_clean p WHERE p.sku IS NOT NULL AND p.sku <> '' "

    conn = get_conn()
    try:
        cur = conn.cursor()
        if not cat:
            level = "category"
            cur.execute(
                "SELECT " + CAT + " AS val, "
                "COUNT(DISTINCT " + STY + ") AS styles, "
                "COUNT(DISTINCT p.sku) AS skus "
                "FROM " + BASE +
                "GROUP BY 1 ORDER BY (" + CAT + " = '') ASC, " + CAT + " ASC"
            )
        elif not sub:
            level = "subcategory"
            cur.execute(
                "SELECT " + SUB + " AS val, "
                "COUNT(DISTINCT " + STY + ") AS styles, "
                "COUNT(DISTINCT p.sku) AS skus "
                "FROM " + BASE + "AND " + CAT + " = %s "
                "GROUP BY 1 ORDER BY (" + SUB + " = '') ASC, " + SUB + " ASC",
                (cat,),
            )
        elif not sty:
            level = "style"
            cur.execute(
                "SELECT " + STY + " AS val, "
                "COUNT(DISTINCT p.sku) AS skus "
                "FROM " + BASE + "AND " + CAT + " = %s AND " + SUB + " = %s "
                "GROUP BY 1 ORDER BY (" + STY + " = '') ASC, " + STY + " ASC",
                (cat, sub),
            )
        else:
            level = "variant"
            cur.execute(
                "SELECT p.sku, COALESCE(p.barcode,'') AS barcode, "
                "COALESCE(p.style_name,'') AS style_name, "
                "COALESCE(NULLIF(p.product_name,''), p.style_name) AS product_name, "
                "COALESCE(p.color_print,'') AS color, COALESCE(p.size,'') AS size "
                "FROM " + BASE + "AND " + CAT + " = %s AND " + SUB + " = %s "
                "AND " + STY + " = %s "
                "ORDER BY p.size NULLS LAST, p.sku",
                (cat, sub, sty),
            )
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    if level == "variant":
        # De-dupe by SKU (keep first), mirroring product-search.
        seen, deduped = set(), []
        for r in rows:
            if r.get("sku") in seen:
                continue
            seen.add(r["sku"])
            deduped.append(r)
        return {"level": level, "items": deduped}

    return {"level": level, "items": rows}


# Bucket expressions shared by the STS in-table drill-down so NULL/'' collapse
# to one stable bucket value (mirrors /api/product-tree).
_STS_CAT = "COALESCE(NULLIF(p.category,''),'')"
_STS_SUB = "COALESCE(NULLIF(p.product_type,''),'')"
_STS_STY = "COALESCE(NULLIF(p.style_name,''),'')"


@app.get("/api/analytics/stock-to-sales-drill")
def analytics_sts_drill(
    level: str = Query(default="style"),   # "style" | "variant"
    category: str = Query(default=""),
    subcategory: str = Query(default=""),
    style: str = Query(default=""),
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    """Lazy drill children WITH stock-to-sales metrics for the in-table Products
    drill-down: units_sold over the selected window + current_stock (excl.
    warehouses). The % shares and variance are computed CLIENT-side against the
    category-table grand totals so every level nests cleanly under its parent.

      level=style   -> styles within category+subcategory
      level=variant -> SKU/barcode variants within category+subcategory+style
    """
    cat = (category or "").strip()
    sub = (subcategory or "").strip()
    sty = (style or "").strip()
    # build_filters injects BASE_FILTERS, which contains literal '%' (gift-card
    # excludes). Double them so psycopg treats them as literals while we bind
    # the cat/sub/sty values as %s params (see psycopg2-literal-percent memory).
    sales_where = build_filters(
        date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0",
    ).replace("%", "%%")

    if level == "variant":
        sql = (
            "WITH sales AS ("
            "  SELECT p.sku AS k, SUM(s.ordered_item_quantity) AS units_sold "
            "  FROM all_sales s JOIN all_products_clean p ON s.variant_sku = p.sku "
            "  WHERE " + sales_where +
            "    AND " + _STS_CAT + " = %s AND " + _STS_SUB + " = %s AND " + _STS_STY + " = %s "
            "  GROUP BY p.sku"
            "), stock AS ("
            "  SELECT i.sku AS k, SUM(i.available) AS current_stock "
            "  FROM all_inventory i "
            "  WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
            "  GROUP BY i.sku"
            ") "
            "SELECT p.sku, COALESCE(p.barcode,'') AS barcode, "
            "  COALESCE(p.style_name,'') AS style_name, "
            "  COALESCE(NULLIF(p.product_name,''), p.style_name) AS product_name, "
            "  COALESCE(p.color_print,'') AS color, COALESCE(p.size,'') AS size, "
            "  COALESCE(sa.units_sold,0) AS units_sold, "
            "  COALESCE(st.current_stock,0) AS current_stock "
            "FROM all_products_clean p "
            "LEFT JOIN sales sa ON sa.k = p.sku "
            "LEFT JOIN stock st ON st.k = p.sku "
            "WHERE p.sku IS NOT NULL AND p.sku <> '' "
            "  AND " + _STS_CAT + " = %s AND " + _STS_SUB + " = %s AND " + _STS_STY + " = %s "
            "ORDER BY p.size NULLS LAST, p.sku"
        )
        params = (cat, sub, sty, cat, sub, sty)
    else:  # style
        sql = (
            "WITH sales AS ("
            "  SELECT " + _STS_STY + " AS k, SUM(s.ordered_item_quantity) AS units_sold "
            "  FROM all_sales s JOIN all_products_clean p ON s.variant_sku = p.sku "
            "  WHERE " + sales_where +
            "    AND " + _STS_CAT + " = %s AND " + _STS_SUB + " = %s "
            "  GROUP BY 1"
            "), stock AS ("
            "  SELECT " + _STS_STY + " AS k, SUM(i.available) AS current_stock "
            "  FROM all_inventory i JOIN all_products_clean p ON i.sku = p.sku "
            "  WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
            "    AND " + _STS_CAT + " = %s AND " + _STS_SUB + " = %s "
            "  GROUP BY 1"
            "), base AS ("
            "  SELECT " + _STS_STY + " AS val, COUNT(DISTINCT p.sku) AS skus "
            "  FROM all_products_clean p "
            "  WHERE p.sku IS NOT NULL AND p.sku <> '' "
            "    AND " + _STS_CAT + " = %s AND " + _STS_SUB + " = %s "
            "  GROUP BY 1"
            ") "
            "SELECT b.val, b.skus, "
            "  COALESCE(sa.units_sold,0) AS units_sold, "
            "  COALESCE(st.current_stock,0) AS current_stock "
            "FROM base b "
            "LEFT JOIN sales sa ON sa.k = b.val "
            "LEFT JOIN stock st ON st.k = b.val "
            "ORDER BY (b.val = '') ASC, COALESCE(sa.units_sold,0) DESC, b.val ASC"
        )
        params = (cat, sub, cat, sub, cat, sub)

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    if level == "variant":
        seen, deduped = set(), []
        for r in rows:
            if r.get("sku") in seen:
                continue
            seen.add(r["sku"])
            deduped.append(r)
        rows = deduped
    return {"level": level, "items": rows}


@app.get("/api/analytics/stock-to-sales-export")
def analytics_sts_export(
    grain: str = Query(default="product"),   # currently only "product"
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    """Flat per-SKU stock-to-sales rows for the table's CSV-export dropdown
    ("All products — full stock mix" and, filtered client-side by risk flag,
    "Action items only"). One row per active SKU (current_stock>0 OR sold>0)
    with its category/subcategory/style + units_sold (window) + current_stock."""
    sales_where = build_filters(
        date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0",
    ).replace("%", "%%")
    sql = (
        "WITH sales AS ("
        "  SELECT p.sku AS k, SUM(s.ordered_item_quantity) AS units_sold "
        "  FROM all_sales s JOIN all_products_clean p ON s.variant_sku = p.sku "
        "  WHERE " + sales_where +
        "  GROUP BY p.sku"
        "), stock AS ("
        "  SELECT i.sku AS k, SUM(i.available) AS current_stock "
        "  FROM all_inventory i "
        "  WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ") "
        "  GROUP BY i.sku"
        ") "
        "SELECT " + _STS_CAT + " AS category, " + _STS_SUB + " AS subcategory, "
        "  COALESCE(p.style_name,'') AS style_name, p.sku, "
        "  COALESCE(p.barcode,'') AS barcode, "
        "  COALESCE(p.color_print,'') AS color, COALESCE(p.size,'') AS size, "
        "  COALESCE(sa.units_sold,0) AS units_sold, "
        "  COALESCE(st.current_stock,0) AS current_stock "
        "FROM all_products_clean p "
        "LEFT JOIN sales sa ON sa.k = p.sku "
        "LEFT JOIN stock st ON st.k = p.sku "
        "WHERE p.sku IS NOT NULL AND p.sku <> '' "
        "  AND (COALESCE(st.current_stock,0) > 0 OR COALESCE(sa.units_sold,0) > 0) "
        "ORDER BY category, subcategory, style_name, p.sku "
        "LIMIT 50000"
    )
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()
    seen, deduped = set(), []
    for r in rows:
        if r.get("sku") in seen:
            continue
        seen.add(r["sku"])
        deduped.append(r)
    return {"items": deduped}


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
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')"
        " AND s.customer_id NOT IN (SELECT customer_id FROM all_customers WHERE customer_id IS NOT NULL"
        " AND (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ~* '" + _WALKIN_NAME_REGEX + "')")
    return run_query("""
        WITH """ + _unified_first_purchase_ctes("all_time", "first_purchase") + """
        SELECT s.sale_date AS day,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase = s.sale_date::date THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < s.sale_date::date THEN s.customer_id END) AS returning_customers
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
        extra="s.sale_kind IN ('sale','order') AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')"
        " AND s.customer_id NOT IN (SELECT customer_id FROM all_customers WHERE customer_id IS NOT NULL"
        " AND (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ~* '" + _WALKIN_NAME_REGEX + "')")
    return run_query("""
        WITH """ + _unified_first_purchase_ctes("all_time", "first_purchase") + """
        SELECT s.pos_location_name, s.country,
            COUNT(DISTINCT s.customer_id) AS total_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase BETWEEN '""" + date_from + """'::date AND '""" + date_to + """'::date THEN s.customer_id END) AS new_customers,
            COUNT(DISTINCT CASE WHEN a.first_purchase < '""" + date_from + """'::date THEN s.customer_id END) AS returning_customers,
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
    #
    # Response cache: the Catalog "Styles Tracked" KPI + SOR table now show every
    # qualifying style (uncapped), so a wide date range full-scans all_sales and
    # can take ~8s for ~1800 rows. The result is identical for every user and
    # changes slowly, so cache the fully-computed response for 10 min keyed on
    # all filter params (mirrors /api/analytics/sor-all-styles via the run_query
    # cache, but pins a longer TTL so wide ranges ending today stay warm — the
    # bare run_query cache would only hold ~120s when date_to >= today).
    _sor_ck = "sor:" + "|".join(str(x) for x in (date_from, date_to, country, channel))
    _sor_cached = cache_get(_sor_ck)
    if _sor_cached is not None:
        return _sor_cached
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order','return') AND p.style_name IS NOT NULL")
    rows = run_query("""
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
        LIMIT 50000
    """, date_to=date_to)
    cache_set(_sor_ck, rows, ttl=600)
    return rows

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
            COALESCE(NULLIF(p.product_name, ''), s.product_title) AS product_title, s.variant_sku AS sku,
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
    locations: str = Query(default=None),
):
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    inv_country_filter = ("AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    # The filter-bar "store" param (sent by the Inventory page as `locations`)
    # carries pos_location_name values. Apply it to BOTH the sales and the
    # inventory CTE so the table scopes consistently — otherwise a store-scoped
    # sales row was matched against catalog-wide stock (or vice versa).
    loc_sales_filter = ("AND s.pos_location_name IN (" + csv_to_sql(locations) + ")") if locations else ""
    loc_inv_filter = ("AND i.pos_location_name IN (" + csv_to_sql(locations) + ")") if locations else ""
    return run_query("""
        WITH sales AS (
            SELECT s.pos_location_name, s.country,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
            AND s.sale_kind IN ('sale','order')
            AND """ + BASE_FILTERS + " " + country_filter + " " + loc_sales_filter + """
            GROUP BY s.pos_location_name, s.country
        ),
        inventory AS (
            SELECT i.pos_location_name, i.country, SUM(i.available) AS total_stock
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            """ + inv_country_filter + " " + loc_inv_filter + """
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
    # New vs Returning by FIRST-EVER purchase date, matching /api/customers seg.
    # The stored customer_type can't express new-vs-returning for POS (every
    # counter sale is tagged 'registered', never 'new'), so a customer_type='new'
    # filter made "New" structurally 0. 'registered' customer_ids are stable, so
    # the first-purchase recompute is reliable: a customer whose first-EVER
    # purchase falls in the window is New, one who bought before is Returning.
    # The identified universe is still customer_type in new/returning/registered;
    # anything else (walk-in, Guest, blank) is a Walk-in.
    # spend_per_customer divides by unique customers (COUNT DISTINCT customer_id)
    # while avg_basket_value divides by orders (COUNT DISTINCT order_id), so the
    # two diverge: since customers place >1 order on average, spend_per_customer
    # is generally higher than ABV.
    return run_query("""
        WITH """ + _unified_first_purchase_ctes() + """
        SELECT
            CASE
                -- COALESCE so a NULL customer_type maps to Walk-in (NULL NOT IN
                -- (...) is NULL, which would otherwise fall through to Returning).
                WHEN COALESCE(LOWER(s.customer_type),'') NOT IN ('new','returning','registered') THEN 'Walk-in'
                -- No first_purchase match = unidentifiable (null/placeholder
                -- customer_id) → Walk-in, so New/Returning stays in lockstep with
                -- /api/customers seg (which INNER JOINs first_purchase).
                WHEN fp.first_purchase_date IS NULL THEN 'Walk-in'
                WHEN fp.first_purchase_date BETWEEN '""" + date_from + """'::date AND '""" + date_to + """'::date THEN 'New'
                ELSE 'Returning'
            END AS customer_segment,
            COUNT(DISTINCT s.customer_id) AS customers,
            COUNT(DISTINCT s.order_id) AS orders,
            ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.customer_id), 0), 0) AS spend_per_customer,
            ROUND(SUM(s.total_sales_kes::numeric) / NULLIF(COUNT(DISTINCT s.order_id), 0), 0) AS avg_basket_value
        FROM all_sales s
        LEFT JOIN first_purchase fp ON fp.customer_id = s.customer_id
        WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
        AND s.sale_kind = 'order'
        """ + country_filter + """
        GROUP BY customer_segment
        ORDER BY customer_segment
    """, date_to=date_to)


# ── Auth endpoints (self-hosted Postgres sessions) ────────────────────────────
# Login verifies a PBKDF2 password hash and issues an opaque session (returned as
# a bearer token AND set as an httpOnly cookie). The gate resolves that session
# back to `request.state.user` on every subsequent request.
def _login_cookie_kwargs():
    # httpOnly so JS can't read it; SameSite=Lax so the Google redirect carries
    # it; Secure because the Replit proxy always serves the app over HTTPS.
    return dict(httponly=True, samesite="lax", secure=True, path="/",
                max_age=_SESSION_TTL)


@app.get("/api/auth/me")
def auth_me(request: Request):
    u = getattr(request.state, "user", None) or {}
    if u:
        u = dict(u)
        u["hidden_pages"] = _hidden_pages()
        u["allowed_pages"] = _effective_pages_for_role(u.get("role"))
    return u


@app.get("/api/admin/page-visibility")
def admin_page_visibility_get(request: Request):
    return {"hidden_pages": _hidden_pages()}


@app.put("/api/admin/page-visibility")
async def admin_page_visibility_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    pages = body.get("hidden_pages")
    if not isinstance(pages, list):
        return JSONResponse(
            {"detail": "hidden_pages must be a list"}, status_code=400)
    return {"ok": True, "hidden_pages": _set_hidden_pages(pages)}


@app.get("/api/admin/group-pages")
def admin_group_pages_get(request: Request):
    """Per-group page access — effective list + built-in default for every
    selectable group, so the admin Group Access screen can render the checklist
    and offer a Reset to default."""
    ov = _role_page_overrides()
    groups, defaults, overridden = {}, {}, {}
    for role in VALID_ROLES:
        groups[role] = _effective_pages_for_role(role)
        defaults[role] = _default_pages_for_role(role)
        overridden[role] = (role != "admin") and (role in ov)
    return {
        "groups": groups,
        "defaults": defaults,
        "overridden": overridden,
        "page_catalog": sorted(ALL_PAGE_IDS),
    }


@app.put("/api/admin/group-pages")
async def admin_group_pages_put(request: Request):
    """Save a single group's allowed pages, or reset it to default. Body:
    {"role": "<group>", "pages": [...]} or {"role": "<group>", "reset": true}."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    role = (body.get("role") or "").strip().lower()
    if role not in VALID_ROLES:
        return JSONResponse({"detail": "Unknown group"}, status_code=400)
    if role == "admin":
        return JSONResponse(
            {"detail": "The Admin group always has full access and cannot be restricted"},
            status_code=400)
    try:
        if body.get("reset"):
            pages = _reset_role_pages(role)
        else:
            raw = body.get("pages")
            if not isinstance(raw, list):
                return JSONResponse({"detail": "pages must be a list"}, status_code=400)
            pages = _set_role_pages(role, raw)
    except ValueError as e:
        return JSONResponse({"detail": str(e)}, status_code=400)
    return {"ok": True, "role": role, "pages": pages}


@app.get("/api/auth/me/status")
def auth_me_status(request: Request):
    u = getattr(request.state, "user", None) or {}
    if u:
        u = dict(u)
        u["allowed_pages"] = _effective_pages_for_role(u.get("role"))
    return {"status": u.get("status", "active"), "role": u.get("role"), "user": u}


@app.post("/api/auth/login")
async def auth_login(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not email or not password:
        return JSONResponse({"detail": "Email and password are required"}, status_code=400)
    rows = _users_exec(
        "SELECT user_id, email, name, role, status, password_hash "
        "FROM app_users WHERE email=%s", (email,), fetch=True)
    rec = rows[0] if rows else None
    if not rec or not _verify_password(password, rec.get("password_hash")):
        return JSONResponse({"detail": "Invalid email or password"}, status_code=401)
    if rec["status"] == "rejected":
        return JSONResponse({"detail": "account_rejected"}, status_code=403)
    if rec["status"] == "disabled":
        return JSONResponse({"detail": "account_disabled"}, status_code=403)
    token = _create_session(rec["user_id"])
    try:
        _users_exec("UPDATE app_users SET last_login_at=now() WHERE user_id=%s",
                    (rec["user_id"],))
    except Exception:
        pass
    user = _user_dict(rec)
    user["hidden_pages"] = _hidden_pages()
    user["allowed_pages"] = _effective_pages_for_role(user.get("role"))
    resp = JSONResponse({"token": token, "user": user})
    resp.set_cookie("session_token", token, **_login_cookie_kwargs())
    return resp


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    _destroy_session(_extract_session_token(request))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session_token", path="/")
    return resp


# ── Google OAuth (Authorization Code flow, stdlib + requests) ─────────────────
def _google_redirect_uri(request: Request):
    # An explicit override wins (useful if the registered URI differs from the
    # request host). Otherwise derive it from the forwarded host so the same code
    # works in dev and production behind the Replit proxy.
    override = os.environ.get("GOOGLE_REDIRECT_URI")
    if override:
        return override
    proto = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    return f"{proto}://{host}/api/auth/google/callback"


def _safe_oauth_return(val):
    """Validate the optional ``return`` target for the OAuth callback.

    Only native-app deep links pointing at our own callback path are allowed
    (the mobile app passes its runtime redirect URL here so the session can be
    handed back). This is deliberately NOT a general web redirect — only the
    Expo/standalone app schemes are accepted, so it cannot be abused as an open
    redirect to an arbitrary website. Web clients omit the param and keep the
    default relative ``/auth/callback`` behavior.
    """
    if not val:
        return None
    val = val.strip()
    if len(val) > 512:
        return None
    if "auth/callback" not in val:
        return None
    # Expo Go uses exp:// (optionally exp+<slug>://), standalone builds use the
    # app's own scheme. Both only open this app, never a website.
    if re.match(r"^(vivo-mobile|exp|exp\+[a-z0-9._-]+)://", val):
        return val
    # Same-origin web path (e.g. "/crm/auth/callback"). Must be server-relative:
    # exactly one leading slash, no scheme/host, not protocol-relative ("//host").
    # This lets path-routed web apps (served under their own base path) get the
    # OAuth result back at their own callback instead of the root SPA's.
    if (val.startswith("/") and not val.startswith("//")
            and re.match(r"^/[A-Za-z0-9._/-]*auth/callback$", val)):
        return val
    return None


@app.get("/api/auth/google/login")
def auth_google_login(request: Request):
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        return JSONResponse(
            {"detail": "Google sign-in is not configured."}, status_code=503)
    state = secrets.token_urlsafe(24)
    return_to = _safe_oauth_return(request.query_params.get("return"))
    params = urlencode({
        "client_id": client_id,
        "redirect_uri": _google_redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    })
    resp = RedirectResponse(
        f"https://accounts.google.com/o/oauth2/v2/auth?{params}")
    # Short-lived state cookie for CSRF protection on the callback.
    resp.set_cookie("g_oauth_state", state, httponly=True, samesite="lax",
                    secure=True, max_age=600, path="/")
    # Remember where to hand the session back (mobile deep link). Absent for web.
    if return_to:
        resp.set_cookie("g_oauth_return", return_to, httponly=True,
                        samesite="lax", secure=True, max_age=600, path="/")
    return resp


@app.get("/api/auth/google/callback")
def auth_google_callback(request: Request):
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    # Where to hand the result back. Web uses the default relative path with a
    # URL fragment; the mobile app passes a native deep link (stored at login),
    # for which query params survive the OS hand-off more reliably than a #frag.
    return_to = _safe_oauth_return(request.cookies.get("g_oauth_return"))
    base = return_to or "/auth/callback"
    # Native deep links carry the token as a query param (survives the OS
    # hand-off more reliably); web targets (default root path or a relative
    # same-origin path like /crm/auth/callback) use a URL fragment, which the
    # SPA reads from window.location.hash.
    is_native = bool(return_to) and "://" in return_to
    sep = "?" if is_native else "#"

    def _back(suffix):
        r = RedirectResponse(f"{base}{sep}{suffix}")
        r.delete_cookie("g_oauth_return", path="/")
        return r

    if not client_id or not client_secret:
        return _back("error=not_configured")
    if request.query_params.get("error"):
        return _back("error=" + quote(request.query_params.get("error")))
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    cookie_state = request.cookies.get("g_oauth_state")
    if not code or not state or not cookie_state or not hmac.compare_digest(state, cookie_state):
        return _back("error=invalid_state")
    redirect_uri = _google_redirect_uri(request)
    try:
        tok = requests.post("https://oauth2.googleapis.com/token", data={
            "code": code, "client_id": client_id, "client_secret": client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        }, timeout=15)
    except Exception:
        return _back("error=token_exchange")
    if tok.status_code >= 400:
        return _back("error=token_exchange")
    access_token = (tok.json() or {}).get("access_token")
    if not access_token:
        return _back("error=token_exchange")
    try:
        prof = requests.get(
            "https://openidconnect.googleapis.com/v1/userinfo",
            headers={"Authorization": f"Bearer {access_token}"}, timeout=15)
    except Exception:
        return _back("error=profile")
    if prof.status_code >= 400:
        return _back("error=profile")
    info = prof.json() or {}
    email = (info.get("email") or "").strip().lower()
    # Require an explicitly verified email AND an allowed company domain. Treat a
    # missing/false email_verified as untrusted rather than letting it through.
    if info.get("email_verified") is not True or not clerk_auth.email_allowed(email):
        return _back("error=domain_not_allowed")
    sub = "google:" + str(info.get("sub") or email)
    name = info.get("name") or ""
    rec = resolve_app_user(sub, email, name)
    token = _create_session(rec["user_id"])
    resp = _back("token=" + quote(token))
    resp.set_cookie("session_token", token, **_login_cookie_kwargs())
    resp.delete_cookie("g_oauth_state", path="/")
    return resp

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
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.gross_sales_kes::numeric ELSE 0 END), 0) AS gross_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.discounts_kes::numeric ELSE 0 END), 0) AS discounts,
            ROUND(SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS returns,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY s.country
        ORDER BY total_sales DESC
    """, date_to=date_to)

def _daily_by_country_q(date_from, date_to, country=None, channel=None):
    if not date_from or not date_to:
        return {}
    # Net of returns so the per-country daily series reconciles to the headline
    # (variant A), matching /api/daily-trend. Returns subtract on their own date;
    # orders/units stay sale+order only.
    where = build_filters(date_from, date_to, country, channel)
    rows = run_query("""
        SELECT s.sale_date AS day, s.country,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END)
                - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales
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
            COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0), 0) AS total_sales,
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
    brand: str = Query(default=None),
    style_status: str = Query(default="all"),
    window_days: int = Query(default=180),
    country: str = Query(default=None),
    channel: str = Query(default=None),
):
    # Catalog-wide SOR audit — same row shape as the L-10 report
    # (SorStylesTable contract) but covering every style in the catalog
    # rather than just the 90-122 day new-style band. "Active" rows are
    # styles that sold a unit in the trailing `window_days`; "retired" are
    # styles with stock but no sales in the window; "all" is the union.
    win = int(window_days) if window_days and int(window_days) > 0 else 180
    brand_pf = ""
    if brand:
        brand_pf = " AND LOWER(brand) = '" + brand.strip().lower().replace("'", "''") + "'"
    cf, chf = _style_filters(country, channel, "s")
    raw = run_query(
        """
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(category) AS category,
                MAX(collection) AS collection,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number,
                MAX(price::numeric) AS original_price
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''""" + brand_pf + """
            GROUP BY style_name
        ),
        sales AS (
            SELECT p.style_name,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '""" + str(win) + """ days') AS units_6m,
                ROUND(SUM(s.net_sales_kes::numeric) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '""" + str(win) + """ days')) AS sales_6m,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '21 days') AS units_3w,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days') AS units_30d,
                -- Lifetime ("since launch") totals: no date filter, so they
                -- cover the style's full history (matches the report's "Units
                -- Since Launch" / "SOR Since Launch" columns). Still scoped by
                -- the country/channel filter via cf/chf below.
                SUM(s.net_quantity) AS units_since_launch,
                MAX(s.sale_date::date) AS last_sale,
                MIN(s.sale_date::date) AS first_sale
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IS NOT NULL AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT COALESCE(m.style_name, i.style_name) AS style_name,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_stores,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_warehouse
            FROM all_inventory i
            LEFT JOIN """ + SKU_STYLE_MAP + """ m ON m.sku = i.sku
            WHERE COALESCE(m.style_name, i.style_name) IS NOT NULL
            GROUP BY 1
        )
        SELECT p.style_name, p.brand, p.category, p.collection, p.subcategory,
            p.style_number, p.original_price,
            COALESCE(sa.units_6m, 0) AS units_6m, COALESCE(sa.sales_6m, 0) AS sales_6m,
            COALESCE(sa.units_3w, 0) AS units_3w, COALESCE(sa.units_30d, 0) AS units_30d,
            COALESCE(sa.units_since_launch, 0) AS units_since_launch,
            sa.last_sale, sa.first_sale,
            COALESCE(st.soh_stores, 0) AS soh_stores, COALESCE(st.soh_warehouse, 0) AS soh_warehouse
        FROM prod p
        LEFT JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        WHERE COALESCE(p.brand, '') NOT ILIKE '%third party%'
          AND (sa.units_6m IS NOT NULL OR st.soh_stores > 0 OR st.soh_warehouse > 0)
        """
    ) or []
    status = (style_status or "all").strip().lower()
    today = date.today()
    out = []
    for r in raw:
        units_6m = int(r["units_6m"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        soh_total = soh_stores + soh_warehouse
        # Style status semantics: active = sold in window; retired = has
        # stock but no sales in window; all = either. A manually-retired
        # style is force-treated as retired (never active, always satisfies
        # the retired filter regardless of stock) for cross-screen consistency.
        manual_retired = _is_manually_retired(r["style_name"])
        if status == "active":
            if units_6m <= 0 or manual_retired:
                continue
        elif status == "retired":
            if not manual_retired and (units_6m > 0 or soh_total <= 0):
                continue
        else:  # all
            if units_6m <= 0 and soh_total <= 0:
                continue
        sales_6m = float(r["sales_6m"] or 0)
        units_30d = int(r["units_30d"] or 0)
        last_sale = r["last_sale"]
        first_sale = r["first_sale"]
        weekly_avg = round(units_30d / (30.0 / 7.0), 1)
        woc = round(soh_total / weekly_avg, 1) if weekly_avg > 0 else None
        denom = units_6m + soh_total
        # Lifetime ("since launch") sell-through: lifetime net units over
        # lifetime units + current stock-on-hand, mirroring the 6m SOR formula.
        units_since_launch = int(r["units_since_launch"] or 0)
        life_denom = units_since_launch + soh_total
        age_days = (today - first_sale).days if first_sale else None
        original_price = r["original_price"]
        out.append({
            "style_name": r["style_name"],
            "brand": r["brand"],
            "category": r["category"],
            "collection": r["collection"],
            "subcategory": r["subcategory"],
            "style_number": r["style_number"],
            "sales_6m": round(sales_6m),
            "units_6m": units_6m,
            "units_3w": int(r["units_3w"] or 0),
            "units_since_launch": units_since_launch,
            "weekly_avg": weekly_avg,
            "soh_total": soh_total,
            "soh_wh": soh_warehouse,
            "woc": woc,
            "pct_in_wh": round(100.0 * soh_warehouse / soh_total, 1) if soh_total else 0.0,
            "asp_6m": round(sales_6m / units_6m) if units_6m > 0 else None,
            "original_price": round(float(original_price)) if original_price is not None else None,
            "days_since_last_sale": (today - last_sale).days if last_sale else None,
            "sor_6m": round(100.0 * units_6m / denom, 1) if denom > 0 else None,
            "sor_since_launch": round(100.0 * units_since_launch / life_denom, 1) if life_denom > 0 else None,
            "launch_date": str(first_sale) if first_sale else None,
            "style_age_weeks": round(age_days / 7.0) if age_days is not None else 0,
        })
    out.sort(key=lambda x: -(x["sales_6m"] or 0))
    return out

# ---------------------------------------------------------------------------
# Product Analysis cockpit — one canonical style-level dataset
# ---------------------------------------------------------------------------
# A single read-only endpoint that returns the CEO-grade style master for the
# selected period + scope, with sales AND current stock BOTH scoped by the
# store/country filter (store-scoped current stock, warehouse-excluded when
# "Overall", is the key fix that makes every figure tie out). Revenue defs
# mirror /api/kpis: revenue = SUM(total_sales_kes for sale/order) -
# SUM(returns_kes for return); net revenue likewise on net_sales_kes; ASP =
# revenue / SUM(ordered_item_quantity for sale/order). NOTE: this cockpit's
# `units` deliberately use SUM(net_quantity) (returns-netted, velocity/
# lifecycle-oriented) and therefore differ by the return volume from the gross
# "units sold" headline (/api/kpis.total_units, country-summary, products),
# which all use SUM(ordered_item_quantity for sale/order) = _UNITS.
# WOC + SOR reuse the shared velocity/sell-out shapes used elsewhere. The
# summary band + by-brand + by-sub-category rollups are derived in Python from
# the SAME canonical rows (rolled up to style grain) so they reconcile with
# the table exactly at any grain.

def _pa_safe_date(s, fallback):
    """Validate a YYYY-MM-DD date param before it is interpolated into SQL.
    The /api date-injection middleware already screens these, but we re-parse
    here as defense in depth (and to apply a sane fallback)."""
    try:
        return str(date.fromisoformat((s or "").strip()))
    except (ValueError, TypeError):
        return fallback


def _pa_in_filter(col, val, lower=False):
    """Build an ` AND col IN (...)` clause from a comma-separated filter value.
    Quotes are doubled so values can't break out of the SQL literal."""
    if not val:
        return ""
    vals = [v.strip() for v in str(val).split(",") if v.strip()]
    if not vals:
        return ""
    if lower:
        joined = ",".join("'" + v.lower().replace("'", "''") + "'" for v in vals)
        return " AND LOWER(" + col + ") IN (" + joined + ")"
    joined = ",".join("'" + v.replace("'", "''") + "'" for v in vals)
    return " AND " + col + " IN (" + joined + ")"


# Fixed primary-colour palette every raw colour string is mapped onto.
_PRIMARY_COLORS = [
    "Black", "White", "Grey", "Beige", "Brown", "Red", "Pink", "Orange",
    "Yellow", "Green", "Blue", "Purple", "Gold", "Silver", "Multi", "Other",
]

# Deterministic keyword map: substring -> primary. Checked before the LLM so the
# common long tail never needs a model call (and the page never breaks if the LLM
# is down). Order matters — more specific phrases first.
_PRIMARY_COLOR_RULES = [
    ("multi", "Multi"), ("print", "Multi"), ("floral", "Multi"), ("animal", "Multi"),
    ("stripe", "Multi"), ("check", "Multi"), ("aztec", "Multi"), ("ankara", "Multi"),
    ("leopard", "Multi"), ("camo", "Multi"), ("assorted", "Multi"), ("mixed", "Multi"),
    ("navy", "Blue"), ("denim", "Blue"), ("indigo", "Blue"), ("teal", "Blue"),
    ("turquoise", "Blue"), ("cobalt", "Blue"), ("aqua", "Blue"), ("sky", "Blue"),
    ("royal", "Blue"), ("blue", "Blue"),
    ("maroon", "Red"), ("burgundy", "Red"), ("wine", "Red"), ("crimson", "Red"),
    ("scarlet", "Red"), ("cherry", "Red"), ("red", "Red"),
    ("fuchsia", "Pink"), ("magenta", "Pink"), ("rose", "Pink"), ("blush", "Pink"),
    ("coral", "Pink"), ("salmon", "Pink"), ("pink", "Pink"),
    ("lavender", "Purple"), ("lilac", "Purple"), ("violet", "Purple"),
    ("plum", "Purple"), ("mauve", "Purple"), ("purple", "Purple"),
    ("rust", "Orange"), ("terracotta", "Orange"), ("apricot", "Orange"),
    ("peach", "Orange"), ("tangerine", "Orange"), ("orange", "Orange"),
    ("mustard", "Yellow"), ("buttermilk", "Yellow"), ("lemon", "Yellow"),
    ("ochre", "Yellow"), ("yellow", "Yellow"),
    ("olive", "Green"), ("mint", "Green"), ("lime", "Green"), ("sage", "Green"),
    ("emerald", "Green"), ("khaki", "Green"), ("green", "Green"),
    ("chocolate", "Brown"), ("tan", "Brown"), ("camel", "Brown"), ("coffee", "Brown"),
    ("mocha", "Brown"), ("caramel", "Brown"), ("bronze", "Brown"), ("brown", "Brown"),
    ("cream", "Beige"), ("ivory", "Beige"), ("nude", "Beige"), ("beige", "Beige"),
    ("taupe", "Beige"), ("sand", "Beige"), ("stone", "Beige"), ("oatmeal", "Beige"),
    ("off white", "Beige"), ("offwhite", "Beige"), ("ecru", "Beige"),
    ("charcoal", "Grey"), ("grey", "Grey"), ("gray", "Grey"), ("silver", "Silver"),
    ("gold", "Gold"), ("white", "White"), ("black", "Black"),
]

_PRIMARY_COLOR_MEM = {}  # in-process cache: raw_lower -> primary


def _primary_color_deterministic(raw):
    low = " " + raw.lower().strip() + " "
    for kw, prim in _PRIMARY_COLOR_RULES:
        if kw in low:
            return prim
    return None


def _primary_color_map(raw_colors):
    """Map a set of distinct raw colour strings to the fixed primary palette.

    Layered: in-process memo -> persistent ``color_primary_map`` table ->
    deterministic keyword rules -> a single batched LLM call for the long tail.
    Newly resolved values are persisted so the LLM is only ever consulted once
    per distinct colour. Never raises: any failure falls back to deterministic /
    'Other' so the endpoint always returns."""
    out = {}
    pending = []
    for raw in raw_colors:
        if not raw:
            continue
        key = raw.strip()
        if not key:
            continue
        low = key.lower()
        if low in _PRIMARY_COLOR_MEM:
            out[key] = _PRIMARY_COLOR_MEM[low]
        else:
            pending.append(key)
    if not pending:
        return out

    # Persistent cache lookup.
    try:
        _users_exec("""
            CREATE TABLE IF NOT EXISTS color_primary_map (
                raw_color     TEXT PRIMARY KEY,
                primary_color TEXT NOT NULL,
                source        TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        lows = sorted({p.lower() for p in pending})
        joined = ",".join("'" + v.replace("'", "''") + "'" for v in lows)
        cached = _users_exec(
            "SELECT raw_color, primary_color FROM color_primary_map"
            " WHERE raw_color IN (" + joined + ")", fetch=True) or []
        cmap = {r["raw_color"]: r["primary_color"] for r in cached}
    except Exception:
        cmap = {}

    still = []
    for key in pending:
        low = key.lower()
        if low in cmap:
            _PRIMARY_COLOR_MEM[low] = cmap[low]
            out[key] = cmap[low]
        else:
            still.append(key)

    # Deterministic rules resolve most of the remaining tail with no LLM call.
    llm_pending = []
    resolved = {}  # low -> (primary, source)
    for key in still:
        det = _primary_color_deterministic(key)
        if det:
            resolved[key.lower()] = (det, "rule")
            out[key] = det
            _PRIMARY_COLOR_MEM[key.lower()] = det
        else:
            llm_pending.append(key)

    # One batched LLM call for whatever the rules could not place.
    if llm_pending:
        ai = {}
        try:
            sample = llm_pending[:300]
            palette = ", ".join(_PRIMARY_COLORS)
            prompt = (
                "You map retail product colour names to a base colour family. "
                "Allowed families (use EXACTLY one per input): " + palette + ". "
                "Use 'Multi' for prints/patterns/multicolour, 'Other' only if truly none fit. "
                "Return ONLY a compact JSON object mapping each input string to its family.\n"
                "Inputs: " + json.dumps(sample)
            )
            txt = _chat_llm([{"role": "user", "content": prompt}], max_tokens=2000)
            if txt:
                s = txt.find("{")
                e = txt.rfind("}")
                if s != -1 and e != -1 and e > s:
                    parsed = json.loads(txt[s:e + 1])
                    valid = {c.lower(): c for c in _PRIMARY_COLORS}
                    for k, v in parsed.items():
                        vc = valid.get(str(v).strip().lower())
                        if vc:
                            ai[k] = vc
        except Exception:
            ai = {}
        for key in llm_pending:
            prim = ai.get(key) or ai.get(key.lower()) or "Other"
            resolved[key.lower()] = (prim, "llm" if key in ai or key.lower() in ai else "fallback")
            out[key] = prim
            _PRIMARY_COLOR_MEM[key.lower()] = prim

    # Persist everything newly resolved (rules + llm + fallback) so it is cheap
    # next time. Fallback 'Other' is persisted too but tagged so it can be
    # re-derived later if rules improve.
    if resolved:
        try:
            vals = ",".join(
                "('" + low.replace("'", "''") + "','" + prim.replace("'", "''") +
                "','" + src + "')"
                for low, (prim, src) in resolved.items())
            _users_exec(
                "INSERT INTO color_primary_map (raw_color, primary_color, source) VALUES "
                + vals + " ON CONFLICT (raw_color) DO NOTHING")
        except Exception:
            pass
    return out


def _split_colors(s):
    """Split an aggregated colour cell ('Gold, Green') into its tokens."""
    if not s:
        return []
    return [t.strip() for t in str(s).split(",") if t.strip()]


@app.get("/api/analytics/product-analysis")
def analytics_product_analysis(
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    country: str = Query(default=None),
    store: str = Query(default=None),
    brand: str = Query(default=None),
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    tier: str = Query(default=None),
    style_status: str = Query(default="all"),
    grain: str = Query(default="style"),
    dims: str = Query(default=None),
    velocity_days: int = Query(default=30),
    include_warehouse: bool = Query(default=False),
):
    df = _pa_safe_date(date_from, str(date.today() - timedelta(days=89)))
    dt = _pa_safe_date(date_to, str(date.today()))
    vel = velocity_days if isinstance(velocity_days, int) and velocity_days > 0 else 30
    vel = min(vel, 3650)
    grain = (grain or "style").strip().lower()
    # Row-explosion model: the table can be exploded to one value per row for any
    # subset of {colour, print, size} via the `dims` CSV param (driven by the
    # column picker). Each selected dimension becomes a GROUP BY key so a style
    # with several colours / prints / sizes returns one row per combination.
    # `grain` (legacy single dimension) is honoured as a fallback for old callers.
    DIM_SPECS = {
        # key -> (output column, source column in all_products_clean / all_inventory)
        "color": ("color", "color_print"),
        "print": ("print_plain", "print_plain"),
        "size": ("size", "size"),
    }
    DIM_ORDER = ["color", "print", "size"]
    if dims is not None:
        req = {x.strip().lower() for x in dims.split(",")} - {""}
    elif grain in ("color", "size"):
        req = {grain}
    else:
        req = set()
    sel_dims = [d for d in DIM_ORDER if d in req]
    # POS location is a special dimension: it does not live on the product master
    # (all_products_clean) but on the sales / inventory rows. When it is exploded
    # the final assembly switches from "prod-driven" joins to a sales⟗stock key
    # spine joined back to prod on style (see from_join below) so a style returns
    # one row per selling point — exactly like colour / print / size.
    pos_exploded = "pos_location" in req
    all_sel = sel_dims + (["pos_location"] if pos_exploded else [])

    style_status = (style_status or "all").strip().lower()
    if style_status not in ("active", "retired", "all"):
        style_status = "all"

    # Response cache: this endpoint runs a heavy lifetime full-scan of all_sales
    # (~1.6M rows). The result is identical for every user and changes slowly, so
    # cache the fully-computed response for 10 min keyed on all filter params.
    # (run_query also caches the SQL, but only ~120s; this keeps the page warm.)
    _pa_ck = "pa:" + "|".join(str(x) for x in (
        df, dt, country, store, brand, category, subcategory, tier,
        style_status, grain, ",".join(all_sel), vel, int(include_warehouse)))
    _pa_cached = cache_get(_pa_ck)
    if _pa_cached is not None:
        return _pa_cached

    cf, chf = _style_filters(country, store, "s")   # sales scope (store -> pos_location_name)
    icf, _ = _style_filters(country, None, "i")      # inventory country scope
    if store:
        current_loc_clause = "i.pos_location_name IN (" + csv_to_sql(store) + ")"
    elif include_warehouse:
        # Explicit "include warehouse" toggle: count stock in EVERY location
        # (retail stores + warehouse / holding locations) in the current scope.
        current_loc_clause = "i.pos_location_name IS NOT NULL"
    else:
        current_loc_clause = "i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"

    brand_pf = _pa_in_filter("brand", brand, lower=True)
    cat_pf = _pa_in_filter("category", category)
    subcat_pf = _pa_in_filter("product_type", subcategory)

    # Build the per-CTE dimension fragments. A selected dim is a group key in
    # prod / sales / stock and a USING join key; the colour / print / size
    # display columns are the group key when selected, else aggregated (colour /
    # print) or NULL (size). all_inventory has no print_plain, so when print is
    # exploded the stock CTE joins all_products_clean by sku (sku is unique there,
    # so no fan-out).
    prod_grp = ""
    sales_dim_sel = sales_dim_grp = ""
    stock_dim_sel = stock_dim_grp = ""
    join_dims = []
    need_stock_pc = False
    for d in sel_dims:
        out, src = DIM_SPECS[d]
        expr_p = "COALESCE(NULLIF(TRIM(" + src + "),''),'(none)')"
        expr_sa = "COALESCE(NULLIF(TRIM(p." + src + "),''),'(none)')"
        if d == "print":
            expr_st = "COALESCE(NULLIF(TRIM(pc.print_plain),''),'(none)')"
            need_stock_pc = True
        elif d == "color":
            # all_inventory.color_print is ~93% NULL and UPPERCASE where present
            # ('BLACK'), so it does NOT match all_products_clean.color_print
            # ('Black'). Joining stock on i.color_print collapses the colour
            # explosion to a handful of '(none)' rows (the "blank Colour" bug).
            # Derive the stock colour from the product master via sku instead, so
            # all three CTEs share one consistent colour key.
            expr_st = "COALESCE(NULLIF(TRIM(pc.color_print),''),'(none)')"
            need_stock_pc = True
        else:
            expr_st = "COALESCE(NULLIF(TRIM(i." + src + "),''),'(none)')"
        prod_grp += ", " + expr_p
        sales_dim_sel += ", " + expr_sa + " AS " + out
        sales_dim_grp += ", " + expr_sa
        stock_dim_sel += ", " + expr_st + " AS " + out
        stock_dim_grp += ", " + expr_st
        join_dims.append(out)

    def _disp(key):
        out, src = DIM_SPECS[key]
        if key in sel_dims:
            return "COALESCE(NULLIF(TRIM(" + src + "),''),'(none)') AS " + out
        if key == "color":
            return "string_agg(DISTINCT NULLIF(TRIM(color_print),''), ', ') AS color"
        if key == "print":
            return "string_agg(DISTINCT NULLIF(TRIM(print_plain),''), ', ') AS print_plain"
        return "NULL::text AS size"

    prod_disp = ", " + _disp("color") + ", " + _disp("print") + ", " + _disp("size")
    stock_from = " FROM all_inventory i LEFT JOIN " + SKU_STYLE_MAP + " m ON m.sku = i.sku"
    if need_stock_pc:
        stock_from += " JOIN all_products_clean pc ON pc.sku = i.sku"
    join_keys = " USING (style_name" + ("".join(", " + j for j in join_dims)) + ")"

    # POS explosion: add pos_location_name as a group key in the sales & stock
    # CTEs only (it is not a product attribute), drop warehouse rows from stock so
    # only real selling points become rows, and switch the final FROM to a
    # sales⟗stock spine joined back to prod on style (+ any product dims).
    sales_pos_sel = sales_pos_grp = sales_pos_where = ""
    stock_pos_sel = stock_pos_grp = stock_pos_where = ""
    if pos_exploded:
        sales_pos_sel = ", s.pos_location_name AS pos_location"
        sales_pos_grp = ", s.pos_location_name"
        stock_pos_sel = ", i.pos_location_name AS pos_location"
        stock_pos_grp = ", i.pos_location_name"
        # Only real selling points become rows: drop warehouse / holding locations
        # from stock (current_loc_clause) and from sales (a store filter already
        # restricts sales; otherwise exclude the same warehouse set).
        stock_pos_where = " AND (" + current_loc_clause + ")"
        if not store and not include_warehouse:
            sales_pos_where = " AND s.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"
        spine_keys = " USING (style_name" + ("".join(", " + j for j in join_dims)) + ", pos_location)"
        prod_keys = " USING (style_name" + ("".join(", " + j for j in join_dims)) + ")"
        from_join = (" FROM sales sa FULL OUTER JOIN stock st" + spine_keys +
                     " JOIN prod p" + prod_keys)
        pos_out = " pos_location,"
        # Only selling points that currently hold inventory become rows (a style
        # with no stock at a POS is not part of that location's live range).
        activity_where = " WHERE COALESCE(st.soh_current,0) > 0"
    else:
        from_join = (" FROM prod p LEFT JOIN sales sa" + join_keys +
                     " LEFT JOIN stock st" + join_keys)
        pos_out = " st.store_locations AS pos_location,"
        # Only styles that currently hold inventory (stores or warehouse) are in scope.
        activity_where = (" WHERE (COALESCE(st.soh_current,0) > 0"
                          " OR COALESCE(st.soh_warehouse,0) > 0 OR COALESCE(st.soh_stores,0) > 0)")

    # The sales CTE is the heavy lifetime full-scan. When the table is NOT exploded
    # by any product dim / POS, is not store-scoped, and uses the default 30-day
    # velocity window, the lifetime / trailing-window measures (units_vel, life,
    # 6m, 24m, current_price) are exactly what the pa_style rollup materialises, so
    # we serve them from the rollup and keep only the cheap date-bounded period
    # measures live. The split: period_sales = a date-bounded live scan (only the
    # df..dt window), life = the rollup re-aggregated per country, FULL OUTER JOINed
    # on style. KES sums are stored unrounded and ROUNDed after re-aggregation so
    # the All total matches the live round-of-sum; current_price merges across
    # countries by most-recent valid-price date (parity-verified except inherent
    # same-date ties). Any explosion / store / non-default velocity → live path.
    pa_use_rollup = (not sel_dims and not pos_exploded and not store
                     and vel == 30 and _rollup_fresh("pa_style"))
    if pa_use_rollup:
        pa_sales_block = (
            "period_sales AS ("
            " SELECT p.style_name,"
            " COALESCE(SUM(s.net_quantity),0) AS units_period,"
            " COALESCE(ROUND(SUM(" + _PA_KES_CASE + ")),0) AS revenue_period,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes"
            " WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)),0) AS net_revenue_period,"
            " COALESCE(SUM(" + _PA_GROSS_CASE + "),0) AS gross_units_period,"
            " COUNT(DISTINCT s.order_id) FILTER (WHERE s.sale_kind IN ('sale','order')) AS orders_period"
            " FROM all_products_clean p JOIN all_sales s ON s.variant_sku = p.sku"
            " WHERE p.style_name IS NOT NULL AND p.style_name <> ''"
            " AND COALESCE(p.brand,'') NOT ILIKE '%third party%'"
            " AND s.sale_date BETWEEN '" + df + "' AND '" + dt + "' AND " + BASE_FILTERS + cf + chf +
            " GROUP BY p.style_name"
            "),"
            "life AS ("
            " SELECT style_name,"
            " COALESCE(SUM(units_vel),0) AS units_vel,"
            " SUM(units_life) AS units_life,"
            " COALESCE(ROUND(SUM(sales_life)),0) AS sales_life,"
            " COALESCE(SUM(units_6m),0) AS units_6m,"
            " COALESCE(ROUND(SUM(revenue_6m)),0) AS revenue_6m,"
            " COALESCE(SUM(gross_units_6m),0) AS gross_units_6m,"
            " COALESCE(SUM(units_24m),0) AS units_24m,"
            " COALESCE(ROUND(SUM(revenue_24m)),0) AS revenue_24m,"
            " COALESCE(SUM(gross_units_24m),0) AS gross_units_24m,"
            " MAX(last_sale) AS last_sale,"
            " MIN(first_sale) AS first_sale,"
            " (array_agg(current_price ORDER BY current_price_date DESC NULLS LAST)"
            " FILTER (WHERE current_price IS NOT NULL))[1] AS current_price"
            " FROM rollup_pa_style" + _rollup_country_where(country) +
            " GROUP BY style_name"
            "),"
            "sales AS ("
            " SELECT COALESCE(ps.style_name, life.style_name) AS style_name,"
            " COALESCE(ps.units_period,0) AS units_period, COALESCE(ps.revenue_period,0) AS revenue_period,"
            " COALESCE(ps.net_revenue_period,0) AS net_revenue_period,"
            " COALESCE(ps.gross_units_period,0) AS gross_units_period,"
            " COALESCE(ps.orders_period,0) AS orders_period,"
            " COALESCE(life.units_vel,0) AS units_vel, life.units_life, COALESCE(life.sales_life,0) AS sales_life,"
            " COALESCE(life.units_6m,0) AS units_6m, COALESCE(life.revenue_6m,0) AS revenue_6m,"
            " COALESCE(life.gross_units_6m,0) AS gross_units_6m,"
            " COALESCE(life.units_24m,0) AS units_24m, COALESCE(life.revenue_24m,0) AS revenue_24m,"
            " COALESCE(life.gross_units_24m,0) AS gross_units_24m,"
            " life.last_sale, life.first_sale, life.current_price"
            " FROM period_sales ps FULL OUTER JOIN life ON life.style_name = ps.style_name"
            "),"
        )
    else:
        pa_sales_block = (
            "sales AS ("
            " SELECT p.style_name" + sales_dim_sel + sales_pos_sel + ","
            " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "'),0) AS units_period,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes"
            " WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)"
            " FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "')),0) AS revenue_period,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes"
            " WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)"
            " FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "')),0) AS net_revenue_period,"
            " COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END)"
            " FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "'),0) AS gross_units_period,"
            " COUNT(DISTINCT s.order_id) FILTER (WHERE s.sale_kind IN ('sale','order')"
            " AND s.sale_date BETWEEN '" + df + "' AND '" + dt + "') AS orders_period,"
            " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '" + str(vel) + " days'),0) AS units_vel,"
            " SUM(s.net_quantity) AS units_life,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)),0) AS sales_life,"
            " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days'),0) AS units_6m,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days')),0) AS revenue_6m,"
            " COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '180 days'),0) AS gross_units_6m,"
            " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days'),0) AS units_24m,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days')),0) AS revenue_24m,"
            " COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '730 days'),0) AS gross_units_24m,"
            " MAX(s.sale_date::date) AS last_sale,"
            " MIN(s.sale_date::date) FILTER (WHERE s.sale_kind IN ('sale','order')) AS first_sale,"
            " (array_agg(s.product_price_kes ORDER BY s.sale_date DESC) FILTER ("
            " WHERE s.sale_kind IN ('sale','order') AND s.product_price_kes IS NOT NULL"
            " AND s.product_price_kes > 0))[1] AS current_price"
            " FROM all_products_clean p JOIN all_sales s ON s.variant_sku = p.sku"
            " WHERE p.style_name IS NOT NULL AND p.style_name <> ''"
            " AND COALESCE(p.brand,'') NOT ILIKE '%third party%' AND " + BASE_FILTERS + cf + chf + sales_pos_where +
            " GROUP BY p.style_name" + sales_dim_grp + sales_pos_grp +
            "),"
        )

    sql = (
        "WITH prod AS ("
        " SELECT style_name,"
        " MAX(brand) AS brand, MAX(category) AS category, MAX(product_type) AS subcategory,"
        " MAX(collection) AS collection, MAX(season) AS season, MAX(style_number) AS style_number,"
        " MAX(price) AS full_price, MIN(price) AS price_min, MAX(price) AS price_max,"
        " MIN(substring(style_launch_date,1,10)) FILTER ("
        " WHERE substring(style_launch_date,1,10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') AS launch_date,"
        " COUNT(DISTINCT NULLIF(TRIM(size),'')) AS sizes_count,"
        " COUNT(DISTINCT NULLIF(TRIM(color_print),'')) AS colors_count,"
        # Representative SKU for the row's product image. Prefer a SKU that
        # actually has an image (Odoo image_512 OR a Shopify image URL, matched
        # V-prefix-insensitively the same way the image endpoints expand), so a
        # style/colour with photos never shows a placeholder just because the
        # alphabetically-first SKU happens to lack one. Deterministic MIN(sku)
        # tiebreak keeps the choice stable.
        " (array_agg(sku ORDER BY (im.norm_sku IS NOT NULL) DESC, sku ASC))[1] AS rep_sku"
        + prod_disp +
        " FROM all_products_clean"
        " LEFT JOIN (SELECT DISTINCT norm_sku FROM ("
        "   SELECT regexp_replace(m.sku,'^[Vv]','') AS norm_sku"
        "     FROM product_image_map m JOIN product_images i ON i.tmpl_id = m.tmpl_id"
        "     WHERE i.image_512 IS NOT NULL AND i.image_512 <> ''"
        "   UNION"
        "   SELECT regexp_replace(sku,'^[Vv]','') AS norm_sku FROM product_image_urls"
        " ) z) im ON im.norm_sku = regexp_replace(sku,'^[Vv]','')"
        " WHERE style_name IS NOT NULL AND style_name <> ''"
        " AND COALESCE(brand,'') NOT ILIKE '%third party%'" + brand_pf + cat_pf + subcat_pf +
        " GROUP BY style_name" + prod_grp +
        "),"
        + pa_sales_block +
        "stock AS ("
        " SELECT COALESCE(m.style_name, i.style_name) AS style_name" + stock_dim_sel + stock_pos_sel + ","
        " COALESCE(SUM(i.available) FILTER (WHERE " + current_loc_clause + "),0) AS soh_current,"
        " COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name IN (" + WAREHOUSE_LOCATIONS + ")),0) AS soh_warehouse,"
        " COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")),0) AS soh_stores,"
        " string_agg(DISTINCT i.pos_location_name, ', ' ORDER BY i.pos_location_name)"
        " FILTER (WHERE i.available > 0 AND (" + current_loc_clause + ")) AS store_locations"
        + stock_from + " WHERE COALESCE(m.style_name, i.style_name) IS NOT NULL AND COALESCE(m.style_name, i.style_name) <> ''" + icf + stock_pos_where +
        " GROUP BY 1" + stock_dim_grp + stock_pos_grp +
        ")"
        " SELECT p.style_name, p.rep_sku,"
        " p.brand, p.category, p.subcategory, p.collection, p.season, p.style_number,"
        " p.color, p.print_plain, p.size,"
        " p.full_price, p.price_min, p.price_max, p.launch_date, p.sizes_count, p.colors_count,"
        " COALESCE(sa.units_period,0) AS units_period, COALESCE(sa.revenue_period,0) AS revenue_period,"
        " COALESCE(sa.net_revenue_period,0) AS net_revenue_period, COALESCE(sa.gross_units_period,0) AS gross_units_period,"
        " COALESCE(sa.orders_period,0) AS orders_period, COALESCE(sa.units_vel,0) AS units_vel,"
        " COALESCE(sa.units_life,0) AS units_life, COALESCE(sa.sales_life,0) AS sales_life,"
        " COALESCE(sa.units_6m,0) AS units_6m, COALESCE(sa.revenue_6m,0) AS revenue_6m, COALESCE(sa.gross_units_6m,0) AS gross_units_6m,"
        " COALESCE(sa.units_24m,0) AS units_24m, COALESCE(sa.revenue_24m,0) AS revenue_24m, COALESCE(sa.gross_units_24m,0) AS gross_units_24m,"
        " sa.last_sale, sa.first_sale,"
        " COALESCE(st.soh_current,0) AS soh_current, COALESCE(st.soh_warehouse,0) AS soh_warehouse,"
        " COALESCE(st.soh_stores,0) AS soh_stores," + pos_out + " sa.current_price"
        + from_join + activity_where
    )

    raw = run_query(sql)
    today = date.today()
    wk = vel / 7.0

    def _woc(stock, uvel):
        wa = (uvel / wk) if wk > 0 else 0
        return round(stock / wa, 1) if wa > 0 else None

    def _sor(units, stock):
        denom = units + stock
        return round(units * 100.0 / denom, 1) if denom > 0 else None

    def _life_cycle(aw, lifetime_sor=None, full_price_pct=None, last_sale_days=None,
                    woc=None, reorder_count=0, recent_sor=None, recent_units=None):
        # Descriptive label for the 2026 Range Strategy GATED lifecycle tier (the
        # same gates as the Range Management classify endpoint), mapped to words
        # so it is not confused with the Pareto revenue "Tier" column. Styles that
        # fail their gate surface as "Retire".
        return {
            "Tier 1": "Core",
            "Tier 2": "Core Performer",
            "Tier 3": "Recent Performer",
            "Tier 4": "New / Test",
            "Retire": "Retire",
        }.get(_gated_range_tier(
            aw, lifetime_sor=lifetime_sor, full_price_pct=full_price_pct,
            last_sale_days=last_sale_days, woc=woc, reorder_count=reorder_count,
            recent_sor=recent_sor, recent_units=recent_units),
            "New / Test")

    rows = []
    for r in raw:
        units = int(r["units_period"] or 0)
        revenue = float(r["revenue_period"] or 0)
        net_rev = float(r["net_revenue_period"] or 0)
        gross_units = int(r["gross_units_period"] or 0)
        units_vel = int(r["units_vel"] or 0)
        units_life = int(r["units_life"] or 0)
        stock = int(r["soh_current"] or 0)
        first_sale = r["first_sale"]
        launch = _parse_iso_date(r["launch_date"]) or first_sale
        age_weeks = round((today - launch).days / 7.0) if launch else None
        full_price = round(float(r["full_price"])) if r["full_price"] is not None else None
        current_price = round(float(r["current_price"])) if r["current_price"] is not None else None
        asp = round(revenue / gross_units) if gross_units > 0 else None
        units_6m = int(r["units_6m"] or 0)
        revenue_6m = float(r["revenue_6m"] or 0)
        gross_units_6m = int(r["gross_units_6m"] or 0)
        units_24m = int(r["units_24m"] or 0)
        revenue_24m = float(r["revenue_24m"] or 0)
        gross_units_24m = int(r["gross_units_24m"] or 0)
        sales_life = float(r["sales_life"] or 0)
        asp_6m = round(revenue_6m / gross_units_6m) if gross_units_6m > 0 else None
        asp_24m = round(revenue_24m / gross_units_24m) if gross_units_24m > 0 else None
        avg_price_life = round(sales_life / units_life) if units_life > 0 else None
        # Full Price % = lifetime avg selling price ÷ full ticket price (capped at
        # 100), matching the Range Management report's definition.
        full_price_pct = round(min(100.0, avg_price_life * 100.0 / full_price), 1) \
            if (avg_price_life is not None and full_price not in (None, 0)) else None
        days_since_launch = (today - launch).days if launch else None
        weeks_since_launch = round(days_since_launch / 7.0) if days_since_launch is not None else None
        age_years = round(days_since_launch / 365.25, 1) if days_since_launch is not None else None
        units_per_week = round(units_vel / wk, 1) if wk > 0 else None
        reorder_count = int(age_weeks // 12) if age_weeks else 0
        price_min = round(float(r["price_min"])) if r["price_min"] is not None else None
        price_max = round(float(r["price_max"])) if r["price_max"] is not None else None
        sor_6m = _sor(units_6m, stock)
        sor_life = _sor(units_life, stock)
        last_sale_days = (today - r["last_sale"]).days if r["last_sale"] else None
        life_cycle = _life_cycle(age_weeks, sor_life, full_price_pct, last_sale_days,
                                 _woc(stock, units_vel), reorder_count,
                                 recent_sor=sor_6m, recent_units=units_6m)
        rows.append({
            "style_name": r["style_name"],
            "sku": r["rep_sku"],
            "style_number": r["style_number"],
            "brand": r["brand"],
            "category": r["category"],
            "subcategory": r["subcategory"],
            "color": r["color"],
            "print": r["print_plain"],
            "size": r["size"],
            "collection": r["collection"],
            "season": r["season"],
            "units_sold": units,
            "revenue": round(revenue),
            "net_revenue": round(net_rev),
            "orders": int(r["orders_period"] or 0),
            "current_stock": stock,
            "warehouse_stock": int(r["soh_warehouse"] or 0),
            "store_stock": int(r["soh_stores"] or 0),
            "pos_location": r["pos_location"] or None,
            "units_vel": units_vel,
            "units_life": units_life,
            "woc": _woc(stock, units_vel),
            "sor": _sor(units, stock),
            "sor_since_launch": _sor(units_life, stock),
            "asp": asp,
            "full_price": full_price,
            "current_price": current_price,
            "launch_date": str(launch) if launch else None,
            "age_weeks": age_weeks,
            "age_years": age_years,
            "days_since_launch": days_since_launch,
            "weeks_since_launch": weeks_since_launch,
            "units_per_week": units_per_week,
            "reorder_count": reorder_count,
            "life_cycle": life_cycle,
            "units_6m": units_6m,
            "revenue_6m": round(revenue_6m),
            "asp_6m": asp_6m,
            "sor_6m": sor_6m,
            "units_24m": units_24m,
            "revenue_24m": round(revenue_24m),
            "asp_24m": asp_24m,
            "sales_life": round(sales_life),
            "avg_price_life": avg_price_life,
            "full_price_pct": full_price_pct,
            "price_min": price_min,
            "price_max": price_max,
            "last_sale": str(r["last_sale"]) if r["last_sale"] else None,
            "sizes_count": int(r["sizes_count"] or 0),
            "colors_count": int(r["colors_count"] or 0),
        })

    # Roll the (possibly dim-grain) rows up to STYLE grain so the status filter
    # and the summary/by-brand/by-subcategory rollups are computed consistently
    # and reconcile with the table at any grain.
    styles = {}
    for row in rows:
        k = row["style_name"]
        g = styles.get(k)
        if not g:
            g = {"units": 0, "revenue": 0, "net_revenue": 0, "stock": 0, "units_vel": 0,
                 "brand": row["brand"], "category": row["category"], "subcategory": row["subcategory"]}
            styles[k] = g
        g["units"] += row["units_sold"]
        g["revenue"] += row["revenue"]
        g["net_revenue"] += row["net_revenue"]
        g["stock"] += row["current_stock"]
        g["units_vel"] += row["units_vel"]

    def _is_active(g):
        return g["units_vel"] > 0

    keep = set()
    status_by_style = {}
    for k, g in styles.items():
        manual_retired = _is_manually_retired(k)
        # A manually-retired style is force-treated as retired: never "active",
        # and it always satisfies the "retired" filter regardless of stock.
        active = _is_active(g) and not manual_retired
        status_by_style[k] = "Active" if active else "Retired"
        if style_status == "active" and not active:
            continue
        # Universe is already inventory-only, so "retired" = every non-active style
        # (incl. warehouse-only stock); this keeps Active + Retired == Total.
        if style_status == "retired" and active:
            continue
        keep.add(k)

    rows = [r for r in rows if r["style_name"] in keep]
    for r in rows:
        r["style_status"] = status_by_style.get(r["style_name"])
    kept = {k: g for k, g in styles.items() if k in keep}

    # Range tier — Pareto on cumulative revenue share over the kept styles
    # (T1 <= 20%, T2 <= 60%, T3 <= 90%, T4 the rest). Computed over the FULL
    # kept population so the ranking is stable, THEN the optional tier filter
    # narrows the table + the summary/by-brand/by-subcategory rollups (exactly
    # like the brand/category filters do).
    ranked = sorted(kept.items(), key=lambda kv: -(kv[1]["revenue"] or 0))
    tot_rev_all = sum((g["revenue"] or 0) for _, g in ranked)
    tier_by_style = {}
    cum = 0.0
    for k, g in ranked:
        cum += (g["revenue"] or 0)
        share = (cum / tot_rev_all) if tot_rev_all > 0 else 1.0
        if share <= 0.20:
            t = "T1"
        elif share <= 0.60:
            t = "T2"
        elif share <= 0.90:
            t = "T3"
        else:
            t = "T4"
        tier_by_style[k] = t
        g["tier"] = t
    for r in rows:
        r["tier"] = tier_by_style.get(r["style_name"])

    tier_sel = {x.strip().upper() for x in str(tier).split(",")} - {""} if tier else set()
    if tier_sel:
        rows = [r for r in rows if (r.get("tier") in tier_sel)]
        kept = {k: g for k, g in kept.items() if tier_by_style.get(k) in tier_sel}

    tot_units = sum(g["units"] for g in kept.values())
    tot_rev = sum(g["revenue"] for g in kept.values())
    tot_net = sum(g["net_revenue"] for g in kept.values())
    tot_stock = sum(g["stock"] for g in kept.values())
    tot_vel = sum(g["units_vel"] for g in kept.values())
    summary = {
        "styles": len(kept),
        # Use the same effective status as the row-level style_status (velocity AND
        # not manually retired) so active_styles == Total - Retired reconciles.
        "active_styles": sum(1 for k in kept if status_by_style.get(k) == "Active"),
        "units": tot_units,
        "revenue": tot_rev,
        "net_revenue": tot_net,
        "stock_units": tot_stock,
        "avg_sor": _sor(tot_units, tot_stock),
        "avg_woc": _woc(tot_stock, tot_vel),
    }

    brands_map = {}
    for g in kept.values():
        b = g["brand"] or "Unknown"
        bb = brands_map.setdefault(b, {"brand": b, "styles": 0, "units": 0, "revenue": 0, "stock": 0, "units_vel": 0})
        bb["styles"] += 1
        bb["units"] += g["units"]
        bb["revenue"] += g["revenue"]
        bb["stock"] += g["stock"]
        bb["units_vel"] += g["units_vel"]
    by_brand = []
    for bb in brands_map.values():
        bb["sor"] = _sor(bb["units"], bb["stock"])
        bb["woc"] = _woc(bb["stock"], bb["units_vel"])
        by_brand.append(bb)
    by_brand.sort(key=lambda x: -x["revenue"])

    total_styles = len(kept) or 1
    sub_map = {}
    for g in kept.values():
        sc = g["subcategory"] or "Unknown"
        ss = sub_map.setdefault(sc, {"subcategory": sc, "category": g["category"], "styles": 0,
                                     "units": 0, "revenue": 0, "stock": 0, "units_vel": 0})
        ss["styles"] += 1
        ss["units"] += g["units"]
        ss["revenue"] += g["revenue"]
        ss["stock"] += g["stock"]
        ss["units_vel"] += g["units_vel"]
    by_subcategory = []
    for ss in sub_map.values():
        ss["pct_range"] = round(ss["styles"] * 100.0 / total_styles, 1)
        ss["pct_stock"] = round(ss["stock"] * 100.0 / tot_stock, 1) if tot_stock else 0.0
        ss["pct_units"] = round(ss["units"] * 100.0 / tot_units, 1) if tot_units else 0.0
        ss["pct_revenue"] = round(ss["revenue"] * 100.0 / tot_rev, 1) if tot_rev else 0.0
        ss["woc"] = _woc(ss["stock"], ss["units_vel"])
        by_subcategory.append(ss)
    by_subcategory.sort(key=lambda x: -x["revenue"])

    # Primary colour (AI-assisted): map each row's raw colour string(s) onto a
    # fixed base palette. Done over the final kept rows so we only classify the
    # colours actually returned. Results are cached so the LLM is consulted at
    # most once per distinct colour ever.
    try:
        tokens = set()
        for r in rows:
            for t in _split_colors(r.get("color")):
                tokens.add(t)
        cmap = _primary_color_map(tokens) if tokens else {}
        for r in rows:
            prims = []
            for t in _split_colors(r.get("color")):
                p = cmap.get(t) or cmap.get(t.strip())
                if p and p not in prims:
                    prims.append(p)
            r["primary_color"] = ", ".join(prims) if prims else None
    except Exception:
        for r in rows:
            r.setdefault("primary_color", None)

    resp = {
        "rows": rows,
        "summary": summary,
        "by_brand": by_brand,
        "by_subcategory": by_subcategory,
        "scope": {
            "store": store or None, "country": country or None,
            "date_from": df, "date_to": dt, "velocity_days": vel,
            "grain": grain, "dims": ",".join(all_sel), "style_status": style_status,
        },
    }
    cache_set(_pa_ck, resp, ttl=600)
    return resp


@app.get("/api/analytics/product-analysis/style")
def analytics_product_analysis_style(
    style: str = Query(...),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    country: str = Query(default=None),
    store: str = Query(default=None),
):
    """Per-style drill-down: size breakdown, colour breakdown, and current stock
    by store location ("what's sitting where"). Sales are period/scope-scoped;
    the location view shows ALL locations (country-scoped) so transfers can be
    reasoned about, with the warehouse flagged."""
    df = _pa_safe_date(date_from, str(date.today() - timedelta(days=89)))
    dt = _pa_safe_date(date_to, str(date.today()))
    st_lit = "'" + (style or "").replace("'", "''") + "'"
    cf, chf = _style_filters(country, store, "s")
    icf, _ = _style_filters(country, None, "i")
    if store:
        current_loc_clause = "i.pos_location_name IN (" + csv_to_sql(store) + ")"
    else:
        current_loc_clause = "i.pos_location_name NOT IN (" + WAREHOUSE_LOCATIONS + ")"

    def _dim_break(dim_col):
        return run_query(
            "WITH sales AS ("
            " SELECT COALESCE(NULLIF(TRIM(p." + dim_col + "),''),'(none)') AS k,"
            " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "'),0) AS units,"
            " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes"
            " WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)"
            " FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "')),0) AS revenue"
            " FROM all_products_clean p JOIN all_sales s ON s.variant_sku = p.sku"
            " WHERE p.style_name = " + st_lit + " AND " + BASE_FILTERS + cf + chf +
            " GROUP BY 1"
            "), stock AS ("
            " SELECT COALESCE(NULLIF(TRIM(i." + dim_col + "),''),'(none)') AS k,"
            " COALESCE(SUM(i.available) FILTER (WHERE " + current_loc_clause + "),0) AS stock"
            " FROM all_inventory i WHERE i.style_name = " + st_lit + icf +
            " GROUP BY 1"
            ") SELECT COALESCE(sa.k, st.k) AS k, COALESCE(sa.units,0) AS units,"
            " COALESCE(sa.revenue,0) AS revenue, COALESCE(st.stock,0) AS stock"
            " FROM sales sa FULL OUTER JOIN stock st USING (k)"
            " ORDER BY units DESC, stock DESC"
        )

    by_size = [{"size": x["k"], "units": int(x["units"] or 0),
                "revenue": int(float(x["revenue"] or 0)), "stock": int(x["stock"] or 0)}
               for x in _dim_break("size")]
    by_color = [{"color": x["k"], "units": int(x["units"] or 0),
                 "revenue": int(float(x["revenue"] or 0)), "stock": int(x["stock"] or 0)}
                for x in _dim_break("color_print")]

    loc = run_query(
        "WITH stock AS ("
        " SELECT i.pos_location_name AS location, MAX(i.country) AS country,"
        " COALESCE(SUM(i.available),0) AS stock"
        " FROM all_inventory i WHERE i.style_name = " + st_lit + icf +
        " GROUP BY i.pos_location_name"
        "), sales AS ("
        " SELECT s.pos_location_name AS location,"
        " COALESCE(SUM(s.net_quantity) FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "'),0) AS units,"
        " COALESCE(ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes"
        " WHEN s.sale_kind='return' THEN -s.returns_kes ELSE 0 END)"
        " FILTER (WHERE s.sale_date BETWEEN '" + df + "' AND '" + dt + "')),0) AS revenue"
        " FROM all_products_clean p JOIN all_sales s ON s.variant_sku = p.sku"
        " WHERE p.style_name = " + st_lit + " AND " + BASE_FILTERS + cf +
        " GROUP BY s.pos_location_name"
        ") SELECT COALESCE(st.location, sa.location) AS location,"
        " st.country AS country,"
        " COALESCE(st.stock,0) AS stock,"
        " COALESCE(sa.units,0) AS units,"
        " COALESCE(sa.revenue,0) AS revenue,"
        " (COALESCE(st.location, sa.location) IN (" + WAREHOUSE_LOCATIONS + ")) AS is_warehouse"
        " FROM stock st FULL OUTER JOIN sales sa ON st.location = sa.location"
        " WHERE COALESCE(st.stock,0) <> 0 OR COALESCE(sa.units,0) <> 0 OR COALESCE(sa.revenue,0) <> 0"
        " ORDER BY units DESC, stock DESC"
    )
    by_location = [{"location": x["location"], "country": x["country"],
                    "stock": int(x["stock"] or 0), "units": int(x["units"] or 0),
                    "revenue": int(float(x["revenue"] or 0)),
                    "is_warehouse": bool(x["is_warehouse"])}
                   for x in loc]

    return {
        "style": style,
        "by_size": by_size,
        "by_color": by_color,
        "by_location": by_location,
        "scope": {"store": store or None, "country": country or None, "date_from": df, "date_to": dt},
    }


def _product_ai_core(body):
    """Grounded "what to act on" narrative for the Product Analysis range. The
    client posts the canonical summary + a few short lists (overstock / top
    sellers / slow movers) computed from the same rows; we format the facts and
    ask the LLM for a concise executive read. Plain text, never JSON."""
    scope = str(body.get("scope_label") or "the range").strip()[:120]
    date_label = str(body.get("date_label") or "").strip()[:80]
    s = body.get("summary") or {}

    def _g(k):
        try:
            v = s.get(k)
            return None if v is None else float(v)
        except (TypeError, ValueError):
            return None

    def _money(v):
        return "KES %s" % format(round(v), ",") if v is not None else "n/a"

    def _num(v):
        return format(round(v), ",") if v is not None else "n/a"

    def _lst(items, fmt):
        out = []
        for it in (items or [])[:8]:
            try:
                out.append(fmt(it))
            except (TypeError, ValueError, KeyError, AttributeError):
                continue
        return "; ".join(out) if out else "none"

    overstock = _lst(
        body.get("overstock"),
        lambda it: "%s (WOC %s, %s units stock)" % (
            str(it.get("style_name") or it.get("style") or "")[:48],
            ("%.0f" % float(it.get("woc"))) if it.get("woc") is not None else "n/a",
            _num(float(it.get("current_stock") or it.get("stock") or 0)),
        ),
    )
    top_sellers = _lst(
        body.get("top_sellers"),
        lambda it: "%s (%s units, %s)" % (
            str(it.get("style_name") or it.get("style") or "")[:48],
            _num(float(it.get("units_sold") or it.get("units") or 0)),
            _money(float(it.get("revenue") or 0)),
        ),
    )
    slow = _lst(
        body.get("slow_movers"),
        lambda it: "%s (SOR %s%%, %s units stock)" % (
            str(it.get("style_name") or it.get("style") or "")[:48],
            ("%.0f" % float(it.get("sor"))) if it.get("sor") is not None else "n/a",
            _num(float(it.get("current_stock") or it.get("stock") or 0)),
        ),
    )

    facts = (
        "Scope: %s. Period: %s.\n"
        "Range summary: %s active styles, %s units sold, %s revenue, %s units of current stock, "
        "average sell-out rate %s%%, average weeks-of-cover %s.\n"
        "Overstocked (high weeks-of-cover): %s.\n"
        "Top sellers: %s.\n"
        "Slow movers (low sell-out, stock on hand): %s."
    ) % (
        scope, date_label or "selected period",
        _num(_g("active_styles") if _g("active_styles") is not None else _g("styles")),
        _num(_g("units")), _money(_g("revenue")), _num(_g("stock_units")),
        ("%.0f" % _g("avg_sor")) if _g("avg_sor") is not None else "n/a",
        ("%.1f" % _g("avg_woc")) if _g("avg_woc") is not None else "n/a",
        overstock, top_sellers, slow,
    )
    sys = (
        "You are a retail merchandising analyst for Vivo Fashion Group, a "
        "multi-brand fashion retailer in East Africa (Kenya/Uganda/Rwanda + "
        "Online). All money is in Kenyan Shillings (KES). You are given a "
        "snapshot of a product range: a summary plus lists of overstocked, "
        "best-selling, and slow-moving styles. Write a concise, decision-useful "
        "'what to act on' narrative (4-6 sentences, <=140 words): what to "
        "reorder or chase, what to mark down or clear, and where stock is "
        "imbalanced. Use the exact figures and style names provided; do not "
        "invent numbers. Plain prose, no markdown headers, no bullet lists, no "
        "emojis."
    )
    narrative = (_chat_llm(
        [{"role": "system", "content": sys},
         {"role": "user", "content": facts}],
        max_tokens=380,
    ) or "").strip()
    if not narrative:
        return {"available": False, "reason": "empty"}
    return {"available": True, "narrative": narrative}


@app.post("/api/analytics/product-analysis/ai")
async def product_analysis_ai_post(request: Request):
    """AI range narrative for the Product Analysis page. Mirrors the trend/
    projection AI pattern: the AI key is server-only, so the client posts the
    grounded summary and we run the LLM here. Always returns gracefully — the
    narrative is an enhancement, never a blocker."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {"available": False, "reason": "ai_not_configured"}
    try:
        return await _chat_run_in_threadpool(_product_ai_core, body or {})
    except Exception:
        return {"available": False, "reason": "ai_error"}


def _catalogue_ask_core(body):
    """Map a natural-language question to the best dashboard page using the
    catalogue index the client posts (frontend is the single source of truth)."""
    question = (body.get("question") or "").strip()
    pages = body.get("pages") or []
    if not question:
        return {"available": False, "reason": "empty_question"}
    if not isinstance(pages, list) or not pages:
        return {"available": False, "reason": "no_catalogue"}
    lines = []
    for p in pages[:120]:
        if not isinstance(p, dict):
            continue
        route = str(p.get("route") or "").strip()
        label = str(p.get("label") or "").strip()
        purpose = str(p.get("purpose") or "").strip()
        reports = p.get("reports") or []
        if isinstance(reports, list):
            rep = "; ".join(str(r)[:90] for r in reports[:14])
        else:
            rep = str(reports)[:280]
        lines.append("- route=%s | page=%s | purpose=%s | reports: %s"
                     % (route, label, purpose, rep))
    catalog_txt = "\n".join(lines)
    sys = (
        "You are the report finder for the Vivo Fashion Group BI dashboard, a "
        "multi-brand fashion retailer in East Africa (money in KES). You are given "
        "a CATALOGUE of dashboard pages — each with its route, name, purpose and the "
        "reports/metrics it contains. Given the user's question, pick the SINGLE best "
        "page that answers it, plus up to 2 genuinely related pages. Only choose "
        "routes that appear in the catalogue. Reply with STRICT JSON only (no markdown, "
        "no prose around it), shaped exactly: "
        '{"route": "/x", "label": "Page Name", '
        '"answer": "one or two sentences telling the user exactly where to look and which report to open", '
        '"related": [{"route": "/y", "label": "Other Page"}]}. '
        "If nothing in the catalogue fits, set route to null and say so briefly in answer."
    )
    usr = "CATALOGUE:\n%s\n\nQUESTION: %s" % (catalog_txt, question)
    raw = _chat_llm(
        [{"role": "system", "content": sys},
         {"role": "user", "content": usr}],
        max_tokens=320,
    )
    data = _chat_extract_json(raw or "")
    if not isinstance(data, dict):
        return {"available": False, "reason": "parse_error"}
    valid_routes = {str(p.get("route") or "") for p in pages if isinstance(p, dict)}
    route = data.get("route")
    if route and route not in valid_routes:
        route = None
    related = []
    for r in (data.get("related") or []):
        if isinstance(r, dict) and str(r.get("route") or "") in valid_routes:
            related.append({"route": r.get("route"), "label": r.get("label")})
        if len(related) >= 2:
            break
    return {
        "available": True,
        "route": route,
        "label": data.get("label"),
        "answer": (data.get("answer") or "").strip(),
        "related": related,
    }


@app.post("/api/catalogue/ask")
async def catalogue_ask_post(request: Request):
    """AI report-finder for the Catalogue page. The client posts its question plus
    the catalogue index; we run the LLM server-side (the AI key is server-only) and
    return the best-matching page + route. Always returns gracefully — the AI hint
    is an enhancement on top of the client-side keyword search, never a blocker."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {"available": False, "reason": "ai_not_configured"}
    try:
        return await _chat_run_in_threadpool(_catalogue_ask_core, body or {})
    except Exception:
        return {"available": False, "reason": "ai_error"}


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
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 AND p.style_name IS NOT NULL")
    # Phase 2 A6/A1 — rate_of_sale & weeks_of_cover use the standardized
    # recency-weighted weekly velocity (last 28 days double-weighted over a
    # 12-week-equivalent denominator, computed on a trailing 56-day window) so
    # cover figures agree with /weeks-of-cover and /replenish-by-color. The
    # selected-period units_sold / total_sales remain for the displayed totals.
    vel_cc = _country_channel_filter(country, channel)
    rows = run_query("""
        WITH sales AS (
            SELECT p.style_name, p.brand, p.product_type,
                SUM(s.ordered_item_quantity) AS units_sold,
                ROUND(SUM(s.total_sales_kes::numeric), 0) AS total_sales
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.style_name, p.brand, p.product_type
        ),
        vel AS (
            SELECT p.style_name,
                SUM(s.ordered_item_quantity) FILTER (
                    WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '28 days') AS u28,
                SUM(s.ordered_item_quantity) AS u56
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order') AND p.style_name IS NOT NULL
              AND s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
              AND """ + vel_cc + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT p.style_name, SUM(i.available) AS current_stock
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY p.style_name
        ),
        base AS (
            SELECT sa.style_name, sa.brand, sa.product_type,
                sa.units_sold, sa.total_sales,
                COALESCE(st.current_stock, 0) AS current_stock,
                ((COALESCE(v.u28, 0) * 2)
                  + GREATEST(COALESCE(v.u56, 0) - COALESCE(v.u28, 0), 0)) / 12.0 AS weekly_units
            FROM sales sa
            LEFT JOIN vel v ON v.style_name = sa.style_name
            LEFT JOIN stock st ON sa.style_name = st.style_name
        )
        SELECT style_name, brand, product_type, units_sold, total_sales, current_stock,
            ROUND(weekly_units, 1) AS rate_of_sale,
            ROUND(current_stock / NULLIF(weekly_units, 0), 1) AS weeks_of_cover,
            ROUND(units_sold * 100.0 /
                NULLIF(units_sold + current_stock, 0), 1) AS sell_through
        FROM base
        ORDER BY rate_of_sale DESC NULLS LAST
        LIMIT 5000
    """, date_to=date_to)
    for r in rows:
        r["velocity_method"] = "ewma_56d"
    return rows

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
        dem AS (
            SELECT p.style_name, NULLIF(TRIM(p.size), '') AS size, SUM(s.net_quantity) AS u
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
              AND p.style_name IS NOT NULL AND NULLIF(TRIM(p.size), '') IS NOT NULL
            GROUP BY p.style_name, NULLIF(TRIM(p.size), '')
        ),
        whstock AS (
            SELECT p.style_name, NULLIF(TRIM(p.size), '') AS size, SUM(i.available) AS a
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
              AND i.available > 0
              AND p.style_name IS NOT NULL AND NULLIF(TRIM(p.size), '') IS NOT NULL
            GROUP BY p.style_name, NULLIF(TRIM(p.size), '')
        ),
        curve AS (
            SELECT c.style_name,
                COUNT(*) AS total_sizes,
                COUNT(*) FILTER (WHERE COALESCE(st.avail, 0) > 0) AS sizes_in_stock,
                string_agg(CASE WHEN COALESCE(st.avail, 0) <= 0 THEN c.size END, ', ' ORDER BY c.size) AS missing_sizes,
                SUM(COALESCE(d.u, 0) * (CASE WHEN COALESCE(st.avail, 0) > 0 THEN 1 ELSE 0 END)) AS dem_in_stock,
                SUM(COALESCE(d.u, 0)) AS dem_total,
                bool_or(COALESCE(st.avail, 0) <= 0 AND COALESCE(w.a, 0) > 0) AS ibt_opportunity
            FROM catalog c
            LEFT JOIN stock st ON c.style_name = st.style_name AND c.size = st.size
            LEFT JOIN dem d ON c.style_name = d.style_name AND c.size = d.size
            LEFT JOIN whstock w ON c.style_name = w.style_name AND c.size = w.size
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
            COALESCE(
                ROUND(cu.dem_in_stock * 100.0 / NULLIF(cu.dem_total, 0), 0),
                ROUND(cu.sizes_in_stock * 100.0 / NULLIF(cu.total_sizes, 0), 0)
            ) AS demand_weighted_health,
            COALESCE(cu.ibt_opportunity, false) AS ibt_opportunity,
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

@app.get("/api/finance/pl")
def finance_pl(
    date_from: str = Query(default=str(date(date.today().year - 1, date.today().month, 1))),
    date_to:   str = Query(default=str(date.today())),
):
    """Monthly Profit & Loss from the finance_pl_summary view — the official Odoo
    P&L structure: Revenue (revenue_odoo) → Less Costs of Revenue
    (cogs / production / purchases → total_costs_of_revenue) → Gross Profit → Less
    Operating Expenses (employment / admin / establishment / selling / marketing /
    finance_charges / other_opex → total_operating_expenses) → Operating Income
    (DERIVED = gross_profit - total_operating_expenses) → Plus Other Income → Net
    Profit. Also carries net_revenue_pipeline (sales-pipeline revenue, for the
    Odoo-vs-pipeline variance report) and the data-integrity flags is_closed /
    has_cost_anomaly.

    Returns the FULL month history (`months`) as a constant query → cached by
    run_query so the expensive finance_pl_summary view is computed ONCE rather than
    re-scanned per period change. The frontend windows the rows to the selected
    [date_from, date_to] client-side and uses the full list to populate its
    month-range selector. date_from/date_to are accepted for API symmetry and
    validated, but the query is intentionally un-windowed (do NOT add a second
    full-view scan — it doubles the cost). Read-only; reuses the shared pool."""
    _ = _validate_date_param(date_from), _validate_date_param(date_to)
    months = run_query("""
        SELECT month, gross_sales, returns, net_revenue_pipeline, revenue_odoo,
               cogs, production, purchases, total_costs_of_revenue, gross_profit,
               employment, admin, establishment, selling, marketing,
               finance_charges, other_opex, total_operating_expenses,
               (gross_profit - total_operating_expenses) AS operating_income,
               other_income, net_profit, is_closed, has_cost_anomaly
        FROM finance_pl_summary
        ORDER BY month
    """)
    return {"months": months}


@app.get("/api/finance/pl-detail")
def finance_pl_detail(
    date_from: str = Query(default=str(date(date.today().year - 1, date.today().month, 1))),
    date_to:   str = Query(default=str(date.today())),
):
    """Account-level P&L detail for the selected month window. Joins
    raw_account_move_lines to finance_account_map and sums each account with the
    correct sign convention (revenue / other_income = credit - debit; costs &
    operating expenses = debit - credit) so figures reconcile to
    finance_pl_summary. Grouped by pl_section, pl_group, account_code,
    account_name; flat array ordered by section, group, amount desc. Powers the
    group→account drill-downs on the P&L statement, the Operating-Expenses
    analysis and the Cost-of-Revenue report. Windowed server-side (cheap vs the
    full view). Date params validated by the /api edge middleware AND here."""
    df = _validate_date_param(date_from) or str(date(date.today().year - 1, date.today().month, 1))
    dt = _validate_date_param(date_to) or str(date.today())
    sign = ("CASE WHEN m.pl_section IN ('revenue','other_income') "
            "THEN l.credit - l.debit ELSE l.debit - l.credit END")
    rows = run_query("""
        SELECT m.pl_section, m.pl_group, l.account_code, l.account_name,
               ROUND(SUM(""" + sign + """), 0) AS amount
        FROM raw_account_move_lines l
        JOIN finance_account_map m ON m.account_code = l.account_code
        WHERE l.date >= date_trunc('month', DATE '""" + df + """')
          AND l.date <  date_trunc('month', DATE '""" + dt + """') + INTERVAL '1 month'
        GROUP BY m.pl_section, m.pl_group, l.account_code, l.account_name
        HAVING ROUND(SUM(""" + sign + """), 0) <> 0
        ORDER BY m.pl_section, m.pl_group, amount DESC
    """, date_to=dt)
    return {"detail": rows}


@app.get("/api/finance/expense-by-vendor")
def finance_expense_by_vendor(
    date_from: str = Query(default=str(date(date.today().year - 1, date.today().month, 1))),
    date_to:   str = Query(default=str(date.today())),
    category:  str = Query(default=None),
    limit:     int = Query(default=50),
):
    """Top vendors / suppliers by spend over the selected month window. Sums
    debit - credit on raw_account_move_lines for cost-of-revenue + operating-
    expense accounts, grouped by partner_name, excluding null/blank partners,
    ordered desc. Optional `category` narrows to a single pl_group (whitelisted to
    keep it un-injectable). Windowed server-side. Read-only."""
    df = _validate_date_param(date_from) or str(date(date.today().year - 1, date.today().month, 1))
    dt = _validate_date_param(date_to) or str(date.today())
    lim = max(1, min(int(limit or 50), 500))
    cat = (category or "").strip()
    valid_groups = {"cogs", "production", "purchases", "employment", "admin",
                    "establishment", "selling", "marketing", "finance_charges", "other_opex"}
    cat_sql = (" AND m.pl_group = '" + cat + "'") if cat in valid_groups else ""
    rows = run_query("""
        SELECT l.partner_name AS vendor,
               ROUND(SUM(l.debit - l.credit), 0) AS spend
        FROM raw_account_move_lines l
        JOIN finance_account_map m ON m.account_code = l.account_code
        WHERE m.pl_section IN ('costs_of_revenue','operating_expenses')""" + cat_sql + """
          AND l.partner_name IS NOT NULL AND btrim(l.partner_name) <> ''
          AND l.date >= date_trunc('month', DATE '""" + df + """')
          AND l.date <  date_trunc('month', DATE '""" + dt + """') + INTERVAL '1 month'
        GROUP BY l.partner_name
        HAVING ROUND(SUM(l.debit - l.credit), 0) <> 0
        ORDER BY spend DESC
        LIMIT """ + str(lim) + """
    """, date_to=dt)
    return {"vendors": rows}


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
    # Phase 2 A6 — weekly_units per SKU uses the standardized recency-weighted
    # velocity (28d ×2 over a 12-week-equivalent denominator on a trailing 56d
    # window). For aged stock it is near-zero by definition, which is the point:
    # it quantifies how slowly each SKU is actually moving.
    rows = run_query("""
        WITH last_sale AS (
            SELECT variant_sku AS sku, MAX(sale_date) AS last_sold,
                SUM(CASE WHEN sale_date::date >= CURRENT_DATE - INTERVAL '180 days'
                         THEN ordered_item_quantity ELSE 0 END) AS units_180,
                SUM(CASE WHEN sale_date::date >= CURRENT_DATE - INTERVAL '28 days'
                         THEN ordered_item_quantity ELSE 0 END) AS u28,
                SUM(CASE WHEN sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
                         THEN ordered_item_quantity ELSE 0 END) AS u56
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
            COALESCE(NULLIF(MAX(p.product_name), ''), MAX(i.product_name)) AS product_name,
            MAX(p.size) AS size,
            MAX(p.barcode) AS barcode,
            MAX(i.color_print) AS color,
            COALESCE(MAX(ls.units_180), 0) AS units_sold_180d,
            SUM(i.available) AS soh,
            COALESCE(MAX(wh.soh_warehouse), 0) AS soh_warehouse,
            ROUND(((COALESCE(MAX(ls.u28), 0) * 2)
                   + GREATEST(COALESCE(MAX(ls.u56), 0) - COALESCE(MAX(ls.u28), 0), 0)) / 12.0, 2) AS weekly_units,
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
    for r in rows:
        r["velocity_method"] = "ewma_56d"
    return rows

@app.get("/api/analytics/warehouse-return-candidates")
def analytics_warehouse_return_candidates(
    mode:     str = Query(default="aged"),
    min_days: int = Query(default=30),
):
    """Store SKUs that are candidates to be returned to the warehouse, for the
    Warehouse Returns page. Two modes:

      * 'aged'    — stock that has not sold AT ITS STORE in >= min_days days
                    (never-sold SKUs included, surfaced with the 999 sentinel).
      * 'retired' — stock of RETIRED styles: no company-wide sales in the last
                    182 days, OR on the manual-retirement list (force-included
                    even if they still sell, honouring _is_manually_retired so
                    this page agrees with Range Mgmt / Product Analysis).

    One row per SKU-store with store SOH (soh), warehouse SOH (soh_warehouse),
    days-since-last-sale and `already_marked` (true once it has been marked for a
    warehouse return). Warehouses themselves are excluded as the destination."""
    m = "retired" if str(mode).lower() == "retired" else "aged"
    n = max(0, int(min_days))
    if m == "aged":
        where_extra = ("AND (ls.last_sold IS NULL "
                       "OR ls.last_sold::date < CURRENT_DATE - ("
                       + str(n) + " || ' days')::interval)")
    else:
        where_extra = ("AND (COALESCE(ss.units_182, 0) = 0 "
                       "OR p.style_name IN (" + _MANUAL_RETIRED_IN_SQL + "))")
    rows = run_query("""
        WITH last_sale AS (
            SELECT pos_location_name AS pos_location, variant_sku AS sku,
                MAX(sale_date) AS last_sold,
                SUM(CASE WHEN sale_date::date >= CURRENT_DATE - INTERVAL '180 days'
                         THEN ordered_item_quantity ELSE 0 END) AS units_180
            FROM all_sales
            WHERE sale_kind IN ('sale','order')
            GROUP BY pos_location_name, variant_sku
        ),
        style_sales AS (
            SELECT p.style_name,
                SUM(CASE WHEN s.sale_date::date >= CURRENT_DATE - INTERVAL '182 days'
                         THEN s.ordered_item_quantity ELSE 0 END) AS units_182
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order')
            GROUP BY p.style_name
        ),
        wh AS (
            SELECT sku, SUM(available) AS soh_warehouse
            FROM all_inventory
            WHERE pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
            GROUP BY sku
        ),
        marked AS (
            SELECT split_part(rec_key,'|',1) AS pos_location,
                   split_part(rec_key,'|',3) AS sku
            FROM recommendation_actions
            WHERE rec_type='warehouse_return' AND status='done'
        )
        SELECT i.pos_location_name AS pos_location,
            i.sku,
            COALESCE(NULLIF(MAX(p.product_name), ''), NULLIF(MAX(i.product_name), ''), MAX(p.style_name)) AS product_name,
            MAX(p.size) AS size,
            MAX(p.barcode) AS barcode,
            MAX(i.color_print) AS color,
            MAX(p.style_name) AS style_name,
            COALESCE(MAX(ls.units_180), 0) AS units_sold_180d,
            SUM(i.available) AS soh,
            COALESCE(MAX(wh.soh_warehouse), 0) AS soh_warehouse,
            CASE WHEN MAX(ls.last_sold) IS NULL THEN 999
                 ELSE (CURRENT_DATE - MAX(ls.last_sold)::date) END AS days_since_last_sale,
            MAX(ls.last_sold) AS last_sale_date,
            BOOL_OR(m.sku IS NOT NULL) AS already_marked
        FROM all_inventory i
        LEFT JOIN last_sale ls
            ON i.sku = ls.sku AND i.pos_location_name = ls.pos_location
        LEFT JOIN wh ON i.sku = wh.sku
        LEFT JOIN all_products_clean p ON i.sku = p.sku
        LEFT JOIN style_sales ss ON p.style_name = ss.style_name
        LEFT JOIN marked m
            ON m.pos_location = i.pos_location_name AND m.sku = i.sku
        WHERE i.available > 0
        AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
        """ + where_extra + """
        GROUP BY i.pos_location_name, i.sku
        ORDER BY days_since_last_sale DESC, soh DESC
        LIMIT 1500
    """)
    return {"mode": m, "min_days": n, "rows": rows}

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
    channel:   str = Query(default=None),
):
    # ── Walk-in (anonymous transaction) definition ─────────────────────────────
    # An "anonymous transaction" = a sale with no real identified customer profile
    # attached: in-store walk-ins for Retail + guest checkouts for Online.
    # Counting rule: each anonymous TRANSACTION (order) counts as 1 walk-in
    # customer. A transaction is anonymous when ANY of the following holds:
    #   (a) customer_id is missing ('', NULL, 'None', 'null'),
    #   (b) customer_type is the literal 'walk-in', or
    #   (c) customer_id resolves to a placeholder / brand pseudo-account
    #       (name matches _WALKIN_NAME_REGEX) — the SAME accounts /api/customers
    #       excludes from the identified universe, so walk-ins + identified = total.
    # (Counting only customer_id IS NULL — the old logic — missed buckets (b)/(c)
    #  and surfaced as a near-zero walk-in count on the dashboard.)
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order')")
    anon_expr = (
        "(s.customer_id IS NULL OR s.customer_id IN ('None','null','') "
        "OR s.customer_type ILIKE 'walk-in' "
        "OR ps.customer_id IS NOT NULL)"
    )
    pseudo_cte = (
        "pseudo AS (SELECT DISTINCT customer_id FROM all_customers "
        "WHERE customer_id IS NOT NULL AND (COALESCE(first_name,'') || ' ' || "
        "COALESCE(last_name,'')) ~* '" + _WALKIN_NAME_REGEX + "')"
    )

    def _shares(r):
        wi, tot = r.get("walk_in_orders") or 0, r.get("total_orders") or 0
        ws, ts = float(r.get("walk_in_sales") or 0), float(r.get("total_sales") or 0)
        r["walk_in_customers"] = wi
        r["walk_in_share_orders_pct"] = round(wi * 100.0 / tot, 4) if tot else 0
        r["walk_in_share_sales_pct"] = round(ws * 100.0 / ts, 4) if ts else 0
        r["walk_in_avg_basket_kes"] = round(ws / wi, 0) if wi else 0
        r["capture_rate_pct"] = round(100.0 - (wi * 100.0 / tot), 2) if tot else None
        return r

    agg_sql = "WITH " + pseudo_cte + """
        SELECT
            COUNT(DISTINCT s.order_id) AS total_orders,
            COUNT(DISTINCT s.order_id) FILTER (WHERE """ + anon_expr + """) AS walk_in_orders,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
            COALESCE(ROUND(SUM(s.total_sales_kes::numeric) FILTER (WHERE """ + anon_expr + """), 0), 0) AS walk_in_sales
        FROM all_sales s
        LEFT JOIN pseudo ps ON ps.customer_id = s.customer_id
        WHERE """ + where
    top = run_query(agg_sql, date_to=date_to)
    summary = _shares(top[0]) if top else {
        "total_orders": 0, "walk_in_orders": 0, "total_sales": 0, "walk_in_sales": 0,
        "walk_in_customers": 0, "walk_in_share_orders_pct": 0,
        "walk_in_share_sales_pct": 0, "walk_in_avg_basket_kes": 0, "capture_rate_pct": None,
    }

    by_country = [
        _shares(r) for r in run_query("WITH " + pseudo_cte + """
            SELECT s.country AS country,
                COUNT(DISTINCT s.order_id) AS total_orders,
                COUNT(DISTINCT s.order_id) FILTER (WHERE """ + anon_expr + """) AS walk_in_orders,
                COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
                COALESCE(ROUND(SUM(s.total_sales_kes::numeric) FILTER (WHERE """ + anon_expr + """), 0), 0) AS walk_in_sales
            FROM all_sales s
            LEFT JOIN pseudo ps ON ps.customer_id = s.customer_id
            WHERE """ + where + """ AND COALESCE(s.country,'') <> ''
            GROUP BY s.country
            HAVING COUNT(DISTINCT s.order_id) FILTER (WHERE """ + anon_expr + """) > 0
            ORDER BY walk_in_orders DESC""", date_to=date_to)
    ]

    by_location = [
        _shares(r) for r in run_query("WITH " + pseudo_cte + """
            SELECT s.pos_location_name AS channel, MAX(s.country) AS country,
                COUNT(DISTINCT s.order_id) AS total_orders,
                COUNT(DISTINCT s.order_id) FILTER (WHERE """ + anon_expr + """) AS walk_in_orders,
                COALESCE(ROUND(SUM(s.total_sales_kes::numeric), 0), 0) AS total_sales,
                COALESCE(ROUND(SUM(s.total_sales_kes::numeric) FILTER (WHERE """ + anon_expr + """), 0), 0) AS walk_in_sales
            FROM all_sales s
            LEFT JOIN pseudo ps ON ps.customer_id = s.customer_id
            WHERE """ + where + """ AND COALESCE(s.pos_location_name,'') <> ''
            GROUP BY s.pos_location_name
            HAVING COUNT(DISTINCT s.order_id) FILTER (WHERE """ + anon_expr + """) > 0
            ORDER BY walk_in_orders DESC""", date_to=date_to)
    ]

    # ── Incomplete profile (identified customers missing name/phone/email) ──────
    # Identified = real customers active in the period (have a customer_id, not a
    # null/pseudo placeholder). Reuses the same exclusion as /api/customers so the
    # "of N identified" denominator matches the Total Identified Customers tile.
    country_filter = ("AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    channel_filter = ("AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    ip_rows = run_query("""
        WITH excluded AS (
            SELECT DISTINCT customer_id FROM all_customers
            WHERE customer_id IS NOT NULL
              AND (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ~* '""" + _WALKIN_NAME_REGEX + """'
        ),
        cust_profile AS (
            SELECT customer_id,
                MAX(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')) AS prof_name,
                MAX(NULLIF(TRIM(COALESCE(phone,'')), '')) AS prof_phone,
                MAX(NULLIF(TRIM(COALESCE(email,'')), '')) AS prof_email
            FROM all_customers WHERE customer_id IS NOT NULL GROUP BY customer_id
        ),
        period_customers AS (
            SELECT DISTINCT s.customer_id
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND s.sale_kind IN ('sale','order')
              AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')
              AND s.customer_id NOT IN (SELECT customer_id FROM excluded)
              AND """ + BASE_FILTERS + " " + country_filter + " " + channel_filter + """
        )
        SELECT
            COUNT(*) AS identified_total,
            COUNT(*) FILTER (WHERE cp.customer_id IS NULL
                OR cp.prof_name IS NULL OR cp.prof_phone IS NULL OR cp.prof_email IS NULL) AS customers,
            COUNT(*) FILTER (WHERE cp.customer_id IS NULL OR cp.prof_name  IS NULL) AS no_name,
            COUNT(*) FILTER (WHERE cp.customer_id IS NULL OR cp.prof_phone IS NULL) AS no_phone,
            COUNT(*) FILTER (WHERE cp.customer_id IS NULL OR cp.prof_email IS NULL) AS no_email
        FROM period_customers p
        LEFT JOIN cust_profile cp ON cp.customer_id = p.customer_id
    """, date_to=date_to)
    ip = ip_rows[0] if ip_rows else {"identified_total": 0, "customers": 0, "no_name": 0, "no_phone": 0, "no_email": 0}
    ip_total = ip.get("identified_total") or 0
    ip["share_pct"] = round((ip.get("customers") or 0) * 100.0 / ip_total, 1) if ip_total else 0

    return {
        **summary,
        "walk_in_sales_kes": summary.get("walk_in_sales", 0),
        "total_sales_kes": summary.get("total_sales", 0),
        "detection_rule": "customer_id missing OR customer_type='walk-in' OR placeholder/brand pseudo-account",
        "truncated": False,
        "degraded": False,
        "by_country": by_country,
        "by_location": by_location,
        "incomplete_profile": ip,
    }


# ══════════════════════════════════════════════════════════════════════════════
# IBT (Inter-Branch Transfer) — real data
#   Store-to-store moves a SKU from a store where the style is barely selling
#   (≤ low_pct of the style's per-store average) but has stock, to a store
#   selling strongly (≥ high_pct of average) but running low. Warehouses are
#   excluded. Warehouse-to-store covers shop-floor gaps from warehouse stock.
# ══════════════════════════════════════════════════════════════════════════════

def _sql_str(s):
    return (s or "").replace("'", "''")

def _ibt_suggestions_sql(date_from, date_to, country, low, high, lim, use_clustering=True):
    """Shared IBT suggestions SQL builder (Phase 1 audit B6 + Phase 2 A4/B4).

    Phase 1: excludes dead-stock styles (>16 weeks cover AND <5% sell-through
    over 56 days) from both donor and recipient sides.

    Phase 2:
      - A4 0-100 composite score (donor excess 40%, need urgency 40%,
        sell-through 20%); rows ORDER BY score DESC.
      - Removes the DISTINCT ON (style) one-pair-per-style cap so every valid
        donor->needer pair is returned (capped only by `lim`). `pair_count` is a
        per-style window count of all pairs for that style.
      - B4 store clustering: stores are tiered A/B/C by 90-day revenue
        (NTILE(3)); when use_clustering=True only pairs in the same or an
        adjacent tier are emitted (A<->B, B<->C; A<->C blocked) and the demand
        baseline avg_u is computed within the *destination* store's cluster
        (falling back to the chain-wide average when the cluster has no signal).

    Reused by both /analytics/ibt-suggestions and /ibt/late-count."""
    c_sales = ("AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = ("AND i.country = '" + _sql_str(country) + "'") if country else ""
    if use_clustering:
        avg_expr = "COALESCE(NULLIF(cs.avg_u, 0), st.avg_u)"
        cs_join = "LEFT JOIN cluster_stats cs ON cs.style = f.style AND cs.tier_n = t.tier_n"
        adj_filter = "AND ABS(f.tier_n - t.tier_n) <= 1"
    else:
        avg_expr = "st.avg_u"
        cs_join = ""
        adj_filter = ""
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
    store_rev AS (
      SELECT s.pos_location_name AS store, SUM(s.net_sales_kes::numeric) AS rev90
      FROM all_sales s
      WHERE s.sale_kind IN ('sale','order')
        AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
        AND {BASE_FILTERS}
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT ILIKE '%online%' {c_sales}
      GROUP BY 1
    ),
    store_tier AS (
      SELECT store, NTILE(3) OVER (ORDER BY rev90 DESC) AS tier_n
      FROM store_rev
    ),
    cluster_stats AS (
      SELECT c.style, COALESCE(t.tier_n, 3) AS tier_n, AVG(c.units_sold) AS avg_u
      FROM combined c
      LEFT JOIN store_tier t ON t.store = c.store
      GROUP BY c.style, COALESCE(t.tier_n, 3)
    ),
    style_inv AS (
      SELECT p.style_name AS style, SUM(i.available) AS avail
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1
    ),
    style_sales56 AS (
      SELECT p.style_name AS style, SUM(s.net_quantity) AS u56
      FROM all_sales s
      JOIN all_products_clean p ON p.sku = s.variant_sku
      WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
        AND s.sale_kind IN ('sale','order')
        AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(p.style_name,'') <> '' {c_sales}
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
    -- "Too new to transfer" guard: never recommend moving a style that has only
    -- recently entered the range. Retail inventory carries no per-store received
    -- date, so the catalogue launch date is the reliable proxy for how long the
    -- item has been in the stores. Styles launched within the last 3 weeks are
    -- held back on BOTH the donor (source) and recipient (receiving) side so
    -- freshly-introduced product gets time to sell before it can be flagged for
    -- a transfer. A missing/unparseable launch date is NOT excluded (so the
    -- guard never silently drops legitimate, established styles).
    style_age AS (
      SELECT style_name AS style,
             MIN(substring(style_launch_date,1,10)) FILTER (
               WHERE substring(style_launch_date,1,10) ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$'
             )::date AS launch
      FROM all_products_clean
      WHERE COALESCE(style_name,'') <> ''
      GROUP BY 1
    ),
    too_new AS (
      SELECT style FROM style_age
      WHERE launch IS NOT NULL
        AND launch > (CURRENT_DATE - INTERVAL '21 days')
    ),
    froms AS (
      SELECT c.style, c.store, c.available, c.units_sold,
             COALESCE(stt.tier_n, 3) AS tier_n
      FROM combined c
      JOIN stats st ON st.style = c.style
      LEFT JOIN store_tier stt ON stt.store = c.store
      WHERE c.available >= 3
        AND NOT EXISTS (SELECT 1 FROM dead d WHERE d.style = c.style)
        AND NOT EXISTS (SELECT 1 FROM too_new tn WHERE tn.style = c.style)
    ),
    tos AS (
      SELECT c.style, c.store, c.available, c.units_sold,
             COALESCE(stt.tier_n, 3) AS tier_n
      FROM combined c
      JOIN stats st ON st.style = c.style
      LEFT JOIN store_tier stt ON stt.store = c.store
      WHERE c.available <= 2
        AND NOT EXISTS (SELECT 1 FROM dead d WHERE d.style = c.style)
        AND NOT EXISTS (SELECT 1 FROM too_new tn WHERE tn.style = c.style)
    ),
    pairs AS (
      SELECT f.style,
             f.store AS from_store, f.available AS from_avail,
             f.units_sold AS from_sold, f.tier_n AS from_tier,
             t.store AS to_store, t.available AS to_avail,
             t.units_sold AS to_sold, t.tier_n AS to_tier,
             {avg_expr} AS avg_u, st.asp AS asp
      FROM froms f
      JOIN tos t ON t.style = f.style AND t.store <> f.store
      JOIN stats st ON st.style = f.style
      {cs_join}
      WHERE f.units_sold <= {low} * {avg_expr}
        AND t.units_sold >= {high} * {avg_expr}
        {adj_filter}
    ),
    -- ── Minimum range guard (≥ 3 distinct SKUs at the receiver post-transfer) ──
    -- A style is only allocated to a receiving store if, AFTER the transfer, that
    -- store will hold at least 3 distinct SKUs of the style. Post-transfer SKUs =
    -- SKUs the receiver already stocks (av >= 1) UNION SKUs the donor will send
    -- (donor av >= 2 so it keeps ≥1, and receiver currently has <= 1) — the same
    -- per-SKU rule the SKU-breakdown applies (suggested_qty > 0 ⇔ from>=2,to<=1).
    sku_av AS (
      SELECT p.style_name AS style, i.pos_location_name AS store, i.sku AS sku,
             SUM(i.available) AS av
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2, 3
    ),
    cand AS (SELECT DISTINCT style, from_store, to_store FROM pairs),
    recv_have AS (
      SELECT c.style, c.from_store, c.to_store, sa.sku
      FROM cand c
      JOIN sku_av sa ON sa.style = c.style AND sa.store = c.to_store AND sa.av >= 1
    ),
    recv_get AS (
      SELECT c.style, c.from_store, c.to_store, df.sku
      FROM cand c
      JOIN sku_av df ON df.style = c.style AND df.store = c.from_store AND df.av >= 2
      LEFT JOIN sku_av dt ON dt.style = c.style AND dt.store = c.to_store AND dt.sku = df.sku
      WHERE COALESCE(dt.av, 0) <= 1
    ),
    recv_proj AS (
      SELECT style, from_store, to_store, COUNT(DISTINCT sku) AS projected_skus
      FROM (SELECT * FROM recv_have UNION SELECT * FROM recv_get) u
      GROUP BY 1, 2, 3
    ),
    scored AS (
      SELECT pr.*,
        ROUND(100 * (
          0.4 * (LEAST(pr.from_avail::numeric / NULLIF(pr.avg_u, 0), 3.0) / 3.0)
        + 0.4 * (LEAST(pr.to_sold::numeric / NULLIF(GREATEST(pr.to_avail, 0) + 1, 0), 5.0) / 5.0)
        + 0.2 * COALESCE(pr.to_sold::numeric / NULLIF(pr.to_sold + pr.to_avail, 0), 0)
        ))::int AS score
      FROM pairs pr
      JOIN recv_proj rp
        ON rp.style = pr.style AND rp.from_store = pr.from_store AND rp.to_store = pr.to_store
      WHERE rp.projected_skus >= 3
    )
    SELECT sc.style AS style_name, pp.brand, pp.category AS subcategory,
           sc.from_store, sc.to_store,
           CASE sc.from_tier WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'C' END AS from_cluster,
           CASE sc.to_tier   WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'C' END AS to_cluster,
           sc.score,
           COUNT(*) OVER (PARTITION BY sc.style)::int AS pair_count,
           GREATEST(LEAST(sc.from_avail - 2, GREATEST(sc.to_sold - sc.to_avail, 1)), 1)::int AS units_to_move,
           ROUND(GREATEST(LEAST(sc.from_avail - 2, GREATEST(sc.to_sold - sc.to_avail, 1)), 1)
                 * COALESCE(sc.asp, 0))::numeric AS estimated_uplift,
           sc.from_sold::int AS from_qty_sold_28d,
           sc.to_sold::int AS to_qty_sold_28d
    FROM scored sc
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = sc.style LIMIT 1
    ) pp ON TRUE
    ORDER BY sc.score DESC, sc.style, estimated_uplift DESC NULLS LAST
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
    use_clustering: bool = Query(default=True),
):
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    low = float(low_pct) / 100.0
    high = float(high_pct) / 100.0
    lim = max(1, min(int(limit), 1000))
    q = _ibt_suggestions_sql(date_from, date_to, country, low, high, lim,
                             use_clustering=use_clustering)
    return run_query(q, date_to=date_to)


@app.get("/api/analytics/ibt-sku-breakdown")
def ibt_sku_breakdown(
    style_name:    str = Query(...),
    from_store:    str = Query(...),
    to_store:      str = Query(...),
    units_to_move: int = Query(default=0),
):
    _warehouse_bins_refresh()
    st = _sql_str(style_name)
    fs = _sql_str(from_store)
    ts = _sql_str(to_store)
    # Phase 2 A5 — size-run integrity guard. Every size the donor still stocks
    # keeps at least 1 unit on the shelf, so a transfer can never zero out a size
    # and break the donor's size run (qty is capped at from_available - 1). A SKU
    # whose only available unit would otherwise move (and the destination is not
    # already covered) is held back and flagged size_run_protected = true.
    q = f"""
    WITH skus AS (
      SELECT DISTINCT p.sku, p.color_print AS color, p.size, p.barcode
      FROM all_products_clean p WHERE p.style_name = '{st}'
    ),
    fi AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{fs}' GROUP BY sku),
    ti AS (SELECT sku, SUM(available) AS av FROM all_inventory WHERE pos_location_name = '{ts}' GROUP BY sku)
    SELECT s.sku, s.color, s.size, s.barcode,
           COALESCE(wb.bin, '') AS bin,
           COALESCE(fi.av, 0)::int AS from_available,
           COALESCE(ti.av, 0)::int AS to_available,
           LEAST(
             GREATEST(COALESCE(fi.av,0) - 1, 0),
             GREATEST(2 - COALESCE(ti.av,0), 0)
           )::int AS suggested_qty,
           (COALESCE(fi.av,0) >= 1
            AND COALESCE(ti.av,0) < 2
            AND LEAST(
                  GREATEST(COALESCE(fi.av,0) - 1, 0),
                  GREATEST(2 - COALESCE(ti.av,0), 0)
                ) = 0) AS size_run_protected
    FROM skus s
    LEFT JOIN fi ON fi.sku = s.sku
    LEFT JOIN ti ON ti.sku = s.sku
    LEFT JOIN warehouse_bins wb ON wb.barcode = s.barcode
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
    _warehouse_bins_refresh()
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
    ),
    sb AS (
      SELECT p.style_name AS style,
             string_agg(DISTINCT wb.bin, ', ' ORDER BY wb.bin) AS bins
      FROM warehouse_bins wb
      JOIN all_products_clean p ON p.barcode = wb.barcode
      WHERE COALESCE(wb.bin,'') <> '' AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1
    ),
    -- ── Minimum range guard (≥ 3 distinct SKUs at the receiver post-transfer) ──
    -- Only allocate a style to a store if, AFTER the warehouse transfer, the store
    -- will hold ≥ 3 distinct SKUs of it. Post-transfer SKUs = SKUs the store already
    -- stocks (av >= 1) UNION SKUs the warehouse will send (warehouse av >= 2 and the
    -- store currently has <= 1) — matching the SKU-breakdown's suggested_qty > 0 rule.
    sku_av AS (
      SELECT p.style_name AS style, i.pos_location_name AS store, i.sku AS sku,
             SUM(i.available) AS av
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
        AND COALESCE(i.pos_location_name,'') <> ''
        AND COALESCE(p.style_name,'') <> '' {c_inv}
      GROUP BY 1, 2, 3
    ),
    wh_sku AS (
      SELECT p.style_name AS style, i.sku AS sku, SUM(i.available) AS av
      FROM all_inventory i
      JOIN all_products_clean p ON p.sku = i.sku
      WHERE i.pos_location_name = 'Warehouse Finished Goods'
        AND COALESCE(p.style_name,'') <> ''
      GROUP BY 1, 2
    ),
    cand AS (SELECT DISTINCT style, store FROM sv),
    recv_have AS (
      SELECT c.style, c.store, sa.sku
      FROM cand c
      JOIN sku_av sa ON sa.style = c.style AND sa.store = c.store AND sa.av >= 1
    ),
    recv_get AS (
      SELECT c.style, c.store, w.sku
      FROM cand c
      JOIN wh_sku w ON w.style = c.style AND w.av >= 2
      LEFT JOIN sku_av dt ON dt.style = c.style AND dt.store = c.store AND dt.sku = w.sku
      WHERE COALESCE(dt.av, 0) <= 1
    ),
    recv_proj AS (
      SELECT style, store, COUNT(DISTINCT sku) AS projected_skus
      FROM (SELECT * FROM recv_have UNION SELECT * FROM recv_get) u
      GROUP BY 1, 2
    )
    SELECT sv.style AS style_name, pp.brand, pp.category AS subcategory,
           sv.store AS to_store,
           GREATEST(LEAST(wh.available, sv.units_sold - COALESCE(si.available, 0)), 1)::int AS suggested_qty,
           sv.units_sold::int AS to_qty_sold_28d,
           COALESCE(sb.bins, '') AS bins
    FROM sv
    JOIN wh ON wh.style = sv.style AND wh.available > 0
    LEFT JOIN si ON si.style = sv.style AND si.store = sv.store
    LEFT JOIN sb ON sb.style = sv.style
    LEFT JOIN LATERAL (
      SELECT brand, category FROM all_products_clean WHERE style_name = sv.style LIMIT 1
    ) pp ON TRUE
    JOIN recv_proj rp ON rp.style = sv.style AND rp.store = sv.store
    WHERE COALESCE(si.available, 0) <= 2
      AND rp.projected_skus >= 3
    ORDER BY suggested_qty DESC
    LIMIT {lim}
    """
    rows = run_query(q, date_to=date_to)
    # Attach the per-destination-store picker from the persisted roster map so
    # the Owner column reflects the same store→owner assignment as the
    # replenishment reports (recomputed only on an explicit redistribute).
    store_map = _replen_store_owner_map()
    for r in (rows or []):
        r["owner"] = store_map.get(r.get("to_store")) or "—"
    return rows


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

# ---------------------------------------------------------------------------
# Data Health / prod-vs-dev parity check (admin-only).
#
# Prod is a SEPARATE database from dev: publishing ships code + schema but NOT
# data rows, so several hand-loaded / self-bootstrapping tables can be empty or
# stale in production. This endpoint reports, for the CURRENT database, a
# row-count + freshness manifest of the key tables so an admin can open it on
# the live site AND in dev and confirm the two line up after every publish.
# Table names are hardcoded constants (never user input), and every probe is
# wrapped so a missing table degrades to a clean "missing" status instead of
# 500-ing the whole report.
# ---------------------------------------------------------------------------
_DATA_HEALTH_TABLES = [
    # (table, label, group, critical, date_expr)
    ("all_sales",               "All Sales (fact table)",            "Core data",     True,  "sale_date::date"),
    ("all_inventory",           "Inventory snapshot",                "Core data",     True,  None),
    ("all_customers",           "Customers",                         "Core data",     True,  None),
    ("shopify_sales",           "Shopify retail (rebuild input)",    "Sales sources", True,  None),
    ("raw_shopify_vendor_sales","Online / ShopifyQL (rebuild input)","Sales sources", True,  None),
    ("raw_odoo_pos_orders",     "Odoo POS orders (rebuild input)",   "Sales sources", False, None),
    ("raw_odoo_products",       "Odoo products (rebuild input)",     "Sales sources", False, None),
    ("raw_account_move_lines",  "Finance journal lines",             "Finance",       False, None),
    ("finance_account_map",     "Finance account map (seeded)",      "Finance",       True,  None),
    ("targets_monthly",         "Sales targets (seeded)",            "Targets",       True,  None),
    ("hr_employees",            "HR roster (sheet-sourced)",         "HR",            True,  None),
    ("hr_employee_match",       "HR roster \u2194 attendance matches","HR",           True,  None),
    ("production_orders",       "Production orders (DPS-sourced)",   "Production",    True,  None),
    ("stage_movements",         "Production stage movements",        "Production",    False, None),
    ("app_users",               "App users / access",                "Access",        True,  None),
]

@app.get("/api/admin/data-health")
def admin_data_health():
    """Row-count + freshness manifest of key tables for the CURRENT database, for
    prod-vs-dev parity checks. Admin-only (enforced by clerk_auth_gate for the
    /api/admin/* prefix). Reads a fresh (uncached) connection so the numbers are
    live."""
    from datetime import datetime, timezone
    conn = get_conn()
    out = []
    counts = {"ok": 0, "empty": 0, "missing": 0}
    dbname = None
    try:
        conn.autocommit = True  # each probe is its own txn; a failed probe never
                                # poisons the next one.
        cur = conn.cursor()
        try:
            cur.execute("SELECT current_database()")
            dbname = cur.fetchone()[0]
        except Exception:
            dbname = None
        for table, label, group, critical, date_expr in _DATA_HEALTH_TABLES:
            rec = {"key": table, "label": label, "group": group, "critical": critical,
                   "rows": None, "earliest": None, "latest": None, "status": "missing"}
            try:
                if date_expr:
                    cur.execute(f"SELECT COUNT(*), MIN({date_expr}), MAX({date_expr}) FROM {table}")
                    r = cur.fetchone()
                    rec["rows"] = int(r[0])
                    rec["earliest"] = str(r[1]) if r[1] is not None else None
                    rec["latest"] = str(r[2]) if r[2] is not None else None
                else:
                    cur.execute(f"SELECT COUNT(*) FROM {table}")
                    rec["rows"] = int(cur.fetchone()[0])
                rec["status"] = "empty" if (rec["rows"] == 0 and critical) else "ok"
            except Exception as e:
                rec["status"] = "missing"
                rec["error"] = str(e).splitlines()[0][:140]
            counts[rec["status"]] = counts.get(rec["status"], 0) + 1
            out.append(rec)
        cur.close()
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {
        "database": dbname,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": counts,
        "tables": out,
    }
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
# Canonical annual-target buckets. These names are the contract the Targets
# page (TargetsTracker.jsx BUCKETS.source) keys on, and they match the
# leadership Budget workbook's Quarterly Summary breakdown.
_TARGET_BUCKETS = ["Kenya - Retail", "Kenya - Online", "Uganda", "Rwanda"]

# Map a sales row to one of the 4 buckets (mirrors the budget split). Online
# (Shop Zetu) is "Kenya - Online"; the rest split by country. Warehouse / staff
# rows are already excluded by BASE_FILTERS, leaving exactly these 4 countries.
_ACTUAL_BUCKET_CASE = (
    "CASE WHEN s.country = 'Online' OR s.pos_location_name ILIKE '%online%' THEN 'Kenya - Online' "
    "WHEN s.country = 'Kenya' THEN 'Kenya - Retail' "
    "WHEN s.country = 'Uganda' THEN 'Uganda' "
    "WHEN s.country = 'Rwanda' THEN 'Rwanda' "
    "ELSE 'Other' END"
)

# Achievement is measured on the SAME canonical revenue basis as the headline
# KPIs (total_sales_kes net of returns) — NOT net_sales_kes, which is net of
# discounts and reads ~12-14% low (e.g. Kenya YTD 370M vs the real 422M). Any
# query using this expression must include 'return' rows in its WHERE clause
# (sale_kind IN ('sale','order','return')) so the returns subtraction applies.
_TARGET_REVENUE = (
    "SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) "
    "- SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)"
)

_TARGETS_DDL = """
CREATE TABLE IF NOT EXISTS targets_monthly (
    id          BIGSERIAL PRIMARY KEY,
    scope       TEXT NOT NULL,
    name        TEXT NOT NULL,
    country     TEXT,
    month       DATE NOT NULL,
    target_kes  NUMERIC NOT NULL,
    source      TEXT NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (scope, name, month, source)
);
"""


def _ensure_targets_table():
    try:
        conn = get_conn()
        try:
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(_TARGETS_DDL)
            cur.close()
        finally:
            conn.close()
    except Exception as e:  # pragma: no cover - best effort, never block boot
        print(f"[targets] ensure table failed: {e}", flush=True)


# 2026 leadership budget (scope='region', source='budget'), one figure per
# (bucket, month). This is hand-entered leadership data with no external source
# to re-derive it from, so a fresh prod DB has no way to self-populate it — it
# would otherwise fall back to prior-year actuals + 15%. We seed it from code so
# a published deployment bootstraps the real budget on first boot. The seed is
# GUARDED: it only runs when the 2026 region/budget set is empty, so it never
# clobbers later edits made directly in production.
# Columns per row: (bucket name, country, month 1-12, target_kes).
_BUDGET_2026_SEED = [
    ("Kenya - Online", "Online", [
        8489250, 6755948, 8327702, 8005285, 7846801, 8825976,
        7994360, 7559754, 8165494, 7415181, 13352515, 6784859]),
    ("Kenya - Retail", "Kenya", [
        73551760, 78561699, 83569811, 90859769, 90884418, 86816048,
        106253533, 112010104, 93144307, 98271941, 119117293, 127195778]),
    ("Rwanda", "Rwanda", [
        3557665, 2630475, 3592741, 2489631, 5063588, 4221746,
        3871062, 3839509, 2832688, 5690753, 7614199, 6394225]),
    ("Uganda", "Uganda", [
        8464809, 9170957, 9268631, 9175791, 9573757, 9503715,
        9608765, 10105378, 9261594, 12420238, 13205085, 13205085]),
]


# Dedicated advisory-lock key so concurrent boots serialize the seed check+write
# (distinct from the admin/rollup lock keys used elsewhere).
_TARGETS_SEED_LOCK_KEY = 822026


def _seed_targets_budget_2026():
    """Idempotently bootstrap the 2026 region budget when it is incomplete.

    Boot-safe and atomic: the emptiness check and the insert run in ONE
    transaction guarded by an advisory lock, so concurrent workers can't both
    decide to seed and a crash can't leave a permanently partial budget (the
    next boot heals it). The guard is completeness-based (expects 48 rows) and
    inserts with ON CONFLICT DO NOTHING, so it only ADDS missing (name, month)
    rows and NEVER overwrites a value edited directly in production.
    """
    expected = sum(len(months) for _, _, months in _BUDGET_2026_SEED)
    count_sql = (
        "SELECT COUNT(*) FROM targets_monthly "
        "WHERE scope='region' AND source='budget' "
        "AND EXTRACT(YEAR FROM month)=2026"
    )
    conn = None
    try:
        conn = get_conn()
        conn.autocommit = False
        cur = conn.cursor()
        # Serialize concurrent boots; auto-released at COMMIT/ROLLBACK.
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (_TARGETS_SEED_LOCK_KEY,))
        cur.execute(count_sql)
        have = (cur.fetchone() or [0])[0]
        if have >= expected:
            conn.rollback()  # complete — nothing to do (releases the lock)
            cur.close()
            return
        rows = []
        for name, country, months in _BUDGET_2026_SEED:
            for i, amount in enumerate(months, start=1):
                rows.append((
                    "region", name, country,
                    f"2026-{i:02d}-01", amount, "budget",
                ))
        cur.executemany(
            "INSERT INTO targets_monthly "
            "(scope, name, country, month, target_kes, source) "
            "VALUES (%s, %s, %s, %s::date, %s, %s) "
            "ON CONFLICT (scope, name, month, source) DO NOTHING",
            rows,
        )
        cur.execute(count_sql)
        now_have = (cur.fetchone() or [0])[0]
        conn.commit()
        print(f"[targets] 2026 budget seed: had {have}, now {now_have} "
              f"(added {now_have - have})", flush=True)
        cur.close()
    except Exception as e:  # pragma: no cover - best effort, never block boot
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[targets] seed 2026 budget failed: {e}", flush=True)
    finally:
        if conn is not None:
            conn.close()


# --------------------------------------------------------------------------- #
# Finance P&L account map (account_code -> P&L group/section).                  #
# Hand-curated mapping with NO external source to re-derive it from, and (like  #
# targets_monthly) it was originally created by a manual dev import — there is  #
# no CREATE TABLE for it in code either. A fresh prod DB therefore has an empty #
# finance_account_map, which breaks the Finance / P&L page (its month matrix    #
# JOINs raw_account_move_lines -> finance_account_map). We ship the DDL + a     #
# guarded code seed so a published deployment self-creates and bootstraps it.   #
# --------------------------------------------------------------------------- #
_FINANCE_ACCOUNT_MAP_DDL = """
CREATE TABLE IF NOT EXISTS finance_account_map (
    account_code TEXT PRIMARY KEY,
    pl_group     TEXT,
    pl_section   TEXT
);
"""

# (pl_group, pl_section) -> list of account_code. Grouped purely for legibility;
# flattened to one row per account_code at seed time.
_FINANCE_ACCOUNT_MAP_SEED = {
    ("cogs", "costs_of_revenue"): ["5002000000"],
    ("other_opex", "operating_expenses"): ["5146000000"],
    ("revenue", "revenue"): ["6001", "60011", "6101", "6102", "6103"],
    ("other_income", "other_income"): ["6104", "6105", "6106", "6107"],
    ("production", "costs_of_revenue"): [
        "70000000", "71000000", "7112", "7113", "7114", "7115", "7116", "7122",
        "7201", "7202", "7210", "7215", "7216", "7217", "7218", "7220", "7221",
        "7223", "7251", "7252", "7253", "7254", "7255", "7256", "7257", "7301",
        "7302", "7303", "7304", "7305", "7306", "7307", "7308"],
    ("purchases", "costs_of_revenue"): ["7401", "7402", "7403", "7404", "7405"],
    ("employment", "operating_expenses"): [
        "8111", "8112", "8113", "8114", "8115", "8116", "8117", "8118",
        "8202", "8204", "8205"],
    ("admin", "operating_expenses"): [
        "8401", "8402", "8403", "8404", "8405", "8406", "8407", "8408", "8409",
        "8410", "8413", "8414", "8415", "8417", "8418", "8419", "8420", "8421",
        "8422", "8423", "8424", "8451", "8452", "8453", "8454", "8455", "8456"],
    ("establishment", "operating_expenses"): [
        "8503", "8504", "8505", "8506", "8507",
        "8551", "8552", "8553", "8554", "8555", "8556"],
    ("selling", "operating_expenses"): [
        "8601", "8651", "8652", "8653", "8654", "8655", "8656",
        "8701", "8702", "8703", "8704"],
    ("marketing", "operating_expenses"): [
        "8801", "8806", "8809", "8812", "8813", "8814", "8816", "8817", "8820"],
    ("finance_charges", "operating_expenses"): [
        "8901", "8902", "8903", "8905"],
}

# Distinct advisory-lock key (separate from the targets/admin/rollup keys).
_FINANCE_MAP_SEED_LOCK_KEY = 920122


def _ensure_finance_account_map():
    try:
        conn = get_conn()
        try:
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(_FINANCE_ACCOUNT_MAP_DDL)
            cur.close()
        finally:
            conn.close()
    except Exception as e:  # pragma: no cover - best effort, never block boot
        print(f"[finance] ensure account_map table failed: {e}", flush=True)


def _seed_finance_account_map():
    """Idempotently bootstrap finance_account_map when it is incomplete.

    Same boot-safe pattern as the targets budget seed: the emptiness check and
    the insert run in ONE advisory-locked transaction (so concurrent boots
    serialize and a crash can't leave a permanently partial map — the next boot
    heals it). The guard is completeness-based (expects the full mapping count)
    and inserts ON CONFLICT (account_code) DO NOTHING, so it only ADDS missing
    account codes and NEVER overwrites a mapping edited directly in production.
    """
    rows = []
    for (pl_group, pl_section), codes in _FINANCE_ACCOUNT_MAP_SEED.items():
        for code in codes:
            rows.append((code, pl_group, pl_section))
    expected = len(rows)
    conn = None
    try:
        conn = get_conn()
        conn.autocommit = False
        cur = conn.cursor()
        cur.execute("SELECT pg_advisory_xact_lock(%s)",
                    (_FINANCE_MAP_SEED_LOCK_KEY,))
        cur.execute("SELECT COUNT(*) FROM finance_account_map")
        have = (cur.fetchone() or [0])[0]
        if have >= expected:
            conn.rollback()  # complete — nothing to do (releases the lock)
            cur.close()
            return
        cur.executemany(
            "INSERT INTO finance_account_map (account_code, pl_group, pl_section) "
            "VALUES (%s, %s, %s) "
            "ON CONFLICT (account_code) DO NOTHING",
            rows,
        )
        cur.execute("SELECT COUNT(*) FROM finance_account_map")
        now_have = (cur.fetchone() or [0])[0]
        conn.commit()
        print(f"[finance] account_map seed: had {have}, now {now_have} "
              f"(added {now_have - have})", flush=True)
        cur.close()
    except Exception as e:  # pragma: no cover - best effort, never block boot
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[finance] seed account_map failed: {e}", flush=True)
    finally:
        if conn is not None:
            conn.close()


@app.on_event("startup")
def _targets_startup():
    _ensure_targets_table()
    _seed_targets_budget_2026()
    _ensure_finance_account_map()
    _seed_finance_account_map()
    # Optional free-text transfer/PO reference attached when a replenishment is
    # marked done (IBT moves already carry po_number in ibt_completions).
    try:
        _users_exec("ALTER TABLE recommendation_actions "
                    "ADD COLUMN IF NOT EXISTS transfer_ref TEXT")
    except Exception as e:  # pragma: no cover - best effort
        print(f"[targets] ensure transfer_ref column failed: {e}", flush=True)


@app.get("/api/analytics/annual-targets")
def analytics_annual_targets(year: int = Query(default=None)):
    # Targets come from the stored leadership budget (targets_monthly,
    # scope='region', source='budget'). When no budget exists for a year (e.g.
    # the prior-year YoY lookup), we fall back to prior-year actuals + a 15%
    # stretch so the comparison column still renders.
    yr = int(year) if year else date.today().year
    growth = 1.15

    def actuals(y):
        return run_query("""
            SELECT """ + _ACTUAL_BUCKET_CASE + """ AS bucket,
                EXTRACT(QUARTER FROM s.sale_date::date)::int AS q,
                ROUND(""" + _TARGET_REVENUE + """) AS net
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + str(y) + """-01-01' AND '""" + str(y) + """-12-31'
              AND s.sale_kind IN ('sale','order','return') AND """ + BASE_FILTERS + """
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

    # Stored budget targets for this year, summed into quarters per bucket.
    budget = {}
    for r in run_query(
        "SELECT name, EXTRACT(QUARTER FROM month)::int AS q, "
        "SUM(target_kes)::numeric AS tgt FROM targets_monthly "
        "WHERE scope = 'region' AND source = 'budget' "
        "AND EXTRACT(YEAR FROM month) = " + str(yr) + " GROUP BY 1, 2"
    ):
        q = int(r["q"]) if r["q"] else 0
        if q in (1, 2, 3, 4):
            budget.setdefault(r["name"], {1: 0, 2: 0, 3: 0, 4: 0})[q] += float(r["tgt"] or 0)

    start, end = date(yr, 1, 1), date(yr, 12, 31)
    days_total = (end - start).days + 1
    today = date.today()
    days_elapsed = 0 if today < start else days_total if today > end else (today - start).days + 1
    frac = days_elapsed / days_total if days_total else 1

    # Prior-year YTD bounded to the SAME calendar date as today, so the YoY
    # comparison is apples-to-apples (this-year Jan 1..today vs last-year
    # Jan 1..same MM-DD). Without this the frontend compared this-year-YTD
    # against last-year's FULL year, making YoY read ~-55% mid-year. For a
    # year that is fully in the past we use last year's whole span; for a
    # year that has not started yet there is no YTD to compare.
    if today > end:
        ly_to = date(yr - 1, 12, 31)
    elif today < start:
        ly_to = None
    else:
        try:
            ly_to = date(yr - 1, today.month, today.day)
        except ValueError:
            ly_to = date(yr - 1, 2, 28)  # Feb 29 in a non-leap prior year
    ytd_ly = {}
    if ly_to is not None:
        for r in run_query(
            "SELECT " + _ACTUAL_BUCKET_CASE + " AS bucket, "
            "ROUND(" + _TARGET_REVENUE + ") AS net FROM all_sales s "
            "WHERE s.sale_date BETWEEN '" + str(date(yr - 1, 1, 1)) + "' AND '" + str(ly_to) + "' "
            "AND s.sale_kind IN ('sale','order','return') AND " + BASE_FILTERS + " GROUP BY 1"
        ):
            ytd_ly[r["bucket"]] = float(r["net"] or 0)

    def make_bucket(name):
        pq = prev_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        cq = cur_m.get(name, {1: 0, 2: 0, 3: 0, 4: 0})
        bq = budget.get(name)
        # Quarter targets: stored budget when present, else prior-year + 15%.
        tq = {q: (round(bq.get(q, 0)) if bq is not None else round(pq[q] * growth))
              for q in (1, 2, 3, 4)}
        target_annual = sum(tq.values())
        actual_ytd = round(sum(cq.values()))
        projected_year = round(actual_ytd / frac) if frac else actual_ytd
        return {
            "bucket": name, "target_annual": target_annual, "actual_ytd": actual_ytd,
            "actual_ytd_ly": round(ytd_ly.get(name, 0)),
            "pct_of_target_ytd": round(100.0 * actual_ytd / target_annual, 1) if target_annual else 0.0,
            "projected_year": projected_year,
            "pct_of_target_projected": round(100.0 * projected_year / target_annual, 1) if target_annual else 0.0,
            "variance_projected": projected_year - target_annual,
            "quarters": {("Q%d" % q): tq[q] for q in (1, 2, 3, 4)},
            "actual_quarters": {("Q%d" % q): round(cq[q]) for q in (1, 2, 3, 4)},
        }

    # Always emit the 4 canonical buckets in order (matches the budget + the
    # frontend bucket list). 'Other' actuals (mislabeled rows) are dropped so
    # the page reconciles to the budget total.
    buckets = [make_bucket(n) for n in _TARGET_BUCKETS]
    tt_target = sum(b["target_annual"] for b in buckets)
    tt_actual = sum(b["actual_ytd"] for b in buckets)
    tt_actual_ly = sum(b["actual_ytd_ly"] for b in buckets)
    tt_proj = round(tt_actual / frac) if frac else tt_actual
    total = {
        "target_annual": tt_target, "actual_ytd": tt_actual,
        "actual_ytd_ly": tt_actual_ly,
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
    # Per-STORE daily target tracker (pos_location_name). The monthly target
    # is the typed leadership number (targets_monthly, scope='store', manual
    # preferred over budget); when none is stored for a store we fall back to
    # prior-year same-month actual + a 15% stretch so the tracker still works.
    # The "Suggested Daily Need" on remaining days is the gap re-weighted by
    # the store's trailing-6-month day-of-week sales pattern (not flat), and
    # suggested quantity / basket size derive from the store's ASP + orders pace.
    try:
        mstart = (date.fromisoformat(month[:10]).replace(day=1) if month
                  else date.today().replace(day=1))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid month (expected YYYY-MM-DD)")
    nstart = (date(mstart.year + 1, 1, 1) if mstart.month == 12
              else date(mstart.year, mstart.month + 1, 1))
    mend = nstart - timedelta(days=1)
    days_in_month = mend.day
    today = date.today()
    growth = 1.15
    py_start = mstart.replace(year=mstart.year - 1)
    py_end = mend.replace(year=mend.year - 1)
    pat_start = mstart - timedelta(days=183)

    def _pgdow(d):  # Python weekday() (Mon=0) -> Postgres DOW (Sun=0..Sat=6)
        return (d.weekday() + 1) % 7

    # Stored per-store targets for the month (manual wins over budget).
    target_map = {}
    for r in run_query(
        "SELECT name, source, target_kes::numeric AS t FROM targets_monthly "
        "WHERE scope = 'store' AND month = '" + str(mstart) + "'"
    ):
        nm, src, t = r["name"], r["source"], float(r["t"] or 0)
        cur = target_map.get(nm)
        if cur is None or (cur[1] != "manual" and src == "manual"):
            target_map[nm] = (t, src)

    # Prior-year same-month per-store actuals (fallback target basis). Canonical
    # revenue basis (total_sales_kes net of returns), matching the headline KPIs.
    py_map = {r["store"]: float(r["net"] or 0) for r in run_query("""
        SELECT s.pos_location_name AS store,
            ROUND(""" + _TARGET_REVENUE + """) AS net
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(py_start) + """' AND '""" + str(py_end) + """'
          AND s.sale_kind IN ('sale','order','return') AND """ + BASE_FILTERS + """
        GROUP BY 1
    """)}

    # This-month per-store daily actuals. "net" is canonical revenue
    # (total_sales_kes net of returns); units/orders stay sale/order-only.
    dmap = {}
    for r in run_query("""
        SELECT s.pos_location_name AS store, s.sale_date::date AS d,
            ROUND(""" + _TARGET_REVENUE + """) AS net,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + str(mstart) + """' AND '""" + str(mend) + """'
          AND s.sale_kind IN ('sale','order','return') AND """ + BASE_FILTERS + """
        GROUP BY 1, 2
    """):
        dmap.setdefault(r["store"], {})[str(r["d"])] = {
            "net": float(r["net"] or 0), "units": float(r["units"] or 0), "orders": float(r["orders"] or 0)}

    # Trailing-6-month per-store day-of-week pattern → average net + orders per
    # weekday (for suggested-need weighting + basket pace) and a stable ASP.
    pat_net, pat_ord, asp_acc = {}, {}, {}
    for r in run_query("""
        SELECT s.pos_location_name AS store,
            EXTRACT(DOW FROM s.sale_date::date)::int AS dow,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric ELSE 0 END) AS net,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_quantity ELSE 0 END) AS units,
            COUNT(DISTINCT s.order_id) AS orders,
            COUNT(DISTINCT s.sale_date::date) AS ndays
        FROM all_sales s
        WHERE s.sale_date >= '""" + str(pat_start) + """' AND s.sale_date < '""" + str(mstart) + """'
          AND s.sale_kind IN ('sale','order') AND """ + BASE_FILTERS + """
        GROUP BY 1, 2
    """):
        st, dow, nd = r["store"], int(r["dow"]), float(r["ndays"] or 0)
        net, units, orders = float(r["net"] or 0), float(r["units"] or 0), float(r["orders"] or 0)
        if nd > 0:
            pat_net.setdefault(st, {})[dow] = net / nd
            pat_ord.setdefault(st, {})[dow] = orders / nd
        a = asp_acc.setdefault(st, [0.0, 0.0]); a[0] += net; a[1] += units

    if mstart.year == today.year and mstart.month == today.month:
        days_complete = today.day
    elif today < mstart:
        days_complete = 0
    else:
        days_complete = days_in_month
    days_remaining = days_in_month - days_complete

    # Store universe: every store with a stored target, plus every store with
    # actuals this month (so no live store's sales are hidden).
    store_names = set(target_map.keys()) | set(dmap.keys())
    stores = []
    for st in store_names:
        if st in target_map:
            sales_target, tgt_source = round(target_map[st][0]), target_map[st][1]
        else:
            sales_target, tgt_source = round(py_map.get(st, 0) * growth), "derived"
        daily_target = sales_target / days_in_month if days_in_month else 0
        ch_daily = dmap.get(st, {})

        # Month-to-date actuals.
        mtd_actual = mtd_units = mtd_orders = 0.0
        for dd in range(1, days_complete + 1):
            a = ch_daily.get(str(date(mstart.year, mstart.month, dd)))
            if a:
                mtd_actual += a["net"]; mtd_units += a["units"]; mtd_orders += a["orders"]
        gap = sales_target - round(mtd_actual)
        gap_pos = max(0, gap)

        # Stable per-store ASP (6-month) for suggested quantity; MTD fallback.
        a = asp_acc.get(st, [0.0, 0.0])
        store_asp = (a[0] / a[1]) if a[1] else (mtd_actual / mtd_units if mtd_units else 0)

        # Future-day weights from the DOW net-sales pattern.
        future_days = [date(mstart.year, mstart.month, dd) for dd in range(1, days_in_month + 1)
                       if date(mstart.year, mstart.month, dd) > today]
        wsum = sum(pat_net.get(st, {}).get(_pgdow(d), 0.0) for d in future_days)

        days, cum_var = [], 0.0
        for dd in range(1, days_in_month + 1):
            day = date(mstart.year, mstart.month, dd)
            a = ch_daily.get(str(day))
            actual = a["net"] if a else 0.0
            is_future = day > today
            dt = round(daily_target)
            ksh_var = round(actual - dt)
            cum_var += ksh_var
            row = {
                "date": str(day), "day_of_week": day.strftime("%a"),
                "ratio": round(100.0 / days_in_month, 1),
                "daily_target": dt,
                "suggested_daily_target": None,
                "suggested_daily_quantity": None,
                "suggested_basket_size": None,
                "actual": round(actual),
                "variance_pct": round(100.0 * (actual - dt) / dt, 1) if dt else 0.0,
                "ksh_variance": ksh_var, "ksh_variance_cumulative": round(cum_var),
                "is_future": is_future, "is_today": day == today,
            }
            if is_future:
                dow = _pgdow(day)
                w = pat_net.get(st, {}).get(dow, 0.0)
                if gap_pos <= 0:
                    sdt = 0
                elif wsum > 0:
                    sdt = gap_pos * (w / wsum)
                elif future_days:
                    sdt = gap_pos / len(future_days)
                else:
                    sdt = 0
                sdt = max(0, round(sdt))
                row["suggested_daily_target"] = sdt
                row["suggested_daily_quantity"] = round(sdt / store_asp) if store_asp > 0 else None
                opace = pat_ord.get(st, {}).get(dow, 0.0)
                row["suggested_basket_size"] = round(sdt / opace) if opace > 0 else None
            days.append(row)

        mtd_target = round(daily_target * days_complete)
        projected = round(mtd_actual / days_complete * days_in_month) if days_complete else 0
        stores.append({
            "channel": st, "sales_target": sales_target, "mtd_actual": round(mtd_actual),
            "mtd_target": mtd_target, "projected_landing": projected,
            "pct_of_target_projected": round(100.0 * projected / sales_target, 1) if sales_target else 0.0,
            "ksh_variance_total": round(mtd_actual) - mtd_target,
            "days_complete": days_complete, "days_in_month": days_in_month,
            "days_remaining": days_remaining,
            "avg_suggested_remaining": round(gap / days_remaining) if days_remaining > 0 else 0,
            "gap_to_target": gap,
            "asp": round(mtd_actual / mtd_units) if mtd_units else round(store_asp),
            "basket_kes": round(mtd_actual / mtd_orders) if mtd_orders else 0,
            "target_source": tgt_source,
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
    rows = run_query("""
        SELECT COALESCE(pl.country, 'Other') AS country,
            SUM(f.a01_footfall_in) AS footfall
        FROM footfall f
        LEFT JOIN pos_locations pl ON """ + ff_canon_sql() + """ = pl.location_name
        WHERE f.time BETWEEN \'""" + date_from + """\' AND \'""" + date_to + """\'
        GROUP BY COALESCE(pl.country, 'Other')
    """, date_to=date_to)
    ff_map = {r["country"]: float(r["footfall"] or 0) for r in rows}
    total_row = run_query("""
        SELECT SUM(a01_footfall_in) AS total
        FROM footfall
        WHERE time BETWEEN \'""" + date_from + """\' AND \'""" + date_to + """\'
    """, date_to=date_to)
    ff_map["__total__"] = float((total_row[0]["total"] if total_row else 0) or 0)
    return ff_map


def _es_footfall_total(ff_map, country):
    if country:
        wanted = {c.strip().lower() for c in country.split(",")}
        return sum(v for kc, v in ff_map.items()
                   if kc != "__total__" and kc.lower() in wanted)
    return ff_map.get("__total__", sum(v for k, v in ff_map.items() if k != "__total__"))


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

# Panel row -> stored-budget bucket name. The finance budget workbook splits
# Kenya into Retail vs Online; the Exec-Summary panel surfaces these as the
# "Kenya" and "Online" rows (matching _es_countries' country names, which is
# what the frontend joins the YTD actuals on). Uganda / Rwanda pass through.
_ES_TARGET_BUCKET_MAP = [
    ("Kenya", "Kenya - Retail"),
    ("Online", "Kenya - Online"),
    ("Uganda", "Uganda"),
    ("Rwanda", "Rwanda"),
]


def _es_targets(as_of, country):
    # YTD-vs-yearly-target pacing per market, fed from the stored finance
    # budget (targets_monthly, scope='region', source='budget') for as_of's
    # year — the SAME source the Annual Targets page / /api/analytics/
    # annual-targets reads. annual = sum of the 12 monthly budget rows;
    # ytd = full elapsed months + (current month x day_in_month/days_in_month).
    # The YTD actual the panel compares against is supplied by the frontend
    # from _es_countries / the YTD KPIs (total_sales_kes net of returns, the
    # canonical _TARGET_REVENUE basis), so target and actual share a basis and
    # a country at true budget pace reads ~100%. When no budget exists for the
    # year we fall back to prior-year actuals x 1.15 on that same net-of-returns
    # basis (a clearly-labelled stretch) so the panel still renders.
    yr = as_of.year
    cur_month = as_of.month
    dim = calendar.monthrange(yr, cur_month)[1]
    month_frac = as_of.day / dim if dim else 1.0

    # Monthly stored budget per bucket: {bucket_name: {month_int: target_kes}}.
    budget = {}
    for r in run_query(
        "SELECT name, EXTRACT(MONTH FROM month)::int AS m, "
        "SUM(target_kes)::numeric AS tgt FROM targets_monthly "
        "WHERE scope = 'region' AND source = 'budget' "
        "AND EXTRACT(YEAR FROM month) = " + str(yr) + " GROUP BY 1, 2"
    ):
        m = int(r["m"]) if r["m"] else 0
        if 1 <= m <= 12:
            budget.setdefault(r["name"], {})[m] = float(r["tgt"] or 0)

    has_budget = bool(budget)

    # Fallback: prior-year actuals x 1.15 (same net-of-returns basis as the
    # actuals) when there is no stored budget for the year.
    fallback = {}
    if not has_budget:
        growth = 1.15
        for r in run_query("""
            SELECT """ + _ACTUAL_BUCKET_CASE + """ AS bucket,
                EXTRACT(MONTH FROM s.sale_date::date)::int AS m,
                ROUND(""" + _TARGET_REVENUE + """) AS net
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + str(yr - 1) + """-01-01' AND '""" + str(yr - 1) + """-12-31'
              AND s.sale_kind IN ('sale','order','return') AND """ + BASE_FILTERS + """
            GROUP BY 1, 2
        """):
            m = int(r["m"]) if r["m"] else 0
            if 1 <= m <= 12:
                fallback.setdefault(r["bucket"], {})[m] = float(r["net"] or 0) * growth

    source = budget if has_budget else fallback

    def country_target(panel_name, budget_bucket):
        months = source.get(budget_bucket, {})
        annual = round(sum(months.values()))
        ytd = 0.0
        for m in range(1, cur_month):
            ytd += months.get(m, 0)
        ytd += months.get(cur_month, 0) * month_frac
        return {"country": panel_name, "ytd": round(ytd), "annual": annual}

    rows = list(_ES_TARGET_BUCKET_MAP)
    if country:
        cset = {c.strip() for c in country.split(",")}
        rows = [(p, b) for (p, b) in rows if p in cset]
    countries = [country_target(p, b) for (p, b) in rows]
    return {
        "countries": countries,
        "total": {"ytd": sum(c["ytd"] for c in countries),
                  "annual": sum(c["annual"] for c in countries)},
        "source": "budget" if has_budget else "prior_year_stretch",
        "year": yr,
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
# ── Phase 2 A3 — size-curve replenishment helpers ─────────────────────────────
_SIZE_ORDER = {s: i for i, s in enumerate(
    ["XXXS", "XXS", "XS", "S", "S/M", "M", "M/L", "L", "L/XL",
     "XL", "XXL", "XXXL", "2XL", "3XL", "4XL", "5XL"])}


def _size_sort_key(sz):
    u = (sz or "").strip().upper()
    if u in _SIZE_ORDER:
        return (0, _SIZE_ORDER[u], "")
    try:
        return (1, float(u), "")
    except (TypeError, ValueError):
        return (2, 0.0, u)


def _split_recommended(weights, total):
    # Split `total` across buckets proportionally to `weights` using the
    # largest-remainder method so the per-size parts always sum to exactly
    # `total` (no rounding drift).
    n = len(weights)
    if n == 0 or total <= 0:
        return [0] * n
    tot_w = sum(weights)
    if tot_w <= 0:
        weights = [1] * n
        tot_w = n
    raw = [total * w / tot_w for w in weights]
    floors = [int(x) for x in raw]
    remainder = int(total - sum(floors))
    order = sorted(range(n), key=lambda i: raw[i] - floors[i], reverse=True)
    for k in range(max(0, remainder)):
        floors[order[k % n]] += 1
    return floors


def _size_mix_rows(style_filter_sql, sales_extra, inv_country):
    """Per (style, size) 28d/56d units sold + current store SOH, used by both
    the size-breakdown endpoint and the replenish-by-color size_mix block.
    `style_filter_sql` is an already-escaped `AND p.style_name ...` predicate."""
    return run_query("""
        WITH sized_sales AS (
            SELECT p.style_name AS style, NULLIF(TRIM(p.size), '') AS size,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS units_28,
                SUM(s.net_quantity) AS units_56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND """ + BASE_FILTERS + sales_extra + """
              AND p.style_name IS NOT NULL """ + style_filter_sql + """
              AND NULLIF(TRIM(p.size), '') IS NOT NULL
            GROUP BY 1, 2
        ),
        sized_soh AS (
            SELECT p.style_name AS style, NULLIF(TRIM(p.size), '') AS size,
                SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND p.style_name IS NOT NULL """ + style_filter_sql + """
              AND NULLIF(TRIM(p.size), '') IS NOT NULL""" + inv_country + """
            GROUP BY 1, 2
        )
        SELECT COALESCE(ss.style, sh.style) AS style,
            COALESCE(ss.size, sh.size) AS size,
            COALESCE(ss.units_28, 0)::int AS units_28,
            COALESCE(ss.units_56, 0)::int AS units_56,
            COALESCE(sh.soh, 0)::int AS soh
        FROM sized_sales ss
        FULL OUTER JOIN sized_soh sh ON sh.style = ss.style AND sh.size = ss.size
        WHERE COALESCE(ss.style, sh.style) IS NOT NULL
    """)


def _build_size_mix(rows, total_recommended):
    """Turn raw (size, units_28, units_56, soh) rows for ONE style into an
    ordered size_mix list, splitting `total_recommended` proportionally to 28d
    sales (falling back to 56d, then even) so the parts sum to the style total."""
    rows = sorted(rows, key=lambda r: _size_sort_key(r.get("size")))
    weights = [int(r.get("units_28") or 0) for r in rows]
    if sum(weights) == 0:
        weights = [int(r.get("units_56") or 0) for r in rows]
    tot_w = sum(weights) or len(rows) or 1
    qtys = _split_recommended(weights, total_recommended)
    out = []
    for r, w, q in zip(rows, weights, qtys):
        out.append({
            "size": r.get("size"),
            "units_28": int(r.get("units_28") or 0),
            "units_56": int(r.get("units_56") or 0),
            "soh": int(r.get("soh") or 0),
            "size_share_pct": round(100.0 * w / tot_w, 1) if tot_w else 0.0,
            "recommended_qty": q,
        })
    return out


@app.get("/api/replenishment/size-breakdown")
def replenishment_size_breakdown(
    style_name: str = Query(...),
    country:    str = Query(default=None),
    channel:    str = Query(default=None),
):
    # Phase 2 A3 — split a single style's recommended replenishment across its
    # size run, proportional to the last-28-day size mix (recency-weighted
    # velocity over the 56d window, identical to replenish-by-color).
    sales_extra = ""
    if country:
        sales_extra += " AND s.country = '" + _sql_str(country) + "'"
    if channel:
        sales_extra += " AND s.pos_location_name IN (" + csv_to_sql(channel) + ")"
    inv_country = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    style_filter = " AND p.style_name = '" + _sql_str(style_name) + "'"
    rows = _size_mix_rows(style_filter, sales_extra, inv_country)
    total_28 = sum(int(r.get("units_28") or 0) for r in rows)
    total_56 = sum(int(r.get("units_56") or 0) for r in rows)
    total_soh = sum(int(r.get("soh") or 0) for r in rows)
    weekly = ((total_28 * 2) + max(total_56 - total_28, 0)) / 12.0
    target = int(round(weekly * 4.0))
    total_recommended = max(0, target - total_soh)
    sizes = _build_size_mix(rows, total_recommended)
    return {
        "style_name": style_name,
        "weekly_units": round(weekly, 2),
        "weeks_target": 4.0,
        "total_units_28d": total_28,
        "total_units_56d": total_56,
        "total_soh": total_soh,
        "total_recommended_qty": total_recommended,
        "velocity_method": "ewma_56d",
        "sizes": sizes,
    }


@app.get("/api/replenishment/calendar")
def replenishment_calendar(
    country:      str = Query(default=None),
    weeks_ahead:  int = Query(default=8),
):
    # Phase 2 B3 — forward-looking replenishment calendar. For every style we
    # project when its weeks-of-cover will fall to the lead-time + safety-stock
    # reorder threshold, then bucket the styles by the ISO week in which an order
    # must be placed so it arrives before stockout. Velocity is the standardized
    # recency-weighted weekly run-rate (28d ×2 over a 12-week denominator on the
    # trailing 56d window), identical to /weeks-of-cover and /replenish-by-color.
    from datetime import datetime, timedelta
    weeks_ahead = max(1, min(int(weeks_ahead), 52))
    subcat_list = "'" + "','".join(PRODUCT_SUBCATS) + "'"
    sales_extra = ""
    inv_extra = ""
    if country:
        sales_extra = " AND s.country IN (" + csv_to_sql(country) + ")"
        # Scope stock to the same country so weeks_of_cover / reorder_point /
        # priority compare local demand against local stock (architect review).
        inv_extra = " AND i.country IN (" + csv_to_sql(country) + ")"
    rows = run_query("""
        WITH sales AS (
            SELECT p.product_type AS subcategory, p.style_name, p.brand,
                SUM(s.ordered_item_quantity) FILTER (
                    WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '28 days') AS units_28,
                SUM(s.ordered_item_quantity) AS units_56
            FROM all_sales s
            LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order')
            AND s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
            AND """ + BASE_FILTERS + sales_extra + """
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name, p.brand
        ),
        stock AS (
            SELECT p.product_type AS subcategory, p.style_name,
                SUM(i.available) AS available
            FROM all_inventory i
            LEFT JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)""" + inv_extra + """
            AND p.product_type IN (""" + subcat_list + """)
            GROUP BY p.product_type, p.style_name
        ),
        base AS (
            SELECT COALESCE(st.subcategory, sa.subcategory) AS subcategory,
                COALESCE(st.style_name, sa.style_name) AS style_name,
                MAX(sa.brand) AS brand,
                COALESCE(st.available, 0) AS available,
                ((COALESCE(sa.units_28, 0) * 2)
                  + GREATEST(COALESCE(sa.units_56, 0) - COALESCE(sa.units_28, 0), 0)) / 12.0
                  AS weekly_units
            FROM stock st
            FULL OUTER JOIN sales sa
                ON st.subcategory = sa.subcategory AND st.style_name = sa.style_name
            WHERE COALESCE(st.style_name, sa.style_name) IS NOT NULL
            GROUP BY st.subcategory, sa.subcategory, st.style_name, sa.style_name,
                st.available, sa.units_28, sa.units_56
        )
        SELECT subcategory, style_name, brand, available,
            ROUND(weekly_units, 2) AS weekly_units,
            ROUND(available / NULLIF(weekly_units, 0), 1) AS weeks_of_cover,
            ROUND(weekly_units * """ + str(REORDER_COVER_WEEKS) + """)::int AS reorder_point
        FROM base
        WHERE weekly_units > 0
        ORDER BY weeks_of_cover ASC NULLS LAST
        LIMIT 5000
    """)

    today = date.today()
    # Monday of the current ISO week — every bucket is anchored on a Monday.
    current_monday = today - timedelta(days=today.weekday())
    horizon_end = current_monday + timedelta(weeks=weeks_ahead)

    buckets = {}  # week_start ISO date -> bucket dict

    def _bucket(week_start):
        key = week_start.isoformat()
        if key not in buckets:
            iso_year, iso_week, _ = week_start.isocalendar()
            buckets[key] = {
                "week_start": key,
                "iso_year": iso_year,
                "iso_week": iso_week,
                "week_label": "%d-W%02d" % (iso_year, iso_week),
                "critical": 0, "high": 0, "medium": 0,
                "styles": [],
            }
        return buckets[key]

    for r in rows:
        weekly = float(r.get("weekly_units") or 0)
        if weekly <= 0:
            continue
        available = float(r.get("available") or 0)
        woc = available / weekly  # raw weeks of cover
        # Weeks from now until cover decays to the reorder threshold.
        weeks_until = woc - REORDER_COVER_WEEKS

        if woc < LEAD_TIME_WEEKS:
            priority = "CRITICAL"
            action_monday = current_monday
            trigger_reason = (
                "Only %.1f weeks of cover — below the %.0f-week production lead "
                "time. Stockout imminent; expedite now." % (woc, LEAD_TIME_WEEKS)
            )
        elif weeks_until <= 0:
            priority = "HIGH"
            action_monday = current_monday
            trigger_reason = (
                "Below reorder point (%.1f wks cover < %.0f-wk threshold). "
                "Place the reorder this week." % (woc, REORDER_COVER_WEEKS)
            )
        else:
            # Will cross the reorder threshold in `weeks_until` weeks.
            action_monday = current_monday + timedelta(weeks=int(weeks_until // 1))
            if action_monday >= horizon_end:
                continue  # beyond the requested horizon — not actionable yet
            priority = "MEDIUM"
            trigger_reason = (
                "Projected to hit the reorder point in ~%d week(s) "
                "(%.1f wks cover now)." % (int(weeks_until // 1), woc)
            )

        b = _bucket(action_monday)
        b[priority.lower()] += 1
        b["styles"].append({
            "style_name": r.get("style_name"),
            "subcategory": r.get("subcategory"),
            "brand": r.get("brand"),
            "available": int(available),
            "weekly_units": round(weekly, 2),
            "weeks_of_cover": round(woc, 1),
            "reorder_point": int(r.get("reorder_point") or 0),
            "priority": priority,
            "trigger_reason": trigger_reason,
            "velocity_method": "ewma_56d",
        })

    _prio_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2}
    for b in buckets.values():
        b["styles"].sort(key=lambda s: (_prio_rank.get(s["priority"], 9),
                                        s["weeks_of_cover"]))
        b["count"] = len(b["styles"])

    ordered = [buckets[k] for k in sorted(buckets.keys())]
    return {
        "country": country,
        "weeks_ahead": weeks_ahead,
        "lead_time_weeks": LEAD_TIME_WEEKS,
        "safety_weeks": SAFETY_WEEKS,
        "reorder_cover_weeks": REORDER_COVER_WEEKS,
        "generated_at": today.isoformat(),
        "total_styles": sum(b["count"] for b in ordered),
        "velocity_method": "ewma_56d",
        "buckets": ordered,
    }


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
        sales_extra += " AND s.pos_location_name IN (" + csv_to_sql(channel) + ")"
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
            "size_mix": [],
        })
    out.sort(key=lambda x: x["total_recommended_qty"], reverse=True)
    # Phase 2 A3 — attach a per-style size_mix (recommended qty split across the
    # size run by 28d sales mix). One query for every style that made the cut.
    if out:
        names = [o["style_name"] for o in out]
        style_filter = (" AND p.style_name IN ("
                        + ",".join("'" + _sql_str(n) + "'" for n in names) + ")")
        size_rows = _size_mix_rows(style_filter, sales_extra, inv_country)
        by_style = {}
        for r in size_rows:
            by_style.setdefault(r["style"], []).append(r)
        for o in out:
            o["size_mix"] = _build_size_mix(
                by_style.get(o["style_name"], []), o["total_recommended_qty"])
    return out
@app.get("/api/analytics/replenishment-completed")
def analytics_replenishment_completed(days: int = Query(default=30)):
    rows = _users_exec(
        "SELECT rec_key, actual_units, acted_by, acted_at, transfer_ref "
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
            "transfer_ref": r.get("transfer_ref") or "",
            "completed_by": r["acted_by"],
            "completed_at": r["acted_at"].isoformat() if r.get("acted_at") else None,
        })
    return {"rows": out, "total": sum(x["actual_units_replenished"] for x in out)}


@app.get("/api/analytics/replenishment-transfer-report")
def analytics_replenishment_transfer_report(
    days:      int = Query(default=60),
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    rec_type:  str = Query(default="replenish"),
):
    """DONE recommendations grouped by POS location + day, for tracking what was
    marked done against the actual Odoo transfer document.

    Shared by two surfaces via `rec_type`: 'replenish' (Replenishments /
    Replenishment-by-style) and 'warehouse_return' (the Warehouse Returns page).
    Once an item is marked done it lands in `recommendation_actions`
    (status='done'); this report rolls those rows up into one bucket per
    (POS location, day) so an operator can record the single Odoo transfer
    number that physically moved that store's items that day.

    Window: by default the trailing `days` days; pass `date_from`/`date_to`
    (YYYY-MM-DD, inclusive) to use a custom EAT calendar range instead. Days
    bucket by Africa/Nairobi (EAT) so a late-evening mark is not pushed to the
    next UTC day. Items are enriched with product name/size/colour from
    all_products_clean (same DB) and de-duplicated: a replenish mark writes BOTH
    a 'sku' and a 'barcode' keyed row for the same physical item, so we collapse
    them to one canonical SKU (warehouse returns write a single sku row)."""
    from fastapi import HTTPException
    rt = rec_type if rec_type in _TRANSFER_REC_TYPES else "replenish"
    df = (date_from or "").strip()
    dt = (date_to or "").strip()
    params = [rt]
    if df and dt:
        try:
            date.fromisoformat(df); date.fromisoformat(dt)
        except ValueError:
            raise HTTPException(status_code=400,
                                detail="date_from/date_to must be YYYY-MM-DD")
        win_sql = ("    AND (acted_at AT TIME ZONE 'Africa/Nairobi')::date "
                   "BETWEEN %s::date AND %s::date")
        params += [df, dt]
    else:
        win_sql = "    AND acted_at >= now() - (%s || ' days')::interval"
        params.append(str(int(days)))
    rows = _users_exec(
        "WITH done AS ("
        "  SELECT split_part(rec_key,'|',1) AS pos_location,"
        "         split_part(rec_key,'|',2) AS kind,"
        "         split_part(rec_key,'|',3) AS value,"
        "         (acted_at AT TIME ZONE 'Africa/Nairobi')::date AS day,"
        "         COALESCE(actual_units,0) AS actual_units,"
        "         COALESCE(transfer_ref,'') AS transfer_ref,"
        "         acted_by, acted_at"
        "  FROM recommendation_actions"
        "  WHERE rec_type=%s AND status='done'"
        + win_sql +
        ") "
        "SELECT d.pos_location, d.kind, d.value, d.day, d.actual_units,"
        "       d.transfer_ref, d.acted_by, d.acted_at,"
        "       CASE WHEN d.kind='sku' THEN d.value ELSE p.sku END AS canon_sku,"
        "       COALESCE(p.product_name,'') AS product_name,"
        "       COALESCE(p.size,'') AS size,"
        "       COALESCE(p.color_print,'') AS color_print,"
        "       CASE WHEN d.kind='barcode' THEN d.value ELSE COALESCE(p.barcode,'') END AS barcode,"
        "       CASE WHEN d.kind='sku' THEN d.value ELSE COALESCE(p.sku,'') END AS sku "
        "FROM done d "
        "LEFT JOIN all_products_clean p "
        "  ON (d.kind='sku' AND p.sku = d.value) "
        "  OR (d.kind='barcode' AND p.barcode = d.value) "
        "ORDER BY d.day DESC, d.pos_location ASC, d.acted_at DESC",
        tuple(params), fetch=True) or []

    groups = {}
    for r in rows:
        pos = r.get("pos_location") or ""
        day = r["day"].isoformat() if r.get("day") else ""
        gkey = (pos, day)
        g = groups.get(gkey)
        if g is None:
            g = {"pos_location": pos, "day": day, "items": [],
                 "_seen": set(), "_refs": set()}
            groups[gkey] = g
        # Collapse the twin sku/barcode rows written for one physical item.
        canon = (r.get("canon_sku") or "").strip()
        itemkey = canon if canon else f"{r.get('kind')}:{r.get('value')}"
        if itemkey in g["_seen"]:
            continue
        g["_seen"].add(itemkey)
        ref = (r.get("transfer_ref") or "").strip()
        if ref:
            g["_refs"].add(ref)
        g["items"].append({
            "sku": r.get("sku") or "",
            "barcode": r.get("barcode") or "",
            "product_name": r.get("product_name") or "",
            "size": r.get("size") or "",
            "color_print": r.get("color_print") or "",
            "actual_units": int(r.get("actual_units") or 0),
            "transfer_ref": ref,
            "completed_by": r.get("acted_by") or "",
            "completed_at": r["acted_at"].isoformat() if r.get("acted_at") else None,
        })

    out_groups = []
    for g in groups.values():
        refs = sorted(g.pop("_refs"))
        g.pop("_seen", None)
        g["transfer_ref"] = refs[0] if len(refs) == 1 else ""
        g["transfer_ref_mixed"] = len(refs) > 1
        g["transfer_refs"] = refs
        g["item_count"] = len(g["items"])
        g["total_units"] = sum(i["actual_units"] for i in g["items"])
        out_groups.append(g)
    # Most recent day first, then POS name.
    out_groups.sort(key=lambda g: (g["day"], g["pos_location"]), reverse=True)
    out_groups.sort(key=lambda g: g["pos_location"])
    out_groups.sort(key=lambda g: g["day"], reverse=True)
    return {
        "groups": out_groups,
        "group_count": len(out_groups),
        "total_units": sum(g["total_units"] for g in out_groups),
        "rec_type": rt,
    }


@app.post("/api/analytics/replenishment-transfer-report/assign")
async def analytics_replenishment_transfer_assign(request: Request):
    """Stamp ONE Odoo transfer number onto every done recommendation for a given
    (POS location, day) bucket, so the marked-done items can be reconciled
    against the physical transfer document. Day is the EAT calendar day used by
    the report above. `rec_type` selects the surface ('replenish' default, or
    'warehouse_return')."""
    from fastapi import HTTPException
    body = await request.json()
    pos_location = (body.get("pos_location") or "").strip()
    day = (body.get("day") or "").strip()
    transfer_ref = (body.get("transfer_ref") or "").strip()
    rec_type = (body.get("rec_type") or "replenish").strip()
    rt = rec_type if rec_type in _TRANSFER_REC_TYPES else "replenish"
    if not pos_location or not day:
        raise HTTPException(status_code=400, detail="pos_location and day are required")
    try:
        date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="day must be YYYY-MM-DD")
    updated = _users_exec(
        "UPDATE recommendation_actions "
        "SET transfer_ref = %s "
        "WHERE rec_type=%s AND status='done' "
        "  AND split_part(rec_key,'|',1) = %s "
        "  AND (acted_at AT TIME ZONE 'Africa/Nairobi')::date = %s::date "
        "RETURNING 1",
        ((transfer_ref or None), rt, pos_location, day), fetch=True) or []
    return {
        "ok": True, "pos_location": pos_location, "day": day,
        "transfer_ref": transfer_ref, "updated": len(updated), "rec_type": rt,
    }


def _replen_clean_text(s, maxlen=80):
    # Free-text search/value sanitiser for inlined SQL literals: strip the
    # chars that could break out of a string literal. Values are matched with
    # doubled single-quotes at the call site for exact-match literals.
    return (str(s or "")).replace("\\", "").replace(";", "").strip()[:maxlen]


@app.get("/api/analytics/replenish-options")
def analytics_replenish_options(mode: str = Query(default="style"),
                                q: str = Query(default="")):
    # Typeahead options for the Replenish-by-Item picker. mode='style' returns
    # distinct style names; mode='sku' returns sku + product name + barcode.
    qq = _replen_clean_text(q, 60).lower().replace("'", "")
    like = "%" + qq + "%"
    if mode == "sku":
        rows = run_query(
            "SELECT sku AS value, "
            "COALESCE(NULLIF(product_name, ''), sku) AS label, "
            "COALESCE(barcode, '') AS barcode, "
            "COALESCE(style_name, '') AS style_name "
            "FROM all_products_clean "
            "WHERE LOWER(sku) LIKE '" + like + "' "
            "OR LOWER(COALESCE(product_name, '')) LIKE '" + like + "' "
            "OR LOWER(COALESCE(barcode, '')) LIKE '" + like + "' "
            "ORDER BY product_name NULLS LAST, sku LIMIT 50")
    else:
        rows = run_query(
            "SELECT style_name AS value, style_name AS label, "
            "COUNT(*) AS sku_count "
            "FROM all_products_clean "
            "WHERE style_name IS NOT NULL AND style_name <> '' "
            "AND brand IN ('Vivo', 'Safari', 'Zoya') "
            "AND LOWER(style_name) LIKE '" + like + "' "
            "GROUP BY style_name ORDER BY style_name LIMIT 50")
    return {"mode": "sku" if mode == "sku" else "style", "options": rows}


def _cap_replenish_to_warehouse(rows, *, need_key, out_key,
                                sku_key="sku", wh_key="soh_wh",
                                sold_key="units_sold", loc_key="pos_location"):
    """Cap suggested replenishment so the units recommended for a SKU across all
    stores never exceed that SKU's warehouse stock-on-hand (soh_wh).

    A SKU's finite warehouse units are a shared pool: independently suggesting
    ``need`` for every understocked store double-counts that pool, so the page can
    recommend sending more than the warehouse physically holds. Here each SKU's
    warehouse SOH is ALLOCATED to the TOP-PERFORMING stores first (most units sold
    in the window), then by largest unmet need, then store name for a stable,
    deterministic split. Mutates ``rows`` in place (sets ``out_key``) and returns
    them. Single-store SKUs simply get min(need, soh_wh)."""
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        groups[r.get(sku_key)].append(r)
    for grp in groups.values():
        # soh_wh is a per-SKU figure (every row in the group should carry the same
        # value); take the max defensively so an upstream NULL/anomaly on one row
        # can't shrink the pool below the SKU's true warehouse stock.
        remaining = max((int(r.get(wh_key) or 0) for r in grp), default=0)
        grp.sort(key=lambda r: (
            -(int(r.get(sold_key) or 0)),
            -(int(r.get(need_key) or 0)),
            str(r.get(loc_key) or ""),
        ))
        for r in grp:
            need = max(0, int(r.get(need_key) or 0))
            alloc = min(need, remaining) if remaining > 0 else 0
            r[out_key] = alloc
            remaining -= alloc
    return rows


@app.get("/api/analytics/replenish-by-item")
def analytics_replenish_by_item(
    mode: str = Query(default="style"),
    value: str = Query(default=""),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    low_threshold: int = Query(default=2),
):
    # Item-centric allocation: pick one style (all its sizes/colours) or one
    # sku, then list the retail stores that are understocked (current store SOH
    # below ``low_threshold``) while the warehouse still has units to send.
    _warehouse_bins_refresh()
    val = _replen_clean_text(value, 120)
    if not val:
        return {"mode": mode, "value": "", "warehouse_soh": 0, "rows": []}
    if not date_from or not date_to:
        date_to = str(date.today())
        date_from = str(date.today() - timedelta(days=90))
    lit = val.replace("'", "''")
    thr = max(0, int(low_threshold))
    sku_pred = ("sku = '" + lit + "'") if mode == "sku" else ("style_name = '" + lit + "'")
    item_skus = "(SELECT sku FROM all_products_clean WHERE " + sku_pred + ")"

    # Per (store, sku) understocked rows carrying the SAME column set as the main
    # Replenishment list (owner, days-lapsed, product, size, barcode, bin, sold,
    # store SOH, WH SOH, suggested + the mark fields) so this view is a drop-in
    # item-filtered equivalent. A store appears when its SOH for an item SKU is
    # below the threshold while the warehouse still holds units to send.
    rows = run_query("""
        WITH sold AS (
            SELECT s.pos_location_name, s.variant_sku AS sku,
                SUM(s.net_quantity) AS units_sold,
                MAX(s.product_title) AS product_name,
                MAX(s.country) AS country,
                MAX(s.sale_date) AS last_sale
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND """ + BASE_FILTERS + """
              AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND (s.pos_location_name NOT ILIKE '%online%'
                   OR s.pos_location_name = 'Online - Shop Zetu')
              AND s.variant_sku IN """ + item_skus + """
            GROUP BY 1, 2
        ),
        store_soh AS (
            SELECT i.pos_location_name, i.sku,
                SUM(i.available) AS soh_store, MAX(i.location_name) AS bin
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
              AND i.sku IN """ + item_skus + """
            GROUP BY 1, 2
        ),
        wh_soh AS (
            SELECT i.sku, SUM(i.available) AS soh_wh
            FROM all_inventory i
            WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
              AND i.sku IN """ + item_skus + """
            GROUP BY 1
        )
        SELECT COALESCE(sold.pos_location_name, ss.pos_location_name) AS pos_location,
            COALESCE(sold.sku, ss.sku) AS sku,
            COALESCE(sold.units_sold, 0) AS units_sold,
            sold.product_name, sold.country, sold.last_sale,
            COALESCE(ss.soh_store, 0) AS soh_store,
            COALESCE(NULLIF(wb.bin, ''), '') AS bin,
            COALESCE(w.soh_wh, 0) AS soh_wh,
            COALESCE(p.size, '') AS size, COALESCE(p.barcode, '') AS barcode,
            COALESCE(p.color_print, '') AS color_print, COALESCE(p.print_plain, '') AS print_plain,
            p.product_name AS pname
        FROM sold
        FULL OUTER JOIN store_soh ss
          ON ss.pos_location_name = sold.pos_location_name AND ss.sku = sold.sku
        LEFT JOIN wh_soh w ON w.sku = COALESCE(sold.sku, ss.sku)
        LEFT JOIN all_products_clean p ON p.sku = COALESCE(sold.sku, ss.sku)
        LEFT JOIN warehouse_bins wb ON wb.barcode = p.barcode
        WHERE COALESCE(ss.soh_store, 0) < """ + str(thr) + """
          AND COALESCE(w.soh_wh, 0) > 0
    """)
    # Warehouse SOH is computed independently of the understock rows so the
    # header signal is correct even when no store is currently understocked.
    wh_rows = run_query("""
        SELECT COALESCE(SUM(i.available), 0) AS soh_wh
        FROM all_inventory i
        WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
          AND i.sku IN """ + item_skus + """
    """)
    wh_soh = int((wh_rows[0]["soh_wh"] if wh_rows else 0) or 0)
    store_map = _replen_store_owner_map()
    marks_all = _replen_marks()
    today = date.today()
    out = []
    for r in rows:
        st = r.get("pos_location") or ""
        if st.lower().find("online") >= 0 and st != "Online - Shop Zetu":
            continue
        soh = int(r["soh_store"] or 0)
        units = int(r["units_sold"] or 0)
        soh_wh = int(r["soh_wh"] or 0)
        barcode = r.get("barcode") or ""
        sku = r.get("sku")
        days_lapsed = None
        if r.get("last_sale"):
            try:
                days_lapsed = (today - date.fromisoformat(str(r["last_sale"])[:10])).days
            except ValueError:
                days_lapsed = None
        mark = (marks_all.get((st, "sku", sku))
                or marks_all.get((st, "barcode", barcode)) or {})
        out.append({
            "pos_location": st, "sku": sku, "barcode": barcode,
            "product_name": r.get("pname") or r.get("product_name") or "",
            "size": r.get("size") or "", "bin": r.get("bin") or "",
            "color_print": r.get("color_print") or "", "print_plain": r.get("print_plain") or "",
            "country": r.get("country"),
            "units_sold": units, "soh_store": soh, "soh_wh": soh_wh,
            "suggested_units": max(thr - soh, 0),
            "days_lapsed": days_lapsed,
            "last_sale": str(r["last_sale"]) if r.get("last_sale") else None,
            "replenished": bool(mark.get("replenished", False)),
            "actual_units_replenished": int(mark.get("actual_units_replenished", 0)),
            "transfer_ref": mark.get("transfer_ref") or "",
        })
    # Allocate each SKU's warehouse pool across stores (top sellers first) so the
    # suggested total per SKU never exceeds its warehouse stock.
    _cap_replenish_to_warehouse(out, need_key="suggested_units", out_key="suggested_units")
    # Drop rows the warehouse pool can no longer cover (suggested capped to 0) — a
    # zero-unit suggestion is not actionable and must not appear in the list.
    out = [r for r in out if int(r.get("suggested_units") or 0) > 0]
    _owners = _replen_owners()
    for row in out:
        row["owner"] = _owner_for_store(row.get("pos_location"), store_map, _owners)
    out.sort(key=lambda x: (x["units_sold"], -x["soh_store"]), reverse=True)
    return {"mode": "sku" if mode == "sku" else "style", "value": val,
            "warehouse_soh": wh_soh, "date_from": date_from, "date_to": date_to,
            "low_threshold": thr, "rows": out}


@app.get("/api/analytics/replenish-gaps")
def analytics_replenish_gaps(
    store: str = Query(default=""),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    low_threshold: int = Query(default=2),
    limit: int = Query(default=300),
):
    # Store-centric gap finder: items a store SOLD in the window but barely
    # stocks now (store SOH below ``low_threshold``) while the warehouse has
    # units to send — i.e. proven local demand the store can't currently serve.
    _warehouse_bins_refresh()
    st = _replen_clean_text(store, 120)
    if not st:
        return {"store": "", "rows": []}
    if not date_from or not date_to:
        date_to = str(date.today())
        date_from = str(date.today() - timedelta(days=90))
    thr = max(0, int(low_threshold))
    # "__all__" = every selling store at once (one row per store × sku). Warehouses
    # are excluded and online channels are dropped except Online - Shop Zetu, matching
    # the cross-store replenishment report. A single store name uses an exact match.
    all_stores = (st == "__all__")
    if all_stores:
        rows = run_query("""
            WITH sold AS (
                SELECT s.pos_location_name AS pos_location, s.variant_sku AS sku,
                    SUM(s.net_quantity) AS units_sold,
                    MAX(s.product_title) AS product_name,
                    MAX(s.sale_date) AS last_sale
                FROM all_sales s
                WHERE s.sale_kind IN ('sale','order')
                  AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                  AND """ + BASE_FILTERS + """
                  AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
                  AND (s.pos_location_name NOT ILIKE '%online%'
                       OR s.pos_location_name = 'Online - Shop Zetu')
                  AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
                GROUP BY s.pos_location_name, s.variant_sku
                HAVING SUM(s.net_quantity) > 0
            ),
            store_soh AS (
                SELECT i.pos_location_name, i.sku, SUM(i.available) AS soh, MAX(i.location_name) AS bin
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
            SELECT sold.pos_location, sold.sku, COALESCE(NULLIF(p.product_name, ''), sold.product_name) AS product_name, sold.units_sold, sold.last_sale,
                COALESCE(ss.soh, 0) AS soh_store,
                COALESCE(NULLIF(wb.bin, ''), '') AS bin,
                COALESCE(w.soh_wh, 0) AS soh_wh,
                COALESCE(p.style_name, '') AS style_name,
                COALESCE(p.size, '') AS size, COALESCE(p.barcode, '') AS barcode,
                COALESCE(p.color_print, '') AS color_print, COALESCE(p.print_plain, '') AS print_plain
            FROM sold
            LEFT JOIN store_soh ss ON ss.pos_location_name = sold.pos_location AND ss.sku = sold.sku
            LEFT JOIN wh_soh w ON w.sku = sold.sku
            LEFT JOIN all_products_clean p ON p.sku = sold.sku
            LEFT JOIN warehouse_bins wb ON wb.barcode = p.barcode
            WHERE COALESCE(ss.soh, 0) < """ + str(thr) + """ AND COALESCE(w.soh_wh, 0) > 0
            ORDER BY sold.units_sold DESC
            LIMIT """ + str(int(limit)))
    else:
        lit = st.replace("'", "''")
        rows = run_query("""
            WITH sold AS (
                SELECT s.variant_sku AS sku,
                    SUM(s.net_quantity) AS units_sold,
                    MAX(s.product_title) AS product_name,
                    MAX(s.sale_date) AS last_sale
                FROM all_sales s
                WHERE s.sale_kind IN ('sale','order')
                  AND s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
                  AND s.pos_location_name = '""" + lit + """'
                  AND """ + BASE_FILTERS + """
                  AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
                GROUP BY s.variant_sku
                HAVING SUM(s.net_quantity) > 0
            ),
            store_soh AS (
                SELECT i.sku, SUM(i.available) AS soh, MAX(i.location_name) AS bin
                FROM all_inventory i
                WHERE i.pos_location_name = '""" + lit + """'
                GROUP BY i.sku
            ),
            wh_soh AS (
                SELECT i.sku, SUM(i.available) AS soh_wh
                FROM all_inventory i
                WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)
                GROUP BY i.sku
            )
            SELECT sold.sku, COALESCE(NULLIF(p.product_name, ''), sold.product_name) AS product_name, sold.units_sold, sold.last_sale,
                COALESCE(ss.soh, 0) AS soh_store,
                COALESCE(NULLIF(wb.bin, ''), '') AS bin,
                COALESCE(w.soh_wh, 0) AS soh_wh,
                COALESCE(p.style_name, '') AS style_name,
                COALESCE(p.size, '') AS size, COALESCE(p.barcode, '') AS barcode,
                COALESCE(p.color_print, '') AS color_print, COALESCE(p.print_plain, '') AS print_plain
            FROM sold
            LEFT JOIN store_soh ss ON ss.sku = sold.sku
            LEFT JOIN wh_soh w ON w.sku = sold.sku
            LEFT JOIN all_products_clean p ON p.sku = sold.sku
            LEFT JOIN warehouse_bins wb ON wb.barcode = p.barcode
            WHERE COALESCE(ss.soh, 0) < """ + str(thr) + """ AND COALESCE(w.soh_wh, 0) > 0
            ORDER BY sold.units_sold DESC
            LIMIT """ + str(int(limit)))
    store_map = _replen_store_owner_map()
    _owners = _replen_owners()
    marks_all = _replen_marks()
    today = date.today()
    out = []
    for idx, r in enumerate(rows):
        loc = (r.get("pos_location") or "") if all_stores else st
        soh = int(r["soh_store"] or 0)
        soh_wh = int(r["soh_wh"] or 0)
        barcode = r.get("barcode") or ""
        sku = r["sku"]
        days_lapsed = None
        if r.get("last_sale"):
            try:
                days_lapsed = (today - date.fromisoformat(str(r["last_sale"])[:10])).days
            except ValueError:
                days_lapsed = None
        mark = (marks_all.get((loc, "sku", sku))
                or marks_all.get((loc, "barcode", barcode)) or {})
        out.append({
            "pos_location": loc, "owner": _owner_for_store(loc, store_map, _owners),
            "sku": sku, "barcode": barcode,
            "product_name": r.get("product_name") or "",
            "style_name": r.get("style_name") or "", "size": r.get("size") or "",
            "bin": r.get("bin") or "",
            "color_print": r.get("color_print") or "", "print_plain": r.get("print_plain") or "",
            "units_sold": int(r["units_sold"] or 0), "soh_store": soh,
            "soh_wh": soh_wh,
            "suggested_units": max(thr - soh, 0),
            "days_lapsed": days_lapsed,
            "last_sale": str(r["last_sale"]) if r.get("last_sale") else None,
            "replenished": bool(mark.get("replenished", False)),
            "actual_units_replenished": int(mark.get("actual_units_replenished", 0)),
            "transfer_ref": mark.get("transfer_ref") or "",
        })
    # Allocate each SKU's warehouse pool across stores (top sellers first) so the
    # suggested total per SKU never exceeds its warehouse stock.
    _cap_replenish_to_warehouse(out, need_key="suggested_units", out_key="suggested_units")
    # Drop rows the warehouse pool can no longer cover (suggested capped to 0) — a
    # zero-unit suggestion is not actionable and must not appear in the list.
    out = [r for r in out if int(r.get("suggested_units") or 0) > 0]
    return {"store": st, "date_from": date_from, "date_to": date_to,
            "low_threshold": thr, "rows": out}


# Shared XLSX column set for the Replenish by Style / SKU exports — mirrors the
# ReplenTable columns shown in the UI for both the By Item and Store Gaps views.
def _replen_colour_print(r):
    # Colour only — the colour name (color_print) is the meaningful descriptor;
    # the generic print_plain ("Print"/"Plain") is dropped per ops request.
    return (r.get("color_print") or "").strip()


_REPLEN_ITEM_XLSX_COLS = [
    "Owner", "Store", "Days Lapsed", "Last Sold", "Product", "Size",
    "Barcode", "Bin", "Colour", "Units Sold", "Store SOH", "WH SOH",
    "Suggested", "Actual Replenished", "Transfer Ref",
]


def _replen_item_xlsx_row(r):
    return [
        r.get("owner") or "—", r.get("pos_location") or "",
        r.get("days_lapsed") if r.get("days_lapsed") is not None else "",
        (str(r.get("last_sale"))[:10] if r.get("last_sale") else ""),
        r.get("product_name") or "", r.get("size") or "",
        r.get("barcode") or "", r.get("bin") or "",
        _replen_colour_print(r),
        int(r.get("units_sold") or 0), int(r.get("soh_store") or 0),
        int(r.get("soh_wh") or 0), int(r.get("suggested_units") or 0),
        int(r.get("actual_units_replenished") or 0), r.get("transfer_ref") or "",
    ]


@app.get("/api/analytics/replenish-by-item/export")
def analytics_replenish_by_item_export(
    mode: str = Query(default="style"),
    value: str = Query(default=""),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    low_threshold: int = Query(default=2),
):
    # Excel export of the By Item replenishment view. Reuses the JSON endpoint's
    # row builder verbatim (no SQL duplication) and writes the same columns the
    # UI table shows.
    from openpyxl import Workbook
    data = analytics_replenish_by_item(
        mode=mode, value=value, date_from=date_from, date_to=date_to,
        low_threshold=low_threshold)
    rows = data.get("rows", [])
    wb = Workbook()
    ws = wb.active
    ws.title = _xlsx_sheet_title(
        ("SKU " if mode == "sku" else "Style ") + (data.get("value") or "Replenish"),
        set())
    _xlsx_header(ws, _REPLEN_ITEM_XLSX_COLS)
    for r in rows:
        ws.append(_replen_item_xlsx_row(r))
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", (data.get("value") or "item")).strip("_") or "item"
    label = "SKU" if mode == "sku" else "Style"
    return _xlsx_response(
        wb, f"Replenish_By_{label}_{safe}_{date.today().isoformat()}.xlsx")


@app.get("/api/analytics/replenish-gaps/export")
def analytics_replenish_gaps_export(
    store: str = Query(default=""),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    low_threshold: int = Query(default=2),
    limit: int = Query(default=300),
):
    # Excel export of the Store Gaps view — same reuse pattern as By Item.
    from openpyxl import Workbook
    data = analytics_replenish_gaps(
        store=store, date_from=date_from, date_to=date_to,
        low_threshold=low_threshold, limit=limit)
    rows = data.get("rows", [])
    st = data.get("store") or "store"
    title = "All Stores" if st == "__all__" else st
    wb = Workbook()
    ws = wb.active
    ws.title = _xlsx_sheet_title("Gaps " + title, set())
    _xlsx_header(ws, _REPLEN_ITEM_XLSX_COLS)
    for r in rows:
        ws.append(_replen_item_xlsx_row(r))
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", title).strip("_") or "store"
    return _xlsx_response(
        wb, f"Replenish_Gaps_{safe}_{date.today().isoformat()}.xlsx")


def _compute_replenishment_report_rows(date_from=None, date_to=None, limit=400):
    """Core of the replenishment pick list: per-(store,SKU) rows with the
    suggested 'replenish' units (warehouse-capped; zero-need rows dropped),
    WITHOUT owner assignment or size-mix enrichment. Shared by the report
    endpoint and the picker-balancing weight calc so both compute identical
    per-store units."""
    if not date_from or not date_to:
        date_to = str(date.today())
        date_from = str(date.today() - timedelta(days=30))
    _warehouse_bins_refresh()
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
              -- Include Online (Shop Zetu) as a replenishable channel; other
              -- online channels (e.g. Online - vivo-uganda) stay excluded.
              AND (s.pos_location_name NOT ILIKE '%online%'
                   OR s.pos_location_name = 'Online - Shop Zetu')
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
            COALESCE(NULLIF(p.product_name, ''), sold.product_name) AS product_name, sold.variant_sku AS sku, sold.units_sold, sold.last_sale,
            p.size AS size, p.barcode,
            COALESCE(p.color_print, '') AS color_print, COALESCE(p.print_plain, '') AS print_plain,
            COALESCE(ss.soh_store, 0) AS soh_store,
            COALESCE(NULLIF(wb.bin, ''), '') AS bin,
            COALESCE(w.soh_wh, 0) AS soh_wh
        FROM sold
        LEFT JOIN store_soh ss ON ss.pos_location_name = sold.pos_location_name AND ss.sku = sold.variant_sku
        LEFT JOIN wh_soh w ON w.sku = sold.variant_sku
        LEFT JOIN all_products_clean p ON p.sku = sold.variant_sku
        LEFT JOIN warehouse_bins wb ON wb.barcode = p.barcode
        WHERE COALESCE(ss.soh_store, 0) < sold.units_sold AND COALESCE(w.soh_wh, 0) > 0
        ORDER BY (sold.units_sold - COALESCE(ss.soh_store, 0)) DESC
        LIMIT """ + str(int(limit)))
    marks_all = _replen_marks()
    today = date.today()
    out_rows = []
    for r in rows:
        units_sold = int(r["units_sold"] or 0)
        soh_store = int(r["soh_store"] or 0)
        soh_wh = int(r["soh_wh"] or 0)
        # Uncapped per-store need; the finite warehouse pool is allocated across
        # stores (top sellers first) by _cap_replenish_to_warehouse below so the
        # SKU's total suggested never exceeds soh_wh.
        replenish = max(0, units_sold - soh_store)
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
            "country": r.get("country"),
            "pos_location": r.get("pos_location"), "product_name": r.get("product_name"),
            "size": r.get("size") or "", "barcode": r.get("barcode") or "",
            "sku": r.get("sku"), "bin": r.get("bin") or "",
            "color_print": r.get("color_print") or "", "print_plain": r.get("print_plain") or "",
            "units_sold": units_sold, "soh_store": soh_store, "soh_wh": soh_wh,
            "replenish": replenish, "replenished": bool(mark.get("replenished", False)),
            "actual_units_replenished": int(mark.get("actual_units_replenished", 0)),
            "transfer_ref": mark.get("transfer_ref") or "",
            "days_lapsed": days_lapsed,
        })
    # Allocate each SKU's warehouse pool across stores (top sellers first) so the
    # suggested ("replenish") never exceeds warehouse stock for that SKU.
    _cap_replenish_to_warehouse(out_rows, need_key="replenish", out_key="replenish")
    # Drop rows the warehouse pool can no longer cover (replenish capped to 0) — a
    # zero-unit suggestion is not actionable, so it must not appear in the list nor
    # inflate the per-owner line/unit counts or the size-mix below.
    out_rows = [r for r in out_rows if int(r.get("replenish") or 0) > 0]
    return out_rows


@app.get("/api/analytics/replenishment-report")
def analytics_replenishment_report(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    limit: int = Query(default=400),
):
    out_rows = _compute_replenishment_report_rows(date_from, date_to, limit)
    # Distribute the pick list so each picker gets as close to EQUAL UNITS as
    # possible. Rows are ordered by POS location, so each store's lines stay
    # contiguous and a store is split between two pickers only when the
    # equal-units boundary lands inside it (one POS may be shared by >1 picker).
    # FROZEN assignment: the equal-units balance is computed ONLY by the explicit
    # "Save & redistribute" action (see _redistribute_replen_owners) and persisted
    # as a {line_key: owner} map. We read it back here so a page reload never
    # reshuffles a picker's lines — a picker who finished early can refresh without
    # being handed new work. Lines added since the last redistribute fall back to
    # that store's main picker, else a stable hash (also reload-stable).
    owners = _replen_owners()
    line_map = _replen_line_owner_map()
    store_fallback = {}
    _store_owner_counts = {}
    for _k, _ow in line_map.items():
        _store = _k.split("\u0001", 1)[0]
        _d = _store_owner_counts.setdefault(_store, {})
        _d[_ow] = _d.get(_ow, 0) + 1
    for _store, _d in _store_owner_counts.items():
        store_fallback[_store] = max(_d.items(), key=lambda kv: kv[1])[0]
    out_rows.sort(key=lambda r: (str(r.get("pos_location") or ""),
                                 str(r.get("sku") or ""),
                                 str(r.get("barcode") or "")))
    for r in out_rows:
        r["owner"] = _owner_for_line(
            r.get("pos_location"), r.get("sku"), line_map, owners, store_fallback)
    by_owner = {}
    for r in out_rows:
        o = by_owner.setdefault(r["owner"], {"owner": r["owner"], "lines": 0, "units": 0, "stores": set()})
        o["lines"] += 1
        o["units"] += r["replenish"]
        o["stores"].add(r["pos_location"])
    by_owner_list = sorted(
        [{"owner": o["owner"], "lines": o["lines"], "units": o["units"], "stores": len(o["stores"])} for o in by_owner.values()],
        key=lambda x: x["units"], reverse=True)
    # Phase 3 A3-ext — attach a recommended-qty size curve per (store, style).
    # Two batch queries total: sku->style map, then one size-mix pull for every
    # style on the page (chain-wide curve), split per (store, style) group total.
    _skus = sorted({r["sku"] for r in out_rows if r.get("sku")})
    _sku_style = {}
    if _skus:
        _sku_in = ",".join("'" + _sql_str(x) + "'" for x in _skus)
        for m in (run_query(
                "SELECT sku, style_name FROM all_products_clean WHERE sku IN ("
                + _sku_in + ") AND COALESCE(style_name,'') <> ''") or []):
            _sku_style[m["sku"]] = m["style_name"]
    _styles = sorted({v for v in _sku_style.values() if v})
    _style_rows = {}
    if _styles:
        _style_in = " AND p.style_name IN (" + ",".join("'" + _sql_str(x) + "'" for x in _styles) + ")"
        for sr in (_size_mix_rows(_style_in, "", "") or []):
            _style_rows.setdefault(sr["style"], []).append(sr)
    _grp_total = {}
    for r in out_rows:
        st = _sku_style.get(r.get("sku"))
        if st:
            _grp_total[(r["pos_location"], st)] = _grp_total.get((r["pos_location"], st), 0) + r["replenish"]
    _grp_mix = {}
    for (loc, st), tot in _grp_total.items():
        srows = _style_rows.get(st)
        if srows and tot > 0:
            _grp_mix[(loc, st)] = _build_size_mix(srows, tot)
    for r in out_rows:
        st = _sku_style.get(r.get("sku"))
        mix = _grp_mix.get((r["pos_location"], st)) if st else None
        r["style_name"] = st
        r["size_breakdown"] = mix or []
        r["size_breakdown_available"] = bool(mix)
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
def _rollup_country_where(country):
    """Standalone WHERE clause filtering a rollup table's `country` column by the
    same csv/lowercase contract as _style_filters' country branch. Returns "" when
    no country is selected (the All scope)."""
    if not country:
        return ""
    cs = [c.strip().lower() for c in country.split(",") if c.strip()]
    if not cs:
        return ""
    return " WHERE LOWER(country) IN (" + ",".join(
        "'" + c.replace("'", "''") + "'" for c in cs) + ")"


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
def notifications_list(request: Request):
    # Surface pending access requests (app_users.status='pending') to admins so
    # they get a real, actionable inbox item linking to the Users page. Other
    # users see an empty inbox. Items are derived live (not stored), so they stay
    # visible until the admin approves/rejects the user.
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        return []
    rows = _users_exec(
        "SELECT user_id, email, name, created_at FROM app_users "
        "WHERE status='pending' ORDER BY created_at DESC", fetch=True) or []
    out = []
    for r in rows:
        who = r.get("name") or r.get("email") or "A user"
        out.append({
            "event_id": "access:" + str(r["user_id"]),
            "type": "access_request",
            "title": "Access request",
            "message": f"{who} requested access — review on the Users page.",
            "link": "/users",
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
            "read": False,
        })
    return out
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
# RAG target bands for the Range tier counts. Aligned to the 2026 Range Strategy
# (PPT) lifecycle framework: a healthy active range of ~500-700 styles split across
# the four lifecycle tiers. RAG is an app-only health indicator that brackets the
# strategy's per-tier style-count targets.
_RANGE_TARGETS = {
    "total": [500, 700],
    "Tier 1": [30, 50],
    "Tier 2": [200, 300],
    "Tier 3": [150, 200],
    "Tier 4": [60, 100],
}


def _passed_week8_gate(lifetime_sor, full_price_pct, last_sale_days, woc):
    # 2026 Range Strategy Week-8 read: lifetime SOR > 60% AND a sale within the
    # last 7 days AND weeks-of-cover <= 8. (Full-price realisation is intentionally
    # NOT gated — full_price_pct is kept only as a display column.) Missing SOR /
    # last-sale data fails the gate closed.
    if lifetime_sor is None or last_sale_days is None:
        return False
    if lifetime_sor <= 60:
        return False
    if last_sale_days > 7:
        return False
    if woc is not None and woc > 8:
        return False
    return True


def _passed_week12_backstop(lifetime_sor):
    # Week-12 backstop: a style that missed the Week-8 read still graduates if
    # its lifetime sell-out rate has reached 80%.
    return lifetime_sor is not None and lifetime_sor >= 80


def _gated_range_tier(age_weeks, *, lifetime_sor, full_price_pct, last_sale_days,
                      woc, reorder_count, recent_sor=None, recent_units=None):
    # 2026 Range Strategy (SOP) GATED lifecycle tier. Age sets the stage but the
    # performance gates decide whether a style graduates or retires at each stage.
    # Returns one of 'Tier 1'..'Tier 4' or 'Retire'. Age boundaries follow the
    # calendar (8wk read, 12wk backstop, ~9 months = 36wk, 24 months = 96wk).
    # Hard-retire overrides (manual list / Zoya / aged-out / flagged) are applied
    # by the caller, NOT here.
    if age_weeks is None:
        return "Tier 4"
    w8 = _passed_week8_gate(lifetime_sor, full_price_pct, last_sale_days, woc)
    w12 = _passed_week12_backstop(lifetime_sor)
    if age_weeks < 8:
        return "Tier 4"                       # New / Test — pre Week-8 read
    if age_weeks <= 12:
        return "Tier 3" if w8 else "Tier 4"   # Week-8 read window
    if age_weeks < 36:                         # Week-12 backstop .. ~9 months
        return "Tier 3" if (w8 or w12) else "Retire"
    if age_weeks < 96:                         # ~9-24 months
        if reorder_count >= 3 and (lifetime_sor or 0) > 60:
            return "Tier 2"
        return "Retire"
    # 24+ months — Tier 1 = Core, a deliberately tight "hero core" range (target
    # 30-50 styles). It must be an ACTIVELY high-selling style on BOTH rate and
    # volume: sold within the last 30 days, still selling through strongly in the
    # recent 6-month window (recent SOR > 75), AND carrying real recent demand
    # (>= 300 units in the last 6 months) — not merely a style that sold well a
    # long time ago or clears a tiny residual stock at a high rate. Proven repeat
    # demand (5+ reorders) is still required. Missing recent-volume data fails the
    # gate closed (treated as 0 units), consistent with the other gates.
    if (reorder_count >= 5 and last_sale_days is not None and last_sale_days <= 30
            and (recent_sor or 0) > 75 and (recent_units or 0) >= 300):
        return "Tier 1"
    return "Retire"


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
        "stock_available": stock,
        "sor_lifetime_pct": round(units * 100.0 / denom, 1) if denom else None,
    }

@app.get("/api/range-mgmt/classify")
def range_mgmt_classify(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, ichf = _style_filters(country, channel, "i")
    # Per-style lifetime/trailing-window sales is the heavy full-scan here. The
    # rm_style rollup is keyed by (style, country) so it serves any country scope,
    # but it has NO channel (pos_location) dimension, so use it only when channel
    # is unset (the dashboard default). KES sums are stored unrounded and ROUNDed
    # after the per-country re-aggregation so the All total matches the live
    # round-of-sum byte-for-byte (parity-verified). Falls back to live otherwise.
    if not channel and _rollup_fresh("rm_style"):
        rm_sales_cte = """sales AS (
            SELECT style_name,
                SUM(units_life) AS units_life,
                ROUND(SUM(sales_life)) AS sales_life,
                SUM(units_6m) AS units_6m,
                ROUND(SUM(sales_6m)) AS sales_6m,
                SUM(units_30d) AS units_30d,
                SUM(units_14d) AS units_14d,
                SUM(units_prior_30d) AS units_prior_30d,
                SUM(units_online) AS units_online,
                SUM(units_stores) AS units_stores,
                MAX(last_sale) AS last_sale,
                MIN(first_sale) AS first_sale
            FROM rollup_rm_style""" + _rollup_country_where(country) + """
            GROUP BY style_name
        )"""
    else:
        rm_sales_cte = """sales AS (
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
        )"""
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
        """ + rm_sales_cte + """,
        stock AS (
            SELECT COALESCE(m.style_name, i.style_name) AS style_name,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_stores,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_warehouse
            FROM all_inventory i
            LEFT JOIN """ + SKU_STYLE_MAP + """ m ON m.sku = i.sku
            WHERE COALESCE(m.style_name, i.style_name) IS NOT NULL""" + icf + ichf + """
            GROUP BY 1
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
        WHERE (COALESCE(st.soh_stores, 0) > 0 OR COALESCE(st.soh_warehouse, 0) > 0)
          AND COALESCE(p.brand, '') NOT ILIKE '%third party%'
    """)
    today = date.today()
    active, retired, pipeline, candidates = [], [], [], []
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

        # Pure catalogue-age band — used ONLY by the age-milestone trackers
        # (approaching the Week-8 / 9-month gate) and the "Overdue read" status,
        # never as the displayed tier.
        if age_weeks is None:
            age_band = "Tier 4"
        elif age_weeks >= 104:
            age_band = "Tier 1"
        elif age_weeks >= 39:
            age_band = "Tier 2"
        elif age_weeks >= 8:
            age_band = "Tier 3"
        else:
            age_band = "Tier 4"

        # Range tier = the 2026 Range Strategy (SOP) GATED lifecycle classification:
        # age sets the stage, but performance gates decide promotion vs retirement
        # (Week-8 read = SOR > 60% + sold within 7d + WOC <= 8; Week-12 backstop =
        # SOR >= 80%; Tier 2 needs 3+ reorders & lifetime SOR > 60%; Tier 1 = tight
        # "hero core" needing 5+ reorders & a sale within 30d & recent 6-month SOR
        # > 75% & >= 300 recent-6m units (actively high-selling on rate AND volume,
        # not historically); full-price realisation is no longer gated). A
        # failed gate yields
        # the "Retire" verdict — but for a still-trading style that is a FLAG, not a
        # move: it stays in the live range (rows, but is NOT counted in the Active
        # total) and is surfaced as "flagged for retirement". Only HARD retirement
        # moves a style out.
        gated_tier = _gated_range_tier(
            age_weeks, lifetime_sor=sor_life, full_price_pct=full_price_pct,
            last_sale_days=last_sale_days, woc=woc, reorder_count=reorder_count,
            recent_sor=sor_6m, recent_units=units_6m)

        # Hard (physical) retirement is the ONLY thing that moves a style into the
        # Retired bucket: the durable manual-retirement list (the styles list), every
        # Zoya style, and long-dead aged-out styles (>=39wk, no 6-month sales, no sale
        # in 270 days). A gated "Retire" verdict on a still-trading best-seller never
        # retires it — it stays Active, flagged.
        is_retired = (age_weeks is not None and age_weeks >= 39 and units_6m == 0
                      and (last_sale_days is None or last_sale_days > 270))
        if (r["brand"] or "").strip().lower() == "zoya":
            is_retired = True
        if _is_manually_retired(r["style_name"]):
            is_retired = True

        if is_retired or gated_tier == "Retire":
            status = "Retire"
            action = "Mark down to outlet and clear remaining stock per the SOP 4-week gap rule."
        elif (age_band in ("Tier 3", "Tier 4") and age_weeks is not None
                and age_weeks >= 12 and (sor_life is None or sor_life < 25)):
            status = "Overdue"
            action = "Overdue Week-8 read — review sell-through now and decide reorder or exit."
        elif sor_life is not None and sor_life < 45:
            status = "At Risk"
            action = "Monitor weekly; consider a marketing push or price review to lift sell-through."
        elif gated_tier == "Tier 3":
            status = "On Track"
            action = "On review — track toward the 9-month gate for graduation to Tier 2."
        else:
            status = "On Track"
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
            "age_tier": age_band,
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

        # --- Range tier classification (2026 Range Strategy / SOP): every style in
        # the live range carries a real displayed Tier 1..4 so the per-tier counts
        # add up to the Active total. A still-trading style whose GATED verdict is
        # "Retire" (_gated_range_tier above) is NOT dropped to a "Retire" tier — it
        # is reclassified into its catalogue-age band (Tier 1..4) AND marked with a
        # `flagged_for_retirement` flag that drives the markdown rail + the "flagged"
        # pill. So flagged best-sellers stay PART of the Active range and its tier
        # breakdown, while still being surfaced for the retirement decision.
        # ONLY hard/physical retirement (manual styles list / Zoya / long-dead
        # aged-out) moves a style into `retired`. A manual tier override
        # (_RANGE_OVERRIDES, Tier 1..4 only) re-buckets within the live range, clears
        # the flag, and beats a gated "Retire"; `auto_tier` records the un-overridden
        # tier so the frontend's "override · auto-tier was X" hint stays useful.
        flagged = (gated_tier == "Retire")
        # The displayed tier for a flagged style is its catalogue-age band (Tier 1..4);
        # otherwise it is the gated lifecycle tier (already Tier 1..4).
        effective_tier = age_band if flagged else gated_tier

        if is_retired:
            row["tier"] = row["auto_tier"] = "Retire"
            row["flagged_for_retirement"] = False
            retired.append(row)
            continue

        ov = _RANGE_OVERRIDES.get(r["style_name"])
        ov_tier = ov["tier"] if (ov and ov.get("tier") in
                                  ("Tier 1", "Tier 2", "Tier 3", "Tier 4")) else None
        if ov_tier:
            row["tier"], row["auto_tier"], row["override_reason"] = ov_tier, effective_tier, ov.get("reason")
            # A manual override keeps the style in the live range and removes the
            # retirement flag, so a gated "Retire" status/action would be misleading
            # — recompute against the effective tier.
            flagged = False
            if status == "Retire":
                row["status"] = status = "On Track"
                row["recommended_action"] = action = (
                    "Manually held in the active range — maintain replenishment per the override.")
        else:
            row["tier"], row["auto_tier"], row["override_reason"] = effective_tier, effective_tier, None
        row["flagged_for_retirement"] = flagged
        active.append(row)

        # Actionable retirement pipeline: still-trading flagged styles that still
        # hold stock to clear (the markdown rail). These remain in Active — the
        # pipeline is an overlay, not a separate bucket.
        if flagged and current_stock > 0:
            rec = today + timedelta(days=14)
            pipeline.append({**row,
                "recommended_retirement_date": str(rec),
                "outlet_discount_date": str(rec + timedelta(days=28)),
                "reason": "Flagged for retirement — aged %sw at %s%% lifetime SOR with %s units remaining." % (
                    row["style_age_weeks"], row["sor_since_launch"], row["current_stock"]),
            })

        if (age_band == "Tier 3" and age_weeks is not None and 0 <= (39 - age_weeks) <= 6
                and reorder_count >= 3 and sor_life is not None and sor_life > 60):
            candidates.append({
                "style_name": r["style_name"], "brand": r["brand"], "subcategory": r["subcategory"],
                "weeks_to_gate": 39 - age_weeks, "lifetime_sor_pct": sor_life,
                "full_price_pct": full_price_pct, "reorder_count": reorder_count,
                "current_stock": current_stock, "last_sale_days": last_sale_days,
            })

    tier_counts = {t: 0 for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4")}
    for row in active:
        tier_counts[row["tier"]] = tier_counts.get(row["tier"], 0) + 1

    # Every active style now carries a real Tier 1..4 (flagged-for-retirement styles
    # are reclassified into their age band rather than a "Retire" tier), so the Active
    # range total == len(active) == the sum of the per-tier counts. Flagged styles
    # stay PART of Active and are surfaced separately via `flagged_for_retirement`.
    active_tier_total = len(active)
    flagged_count = sum(1 for row in active if row.get("flagged_for_retirement"))

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
            (row["age_tier"] == "Tier 4" and 0 <= (8 - row["style_age_weeks"]) <= 6)))

    rag = {"total": _rag(active_tier_total, *_RANGE_TARGETS["total"])}
    for t in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
        rag[t] = _rag(tier_counts.get(t, 0), *_RANGE_TARGETS[t])

    summary = {
        # Active range number = every live style (all carry a real Tier 1..4), so
        # this equals len(active) and the sum of the per-tier counts. Flagged styles
        # are PART of this total and surfaced separately via flagged_for_retirement.
        "total_active_styles": active_tier_total,
        # "Flagged for retirement" pill = active styles the classifier flags for the
        # markdown rail (failed an SOP gate but kept in the live range).
        "flagged_for_retirement": flagged_count,
        # Active styles still in Tier 4 past the 8-week read window — i.e. they
        # missed the Week-8 read and are awaiting the Week-12 backstop decision.
        "overdue_for_week8_read": sum(1 for row in active
            if row["tier"] == "Tier 4" and (row["style_age_weeks"] or 0) >= 8),
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


# ───────────────────────────────────────────────────────────────────────────
# Reports/exports endpoints called by the dashboard's analytics & exports pages.
# All reuse the shared helpers (BASE_FILTERS, build_filters, _style_filters,
# WAREHOUSE_LOCATIONS, ff_canon_sql, run_query) so figures stay internally
# consistent with the rest of the cockpit. sale_date is TEXT → cast ::date.
# ───────────────────────────────────────────────────────────────────────────

def _x_pct(cur, prev):
    """YoY/MoM percentage change, None when the base period is zero/empty."""
    cur = float(cur or 0)
    prev = float(prev or 0)
    return round((cur - prev) / prev * 100, 2) if prev else None


def _x_shift_years(d, n):
    """Shift a date back n years, falling back to a 365-day step for Feb 29."""
    try:
        return d.replace(year=d.year - n)
    except ValueError:
        return d - timedelta(days=365 * n)


def _x_store_sales(df, dt):
    """{loc: {sales, units, tx}} for non-warehouse POS locations in [df,dt]."""
    rows = run_query(
        """
        SELECT s.pos_location_name AS loc,
            ROUND(SUM(s.total_sales_kes::numeric)) AS sales,
            COALESCE(SUM(s.net_quantity), 0) AS units,
            COUNT(DISTINCT s.order_id) AS tx
        FROM all_sales s
        WHERE s.sale_date BETWEEN '""" + df + """' AND '""" + dt + """'
          AND s.sale_kind IN ('sale','order')
          AND """ + BASE_FILTERS + """
          AND s.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
        GROUP BY s.pos_location_name
        """,
        date_to=dt,
    ) or []
    return {r["loc"]: r for r in rows}


def _x_store_footfall(df, dt):
    """{canonical_location: footfall_in} in [df,dt]."""
    rows = run_query(
        "SELECT " + ff_canon_sql() + """ AS loc, SUM(f.a01_footfall_in) AS footfall
        FROM footfall f
        WHERE f.time BETWEEN '""" + df + """' AND '""" + dt + """'
        GROUP BY 1
        """,
        date_to=dt,
    ) or []
    return {r["loc"]: float(r["footfall"] or 0) for r in rows}


@app.get("/api/analytics/sor-new-styles-l10")
def analytics_sor_new_styles_l10(
    brand: str = Query(default=None),
    style_status: str = Query(default="all"),
    window_days: int = Query(default=180),
):
    # Styles whose FIRST-EVER sale was 90-122 days ago (≥3 and ≤4 months) AND
    # whose combined demand+stock (units_6m + soh_total) is >= 50. Returns the
    # SorStylesTable row shape so the L-10 tab can render + drill into SKUs.
    brand_pf = ""
    if brand:
        brand_pf = " AND LOWER(brand) = '" + brand.strip().lower().replace("'", "''") + "'"
    raw = run_query(
        """
        WITH prod AS (
            SELECT style_name,
                MAX(brand) AS brand,
                MAX(collection) AS collection,
                MAX(product_type) AS subcategory,
                MAX(style_number) AS style_number
            FROM all_products_clean
            WHERE style_name IS NOT NULL AND style_name <> ''""" + brand_pf + """
            GROUP BY style_name
        ),
        sales AS (
            SELECT p.style_name,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '182 days') AS units_6m,
                ROUND(SUM(s.net_sales_kes::numeric) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '182 days')) AS sales_6m,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '21 days') AS units_3w,
                SUM(s.net_quantity) FILTER (WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '30 days') AS units_30d,
                MAX(s.sale_date::date) AS last_sale,
                MIN(s.sale_date::date) AS first_sale
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IS NOT NULL AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + """
            GROUP BY p.style_name
        ),
        stock AS (
            SELECT COALESCE(m.style_name, i.style_name) AS style_name,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_stores,
                COALESCE(SUM(i.available) FILTER (WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)), 0) AS soh_warehouse
            FROM all_inventory i
            LEFT JOIN """ + SKU_STYLE_MAP + """ m ON m.sku = i.sku
            WHERE COALESCE(m.style_name, i.style_name) IS NOT NULL
            GROUP BY 1
        )
        SELECT p.style_name, p.brand, p.collection, p.subcategory, p.style_number,
            COALESCE(sa.units_6m, 0) AS units_6m, COALESCE(sa.sales_6m, 0) AS sales_6m,
            COALESCE(sa.units_3w, 0) AS units_3w, COALESCE(sa.units_30d, 0) AS units_30d,
            sa.last_sale, sa.first_sale,
            COALESCE(st.soh_stores, 0) AS soh_stores, COALESCE(st.soh_warehouse, 0) AS soh_warehouse
        FROM prod p
        JOIN sales sa USING (style_name)
        LEFT JOIN stock st USING (style_name)
        WHERE sa.first_sale IS NOT NULL
          AND COALESCE(p.brand, '') NOT ILIKE '%third party%'
        """
    ) or []
    today = date.today()
    out = []
    for r in raw:
        first_sale = r["first_sale"]
        if not first_sale:
            continue
        age_days = (today - first_sale).days
        if age_days < 90 or age_days > 122:
            continue
        units_6m = int(r["units_6m"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        soh_total = soh_stores + soh_warehouse
        if (units_6m + soh_total) < 50:
            continue
        sales_6m = float(r["sales_6m"] or 0)
        units_30d = int(r["units_30d"] or 0)
        last_sale = r["last_sale"]
        weekly_avg = round(units_30d / (30.0 / 7.0), 1)
        woc = round(soh_total / weekly_avg, 1) if weekly_avg > 0 else None
        denom = units_6m + soh_total
        out.append({
            "style_name": r["style_name"],
            "brand": r["brand"],
            "collection": r["collection"],
            "subcategory": r["subcategory"],
            "style_number": r["style_number"],
            "sales_6m": round(sales_6m),
            "units_6m": units_6m,
            "units_3w": int(r["units_3w"] or 0),
            "weekly_avg": weekly_avg,
            "soh_total": soh_total,
            "soh_wh": soh_warehouse,
            "woc": woc,
            "pct_in_wh": round(100.0 * soh_warehouse / soh_total, 1) if soh_total else 0.0,
            "asp_6m": round(sales_6m / units_6m) if units_6m > 0 else None,
            "days_since_last_sale": (today - last_sale).days if last_sale else None,
            "sor_6m": round(100.0 * units_6m / denom, 1) if denom > 0 else None,
            "launch_date": str(first_sale),
            "style_age_weeks": round(age_days / 7.0),
        })
    out.sort(key=lambda x: -(x["sales_6m"] or 0))
    return out


@app.get("/api/analytics/new-styles-curve")
def analytics_new_styles_curve(
    days: int = Query(default=122),
    country: str = Query(default=None),
    channel: str = Query(default=None),
):
    # Every style whose first-ever sale was in the last `days`, with its
    # weekly units-since-launch curve + a climbing/plateau/declining trend.
    cf, chf = _style_filters(country, channel, "s")
    raw = run_query(
        """
        WITH firsts AS (
            SELECT p.style_name,
                MIN(s.sale_date::date) AS first_sale,
                MAX(p.brand) AS brand,
                MAX(p.product_type) AS subcategory
            FROM all_products_clean p
            JOIN all_sales s ON s.variant_sku = p.sku
            WHERE p.style_name IS NOT NULL AND s.sale_kind IN ('sale','order')
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.style_name
            HAVING MIN(s.sale_date::date) >= CURRENT_DATE - INTERVAL '""" + str(days) + """ days'
        )
        SELECT f.style_name, f.brand, f.subcategory, f.first_sale,
            ((s.sale_date::date - f.first_sale) / 7) AS week_index,
            f.first_sale + ((s.sale_date::date - f.first_sale) / 7) * 7 AS week_start,
            SUM(s.net_quantity) AS units,
            ROUND(SUM(s.net_sales_kes::numeric)) AS sales
        FROM firsts f
        JOIN all_products_clean p ON p.style_name = f.style_name
        JOIN all_sales s ON s.variant_sku = p.sku
        WHERE s.sale_kind IN ('sale','order') AND s.sale_date::date >= f.first_sale
          AND """ + BASE_FILTERS + cf + chf + """
        GROUP BY f.style_name, f.brand, f.subcategory, f.first_sale,
            ((s.sale_date::date - f.first_sale) / 7)
        ORDER BY f.style_name, week_index
        """
    ) or []
    today = date.today()
    by_style = {}
    for r in raw:
        st = by_style.setdefault(r["style_name"], {
            "style_name": r["style_name"], "brand": r["brand"],
            "subcategory": r["subcategory"], "first_sale": r["first_sale"],
            "weekly": [],
        })
        wi = int(r["week_index"] or 0)
        if wi < 0:
            continue
        st["weekly"].append({
            "week_index": wi,
            "week_start": str(r["week_start"]) if r["week_start"] else None,
            "units": int(r["units"] or 0),
            "sales": round(float(r["sales"] or 0)),
        })

    def _trend(units_by_week):
        if sum(units_by_week) == 0:
            return "no-sales"
        n = len(units_by_week)
        tail = units_by_week[-3:] if n >= 3 else units_by_week[:]
        recent = sum(tail) / len(tail)
        prior_src = units_by_week[-6:-3] if n >= 6 else units_by_week[:max(0, n - len(tail))]
        prior = (sum(prior_src) / len(prior_src)) if prior_src else None
        if recent == 0:
            return "declining"
        if prior is None or prior == 0:
            return "climbing"
        ratio = recent / prior
        if ratio >= 1.15:
            return "climbing"
        if ratio <= 0.7:
            return "declining"
        return "plateau"

    rows = []
    for st in by_style.values():
        first_sale = st["first_sale"]
        weeks_since_launch = max(0, (today - first_sale).days // 7) if first_sale else 0
        weekly = sorted(st["weekly"], key=lambda w: w["week_index"])
        wk_map = {w["week_index"]: w["units"] for w in weekly}
        padded = [wk_map.get(i, 0) for i in range(0, max(weeks_since_launch, (weekly[-1]["week_index"] if weekly else 0)) + 1)]
        total_units = sum(w["units"] for w in weekly)
        total_sales = sum(w["sales"] for w in weekly)
        peak = max((w["units"] for w in weekly), default=0)
        rows.append({
            "style_name": st["style_name"],
            "brand": st["brand"],
            "subcategory": st["subcategory"],
            "first_sale": str(first_sale) if first_sale else None,
            "weeks_since_launch": weeks_since_launch,
            "weekly": weekly,
            "peak_weekly_units": peak,
            "total_units": total_units,
            "total_sales": total_sales,
            "trend": _trend(padded),
        })
    rows.sort(key=lambda x: -(x["total_units"] or 0))
    return {"rows": rows}


@app.get("/api/analytics/products-plan")
def analytics_products_plan(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    channel:   str = Query(default=None),
):
    # Sub-category composition: sales, SOR, qty + SOH split (stores vs W/H),
    # each alongside its share of the corresponding group total.
    where = build_filters(date_from, date_to, country, channel,
        extra="s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0 "
              "AND p.product_type IN (" + MERCH_SUBCATEGORIES_SQL + ")")
    inv_country = (" AND i.country IN (" + csv_to_sql(country) + ")") if country else ""
    rows = run_query(
        """
        WITH sales AS (
            SELECT p.category, p.product_type AS subcategory,
                SUM(s.ordered_item_quantity) AS qty_sold,
                ROUND(SUM(s.total_sales_kes::numeric)) AS total_sales
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE """ + where + """
            GROUP BY p.category, p.product_type
        ),
        stock AS (
            SELECT p.category, p.product_type AS subcategory,
                SUM(i.available) AS total_soh,
                SUM(i.available) FILTER (WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)) AS stores_soh,
                SUM(i.available) FILTER (WHERE i.pos_location_name IN (""" + WAREHOUSE_LOCATIONS + """)) AS wh_soh
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE p.product_type IN (""" + MERCH_SUBCATEGORIES_SQL + """)""" + inv_country + """
            GROUP BY p.category, p.product_type
        )
        SELECT COALESCE(s.category, st.category) AS category,
            COALESCE(s.subcategory, st.subcategory) AS subcategory,
            COALESCE(s.total_sales, 0) AS total_sales,
            COALESCE(s.qty_sold, 0) AS qty_sold,
            COALESCE(st.total_soh, 0) AS total_soh,
            COALESCE(st.stores_soh, 0) AS stores_soh,
            COALESCE(st.wh_soh, 0) AS wh_soh
        FROM sales s
        FULL OUTER JOIN stock st ON s.category = st.category AND s.subcategory = st.subcategory
        WHERE COALESCE(s.subcategory, st.subcategory) IS NOT NULL
        """,
        date_to=date_to,
    ) or []
    tot_sales = sum(float(r["total_sales"] or 0) for r in rows)
    tot_qty = sum(float(r["qty_sold"] or 0) for r in rows)
    tot_soh = sum(float(r["total_soh"] or 0) for r in rows)
    tot_stores = sum(float(r["stores_soh"] or 0) for r in rows)
    tot_wh = sum(float(r["wh_soh"] or 0) for r in rows)
    out = []
    for r in rows:
        qty = float(r["qty_sold"] or 0)
        soh = float(r["total_soh"] or 0)
        stores = float(r["stores_soh"] or 0)
        wh = float(r["wh_soh"] or 0)
        out.append({
            "category": r["category"] or "—",
            "subcategory": r["subcategory"] or "—",
            "total_sales": round(float(r["total_sales"] or 0)),
            "sor": round(qty / (qty + soh) * 100, 1) if (qty + soh) > 0 else 0.0,
            "qty_sold": int(qty),
            "pct_qty": round(qty / tot_qty * 100, 1) if tot_qty else 0.0,
            "total_soh": int(soh),
            "pct_total_soh": round(soh / tot_soh * 100, 1) if tot_soh else 0.0,
            "stores_soh": int(stores),
            "pct_stores_soh": round(stores / tot_stores * 100, 1) if tot_stores else 0.0,
            "wh_soh": int(wh),
            "pct_wh_soh": round(wh / tot_wh * 100, 1) if tot_wh else 0.0,
        })
    out.sort(key=lambda x: -x["qty_sold"])
    return out


@app.get("/api/analytics/category-country-matrix")
def analytics_category_country_matrix(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
    channel:   str = Query(default=None),
):
    # Subcategory × Country (Kenya/Uganda/Rwanda/Online) sales matrix. Each
    # cell carries the KES + that subcategory's share of THAT country's total.
    countries = ["Kenya", "Uganda", "Rwanda", "Online"]
    chf = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    rows = run_query(
        """
        SELECT p.product_type AS subcategory, s.country,
            ROUND(SUM(s.total_sales_kes::numeric)) AS sales_kes
        FROM all_sales s
        JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
          AND s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0
          AND """ + BASE_FILTERS + """
          AND s.country IN ('Kenya','Uganda','Rwanda','Online')
          AND p.product_type IN (""" + MERCH_SUBCATEGORIES_SQL + """)""" + chf + """
        GROUP BY p.product_type, s.country
        """,
        date_to=date_to,
    ) or []
    country_totals = {c: 0.0 for c in countries}
    by_sub = {}
    for r in rows:
        sub = r["subcategory"]
        c = r["country"]
        if c not in country_totals:
            continue
        v = float(r["sales_kes"] or 0)
        country_totals[c] += v
        by_sub.setdefault(sub, {})[c] = v
    grand_total = sum(country_totals.values())
    out_rows = []
    for sub, cmap in by_sub.items():
        cells = {}
        row_total = 0.0
        for c in countries:
            v = cmap.get(c, 0.0)
            row_total += v
            if v:
                cells[c] = {
                    "sales_kes": round(v),
                    "share_of_country_pct": round(v / country_totals[c] * 100, 1) if country_totals[c] else 0.0,
                }
        out_rows.append({
            "subcategory": sub,
            "row_total_kes": round(row_total),
            "cells": cells,
        })
    out_rows.sort(key=lambda x: -x["row_total_kes"])
    return {
        "rows": out_rows,
        "countries": countries,
        "country_totals": {c: round(v) for c, v in country_totals.items()},
        "grand_total_kes": round(grand_total),
    }


def _x_attr_variance(attr_col, key_name, date_from, date_to, cf, chf, inv_cf):
    rows = run_query(
        """
        WITH sales AS (
            SELECT p.""" + attr_col + """ AS k, SUM(s.ordered_item_quantity) AS units_sold
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0
              AND """ + BASE_FILTERS + cf + chf + """
            GROUP BY p.""" + attr_col + """
        ),
        stock AS (
            SELECT p.""" + attr_col + """ AS k, SUM(i.available) AS current_stock
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)""" + inv_cf + """
            GROUP BY p.""" + attr_col + """
        )
        SELECT COALESCE(s.k, st.k) AS k,
            COALESCE(s.units_sold, 0) AS units_sold,
            COALESCE(st.current_stock, 0) AS current_stock
        FROM sales s FULL OUTER JOIN stock st ON s.k = st.k
        WHERE COALESCE(s.k, st.k) IS NOT NULL AND COALESCE(s.k, st.k) <> ''
        """,
        date_to=date_to,
    ) or []
    tot_sold = sum(float(r["units_sold"] or 0) for r in rows)
    tot_stock = sum(float(r["current_stock"] or 0) for r in rows)
    out = []
    for r in rows:
        sold = float(r["units_sold"] or 0)
        stock = float(r["current_stock"] or 0)
        if sold == 0 and stock == 0:
            continue
        pct_sold = sold / tot_sold * 100 if tot_sold else 0.0
        pct_stock = stock / tot_stock * 100 if tot_stock else 0.0
        out.append({
            key_name: r["k"],
            "units_sold": int(sold),
            "current_stock": int(stock),
            "pct_of_total_sold": round(pct_sold, 2),
            "pct_of_total_stock": round(pct_stock, 2),
            "variance": round(pct_sold - pct_stock, 2),
        })
    out.sort(key=lambda x: -abs(x["variance"]))
    return out


@app.get("/api/analytics/stock-to-sales-by-attribute")
def analytics_stock_to_sales_by_attribute(
    date_from: str = Query(default=str((date.today() - timedelta(days=29)).isoformat())),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    locations: str = Query(default=None),
):
    # Stock-to-sales variance by color/print and by size. country is a
    # lowercased CSV (matched case-insensitively); locations is a CSV of
    # pos_location_name values applied to the sales side.
    cf, chf = _style_filters(country, locations, "s")
    inv_cf, _ = _style_filters(country, None, "i")
    return {
        "by_color": _x_attr_variance("color_print", "color", date_from, date_to, cf, chf, inv_cf),
        "by_size": _x_attr_variance("size", "size", date_from, date_to, cf, chf, inv_cf),
    }


@app.get("/api/footfall/daily-calendar")
def footfall_daily_calendar(
    date_from: str = Query(default=str((date.today() - timedelta(days=89)).isoformat())),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
):
    # Daily footfall + orders + sales for a calendar heatmap. footfall has no
    # country column → mapped via pos_locations. weekday: 0=Mon..6=Sun.
    ff_country = (" AND pl.country = '" + _sql_str(country) + "'") if country else ""
    sa_country = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    rows = run_query(
        """
        WITH ff AS (
            SELECT f.time::date AS d, SUM(f.a01_footfall_in) AS footfall
            FROM footfall f
            LEFT JOIN pos_locations pl ON """ + ff_canon_sql() + """ = pl.location_name
            WHERE f.time BETWEEN '""" + date_from + """' AND '""" + date_to + """'""" + ff_country + """
            GROUP BY f.time::date
        ),
        sa AS (
            SELECT s.sale_date::date AS d,
                COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
                ROUND(SUM(s.total_sales_kes::numeric)) AS total_sales
            FROM all_sales s
            WHERE s.sale_date BETWEEN '""" + date_from + """' AND '""" + date_to + """'
              AND """ + BASE_FILTERS + sa_country + """
            GROUP BY s.sale_date::date
        )
        SELECT COALESCE(ff.d, sa.d) AS d,
            ((EXTRACT(DOW FROM COALESCE(ff.d, sa.d))::int + 6) % 7) AS weekday,
            COALESCE(ff.footfall, 0) AS footfall,
            COALESCE(sa.orders, 0) AS orders,
            COALESCE(sa.total_sales, 0) AS total_sales
        FROM ff FULL OUTER JOIN sa ON ff.d = sa.d
        WHERE COALESCE(ff.d, sa.d) IS NOT NULL
        ORDER BY d
        """,
        date_to=date_to,
    ) or []
    days = []
    max_ff = 0
    for r in rows:
        ff = int(r["footfall"] or 0)
        orders = int(r["orders"] or 0)
        max_ff = max(max_ff, ff)
        days.append({
            "date": str(r["d"]),
            "weekday": int(r["weekday"]),
            "footfall": ff,
            "orders": orders,
            "total_sales": round(float(r["total_sales"] or 0)),
            "conversion_rate": round(orders / ff * 100, 1) if ff > 0 else None,
        })
    try:
        ndays = (date.fromisoformat(date_to[:10]) - date.fromisoformat(date_from[:10])).days + 1
    except ValueError:
        ndays = len(days)
    return {
        "days": days,
        "max_footfall": max_ff,
        "window": {"start": date_from, "end": date_to, "days": ndays},
    }


@app.get("/api/exports/store-kpis")
def exports_store_kpis(
    date_from: str = Query(default=str(date.today().replace(day=1))),
    date_to:   str = Query(default=str(date.today())),
):
    # One row per POS location with current vs LY (same window last year) and
    # LM (previous equal-length window) for revenue/units/footfall/tx/basket/
    # ASP/MSI plus conversion.
    d0 = date.fromisoformat(date_from[:10])
    d1 = date.fromisoformat(date_to[:10])
    length = (d1 - d0).days + 1
    ly0, ly1 = _x_shift_years(d0, 1), _x_shift_years(d1, 1)
    lm1 = d0 - timedelta(days=1)
    lm0 = lm1 - timedelta(days=length - 1)
    cur = _x_store_sales(str(d0), str(d1))
    ly = _x_store_sales(str(ly0), str(ly1))
    lm = _x_store_sales(str(lm0), str(lm1))
    ff_cur = _x_store_footfall(str(d0), str(d1))
    ff_ly = _x_store_footfall(str(ly0), str(ly1))
    locs = set(cur) | set(ly) | set(lm) | set(ff_cur) | set(ff_ly)

    def _m(d, loc):
        r = d.get(loc) or {}
        return float(r.get("sales") or 0), float(r.get("units") or 0), float(r.get("tx") or 0)

    rows = []
    for loc in locs:
        s_c, u_c, t_c = _m(cur, loc)
        s_l, u_l, t_l = _m(ly, loc)
        s_m, u_m, t_m = _m(lm, loc)
        f_c = ff_cur.get(loc, 0.0)
        f_l = ff_ly.get(loc, 0.0)
        if s_c == 0 and u_c == 0 and t_c == 0 and f_c == 0:
            continue
        bv_c = s_c / t_c if t_c else 0
        bv_l = s_l / t_l if t_l else 0
        asp_c = s_c / u_c if u_c else 0
        asp_l = s_l / u_l if u_l else 0
        msi_c = u_c / t_c if t_c else 0
        msi_l = u_l / t_l if t_l else 0
        conv_c = t_c / f_c * 100 if f_c else None
        conv_l = t_l / f_l * 100 if f_l else None
        rows.append({
            "pos_location": loc,
            "total_sales": round(s_c), "total_sales_ly": round(s_l),
            "yoy_revenue_pct": _x_pct(s_c, s_l),
            "total_sales_lm": round(s_m), "mom_revenue_pct": _x_pct(s_c, s_m),
            "units_sold": int(u_c), "units_sold_ly": int(u_l),
            "yoy_units_pct": _x_pct(u_c, u_l),
            "footfall": int(f_c), "footfall_ly": int(f_l),
            "yoy_footfall_pct": _x_pct(f_c, f_l),
            "transactions": int(t_c), "transactions_ly": int(t_l),
            "yoy_transactions_pct": _x_pct(t_c, t_l),
            "basket_value": round(bv_c), "basket_value_ly": round(bv_l),
            "yoy_basket_value_pct": _x_pct(bv_c, bv_l),
            "asp": round(asp_c), "asp_ly": round(asp_l),
            "yoy_asp_pct": _x_pct(asp_c, asp_l),
            "msi": round(msi_c, 2), "msi_ly": round(msi_l, 2),
            "yoy_msi_pct": _x_pct(msi_c, msi_l),
            "conv_rate": round(conv_c, 2) if conv_c is not None else None,
            "yoy_conv_pp": round(conv_c - conv_l, 2) if (conv_c is not None and conv_l is not None) else None,
        })
    rows.sort(key=lambda x: -(x["total_sales"] or 0))
    return {
        "rows": rows,
        "period_ly": {"date_from": str(ly0), "date_to": str(ly1)},
        "period_lm": {"date_from": str(lm0), "date_to": str(lm1)},
    }


@app.get("/api/exports/period-performance")
def exports_period_performance(
    mode:   str = Query(default="wtd"),
    anchor: str = Query(default=str(date.today())),
):
    # 3-year per-store comparison (Last-Last-Year / Last-Year / Current-Year)
    # for WTD / MTD / YTD windows ending at `anchor`.
    a = date.fromisoformat(anchor[:10])
    if mode == "ytd":
        frm = date(a.year, 1, 1)
    elif mode == "mtd":
        frm = a.replace(day=1)
    else:
        frm = a - timedelta(days=a.weekday())
    to = a
    ly0, ly1 = _x_shift_years(frm, 1), _x_shift_years(to, 1)
    lly0, lly1 = _x_shift_years(frm, 2), _x_shift_years(to, 2)
    cy = _x_store_sales(str(frm), str(to))
    ly = _x_store_sales(str(ly0), str(ly1))
    lly = _x_store_sales(str(lly0), str(lly1))
    locs = set(cy) | set(ly) | set(lly)
    total_rev_cy = sum(float((cy.get(l) or {}).get("sales") or 0) for l in cy)

    def _ru(d, loc):
        r = d.get(loc) or {}
        return float(r.get("sales") or 0), float(r.get("units") or 0)

    rows = []
    for loc in locs:
        r_cy, u_cy = _ru(cy, loc)
        r_ly, u_ly = _ru(ly, loc)
        r_lly, u_lly = _ru(lly, loc)
        if r_cy == 0 and r_ly == 0 and r_lly == 0:
            continue
        asp_cy = r_cy / u_cy if u_cy else 0
        asp_ly = r_ly / u_ly if u_ly else 0
        asp_lly = r_lly / u_lly if u_lly else 0
        rows.append({
            "store_name": loc,
            "units_lly": int(u_lly), "units_ly": int(u_ly), "units_cy": int(u_cy),
            "units_yoy_pct": _x_pct(u_cy, u_ly), "units_lly_pct": _x_pct(u_cy, u_lly),
            "revenue_lly": round(r_lly), "revenue_ly": round(r_ly), "revenue_cy": round(r_cy),
            "revenue_yoy_pct": _x_pct(r_cy, r_ly), "revenue_lly_pct": _x_pct(r_cy, r_lly),
            "asp_lly": round(asp_lly), "asp_ly": round(asp_ly), "asp_cy": round(asp_cy),
            "asp_yoy_pct": _x_pct(asp_cy, asp_ly), "asp_lly_pct": _x_pct(asp_cy, asp_lly),
            "contrib_revenue_pct": round(r_cy / total_rev_cy * 100, 2) if total_rev_cy else 0.0,
        })
    rows.sort(key=lambda x: -(x["revenue_cy"] or 0))
    return {
        "rows": rows,
        "period_current": {"date_from": str(frm), "date_to": str(to)},
    }


@app.get("/api/exports/stock-rebalancing")
def exports_stock_rebalancing(
    categories: str = Query(default=None),
    channel:    str = Query(default=None),
    country:    str = Query(default=None),
):
    # Per category × subcategory: full-year units sold for the last 3 years and
    # units in the same calendar quarter each year, alongside live store SOH.
    today = date.today()
    years = [today.year - 2, today.year - 1, today.year]
    cq = (today.month - 1) // 3 + 1
    q_start_m = (cq - 1) * 3 + 1

    def _q_window(y):
        start = date(y, q_start_m, 1)
        end_m = q_start_m + 2
        if end_m == 12:
            end = date(y, 12, 31)
        else:
            end = date(y, end_m + 1, 1) - timedelta(days=1)
        if end > today:
            end = today
        return start, end

    cat_pf = ""
    if categories:
        cats = [c.strip() for c in categories.split(",") if c.strip()]
        if cats:
            cat_pf = " AND p.category IN (" + ",".join(
                "'" + c.replace("'", "''") + "'" for c in cats) + ")"
    chf = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    sa_country = (" AND s.country IN (" + csv_to_sql(country) + ")") if country else ""
    inv_country = (" AND i.country IN (" + csv_to_sql(country) + ")") if country else ""

    year_cols = []
    for y in years:
        qs, qe = _q_window(y)
        year_cols.append(
            "SUM(s.ordered_item_quantity) FILTER (WHERE s.sale_date::date BETWEEN '"
            + str(date(y, 1, 1)) + "' AND '" + str(date(y, 12, 31)) + "') AS y" + str(y) + "_units")
        year_cols.append(
            "SUM(s.ordered_item_quantity) FILTER (WHERE s.sale_date::date BETWEEN '"
            + str(qs) + "' AND '" + str(qe) + "') AS y" + str(y) + "_units_q")
    sales = run_query(
        """
        SELECT p.category, p.product_type AS subcategory,
            """ + ",\n            ".join(year_cols) + """
        FROM all_sales s
        JOIN all_products_clean p ON s.variant_sku = p.sku
        WHERE s.sale_date BETWEEN '""" + str(date(years[0], 1, 1)) + """' AND '""" + str(today) + """'
          AND s.sale_kind IN ('sale','order') AND s.ordered_item_quantity > 0
          AND p.product_type IN (""" + MERCH_SUBCATEGORIES_SQL + """)""" + cat_pf + chf + sa_country + """
        GROUP BY p.category, p.product_type
        """,
        date_to=str(today),
    ) or []
    stock = run_query(
        """
        SELECT p.category, p.product_type AS subcategory, SUM(i.available) AS soh
        FROM all_inventory i
        JOIN all_products_clean p ON i.sku = p.sku
        WHERE i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)
          AND p.product_type IN (""" + MERCH_SUBCATEGORIES_SQL + """)""" + cat_pf + inv_country + """
        GROUP BY p.category, p.product_type
        """
    ) or []
    soh_map = {(r["category"], r["subcategory"]): float(r["soh"] or 0) for r in stock}

    # Merge sales + stock keyed by (category, subcategory).
    merged = {}
    for r in sales:
        key = (r["category"], r["subcategory"])
        m = merged.setdefault(key, {})
        for y in years:
            m["y%d_units" % y] = float(r["y%d_units" % y] or 0)
            m["y%d_units_q" % y] = float(r["y%d_units_q" % y] or 0)
        m["soh"] = soh_map.get(key, 0.0)
    for key, soh in soh_map.items():
        if key not in merged:
            m = merged.setdefault(key, {})
            for y in years:
                m["y%d_units" % y] = 0.0
                m["y%d_units_q" % y] = 0.0
            m["soh"] = soh

    # Grand totals across everything (denominators for the % columns).
    totals = {}
    for y in years:
        totals["y%d_units_sold" % y] = sum(m["y%d_units" % y] for m in merged.values())
        totals["y%d_units_q" % y] = sum(m["y%d_units_q" % y] for m in merged.values())
    totals["soh"] = sum(m["soh"] for m in merged.values())

    def _pctof(val, key):
        t = totals.get(key, 0)
        return round(val / t * 100, 2) if t else 0.0

    # Group by category → subcategory rows + a per-category total row.
    by_cat = {}
    for (cat, sub), m in merged.items():
        by_cat.setdefault(cat or "—", []).append((sub, m))
    out_rows = []
    for cat in sorted(by_cat):
        subs = sorted(by_cat[cat], key=lambda x: -(x[1].get("y%d_units" % years[-1]) or 0))
        cat_tot = {}
        for sub, m in subs:
            row = {"category": cat, "subcategory": sub, "is_total": False}
            for y in years:
                u = m["y%d_units" % y]
                uq = m["y%d_units_q" % y]
                row["y%d_units_sold" % y] = int(u)
                row["y%d_units_sold_pct" % y] = _pctof(u, "y%d_units_sold" % y)
                row["y%d_units_q" % y] = int(uq)
                row["y%d_units_q_pct" % y] = _pctof(uq, "y%d_units_q" % y)
                cat_tot["y%d_units" % y] = cat_tot.get("y%d_units" % y, 0) + u
                cat_tot["y%d_units_q" % y] = cat_tot.get("y%d_units_q" % y, 0) + uq
            row["soh"] = int(m["soh"])
            row["soh_pct"] = _pctof(m["soh"], "soh")
            cat_tot["soh"] = cat_tot.get("soh", 0) + m["soh"]
            out_rows.append(row)
        trow = {"category": cat, "subcategory": "", "is_total": True}
        for y in years:
            trow["y%d_units_sold" % y] = int(cat_tot.get("y%d_units" % y, 0))
            trow["y%d_units_sold_pct" % y] = _pctof(cat_tot.get("y%d_units" % y, 0), "y%d_units_sold" % y)
            trow["y%d_units_q" % y] = int(cat_tot.get("y%d_units_q" % y, 0))
            trow["y%d_units_q_pct" % y] = _pctof(cat_tot.get("y%d_units_q" % y, 0), "y%d_units_q" % y)
        trow["soh"] = int(cat_tot.get("soh", 0))
        trow["soh_pct"] = _pctof(cat_tot.get("soh", 0), "soh")
        out_rows.append(trow)

    available_categories = sorted(
        {v for v in SUBCATEGORY_TO_CATEGORY.values() if v not in ("Accessories", "Sale")})
    totals_out = {}
    for y in years:
        totals_out["y%d_units_sold" % y] = int(totals["y%d_units_sold" % y])
        totals_out["y%d_units_q" % y] = int(totals["y%d_units_q" % y])
    totals_out["soh"] = int(totals["soh"])
    return {
        "years": years,
        "current_quarter": cq,
        "rows": out_rows,
        "totals": totals_out,
        "available_categories": available_categories,
    }


@app.get("/api/inventory-style-counts")
def inventory_style_counts(
    country:   str = Query(default=None),
    locations: str = Query(default=None),
):
    # Active = styles sold in the last 182 days; retired = styles with stock
    # but no sale in that window; total = the union.
    cf_s, chf_s = _style_filters(country, locations, "s")
    cf_i, _ = _style_filters(country, None, "i")
    loc_i = ""
    if locations:
        locs = [l.strip() for l in locations.split(",") if l.strip()]
        if locs:
            loc_i = " AND i.pos_location_name IN (" + ",".join(
                "'" + l.replace("'", "''") + "'" for l in locs) + ")"
    rows = run_query(
        """
        WITH sold AS (
            SELECT DISTINCT p.style_name
            FROM all_sales s
            JOIN all_products_clean p ON s.variant_sku = p.sku
            WHERE s.sale_kind IN ('sale','order') AND s.net_quantity > 0
              AND s.sale_date::date >= CURRENT_DATE - INTERVAL '182 days'
              AND p.style_name IS NOT NULL AND p.style_name <> ''
              AND """ + BASE_FILTERS + cf_s + chf_s + """
        ),
        instock AS (
            SELECT DISTINCT p.style_name
            FROM all_inventory i
            JOIN all_products_clean p ON i.sku = p.sku
            WHERE i.available > 0 AND p.style_name IS NOT NULL AND p.style_name <> ''""" + cf_i + loc_i + """
        )
        SELECT 'sold' AS src, style_name FROM sold
        UNION ALL
        SELECT 'instock' AS src, style_name FROM instock
        """
    ) or []
    # Compute counts in Python so the durable manual-retirement list is honored
    # consistently (the normalized match can't be expressed in raw SQL equality):
    # active = sold styles MINUS manual-retired; retired = everything in the
    # universe that is not active (in-stock-no-sale PLUS manual-retired); the two
    # buckets stay disjoint so active + retired == total.
    sold, instock = set(), set()
    for r in rows:
        (sold if r["src"] == "sold" else instock).add(r["style_name"])
    universe = sold | instock
    active = {s for s in sold if not _is_manually_retired(s)}
    retired = universe - active
    return {
        "active_styles": len(active),
        "retired_styles": len(retired),
        "total_styles": len(universe),
    }


@app.get("/api/range-mgmt/weekly-sor")
def range_mgmt_weekly_sor(country: str = Query(default=None), channel: str = Query(default=None)):
    cf, chf = _style_filters(country, channel, "s")
    icf, ichf = _style_filters(country, channel, "i")
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
              AND COALESCE(brand, '') NOT ILIKE '%third party%'
              AND LOWER(COALESCE(brand, '')) <> 'zoya'
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
            SELECT COALESCE(m.style_name, i.style_name) AS style_name, COALESCE(SUM(i.available), 0) AS current_stock
            FROM all_inventory i
            LEFT JOIN """ + SKU_STYLE_MAP + """ m ON m.sku = i.sku
            WHERE COALESCE(m.style_name, i.style_name) IN (SELECT style_name FROM new_styles)
              AND i.pos_location_name NOT IN (""" + WAREHOUSE_LOCATIONS + """)""" + icf + ichf + """
            GROUP BY 1
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
def _ensure_thumbnail_overrides():
    """Idempotently create the admin thumbnail-override table.

    Overrides come in two flavours: a pasted external ``image_url`` (https://…)
    or a file uploaded straight from the admin's device. Uploaded files are
    stored durably as bytes in ``image_data`` (+ ``content_type``) and served
    back through ``GET /api/thumbnails/{style}/image``; for those rows
    ``image_url`` holds that internal serving path so the lookup resolves them
    identically to URL overrides."""
    _users_exec("""
        CREATE TABLE IF NOT EXISTS thumbnail_overrides (
            style_name TEXT PRIMARY KEY,
            image_url  TEXT NOT NULL,
            updated_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("ALTER TABLE thumbnail_overrides ADD COLUMN IF NOT EXISTS image_data BYTEA")
    _users_exec("ALTER TABLE thumbnail_overrides ADD COLUMN IF NOT EXISTS content_type TEXT")


@app.get("/api/thumbnails")
def list_thumbnail_overrides(request: Request):
    """Admin management view: list all admin-set thumbnail overrides."""
    _require_admin(request)
    _ensure_thumbnail_overrides()
    rows = _users_exec(
        "SELECT style_name, image_url, updated_by, updated_at "
        "FROM thumbnail_overrides ORDER BY updated_at DESC", fetch=True) or []
    for r in rows:
        ua = r.get("updated_at")
        if ua is not None:
            r["updated_at"] = ua.isoformat()
    return rows

# --- GET stubs returning objects ---
@app.get("/api/analytics/cache-stats")
def analytics_cache_stats(): return _cache_stats_payload()
@app.get("/api/admin/cache-stats")
def admin_cache_stats(): return _cache_stats_payload()


# ── Ops / diagnostics endpoints (Phase 7) ─────────────────────────────────────
def _require_admin(request: Request):
    u = getattr(request.state, "user", None) or {}
    if u.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")


@app.get("/api/pool-status")
def pool_status(request: Request):
    _require_admin(request)
    pool = _get_pool()
    used = len(getattr(pool, "_used", {}) or {})
    idle = len(getattr(pool, "_pool", []) or [])
    return {
        "min_conn": pool.minconn,
        "max_conn": pool.maxconn,
        "used_conn": used,
        "available_conn": pool.maxconn - used,
        "idle_conn": idle,
    }


@app.get("/api/cache/status")
def cache_status():
    payload = _cache_stats_payload()
    now = time.time()
    total_bytes = 0
    oldest = None
    newest = None
    for _val, ts, _ttl in list(_cache.values()):
        oldest = ts if oldest is None or ts < oldest else oldest
        newest = ts if newest is None or ts > newest else newest
        try:
            total_bytes += len(json.dumps(_val, default=str))
        except Exception:
            pass
    return {
        "total_entries": len(_cache),
        "total_size_bytes": total_bytes,
        "hit_rate": payload["counters_since_boot"]["hit_rate_pct"],
        "ttl_buckets": payload["in_process_cache"]["ttl_buckets"],
        "oldest_entry_age_sec": round(now - oldest) if oldest else 0,
        "newest_entry_age_sec": round(now - newest) if newest else 0,
        # The query cache is keyed by SQL hash, not request path, so a true
        # per-endpoint breakdown is not available; ttl_buckets gives the live tier
        # split (60s today / 600s yesterday / 3600s historical).
        "endpoints": [],
    }


@app.post("/api/cache/clear")
def cache_clear(request: Request):
    _require_admin(request)
    n = len(_cache)
    _cache.clear()
    _cache_stats["evictions"] += n
    return {"ok": True, "cleared_entries": n}


@app.get("/api/diagnostics/slow-queries")
def diagnostics_slow_queries(request: Request):
    _require_admin(request)
    return {
        "warn_threshold_sec": SLOW_QUERY_WARN_SEC,
        "error_threshold_sec": SLOW_QUERY_ERROR_SEC,
        "count": len(_slow_queries),
        "slow_queries": list(_slow_queries),
    }
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
def get_data_freshness():
    # Real freshness from the analytics table load timestamp. `loaded_at` is a
    # naive server-time timestamp written by the sync; `now()::timestamp` is the
    # current server time, so their difference is a correct elapsed interval
    # regardless of session timezone. `secs` drives the relative "Updated X ago"
    # label so the client never has to reinterpret a naive timestamp.
    try:
        rows = run_query(
            "SELECT MAX(loaded_at) AS last_updated, "
            "MAX(sale_date) AS last_sale_date, "
            "EXTRACT(EPOCH FROM (now()::timestamp - MAX(loaded_at))) AS secs "
            "FROM all_sales"
        )
        r = rows[0] if rows else {}
        lu = r.get("last_updated")
        secs = r.get("secs")
        return {
            "fresh": True,
            "last_updated": lu.isoformat() if hasattr(lu, "isoformat") else lu,
            "seconds_since_update": int(secs) if secs is not None else None,
            "last_sale_date": r.get("last_sale_date"),
        }
    except Exception:
        return {"fresh": False, "last_updated": None, "seconds_since_update": None, "last_sale_date": None}
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
def notifications_unread_count(request: Request):
    # Badge count = number of pending access requests, admins only.
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        return {"unread": 0}
    rows = _users_exec(
        "SELECT COUNT(*) AS n FROM app_users WHERE status='pending'", fetch=True) or []
    return {"unread": int(rows[0]["n"]) if rows else 0}
@app.get("/api/leaderboard/store-of-the-week")
def stub_leaderboard_store_of_the_week(): return {}
@app.get("/api/thumbnails/lookup")
def stub_thumbnails_lookup(): return {}
@app.post("/api/thumbnails/lookup")
async def thumbnails_lookup(request: Request):
    """Batch-resolve a list of style names to a representative product photo.

    The frontend posts ``{"styles": [...]}`` (chunked to <=300) and renders the
    returned ``{style_name: "/api/product-image/<sku>"}`` map directly as an
    <img> src. Styles with no stored image are simply omitted so the client
    falls back to its deterministic coloured-initials placeholder.

    One set-based query per request (no per-style N+1): join the product master
    style -> sku -> image map -> stored image, then DISTINCT ON keeps one SKU
    per style (the lexicographically smallest SKU that actually has an image)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body.get("styles") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        return {}
    names, seen = [], set()
    for s in raw:
        if isinstance(s, str):
            t = s.strip()
            if t and t not in seen:
                seen.add(t)
                names.append(t)
    if not names:
        return {}
    names = names[:300]  # match the frontend chunk size; defensive cap
    out = {}
    # Admin-set overrides take precedence over the Odoo-derived photo.
    try:
        _ensure_thumbnail_overrides()
        ov_rows = _users_exec(
            "SELECT style_name, image_url FROM thumbnail_overrides "
            "WHERE style_name = ANY(%s) AND image_url <> ''",
            (names,), fetch=True) or []
        for r in ov_rows:
            if r.get("style_name") and r.get("image_url"):
                out[r["style_name"]] = r["image_url"]
    except Exception:
        pass
    # Resolve the remaining styles to their Odoo product photo.
    remaining = [n for n in names if n not in out]
    if remaining:
        conn = get_conn()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT DISTINCT ON (p.style_name) p.style_name, p.sku "
                "FROM all_products_clean p "
                "JOIN product_image_map m ON m.sku = p.sku "
                "JOIN product_images i ON i.tmpl_id = m.tmpl_id "
                "WHERE p.style_name = ANY(%s) "
                "AND i.image_512 IS NOT NULL AND i.image_512 <> '' "
                "ORDER BY p.style_name, p.sku",
                (remaining,)
            )
            rows = cur.fetchall()
            cur.close()
        finally:
            conn.close()
        for style_name, sku in rows:
            if style_name and sku:
                out[style_name] = f"/api/product-image/{quote(str(sku), safe='')}"
    return out
@app.get("/api/auth/activity-streak")
def stub_auth_activity_streak(): return {"streak": 0}
@app.get("/api/auth/allowed-domains")
def stub_auth_allowed_domains(): return {"domains": list(clerk_auth.ALLOWED_DOMAINS)}
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
    if bucket == "year":
        return d.strftime("%Y")
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
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END) AS units_sold,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END) - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END)) / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
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

# ── Trend Analysis ────────────────────────────────────────────────────────────
# A dedicated, richer time-series used by the Trend Analysis page. Unlike
# /api/analytics/kpi-trend it (a) supports a "year" bucket, (b) can scope to a
# single store (pos_location_name), and (c) folds in FOOTFALL and CONVERSION by
# joining the footfall sensor table per bucket. Metric definitions deliberately
# MIRROR /api/kpis so a trend ties out to the Overview KPI cards:
#   total_sales = net of returns; net_sales = net incl. returns; units = net_quantity;
#   ABV = total_sales / orders; ASP = total_sales / ordered_item_quantity.
@app.get("/api/analytics/trend-series")
def get_trend_series(
    date_from: str = Query(default=str(date.today().replace(month=1, day=1))),
    date_to:   str = Query(default=str(date.today())),
    country:   str = Query(default=None),
    store:     str = Query(default=None),
    bucket:    str = Query(default="month"),
):
    bucket = bucket if bucket in ("day", "week", "month", "quarter", "year") else "month"
    # `store` is a pos_location_name; reuse build_filters' channel arg which
    # filters s.pos_location_name. Absent => overall (all stores).
    where = build_filters(date_from, date_to, country, store)
    sales_rows = run_query("""
        SELECT
            date_trunc('""" + bucket + """', s.sale_date::date)::date AS bucket_date,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END)
                - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END), 0) AS total_sales,
            ROUND(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.net_sales_kes::numeric
                          WHEN s.sale_kind = 'return' THEN -s.returns_kes::numeric ELSE 0 END), 0) AS net_sales,
            SUM(s.net_quantity) AS units_sold,
            COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END) AS orders,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END)
                - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END))
                / NULLIF(COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order') THEN s.order_id END), 0), 0) AS avg_basket_size,
            ROUND((SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.total_sales_kes::numeric ELSE 0 END)
                - SUM(CASE WHEN s.sale_kind = 'return' THEN s.returns_kes::numeric ELSE 0 END))
                / NULLIF(SUM(CASE WHEN s.sale_kind IN ('sale','order') THEN s.ordered_item_quantity ELSE 0 END), 0), 0) AS avg_selling_price
        FROM all_sales s
        WHERE """ + where + """
        GROUP BY 1
        ORDER BY 1
    """, date_to=date_to)

    # Footfall per bucket from the sensor table. Footfall has no country column,
    # so a country filter cannot be applied here; when a single store is chosen
    # we scope footfall to that store via the canonical name (post-rename safe).
    ff_where = "f.time BETWEEN '" + date_from + "' AND '" + date_to + "'"
    if store:
        ff_where += " AND " + ff_canon_sql() + " IN (" + csv_to_sql(store) + ")"
    ff_rows = run_query("""
        SELECT date_trunc('""" + bucket + """', f.time::date)::date AS bucket_date,
            SUM(f.a01_footfall_in) AS footfall
        FROM footfall f
        WHERE """ + ff_where + """
        GROUP BY 1
    """, date_to=date_to)
    ff_by_bucket = {str(r["bucket_date"]): (r["footfall"] or 0) for r in ff_rows}

    out = []
    for r in sales_rows:
        d = r.pop("bucket_date")
        key = str(d)
        ff = ff_by_bucket.pop(key, 0) or 0
        orders = r.get("orders") or 0
        r["date"] = key
        r["label"] = _fmt_bucket_label(d, bucket)
        r["footfall"] = int(ff)
        r["conversion_rate"] = (round(orders * 100.0 / ff, 2) if ff else None)
        out.append(r)
    # Buckets that have footfall but no sales rows (rare — e.g. a store with a
    # sensor but no qualifying sales in the window). Surface them so the
    # footfall/conversion trend isn't silently truncated.
    for key, ff in ff_by_bucket.items():
        if not ff:
            continue
        d = date.fromisoformat(key)
        out.append({
            "date": key, "label": _fmt_bucket_label(d, bucket),
            "total_sales": 0, "net_sales": 0, "units_sold": 0, "orders": 0,
            "avg_basket_size": 0, "avg_selling_price": 0,
            "footfall": int(ff), "conversion_rate": 0.0,
        })
    out.sort(key=lambda x: x["date"])
    return out


def _trend_ai_core(body):
    """Generate a short, grounded narrative for a single KPI trend. The client
    sends the metric, its unit, the granularity, the scope label, and the
    plotted points; we compute deterministic summary stats and ask the LLM to
    describe what the trend says (direction, momentum, peaks/troughs, a
    pointer) in plain business English. Output is plain text, never JSON."""
    metric_label = str(body.get("metric_label") or "the metric").strip()[:80]
    unit = str(body.get("unit") or "").strip().lower()  # "kes" | "count" | "pct"
    bucket = str(body.get("bucket") or "period").strip()[:16]
    scope_label = str(body.get("scope_label") or "overall").strip()[:80]
    points = body.get("points") or []
    series = []
    for p in points:
        try:
            v = p.get("value")
            if v is None:
                continue
            series.append((str(p.get("label") or "")[:24], float(v)))
        except (TypeError, ValueError, AttributeError):
            continue
    if len(series) < 2:
        return {"available": False, "reason": "not_enough_points"}

    vals = [v for _, v in series]
    first_lbl, first_v = series[0]
    last_lbl, last_v = series[-1]
    max_lbl, max_v = max(series, key=lambda s: s[1])
    min_lbl, min_v = min(series, key=lambda s: s[1])
    avg_v = sum(vals) / len(vals)
    pct_change = ((last_v - first_v) / abs(first_v) * 100) if first_v else None

    def _fmt(v):
        if unit == "kes":
            return "KES %s" % format(round(v), ",")
        if unit == "pct":
            return "%.1f%%" % v
        return format(round(v), ",")

    direction = "flat"
    if pct_change is not None:
        if pct_change > 3:
            direction = "rising"
        elif pct_change < -3:
            direction = "declining"
    facts = (
        "Metric: %s. Granularity: per %s. Scope: %s.\n"
        "Points (%d): %s.\n"
        "First (%s): %s. Last (%s): %s. Overall change: %s.\n"
        "Peak (%s): %s. Trough (%s): %s. Average: %s. Direction: %s."
    ) % (
        metric_label, bucket, scope_label, len(series),
        ", ".join("%s=%s" % (lbl, _fmt(v)) for lbl, v in series[:40]),
        first_lbl, _fmt(first_v), last_lbl, _fmt(last_v),
        ("%+.1f%%" % pct_change if pct_change is not None else "n/a"),
        max_lbl, _fmt(max_v), min_lbl, _fmt(min_v), _fmt(avg_v), direction,
    )
    sys = (
        "You are a retail BI analyst for Vivo Fashion Group, a multi-brand "
        "fashion retailer in East Africa (Kenya/Uganda/Rwanda + Online). All "
        "money is in Kenyan Shillings (KES). You are given a single KPI's trend "
        "over time with summary statistics. Write a concise, decision-useful "
        "narrative (3-5 sentences, <=120 words) describing what the trend "
        "shows: overall direction and momentum, notable peaks/troughs or "
        "turning points, and one practical implication or thing to watch. Use "
        "the exact figures provided; do not invent numbers. Plain prose, no "
        "markdown headers, no bullet lists, no emojis."
    )
    narrative = _chat_llm(
        [{"role": "system", "content": sys},
         {"role": "user", "content": facts}],
        max_tokens=320,
    )
    narrative = (narrative or "").strip()
    if not narrative:
        return {"available": False, "reason": "empty"}
    return {
        "available": True,
        "narrative": narrative,
        "direction": direction,
        "pct_change": (round(pct_change, 1) if pct_change is not None else None),
    }


@app.post("/api/analytics/trend-ai")
async def trend_ai_post(request: Request):
    """AI narrative for a Trend Analysis chart. The AI key is server-only, so
    the client posts the plotted series + metadata and we run the LLM here.
    Always returns gracefully — a narrative is an enhancement, never a blocker."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {"available": False, "reason": "ai_not_configured"}
    try:
        return await _chat_run_in_threadpool(_trend_ai_core, body or {})
    except Exception:
        return {"available": False, "reason": "ai_error"}

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
    # Admin-provisioned email/password account. Credentials are owned locally:
    # we store a PBKDF2 hash and mark the account active so it can sign in at once.
    try:
        body = await request.json()
    except Exception:
        body = {}
    email = (body.get("email") or "").strip().lower()
    name = (body.get("name") or "").strip()
    password = body.get("password") or ""
    role = body.get("role") or DEFAULT_NEW_ROLE
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

    first = (name.split()[0] if name else email.split("@")[0])
    ph = _hash_password(password)
    acting = getattr(request.state, "user", None) or {}
    approver = acting.get("email") or acting.get("id")
    user_id = "local:" + secrets.token_hex(8)
    rows = _users_exec("""
        INSERT INTO app_users (user_id, email, name, role, status, auth_method,
                               password_hash, approved_at, approved_by)
        VALUES (%s, %s, %s, %s, 'active', 'password', %s, now(), %s)
        ON CONFLICT (email) DO UPDATE
            SET name=EXCLUDED.name, role=EXCLUDED.role, status='active',
                auth_method='password', password_hash=EXCLUDED.password_hash,
                approved_at=now(), approved_by=EXCLUDED.approved_by
        RETURNING user_id
    """, (user_id, email, name or first, role, ph, approver), fetch=True)
    sub = rows[0]["user_id"] if rows else user_id
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
    transfer_ref = (body.get("transfer_ref") or "").strip() or None
    acting = getattr(request.state, "user", None) or {}
    acted_by = acting.get("name") or acting.get("email")
    # Callers identify rows by either sku (Replenishments) or barcode
    # (ReplenishmentReport); store under both so either GET row matches.
    if sku:
        _set_replen_mark(pos_location, "sku", sku, replenished, actual, acted_by, transfer_ref)
    if barcode:
        _set_replen_mark(pos_location, "barcode", barcode, replenished, actual, acted_by, transfer_ref)
    return {
        "ok": True, "sku": sku, "barcode": barcode, "pos_location": pos_location,
        "replenished": replenished, "actual_units_replenished": actual,
        "transfer_ref": transfer_ref or "",
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
async def set_thumbnail_override(style: str, request: Request):
    """Admin-only: upsert a custom thumbnail URL for a style name."""
    _require_admin(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    style_name = (style or body.get("style_name") or "").strip()
    image_url = (body.get("image_url") or "").strip()
    if not style_name:
        raise HTTPException(status_code=400, detail="Missing style name.")
    if not re.match(r"^https?://", image_url, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Paste a full https:// image URL.")
    _ensure_thumbnail_overrides()
    actor = getattr(request.state, "user", None) or {}
    updated_by = actor.get("email") or actor.get("name") or actor.get("user_id") or "admin"
    # A pasted URL supersedes any previously uploaded file for this style, so
    # clear the stored bytes to avoid serving a stale upload.
    _users_exec(
        "INSERT INTO thumbnail_overrides (style_name, image_url, image_data, content_type, updated_by, updated_at) "
        "VALUES (%s, %s, NULL, NULL, %s, now()) "
        "ON CONFLICT (style_name) DO UPDATE SET "
        "image_url = EXCLUDED.image_url, image_data = NULL, content_type = NULL, "
        "updated_by = EXCLUDED.updated_by, updated_at = now()",
        (style_name, image_url, updated_by))
    return {"ok": True, "style_name": style_name, "image_url": image_url}


# Accepted upload image types -> canonical content-type served back.
_THUMB_UPLOAD_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
}
_THUMB_MAX_BYTES = 5 * 1024 * 1024  # 5 MB decoded ceiling


@app.post("/api/thumbnails/{style}/upload")
async def upload_thumbnail_override(style: str, request: Request):
    """Admin-only: store an image uploaded straight from the admin's device.

    The frontend reads the chosen file as a base64 data URL and POSTs JSON
    ``{content_type, data_base64}``. The bytes are stored durably on the
    override row and the row's ``image_url`` is set to the internal serving
    path (``/api/thumbnails/{style}/image?v=<epoch>``) so the lookup endpoint
    resolves it exactly like a pasted URL."""
    _require_admin(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    style_name = (style or body.get("style_name") or "").strip()
    if not style_name:
        raise HTTPException(status_code=400, detail="Missing style name.")
    content_type = (body.get("content_type") or "").strip().lower()
    data_b64 = body.get("data_base64") or body.get("data") or ""
    if isinstance(data_b64, str) and data_b64.startswith("data:"):
        # Tolerate a full data URL: data:image/png;base64,XXXX
        header, _, rest = data_b64.partition(",")
        data_b64 = rest
        if not content_type:
            m = re.match(r"data:([^;]+)", header)
            if m:
                content_type = m.group(1).strip().lower()
    if content_type not in _THUMB_UPLOAD_TYPES:
        raise HTTPException(status_code=400, detail="Upload a JPG, PNG or WebP image.")
    if not isinstance(data_b64, str) or not data_b64.strip():
        raise HTTPException(status_code=400, detail="No image data received.")
    try:
        raw = base64.b64decode(data_b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Couldn't read the image file.")
    if not raw:
        raise HTTPException(status_code=400, detail="No image data received.")
    if len(raw) > _THUMB_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (max 5 MB).")
    served_type = _THUMB_UPLOAD_TYPES[content_type]
    _ensure_thumbnail_overrides()
    actor = getattr(request.state, "user", None) or {}
    updated_by = actor.get("email") or actor.get("name") or actor.get("user_id") or "admin"
    # Cache-bust the served path so a re-upload immediately shows the new image.
    image_url = f"/api/thumbnails/{quote(style_name, safe='')}/image?v={int(time.time())}"
    _users_exec(
        "INSERT INTO thumbnail_overrides (style_name, image_url, image_data, content_type, updated_by, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, now()) "
        "ON CONFLICT (style_name) DO UPDATE SET "
        "image_url = EXCLUDED.image_url, image_data = EXCLUDED.image_data, "
        "content_type = EXCLUDED.content_type, updated_by = EXCLUDED.updated_by, updated_at = now()",
        (style_name, image_url, psycopg2.Binary(raw), served_type, updated_by))
    return {"ok": True, "style_name": style_name, "image_url": image_url}


@app.get("/api/thumbnails/{style}/image")
def get_thumbnail_override_image(style: str):
    """Serve the raw bytes of an uploaded thumbnail override for a style."""
    style_name = (style or "").strip()
    if not style_name:
        return Response(status_code=404)
    try:
        _ensure_thumbnail_overrides()
        rows = _users_exec(
            "SELECT image_data, content_type FROM thumbnail_overrides "
            "WHERE style_name = %s LIMIT 1",
            (style_name,), fetch=True) or []
    except Exception:
        return Response(status_code=404)
    if not rows:
        return Response(status_code=404)
    data = rows[0].get("image_data")
    if not data:
        return Response(status_code=404)
    raw = bytes(data) if not isinstance(data, (bytes, bytearray)) else bytes(data)
    ctype = rows[0].get("content_type") or "image/jpeg"
    return Response(content=raw, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=604800"})
@app.delete("/api/thumbnails/{style}")
async def delete_thumbnail_override(style: str, request: Request):
    """Admin-only: remove a custom thumbnail override for a style name."""
    _require_admin(request)
    style_name = (style or "").strip()
    if not style_name:
        raise HTTPException(status_code=400, detail="Missing style name.")
    _ensure_thumbnail_overrides()
    _users_exec(
        "DELETE FROM thumbnail_overrides WHERE style_name = %s", (style_name,))
    return {"ok": True, "style_name": style_name}
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
    _redistribute_replen_owners(owners)
    return {"ok": True, "owners": owners}


@app.get("/api/replenishment/roster")
def replenishment_roster_get(request: Request):
    """Current roster + whether the caller may save/redistribute it. Readable by
    any signed-in user (the owner columns are visible to everyone)."""
    user = getattr(request.state, "user", None)
    return {"owners": _replen_owners(), "can_manage": _can_manage_roster(user)}


@app.post("/api/replenishment/roster")
async def replenishment_roster_post(request: Request):
    """Save the roster AND redistribute the store→owner map (the only place a
    redistribution is triggered). Restricted to admins + named operators."""
    user = getattr(request.state, "user", None)
    if not _can_manage_roster(user):
        return JSONResponse(
            {"detail": "You don't have permission to save or redistribute the roster."},
            status_code=403)
    body = await request.json()
    owners = [str(o).strip() for o in (body.get("owners") or []) if str(o).strip()]
    owners = owners or list(_DEFAULT_REPLEN_OWNERS)
    _set_replen_owners(owners)
    # Freeze the pick-list balance over the window the operator is viewing so the
    # equal-units split matches what's on screen. Dates are re-validated here
    # (defense in depth) because they reach _compute_replenishment_report_rows.
    raw_df, raw_dt = body.get("date_from"), body.get("date_to")
    df = _pa_safe_date(raw_df, None) if raw_df else None
    dt = _pa_safe_date(raw_dt, None) if raw_dt else None
    _redistribute_replen_owners(owners, date_from=df, date_to=dt)
    return {"ok": True, "owners": owners, "can_manage": True}
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


def _num(v, default=0.0):
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _projection_ai_core(feat):
    """Ask the LLM to act as a retail intraday forecaster. It receives the
    deterministic features (so-far revenue/orders, elapsed shape fraction, the
    last few same-DOW closing totals, SDLM/SDLY) and returns a calibrated
    end-of-day estimate with a range, confidence and one-line rationale. The
    output is validated + clamped so a bad/hallucinated number can never make
    the projection nonsensical (must be >= so-far revenue)."""
    so_far = _num(feat.get("so_far"))
    orders = int(_num(feat.get("orders")))
    elapsed_pct = round(_num(feat.get("elapsed")) * 100, 1)
    shape_pct = round(_num(feat.get("shape_fraction")) * 100, 1)
    dow_name = str(feat.get("dow_name") or "")
    now_local = str(feat.get("now_local") or "")
    dow_totals = [round(_num(x)) for x in (feat.get("dow_totals") or []) if _num(x) > 0]
    dow_avg = round(sum(dow_totals) / len(dow_totals)) if dow_totals else 0
    sdlm = round(_num(feat.get("sdlm")))
    sdly = round(_num(feat.get("sdly")))
    curve_proj = round(_num(feat.get("curve_projected")))
    linear_proj = round(_num(feat.get("linear_projected")))

    sys = (
        "You are a precise retail intraday sales forecaster for a fashion "
        "retailer in East Africa (Kenya/Uganda/Rwanda), trading 9:00 AM to "
        "8:30 PM (Africa/Nairobi). Sales are NOT linear across the day: "
        "mornings are slow, there is a midday bump, and the afternoon/early "
        "evening is the strongest. Estimate today's end-of-day total revenue "
        "in KES given how the day is tracking so far versus the same weekday "
        "in prior weeks. Be realistic and avoid over-reacting to a small "
        "morning sample. Respond with STRICT JSON only, no prose:\n"
        '{"projected": <number>, "low": <number>, "high": <number>, '
        '"confidence": "low|medium|high", "rationale": "<=140 chars"}'
    )
    user = (
        f"Now: {now_local} ({dow_name}). Clock-elapsed of trading window: "
        f"{elapsed_pct}%. Typical revenue completed by now (intraday shape "
        f"curve): {shape_pct}%.\n"
        f"So far today: KES {round(so_far):,} across {orders} orders.\n"
        f"Last same-weekday closing totals: {dow_totals} (avg KES {dow_avg:,}).\n"
        f"Same day last month: KES {sdlm:,}. Same day last year: KES {sdly:,}.\n"
        f"Reference projections — shape-curve: KES {curve_proj:,}, "
        f"linear-pace: KES {linear_proj:,}.\n"
        "Return the JSON forecast now."
    )
    raw = _chat_llm([{"role": "system", "content": sys},
                     {"role": "user", "content": user}])
    parsed = _chat_extract_json(raw) or {}
    proj = _num(parsed.get("projected"))
    if proj <= 0:
        return {"available": False}
    # Clamp: never below what is already booked; cap runaway estimates at a
    # sane multiple of the same-DOW average / so-far figure.
    ceiling = max(dow_avg, curve_proj, linear_proj, so_far) * 3 + 1
    proj = max(so_far, min(proj, ceiling))
    low = _num(parsed.get("low"))
    high = _num(parsed.get("high"))
    low = max(so_far, min(low, proj)) if low > 0 else proj * 0.9
    high = max(proj, min(high, ceiling)) if high > 0 else proj * 1.1
    conf = str(parsed.get("confidence") or "medium").lower()
    if conf not in ("low", "medium", "high"):
        conf = "medium"
    rationale = str(parsed.get("rationale") or "").strip()[:160]
    return {
        "available": True,
        "projected": round(proj),
        "low": round(low),
        "high": round(high),
        "confidence": conf,
        "rationale": rationale,
    }


@app.post("/api/analytics/projection-ai")
async def projection_ai_post(request: Request):
    """AI-assisted end-of-day projection. The client sends the deterministic
    intraday features it already computed; we run an LLM forecast server-side
    (the AI key is server-only) and return a calibrated estimate + rationale."""
    try:
        feat = await request.json()
    except Exception:
        feat = {}
    if not (os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
            and os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")):
        return {"available": False, "reason": "ai_not_configured"}
    try:
        return await _chat_run_in_threadpool(_projection_ai_core, feat or {})
    except Exception:
        return {"available": False, "reason": "ai_error"}


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


# ══════════════════════════════════════════════════════════════════════════════
# Phase 3 — IBT/replenishment outcome tracking, accuracy, bulk ops, Excel ops
# exports, chronic-stockout snapshots, predictive alerts and store-potential.
# All read-only BI aggregation against the live Postgres (sale_date is TEXT, so
# every date function gets an explicit ::date cast). Velocity uses the same
# recency-weighted 56-day EWMA proxy as the rest of the app: a style's weekly run
# rate ≈ ((u28*2) + max(u56-u28, 0)) / 12, which double-weights the most recent
# 28 days over the trailing 56-day window.
# ══════════════════════════════════════════════════════════════════════════════
VELOCITY_METHOD = "ewma_56d"


def _ewma_weekly(u28, u56):
    """Recency-weighted weekly run-rate (units/week) from 28d & 56d unit sums."""
    u28 = float(u28 or 0)
    u56 = float(u56 or 0)
    return ((u28 * 2.0) + max(u56 - u28, 0.0)) / 12.0


# ── Step 1 — IBT outcome tracking + ROI (audit B2) ────────────────────────────
_IBT_OUTCOMES_SQL = """
    SELECT c.style_name, c.brand, c.subcategory, c.to_store, c.from_store, c.flow,
        c.actual_units_moved, c.transfer_date, c.completed_at,
        COALESCE(SUM(s.net_quantity) FILTER (
            WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 30
              AND s.pos_location_name = c.to_store), 0) AS sold_30d,
        COALESCE(SUM(s.net_quantity) FILTER (
            WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 60
              AND s.pos_location_name = c.to_store), 0) AS sold_60d,
        ROUND(100.0 * COALESCE(SUM(s.net_quantity) FILTER (
            WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 30
              AND s.pos_location_name = c.to_store), 0)
            / NULLIF(c.actual_units_moved, 0), 1) AS sell_through_30d,
        ROUND(100.0 * COALESCE(SUM(s.net_quantity) FILTER (
            WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 60
              AND s.pos_location_name = c.to_store), 0)
            / NULLIF(c.actual_units_moved, 0), 1) AS sell_through_60d
    FROM ibt_completions c
    LEFT JOIN all_products_clean p ON p.style_name = c.style_name
    LEFT JOIN all_sales s ON s.variant_sku = p.sku
        AND s.sale_kind IN ('sale','order')
    WHERE c.transfer_date IS NOT NULL
    GROUP BY c.id, c.style_name, c.brand, c.subcategory, c.to_store, c.from_store,
        c.flow, c.actual_units_moved, c.transfer_date, c.completed_at
    ORDER BY c.completed_at DESC
"""


def _ibt_outcome_rows():
    rows = run_query(_IBT_OUTCOMES_SQL) or []
    out = []
    for r in rows:
        out.append({
            "style_name": r.get("style_name"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"), "to_store": r.get("to_store"),
            "from_store": r.get("from_store"), "flow": r.get("flow"),
            "actual_units_moved": int(r.get("actual_units_moved") or 0),
            "transfer_date": r["transfer_date"].isoformat() if r.get("transfer_date") else None,
            "completed_at": r["completed_at"].isoformat() if r.get("completed_at") else None,
            "sold_30d": int(r.get("sold_30d") or 0),
            "sold_60d": int(r.get("sold_60d") or 0),
            "sell_through_30d": float(r["sell_through_30d"]) if r.get("sell_through_30d") is not None else None,
            "sell_through_60d": float(r["sell_through_60d"]) if r.get("sell_through_60d") is not None else None,
        })
    return out


@app.get("/api/ibt/outcomes")
def ibt_outcomes():
    return _ibt_outcome_rows()


@app.get("/api/ibt/outcomes/summary")
def ibt_outcomes_summary():
    rows = _ibt_outcome_rows()
    total = len(rows)
    units = sum(r["actual_units_moved"] for r in rows)
    st30 = [r["sell_through_30d"] for r in rows if r["sell_through_30d"] is not None]
    st60 = [r["sell_through_60d"] for r in rows if r["sell_through_60d"] is not None]
    # Per-destination-store performance = avg 30d sell-through across its inbound
    # transfers (answers Q4: stores that receive IBTs but do not sell them).
    by_store = {}
    for r in rows:
        b = by_store.setdefault(r["to_store"], [])
        if r["sell_through_30d"] is not None:
            b.append(r["sell_through_30d"])
    store_avg = {k: round(sum(v) / len(v), 1) for k, v in by_store.items() if v}
    best = max(store_avg.items(), key=lambda kv: kv[1]) if store_avg else None
    worst = min(store_avg.items(), key=lambda kv: kv[1]) if store_avg else None
    return {
        "total_transfers": total,
        "total_units_moved": units,
        "avg_sell_through_30d": round(sum(st30) / len(st30), 1) if st30 else 0,
        "avg_sell_through_60d": round(sum(st60) / len(st60), 1) if st60 else 0,
        "transfers_above_50pct_30d": sum(1 for x in st30 if x >= 50),
        "transfers_above_50pct_60d": sum(1 for x in st60 if x >= 50),
        "best_performing_store": ({"store": best[0], "avg_sell_through_30d": best[1]} if best else None),
        "worst_performing_store": ({"store": worst[0], "avg_sell_through_30d": worst[1]} if worst else None),
        "velocity_method": VELOCITY_METHOD,
    }


# ── Step 3 — replenishment recommendation accuracy ────────────────────────────
@app.get("/api/replenishment/accuracy")
def replenishment_accuracy():
    # Compare each completed replenishment (recommendation_actions rec_type
    # 'replenish', status 'done') against what actually sold at that store in the
    # 28 days AFTER the action. rec_key is "<store>|<kind>|<value>" where kind is
    # 'sku' or 'barcode'. actual_units holds the units that were replenished.
    rows = _users_exec("""
        WITH acts AS (
            SELECT rec_key, actual_units, acted_at,
                split_part(rec_key, '|', 1) AS store,
                split_part(rec_key, '|', 2) AS kind,
                split_part(rec_key, '|', 3) AS val
            FROM recommendation_actions
            WHERE rec_type = 'replenish' AND status = 'done'
              AND actual_units > 0 AND acted_at IS NOT NULL
        )
        SELECT a.rec_key, a.store, a.actual_units, a.acted_at,
            MAX(p.style_name) AS style_name, COALESCE(NULLIF(MAX(p.product_name), ''), MAX(s.product_title)) AS product_name,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date BETWEEN a.acted_at::date
                  AND a.acted_at::date + 28), 0) AS sold_28d
        FROM acts a
        LEFT JOIN all_products_clean p
            ON (a.kind = 'sku' AND p.sku = a.val)
            OR (a.kind = 'barcode' AND p.barcode = a.val)
        LEFT JOIN all_sales s ON s.variant_sku = p.sku
            AND s.pos_location_name = a.store
            AND s.sale_kind IN ('sale','order')
        GROUP BY a.rec_key, a.store, a.actual_units, a.acted_at
    """, fetch=True) or []
    over, under, well = [], [], []
    stockout_days = []
    for r in rows:
        rec = int(r.get("actual_units") or 0)
        sold = int(r.get("sold_28d") or 0)
        item = {
            "store": r.get("store"),
            "style_name": r.get("style_name") or r.get("product_name"),
            "recommended": rec, "sold_28d": sold,
            "accuracy_pct": round(100.0 * min(rec, sold) / max(rec, sold, 1), 1) if (rec or sold) else 0.0,
        }
        if sold <= 0 or rec > sold * 1.2:
            over.append(item)
        elif rec < sold * 0.8:
            under.append(item)
        else:
            well.append(item)
        if sold > 0:
            # Days the replenished units last at the observed post-replenish rate.
            stockout_days.append(rec / (sold / 28.0))
    total = len(rows)
    over.sort(key=lambda x: x["recommended"] - x["sold_28d"], reverse=True)
    under.sort(key=lambda x: x["sold_28d"] - x["recommended"], reverse=True)
    return {
        "accuracy_score": round(100.0 * len(well) / total, 1) if total else 0.0,
        "evaluated": total,
        "over_replenished": over,
        "under_replenished": under,
        "well_calibrated": well,
        "avg_days_to_stockout_after_replenish": round(sum(stockout_days) / len(stockout_days), 1) if stockout_days else None,
    }


# ── Step 4 — bulk approve/reject + summary (audit D3) ─────────────────────────
@app.post("/api/recommendations/bulk")
async def post_recommendations_bulk(request: Request):
    from fastapi import HTTPException
    body = await request.json()
    actions = body.get("actions") if isinstance(body, dict) else body
    if not isinstance(actions, list) or not actions:
        raise HTTPException(status_code=400, detail="actions must be a non-empty array")
    acting = getattr(request.state, "user", None) or {}
    default_by = acting.get("name") or acting.get("email")
    updated = 0
    with _users_tx() as cur:
        for a in actions:
            if not isinstance(a, dict):
                continue
            rt = a.get("rec_type") or a.get("item_type")
            rk = a.get("rec_key") or a.get("item_key")
            stt = a.get("status")
            if not rt or not rk or not stt:
                continue
            by = a.get("acted_by") or default_by
            note = a.get("reason") or a.get("note")
            au = a.get("actual_units")
            if stt == "pending":
                cur.execute(
                    "DELETE FROM recommendation_actions WHERE rec_type=%s AND rec_key=%s",
                    (rt, rk))
                updated += cur.rowcount
                continue
            cur.execute(
                "INSERT INTO recommendation_actions "
                "(rec_type, rec_key, status, reason, actual_units, acted_by, acted_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,now()) "
                "ON CONFLICT (rec_type, rec_key) DO UPDATE SET "
                "status=EXCLUDED.status, reason=EXCLUDED.reason, "
                "actual_units=EXCLUDED.actual_units, acted_by=EXCLUDED.acted_by, acted_at=now()",
                (rt, rk, stt, note, au, by))
            updated += cur.rowcount
    return {"ok": True, "updated": updated}


@app.delete("/api/recommendations/bulk")
async def delete_recommendations_bulk(request: Request):
    from fastapi import HTTPException
    try:
        body = await request.json()
    except Exception:
        body = {}
    rt = body.get("rec_type") if isinstance(body, dict) else None
    stt = body.get("status") if isinstance(body, dict) else None
    if not rt:
        raise HTTPException(status_code=400, detail="rec_type is required")
    with _users_tx() as cur:
        if stt:
            cur.execute(
                "DELETE FROM recommendation_actions WHERE rec_type=%s AND status=%s",
                (rt, stt))
        else:
            cur.execute("DELETE FROM recommendation_actions WHERE rec_type=%s", (rt,))
        deleted = cur.rowcount
    return {"ok": True, "deleted": deleted}


@app.get("/api/recommendations/summary")
def recommendations_summary():
    rows = _users_exec(
        "SELECT rec_type, status, COUNT(*) AS n FROM recommendation_actions "
        "GROUP BY rec_type, status", fetch=True) or []
    out = {}
    for r in rows:
        out.setdefault(r["rec_type"] or "unknown", {})[r["status"] or "unknown"] = int(r["n"])
    return out


# ── Step 5 — operations Excel exports (audit D4) ──────────────────────────────
_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_BRAND_ORANGE = "E85B1B"


def _xlsx_response(wb, filename):
    import io
    from fastapi.responses import StreamingResponse
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type=_XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _xlsx_sheet_title(name, used):
    import re
    t = re.sub(r'[:\\/?*\[\]]', '-', str(name or "Sheet"))[:31] or "Sheet"
    base = t
    i = 2
    while t.lower() in used:
        suffix = f" ({i})"
        t = (base[:31 - len(suffix)] + suffix)
        i += 1
    used.add(t.lower())
    return t


def _xlsx_header(ws, cols):
    from openpyxl.styles import Font, PatternFill, Alignment
    fill = PatternFill("solid", fgColor=_BRAND_ORANGE)
    font = Font(bold=True, color="FFFFFF")
    for ci, h in enumerate(cols, 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.fill = fill
        c.font = font
        c.alignment = Alignment(horizontal="left", vertical="center")
        ws.column_dimensions[c.column_letter].width = max(12, min(40, len(str(h)) + 6))
    ws.freeze_panes = "A2"


@app.get("/api/ibt/export/operations")
def ibt_export_operations(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
    use_clustering: bool = Query(default=True),
):
    from openpyxl import Workbook
    today = date.today()
    date_to = date_to or today.isoformat()
    date_from = date_from or (today - timedelta(days=30)).isoformat()
    rows = run_query(
        _ibt_suggestions_sql(date_from, date_to, country, 0.2, 1.5, 1000,
                             use_clustering=use_clustering),
        date_to=date_to) or []
    # One batch lookup of the available size run + SKUs per (style, donor store).
    sku_map = {}
    styles = sorted({r.get("style_name") for r in rows if r.get("style_name")})
    if styles:
        style_in = ",".join("'" + _sql_str(x) + "'" for x in styles)
        for m in (run_query(
                "SELECT p.style_name AS style, i.pos_location_name AS store, "
                "string_agg(DISTINCT p.sku, ', ' ORDER BY p.sku) AS skus, "
                "string_agg(DISTINCT p.size, ', ' ORDER BY p.size) AS sizes "
                "FROM all_inventory i JOIN all_products_clean p ON p.sku = i.sku "
                "WHERE i.available > 0 AND p.style_name IN (" + style_in + ") "
                "GROUP BY 1, 2") or []):
            sku_map[(m["style"], m["store"])] = (m.get("skus") or "", m.get("sizes") or "")
    cols = ["Style Name", "Brand", "Subcategory", "From Store", "To Store",
            "SKUs", "Sizes", "Units to Move", "Score",
            "Estimated Uplift (KES)", "Suggested Date"]
    wb = Workbook()
    wb.remove(wb.active)
    groups = {}
    for r in rows:
        groups.setdefault(r.get("from_store") or "Unknown", []).append(r)
    used = set()
    suggested = today.isoformat()
    if not groups:
        ws = wb.create_sheet(_xlsx_sheet_title("No Suggestions", used))
        _xlsx_header(ws, cols)
    for store in sorted(groups):
        ws = wb.create_sheet(_xlsx_sheet_title(store, used))
        _xlsx_header(ws, cols)
        for r in groups[store]:
            skus, sizes = sku_map.get((r.get("style_name"), store), ("", ""))
            ws.append([
                r.get("style_name"), r.get("brand"), r.get("subcategory"),
                store, r.get("to_store"), skus, sizes,
                int(r.get("units_to_move") or 0), int(r.get("score") or 0),
                float(r.get("estimated_uplift") or 0), suggested,
            ])
    return _xlsx_response(wb, f"IBT_Operations_{today.isoformat()}.xlsx")


def _replen_export_rows(country, channel):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    ch = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    ch_inv = (" AND i.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    return run_query(f"""
        WITH sold AS (
            SELECT s.pos_location_name, s.variant_sku,
                MAX(s.country) AS country, MAX(s.product_title) AS product_name,
                SUM(s.net_quantity) AS units_sold
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '30 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND s.pos_location_name NOT ILIKE '%online%'
              AND s.variant_sku IS NOT NULL AND s.variant_sku <> '' {c_sales}{ch}
            GROUP BY 1, 2 HAVING SUM(s.net_quantity) > 0
        ),
        store_soh AS (
            SELECT i.pos_location_name, i.sku, SUM(i.available) AS soh_store
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS}) {c_inv}{ch_inv}
            GROUP BY 1, 2
        ),
        wh_soh AS (
            SELECT i.sku, SUM(i.available) AS soh_wh
            FROM all_inventory i
            WHERE i.pos_location_name IN ({WAREHOUSE_LOCATIONS})
            GROUP BY 1
        )
        SELECT sold.pos_location_name AS store, sold.country, COALESCE(NULLIF(p.product_name, ''), sold.product_name) AS product_name,
            sold.variant_sku AS sku, p.style_name, p.brand, p.size,
            sold.units_sold,
            COALESCE(ss.soh_store, 0) AS soh_store,
            COALESCE(w.soh_wh, 0) AS soh_wh
        FROM sold
        LEFT JOIN store_soh ss ON ss.pos_location_name = sold.pos_location_name AND ss.sku = sold.variant_sku
        LEFT JOIN wh_soh w ON w.sku = sold.variant_sku
        LEFT JOIN all_products_clean p ON p.sku = sold.variant_sku
        WHERE COALESCE(ss.soh_store, 0) < sold.units_sold AND COALESCE(w.soh_wh, 0) > 0
        ORDER BY sold.pos_location_name, (sold.units_sold - COALESCE(ss.soh_store, 0)) DESC
    """) or []


@app.get("/api/replenishment/export/operations")
def replenishment_export_operations(
    country: str = Query(default=None),
    channel: str = Query(default=None),
):
    from openpyxl import Workbook
    rows = _replen_export_rows(country, channel)
    # Per (store, style) size curve from each line's own size + recommended qty.
    curve = {}
    enriched = []
    for r in rows:
        units = int(r.get("units_sold") or 0)
        soh = int(r.get("soh_store") or 0)
        wh = int(r.get("soh_wh") or 0)
        rec = max(0, min(units - soh, wh))
        store = r.get("store")
        style = r.get("style_name") or r.get("product_name")
        size = (r.get("size") or "").strip()
        if size and rec > 0:
            curve.setdefault((store, style), {})
            curve[(store, style)][size] = curve[(store, style)].get(size, 0) + rec
        enriched.append((r, units, soh, wh, rec, store, style, size))
    cols = ["Store", "Style", "Brand", "SKU", "Current Stock", "Units Sold (30d)",
            "Recommended Qty", "Size Breakdown", "Priority", "Trigger Reason"]
    wb = Workbook()
    wb.remove(wb.active)
    groups = {}
    for tup in enriched:
        groups.setdefault(tup[5] or "Unknown", []).append(tup)
    used = set()
    if not groups:
        ws = wb.create_sheet(_xlsx_sheet_title("No Replenishments", used))
        _xlsx_header(ws, cols)
    for store in sorted(groups):
        ws = wb.create_sheet(_xlsx_sheet_title(store, used))
        _xlsx_header(ws, cols)
        for (r, units, soh, wh, rec, st, style, size) in groups[store]:
            if soh == 0:
                priority = "CRITICAL"
            elif soh < units * 0.5:
                priority = "HIGH"
            else:
                priority = "MEDIUM"
            cur_curve = curve.get((st, style), {})
            curve_str = ", ".join(f"{k}:{v}" for k, v in
                                  sorted(cur_curve.items(), key=lambda kv: _size_sort_key(kv[0])))
            reason = f"Sold {units} in 30d, only {soh} on hand; warehouse has {wh}"
            ws.append([st, style, r.get("brand"), r.get("sku"), soh, units,
                       rec, curve_str, priority, reason])
    return _xlsx_response(wb, f"Replenishment_Operations_{date.today().isoformat()}.xlsx")


# ── Step 6 — chronic stockout snapshots (audit A8) ────────────────────────────
def _ensure_stockout_table():
    _users_exec("""
        CREATE TABLE IF NOT EXISTS stockout_snapshots (
            id BIGSERIAL PRIMARY KEY,
            snapshot_date DATE NOT NULL,
            style_name TEXT NOT NULL,
            brand TEXT,
            subcategory TEXT,
            country TEXT,
            weeks_of_cover NUMERIC,
            at_risk BOOLEAN,
            weekly_units NUMERIC,
            soh_total NUMERIC,
            snapshot_taken_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE(snapshot_date, style_name, country)
        )""")
    _users_exec(
        "CREATE INDEX IF NOT EXISTS idx_stockout_style_country_date "
        "ON stockout_snapshots (style_name, country, snapshot_date DESC)")


@app.on_event("startup")
def _init_stockout_table():
    try:
        _ensure_stockout_table()
    except Exception:
        pass


_STOCKOUT_AT_RISK_WOC = 2.0  # weeks-of-cover threshold below which a style is at risk


@app.post("/api/replenishment/snapshot")
async def replenishment_snapshot(request: Request, force: bool = Query(default=False)):
    # Persist current weeks-of-cover per (style, country). Called daily by the
    # sync job but deduplicated to ~weekly cadence so "consecutive snapshots"
    # ≈ "consecutive weeks" for chronic detection (override with ?force=1).
    from datetime import datetime, timezone
    _ensure_stockout_table()
    eat_today = (datetime.now(timezone.utc) + timedelta(hours=3)).date()
    if not force:
        last = _users_exec(
            "SELECT MAX(snapshot_date) AS d FROM stockout_snapshots", fetch=True) or []
        last_d = last[0].get("d") if last else None
        if last_d and (eat_today - last_d).days < 6:
            return {"ok": True, "skipped": True, "reason": "within weekly window",
                    "last_snapshot_date": last_d.isoformat(), "snapshot_date": eat_today.isoformat()}
    rows = run_query(f"""
        WITH sales AS (
            SELECT p.style_name AS style, s.country AS country,
                MAX(p.brand) AS brand, MAX(p.category) AS subcategory,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
                SUM(s.net_quantity) AS u56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> ''
            GROUP BY 1, 2
        ),
        soh AS (
            SELECT p.style_name AS style, i.country AS country, SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> ''
            GROUP BY 1, 2
        )
        SELECT COALESCE(sa.style, so.style) AS style_name,
            COALESCE(sa.country, so.country) AS country,
            sa.brand, sa.subcategory,
            COALESCE(sa.u28, 0) AS u28, COALESCE(sa.u56, 0) AS u56,
            COALESCE(so.soh, 0) AS soh_total
        FROM sales sa
        FULL OUTER JOIN soh so
            ON so.style = sa.style AND so.country IS NOT DISTINCT FROM sa.country
        WHERE COALESCE(sa.style, so.style) IS NOT NULL
    """) or []
    written = 0
    with _users_tx() as cur:
        for r in rows:
            weekly = _ewma_weekly(r.get("u28"), r.get("u56"))
            if weekly <= 0:
                continue  # only track actively-selling styles
            soh_total = float(r.get("soh_total") or 0)
            woc = round(soh_total / weekly, 2)
            at_risk = woc < _STOCKOUT_AT_RISK_WOC
            cur.execute(
                "INSERT INTO stockout_snapshots "
                "(snapshot_date, style_name, brand, subcategory, country, "
                "weeks_of_cover, at_risk, weekly_units, soh_total) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (snapshot_date, style_name, country) DO UPDATE SET "
                "brand=EXCLUDED.brand, subcategory=EXCLUDED.subcategory, "
                "weeks_of_cover=EXCLUDED.weeks_of_cover, at_risk=EXCLUDED.at_risk, "
                "weekly_units=EXCLUDED.weekly_units, soh_total=EXCLUDED.soh_total, "
                "snapshot_taken_at=now()",
                (eat_today, r.get("style_name"), r.get("brand"), r.get("subcategory"),
                 r.get("country") or "", woc, at_risk, round(weekly, 3), soh_total))
            written += 1
    return {"ok": True, "skipped": False, "snapshot_date": eat_today.isoformat(),
            "rows_written": written, "velocity_method": VELOCITY_METHOD}


@app.get("/api/replenishment/chronic-stockouts")
def replenishment_chronic_stockouts(min_weeks: int = Query(default=3)):
    min_weeks = max(1, int(min_weeks))
    rows = _users_exec(
        "SELECT style_name, country, brand, subcategory, snapshot_date, at_risk, "
        "weekly_units, weeks_of_cover FROM stockout_snapshots "
        "ORDER BY style_name, country, snapshot_date DESC", fetch=True) or []
    groups = {}
    for r in rows:
        groups.setdefault((r["style_name"], r.get("country")), []).append(r)
    out = []
    for (style, country), recs in groups.items():
        run = []
        for r in recs:  # already date-desc within group
            if r.get("at_risk"):
                run.append(r)
            else:
                break
        if len(run) < int(min_weeks):
            continue
        wk = [float(r["weekly_units"]) for r in run if r.get("weekly_units") is not None]
        wc = [float(r["weeks_of_cover"]) for r in run if r.get("weeks_of_cover") is not None]
        out.append({
            "style_name": style, "country": country,
            "brand": run[0].get("brand"), "subcategory": run[0].get("subcategory"),
            "consecutive_at_risk_weeks": len(run),
            "avg_weekly_units": round(sum(wk) / len(wk), 2) if wk else 0,
            "avg_woc": round(sum(wc) / len(wc), 2) if wc else 0,
            "first_flagged_date": run[-1]["snapshot_date"].isoformat(),
        })
    out.sort(key=lambda x: (-x["consecutive_at_risk_weeks"], -x["avg_weekly_units"]))
    return out


# ── Step 7 — 7-day forward predictive stockout alerts (answers Q1) ────────────
@app.get("/api/replenishment/stockout-alerts")
def replenishment_stockout_alerts(
    country: str = Query(default=None),
    channel: str = Query(default=None),
):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    ch = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    ch_inv = (" AND i.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    rows = run_query(f"""
        WITH sales AS (
            SELECT p.style_name AS style, MAX(p.brand) AS brand, MAX(p.category) AS subcategory,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '14 days')::text) AS u14,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
                SUM(s.net_quantity) AS u56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_sales}{ch}
            GROUP BY 1
        ),
        store_soh AS (
            SELECT p.style_name AS style,
                string_agg(DISTINCT i.pos_location_name, ', ') AS stores,
                SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND i.available > 0 AND COALESCE(p.style_name,'') <> '' {c_inv}{ch_inv}
            GROUP BY 1
        ),
        wh AS (
            SELECT p.style_name AS style, SUM(i.available) AS wh_soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> ''
            GROUP BY 1
        )
        SELECT sa.style AS style_name, sa.brand, sa.subcategory,
            COALESCE(sa.u14, 0) AS u14,
            COALESCE(sa.u28, 0) AS u28, COALESCE(sa.u56, 0) AS u56,
            COALESCE(ss.soh, 0) AS total_soh,
            COALESCE(ss.stores, '') AS affected_stores,
            COALESCE(wh.wh_soh, 0) AS warehouse_stock
        FROM sales sa
        LEFT JOIN store_soh ss ON ss.style = sa.style
        LEFT JOIN wh ON wh.style = sa.style
    """) or []
    alerts = []
    today = date.today()
    for r in rows:
        weekly = _ewma_weekly(r.get("u28"), r.get("u56"))
        if weekly <= 0:
            continue
        total_soh = int(r.get("total_soh") or 0)
        woc = total_soh / weekly
        if woc >= 2.0:
            continue
        wh = int(r.get("warehouse_stock") or 0)
        if wh > 0:
            action = "IBT from warehouse"
        elif total_soh <= 0:
            action = "No stock available"
        else:
            action = "Replenish from production"
        # Velocity trend = last 2 weeks vs the prior 2 weeks (units). Confidence
        # reflects how stable that signal is: a flat/steady run is high-confidence,
        # an erratic spike-from-zero is low-confidence.
        u14 = float(r.get("u14") or 0)
        prior2 = max(float(r.get("u28") or 0) - u14, 0.0)
        if prior2 <= 0:
            velocity_trend = "accelerating" if u14 > 0 else "stable"
            confidence = "low"
        elif u14 > prior2 * 1.2:
            velocity_trend, confidence = "accelerating", "medium"
        elif u14 < prior2 * 0.8:
            velocity_trend, confidence = "decelerating", "medium"
        else:
            velocity_trend, confidence = "stable", "high"
        days_until = round(woc * 7.0, 1)
        proj = today + timedelta(days=int(round(woc * 7.0)))
        order_by = proj - timedelta(days=int(round(LEAD_TIME_WEEKS * 7.0)))
        alerts.append({
            "style_name": r.get("style_name"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"),
            "affected_stores": r.get("affected_stores") or "",
            "total_soh": total_soh, "weekly_units": round(weekly, 2),
            "weeks_of_cover": round(woc, 2),
            "days_until_stockout": days_until,
            "warehouse_stock_available": wh > 0,
            "warehouse_stock": wh,
            "urgency": "CRITICAL" if woc < 1.0 else "WARNING",
            "velocity_trend": velocity_trend,
            "confidence": confidence,
            "projected_stockout_date": proj.isoformat(),
            "recommended_order_date": order_by.isoformat(),
            "recommended_action": action,
        })
    alerts.sort(key=lambda x: x["days_until_stockout"])
    return {
        "alerts": alerts,
        "critical_count": sum(1 for a in alerts if a["urgency"] == "CRITICAL"),
        "warning_count": sum(1 for a in alerts if a["urgency"] == "WARNING"),
        "total": len(alerts),
        "velocity_method": VELOCITY_METHOD,
    }


# ── Step 8 — store understocking vs cluster peers (answers Q9) ─────────────────
@app.get("/api/analytics/store-potential")
def analytics_store_potential(country: str = Query(default=None)):
    import statistics
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    rows = run_query(f"""
        WITH rev AS (
            SELECT s.pos_location_name AS store, MAX(s.country) AS country,
                SUM(s.net_sales_kes::numeric) AS rev90,
                SUM(s.net_quantity) AS units90
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND s.pos_location_name NOT ILIKE '%online%' {c_sales}
            GROUP BY 1
        ),
        firsts AS (
            SELECT s.pos_location_name AS store, MIN(s.sale_date) AS first_sale
            FROM all_sales s
            WHERE s.sale_kind IN ('sale','order')
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
            GROUP BY 1
        ),
        inv AS (
            SELECT i.pos_location_name AS store, SUM(i.available) AS soh
            FROM all_inventory i
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS}) {c_inv}
            GROUP BY 1
        ),
        ff AS (
            SELECT """ + ff_canon_sql() + """ AS store,
                SUM(f.a01_footfall_in) AS footfall,
                AVG(NULLIF(f.b06_sales_conversion, 0)) AS conversion
            FROM footfall f
            WHERE f.time::date >= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY 1
        )
        SELECT rev.store, rev.country, rev.rev90, rev.units90,
            firsts.first_sale,
            COALESCE(inv.soh, 0) AS soh,
            COALESCE(ff.footfall, 0) AS footfall, ff.conversion
        FROM rev
        LEFT JOIN firsts ON firsts.store = rev.store
        LEFT JOIN inv ON inv.store = rev.store
        LEFT JOIN ff ON ff.store = rev.store
        WHERE rev.rev90 > 0
        ORDER BY rev.rev90 DESC
    """) or []
    n = len(rows)
    if n == 0:
        return {"stores": [], "clusters": {}}
    # NTILE(3) by revenue desc: top third = cluster A, middle = B, bottom = C.
    for i, r in enumerate(rows):
        third = i * 3 // n
        r["_cluster"] = "A" if third == 0 else ("B" if third == 1 else "C")
    by_cluster = {}
    for r in rows:
        by_cluster.setdefault(r["_cluster"], []).append(r)
    cluster_meta = {}
    for cl, members in by_cluster.items():
        revs = [float(m["rev90"] or 0) for m in members]
        sohs = [float(m["soh"] or 0) for m in members]
        ffs = [float(m["footfall"] or 0) for m in members]
        convs = [float(m["conversion"]) for m in members if m.get("conversion") is not None]
        cluster_meta[cl] = {
            "median_revenue": statistics.median(revs) if revs else 0,
            "median_soh": statistics.median(sohs) if sohs else 0,
            "median_footfall": statistics.median(ffs) if ffs else 0,
            "median_conversion": statistics.median(convs) if convs else 0,
            "stores": len(members),
        }
    today = date.today()
    out = []
    for r in rows:
        cl = r["_cluster"]
        meta = cluster_meta[cl]
        rev90 = float(r["rev90"] or 0)
        median = meta["median_revenue"] or 0
        pct = round(100.0 * rev90 / median, 1) if median else 100.0
        understocked = pct < 70.0
        gap = round(max(0.0, median - rev90))
        # Likely cause: a brand-new store first, else the metric most deficient
        # vs its cluster peers (stock / footfall / conversion).
        cause = None
        if understocked:
            new_store = False
            fs = r.get("first_sale")
            if fs:
                try:
                    new_store = (today - date.fromisoformat(str(fs)[:10])).days <= 120
                except ValueError:
                    new_store = False
            if new_store:
                cause = "new_store"
            else:
                ratios = {}
                if meta["median_soh"]:
                    ratios["low_stock"] = float(r["soh"] or 0) / meta["median_soh"]
                if meta["median_footfall"]:
                    ratios["low_footfall"] = float(r["footfall"] or 0) / meta["median_footfall"]
                if meta["median_conversion"] and r.get("conversion") is not None:
                    ratios["low_conversion"] = float(r["conversion"]) / meta["median_conversion"]
                cause = min(ratios, key=ratios.get) if ratios else "low_stock"
        out.append({
            "store": r["store"], "country": r.get("country"), "cluster": cl,
            "actual_revenue_90d": round(rev90),
            "cluster_median_revenue": round(median),
            "pct_of_potential": pct,
            "gap_kes": gap,
            "units_90d": int(r.get("units90") or 0),
            "store_soh": int(r.get("soh") or 0),
            "footfall_90d": int(r.get("footfall") or 0),
            "conversion_rate": round(float(r["conversion"]), 1) if r.get("conversion") is not None else None,
            "understocked": understocked,
            "likely_cause": cause,
        })
    out.sort(key=lambda x: x["pct_of_potential"])
    return {
        "stores": out,
        "clusters": {cl: {
            "median_revenue": round(m["median_revenue"]),
            "stores": m["stores"],
        } for cl, m in cluster_meta.items()},
        "understocked_count": sum(1 for s in out if s["understocked"]),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Phase 4 — advanced analytics: IBT ROI dashboards, forecast/velocity
# calibration, trend detection, replenishment ROI, size-gap intelligence,
# markdown/clearance planning, buying plan + size-ratio targets, and a
# data-quality monitor. All read-only BI aggregation against live Postgres
# (sale_date is TEXT → explicit ::date casts), reusing the same recency-weighted
# EWMA weekly velocity proxy as Phase 3. ibt_completions / recommendation_actions
# may be empty, so every endpoint returns a valid (possibly empty) structure.
# ══════════════════════════════════════════════════════════════════════════════
LEAD_TIME_WEEKS = 4.0   # Vivo in-house production / inbound lead time (audit A2)
SAFETY_WEEKS = 1.0      # safety-stock buffer on top of lead time (audit A2)

# A "data source" is one upstream feed; in all_sales it is identified by store_id.
_SOURCE_BY_STORE_ID = {
    "vivofashiongroup": "Odoo",
    "vivowoman": "Shopify Kenya",
    "vivo-uganda": "Uganda",
    "vivo-rwanda": "Rwanda",
    "shop-zetu": "Shop Zetu",
}


def _store_cluster_map(country=None):
    """store -> 'A'/'B'/'C' by trailing-90d net revenue (NTILE3, A = top third)."""
    c = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    rows = run_query(f"""
        SELECT s.pos_location_name AS store, SUM(s.net_sales_kes::numeric) AS rev90
        FROM all_sales s
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND s.pos_location_name NOT ILIKE '%online%' {c}
        GROUP BY 1 HAVING SUM(s.net_sales_kes::numeric) > 0
        ORDER BY rev90 DESC
    """) or []
    n = len(rows)
    out = {}
    for i, r in enumerate(rows):
        third = (i * 3 // n) if n else 0
        out[r["store"]] = "A" if third == 0 else ("B" if third == 1 else "C")
    return out


def _store_country_map():
    rows = run_query(
        "SELECT pos_location_name AS store, MAX(country) AS country "
        "FROM all_sales WHERE pos_location_name IS NOT NULL GROUP BY 1") or []
    return {r["store"]: r.get("country") for r in rows}


def _trend_bucket(recent, prior):
    """Classify a 4wk-vs-prior-4wk velocity change into a named bucket + pct."""
    recent = float(recent or 0)
    prior = float(prior or 0)
    if prior <= 0:
        return ("SURGING", None) if recent > 0 else ("STABLE", 0.0)
    chg = (recent - prior) / prior
    pct = round(100.0 * chg, 1)
    if chg > 0.5:
        return "SURGING", pct
    if chg > 0.2:
        return "GROWING", pct
    if chg < -0.5:
        return "DYING", pct
    if chg < -0.2:
        return "DECLINING", pct
    return "STABLE", pct


# ── Step 1 — IBT ROI dashboards (audit B2 / Q4) ───────────────────────────────
def _ibt_roi_rows(date_from, date_to):
    """Per completed IBT (transfer_date in window): units moved, units sold &
    revenue at the destination in 30/60 days, plus the destination's cluster and
    country. ASP is the chain's trailing-90d net price for the style."""
    rows = run_query(f"""
        WITH comp AS (
            SELECT c.id, c.style_name, c.brand, c.subcategory, c.from_store,
                c.to_store, c.flow, c.actual_units_moved, c.transfer_date
            FROM ibt_completions c
            WHERE c.transfer_date IS NOT NULL
              AND c.transfer_date BETWEEN '{_sql_str(date_from)}' AND '{_sql_str(date_to)}'
        ),
        asp AS (
            SELECT p.style_name AS style,
                SUM(s.net_sales_kes::numeric) / NULLIF(SUM(s.net_quantity), 0) AS asp
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order') AND s.net_quantity > 0
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
            GROUP BY 1
        )
        SELECT comp.id, comp.style_name, comp.brand, comp.subcategory,
            comp.from_store, comp.to_store, comp.flow, comp.actual_units_moved,
            comp.transfer_date,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date BETWEEN comp.transfer_date AND comp.transfer_date + 30
                  AND s.pos_location_name = comp.to_store), 0) AS sold_30d,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date BETWEEN comp.transfer_date AND comp.transfer_date + 60
                  AND s.pos_location_name = comp.to_store), 0) AS sold_60d,
            COALESCE(SUM(s.net_sales_kes::numeric) FILTER (
                WHERE s.sale_date::date BETWEEN comp.transfer_date AND comp.transfer_date + 30
                  AND s.pos_location_name = comp.to_store), 0) AS revenue_30d,
            MAX(a.asp) AS asp
        FROM comp
        LEFT JOIN all_products_clean p ON p.style_name = comp.style_name
        LEFT JOIN all_sales s ON s.variant_sku = p.sku AND s.sale_kind IN ('sale','order')
        LEFT JOIN asp a ON a.style = comp.style_name
        GROUP BY comp.id, comp.style_name, comp.brand, comp.subcategory,
            comp.from_store, comp.to_store, comp.flow, comp.actual_units_moved,
            comp.transfer_date
    """, date_to=date_to) or []
    clusters = _store_cluster_map()
    countries = _store_country_map()
    out = []
    for r in rows:
        units = int(r.get("actual_units_moved") or 0)
        s30 = int(r.get("sold_30d") or 0)
        s60 = int(r.get("sold_60d") or 0)
        asp = float(r["asp"]) if r.get("asp") is not None else 0.0
        out.append({
            "style_name": r.get("style_name"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"), "from_store": r.get("from_store"),
            "to_store": r.get("to_store"), "flow": r.get("flow"),
            "units": units, "sold_30d": s30, "sold_60d": s60,
            "revenue_30d": float(r.get("revenue_30d") or 0),
            "sell_through_30d": round(100.0 * s30 / units, 1) if units else 0.0,
            "sell_through_60d": round(100.0 * s60 / units, 1) if units else 0.0,
            "estimated_uplift": round(units * asp, 2),
            "cluster": clusters.get(r.get("to_store")),
            "country": countries.get(r.get("to_store")),
            "transfer_date": r["transfer_date"].isoformat() if r.get("transfer_date") else None,
        })
    return out


def _ibt_flow_key(flow):
    return "warehouse_to_store" if (flow and "warehouse" in str(flow).lower()) else "store_to_store"


def _roi_group(items):
    n = len(items)
    u = sum(i["units"] for i in items)
    st = [i["sell_through_30d"] for i in items if i["units"] > 0]
    return {"transfers": n, "units": u,
            "avg_sell_through_30d": round(sum(st) / len(st), 1) if st else 0.0}


def _ibt_roi_default_window(date_from, date_to):
    today = date.today()
    return (date_from or (today - timedelta(days=180)).isoformat(),
            date_to or today.isoformat())


@app.get("/api/ibt/roi-dashboard")
def ibt_roi_dashboard(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
):
    date_from, date_to = _ibt_roi_default_window(date_from, date_to)
    rows = _ibt_roi_rows(date_from, date_to)
    units = sum(r["units"] for r in rows)
    uplift = sum(r["estimated_uplift"] for r in rows)
    revenue = sum(r["revenue_30d"] for r in rows)
    st30 = [r["sell_through_30d"] for r in rows if r["units"] > 0]
    flows = {"store_to_store": [], "warehouse_to_store": []}
    for r in rows:
        flows[_ibt_flow_key(r["flow"])].append(r)
    clusters = {"A": [], "B": [], "C": []}
    for r in rows:
        if r.get("cluster") in clusters:
            clusters[r["cluster"]].append(r)
    routes = {}
    for r in rows:
        routes.setdefault((r["from_store"], r["to_store"]), []).append(r)
    route_list = [{"from_store": k[0], "to_store": k[1],
                   "transfers": len(v), "avg_sell_through_30d": _roi_group(v)["avg_sell_through_30d"]}
                  for k, v in routes.items()]
    subs = {}
    for r in rows:
        subs.setdefault(r["subcategory"] or "Unknown", []).append(r)
    sub_list = [{"subcategory": k, "transfers": len(v),
                 "avg_sell_through_30d": _roi_group(v)["avg_sell_through_30d"]}
                for k, v in subs.items()]
    return {
        "period": {"from": date_from, "to": date_to},
        "total_transfers_completed": len(rows),
        "total_units_moved": units,
        "total_estimated_uplift_kes": round(uplift),
        "total_actual_revenue_kes": round(revenue),
        "roi_multiple": round(revenue / uplift, 2) if uplift else 0.0,
        "avg_sell_through_30d": round(sum(st30) / len(st30), 1) if st30 else 0.0,
        "by_flow": {k: _roi_group(v) for k, v in flows.items()},
        "by_cluster": {k: _roi_group(v) for k, v in clusters.items()},
        "best_routes": sorted(route_list, key=lambda x: x["avg_sell_through_30d"], reverse=True)[:10],
        "worst_routes": sorted(route_list, key=lambda x: x["avg_sell_through_30d"])[:10],
        "best_subcategories": sorted(sub_list, key=lambda x: x["avg_sell_through_30d"], reverse=True)[:10],
        "worst_subcategories": sorted(sub_list, key=lambda x: x["avg_sell_through_30d"])[:10],
        "velocity_method": VELOCITY_METHOD,
    }


@app.get("/api/ibt/roi-by-store")
def ibt_roi_by_store(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
):
    date_from, date_to = _ibt_roi_default_window(date_from, date_to)
    rows = _ibt_roi_rows(date_from, date_to)
    if country:
        rows = [r for r in rows if r["country"] == country]
    by = {}
    for r in rows:
        by.setdefault(r["to_store"], []).append(r)
    out = []
    for store, items in by.items():
        u = sum(i["units"] for i in items)
        s30 = sum(i["sold_30d"] for i in items)
        s60 = sum(i["sold_60d"] for i in items)
        rev = sum(i["revenue_30d"] for i in items)
        days = [30.0 * i["units"] / i["sold_30d"] for i in items if i["sold_30d"] > 0 and i["units"] > 0]
        out.append({
            "store": store, "country": items[0].get("country"),
            "cluster": items[0].get("cluster"),
            "transfers_received": len(items), "units_received": u,
            "sold_30d": s30, "sold_60d": s60,
            "sell_through_30d": round(100.0 * s30 / u, 1) if u else 0.0,
            "sell_through_60d": round(100.0 * s60 / u, 1) if u else 0.0,
            "revenue_generated_kes": round(rev),
            "avg_days_to_sell": round(sum(days) / len(days), 1) if days else None,
        })
    out.sort(key=lambda x: x["sell_through_30d"], reverse=True)
    return {"stores": out, "total": len(out),
            "period": {"from": date_from, "to": date_to}}


@app.get("/api/ibt/roi-by-category")
def ibt_roi_by_category(
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
    country:   str = Query(default=None),
):
    date_from, date_to = _ibt_roi_default_window(date_from, date_to)
    rows = _ibt_roi_rows(date_from, date_to)
    if country:
        rows = [r for r in rows if r["country"] == country]
    by = {}
    for r in rows:
        by.setdefault(r["subcategory"] or "Unknown", []).append(r)
    out = []
    for sub, items in by.items():
        u = sum(i["units"] for i in items)
        s30 = sum(i["sold_30d"] for i in items)
        rev = sum(i["revenue_30d"] for i in items)
        uplift = sum(i["estimated_uplift"] for i in items)
        out.append({
            "subcategory": sub, "transfers": len(items), "units_moved": u,
            "sold_30d": s30,
            "sell_through_30d": round(100.0 * s30 / u, 1) if u else 0.0,
            "revenue_generated_kes": round(rev),
            "estimated_uplift_kes": round(uplift),
            "roi_multiple": round(rev / uplift, 2) if uplift else 0.0,
        })
    out.sort(key=lambda x: x["revenue_generated_kes"], reverse=True)
    return {"categories": out, "total": len(out),
            "period": {"from": date_from, "to": date_to}}


# ── Step 2 — forecast accuracy + velocity calibration (audit B1) ──────────────
@app.get("/api/replenishment/forecast-accuracy")
def replenishment_forecast_accuracy():
    # Compare each completed replenishment's recommended quantity (actual_units)
    # against what actually sold at that store in the 28 days after the action.
    rows = _users_exec("""
        WITH acts AS (
            SELECT rec_key, actual_units, acted_at,
                split_part(rec_key, '|', 1) AS store,
                split_part(rec_key, '|', 2) AS kind,
                split_part(rec_key, '|', 3) AS val
            FROM recommendation_actions
            WHERE rec_type = 'replenish' AND status = 'done'
              AND actual_units > 0 AND acted_at IS NOT NULL
        )
        SELECT a.rec_key, a.store, a.actual_units, a.acted_at,
            to_char(a.acted_at, 'YYYY-MM') AS month,
            MAX(p.style_name) AS style_name, MAX(p.brand) AS brand,
            MAX(p.product_type) AS subcategory,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date BETWEEN a.acted_at::date AND a.acted_at::date + 28), 0) AS sold_28d
        FROM acts a
        LEFT JOIN all_products_clean p
            ON (a.kind = 'sku' AND p.sku = a.val)
            OR (a.kind = 'barcode' AND p.barcode = a.val)
        LEFT JOIN all_sales s ON s.variant_sku = p.sku
            AND s.pos_location_name = a.store AND s.sale_kind IN ('sale','order')
        GROUP BY a.rec_key, a.store, a.actual_units, a.acted_at
    """, fetch=True) or []
    items = []
    abs_pct = []
    for r in rows:
        rec = int(r.get("actual_units") or 0)
        sold = int(r.get("sold_28d") or 0)
        bias = sold - rec
        items.append({
            "store": r.get("store"), "style_name": r.get("style_name"),
            "brand": r.get("brand"), "subcategory": r.get("subcategory"),
            "month": r.get("month"), "recommended": rec, "actual_sold_28d": sold,
            "bias": bias,
            "accuracy_pct": round(100.0 * sold / rec, 1) if rec else 0.0,
            "direction": "under_replenished" if bias > 0 else ("over_replenished" if bias < 0 else "on_target"),
        })
        if rec:
            abs_pct.append(abs(rec - sold) * 100.0 / rec)

    def _agg(key):
        g = {}
        for it in items:
            g.setdefault(it[key] or "Unknown", []).append(it)
        res = []
        for k, v in g.items():
            ap = [abs(i["recommended"] - i["actual_sold_28d"]) * 100.0 / i["recommended"]
                  for i in v if i["recommended"]]
            res.append({key: k, "evaluated": len(v),
                        "mape": round(sum(ap) / len(ap), 1) if ap else 0.0,
                        "avg_bias": round(sum(i["bias"] for i in v) / len(v), 1)})
        return sorted(res, key=lambda x: x["mape"], reverse=True)

    by_month = sorted(_agg("month"), key=lambda x: x["month"])
    trend = None
    if len(by_month) >= 2:
        first, last = by_month[0]["mape"], by_month[-1]["mape"]
        trend = {"first_month": by_month[0]["month"], "last_month": by_month[-1]["month"],
                 "first_mape": first, "last_mape": last,
                 "direction": "improving" if last < first else ("worsening" if last > first else "flat")}
    return {
        "evaluated": len(items),
        "mape": round(sum(abs_pct) / len(abs_pct), 1) if abs_pct else 0.0,
        "by_store": _agg("store"),
        "by_subcategory": _agg("subcategory"),
        "by_brand": _agg("brand"),
        "by_month": by_month,
        "trend": trend,
        "items": items,
    }


@app.get("/api/replenishment/velocity-calibration")
def replenishment_velocity_calibration(threshold_pct: float = Query(default=30.0)):
    # Predict each style's weekly velocity from the EWMA of an OLDER window
    # (weeks 5-12 ago), then compare to what actually sold in the most recent 4
    # weeks. Surfaces styles whose run-rate proxy is systematically off.
    rows = run_query(f"""
        SELECT p.style_name AS style, MAX(p.brand) AS brand,
            MAX(p.product_type) AS subcategory,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
                  AND s.sale_date::date < CURRENT_DATE - INTERVAL '28 days'), 0) AS old28,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '84 days'
                  AND s.sale_date::date < CURRENT_DATE - INTERVAL '28 days'), 0) AS old56,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '28 days'), 0) AS actual28
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND COALESCE(p.style_name,'') <> ''
        GROUP BY 1
        HAVING SUM(s.net_quantity) > 0
    """) or []
    out = []
    under = over = 0
    errs = []
    for r in rows:
        predicted = _ewma_weekly(r.get("old28"), r.get("old56"))
        actual = float(r.get("actual28") or 0) / 4.0
        if predicted <= 0 and actual <= 0:
            continue
        err = round(100.0 * (actual - predicted) / predicted, 1) if predicted > 0 else None
        direction = "calibrated"
        if actual > predicted:
            direction = "under_predicting"
            under += 1
        elif actual < predicted:
            direction = "over_predicting"
            over += 1
        if err is not None:
            errs.append(abs(err))
        out.append({
            "style_name": r.get("style"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"),
            "predicted_weekly": round(predicted, 2),
            "actual_weekly_next4wk": round(actual, 2),
            "calibration_error_pct": err, "direction": direction,
            "flagged": err is not None and abs(err) > threshold_pct,
        })
    out.sort(key=lambda x: abs(x["calibration_error_pct"]) if x["calibration_error_pct"] is not None else -1, reverse=True)
    return {
        "styles": out, "evaluated": len(out),
        "mean_abs_error_pct": round(sum(errs) / len(errs), 1) if errs else 0.0,
        "under_predicting": under, "over_predicting": over,
        "flagged_count": sum(1 for s in out if s["flagged"]),
        "velocity_method": VELOCITY_METHOD,
    }


# ── Step 3 — velocity trend analysis (stockout-alerts trend fields above) ─────
@app.get("/api/replenishment/trend-analysis")
def replenishment_trend_analysis(
    country: str = Query(default=None),
    channel: str = Query(default=None),
):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    ch = (" AND s.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    ch_inv = (" AND i.pos_location_name IN (" + csv_to_sql(channel) + ")") if channel else ""
    rows = run_query(f"""
        WITH sales AS (
            SELECT p.style_name AS style, MAX(p.brand) AS brand,
                MAX(p.product_type) AS subcategory,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
                SUM(s.net_quantity) AS u56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_sales}{ch}
            GROUP BY 1
        ),
        soh AS (
            SELECT p.style_name AS style, SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_inv}{ch_inv}
            GROUP BY 1
        )
        SELECT sa.style AS style_name, sa.brand, sa.subcategory,
            COALESCE(sa.u28, 0) AS u28, COALESCE(sa.u56, 0) AS u56,
            COALESCE(so.soh, 0) AS soh
        FROM sales sa LEFT JOIN soh so ON so.style = sa.style
    """) or []
    distribution = {"SURGING": 0, "GROWING": 0, "STABLE": 0, "DECLINING": 0, "DYING": 0}
    out = []
    for r in rows:
        u28 = int(r.get("u28") or 0)
        u56 = int(r.get("u56") or 0)
        if u56 <= 0:
            continue
        recent = u28
        prior = max(u56 - u28, 0)
        bucket, pct = _trend_bucket(recent, prior)
        weekly = _ewma_weekly(u28, u56)
        soh = int(r.get("soh") or 0)
        woc = round(soh / weekly, 2) if weekly > 0 else None
        action = "hold"
        if bucket == "SURGING" and woc is not None and woc < 4:
            action = "urgent_replenish"
        elif bucket == "GROWING" and woc is not None and woc < 4:
            action = "replenish"
        elif bucket == "DYING" and woc is not None and woc > 16:
            action = "markdown"
        elif bucket == "DECLINING" and woc is not None and woc > 16:
            action = "monitor_markdown"
        distribution[bucket] += 1
        out.append({
            "style_name": r.get("style_name"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"), "trend_bucket": bucket,
            "velocity_change_pct": pct, "weekly_units": round(weekly, 2),
            "current_woc": woc, "store_soh": soh,
            "action_recommended": action,
        })
    out.sort(key=lambda x: (x["velocity_change_pct"] if x["velocity_change_pct"] is not None else 9e9), reverse=True)
    return {"distribution": distribution, "styles": out, "total": len(out),
            "velocity_method": VELOCITY_METHOD}


# ── Step 4 — replenishment ROI (incremental revenue, audit B2) ────────────────
@app.get("/api/replenishment/roi")
def replenishment_roi():
    rows = _users_exec("""
        WITH acts AS (
            SELECT rec_key, actual_units, acted_at,
                split_part(rec_key, '|', 1) AS store,
                split_part(rec_key, '|', 2) AS kind,
                split_part(rec_key, '|', 3) AS val
            FROM recommendation_actions
            WHERE rec_type = 'replenish' AND status = 'done'
              AND actual_units > 0 AND acted_at IS NOT NULL
        )
        SELECT a.rec_key, a.store, a.actual_units, a.acted_at,
            MAX(p.style_name) AS style_name, MAX(p.brand) AS brand,
            COALESCE(SUM(s.net_sales_kes::numeric) FILTER (
                WHERE s.sale_date::date >= a.acted_at::date - 28
                  AND s.sale_date::date < a.acted_at::date), 0) AS pre_rev,
            COALESCE(SUM(s.net_sales_kes::numeric) FILTER (
                WHERE s.sale_date::date >= a.acted_at::date
                  AND s.sale_date::date < a.acted_at::date + 28), 0) AS post_rev,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date >= a.acted_at::date - 28
                  AND s.sale_date::date < a.acted_at::date), 0) AS pre_units,
            COALESCE(SUM(s.net_quantity) FILTER (
                WHERE s.sale_date::date >= a.acted_at::date
                  AND s.sale_date::date < a.acted_at::date + 28), 0) AS post_units
        FROM acts a
        LEFT JOIN all_products_clean p
            ON (a.kind = 'sku' AND p.sku = a.val)
            OR (a.kind = 'barcode' AND p.barcode = a.val)
        LEFT JOIN all_sales s ON s.variant_sku = p.sku
            AND s.pos_location_name = a.store AND s.sale_kind IN ('sale','order')
        GROUP BY a.rec_key, a.store, a.actual_units, a.acted_at
    """, fetch=True) or []
    items = []
    total_incr = 0.0
    pos = neg = 0
    for r in rows:
        pre = float(r.get("pre_rev") or 0)
        post = float(r.get("post_rev") or 0)
        pre_u = int(r.get("pre_units") or 0)
        post_u = int(r.get("post_units") or 0)
        incr = round(post - pre)
        days_avoided = round(max(0, post_u - pre_u) / (post_u / 28.0), 1) if post_u > 0 else 0.0
        if incr > 0:
            pos += 1
        elif incr < 0:
            neg += 1
        total_incr += incr
        items.append({
            "store": r.get("store"), "style_name": r.get("style_name"),
            "brand": r.get("brand"),
            "pre_replenish_weekly_revenue": round(pre / 4.0),
            "post_replenish_weekly_revenue": round(post / 4.0),
            "incremental_revenue_kes": incr,
            "stockout_days_avoided": days_avoided,
        })
    items.sort(key=lambda x: x["incremental_revenue_kes"], reverse=True)
    return {
        "evaluated": len(items),
        "total_incremental_revenue_kes": round(total_incr),
        "positive_count": pos, "negative_count": neg,
        "items": items,
    }


# ── Step 5 — size-gap intelligence (audit A3 / Q6) ────────────────────────────
@app.get("/api/analytics/size-gaps")
def analytics_size_gaps(country: str = Query(default=None)):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    demand = run_query(f"""
        SELECT p.style_name AS style, NULLIF(TRIM(p.size), '') AS size,
            SUM(s.net_quantity) AS u, SUM(s.net_sales_kes::numeric) AS rev
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '30 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.style_name,'') <> '' {c_sales}
        GROUP BY 1, 2 HAVING SUM(s.net_quantity) > 3
    """) or []
    instock = run_query(f"""
        SELECT i.pos_location_name AS store, p.style_name AS style,
            NULLIF(TRIM(p.size), '') AS size, SUM(i.available) AS a
        FROM all_inventory i
        JOIN all_products_clean p ON p.sku = i.sku
        WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND i.available > 0 AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.style_name,'') <> '' {c_inv}
        GROUP BY 1, 2, 3
    """) or []
    active = run_query(f"""
        SELECT s.pos_location_name AS store, p.style_name AS style
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '30 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND s.pos_location_name NOT ILIKE '%online%'
          AND COALESCE(p.style_name,'') <> '' {c_sales}
        GROUP BY 1, 2 HAVING SUM(s.net_quantity) > 0
    """) or []
    instock_set = {(r["store"], r["style"], r["size"]) for r in instock}
    source_map = {}
    for r in instock:
        source_map.setdefault((r["style"], r["size"]), []).append(r["store"])
    demand_by_style = {}
    size_units = {}
    size_rev = {}
    for r in demand:
        demand_by_style.setdefault(r["style"], []).append(r["size"])
        size_units[(r["style"], r["size"])] = float(r.get("u") or 0)
        size_rev[(r["style"], r["size"])] = float(r.get("rev") or 0)
    n_active = {}
    for r in active:
        n_active[r["style"]] = n_active.get(r["style"], 0) + 1
    out = []
    for r in active:
        store, style = r["store"], r["style"]
        dsizes = demand_by_style.get(style, [])
        missing = [sz for sz in dsizes if (store, style, sz) not in instock_set]
        if not missing:
            continue
        chain_demand = sum(int(size_units.get((style, sz), 0)) for sz in missing)
        nact = max(1, n_active.get(style, 1))
        lost = sum(size_rev.get((style, sz), 0) for sz in missing) / nact
        sources = sorted({st for sz in missing for st in source_map.get((style, sz), []) if st != store})
        out.append({
            "store": store, "style_name": style,
            "missing_sizes": sorted(missing, key=_size_sort_key),
            "chain_demand_for_missing": chain_demand,
            "estimated_lost_sales_kes": round(lost),
            "source_stores_with_stock": sources[:8],
        })
    out.sort(key=lambda x: x["estimated_lost_sales_kes"], reverse=True)
    return {"gaps": out, "total": len(out),
            "stores_with_gaps": len({x["store"] for x in out})}


@app.get("/api/analytics/size-run-health")
def analytics_size_run_health(country: str = Query(default=None)):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    selling = run_query(f"""
        SELECT p.style_name AS style, NULLIF(TRIM(p.size), '') AS size
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.style_name,'') <> '' {c_sales}
        GROUP BY 1, 2 HAVING SUM(s.net_quantity) > 0
    """) or []
    instock = run_query(f"""
        SELECT i.pos_location_name AS store, p.style_name AS style,
            NULLIF(TRIM(p.size), '') AS size
        FROM all_inventory i
        JOIN all_products_clean p ON p.sku = i.sku
        WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND i.available > 0 AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.style_name,'') <> '' {c_inv}
        GROUP BY 1, 2, 3
    """) or []
    active = run_query(f"""
        SELECT s.pos_location_name AS store, p.style_name AS style
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND s.pos_location_name NOT ILIKE '%online%'
          AND COALESCE(p.style_name,'') <> '' {c_sales}
        GROUP BY 1, 2 HAVING SUM(s.net_quantity) > 0
    """) or []
    selling_sizes = {}
    for r in selling:
        selling_sizes.setdefault(r["style"], set()).add(r["size"])
    instock_set = {(r["store"], r["style"], r["size"]) for r in instock}
    stores = {}
    for r in active:
        store, style = r["store"], r["style"]
        ss = selling_sizes.get(style)
        if not ss:
            continue
        in_stock = sum(1 for sz in ss if (store, style, sz) in instock_set)
        health = 100.0 * in_stock / len(ss)
        acc = stores.setdefault(store, {"healths": [], "broken": 0, "full": 0})
        acc["healths"].append(health)
        if health >= 100.0:
            acc["full"] += 1
        else:
            acc["broken"] += 1
    out = []
    for store, acc in stores.items():
        h = acc["healths"]
        out.append({
            "store": store,
            "avg_size_run_health_pct": round(sum(h) / len(h), 1) if h else 0.0,
            "styles_evaluated": len(h),
            "styles_with_broken_runs": acc["broken"],
            "styles_fully_stocked": acc["full"],
        })
    out.sort(key=lambda x: x["avg_size_run_health_pct"])
    return {"stores": out, "total": len(out),
            "health_trend_vs_30d": None,
            "note": "Per-store size-run history is not retained in stockout_snapshots (style/country grain only), so a 30-day trend is not available yet."}


# ── Step 6 — markdown candidates + clearance plan (audit A7 / Q8) ─────────────
@app.get("/api/analytics/markdown-candidates")
def analytics_markdown_candidates(country: str = Query(default=None)):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    rows = run_query(f"""
        WITH sales AS (
            SELECT p.style_name AS style, MAX(p.brand) AS brand,
                MAX(p.product_type) AS subcategory,
                MAX(p.style_launch_date) AS launch,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
                SUM(s.net_quantity) AS u56,
                SUM(s.net_sales_kes::numeric) / NULLIF(SUM(s.net_quantity), 0) AS asp
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_sales}
            GROUP BY 1
        ),
        soh AS (
            SELECT p.style_name AS style,
                string_agg(DISTINCT i.pos_location_name, ', ') AS stores,
                SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND i.available > 0 AND COALESCE(p.style_name,'') <> '' {c_inv}
            GROUP BY 1
        )
        SELECT so.style AS style_name, sa.brand, sa.subcategory, sa.launch,
            COALESCE(sa.u28, 0) AS u28, COALESCE(sa.u56, 0) AS u56, sa.asp,
            COALESCE(so.soh, 0) AS soh, COALESCE(so.stores, '') AS stores
        FROM soh so LEFT JOIN sales sa ON sa.style = so.style
        WHERE COALESCE(so.soh, 0) > 0
    """) or []
    today = date.today()
    out = []
    for r in rows:
        u28 = int(r.get("u28") or 0)
        u56 = int(r.get("u56") or 0)
        soh = int(r.get("soh") or 0)
        asp = float(r["asp"]) if r.get("asp") is not None else 0.0
        weekly = _ewma_weekly(u28, u56)
        woc = round(soh / weekly, 1) if weekly > 0 else 999.0
        sell_through_8wk = round(100.0 * u56 / (u56 + soh), 1) if (u56 + soh) > 0 else 0.0
        bucket, _ = _trend_bucket(u28, max(u56 - u28, 0))
        launch_ok = True
        lv = r.get("launch")
        if lv:
            try:
                launch_ok = (today - date.fromisoformat(str(lv)[:10])).days > 84
            except ValueError:
                launch_ok = True
        if not (woc > 16 and sell_through_8wk < 20 and bucket in ("DECLINING", "DYING") and launch_ok):
            continue
        proj_units = min(soh, round(weekly * 2.0 * 8.0))
        md_pct = 30 if woc <= 26 else (40 if woc <= 52 else 50)
        md_rev = round(proj_units * asp * (1.0 - md_pct / 100.0))
        out.append({
            "style_name": r.get("style_name"), "brand": r.get("brand"),
            "subcategory": r.get("subcategory"),
            "affected_stores": r.get("stores") or "",
            "total_units": soh, "current_woc": woc,
            "sell_through_8wk": sell_through_8wk,
            "trend_bucket": bucket,
            "estimated_markdown_revenue_kes": md_rev,
            "recommended_markdown_pct": md_pct,
        })
    out.sort(key=lambda x: x["total_units"], reverse=True)
    return {"candidates": out, "total": len(out),
            "total_units": sum(c["total_units"] for c in out),
            "estimated_recovery_kes": sum(c["estimated_markdown_revenue_kes"] for c in out)}


@app.get("/api/analytics/clearance-plan")
def analytics_clearance_plan(country: str = Query(default=None)):
    cands = analytics_markdown_candidates(country)["candidates"]
    immediate = [c for c in cands if c["current_woc"] > 26]
    planned = [c for c in cands if 16 < c["current_woc"] <= 26]

    def _schedule(group):
        by_store = {}
        for c in group:
            for st in (c["affected_stores"].split(", ") if c["affected_stores"] else []):
                if not st:
                    continue
                by_store.setdefault(st, []).append({
                    "style_name": c["style_name"],
                    "recommended_markdown_pct": c["recommended_markdown_pct"],
                    "total_units": c["total_units"],
                    "current_woc": c["current_woc"],
                })
        return {
            "count": len(group),
            "total_units": sum(c["total_units"] for c in group),
            "estimated_recovery_kes": sum(c["estimated_markdown_revenue_kes"] for c in group),
            "by_store": by_store,
        }

    month = date.today().month
    season = "End-of-season clearance" if month in (1, 2, 6, 7) else "Mid-season markdown"
    return {
        "season_timing": season,
        "immediate": _schedule(immediate),
        "planned": _schedule(planned),
    }


# ── Step 7 — buying plan + size-ratio targets (audit A2 / A3) ─────────────────
@app.get("/api/buying/plan-summary")
def buying_plan_summary(
    weeks_ahead: float = Query(default=8.0),
    country:     str = Query(default=None),
):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    rows = run_query(f"""
        WITH sales AS (
            SELECT p.style_name AS style, MAX(p.product_type) AS subcategory,
                MAX(p.brand) AS brand, MAX(p.cost) AS cost,
                SUM(s.net_quantity) FILTER (
                    WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
                SUM(s.net_quantity) AS u56
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_kind IN ('sale','order')
              AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
              AND {BASE_FILTERS}
              AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_sales}
            GROUP BY 1
        ),
        soh AS (
            SELECT p.style_name AS style, SUM(i.available) AS soh
            FROM all_inventory i
            JOIN all_products_clean p ON p.sku = i.sku
            WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              AND COALESCE(p.style_name,'') <> '' {c_inv}
            GROUP BY 1
        )
        SELECT sa.style, sa.subcategory, sa.brand, sa.cost,
            COALESCE(sa.u28, 0) AS u28, COALESCE(sa.u56, 0) AS u56,
            COALESCE(so.soh, 0) AS soh
        FROM sales sa LEFT JOIN soh so ON so.style = sa.style
    """) or []
    agg = {}
    for r in rows:
        weekly = _ewma_weekly(r.get("u28"), r.get("u56"))
        if weekly <= 0:
            continue
        soh = int(r.get("soh") or 0)
        needed = max(0, round(weekly * (weeks_ahead + SAFETY_WEEKS) - soh))
        if needed <= 0:
            continue
        key = (r.get("subcategory") or "Unknown", r.get("brand") or "Unknown")
        a = agg.setdefault(key, {"units": 0, "cost_sum": 0.0, "has_cost": False})
        a["units"] += needed
        cost = r.get("cost")
        if cost:
            a["cost_sum"] += needed * float(cost)
            a["has_cost"] = True
    mix = run_query(f"""
        SELECT p.product_type AS subcategory, NULLIF(TRIM(p.size), '') AS size,
            SUM(s.net_quantity) AS u
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.product_type,'') <> '' {c_sales}
        GROUP BY 1, 2
    """) or []
    mix_by_sub = {}
    for r in mix:
        mix_by_sub.setdefault(r["subcategory"], {})[r["size"]] = float(r.get("u") or 0)
    out = []
    for (sub, brand), a in agg.items():
        total = a["units"]
        sub_mix = mix_by_sub.get(sub, {})
        tot_mix = sum(sub_mix.values())
        by_size = {}
        if tot_mix > 0:
            for sz in sorted(sub_mix, key=_size_sort_key):
                qty = round(total * sub_mix[sz] / tot_mix)
                if qty > 0:
                    by_size[sz] = qty
        out.append({
            "subcategory": sub, "brand": brand, "total_units_needed": total,
            "by_size": by_size,
            "estimated_cost_kes": round(a["cost_sum"]) if a["has_cost"] else None,
        })
    out.sort(key=lambda x: x["total_units_needed"], reverse=True)
    n = len(out)
    for i, o in enumerate(out):
        o["priority"] = "HIGH" if i < n * 0.34 else ("MEDIUM" if i < n * 0.67 else "LOW")
    return {
        "plan": out, "weeks_ahead": weeks_ahead,
        "total_units_needed": sum(o["total_units_needed"] for o in out),
        "total_estimated_cost_kes": round(sum((o["estimated_cost_kes"] or 0) for o in out)),
        "velocity_method": VELOCITY_METHOD,
    }


@app.get("/api/buying/size-ratio-targets")
def buying_size_ratio_targets(country: str = Query(default=None)):
    c_sales = (" AND s.country = '" + _sql_str(country) + "'") if country else ""
    c_inv = (" AND i.country = '" + _sql_str(country) + "'") if country else ""
    sales = run_query(f"""
        SELECT p.product_type AS subcategory, NULLIF(TRIM(p.size), '') AS size,
            SUM(s.net_quantity) FILTER (
                WHERE s.sale_date >= (CURRENT_DATE - INTERVAL '28 days')::text) AS u28,
            SUM(s.net_quantity) AS u56
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '56 days')::text
          AND {BASE_FILTERS}
          AND s.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.product_type,'') <> '' {c_sales}
        GROUP BY 1, 2
    """) or []
    inv = run_query(f"""
        SELECT p.product_type AS subcategory, NULLIF(TRIM(p.size), '') AS size,
            SUM(i.available) AS a
        FROM all_inventory i
        JOIN all_products_clean p ON p.sku = i.sku
        WHERE i.pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
          AND i.available > 0 AND NULLIF(TRIM(p.size), '') IS NOT NULL
          AND COALESCE(p.product_type,'') <> '' {c_inv}
        GROUP BY 1, 2
    """) or []
    sales_w = {}
    inv_a = {}
    subs = set()
    for r in sales:
        w = _ewma_weekly(r.get("u28"), r.get("u56"))
        sales_w.setdefault(r["subcategory"], {})[r["size"]] = w
        subs.add(r["subcategory"])
    for r in inv:
        inv_a.setdefault(r["subcategory"], {})[r["size"]] = float(r.get("a") or 0)
        subs.add(r["subcategory"])
    out = []
    for sub in subs:
        sw = sales_w.get(sub, {})
        iv = inv_a.get(sub, {})
        tot_s = sum(sw.values())
        tot_i = sum(iv.values())
        for sz in sorted(set(sw) | set(iv), key=_size_sort_key):
            sp = round(100.0 * sw.get(sz, 0) / tot_s, 1) if tot_s > 0 else 0.0
            ip = round(100.0 * iv.get(sz, 0) / tot_i, 1) if tot_i > 0 else 0.0
            if sp <= 0 and ip <= 0:
                continue
            var = round(sp - ip, 1)
            rec = "increase_buy" if var > 15 else ("reduce_buy" if var < -15 else "maintain")
            out.append({
                "subcategory": sub, "size": sz, "sales_pct": sp,
                "inventory_pct": ip, "variance_pct": var, "recommendation": rec,
            })
    out.sort(key=lambda x: (x["subcategory"], _size_sort_key(x["size"])))
    return {"targets": out, "total": len(out),
            "flagged_count": sum(1 for o in out if abs(o["variance_pct"]) > 15),
            "velocity_method": VELOCITY_METHOD}


# ── Step 8 — data-quality monitor (audit C / Q10) ─────────────────────────────
def _data_quality_report_dict():
    checks = []

    inv = (run_query("""
        SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE _loaded_at >= now() - INTERVAL '24 hours') AS fresh,
            array_agg(pos_location_name) FILTER (WHERE _loaded_at < now() - INTERVAL '24 hours') AS stale
        FROM (SELECT pos_location_name, MAX(_loaded_at) AS _loaded_at
              FROM all_inventory GROUP BY 1) t
    """) or [{}])[0]
    inv_total = int(inv.get("total") or 0)
    inv_fresh = int(inv.get("fresh") or 0)
    checks.append({
        "check": "inventory_freshness",
        "score": round(100.0 * inv_fresh / inv_total, 1) if inv_total else 100.0,
        "detail": f"{inv_fresh}/{inv_total} locations refreshed within 24h",
        "failing_locations": (inv.get("stale") or [])[:25],
    })

    lag = (run_query("""
        SELECT MAX(loaded_at) AS last_sync,
            EXTRACT(EPOCH FROM (now() - MAX(loaded_at))) / 60.0 AS lag_min
        FROM all_sales
    """) or [{}])[0]
    lag_min = float(lag.get("lag_min") or 0)
    lag_score = 100.0 if lag_min <= 60 else max(0.0, 100.0 - (lag_min - 60) / 60.0 * 10.0)
    checks.append({
        "check": "sales_sync_lag",
        "score": round(lag_score, 1),
        "detail": f"last sale loaded {round(lag_min)} min ago",
        "last_sync": lag["last_sync"].isoformat() if lag.get("last_sync") else None,
    })

    match = (run_query("""
        SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE p.sku IS NOT NULL) AS matched
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '30 days')::text
          AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
    """) or [{}])[0]
    m_total = int(match.get("total") or 0)
    m_matched = int(match.get("matched") or 0)
    checks.append({
        "check": "sku_match_rate",
        "score": round(100.0 * m_matched / m_total, 1) if m_total else 100.0,
        "detail": f"{m_matched}/{m_total} sale lines (30d) matched a product",
    })

    cost = (run_query("""
        SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE cost IS NULL OR cost <= 0) AS missing
        FROM all_products_clean WHERE active IS TRUE
    """) or [{}])[0]
    c_total = int(cost.get("total") or 0)
    c_missing = int(cost.get("missing") or 0)
    checks.append({
        "check": "missing_costs",
        "score": round(100.0 * (c_total - c_missing) / c_total, 1) if c_total else 100.0,
        "detail": f"{c_missing}/{c_total} active SKUs missing a cost",
    })

    zero = (run_query(f"""
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE soh <= 0) AS zero,
            array_agg(store) FILTER (WHERE soh <= 0) AS stores
        FROM (SELECT pos_location_name AS store, SUM(available) AS soh
              FROM all_inventory
              WHERE pos_location_name NOT IN ({WAREHOUSE_LOCATIONS})
              GROUP BY 1) t
    """) or [{}])[0]
    z_total = int(zero.get("total") or 0)
    z_zero = int(zero.get("zero") or 0)
    checks.append({
        "check": "zero_stock_stores",
        "score": round(100.0 * (z_total - z_zero) / z_total, 1) if z_total else 100.0,
        "detail": f"{z_zero}/{z_total} selling locations report zero inventory",
        "failing_locations": (zero.get("stores") or [])[:25],
    })

    scores = [c["score"] for c in checks]
    overall = round(sum(scores) / len(scores), 1) if scores else 100.0
    for c in checks:
        c["status"] = "ok" if c["score"] >= 80 else "alert"
    from datetime import datetime, timezone
    return {"overall_score": overall, "checks": checks,
            "checked_at": datetime.now(timezone.utc).isoformat()}


@app.get("/api/data-quality/report")
def data_quality_report():
    return _data_quality_report_dict()


@app.get("/api/data-quality/sku-coverage")
def data_quality_sku_coverage():
    rows = run_query("""
        SELECT s.store_id,
            COUNT(*) AS lines,
            COUNT(*) FILTER (WHERE p.sku IS NOT NULL) AS matched,
            COUNT(*) FILTER (WHERE p.cost IS NOT NULL AND p.cost > 0) AS costed,
            COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(p.product_type), ''), '') <> '') AS typed,
            COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(p.size), ''), '') <> '') AS sized
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_kind IN ('sale','order')
          AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
          AND s.variant_sku IS NOT NULL AND s.variant_sku <> ''
        GROUP BY s.store_id
    """) or []
    out = []
    for r in rows:
        lines = int(r.get("lines") or 0)
        if lines <= 0:
            continue
        out.append({
            "source": _SOURCE_BY_STORE_ID.get(r["store_id"], r["store_id"] or "Unknown"),
            "store_id": r.get("store_id"),
            "total_sku_lines": lines,
            "pct_matched": round(100.0 * int(r.get("matched") or 0) / lines, 1),
            "pct_with_cost": round(100.0 * int(r.get("costed") or 0) / lines, 1),
            "pct_with_subcategory": round(100.0 * int(r.get("typed") or 0) / lines, 1),
            "pct_with_size": round(100.0 * int(r.get("sized") or 0) / lines, 1),
        })
    out.sort(key=lambda x: x["total_sku_lines"], reverse=True)
    return {"sources": out, "total": len(out)}


def _ensure_data_quality_column():
    _users_exec(
        "ALTER TABLE sync_health_log "
        "ADD COLUMN IF NOT EXISTS data_quality_score numeric")


@app.on_event("startup")
def _init_data_quality_column():
    try:
        _ensure_data_quality_column()
    except Exception:
        pass


@app.post("/api/data-quality/log")
def data_quality_log(request: Request):
    # Internal-only (sync job, X-Internal-Token == SESSION_SECRET): persist the
    # current overall data-quality score onto a sync_health_log row. Idempotent
    # per UTC day — the sync loop fires every minute inside its 21:00 window, so
    # we skip if a data_quality row already exists for today (no duplicate noise).
    _ensure_data_quality_column()
    rep = _data_quality_report_dict()
    score = rep["overall_score"]
    alerts = [c["check"] for c in rep["checks"] if c["status"] != "ok"]
    note = f"data quality {score}" + (f"; alerts: {', '.join(alerts)}" if alerts else "")
    with _users_tx(lock=True) as cur:
        cur.execute(
            "SELECT 1 FROM sync_health_log "
            "WHERE action_taken = 'data_quality' "
            "AND checked_at::date = (now() AT TIME ZONE 'UTC')::date LIMIT 1")
        if cur.fetchone():
            return {"ok": True, "data_quality_score": score,
                    "skipped": True, "reason": "already logged today",
                    "checks": rep["checks"]}
        cur.execute(
            "INSERT INTO sync_health_log "
            "(checked_at, api_healthy, sync_healthy, action_taken, notes, data_quality_score) "
            "VALUES (now(), true, true, %s, %s, %s)",
            ("data_quality", note[:500], score))
    return {"ok": True, "data_quality_score": score, "skipped": False,
            "checks": rep["checks"]}


# =====================================================================
# CRM / CEM / Loyalty platform (in-app, no external integrations)
# ---------------------------------------------------------------------
# A write-capable CRM layered on the live BI data. Customer 360 merges
# all_customers + all_sales with a CRM override/extension table; brand
# split (vivo | sz) lives on every CRM record. Append-only ledgers for
# loyalty points and ticket messages. All money in KES. Social-channel
# webhooks, the customer loyalty app, OTP, email engine and ML churn are
# intentionally NOT built here (they need external accounts/approvals).
# =====================================================================

CRM_BRANDS = ("vivo", "sz")

CRM_CONFIG_DEFAULTS = {
    "loyalty.earn_rate_kes": "100",        # base: 1 point per KES 100 spent (floor)
    "loyalty.points_per_kes_redeem": "100",  # 100 points = KES 1
    "loyalty.redemption_floor": "200",     # minimum points to redeem
    "loyalty.points_expiry_months": "12",  # points expire after this many months of no purchase
    # Tier qualification by trailing-12-month spend (KES). Four tiers (PRD 5.3):
    #   Bronze   KES 1 – 49,999
    #   Silver   KES 50,000 – 149,999
    #   Gold     KES 150,000 – 299,999
    #   VIP      KES 300,000+
    "loyalty.tier_silver_kes": "50000",
    "loyalty.tier_gold_kes": "150000",
    "loyalty.tier_vip_kes": "300000",      # VIP loyalty tier threshold (also gates the CRM "vip" segment)
    # Points earned per KES 100 by tier (tiered earn-rate multipliers).
    "loyalty.earn_multiplier_bronze": "1",
    "loyalty.earn_multiplier_silver": "2",
    "loyalty.earn_multiplier_gold": "3",
    "loyalty.earn_multiplier_vip": "4",
    "sla.meta_high_minutes": "120",
    "sla.tiktok_high_minutes": "240",
    "sla.whatsapp_high_minutes": "120",
    "sla.email_minutes": "1440",
    "sla.in_store_critical_minutes": "60",
    "sla.default_minutes": "480",
    # Complaint/case SLA per category (minutes to first response/resolution).
    # These OVERRIDE the channel SLA when the ticket's issue_category is a
    # recognised complaint category (CEM 2.1).
    "sla.category_product_quality_minutes": "240",
    "sla.category_sizing_minutes": "480",
    "sla.category_delivery_minutes": "240",
    "sla.category_returns_minutes": "480",
    "sla.category_staff_conduct_minutes": "120",
    # Complaint escalation (CEM 2.1): associate -> team_lead -> head_of_cx.
    # Gold/VIP loyalty members auto-escalate straight to Head of CX on create.
    "escalation.gold_vip_auto_head_of_cx": "1",
    # A second complaint in the same category within this many days flags the
    # customer as a repeat complainer on their card.
    "escalation.repeat_complaint_window_days": "90",
    # CSAT (CEM 2.2). Per-ticket survey on resolve + post-purchase survey.
    "csat.enabled": "1",
    # Meta/WhatsApp can only message a user inside this many hours of their last
    # inbound message; outside it we log + skip the survey rather than send.
    "csat.meta_window_hours": "24",
    # Post-purchase survey is requested for orders whose purchase date falls in
    # this window (PRD: 24-48h after purchase). all_sales is date-grained, so we
    # approximate at day resolution: orders from min..max days ago.
    "csat.post_purchase_min_days": "1",
    "csat.post_purchase_max_days": "2",
}

# Recognised complaint categories (CEM 2.1). issue_category values matching
# these get a per-category SLA and participate in the complaint escalation /
# repeat-complaint logic. Anything else is treated as a general enquiry.
CRM_COMPLAINT_CATEGORIES = (
    "product_quality", "sizing", "delivery", "returns", "staff_conduct",
)

# Complaint escalation ladder (lowest -> highest).
CRM_ESCALATION_LADDER = ("associate", "team_lead", "head_of_cx")

# Channels that enforce a customer-care-window messaging policy (CEM 2.2): a
# survey can only be delivered within csat.meta_window_hours of the customer's
# last inbound message; outside it we log + skip rather than send.
CSAT_META_CHANNELS = ("facebook", "instagram", "messenger", "meta", "whatsapp")


def _ensure_crm_tables():
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_config (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    # Customer extension / override layer. Rows may key an existing
    # all_customers.customer_id (overrides + CRM-only fields) OR be a
    # staff-added contact (is_manual=true, generated 'crm:' customer_id).
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_customer (
            customer_id            TEXT PRIMARY KEY,
            brand_code             TEXT NOT NULL DEFAULT 'vivo',
            first_name             TEXT,
            last_name              TEXT,
            phone                  TEXT,
            email                  TEXT,
            dob                    TEXT,
            preferred_size         TEXT,
            preferred_style        TEXT,
            preferred_channel      TEXT,
            store_affinity         TEXT,
            consent_marketing      BOOLEAN NOT NULL DEFAULT FALSE,
            consent_data_processing BOOLEAN NOT NULL DEFAULT FALSE,
            notes                  TEXT,
            is_manual              BOOLEAN NOT NULL DEFAULT FALSE,
            created_by             TEXT,
            created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_by             TEXT,
            updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_customer_phone ON crm_customer(phone)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_customer_email ON crm_customer(email)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_customer_brand ON crm_customer(brand_code)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_tags (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            color      TEXT DEFAULT '#1a5c38',
            brand_code TEXT NOT NULL DEFAULT 'vivo',
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (name, brand_code)
        )""")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_customer_tags (
            customer_id TEXT NOT NULL,
            tag_id      INTEGER NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
            added_by    TEXT,
            added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (customer_id, tag_id)
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_customer_tags_tag ON crm_customer_tags(tag_id)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_tasks (
            id               SERIAL PRIMARY KEY,
            customer_id      TEXT,
            title            TEXT NOT NULL,
            description      TEXT,
            due_date         DATE,
            status           TEXT NOT NULL DEFAULT 'open',
            priority         TEXT NOT NULL DEFAULT 'normal',
            assignee_user_id TEXT,
            assignee_name    TEXT,
            brand_code       TEXT NOT NULL DEFAULT 'vivo',
            created_by       TEXT,
            created_by_name  TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tasks_status ON crm_tasks(status)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee ON crm_tasks(assignee_user_id)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tasks_customer ON crm_tasks(customer_id)")
    # Append-only interaction / outcome log.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_interactions (
            id          SERIAL PRIMARY KEY,
            customer_id TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'note',
            outcome     TEXT,
            channel     TEXT,
            notes       TEXT,
            user_id     TEXT,
            user_name   TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_interactions_customer ON crm_interactions(customer_id)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_campaigns (
            id              SERIAL PRIMARY KEY,
            name            TEXT NOT NULL,
            brand_code      TEXT NOT NULL DEFAULT 'vivo',
            channel         TEXT,
            description     TEXT,
            status          TEXT NOT NULL DEFAULT 'draft',
            created_by      TEXT,
            created_by_name TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_campaign_members (
            id            SERIAL PRIMARY KEY,
            campaign_id   INTEGER NOT NULL REFERENCES crm_campaigns(id) ON DELETE CASCADE,
            customer_id   TEXT NOT NULL,
            send_status   TEXT NOT NULL DEFAULT 'pending',
            responded     BOOLEAN NOT NULL DEFAULT FALSE,
            response_note TEXT,
            sent_at       TIMESTAMPTZ,
            responded_at  TIMESTAMPTZ,
            added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (campaign_id, customer_id)
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_campaign_members_campaign ON crm_campaign_members(campaign_id)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_tickets (
            id                SERIAL PRIMARY KEY,
            ticket_number     TEXT UNIQUE,
            customer_id       TEXT,
            brand_code        TEXT NOT NULL DEFAULT 'vivo',
            inbound_channel   TEXT,
            issue_category    TEXT,
            subject           TEXT,
            priority          TEXT NOT NULL DEFAULT 'normal',
            assigned_to       TEXT,
            assigned_to_name  TEXT,
            status            TEXT NOT NULL DEFAULT 'open',
            sla_target_minutes INTEGER,
            sla_due_at        TIMESTAMPTZ,
            sla_breached      BOOLEAN NOT NULL DEFAULT FALSE,
            csat_score        INTEGER,
            created_by        TEXT,
            created_by_name   TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at       TIMESTAMPTZ
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tickets_status ON crm_tickets(status)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tickets_assigned ON crm_tickets(assigned_to)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tickets_customer ON crm_tickets(customer_id)")
    # Complaint/case management columns (CEM 2.1) — added idempotently so
    # existing deployments pick them up without a migration.
    for _col, _ddl in (
        ("escalation_level", "TEXT NOT NULL DEFAULT 'associate'"),
        ("escalated_at", "TIMESTAMPTZ"),
        ("escalated_to", "TEXT"),
        ("escalated_to_name", "TEXT"),
        ("escalation_reason", "TEXT"),
        ("product_sku", "TEXT"),
        ("resolution_notified_at", "TIMESTAMPTZ"),
        ("resolution_notify_channel", "TEXT"),
    ):
        _users_exec(f"ALTER TABLE crm_tickets ADD COLUMN IF NOT EXISTS {_col} {_ddl}")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_tickets_category ON crm_tickets(issue_category)")
    # Append-only ticket conversation.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_ticket_messages (
            id             SERIAL PRIMARY KEY,
            ticket_id      INTEGER NOT NULL REFERENCES crm_tickets(id) ON DELETE CASCADE,
            direction      TEXT NOT NULL DEFAULT 'outbound',
            sender_user_id TEXT,
            sender_name    TEXT,
            body           TEXT,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_ticket_messages_ticket ON crm_ticket_messages(ticket_id)")
    # CSAT surveys (CEM 2.2): per-ticket (on resolve) + post-purchase. One log
    # row per survey; status requested -> responded | skipped.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_csat (
            id            SERIAL PRIMARY KEY,
            survey_type   TEXT NOT NULL DEFAULT 'ticket',
            ticket_id     INTEGER REFERENCES crm_tickets(id) ON DELETE CASCADE,
            customer_id   TEXT,
            brand_code    TEXT NOT NULL DEFAULT 'vivo',
            channel       TEXT,
            store         TEXT,
            order_id      TEXT,
            score         INTEGER,
            comment       TEXT,
            status        TEXT NOT NULL DEFAULT 'requested',
            skip_reason   TEXT,
            requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            responded_at  TIMESTAMPTZ
        )""")
    # One survey per ticket, and one post-purchase survey per order (idempotency
    # for the lazy post-purchase trigger + re-resolve).
    _users_exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_csat_ticket ON crm_csat(ticket_id) "
                "WHERE survey_type='ticket' AND ticket_id IS NOT NULL")
    _users_exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_csat_order ON crm_csat(order_id) "
                "WHERE survey_type='post_purchase' AND order_id IS NOT NULL")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_csat_requested ON crm_csat(requested_at)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_csat_customer ON crm_csat(customer_id)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_loyalty_enrolment (
            customer_id     TEXT PRIMARY KEY,
            brand_code      TEXT NOT NULL DEFAULT 'vivo',
            tier            TEXT NOT NULL DEFAULT 'Bronze',
            points_balance  INTEGER NOT NULL DEFAULT 0,
            points_lifetime INTEGER NOT NULL DEFAULT 0,
            enrolment_date  TIMESTAMPTZ NOT NULL DEFAULT now(),
            tier_updated_at TIMESTAMPTZ
        )""")
    # Append-only points ledger — single source of truth, never updated/deleted.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_loyalty_ledger (
            id             SERIAL PRIMARY KEY,
            customer_id    TEXT NOT NULL,
            transaction_id TEXT,
            points_change  INTEGER NOT NULL,
            reason         TEXT NOT NULL DEFAULT 'admin',
            balance_after  INTEGER,
            valid_until    TIMESTAMPTZ,
            created_by     TEXT,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_ledger_customer ON crm_loyalty_ledger(customer_id)")
    # Make POS earn idempotency a hard DB invariant: at most one 'earn' ledger
    # row per (customer, transaction_id). Concurrent same-txn requests can no
    # longer both pass the pre-check and double-credit — the loser hits this
    # constraint and is collapsed via ON CONFLICT DO NOTHING.
    _users_exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ledger_earn_txn "
        "ON crm_loyalty_ledger(customer_id, transaction_id) "
        "WHERE reason='earn' AND transaction_id IS NOT NULL")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_redemptions (
            id             SERIAL PRIMARY KEY,
            customer_id    TEXT NOT NULL,
            points_redeemed INTEGER NOT NULL,
            kes_value      NUMERIC,
            discount_code  TEXT UNIQUE,
            code_status    TEXT NOT NULL DEFAULT 'issued',
            issued_by      TEXT,
            issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            used_at        TIMESTAMPTZ,
            used_store_id  TEXT
        )""")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_audit (
            id         SERIAL PRIMARY KEY,
            entity     TEXT,
            entity_id  TEXT,
            action     TEXT,
            detail     TEXT,
            user_id    TEXT,
            user_name  TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    # Customer-facing loyalty membership (the "loyalty card"). A self-service
    # identity distinct from staff app_users: members enrol with phone + PIN and
    # carry a scannable membership_code (Carrefour-style barcode). Points/tiers
    # live in the existing crm_loyalty_enrolment/ledger keyed by customer_id; this
    # row links a member to that customer_id ('mbr:' generated id).
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_loyalty_member (
            member_id       TEXT PRIMARY KEY,
            customer_id     TEXT UNIQUE NOT NULL,
            brand_code      TEXT NOT NULL DEFAULT 'vivo',
            name            TEXT,
            phone           TEXT UNIQUE NOT NULL,
            email           TEXT,
            membership_code TEXT UNIQUE NOT NULL,
            pin_hash        TEXT NOT NULL,
            card_token_hash TEXT,
            spend_kes       NUMERIC NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at   TIMESTAMPTZ
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_member_code ON crm_loyalty_member(membership_code)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_member_token ON crm_loyalty_member(card_token_hash)")
    # Brute-force throttle for the low-entropy (4–6 digit) PIN login. Tracked on
    # the member row so it survives restarts and is per-account, not in-memory.
    _users_exec("ALTER TABLE crm_loyalty_member ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0")
    _users_exec("ALTER TABLE crm_loyalty_member ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ")
    # In-app messages staff broadcast to loyalty members (read in the mobile card).
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_member_message (
            id              SERIAL PRIMARY KEY,
            audience        TEXT NOT NULL DEFAULT 'all',
            brand_code      TEXT,
            customer_id     TEXT,
            title           TEXT NOT NULL,
            body            TEXT NOT NULL,
            created_by      TEXT,
            created_by_name TEXT,
            active          BOOLEAN NOT NULL DEFAULT TRUE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_crm_msg_active ON crm_member_message(active, created_at DESC)")
    # Scheduling: optional auto-publish (hidden until publish_at) + auto-expire (hidden after expires_at).
    _users_exec("ALTER TABLE crm_member_message ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ")
    _users_exec("ALTER TABLE crm_member_message ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS crm_member_message_read (
            message_id  INTEGER NOT NULL,
            customer_id TEXT NOT NULL,
            read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (message_id, customer_id)
        )""")
    # Seed config defaults (idempotent — never clobbers an admin-edited value).
    for k, v in CRM_CONFIG_DEFAULTS.items():
        _users_exec(
            "INSERT INTO crm_config (key, value, updated_by) VALUES (%s, %s, 'system:seed') "
            "ON CONFLICT (key) DO NOTHING", (k, v))


@app.on_event("startup")
def _init_crm_store():
    try:
        _ensure_crm_tables()
    except Exception as e:
        log.error("CRM table init failed: %s", e)
    try:
        _ensure_thumbnail_overrides()
    except Exception as e:
        log.error("thumbnail_overrides table init failed: %s", e)


# --- CRM helpers ----------------------------------------------------------

def _crm_actor(request):
    u = getattr(request.state, "user", None) or {}
    uid = u.get("user_id") or u.get("id") or "system"
    name = u.get("name") or u.get("email") or "system"
    role = (u.get("role") or DEFAULT_NEW_ROLE).lower()
    return uid, name, role


def _crm_is_admin(request):
    _, _, role = _crm_actor(request)
    return role == "admin"


def _crm_norm_phone(p):
    """Normalise a Kenyan phone toward E.164 (+254...). Best-effort."""
    if not p:
        return None
    d = re.sub(r"[^0-9]", "", str(p))
    if not d:
        return None
    if d.startswith("254"):
        pass
    elif d.startswith("0"):
        d = "254" + d[1:]
    elif len(d) == 9 and d[0] in ("7", "1"):
        d = "254" + d
    return "+" + d


def _crm_brand(v, default="vivo"):
    v = (v or "").strip().lower()
    return v if v in CRM_BRANDS else default


def _crm_config_dict():
    rows = _users_exec("SELECT key, value FROM crm_config", fetch=True) or []
    cfg = dict(CRM_CONFIG_DEFAULTS)
    for r in rows:
        cfg[r["key"]] = r["value"]
    return cfg


def _crm_cfg_num(cfg, key, default=0.0):
    try:
        return float(cfg.get(key, CRM_CONFIG_DEFAULTS.get(key, default)))
    except Exception:
        return float(default)


def _crm_tier_for_spend(spend, cfg):
    # Loyalty membership has four tiers, qualified by trailing-12-month spend
    # (PRD 5.3): Bronze / Silver / Gold / VIP.
    s = float(spend or 0)
    if s >= _crm_cfg_num(cfg, "loyalty.tier_vip_kes", 300000):
        return "VIP"
    if s >= _crm_cfg_num(cfg, "loyalty.tier_gold_kes", 150000):
        return "Gold"
    if s >= _crm_cfg_num(cfg, "loyalty.tier_silver_kes", 50000):
        return "Silver"
    return "Bronze"


def _crm_earn_multiplier(tier, cfg):
    """Points earned per KES 100 depends on the member's tier:
    Bronze x1, Silver x2, Gold x3, VIP x4 (configurable). Always >= 1."""
    key = {
        "VIP": "loyalty.earn_multiplier_vip",
        "Gold": "loyalty.earn_multiplier_gold",
        "Silver": "loyalty.earn_multiplier_silver",
    }.get(tier, "loyalty.earn_multiplier_bronze")
    m = int(_crm_cfg_num(cfg, key, 1) or 1)
    return m if m >= 1 else 1


def _member_expire_inactive_points(customer_id, cfg=None):
    """Lazily expire a member's whole points balance after N months with no
    'earn' activity ("points expire within 12 months if the customer does not
    come back"). There is no cron — this is evaluated on member reads + earns,
    the same lazy pattern used for scheduled member messages. Coming back (an
    earn) resets the clock. Returns True if points were expired this call."""
    cfg = cfg or _crm_config_dict()
    months = int(_crm_cfg_num(cfg, "loyalty.points_expiry_months", 12) or 12)
    if months <= 0:
        return False
    with _users_tx() as cur:
        cur.execute(
            "SELECT points_balance FROM crm_loyalty_enrolment WHERE customer_id=%s FOR UPDATE",
            (customer_id,))
        row = cur.fetchone()
        if not row or int(row["points_balance"] or 0) <= 0:
            cur.connection.rollback()
            return False
        bal = int(row["points_balance"])
        cur.execute(
            "SELECT MAX(created_at) AS last_earn FROM crm_loyalty_ledger "
            "WHERE customer_id=%s AND reason='earn'", (customer_id,))
        lr = cur.fetchone()
        last_earn = lr["last_earn"] if lr else None
        if last_earn is None:
            cur.connection.rollback()
            return False
        cur.execute(
            "SELECT (%s < now() - make_interval(months => %s)) AS expired",
            (last_earn, months))
        if not cur.fetchone()["expired"]:
            cur.connection.rollback()
            return False
        cur.execute(
            "INSERT INTO crm_loyalty_ledger (customer_id, points_change, reason, balance_after, created_by) "
            "VALUES (%s,%s,'expire',0,%s)",
            (customer_id, -bal, "system:expiry"))
        cur.execute(
            "UPDATE crm_loyalty_enrolment SET points_balance=0 WHERE customer_id=%s",
            (customer_id,))
    return True


def _crm_rolling_spend(customer_id):
    rows = _users_exec(
        "SELECT COALESCE(SUM(s.total_sales_kes::numeric),0) AS spend "
        "FROM all_sales s WHERE s.customer_id = %s "
        "AND s.sale_kind IN ('sale','order') "
        "AND s.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' "
        "AND s.sale_date::date >= (CURRENT_DATE - INTERVAL '12 months') "
        "AND s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda')",
        (customer_id,), fetch=True)
    return float(rows[0]["spend"]) if rows else 0.0


def _crm_audit(entity, entity_id, action, detail, request):
    uid, name, _ = _crm_actor(request)
    try:
        _users_exec(
            "INSERT INTO crm_audit (entity, entity_id, action, detail, user_id, user_name) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            (entity, str(entity_id), action, (detail or "")[:1000], uid, name))
    except Exception:
        pass


# --- Loyalty membership (customer-facing card) helpers --------------------

def _member_hash_token(token):
    """Hash a member card token for at-rest storage (never store the raw token)."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _member_token_from_request(request):
    """Read the member card token from the X-Member-Token header (or Bearer)."""
    tok = request.headers.get("x-member-token")
    if tok:
        return tok.strip()
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _member_for_request(request):
    """Resolve the calling loyalty member from their card token, or None."""
    tok = _member_token_from_request(request)
    if not tok:
        return None
    rows = _users_exec(
        "SELECT * FROM crm_loyalty_member WHERE card_token_hash=%s",
        (_member_hash_token(tok),), fetch=True)
    return rows[0] if rows else None


def _gen_membership_code():
    """Generate a unique 13-digit numeric membership code (scans as Code128)."""
    for _ in range(10):
        code = "20" + "".join(secrets.choice("0123456789") for _ in range(11))
        if not _users_exec(
                "SELECT 1 FROM crm_loyalty_member WHERE membership_code=%s",
                (code,), fetch=True):
            return code
    return "20" + "".join(secrets.choice("0123456789") for _ in range(11))


def _member_public(m, enrol=None):
    """The safe member view returned to the loyalty app (no PIN / token hash)."""
    out = {
        "member_id": m.get("member_id"),
        "customer_id": m.get("customer_id"),
        "brand_code": m.get("brand_code") or "vivo",
        "name": m.get("name"),
        "phone": m.get("phone"),
        "email": m.get("email"),
        "membership_code": m.get("membership_code"),
        "tier": "Bronze",
        "points_balance": 0,
        "points_lifetime": 0,
    }
    if enrol:
        out["tier"] = enrol.get("tier") or "Bronze"
        out["points_balance"] = int(enrol.get("points_balance") or 0)
        out["points_lifetime"] = int(enrol.get("points_lifetime") or 0)
    return out


def _member_enrolment(customer_id):
    rows = _users_exec(
        "SELECT * FROM crm_loyalty_enrolment WHERE customer_id=%s",
        (customer_id,), fetch=True)
    return rows[0] if rows else None


def _crm_is_complaint(category):
    return (category or "").strip().lower() in CRM_COMPLAINT_CATEGORIES


def _crm_sla_minutes(cfg, channel, priority, category=None):
    # Recognised complaint categories take a per-category SLA that OVERRIDES
    # the channel SLA (CEM 2.1).
    cat = (category or "").strip().lower()
    if cat in CRM_COMPLAINT_CATEGORIES:
        key = f"sla.category_{cat}_minutes"
        default = {
            "product_quality": 240, "sizing": 480, "delivery": 240,
            "returns": 480, "staff_conduct": 120,
        }.get(cat, 480)
        return int(_crm_cfg_num(cfg, key, default))
    ch = (channel or "").lower()
    pr = (priority or "normal").lower()
    if ch == "in_store" and pr in ("critical", "urgent", "high"):
        return int(_crm_cfg_num(cfg, "sla.in_store_critical_minutes", 60))
    if ch in ("facebook", "instagram", "meta"):
        return int(_crm_cfg_num(cfg, "sla.meta_high_minutes", 120))
    if ch == "tiktok":
        return int(_crm_cfg_num(cfg, "sla.tiktok_high_minutes", 240))
    if ch == "whatsapp":
        return int(_crm_cfg_num(cfg, "sla.whatsapp_high_minutes", 120))
    if ch == "email":
        return int(_crm_cfg_num(cfg, "sla.email_minutes", 1440))
    return int(_crm_cfg_num(cfg, "sla.default_minutes", 480))


def _crm_customer_tier(customer_id, cfg):
    """Resolve a customer's loyalty tier: prefer the stored enrolment tier,
    else compute from trailing-12-month spend. Returns 'Bronze' if unknown."""
    if not customer_id:
        return "Bronze"
    r = _users_exec(
        "SELECT tier FROM crm_loyalty_enrolment WHERE customer_id=%s",
        (customer_id,), fetch=True)
    if r and r[0].get("tier"):
        return r[0]["tier"]
    sp = _users_exec(
        "SELECT COALESCE(SUM(total_sales_kes),0) AS s FROM all_sales "
        "WHERE customer_id=%s AND sale_date::date >= (CURRENT_DATE - INTERVAL '365 days')",
        (customer_id,), fetch=True)
    return _crm_tier_for_spend((sp[0]["s"] if sp else 0), cfg)


def _crm_repeat_complaint_count(customer_id, category, cfg, exclude_ticket_id=None):
    """How many complaints this customer has filed in the same category within
    the repeat-complaint window (CEM 2.1). Used to flag repeat complainers."""
    if not customer_id or not _crm_is_complaint(category):
        return 0
    days = int(_crm_cfg_num(cfg, "escalation.repeat_complaint_window_days", 90))
    params = [customer_id, category.strip().lower(), str(days)]
    extra = ""
    if exclude_ticket_id is not None:
        extra = " AND id <> %s"
        params.append(exclude_ticket_id)
    r = _users_exec(
        "SELECT COUNT(*) AS c FROM crm_tickets WHERE customer_id=%s "
        "AND LOWER(issue_category)=%s "
        "AND created_at >= (now() - (%s || ' days')::interval)" + extra,
        tuple(params), fetch=True)
    return int(r[0]["c"]) if r else 0


def _crm_log_ticket_system(tid, body):
    """Append an internal system note to a ticket thread (audit-style trail)."""
    try:
        _users_exec(
            "INSERT INTO crm_ticket_messages (ticket_id, direction, sender_user_id, sender_name, body) "
            "VALUES (%s,'system',%s,%s,%s)", (tid, "system", "System", body[:2000]))
    except Exception:
        pass


def _crm_next_escalation(level):
    """Return the next level up the ladder, or None if already at the top."""
    lvl = (level or "associate").lower()
    try:
        i = CRM_ESCALATION_LADDER.index(lvl)
    except ValueError:
        i = 0
    return CRM_ESCALATION_LADDER[i + 1] if i + 1 < len(CRM_ESCALATION_LADDER) else None


def _crm_escalate_overdue(cfg=None):
    """Lazy SLA sweep (no cron, like points expiry): any open complaint past
    its SLA due time that has not yet reached head_of_cx is bumped one level up
    the ladder and a system note is logged. Runs on ticket-list reads."""
    try:
        rows = _users_exec(
            "SELECT id, escalation_level, ticket_number FROM crm_tickets "
            "WHERE status NOT IN ('resolved','closed') AND sla_due_at IS NOT NULL "
            "AND now() > sla_due_at AND COALESCE(escalation_level,'associate') <> 'head_of_cx' "
            "AND LOWER(issue_category) = ANY(%s)",
            (list(CRM_COMPLAINT_CATEGORIES),), fetch=True) or []
    except Exception:
        rows = []
    for r in rows:
        nxt = _crm_next_escalation(r.get("escalation_level"))
        if not nxt:
            continue
        _users_exec(
            "UPDATE crm_tickets SET escalation_level=%s, escalated_at=now(), "
            "escalation_reason='SLA breach (auto)', sla_breached=TRUE WHERE id=%s",
            (nxt, r["id"]))
        _crm_log_ticket_system(r["id"], f"Auto-escalated to {nxt} on SLA breach.")


def _crm_request_ticket_csat(ticket, cfg=None):
    """On ticket resolve, request a per-ticket CSAT (1-5) via the originating
    channel (CEM 2.2). Respects the Meta/WhatsApp customer-care window: if the
    customer's last inbound message is older than csat.meta_window_hours, the
    survey can't be delivered, so we record it as 'skipped' (log + skip) instead
    of sending. Idempotent: one survey per ticket (uq_crm_csat_ticket)."""
    cfg = cfg or _crm_config_dict()
    if not int(_crm_cfg_num(cfg, "csat.enabled", 1)):
        return None
    tid = ticket.get("id")
    if not tid:
        return None
    channel = (ticket.get("inbound_channel") or "in_store")
    status, skip_reason = "requested", None
    if channel.lower() in CSAT_META_CHANNELS:
        win_h = _crm_cfg_num(cfg, "csat.meta_window_hours", 24)
        r = _users_exec(
            "SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))/3600.0 AS age_h "
            "FROM crm_ticket_messages WHERE ticket_id=%s AND direction='inbound'",
            (tid,), fetch=True)
        age_h = (r[0]["age_h"] if r else None)
        if age_h is None or float(age_h) > win_h:
            status, skip_reason = "skipped", f"outside {int(win_h)}h messaging window"
    row = _users_exec(
        "INSERT INTO crm_csat (survey_type, ticket_id, customer_id, brand_code, channel, status, skip_reason) "
        "VALUES ('ticket',%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT (ticket_id) WHERE survey_type='ticket' AND ticket_id IS NOT NULL DO NOTHING "
        "RETURNING id, status",
        (tid, ticket.get("customer_id"), _crm_brand(ticket.get("brand_code")),
         channel, status, skip_reason), fetch=True)
    if not row:
        return None
    if status == "skipped":
        _crm_log_ticket_system(tid, f"CSAT survey skipped: {skip_reason}.")
    else:
        _crm_log_ticket_system(tid, f"CSAT survey requested via {channel}.")
    return {"survey_id": row[0]["id"], "status": status, "skip_reason": skip_reason}


def _crm_trigger_post_purchase_csat(cfg=None):
    """Lazy post-purchase CSAT trigger (no cron, like the SLA sweep): create a
    survey for identified-customer orders whose purchase date falls in the
    configured window (PRD 24-48h; approximated at day grain since all_sales is
    date-only). Idempotent per order via uq_crm_csat_order. Returns #created."""
    cfg = cfg or _crm_config_dict()
    if not int(_crm_cfg_num(cfg, "csat.enabled", 1)):
        return 0
    min_d = int(_crm_cfg_num(cfg, "csat.post_purchase_min_days", 1))
    max_d = int(_crm_cfg_num(cfg, "csat.post_purchase_max_days", 2))
    try:
        rows = _users_exec(
            "SELECT order_id, MAX(customer_id) AS customer_id, "
            "       MAX(pos_location_name) AS store, MAX(channel) AS channel "
            "FROM all_sales "
            "WHERE customer_id IS NOT NULL AND customer_id <> '' "
            "  AND order_id IS NOT NULL AND order_id <> '' "
            "  AND COALESCE(LOWER(customer_type),'') NOT IN ('walk-in','walk_in','anonymous') "
            "  AND sale_kind IN ('sale','order') "
            "  AND sale_date::date BETWEEN (CURRENT_DATE - %s) AND (CURRENT_DATE - %s) "
            "GROUP BY order_id "
            "HAVING COALESCE(SUM(total_sales_kes),0) > 0",
            (max_d, min_d), fetch=True) or []
    except Exception:
        rows = []
    created = 0
    for r in rows:
        ins = _users_exec(
            "INSERT INTO crm_csat (survey_type, order_id, customer_id, channel, store, status) "
            "VALUES ('post_purchase',%s,%s,%s,%s,'requested') "
            "ON CONFLICT (order_id) WHERE survey_type='post_purchase' AND order_id IS NOT NULL "
            "DO NOTHING RETURNING id",
            (r.get("order_id"), r.get("customer_id"),
             r.get("channel") or "post_purchase", r.get("store")), fetch=True)
        if ins:
            created += 1
    return created


# --- CRM: config + team ---------------------------------------------------

@app.get("/api/crm/config")
def crm_config_get(request: Request):
    return {"config": _crm_config_dict()}


@app.put("/api/crm/config")
async def crm_config_put(request: Request):
    if not _crm_is_admin(request):
        return JSONResponse({"detail": "Admin access required"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    items = body.get("config") if isinstance(body, dict) and "config" in body else body
    if not isinstance(items, dict):
        return JSONResponse({"detail": "Expected an object of key/value pairs"}, status_code=400)
    uid, name, _ = _crm_actor(request)
    for k, v in items.items():
        _users_exec(
            "INSERT INTO crm_config (key, value, updated_by, updated_at) VALUES (%s,%s,%s,now()) "
            "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()",
            (str(k), str(v), name))
    _crm_audit("config", "*", "update", ", ".join(items.keys()), request)
    return {"ok": True, "config": _crm_config_dict()}


@app.get("/api/crm/team")
def crm_team(request: Request):
    rows = _users_exec(
        "SELECT user_id, name, email, role FROM app_users WHERE status='active' ORDER BY name NULLS LAST, email",
        fetch=True) or []
    return {"team": rows}


# --- CRM: customers (search / 360 / create / patch) -----------------------

@app.get("/api/crm/customers")
def crm_customers(request: Request):
    qp = request.query_params
    q = (qp.get("q") or "").strip()
    brand = _crm_brand(qp.get("brand"), default="")
    segment = (qp.get("segment") or "").strip().lower()
    tag_id = qp.get("tag_id")
    try:
        limit = max(1, min(int(qp.get("limit") or 50), 200))
    except Exception:
        limit = 50
    try:
        offset = max(0, int(qp.get("offset") or 0))
    except Exception:
        offset = 0

    like = f"%{q.lower()}%"
    phone_digits = re.sub(r"[^0-9]", "", q)
    phone_like = f"%{phone_digits}%" if phone_digits else None

    where = ["1=1"]
    params = {}
    if q:
        cond = "(lower(m.name) LIKE %(like)s OR lower(m.email) LIKE %(like)s"
        params["like"] = like
        if phone_like:
            cond += " OR regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g') LIKE %(phone_like)s"
            params["phone_like"] = phone_like
        cond += ")"
        where.append(cond)
    if brand:
        where.append("m.brand_code = %(brand)s")
        params["brand"] = brand
    if tag_id:
        where.append("EXISTS (SELECT 1 FROM crm_customer_tags ct WHERE ct.customer_id = m.customer_id AND ct.tag_id = %(tag_id)s)")
        try:
            params["tag_id"] = int(tag_id)
        except Exception:
            params["tag_id"] = -1
    if segment == "new":
        where.append("COALESCE(m.total_orders,0) <= 1")
    elif segment == "loyal":
        where.append("COALESCE(m.total_orders,0) >= 5")
    elif segment == "vip":
        where.append("COALESCE(m.total_spend_kes,0) >= %(vip)s")
        params["vip"] = _crm_cfg_num(_crm_config_dict(), "loyalty.tier_vip_kes", 300000)
    elif segment == "at_risk":
        where.append("m.days_since BETWEEN 90 AND 180")
    elif segment == "churned":
        where.append("m.days_since > 180")

    sql = f"""
    WITH base AS (
        SELECT customer_id,
               MAX(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)),'')) AS b_name,
               MAX(NULLIF(phone,''))   AS b_phone,
               MAX(NULLIF(email,''))   AS b_email,
               MAX(NULLIF(country,'')) AS b_country,
               SUM(COALESCE(total_orders,0))    AS b_orders,
               SUM(COALESCE(total_spend_kes,0)) AS b_spend,
               MAX(last_order_date)    AS b_last
        FROM all_customers GROUP BY customer_id
    ),
    merged AS (
        SELECT COALESCE(cc.customer_id, b.customer_id) AS customer_id,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', cc.first_name, cc.last_name)),''), b.b_name) AS name,
               COALESCE(NULLIF(cc.phone,''), b.b_phone) AS phone,
               COALESCE(NULLIF(cc.email,''), b.b_email) AS email,
               b.b_country AS country,
               COALESCE(cc.brand_code,'vivo') AS brand_code,
               COALESCE(b.b_orders,0)  AS total_orders,
               COALESCE(b.b_spend,0)   AS total_spend_kes,
               b.b_last AS last_order_date,
               COALESCE(cc.is_manual,false) AS is_manual,
               CASE WHEN b.b_last ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}'
                    THEN (CURRENT_DATE - b.b_last::date) END AS days_since
        FROM base b FULL OUTER JOIN crm_customer cc ON cc.customer_id = b.customer_id
    )
    SELECT m.customer_id, m.name, m.phone, m.email, m.country, m.brand_code,
           m.total_orders, m.total_spend_kes, m.last_order_date, m.is_manual, m.days_since,
           le.tier, le.points_balance
    FROM merged m
    LEFT JOIN crm_loyalty_enrolment le ON le.customer_id = m.customer_id
    WHERE {" AND ".join(where)}
    ORDER BY m.total_spend_kes DESC NULLS LAST, m.name NULLS LAST
    LIMIT %(limit)s OFFSET %(offset)s
    """
    params["limit"] = limit
    params["offset"] = offset
    rows = _users_exec(sql, params, fetch=True) or []
    # Attach tags for this page of customers.
    ids = [r["customer_id"] for r in rows]
    tags_by_cust = {}
    if ids:
        trows = _users_exec(
            "SELECT ct.customer_id, t.id, t.name, t.color FROM crm_customer_tags ct "
            "JOIN crm_tags t ON t.id = ct.tag_id WHERE ct.customer_id = ANY(%s)",
            (ids,), fetch=True) or []
        for tr in trows:
            tags_by_cust.setdefault(tr["customer_id"], []).append(
                {"id": tr["id"], "name": tr["name"], "color": tr["color"]})
    for r in rows:
        r["tags"] = tags_by_cust.get(r["customer_id"], [])
        if r.get("total_spend_kes") is not None:
            r["total_spend_kes"] = float(r["total_spend_kes"])
    return {"customers": rows, "count": len(rows), "limit": limit, "offset": offset}


@app.get("/api/crm/customers/{customer_id}")
def crm_customer_detail(customer_id: str, request: Request):
    base = _users_exec(
        "SELECT customer_id, "
        "MAX(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)),'')) AS name, "
        "MAX(NULLIF(phone,'')) AS phone, MAX(NULLIF(email,'')) AS email, "
        "MAX(NULLIF(country,'')) AS country, MAX(NULLIF(city,'')) AS city, "
        "MAX(NULLIF(preferred_size,'')) AS preferred_size, "
        "SUM(COALESCE(total_orders,0)) AS total_orders, "
        "SUM(COALESCE(total_spend_kes,0)) AS total_spend_kes, "
        "MAX(last_order_date) AS last_order_date, MIN(first_order_date) AS first_order_date "
        "FROM all_customers WHERE customer_id=%s GROUP BY customer_id",
        (customer_id,), fetch=True)
    ext = _users_exec("SELECT * FROM crm_customer WHERE customer_id=%s", (customer_id,), fetch=True)
    if not base and not ext:
        return JSONResponse({"detail": "Customer not found"}, status_code=404)
    b = base[0] if base else {}
    e = ext[0] if ext else {}
    profile = {
        "customer_id": customer_id,
        "name": (((e.get("first_name") or "") + " " + (e.get("last_name") or "")).strip()
                 or b.get("name") or ""),
        "first_name": e.get("first_name"),
        "last_name": e.get("last_name"),
        "phone": e.get("phone") or b.get("phone"),
        "email": e.get("email") or b.get("email"),
        "country": b.get("country"),
        "city": b.get("city"),
        "brand_code": e.get("brand_code") or "vivo",
        "dob": e.get("dob"),
        "preferred_size": e.get("preferred_size") or b.get("preferred_size"),
        "preferred_style": e.get("preferred_style"),
        "preferred_channel": e.get("preferred_channel"),
        "store_affinity": e.get("store_affinity"),
        "consent_marketing": bool(e.get("consent_marketing")),
        "consent_data_processing": bool(e.get("consent_data_processing")),
        "notes": e.get("notes"),
        "is_manual": bool(e.get("is_manual")),
        "total_orders": int(b.get("total_orders") or 0),
        "total_spend_kes": float(b.get("total_spend_kes") or 0),
        "first_order_date": b.get("first_order_date"),
        "last_order_date": b.get("last_order_date"),
    }
    # Recent transactions (aggregate per order, most recent 20).
    txns = _users_exec(
        "SELECT s.order_id, MAX(s.sale_date) AS sale_date, MAX(s.pos_location_name) AS pos_location, "
        "MAX(s.channel) AS channel, MAX(s.country) AS country, "
        "ROUND(SUM(s.total_sales_kes::numeric),0) AS amount_kes, "
        "SUM(COALESCE(s.ordered_item_quantity,0)) AS units "
        "FROM all_sales s WHERE s.customer_id=%s "
        "AND s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda') "
        "GROUP BY s.order_id ORDER BY MAX(s.sale_date) DESC NULLS LAST LIMIT 20",
        (customer_id,), fetch=True) or []
    for t in txns:
        t["amount_kes"] = float(t["amount_kes"]) if t.get("amount_kes") is not None else 0.0
    tags = _users_exec(
        "SELECT t.id, t.name, t.color FROM crm_customer_tags ct JOIN crm_tags t ON t.id=ct.tag_id "
        "WHERE ct.customer_id=%s ORDER BY t.name", (customer_id,), fetch=True) or []
    tasks = _users_exec(
        "SELECT * FROM crm_tasks WHERE customer_id=%s ORDER BY (status='done'), due_date NULLS LAST, created_at DESC LIMIT 50",
        (customer_id,), fetch=True) or []
    interactions = _users_exec(
        "SELECT * FROM crm_interactions WHERE customer_id=%s ORDER BY created_at DESC LIMIT 50",
        (customer_id,), fetch=True) or []
    tickets = _users_exec(
        "SELECT id, ticket_number, subject, status, priority, inbound_channel, issue_category, "
        "escalation_level, product_sku, sla_breached, created_at, "
        "(LOWER(issue_category) = ANY(%s)) AS is_complaint "
        "FROM crm_tickets WHERE customer_id=%s ORDER BY created_at DESC LIMIT 50",
        (list(CRM_COMPLAINT_CATEGORIES), customer_id), fetch=True) or []
    # Repeat-complaint flags: categories the customer has complained about >= 2x
    # within the configured window (CEM 2.1 — surfaced on the customer card).
    _cfg_rc = _crm_config_dict()
    _rc_days = int(_crm_cfg_num(_cfg_rc, "escalation.repeat_complaint_window_days", 90))
    repeat_complaints = _users_exec(
        "SELECT LOWER(issue_category) AS category, COUNT(*) AS count "
        "FROM crm_tickets WHERE customer_id=%s AND LOWER(issue_category) = ANY(%s) "
        "AND created_at >= (now() - (%s || ' days')::interval) "
        "GROUP BY LOWER(issue_category) HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC",
        (customer_id, list(CRM_COMPLAINT_CATEGORIES), str(_rc_days)), fetch=True) or []
    enrol = _users_exec("SELECT * FROM crm_loyalty_enrolment WHERE customer_id=%s", (customer_id,), fetch=True)
    ledger = _users_exec(
        "SELECT * FROM crm_loyalty_ledger WHERE customer_id=%s ORDER BY created_at DESC LIMIT 25",
        (customer_id,), fetch=True) or []
    redemptions = _users_exec(
        "SELECT * FROM crm_redemptions WHERE customer_id=%s ORDER BY issued_at DESC LIMIT 25",
        (customer_id,), fetch=True) or []
    for rd in redemptions:
        if rd.get("kes_value") is not None:
            rd["kes_value"] = float(rd["kes_value"])
    return {
        "profile": profile,
        "transactions": txns,
        "tags": tags,
        "tasks": tasks,
        "interactions": interactions,
        "tickets": tickets,
        "repeat_complaints": repeat_complaints,
        "loyalty": {
            "enrolment": enrol[0] if enrol else None,
            "ledger": ledger,
            "redemptions": redemptions,
        },
    }


@app.post("/api/crm/customers")
async def crm_customer_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    first = (body.get("first_name") or "").strip()
    last = (body.get("last_name") or "").strip()
    if not first and not last:
        return JSONResponse({"detail": "A first or last name is required"}, status_code=400)
    uid, name, _ = _crm_actor(request)
    cid = "crm:" + secrets.token_hex(8)
    phone = _crm_norm_phone(body.get("phone"))
    _users_exec(
        "INSERT INTO crm_customer (customer_id, brand_code, first_name, last_name, phone, email, "
        "dob, preferred_size, preferred_style, preferred_channel, store_affinity, "
        "consent_marketing, consent_data_processing, notes, is_manual, created_by, updated_by) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true,%s,%s)",
        (cid, _crm_brand(body.get("brand_code")), first, last, phone,
         (body.get("email") or "").strip() or None, body.get("dob"),
         body.get("preferred_size"), body.get("preferred_style"), body.get("preferred_channel"),
         body.get("store_affinity"), bool(body.get("consent_marketing")),
         bool(body.get("consent_data_processing")), body.get("notes"), uid, name))
    _crm_audit("customer", cid, "create", f"manual contact {first} {last}", request)
    return {"ok": True, "customer_id": cid}


@app.patch("/api/crm/customers/{customer_id}")
async def crm_customer_patch(customer_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    uid, name, _ = _crm_actor(request)
    allowed = ["first_name", "last_name", "phone", "email", "dob", "preferred_size",
               "preferred_style", "preferred_channel", "store_affinity", "notes",
               "consent_marketing", "consent_data_processing", "brand_code"]
    fields = {}
    for k in allowed:
        if k in body:
            if k == "phone":
                fields[k] = _crm_norm_phone(body.get(k))
            elif k == "brand_code":
                fields[k] = _crm_brand(body.get(k))
            elif k in ("consent_marketing", "consent_data_processing"):
                fields[k] = bool(body.get(k))
            else:
                fields[k] = body.get(k)
    # Upsert: ensure a row exists then update the touched fields.
    _users_exec(
        "INSERT INTO crm_customer (customer_id, created_by, updated_by) VALUES (%s,%s,%s) "
        "ON CONFLICT (customer_id) DO NOTHING", (customer_id, uid, name))
    if fields:
        sets = ", ".join(f"{k}=%s" for k in fields) + ", updated_by=%s, updated_at=now()"
        vals = list(fields.values()) + [name, customer_id]
        _users_exec(f"UPDATE crm_customer SET {sets} WHERE customer_id=%s", vals)
    _crm_audit("customer", customer_id, "update", ", ".join(fields.keys()), request)
    return {"ok": True, "customer_id": customer_id}


# --- CRM: tags / segments -------------------------------------------------

@app.get("/api/crm/tags")
def crm_tags_list(request: Request):
    brand = _crm_brand(request.query_params.get("brand"), default="")
    if brand:
        rows = _users_exec(
            "SELECT t.*, (SELECT COUNT(*) FROM crm_customer_tags ct WHERE ct.tag_id=t.id) AS member_count "
            "FROM crm_tags t WHERE t.brand_code=%s ORDER BY t.name", (brand,), fetch=True) or []
    else:
        rows = _users_exec(
            "SELECT t.*, (SELECT COUNT(*) FROM crm_customer_tags ct WHERE ct.tag_id=t.id) AS member_count "
            "FROM crm_tags t ORDER BY t.name", fetch=True) or []
    return {"tags": rows}


@app.post("/api/crm/tags")
async def crm_tags_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"detail": "Tag name is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    rows = _users_exec(
        "INSERT INTO crm_tags (name, color, brand_code, created_by) VALUES (%s,%s,%s,%s) "
        "ON CONFLICT (name, brand_code) DO UPDATE SET color=EXCLUDED.color RETURNING *",
        (name, body.get("color") or "#1a5c38", _crm_brand(body.get("brand_code")), uname), fetch=True)
    return {"ok": True, "tag": rows[0] if rows else None}


@app.delete("/api/crm/tags/{tag_id}")
def crm_tags_delete(tag_id: int, request: Request):
    _users_exec("DELETE FROM crm_tags WHERE id=%s", (tag_id,))
    return {"ok": True}


@app.post("/api/crm/tags/{tag_id}/members")
async def crm_tag_add_members(tag_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    ids = body.get("customer_ids") or []
    if not isinstance(ids, list) or not ids:
        return JSONResponse({"detail": "customer_ids[] is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    added = 0
    for cid in ids:
        try:
            _users_exec(
                "INSERT INTO crm_customer_tags (customer_id, tag_id, added_by) VALUES (%s,%s,%s) "
                "ON CONFLICT (customer_id, tag_id) DO NOTHING", (str(cid), tag_id, uname))
            added += 1
        except Exception:
            pass
    return {"ok": True, "added": added}


@app.delete("/api/crm/customers/{customer_id}/tags/{tag_id}")
def crm_tag_remove(customer_id: str, tag_id: int, request: Request):
    _users_exec("DELETE FROM crm_customer_tags WHERE customer_id=%s AND tag_id=%s", (customer_id, tag_id))
    return {"ok": True}


@app.get("/api/crm/segments")
def crm_segments(request: Request):
    """Lightweight, derived target segments (counts) for building lists."""
    cfg = _crm_config_dict()
    vip = _crm_cfg_num(cfg, "loyalty.tier_vip_kes", 300000)
    rows = _users_exec(
        "WITH c AS (SELECT customer_id, SUM(COALESCE(total_orders,0)) AS orders, "
        "SUM(COALESCE(total_spend_kes,0)) AS spend, MAX(last_order_date) AS last "
        "FROM all_customers GROUP BY customer_id), "
        "d AS (SELECT *, CASE WHEN last ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (CURRENT_DATE - last::date) END AS days "
        "FROM c) "
        "SELECT "
        "COUNT(*) FILTER (WHERE orders <= 1) AS new_count, "
        "COUNT(*) FILTER (WHERE orders >= 5) AS loyal_count, "
        "COUNT(*) FILTER (WHERE spend >= %s) AS vip_count, "
        "COUNT(*) FILTER (WHERE days BETWEEN 90 AND 180) AS at_risk_count, "
        "COUNT(*) FILTER (WHERE days > 180) AS churned_count "
        "FROM d", (vip,), fetch=True)
    r = rows[0] if rows else {}
    segs = [
        {"key": "new", "label": "New (≤1 order)", "count": int(r.get("new_count") or 0)},
        {"key": "loyal", "label": "Loyal (5+ orders)", "count": int(r.get("loyal_count") or 0)},
        {"key": "vip", "label": "VIP spend", "count": int(r.get("vip_count") or 0)},
        {"key": "at_risk", "label": "At risk (90–180d)", "count": int(r.get("at_risk_count") or 0)},
        {"key": "churned", "label": "Churned (>180d)", "count": int(r.get("churned_count") or 0)},
    ]
    return {"segments": segs}


# --- CRM: segmentation export + reports (PRD 6.5 / 7.5) -------------------

def _validate_date_param(v):
    """Validate an optional YYYY-MM-DD date param. Returns the string when valid,
    None for empty/missing/invalid (values are always passed as bound params, so an
    ignored invalid value can never reach SQL unparameterised)."""
    s = (v or "").strip()
    if not s:
        return None
    import re as _re
    if not _re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return None
    try:
        from datetime import datetime as _dt
        _dt.strptime(s, "%Y-%m-%d")
    except Exception:
        return None
    return s


def _crm_tier_spend_range(tier, cfg):
    """Map a tier name to a [min_spend, max_spend) KES range for SQL filtering."""
    silver = _crm_cfg_num(cfg, "loyalty.tier_silver_kes", 50000)
    gold = _crm_cfg_num(cfg, "loyalty.tier_gold_kes", 150000)
    vip = _crm_cfg_num(cfg, "loyalty.tier_vip_kes", 300000)
    return {
        "bronze": (0, silver),
        "silver": (silver, gold),
        "gold": (gold, vip),
        "vip": (vip, None),
    }.get((tier or "").strip().lower())


@app.get("/api/crm/segments/export")
def crm_segments_export(request: Request):
    """Combinable-filter customer segmentation export as CSV (PRD 6.5).
    Filters (all optional, combinable): tier, min_orders, max_orders (frequency),
    channel (dominant), store_id, country, affinity (dominant product_type).
    Hard-capped at 10,000 rows."""
    import csv as _csv
    import io as _io
    from fastapi.responses import StreamingResponse
    qp = request.query_params
    cfg = _crm_config_dict()
    where, params = ["1=1"], []

    def _int(v):
        try:
            return int(str(v).strip())
        except Exception:
            return None

    mo = _int(qp.get("min_orders"))
    if mo is not None:
        where.append("COALESCE(ac.total_orders,0) >= %s")
        params.append(mo)
    xo = _int(qp.get("max_orders"))
    if xo is not None:
        where.append("COALESCE(ac.total_orders,0) <= %s")
        params.append(xo)
    if qp.get("store_id"):
        where.append("ac.store_id = %s")
        params.append(qp.get("store_id"))
    if qp.get("country"):
        where.append("ac.country = %s")
        params.append(qp.get("country"))
    tier = (qp.get("tier") or "").strip()
    if tier:
        rng = _crm_tier_spend_range(tier, cfg)
        if rng:
            where.append("COALESCE(ac.total_spend_kes,0) >= %s")
            params.append(rng[0])
            if rng[1] is not None:
                where.append("COALESCE(ac.total_spend_kes,0) < %s")
                params.append(rng[1])

    outer, outer_params = [], []
    affinity = (qp.get("affinity") or "").strip()
    if affinity:
        outer.append("a.product_type = %s")
        outer_params.append(affinity)
    channel = (qp.get("channel") or "").strip()
    if channel:
        outer.append("c.channel = %s")
        outer_params.append(channel)
    outer_sql = (" AND " + " AND ".join(outer)) if outer else ""

    sql = (
        "WITH base AS ("
        "  SELECT ac.customer_id,"
        "         NULLIF(TRIM(CONCAT_WS(' ', ac.first_name, ac.last_name)),'') AS name,"
        "         ac.phone, ac.email, ac.country, ac.store_id,"
        "         COALESCE(ac.total_orders,0) AS total_orders,"
        "         COALESCE(ac.total_spend_kes,0) AS total_spend_kes,"
        "         ac.last_order_date"
        f"  FROM all_customers ac WHERE {' AND '.join(where)}"
        "), "
        "aff AS ("
        "  SELECT customer_id, product_type FROM ("
        "    SELECT customer_id, product_type,"
        "           ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY SUM(COALESCE(net_quantity,0)) DESC NULLS LAST) AS rn"
        "    FROM all_sales WHERE customer_id IN (SELECT customer_id FROM base)"
        "      AND product_type IS NOT NULL AND product_type <> ''"
        "    GROUP BY customer_id, product_type) q WHERE rn = 1"
        "), "
        "ch AS ("
        "  SELECT customer_id, channel FROM ("
        "    SELECT customer_id, channel,"
        "           ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY COUNT(*) DESC) AS rn"
        "    FROM all_sales WHERE customer_id IN (SELECT customer_id FROM base)"
        "      AND channel IS NOT NULL AND channel <> ''"
        "    GROUP BY customer_id, channel) q WHERE rn = 1"
        ") "
        "SELECT b.customer_id, b.name, b.phone, b.email, b.country, b.store_id,"
        "       b.total_orders, b.total_spend_kes, b.last_order_date,"
        "       a.product_type AS top_product_type, c.channel AS top_channel "
        "FROM base b "
        "LEFT JOIN aff a ON a.customer_id = b.customer_id "
        "LEFT JOIN ch c ON c.customer_id = b.customer_id "
        f"WHERE 1=1{outer_sql} "
        "ORDER BY b.total_spend_kes DESC LIMIT 10000"
    )
    rows = _users_exec(sql, tuple(params + outer_params), fetch=True) or []

    buf = _io.StringIO()
    w = _csv.writer(buf)
    w.writerow(["customer_id", "name", "phone", "email", "country", "store_id",
                "total_orders", "total_spend_kes", "tier", "top_product_type",
                "top_channel", "last_order_date"])
    for r in rows:
        tier_val = _crm_tier_for_spend(r.get("total_spend_kes"), cfg)
        w.writerow([
            r.get("customer_id") or "", r.get("name") or "", r.get("phone") or "",
            r.get("email") or "", r.get("country") or "", r.get("store_id") or "",
            int(r.get("total_orders") or 0), float(r.get("total_spend_kes") or 0),
            tier_val, r.get("top_product_type") or "", r.get("top_channel") or "",
            r.get("last_order_date") or "",
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="vfg_segment_export.csv"'})


@app.get("/api/crm/reports/customers-by-segment")
def crm_report_customers_by_segment(request: Request):
    cfg = _crm_config_dict()
    vip = _crm_cfg_num(cfg, "loyalty.tier_vip_kes", 300000)
    rows = _users_exec(
        "WITH c AS (SELECT customer_id, SUM(COALESCE(total_orders,0)) AS orders, "
        "SUM(COALESCE(total_spend_kes,0)) AS spend, MAX(last_order_date) AS last "
        "FROM all_customers GROUP BY customer_id), "
        "d AS (SELECT *, CASE WHEN last ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (CURRENT_DATE - last::date) END AS days FROM c) "
        "SELECT "
        "COUNT(*) FILTER (WHERE orders <= 1) AS new_count, "
        "COALESCE(SUM(spend) FILTER (WHERE orders <= 1),0) AS new_spend, "
        "COUNT(*) FILTER (WHERE orders >= 5) AS loyal_count, "
        "COALESCE(SUM(spend) FILTER (WHERE orders >= 5),0) AS loyal_spend, "
        "COUNT(*) FILTER (WHERE spend >= %s) AS vip_count, "
        "COALESCE(SUM(spend) FILTER (WHERE spend >= %s),0) AS vip_spend, "
        "COUNT(*) FILTER (WHERE days BETWEEN 90 AND 180) AS at_risk_count, "
        "COALESCE(SUM(spend) FILTER (WHERE days BETWEEN 90 AND 180),0) AS at_risk_spend, "
        "COUNT(*) FILTER (WHERE days > 180) AS churned_count, "
        "COALESCE(SUM(spend) FILTER (WHERE days > 180),0) AS churned_spend "
        "FROM d", (vip, vip), fetch=True)
    r = rows[0] if rows else {}
    segs = [
        {"key": "new", "label": "New (≤1 order)", "count": int(r.get("new_count") or 0), "spend_kes": float(r.get("new_spend") or 0)},
        {"key": "loyal", "label": "Loyal (5+ orders)", "count": int(r.get("loyal_count") or 0), "spend_kes": float(r.get("loyal_spend") or 0)},
        {"key": "vip", "label": "VIP spend", "count": int(r.get("vip_count") or 0), "spend_kes": float(r.get("vip_spend") or 0)},
        {"key": "at_risk", "label": "At risk (90–180d)", "count": int(r.get("at_risk_count") or 0), "spend_kes": float(r.get("at_risk_spend") or 0)},
        {"key": "churned", "label": "Churned (>180d)", "count": int(r.get("churned_count") or 0), "spend_kes": float(r.get("churned_spend") or 0)},
    ]
    tiers = _users_exec(
        "SELECT tier, COUNT(*) AS n, COALESCE(SUM(points_balance),0) AS pts "
        "FROM crm_loyalty_enrolment GROUP BY tier", fetch=True) or []
    return {"segments": segs, "by_tier": [
        {"tier": t.get("tier") or "Bronze", "members": int(t.get("n") or 0), "points_balance": int(t.get("pts") or 0)}
        for t in tiers]}


@app.get("/api/crm/reports/loyalty-engagement")
def crm_report_loyalty_engagement(request: Request):
    enrol = _users_exec(
        "SELECT COUNT(*) AS members, COALESCE(SUM(points_balance),0) AS bal, "
        "COALESCE(AVG(points_balance),0) AS avg_bal, COALESCE(SUM(points_lifetime),0) AS lifetime "
        "FROM crm_loyalty_enrolment", fetch=True)
    e = enrol[0] if enrol else {}
    by_tier = _users_exec(
        "SELECT tier, COUNT(*) AS n, COALESCE(SUM(points_balance),0) AS pts "
        "FROM crm_loyalty_enrolment GROUP BY tier", fetch=True) or []
    led = _users_exec(
        "SELECT "
        "COALESCE(SUM(points_change) FILTER (WHERE reason='earn'),0) AS earned, "
        "COALESCE(SUM(points_change) FILTER (WHERE reason ILIKE 'redempt%%' OR reason='redemption'),0) AS redeemed, "
        "COALESCE(SUM(points_change) FILTER (WHERE reason='expire'),0) AS expired, "
        "COUNT(DISTINCT customer_id) FILTER (WHERE reason='earn' AND created_at > now() - interval '90 days') AS active_90d "
        "FROM crm_loyalty_ledger", fetch=True)
    l = led[0] if led else {}
    return {
        "summary": {
            "members": int(e.get("members") or 0),
            "points_balance": int(e.get("bal") or 0),
            "avg_balance": round(float(e.get("avg_bal") or 0), 1),
            "points_lifetime": int(e.get("lifetime") or 0),
            "points_earned": int(l.get("earned") or 0),
            "points_redeemed": abs(int(l.get("redeemed") or 0)),
            "points_expired": abs(int(l.get("expired") or 0)),
            "active_members_90d": int(l.get("active_90d") or 0),
        },
        "by_tier": [
            {"tier": t.get("tier") or "Bronze", "members": int(t.get("n") or 0), "points_balance": int(t.get("pts") or 0)}
            for t in by_tier],
    }


@app.get("/api/crm/reports/service-metrics")
def crm_report_service_metrics(request: Request):
    qp = request.query_params
    where, params = ["1=1"], []
    raw_df, raw_dt = qp.get("date_from"), qp.get("date_to")
    df = _validate_date_param(raw_df)
    dt = _validate_date_param(raw_dt)
    if (raw_df and df is None) or (raw_dt and dt is None):
        raise HTTPException(status_code=400, detail="date_from/date_to must be YYYY-MM-DD")
    if df:
        where.append("created_at::date >= %s")
        params.append(df)
    if dt:
        where.append("created_at::date <= %s")
        params.append(dt)
    w = " AND ".join(where)
    p = tuple(params) if params else None
    summ = _users_exec(
        "SELECT COUNT(*) AS total, "
        "COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) AS open, "
        "COUNT(*) FILTER (WHERE status IN ('resolved','closed')) AS closed, "
        "COUNT(*) FILTER (WHERE sla_breached) AS breached, "
        "COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600.0) "
        "  FILTER (WHERE resolved_at IS NOT NULL),0) AS avg_resolution_hours, "
        "COALESCE(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL),0) AS avg_csat, "
        "COUNT(*) FILTER (WHERE csat_score IS NOT NULL) AS csat_responses "
        f"FROM crm_tickets WHERE {w}", p, fetch=True)
    s = summ[0] if summ else {}
    closed = int(s.get("closed") or 0)
    breached = int(s.get("breached") or 0)
    by_channel = _users_exec(
        f"SELECT COALESCE(inbound_channel,'unknown') AS k, COUNT(*) AS n FROM crm_tickets WHERE {w} GROUP BY 1 ORDER BY 2 DESC", p, fetch=True) or []
    by_category = _users_exec(
        f"SELECT COALESCE(issue_category,'enquiry') AS k, COUNT(*) AS n FROM crm_tickets WHERE {w} GROUP BY 1 ORDER BY 2 DESC", p, fetch=True) or []
    by_status = _users_exec(
        f"SELECT COALESCE(status,'open') AS k, COUNT(*) AS n FROM crm_tickets WHERE {w} GROUP BY 1 ORDER BY 2 DESC", p, fetch=True) or []
    by_escalation = _users_exec(
        f"SELECT COALESCE(escalation_level,'associate') AS k, COUNT(*) AS n FROM crm_tickets WHERE {w} GROUP BY 1 ORDER BY 2 DESC", p, fetch=True) or []
    return {
        "summary": {
            "total": int(s.get("total") or 0),
            "open": int(s.get("open") or 0),
            "closed": closed,
            "breached": breached,
            "breach_rate": round((breached / closed) * 100, 1) if closed else 0.0,
            "avg_resolution_hours": round(float(s.get("avg_resolution_hours") or 0), 1),
            "avg_csat": round(float(s.get("avg_csat") or 0), 2),
            "csat_responses": int(s.get("csat_responses") or 0),
        },
        "by_status": [{"key": r.get("k"), "count": int(r.get("n") or 0)} for r in by_status],
        "by_channel": [{"key": r.get("k"), "count": int(r.get("n") or 0)} for r in by_channel],
        "by_category": [{"key": r.get("k"), "count": int(r.get("n") or 0)} for r in by_category],
        "by_escalation": [{"key": r.get("k"), "count": int(r.get("n") or 0)} for r in by_escalation],
    }


# --- CRM: tasks (shared follow-up queue) ----------------------------------

@app.get("/api/crm/tasks")
def crm_tasks_list(request: Request):
    qp = request.query_params
    where, params = ["1=1"], []
    st = (qp.get("status") or "").strip().lower()
    if st == "open":
        where.append("status <> 'done' AND status <> 'cancelled'")
    elif st:
        where.append("status=%s")
        params.append(st)
    if qp.get("assignee"):
        where.append("assignee_user_id=%s")
        params.append(qp.get("assignee"))
    if qp.get("customer_id"):
        where.append("customer_id=%s")
        params.append(qp.get("customer_id"))
    brand = _crm_brand(qp.get("brand"), default="")
    if brand:
        where.append("brand_code=%s")
        params.append(brand)
    rows = _users_exec(
        f"SELECT * FROM crm_tasks WHERE {' AND '.join(where)} "
        "ORDER BY (status='done' OR status='cancelled'), due_date NULLS LAST, created_at DESC LIMIT 500",
        tuple(params) if params else None, fetch=True) or []
    return {"tasks": rows}


@app.post("/api/crm/tasks")
async def crm_tasks_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    title = (body.get("title") or "").strip()
    if not title:
        return JSONResponse({"detail": "Task title is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    assignee = body.get("assignee_user_id")
    assignee_name = body.get("assignee_name")
    if assignee and not assignee_name:
        ar = _users_exec("SELECT name, email FROM app_users WHERE user_id=%s", (assignee,), fetch=True)
        if ar:
            assignee_name = ar[0].get("name") or ar[0].get("email")
    rows = _users_exec(
        "INSERT INTO crm_tasks (customer_id, title, description, due_date, priority, "
        "assignee_user_id, assignee_name, brand_code, created_by, created_by_name) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (body.get("customer_id"), title, body.get("description"), body.get("due_date") or None,
         body.get("priority") or "normal", assignee, assignee_name,
         _crm_brand(body.get("brand_code")), uid, uname), fetch=True)
    return {"ok": True, "id": rows[0]["id"] if rows else None}


@app.patch("/api/crm/tasks/{task_id}")
async def crm_tasks_patch(task_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    fields = {}
    for k in ("title", "description", "due_date", "status", "priority", "assignee_user_id"):
        if k in body:
            fields[k] = body.get(k) or None
    if "assignee_user_id" in fields:
        ar = _users_exec("SELECT name, email FROM app_users WHERE user_id=%s", (fields["assignee_user_id"],), fetch=True)
        fields["assignee_name"] = (ar[0].get("name") or ar[0].get("email")) if ar else None
    if not fields:
        return {"ok": True}
    sets = ", ".join(f"{k}=%s" for k in fields) + ", updated_at=now()"
    vals = list(fields.values()) + [task_id]
    _users_exec(f"UPDATE crm_tasks SET {sets} WHERE id=%s", vals)
    return {"ok": True}


@app.delete("/api/crm/tasks/{task_id}")
def crm_tasks_delete(task_id: int, request: Request):
    _users_exec("DELETE FROM crm_tasks WHERE id=%s", (task_id,))
    return {"ok": True}


# --- CRM: interactions (logged outcomes) ----------------------------------

@app.post("/api/crm/customers/{customer_id}/interactions")
async def crm_interaction_create(customer_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    uid, uname, _ = _crm_actor(request)
    rows = _users_exec(
        "INSERT INTO crm_interactions (customer_id, type, outcome, channel, notes, user_id, user_name) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (customer_id, (body.get("type") or "note"), body.get("outcome"), body.get("channel"),
         body.get("notes"), uid, uname), fetch=True)
    return {"ok": True, "id": rows[0]["id"] if rows else None}


# --- CRM: campaigns -------------------------------------------------------

@app.get("/api/crm/campaigns")
def crm_campaigns_list(request: Request):
    brand = _crm_brand(request.query_params.get("brand"), default="")
    where = "WHERE c.brand_code=%s" if brand else ""
    params = (brand,) if brand else None
    rows = _users_exec(
        "SELECT c.*, "
        "(SELECT COUNT(*) FROM crm_campaign_members m WHERE m.campaign_id=c.id) AS members, "
        "(SELECT COUNT(*) FROM crm_campaign_members m WHERE m.campaign_id=c.id AND m.send_status='sent') AS sent, "
        "(SELECT COUNT(*) FROM crm_campaign_members m WHERE m.campaign_id=c.id AND m.responded) AS responses "
        f"FROM crm_campaigns c {where} ORDER BY c.created_at DESC",
        params, fetch=True) or []
    return {"campaigns": rows}


@app.post("/api/crm/campaigns")
async def crm_campaigns_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"detail": "Campaign name is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    rows = _users_exec(
        "INSERT INTO crm_campaigns (name, brand_code, channel, description, status, created_by, created_by_name) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (name, _crm_brand(body.get("brand_code")), body.get("channel"), body.get("description"),
         body.get("status") or "draft", uid, uname), fetch=True)
    return {"ok": True, "id": rows[0]["id"] if rows else None}


@app.get("/api/crm/campaigns/{campaign_id}")
def crm_campaign_detail(campaign_id: int, request: Request):
    c = _users_exec("SELECT * FROM crm_campaigns WHERE id=%s", (campaign_id,), fetch=True)
    if not c:
        return JSONResponse({"detail": "Campaign not found"}, status_code=404)
    members = _users_exec(
        "SELECT m.*, "
        "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', cc.first_name, cc.last_name)),''), "
        "  (SELECT MAX(NULLIF(TRIM(CONCAT_WS(' ', ac.first_name, ac.last_name)),'')) FROM all_customers ac WHERE ac.customer_id=m.customer_id)) AS name, "
        "COALESCE(cc.phone, (SELECT MAX(NULLIF(ac.phone,'')) FROM all_customers ac WHERE ac.customer_id=m.customer_id)) AS phone, "
        "COALESCE(cc.email, (SELECT MAX(NULLIF(ac.email,'')) FROM all_customers ac WHERE ac.customer_id=m.customer_id)) AS email "
        "FROM crm_campaign_members m LEFT JOIN crm_customer cc ON cc.customer_id=m.customer_id "
        "WHERE m.campaign_id=%s ORDER BY m.added_at DESC LIMIT 1000",
        (campaign_id,), fetch=True) or []
    return {"campaign": c[0], "members": members}


@app.post("/api/crm/campaigns/{campaign_id}/members")
async def crm_campaign_add_members(campaign_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    ids = body.get("customer_ids") or []
    if not isinstance(ids, list) or not ids:
        return JSONResponse({"detail": "customer_ids[] is required"}, status_code=400)
    added = 0
    for cid in ids:
        try:
            _users_exec(
                "INSERT INTO crm_campaign_members (campaign_id, customer_id) VALUES (%s,%s) "
                "ON CONFLICT (campaign_id, customer_id) DO NOTHING", (campaign_id, str(cid)))
            added += 1
        except Exception:
            pass
    return {"ok": True, "added": added}


@app.patch("/api/crm/campaigns/{campaign_id}")
async def crm_campaign_patch(campaign_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    fields = {}
    for k in ("name", "channel", "description", "status", "brand_code"):
        if k in body:
            fields[k] = _crm_brand(body.get(k)) if k == "brand_code" else body.get(k)
    if not fields:
        return {"ok": True}
    sets = ", ".join(f"{k}=%s" for k in fields)
    _users_exec(f"UPDATE crm_campaigns SET {sets} WHERE id=%s", list(fields.values()) + [campaign_id])
    return {"ok": True}


@app.patch("/api/crm/campaigns/{campaign_id}/members/{member_id}")
async def crm_campaign_member_patch(campaign_id: int, member_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    sets, vals = [], []
    if "send_status" in body:
        sets.append("send_status=%s")
        vals.append(body.get("send_status"))
        if body.get("send_status") == "sent":
            sets.append("sent_at=now()")
    if "responded" in body:
        sets.append("responded=%s")
        vals.append(bool(body.get("responded")))
        if body.get("responded"):
            sets.append("responded_at=now()")
    if "response_note" in body:
        sets.append("response_note=%s")
        vals.append(body.get("response_note"))
    if not sets:
        return {"ok": True}
    vals += [member_id, campaign_id]
    _users_exec(f"UPDATE crm_campaign_members SET {', '.join(sets)} WHERE id=%s AND campaign_id=%s", vals)
    return {"ok": True}


@app.post("/api/crm/campaigns/{campaign_id}/mark-sent")
async def crm_campaign_mark_sent(campaign_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    member_ids = body.get("member_ids")
    if isinstance(member_ids, list) and member_ids:
        _users_exec(
            "UPDATE crm_campaign_members SET send_status='sent', sent_at=now() "
            "WHERE campaign_id=%s AND id = ANY(%s) AND send_status<>'sent'",
            (campaign_id, member_ids))
    else:
        _users_exec(
            "UPDATE crm_campaign_members SET send_status='sent', sent_at=now() "
            "WHERE campaign_id=%s AND send_status<>'sent'", (campaign_id,))
    return {"ok": True}


# --- CRM: service tickets -------------------------------------------------

@app.get("/api/crm/tickets")
def crm_tickets_list(request: Request):
    # Lazy SLA-breach escalation sweep (no cron, like points expiry).
    _crm_escalate_overdue()
    qp = request.query_params
    where, params = ["1=1"], []
    st = (qp.get("status") or "").strip().lower()
    if st == "open":
        where.append("status <> 'resolved' AND status <> 'closed'")
    elif st:
        where.append("status=%s")
        params.append(st)
    if qp.get("assigned_to"):
        where.append("assigned_to=%s")
        params.append(qp.get("assigned_to"))
    if qp.get("customer_id"):
        where.append("customer_id=%s")
        params.append(qp.get("customer_id"))
    if qp.get("escalation_level"):
        where.append("escalation_level=%s")
        params.append(qp.get("escalation_level"))
    if (qp.get("complaints_only") or "").lower() in ("1", "true", "yes"):
        where.append("LOWER(issue_category) = ANY(%s)")
        params.append(list(CRM_COMPLAINT_CATEGORIES))
    brand = _crm_brand(qp.get("brand"), default="")
    if brand:
        where.append("brand_code=%s")
        params.append(brand)
    rows = _users_exec(
        f"SELECT t.*, (now() > t.sla_due_at AND t.status NOT IN ('resolved','closed')) AS sla_overdue, "
        "(LOWER(t.issue_category) = ANY(%s)) AS is_complaint, "
        "(SELECT COALESCE(MAX(NULLIF(TRIM(CONCAT_WS(' ', ac.first_name, ac.last_name)),'')),'') "
        " FROM all_customers ac WHERE ac.customer_id=t.customer_id) AS customer_name "
        f"FROM crm_tickets t WHERE {' AND '.join(where)} "
        "ORDER BY (status IN ('resolved','closed')), sla_due_at NULLS LAST, created_at DESC LIMIT 500",
        tuple([list(CRM_COMPLAINT_CATEGORIES)] + params), fetch=True) or []
    return {"tickets": rows}


@app.post("/api/crm/tickets")
async def crm_tickets_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    subject = (body.get("subject") or "").strip()
    if not subject:
        return JSONResponse({"detail": "Subject is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    cfg = _crm_config_dict()
    channel = body.get("inbound_channel") or "in_store"
    priority = body.get("priority") or "normal"
    category = body.get("issue_category")
    customer_id = body.get("customer_id")
    minutes = _crm_sla_minutes(cfg, channel, priority, category)
    assigned = body.get("assigned_to")
    assigned_name = None
    if assigned:
        ar = _users_exec("SELECT name, email FROM app_users WHERE user_id=%s", (assigned,), fetch=True)
        if ar:
            assigned_name = ar[0].get("name") or ar[0].get("email")
    product_sku = (body.get("product_sku") or "").strip() or None
    # Gold/VIP complaints jump straight to Head of CX on intake (CEM 2.1).
    escalation_level = "associate"
    escalation_reason = None
    escalated_at_sql = "NULL"
    is_complaint = _crm_is_complaint(category)
    tier = _crm_customer_tier(customer_id, cfg) if customer_id else "Bronze"
    if is_complaint and tier in ("Gold", "VIP") and int(_crm_cfg_num(cfg, "escalation.gold_vip_auto_head_of_cx", 1)):
        escalation_level = "head_of_cx"
        escalation_reason = f"{tier} member complaint — auto-escalated to Head of CX"
        escalated_at_sql = "now()"
    tnum = "TKT-" + secrets.token_hex(3).upper()
    rows = _users_exec(
        "INSERT INTO crm_tickets (ticket_number, customer_id, brand_code, inbound_channel, "
        "issue_category, subject, priority, assigned_to, assigned_to_name, status, "
        "sla_target_minutes, sla_due_at, created_by, created_by_name, "
        "escalation_level, escalation_reason, escalated_at, product_sku) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'open',%s, now() + (%s || ' minutes')::interval, %s,%s, "
        "%s,%s," + escalated_at_sql + ",%s) RETURNING id, ticket_number",
        (tnum, customer_id, _crm_brand(body.get("brand_code")), channel,
         category, subject, priority, assigned, assigned_name,
         minutes, str(minutes), uid, uname,
         escalation_level, escalation_reason, product_sku), fetch=True)
    tid = rows[0]["id"] if rows else None
    if body.get("description"):
        _users_exec(
            "INSERT INTO crm_ticket_messages (ticket_id, direction, sender_user_id, sender_name, body) "
            "VALUES (%s,'internal',%s,%s,%s)", (tid, uid, uname, body.get("description")))
    if escalation_reason:
        _crm_log_ticket_system(tid, escalation_reason + ".")
    # Repeat-complaint detection (same category in window): note it on the thread.
    repeat = _crm_repeat_complaint_count(customer_id, category, cfg, exclude_ticket_id=tid)
    if repeat >= 1:
        _crm_log_ticket_system(
            tid, f"Repeat complaint: customer has {repeat} prior '{category}' "
            f"complaint(s) in the last {int(_crm_cfg_num(cfg, 'escalation.repeat_complaint_window_days', 90))} days.")
    _crm_audit("ticket", tid, "create",
               f"{category or 'enquiry'} via {channel}" + (f" [SKU {product_sku}]" if product_sku else ""), request)
    return {"ok": True, "id": tid, "ticket_number": rows[0]["ticket_number"] if rows else None,
            "escalation_level": escalation_level, "is_complaint": is_complaint,
            "repeat_complaint": repeat >= 1}


@app.get("/api/crm/tickets/{ticket_id}")
def crm_ticket_detail(ticket_id: int, request: Request):
    t = _users_exec("SELECT * FROM crm_tickets WHERE id=%s", (ticket_id,), fetch=True)
    if not t:
        return JSONResponse({"detail": "Ticket not found"}, status_code=404)
    msgs = _users_exec(
        "SELECT * FROM crm_ticket_messages WHERE ticket_id=%s ORDER BY created_at ASC", (ticket_id,), fetch=True) or []
    return {"ticket": t[0], "messages": msgs}


@app.patch("/api/crm/tickets/{ticket_id}")
async def crm_ticket_patch(ticket_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    cur = _users_exec("SELECT * FROM crm_tickets WHERE id=%s", (ticket_id,), fetch=True)
    if not cur:
        return JSONResponse({"detail": "Ticket not found"}, status_code=404)
    cur = cur[0]
    cfg = _crm_config_dict()
    sets, vals = [], []
    for k in ("status", "priority", "issue_category", "assigned_to", "csat_score", "product_sku"):
        if k in body:
            sets.append(f"{k}=%s")
            vals.append(body.get(k) or None)
    if "assigned_to" in body:
        ar = _users_exec("SELECT name, email FROM app_users WHERE user_id=%s", (body.get("assigned_to"),), fetch=True)
        sets.append("assigned_to_name=%s")
        vals.append((ar[0].get("name") or ar[0].get("email")) if ar else None)
    # If the category changes to/from a complaint category, recompute the SLA.
    if "issue_category" in body and (body.get("issue_category") or "") != (cur.get("issue_category") or ""):
        minutes = _crm_sla_minutes(cfg, cur.get("inbound_channel"), body.get("priority") or cur.get("priority"), body.get("issue_category"))
        sets.append("sla_target_minutes=%s")
        vals.append(minutes)
        sets.append("sla_due_at=created_at + (%s || ' minutes')::interval")
        vals.append(str(minutes))
    now_resolving = body.get("status") in ("resolved", "closed") and cur.get("status") not in ("resolved", "closed")
    if body.get("status") in ("resolved", "closed"):
        sets.append("resolved_at=COALESCE(resolved_at, now())")
        sets.append("sla_breached=(now() > sla_due_at)")
    if not sets:
        return {"ok": True}
    vals.append(ticket_id)
    _users_exec(f"UPDATE crm_tickets SET {', '.join(sets)} WHERE id=%s", vals)
    notify = None
    if now_resolving:
        notify = _crm_notify_resolution(ticket_id, cur, request)
    _crm_audit("ticket", ticket_id, "update", ", ".join(sets and [s.split("=")[0] for s in sets]), request)
    return {"ok": True, "notified": notify}


def _crm_notify_resolution(ticket_id, ticket, request):
    """Closed-loop resolution notification (CEM 2.1): notify the customer that
    their case is resolved via their preferred channel. Real channel delivery
    needs provider creds; for now we log the intent (interaction + system note
    + audit) and stamp resolution_notified_at so it is auditable + idempotent."""
    cid = ticket.get("customer_id")
    channel = ticket.get("inbound_channel") or "in_store"
    if cid:
        pref = _users_exec(
            "SELECT preferred_channel FROM crm_customer WHERE customer_id=%s",
            (cid,), fetch=True)
        if pref and pref[0].get("preferred_channel"):
            channel = pref[0]["preferred_channel"]
    # Idempotent at the DB level: only the request that flips resolution_notified_at
    # from NULL emits the side effects, so concurrent resolves notify exactly once.
    won = _users_exec(
        "UPDATE crm_tickets SET resolution_notified_at=now(), resolution_notify_channel=%s "
        "WHERE id=%s AND resolution_notified_at IS NULL RETURNING id",
        (channel, ticket_id), fetch=True)
    if not won:
        return None
    msg = (f"Case {ticket.get('ticket_number')} resolved — customer notified via {channel} "
           "(logged; real-channel delivery pending provider credentials).")
    _crm_log_ticket_system(ticket_id, msg)
    if cid:
        try:
            _users_exec(
                "INSERT INTO crm_interactions (customer_id, type, outcome, channel, notes, user_id, user_name) "
                "VALUES (%s,'resolution_notice','resolved',%s,%s,%s,%s)",
                (cid, channel, msg, "system", "System"))
        except Exception:
            pass
    _crm_audit("ticket", ticket_id, "resolve_notify", msg, request)
    # Request a per-ticket CSAT survey on resolve (CEM 2.2).
    csat = None
    try:
        t2 = dict(ticket)
        t2["id"] = ticket_id
        csat = _crm_request_ticket_csat(t2)
    except Exception:
        csat = None
    return {"channel": channel, "csat": csat}


@app.post("/api/crm/tickets/{ticket_id}/escalate")
async def crm_ticket_escalate(ticket_id: int, request: Request):
    """Manually escalate a complaint one level up the ladder
    (associate -> team_lead -> head_of_cx), or to an explicit level."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    cur = _users_exec("SELECT * FROM crm_tickets WHERE id=%s", (ticket_id,), fetch=True)
    if not cur:
        return JSONResponse({"detail": "Ticket not found"}, status_code=404)
    cur = cur[0]
    if not _crm_is_complaint(cur.get("issue_category")):
        return JSONResponse(
            {"detail": "Escalation ladder applies to complaint tickets only"}, status_code=400)
    target = (body.get("level") or "").strip().lower()
    if target and target not in CRM_ESCALATION_LADDER:
        return JSONResponse({"detail": "Invalid escalation level"}, status_code=400)
    nxt = target or _crm_next_escalation(cur.get("escalation_level"))
    if not nxt:
        return JSONResponse({"detail": "Already at the highest escalation level"}, status_code=400)
    reason = (body.get("reason") or "").strip() or "Manual escalation"
    _users_exec(
        "UPDATE crm_tickets SET escalation_level=%s, escalated_at=now(), escalation_reason=%s WHERE id=%s",
        (nxt, reason, ticket_id))
    _crm_log_ticket_system(ticket_id, f"Escalated to {nxt}: {reason}")
    _crm_audit("ticket", ticket_id, "escalate", f"{cur.get('escalation_level')} -> {nxt}: {reason}", request)
    return {"ok": True, "escalation_level": nxt}


@app.post("/api/crm/tickets/{ticket_id}/messages")
async def crm_ticket_message(ticket_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    txt = (body.get("body") or "").strip()
    if not txt:
        return JSONResponse({"detail": "Message body is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    _users_exec(
        "INSERT INTO crm_ticket_messages (ticket_id, direction, sender_user_id, sender_name, body) "
        "VALUES (%s,%s,%s,%s,%s)",
        (ticket_id, body.get("direction") or "outbound", uid, uname, txt))
    return {"ok": True}


# --- CRM: CSAT (CEM 2.2) --------------------------------------------------

@app.post("/api/crm/csat/respond")
async def crm_csat_respond(request: Request):
    """Record a CSAT response (score 1-5). Locate the survey by survey_id, or by
    ticket_id (creating the ticket survey if one wasn't requested yet — e.g. an
    in-store agent capturing the score directly). Per-ticket scores also sync to
    crm_tickets.csat_score so the ticket card stays consistent."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        score = int(body.get("score"))
    except Exception:
        return JSONResponse({"detail": "score must be an integer 1-5"}, status_code=400)
    if score < 1 or score > 5:
        return JSONResponse({"detail": "score must be between 1 and 5"}, status_code=400)
    comment = (body.get("comment") or "").strip()[:1000] or None
    sid = body.get("survey_id")
    tid = body.get("ticket_id")
    row = None
    if sid:
        row = _users_exec(
            "UPDATE crm_csat SET score=%s, comment=%s, status='responded', responded_at=now() "
            "WHERE id=%s RETURNING id, ticket_id, survey_type",
            (score, comment, sid), fetch=True)
    elif tid:
        row = _users_exec(
            "UPDATE crm_csat SET score=%s, comment=%s, status='responded', responded_at=now() "
            "WHERE ticket_id=%s AND survey_type='ticket' RETURNING id, ticket_id, survey_type",
            (score, comment, tid), fetch=True)
        if not row:
            # No survey requested yet (e.g. resolved before CSAT wired, or in-store
            # direct capture): create a responded survey from the ticket.
            t = _users_exec("SELECT id, customer_id, brand_code, inbound_channel FROM crm_tickets WHERE id=%s",
                            (tid,), fetch=True)
            if not t:
                return JSONResponse({"detail": "Ticket not found"}, status_code=404)
            t = t[0]
            row = _users_exec(
                "INSERT INTO crm_csat (survey_type, ticket_id, customer_id, brand_code, channel, "
                "score, comment, status, responded_at) "
                "VALUES ('ticket',%s,%s,%s,%s,%s,%s,'responded',now()) "
                "ON CONFLICT (ticket_id) WHERE survey_type='ticket' AND ticket_id IS NOT NULL "
                "DO UPDATE SET score=EXCLUDED.score, comment=EXCLUDED.comment, "
                "status='responded', responded_at=now() "
                "RETURNING id, ticket_id, survey_type",
                (tid, t.get("customer_id"), _crm_brand(t.get("brand_code")),
                 t.get("inbound_channel"), score, comment), fetch=True)
    else:
        return JSONResponse({"detail": "survey_id or ticket_id is required"}, status_code=400)
    if not row:
        return JSONResponse({"detail": "Survey not found"}, status_code=404)
    r = row[0]
    if r.get("ticket_id"):
        _users_exec("UPDATE crm_tickets SET csat_score=%s WHERE id=%s", (score, r["ticket_id"]))
    _crm_audit("csat", r["id"], "respond", f"score {score} ({r.get('survey_type')})", request)
    return {"ok": True, "survey_id": r["id"], "score": score}


@app.get("/api/crm/csat")
def crm_csat_list(request: Request):
    """Recent CSAT surveys (most recent first), optionally filtered by status,
    survey_type, or customer_id."""
    qp = request.query_params
    where, params = ["1=1"], []
    if qp.get("status"):
        where.append("status=%s")
        params.append(qp.get("status").strip().lower())
    if qp.get("survey_type"):
        where.append("survey_type=%s")
        params.append(qp.get("survey_type").strip().lower())
    if qp.get("customer_id"):
        where.append("customer_id=%s")
        params.append(qp.get("customer_id"))
    try:
        limit = min(int(qp.get("limit", 100)), 500)
    except Exception:
        limit = 100
    rows = _users_exec(
        "SELECT c.*, t.ticket_number FROM crm_csat c "
        "LEFT JOIN crm_tickets t ON t.id=c.ticket_id "
        f"WHERE {' AND '.join(where)} ORDER BY c.requested_at DESC LIMIT {limit}",
        tuple(params), fetch=True) or []
    return {"surveys": rows}


@app.get("/api/crm/csat/dashboard")
def crm_csat_dashboard(request: Request):
    """CSAT dashboard (CEM 2.2): summary + breakdowns by store, channel, type,
    and a weekly trend. Runs the lazy post-purchase trigger first. Optional
    date_from/date_to scope requested_at (both required together or 400)."""
    # Lazy post-purchase survey creation (no cron).
    try:
        _crm_trigger_post_purchase_csat()
    except Exception:
        pass
    qp = request.query_params
    df, dt = qp.get("date_from"), qp.get("date_to")
    if bool(df) != bool(dt):
        return JSONResponse({"detail": "date_from and date_to must be provided together"}, status_code=400)
    dwhere, dparams = "", []
    if df and dt:
        dwhere = " AND requested_at::date BETWEEN %s AND %s"
        dparams = [df, dt]
    base = "FROM crm_csat WHERE 1=1" + dwhere
    summ = _users_exec(
        "SELECT COUNT(*) AS requested, "
        "COUNT(*) FILTER (WHERE status='responded') AS responses, "
        "COUNT(*) FILTER (WHERE status='skipped') AS skipped, "
        "ROUND(AVG(score) FILTER (WHERE status='responded')::numeric, 2) AS avg_score, "
        "COUNT(*) FILTER (WHERE score=1) AS s1, COUNT(*) FILTER (WHERE score=2) AS s2, "
        "COUNT(*) FILTER (WHERE score=3) AS s3, COUNT(*) FILTER (WHERE score=4) AS s4, "
        "COUNT(*) FILTER (WHERE score=5) AS s5 " + base,
        tuple(dparams), fetch=True)
    s = summ[0] if summ else {}
    requested = int(s.get("requested") or 0)
    responses = int(s.get("responses") or 0)
    # Eligible = requested minus skipped (skipped surveys were never deliverable).
    eligible = requested - int(s.get("skipped") or 0)
    by_channel = _users_exec(
        "SELECT COALESCE(channel,'(none)') AS channel, "
        "COUNT(*) FILTER (WHERE status='responded') AS responses, "
        "ROUND(AVG(score) FILTER (WHERE status='responded')::numeric,2) AS avg_score "
        + base + " GROUP BY 1 ORDER BY responses DESC", tuple(dparams), fetch=True) or []
    by_store = _users_exec(
        "SELECT COALESCE(store,'(none)') AS store, "
        "COUNT(*) FILTER (WHERE status='responded') AS responses, "
        "ROUND(AVG(score) FILTER (WHERE status='responded')::numeric,2) AS avg_score "
        + base + " AND store IS NOT NULL GROUP BY 1 ORDER BY responses DESC LIMIT 50",
        tuple(dparams), fetch=True) or []
    by_type = _users_exec(
        "SELECT survey_type, COUNT(*) AS requested, "
        "COUNT(*) FILTER (WHERE status='responded') AS responses, "
        "ROUND(AVG(score) FILTER (WHERE status='responded')::numeric,2) AS avg_score "
        + base + " GROUP BY 1 ORDER BY 1", tuple(dparams), fetch=True) or []
    trend = _users_exec(
        "SELECT to_char(date_trunc('week', requested_at),'YYYY-MM-DD') AS week, "
        "COUNT(*) AS requested, "
        "COUNT(*) FILTER (WHERE status='responded') AS responses, "
        "ROUND(AVG(score) FILTER (WHERE status='responded')::numeric,2) AS avg_score "
        + base + " GROUP BY 1 ORDER BY 1 DESC LIMIT 26", tuple(dparams), fetch=True) or []
    return {
        "summary": {
            "requested": requested,
            "responses": responses,
            "skipped": int(s.get("skipped") or 0),
            "response_rate": round(responses / eligible, 4) if eligible > 0 else 0,
            "avg_score": float(s["avg_score"]) if s.get("avg_score") is not None else None,
            "distribution": {str(i): int(s.get(f"s{i}") or 0) for i in range(1, 6)},
        },
        "by_channel": by_channel,
        "by_store": by_store,
        "by_type": by_type,
        "trend": list(reversed(trend)),
    }


# --- CRM: loyalty ---------------------------------------------------------

@app.get("/api/crm/loyalty/summary")
def crm_loyalty_summary(request: Request):
    rows = _users_exec(
        "SELECT tier, COUNT(*) AS members, COALESCE(SUM(points_balance),0) AS points "
        "FROM crm_loyalty_enrolment GROUP BY tier", fetch=True) or []
    by_tier = {r["tier"]: {"members": int(r["members"]), "points": int(r["points"])} for r in rows}
    total_members = sum(v["members"] for v in by_tier.values())
    total_points = sum(v["points"] for v in by_tier.values())
    red = _users_exec(
        "SELECT COUNT(*) FILTER (WHERE code_status='issued') AS open_codes, "
        "COUNT(*) FILTER (WHERE code_status='used') AS used_codes FROM crm_redemptions", fetch=True)
    return {
        "by_tier": by_tier,
        "total_members": total_members,
        "total_points_outstanding": total_points,
        "redemptions": red[0] if red else {},
    }


@app.get("/api/crm/loyalty/redemptions/report")
def crm_loyalty_redemptions_report(
    request: Request,
    date_from: str = Query(default=None),
    date_to:   str = Query(default=None),
):
    # Manager view of loyalty discount-code spend. Two date dimensions are used
    # so the numbers mean what managers expect:
    #   - ISSUED metrics (codes issued, open/outstanding liability, points
    #     redeemed) are scoped by issue date.
    #   - REALIZED spend (codes used, KES discount spent, per-store breakdown)
    #     is scoped by redemption (used_at) date — so a code issued before the
    #     window but redeemed inside it counts as spend in the window.
    # With no range, everything is all-time.
    if bool(date_from) != bool(date_to):
        return JSONResponse(
            {"detail": "Provide both date_from and date_to, or neither"}, status_code=400)

    issued_where = "1=1"
    used_where = "r.code_status='used'"
    iss_params: tuple = ()
    used_params: tuple = ()
    if date_from and date_to:
        issued_where = "r.issued_at::date BETWEEN %s AND %s"
        iss_params = (date_from, date_to)
        used_where = "r.code_status='used' AND r.used_at::date BETWEEN %s AND %s"
        used_params = (date_from, date_to)

    issued = _users_exec(
        "SELECT "
        "COUNT(*) AS total_codes, "
        "COUNT(*) FILTER (WHERE r.code_status='issued') AS open_codes, "
        "COALESCE(SUM(r.kes_value),0) AS kes_issued, "
        "COALESCE(SUM(r.kes_value) FILTER (WHERE r.code_status='issued'),0) AS kes_open, "
        "COALESCE(SUM(r.points_redeemed),0) AS points_redeemed "
        "FROM crm_redemptions r WHERE " + issued_where, iss_params, fetch=True) or [{}]
    iss = issued[0]

    used = _users_exec(
        "SELECT COUNT(*) AS used_codes, COALESCE(SUM(r.kes_value),0) AS kes_used "
        "FROM crm_redemptions r WHERE " + used_where, used_params, fetch=True) or [{}]
    us = used[0]

    by_store = _users_exec(
        "SELECT COALESCE(NULLIF(TRIM(r.used_store_id),''), 'Unattributed') AS store, "
        "COUNT(*) AS used_codes, COALESCE(SUM(r.kes_value),0) AS kes_used "
        "FROM crm_redemptions r WHERE " + used_where + " "
        "GROUP BY 1 ORDER BY kes_used DESC", used_params, fetch=True) or []

    recent = _users_exec(
        "SELECT r.discount_code, r.code_status, r.kes_value, r.points_redeemed, "
        "r.issued_at, r.used_at, r.used_store_id, "
        "COALESCE(m.name, NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')), '')) AS member_name "
        "FROM crm_redemptions r "
        "LEFT JOIN crm_loyalty_member m ON m.customer_id = r.customer_id "
        "LEFT JOIN crm_customer c ON c.customer_id = r.customer_id "
        "WHERE " + issued_where + " ORDER BY r.issued_at DESC LIMIT 100", iss_params, fetch=True) or []

    def _f(v): return float(v) if v is not None else 0.0
    return {
        "summary": {
            "total_codes": int(iss.get("total_codes") or 0),
            "open_codes": int(iss.get("open_codes") or 0),
            "used_codes": int(us.get("used_codes") or 0),
            "kes_issued": _f(iss.get("kes_issued")),
            "kes_used": _f(us.get("kes_used")),
            "kes_open": _f(iss.get("kes_open")),
            "points_redeemed": int(iss.get("points_redeemed") or 0),
        },
        "by_store": [
            {"store": r["store"], "used_codes": int(r["used_codes"]), "kes_used": _f(r["kes_used"])}
            for r in by_store
        ],
        "recent": [
            {
                "discount_code": r["discount_code"],
                "code_status": r["code_status"],
                "kes_value": _f(r["kes_value"]),
                "points_redeemed": int(r["points_redeemed"] or 0),
                "issued_at": r["issued_at"],
                "used_at": r["used_at"],
                "used_store_id": r["used_store_id"],
                "member_name": r.get("member_name"),
            }
            for r in recent
        ],
    }


@app.get("/api/crm/member-messages")
def crm_member_messages_list(request: Request):
    """Staff view of the in-app messages sent to loyalty members, newest first,
    each with audience reach + how many members have read it."""
    rows = _users_exec(
        "SELECT msg.id, msg.audience, msg.brand_code, msg.customer_id, msg.title, "
        "msg.body, msg.created_by_name, msg.active, msg.created_at, msg.publish_at, msg.expires_at, "
        "(SELECT COUNT(*) FROM crm_member_message_read r WHERE r.message_id = msg.id) AS read_count "
        "FROM crm_member_message msg ORDER BY msg.created_at DESC LIMIT 200",
        fetch=True) or []
    # Reach: how many members each broadcast can land on (computed once for 'all').
    total = _users_exec("SELECT COUNT(*) AS n FROM crm_loyalty_member", fetch=True)
    total_members = int(total[0]["n"]) if total else 0
    by_brand_rows = _users_exec(
        "SELECT brand_code, COUNT(*) AS n FROM crm_loyalty_member GROUP BY brand_code",
        fetch=True) or []
    by_brand = {r["brand_code"]: int(r["n"]) for r in by_brand_rows}
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        if r["audience"] == "all":
            reach = total_members
        elif r["audience"] == "brand":
            reach = by_brand.get(r["brand_code"], 0)
        else:
            reach = 1
        pub, exp = r["publish_at"], r["expires_at"]
        if not r["active"]:
            status = "retracted"
        elif pub is not None and pub > now:
            status = "scheduled"
        elif exp is not None and exp <= now:
            status = "expired"
        else:
            status = "active"
        out.append({
            "id": r["id"], "audience": r["audience"], "brand_code": r["brand_code"],
            "customer_id": r["customer_id"], "title": r["title"], "body": r["body"],
            "created_by_name": r["created_by_name"], "active": r["active"],
            "created_at": r["created_at"], "read_count": int(r["read_count"] or 0),
            "reach": reach, "publish_at": pub, "expires_at": exp, "status": status,
        })
    return {"messages": out}


@app.post("/api/crm/member-messages")
async def crm_member_messages_create(request: Request):
    """Staff compose an in-app message/announcement for loyalty members."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    title = (body.get("title") or "").strip()
    text = (body.get("body") or "").strip()
    audience = (body.get("audience") or "all").strip().lower()
    if not title or not text:
        return JSONResponse({"detail": "Title and message are required"}, status_code=400)
    if audience not in ("all", "brand", "member"):
        return JSONResponse({"detail": "Invalid audience"}, status_code=400)
    brand_code = None
    customer_id = None
    if audience == "brand":
        brand_code = _crm_brand(body.get("brand_code"))
    elif audience == "member":
        customer_id = (body.get("customer_id") or "").strip()
        if not customer_id:
            return JSONResponse({"detail": "customer_id is required for a member message"}, status_code=400)
        exists = _users_exec(
            "SELECT 1 FROM crm_loyalty_member WHERE customer_id=%s", (customer_id,), fetch=True)
        if not exists:
            return JSONResponse({"detail": "Loyalty member not found"}, status_code=404)
    # Optional scheduling: publish_at (auto-publish) + expires_at (auto-hide). ISO 8601 UTC.
    from datetime import datetime, timezone
    def _parse_dt(val):
        if val is None or str(val).strip() == "":
            return None
        try:
            dt = datetime.fromisoformat(str(val).replace("Z", "+00:00"))
        except Exception:
            return "ERR"
        # Require a timezone-aware value, then normalize to UTC so all
        # comparisons below (against an aware now) stay valid. A naive
        # datetime would raise TypeError on comparison -> 500, so reject it.
        if dt.tzinfo is None:
            return "ERR"
        return dt.astimezone(timezone.utc)
    publish_at = _parse_dt(body.get("publish_at"))
    expires_at = _parse_dt(body.get("expires_at"))
    if publish_at == "ERR" or expires_at == "ERR":
        return JSONResponse({"detail": "Invalid publish/expiry date"}, status_code=400)
    now = datetime.now(timezone.utc)
    if expires_at is not None and expires_at <= now:
        return JSONResponse({"detail": "Expiry must be in the future"}, status_code=400)
    if publish_at is not None and expires_at is not None and expires_at <= publish_at:
        return JSONResponse({"detail": "Expiry must be after the publish date"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    rows = _users_exec(
        "INSERT INTO crm_member_message (audience, brand_code, customer_id, title, body, created_by, created_by_name, publish_at, expires_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (audience, brand_code, customer_id, title, text, uid, uname, publish_at, expires_at), fetch=True)
    mid = rows[0]["id"] if rows else None
    _crm_audit("member_message", str(mid), "create", f"{audience}: {title}", request)
    return {"ok": True, "id": mid}


@app.delete("/api/crm/member-messages/{message_id}")
def crm_member_messages_delete(message_id: int, request: Request):
    """Retract a message (soft delete) so members stop seeing it."""
    found = _users_exec(
        "SELECT 1 FROM crm_member_message WHERE id=%s", (message_id,), fetch=True)
    if not found:
        return JSONResponse({"detail": "Message not found"}, status_code=404)
    _users_exec("UPDATE crm_member_message SET active=FALSE WHERE id=%s", (message_id,))
    _crm_audit("member_message", str(message_id), "retract", "", request)
    return {"ok": True}


@app.post("/api/crm/loyalty/{customer_id}/enrol")
def crm_loyalty_enrol(customer_id: str, request: Request):
    cfg = _crm_config_dict()
    spend = _crm_rolling_spend(customer_id)
    tier = _crm_tier_for_spend(spend, cfg)
    brand_rows = _users_exec("SELECT brand_code FROM crm_customer WHERE customer_id=%s", (customer_id,), fetch=True)
    brand = (brand_rows[0]["brand_code"] if brand_rows else "vivo")
    _users_exec(
        "INSERT INTO crm_loyalty_enrolment (customer_id, brand_code, tier, tier_updated_at) "
        "VALUES (%s,%s,%s,now()) ON CONFLICT (customer_id) DO UPDATE SET tier=EXCLUDED.tier, tier_updated_at=now()",
        (customer_id, brand, tier))
    _crm_audit("loyalty", customer_id, "enrol", f"tier={tier}", request)
    return {"ok": True, "tier": tier, "rolling_12m_spend_kes": spend}


@app.post("/api/crm/loyalty/{customer_id}/adjust")
async def crm_loyalty_adjust(customer_id: str, request: Request):
    if not _crm_is_admin(request):
        return JSONResponse({"detail": "Admin access required"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        change = int(body.get("points_change"))
    except Exception:
        return JSONResponse({"detail": "points_change (integer) is required"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    reason = body.get("reason") or "admin"
    with _users_tx() as cur:
        cur.execute("SELECT points_balance, points_lifetime FROM crm_loyalty_enrolment WHERE customer_id=%s FOR UPDATE",
                    (customer_id,))
        row = cur.fetchone()
        if not row:
            cur.execute(
                "INSERT INTO crm_loyalty_enrolment (customer_id, points_balance, points_lifetime, tier_updated_at) "
                "VALUES (%s,0,0,now())", (customer_id,))
            bal, life = 0, 0
        else:
            bal, life = int(row["points_balance"]), int(row["points_lifetime"])
        new_bal = bal + change
        if new_bal < 0:
            new_bal = 0
        new_life = life + (change if change > 0 else 0)
        cur.execute("UPDATE crm_loyalty_enrolment SET points_balance=%s, points_lifetime=%s WHERE customer_id=%s",
                    (new_bal, new_life, customer_id))
        cur.execute(
            "INSERT INTO crm_loyalty_ledger (customer_id, points_change, reason, balance_after, created_by) "
            "VALUES (%s,%s,%s,%s,%s)", (customer_id, change, reason, new_bal, uname))
    return {"ok": True, "points_balance": new_bal}


@app.post("/api/crm/loyalty/{customer_id}/redeem")
async def crm_loyalty_redeem(customer_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        points = int(body.get("points"))
    except Exception:
        return JSONResponse({"detail": "points (integer) is required"}, status_code=400)
    cfg = _crm_config_dict()
    floor = int(_crm_cfg_num(cfg, "loyalty.redemption_floor", 200))
    per_kes = _crm_cfg_num(cfg, "loyalty.points_per_kes_redeem", 100) or 100
    if points < floor:
        return JSONResponse({"detail": f"Minimum redemption is {floor} points"}, status_code=400)
    uid, uname, _ = _crm_actor(request)
    code = "VFG-" + secrets.token_hex(4).upper()
    kes_value = round(points / per_kes, 2)
    with _users_tx() as cur:
        cur.execute("SELECT points_balance FROM crm_loyalty_enrolment WHERE customer_id=%s FOR UPDATE", (customer_id,))
        row = cur.fetchone()
        bal = int(row["points_balance"]) if row else 0
        if not row or bal < points:
            cur.connection.rollback()
            return JSONResponse({"detail": f"Insufficient points (balance {bal})"}, status_code=400)
        new_bal = bal - points
        cur.execute("UPDATE crm_loyalty_enrolment SET points_balance=%s WHERE customer_id=%s", (new_bal, customer_id))
        cur.execute(
            "INSERT INTO crm_loyalty_ledger (customer_id, points_change, reason, balance_after, created_by) "
            "VALUES (%s,%s,'redemption',%s,%s)", (customer_id, -points, new_bal, uname))
        cur.execute(
            "INSERT INTO crm_redemptions (customer_id, points_redeemed, kes_value, discount_code, issued_by) "
            "VALUES (%s,%s,%s,%s,%s)", (customer_id, points, kes_value, code, uname))
    return {"ok": True, "discount_code": code, "kes_value": kes_value, "points_balance": new_bal}


@app.post("/api/crm/redemptions/{redemption_id}/mark-used")
async def crm_redemption_mark_used(redemption_id: int, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    _users_exec(
        "UPDATE crm_redemptions SET code_status='used', used_at=now(), used_store_id=%s "
        "WHERE id=%s AND code_status='issued'", (body.get("used_store_id"), redemption_id))
    return {"ok": True}


# --- CRM: till "scan to redeem" (staff-gated, analyst+) -------------------
# Members redeem points online/in-app and receive a discount_code (VFG-XXXXXXXX).
# At the till, staff enter that code to (1) preview its KES value + member, then
# (2) apply it — which marks the code 'used' atomically so it can only be spent
# once. The points were already deducted at issue time; redeeming the code only
# applies the discount and burns the code.

def _redemption_by_code_sql():
    return (
        "SELECT r.id, r.customer_id, r.points_redeemed, r.kes_value, r.discount_code, "
        "r.code_status, r.issued_at, r.used_at, r.used_store_id, "
        "COALESCE(m.name, NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')), '')) AS member_name "
        "FROM crm_redemptions r "
        "LEFT JOIN crm_loyalty_member m ON m.customer_id = r.customer_id "
        "LEFT JOIN crm_customer c ON c.customer_id = r.customer_id "
        "WHERE r.discount_code=%s")


@app.post("/api/crm/loyalty/redeem-code/lookup")
async def crm_redeem_code_lookup(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    code = (body.get("code") or "").strip().upper()
    if not code:
        return JSONResponse({"detail": "code is required"}, status_code=400)
    rows = _users_exec(_redemption_by_code_sql(), (code,), fetch=True)
    if not rows:
        return JSONResponse({"detail": "No redemption matches that code"}, status_code=404)
    r = rows[0]
    return {
        "ok": True,
        "redemption_id": r["id"],
        "discount_code": r["discount_code"],
        "customer_id": r["customer_id"],
        "member_name": r.get("member_name"),
        "kes_value": float(r["kes_value"]) if r.get("kes_value") is not None else None,
        "points_redeemed": r.get("points_redeemed"),
        "code_status": r["code_status"],
        "issued_at": r.get("issued_at"),
        "used_at": r.get("used_at"),
        "used_store_id": r.get("used_store_id"),
        "redeemable": r["code_status"] == "issued",
    }


@app.post("/api/crm/loyalty/redeem-code/apply")
async def crm_redeem_code_apply(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    code = (body.get("code") or "").strip().upper()
    if not code:
        return JSONResponse({"detail": "code is required"}, status_code=400)
    store_id = (body.get("used_store_id") or "").strip() or None
    with _users_tx() as cur:
        # Lock the redemption row so two tills can't both burn the same code.
        cur.execute(
            "SELECT id, customer_id, points_redeemed, kes_value, code_status, used_at, used_store_id "
            "FROM crm_redemptions WHERE discount_code=%s FOR UPDATE", (code,))
        row = cur.fetchone()
        if not row:
            cur.connection.rollback()
            return JSONResponse({"detail": "No redemption matches that code"}, status_code=404)
        if row["code_status"] != "issued":
            cur.connection.rollback()
            used_at = row["used_at"]
            return JSONResponse(
                {"detail": f"Code already {row['code_status']}",
                 "code_status": row["code_status"],
                 "used_at": used_at.isoformat() if used_at is not None else None,
                 "used_store_id": row["used_store_id"]},
                status_code=409)
        cur.execute(
            "UPDATE crm_redemptions SET code_status='used', used_at=now(), used_store_id=%s WHERE id=%s",
            (store_id, row["id"]))
    cid = row["customer_id"]
    kes_value = float(row["kes_value"]) if row["kes_value"] is not None else None
    _crm_audit("loyalty", cid, "redeem-code",
               f"code={code} kes_value={kes_value if kes_value is not None else '-'} store={store_id or '-'}", request)
    nm = _users_exec(_redemption_by_code_sql(), (code,), fetch=True)
    member_name = nm[0].get("member_name") if nm else None
    return {"ok": True, "redemption_id": row["id"], "discount_code": code,
            "customer_id": cid, "member_name": member_name,
            "kes_value": kes_value, "points_redeemed": row["points_redeemed"]}


@app.post("/api/crm/loyalty/recalc-tiers")
def crm_loyalty_recalc(request: Request):
    if not _crm_is_admin(request):
        return JSONResponse({"detail": "Admin access required"}, status_code=403)
    cfg = _crm_config_dict()
    enrolled = _users_exec("SELECT customer_id FROM crm_loyalty_enrolment", fetch=True) or []
    updated = 0
    for e in enrolled:
        cid = e["customer_id"]
        spend = _crm_rolling_spend(cid)
        tier = _crm_tier_for_spend(spend, cfg)
        _users_exec(
            "UPDATE crm_loyalty_enrolment SET tier=%s, tier_updated_at=now() WHERE customer_id=%s AND tier<>%s",
            (tier, cid, tier))
        updated += 1
    return {"ok": True, "evaluated": updated}


# --- CRM: POS "scan to earn" (staff-gated, analyst+) ----------------------
# A POS operator scans the member's barcode (membership_code) and posts the
# purchase amount; we award points = floor(amount / earn_rate). Idempotent on
# transaction_id so a double-submit (or the sync loop's retries) can't
# double-credit. Writes the append-only ledger + audit trail.

@app.post("/api/crm/loyalty/earn")
async def crm_loyalty_earn(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    code = (body.get("membership_code") or "").strip()
    if not code:
        return JSONResponse({"detail": "membership_code is required"}, status_code=400)
    try:
        amount = float(body.get("amount_kes"))
    except Exception:
        return JSONResponse({"detail": "amount_kes (number) is required"}, status_code=400)
    if amount <= 0:
        return JSONResponse({"detail": "amount_kes must be positive"}, status_code=400)
    rows = _users_exec(
        "SELECT * FROM crm_loyalty_member WHERE membership_code=%s", (code,), fetch=True)
    if not rows:
        return JSONResponse({"detail": "No loyalty member matches that code"}, status_code=404)
    m = rows[0]
    cid = m["customer_id"]
    txn = (body.get("transaction_id") or "").strip() or None
    cfg = _crm_config_dict()
    # Expire stale points before crediting: a member who was away past the
    # expiry window loses their old balance; this purchase ("coming back")
    # starts a fresh balance + resets the clock.
    _member_expire_inactive_points(cid, cfg)
    earn_rate = _crm_cfg_num(cfg, "loyalty.earn_rate_kes", 100) or 100
    uid, uname, _ = _crm_actor(request)
    store_id = (body.get("store_id") or "").strip() or None
    with _users_tx() as cur:
        # Idempotency: a ledger row already exists for this transaction_id.
        if txn:
            cur.execute(
                "SELECT balance_after FROM crm_loyalty_ledger "
                "WHERE customer_id=%s AND transaction_id=%s AND reason='earn' LIMIT 1",
                (cid, txn))
            dup = cur.fetchone()
            if dup:
                cur.connection.rollback()
                return {"ok": True, "duplicate": True, "points_awarded": 0,
                        "points_balance": int(dup["balance_after"] or 0),
                        "member_name": m.get("name"), "membership_code": code}
        # Lock the member row and read the authoritative spend INSIDE the tx so
        # concurrent earns (different transaction_ids) can't lose a spend/tier
        # update. The tier going into this purchase drives the earn multiplier
        # (Bronze x1, Silver x2, Gold x3).
        cur.execute(
            "SELECT spend_kes FROM crm_loyalty_member WHERE member_id=%s FOR UPDATE",
            (m["member_id"],))
        mrow = cur.fetchone()
        prior_spend = float((mrow["spend_kes"] if mrow else m.get("spend_kes")) or 0)
        current_tier = _crm_tier_for_spend(prior_spend, cfg)
        multiplier = _crm_earn_multiplier(current_tier, cfg)
        points = int(amount // earn_rate) * multiplier
        cur.execute(
            "SELECT points_balance, points_lifetime FROM crm_loyalty_enrolment "
            "WHERE customer_id=%s FOR UPDATE", (cid,))
        row = cur.fetchone()
        if not row:
            cur.execute(
                "INSERT INTO crm_loyalty_enrolment (customer_id, brand_code, points_balance, points_lifetime, tier_updated_at) "
                "VALUES (%s,%s,0,0,now())", (cid, m.get("brand_code") or "vivo"))
            bal, life = 0, 0
        else:
            bal, life = int(row["points_balance"]), int(row["points_lifetime"])
        new_bal = bal + points
        new_life = life + points
        new_spend = prior_spend + amount
        tier = _crm_tier_for_spend(new_spend, cfg)
        # Insert the ledger row FIRST under the partial-unique idempotency
        # index. If a concurrent request with the same transaction_id already
        # won the race, ON CONFLICT collapses this one to zero rows and we abort
        # the credit entirely (return the existing balance) — so the spend +
        # balance updates below never double-apply.
        if txn:
            cur.execute(
                "INSERT INTO crm_loyalty_ledger (customer_id, transaction_id, points_change, reason, balance_after, created_by) "
                "VALUES (%s,%s,%s,'earn',%s,%s) "
                "ON CONFLICT (customer_id, transaction_id) WHERE reason='earn' AND transaction_id IS NOT NULL "
                "DO NOTHING RETURNING id",
                (cid, txn, points, new_bal, uname))
            if cur.fetchone() is None:
                # Lost the race: another request already credited this txn.
                cur.connection.rollback()
                dup_bal = _users_exec(
                    "SELECT balance_after FROM crm_loyalty_ledger "
                    "WHERE customer_id=%s AND transaction_id=%s AND reason='earn' "
                    "ORDER BY id LIMIT 1",
                    (cid, txn), fetch=True)
                bal_after = int((dup_bal[0]["balance_after"] if dup_bal else bal) or 0)
                return {"ok": True, "duplicate": True, "points_awarded": 0,
                        "points_balance": bal_after,
                        "member_name": m.get("name"), "membership_code": code}
        else:
            cur.execute(
                "INSERT INTO crm_loyalty_ledger (customer_id, transaction_id, points_change, reason, balance_after, created_by) "
                "VALUES (%s,%s,%s,'earn',%s,%s)",
                (cid, txn, points, new_bal, uname))
        cur.execute(
            "UPDATE crm_loyalty_enrolment SET points_balance=%s, points_lifetime=%s, "
            "tier=%s, tier_updated_at=now() WHERE customer_id=%s",
            (new_bal, new_life, tier, cid))
        cur.execute(
            "UPDATE crm_loyalty_member SET spend_kes=%s WHERE member_id=%s",
            (new_spend, m["member_id"]))
    _crm_audit("loyalty", cid, "earn",
               f"code={code} amount_kes={amount:.0f} points=+{points} "
               f"(x{multiplier} {current_tier}) store={store_id or '-'}", request)
    return {"ok": True, "points_awarded": points, "points_balance": new_bal,
            "tier": tier, "points_multiplier": multiplier,
            "member_name": m.get("name"), "membership_code": code}


# --- Facebook Page integration (staff-gated, analyst+) --------------------
# Manage the brand's Facebook Page from the cockpit: publish offers, pull Page
# audience + engagement, and read/reply to comments with AI sentiment. Uses the
# Page access token + Page id from secrets (FACEBOOK_PAGE_ACCESS_TOKEN /
# FACEBOOK_PAGE_ID). All calls go through the Graph API and surface the Graph
# error message on failure rather than a generic 500.

_FB_GRAPH = "https://graph.facebook.com/v21.0"


def _fb_token():
    return (os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN") or "").strip()


def _fb_page_id():
    return (os.environ.get("FACEBOOK_PAGE_ID") or "").strip()


def _fb_configured():
    return bool(_fb_token() and _fb_page_id())


# The configured FACEBOOK_PAGE_ACCESS_TOKEN may be a USER token rather than the
# Page token (a very common mistake in Graph API Explorer). A user token cannot
# read a Page's posts/comments or publish on its behalf. When that happens we
# transparently derive the Page access token for FACEBOOK_PAGE_ID from the user
# token (via the Page node's `access_token` field, falling back to /me/accounts).
# If the raw token is already the Page token (or resolution fails) we use it as-is.
# Cache only SUCCESSFUL resolutions, keyed by (raw token, page id) and with a
# TTL so a revoked/rotated derived token is eventually re-resolved. A failed
# resolution is never cached (we fall back to the raw token for that one call),
# so a transient Graph/network error can't get stuck.
_fb_page_token_cache = {"key": None, "resolved": None, "ts": 0.0}
_fb_page_token_lock = threading.Lock()
_FB_PAGE_TOKEN_TTL = 600  # seconds


def _fb_resolve_page_token(raw, page_id):
    if not raw or not page_id:
        return raw
    key = (raw, str(page_id))
    now = time.time()
    with _fb_page_token_lock:
        if (_fb_page_token_cache.get("key") == key
                and _fb_page_token_cache.get("resolved")
                and (now - _fb_page_token_cache.get("ts", 0.0))
                < _FB_PAGE_TOKEN_TTL):
            return _fb_page_token_cache["resolved"]
    resolved = None  # None => resolution failed; fall back to raw, don't cache
    try:
        me = requests.get(_FB_GRAPH + "/me",
                          params={"fields": "id", "access_token": raw},
                          timeout=20)
        if me.ok:
            if str((me.json() or {}).get("id")) == str(page_id):
                resolved = raw  # already the Page token
            else:
                tok = None
                try:
                    pr = requests.get(_FB_GRAPH + "/" + str(page_id),
                                      params={"fields": "access_token",
                                              "access_token": raw}, timeout=20)
                    if pr.ok:
                        tok = (pr.json() or {}).get("access_token")
                except Exception:
                    tok = None
                if not tok:
                    url = _FB_GRAPH + "/me/accounts"
                    params = {"fields": "id,access_token", "limit": 100,
                              "access_token": raw}
                    for _ in range(10):  # bounded pagination
                        rr = requests.get(url, params=params, timeout=20)
                        if not rr.ok:
                            break
                        j = rr.json() or {}
                        for p in (j.get("data") or []):
                            if (str(p.get("id")) == str(page_id)
                                    and p.get("access_token")):
                                tok = p["access_token"]
                                break
                        nxt = (j.get("paging") or {}).get("next")
                        if tok or not nxt:
                            break
                        url, params = nxt, None
                if tok:
                    resolved = tok
    except Exception:
        resolved = None
    if resolved:
        with _fb_page_token_lock:
            _fb_page_token_cache.update(key=key, resolved=resolved, ts=now)
        return resolved
    return raw  # could not resolve this call; surface the real Graph error


def _fb_page_token():
    return _fb_resolve_page_token(_fb_token(), _fb_page_id())


def _fb_error_detail(resp):
    try:
        err = (resp.json() or {}).get("error") or {}
        msg = err.get("message")
        if msg:
            return msg
    except Exception:
        pass
    return f"Facebook request failed ({resp.status_code})"


def _fb_get(path, params=None):
    p = dict(params or {})
    p["access_token"] = _fb_page_token()
    resp = requests.get(_FB_GRAPH.rstrip("/") + "/" + str(path).lstrip("/"),
                        params=p, timeout=30)
    if not resp.ok:
        raise RuntimeError(_fb_error_detail(resp))
    return resp.json()


def _fb_post(path, data=None):
    d = dict(data or {})
    d["access_token"] = _fb_page_token()
    resp = requests.post(_FB_GRAPH.rstrip("/") + "/" + str(path).lstrip("/"),
                         data=d, timeout=30)
    if not resp.ok:
        raise RuntimeError(_fb_error_detail(resp))
    return resp.json()


def _fb_normalize_post(p):
    """Flatten a Graph post node into the shape the UI consumes."""
    reactions = ((p.get("reactions") or {}).get("summary") or {})
    comments = ((p.get("comments") or {}).get("summary") or {})
    shares = (p.get("shares") or {})
    return {
        "id": p.get("id"),
        "message": p.get("message") or "",
        "created_time": p.get("created_time"),
        "permalink_url": p.get("permalink_url"),
        "picture": p.get("full_picture"),
        "like_count": int(reactions.get("total_count") or 0),
        "comment_count": int(comments.get("total_count") or 0),
        "share_count": int(shares.get("count") or 0),
    }


_FB_POST_FIELDS = (
    "message,created_time,permalink_url,full_picture,shares,"
    "comments.summary(true),reactions.summary(true)"
)


def _fb_sentiment(messages):
    """Classify a list of comment strings as positive/negative/neutral via the
    shared LLM. Returns a dict {index: label|None}; never raises."""
    result = {i: None for i in range(len(messages))}
    idxs = [i for i, t in enumerate(messages) if (t or "").strip()]
    if not idxs:
        return result
    try:
        numbered = "\n".join(f"{i}: {messages[i].strip()}" for i in idxs)
        prompt = [
            {"role": "system", "content":
             "You classify the sentiment of customer comments on a fashion "
             "retailer's social posts. Reply ONLY with compact JSON mapping each "
             "id (as a string) to one of \"positive\", \"negative\", or "
             "\"neutral\". No prose."},
            {"role": "user", "content":
             "Classify these comments. Example output: {\"0\":\"positive\","
             "\"1\":\"neutral\"}.\n" + numbered},
        ]
        raw = _chat_llm(prompt, max_tokens=600)
        data = _chat_extract_json(raw) or {}
        for k, v in data.items():
            try:
                ki = int(k)
            except Exception:
                continue
            label = (v or "").lower().strip()
            if ki in result and label in ("positive", "negative", "neutral"):
                result[ki] = label
    except Exception:
        pass
    return result


@app.get("/api/social/status")
async def social_status(request: Request):
    if not _fb_configured():
        return {"configured": False}
    try:
        page = _fb_get(_fb_page_id(),
                       {"fields": "name,fan_count,followers_count,link"})
    except Exception as e:
        return JSONResponse(
            {"configured": True, "ok": False, "detail": str(e)},
            status_code=502)
    return {
        "configured": True,
        "ok": True,
        "page_id": _fb_page_id(),
        "name": page.get("name"),
        "fan_count": page.get("fan_count"),
        "followers_count": page.get("followers_count"),
        "link": page.get("link"),
    }


# Permissions the Social cockpit relies on, in the order shown in the UI.
_FB_REQUIRED_PERMISSIONS = [
    ("pages_show_list", "Identify and list the Page"),
    ("pages_read_engagement", "Read Page info, posts, insights and comments"),
    ("pages_manage_posts", "Publish offers and posts from the cockpit"),
    ("pages_manage_engagement", "Reply to comments on Page posts"),
]


@app.get("/api/social/diagnostics")
async def social_diagnostics(request: Request):
    """One-click connection test for the Facebook Page token. Reports which
    required permissions are granted vs missing so a token can be validated from
    the UI without reading server logs. Strictly read-only: it never posts."""
    token = _fb_token()
    page_id = _fb_page_id()
    out = {
        "configured": bool(token and page_id),
        "token_present": bool(token),
        "page_id_present": bool(page_id),
        "page_id": page_id or None,
        "checks": [],
        "permissions": [],
        "missing": [],
        "ok": False,
    }
    if not token or not page_id:
        miss = []
        if not token:
            miss.append("FACEBOOK_PAGE_ACCESS_TOKEN")
        if not page_id:
            miss.append("FACEBOOK_PAGE_ID")
        out["summary"] = "Not configured. Missing secret(s): " + ", ".join(miss)
        return out

    # 1) Identity probe — confirms the token is a usable Page token and that it
    #    points at the configured Page id.
    identity = {"name": "Token identity (/me)", "ok": False, "detail": ""}
    me = None
    try:
        me = _fb_get("me", {"fields": "id,name"})
        identity["ok"] = True
        identity["detail"] = f"{me.get('name') or 'Unknown'} (id {me.get('id')})"
        out["identity_name"] = me.get("name")
        out["matches_page_id"] = (str(me.get("id")) == str(page_id))
    except Exception as e:
        identity["detail"] = str(e)
    out["checks"].append(identity)

    if me is not None and not out.get("matches_page_id", True):
        out["checks"].append({
            "name": "Token matches FACEBOOK_PAGE_ID",
            "ok": False,
            "detail": (f"Token is for id {me.get('id')} but FACEBOOK_PAGE_ID is "
                       f"{page_id}. This looks like a user token, not the Page "
                       "token. Get the Page token from /me/accounts for this Page."),
        })

    # 2) Read-engagement probe — reading the Page node + a recent post requires
    #    pages_read_engagement (Graph error #10 names it when missing).
    read_ok = False
    read_detail = ""
    try:
        _fb_get(page_id, {"fields": "name,fan_count,followers_count"})
        _fb_get(f"{page_id}/posts", {"limit": 1, "fields": "id"})
        read_ok = True
        read_detail = "Read Page profile and recent posts."
    except Exception as e:
        read_detail = str(e)
    out["checks"].append({"name": "Read Page profile & posts", "ok": read_ok,
                          "detail": read_detail})

    # 3) Resolve granted permissions. The definitive source is /me/permissions;
    #    some Page tokens cannot read it, in which case we infer from the probes.
    granted = None
    declined = set()
    try:
        perms = _fb_get("me/permissions")
        rows = perms.get("data") or []
        if not rows:
            # Empty list is inconclusive (some tokens hide their scopes) — infer.
            raise RuntimeError("no permission rows")
        granted = set()
        for row in rows:
            name = row.get("permission")
            st = (row.get("status") or "").lower()
            if not name:
                continue
            if st == "granted":
                granted.add(name)
            elif st == "declined":
                declined.add(name)
        out["permissions_source"] = "granted_list"
    except Exception:
        granted = None
        out["permissions_source"] = "probe"

    for name, purpose in _FB_REQUIRED_PERMISSIONS:
        if granted is not None:
            if name in granted:
                status = "granted"
            elif name in declined:
                status = "declined"
            else:
                status = "missing"
        else:
            # Probe-based inference (no granted list available for this token).
            if name == "pages_read_engagement":
                status = "granted" if read_ok else "missing"
            elif name == "pages_show_list":
                status = "granted" if identity["ok"] else "unknown"
            else:
                status = "unknown"
        if status in ("missing", "declined"):
            out["missing"].append(name)
        out["permissions"].append({"permission": name, "purpose": purpose,
                                   "status": status})

    reads_ok = read_ok and identity["ok"] and out.get("matches_page_id", True)
    if out["permissions_source"] == "granted_list":
        out["ok"] = bool(reads_ok and not out["missing"])
        if out["ok"]:
            out["summary"] = (f"Connected to {out.get('identity_name') or 'the Page'}. "
                              "All required permissions are granted.")
        elif out["missing"]:
            out["summary"] = ("Missing permission(s): " + ", ".join(out["missing"]) +
                              ". Regenerate a Page token with these scopes.")
        elif not identity["ok"]:
            out["summary"] = "Token is not a valid Page token: " + (identity["detail"] or "identity check failed")
        elif not out.get("matches_page_id", True):
            out["summary"] = ("Scopes are granted but the token is not the Page "
                              "token (its id does not match FACEBOOK_PAGE_ID). "
                              "Use the Page token from /me/accounts.")
        else:
            out["summary"] = "Connection test failed. See checks for details."
    else:
        out["ok"] = bool(reads_ok)
        if out["ok"]:
            out["summary"] = (f"Connected to {out.get('identity_name') or 'the Page'}. "
                              "Page reads work. Posting and reply permissions could not be "
                              "auto-verified from this token; if publishing fails, ensure "
                              "pages_manage_posts and pages_manage_engagement are granted.")
        elif not identity["ok"]:
            out["summary"] = "Token is not a valid Page token: " + (identity["detail"] or "identity check failed")
        elif not out.get("matches_page_id", True):
            out["summary"] = "Token does not match the configured Page id."
        elif not read_ok:
            out["summary"] = ("Cannot read the Page (missing pages_read_engagement): " +
                              (read_detail or "read failed"))
        else:
            out["summary"] = "Connection test failed. See checks for details."
    return out


@app.get("/api/social/insights")
async def social_insights(request: Request):
    if not _fb_configured():
        return JSONResponse({"detail": "Facebook is not configured"}, status_code=400)
    try:
        page = _fb_get(_fb_page_id(),
                       {"fields": "name,fan_count,followers_count"})
        feed = _fb_get(f"{_fb_page_id()}/posts",
                       {"fields": _FB_POST_FIELDS, "limit": 25})
    except Exception as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    posts = [_fb_normalize_post(p) for p in (feed.get("data") or [])]
    reactions = sum(p["like_count"] for p in posts)
    comments = sum(p["comment_count"] for p in posts)
    shares = sum(p["share_count"] for p in posts)
    return {
        "name": page.get("name"),
        "fan_count": page.get("fan_count"),
        "followers_count": page.get("followers_count"),
        "posts_analyzed": len(posts),
        "total_reactions": reactions,
        "total_comments": comments,
        "total_shares": shares,
        "total_engagement": reactions + comments + shares,
    }


@app.get("/api/social/posts")
async def social_posts(request: Request):
    if not _fb_configured():
        return JSONResponse({"detail": "Facebook is not configured"}, status_code=400)
    try:
        limit = int(request.query_params.get("limit") or 12)
    except Exception:
        limit = 12
    limit = max(1, min(limit, 50))
    try:
        feed = _fb_get(f"{_fb_page_id()}/posts",
                       {"fields": _FB_POST_FIELDS, "limit": limit})
    except Exception as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    return {"posts": [_fb_normalize_post(p) for p in (feed.get("data") or [])]}


@app.post("/api/social/post")
async def social_create_post(request: Request):
    if not _fb_configured():
        return JSONResponse({"detail": "Facebook is not configured"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = (body.get("message") or "").strip()
    link = (body.get("link") or "").strip()
    if not message:
        return JSONResponse({"detail": "message is required"}, status_code=400)
    data = {"message": message}
    if link:
        data["link"] = link
    try:
        res = _fb_post(f"{_fb_page_id()}/feed", data)
    except Exception as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    pid = res.get("id")
    _crm_audit("social", pid or "-", "post",
               f"published offer ({len(message)} chars)" + (f" link={link}" if link else ""),
               request)
    return {"ok": True, "id": pid}


@app.get("/api/social/comments")
async def social_comments(request: Request):
    if not _fb_configured():
        return JSONResponse({"detail": "Facebook is not configured"}, status_code=400)
    post_id = (request.query_params.get("post_id") or "").strip()
    if not post_id:
        return JSONResponse({"detail": "post_id is required"}, status_code=400)
    try:
        limit = int(request.query_params.get("limit") or 30)
    except Exception:
        limit = 30
    limit = max(1, min(limit, 100))
    try:
        res = _fb_get(f"{post_id}/comments", {
            "fields": "message,from,created_time,like_count",
            "order": "reverse_chronological",
            "limit": limit,
        })
    except Exception as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    raw = res.get("data") or []
    sentiments = _fb_sentiment([(c.get("message") or "") for c in raw])
    out = []
    for i, c in enumerate(raw):
        frm = c.get("from") or {}
        out.append({
            "id": c.get("id"),
            "message": c.get("message") or "",
            "created_time": c.get("created_time"),
            "like_count": int(c.get("like_count") or 0),
            "from_name": frm.get("name"),
            "sentiment": sentiments.get(i),
        })
    return {"comments": out}


@app.post("/api/social/comments/{comment_id}/reply")
async def social_reply_comment(comment_id: str, request: Request):
    if not _fb_configured():
        return JSONResponse({"detail": "Facebook is not configured"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = (body.get("message") or "").strip()
    if not message:
        return JSONResponse({"detail": "message is required"}, status_code=400)
    try:
        res = _fb_post(f"{comment_id}/comments", {"message": message})
    except Exception as e:
        return JSONResponse({"detail": str(e)}, status_code=502)
    _crm_audit("social", comment_id, "reply",
               f"replied to comment ({len(message)} chars)", request)
    return {"ok": True, "id": res.get("id")}


# --- Customer-facing loyalty (public, member-token auth) -------------------
# These endpoints are NOT behind the staff session gate (see clerk_auth_gate).
# A member enrols with phone + PIN, receives a card token (device session) +
# a scannable membership_code, and can read their tier/points/ledger + redeem
# without any staff login. The ledger is the customer-visible points audit.

def _member_issue_token(member_id):
    """Mint + persist a fresh card token for a member; return the raw token."""
    token = secrets.token_urlsafe(32)
    _users_exec(
        "UPDATE crm_loyalty_member SET card_token_hash=%s, last_login_at=now() WHERE member_id=%s",
        (_member_hash_token(token), member_id))
    return token


def _valid_pin(pin):
    return bool(pin) and pin.isdigit() and 4 <= len(pin) <= 6


@app.post("/api/loyalty/enrol")
async def loyalty_enrol(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name") or "").strip()
    phone = _crm_norm_phone(body.get("phone"))
    pin = (body.get("pin") or "").strip()
    email = (body.get("email") or "").strip() or None
    brand = _crm_brand(body.get("brand_code"))
    if not name:
        return JSONResponse({"detail": "Your name is required"}, status_code=400)
    if not phone:
        return JSONResponse({"detail": "A valid phone number is required"}, status_code=400)
    if not _valid_pin(pin):
        return JSONResponse({"detail": "Choose a 4–6 digit PIN"}, status_code=400)
    if _users_exec("SELECT 1 FROM crm_loyalty_member WHERE phone=%s", (phone,), fetch=True):
        return JSONResponse(
            {"detail": "This phone is already enrolled. Please sign in instead."},
            status_code=409)
    member_id = "mbr:" + secrets.token_hex(8)
    customer_id = member_id  # loyalty card customer key
    code = _gen_membership_code()
    pin_hash = _hash_password(pin)
    _users_exec(
        "INSERT INTO crm_loyalty_member (member_id, customer_id, brand_code, name, phone, email, membership_code, pin_hash) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (member_id, customer_id, brand, name, phone, email, code, pin_hash))
    # Mirror into the staff CRM as a manual contact so the 360 view + loyalty
    # admin can see self-enrolled members alongside transactional customers.
    parts = name.split(" ", 1)
    first, last = parts[0], (parts[1] if len(parts) > 1 else None)
    _users_exec(
        "INSERT INTO crm_customer (customer_id, brand_code, first_name, last_name, phone, email, is_manual, created_by, consent_marketing) "
        "VALUES (%s,%s,%s,%s,%s,%s,TRUE,'loyalty:self',TRUE) ON CONFLICT (customer_id) DO NOTHING",
        (customer_id, brand, first, last, phone, email))
    _users_exec(
        "INSERT INTO crm_loyalty_enrolment (customer_id, brand_code, tier, tier_updated_at) "
        "VALUES (%s,%s,'Bronze',now()) ON CONFLICT (customer_id) DO NOTHING",
        (customer_id, brand))
    _users_exec(
        "INSERT INTO crm_audit (entity, entity_id, action, detail, user_id, user_name) "
        "VALUES ('loyalty',%s,'self_enrol',%s,%s,%s)",
        (customer_id, f"code={code}", member_id, name))
    token = _member_issue_token(member_id)
    m = _users_exec("SELECT * FROM crm_loyalty_member WHERE member_id=%s", (member_id,), fetch=True)[0]
    enrol = _member_enrolment(customer_id)
    return {"ok": True, "token": token, "member": _member_public(m, enrol)}


@app.post("/api/loyalty/login")
async def loyalty_login(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    phone = _crm_norm_phone(body.get("phone"))
    pin = (body.get("pin") or "").strip()
    if not phone or not pin:
        return JSONResponse({"detail": "Phone and PIN are required"}, status_code=400)
    # Brute-force throttle: a 4–6 digit PIN is low-entropy, so cap failures per
    # account. After LOGIN_MAX_FAILS consecutive misses the account is locked for
    # LOGIN_LOCK_MINUTES; a correct PIN resets the counter. Lock + counter live on
    # the member row (survives restarts, per-account). The whole check-and-bump
    # runs inside one advisory-locked tx so concurrent guesses can't race past it.
    LOGIN_MAX_FAILS = 5
    LOGIN_LOCK_MINUTES = 15
    with _users_tx(lock=True) as cur:
        cur.execute(
            "SELECT *, (locked_until IS NOT NULL AND locked_until > now()) AS is_locked "
            "FROM crm_loyalty_member WHERE phone=%s FOR UPDATE", (phone,))
        m = cur.fetchone()
        # Uniform 401 whether or not the phone exists (no account enumeration).
        if not m:
            return JSONResponse({"detail": "Invalid phone or PIN"}, status_code=401)
        if m.get("is_locked"):
            return JSONResponse(
                {"detail": "Too many attempts. Try again later."}, status_code=429)
        if not _verify_password(pin, m["pin_hash"]):
            fails = int(m.get("failed_logins") or 0) + 1
            if fails >= LOGIN_MAX_FAILS:
                cur.execute(
                    "UPDATE crm_loyalty_member SET failed_logins=0, "
                    "locked_until=now() + (%s || ' minutes')::interval WHERE member_id=%s",
                    (LOGIN_LOCK_MINUTES, m["member_id"]))
                return JSONResponse(
                    {"detail": "Too many attempts. Try again later."}, status_code=429)
            cur.execute(
                "UPDATE crm_loyalty_member SET failed_logins=%s WHERE member_id=%s",
                (fails, m["member_id"]))
            return JSONResponse({"detail": "Invalid phone or PIN"}, status_code=401)
        # Success: clear throttle state.
        cur.execute(
            "UPDATE crm_loyalty_member SET failed_logins=0, locked_until=NULL WHERE member_id=%s",
            (m["member_id"],))
    token = _member_issue_token(m["member_id"])
    enrol = _member_enrolment(m["customer_id"])
    m = _users_exec("SELECT * FROM crm_loyalty_member WHERE member_id=%s", (m["member_id"],), fetch=True)[0]
    return {"ok": True, "token": token, "member": _member_public(m, enrol)}


@app.post("/api/loyalty/logout")
async def loyalty_logout(request: Request):
    m = _member_for_request(request)
    if m:
        _users_exec(
            "UPDATE crm_loyalty_member SET card_token_hash=NULL WHERE member_id=%s",
            (m["member_id"],))
    return {"ok": True}


@app.get("/api/loyalty/me")
def loyalty_me(request: Request):
    m = _member_for_request(request)
    if not m:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    cid = m["customer_id"]
    # Lazily expire points if the member has been away past the expiry window.
    _member_expire_inactive_points(cid)
    enrol = _member_enrolment(cid)
    ledger = _users_exec(
        "SELECT points_change, reason, balance_after, transaction_id, created_at "
        "FROM crm_loyalty_ledger WHERE customer_id=%s ORDER BY created_at DESC LIMIT 50",
        (cid,), fetch=True) or []
    redemptions = _users_exec(
        "SELECT points_redeemed, kes_value, discount_code, code_status, issued_at, used_at "
        "FROM crm_redemptions WHERE customer_id=%s ORDER BY issued_at DESC LIMIT 25",
        (cid,), fetch=True) or []
    cfg = _crm_config_dict()
    return {
        "member": _member_public(m, enrol),
        "ledger": ledger,
        "redemptions": redemptions,
        "unread_messages": _member_unread_message_count(cid, m.get("brand_code")),
        "config": {
            "earn_rate_kes": _crm_cfg_num(cfg, "loyalty.earn_rate_kes", 100),
            "points_per_kes_redeem": _crm_cfg_num(cfg, "loyalty.points_per_kes_redeem", 100),
            "redemption_floor": int(_crm_cfg_num(cfg, "loyalty.redemption_floor", 200)),
            "points_expiry_months": int(_crm_cfg_num(cfg, "loyalty.points_expiry_months", 12)),
            "tiers": {
                "Silver": _crm_cfg_num(cfg, "loyalty.tier_silver_kes", 50000),
                "Gold": _crm_cfg_num(cfg, "loyalty.tier_gold_kes", 150000),
                "VIP": _crm_cfg_num(cfg, "loyalty.tier_vip_kes", 300000),
            },
            "earn_multipliers": {
                "Bronze": _crm_earn_multiplier("Bronze", cfg),
                "Silver": _crm_earn_multiplier("Silver", cfg),
                "Gold": _crm_earn_multiplier("Gold", cfg),
                "VIP": _crm_earn_multiplier("VIP", cfg),
            },
        },
    }


def _member_message_match_sql():
    """Shared WHERE for messages visible to a member: broadcast, their brand, or
    addressed to them personally. Columns are qualified with the `msg` alias
    (every call site aliases crm_member_message AS msg) because the read table
    also has a customer_id. Params order: (brand_code, customer_id)."""
    return (
        "msg.active = TRUE "
        "AND (msg.publish_at IS NULL OR msg.publish_at <= now()) "
        "AND (msg.expires_at IS NULL OR msg.expires_at > now()) "
        "AND ("
        "msg.audience = 'all' "
        "OR (msg.audience = 'brand' AND msg.brand_code = %s) "
        "OR (msg.audience = 'member' AND msg.customer_id = %s))"
    )


def _member_unread_message_count(customer_id, brand_code):
    rows = _users_exec(
        "SELECT COUNT(*) AS n FROM crm_member_message msg "
        "WHERE " + _member_message_match_sql() + " "
        "AND NOT EXISTS (SELECT 1 FROM crm_member_message_read r "
        "  WHERE r.message_id = msg.id AND r.customer_id = %s)",
        (brand_code or "vivo", customer_id, customer_id), fetch=True)
    return int(rows[0]["n"]) if rows else 0


@app.get("/api/loyalty/messages")
def loyalty_messages(request: Request):
    """List the in-app messages a loyalty member can see, newest first, each
    flagged read/unread for this member."""
    m = _member_for_request(request)
    if not m:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    cid = m["customer_id"]
    brand = m.get("brand_code") or "vivo"
    rows = _users_exec(
        "SELECT msg.id, msg.title, msg.body, msg.created_at, msg.created_by_name, "
        "(r.message_id IS NOT NULL) AS read "
        "FROM crm_member_message msg "
        "LEFT JOIN crm_member_message_read r "
        "  ON r.message_id = msg.id AND r.customer_id = %s "
        "WHERE " + _member_message_match_sql() + " "
        "ORDER BY msg.created_at DESC LIMIT 100",
        (cid, brand, cid), fetch=True) or []
    unread = sum(1 for x in rows if not x["read"])
    return {"messages": rows, "unread": unread}


@app.post("/api/loyalty/messages/{message_id}/read")
def loyalty_message_read(message_id: int, request: Request):
    """Mark a message read for the calling member (idempotent)."""
    m = _member_for_request(request)
    if not m:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    cid = m["customer_id"]
    brand = m.get("brand_code") or "vivo"
    visible = _users_exec(
        "SELECT 1 FROM crm_member_message msg "
        "WHERE msg.id = %s AND " + _member_message_match_sql(),
        (message_id, brand, cid), fetch=True)
    if not visible:
        return JSONResponse({"detail": "Message not found"}, status_code=404)
    _users_exec(
        "INSERT INTO crm_member_message_read (message_id, customer_id) "
        "VALUES (%s, %s) ON CONFLICT DO NOTHING", (message_id, cid))
    return {"ok": True, "unread": _member_unread_message_count(cid, brand)}


@app.post("/api/loyalty/redeem")
async def loyalty_redeem(request: Request):
    m = _member_for_request(request)
    if not m:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        points = int(body.get("points"))
    except Exception:
        return JSONResponse({"detail": "points (integer) is required"}, status_code=400)
    cfg = _crm_config_dict()
    floor = int(_crm_cfg_num(cfg, "loyalty.redemption_floor", 200))
    per_kes = _crm_cfg_num(cfg, "loyalty.points_per_kes_redeem", 100) or 100
    if points < floor:
        return JSONResponse({"detail": f"Minimum redemption is {floor} points"}, status_code=400)
    cid = m["customer_id"]
    code = "VFG-" + secrets.token_hex(4).upper()
    kes_value = round(points / per_kes, 2)
    with _users_tx() as cur:
        cur.execute("SELECT points_balance FROM crm_loyalty_enrolment WHERE customer_id=%s FOR UPDATE", (cid,))
        row = cur.fetchone()
        bal = int(row["points_balance"]) if row else 0
        if not row or bal < points:
            cur.connection.rollback()
            return JSONResponse({"detail": f"Insufficient points (balance {bal})"}, status_code=400)
        new_bal = bal - points
        cur.execute("UPDATE crm_loyalty_enrolment SET points_balance=%s WHERE customer_id=%s", (new_bal, cid))
        cur.execute(
            "INSERT INTO crm_loyalty_ledger (customer_id, points_change, reason, balance_after, created_by) "
            "VALUES (%s,%s,'redemption',%s,'member:self')", (cid, -points, new_bal))
        cur.execute(
            "INSERT INTO crm_redemptions (customer_id, points_redeemed, kes_value, discount_code, issued_by) "
            "VALUES (%s,%s,%s,%s,'member:self')", (cid, points, kes_value, code))
    return {"ok": True, "discount_code": code, "kes_value": kes_value, "points_balance": new_bal}


# --- Production Tracker -----------------------------------------------------
# A kanban board for the product-development team: every buying order's
# work-in-progress quantity is tracked across the manufacturing stages
# (Buying Order -> Cutting -> ... -> Warehouse) via an append-only movement
# ledger. The schema (stages + seed rows, orders, movements, the two balance
# views) lives in production_tracker_schema.sql and is folded into an idempotent
# startup hook here so a fresh/prod DB gets the tables + stage reference data
# automatically. Endpoints are served under the same gated /api as everything
# else (role gate in clerk_auth_gate: product_development / leadership / admin).

def _ensure_production_tables():
    """Idempotent DDL for the production tracker. Creates the stage reference
    (seeding the canonical stage list + allowed transitions), the order header,
    the append-only movement ledger and the two balance views. Never truncates
    or reseeds existing data — INSERT ... ON CONFLICT DO UPDATE only refreshes
    the stage reference metadata."""
    _users_exec("""
        CREATE TABLE IF NOT EXISTS production_stages (
            stage_key     TEXT PRIMARY KEY,
            stage_name    TEXT NOT NULL,
            sort_order    INT  NOT NULL,
            is_terminal   BOOLEAN NOT NULL DEFAULT FALSE,
            allowed_next  TEXT[] NOT NULL DEFAULT '{}'
        )""")
    _users_exec("""
        INSERT INTO production_stages (stage_key, stage_name, sort_order, is_terminal, allowed_next) VALUES
          ('buying_order',   'Buying Order (Odoo)', 0, FALSE, ARRAY['cutting']),
          ('cutting',        'Cutting & Bundling',  1, FALSE, ARRAY['waiting_sewing']),
          ('waiting_sewing', 'Waiting Sewing',      2, FALSE, ARRAY['sewing']),
          ('sewing',         'Sewing',              3, FALSE, ARRAY['finishing','washing']),
          ('washing',        'Washing',             4, FALSE, ARRAY['finishing','warehouse']),
          ('finishing',      'Finishing',           5, FALSE, ARRAY['warehouse','washing','repairs']),
          ('repairs',        'Repairs',             6, FALSE, ARRAY['sewing','finishing','defects','warehouse']),
          ('defects',        'Defects',             7, FALSE, ARRAY['warehouse','repairs']),
          ('warehouse',      'Warehouse',           8, TRUE,  ARRAY[]::TEXT[])
        ON CONFLICT (stage_key) DO UPDATE
          SET stage_name   = EXCLUDED.stage_name,
              sort_order   = EXCLUDED.sort_order,
              is_terminal  = EXCLUDED.is_terminal,
              allowed_next = EXCLUDED.allowed_next""")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS production_orders (
            order_ref     TEXT PRIMARY KEY,
            odoo_id       BIGINT,
            style_number  TEXT,
            product_name  TEXT,
            product_sku   TEXT,
            order_qty     NUMERIC,
            fabric        TEXT,
            date_ordered  DATE,
            source        TEXT DEFAULT 'odoo',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_prod_orders_style ON production_orders(style_number)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_prod_orders_date  ON production_orders(date_ordered)")
    # Richer buying-order header (added incrementally; idempotent so a fresh/prod
    # DB picks them up without the standalone migration file).
    _users_exec("""
        ALTER TABLE production_orders
            ADD COLUMN IF NOT EXISTS buyer                  TEXT,
            ADD COLUMN IF NOT EXISTS style_name             TEXT,
            ADD COLUMN IF NOT EXISTS expected_delivery_date DATE,
            ADD COLUMN IF NOT EXISTS production_type        TEXT,
            ADD COLUMN IF NOT EXISTS lifecycle_type         TEXT,
            ADD COLUMN IF NOT EXISTS bo_state               TEXT,
            ADD COLUMN IF NOT EXISTS notes_html             TEXT""")
    # Per-colour breakdown of each buying order (one row per BO line).
    _users_exec("""
        CREATE TABLE IF NOT EXISTS production_order_lines (
            id            BIGSERIAL PRIMARY KEY,
            order_ref     TEXT NOT NULL REFERENCES production_orders(order_ref) ON DELETE CASCADE,
            odoo_line_id  BIGINT,
            product_sku   TEXT,
            product_name  TEXT,
            colour        TEXT,
            total_qty     NUMERIC,
            planned_qty   NUMERIC,
            remaining_qty NUMERIC,
            line_state    TEXT,
            UNIQUE (order_ref, odoo_line_id)
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_pol_order ON production_order_lines(order_ref)")
    # Per-size breakdown (the "variant breakdown" under each colour line): one row
    # per (BO line x size). size + product_sku are parsed from the Odoo variant
    # label during sync. Lets the report build a colour x size matrix.
    _users_exec("""
        CREATE TABLE IF NOT EXISTS production_order_variants (
            id              BIGSERIAL PRIMARY KEY,
            odoo_variant_id BIGINT UNIQUE,
            order_ref       TEXT NOT NULL REFERENCES production_orders(order_ref) ON DELETE CASCADE,
            odoo_line_id    BIGINT,
            product_sku     TEXT,
            variant_name    TEXT,
            colour          TEXT,
            size            TEXT,
            qty             NUMERIC
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_pov_order ON production_order_variants(order_ref)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_pov_line  ON production_order_variants(odoo_line_id)")
    _users_exec("""
        CREATE TABLE IF NOT EXISTS stage_movements (
            id          BIGSERIAL PRIMARY KEY,
            order_ref   TEXT NOT NULL REFERENCES production_orders(order_ref) ON DELETE CASCADE,
            from_stage  TEXT REFERENCES production_stages(stage_key),
            to_stage    TEXT NOT NULL REFERENCES production_stages(stage_key),
            qty         NUMERIC NOT NULL CHECK (qty > 0),
            moved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            moved_by    TEXT,
            note        TEXT
        )""")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_stage_moves_order ON stage_movements(order_ref)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_stage_moves_to    ON stage_movements(to_stage)")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_stage_moves_from  ON stage_movements(from_stage)")
    # Single-row heartbeat stamped by sync_production_tracker.py on each
    # successful Odoo sync, so the board can surface "last updated from Odoo".
    _users_exec("""
        CREATE TABLE IF NOT EXISTS production_sync_heartbeat (
            id            INT PRIMARY KEY DEFAULT 1,
            last_run_at   TIMESTAMPTZ,
            last_status   TEXT,
            orders_synced INT,
            CONSTRAINT production_sync_heartbeat_single CHECK (id = 1)
        )""")
    _users_exec("""
        CREATE OR REPLACE VIEW v_stage_balances AS
        WITH inbound AS (
            SELECT order_ref, to_stage AS stage, SUM(qty) AS qty_in,
                   MIN(moved_at) AS first_in, MAX(moved_at) AS last_in
            FROM stage_movements
            GROUP BY order_ref, to_stage
        ),
        outbound AS (
            SELECT order_ref, from_stage AS stage, SUM(qty) AS qty_out
            FROM stage_movements
            WHERE from_stage IS NOT NULL
            GROUP BY order_ref, from_stage
        )
        SELECT i.order_ref, i.stage,
               (i.qty_in - COALESCE(o.qty_out, 0)) AS qty_here,
               i.first_in, i.last_in,
               EXTRACT(EPOCH FROM (now() - i.last_in)) / 86400.0 AS days_since_last_in
        FROM inbound i
        LEFT JOIN outbound o ON o.order_ref = i.order_ref AND o.stage = i.stage
        WHERE (i.qty_in - COALESCE(o.qty_out, 0)) > 0""")
    _users_exec("""
        CREATE OR REPLACE VIEW v_wip_summary AS
        SELECT b.stage, s.stage_name, s.sort_order,
               COUNT(DISTINCT b.order_ref) AS orders_here,
               SUM(b.qty_here) AS units_here,
               ROUND(AVG(b.days_since_last_in)::numeric, 1) AS avg_days_in_stage,
               ROUND(MAX(b.days_since_last_in)::numeric, 1) AS oldest_days_in_stage
        FROM v_stage_balances b
        JOIN production_stages s ON s.stage_key = b.stage
        GROUP BY b.stage, s.stage_name, s.sort_order
        ORDER BY s.sort_order""")
    # SKU-level movement tracking. A move can carry the variant SKU (+ size) it
    # applies to so the team can move one colour/size at a time. Legacy rows have
    # NULL sku/size and stay valid — the order-level v_stage_balances above
    # ignores sku, so it keeps summing every order's units correctly regardless
    # of whether the underlying moves are per-SKU or whole-order.
    _users_exec("ALTER TABLE stage_movements ADD COLUMN IF NOT EXISTS sku  TEXT")
    _users_exec("ALTER TABLE stage_movements ADD COLUMN IF NOT EXISTS size TEXT")
    _users_exec("CREATE INDEX IF NOT EXISTS idx_stage_moves_sku ON stage_movements(order_ref, sku)")
    # Sewing line (A–E) captured on each move INTO the sewing stage at the (sku,
    # size) grain. NULL on every non-sewing move and on legacy sewing moves made
    # before lines were captured; repair auto-routing reuses the most recent
    # non-NULL line for that order+sku+size.
    _users_exec("ALTER TABLE stage_movements ADD COLUMN IF NOT EXISTS sewing_line TEXT")
    # Per (order x sku x size x stage) balance — same in/out arithmetic as the
    # order-level view but at the variant grain. NULL sku/size form a single
    # "whole order" bucket (legacy / variant-less orders); the in/out join uses
    # IS NOT DISTINCT FROM so those NULL buckets reconcile too.
    _users_exec("""
        CREATE OR REPLACE VIEW v_stage_sku_balances AS
        WITH inbound AS (
            SELECT order_ref, sku, size, to_stage AS stage,
                   SUM(qty) AS qty_in, MIN(moved_at) AS first_in, MAX(moved_at) AS last_in
            FROM stage_movements
            GROUP BY order_ref, sku, size, to_stage
        ),
        outbound AS (
            SELECT order_ref, sku, size, from_stage AS stage, SUM(qty) AS qty_out
            FROM stage_movements
            WHERE from_stage IS NOT NULL
            GROUP BY order_ref, sku, size, from_stage
        )
        SELECT i.order_ref, i.sku, i.size, i.stage,
               (i.qty_in - COALESCE(o.qty_out, 0)) AS qty_here,
               i.first_in, i.last_in,
               EXTRACT(EPOCH FROM (now() - i.last_in)) / 86400.0 AS days_since_last_in
        FROM inbound i
        LEFT JOIN outbound o
               ON o.order_ref = i.order_ref
              AND o.sku  IS NOT DISTINCT FROM i.sku
              AND o.size IS NOT DISTINCT FROM i.size
              AND o.stage = i.stage
        WHERE (i.qty_in - COALESCE(o.qty_out, 0)) > 0""")


@app.on_event("startup")
def _init_production_store():
    try:
        _ensure_production_tables()
    except Exception as e:
        log.error("Production tracker table init failed: %s", e)


def _production_order_detail(order_ref):
    """One order: header, current per-stage balances, full movement history.
    Returns None when the order_ref is unknown so callers can 404."""
    order_rows = _users_exec(
        "SELECT * FROM production_orders WHERE order_ref = %s",
        (order_ref,), fetch=True)
    if not order_rows:
        return None
    balances = _users_exec("""
        SELECT b.stage, s.stage_name, s.allowed_next, s.is_terminal,
               b.qty_here,
               ROUND(b.days_since_last_in::numeric, 1) AS days_in_stage
        FROM v_stage_balances b
        JOIN production_stages s ON s.stage_key = b.stage
        WHERE b.order_ref = %s
        ORDER BY s.sort_order""", (order_ref,), fetch=True)
    history = _users_exec("""
        SELECT from_stage, to_stage, qty, sku, size, sewing_line, moved_at, moved_by, note
        FROM stage_movements
        WHERE order_ref = %s
        ORDER BY moved_at DESC, id DESC""", (order_ref,), fetch=True)
    # Per-colour lines and the per-size variant breakdown under each colour, so
    # the UI can render "how many colours / what sizes" and a colour x size matrix.
    lines = _users_exec("""
        SELECT colour, product_sku, product_name, odoo_line_id,
               total_qty, planned_qty, remaining_qty, line_state
        FROM production_order_lines
        WHERE order_ref = %s
        ORDER BY total_qty DESC NULLS LAST, colour""", (order_ref,), fetch=True)
    variants = _users_exec("""
        SELECT odoo_line_id, colour, size, product_sku, variant_name, qty
        FROM production_order_variants
        WHERE order_ref = %s
        ORDER BY colour, size""", (order_ref,), fetch=True)
    # Per-SKU (variant) balances — drives the SKU-level mover. colour/variant_name
    # are recovered from the order's variant master by product_sku (one lookup per
    # sku). NULL-sku rows are the legacy/whole-order bucket.
    sku_balances = _users_exec("""
        SELECT sb.stage, s.stage_name, s.sort_order, s.allowed_next, s.is_terminal,
               sb.sku, sb.size, sb.qty_here,
               ROUND(sb.days_since_last_in::numeric, 1) AS days_in_stage,
               v.colour, v.variant_name, sl.sewing_line AS last_sewing_line
        FROM v_stage_sku_balances sb
        JOIN production_stages s ON s.stage_key = sb.stage
        LEFT JOIN LATERAL (
            SELECT colour, variant_name
            FROM production_order_variants
            WHERE order_ref = sb.order_ref AND product_sku = sb.sku
            LIMIT 1
        ) v ON sb.sku IS NOT NULL
        LEFT JOIN LATERAL (
            SELECT sewing_line
            FROM stage_movements
            WHERE order_ref = sb.order_ref AND to_stage = 'sewing'
              AND sewing_line IS NOT NULL
              AND sku  IS NOT DISTINCT FROM sb.sku
              AND size IS NOT DISTINCT FROM sb.size
            ORDER BY moved_at DESC, id DESC
            LIMIT 1
        ) sl ON TRUE
        WHERE sb.order_ref = %s
        ORDER BY s.sort_order, v.colour NULLS LAST, sb.size NULLS LAST, sb.sku""",
        (order_ref,), fetch=True)
    # Stage reference (ordered) so the UI can build the journey stepper / mover
    # without a second round-trip.
    stages = _users_exec("""
        SELECT stage_key, stage_name, sort_order, allowed_next, is_terminal
        FROM production_stages ORDER BY sort_order""", fetch=True)
    return {"order": order_rows[0], "balances": balances, "history": history,
            "lines": lines, "variants": variants,
            "sku_balances": sku_balances, "stages": stages}


@app.get("/api/production/stages")
def production_stages():
    """Stage definitions with live order/unit counts — drives the board columns."""
    rows = _users_exec("""
        SELECT s.stage_key, s.stage_name, s.sort_order,
               s.is_terminal, s.allowed_next,
               COALESCE(w.orders_here, 0)         AS orders_here,
               COALESCE(w.units_here, 0)          AS units_here,
               COALESCE(w.avg_days_in_stage, 0)   AS avg_days_in_stage,
               COALESCE(w.oldest_days_in_stage,0) AS oldest_days_in_stage
        FROM production_stages s
        LEFT JOIN v_wip_summary w ON w.stage = s.stage_key
        ORDER BY s.sort_order""", fetch=True)
    return {"stages": rows}


@app.get("/api/production/board")
def production_board():
    """Every (order x stage) slice that currently holds units — the board cards."""
    rows = _users_exec("""
        SELECT b.order_ref, b.stage, b.qty_here,
               ROUND(b.days_since_last_in::numeric, 1) AS days_in_stage,
               po.style_number, po.product_name, po.order_qty, po.date_ordered
        FROM v_stage_balances b
        JOIN production_orders po ON po.order_ref = b.order_ref
        JOIN production_stages s  ON s.stage_key  = b.stage
        ORDER BY s.sort_order, b.days_since_last_in DESC""", fetch=True)
    return {"cards": rows}


@app.get("/api/production/sync-status")
def production_sync_status():
    """When the production tracker last synced from Odoo.

    Reflects the most recent SUCCESSFUL sync (stamped inside the sync's own
    transaction), not just a page load. `stale` flags a sync older than 2 hours
    so staff can spot a silently broken hourly sync. Returns null fields when no
    sync has run yet (fresh DB)."""
    rows = _users_exec("""
        SELECT last_run_at, last_status, orders_synced,
               EXTRACT(EPOCH FROM (now() - last_run_at)) AS age_seconds
        FROM production_sync_heartbeat WHERE id = 1""", fetch=True)
    if not rows or rows[0].get("last_run_at") is None:
        return {"last_run_at": None, "last_status": None,
                "orders_synced": None, "age_seconds": None, "stale": False}
    r = rows[0]
    age = float(r["age_seconds"]) if r["age_seconds"] is not None else None
    return {
        "last_run_at": r["last_run_at"].isoformat() if r["last_run_at"] else None,
        "last_status": r["last_status"],
        "orders_synced": r["orders_synced"],
        "age_seconds": age,
        "stale": age is not None and age > 7200,
    }


def _production_flow_stages():
    """The stage flow: one row per stage with units, distinct orders & styles in
    it now, its % of all in-progress units, plus the stage's sort order and
    allowed transitions so the UI can draw the arrows. Returns (rows, total)."""
    rows = _users_exec("""
        WITH bal AS (
            SELECT b.stage,
                   SUM(b.qty_here)               AS units,
                   COUNT(DISTINCT b.order_ref)   AS orders,
                   COUNT(DISTINCT po.style_number) AS styles
            FROM v_stage_balances b
            JOIN production_orders po ON po.order_ref = b.order_ref
            GROUP BY b.stage
        )
        SELECT s.stage_key, s.stage_name, s.sort_order, s.is_terminal, s.allowed_next,
               COALESCE(bal.units, 0)  AS units,
               COALESCE(bal.orders, 0) AS orders,
               COALESCE(bal.styles, 0) AS styles
        FROM production_stages s
        LEFT JOIN bal ON bal.stage = s.stage_key
        ORDER BY s.sort_order""", fetch=True)
    total = sum(float(r["units"] or 0) for r in rows)
    for r in rows:
        u = float(r["units"] or 0)
        r["pct"] = round(u / total * 100, 1) if total else 0.0
    return rows, total


@app.get("/api/production/flow")
def production_flow():
    """Overall stage flow for the flow-chart visualization."""
    rows, total = _production_flow_stages()
    return {"stages": rows, "total_units": total}


@app.get("/api/production/expected-drops")
def production_expected_drops():
    """Buying orders bucketed into weekly 'expected drop' windows by their Odoo
    expected_delivery_date — Overdue, the current week + the next 7 weeks, and a
    'Later' catch-all. Only orders that still have units to deliver (order_qty
    minus what already reached the warehouse) are listed. pending_qty drives the
    unit totals; styles count distinct style numbers per bucket."""
    from datetime import datetime as _DT, timedelta as _TD
    from collections import defaultdict as _DD

    rows = _users_exec("""
        WITH wh AS (
            SELECT order_ref, SUM(qty_here) AS wh_qty
            FROM v_stage_balances
            WHERE stage = 'warehouse'
            GROUP BY order_ref
        )
        SELECT po.order_ref, po.style_number, po.style_name, po.product_name,
               po.order_qty, po.expected_delivery_date, po.lifecycle_type,
               COALESCE(wh.wh_qty, 0) AS warehouse_qty,
               GREATEST(po.order_qty - COALESCE(wh.wh_qty, 0), 0) AS pending_qty
        FROM production_orders po
        LEFT JOIN wh ON wh.order_ref = po.order_ref
        WHERE po.expected_delivery_date IS NOT NULL
          AND (po.order_qty - COALESCE(wh.wh_qty, 0)) > 0
        ORDER BY po.expected_delivery_date""", fetch=True)

    # East-Africa (UTC+3) "today" so the week strip aligns with the buyers' calendar.
    today = (_DT.utcnow() + _TD(hours=3)).date()
    this_monday = today - _TD(days=today.weekday())
    WEEKS = 8
    week_starts = [this_monday + _TD(weeks=i) for i in range(WEEKS)]
    after_last = week_starts[-1] + _TD(weeks=1)

    def _mk(key, label, kind, ws=None, we=None):
        return {"key": key, "label": label, "kind": kind,
                "week_start": ws.isoformat() if ws else None,
                "week_end": we.isoformat() if we else None,
                "styles": 0, "units": 0.0, "orders": []}

    overdue = _mk("overdue", "Overdue", "overdue")
    week_buckets = [_mk(ws.isoformat(), None, "week", ws, ws + _TD(days=6))
                    for ws in week_starts]
    later = _mk("later", "Later", "later")
    style_sets = _DD(set)

    for r in rows:
        d = r["expected_delivery_date"]
        ws_mon = d - _TD(days=d.weekday())
        if d < this_monday:
            b = overdue
        elif ws_mon >= after_last:
            b = later
        else:
            b = week_buckets[(ws_mon - this_monday).days // 7]
        b["units"] += float(r["pending_qty"] or 0)
        b["orders"].append({
            "order_ref": r["order_ref"],
            "style_number": r["style_number"],
            "style_name": r["style_name"],
            "product_name": r["product_name"],
            "lifecycle_type": r["lifecycle_type"],
            "order_qty": r["order_qty"],
            "pending_qty": r["pending_qty"],
            "warehouse_qty": r["warehouse_qty"],
            "expected_delivery_date": r["expected_delivery_date"],
        })
        if r["style_number"]:
            style_sets[b["key"]].add(r["style_number"])

    out = []
    if overdue["orders"]:
        out.append(overdue)
    out.extend(week_buckets)
    if later["orders"]:
        out.append(later)
    for b in out:
        b["styles"] = len(style_sets[b["key"]])
        b["units"] = round(b["units"], 2)
    return {"buckets": out, "today": today.isoformat()}


@app.get("/api/production/summary")
def production_summary():
    """Portfolio-level roll-ups for the Production Report: totals plus
    breakdowns by lifecycle type (New / Replenishment / Re-order), production
    type, buying-order state, current WIP stage, and buyer. Plus a flat row per
    buying order (with its colour/size/variant counts and per-stage unit split)
    so the report can list every order and export it without N detail calls."""
    totals = _users_exec("""
        SELECT COUNT(*)                         AS orders,
               COALESCE(SUM(order_qty), 0)      AS units,
               COUNT(DISTINCT style_number)     AS styles
        FROM production_orders""", fetch=True)

    def _grouped(col):
        return _users_exec(f"""
            SELECT COALESCE({col}, 'Unspecified') AS label,
                   COUNT(*)                       AS orders,
                   COALESCE(SUM(order_qty), 0)    AS units
            FROM production_orders
            GROUP BY 1
            ORDER BY units DESC""", fetch=True)

    by_stage = _users_exec("""
        SELECT s.stage_key, s.stage_name, s.sort_order,
               COALESCE(w.orders_here, 0) AS orders,
               COALESCE(w.units_here, 0)  AS units
        FROM production_stages s
        LEFT JOIN v_wip_summary w ON w.stage = s.stage_key
        ORDER BY s.sort_order""", fetch=True)

    by_buyer = _users_exec("""
        SELECT COALESCE(buyer, 'Unspecified') AS label,
               COUNT(*)                       AS orders,
               COALESCE(SUM(order_qty), 0)    AS units
        FROM production_orders
        GROUP BY 1
        ORDER BY units DESC
        LIMIT 30""", fetch=True)

    # One row per buying order with colour/size/variant counts + per-stage units.
    # `sew` rolls up the distinct sewing line(s) every order's pieces ran on (any
    # move INTO sewing carrying a line), so the report can show which line(s) an
    # order is in / has passed through and filter the table by line.
    orders = _users_exec("""
        WITH line_rollup AS (
            SELECT order_ref,
                   COUNT(DISTINCT colour) AS colours,
                   COUNT(*)               AS lines
            FROM production_order_lines
            GROUP BY order_ref
        ),
        var_rollup AS (
            SELECT order_ref,
                   COUNT(*)             AS variants,
                   COUNT(DISTINCT size) AS sizes
            FROM production_order_variants
            GROUP BY order_ref
        ),
        bal AS (
            SELECT b.order_ref,
                   jsonb_object_agg(b.stage, b.qty_here) AS stage_qty,
                   SUM(b.qty_here)                       AS units_in_progress
            FROM v_stage_balances b
            GROUP BY b.order_ref
        ),
        sew AS (
            SELECT order_ref,
                   array_agg(DISTINCT sewing_line ORDER BY sewing_line) AS sewing_lines
            FROM stage_movements
            WHERE to_stage = 'sewing' AND sewing_line IS NOT NULL
            GROUP BY order_ref
        )
        SELECT po.order_ref, po.style_number, po.style_name, po.product_name,
               po.buyer, po.order_qty, po.date_ordered, po.expected_delivery_date,
               po.production_type, po.lifecycle_type, po.bo_state,
               COALESCE(lr.colours, 0)  AS colours,
               COALESCE(vr.sizes, 0)    AS sizes,
               COALESCE(vr.variants, 0) AS variants,
               COALESCE(bal.units_in_progress, 0) AS units_in_progress,
               bal.stage_qty,
               COALESCE(sew.sewing_lines, ARRAY[]::text[]) AS sewing_lines
        FROM production_orders po
        LEFT JOIN line_rollup lr ON lr.order_ref = po.order_ref
        LEFT JOIN var_rollup  vr ON vr.order_ref = po.order_ref
        LEFT JOIN bal            ON bal.order_ref = po.order_ref
        LEFT JOIN sew            ON sew.order_ref = po.order_ref
        ORDER BY po.date_ordered DESC NULLS LAST, po.order_ref DESC""", fetch=True)

    # Load now sitting in the Sewing stage, split by the line each piece ran on
    # (its most recent sewing line) — units + distinct orders/styles per line so
    # supervisors can see how work is balanced across lines A–E.
    by_sewing_line = _users_exec("""
        WITH cur AS (
            SELECT sb.order_ref, sb.sku, sb.size, sb.qty_here, sl.sewing_line
            FROM v_stage_sku_balances sb
            LEFT JOIN LATERAL (
                SELECT sewing_line
                FROM stage_movements
                WHERE order_ref = sb.order_ref AND to_stage = 'sewing'
                  AND sewing_line IS NOT NULL
                  AND sku  IS NOT DISTINCT FROM sb.sku
                  AND size IS NOT DISTINCT FROM sb.size
                ORDER BY moved_at DESC, id DESC
                LIMIT 1
            ) sl ON TRUE
            WHERE sb.stage = 'sewing'
        )
        SELECT COALESCE(c.sewing_line, 'Unspecified') AS label,
               COUNT(DISTINCT c.order_ref)            AS orders,
               COALESCE(SUM(c.qty_here), 0)           AS units,
               COUNT(DISTINCT po.style_number)        AS styles
        FROM cur c
        LEFT JOIN production_orders po ON po.order_ref = c.order_ref
        GROUP BY 1
        ORDER BY (COALESCE(c.sewing_line, 'Unspecified') = 'Unspecified'), label""", fetch=True)

    return {
        "totals": (totals[0] if totals else {"orders": 0, "units": 0, "styles": 0}),
        "by_lifecycle": _grouped("lifecycle_type"),
        "by_production_type": _grouped("production_type"),
        "by_state": _grouped("bo_state"),
        "by_stage": by_stage,
        "by_buyer": by_buyer,
        "by_sewing_line": by_sewing_line,
        "orders": orders,
    }


@app.get("/api/production/orders/{order_ref}")
def production_order(order_ref: str):
    detail = _production_order_detail(order_ref)
    if detail is None:
        return JSONResponse({"detail": f"Order {order_ref} not found"}, status_code=404)
    return detail


SEWING_LINES = ("A", "B", "C", "D", "E")


class _MoveError(Exception):
    """A rejected production move. Carries the user-facing detail + HTTP status."""

    def __init__(self, detail, status_code=400):
        self.detail = detail
        self.status_code = status_code
        super().__init__(detail)


def _derive_prior_sewing_line(cur, order_ref, sku, size):
    """Most recent sewing line recorded for this order (+ sku/size) on a prior
    move INTO sewing. Drives repair auto-routing: a piece returning from Repairs
    goes back to the line it was originally sewn on."""
    cur.execute(
        "SELECT sewing_line FROM stage_movements "
        "WHERE order_ref = %s AND to_stage = 'sewing' AND sewing_line IS NOT NULL "
        "AND sku IS NOT DISTINCT FROM %s AND size IS NOT DISTINCT FROM %s "
        "ORDER BY moved_at DESC, id DESC LIMIT 1",
        (order_ref, sku, size))
    r = cur.fetchone()
    return r["sewing_line"] if r else None


def _resolve_sewing_line(cur, order_ref, from_stage, to_stage, sku, size, supplied):
    """Return the sewing line to record on a move, or None when to_stage is not
    'sewing'. Repairs -> Sewing auto-routes to the piece's original line (falling
    back to a supplied line only when none was ever recorded); every other move
    into Sewing requires an explicit A–E line. Raises _MoveError on anything
    missing or invalid."""
    if to_stage != "sewing":
        return None
    supplied = (supplied or "").strip().upper() or None
    if from_stage == "repairs":
        line = _derive_prior_sewing_line(cur, order_ref, sku, size)
        if not line:
            line = supplied
            if not line:
                raise _MoveError(
                    "No original sewing line is on record for this item — "
                    "please choose a line (A–E).")
    else:
        line = supplied
        if not line:
            raise _MoveError("A sewing line (A–E) is required when moving into Sewing.")
    if line not in SEWING_LINES:
        raise _MoveError("Sewing line must be one of A, B, C, D or E.")
    return line


def _advance_whole_order(cur, order_ref, from_stage, to_stage, supplied_line, moved_by, note):
    """Advance ALL units an order currently holds at from_stage to to_stage in a
    single action, preserving each (sku, size) bucket's grain (so per-variant and
    legacy whole-order orders both move cleanly). Into Sewing: a supplied line
    applies to every bucket, except Repairs -> Sewing where each bucket auto-routes
    to its own original line. Caller owns the transaction; raises _MoveError on
    rejection. Returns the total quantity moved."""
    cur.execute(
        "SELECT 1 FROM production_orders WHERE order_ref = %s FOR UPDATE", (order_ref,))
    if not cur.fetchone():
        raise _MoveError(f"Unknown order: {order_ref}", 404)
    cur.execute(
        "SELECT allowed_next FROM production_stages WHERE stage_key = %s", (from_stage,))
    row = cur.fetchone()
    if not row:
        raise _MoveError(f"Unknown stage: {from_stage}")
    if to_stage not in (row["allowed_next"] or []):
        raise _MoveError(f"Cannot move from {from_stage} to {to_stage}")
    cur.execute(
        "SELECT sku, size, qty_here FROM v_stage_sku_balances "
        "WHERE order_ref = %s AND stage = %s AND qty_here > 0",
        (order_ref, from_stage))
    buckets = cur.fetchall()
    if not buckets:
        raise _MoveError(f"No units are currently at {from_stage}")
    total = 0.0
    for b in buckets:
        qty = float(b["qty_here"])
        if qty <= 0:
            continue
        line = _resolve_sewing_line(
            cur, order_ref, from_stage, to_stage, b["sku"], b["size"], supplied_line)
        cur.execute(
            "INSERT INTO stage_movements "
            "(order_ref, from_stage, to_stage, qty, moved_by, note, sku, size, sewing_line) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (order_ref, from_stage, to_stage, qty, moved_by, note,
             b["sku"], b["size"], line))
        total += qty
    return total


@app.post("/api/production/move")
async def production_move(request: Request):
    """Move a quantity between stages — the board's only writer. Validates that
    the transition is allowed (to_stage in from_stage.allowed_next), that the
    stages differ, and that enough units sit at from_stage, so the ledger can
    never go negative or skip stages. moved_by defaults to the signed-in user."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    order_ref = (body.get("order_ref") or "").strip()
    from_stage = (body.get("from_stage") or "").strip()
    to_stage = (body.get("to_stage") or "").strip()
    note = (body.get("note") or "").strip() or None
    # Optional SKU-level move. When sku is given, validate + record at the
    # variant grain; otherwise it's a whole-order move (legacy shape).
    sku = body.get("sku")
    sku = sku.strip() if isinstance(sku, str) else sku
    sku = sku or None
    size = body.get("size")
    size = size.strip() if isinstance(size, str) else size
    size = size or None
    if not order_ref or not from_stage or not to_stage:
        return JSONResponse(
            {"detail": "order_ref, from_stage and to_stage are required"},
            status_code=400)
    try:
        qty = float(body.get("qty"))
    except (TypeError, ValueError):
        return JSONResponse({"detail": "qty (number) is required"}, status_code=400)
    if qty <= 0:
        return JSONResponse({"detail": "qty must be greater than 0"}, status_code=400)
    if from_stage == to_stage:
        return JSONResponse(
            {"detail": "from_stage and to_stage are the same"}, status_code=400)

    # Attribute the move to the signed-in user unless an explicit name is given.
    u = getattr(request.state, "user", None) or {}
    moved_by = (body.get("moved_by") or "").strip() or (
        u.get("name") or u.get("email") or "unknown")

    with _users_tx() as cur:
        # Serialize concurrent moves on the SAME order so the availability check
        # below and the insert are atomic w.r.t. other movers — two requests for
        # the same (stage, sku) can't both pass the check and over-subscribe.
        cur.execute(
            "SELECT 1 FROM production_orders WHERE order_ref = %s FOR UPDATE",
            (order_ref,))
        if not cur.fetchone():
            cur.connection.rollback()
            return JSONResponse(
                {"detail": f"Unknown order: {order_ref}"}, status_code=404)
        cur.execute(
            "SELECT allowed_next FROM production_stages WHERE stage_key = %s",
            (from_stage,))
        row = cur.fetchone()
        if not row:
            cur.connection.rollback()
            return JSONResponse(
                {"detail": f"Unknown stage: {from_stage}"}, status_code=400)
        if to_stage not in (row["allowed_next"] or []):
            cur.connection.rollback()
            return JSONResponse(
                {"detail": f"Cannot move from {from_stage} to {to_stage}"},
                status_code=400)
        if sku:
            # SKU-level: only as many units of this exact variant at this stage.
            cur.execute(
                "SELECT COALESCE(SUM(qty_here), 0) AS avail "
                "FROM v_stage_sku_balances "
                "WHERE order_ref = %s AND sku IS NOT DISTINCT FROM %s "
                "AND size IS NOT DISTINCT FROM %s AND stage = %s",
                (order_ref, sku, size, from_stage))
            available = float(cur.fetchone()["avail"])
            if qty > available:
                cur.connection.rollback()
                return JSONResponse(
                    {"detail": f"Only {available:g} units of {sku} available at {from_stage}"},
                    status_code=400)
        else:
            cur.execute(
                "SELECT qty_here FROM v_stage_balances WHERE order_ref = %s AND stage = %s",
                (order_ref, from_stage))
            bal = cur.fetchone()
            available = float(bal["qty_here"]) if bal else 0.0
            if qty > available:
                cur.connection.rollback()
                return JSONResponse(
                    {"detail": f"Only {available:g} units available at {from_stage}"},
                    status_code=400)
        try:
            sewing_line = _resolve_sewing_line(
                cur, order_ref, from_stage, to_stage, sku, size,
                body.get("sewing_line"))
        except _MoveError as e:
            cur.connection.rollback()
            return JSONResponse({"detail": e.detail}, status_code=e.status_code)
        cur.execute(
            "INSERT INTO stage_movements "
            "(order_ref, from_stage, to_stage, qty, moved_by, note, sku, size, sewing_line) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (order_ref, from_stage, to_stage, qty, moved_by, note, sku, size, sewing_line))

    # Return the order's fresh state so the UI can update in place.
    return _production_order_detail(order_ref)


@app.post("/api/production/bulk-move")
async def production_bulk_move(request: Request):
    """Advance one or more whole BOs from from_stage to to_stage in a single
    request. Powers (a) the modal's 'move whole order' control (one order_ref),
    (b) the board's multi-BO advance, and (c) the report's multi-BO advance.
    Each order moves in its OWN transaction so one failure never rolls back the
    rest; the response reports per-order success/failure. Into Sewing: a single
    supplied line applies to every order's units (Repairs -> Sewing auto-routes
    each piece to its original line instead)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    refs = body.get("order_refs")
    if not isinstance(refs, list):
        single = (body.get("order_ref") or "").strip()
        refs = [single] if single else []
    order_refs = []
    for r in refs:
        r = (r or "").strip() if isinstance(r, str) else None
        if r and r not in order_refs:
            order_refs.append(r)
    from_stage = (body.get("from_stage") or "").strip()
    to_stage = (body.get("to_stage") or "").strip()
    note = (body.get("note") or "").strip() or None
    supplied_line = body.get("sewing_line")
    if not order_refs:
        return JSONResponse({"detail": "order_refs is required"}, status_code=400)
    if not from_stage or not to_stage:
        return JSONResponse(
            {"detail": "from_stage and to_stage are required"}, status_code=400)
    if from_stage == to_stage:
        return JSONResponse(
            {"detail": "from_stage and to_stage are the same"}, status_code=400)

    u = getattr(request.state, "user", None) or {}
    moved_by = (body.get("moved_by") or "").strip() or (
        u.get("name") or u.get("email") or "unknown")

    results = []
    moved_count = 0
    failed_count = 0
    for order_ref in order_refs:
        try:
            with _users_tx() as cur:
                qty = _advance_whole_order(
                    cur, order_ref, from_stage, to_stage, supplied_line, moved_by, note)
            results.append({"order_ref": order_ref, "ok": True, "qty": qty})
            moved_count += 1
        except _MoveError as e:
            results.append({"order_ref": order_ref, "ok": False, "error": e.detail})
            failed_count += 1
        except Exception as e:
            results.append({"order_ref": order_ref, "ok": False, "error": str(e)})
            failed_count += 1

    return {"results": results, "moved_count": moved_count, "failed_count": failed_count}


# Clienteling CRM endpoints (ported vivo-crm frontend at /crm/). Registered HERE,
# before the StaticFiles SPA catch-all below, so the catch-all does not swallow
# GET /api/* requests. The module sources data from this project's live Postgres.
import crm_clienteling
crm_clienteling.register_clienteling_routes(app)

# HR attendance dashboard endpoints (ported vivo-hr frontend at /hr/). Same
# placement rationale as the CRM module above — before the StaticFiles catch-all.
# Sources data from this project's live vivo_attendance Postgres table.
import hr_attendance
hr_attendance.register_hr_routes(app)

# Warehouse bins (barcode -> bin) mirrored from a daily-updated Google Sheet; the
# Replenishment + IBT endpoints LEFT JOIN this by barcode. Idempotent table is
# created on boot (safe on the separate prod DB); refresh is lazy + best-effort so
# an unset sheet id / missing connector simply leaves the prior bins in place.
import warehouse_bins


@app.on_event("startup")
def _init_warehouse_bins():
    try:
        pool = _get_pool()
        conn = pool.getconn()
        try:
            warehouse_bins.ensure_table(conn)
        finally:
            pool.putconn(conn)
        # Force ONE full re-sync of the bin map on boot (background, best-effort).
        # Prod is a SEPARATE DB whose bins may have been written by older, capped
        # code; without this the hourly staleness gate would keep serving the
        # stale rows for up to an hour after a deploy. force=True re-fetches the
        # whole sheet now so a freshly deployed prod is immediately correct.
        log.info("warehouse_bins: triggering one-shot forced refresh on startup")
        _warehouse_bins_refresh(force=True)
    except Exception as e:
        log.error("warehouse_bins table init failed: %s", e)

from fastapi.staticfiles import StaticFiles
import pathlib

# Standalone Fabric BI dashboard, served full-page at /fabric. Registered HERE,
# OUTSIDE the `if build_dir.exists()` guard below, because `dashboard/build` is
# gitignored and never ships to production. Previously the only /fabric handler
# lived inside that guard (the SPA catch-all), so in prod the route either did
# not exist or fell through to FileResponse on a missing index.html — raising
# during response streaming and surfacing as a 500. The page source
# (fabric_dashboard_live.html) is git-tracked at the repo root, so serve it
# directly and 404 cleanly if it is somehow absent (never fall through).
def _serve_fabric_page():
    from fastapi.responses import HTMLResponse
    here = pathlib.Path(__file__).parent
    fabric = here / "fabric_dashboard_live.html"
    if not fabric.exists():
        fabric = here / "dashboard" / "build" / "fabric.html"
    if not fabric.exists():
        return JSONResponse({"detail": "Fabric dashboard not available"}, status_code=404)
    # Return an in-memory HTMLResponse, NOT a FileResponse. Under GZipMiddleware a
    # FileResponse can emit the ASGI `http.response.pathsend` zero-copy extension,
    # which GZipMiddleware does not understand and raises on mid-stream — surfacing
    # as a 500 ONLY on the deployed server (whose uvicorn negotiates pathsend; the
    # dev server did not, so /fabric was 200 in dev but 500 in prod). A plain
    # in-memory body compresses cleanly on every server/uvicorn version.
    html = fabric.read_text(encoding="utf-8")
    resp = HTMLResponse(content=html)
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


@app.get("/fabric")
async def serve_fabric_page():
    return _serve_fabric_page()


@app.get("/fabric/{sub_path:path}")
async def serve_fabric_subpath(sub_path: str):
    return _serve_fabric_page()


# Serve React build as static files
build_dir = pathlib.Path(__file__).parent / "dashboard" / "build"
if build_dir.exists():
    app.mount("/static", StaticFiles(directory=str(build_dir / "static")), name="static")

    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        from fastapi.responses import HTMLResponse, JSONResponse
        # Never serve the SPA for API routes
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        # Standalone Fabric BI dashboard — a self-contained static HTML page served
        # full-page (outside the React SPA) at /fabric. Auth is the general /api gate
        # (cookie session sent on the full-page navigation), and /api/fabric/* is
        # readable by any active user.
        if full_path == "fabric" or full_path.startswith("fabric/"):
            # Prefer the git-tracked source at the repo root so the page reliably
            # ships on deploy — dashboard/build is gitignored CRA output and is not
            # guaranteed to be present in a fresh build. Fall back to the build copy.
            fabric = pathlib.Path(__file__).parent / "fabric_dashboard_live.html"
            if not fabric.exists():
                fabric = build_dir / "fabric.html"
            if fabric.exists():
                # In-memory HTMLResponse, not FileResponse: a FileResponse under
                # GZipMiddleware can emit the ASGI `http.response.pathsend` zero-copy
                # extension that GZipMiddleware raises on mid-stream (500 in prod,
                # fine in dev). A plain body compresses cleanly everywhere.
                fr = HTMLResponse(content=fabric.read_text(encoding="utf-8"))
                fr.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                fr.headers["Pragma"] = "no-cache"
                fr.headers["Expires"] = "0"
                return fr
        # Standalone CRM · Clienteling cockpit — a self-contained static HTML page
        # served full-page (outside the React SPA) at /clienteling, the same way as
        # /fabric. It calls the existing gated /api/crm/* endpoints (cookie session
        # sent on the full-page navigation). Served at /clienteling, not /crm, to
        # avoid colliding with the React SPA's /crm route.
        if full_path == "clienteling" or full_path.startswith("clienteling/"):
            crm = build_dir / "crm.html"
            if crm.exists():
                cr = HTMLResponse(content=crm.read_text(encoding="utf-8"))
                cr.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                cr.headers["Pragma"] = "no-cache"
                cr.headers["Expires"] = "0"
                return cr
        index = build_dir / "index.html"
        # Never serve an absent file: a missing index.html surfaces as an opaque
        # 500 (this was the original /fabric + /clienteling prod failure). Return a
        # clean 404 instead. Serve as an in-memory HTMLResponse rather than a
        # FileResponse so GZipMiddleware never hits the `http.response.pathsend`
        # extension (which raised mid-stream → 500 in prod, fine in dev).
        if not index.exists():
            return JSONResponse({"detail": "Not found"}, status_code=404)
        response = HTMLResponse(content=index.read_text(encoding="utf-8"))
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
