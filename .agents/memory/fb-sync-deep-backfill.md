---
name: Facebook sync deep backfill
description: How the clienteling Facebook sync reaches its 2000/2000 post/comment targets across multiple budget-limited runs.
---

The clienteling Facebook sync targets (≥2000 posts, ≥2000 comments, ≥2000 DMs) are **cumulative against stored rows**, not per-run fetch counts.

**Why:** one HTTP request can only walk ~600 posts inside its 240s time budget, and a sync that always restarts from the newest post can never get past that depth — repeated syncs would re-walk the same pages forever. The Graph feed must be resumed where the last run stopped.

**How to apply:**
- Two phases: Phase A walks newest-first until a page adds **no new** posts (fresh content only); Phase B deep-backfills toward the stored targets, resuming from a cursor persisted in `crm_config` (`social.fb.deep_cursor`), with `social.fb.deep_done` set when the feed is exhausted.
- If the time budget interrupts mid-page, do NOT advance the resume cursor past that page (re-do it next run; `source_id` dedup makes that safe).
- The whole run holds a non-blocking in-process lock (409 if a sync is already running) so concurrent clicks can't race the cursor.
- Steady state (targets met): a sync is ~5-10s (one newest page per surface, deep phases skipped).
- Messenger DMs follow the same pattern as a Phase C (`social.fb.dm_deep_cursor`/`dm_deep_done`, `fbdm:` source ids): only INBOUND messages (from.id ≠ page id) become `dm` rows; the sender's page-scoped id (PSID) is stored in `author_handle` so the reply endpoint can deliver via the Send API (`/{page-id}/messages`, recipient/message as JSON strings). A missing `pages_messaging` scope (or any conversations failure) must never fail the posts/comments sync — report via `scopes_missing`. Reply failures (e.g. 24-hour window closed) surface the real Graph error as a 502 and do NOT stamp `replied_at`.
- Trap when verifying via `GET /api/social/feedback`: it clamps at 5000 rows total — use the `type=` filter for per-type counts, or the "stalled" counts are just the clamp.
- **A "phase never ran" symptom can be stale server code, not a Graph problem**: the DM phase once appeared broken (0 rows, no cursor, no `last_sync_dms`) purely because the api-server process predated the DM code — restart the workflow FIRST, then diagnose. To make silent skips impossible, the sync now persists `social.fb.last_dm_error` unconditionally each run (empty = OK) and returns `dm_blocked`/`dm_error` in the sync response.
- Ops note: detached background processes (`setsid nohup … &`) do NOT survive the agent's bash session here; for long server-side jobs, fire the request with a short client timeout (server keeps processing after disconnect) and poll results in later calls.
