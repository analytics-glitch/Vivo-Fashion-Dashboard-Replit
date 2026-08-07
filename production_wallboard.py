"""Production hourly-tracker wallboard backend.

Reads the "Production Tracker" Google Sheet (one row per sewing line per hour
slot: Sewing Line | Date | Time Slot | Target | Actual) via the Replit
google-sheet connector and serves ONE JSON payload with per-line hourly
target-vs-actual, pace, and a projected end-of-day landing.

The sheet is hand-updated hourly by production staff; the wallboard frontend
polls every 30s and this module re-reads the sheet at most every ~30s per
process (TTL cache + single-flight; the API runs a single uvicorn process, so
in practice that is one sheet read per ~30s), so an edit shows on the screen
within ~1 minute.

Day modes
- live   (requested/default date == today EAT): "should be" / status use
  pro-rata clock math; actuals typed into NOT-YET-STARTED slots are shown but
  EXCLUDED from made/pace/projection (counted=False) so a stray future entry
  can't inflate the board.
- past   (date < today): everything elapsed; projection == actual total.
- future (date > today): nothing elapsed; status "Not started".

Pace & projection are FILLED-HOURS based (per user spec): pace = made ÷ hours
with an Actual entered (counted only); projection = made + pace × hours
without a counted entry (future-typed values are forecast as if blank — they
must not move the projection either way). The clock only drives
expected_by_now/status — so a line isn't punished for a sheet update that
lags the wall clock.

Data quality: duplicate (date, line, slot) rows keep the LAST row (treated as
a correction) and are reported in payload.warnings; unparseable rows are
skipped and counted there too. Header drift or an unreachable sheet fails
loudly with 503 — no silent fallback.

All "now" math is EAT (UTC+3) wall-clock. Dates in the sheet are D/M/YYYY
(Kenya locale); slots like "8:00-9:00", "12:00-1:00", "2:00-3:00" — start
hours < 7 are PM (+12). Lunch (1:00-2:00) simply doesn't appear as a slot.
Whole-column read (A1:E) — never a fixed row cap (bins-sheet lesson).
"""

import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from hr_attendance import _gsheet_values

production_wallboard_router = APIRouter()

EAT = timezone(timedelta(hours=3))

SHEET_ID = (os.environ.get("PRODUCTION_SHEET_ID") or "").strip() or \
    "11Ub7_vnHo3MasOvnXHtKG65gsSsv-OMXwmV0aGPxmu8"
SHEET_TAB = (os.environ.get("PRODUCTION_SHEET_TAB") or "").strip() or \
    "Production Tracker"

_TTL_SECONDS = 30.0
_cache_lock = threading.Lock()
_fetch_lock = threading.Lock()  # single-flight (per process) for the sheet read
_cache = {"ts": 0.0, "rows": None}


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _to_num(v):
    """Blank-safe int parse; returns None for empty/unparseable cells."""
    s = str(v if v is not None else "").strip().replace(",", "")
    if not s:
        return None
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def _parse_date(v):
    """Sheet dates are D/M/YYYY (Kenya). Tolerate M/D when unambiguous."""
    s = str(v or "").strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)
    if not m:
        # Also accept ISO just in case the sheet format changes.
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except ValueError:
            return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    if mo > 12 and d <= 12:  # someone typed M/D — swap
        d, mo = mo, d
    try:
        return datetime(y, mo, d).date()
    except ValueError:
        return None


_SLOT_RE = re.compile(r"^\s*(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?\s*$")


def _parse_slot(v):
    """'8:00-9:00' -> (8, 9); '12:00-1:00' -> (12, 13); '2:00-3:00' -> (14, 15).

    Factory day starts 08:00, so any start hour < 7 is PM. End hour is derived
    from the start (slots are 1h) so '12:00-1:00' can't map to 12->1.
    """
    m = _SLOT_RE.match(str(v or ""))
    if not m:
        return None
    start = int(m.group(1))
    if start < 7:
        start += 12
    if start > 23:
        return None
    return (start, start + 1)


