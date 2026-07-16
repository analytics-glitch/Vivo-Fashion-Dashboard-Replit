"""Staff Rota backend for the Vivo BI dashboard.

Routes are registered via register_rota_routes(app), called from api_pg.py
before the StaticFiles SPA catch-all. All endpoints live at /api/rota/*.

Auth: clerk_auth_gate in api_pg.py gates /api/rota/* to leadership + hr + admin.
Business rules are enforced server-side (>48h/week, consecutive days, rest gap,
leave clash) — returned as structured warnings, not hard errors, so managers
can override after reviewing.

DB tables (idempotently created via _deferred_startup in api_pg.py):
  rota_staff   — the staff roster (who can be scheduled)
  rota_shifts  — shift library (Early / Middle / Late / Off / Leave / etc.)
  rota_entries — one row per (staff, date, shift) — the rota grid
  rota_leave   — leave requests with status lifecycle
"""

import logging
from datetime import date, datetime, timedelta

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger("rota")

# Set in register_rota_routes() to the fully-loaded api_pg module.
A = None

_ROTA_ALLOWED_ROLES = {"admin", "leadership", "hr"}

# Ideal per-shift headcount used for coverage traffic-light calculations.
# Managers can override these per-tab; these are just server-side defaults
# returned in the coverage response so the UI can seed its inputs.
_DEFAULT_COVERAGE_THRESHOLDS = {
    "morning":   {"min": 2, "ideal": 4},
    "afternoon": {"min": 2, "ideal": 4},
    "evening":   {"min": 1, "ideal": 3},
}

