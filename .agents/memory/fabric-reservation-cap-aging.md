---
name: Fabric reservation stock cap & aging
description: Available-to-reserve definition, lazy aging/expiry sweep, and the persisted per-user bell notification store
---

# Fabric reservation cap + aging/expiry

- **Available to reserve (kg)** = RMAT/Stock `SUM(quantity - reserved_qty)` (ERP allocations sit on RMAT/Stock, NOT PROD/Stock) − sum of OPEN app reservations (`status='active'`). One helper computes it; the create endpoint enforces it server-side and the form/list surface it.
- Thresholds live in ONE place (`_RESV_AGING_NOTICE_DAYS=14`, `_RESV_EXPIRE_GRACE_DAYS=7`); expiry = notice+grace.
- **Lazy sweep on list read**: 14-day one-time notice (stamped `aging_notified_at`), auto-expire past 21d (`status='expired'`, `expired_at`, audit-logged). Idempotency = UPDATE guards + notification dedupe_key.
- Everything that frees quantity relies on availability readers filtering `status='active'` — never add a reader that counts expired rows.

# Persisted per-user bell notifications (`user_notifications`)

- New shared table: `user_notifications(user_id, type, title, message, link, dedupe_key UNIQUE, created_at, read_at)`. Insert with `ON CONFLICT (dedupe_key) DO NOTHING` for idempotent notifies. Ensured lazily in BOTH fabric_router (`_ensure_fabric_tables`) and api_pg (`_ensure_user_notifications`).
- `/api/notifications` + unread-count now merge: admin-derived live items (access requests, social alerts — still no read state) PLUS the signed-in user's persisted rows (any role, `event_id='un:<id>'`, read state via `read_at`; `/read` and `/read-all` update them). Persisted items set `external: true` so non-SPA links (e.g. /fabric) full-navigate.

**How to apply:** any future "notify this user in the bell" feature should insert into `user_notifications` with a dedupe_key — do not invent another store or overload crm_tasks.