def _read_sheet_rows():
    """TTL-cached, single-flight (per process) whole-grid read of the tab."""
    now = time.time()
    with _cache_lock:
        if _cache["rows"] is not None and now - _cache["ts"] < _TTL_SECONDS:
            return _cache["rows"]
    with _fetch_lock:
        with _cache_lock:  # another request may have refreshed while we waited
            if _cache["rows"] is not None and time.time() - _cache["ts"] < _TTL_SECONDS:
                return _cache["rows"]
        values = _gsheet_values(SHEET_ID, SHEET_TAB, "A1:E")
        with _cache_lock:
            _cache["rows"] = values
            _cache["ts"] = time.time()
        return values


def _parse_grid(values):
    """-> ({date: {line: {start_hour: {...slot}}}}, warnings dict)."""
    if not values:
        return {}, {"duplicate_rows": 0, "skipped_rows": 0}
    header = [_norm(c) for c in values[0]]

    def col(*tokens):
        for i, h in enumerate(header):
            if h in tokens:
                return i
        for i, h in enumerate(header):
            if any(t in h for t in tokens):
                return i
        return None

    c_line = col("sewing line", "line")
    c_date = col("date")
    c_slot = col("time slot", "slot", "time")
    c_target = col("target")
    c_actual = col("actual", "achieved")
    if c_line is None or c_date is None or c_slot is None or c_target is None:
        raise HTTPException(
            status_code=503,
            detail="Production Tracker sheet header changed — expected "
                   "'Sewing Line | Date | Time Slot | Target | Actual'.",
        )

    out = {}
    dupes = 0
    skipped = 0
    for raw in values[1:]:
        row = list(raw) + [""] * (5 - len(raw))
        if not any(str(c).strip() for c in row):
            continue  # fully blank row — not a data-quality problem
        line = str(row[c_line] or "").strip()
        day = _parse_date(row[c_date])
        slot = _parse_slot(row[c_slot])
        if not line or day is None or slot is None:
            skipped += 1
            continue
        start, end = slot
        rec = out.setdefault(day, {}).setdefault(line.upper(), {})
        if start in rec:
            dupes += 1  # last row wins — treated as a correction
        rec[start] = {
            "label": str(row[c_slot]).strip(),
            "start_hour": start,
            "end_hour": end,
            "target": _to_num(row[c_target]),
            "actual": _to_num(row[c_actual]) if c_actual is not None else None,
        }
    return out, {"duplicate_rows": dupes, "skipped_rows": skipped}


def _line_payload(line_name, slots_by_hour, now_eat, day_mode):
    """day_mode: 'live' (today, pro-rata), 'past' (all elapsed), 'future'."""
    slots = [slots_by_hour[h] for h in sorted(slots_by_hour)]
    now_h = now_eat.hour + now_eat.minute / 60.0

    daily_target = sum(s["target"] or 0 for s in slots)

    made = 0
    future_actuals = 0
    expected = 0.0
    elapsed_hours = 0.0   # productive hours fully/partially elapsed
    done_slots = 0
    for s in slots:
        if day_mode == "past":
            frac = 1.0
        elif day_mode == "future":
            frac = 0.0
        elif now_h >= s["end_hour"]:
            frac = 1.0
        elif now_h > s["start_hour"]:
            frac = now_h - s["start_hour"]
        else:
            frac = 0.0
        # A stray value typed into a slot that hasn't started must not inflate
        # the live board; it stays visible in the cell but is not counted.
        counted = frac > 0.0
        if s["actual"] is not None:
            if counted:
                made += s["actual"]
            else:
                future_actuals += 1
        s["elapsed_fraction"] = round(frac, 2)
        s["counted"] = counted
        s["hit"] = (s["actual"] is not None and (s["target"] or 0) > 0
                    and s["actual"] >= s["target"])
        expected += (s["target"] or 0) * frac
        elapsed_hours += frac
        if frac >= 1.0:
            done_slots += 1

    productive_hours = len(slots)

    # Pace is data-driven, not clock-driven: made ÷ hours actually FILLED IN
    # (counted slots with an Actual). With 2 hours filled, pace = made/2 until
    # a third hour is entered — a late sheet update can't drag the pace down.
    # Projection extends that pace over every slot without a COUNTED entry; a
    # value typed into a not-yet-started slot is forecast at pace as if blank,
    # so a stray future entry can neither raise nor lower the projection. A
    # finished (past) day simply lands on its actual total.
    hours_filled = sum(1 for s in slots if s["actual"] is not None and s["counted"])
    unfilled_hours = productive_hours - hours_filled

    if hours_filled > 0:
        pace = made / hours_filled
        projected = float(made) if day_mode == "past" else made + pace * unfilled_hours
    else:
        pace = None  # no hours filled in yet — no run-rate to project from
        projected = float(made) if day_mode == "past" else float(daily_target)

    expected_i = int(round(expected))
    if day_mode == "future" or elapsed_hours < 0.25 or (expected_i <= 0 and made <= 0):
        status = "Not started"
    else:
        ratio = (made / expected) if expected > 0 else (1.0 if made > 0 else 0.0)
        if ratio >= 0.97:
            status = "On track"
        elif ratio >= 0.85:
            status = "Slightly behind"
        else:
            status = "Behind"

    return {
        "sewing_line": line_name,
        "slots": slots,
        "daily_target": daily_target,
        "made_so_far": made,
        "future_actuals": future_actuals,
        "expected_by_now": expected_i,
        "pct_achieved": int(round(100 * made / daily_target)) if daily_target else 0,
        "pace_per_hour": round(pace, 1) if pace is not None else None,
        "hours_filled": hours_filled,
        "hours_completed": done_slots,
        "productive_hours": productive_hours,
        "projected_landing": int(round(projected)),
        "projected_pct": int(round(100 * projected / daily_target)) if daily_target else 0,
        "status": status,
        "targets_set": daily_target > 0,
    }