_DEFAULT_SHIFTS = [
    {"name": "Early",        "start_time": "07:00", "end_time": "15:00", "colour": "#16a34a", "hours": 8.0},
    {"name": "Middle",       "start_time": "09:00", "end_time": "17:00", "colour": "#2563eb", "hours": 8.0},
    {"name": "Late",         "start_time": "14:00", "end_time": "22:00", "colour": "#7c3aed", "hours": 8.0},
    {"name": "Off",          "start_time": None,    "end_time": None,    "colour": "#6b7280", "hours": 0.0},
    {"name": "Annual Leave", "start_time": None,    "end_time": None,    "colour": "#f59e0b", "hours": 0.0},
    {"name": "Sick Leave",   "start_time": None,    "end_time": None,    "colour": "#ef4444", "hours": 0.0},
    {"name": "Training",     "start_time": None,    "end_time": None,    "colour": "#06b6d4", "hours": 8.0},
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ex(sql, params=None, fetch=False):
    return A._users_exec(sql, params, fetch=fetch)


def _rows(sql, params=None):
    return _ex(sql, params, fetch=True) or []


def _actor(request):
    return A._crm_actor(request)


def _ok(data=None, **kwargs):
    """Return the payload directly — no envelope wrapper.

    The frontend reads r.data (the raw response body) directly, so wrapping
    in {"ok": true, "data": ...} would require every consumer to unwrap.
    Plain dicts/lists are consistent with every other endpoint in this project.
    """
    if data is None and not kwargs:
        return {}
    if kwargs:
        result = dict(data) if isinstance(data, dict) else ({} if data is None else data)
        if isinstance(result, dict):
            result.update(kwargs)
        return result
    return data


def _monday(d: date) -> date:
    """Return the Monday of the ISO week containing d."""
    return d - timedelta(days=d.weekday())


def _parse_date(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Schema bootstrap  (called from @_deferred_startup in api_pg.py)
# ---------------------------------------------------------------------------

def ensure_rota_tables():
    """Idempotently create the four rota tables and seed the shift library."""
    _ex("""
        CREATE TABLE IF NOT EXISTS rota_staff (
            id             SERIAL PRIMARY KEY,
            name           TEXT NOT NULL,
            department     TEXT,
            role           TEXT,
            contract_hours NUMERIC DEFAULT 40,
            max_hours      NUMERIC DEFAULT 48,
            store          TEXT,
            status         TEXT NOT NULL DEFAULT 'active',
            created_at     TIMESTAMPTZ DEFAULT now(),
            updated_at     TIMESTAMPTZ DEFAULT now()
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS rota_shifts (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            start_time TEXT,
            end_time   TEXT,
            colour     TEXT NOT NULL DEFAULT '#6b7280',
            hours      NUMERIC NOT NULL DEFAULT 0,
            is_leave   BOOLEAN NOT NULL DEFAULT FALSE,
            is_system  BOOLEAN NOT NULL DEFAULT TRUE
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS rota_entries (
            id         SERIAL PRIMARY KEY,
            staff_id   INTEGER NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
            entry_date DATE NOT NULL,
            shift_id   INTEGER REFERENCES rota_shifts(id) ON DELETE SET NULL,
            published  BOOLEAN NOT NULL DEFAULT FALSE,
            notes      TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE (staff_id, entry_date)
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS rota_leave (
            id          SERIAL PRIMARY KEY,
            staff_id    INTEGER NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
            start_date  DATE NOT NULL,
            end_date    DATE NOT NULL,
            type        TEXT NOT NULL DEFAULT 'Annual Leave',
            status      TEXT NOT NULL DEFAULT 'Pending',
            reason      TEXT,
            approved_by TEXT,
            created_at  TIMESTAMPTZ DEFAULT now(),
            updated_at  TIMESTAMPTZ DEFAULT now()
        )
    """)
    # Add is_leave column to rota_shifts if it was created before this column existed
    _ex("ALTER TABLE rota_shifts ADD COLUMN IF NOT EXISTS is_leave BOOLEAN NOT NULL DEFAULT FALSE")
    _ex("ALTER TABLE rota_shifts ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT TRUE")

    # Seed default shifts (idempotent: ON CONFLICT DO NOTHING on the UNIQUE name)
    for s in _DEFAULT_SHIFTS:
        is_leave = s["name"] in ("Annual Leave", "Sick Leave")
        _ex(
            """INSERT INTO rota_shifts (name, start_time, end_time, colour, hours, is_leave, is_system)
               VALUES (%s, %s, %s, %s, %s, %s, TRUE)
               ON CONFLICT (name) DO NOTHING""",
            (s["name"], s["start_time"], s["end_time"], s["colour"], s["hours"], is_leave),
        )


# ---------------------------------------------------------------------------
# Business rule validation
# ---------------------------------------------------------------------------

def _check_entry_warnings(staff_id: int, entry_date: date, shift_id: int | None) -> list[str]:
    """Return a list of human-readable warning strings for assigning this entry.
    Never blocks — callers decide whether to surface or ignore."""
    warnings = []
    if shift_id is None:
        return warnings

    shift_rows = _rows("SELECT hours, is_leave FROM rota_shifts WHERE id=%s", (shift_id,))
    if not shift_rows:
        return warnings
    shift = shift_rows[0]
    if shift["is_leave"]:
        return warnings  # leave shifts don't trigger hour/rest warnings

    # 1. Check leave clash: is there an approved leave covering this date?
    leave_clash = _rows(
        """SELECT id FROM rota_leave
           WHERE staff_id=%s AND status='Approved'
             AND start_date <= %s AND end_date >= %s""",
        (staff_id, entry_date, entry_date),
    )
    if leave_clash:
        warnings.append("Scheduling on approved leave")

    # 2. Weekly hours >48
    week_start = _monday(entry_date)
    week_end = week_start + timedelta(days=6)
    hours_data = _rows(
        """SELECT COALESCE(SUM(rs.hours), 0) AS total_hours
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id = re.shift_id
           WHERE re.staff_id=%s
             AND re.entry_date BETWEEN %s AND %s
             AND re.entry_date <> %s""",
        (staff_id, week_start, week_end, entry_date),
    )
    existing_hours = float(hours_data[0]["total_hours"]) if hours_data else 0.0
    new_total = existing_hours + float(shift["hours"] or 0)
    if new_total > 48:
        warnings.append(f"Weekly hours would exceed 48 h (total: {new_total:.1f} h)")

    # 3. >6 consecutive working days
    # Count working days in a 13-day window centred on entry_date
    window_start = entry_date - timedelta(days=6)
    window_end = entry_date + timedelta(days=6)
    worked_days = _rows(
        """SELECT entry_date
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id = re.shift_id
           WHERE re.staff_id=%s AND re.entry_date BETWEEN %s AND %s
             AND rs.hours > 0 AND re.entry_date <> %s
           ORDER BY entry_date""",
        (staff_id, window_start, window_end, entry_date),
    )
    all_dates = sorted(
        [r["entry_date"] for r in worked_days] + ([entry_date] if float(shift["hours"] or 0) > 0 else [])
    )
    max_run = 1
    run = 1
    for i in range(1, len(all_dates)):
        if (all_dates[i] - all_dates[i - 1]).days == 1:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    if max_run > 6:
        warnings.append("More than 6 consecutive working days")

    # 4. <11h rest between shifts
    prev_rows = _rows(
        """SELECT rs.end_time
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id = re.shift_id
           WHERE re.staff_id=%s AND re.entry_date = %s AND rs.end_time IS NOT NULL""",
        (staff_id, entry_date - timedelta(days=1)),
    )
    if prev_rows and prev_rows[0]["end_time"]:
        shift_start_rows = _rows("SELECT start_time FROM rota_shifts WHERE id=%s", (shift_id,))
        if shift_start_rows and shift_start_rows[0]["start_time"]:
            try:
                prev_end_h, prev_end_m = [int(x) for x in prev_rows[0]["end_time"].split(":")]
                cur_start_h, cur_start_m = [int(x) for x in shift_start_rows[0]["start_time"].split(":")]
                # prev end: e.g. 22:00, cur start: e.g. 07:00 next day
                rest_mins = (24 * 60 - (prev_end_h * 60 + prev_end_m)) + (cur_start_h * 60 + cur_start_m)
                if rest_mins < 11 * 60:
                    warnings.append(f"Less than 11 h rest between shifts ({rest_mins // 60}h {rest_mins % 60}m)")
            except Exception:
                pass

    return warnings


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

def _get_overview(request: Request):
    today = date.today()
    week_start = _monday(today)
    week_end = week_start + timedelta(days=6)

    total_staff = _rows("SELECT COUNT(*) AS n FROM rota_staff WHERE status='active'")
    scheduled_today = _rows(
        """SELECT COUNT(DISTINCT re.staff_id) AS n
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id=re.shift_id
           WHERE re.entry_date=%s AND rs.hours>0""",
        (today,),
    )
    on_leave = _rows(
        """SELECT COUNT(DISTINCT rl.staff_id) AS n
           FROM rota_leave rl
           WHERE rl.status='Approved' AND rl.start_date<=%s AND rl.end_date>=%s""",
        (today, today),
    )
    open_shifts = _rows(
        """SELECT COUNT(*) AS n FROM rota_staff rs
           WHERE rs.status='active'
             AND NOT EXISTS (
               SELECT 1 FROM rota_entries re WHERE re.staff_id=rs.id AND re.entry_date=%s
             )""",
        (today,),
    )
    weekly_hours = _rows(
        """SELECT COALESCE(SUM(rs.hours),0) AS h
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id=re.shift_id
           WHERE re.entry_date BETWEEN %s AND %s""",
        (week_start, week_end),
    )
    overtime_staff = _rows(
        """SELECT COUNT(DISTINCT re.staff_id) AS n
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id=re.shift_id
           WHERE re.entry_date BETWEEN %s AND %s
           GROUP BY re.staff_id
           HAVING SUM(rs.hours) > 48""",
        (week_start, week_end),
    )
    overtime_hours = _rows(
        """SELECT COALESCE(SUM(GREATEST(weekly.total-48,0)),0) AS h
           FROM (
             SELECT re.staff_id, SUM(rs.hours) AS total
             FROM rota_entries re
             JOIN rota_shifts rs ON rs.id=re.shift_id
             WHERE re.entry_date BETWEEN %s AND %s
             GROUP BY re.staff_id
           ) weekly""",
        (week_start, week_end),
    )

    ts = int(total_staff[0]["n"]) if total_staff else 0
    sc = int(scheduled_today[0]["n"]) if scheduled_today else 0
    coverage_pct = round(sc / ts * 100) if ts else 0

    # Scheduled per day of current week
    per_day = _rows(
        """SELECT re.entry_date AS d, COUNT(DISTINCT re.staff_id) AS n
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id=re.shift_id
           WHERE re.entry_date BETWEEN %s AND %s AND rs.hours>0
           GROUP BY re.entry_date ORDER BY re.entry_date""",
        (week_start, week_end),
    )
    per_day_map = {r["d"].isoformat() if hasattr(r["d"], "isoformat") else str(r["d"]): int(r["n"]) for r in per_day}
    per_day_chart = []
    for i in range(7):
        d = week_start + timedelta(days=i)
        per_day_chart.append({"date": d.isoformat(), "label": d.strftime("%a"), "count": per_day_map.get(d.isoformat(), 0)})

    # Hours by department
    dept_hours = _rows(
        """SELECT rs_staff.department, COALESCE(SUM(rs_sh.hours),0) AS h
           FROM rota_entries re
           JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id
           JOIN rota_staff rs_staff ON rs_staff.id=re.staff_id
           WHERE re.entry_date BETWEEN %s AND %s
           GROUP BY rs_staff.department
           ORDER BY h DESC""",
        (week_start, week_end),
    )

    # 8-week leave trend
    leave_trend = _rows(
        """SELECT date_trunc('week', generate_series)::date AS week_start,
                  COUNT(rl.id) AS n
           FROM generate_series(%s::date - INTERVAL '7 weeks', %s::date, INTERVAL '1 week') gs
           LEFT JOIN rota_leave rl
             ON rl.status='Approved'
             AND rl.start_date <= (gs + INTERVAL '6 days')::date
             AND rl.end_date   >= gs::date
           GROUP BY week_start ORDER BY week_start""",
        (week_start, week_start),
    )

    # 8-week overtime trend
    ot_trend = _rows(
        """SELECT ws.week_start, COUNT(DISTINCT sub.staff_id) AS n
           FROM (
             SELECT generate_series(%s::date - INTERVAL '7 weeks', %s::date, INTERVAL '1 week')::date AS week_start
           ) ws
           LEFT JOIN LATERAL (
             SELECT re.staff_id
             FROM rota_entries re
             JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id
             WHERE re.entry_date BETWEEN ws.week_start AND ws.week_start+6
             GROUP BY re.staff_id
             HAVING SUM(rs_sh.hours)>48
           ) sub ON TRUE
           GROUP BY ws.week_start ORDER BY ws.week_start""",
        (week_start, week_start),
    )

    return _ok({
        "kpis": {
            "total_staff": ts,
            "scheduled_today": sc,
            "on_leave": int(on_leave[0]["n"]) if on_leave else 0,
            "open_shifts": int(open_shifts[0]["n"]) if open_shifts else 0,
            "weekly_hours": float(weekly_hours[0]["h"]) if weekly_hours else 0.0,
            "coverage_pct": coverage_pct,
            "overtime_staff": len(overtime_staff),
            "overtime_hours": float(overtime_hours[0]["h"]) if overtime_hours else 0.0,
        },
        "per_day_chart": per_day_chart,
        "dept_hours": [{"department": r["department"] or "Unassigned", "hours": float(r["h"])} for r in dept_hours],
        "leave_trend": [{"week": (r["week_start"].isoformat() if hasattr(r["week_start"], "isoformat") else str(r["week_start"])), "count": int(r["n"])} for r in leave_trend],
        "ot_trend": [{"week": (r["week_start"].isoformat() if hasattr(r["week_start"], "isoformat") else str(r["week_start"])), "count": int(r["n"])} for r in ot_trend],
    })


def _get_week(request: Request):
    ws_str = (request.query_params.get("week_start") or "").strip()
    ws = _parse_date(ws_str) if ws_str else _monday(date.today())
    if ws is None:
        ws = _monday(date.today())
    ws = _monday(ws)  # normalise to Monday
    we = ws + timedelta(days=6)

    staff = _rows("SELECT * FROM rota_staff WHERE status='active' ORDER BY department, name")
    shifts = _rows("SELECT * FROM rota_shifts ORDER BY id")
    entries = _rows(
        """SELECT re.*, rs.name AS shift_name, rs.colour AS shift_colour, rs.hours AS shift_hours, rs.is_leave AS shift_is_leave
           FROM rota_entries re
           JOIN rota_shifts rs ON rs.id=re.shift_id
           WHERE re.entry_date BETWEEN %s AND %s""",
        (ws, we),
    )

    # Approved leave that overlaps this week (for display)
    leave = _rows(
        """SELECT * FROM rota_leave
           WHERE status='Approved' AND start_date<=%s AND end_date>=%s""",
        (we, ws),
    )
    leave_by_staff = {}
    for l in leave:
        sid = l["staff_id"]
        if sid not in leave_by_staff:
            leave_by_staff[sid] = []
        leave_by_staff[sid].append({
            "start": l["start_date"].isoformat() if hasattr(l["start_date"], "isoformat") else str(l["start_date"]),
            "end": l["end_date"].isoformat() if hasattr(l["end_date"], "isoformat") else str(l["end_date"]),
            "type": l["type"],
        })

    # Build entry lookup keyed (staff_id, date_iso)
    entry_map = {}
    for e in entries:
        d = e["entry_date"].isoformat() if hasattr(e["entry_date"], "isoformat") else str(e["entry_date"])
        entry_map[(e["staff_id"], d)] = e

    # Check published status for this week
    pub_rows = _rows(
        """SELECT COUNT(*) AS total, SUM(CASE WHEN published THEN 1 ELSE 0 END) AS published_n
           FROM rota_entries WHERE entry_date BETWEEN %s AND %s""",
        (ws, we),
    )
    total_entries = int(pub_rows[0]["total"]) if pub_rows else 0
    pub_count = int(pub_rows[0]["published_n"] or 0) if pub_rows else 0
    is_published = total_entries > 0 and pub_count == total_entries

    rows_out = []
    for s in staff:
        sid = s["id"]
        days = []
        for i in range(7):
            d = ws + timedelta(days=i)
            diso = d.isoformat()
            e = entry_map.get((sid, diso))
            if e:
                days.append({
                    "date": diso,
                    "entry_id": e["id"],
                    "shift_id": e["shift_id"],
                    "shift_name": e["shift_name"],
                    "shift_colour": e["shift_colour"],
                    "shift_hours": float(e["shift_hours"] or 0),
                    "shift_is_leave": e["shift_is_leave"],
                    "published": e["published"],
                    "notes": e["notes"],
                })
            else:
                days.append({
                    "date": diso,
                    "entry_id": None,
                    "shift_id": None,
                    "shift_name": None,
                    "shift_colour": None,
                    "shift_hours": 0.0,
                    "shift_is_leave": False,
                    "published": False,
                    "notes": None,
                })
        rows_out.append({
            "staff_id": sid,
            "name": s["name"],
            "department": s["department"],
            "role": s["role"],
            "store": s["store"],
            "contract_hours": float(s["contract_hours"] or 40),
            "max_hours": float(s["max_hours"] or 48),
            "leave": leave_by_staff.get(sid, []),
            "days": days,
        })

    return _ok({
        "week_start": ws.isoformat(),
        "week_end": we.isoformat(),
        "is_published": is_published,
        "shifts": [{"id": s["id"], "name": s["name"], "colour": s["colour"], "hours": float(s["hours"] or 0), "start_time": s["start_time"], "end_time": s["end_time"], "is_leave": s["is_leave"]} for s in shifts],
        "rows": rows_out,
    })


def _put_entry(request: Request, body: dict):
    staff_id = body.get("staff_id")
    entry_date_str = body.get("entry_date")
    shift_id = body.get("shift_id")  # None = clear the entry
    notes = body.get("notes")

    if not staff_id or not entry_date_str:
        return JSONResponse({"detail": "staff_id and entry_date are required"}, status_code=400)
    entry_date = _parse_date(entry_date_str)
    if not entry_date:
        return JSONResponse({"detail": "Invalid entry_date"}, status_code=400)

    # Check if week is published — require explicit override flag
    pub_rows = _rows(
        "SELECT COUNT(*) AS n FROM rota_entries WHERE entry_date BETWEEN %s AND %s AND published=TRUE",
        (_monday(entry_date), _monday(entry_date) + timedelta(days=6)),
    )
    is_published = int(pub_rows[0]["n"] or 0) > 0 if pub_rows else False
    override = body.get("override_published", False)
    if is_published and not override:
        return JSONResponse({"detail": "week_published", "message": "This week is published. Pass override_published=true to edit."}, status_code=409)

    warnings = _check_entry_warnings(staff_id, entry_date, shift_id)

    if shift_id is None:
        _ex("DELETE FROM rota_entries WHERE staff_id=%s AND entry_date=%s", (staff_id, entry_date))
        return _ok({"warnings": warnings, "deleted": True})

    _ex(
        """INSERT INTO rota_entries (staff_id, entry_date, shift_id, notes, updated_at)
           VALUES (%s, %s, %s, %s, now())
           ON CONFLICT (staff_id, entry_date)
           DO UPDATE SET shift_id=EXCLUDED.shift_id, notes=EXCLUDED.notes, updated_at=now()""",
        (staff_id, entry_date, shift_id, notes),
    )
    return _ok({"warnings": warnings})


def _post_copy_week(request: Request, body: dict):
    from_ws_str = body.get("from_week_start")
    to_ws_str = body.get("to_week_start")
    if not from_ws_str or not to_ws_str:
        return JSONResponse({"detail": "from_week_start and to_week_start are required"}, status_code=400)
    from_ws = _parse_date(from_ws_str)
    to_ws = _parse_date(to_ws_str)
    if not from_ws or not to_ws:
        return JSONResponse({"detail": "Invalid week dates"}, status_code=400)
    from_ws = _monday(from_ws)
    to_ws = _monday(to_ws)
    offset = (to_ws - from_ws).days

    source = _rows(
        "SELECT staff_id, entry_date, shift_id, notes FROM rota_entries WHERE entry_date BETWEEN %s AND %s",
        (from_ws, from_ws + timedelta(days=6)),
    )
    copied = 0
    for e in source:
        new_date = e["entry_date"] + timedelta(days=offset)
        _ex(
            """INSERT INTO rota_entries (staff_id, entry_date, shift_id, notes, published, updated_at)
               VALUES (%s, %s, %s, %s, FALSE, now())
               ON CONFLICT (staff_id, entry_date) DO NOTHING""",
            (e["staff_id"], new_date, e["shift_id"], e["notes"]),
        )
        copied += 1
    return _ok({"copied": copied, "to_week_start": to_ws.isoformat()})


def _put_publish(request: Request, body: dict):
    ws_str = body.get("week_start")
    if not ws_str:
        return JSONResponse({"detail": "week_start is required"}, status_code=400)
    ws = _parse_date(ws_str)
    if not ws:
        return JSONResponse({"detail": "Invalid week_start"}, status_code=400)
    ws = _monday(ws)
    we = ws + timedelta(days=6)
    publish = body.get("publish", True)
    _ex(
        "UPDATE rota_entries SET published=%s, updated_at=now() WHERE entry_date BETWEEN %s AND %s",
        (publish, ws, we),
    )
    return _ok({"week_start": ws.isoformat(), "published": publish})


def _get_leave(request: Request):
    status_f = request.query_params.get("status") or ""
    staff_f = request.query_params.get("staff_id") or ""
    where = ["1=1"]
    params = []
    if status_f and status_f.lower() != "all":
        where.append("rl.status=%s")
        params.append(status_f)
    if staff_f:
        try:
            where.append("rl.staff_id=%s")
            params.append(int(staff_f))
        except ValueError:
            pass
    rows = _rows(
        f"""SELECT rl.*, rs.name AS staff_name, rs.department
            FROM rota_leave rl
            JOIN rota_staff rs ON rs.id=rl.staff_id
            WHERE {" AND ".join(where)}
            ORDER BY rl.created_at DESC""",
        params or None,
    )
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "staff_id": r["staff_id"],
            "staff_name": r["staff_name"],
            "department": r["department"],
            "start_date": r["start_date"].isoformat() if hasattr(r["start_date"], "isoformat") else str(r["start_date"]),
            "end_date": r["end_date"].isoformat() if hasattr(r["end_date"], "isoformat") else str(r["end_date"]),
            "type": r["type"],
            "status": r["status"],
            "reason": r["reason"],
            "approved_by": r["approved_by"],
            "created_at": r["created_at"].isoformat() if hasattr(r["created_at"], "isoformat") else str(r["created_at"]),
        })
    return _ok(out)


