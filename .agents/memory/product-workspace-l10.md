---
name: Product Workspace L10
description: Durable schema boundary and migration rule for the Product Workspace EOS meeting module.
---

Product Workspace L10 data belongs in its own workspace schema rather than reusing the legacy public L10 tables. Existing public rocks may be copied once as the initial 22-rock board; later workspace edits should not write back to the legacy tracker.

**Why:** The legacy tracker has different meeting, check-in, scorecard, and agenda models, while the Product Workspace needs its own auth, API contract, and UI lifecycle.

**How to apply:** Add future L10 fields and mutations to the workspace API/schema first. Treat `public.l10_rocks` as an optional one-time import source, not a runtime dependency for meeting updates.