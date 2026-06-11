---
name: Mobile Google OAuth deep-link return
description: How the Expo app completes Google sign-in against the shared web /api OAuth flow without breaking web, and why the backend `return` param is scheme-locked.
---

# Mobile Google sign-in via a validated `return` deep link

The Expo mobile app shares the SAME gated backend `/api/auth/google/*` flow as the
web dashboard. The backend callback normally redirects to the relative web page
`/auth/callback#token=…`. That fragment-on-a-web-page hand-off cannot return
control to a native app.

**Solution (additive, no web behavior change):**
- Mobile passes its runtime redirect URL — `Linking.createURL("/auth/callback")` —
  to `GET /api/auth/google/login?return=<deep link>`. In Expo Go this is an
  `exp://…/--/auth/callback` URL; in a dev/standalone build it is the app's own
  `vivo-mobile://auth/callback` scheme. `openAuthSessionAsync(authUrl, returnUrl)`
  intercepts that URL and returns control to the app.
- Backend stores the validated value in a short-lived `g_oauth_return` cookie at
  login and, in the callback, redirects the token there. **Native deep links get
  a `?query` separator (`?token=` / `?error=`)**, web keeps the original
  `#fragment` — query params survive the OS app hand-off more reliably than a
  fragment. Mobile parses whichever delimiter is present.

**Why `return` is scheme-locked (`_safe_oauth_return` in `api_pg.py`):** it accepts
ONLY `vivo-mobile://`, `exp://`, or `exp+<slug>://` URLs that contain
`auth/callback`. It rejects any `https://` / arbitrary target. These schemes can
only open this app, so the param can never become a general open-redirect to a
phishing site. Web clients omit the param entirely and the default relative
`/auth/callback#…` path is unchanged. CSRF `g_oauth_state` + `hmac.compare_digest`
is untouched.

**How to apply:** if you add another OAuth provider or a new mobile build scheme,
extend the `_safe_oauth_return` allowlist regex — do NOT loosen it to accept
`https`. Keep the query-vs-fragment split keyed on whether a `return` deep link is
present.

**Transient 502 note:** the "Request failed (502)" the user saw on the login
screen was a bad-gateway during an api-server restart bounce, NOT a backend bug.
`lib/api.ts` now maps 502/503/504 + transport failures to friendly retry copy.
