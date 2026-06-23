---
name: Production tracker prod bootstrap
description: Why/how the production tracker (DPS buying-order kanban) self-populates on the separate prod DB via the incremental sync loop.
---

The production tracker board (`/api/production`, tables `production_orders` + append-only `stage_movements`, views `v_stage_balances`/`v_wip_summary`) reads its own DB rows. Prod is a SEPARATE database that ships code + schema but NO data rows, so the board starts empty there even though dev is seeded (~316 DPS orders).

**Rule:** populate prod the same way fabric does — bootstrap from inside the supervised incremental sync loop, not via a one-off the agent runs (the agent cannot write to prod; only read-only prod queries are available).

**How to apply:**
- `sync_incremental.py main()` runs `sync_production_tracker.py` (subprocess) with a "bootstrap-when-empty, else hourly" guard (mirrors the fabric extract block): presence/empty check on `production_orders`, module guard `_LAST_PRODUCTION_TRACKER_SYNC`. So on first publish prod populates immediately, then refreshes hourly as DPS orders grow.
- `sync_production_tracker.py` is idempotent — upsert on `order_ref`, and intake movements append only the delta between DPS qty and what's already taken in (re-running never double-counts). It also calls `ensure_schema()` (runs `production_tracker_schema.sql`, all idempotent) so it's safe on a fresh prod DB and as a standalone backfill, independent of the API startup hook.

**Why:** matches the fabric/attendance prod-bootstrap convention already in the sync loop; keeps prod continuously in sync without a manual REBUILD_ON_BOOT-style gate.

**Verification:** the agent cannot publish, so prod stays empty until the user publishes. After publish, verify with a read-only prod query: `SELECT COUNT(*) FROM production_orders` (expect ~dev count) and `SELECT * FROM v_wip_summary`.
