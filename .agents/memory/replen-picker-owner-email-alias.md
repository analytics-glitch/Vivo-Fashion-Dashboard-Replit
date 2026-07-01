---
name: Replen picker owner ↔ login-email alias
description: How a picker sees only their own lines, and the override for name/email mismatches
---

# Picker "sees only my lines" matching + email-alias override

A replenishment picker only sees their own distributed pick-list lines because
`_replen_owner_matches_user(owner, user)` in `api_pg.py` matches the free-text
roster **owner label** (a first name) against the signed-in user's identity
candidates: their `name`, their first name, and their **email local-part**.
There is no general login→owner mapping table; matching is by equality (never a
shared token, to avoid leaking another picker's lines). Managers bypass it.

**Why an override exists:** a picker's login email usually contains their roster
first name (local-part ≈ first name), so name/local-part matching works. It fails
closed when it doesn't — e.g. a roster label whose spelling differs from the email
local-part (a one-letter variant), so that picker saw none of their own lines while
every other picker worked. (Concrete emails/names are PII — keep them out of memory;
the live mapping is `_REPLEN_OWNER_EMAIL_ALIASES` in code.)

**How to apply:** add such pickers to `_REPLEN_OWNER_EMAIL_ALIASES` (normalised
owner label → set of exact login emails). If a future picker reports "I can't
see my pick list" and the others are fine, check whether their email contains
their roster name; if not, add an override entry (key both the full and any
truncated roster spelling if the default roster truncates it).
