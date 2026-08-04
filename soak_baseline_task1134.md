# Slow-query soak baseline — Task 1134 (dashboard precompute)

Snapshot taken **2026-08-04** from `sync_health_log` (queries >5s, prior 7 days:
2026-07-28 → 2026-08-04), BEFORE the rollup cutovers in this task went live.
Total ≈ 3,100 slow-query rows over the window (~443/day).

## Baseline counts by signature (7 days, count × avg seconds)

| # | Signature (first distinctive fragment) | Endpoint / source | 7d count | avg s |
|---|---|---|---|---|
| 1 | `WITH sv AS (` style×store 28d velocity | IBT suggestions `_ibt_base_ctes` | 269 | 12.7 |
| 2 | weeks-of-cover 56d vel CTE | `/api/analytics/weeks-of-cover` | 239 | ~8 |
| 3 | store-overstock 56d vel CTE | `/api/analytics/store-overstock` | 218 | 17.7 |
| 4 | 56d per-sku vel scan (live velmap) | `_ibt_store_sku_velocity` (country-scoped) | 200 | 8.9 |
| 5 | declining-styles 56d FILTER CTE | `/api/analytics/declining-styles` | 197 | ~9 |
| 6 | customer id-bridge | hourly customer rollup refresh | 168 | 21.8 |
| 7 | classify `nos`/`prod` CTEs | `/api/range-mgmt/classify` | 147 | 20.1 |
| 8 | exec-summary `at` CTE | `/api/exec-summary` | 145 | ~10 |
| 9 | aged-stock last-sale live fallback | `/api/analytics/aged-stock` | 145 | 16.6 |
| 10 | PG buffer-warmup 90d scan | `_start_cache_prewarmer` | 111 | 16.6 |
| 11 | weekly-SOR CTE | `/api/range-mgmt/weekly-sor` | 95 | ~9 |
| 12 | footfall daily CTE | footfall / quarter scorecard | 59 | 8.8 |
| 13 | sor-all-styles 180d sales CTE | `/api/analytics/sor-all-styles` | 57 | 22.5 |

Notes from the measurement phase: most rows are **contention victims** — the
10-minute sync loop, hourly full rollup rebuilds, and the perpetual 600s
buffer-warm scan stacked on top of whatever user queries were in flight.
Signatures 2, 8, 11, 12 measured fast in isolation (<1.5–3s) and were left
live; they are expected to fall out of the log once the contention sources
(1, 3, 4, 5, 7, 10, 13 + the watermark-skipped hourly rebuild) are gone.

## What changed (2026-08-04)

- New rollups: `rollup_store_style_sales`, `rollup_rm_months`, `rollup_rm_prod`;
  extended v2 columns on `rollup_rm_style`, `rollup_sku_velocity2`,
  `rollup_style_velocity2` (`_ROLLUP_SCHEMA_VER = 2`).
- Cutovers (rollup-first, live fallback): IBT sv CTE, IBT velmap (country),
  warehouse→store, store-overstock vel, declining-styles, classify nos/prod,
  sor-all-styles, new-styles L10.
- Hourly rebuild now **skips on unchanged source watermark**
  (`MAX(all_sales.loaded_at)` + product count + build date).
- Prewarmer: buffer-warm scan only first 3 cycles after boot; rollup
  staleness self-heal kick (>90 min → `build_sales_rollups.py` subprocess,
  ≥20 min apart).

## How to re-measure (run after ≥3 days of soak)

```sql
-- slow-query rows/day, last N days vs the 443/day baseline
SELECT DATE(created_at) AS day, COUNT(*) AS slow_rows
FROM sync_health_log
WHERE event = 'slow_query' AND created_at >= now() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1;
```

Success criterion (task Done-looks-like): the addressed signatures (1, 3, 4,
5, 7, 10, 13) each show **>80% fewer** rows/day than the baseline column
above, and no NEW recurring signature appears in the top list.