def _post_leave(request: Request, body: dict):
    staff_id = body.get("staff_id")
    start_str = body.get("start_date")
    end_str = body.get("end_date")
    leave_type = body.get("type", "Annual Leave")
    reason = body.get("reason", "")
    if not staff_id or not start_str or not end_str:
        return JSONResponse({"detail": "staff_id, start_date, end_date are required"}, status_code=400)
    start = _parse_date(start_str)
    end = _parse_date(end_str)
    if not start or not end or end < start:
        return JSONResponse({"detail": "Invalid date range"}, status_code=400)
    result = _rows(
        """INSERT INTO rota_leave (staff_id, start_date, end_date, type, status, reason)
           VALUES (%s,%s,%s,%s,'Pending',%s) RETURNING id""",
        (staff_id, start, end, leave_type, reason),
    )
    return _ok({"id": result[0]["id"] if result else None})


def _put_leave(request: Request, leave_id: int, body: dict):
    status = body.get("status")
    if status not in ("Approved", "Declined"):
        return JSONResponse({"detail": "status must be Approved or Declined"}, status_code=400)
    _, email, _ = _actor(request)
    _ex(
        "UPDATE rota_leave SET status=%s, approved_by=%s, updated_at=now() WHERE id=%s",
        (status, email, leave_id),
    )
    # If approving, auto-insert leave shift entries into the rota grid
    if status == "Approved":
        leave_rows = _rows("SELECT * FROM rota_leave WHERE id=%s", (leave_id,))
        if leave_rows:
            l = leave_rows[0]
            # Find the matching shift
            shift_rows = _rows("SELECT id FROM rota_shifts WHERE name=%s", (l["type"],))
            if shift_rows:
                shift_id = shift_rows[0]["id"]
                cur = l["start_date"]
                end = l["end_date"]
                while cur <= end:
                    _ex(
                        """INSERT INTO rota_entries (staff_id, entry_date, shift_id, notes, updated_at)
                           VALUES (%s,%s,%s,'Auto from approved leave',now())
                           ON CONFLICT (staff_id, entry_date) DO UPDATE
                           SET shift_id=EXCLUDED.shift_id, notes=EXCLUDED.notes, updated_at=now()""",
                        (l["staff_id"], cur, shift_id),
                    )
                    cur = cur + timedelta(days=1)
    return _ok({"status": status})


