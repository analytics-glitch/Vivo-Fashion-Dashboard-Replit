---
name: HR attendance has no Absent rows
description: vivo_attendance only stores Present/Missing-Check-Out; attendance rate needs an expected-days baseline, not present/total-rows.
---

`vivo_attendance` rows exist ONLY for days an employee showed up — statuses are
just `Present` and `Missing Check-Out`. There are **no `Absent` rows**.

**Consequence:** any attendance-rate computed as
`present_rows / total_rows` (or `present / COUNT(*)`) trends to ~100% and is
meaningless. This is easy to write by accident on a new aggregate.

**How to apply:** compute the denominator from an *expected-days* baseline, the
way `/api/hr/employee-summary` does:
- `opendays` CTE = `COUNT(DISTINCT attendance_date)` per `branch_name` over the
  filtered window (the branch's actual operating days).
- per employee: `days_present = COUNT(DISTINCT attendance_date)`,
  `expected_days = MAX(open_days)` for their branch.
- rate = `days_present / expected_days`. To aggregate to a department, sum both
  numerator and denominator across that department's employees, then divide.

Frontend mirrors this: do NOT recompute attendance % client-side from
`/employee-detail` rows (present-only). Use the server-provided
`attendance_rate` / `days_present` / `total_days` fields instead.

`late_rate` uses a different denominator: `late_days / checkin_days` (days with a
check-in), which is fine.
