---
name: RBAC last-admin & bootstrap concurrency
description: Why admin role/status/delete mutations and first-login bootstrap must run inside one advisory-locked transaction in api_pg.py
---

# Last-admin guard & bootstrap must be atomic

Any "check there is still an admin, then mutate" sequence in the user store
(`app_users`) must run as a single transaction guarded by the shared Postgres
advisory lock (`pg_advisory_xact_lock(_ADMIN_LOCK_KEY)`), with `SELECT ... FOR
UPDATE` on the target row and the active-admin recount done on the *same*
transaction cursor (`_active_admins_excluding(cur, ...)`). Use the `_users_tx(lock=True)`
context manager — never the autocommit `_users_exec` for these paths.

**Why:** the original implementation checked the active-admin count and then did
the update/delete in a separate autocommit statement. Two concurrent
demotions/deletions could both pass the guard and commit, leaving **zero active
admins** (permanent lockout — nobody can approve anyone). The same race let
concurrent first logins each elect themselves bootstrap admin.

**How to apply:** the critical sections are bootstrap in `_resolve_app_user_db`
and the `/api/admin/users/{id}` PATCH/POST/DELETE handlers. If you add any new
endpoint that can change who is an active admin, wrap the read-guard-write in
`_users_tx(lock=True)` too. Plain reads (the admin list, `/auth/me`) do not need
the lock.
