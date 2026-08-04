---
name: Sales fast-path worker
description: Why all_sales freshness comes from a dedicated worker thread, the lock contract with the main sync cycle, and the rules any change to sales pulls must respect.
---

# Sales fast-path worker (sales_worker_loop)

**Rule:** Per-minute sales freshness comes from `sales_worker_loop` in the incremental sync — a daemon thread ticking ~60s that re-pulls a short sliding window (default 30 min) from every sales source, serialised against the main cycle by the module-level `_SALES_SYNC_LOCK`. Never move sales freshness back onto the main cycle, and never add a sales-table write path that ignores the lock.

**Why:** `main()` was designed as a ~1-minute loop but grew to 45–90 min per cycle (heavy inventory/social/production phases; Shop Zetu inventory matching alone ~20 min). Sales pulls are cheap (~5–30 s) but sat inside that cycle, so tills-to-dashboard lag reached ~1.5 h. Same disease and same cure as the fabric worker. `all_sales` has NO unique business-grain index in prod (legacy dupes), so the lock — not a constraint — is the only guard against worker/cycle DELETE+INSERT interleaving.

**How to apply:**
- The worker passes `since_override` (trailing kwarg) to the shared pull functions; override = short sliding window, no override = the main cycle's wide self-healing anchors AND the repair env knobs (`ODOO_SYNC_SINCE/UNTIL` stay main-cycle-only). Keep that split when touching either path.
- Formats differ per source: Shopify ISO-Z (`%Y-%m-%dT%H:%M:%SZ`), Odoo naive-UTC (`%Y-%m-%d %H:%M:%S`).
- Any new sales-source pull added to `main()` must go INSIDE the `with _SALES_SYNC_LOCK:` block (AST-pinned by the worker's test module), and usually also into the worker tick.
- Anything that runs while HOLDING the lock must be time-bounded (subprocess `timeout=`) — a hung lock-holder silently stalls the per-minute feed. The worker acquires non-blocking and skips its tick when the cycle holds the lock.
- The worker beats its OWN `sales_heartbeat` table (allowlisted in `_HEARTBEAT_TABLES`), never `sync_heartbeat` — watchdog health must keep reflecting the main loop only (see sync-watchdog-heartbeat.md).
- Shop Zetu inside the worker is interval-gated (~5 min) and stamped BEFORE the run on purpose: a failing endpoint retries at the interval, not every tick.
- The worker starts only in the continuous loop path, gated by `SALES_WORKER_ENABLED` — never in `--once` recovery runs (a recovery process would otherwise spawn a second competing writer; the lock is in-process only).
- Expect `loaded_at` churn on recent rows: each tick rewrites the sliding window, so "rows loaded per minute" is not a health metric — heartbeat age and `MAX(loaded_at)` age are.
