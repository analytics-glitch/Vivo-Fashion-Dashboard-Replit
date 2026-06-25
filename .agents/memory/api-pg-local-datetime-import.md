---
name: api_pg.py datetime/timezone are local imports only
description: Why a new api_pg.py endpoint using datetime.now(timezone.utc) NameErrors unless it imports datetime locally
---

In `api_pg.py` the module-level `from datetime import ...` only brings in `date` and `timedelta`. `datetime` and `timezone` (and sometimes `datetime as _dt`) are imported **locally inside each function** that needs them — there is no module-scope `datetime`/`timezone`.

**Rule:** any new function/endpoint that uses `datetime.now(timezone.utc)` (or any `datetime`/`timezone` reference) must add its own `from datetime import datetime, timezone` at the top of the function body. Copy the pattern from a neighboring handler.

**Why:** a handler that calls `datetime.now(...)` without the local import passes import-time and even an unauthenticated 401 probe (the gate rejects before the body runs), so the `NameError: name 'datetime' is not defined` only surfaces for a real authenticated caller. Test admin endpoints with an actual session, not just the unauth 401.

**How to apply:** when adding any `/api/*` handler, grep the file for how `datetime`/`timezone` are obtained; do not assume they're module globals. Verify by minting a temporary `user_sessions` row for an existing admin and curling with `Authorization: Bearer <token>` (then delete the row), rather than trusting the 401 path.
