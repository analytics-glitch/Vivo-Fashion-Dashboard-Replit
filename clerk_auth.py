"""
Clerk session verification for the Vivo BI FastAPI backend — PURE STDLIB.

We deliberately do NOT depend on the `clerk-backend-api` / `PyJWT` /
`cryptography` packages: this environment's `u-root-cmds` Nix package shadows
GNU coreutils (`uname`, etc.), which breaks `pip`/`uv` builds for those wheels.
Instead we verify Clerk's RS256 session JWT against the instance JWKS using
only the Python standard library (hashlib / base64 / modular exponentiation
for the RSA PKCS#1 v1.5 check) plus `requests` (already importable) for the
JWKS fetch and the Clerk Backend API email lookup.

Flow:
  1. Read the session JWT from the `__session` cookie (web Clerk is
     cookie-based) or an `Authorization: Bearer` header (fallback).
  2. Verify the signature against the instance JWKS (derived from the
     publishable key's encoded Frontend-API host — NOT from the token, to
     avoid SSRF) and check exp/nbf.
  3. Look up the verified user's email via the Clerk Backend API
     (`GET /v1/users/{sub}`), cached per-user.
  4. Enforce the company-domain allowlist.
"""

import base64
import hashlib
import hmac
import json
import os
import threading
import time

import requests

ALLOWED_DOMAINS = ("vivofashiongroup.com", "shopzetu.com")

_LEEWAY_SECONDS = 60
_JWKS_TTL = 10 * 60          # refresh JWKS every 10 min
_EMAIL_TTL = 10 * 60         # cache sub -> email for 10 min
_HTTP_TIMEOUT = 8

# SHA-256 DigestInfo prefix for EMSA-PKCS1-v1_5.
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")

_lock = threading.Lock()
_jwks_cache = {"ts": 0.0, "keys": {}}      # kid -> (n_int, e_int)
_email_cache = {}                          # sub -> (email, ts)


# ── base64url helpers ─────────────────────────────────────────────────────────
def _b64url_decode(s: str) -> bytes:
    if isinstance(s, str):
        s = s.encode("ascii")
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + b"=" * pad)


def _b64url_to_int(s: str) -> int:
    return int.from_bytes(_b64url_decode(s), "big")


# ── publishable key → Frontend API host ───────────────────────────────────────
def _frontend_api_host() -> str | None:
    """Decode the FAPI host that Clerk encodes inside the publishable key.

    pk_test_<base64("relieved-cattle-12.clerk.accounts.dev$")>
    pk_live_<base64("clerk.example.com$")>
    """
    pk = (
        os.environ.get("CLERK_PUBLISHABLE_KEY")
        or os.environ.get("VITE_CLERK_PUBLISHABLE_KEY")
        or ""
    ).strip()
    if not pk:
        return None
    body = pk.split("_", 2)[-1]
    try:
        decoded = _b64url_decode(body).decode("ascii")
    except Exception:
        return None
    host = decoded.rstrip("$").strip().strip("/")
    return host or None


def _jwks_url() -> str | None:
    host = _frontend_api_host()
    if not host:
        return None
    return f"https://{host}/.well-known/jwks.json"


