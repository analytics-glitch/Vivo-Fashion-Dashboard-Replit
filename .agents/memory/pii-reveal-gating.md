---
name: PII reveal gating (phone/email masking)
description: How customer PII is masked and revealed in the BI backend
---

clerk_auth.authenticate hardcodes role:"admin" for everyone, so role is NOT the PII gate. The real
gate is a password-reveal token: POST verify-password (ops password = env PII_REVEAL_PASSWORD) returns
an HMAC token (signed with SESSION_SECRET) bound to the user id; clients send it back via the
`X-PII-Reveal-Token` header. Backend masks phone+email UNLESS a valid token is present (mask_pii_rows).

**Decisions:** (1) mask phone+email only, NOT name — the frontend never reveals name and masking names
everywhere breaks UX. (2) Secure default: if PII_REVEAL_PASSWORD is unset, verify-password returns 503
and masking is always-on. (3) Backend masking is idempotent with the existing client-side masking in
usePiiReveal.js, so double-masking is safe.

**How to apply:** any new endpoint returning customer phone/email must call
`mask_pii_rows(rows, request, phone_keys=(...), email_keys=(...))` and accept `request: Request`.
