# Workspace-wide Performance Review

**Review date:** 2026-09-07  
**Scope:** Every registered production artifact plus the shared API, database, sync, rebuild, export, web, and mobile paths that serve them.  
**Method:** Read-only static inspection, existing build-output measurement, point-in-time process sampling, database statistics, and bounded metadata queries. No application behavior, schema, dependency, deployment, or production data was changed. No load test or destructive profiling was performed.

## Executive summary

The largest performance risk is concentrated in the shared Python API and data pipeline rather than in any single frontend. PostgreSQL currently estimates about **1.63 million live rows in `all_sales`**, **1.13 million in `rollup_merch_style_day`**, **1.07 million in `_msd_snapshot`**, and **631 thousand in `raw_shopify_orders`**. Several cold API queries aggregate these relations at style, inventory, or customer grain; existing rollups, TTL caches, stale-while-revalidate, single-flight controls, and indexes are important safeguards, but they do not remove first-request cost or all concurrent duplication.

The highest-confidence operational risks are:

1. Full sales rebuild paths still materialize Shop Zetu and Odoo rows in memory and expose a truncated/partially rebuilt `all_sales` table if interrupted.
2. Several main sync subprocesses have no runtime deadline, while the supervisor retries indefinitely.
3. Merchandising, inventory, fabric, PD, and production-metrics endpoints contain unbounded or effectively unbounded result/query shapes.
4. Vivo BI and CRM produce large request bursts; recurring polling can amplify the same shared backend paths.
5. Web and mobile clients frequently render large arrays without virtualization. Vivo BI’s existing build is about 12 MB, with a 1.2 MB main chunk and a 916 KB ExcelJS chunk; existing Expo JS bundles are about 4.1–4.3 MB per platform.

Runtime-confirmed bottleneck attribution is limited because `pg_stat_statements` is not installed as a database extension, `log_min_duration_statement` is disabled, and a broad relation-size query exceeded the safe 45-second budget. Therefore this report explicitly distinguishes confirmed code behavior and measured environment facts from query-cost suspicions that still need bounded plan evidence.

## Ranked optimization shortlist

| Rank | Root cause | Evidence class | Why first |
|---|---|---|---|
| 1 | Non-atomic, partly unbounded full `all_sales` rebuild | Code-confirmed; row scale measured | Can OOM or leave the primary BI fact table empty/partial; affects nearly all BI surfaces. |
| 2 | Main sync/rebuild subprocesses without deadlines and indefinite retry | Code-confirmed | One hung dependency can starve freshness and trigger recovery churn across the platform. |
| 3 | Merchandising full-style universe query and dependent fan-out | Code-confirmed; relation scale measured | Cold work joins products, orders, costs, inventory, sales/rollups and feeds several routes/exports. |
| 4 | Legacy inventory response allowing up to 100,000 grouped rows | Code-confirmed | Large DB sort/aggregation, JSON construction, compression, and transfer on one request. |
| 5 | Fabric register/count and ageing historical scans | Code-confirmed | Duplicate pre-pagination aggregation and all-history move joins; cold concurrency is not coalesced. |
| 6 | BI/CRM request bursts and recurring polling | Code-confirmed | Multiplies expensive shared API work during staff concurrency and dashboard navigation. |
| 7 | Unbounded PD/production tracker lists and metrics | Code-confirmed | Linear growth in query sorting, serialization, and payload size; no cache or pagination. |
| 8 | Non-virtualized web/mobile lists | Code-confirmed | Causes layout, memory, and interaction degradation as API results grow. |
| 9 | Large Vivo BI/community/mobile bundles and eager assets/fonts | Runtime-measured build outputs | Increases download, parsing, startup memory, and time-to-interactive, especially on mobile. |
| 10 | Missing production query attribution telemetry | Runtime-confirmed observability gap | Prevents ranking SQL by total time, calls, temp I/O, and real user parameters. |

## Finding register

### P0/P1 — database and pipeline

