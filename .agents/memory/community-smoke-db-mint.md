---
name: Community app DB-mint smoke pattern
description: How to smoke-test /api/community/* endpoints end-to-end without burning signup OTP throttles
---

**Pattern:** For member-authenticated `/api/community/*` smokes, never sign up through the API (OTP + signup throttles burn quickly). DB-mint instead: insert a `community_members` row (random 2547x phone, retry on UniqueViolation) and a `community_sessions` row whose `token_hash` is sha256 of a token you keep, then send `Authorization: Bearer <token>`. Mint with an **empty email** when the flow under test can send real mail (e.g. waitlist promotion) — the mailer skips quietly.

**Why:** auth throttles are per-IP in-process buckets (a server restart clears them); signup also fires real OTP-path writes. Minting is deterministic and parallel-safe.

**How to apply:**
- Hit `http://127.0.0.1:8080/api/community/...` directly, `PYTHONPATH=.pythonlibs/lib/python3.11/site-packages` for ad-hoc python.
- Budget API writes against the in-process throttles (rsvp: 20/hr per IP shared across POST+DELETE); do bulk setup/cleanup via SQL, not the API.
- Link `customer_id` from a real high-spend `all_customers` row only when the test needs lifetime points/tier.
- Inserts into tables whose DDL may drift (e.g. `community_redemptions`): build the column list from `information_schema.columns`, filling only default-less columns.
- **Always clean up in a `finally`:** dependent rows by `member_id = ANY(minted)` before `community_members`, then verify residuals with a count. Demo member (id 11, 0712345678) rows created by UI testers must be reverted in the test plan itself.
