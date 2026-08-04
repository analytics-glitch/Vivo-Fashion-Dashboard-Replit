---
name: Publish platform-failure triage
description: How to tell a Replit-platform publishing outage apart from a project problem, and what evidence support needs
---

# Publish platform-failure triage

**Rule:** When Publish/Republish "does nothing" or the pane shows "Failed to check for database diff: SERVER unexpectedly disconnected", triage with workspace tooling before touching project code:

1. `explainSchemaDiff()` — if it succeeds from the workspace while the UI banner fails, the fault is in the publishing service's own connection path, not the project or the DB.
2. `listDeploymentBuilds` — if Republish clicks create **no new build records**, the request never reached the build service (platform-side; no project change can fix it).
3. `executeSql({environment:"production"})` — proves the prod DB is up/down independently of the UI claim.
4. A deployment record can say "published / success" while the VM serves nothing (both domains timing out) — trust probes, not the pane status.

**Why:** During the 2026-08-04 outage, hours could have been wasted "fixing" a healthy project. The workspace-vs-UI mismatch (diff passes here, fails there, at the same minute) was the evidence that got it routed correctly; recovery required nothing but a later successful Republish (user action + possibly platform recovery — root cause never surfaced to us).

**How to apply:** Run checks 1–3 in one batch on any publish failure. If platform-side: give the user a paste-ready support summary (timestamps, "no builds created since HH:MM", the simultaneous mismatch), point at billing status as a quick parallel check, and do NOT iterate on project code. After recovery, verify with a health pass: both domains 200, repeated Clerk `/api/__clerk/v1/environment` probes all fast (stuck-worker lottery check), single `app_singleflight` deferred_startup claim, sync heartbeat + all_sales.loaded_at advancing.
