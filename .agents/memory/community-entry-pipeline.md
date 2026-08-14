---
name: Community entry/redemption pipeline
description: Publish-gated points, question exemption, CRM redemption status ladder, and CRM build flag.
---

Every member share (look/haul/question, challenge entry or feed post) lands `entry_status='pending'` and is invisible to the community until CRM publish.

**Points land ONLY on publish, never on submit:** challenge entries award the challenge's points; feed posts award by stored media mime (video 100, photo 50, caption-only 0); QUESTIONS never earn and member-facing copy must never mention points near questions ("shared for answers, not points"). Awards are idempotent via UNIQUE(member_id, kind) + ON CONFLICT DO NOTHING. Rejection sets status+entry_status='rejected' — member sees a kind note, no points.

**Redemption statuses:** staff-settable statuses must be a TRUE SUPERSET of every member-visible status — `needs_changes` is what unlocks the member's design-correction flow (her fix returns the piece to `in_review`), so omitting it breaks tank fulfillment (a review once caught exactly this). Zetu ladder = booking→scheduled→done; tank = in_review⇄needs_changes→stitching→ready→collected. Cancelling auto-refunds because spendable points derive from non-cancelled redemptions. The staff note rides along with status and is member-visible immediately.

**Build flags:** vivo-crm's vite config REQUIRES `BASE_PATH=/crm/` on build (same pattern as community's `BASE_PATH=/app/`) — a bare `pnpm --filter @workspace/vivo-crm run build` fails at config load.

**Why:** review-before-publish is the moderation model; points-on-publish stops farming pending posts.
**How to apply:** new share types must default to pending + route awards through the publish handler; new redemption kinds need their status ladder added to the PUT allowlist and the CRM queue's NEXT_STATUSES.
