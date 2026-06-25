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

**Prod self-heals from the sheet (no manual prod write):** prod is a SEPARATE DB
(see prod-separate-db-rebuild.md) so the dev `executeSql` roster import does NOT
reach prod — schema ships via publish, rows do not, leaving prod `hr_employees`
empty. The importer `hr_attendance._sync_roster()` re-reads the sheet (header-
mapped per tab, tolerant of column reorder) and the sync-loop bootstrap in
`sync_incremental.py` runs `sync_hr_roster.py --ai` (imports api_pg, sets
`hr_attendance.A`, runs `_sync_roster` + `_hr_rematch`) so prod populates itself
on first publish. `POST /api/hr/employees/rematch?reimport=1` re-reads the sheet
on demand (admin) without a deploy.

**Atomicity / self-heal rules learned (don't regress):**
- `_sync_roster` MUST be atomic — `api_pg._users_exec` is autocommit, so a naive
  `DELETE` + row-by-row `INSERT` can leave a half-written roster (>0 rows) that
  permanently disables a `COUNT==0` bootstrap. Do the DELETE+INSERT in ONE
  `A._users_tx()` under a dedicated advisory lock (`ROSTER_SYNC_LOCK_KEY`), and
  parse the sheet FIRST (outside the tx) so a slow/failed read never holds the
  lock or touches data. Zero parsed rows → keep the existing roster, return 0.
- The bootstrap guard is COMPLETENESS-based, not `COUNT==0`: it also fires when
  `hr_employees>0 AND hr_employee_match==0` (roster loaded but match never built),
  so a partial first load self-heals next cycle.
- `_hr_rematch` swaps `hr_employee_match` (DELETE+reinsert) only at the END after
  the AI pass, so the OLD match table stays intact while a refresh runs — dev is
  never left broken mid-rematch (worst case: matches stay at the prior set).
- The `--ai` rematch is ~26 sequential `_chat_llm` calls (batch=15); fine as a
  supervised subprocess but it WILL exceed a 120s foreground shell — run detached
  / let the watchdog supervise it, don't expect it to finish in one shell call.

**How to apply:** any roster refresh or attendance-name cleanup requires a
rematch run to re-link; enrichment joins (e.g. `/api/hr/employee-summary`) read
through `hr_employee_match → hr_employees`, so stale matches show as missing
department/clean-name, not errors.
