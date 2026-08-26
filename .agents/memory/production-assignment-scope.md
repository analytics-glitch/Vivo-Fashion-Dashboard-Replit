---
name: Production assignment scope
description: Authorization boundary for production-role access to plan-backed operational data.
---

Production-role users may read or mutate plan-backed operational data only for
plans they own or where their assigned operator is active. Missing production
identity resolves to no scope, never to a broad portfolio read. The same scope
must be applied to source rows before aggregation, including style-level
inventory or fulfillment evidence linked to production orders.

**Why:** filtering visible plan cards after a global aggregate leaves recovery
facts, stage quantities, and fulfillment totals able to disclose another
team's commitments. Inactive assignments are explicitly outside the user's
operational responsibility.

**How to apply:** use the owner-or-active-assignee predicate in every
production plan, recovery, action, detail, and aggregate query. For
style/order views, resolve authorized order references first and join/filter
the raw evidence by those references before calculating quantities.