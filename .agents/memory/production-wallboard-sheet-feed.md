---
name: Production wallboard sheet feed
description: How the factory-TV hourly tracker page gets its data and access; parsing quirks of the hand-edited tracker sheet.
---

**Rule:** The Production Wallboard (`/production-wallboard`, `production_wallboard.py`) reads the "Production Tracker" Google Sheet directly per request (30s TTL cache + per-process single-flight) — there is deliberately NO sync-loop job and NO DB table for it.
**Why:** The sheet is hand-updated hourly; a direct read keeps the TV ~1 min fresh with zero idempotency/watchdog surface. An earlier sync-loop attempt at this feature was reverted.
**How to apply:** Don't "optimize" it into the sync cycle or a DB table. The wallboard is a TAB inside the Production Pipeline hub (`Production.jsx` PROD_TABS id `wallboard`, pageId `production` — no new page id anywhere); `/production-wallboard` redirects to `/production?tab=wallboard` preserving `?date=` etc. Don't re-add a standalone nav item.

**Pace & projection are FILLED-hours based (explicit user spec — don't "fix" back to clock):** pace = made ÷ hours with an Actual entered (counted slots only); projection = made + pace × slots still without an entry; a past day lands on its actual total. Only expected_by_now/status use clock pro-rata.
**Why:** staff enter the sheet up to an hour late; clock-based pace punished every line for entry lag (e.g. 85 made in 2 filled hours read as 28/hr instead of 42.5/hr).

Sheet parsing quirks (hand-edited!):
- Dates are D/M/YYYY (Kenya locale); parser swaps when M/D is unambiguous.
- Slots "8:00-9:00"…"4:00-5:00"; start hour < 7 means PM (+12); lunch 1:00-2:00 never appears; end hour derived (start+1), never trusted from text.
- Day modes: live (today, pro-rata elapsed) / past (all elapsed) / future (nothing elapsed; default date never picks a pre-created future day).
- Live mode EXCLUDES actuals typed into not-yet-started slots (`counted=false`, dimmed cell) so stray entries can't inflate made/pace/projection.
- Duplicates: last (line,date,slot) row wins; duplicate/skipped counts surface in `payload.warnings` and an amber "Sheet check" strip on the page.
- Backend uses `hr_attendance._gsheet_values` whole-column read (A1:E); `PRODUCTION_SHEET_ID`/`PRODUCTION_SHEET_TAB` secrets with safe defaults baked in.
