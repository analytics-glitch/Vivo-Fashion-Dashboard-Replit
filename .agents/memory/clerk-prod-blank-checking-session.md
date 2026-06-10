---
name: Clerk prod "Checking session…" blank page
description: Published app stuck on auth-loading while dev works — caused by the Python Clerk proxy relaying Brotli bytes the browser can't decode.
---

# Symptom
Published app (`*.replit.app`) hangs on the auth-loading state ("Checking session…")
while the dev preview works fully. Production logs show repeated
`GET /api/__clerk/.../clerk.browser.js` → 307 with **no** follow-up
`/api/__clerk/v1/environment` or `/api/auth/me` calls. The browser **console** is the
decisive signal:
`Uncaught SyntaxError: Unexpected token '%' (at clerk.browser.js:1:2)` +
`Clerk: Failed to load Clerk JS (code="failed_to_load_clerk_js")`.

# Root cause (CONFIRMED)
The pure-Python Clerk reverse proxy (`clerk_frontend_proxy` in `api_pg.py`) corrupts
compressed responses:
- In proxy mode Clerk loads `clerk.browser.js` **through** `/api/__clerk` (the FAPI
  307-redirects to a versioned path that comes back through the proxy).
- The browser advertises `Accept-Encoding: br, zstd`. The proxy forwarded that header
  verbatim, so Clerk's CDN returned **Brotli**-compressed bytes.
- Python `requests`/urllib3 only auto-decompress `gzip`/`deflate` — NOT `br`/`zstd`
  (those need the `brotli`/`zstandard` packages). So `.content` was the raw Brotli
  bytes.
- The proxy strips `Content-Encoding` (it's in the hop-by-hop set), so the browser
  received compressed binary with no encoding header and parsed it as JS → the `%`
  SyntaxError → clerk-js never loads → `isLoaded` never true → `ProtectedRoute` stuck.
- Dev never hits this: the proxy is disabled in dev (`REPLIT_DEPLOYMENT=1` +
  `CLERK_SECRET_KEY` gate), so the browser talks to Clerk's dev FAPI directly and
  decompresses Brotli natively.

**Why it was NOT a stale-key/republish issue:** re-publishing produced a fresh build
(new hashed filenames) and the page still hung; the publishable key resolves fine
(`ClerkProvider` mounts and renders the loading screen). The break is purely transport
encoding in the proxy.

# Fix
Force the upstream request to an encoding `requests` can decode, so the proxy always
relays plain bytes:
`fwd_headers["Accept-Encoding"] = "gzip, deflate"` (drop `br`/`zstd`). gzip/deflate are
transparently decoded into `.content`, the (now-irrelevant) `Content-Encoding` header is
stripped, and the browser gets valid uncompressed JS. The canonical Express proxy
(`http-proxy-middleware`) avoids the bug differently — it streams raw bytes AND keeps
the `Content-Encoding` header, so the browser decompresses. Either approach works; the
trap is doing one without the other (decode-less body + stripped header).

**How to apply:** any pass-through proxy built on Python `requests` that strips
`Content-Encoding` MUST also constrain `Accept-Encoding` to gzip/deflate/identity (or
install `brotli`+`zstandard` and keep the header). This applies to every upstream call
in `clerk_frontend_proxy`, not just clerk.browser.js.

# Diagnosis order that worked
1. Confirm dev/preview works (`/api/auth/me` 200) — proves app logic is fine.
2. Prod logs show only `clerk.browser.js` 307s, no `/v1/*` — clerk-js fails before any
   FAPI call → client-side init failure, not a backend/RBAC gate problem.
3. Get the prod browser **Console** error (only the user can see it). The `%`
   SyntaxError pinned it to a transport/encoding corruption, not keys or domains.

# This app's Clerk specifics
- Custom pure-Python Clerk pieces (no Node SDK — u-root-cmds breaks wheel builds):
  reverse proxy `clerk_frontend_proxy` in `api_pg.py` (upstream
  `https://frontend-api.clerk.dev`, sends `Clerk-Proxy-Url`/`Clerk-Secret-Key`,
  enabled only when `REPLIT_DEPLOYMENT=1` + `CLERK_SECRET_KEY`), and token/JWKS
  verification in `clerk_auth.py` (`_frontend_api_host()` decodes the FAPI host from
  the publishable key).
- Frontend `ClerkProvider` wiring in `artifacts/vivo-bi/src/App.js` is canonical:
  `publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)`
  (hostname FIRST) + unconditional `proxyUrl`.
- The auth gate middleware bypasses `/api/__clerk` and `_AUTH_PUBLIC_EXACT`, so RBAC
  does not block Clerk init.