#### PERF-01 — Full sales rebuild can exhaust memory and expose partial data
- **Artifacts:** API Server; Vivo Fashion Group BI; Vivo BI Mobile; all consumers of `all_sales`
- **Location:** `transform_all_sales.py:275-383`, `transform_all_sales.py:386-577`, `watchdog.py:553-585`
- **Expensive behavior:** Shopify is streamed with a named cursor and 50,000-row insert batches, but Shop Zetu and Odoo use `fetchall()` and then build unbounded Python `insert_rows` lists. The rebuild commits `TRUNCATE all_sales` before all sources finish and commits batches while rebuilding.
- **Query shape:** Whole-source joins/deduplication followed by Python row conversion and bulk upserts.
- **Frequency/fan-out:** Full/manual/recovery rebuild; one failure has cross-platform impact.
- **Bounding/pagination:** Shopify bounded in memory; Shop Zetu and Odoo are not.
- **Cache/transaction/concurrency:** No cache relevance. Batch commits reduce transaction size but make partial visibility possible. Watchdog applies per-step timeouts when it invokes rebuild steps, but direct invocation has no deadline.
- **Evidence:** Code-confirmed. Database statistics estimate `all_sales` at 1,627,632 live rows. Historical comments record prior Shopify OOM.
- **Severity / confidence / impact / priority:** **Critical / High / platform-wide missing or partial BI data / P0**
- **Existing safeguards:** Shopify server-side cursor, 50k batches, watchdog fail-closed boot sequence, post-build `VACUUM ANALYZE`.
- **Evidence still needed:** Peak RSS and WAL during each source phase; bounded plan for source dedup joins; failure-injection proof of reader visibility.

#### PERF-02 — Main sync can hang indefinitely and retry-storm
- **Artifacts:** API Server and every data-consuming artifact
- **Location:** `sync_incremental.py:2533-3043`, `sync_incremental.py:3431`, `sync_incremental.py:3479-3863`, `sync_all.py:51-95`, `build_sales_rollups.py:33-53`
- **Expensive behavior:** Multiple synchronous subprocess calls have no timeout. The outer loop retries forever after a 60-second sleep without exponential backoff or a failure ceiling.
- **Frequency/fan-out:** Main scheduled cycle plus sales/fabric workers; a hung child delays freshness and can overlap supervisor recovery/manual work.
- **Bounding:** Some fabric and Shop Zetu worker subprocesses have explicit limits; several main-cycle calls and the generic orchestrator do not.
- **Concurrency:** In-process sales lock prevents worker/main overlap inside one process, but no shared cross-process guard was confirmed for all writers.
- **Evidence:** Code-confirmed. Point-in-time process sample observed `sync_incremental.py` and a heavy fabric child concurrently.
- **Severity / confidence / impact / priority:** **High / High / stale feeds, DB and upstream pressure, delayed recovery / P1**
- **Existing safeguards:** Heartbeats, watchdog recovery suspension, fabric lock/exit-code contract, selected subprocess timeouts, rate-limited source-failure logging.
- **Evidence still needed:** Per-step duration distribution and upstream timeout/error rates from structured cycle telemetry.

#### PERF-03 — Merchandising style universe is a cold full-portfolio computation
- **Artifacts:** Vivo Fashion Group BI
- **Location:** `merch_router.py:343-1040+`, `merch_router.py:6915-7263`
- **Expensive behavior:** The core universe aggregates product master dimensions and joins production orders/costs, inventory, sales or rollups. `/api/merch/styles` and CSV export return the full universe; trend endpoints compute current and prior windows sequentially.
- **Query shape:** Multi-CTE, multi-relation style-grain aggregation with `mode()`, distinct counts, OR joins to production orders, and downstream Python classification.
- **Frequency/fan-out:** Styles, summary, by-brand, by-subcategory, by-tier, trend variants, and export share the root computation. A single UI view can call several.
- **Bounding/pagination:** No result pagination for styles/export. Filters do not always reduce the core SQL universe before computation.
- **Cache/concurrency:** 600-second cache, SWR, rollup bridge, and per-key single-flight substantially mitigate repeat work; cache and locks are process-local.
- **Evidence:** Code-confirmed; major joined relations have measured statistical scale above 1 million rows. No plan captured.
- **Severity / confidence / impact / priority:** **High / High / 10–20s class cold-page risk, export memory, DB concurrency / P1**
- **Evidence still needed:** Bounded `EXPLAIN (FORMAT JSON)` for representative all-country and filtered keys; cold/warm route latency and payload bytes.

