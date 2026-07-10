---
name: vivo-hr ported HR dashboard
description: How the standalone /hr/ attendance dashboard is wired — ported frontend + derived-metrics backend over vivo_attendance.
---

# vivo-hr (HR attendance dashboard at /hr/)

Standalone web artifact `artifacts/vivo-hr`, a faithful port of
github.com/analytics-glitch/HR-Dashboard. Like the vivo-crm port, only **auth**
was rewired to this project's Postgres email/password + Google login (Bearer
`vivo_token` in localStorage; role map admin/exec→executive,
analyst/manager/hr→hr_manager, else→branch_manager; active-only). Frontend uses
two axios clients: `apiClient` (baseURL `/api`, auth paths) and `vivoClient`
(baseURL `/api/hr`, all attendance data). `TIME_OFFSET_HOURS=0` because the
backend already returns Africa/Nairobi wall-clock.

## Backend = derived metrics, not stored columns
`hr_attendance.py` (root, `register_hr_routes(app)`, registered in api_pg.py
right after crm_clienteling, before StaticFiles). Mirrors the crm_clienteling
module pattern (`A=api_pg`, `_ex`/`_rows` via `A._users_exec`, `A._crm_audit`,
`A._crm_actor`). All 13 `/api/hr/*` analytics endpoints aggregate the live
`vivo_attendance` table in SQL.

**The source table has NO is_late / is_overtime / absent columns** and only two
`attendance_status` values: `Present`, `Missing Check-Out` (a row exists only
when someone punched — there are NO absent rows). Everything is DERIVED:
- Device timestamps (check_in/out, device_last_seen) are EAT wall-clock stored
  mislabeled as +00; read them `AT TIME ZONE 'UTC'` (SRC_TZ) for every time-of-day
  derivation AND display (NOT 'Africa/Nairobi' — that double-shifts +3h). App
  `created_at` is genuine now() UTC → stays 'Africa/Nairobi' (TZ). See
  hr-attendance-tz-mislabel.md.
- Work day is 08:00–17:00 (WORK_START_MIN/WORK_END_MIN): is_late = local check-in
  > 08:00; is_early = local check-out < 17:00; is_overtime = hours_worked > 9;
  is_undertime = complete AND < 8. (Thresholds are policy constants — confirm
  current values in hr_attendance.py before relying on them.)
- **absent is derived** = roster − showed-up, where roster = `COUNT(DISTINCT
  user_id)` in a trailing window (`ROSTER_DAYS=30` for snapshot endpoints;
  range-wide distinct for trend/heatmap). "Open days" = distinct attendance_date
  the branch has any row (avoids assuming weekends/holidays).
- consecutive_absences walked in Python over each branch's open-day list.

## Route collision trap
crm_clienteling already owns `/api/notes` (+ POST/DELETE) for CRM customer
notes. The HR frontend originally called `apiClient` `/notes` + `/leaves`, which
the CRM route silently swallowed (FastAPI matches first-registered). Fix: HR
notes/leaves live at `/api/hr/notes` + `/api/hr/leaves` (two `hr_*` tables) and
the frontend calls them via `vivoClient`, not `apiClient`. Any new shared-prefix
route added to a ported app must be checked against existing api_pg/crm routes.

## Authorization (server-side, like /api/crm)
- `/api/hr/*` is gated in `clerk_auth_gate` (api_pg.py) to staff roles
  {admin, exec, analyst, manager, hr, store_manager} — pure `viewer`/`warehouse`
  are 403'd. Active-session-only was NOT enough: hidden web nav / mobile is
  bypassable, so the gate mirrors the CRM/Social pattern.
- Writes (notes/leaves create/update/delete) require exec/hr_manager via
  in-module `_can_write` ({admin, exec, analyst, manager, hr}); branch_manager
  (store_manager) is read-only, matching the frontend `canWrite`.
- **Branch scoping is fail-closed, not a no-op.** `app_users` has NO branch
  column, so `_branch_scope` reads any branch hint on the user dict
  (branch/branch_name/branch_assignment); exec/hr_manager see all, but a
  branch_manager with no resolvable branch sees ZERO notes/leaves (WHERE FALSE).
  The mechanism activates automatically if a branch field is ever added to the
  user object — don't "restore" the old see-all behavior.

## Other deviations
- **Layout: the task spec demands a SIDEBAR, but the reference app's AppLayout is
  a two-row top-nav.** "Faithful replica" and the spec's "Done looks like:
  sidebar nav" conflict — the spec wins, so AppLayout is a fixed left sidebar
  (w-64, lg:pl-64 content offset, Sheet drawer on mobile). Don't "restore" the
  reference top-nav thinking it's more faithful.
- **HQ expand fallback must target the literal `HQ` branch**, not hardcoded
  `HQ Local Device 1..4`. This DB is pre-collapsed (branch already = `HQ`); the
  device names don't exist here, so the old fallback returned empty HQ detail.
  `expandBranchName` returns real device sources when present, else `[HQ_LABEL]`.
- Google sign-in must be initiated from the HR Login (button → `/api/auth/google/
  login?return=<BASE_URL>auth/callback`), same as vivo-crm; AuthCallback alone is
  not enough.
- Notes had only list/create/delete; added `PUT /api/hr/notes/{id}` (note/flag/
  resolved) wired to a Resolve/Reopen toggle in LeaveAndNotes.jsx.
- Training is now LIVE off the real Google Sheet: `lib/training.js` is a real axios
  client (baseURL `/api/hr/training`, Bearer `vivo_token`); backend sync + read
  endpoints live in `hr_attendance.py` (`_sync_training`/`_training_autosync`,
  `_ensure_training_tables`). Shape contract still holds: `/filters` MUST return an
  OBJECT (categories/…/earliest_date/latest_date), not `[]`, or Training.jsx
  date-picker seeding breaks; `/overview`→object, `/lateness`→{by_training,detail},
  most others→[]. Extra `/coverage` + `/targets` endpoints exist but Training.jsx
  doesn't consume them yet (optional enrichment).
- The reference login screen shows cosmetic "demo accounts" hints
  (exec@vivofashion.com …) — they fill the form but are not real accounts.
- `@radix-ui/react-visually-hidden` had to be added (BranchDetailSheet.jsx).
- **Role-gate vs mapRole mismatch to remember when testing/reviewing:** the
  api_pg `/api/hr` gate allows {admin, leadership, store_manager, retail, hr}
  and `_can_write` allows {admin, leadership, hr} — but the frontend `mapRole`
  sends `leadership` to branch_manager (review/write UI hidden) and `analyst`
  is 403'd by the gate entirely. A working HR-reviewer test account must use
  role `hr` (or `admin`). Salary Advance (`/salary-advance`,
  `hr_salary_advances` table) is deliberately carved OUT of the /api/hr role
  gate (`/api/hr/salary-advances*` bypasses the role list — ANY authenticated
  active user may apply; self-service, own-rows-only). Review stays
  `_can_write` server-side + the server's `can_review` flag client-side.
  Don't "tighten" the carve-out back into the role list — that reintroduces
  the "staff can't apply" bug.
