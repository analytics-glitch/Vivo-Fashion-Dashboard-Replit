---
name: Merch style-universe single-flight
description: Merchandising hub endpoints must share ONE style-universe computation (async future layer + per-key lock) and never run its blocking SQL on the event loop.
---

# Merch style-universe single-flight

**Rule:** Any `/api/merch/*` endpoint needing style-universe rows must get them through the shared single-flight helpers (async future layer for request handlers, sync per-key-locked cache underneath) — never by wrapping the raw fetch in its own per-endpoint cache, and never as an async-def handler calling blocking SQL directly. Per-style drill-downs stay sync `def` (threadpool).

**Why:** 2026-08-13 "Merchandising page is quite slow". The Overview tab fires five parallel endpoints that all need the same ~15s universe rowset; each was async-def blocking the event loop with its own cache-miss execution (up to 7 runs counting trend prev-windows) — the page took minutes and the entire app froze meanwhile (same starvation class as the prod healthcheck blip). Naive fix (all-sync handlers + lock waiters) parks a threadpool token per waiter and can exhaust AnyIO's ~34-token capacity under concurrent users — waiters must await an in-flight future (zero tokens); only the winner runs in the threadpool.

**How to apply:** New merch aggregate endpoints: async handler, rows via the shared async helper (same cache key format as /api/merch/styles so all consumers, incl. CSV export, share entries), derive aggregates in Python (cheap at ~3.5k styles), cache the derived result separately. Shared rowsets are common objects — aggregate into new dicts, never mutate style rows. Trend endpoints must run current+prev windows SEQUENTIALLY (current first): concurrent windows contend on the shared PG and delay every endpoint waiting on the current-window future, for zero total-time win.

**Also learned:** replacing the correlated per-sales-row mode(price) subquery with a pre-aggregated CTE did NOT change runtime (PG caches the subplan) — the cost is the multi-CTE scan structure; further speedup needs prewarming or rollups, not micro-fixes.
