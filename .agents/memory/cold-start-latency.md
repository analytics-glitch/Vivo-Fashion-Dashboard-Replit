---
name: Cold-start query latency
description: Why queries are slow after a restart and how to mitigate it
---

## The problem
After any API server restart, two caches go cold simultaneously:
1. **App SWR cache** — in-process, lost on restart
2. **Postgres shared_buffers** — OS may evict pages; `all_sales` is 962 MB,
   far larger than typical shared_buffers (~128-256 MB), so only a fraction
   stays warm.

Combined effect: first requests after restart do 3,000+ disk reads per query,
turning a 50 ms warm query into a 2-3 s cold one.

**`pg_prewarm` is NOT available** on this Postgres instance.

## The fix (implemented)
1. **`smart_ttl` for today's date**: 120 s → 300 s (matches frontend 5-min
   staleTime; sync is hourly so 5-min staleness is invisible to users).
2. **PG buffer warmup in prewarm loop**: at the start of every 600 s cycle,
   run three warming queries (90-day slice of all_sales, all_inventory,
   all_products_clean) that load the most-used pages into shared_buffers.
3. **KPI prewarm targets**: four date presets (today, MTD, 7D, 30D) added to
   `_warm_loop` so the filter-bar's most common requests are cache-hot 90 s
   after restart.

## How to apply
- `_warm_loop` in `_start_cache_prewarmer()` (api_pg.py ~line 1501)
- `smart_ttl` at api_pg.py ~line 144
- The prewarm delay is 90 s (let boot traffic settle first)

## Fuzzy-join lesson (production summary, Jul 2026)
- A per-row fuzzy `LEFT JOIN LATERAL` (exact + ILIKE-prefix conditions) against
  a large dim table took ~28s per pass — and even a plain
  `LEFT JOIN (DISTINCT ON ...) cat ON cat.style_name = po.style_name` timed out
  (>100s) because the planner re-executed the DISTINCT ON subquery per outer row.
- **Rule:** for small fact tables (~hundreds of rows) needing fuzzy dim lookups,
  fetch the dim ONCE and match in Python (exact → stripped → prefix). Sub-second
  vs. minutes, and coverage improved (151→3 unmatched orders).
