---
name: Mobile app shares the API auth gate
description: The Expo mobile app and the web app hit the same gated /api; auth changes affect both.
---

The Expo mobile app (`artifacts/vivo-mobile`) and the web dashboard both call the
same FastAPI `/api/*` endpoints, which are all protected by the session gate
(Bearer header or `session_token` cookie). There is no separate mobile API.

**Rule:** Any change to the backend auth gate (enabling it, changing the public
self-paths, token format, or 401/403 behavior) affects the mobile client too —
not just the web app.

**Why:** When auth was restored on the backend, the mobile app had no auth layer
at all, so every endpoint returned 401 and the dashboard rendered blank. The fix
was to give the mobile app its own login flow that attaches the same Bearer token.

**How to apply:**
- Mobile attaches the token via a module-level variable in `lib/api.ts`
  (`setAuthToken`) on every `apiGet`/`apiPost`; a 401 triggers `onUnauthorized`
  which clears the session and bounces to `/login`.
- The token is persisted in `AsyncStorage` under key `vivo_token` (same key name
  convention as the web app's `localStorage`). `@react-native-async-storage/async-storage`
  ships pre-installed in the Expo scaffold — no new dep needed.
- Tab screens gate their React Query with `enabled: status === "authenticated"`
  so they never fire pre-auth 401s; the cache is cleared on login and logout so a
  second user on the same device never sees the prior session's figures.
- If you test mobile against the backend, the seed admin works the same as on web.
