---
name: Community events capacity + waitlist
description: Design invariants for the member-app events system — public spot counts, seed_taken demo baseline, waitlist promotion, my_rsvp object shape.
---

# Community events: capacity + waitlist model

- **Spot counts are PUBLIC by product decision (Aug 2026)** — `/api/community/events` returns `capacity`, `taken`, `spots_left`, `full` for everyone (anon included). An earlier privacy stance hid them; the user overrode it ("thumbnail with number of signups"). Don't re-hide.
- **`seed_taken` demo baseline**: each seeded event carries `seed_taken` (like mock feed content) so numbers look alive; `taken = min(capacity, seed_taken + confirmed_db_rows)` and the DB may hold at most `capacity − seed_taken` confirmed rows (`db_cap`). Import-time assert enforces `0 ≤ seed_taken ≤ capacity`. The celebration event ships full (60/60) on purpose — it is the waitlist demo.
- **Waitlist**: POST rsvp auto-waitlists when full (single endpoint, response `{status:'waitlisted', position, message}`); re-taps keep the original `waitlisted_at` (queue position). DELETE cancels confirmed OR waitlisted; a confirmed-cancel promotes the earliest waitlisted (`ORDER BY waitlisted_at, id`) **inside the same `community_event_locks` FOR UPDATE transaction** (pooler-safe; advisory locks are not). Promotion email is best-effort in a daemon thread after commit (LOYALTY_APP_SMTP_*, skips quietly when unset/member has no email).
- **`my_rsvp` is an object**: `null | {status:'confirmed'} | {status:'waitlisted', position}` — never the old string. Readers: EventsList, EventDetail, TabHome home card, TabProfile My Events (includes waitlisted with position chips).
- **Frontend pattern**: thumbnails browse, detail page acts (Shop pattern). `?event=` rides CommunityShell view state exactly like `?product=` — every applyView constructor must carry the `ev` field or state desyncs. RSVP/ICS/cancel live ONLY on EventDetail.
- **Why:** capacity urgency drives signups; the seed baseline makes every state demoable (open/urgent/full/waitlisted) without fake DB rows that would break `db_cap` math.
- **How to apply:** new events need capacity+seed_taken+image+about/expect/host; any new reader of my_rsvp uses the object shape; keep list endpoint as the single source (no per-id endpoint — detail finds by id client-side). Smoke: /tmp/events_smoke3.py pattern (12 API writes, budget vs 20/hr IP throttle; mint members with empty email to skip real SMTP).
