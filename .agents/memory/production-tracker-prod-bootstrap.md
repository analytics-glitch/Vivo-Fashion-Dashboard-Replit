---
name: Production tracker prod bootstrap
description: Why/how the production tracker (DPS buying-order kanban) self-populates on the separate prod DB via the incremental sync loop.
---

The production tracker board (`/api/production`, tables `production_orders` + append-only `stage_movements`, views `v_stage_balances`/`v_wip_summary`) reads its own DB rows. Prod is a SEPARATE database that ships code + schema but NO data rows, so the board starts empty there even though dev is seeded (~316 DPS orders).

**Rule:** populate prod the same way fabric does — bootstrap from inside the supervised incremental sync loop, not via a one-off the agent runs (the agent cannot write to prod; only read-only prod queries are available).

**How to apply:**
- `sync_incremental.py main()` runs `sync_production_tracker.py` (subprocess) with a "bootstrap-when-empty, else every 30 minutes" guard (mirrors the fabric extract block): presence/empty check on `production_orders`, single module guard `_LAST_PRODUCTION_SYNC` (1800s threshold). So on first publish prod populates immediately, then refreshes every 30 min as DPS orders grow. (There used to be a SECOND, redundant hourly block with guard `_LAST_PRODUCTION_TRACKER_SYNC` — removed; keep ONE block so it doesn't double-sync. The retained block skips when the table is missing instead of erroring every cycle on a cold DB.)
- `sync_production_tracker.py` is idempotent — upsert on `order_ref`, and intake movements append only the delta between DPS qty and what's already taken in (re-running never double-counts). It also calls `ensure_schema()` (runs `production_tracker_schema.sql`, all idempotent) so it's safe on a fresh prod DB and as a standalone backfill, independent of the API startup hook.

**Why:** matches the fabric/attendance prod-bootstrap convention already in the sync loop; keeps prod continuously in sync without a manual REBUILD_ON_BOOT-style gate.

**Verification:** the agent cannot publish, so prod stays empty until the user publishes. After publish, verify with a read-only prod query: `SELECT COUNT(*) FROM production_orders` (expect ~dev count) and `SELECT * FROM v_wip_summary`.