_THRESHOLD_CONFIG_KEY = "rota_coverage_thresholds"


def _load_coverage_thresholds() -> dict:
    """Read persisted thresholds from app_config; fall back to defaults."""
    try:
        rows = _rows(
            "SELECT value FROM app_config WHERE key=%s",
            (_THRESHOLD_CONFIG_KEY,),
        )
        if rows:
            import json as _json
            stored = _json.loads(rows[0]["value"])
            merged = {}
            for band in ("morning", "afternoon", "evening"):
                defaults = _DEFAULT_COVERAGE_THRESHOLDS[band]
                entry = stored.get(band, {})
                merged[band] = {
                    "min":   int(entry.get("min",   defaults["min"])),
                    "ideal": int(entry.get("ideal", defaults["ideal"])),
                }
            return merged
    except Exception:
        pass
    return _DEFAULT_COVERAGE_THRESHOLDS.copy()


def _save_coverage_thresholds(data: dict) -> dict:
    """Persist threshold dict into app_config."""
    import json as _json
    validated = {}
    for band in ("morning", "afternoon", "evening"):
        entry = data.get(band, {})
        min_v = max(0, int(entry.get("min", _DEFAULT_COVERAGE_THRESHOLDS[band]["min"])))
        ideal_v = max(min_v, int(entry.get("ideal", _DEFAULT_COVERAGE_THRESHOLDS[band]["ideal"])))
        validated[band] = {"min": min_v, "ideal": ideal_v}
    _ex(
        """INSERT INTO app_config (key, value, updated_at)
           VALUES (%s,%s,now())
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()""",
        (_THRESHOLD_CONFIG_KEY, _json.dumps(validated)),
    )
    return validated


