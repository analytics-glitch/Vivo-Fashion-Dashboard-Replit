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

# Fabric feed is watched separately (data-gated, escalating rescue)

The fabric worker (daemon thread inside the sync process) beats
`fabric_heartbeat`; the watchdog checks it INDEPENDENTLY of `sync_heartbeat`.
Fabric health gates on BOTH the heartbeat AND
`MAX(raw_fabric_products._loaded_at)` — the fabric EXCEPTION to the
"heartbeat, not data freshness" rule above: every successful fabric pull
rewrites `_loaded_at` on ALL rows (even with 0 changed rows), so data age IS a
true failure signal there, unlike all_sales where quiet periods stall it
legitimately. `run_recovery()` still ends with a fabric kick, because a
`--once` backfill deliberately skips the fabric worker.

**Why:** heartbeat-only gating let the feed sit 15+ h stale while looking
healthy — see the lock-skip contract below.

**Lock-skip exit-code contract:** `extract_fabric.py` exits 0=success,
1=error, 3=skipped (its pg advisory lock is held; NOTHING was refreshed).
Consumers must treat rc=3 as not-success: the fabric worker writes no
heartbeat and rolls back its 60s rate-limit stamp so the next ~20s tick
retries (fast lands the moment heavy releases the lock). Exiting 0 on
lock-skip was the root bug: heavy held the lock, fast "succeeded", the
heartbeat stayed fresh, the watchdog never fired.

**Rescue ladder:** one-shot `--mode fast`, timeout = the SHARED
`FABRIC_EXTRACT_TIMEOUT_SEC` env var (watchdog fallback 300s; the old
hardcoded 120s could never beat a slow-but-alive Odoo, so recovery failed
forever). Cooldown 60 min normally, 10 min once data >4 h stale; after ≥3
consecutive failed recoveries with data >6 h stale the health loop escalates
to `restart_proc("sync")` to re-spawn the worker thread.
`run_fabric_recovery()` itself owns the failure counter (reset on rc=0,
lock-skips count as failures), so the post-recovery refresh call counts too.

**Gotchas:**
- Only the supervised thread beats `fabric_heartbeat` — a successful one-shot
  rescue refreshes DATA but not the heartbeat, so "fabric stale" warnings
  continue until the thread revives (the escalation eventually restarts it).
- `--mode fast` covers products+inventory only; BOMs/moves/POs need the
  thread's heavy cadence.
- An escalation restart does NOT kill an orphaned heavy-extract child — it
  keeps holding the advisory lock, so fast pulls lock-skip (now honestly)
  until it exits.
