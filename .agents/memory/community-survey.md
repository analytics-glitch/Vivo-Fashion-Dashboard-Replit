---
name: Community survey waves
description: Wave-based member survey — schema-in-DB, once-per-wave points, dismiss ladder, aggregate-only staff summary
---
- A wave is a row in `community_survey_waves` carrying its own `questions` JSONB; launching a new round = INSERT a new wave row. The boot seed keeps wave 1 in sync with the code constants (ON CONFLICT DO UPDATE when distinct) so ADDITIVE mid-wave edits — e.g. appending an optional question — reach dev and prod on boot. Never rename/remove question ids or options mid-wave (orphans collected answers); breaking changes = a new wave row. Frontend + validator + staff summary are all schema-driven, so a question edit usually touches only the constant.
- Points award rides `community_points_events` UNIQUE(member_id, kind) with per-wave kind `survey_<wave_key>` — identical idempotency to the style quiz; the response row is UNIQUE(wave_id, member_id). Both inserts use ON CONFLICT DO NOTHING + RETURNING to detect "already".
- **`_tier_for()` returns a `(tier, next_hint)` TUPLE** — anything storing a tier string must take `[0]`; passing the tuple to psycopg2 fails with "can't adapt type 'dict'" (the hint is a dict).
- Dismiss ladder is server-side (`community_survey_dismissals`): count 1 re-surfaces the Home card after SURVEY_RESURFACE_DAYS of quiet (make_interval SQL), count 2 retires the Home card for the wave — Rewards mission + Profile row always remain.
- The store follow-up question is schema-driven: a `when` array on the channel answer ("In store", "Both") inserts it client-side and enforces it server-side.
- Survey answers are DPA-surfaced like every other member upload: they appear in the My data payload, have a member-facing delete route (points survive deletion — the UNIQUE points ledger means retakes never re-award), and are disclosed in the privacy policy (collect / your-content / why sections). Any new member-linked data type must join all three surfaces or review fails it.
- Dismiss is wave-bound like complete (stale/missing wave_id → 409) — a stale client must not burn a dismissal of a wave it never showed.
- Staff summary `/api/crm/community-survey/summary` is aggregate-only: option counts/pct, NPS (%promoters−%detractors, avg), by-tier split from stored tier_at, anonymous recent comments, median duration. Identity never leaves the backend. UI lives in vivo-crm next to CSAT (manager-gated), not vivo-bi.

**Why:** answers are member-linked for segmentation but reported anonymously — the privacy promise is in the survey intro copy, so any new reporting surface must stay aggregate-only.
**How to apply:** future waves = INSERT wave row with new wave_key + questions JSONB; any new tier-stamping code must unpack `_tier_for()[0]`.
