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

## The trap: prod's SOURCE tables are incomplete, so a transform-only rebuild corrupts
`transform_all_sales.py` reads three sources: `shopify_sales` (Shopify retail
history), `raw_shopify_vendor_sales` (Online/Shop Zetu), `raw_odoo_*`. The
killer: **`shopify_sales` is populated ONLY by `shopify_full_extract.py`** — the
incremental sync never writes it. On a fresh prod DB `shopify_sales` is **empty**
(prod maintains `raw_shopify_sales` + `all_sales` directly, NOT `shopify_sales`),
so a transform-only rebuild logs `Shopify deduped rows: 0` and the TRUNCATE wipes
every Shopify retail row (Kenya pre-2026-03-20, Uganda, Rwanda) — only Odoo +
Shop Zetu survive. Separately prod's `raw_shopify_vendor_sales` was doubled +
un-netted (net==gross, ~2.6× dev all-time) = legacy rows from before the dedup
key/DELETE existed → Online over-reads (e.g. 39.98M vs correct 26.40M).

**Don't trust "rebuild COMPLETED successfully"** — it only means rc==0. Verify
the per-source insert lines (`Shopify deduped rows`, `Shop Zetu rows`, `Odoo raw
rows`) are all non-zero and the summary lists `vivowoman`/`vivo-uganda`/
`vivo-rwanda`, not just `vivofashiongroup` + `shop-zetu`.

## How to correct production data
`watchdog.py` one-time gate: `REBUILD_ON_BOOT` (+ `REBUILD_REFRESH_RAW` default
`1`, `REBUILD_TIMEOUT_SEC`). Runs **after** the API is up (startup health passes)
but **before** the sync loop/health threads start, so it can't overlap the sync
(overlap doubles history — no PK guard on all_sales). When `REBUILD_REFRESH_RAW=1`
it re-extracts ALL sources first: `shopify_full_extract.py` → `shopify_sales`,
`extract_shopzetu_sales.py --since=2022-01-01 --until=today` → vendor_sales
(delete-by-window+insert un-doubles + re-nets), Odoo products+orders, THEN
`transform_all_sales.py` last (only TRUNCATEs when about to repopulate, so an
aborted source refresh leaves all_sales untouched, not empty).

Procedure: set `REBUILD_ON_BOOT=1`, **leave `REBUILD_REFRESH_RAW=1` (do NOT set
0)**, raise `REBUILD_TIMEOUT_SEC` (~7200; first Shopify full extract is the long
pole) → publish off-peak → verify the non-zero per-source logs above →
**unset `REBUILD_ON_BOOT` and republish**.

**Why REBUILD_REFRESH_RAW=0 is a trap:** it transforms prod's sources as-is, but
prod's `shopify_sales` is empty → drops all Shopify retail. Only set 0 if every
source is already known complete & clean (basically never true on prod).

**How to apply:** any time someone fixes the transform/ETL or rebuilds in dev and
the published app still shows wrong numbers — prod doesn't run the rebuild AND
its source tables may be empty/dirty; use REBUILD_ON_BOOT with the source refresh
ON, don't just re-publish or skip the refresh.

## Rebuild timeout → watchdog DEGRADED MODE freezes prod (sync OFF until republish)
On `REBUILD_ON_BOOT=1`, if a rebuild step exceeds `REBUILD_TIMEOUT_SEC` the watchdog
**kills the step, ABORTS the whole rebuild, and refuses to start the sync loop** —
it idles in "degraded mode, operator action required" (`rebuild_on_boot_failed`).
So the dashboard freezes at the last pre-rebuild `loaded_at` and stays frozen on
every VM restart (REBUILD_ON_BOOT re-triggers each boot) until someone republishes.
The app keeps serving (heartbeats/sync-status 200) — only the data feed is dead.

