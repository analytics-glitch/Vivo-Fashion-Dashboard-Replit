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
