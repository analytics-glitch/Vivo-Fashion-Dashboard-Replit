"""Shared security configuration for the standalone FastAPI services."""

import hmac
import os
from typing import Any


_LOCAL_ORIGINS = {
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
}

_ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
_ALLOWED_HEADERS = [
    "Accept",
    "Authorization",
    "Content-Type",
    "X-Internal-Token",
    "X-Member-Token",
    "X-Pii-Reveal-Token",
    "X-Requested-With",
]


def _normalise_origin(value: str) -> str | None:
    value = value.strip().rstrip("/")
    if not value or value == "*":
        return None
    if "://" not in value:
        value = f"https://{value}"
    return value


def trusted_origins() -> list[str]:
    """Return exact origins allowed to make cross-origin API requests.

    CORS_ALLOWED_ORIGINS is the deployment-specific source of truth. Localhost
    and the Replit development domains are included for existing local preview
    workflows; same-origin production traffic does not require CORS.
    """
    origins = set(_LOCAL_ORIGINS)
    configured = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    origins.update(
        origin
        for origin in (_normalise_origin(v) for v in configured.split(","))
        if origin
    )
    for key in ("REPLIT_DEV_DOMAIN", "REPLIT_DOMAINS"):
        for host in (os.environ.get(key) or "").split(","):
            origin = _normalise_origin(host)
            if origin:
                origins.add(origin)
    return sorted(origins)


def cors_config() -> dict[str, Any]:
    return {
        "allow_origins": trusted_origins(),
        "allow_methods": _ALLOWED_METHODS,
        "allow_headers": _ALLOWED_HEADERS,
    }


def fastapi_docs_config() -> dict[str, str | None]:
    """Keep docs available locally while disabling them in published builds."""
    if os.environ.get("REPLIT_DEPLOYMENT"):
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {}


def internal_token_valid(request) -> bool:
    secret = os.environ.get("SESSION_SECRET") or ""
    token = request.headers.get("x-internal-token") or ""
    return bool(secret and token and hmac.compare_digest(token, secret))