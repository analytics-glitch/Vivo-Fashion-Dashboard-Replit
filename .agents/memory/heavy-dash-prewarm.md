---
name: Heavy dashboard cache pre-warmer
description: Whole-history analytics endpoints are kept permanently warm by a background thread; TTL/interval contract and pitfalls.
---

Heavy whole-history dashboards (weeks-of-cover, aged-stock, range classify / store-tier-mix / weekly-sor, store-overstock, declining-styles, excess-inventory) take 10–20s cold. Indexes can't help — they're full-table aggregations. Fix: `HEAVY_DASH_TTL=900` on their `run_query` calls + a `@_deferred_startup` daemon thread that re-computes the default (unfiltered) views every 600s, so no user ever pays the cold cost.

**Why:** with the default 120s smart_ttl, the first user of every 2-minute cycle ate a 10–20s wait and reported the whole dashboard as "very slow". Splitting frontends can't fix this — all apps share one API + one DB.

**How to apply:**
- Any new heavy no-date-filter endpoint should get `ttl=HEAVY_DASH_TTL` and be added to the prewarmer target list.
- Call endpoint functions with EXPLICIT kwargs from the warmer — calling a FastAPI endpoint function directly otherwise passes `Query(...)` sentinel objects as values.
- Warm interval must stay well under the TTL (600 vs 900) or the cache lapses between cycles.
- `_cache` is now guarded by `_CACHE_LOCK` (request threads + warmer race the eviction path otherwise). Keep get/set locked.
- Use `print(..., flush=True)` for warmer heartbeat lines — `log.info` from api_pg is invisible in deployed logs.
