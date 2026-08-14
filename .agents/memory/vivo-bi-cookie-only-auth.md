---
name: staff web auth is cookie-only
description: Staff web SPAs authenticate solely via the httpOnly session cookie; no localStorage token, no Bearer header, no token in OAuth web redirects.
---

Staff-facing web SPAs (vivo-bi, vivo-crm, vivo-hr — all converted) authenticate **only** via the httpOnly `session_token` cookie. The session token must never be written to localStorage, attached as a Bearer header by web code, or placed in a web redirect URL — including the Google OAuth callback, which sets the cookie and redirects with **no** token fragment. Only native mobile deep links (`scheme://…`) carry the token (query param), because a separate process can't read our cookies; the backend keeps accepting Bearer for that mobile flow.

**Why:** Any JS-readable copy (localStorage or a URL fragment) defeats the httpOnly cookie's XSS protection — an injected script could exfiltrate a long-lived staff session (up to admin).

**How to apply:**
- New web fetches must be same-origin so the cookie rides along; never reintroduce a `vivo_token`/Bearer path or a `#token=` web redirect.
- Client-IP decisions (rate limits, audit) must use the trusted-proxy contract: rightmost X-Forwarded-For entry, never the spoofable leftmost.
- e2e specs authenticate via `addCookies` with `session_token`, not localStorage injection.
- Staff login has brute-force protection (per-account lockout + per-IP throttle) — keep it when touching the login handler.
