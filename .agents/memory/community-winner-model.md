---
name: Community challenge winner model
description: Hybrid votes→shortlist→team-pick winner flow, +200 bonus mechanics, and the no-public-tallies rule.
---

Each challenge row carries `deciding`: `team_pick` or `community_shortlist`. Voting (when enabled) shapes a staff-only shortlist — the CRM shortlist endpoint returns top-10 by votes only once a community_shortlist challenge is CLOSED; open or team_pick challenges list every published entry (cap 200).

**Rules that must hold everywhere:**
- Members NEVER see vote counts or tallies — not in vote responses (`{ok, my_vote}` only), not in challenge payloads, not in celebrations. Staff desks (CRM shortlist) are the only place vote_count appears. "Shining This Week" celebrates moments, never numbers.
- The +200 winner bonus is a points event keyed `challenge_winner_{post_id}`; picking is idempotent (re-pick same = 1 row), picking a different entry at the same position DISPLACES the bonus to the new member, clearing (position null) deletes it. `_me_cache` must be popped for every touched member.
- One vote per member per challenge, changeable while voting is open.
- Winners surface member-side as ribbons on entries + celebrations wall + a one-shot Home congrats card (localStorage-dismissed per post_id).

**Why:** product decision — celebration without competition anxiety; tallies would create losers.
**How to apply:** any new endpoint or UI touching challenge entries must keep vote_count staff-side and route winner changes through the winner endpoint (never direct UPDATE) so the bonus follows.