def _get_coverage_thresholds(request: Request):
    return _ok(_load_coverage_thresholds())


def _put_coverage_thresholds(request: Request, body: dict):
    saved = _save_coverage_thresholds(body)
    return _ok(saved)


def _get_coverage(request: Request):
    ws_str = (request.query_params.get("week_start") or "").strip()
    ws = _parse_date(ws_str) if ws_str else _monday(date.today())
    if ws is None:
        ws = _monday(date.today())
    ws = _monday(ws)
    we = ws + timedelta(days=6)

    thresholds = _load_coverage_thresholds()

    # For each day compute morning/afternoon/evening headcount
    # Morning = Early shift; Afternoon = Middle; Evening = Late
    shift_bands = {
        "morning":   "Early",
        "afternoon": "Middle",
        "evening":   "Late",
    }
    days_out = []
    for i in range(7):
        d = ws + timedelta(days=i)
        diso = d.isoformat()
        bands = {}
        for band, shift_name in shift_bands.items():
            count_rows = _rows(
                """SELECT COUNT(DISTINCT re.staff_id) AS n
                   FROM rota_entries re
                   JOIN rota_shifts rs ON rs.id=re.shift_id
                   WHERE re.entry_date=%s AND rs.name=%s""",
                (d, shift_name),
            )
            count = int(count_rows[0]["n"]) if count_rows else 0
            ideal = thresholds[band]["ideal"]
            min_h = thresholds[band]["min"]
            if count >= ideal:
                status = "green"
            elif count >= min_h:
                status = "amber"
            else:
                status = "red"
            bands[band] = {"count": count, "ideal": ideal, "min": min_h, "status": status}
        days_out.append({"date": diso, "label": d.strftime("%a"), "bands": bands})

    # Department coverage
    dept_rows = _rows(
        """SELECT rs_staff.department,
                  COUNT(DISTINCT re.staff_id) AS staff_scheduled,
                  COUNT(DISTINCT rs_staff.id) AS total_staff
           FROM rota_staff rs_staff
           LEFT JOIN rota_entries re
             ON re.staff_id=rs_staff.id AND re.entry_date BETWEEN %s AND %s
           LEFT JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id AND rs_sh.hours>0
           WHERE rs_staff.status='active'
           GROUP BY rs_staff.department ORDER BY rs_staff.department""",
        (ws, we),
    )

    return _ok({
        "week_start": ws.isoformat(),
        "week_end": we.isoformat(),
        "thresholds": thresholds,
        "days": days_out,
        "departments": [
            {
                "department": r["department"] or "Unassigned",
                "staff_scheduled": int(r["staff_scheduled"] or 0),
                "total_staff": int(r["total_staff"] or 0),
            }
            for r in dept_rows
        ],
    })


