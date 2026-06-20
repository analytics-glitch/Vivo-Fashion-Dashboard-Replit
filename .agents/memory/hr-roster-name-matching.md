---
name: HR roster ↔ attendance name matching
description: How the official employee roster links to messy biometric attendance names, and why a rematch endpoint exists.
---

# HR roster import & attendance name matching

The official employee roster comes from a Google Sheet (4 entity tabs with
DIFFERENT headers — Vivo Kenya has Department/Team, the others have Job Title;
"PII"/"Staff No" is the staff number, NOT the attendance `user_id`). It lands in
`hr_employees`; the link to attendance is keyed on the messy `vivo_attendance.employee_name`
(NOT `user_id`, which is not unique per person) via `hr_employee_match`.

**Matching is precision-first and rebuildable**, not a one-off import:
exact-normalized → order-independent token key → difflib fuzzy (≥0.92) → LLM AI
pass (candidate-constrained, confidence ≥0.6). Junk biometric identities
("Unknown Employee", blanks, pure numbers) are filtered before the AI pass.

**Why a rematch endpoint (`POST /api/hr/employees/rematch`, admin/exec):**
prod is a SEPARATE DB (see prod-separate-db-rebuild.md), so the dev `executeSql`
roster import does NOT reach prod. The schema ships via publish, but the rows do
not. To populate prod: re-import the roster rows into prod's `hr_employees`, then
hit the rematch endpoint (the AI pass runs server-side using `A._chat_llm`). The
endpoint rebuilds `hr_employee_match` wholesale (DELETE + re-insert), so it is
safe to re-run after the roster changes.

**How to apply:** any roster refresh or attendance-name cleanup requires a
rematch run to re-link; enrichment joins (e.g. `/api/hr/employee-summary`) read
through `hr_employee_match → hr_employees`, so stale matches show as missing
department/clean-name, not errors.
