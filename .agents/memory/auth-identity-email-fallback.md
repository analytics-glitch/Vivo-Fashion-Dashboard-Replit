---
name: Auth identity resolution must fall back to email
description: Why Google sign-in must match an existing account by the UNIQUE email, not only by the identity key (user_id/sub).
---

# Identity resolution falls back to the UNIQUE email

When resolving an authenticated identity to an `app_users` row, look up by the
identity key first (`user_id` == the IdP `sub`, e.g. `google:<id>`), and if that
misses, fall back to a lookup on the **UNIQUE `email`** column before creating a
new row.

**Why:** accounts can exist under a *different identity key* than the one a given
sign-in presents. The canonical case: an admin creates an email/password user
(`user_id = local:<hex>`), then that same person signs in with Google
(`sub = google:<id>`). A user_id-only lookup misses, and the first-seen bootstrap
`INSERT ... ON CONFLICT (user_id)` does NOT cover the `email UNIQUE` constraint —
so it raises a unique-violation (500), and conceptually would create a duplicate
*pending* account requiring re-approval. Matching by email recognizes the existing
(already-active) account instead.

**How to apply:** keep the email fallback in `_resolve_app_user_db` between the
`user_id=sub` miss and the bootstrap insert. It is safe because the Google callback
already enforces `email_verified == true` AND an allowed company domain before
`resolve_app_user` runs, so the email is a trusted corporate identity. `email` is
`UNIQUE NOT NULL`, so the match is deterministic (one row). No user_id rewrite is
needed — return the existing row (it keeps its `local:` id; sessions are keyed by
user_id, so everything downstream still works).

Separately: the Google `redirect_uri_mismatch` users hit in production is NOT a code
bug — the prod app correctly sends `https://<prod-host>/api/auth/google/callback`
(derived from `x-forwarded-host`, overridable via `GOOGLE_REDIRECT_URI`). That exact
string must be registered in Google Cloud Console → Authorized redirect URIs.
