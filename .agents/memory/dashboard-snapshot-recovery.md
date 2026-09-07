---
name: Dashboard snapshot recovery
description: Reliability rules for coalesced dashboard snapshots and partial frontend rendering.
---

Shared dashboard snapshot waiters and browser requests must have explicit deadlines. A failed or stalled owner must not leave coalesced waiters or the page loading forever, while a stale complete snapshot should still return immediately and refresh in the background.

**Why:** A backend dependency can stall without rejecting. Unbounded server event waits and Axios calls then preserve the loading state indefinitely. Separately, coupling headline rendering to a section-level error hides valid KPI data.

**How to apply:** Give cache waiters and dashboard HTTP requests bounded waits, clear failed client-side shared promises so retries create a new request, and compute headline, section, skeleton, and error visibility independently.