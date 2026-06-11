---
name: CRM authorization is a server-side middleware gate
description: Why /api/crm/* role enforcement lives in clerk_auth_gate, not just the frontend nav/permissions.
---

CRM is an analyst+ surface (`role ∈ {analyst, exec, admin}`). That role gate is enforced **server-side** in `api_pg.py`'s `clerk_auth_gate` middleware (one `path.startswith("/api/crm")` check), exactly like the existing `/api/admin` admin gate — NOT only in the web `permissions.js` / mobile `more.tsx` nav.

**Why:** the web hid CRM nav for non-analysts but the backend originally trusted only "active user". Client-side nav/route hiding is bypassable via direct API calls or the mobile app, which shares the same `/api`. A code review flagged this as broken access control. Frontend hiding is secondary UX, not the security boundary.

**How to apply:** when adding any new gated surface that spans web + mobile, put the role check in the middleware. Finer-grained per-mutation checks (e.g. loyalty adjust / config PUT require admin) still live in the route via `_crm_is_admin`. Keep the mobile `more.tsx` group `roles:[...]` filter in sync with web `permissions.js` for parity, but never rely on it alone.
