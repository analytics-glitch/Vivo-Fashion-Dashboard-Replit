#!/usr/bin/env python3
"""
Loyalty-app smoke test.

Checks that the running Vivo Loyalty PWA backend is healthy and that its
DB-backed routes are responding correctly.  This catches the cold-start
regression where `npx prisma generate` was missing from the run command,
causing the Prisma client to be stale and all /api/* routes to return 503.

Endpoints tested:
  GET /loyalty-app          → must return HTTP 301 redirect to /loyalty-app/
  GET /loyalty-app/         → must return HTML (the SPA login page)
  GET /loyalty-app/health   → must return HTTP 200 with JSON {"status":"ok"}
  GET /loyalty-app/api/auth/me  → must return HTTP 4xx (401 unauthenticated),
                                  NOT 5xx (5xx = Prisma missing or DB down)

The test probes the shared reverse-proxy at localhost:80 (or PROXY_BASE if
overridden), which routes /loyalty-app/* to the Loyalty PWA service.  In
production the same proxy routes traffic from the published domain.

Usage:
  python3 check_loyalty_smoke.py
  PROXY_BASE=https://my-deployed-domain.com python3 check_loyalty_smoke.py
"""

import os
import sys
import time
import urllib.request
import urllib.error

# ── Config ────────────────────────────────────────────────────────────────────

PROXY_BASE = os.environ.get("PROXY_BASE", "http://localhost:80").rstrip("/")
BASE_URL       = f"{PROXY_BASE}/loyalty-app"
SLASH_URL      = f"{PROXY_BASE}/loyalty-app/"
HEALTH_URL     = f"{PROXY_BASE}/loyalty-app/health"
AUTH_ME_URL    = f"{PROXY_BASE}/loyalty-app/api/auth/me"

# How long to wait for the service to become available (seconds).
# The loyalty PWA workflow may still be initialising immediately after a
# publish; a short retry window makes this test robust to that.
WAIT_TIMEOUT_S = int(os.environ.get("LOYALTY_SMOKE_TIMEOUT", "90"))
POLL_INTERVAL_S = 2


# ── Helpers ───────────────────────────────────────────────────────────────────

def fetch(url: str) -> tuple[int, str, dict]:
    """Return (status_code, body, headers). Never raises on HTTP errors."""
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.read().decode(errors="replace"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace") if exc.fp else ""
        return exc.code, body, dict(exc.headers) if exc.headers else {}
    except Exception as exc:
        return 0, str(exc), {}


def fetch_no_redirect(url: str) -> tuple[int, str, dict]:
    """Return (status_code, body, headers) WITHOUT following redirects."""
    class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(_NoRedirectHandler())
    try:
        with opener.open(url, timeout=10) as resp:
            return resp.status, resp.read().decode(errors="replace"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace") if exc.fp else ""
        return exc.code, body, dict(exc.headers) if exc.headers else {}
    except Exception as exc:
        return 0, str(exc), {}


def wait_for_health(timeout: int) -> tuple[bool, int, str]:
    """Poll HEALTH_URL until it returns 200 or the timeout elapses.

    Returns (success, last_status, last_body).
    """
    deadline = time.monotonic() + timeout
    last_status, last_body = 0, ""
    while time.monotonic() < deadline:
        status, body, _ = fetch(HEALTH_URL)
        if status == 200:
            return True, status, body
        last_status, last_body = status, body
        time.sleep(POLL_INTERVAL_S)
    return False, last_status, last_body


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Loyalty-app smoke test  (proxy: {PROXY_BASE})")
    print(f"  bare url : {BASE_URL}")
    print(f"  spa root : {SLASH_URL}")
    print(f"  health   : {HEALTH_URL}")
    print(f"  auth/me  : {AUTH_ME_URL}")
    print()

    # ── Check 1: /loyalty-app/health → 200 ───────────────────────────────────
    print(f"Waiting up to {WAIT_TIMEOUT_S}s for health endpoint …")
    ok, status, body = wait_for_health(WAIT_TIMEOUT_S)
    if not ok:
        print(
            f"FAIL: {HEALTH_URL} did not return 200 within {WAIT_TIMEOUT_S}s.\n"
            f"Last response: {status}\n{body[:1000]}\n\n"
            "Is the 'Vivo Loyalty PWA' workflow running?",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {HEALTH_URL} → {status}")

    # Verify health response is JSON {"status": "ok"}
    import json as _json
    try:
        health_json = _json.loads(body)
        if health_json.get("status") != "ok":
            print(
                f"FAIL: {HEALTH_URL} body did not contain {{\"status\":\"ok\"}}.\n"
                f"Got: {body[:500]}",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"  OK  {HEALTH_URL} body contains {{\"status\":\"ok\"}}")
    except _json.JSONDecodeError:
        print(
            f"FAIL: {HEALTH_URL} returned non-JSON body.\nGot: {body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── Check 2: GET /loyalty-app → 301 redirect to /loyalty-app/ ────────────
    # The bare path (no trailing slash) must issue a browser redirect so the SPA
    # root index.html is served correctly from the /loyalty-app/ base path.
    status, body, headers = fetch_no_redirect(BASE_URL)
    if status not in (301, 302, 307, 308):
        print(
            f"FAIL: {BASE_URL} returned {status} — expected a 3xx redirect to "
            f"{SLASH_URL}.\n\n"
            "A non-redirect response means the bare /loyalty-app URL returns raw "
            "content (or an error) instead of directing browsers to /loyalty-app/.\n"
            f"Response body:\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    location = headers.get("Location") or headers.get("location") or ""
    # Location may be absolute or just the path component.
    if not (location.endswith("/loyalty-app/") or location == "/loyalty-app/"):
        print(
            f"FAIL: {BASE_URL} redirected to '{location}' — expected a URL ending "
            f"with /loyalty-app/.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {BASE_URL} → {status} → {location}")

    # ── Check 3: GET /loyalty-app/ → HTML (the SPA login page) ───────────────
    # After following the redirect the client should receive the React SPA shell.
    status, body, headers = fetch(SLASH_URL)
    if status != 200:
        print(
            f"FAIL: {SLASH_URL} returned {status} — expected 200 with HTML.\n"
            f"Response body:\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    content_type = headers.get("Content-Type") or headers.get("content-type") or ""
    if "text/html" not in content_type.lower():
        print(
            f"FAIL: {SLASH_URL} returned Content-Type '{content_type}' — expected "
            "text/html (the SPA shell).\n"
            f"Response body (first 500 chars):\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    if "<html" not in body.lower():
        print(
            f"FAIL: {SLASH_URL} returned 200 but body does not look like HTML.\n"
            f"Response body (first 500 chars):\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {SLASH_URL} → {status} ({content_type.split(';')[0].strip()})")

    # ── Check 4: /loyalty-app/api/auth/me → 4xx, NOT 5xx ─────────────────────
    # An unauthenticated request must return 401.
    # 503 = Prisma plugin failed to initialise (missing npx prisma generate).
    # 500 = unhandled server crash — equally bad.
    status, body, _ = fetch(AUTH_ME_URL)
    if status >= 500:
        print(
            f"FAIL: {AUTH_ME_URL} returned {status} — expected 401.\n\n"
            "A 5xx response means one of:\n"
            "  • `npx prisma generate` is missing from the loyalty-app run command\n"
            "    (check artifacts/api-server/.replit-artifact/artifact.toml)\n"
            "  • The database is unreachable\n\n"
            f"Response body:\n{body[:2000]}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {AUTH_ME_URL} → {status}")

    print("\nLoyalty-app smoke test PASSED.")


if __name__ == "__main__":
    main()