#### PERF-04 — Legacy inventory endpoint permits a 100,000-row grouped response
- **Artifacts:** Vivo Fashion Group BI; possible mobile/shared consumers
- **Location:** `api_pg.py:7807-7836`
- **Expensive behavior:** Scans inventory, joins product data, groups ten dimensions, orders by aggregated availability, and can JSON-encode/compress/transfer 100,000 rows. Leading-wildcard search is not supported by a normal btree.
- **Frequency/fan-out:** Per inventory page/search request; exact current caller count requires request tracing.
- **Bounding/pagination:** Hard cap is extremely high; no cursor or offset contract.
- **Cache/concurrency:** No route-level cache or single-flight identified.
- **Evidence:** Code-confirmed. `all_inventory` location index has about 1.49 million cumulative scans, showing the table is heavily used, not the cost of this route specifically.
- **Severity / confidence / impact / priority:** **High / High / slow inventory page, large API memory and network / P1**
- **Existing safeguards:** GZip middleware; aggregate limit prevents a literally infinite response.
- **Evidence still needed:** Actual payload distribution, caller parameters, plan with and without search, temp sort/I/O.

#### PERF-05 — Fabric register aggregates twice and paginates late
- **Artifacts:** Vivo Fashion Group BI fabric pages
- **Location:** `fabric_router.py:3480-3651`
- **Expensive behavior:** Consumption, reservations, latest moves, product/location expansion, and inventory aggregation happen before `LIMIT/OFFSET`; the count query repeats much of the product/location aggregation.
- **Frequency/fan-out:** Every register request plus page changes/searches.
- **Bounding/pagination:** Pagination exists but input clamping was not confirmed; OFFSET grows more expensive on later pages.
- **Cache/concurrency:** 60-second cache by raw request key; no cold single-flight.
- **Evidence:** Code-confirmed; no plan captured.
- **Severity / confidence / impact / priority:** **High / High / slow fabric register and avoidable DB load / P1**
- **Existing safeguards:** TTL cache, supporting indexes on fabric move/inventory columns, lazy schema/index setup.
- **Evidence still needed:** Plans for first, middle, and search pages; relation row counts; count-query share of latency.

#### PERF-06 — Fabric ageing and consumption can scan broad history
- **Artifacts:** Vivo Fashion Group BI fabric pages
- **Location:** `fabric_router.py:3658-3760`
- **Expensive behavior:** Ageing joins historical moves to each product and computes `MAX(date)` although only four buckets are returned. Consumption accepts a broad date window (default through 2099), aggregates an effective-moves view, and does not cap category/time-series output.
- **Frequency/fan-out:** Page/filter requests.
- **Bounding:** No enforced maximum history span; fabric breakdown alone is capped to 50.
- **Cache/concurrency:** 120-second cache, no cold coalescing.
- **Evidence:** Code-confirmed; no plan captured.
- **Severity / confidence / impact / priority:** **Medium-High / High / slow cold fabric analytics, duplicated concurrent work / P1**
- **Existing safeguards:** Relevant move indexes and TTL cache.
- **Evidence still needed:** `EXPLAIN` against representative 3-, 12-, and all-history windows; effective-view expansion cost.

### P1/P2 — backend requests, exports, and jobs

#### PERF-07 — PD and production metrics return unbounded collections
- **Artifacts:** Vivo Fashion Group BI; Vivo Digital Product Workspace
- **Location:** `pd_flow_router.py:462-485`, `production_workspace.py:4925-4965`
- **Expensive behavior:** PD board/completed routes select and serialize every row. Tracker metrics permit no date bounds and return all dimensions/periods ordered.
- **Query shape:** Full filtered table scans plus sort; Python conversion for every record.
- **Frequency:** Board, completed, and metrics page loads.
- **Bounding/cache:** No pagination, route cache, or single-flight. Neighboring production run/warning feeds are correctly capped at 100/200.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **High / High / progressively slower page loads and larger memory/payloads / P1**
- **Evidence still needed:** Current and projected row counts, payload sizes, sort plans/index support.

