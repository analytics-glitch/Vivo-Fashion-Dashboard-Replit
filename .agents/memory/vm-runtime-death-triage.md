---
name: Reserved VM runtime death triage
description: How to recognize a whole-VM kill of the production Reserved VM, why it stays down, and the early-warning metric that precedes it
---

# Reserved VM runtime death (whole-VM kill)

**Signature:** deployment logs stop mid-request-stream with no error/shutdown line, and there is ZERO output afterward — no restart attempts, no watchdog rows in `sync_health_log`, no `sync_heartbeat` writes. That means the watchdog supervisor died at the same instant as the API: the whole container/VM was killed from outside (kernel/cgroup OOM of everything, or host failure), not an app crash. Both domains 502 with Replit's "deployment could not be reached" body; the deployment pane still says "published/success" (trust probes, not the pane).

**Contrast with process-level kills:** when only the uvicorn child is OOM-killed, the in-VM watchdog respawns it within ~10s and writes `restart:api` to `sync_health_log` — users barely notice. Whole-VM death has no self-recovery: the platform did NOT auto-restart a dead Reserved VM (2026-08-13: dark 07:57→11:03 UTC, ~3h). Only a user-clicked Republish (fresh build + fresh VM) revives it; agents cannot trigger it.

**Early warning:** count `restart:api` rows in `sync_health_log`. 69 restarts in 14 days (~5/day) preceded the fatal kill — chronic memory pressure on the 2 vCPU / 8 GB machine, masked by watchdog self-healing. A rising restart rate = raise VM memory (user: Publishing → Adjust settings → Machine configuration) and/or reduce spike load before the next whole-VM kill.

**Fatal-load pattern:** death coincided with ~a dozen concurrent 50–140s customer-analytics queries plus the fabric HEAVY Odoo extract subprocess launching on the same VM. Slow-query volume per hour was NOT record-breaking — it's the concurrency spike + subprocess stack that matters, not counts.

**How to apply:** on a prod 502 outage, batch: fetch deployment logs around the last log line, `listDeploymentBuilds` (no new build = nothing user-shipped caused it; `suspendedReason` = billing), prod-DB `sync_heartbeat`/`sync_health_log` reads. Before telling the user to Republish, verify prod env has no leftover `REBUILD_ON_BOOT`. Afterward run the standard health pass (domains 200, repeated Clerk env probes fast, heartbeat + loaded_at advancing, today-rows baseline vs after). Report the non-restart to Replit support — a Reserved VM staying dead is platform-side.
