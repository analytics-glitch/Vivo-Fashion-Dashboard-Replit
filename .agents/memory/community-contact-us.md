---
name: Community Contact Us + CRM Community Inbox
description: Cross-app support-message flow — member submit on the community bypass, staff triage deliberately under /api/crm/*
---

- Member→staff support messages: the submit endpoint stays on the self-authed `/api/community/*` prefix (member Bearer + throttle), while the staff triage surface lives under `/api/crm/*` ON PURPOSE — it inherits the global staff-session gate AND the CRM role gate (customer_service/marketing/leadership/smt/admin) with zero bespoke gating code, and `handled_by` comes from `request.state.user` set by that middleware.
- **Why:** two auth worlds meet in one feature; a custom prefix would need hand-rolled staff auth and would miss future changes to the shared gates.
- **How to apply:** any future member-facing feature needing a staff review surface (reports, moderation, review queues) repeats this split: member writes via `/api/community/*`, staff reads/mutations under `/api/crm/*`.
- community_app cursor convention: plain `conn.cursor()` yields TUPLES in this module; every query must use `conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)` explicitly — shared helpers (`_require_member`, `_session_for`) assume dict rows and raise TypeError at runtime otherwise.
- All placeholder contact details (WhatsApp number, phone, email, UG/RW stores) are centralized in the community app's `src/lib/contactInfo.js` — swap them there only; nothing else hardcodes them.
