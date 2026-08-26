---
name: UI-testing pages behind the custom Postgres auth
description: How to run authenticated Playwright/e2e tests or curl calls against the vivo-bi custom session auth without knowing any password.
---

The BI apps use custom session auth, so browser verification needs a temporary, short-lived development session rather than a password.

**Why:** the browser's protected-page session check uses a cookie and clears the legacy localStorage token. Using a temporary session avoids exposing credentials and lets tests exercise a chosen role.

**How to apply:** create and clean up the temporary session through the approved test/database flow. Set its session cookie before navigating to a protected page, and wait for cold dashboard data after an API restart before diagnosing a loading state.
