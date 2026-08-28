---
name: Embedded operations access and freshness
description: Access and client-cache rules when moving a shared operational workspace into Vivo BI.
---

An embedded operational workspace with its own staff roster authorizes non-admins through the intersection of the effective BI page grant and active roster membership. Do not add a second static role allowlist: configurable group or personal grants can legitimately authorize roles outside defaults.

**Why:** A third role check can make navigation visible while every API rejects the user. Conversely, roster membership alone must not bypass a revoked BI page grant.

**How to apply:** Compose both checks in the shared server guard and shape identity/navigation from the same result. Let admins bypass roster membership only when the workspace policy explicitly permits it.

Shared operational reads must not inherit the dashboard's multi-minute response cache.

**Why:** Intake, assignment, status, measurement, and configuration changes are multi-user workflow state, not slowly changing BI metrics. One worker must see another worker's next read immediately.

**How to apply:** Exempt the operational API prefix from persisted and in-memory response caches, while retaining in-flight de-duplication only if it cannot replay a completed stale response.