#### PERF-08 — PD boot reconciliation is N+1 and repeated
- **Artifacts:** API Server
- **Location:** `pd_flow_router.py:107-323`
- **Expensive behavior:** Many DDL statements run, then seed and Excel patch records perform individual lookups, updates/inserts, and image recompression/upserts on every process boot, followed by full movement reconciliation.
- **Frequency:** API process startup/restart.
- **Bounding/concurrency:** Linear in seed/patch size; no shared startup claim or bulk operation identified.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **Medium / High / delayed readiness and restart amplification / P2**
- **Existing safeguards:** Idempotent DDL/upserts and non-fatal patch handling.
- **Evidence still needed:** Startup phase timing and query count with current seed files.

#### PERF-09 — Full fabric reloads and supervisor recovery have residual overlap/blocking risks
- **Artifacts:** API Server
- **Location:** `extract_fabric.py:740-1048`, `watchdog.py:503-550`, `watchdog.py:692-698`
- **Expensive behavior:** Full fabric paths use truncate/reload and `full` is not protected like fast/heavy modes. Watchdog recovery runs synchronously in its health loop for up to 30 minutes.
- **Frequency:** Exceptional recovery/manual full operations.
- **Concurrency:** Strong guards exist for fast/heavy modes and normal recovery suspends the managed sync; a standalone full run and long health-loop blocking remain risks.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **Medium-High / Medium-High / stale monitoring, raw-table contention or partial refresh / P2**
- **Evidence still needed:** Process-tree behavior on timeout, full-mode operator history, table reader isolation.

#### PERF-10 — Backfill ranges are operator-unbounded
- **Artifacts:** API Server and BI data pipeline
- **Location:** `sync_incremental.py:419-420`, `sync_incremental.py:774`, `sync_incremental.py:870`; full Shop Zetu rebuild invocation at `watchdog.py:607-609`
- **Expensive behavior:** `--days` is parsed as an integer but not capped. Full Shop Zetu refresh grows with all history from 2022.
- **Frequency:** Recovery/manual/boot rebuild, not ordinary page traffic.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **Medium / High / unexpected upstream, DB, memory, and runtime load / P2**
- **Existing safeguards:** Normal incremental default is two days; watchdog recovery uses four; rebuild steps have a 5,400-second default timeout.
- **Evidence still needed:** Historical duration and volume per day/source.

### P1/P2 — web clients

#### PERF-11 — Vivo BI and CRM create large request bursts
- **Artifacts:** Vivo Fashion Group BI; Vivo CRM
- **Location:** `artifacts/vivo-bi/src/pages/Overview.jsx:575,654`; `Customers.jsx:438,490`; `artifacts/vivo-crm/src/pages/CustomerProfile.jsx:86`; `InsightsTabs.jsx:37,361`; `Training.jsx:132`
- **Expensive behavior:** BI Overview launches seven or more parallel requests; CRM Customer Profile launches about fifteen, while other CRM screens launch three to ten.
- **Frequency/fan-out:** On mount/filter/navigation and manual refresh. These bursts can converge on shared DB pools and heavy SQL.
- **Cache/concurrency:** Server caches help some BI routes. Client-side cancellation, shared aggregation, dedupe, and concurrency caps were not consistently evident.
- **Evidence:** Code-confirmed fan-out; runtime request waterfall not captured.
- **Severity / confidence / impact / priority:** **High / High / slow composite screens and amplified DB contention / P1**
- **Evidence still needed:** Browser HAR with route latency/payloads, cache hit telemetry, abandoned-request count.

