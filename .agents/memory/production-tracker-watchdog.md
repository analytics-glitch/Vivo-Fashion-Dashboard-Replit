---
name: Production tracker watchdog
description: Independent freshness recovery and concurrency safety for the Odoo buying-order feed.
---

The Buying Orders board must be monitored from its own successful-sync heartbeat, rather than from the general incremental-sync heartbeat. Any normal scheduled run, manual run, or watchdog recovery must invoke the same tracker script so it shares one database-backed claim.

**Why:** The general loop can keep updating unrelated feeds while failing or stalling before its late production-tracker step. Two tracker runs calculating intake deltas at once can append the same movements.

**How to apply:** Keep the stale-feed recovery independent and rate-limited. Do not add a second direct Odoo-to-production write path; use the tracker entry point and retain its cross-process claim around the complete fetch and reconcile operation.