`REBUILD_TIMEOUT_SEC=7200` (2h) is **far too small** for the first run: the long
pole is `shopify_full_extract.py` re-walking ALL history from 2021 in ~15-day
batches, per store (vivowoman/uganda/rwanda). Observed: in 2h it only reached
~late-2023 for one of three stores. It **is checkpointed** ("Checkpoint advanced
to …") so it resumes, not restarts — but completing once needs many hours; set
`REBUILD_TIMEOUT_SEC` ~28800 (8h) and publish off-peak.

Recovery choices when found parked in degraded mode (all are USER actions — agent
can't set prod secrets / republish):
- **Restore live data fast:** set `REBUILD_ON_BOOT=0` (or delete) + republish →
  normal boot, incremental sync resumes, dashboard catches up in minutes. The
  in-progress raw extract only wrote `shopify_sales` (transform never ran), so
  all_sales is untouched and nothing is lost; the historical correction is just
  deferred.
- **Actually finish the correction:** keep `REBUILD_ON_BOOT=1`, raise
  `REBUILD_TIMEOUT_SEC` to 8h+, republish off-peak (resumes from checkpoint),
  watch for the COMPLETED log, then `REBUILD_ON_BOOT=0` + republish.
**Why:** the abort-and-don't-start-sync is intentional (a half-done rebuild must
not overlap the sync), but the side effect is a fully frozen prod until a human
republishes — so the timeout must be generous enough to finish in one boot.

## Lighter alternative: marker-guarded one-time data fix in the sync loop
When the prod-only damage is a **bounded, precisely-identifiable row set** (e.g.
Kenya `vivofashiongroup` rows dated before the 2026-03-20 cutover duplicating
Shopify's `vivowoman` rows → March 2026 double-counted by ~44M), a full
REBUILD_ON_BOOT is overkill. Instead ship a one-time fix at the top of
`sync_incremental.py main()`: `app_config` marker key (`data_fix_*_v1`) checked
first; if absent, run the idempotent DELETE and INSERT the marker **in the same
transaction**; publish and the next prod sync cycle applies it. In dev the
delete is a 0-row no-op (dev already rebuilt) and the marker still stamps.
**Why:** the rebuild gate needs prod secrets + hours of re-extract + operator
publish choreography; a scoped delete needs none of that and can't corrupt
other history — but ONLY when the bad rows are exactly expressible in a WHERE
clause verified against BOTH dev and prod (check the store_id↔country mapping
first so the predicate can't touch other markets).

## Curated small tables: committed snapshot + guarded boot seed
When a curated, operator-maintained table (hand-imported sheet data, e.g. style
tier overrides) must match between dev and prod, ship it as data-in-code: the
import script writes the table AND regenerates a committed JSON snapshot (rows +
version stamp = the table's `MAX(imported_at)`); a deferred-startup seeder
applies the snapshot only when it is strictly NEWER than what the DB holds,
replacing the table contents in one advisory-locked transaction (DELETE, not
TRUNCATE — MVCC-safe) and stamping applied rows with the snapshot version so the
next boot no-ops. Refuse to write or apply an EMPTY snapshot (a broken export
must never wipe prod). Keep the DDL + export/apply logic in one shared module
(with an operator CLI) used by both the import script and the API boot, so they
can't drift; add a live-parity unit test (snapshot == dev table) to the `test`
workflow so a re-import without committing the refreshed snapshot fails CI.
**Why:** publish never copies rows and the agent can't write to prod; the sync
loop shouldn't own one-off curated data and REBUILD_ON_BOOT is overkill.
**How to apply:** any "prod shows the computed fallback while dev shows curated
data" divergence on a small table — reuse this pattern instead of running a
script against prod.

## Same trap for any NEW raw source: it must be wired into the sync loop
Adding a new Odoo/Shopify extract that writes its own `raw_*` tables (e.g.
`extract_fabric.py` → `raw_fabric_*` feeding `/fabric`) and running it only by
hand in dev means **prod's separate DB never gets the data** → the page shows all
zeros after publish even though dev looks fine. Fix pattern: hook the extract into
`sync_incremental.py` with **bootstrap-if-empty** (`SELECT to_regclass(...)` →
NULL/0 rows ⇒ run it that cycle, so a fresh prod DB self-populates on the first
sync after deploy, no manual gate) **plus** a nightly refresh in the existing
21:00-UTC window. Only safe if the extract is a full TRUNCATE+upsert refresh.
**Why:** the dev-watchdog and deploy-watchdog pipelines are independent; anything
not in the supervised sync simply never runs in prod.
