#!/usr/bin/env python3
"""
sync_hr_roster.py
-----------------
Imports the company staff roster from the Google Sheet into hr_employees and
rebuilds the attendance name-match table (hr_employee_match).

Why this exists: production runs on a SEPARATE Postgres DB that was never loaded
with the roster (the roster was hand-imported into dev). The HR attendance pages
enrich raw biometric attendance via hr_employee_match -> hr_employees, so a fresh
prod DB shows no departments/teams/job-titles until this runs. It is folded into
the incremental sync loop (see sync_incremental.py) as a bootstrap that fires
when hr_employees is empty, so prod self-populates on first publish.

Idempotent full-refresh: hr_employees is re-read from the sheet (the sheet is the
source of truth) and hr_employee_match is rebuilt from scratch. Safe to re-run.

Usage:
    python sync_hr_roster.py [--ai]
      --ai   run the LLM matching pass for ambiguous names (used on first
             bootstrap for best match quality). Omit for a cheaper deterministic
             rematch (exact/token/fuzzy only).
"""

import sys
import logging

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_hr_roster")

import api_pg
import hr_attendance

# hr_attendance reads its DB/LLM/logging helpers off this module global, which is
# normally set by register_hr_routes() under uvicorn. Wire it up for the script.
hr_attendance.A = api_pg
hr_attendance._ensure_hr_tables()


def main():
    use_ai = "--ai" in sys.argv[1:]
    n = hr_attendance._sync_roster()
    log.info("Roster import: %d employees from sheet", n)
    results = hr_attendance._hr_rematch(use_ai=use_ai)
    matched = sum(1 for r in results if r[1] is not None)
    log.info("Rematch: %d/%d attendance names matched (ai=%s)",
             matched, len(results), use_ai)


if __name__ == "__main__":
    main()