# ── JWKS fetch / cache ────────────────────────────────────────────────────────
def _load_jwks(force: bool = False) -> dict:
    now = time.time()
    with _lock:
        if (
            not force
            and _jwks_cache["keys"]
            and (now - _jwks_cache["ts"]) < _JWKS_TTL
        ):
            return _jwks_cache["keys"]
    url = _jwks_url()
    if not url:
        return {}
    try:
        resp = requests.get(url, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return _jwks_cache["keys"]  # serve stale on transient failure
    keys = {}
    for jwk in data.get("keys", []):
        if jwk.get("kty") != "RSA" or "n" not in jwk or "e" not in jwk:
            continue
        kid = jwk.get("kid")
        if not kid:
            continue
        keys[kid] = (_b64url_to_int(jwk["n"]), _b64url_to_int(jwk["e"]))
    if keys:
        with _lock:
            _jwks_cache["keys"] = keys
            _jwks_cache["ts"] = now
    return keys


def _key_for_kid(kid: str):
    keys = _load_jwks()
    if kid not in keys:
        keys = _load_jwks(force=True)  # rotated key — refetch once
    return keys.get(kid)


# ── RSA PKCS#1 v1.5 (SHA-256) signature verification ──────────────────────────
def _verify_rs256(signing_input: bytes, signature: bytes, n: int, e: int) -> bool:
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    sig_int = int.from_bytes(signature, "big")
    if sig_int >= n:
        return False
    em_int = pow(sig_int, e, n)
    em = em_int.to_bytes(k, "big")
    digest = hashlib.sha256(signing_input).digest()
    t = _SHA256_DIGEST_INFO + digest
    ps_len = k - len(t) - 3
    if ps_len < 8:
        return False
    expected = b"\x00\x01" + (b"\xff" * ps_len) + b"\x00" + t
    return hmac.compare_digest(expected, em)


# ── JWT verification ──────────────────────────────────────────────────────────
def verify_session_token(token: str) -> dict | None:
    """Verify a Clerk session JWT. Returns claims dict on success, else None."""
    if not token or token.count(".") != 2:
        return None
    header_b64, payload_b64, sig_b64 = token.split(".")
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(sig_b64)
    except Exception:
        return None
    if header.get("alg") != "RS256":
        return None
    kid = header.get("kid")
    if not kid:
        return None
    key = _key_for_kid(kid)
    if not key:
        return None
    n, e = key
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    if not _verify_rs256(signing_input, signature, n, e):
        return None
    now = time.time()
    exp = payload.get("exp")
    if exp is not None and now > float(exp) + _LEEWAY_SECONDS:
        return None
    nbf = payload.get("nbf")
    if nbf is not None and now < float(nbf) - _LEEWAY_SECONDS:
        return None
    # Discriminator: genuine Clerk *session* tokens always carry a session id.
    # Rejects same-key JWTs that are not session tokens (e.g. JWT-template tokens).
    if not payload.get("sid"):
        return None
    # Issuer must be THIS instance's Frontend API, derived from the publishable
    # key (not the token) — rejects validly-signed tokens minted by a different
    # Clerk instance. Clerk sets `iss` to `https://<frontend-api-host>`.
    host = _frontend_api_host()
    if not host or payload.get("iss") != f"https://{host}":
        return None
    return payload


# ── Clerk Backend API: user email lookup (cached) ─────────────────────────────
def _fetch_user_email(sub: str) -> str | None:
    secret = (os.environ.get("CLERK_SECRET_KEY") or "").strip()
    if not secret or not sub:
        return None
    try:
        resp = requests.get(
            f"https://api.clerk.com/v1/users/{sub}",
            headers={"Authorization": f"Bearer {secret}"},
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None
    primary_id = data.get("primary_email_address_id")
    addresses = data.get("email_addresses") or []

    def _is_verified(addr) -> bool:
        return (addr.get("verification") or {}).get("status") == "verified"

    def _email_of(addr) -> str | None:
        return (addr.get("email_address") or "").strip().lower() or None

    # Requirement is a *verified* email on the allowlist. Prefer the verified
    # primary address; otherwise fall back to any verified address. Unverified
    # addresses are ignored so an unverified allowlisted email cannot get in.
    primary = next((a for a in addresses if a.get("id") == primary_id), None)
    if primary and _is_verified(primary):
        return _email_of(primary)
    for addr in addresses:
        if _is_verified(addr):
            return _email_of(addr)
    return None


def get_user_email(sub: str) -> str | None:
    now = time.time()
    with _lock:
        cached = _email_cache.get(sub)
        if cached and (now - cached[1]) < _EMAIL_TTL:
            return cached[0]
    email = _fetch_user_email(sub)
    if email:
        with _lock:
            _email_cache[sub] = (email, now)
    return email


def email_allowed(email: str | None) -> bool:
    if not email or "@" not in email:
        return False
    domain = email.rsplit("@", 1)[-1].strip().lower()
    return domain in ALLOWED_DOMAINS


# ── token extraction from a request ───────────────────────────────────────────
def extract_token(request) -> str | None:
    # Clerk web sessions are cookie-based: the session JWT lives in `__session`
    # (multi-domain setups suffix it, e.g. `__session_<hash>`).
    for name, value in request.cookies.items():
        if name == "__session" or name.startswith("__session_"):
            if value:
                return value
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def authenticate(request):
    """Returns (user_dict, error_status, error_detail).

    user_dict is None when authentication fails; error_status is 401/403.
    """
    token = extract_token(request)
    if not token:
        return None, 401, "Authentication required"
    claims = verify_session_token(token)
    if not claims:
        return None, 401, "Invalid or expired session"
    sub = claims.get("sub")
    if not sub:
        return None, 401, "Invalid session"
    email = get_user_email(sub)
    if not email:
        return None, 401, "Could not verify account"
    if not email_allowed(email):
        return None, 403, "Access is restricted to authorized company accounts"
    local = email.split("@", 1)[0]
    name = (claims.get("name") or "").strip() or local.replace(".", " ").title()
    return (
        {
            "id": sub,
            "email": email,
            "name": name,
            "role": "admin",
            "status": "active",
            "active": True,
        },
        None,
        None,
    )
