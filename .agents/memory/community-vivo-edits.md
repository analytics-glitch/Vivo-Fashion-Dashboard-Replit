---
name: Vivo Edits (community creator edits)
description: Creator-curated shoppable edits — feed mirroring, scheduling reconcile, image privacy rules.
---
- Each edit mirrors into ONE community_feed_posts row (mock_key vivoedit_*) so likes/comments/shares reuse feed machinery; archive HIDES the post (status 'hidden'), never deletes — likes/comments preserved.
- **Why:** schedules (starts_at/ends_at) flip active state with no mutation, so nothing triggers the feed-post sync. Fix: `_edits_reconcile_feed()` runs lazily on feed + edits list reads (60s rate limit) and syncs any edit whose active state disagrees with its post status. Any new read surface for edits should keep relying on this, and any new "active" predicate must reuse `_EDIT_ACTIVE_SQL`.
- Public image route `/api/community/edit-image/{id}` serves ONLY images whose parent edit is active OR has ever been mirrored to the feed — scheduled/unpublished edit images must stay private (serial ids are enumerable).
- Product tags are feed-shaped JSONB [{sku,name,price}] resolved server-side from the catalogue; CRM rejects unknown SKUs (400) so staff never publish dead shopping links.
- Seed reads creator PNGs from attached_assets/ and silently skips when files are missing (fresh prod container) — staff re-create via CRM; retry happens only on process restart.
- CRM management is under /api/crm/community-edits* to inherit staff-session + role gates; `reorder` route must stay registered before `/{eid:int}`.
