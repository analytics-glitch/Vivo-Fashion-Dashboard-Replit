---
name: Notifications surface access requests
description: How admins discover pending access requests, and the design of the notification endpoints
---

# Notification bell = access-request discoverability

Google sign-ups on an allowed domain land `app_users.status='pending'` and wait on
the AwaitingApproval screen; admins approve/reject them on the Users page. The gap
was **discoverability**: nothing pointed admins to that page, so pending requests
sat unseen.

**Decision:** the top-nav notification bell is the discoverability path.
`/api/notifications` + `/api/notifications/unread-count` derive pending users
**live** for admins only (role check on `request.state.user`; non-admins get
empty/zero, missing user fails closed). Items link to `/users`.

**Why derived-live, not stored:** an item must persist until the admin actually
acts (approve/reject), so `read`/`read-all`/`refresh` stay no-ops — marking read
does not hide it; only changing the user's status does.

**How to apply:** if you add other notification types later, keep the admin gate
for access requests and remember nothing is persisted — don't build read-state on
top of a derived list without a backing store.