#### PERF-12 — Recurring polling continues across several staff screens
- **Artifacts:** Vivo Fashion Group BI; Vivo CRM; Vivo HR; Vivo BI Mobile
- **Location:** BI `ProductionWallboard.jsx:115`, `StoreStockRequests.jsx:639`, `ActivityLogs.jsx:44`, `Overview.jsx:694`; CRM `AppShell.jsx:99`, `CustomerDatabase.jsx:82`; HR `AppLayout.jsx:143`; mobile `app/transfers.tsx:55-70`
- **Expensive behavior:** Poll intervals range from five seconds during CRM refresh to 30/60/120 seconds and 30 minutes. Visibility/focus pausing, jitter, backoff, and cancellation were not consistently confirmed.
- **Frequency:** Continuous while mounted; multiplied by active staff sessions.
- **Evidence:** Code-confirmed configuration.
- **Severity / confidence / impact / priority:** **Medium-High / High / recurring backend load, battery/network cost, synchronized bursts / P1**
- **Existing safeguards:** React Query stale times/auth gating on mobile; selected retry/error states.
- **Evidence still needed:** Production active-session counts and requests/minute by endpoint.

#### PERF-13 — Large web bundles and eager specialist dependencies
- **Artifacts:** Vivo Fashion Group BI; Vivo Community; Customer Report; Vivo Digital Product Workspace
- **Location:** artifact package manifests and existing `dist` outputs
- **Expensive behavior:** Existing output sizes: BI ~12 MB (main JS ~1.2 MB, ExcelJS ~916 KB, TargetsTracker ~616 KB); Community ~7 MB with a ~1.6 MB main JS chunk and ~6.2 MB assets; Product Workspace client ~2.7 MB and server ~3.4 MB (main ~628 KB, RangePlan ~572 KB); Customer Report ~960 KB with ~800 KB main JS.
- **Frequency:** Initial route/chunk downloads and parsing.
- **Evidence:** Runtime-safe filesystem measurement of existing builds; not a fresh production build.
- **Severity / confidence / impact / priority:** **Medium-High / High / slower first load and parse, especially on low-end devices / P2**
- **Existing safeguards:** Some separate chunks already exist; Vite production builds.
- **Evidence still needed:** Fresh compressed bundle report, route waterfall, source-map composition, cache headers.

#### PERF-14 — Web tables/lists are commonly non-virtualized
- **Artifacts:** Vivo Fashion Group BI; Vivo Community; Vivo CRM; Vivo HR; Vivo Digital Product Workspace
- **Location:** HR `Departments.jsx:278-325`, `Heatmap.jsx:155-201`, `DaysWorked.jsx:203`; representative BI/CRM/workspace/community `.map()` list/table paths
- **Expensive behavior:** Large arrays are filtered/sorted/mapped and mounted as ordinary DOM nodes; no virtualization library or `Virtual`/`FixedSize` usage was found in live source.
- **Frequency:** Every render/filter for affected lists.
- **Evidence:** Code-confirmed in cited HR screens; high-confidence representative sampling elsewhere.
- **Severity / confidence / impact / priority:** **Medium-High / High for HR, Medium elsewhere / scroll jank, memory, long commits / P1-P2**
- **Existing safeguards:** Some display caps (for example Days Worked at 500), component-level truncation, server limits on selected routes.
- **Evidence still needed:** Worst-case row counts and React Profiler commit/FPS measurements.

### P1/P2 — mobile clients

#### PERF-15 — Mobile lists render without native virtualization
- **Artifacts:** Vivo BI Mobile
- **Location:** `artifacts/vivo-mobile/app/transfers.tsx:151-155`; `app/(tabs)/products.tsx:42-72`; similar customer/inventory/CRM lists
- **Expensive behavior:** Potentially large collections are mapped inside `ScrollView`; no `FlatList` or `SectionList` usage was found. Transfers asks for 120 days and shows no client pagination.
- **Frequency:** Screen render/refetch.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **High when row counts grow / High / mobile memory, layout time, and scroll jank / P1**
- **Existing safeguards:** Product list is server-limited to 15; text truncation and thumbnail abstraction.
- **Evidence still needed:** Production response counts, device FPS/RSS, API maximums.

#### PERF-16 — Mobile query keys prevent reuse of overlapping dashboard data
- **Artifacts:** Vivo BI Mobile
- **Location:** `app/(tabs)/index.tsx:84-158`; `app/exec-summary.tsx:66-92`
- **Expensive behavior:** Dashboard issues four requests; Executive Summary requests overlapping KPI/country/footfall data under different cache keys, so sequential navigation repeats calls. Manual refresh fires each screen’s full set.
- **Cache:** Five-minute stale time helps within each key but not across differently named equivalent keys.
- **Evidence:** Code-confirmed.
- **Severity / confidence / impact / priority:** **Medium / High / repeated bandwidth and API bursts / P2**
- **Evidence still needed:** Navigation network trace and React Query cache snapshots.

