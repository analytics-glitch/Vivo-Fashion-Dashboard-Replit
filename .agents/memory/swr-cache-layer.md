---
name: Stale-while-revalidate cache layer
description: SWR semantics of the api_pg in-process cache — grace window, single-flight refresh, bypass_key re-entrancy, and where staleness is NOT allowed.
---

The in-process cache serves expired-but-in-grace entries instantly (grace = min(max(ttl*2,120), 3600)) and recomputes in a single-flight background daemon thread (bounded, `_swr_inflight` under `_CACHE_LOCK`). Applied at `run_query` AND the whole-response endpoint caches.

**Why:** a lapsed TTL or an unprewarmed filter combo made a real user eat the full 5–35s query; data changes at sync-loop cadence, so one briefly-stale response is invisible.

**How to apply / invariants:**
- Refresh threads recompute by re-calling the SAME endpoint function with EXPLICIT kwargs; a thread-local `bypass_key` forces a miss for ONLY that key so the re-entrant call does real work (sub-query caches still hit). Never bypass globally — refreshes would recompute everything.
- Any new whole-response cache should use `cache_get_swr` + `swr_refresh` unless staleness is unacceptable: mutation-adjacent reads (e.g. replenishment-sor, whose mutations bypass via `nocache=1`) must NOT background-refresh into keys a mutation just invalidated by convention.
- Snapshot-keyed caches (`_inventory_version()` in the key) are safe: key rollover isolates new snapshots; stale old-key entries just age out.
- `cache_get` (fresh-only) still exists and wraps `cache_get_swr`; stale entries are no longer deleted on read, only past grace.
- SWR pressure is observable in the cache-stats payload (`stale_hits`, `refreshes_inflight`).
