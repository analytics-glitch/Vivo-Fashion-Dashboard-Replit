---
name: Community composer hand-off
description: Pattern for launching the existing Community composer from another customer-facing surface.
---

Cross-surface composer CTAs should pass a one-time intent into the Community shell, let the Community tab open its existing look or question composer, and immediately consume the intent.

**Why:** Navigating to Community alone loses the requested composer mode, while a persistent flag can unexpectedly reopen a composer on a later visit.

**How to apply:** Use a shell-level action object with a nonce, pass it to the Community tab, select the feed and compose type in one effect, then clear the action once consumed.