def _get_report(request: Request):
    report_type = (request.query_params.get("type") or "weekly_hours").strip()
    ws_str = (request.query_params.get("week_start") or "").strip()
    month_str = (request.query_params.get("month") or "").strip()

    if report_type == "weekly_hours":
        ws = _parse_date(ws_str) if ws_str else _monday(date.today())
        if ws is None:
            ws = _monday(date.today())
        ws = _monday(ws)
        we = ws + timedelta(days=6)
        rows = _rows(
            """SELECT rs_staff.name, rs_staff.department, rs_staff.store,
                      COALESCE(SUM(rs_sh.hours),0) AS hours_scheduled,
                      rs_staff.contract_hours
               FROM rota_staff rs_staff
               LEFT JOIN rota_entries re ON re.staff_id=rs_staff.id AND re.entry_date BETWEEN %s AND %s
               LEFT JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id
               WHERE rs_staff.status='active'
               GROUP BY rs_staff.id, rs_staff.name, rs_staff.department, rs_staff.store, rs_staff.contract_hours
               ORDER BY rs_staff.department, rs_staff.name""",
            (ws, we),
        )
        return _ok({
            "type": "weekly_hours",
            "week_start": ws.isoformat(),
            "week_end": we.isoformat(),
            "columns": ["Name", "Department", "Store", "Hours Scheduled", "Contract Hours"],
            "rows": [
                {
                    "name": r["name"], "department": r["department"],
                    "store": r["store"], "hours_scheduled": float(r["hours_scheduled"] or 0),
                    "contract_hours": float(r["contract_hours"] or 40),
                }
                for r in rows
            ],
        })

    elif report_type == "monthly_hours":
        if month_str:
            try:
                y, m = [int(x) for x in month_str.split("-")]
                month_start = date(y, m, 1)
            except Exception:
                month_start = date.today().replace(day=1)
        else:
            month_start = date.today().replace(day=1)
        # Last day of month
        if month_start.month == 12:
            month_end = date(month_start.year + 1, 1, 1) - timedelta(days=1)
        else:
            month_end = date(month_start.year, month_start.month + 1, 1) - timedelta(days=1)
        rows = _rows(
            """SELECT rs_staff.name, rs_staff.department, rs_staff.store,
                      COALESCE(SUM(rs_sh.hours),0) AS hours_scheduled,
                      rs_staff.contract_hours
               FROM rota_staff rs_staff
               LEFT JOIN rota_entries re ON re.staff_id=rs_staff.id AND re.entry_date BETWEEN %s AND %s
               LEFT JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id
               WHERE rs_staff.status='active'
               GROUP BY rs_staff.id, rs_staff.name, rs_staff.department, rs_staff.store, rs_staff.contract_hours
               ORDER BY rs_staff.department, rs_staff.name""",
            (month_start, month_end),
        )
        return _ok({
            "type": "monthly_hours",
            "month": month_str or month_start.strftime("%Y-%m"),
            "columns": ["Name", "Department", "Store", "Hours Scheduled", "Contract Hours"],
            "rows": [
                {
                    "name": r["name"], "department": r["department"],
                    "store": r["store"], "hours_scheduled": float(r["hours_scheduled"] or 0),
                    "contract_hours": float(r["contract_hours"] or 40),
                }
                for r in rows
            ],
        })

    elif report_type == "leave":
        rows = _rows(
            """SELECT rs_staff.name, rs_staff.department,
                      rl.type, rl.status, rl.start_date, rl.end_date,
                      (rl.end_date - rl.start_date + 1) AS days
               FROM rota_leave rl
               JOIN rota_staff rs_staff ON rs_staff.id=rl.staff_id
               ORDER BY rs_staff.name, rl.start_date""",
        )
        return _ok({
            "type": "leave",
            "columns": ["Name", "Department", "Leave Type", "Status", "Start", "End", "Days"],
            "rows": [
                {
                    "name": r["name"], "department": r["department"],
                    "type": r["type"], "status": r["status"],
                    "start_date": r["start_date"].isoformat() if hasattr(r["start_date"], "isoformat") else str(r["start_date"]),
                    "end_date": r["end_date"].isoformat() if hasattr(r["end_date"], "isoformat") else str(r["end_date"]),
                    "days": int(r["days"] or 0),
                }
                for r in rows
            ],
        })

    elif report_type == "overtime":
        ws = _parse_date(ws_str) if ws_str else _monday(date.today())
        if ws is None:
            ws = _monday(date.today())
        ws = _monday(ws)
        we = ws + timedelta(days=6)
        rows = _rows(
            """SELECT rs_staff.name, rs_staff.department, rs_staff.store,
                      COALESCE(SUM(rs_sh.hours),0) AS hours_scheduled,
                      rs_staff.max_hours
               FROM rota_staff rs_staff
               LEFT JOIN rota_entries re ON re.staff_id=rs_staff.id AND re.entry_date BETWEEN %s AND %s
               LEFT JOIN rota_shifts rs_sh ON rs_sh.id=re.shift_id
               WHERE rs_staff.status='active'
               GROUP BY rs_staff.id, rs_staff.name, rs_staff.department, rs_staff.store, rs_staff.max_hours
               HAVING COALESCE(SUM(rs_sh.hours),0) > rs_staff.max_hours * 0.9
               ORDER BY hours_scheduled DESC""",
            (ws, we),
        )
        return _ok({
            "type": "overtime",
            "week_start": ws.isoformat(),
            "week_end": we.isoformat(),
            "columns": ["Name", "Department", "Store", "Hours Scheduled", "Max Hours"],
            "rows": [
                {
                    "name": r["name"], "department": r["department"],
                    "store": r["store"],
                    "hours_scheduled": float(r["hours_scheduled"] or 0),
                    "max_hours": float(r["max_hours"] or 48),
                }
                for r in rows
            ],
        })

    return JSONResponse({"detail": f"Unknown report type: {report_type}"}, status_code=400)


