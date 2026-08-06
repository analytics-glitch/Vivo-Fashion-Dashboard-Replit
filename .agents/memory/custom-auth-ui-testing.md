---
name: UI-testing pages behind the custom Postgres auth
description: How to run authenticated Playwright/e2e tests or curl calls against the vivo-bi custom session auth without knowing any password.
---

The BI apps use a custom Postgres session auth (no Clerk), so the testing subagent cannot "log in" normally and screenshots of protected pages show only /login.

**How to apply:** mint a temporary session directly in the dev DB, hand the token to the test, delete it after:

1. `INSERT INTO user_sessions (session_token, user_id, expires_at) VALUES (<random hex>, <an active admin's user_id from app_users>, now() + interval '45 minutes')`.
2. For curl/API tests: send it as `Authorization: Bearer <token>`.
3. For the Playwright testing subagent: instruct it to run `window.localStorage.setItem("vivo_token", "<token>")` on the login page BEFORE navigating to the protected route (the SPA reads that key and sends the Bearer header).
4. Always `DELETE FROM user_sessions WHERE session_token = ...` when done.

**Why:** avoids needing SEED_ADMIN_PASSWORD (a secret that must never be printed) and works for any role by picking the right app_users row. Also undo any data mutations the test makes (e.g. archives) so the seeded/board state the user sees is unchanged.

**/fabric specifics:** the static fabric page authenticates with the `session_token` COOKIE (`fetch(..., credentials:'include')`), not localStorage — set `document.cookie="session_token=<tok>; path=/"` then reload.

**Testing client-built CSV downloads:** inject after the final reload — `window.__csvs=[]` + wrap `URL.createObjectURL` to push `blob.text()`, stub `window.alert` into `window.__alerts` (a freshness-guard alert otherwise fails silently as "no CSV"). Record `__csvs.length` BEFORE each export click and poll (45s+) until it grows — capture is async and exports may re-fetch first (~11s custom-window /api/fabric/mix). Set date-input pairs via JS + one handler call, not sequential fills (intermediate change events fire loads with partial windows). If a test reports `cacheParams:null`/`hasCache:false` across the board, check whether a workflow restart killed the API mid-test before suspecting the product.

**Session-row shape:** the table is `user_sessions(session_token PK, user_id FK→app_users, expires_at NOT NULL)` — the token column is `session_token`, not `token`. Insert: `INSERT INTO user_sessions (session_token, user_id, expires_at) VALUES (..., now() + interval ...)`, auth via `Authorization: Bearer <session_token>` on localhost:8080; always DELETE the row after.
