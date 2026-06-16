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
