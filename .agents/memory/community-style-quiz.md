---
name: Community Style Quiz canon
description: Answer schema, DNA composer rules, one-time points-event pattern, and personalization cache rules for the community app Style Quiz.
---

## Answer schema (whitelisted ids only)
`styles[]≤3, occasions[], reach_for, fit_priorities[]≤2, colours[], size_range?, fit_lean?` — sanitized by `_quiz_clean_answers` (unknown ids dropped silently, never 500). Complete = the 5 style questions non-empty; `size_range`/`fit_lean` are PRIVATE and always optional (never gate completion, never shown to other members).

## DNA composer
`_compose_style_dna` → 3 descriptors in the MEMBER'S pick order: first two style tokens joined " & ", first occasion token, first fit token. Fallbacks "Signature" / "Everyday-Ready" / "Comfort-First". Server-side is the only canon — clients render, never compose.
**Why:** pick order is the member's voice; recomputing client-side would drift from the stored `dna` JSONB.

## One-time bonus points pattern
`community_points_events (member_id, kind, points, UNIQUE(member_id, kind))` + `ON CONFLICT DO NOTHING RETURNING id` = idempotent one-time awards (kind `style_quiz` = 50). `_earned_bonus_points` must be folded into BOTH lifetime formulas — `_member_payload` AND `_lifetime_points` (event tier gates) — or /me and tier gates disagree.
**How to apply:** any future mission/bonus = new `kind`; never a second earn table, never award client-side. Any spendable/affordability check (tank redeem etc.) must call `_lifetime_points`, NEVER an inline welcome+spend formula — a review caught redeem rejecting members whose balance was only sufficient thanks to the bonus.

## Completed quiz is write-protected against incomplete PUTs
Once `completed_at` is set, an incomplete PUT is ignored (echoes persisted state) — otherwise a stray partial save guts the stored answers while the member stays "completed" and personalization silently scores from nothing.

## Personalization rules
- `GET /products?personalize=1` resolves the member SOFTLY (`_session_for`, never 401) and only re-ranks when quiz completed; response carries `personalized` flag and clients must key UI off that flag, not off "I asked".
- Personalized responses BYPASS the shared `_products_cache` (read AND write) — per-member order must never poison the public cache.
- `_quiz_score_sql` builds the ORDER BY expression ONLY from whitelisted ids → constant keyword lists (ILIKE on colour/name/category, degrades gracefully); no member-typed text ever reaches SQL; literal `%` doubled because the route executes with a params dict.
- Re-rank only, same WHERE: personalized and default responses must be the same catalogue universe (smoke asserts set equality).

## UX wiring
Quiz overlay rides the shell's URL/history pattern (`?quiz=1`, push to open so Back closes). Retake starts at step 1 (skips welcome), prefilled from GET. Share is explicit opt-in (`shared_at` consent timestamp); the community feed is still mock, so the flag is stored-for-later. `_ensure_tables()` runs on route hit — fresh boots have no quiz tables until any community endpoint fires (smoke scripts must prime first).
