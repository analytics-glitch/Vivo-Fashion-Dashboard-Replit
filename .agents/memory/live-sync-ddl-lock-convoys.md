---
name: Live sync DDL lock convoys
description: Prevent routine sync schema checks and full-refresh truncates from freezing readers.
---

Routine sync loops must not execute unconditional `ALTER TABLE ... IF NOT EXISTS` or `TRUNCATE` against tables used by live pages. Check catalog metadata first, use a short lock timeout only for genuinely missing schema, and refresh snapshots with upsert plus stale-row deletion.

**Why:** PostgreSQL queues later readers behind a waiting access-exclusive lock. A harmless-looking DDL check or `TRUNCATE` waiting on one long read can therefore freeze every later page open and save. Promise timeouts do not cancel the queued database statement and can multiply the lock queue.

**How to apply:** Keep migrations out of request/startup retry loops. For recurring extractors, inspect `pg_attribute` before any DDL and fail quickly on lock contention. For full snapshots, refuse empty upstream results, upsert the complete returned set, then delete IDs absent from that set without taking an access-exclusive table lock.