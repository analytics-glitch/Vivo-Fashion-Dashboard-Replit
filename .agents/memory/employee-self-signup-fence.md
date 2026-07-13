---
name: Employee self-signup role + API fence
description: Google self-signups auto-approve into a minimal "employee" role confined server-side to salary-advance endpoints.
---
Google self-signups on an allowed company domain no longer land pending/store_manager — they are AUTO-APPROVED into the minimal `employee` role (`active`, `approved_by='system:auto-employee'`).

**Rule:** the enforcement is a server-side fence in the auth middleware: role `employee` may only reach `/api/hr/salary-advances*`; everything else (including non-self `/api/auth/*` utilities like active-viewers) 403s with `employee_salary_advance_only`. Client nav/route gating (vivo-hr pins employees to `/salary-advance`, ROLE_PAGES.employee=[]) is UX only, bypassable.

**Why:** the whole company signs in via Google to apply for salary advances; giving self-signups any dashboard role or a pending queue creates admin toil and data exposure. Group Access could still *grant* pages to the employee group, but the API fence blocks the data — intentional.

**How to apply:** any new "self-service only" role should follow the same pattern: constant self-signup role + middleware allowlist fence (keep it narrower than `/api/auth/` — auth self-paths already return earlier in the middleware). Trade-off accepted: the admin notification bell no longer surfaces Google signups (nothing is pending). Review-permission UI (e.g. SalaryAdvance review card) must key off server `can_review`, never a client-side role remap.