@production_wallboard_router.get("/api/production/hourly-tracker")
def hourly_tracker(work_date: str = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")):
    try:
        grid, warnings = _parse_grid(_read_sheet_rows())
    except HTTPException:
        raise
    except Exception as e:  # connector/network/API failure — fail loudly
        raise HTTPException(status_code=503,
                            detail=f"Production Tracker sheet unreachable: {e}")

    if not grid:
        raise HTTPException(status_code=503,
                            detail="Production Tracker sheet has no data rows.")

    now_eat = datetime.now(EAT)
    today = now_eat.date()
    dates = sorted(grid.keys())

    if work_date:
        chosen = datetime.strptime(work_date, "%Y-%m-%d").date()
        if chosen not in grid:
            raise HTTPException(status_code=404,
                                detail=f"No tracker rows for {work_date}.")
    else:
        # Default: today if present; else the most recent past day; never
        # default to a pre-created future day (it would render as finished).
        past = [d for d in dates if d <= today]
        chosen = today if today in grid else (past[-1] if past else dates[0])

    if chosen == today:
        day_mode = "live"
    elif chosen < today:
        day_mode = "past"
    else:
        day_mode = "future"

    lines = [
        _line_payload(name, by_hour, now_eat, day_mode)
        for name, by_hour in sorted(grid[chosen].items())
    ]
    warnings["future_actuals"] = sum(l["future_actuals"] for l in lines)

    totals = {
        "daily_target": sum(l["daily_target"] for l in lines),
        "made_so_far": sum(l["made_so_far"] for l in lines),
        "expected_by_now": sum(l["expected_by_now"] for l in lines),
        "projected_landing": sum(l["projected_landing"] for l in lines),
    }
    totals["pct_achieved"] = (
        int(round(100 * totals["made_so_far"] / totals["daily_target"]))
        if totals["daily_target"] else 0)
    totals["projected_pct"] = (
        int(round(100 * totals["projected_landing"] / totals["daily_target"]))
        if totals["daily_target"] else 0)

    return {
        "work_date": chosen.isoformat(),
        "is_today": day_mode == "live",
        "is_future": day_mode == "future",
        "available_dates": [d.isoformat() for d in dates[-14:]],
        "generated_at": now_eat.isoformat(),
        "timezone": "Africa/Nairobi",
        "lines": lines,
        "totals": totals,
        "warnings": warnings,
        "refresh_seconds": 30,
    }
