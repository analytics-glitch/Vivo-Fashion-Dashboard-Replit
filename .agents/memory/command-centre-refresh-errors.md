---
name: Command Centre refresh failures
description: Keep last-known operational data useful without hiding failed refreshes.
---

When a Command Centre refresh fails after an earlier successful load, retain the last-known dashboard but present a clear, visible error alert.

**Why:** stale operational numbers can still provide context, but silently retaining them after a failed refresh falsely implies the data is current and healthy.

**How to apply:** preserve a clear distinction between data recency and data availability whenever an operator refreshes a dashboard. Do not replace the existing dashboard with a blank screen solely because a refresh failed.