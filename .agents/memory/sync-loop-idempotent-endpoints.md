---
name: Sync-loop internal endpoints must be idempotent per period
description: Why internal POST endpoints triggered from the sync_incremental.py daily window must dedupe their own writes.
---

The incremental sync loop runs a full cycle roughly every minute. Its "once a day"
work is gated only by `if now.hour == <H>` (UTC), so any endpoint it POSTs to in
that window is actually hit ~60 times that day, not once.

**Rule:** Any internal endpoint called from the sync loop's hour-gated block must
make its own writes idempotent for the intended period — do not rely on the hour
gate to fire once.

**Why:** The hour gate fires every minute for the whole hour. Without endpoint-side
dedupe you get ~60 duplicate rows/day and inflated monitoring noise. A code review
caught this for `/api/data-quality/log`.

**How to apply:**
- `/api/replenishment/snapshot` dedupes to a weekly cadence inside the endpoint.
- `/api/data-quality/log` dedupes per UTC day: inside one `_users_tx(lock=True)`
  it `SELECT 1 ... WHERE action_taken='data_quality' AND checked_at::date =
  (now() AT TIME ZONE 'UTC')::date` and returns `skipped:true` if a row exists,
  else inserts. The advisory lock makes the check-then-insert atomic across the
  concurrent per-minute calls.
- Same store-by-`action_taken` row shape is reused on `sync_health_log` (one extra
  nullable `data_quality_score numeric` column, added via `ADD COLUMN IF NOT EXISTS`
  at startup + before each write).
