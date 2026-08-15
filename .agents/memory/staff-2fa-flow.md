---
name: Staff 2FA flow
description: Staff web and native authentication use a short-lived challenge before issuing the normal session.
---

Password and Google sign-in must complete the same RFC 6238 challenge before a normal session is created. Web clients use the httpOnly challenge cookie; native clients receive a short-lived challenge token because they cannot read that cookie. Existing session rows remain valid when 2FA is enrolled, reset, or re-enrolled.

**Why:** 2FA was added without forcing already-signed-in staff to log out, while keeping the web session cookie authoritative and avoiding a native deep-link dead end.

**How to apply:** Any new staff authentication provider must route through the challenge endpoints rather than creating a session directly; keep backup codes hashed and one-time, and preserve existing sessions during admin reset.