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

**Why:** the endpoint runs arbitrary LLM-proposed SQL, so it needs full target
enforcement. The autonomous governance fence (`validation_agent/governance.py`
`_fix_is_safe`) now applies the SAME hardening (comment/string stripping,
word-boundary keywords, parsed UPDATE target vs the pattern's allowlist) even
though its SQL comes from trusted pattern builders — keep the two in lockstep.

**How to apply (the checks, in order):**
1. Remove `/*..*/` + `--` comments and blank `'...'` literals in ONE
   quote-aware single-pass lexer BEFORE scanning. A regex pipeline that strips
   comments before strings is bypassable: `--` INSIDE a literal is data, so
   `UPDATE t SET note='abc --'; DELETE …` slips past. Handle `''` escapes;
   unterminated literals consume the rest (conservative).
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