def _get_staff(request: Request):
    rows = _rows("SELECT * FROM rota_staff WHERE status='active' ORDER BY department, name")
    return _ok([{
        "id": r["id"], "name": r["name"], "department": r["department"],
        "role": r["role"], "store": r["store"],
        "contract_hours": float(r["contract_hours"] or 40),
        "max_hours": float(r["max_hours"] or 48),
        "status": r["status"],
    } for r in rows])


def _post_staff(request: Request, body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"detail": "name is required"}, status_code=400)
    result = _rows(
        """INSERT INTO rota_staff (name, department, role, contract_hours, max_hours, store, status)
           VALUES (%s,%s,%s,%s,%s,%s,'active') RETURNING id""",
        (name, body.get("department"), body.get("role"),
         body.get("contract_hours", 40), body.get("max_hours", 48),
         body.get("store")),
    )
    return _ok({"id": result[0]["id"] if result else None})


def _put_staff(request: Request, staff_id: int, body: dict):
    fields = []
    params = []
    for col in ("name", "department", "role", "store", "status"):
        if col in body:
            fields.append(f"{col}=%s")
            params.append(body[col])
    for col in ("contract_hours", "max_hours"):
        if col in body:
            fields.append(f"{col}=%s")
            params.append(float(body[col]))
    if not fields:
        return JSONResponse({"detail": "No fields to update"}, status_code=400)
    fields.append("updated_at=now()")
    params.append(staff_id)
    _ex(f"UPDATE rota_staff SET {', '.join(fields)} WHERE id=%s", params)
    return _ok()


