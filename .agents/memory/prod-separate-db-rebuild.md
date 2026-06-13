---
name: Production is a separate self-maintained DB; dev rebuilds don't reach it
description: Why a full rebuild in dev never fixes the published dashboard, and the one-time REBUILD_ON_BOOT gate that does.
---

# Production all_sales is a SEPARATE database from development

Dev and the published deployment use different Postgres DBs. The deployed
api-server runs `watchdog.py` on a Reserved VM (`WATCHDOG_MANAGE_API=1`) which
supervises uvicorn + `sync_incremental.py` against **production's own** DB.

**Production never runs `transform_all_sales.py`** (the full rebuild) — only the
incremental sync (recent days + a 4-day recovery backfill). So:
- A full rebuild run in dev corrects the **dev** DB only.
- Publishing ships code + migrates schema but **does not copy data rows**.
- Production historical rows are frozen at whatever logic last wrote them and
  never self-heal; only the last few days get refreshed by incremental sync.

**Why:** there are two independent pipelines (dev workspace watchdog → dev DB;
deployment watchdog → prod DB) that drift apart over time. Observed: prod Kenya
Jan–Jun 2026 = 438M/31,350 vs corrected dev 398.8M/45,105 (matches BigQuery).

## How to correct production data
`watchdog.py` has a one-time gate `REBUILD_ON_BOOT` (+ `REBUILD_REFRESH_RAW`,
`REBUILD_TIMEOUT_SEC`). It runs **after** the API is up (startup health passes)
but **before** the sync loop/health threads start, so the rebuild can't overlap
the sync (overlap doubles history — no PK guard on all_sales). Procedure:
set `REBUILD_ON_BOOT=1` as a deployment secret → publish off-peak (live
dashboard reads a partial table during the rebuild) → confirm the success log →
**unset and republish** so it doesn't rebuild on every VM restart.

**How to apply:** any time someone fixes the transform/ETL or rebuilds data in
dev and asks why the published app still shows old numbers — the fix is in the
rebuild path prod doesn't run; use REBUILD_ON_BOOT, don't just re-publish.
