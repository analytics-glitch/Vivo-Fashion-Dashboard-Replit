---
name: Production wallboard sheet feed
description: How the factory-TV hourly tracker page gets its data and access; parsing quirks of the hand-edited tracker sheet.
---

**Rule:** The Production Wallboard (`/production-wallboard`, `production_wallboard.py`) reads the "Production Tracker" Google Sheet directly per request (30s TTL cache + per-process single-flight) — there is deliberately NO sync-loop job and NO DB table for it.
**Why:** The sheet is hand-updated hourly; a direct read keeps the TV ~1 min fresh with zero idempotency/watchdog surface. An earlier sync-loop attempt at this feature was reverted.
**How to apply:** Don't "optimize" it into the sync cycle or a DB table. Access rides the existing `production` page id via `anyOfPageIds` on route + nav — no new page id is registered anywhere; don't add one.

Sheet parsing quirks (hand-edited!):
- Dates are D/M/YYYY (Kenya locale); parser swaps when M/D is unambiguous.
- Slots "8:00-9:00"…"4:00-5:00"; start hour < 7 means PM (+12); lunch 1:00-2:00 never appears; end hour derived (start+1), never trusted from text.
- Day modes: live (today, pro-rata elapsed) / past (all elapsed) / future (nothing elapsed; default date never picks a pre-created future day).
- Live mode EXCLUDES actuals typed into not-yet-started slots (`counted=false`, dimmed cell) so stray entries can't inflate made/pace/projection.
- Duplicates: last (line,date,slot) row wins; duplicate/skipped counts surface in `payload.warnings` and an amber "Sheet check" strip on the page.
- Backend uses `hr_attendance._gsheet_values` whole-column read (A1:E); `PRODUCTION_SHEET_ID`/`PRODUCTION_SHEET_TAB` secrets with safe defaults baked in.
