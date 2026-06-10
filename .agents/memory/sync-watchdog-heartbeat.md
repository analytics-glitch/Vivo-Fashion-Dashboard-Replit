---
name: Sync watchdog health must key off a loop heartbeat
description: Why sync liveness/health is measured by a heartbeat, not all_sales.loaded_at, and how recovery avoids overlap
---

# Sync watchdog: heartbeat, not data freshness

The 24/7 supervisor (`watchdog.py`) and `/api/sync-status` measure sync **loop
liveness** via a heartbeat (`sync_heartbeat.last_cycle_at`, written by
`sync_incremental.py` at cycle start, after each store, and at cycle end). They
do **NOT** use `all_sales.loaded_at`.

**Why:** during quiet sales periods no new rows land, so `MAX(loaded_at)` stops
advancing even though the sync loop is perfectly healthy. Keying health off
`loaded_at` made the watchdog falsely flag failure → needless restart/backfill
thrashing and a status pill that turns red at night. Data freshness is still
reported, but only as informational `data_freshness` in the endpoint.

**How to apply:**
- If you add a new "is the pipeline healthy?" signal, base it on the heartbeat
  (loop progress), and report data age separately. Don't conflate the two.
- The heartbeat staleness threshold (`SYNC_FRESH_MIN`, ~15m) must stay larger
  than a normal full cycle, but the loop heartbeats per store so a 15m gap means
  genuinely stuck, not just slow.

# Recovery must not overlap the supervised sync

`run_recovery()` adds `sync` to a `_suspended` set and terminates the managed
sync **before** launching the one-shot backfill, then respawns it in a `finally`.
`supervise_loop()` skips suspended names so it won't respawn the sync mid-backfill.

**Why:** the original code restarted the sync AND spawned a second
`--once` backfill in the same cycle, running two concurrent expensive pulls
(rate-limit pressure, duplicate work). Recovery and the supervised loop must be
mutually exclusive. Also validate the backfill `returncode` — a non-zero exit
must be reported as FAILED, not silently treated as success.
