---
name: One-click validation-fix safety fence
description: Rules for safely letting an admin click-to-apply an LLM-proposed SQL fix from the Audit Findings page.
---

# One-click review fence for proposed validation fixes

The admin "Audit Findings" page can apply a finding's `proposed_fix_sql` after a
human approve click (`POST /api/admin/validation-exceptions/{id}/apply-fix`).
That SQL is **LLM-generated free-form**, so the human click is the gate and the
backend fence (`_validation_fix_is_safe` in `api_pg.py`) is the machine backstop.

**Rule:** a substring allowlist check is NOT enough. You MUST parse and enforce
the actual `UPDATE` *target* table (the token right after `UPDATE`/`ONLY`,
schema-qualifier tolerated) against the allowlist — otherwise
`UPDATE app_users SET role='admin' WHERE EXISTS (SELECT 1 FROM all_sales)`
passes (an allowlisted name appears *somewhere*) and escalates privilege.

**Why:** the autonomous governance fence (`validation_agent/governance.py`
`_fix_is_safe`) is safe only because its SQL comes from *trusted pattern
builders*; the endpoint runs arbitrary proposed SQL, so it needs stricter target
enforcement than governance's any-token check.

**How to apply (the checks, in order):**
1. Strip block `/*..*/` + line `--..` comments, then blank string literals
   (`'...'`) BEFORE scanning — else a table name / keyword / `;` can be smuggled
   in a comment or string to fool the fence.
2. Single statement: no `;` in the body.
3. Must *start with* `UPDATE` (rejects leading `WITH` CTE, incl. data-modifying
   CTEs); also reject `WITH` anywhere.
4. No `DROP/TRUNCATE/DELETE/ALTER/GRANT/INSERT/CREATE/MERGE` — match on `\b`
   word boundaries so `created_at` is not read as `CREATE`.
5. Parse the target table after `UPDATE` and require it ∈ allowlist
   (`_VALIDATION_FIX_TABLES`: the data facts/dims, never auth/session tables).
6. Apply runs the EXACT reviewed SQL in one tx (FOR UPDATE lock on the finding,
   flip status→`approved`, audit via SAVEPOINT-wrapped best-effort insert).

Cross-surface findings carry NO `proposed_fix_sql` (definition mismatches a dev
must align in code), so the UI shows "No automated fix" + a Dismiss
(status→`rejected`) button instead of Approve.