# ---------------------------------------------------------------------------
# Router registration
# ---------------------------------------------------------------------------

def register_rota_routes(app):
    global A
    import api_pg as _api_pg
    A = _api_pg

    @app.get("/api/rota/overview")
    async def rota_overview(request: Request):
        try:
            return _get_overview(request)
        except Exception as e:
            log.error("rota overview error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/week")
    async def rota_week(request: Request):
        try:
            return _get_week(request)
        except Exception as e:
            log.error("rota week error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.put("/api/rota/entry")
    async def rota_put_entry(request: Request):
        try:
            body = await request.json()
            return _put_entry(request, body)
        except Exception as e:
            log.error("rota put entry error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.post("/api/rota/copy-week")
    async def rota_copy_week(request: Request):
        try:
            body = await request.json()
            return _post_copy_week(request, body)
        except Exception as e:
            log.error("rota copy-week error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.put("/api/rota/publish")
    async def rota_publish(request: Request):
        try:
            body = await request.json()
            return _put_publish(request, body)
        except Exception as e:
            log.error("rota publish error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/leave")
    async def rota_get_leave(request: Request):
        try:
            return _get_leave(request)
        except Exception as e:
            log.error("rota get leave error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.post("/api/rota/leave")
    async def rota_post_leave(request: Request):
        try:
            body = await request.json()
            return _post_leave(request, body)
        except Exception as e:
            log.error("rota post leave error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.put("/api/rota/leave/{leave_id}")
    async def rota_put_leave(leave_id: int, request: Request):
        try:
            body = await request.json()
            return _put_leave(request, leave_id, body)
        except Exception as e:
            log.error("rota put leave error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/coverage/thresholds")
    async def rota_get_thresholds(request: Request):
        try:
            return _get_coverage_thresholds(request)
        except Exception as e:
            log.error("rota get thresholds error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.put("/api/rota/coverage/thresholds")
    async def rota_put_thresholds(request: Request):
        try:
            body = await request.json()
            return _put_coverage_thresholds(request, body)
        except Exception as e:
            log.error("rota put thresholds error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/coverage")
    async def rota_coverage(request: Request):
        try:
            return _get_coverage(request)
        except Exception as e:
            log.error("rota coverage error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/report")
    async def rota_report(request: Request):
        try:
            return _get_report(request)
        except Exception as e:
            log.error("rota report error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.get("/api/rota/staff")
    async def rota_get_staff(request: Request):
        try:
            return _get_staff(request)
        except Exception as e:
            log.error("rota get staff error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.post("/api/rota/staff")
    async def rota_post_staff(request: Request):
        try:
            body = await request.json()
            return _post_staff(request, body)
        except Exception as e:
            log.error("rota post staff error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)

    @app.put("/api/rota/staff/{staff_id}")
    async def rota_put_staff(staff_id: int, request: Request):
        try:
            body = await request.json()
            return _put_staff(request, staff_id, body)
        except Exception as e:
            log.error("rota put staff error: %s", e)
            return JSONResponse({"detail": str(e)}, status_code=500)