#### PERF-17 — Mobile bundles, fonts, and WebView startup are substantial
- **Artifacts:** Vivo BI Mobile; Vivo Johari
- **Location:** existing static Expo builds; `vivo-mobile/app/_layout.tsx:24-95`; `vivo-community-mobile/components/CommunityWebView.tsx:562-620`
- **Expensive behavior:** Existing JS bundles are ~4.28 MB per platform for Vivo Mobile and ~4.11 MB for Johari. Each includes a ~1.31 MB MaterialCommunityIcons font. Vivo Mobile loads five Plus Jakarta Sans weights plus Feather before hiding splash. Johari adds WebView initialization and then loads the hosted Community web bundle.
- **Evidence:** Runtime-safe filesystem measurement and code-confirmed startup behavior.
- **Severity / confidence / impact / priority:** **Medium / High / cold start, parse/decode memory, double web/native startup / P2**
- **Existing safeguards:** Controlled splash, loading/error overlays, retry and process-termination reload, memoized WebView source.
- **Evidence still needed:** Release-compressed sizes, real-device cold start, used-font glyph/weight inventory, `/app` network waterfall.

## Database and runtime evidence appendix

### Safe database observations

- PostgreSQL version observed: 16.15.
- Planner/statistical live-row estimates:
  - `all_sales`: 1,627,632 live / 109,346 dead
  - `rollup_merch_style_day`: 1,130,357 live
  - `_msd_snapshot`: 1,066,940 live
  - `raw_shopify_orders`: 630,988 live / 21,035 dead
  - `customer_identity`: 507,661 live
  - `rollup_sku_velocity2`: 501,611 live
  - `all_customers`: 468,827 live
  - `raw_account_moves`: 310,070 live / 33,048 dead
  - `product_image_urls`: 259,776 live
  - `raw_account_move_lines`: 256,467 live / 23,420 dead
- High cumulative index usage includes the production-order unique index (~1.93M scans), `all_sales` SKU/date index (~1.88M), inventory location index (~1.49M), and stage-movement order index (~1.40M). These counters prove activity, not per-query speed.
- Many large tables have recent auto-analyze statistics. Some raw tables have no explicit `last_analyze`.
- `pg_stat_statements` preload support is configured, but the extension/view is absent.
- `log_min_duration_statement=-1` and `track_io_timing=off`; recent statement duration and I/O attribution are unavailable.
- A broad `pg_total_relation_size` ranking exceeded a 45-second safe timeout and was not retried.
- No `EXPLAIN ANALYZE`, writes, production load test, or uncontrolled query was run.

### Point-in-time process evidence

This is a single sample, useful for locating expensive development processes but not a capacity baseline:

| Process | CPU | RSS |
|---|---:|---:|
| Expo workflow 1 | ~57% | ~989 MB |
| Expo workflow 2 | ~49% | ~948 MB |
| Vivo BI Vite | ~20% | ~537 MB |
| API (`run_api.py`) | ~8.5% | ~147 MB |
| Test suite | ~15% | ~190 MB |
| Heavy fabric extract | ~17% | ~52 MB |
| Incremental sync | ~2.4% | ~63 MB |

These figures include development tooling/startup and must not be treated as production steady-state values.

### Existing performance safeguards

- API DB pool budget and one-worker production default.
- In-process query cache with maximum entry count.
- Smart TTL, stale-while-revalidate, bounded refresh threads, and dashboard snapshot single-flight.
- Heavy-dashboard prewarming and rollup freshness/watermark checks.
- Merch per-key cache and single-flight.
- GZip responses.
- Shopify rebuild streaming and 50k insertion batches.
- Sales worker serialization, fabric fast/heavy guards, subprocess deadlines on selected paths.
- Watchdog liveness/readiness separation, sync heartbeat monitoring, recovery suspension, and bounded recovery/rebuild steps.
- Existing index creation for common fabric move/inventory predicates.
- React Query stale times/auth gating in mobile and explicit loading/error UI in several apps.

