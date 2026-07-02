---
name: Facebook sync deep backfill
description: How the clienteling Facebook sync reaches its 2000/2000 post/comment targets across multiple budget-limited runs.
---

The clienteling Facebook sync targets (≥2000 posts, ≥2000 comments) are **cumulative against stored rows**, not per-run fetch counts.

**Why:** one HTTP request can only walk ~600 posts inside its 240s time budget, and a sync that always restarts from the newest post can never get past that depth — repeated syncs would re-walk the same pages forever. The Graph feed must be resumed where the last run stopped.

**How to apply:**
- Two phases: Phase A walks newest-first until a page adds **no new** posts (fresh content only); Phase B deep-backfills toward the stored targets, resuming from a cursor persisted in `crm_config` (`social.fb.deep_cursor`), with `social.fb.deep_done` set when the feed is exhausted.
- If the time budget interrupts mid-page, do NOT advance the resume cursor past that page (re-do it next run; `source_id` dedup makes that safe).
- The whole run holds a non-blocking in-process lock (409 if a sync is already running) so concurrent clicks can't race the cursor.
- Steady state (targets met): a sync is ~5s (one newest page, Phase B skipped).
- Trap when verifying via `GET /api/social/feedback`: it clamps at 5000 rows total — use the `type=` filter for per-type counts, or the "stalled" counts are just the clamp.
- Ops note: detached background processes (`setsid nohup … &`) do NOT survive the agent's bash session here; for long server-side jobs, fire the request with a short client timeout (server keeps processing after disconnect) and poll results in later calls.
