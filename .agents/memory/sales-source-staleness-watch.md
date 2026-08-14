---
name: Per-source sales staleness watch
description: Rules behind the stale-sales-source monitoring — why loaded_at freshness equals pull health, trading-hours-only accrual, incident-stamp alert dedupe, and the public-route disclosure boundary.
---

# Per-source sales staleness watch

Loop heartbeat and API→Postgres health say nothing about whether a SOURCE
still lands rows — a dead upstream permission can freeze one market for a day
behind green badges. The watch stands on these durable rules:

**Rewrite model (the load-bearing fact).** Every successful pull REWRITES its
whole anchor window with fresh `loaded_at` stamps, around the clock (worker
sliding window, wide main-cycle anchors, Shop Zetu's ~4-day window every few
minutes — overnight stamps prove it). So frozen `MAX(loaded_at)` = pulls
failing, NEVER "store is quiet" — even for a ~11-orders/day market.
**Why:** this is empirical pipeline behavior, not visible in any one query.
**How to apply:** point staleness at `loaded_at` (naive-UTC — treat as UTC),
never at heartbeat or `sale_date` (TEXT, date-only); modest thresholds are
safe; a closed-but-healthy store still restamps overnight.

**Classifier rules** (pure module, registry of ACTIVE sources only):
staleness accrues ONLY inside each source's EAT trading window (overnight and
pre-open freezes never alarm), with a wall-clock escalator to critical only
once already stale. A store absent from all_sales is `no_data` =
informational, never stale — else fresh/rebuilt DBs trigger alert storms.
Retired stores stay OUT of the registry; a lockstep test asserts every synced
source is registered (a store added to sync but not the registry recreates
the silent-outage class).

**Failure trail** (sync loop catch sites → sync_health_log): log on ok→failing
transition then ≤1/hr; recovery row on the flip back. Helpers own their
cursor, commit themselves, and never raise; in-process state flips BEFORE the
write so a failed write can't break rate-limiting (call sites already hold
the sales lock, making the state dict safe).

**Alerting** (admin bell): sweep runs from the public sync-status poll,
TTL-gated per process, idempotent. Incident identity = the source's frozen
`last_loaded_at` ISO stamp embedded in `dedupe_key` — re-sweeps no-op during
an incident; recovery (stamp moves) marks stale alerts read and inserts one
recovery notice. Pill shows the WORSE of heartbeat health and source health;
loop-trouble keeps the heartbeat label, source-trouble shows the stale
summary.

**Disclosure boundary (review-enforced).** `/api/sync-status` is on the
public auth allowlist → it may expose ONLY timestamps and health flags. Raw
upstream error text (fault messages can carry internal detail) goes behind
the blanket `/api/admin` middleware gate (`/api/admin/source-failures`), with
an HTTP-level regression test pinning both sides.

**Simulating an outage in dev:** pause the sync watchdog briefly (<10 min
keeps heartbeat green — the discriminating case), rewind a source's recent
`loaded_at` by hours; Shop Zetu is the best target because its next extract
rewrites the window, self-healing the simulation with no manual restore.
