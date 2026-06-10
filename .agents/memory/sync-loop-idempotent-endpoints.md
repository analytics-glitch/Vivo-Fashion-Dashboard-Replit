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
caught this for the data-quality logging endpoint.

**How to apply:** Dedupe inside the endpoint, under the shared advisory lock so the
check-then-insert is atomic across the concurrent per-minute calls. Existing
precedent: the replenishment snapshot endpoint dedupes to a weekly cadence; the
data-quality log endpoint dedupes per UTC day.
