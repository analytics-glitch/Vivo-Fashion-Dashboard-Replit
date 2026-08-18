---
name: Community DPA consent & My data layer
description: Per-item marketing-consent ledger, data-request flow, and the _ensure_tables DDL splice trap in the community app.
---

## Consent ledger (community_content_consents)
- **Record consent only at an ask-moment.** Share/redeem routes write a row solely when a boolean `marketing_ok` is present in the payload; absence means "never asked", which is NOT the same as declined. UI checkboxes are never pre-ticked.
- One row per (member, content_type, content_id) holds CURRENT state; `history` jsonb is an append-only trail of granted/declined/withdrawn events. Re-grant re-dates `granted_at` (new affirmative act) while history preserves the withdrawal interval. Idempotent re-posts append nothing.
- Rows are never deleted (audit trail). Content deletion withdraws consent — and so does **artwork replacement** (PUT design): new artwork is new content, consent must not carry over.
- **Why:** Kenya DPA framing — consent must be provable, item-specific, and bound to the exact content it was given for.
- Design consent requires `design_image IS NOT NULL` (a monogram has nothing to feature → 404).

## Data requests (community_data_requests)
- Request-logged flow (staff fulfil manually), not self-serve export. Each request also mirrors a row into `community_contact_messages` so CX sees it in the existing CRM queue.
- Dedupe is DB-enforced: partial unique index `(member_id, kind) WHERE status='open'` + UniqueViolation→409. The SELECT precheck is only the friendly path — never rely on it alone (race).
- Deleting content never claws back earned points; UNIQUE(member,kind) on points events prevents re-earning after e.g. style-quiz deletion.

## Design-delete gating
- Members may strip artwork only from released orders: status whitelist `_DESIGN_RELEASED` (cancelled/rejected/fulfilled/…). Unknown/new statuses stay protected — fail closed.

## My data hub (frontend)
- Sections render only when that content type exists; a global empty state covers the nothing-at-all case. An e2e "missing sections" report usually means the member has no server-side content, not a bug.
- Posts/challenge entries are **device-local (localStorage)** — no server copy exists. Privacy §2 copy is deliberately implementation-neutral so it stays true if they ever move server-side.
- Terms version bump (COMMUNITY_TERMS_VERSION) forces re-consent on next open — bump it whenever policy content changes materially.

## _ensure_tables DDL splice trap
- The community DDL is ONE giant multi-statement triple-quoted string. New tables must be SPLICED INTO that string (e.g. after an existing index statement). A naive "find the closing paren/quote" append once dumped CREATE TABLEs into an unrelated CRM route ~2k lines away (IndentationError far from the cause).
- **How to apply:** anchor patches on verbatim DDL text inside the string; add `ALTER TABLE … ADD COLUMN IF NOT EXISTS` lines in the same string for columns added after first ship (tables already exist in dev/prod).

**New member-data tables must join the My Data surface.** Any new table storing member answers/content (e.g. the journey profile that replaced the survey) must be added to GET /api/community/mydata AND covered by a delete path, or it's a DPA regression — a member could no longer see/erase it. Points already earned stay (ledger UNIQUE(member_id,kind) prevents re-award after delete+retake). Also sweep Help/FAQ copy (legalData.js) when a flow moves — it names entry points.
