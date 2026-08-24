---
name: Prod healthcheck boot stall
description: Deploy-log "healthcheck ... context deadline exceeded" with no crash = event-loop/GIL starvation; validation agent must never sweep a cold-boot API.
---

# Prod runtime healthcheck stall (uptime-monitor "outage" with no crash)

**Symptom:** uptime monitor reports an outage; deployment log shows
`healthcheck failed error=healthcheck /<path>: Get "http://127.0.0.1:<port>/<path>/": context deadline exceeded`
but there is no crash, no restart, and the access log shows continuous 200s
around the gap.

**How the probe works:** the platform prober periodically GETs **every entry in
the api-server artifact's `paths` list** from 127.0.0.1 with a tight (~seconds)
deadline. It follows redirects (bare `/loyalty-app` 301s to `/loyalty-app/`),
so the follow-up GET also has to answer in time.

**Root cause pattern:** all probed paths are already async in-memory handlers —
if one times out, the **event loop itself was starved**, not the handler. A
burst of concurrent heavy sync-def endpoints (each fetchall + Python row
munging holds the GIL) can starve the loop for seconds. Worst case observed:
fresh prod VM ~12 min after publish — cold caches + boot prewarm + real traffic
+ the data-validation agent's cross-surface HTTP sweep firing on the FIRST sync
cycle. Client-side 30s timeouts made it worse: the abandoned query keeps
running server-side while the agent fires the next heavy probe (pile-up).

**Rule:** self-auditing HTTP sweeps must never run against a cold-boot API.
- Sync-loop gate gives the validation agent a ~30-min boot grace (first-cycle
  stamp `now - 30min` instead of running immediately). Attendance sync
  intentionally still runs on first cycle — do not "fix" that one.
- cross_surface `_get` aborts the ENTIRE run on the first `requests.Timeout`
  (`_BACKED_OFF` module flag, reset in `run_checks`); remaining scenarios log
  a "backing off" skip and the sweep retries next hour.

**How to apply:** any new hour-gated job in the sync loop that hits the API
over HTTP (not just the DB) needs the same two guards: boot grace + first-
timeout abort. When a monitor flags an outage, check deployment logs for the
healthcheck line and the access-log silence window before assuming real
downtime — a single failed probe cycle recovers on the next check.

**Probe implementation rule:** public liveness/root probes must be async and
DB-free; readiness may perform DB checks only after offloading them from the
shared sync worker pool. A live API can otherwise look offline when BI queries
occupy every worker.
