"""Runtime configuration for the data-validation agent.

Every threshold is overridable via an environment variable so the same code runs
unchanged against the development and production databases. The only thing that
ever differs between environments is which connection-string secret is read
(``VALIDATION_DATABASE_URL`` falls back to ``DATABASE_URL``).
"""
import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, "").strip() or default))
    except (TypeError, ValueError):
        return default


def _b(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _csv(name: str) -> list[str]:
    return [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]


DATABASE_URL = (
    os.environ.get("VALIDATION_DATABASE_URL", "").strip()
    or os.environ.get("DATABASE_URL", "").strip()
)

VAT_RATE = _f("VALIDATION_VAT_RATE", 0.16)
CONSISTENCY_TOL = _f("VALIDATION_CONSISTENCY_TOL", 0.01)
MONEY_TOL = _f("VALIDATION_MONEY_TOL", 0.02)
NET_COMP_TOL = _f("VALIDATION_NET_COMP_TOL", 0.06)

Z_THRESHOLD = _f("VALIDATION_Z_THRESHOLD", 3.0)
PCT_LOW = _f("VALIDATION_PCT_LOW", 1.0)
PCT_HIGH = _f("VALIDATION_PCT_HIGH", 99.0)
IQR_K = _f("VALIDATION_IQR_K", 1.5)
POP_CAP = _f("VALIDATION_POP_CAP", 0.75)

BASELINE_WINDOW_DAYS = _i("VALIDATION_BASELINE_WINDOW_DAYS", 90)
MIN_BUCKET_POINTS = _i("VALIDATION_MIN_BUCKET", 4)
MIN_HISTORY_POINTS = _i("VALIDATION_MIN_HISTORY", 10)

PROMO_RANGES = _csv("VALIDATION_PROMO_RANGES")

MATERIALITY_KES = _f("VALIDATION_MATERIALITY_KES", 50000.0)

MIN_FOOTFALL = _i("VALIDATION_MIN_FOOTFALL", 20)
MIN_TXN = _i("VALIDATION_MIN_TXN", 1)
MIN_SALES_KES = _f("VALIDATION_MIN_SALES_KES", 1000.0)

BY_SUBCATEGORY = _b("VALIDATION_BY_SUBCATEGORY", False)

ACTIVE_HOUR_START = _i("VALIDATION_ACTIVE_HOUR_START", 6)
ACTIVE_HOUR_END = _i("VALIDATION_ACTIVE_HOUR_END", 22)
ACTIVE_TZ = os.environ.get("VALIDATION_ACTIVE_TZ", "Africa/Nairobi").strip() or "Africa/Nairobi"


def within_active_hours(now=None) -> bool:
    """True when the local hour is inside [ACTIVE_HOUR_START, ACTIVE_HOUR_END].

    Bounds are inclusive, evaluated in ACTIVE_TZ (default East Africa), so an
    hourly Scheduled Deployment running in UTC still only does work 6am-10pm local.
    """
    from datetime import datetime
    if now is None:
        try:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(ACTIVE_TZ))
        except Exception:
            now = datetime.now()
    return ACTIVE_HOUR_START <= now.hour <= ACTIVE_HOUR_END

LLM_MODEL = os.environ.get("VALIDATION_LLM_MODEL", "claude-sonnet-4-6").strip()
LLM_MAX_DIAGNOSES = _i("VALIDATION_MAX_DIAGNOSES", 20)
LLM_TIMEOUT_SEC = _i("VALIDATION_LLM_TIMEOUT_SEC", 60)

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_BASE = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "").strip()
ANTHROPIC_PROXY_KEY = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "").strip()

ALERT_EMAILS = _csv("VALIDATION_ALERT_EMAILS")
ALERT_WHATSAPP = _csv("VALIDATION_ALERT_WHATSAPP")
APPROVAL_BASE_URL = os.environ.get("VALIDATION_APPROVAL_BASE_URL", "").strip()

SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = _i("SMTP_PORT", 587)
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASS = os.environ.get("SMTP_PASSWORD", "").strip()
SMTP_FROM = os.environ.get("SMTP_FROM", "").strip()
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "").strip()

TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_WHATSAPP_FROM = os.environ.get("TWILIO_WHATSAPP_FROM", "").strip()


# ── Cross-surface (cross-endpoint) reconciliation ─────────────────────────────
# The same business metric, under the same filters, must read the SAME number on
# every dashboard page. Each page is backed by a different /api endpoint, so this
# step logs in read-only and reconciles the headline KPI endpoint against every
# endpoint that decomposes the same measures. All thresholds are env-overridable.
CROSS_SURFACE_ENABLED = _b("VALIDATION_CROSS_SURFACE", True)
# Reach the API on its own port (same VM in dev and the prod Reserved VM, where
# the watchdog runs uvicorn on PORT). An explicit base wins for unusual setups.
CROSS_SURFACE_API_BASE = (
    os.environ.get("VALIDATION_API_BASE", "").strip().rstrip("/")
    or f"http://localhost:{os.environ.get('PORT', '8080').strip() or '8080'}/api"
)
CROSS_SURFACE_LOGIN_EMAIL = (
    os.environ.get("VALIDATION_API_EMAIL", "").strip().lower()
    or os.environ.get("SEED_ADMIN_EMAIL", "").strip().lower()
    or "admin@vivofashiongroup.com"
)
CROSS_SURFACE_LOGIN_PASSWORD = (
    os.environ.get("VALIDATION_API_PASSWORD", "").strip()
    or os.environ.get("SEED_ADMIN_PASSWORD", "").strip()
)
# A mismatch only counts when BOTH the relative gap exceeds the tolerance AND the
# absolute gap exceeds the floor (the floor absorbs per-bucket integer rounding —
# summing N ROUNDed rows can differ from the ROUNDed grand total by ~N/2).
CROSS_SURFACE_TOL = _f("VALIDATION_CROSS_SURFACE_TOL", 0.0005)        # 0.05%
CROSS_SURFACE_MONEY_FLOOR = _f("VALIDATION_CROSS_SURFACE_MONEY_FLOOR", 100.0)  # KES
CROSS_SURFACE_COUNT_FLOOR = _i("VALIDATION_CROSS_SURFACE_COUNT_FLOOR", 2)
# A count/unit mismatch this large (relative) is RED even with no KES at stake;
# money mismatches are RED at/above MATERIALITY_KES (shared with governance).
CROSS_SURFACE_RED_REL = _f("VALIDATION_CROSS_SURFACE_RED_REL", 0.01)  # 1%
CROSS_SURFACE_TIMEOUT_SEC = _i("VALIDATION_CROSS_SURFACE_TIMEOUT", 30)
# /analytics/product-analysis is a heavy full-catalog scan (server-side it is
# cached ~10min, but a cold call can exceed the fast-endpoint timeout); give the
# product-page reconciliations their own, longer budget so they complete rather
# than skipping every cold hour.
CROSS_SURFACE_PRODUCT_TIMEOUT_SEC = _i("VALIDATION_CROSS_SURFACE_PRODUCT_TIMEOUT", 180)
CROSS_SURFACE_COUNTRIES = _csv("VALIDATION_CROSS_SURFACE_COUNTRIES") or [
    "Kenya", "Uganda", "Rwanda", "Online",
]


METRICS = [
    "total_sales",
    "net_sales",
    "transactions",
    "units_sold",
    "footfall",
    "conversion_rate",
    "abv",
    "asp",
    "msi",
    "return_rate",
    "return_amount",
    "net_comp_residual",
]

MONEY_METRICS = {"total_sales", "net_sales", "return_amount"}


def llm_enabled() -> bool:
    return bool(ANTHROPIC_API_KEY) or bool(ANTHROPIC_BASE and ANTHROPIC_PROXY_KEY)
