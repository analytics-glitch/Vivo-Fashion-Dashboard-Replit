---
name: Clerk prod "Checking session…" blank page
description: Published app stuck on auth-loading while dev works — diagnose as a republish/key-bake issue, not a code bug.
---

# Symptom
Published app (`*.replit.app`) hangs on the auth-loading state ("Checking session…")
while the dev preview works fully. Production logs show repeated
`GET /api/__clerk/.../clerk.browser.js` → 307 with **no** follow-up
`/api/__clerk/v1/environment` or `/api/auth/me` calls. Clerk's browser SDK never
reaches `isLoaded=true`, so `ProtectedRoute` never resolves.

# Root cause class
Production-only Clerk wiring problem, NOT app logic:
- Dev hits Clerk's dev FAPI directly with a `pk_test` key (proxy disabled).
- Prod uses the `/api/__clerk` reverse proxy + a `pk_live` key that is baked into
  the Vite build **at publish time** (`VITE_CLERK_PUBLISHABLE_KEY` is a build-time
  constant, not runtime).
- Merging a task does NOT redeploy. If prod was last published before the live
  Clerk key was provisioned/synced, the deployed build carries a missing/stale
  publishable key → `ClerkProvider` can fetch clerk.browser.js but can't init the
  instance → `isLoaded` stays false forever.

**Why:** Replit-managed Clerk swaps `pk_test`→`pk_live` only at publish/build time.
A correct-in-dev build can still be wrong in prod until re-published.

# How to apply
1. Confirm dev/preview works (look for `/api/auth/me` 200 + "loaded with development
   keys" warning) — proves the code is fine.
2. Diff frontend `ClerkProvider` wiring against the clerk-auth skill canonical:
   `publishableKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)`
   (hostname FIRST), and `proxyUrl = import.meta.env.VITE_CLERK_PROXY_URL`
   UNCONDITIONAL (no PROD/NODE_ENV gate). This app's `artifacts/vivo-bi/src/App.js`
   already matches.
3. Fix = **re-publish** so the live key bakes into the build. Only dig into prod
   browser console/network if it persists after a clean republish.

# This app's specifics
- Custom pure-Python Clerk pieces (no Node SDK — u-root-cmds breaks wheel builds):
  reverse proxy `clerk_frontend_proxy` in `api_pg.py` (upstream
  `https://frontend-api.clerk.dev`, sends `Clerk-Proxy-Url`/`Clerk-Secret-Key`,
  enabled only when `REPLIT_DEPLOYMENT=1` + `CLERK_SECRET_KEY`), and token/JWKS
  verification in `clerk_auth.py` (`_frontend_api_host()` decodes the FAPI host
  from the publishable key). Both verified equivalent to the canonical Express
  `clerkProxyMiddleware.ts` template.
- The auth gate middleware bypasses `/api/__clerk` and `_AUTH_PUBLIC_EXACT`, so RBAC
  does not block Clerk init.