## Artifact coverage matrix

| Registered artifact | Live ownership reviewed | Main findings / status |
|---|---|---|
| API Server | Python `api_pg.py` shared API and Node `artifacts/api-server` package/runtime; sync/watchdog/rebuild ownership | PERF-01–10; shared root of most DB and job risk. Node package/route structure inspected; detailed route SQL needs separate measured attribution. |
| Vivo Fashion Group BI | Live Vite frontend plus shared Python routes | PERF-03–06, 11–14; largest existing web build and broadest backend fan-out. |
| Vivo Community | Live Vite `/app` frontend and shared community API registration | PERF-13–14; 7 MB existing build, 1.6 MB main JS, asset-heavy. No recurring polling found in sampled source. |
| Vivo Johari | Expo WebView wrapper over Vivo Community | PERF-17; native bundle plus hosted web-app startup. Wrapper has good retry/cleanup safeguards. |
| Vivo CRM · Clienteling | Live Vite frontend and `crm_clienteling.py` shared backend | PERF-11–14; highest identified single-screen request burst (~15). Full backend SQL plan coverage remains needed. |
| Vivo HR · Attendance | Live Vite frontend and `hr_attendance.py` shared backend | PERF-12, 14; multi-request screens and non-virtualized/nested tables. No existing `dist` was available for size measurement. |
| Vivo SZ CRM | Live Vite loyalty frontend and shared loyalty backend | Small sampled client; no recurring polling or major fan-out found. Direct fetches remain unmeasured. |
| Vivo BI Mobile | Expo native client over shared API | PERF-12, 15–17; non-virtualized lists, duplicate query keys, ~4.28 MB existing JS bundle. |
| Vivo Digital Product Workspace | Vite client plus Node server workflow and production workspace Python integration | PERF-07, 13–14; server has parallel DB metadata calls and timeout safeguards; full query-plan evidence remains needed. |
| Customer Report · CSV Export | Vite data app | PERF-13; ~800 KB main JS for a focused app, eager workbook/export path. Export peak memory and maximum customer count remain unmeasured. |
| Retired Vivo Loyalty PWA | Registered as retired; no active workflow | Excluded from optimization priorities as required. No live-build/runtime effect identified. |

## Exact evidence still needed

1. Install/enable a safe query-attribution mechanism (prefer `pg_stat_statements` with an agreed reset/observation window, or managed database query insights) and collect calls, total/mean/p95 time, rows, shared/temp blocks, and normalized query IDs.
2. Run bounded `EXPLAIN (FORMAT JSON, BUFFERS false)` for representative high-risk SELECTs using real but non-sensitive filter shapes. Use `EXPLAIN ANALYZE` only on a read-only replica or after a strict statement timeout and operator approval.
3. Record route-level cold/warm latency, payload bytes, cache hit/stale-hit/miss rates, DB wait time, and concurrent in-flight counts.
4. Capture one authenticated browser network waterfall for BI Overview, Merch, Fabric Register, CRM Customer Profile, and Product Workspace Command Centre.
5. Produce fresh production-mode bundle analyzer output with raw, gzip, and Brotli sizes by route/chunk.
6. Capture representative real-device mobile cold-start, JS thread FPS, memory, and list row counts.
7. Add per-step sync telemetry for duration, source rows read/written, peak RSS, retries, timeout, and overlap claim outcome.

## Recommended future sequence

1. Make the sales rebuild bounded and atomic before tuning dashboard SQL.
2. Put hard deadlines and shared overlap protection around every scheduled subprocess and backfill.
3. Enable query attribution, observe a representative business week, then collect bounded plans for the top total-time queries.
4. Bound/paginate the inventory, merch styles/export, fabric register/consumption, PD, and tracker-metrics contracts.
5. Reduce BI/CRM request fan-out and make polling focus/visibility-aware with dedupe and backoff.
6. Virtualize the largest web/mobile lists using measured production row distributions.
7. Split/lazy-load specialist export/chart dependencies and unused fonts/assets based on fresh bundle composition.

This sequence intentionally identifies work only; no optimization has been applied in this review.