---
name: HR attendance timezone mislabel
description: vivo_attendance device timestamps are EAT wall-clock stored as +00; read them AT TIME ZONE 'UTC', never 'Africa/Nairobi'
---

The biometric attendance devices (table `vivo_attendance`) record East-Africa
(UTC+3) wall-clock times, but the source feeds them WITHOUT the offset, so
`check_in_time`, `check_out_time`, and `device_last_seen` land in Postgres as
that wall-clock **mislabeled as +00** (e.g. a real 09:41 EAT check-in is stored
as `2026-06-20 09:41:55+00`).

**Rule:** read those columns `AT TIME ZONE 'UTC'` (constant `SRC_TZ` in
`hr_attendance.py`) — that returns the stored wall-clock unchanged = the correct
EAT time. Reading them `AT TIME ZONE 'Africa/Nairobi'` (the old bug) WRONGLY adds
a second +3h (09:41 displayed as 12:41).

**Why:** the instant in the DB is wrong by +3h, but the wall-clock *portion* is
the truth. The whole dataset is uniformly mislabeled, so a display-layer fix
(treat stored as EAT) corrects every row consistently in both dev and prod with
zero data migration — preferable to rewriting the extractor + backfilling +
coordinating a separate prod migration.

**Exception:** note/leave `created_at` is written by Postgres `now()` = a genuine
UTC instant, so it KEEPS `AT TIME ZONE 'Africa/Nairobi'` (constant `TZ`) for
display. Don't blanket-swap every conversion.

**How to apply:** all time-of-day derivations funnel through `_LIN`/`_LOUT`
(→ `IS_LATE`, `IS_EARLY`, `CIN_LOCAL`, `COUT_LOCAL`). Keep those on `SRC_TZ`.
Frontend `TIME_OFFSET_HOURS` stays 0.
