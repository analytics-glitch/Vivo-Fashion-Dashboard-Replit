#!/usr/bin/env python3
"""
Loyalty-app smoke test.

The vendored Fastify + Prisma PWA was removed.  /loyalty-app/* is now served
by the main FastAPI process in api_pg.py, which embeds loyalty.vivofashionbrands.com
in a full-screen iframe (with a meta-refresh fallback).

Endpoints tested:
  GET /loyalty-app       → 301 redirect to /loyalty-app/
  GET /loyalty-app/      → 200 HTML containing loyalty.vivofashionbrands.com reference
  GET /loyalty-app/health → 200 JSON {"status": "ok"}

Usage:
  python3 check_loyalty_smoke.py
  PROXY_BASE=https://my-deployed-domain.com python3 check_loyalty_smoke.py
"""

import os
import sys
import urllib.request
import urllib.error

PROXY_BASE = os.environ.get("PROXY_BASE", "http://localhost:80").rstrip("/")
BASE_URL   = f"{PROXY_BASE}/loyalty-app"
SLASH_URL  = f"{PROXY_BASE}/loyalty-app/"
HEALTH_URL = f"{PROXY_BASE}/loyalty-app/health"
EXPECTED_HOST = "loyalty.vivofashionbrands.com"


def fetch(url: str) -> tuple[int, str, dict]:
    """Return (status_code, body, headers). Follows redirects. Never raises on HTTP errors."""
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


def main() -> None:
    print(f"Loyalty-app smoke test  (proxy: {PROXY_BASE})")
    print()

    # ── Check 1: GET /loyalty-app → 301 to /loyalty-app/ ─────────────────────
    status, body, headers = fetch_no_redirect(BASE_URL)
    if status not in (301, 302, 307, 308):
        print(
            f"FAIL: {BASE_URL} returned {status} — expected a 3xx redirect.\n"
            f"Response body:\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    location = headers.get("Location") or headers.get("location") or ""
    if not (location.endswith("/loyalty-app/") or location == "/loyalty-app/"):
        print(
            f"FAIL: {BASE_URL} redirected to '{location}' — expected /loyalty-app/.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {BASE_URL} → {status} → {location}")

    # ── Check 2: GET /loyalty-app/ → 200 HTML with loyalty.vivofashionbrands.com
    status, body, headers = fetch(SLASH_URL)
    if status != 200:
        print(
            f"FAIL: {SLASH_URL} returned {status} — expected 200 HTML.\n"
            f"Response body:\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    content_type = headers.get("Content-Type") or headers.get("content-type") or ""
    if "text/html" not in content_type.lower():
        print(
            f"FAIL: {SLASH_URL} returned Content-Type '{content_type}' — expected text/html.",
            file=sys.stderr,
        )
        sys.exit(1)
    if EXPECTED_HOST not in body:
        print(
            f"FAIL: {SLASH_URL} HTML does not reference '{EXPECTED_HOST}'.\n"
            f"Response body (first 500 chars):\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {SLASH_URL} → {status} HTML contains {EXPECTED_HOST}")

    # ── Check 3: GET /loyalty-app/health → 200 {"status": "ok"} ─────────────
    status, body, _ = fetch(HEALTH_URL)
    if status != 200:
        print(
            f"FAIL: {HEALTH_URL} returned {status} — expected 200.\n"
            f"Response body:\n{body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    import json as _json
    try:
        health = _json.loads(body)
        if health.get("status") != "ok":
            print(
                f"FAIL: {HEALTH_URL} body did not contain {{\"status\":\"ok\"}}.\n"
                f"Got: {body[:500]}",
                file=sys.stderr,
            )
            sys.exit(1)
    except _json.JSONDecodeError:
        print(
            f"FAIL: {HEALTH_URL} returned non-JSON body.\nGot: {body[:500]}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  OK  {HEALTH_URL} → {status} {{\"status\":\"ok\"}}")

    print("\nLoyalty-app smoke test PASSED.")


if __name__ == "__main__":
    main()
