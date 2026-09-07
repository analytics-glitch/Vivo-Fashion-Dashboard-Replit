---
name: Auth fallback connection budget
description: Availability rule for database fallbacks used by staff authentication and readiness.
---

When staff authentication bypasses an exhausted application pool, every auth-adjacent operation must share a small, process-wide direct-connection budget with short acquisition, connect, statement, and lock timeouts. Readiness probes must use that same budget and be single-flight or briefly cached.

**Why:** A production incident showed authentication failing behind analytics pool exhaustion. An unrestricted direct fallback would recover individual requests by opening unlimited extra connections, converting the original contention into database-wide exhaustion; an unauthenticated readiness endpoint can amplify that failure mode.

**How to apply:** Cover account lookup, challenge/session writes, session resolution, schema preparation, and readiness—not only the main login transaction. Release permits in unconditional cleanup paths, including failures while rolling back or restoring connection state.