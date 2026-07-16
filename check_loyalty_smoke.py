#!/usr/bin/env python3
"""
Loyalty-app smoke test.

Checks that the running Vivo Loyalty PWA backend is healthy and that its
DB-backed routes are responding correctly.  This catches the cold-start
regression where `npx prisma generate` was missing from the run command,
causing the Prisma client to be stale and all /api/* routes to return 503.

Endpoints tested:
  GET /loyalty-app/health       → must return HTTP 200
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
HEALTH_URL = f"{PROXY_BASE}/loyalty-app/health"
AUTH_ME_URL = f"{PROXY_BASE}/loyalty-app/api/auth/me"

# How long to wait for the service to become available (seconds).
# The loyalty PWA workflow may still be initialising immediately after a
# publish; a short retry window makes this test robust to that.
WAIT_TIMEOUT_S = int(os.environ.get("LOYALTY_SMOKE_TIMEOUT", "90"))
POLL_INTERVAL_S = 2


# ── Helpers ───────────────────────────────────────────────────────────────────

def fetch(url: str) -> tuple[int, str]:
    """Return (status_code, body). Never raises on HTTP errors."""
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace") if exc.fp else ""
        return exc.code, body
    except Exception as exc:
        return 0, str(exc)


def wait_for_health(timeout: int) -> tuple[bool, int, str]:
    """Poll HEALTH_URL until it returns 200 or the timeout elapses.

    Returns (success, last_status, last_body).
    """
    deadline = time.monotonic() + timeout
    last_status, last_body = 0, ""
    while time.monotonic() < deadline:
        status, body = fetch(HEALTH_URL)
        if status == 200:
            return True, status, body
        last_status, last_body = status, body
        time.sleep(POLL_INTERVAL_S)
    return False, last_status, last_body


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Loyalty-app smoke test  (proxy: {PROXY_BASE})")
    print(f"  health  : {HEALTH_URL}")
    print(f"  auth/me : {AUTH_ME_URL}")
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

    # ── Check 2: /loyalty-app/api/auth/me → 4xx, NOT 5xx ─────────────────────
    # An unauthenticated request must return 401.
    # 503 = Prisma plugin failed to initialise (missing npx prisma generate).
    # 500 = unhandled server crash — equally bad.
    status, body = fetch(AUTH_ME_URL)
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
