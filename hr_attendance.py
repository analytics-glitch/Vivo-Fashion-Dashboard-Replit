"""HR attendance dashboard backend for the ported `vivo-hr` frontend.

The frontend (artifacts/vivo-hr, served at /hr/) is a faithful port of
github.com/analytics-glitch/HR-Dashboard whose original backend used an
external attendance analytics API (`vivoClient`) + MongoDB (auth/notes/leaves).
Here every `vivoClient` endpoint is re-implemented as SQL over THIS project's
live `vivo_attendance` Postgres table, and notes/leaves become two `hr_*`
tables. Auth reuses the project's existing Postgres staff session (handled by
the shared `clerk_auth_gate` middleware in api_pg.py).

Routes are registered into the main FastAPI app by `register_hr_routes(app)`,
called from api_pg.py immediately BEFORE the StaticFiles SPA catch-all (route
match order matters — the catch-all would otherwise swallow GET /api/*).

The source table has NO is_late / is_overtime / absent columns and only two
attendance_status values ('Present', 'Missing Check-Out') — every derived
metric (lateness, early departure, over/undertime, absence, hours lost,
consecutive absences) is COMPUTED here.

Timezone note: the biometric devices record East-Africa (UTC+3) wall-clock
times, but the source feeds them to us WITHOUT the offset, so check_in_time /
check_out_time / device_last_seen land in Postgres as that wall-clock mislabeled
as +00 (e.g. a 09:41 EAT check-in is stored as 09:41:55+00). They must therefore
be read back AT TIME ZONE 'UTC' (SRC_TZ) — which returns the stored wall-clock
unchanged = the correct EAT time. Reading them AT TIME ZONE 'Africa/Nairobi'
would WRONGLY add a second +3h (showing 09:41 as 12:41). App-written timestamps
(note/leave created_at) are genuine UTC instants from now() and ARE converted to
Africa/Nairobi (TZ) for display. So the frontend's TIME_OFFSET_HOURS is 0.
"""

from datetime import date, timedelta

from fastapi import Request
from fastapi.responses import JSONResponse

# Set in register_hr_routes() to the fully-loaded api_pg module. Routes only
# dereference it at request time, by which point it is populated.
A = None

# --- Derivation parameters (a standard 09:00-18:00, 9h work day) ----------- #
TZ = "Africa/Nairobi"     # for genuine-UTC app timestamps (note/leave created_at)
# Device/source timestamps (check_in_time, check_out_time, device_last_seen) are
# EAT wall-clock stored mislabeled as +00 (see module docstring). Reading them at
# 'UTC' returns that wall-clock as-is = the real East-Africa time. Do NOT use TZ
# here or you double-shift by +3h.
SRC_TZ = "UTC"
WORK_START_MIN = 9 * 60   # 09:00 — arrivals after this are "late"
WORK_END_MIN = 18 * 60    # 18:00 — departures before this are "early"
EXPECTED_HOURS = 9.0      # full scheduled day
ALLOWABLE_HOURS = 8.0     # minimum acceptable worked hours before "lost"
ROSTER_DAYS = 30          # trailing window that defines a branch's active roster

# Reusable SQL fragments (only integer/float constants interpolated — no params).
_LIN = f"(check_in_time AT TIME ZONE '{SRC_TZ}')"
_LOUT = f"(check_out_time AT TIME ZONE '{SRC_TZ}')"
IS_LATE = (f"(check_in_time IS NOT NULL AND "
           f"(EXTRACT(HOUR FROM {_LIN})*60 + EXTRACT(MINUTE FROM {_LIN})) > {WORK_START_MIN})")
IS_EARLY = (f"(check_out_time IS NOT NULL AND "
            f"(EXTRACT(HOUR FROM {_LOUT})*60 + EXTRACT(MINUTE FROM {_LOUT})) < {WORK_END_MIN})")
IS_OT = f"(hours_worked IS NOT NULL AND hours_worked > {EXPECTED_HOURS})"
IS_UT = f"(COALESCE(is_complete,false) AND hours_worked IS NOT NULL AND hours_worked < {ALLOWABLE_HOURS})"
SHOWED = "attendance_status IN ('Present','Missing Check-Out')"
CIN_LOCAL = f"to_char({_LIN}, 'YYYY-MM-DD\"T\"HH24:MI:SS')"
COUT_LOCAL = f"to_char({_LOUT}, 'YYYY-MM-DD\"T\"HH24:MI:SS')"

# Raw backend roles that may write notes/leaves (map to exec / hr_manager on the
# frontend). Plain store_manager (-> branch_manager) is read-only.
_WRITER_ROLES = {"admin", "exec", "analyst", "manager", "hr"}
# Roles that see ALL branches' notes/leaves (executive + hr_manager). Any other
# permitted HR role (store_manager -> branch_manager) is scoped to its own
# branch only — fail-closed: a branch with no resolvable assignment sees none.
_GLOBAL_VIEW_ROLES = _WRITER_ROLES


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _ex(sql, params=None, fetch=False):
    return A._users_exec(sql, params, fetch=fetch)


def _rows(sql, params=None):
    return _ex(sql, params, fetch=True) or []


def _max_date():
    r = _rows("SELECT MAX(attendance_date) AS d FROM vivo_attendance")
    return r[0]["d"] if r and r[0]["d"] else date.today()


def _filters(qp, allow):
    """Build a WHERE list + params dict for the allowed logical filters.

    allow is an iterable of: country, location, branch, employee.
    """
    cmap = {
        "country": "branch_country",
        "location": "location",
        "branch": "branch_name",
        "employee": "employee_name",
    }
    # A concrete branch fully determines its location (branch_name -> location is
    # 1:1 in vivo_attendance), so an extra location filter is at best redundant
    # and at worst contradictory: e.g. location=Stores AND branch=HQ returns zero
    # rows because HQ's location is "HQ", not "Stores". The frontend injects the
    # active location filter into every request, so when a specific branch is
    # selected we must drop the location filter to avoid an empty result.
    branch_val = (qp.get("branch") or "").strip() if "branch" in allow else ""
    skip_location = bool(branch_val) and branch_val.lower() != "all"
    where, params = [], {}
    for key in allow:
        if key == "location" and skip_location:
            continue
        v = (qp.get(key) or "").strip()
        if v and v.lower() != "all":
            where.append(f"{cmap[key]} = %({key})s")
            params[key] = v
    return where, params


def _range(qp):
    """Resolve date_from/date_to with sensible defaults (last 30 days)."""
    dto = (qp.get("date_to") or "").strip() or str(_max_date())
    dfrom = (qp.get("date_from") or "").strip()
    if not dfrom:
        try:
            dfrom = str(date.fromisoformat(dto) - timedelta(days=30))
        except Exception:
            dfrom = dto
    return dfrom, dto


def _single_date(qp):
    """Snapshot date for overview/branches/alerts: `date` | date_to | max."""
    return ((qp.get("date") or "").strip()
            or (qp.get("date_to") or "").strip()
            or str(_max_date()))


def _fmt_clock(seconds):
    """Format an average time-of-day (seconds since local midnight) as HH:MM."""
    if seconds is None:
        return None
    s = int(round(float(seconds)))
    s %= 24 * 3600
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def _actor(request):
    return A._crm_actor(request)


def _can_write(request):
    _, _, role = _actor(request)
    return role in _WRITER_ROLES


def _user_branch(request):
    """The branch a branch-manager is assigned to, if any. The project's
    `app_users` has no branch column today, so this reads any branch hint the
    auth layer may attach (`branch` / `branch_name` / `branch_assignment`). When
    none is present, a branch-manager is scoped to nothing (fail-closed)."""
    u = getattr(request.state, "user", None) or {}
    for k in ("branch", "branch_name", "branch_assignment"):
        v = (u.get(k) or "").strip() if isinstance(u.get(k), str) else u.get(k)
        if v:
            return v
    return None


def _branch_scope(request):
    """Return (where_fragment, params) restricting notes/leaves to the caller's
    visible branches. Executive/HR-manager roles see all; a branch-manager sees
    only its assigned branch (none when unresolved)."""
    _, _, role = _actor(request)
    if role in _GLOBAL_VIEW_ROLES:
        return None, {}
    b = _user_branch(request)
    if b:
        return "branch_name = %(scope_branch)s", {"scope_branch": b}
    # Branch-manager with no resolvable branch: fail closed (see nothing).
    return "FALSE", {}


# --------------------------------------------------------------------------- #
# Schema                                                                       #
# --------------------------------------------------------------------------- #
def _ensure_hr_tables():
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_notes (
            id              SERIAL PRIMARY KEY,
            employee_name   TEXT,
            branch_name     TEXT,
            user_id         INTEGER,
            note            TEXT NOT NULL,
            flag            BOOLEAN NOT NULL DEFAULT FALSE,
            resolved        BOOLEAN NOT NULL DEFAULT FALSE,
            created_by      TEXT,
            created_by_name TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_leaves (
            id              SERIAL PRIMARY KEY,
            employee_name   TEXT,
            branch_name     TEXT,
            user_id         INTEGER,
            date_from       DATE,
            date_to         DATE,
            leave_type      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            reason          TEXT,
            created_by      TEXT,
            created_by_name TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")


# --------------------------------------------------------------------------- #
# Route registration                                                           #
# --------------------------------------------------------------------------- #
def register_hr_routes(app):
    global A
    import api_pg as _api
    A = _api
    try:
        _ensure_hr_tables()
    except Exception as e:
        A.log.error("HR: table init failed: %s", e)

    # ---------------- Attendance analytics (vivoClient → /api/hr/*) -------- #

    @app.get("/api/hr/overview")
    def hr_overview(request: Request):
        qp = request.query_params
        d = _single_date(qp)
        d0 = str(date.fromisoformat(d) - timedelta(days=ROSTER_DAYS))
        loc_where, params = _filters(qp, ["location"])
        params["d"] = d
        params["d0"] = d0
        loc_sql = (" AND " + " AND ".join(loc_where)) if loc_where else ""

        day = _rows(f"""
            SELECT branch_country,
                   COUNT(*) FILTER (WHERE attendance_status='Present')           AS present,
                   COUNT(*) FILTER (WHERE attendance_status='Missing Check-Out') AS missing_checkout,
                   COUNT(*) FILTER (WHERE {IS_LATE})                             AS late_arrivals,
                   AVG(hours_worked) FILTER (WHERE COALESCE(is_complete,false)
                                             AND hours_worked IS NOT NULL)       AS avg_hours
            FROM vivo_attendance
            WHERE attendance_date = %(d)s{loc_sql}
            GROUP BY branch_country
        """, params)
        roster = _rows(f"""
            SELECT branch_country, COUNT(DISTINCT user_id) AS total_employees
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(d0)s AND %(d)s{loc_sql}
            GROUP BY branch_country
        """, params)
        rmap = {r["branch_country"]: int(r["total_employees"] or 0) for r in roster}

        by_country, t_present, t_missing, t_late, t_emp = [], 0, 0, 0, 0
        for r in day:
            present = int(r["present"] or 0)
            missing = int(r["missing_checkout"] or 0)
            late = int(r["late_arrivals"] or 0)
            emp = rmap.get(r["branch_country"], present + missing)
            showed = present + missing
            absent = max(0, emp - showed)
            by_country.append({
                "branch_country": r["branch_country"],
                "present": present,
                "missing_checkout": missing,
                "absent": absent,
                "late_arrivals": late,
                "total_employees": emp,
                "attendance_rate": round(showed / emp * 100, 1) if emp else 0,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
            })
            t_present += present
            t_missing += missing
            t_late += late
            t_emp += emp

        avg = _rows(f"""
            SELECT AVG(hours_worked) AS a FROM vivo_attendance
            WHERE attendance_date = %(d)s AND COALESCE(is_complete,false)
              AND hours_worked IS NOT NULL{loc_sql}
        """, params)
        avg_h = avg[0]["a"] if avg else None
        showed = t_present + t_missing
        return {
            "totals": {
                "present": t_present,
                "missing_checkout": t_missing,
                "absent": max(0, t_emp - showed),
                "late_arrivals": t_late,
                "total_employees": t_emp,
                "avg_hours_worked": round(float(avg_h), 2) if avg_h is not None else 0,
            },
            "by_country": by_country,
            "date": d,
        }

    @app.get("/api/hr/branches")
    def hr_branches(request: Request):
        qp = request.query_params
        d = _single_date(qp)
        d0 = str(date.fromisoformat(d) - timedelta(days=ROSTER_DAYS))
        loc_where, params = _filters(qp, ["location"])
        params["d"] = d
        params["d0"] = d0
        loc_sql = (" AND " + " AND ".join(loc_where)) if loc_where else ""

        day = _rows(f"""
            SELECT branch_name, branch_country,
                   COUNT(*) FILTER (WHERE attendance_status='Present')           AS present,
                   COUNT(*) FILTER (WHERE attendance_status='Missing Check-Out') AS missing_checkout,
                   COUNT(*) FILTER (WHERE {IS_LATE})                             AS late_arrivals,
                   AVG(hours_worked) FILTER (WHERE COALESCE(is_complete,false)
                                             AND hours_worked IS NOT NULL)       AS avg_hours
            FROM vivo_attendance
            WHERE attendance_date = %(d)s{loc_sql}
            GROUP BY branch_name, branch_country
        """, params)
        roster = _rows(f"""
            SELECT branch_name, COUNT(DISTINCT user_id) AS total_employees
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(d0)s AND %(d)s{loc_sql}
            GROUP BY branch_name
        """, params)
        rmap = {r["branch_name"]: int(r["total_employees"] or 0) for r in roster}
        dev = _rows(f"""
            SELECT DISTINCT ON (branch_name) branch_name, device_status, device_type
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(d0)s AND %(d)s{loc_sql}
            ORDER BY branch_name, device_last_seen DESC NULLS LAST, attendance_date DESC
        """, params)
        dmap = {r["branch_name"]: r for r in dev}

        out = []
        for r in day:
            present = int(r["present"] or 0)
            missing = int(r["missing_checkout"] or 0)
            showed = present + missing
            emp = rmap.get(r["branch_name"], showed)
            absent = max(0, emp - showed)
            rate = round(showed / emp * 100, 1) if emp else 0
            dv = dmap.get(r["branch_name"]) or {}
            dstatus = dv.get("device_status") or "Unknown"
            online = str(dstatus).lower() == "online"
            out.append({
                "branch_name": r["branch_name"],
                "branch_country": r["branch_country"],
                "device_status": dstatus,
                "device_type": dv.get("device_type") or "—",
                "total_employees": emp,
                "present": present,
                "missing_checkout": missing,
                "total_present": showed,
                "total_absent": absent,
                "absent": absent,
                "late_arrivals": int(r["late_arrivals"] or 0),
                "attendance_rate": rate,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
                "status_color": (
                    "offline" if not online else
                    "green" if rate >= 80 else "orange" if rate >= 50 else "red"),
            })
        out.sort(key=lambda x: x["branch_name"])
        return out

    @app.get("/api/hr/branch-rankings")
    def hr_branch_rankings(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""

        rows = _rows(f"""
            WITH base AS (
                SELECT * FROM vivo_attendance
                WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            ),
            opendays AS (
                SELECT branch_name, COUNT(DISTINCT attendance_date) AS open_days
                FROM base GROUP BY branch_name
            )
            SELECT b.branch_name, MAX(b.branch_country) AS branch_country,
                   COUNT(*) FILTER (WHERE b.attendance_status='Present')           AS present,
                   COUNT(*) FILTER (WHERE b.attendance_status='Missing Check-Out') AS missing_checkout,
                   COUNT(*) FILTER (WHERE {IS_LATE.replace('check_in_time','b.check_in_time')}) AS late_arrivals,
                   COUNT(DISTINCT b.user_id) AS total_employees,
                   AVG(b.hours_worked) FILTER (WHERE COALESCE(b.is_complete,false)
                                               AND b.hours_worked IS NOT NULL)     AS avg_hours,
                   MAX(o.open_days) AS open_days
            FROM base b JOIN opendays o ON o.branch_name=b.branch_name
            GROUP BY b.branch_name
        """, params)

        out = []
        for r in rows:
            present = int(r["present"] or 0)
            missing = int(r["missing_checkout"] or 0)
            showed = present + missing
            emp = int(r["total_employees"] or 0)
            open_days = int(r["open_days"] or 0)
            expected = emp * open_days
            absent = max(0, expected - showed)
            rate = round(showed / expected * 100, 1) if expected else 0
            out.append({
                "branch_name": r["branch_name"],
                "branch_country": r["branch_country"],
                "device_status": "—",
                "device_type": "—",
                "total_employees": emp,
                "present": present,
                "missing_checkout": missing,
                "total_present": showed,
                "total_absent": absent,
                "absent": absent,
                "late_arrivals": int(r["late_arrivals"] or 0),
                "attendance_rate": rate,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
                "status_color": "green" if rate >= 80 else "orange" if rate >= 50 else "red",
            })
        out.sort(key=lambda x: x["attendance_rate"], reverse=True)
        return out

    @app.get("/api/hr/branch-detail")
    def hr_branch_detail(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["location", "branch"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            SELECT attendance_date::text AS attendance_date, employee_name, user_id,
                   branch_name, branch_country,
                   {CIN_LOCAL}  AS check_in_time,
                   {COUT_LOCAL} AS check_out_time,
                   hours_worked, attendance_status,
                   {IS_LATE}  AS is_late,
                   {IS_EARLY} AS is_early_departure,
                   {IS_OT}    AS is_overtime,
                   {IS_UT}    AS is_undertime,
                   COALESCE(is_complete,false) AS is_complete
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            ORDER BY attendance_date DESC, employee_name
            LIMIT 5000
        """, params)
        for r in rows:
            if r["hours_worked"] is not None:
                r["hours_worked"] = round(float(r["hours_worked"]), 2)
        return rows

    @app.get("/api/hr/employee-summary")
    def hr_employee_summary(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["location", "branch"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            WITH base AS (
                SELECT * FROM vivo_attendance
                WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            ),
            opendays AS (
                SELECT branch_name, COUNT(DISTINCT attendance_date) AS open_days
                FROM base GROUP BY branch_name
            )
            SELECT b.employee_name, b.user_id, b.branch_name,
                   MAX(b.branch_country) AS branch_country,
                   COUNT(DISTINCT b.attendance_date) AS days_present,
                   MAX(o.open_days) AS total_days,
                   AVG(b.hours_worked) FILTER (WHERE COALESCE(b.is_complete,false)
                                               AND b.hours_worked IS NOT NULL) AS avg_hours
            FROM base b JOIN opendays o ON o.branch_name=b.branch_name
            GROUP BY b.employee_name, b.user_id, b.branch_name
            ORDER BY b.employee_name
        """, params)
        out = []
        for r in rows:
            present = int(r["days_present"] or 0)
            total = int(r["total_days"] or 0)
            absent = max(0, total - present)
            out.append({
                "employee_name": r["employee_name"],
                "user_id": r["user_id"],
                "branch_name": r["branch_name"],
                "branch_country": r["branch_country"],
                "attendance_rate": round(present / total * 100, 1) if total else 0,
                "days_present": present,
                "days_absent": absent,
                "total_days": total,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
            })
        return out

    @app.get("/api/hr/employee-detail")
    def hr_employee_detail(request: Request):
        qp = request.query_params
        emp = (qp.get("employee") or "").strip()
        if not emp:
            return []
        dfrom, dto = _range(qp)
        rows = _rows(f"""
            SELECT attendance_date::text AS attendance_date,
                   {CIN_LOCAL}  AS check_in_time,
                   {COUT_LOCAL} AS check_out_time,
                   hours_worked, attendance_status,
                   {IS_LATE}  AS is_late,
                   {IS_EARLY} AS is_early_departure,
                   {IS_OT}    AS is_overtime,
                   {IS_UT}    AS is_undertime,
                   COALESCE(is_complete,false) AS is_complete
            FROM vivo_attendance
            WHERE employee_name = %(emp)s AND attendance_date BETWEEN %(df)s AND %(dt)s
            ORDER BY attendance_date
        """, {"emp": emp, "df": dfrom, "dt": dto})
        for r in rows:
            if r["hours_worked"] is not None:
                r["hours_worked"] = round(float(r["hours_worked"]), 2)
        return rows

    @app.get("/api/hr/employee-search")
    def hr_employee_search(request: Request):
        qp = request.query_params
        q = (qp.get("q") or "").strip()
        if len(q) < 2:
            return []
        dto = _max_date()
        dfrom = dto - timedelta(days=90)
        rows = _rows(f"""
            WITH base AS (
                SELECT * FROM vivo_attendance
                WHERE attendance_date BETWEEN %(df)s AND %(dt)s
                  AND employee_name ILIKE %(q)s
            ),
            opendays AS (
                SELECT branch_name, COUNT(DISTINCT attendance_date) AS open_days
                FROM vivo_attendance
                WHERE attendance_date BETWEEN %(df)s AND %(dt)s
                GROUP BY branch_name
            )
            SELECT b.employee_name, b.user_id, b.branch_name,
                   MAX(b.branch_country) AS branch_country,
                   COUNT(DISTINCT b.attendance_date) AS days_present,
                   MAX(o.open_days) AS total_days,
                   AVG(b.hours_worked) FILTER (WHERE COALESCE(b.is_complete,false)
                                               AND b.hours_worked IS NOT NULL) AS avg_hours
            FROM base b LEFT JOIN opendays o ON o.branch_name=b.branch_name
            GROUP BY b.employee_name, b.user_id, b.branch_name
            ORDER BY b.employee_name
            LIMIT 50
        """, {"q": f"%{q}%", "df": str(dfrom), "dt": str(dto)})
        out = []
        for r in rows:
            present = int(r["days_present"] or 0)
            total = int(r["total_days"] or 0)
            out.append({
                "employee_name": r["employee_name"],
                "user_id": r["user_id"],
                "branch_name": r["branch_name"],
                "branch_country": r["branch_country"],
                "attendance_rate": round(present / total * 100, 1) if total else 0,
                "days_present": present,
                "total_days": total,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
            })
        return out

    @app.get("/api/hr/trends")
    def hr_trends(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        daily = _rows(f"""
            SELECT attendance_date::text AS attendance_date, branch_country,
                   COUNT(*) FILTER (WHERE {SHOWED})  AS present,
                   COUNT(*) FILTER (WHERE {IS_LATE}) AS late_arrivals
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            GROUP BY attendance_date, branch_country
            ORDER BY attendance_date
        """, params)
        roster = _rows(f"""
            SELECT branch_country, COUNT(DISTINCT user_id) AS total_employees
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            GROUP BY branch_country
        """, params)
        rmap = {r["branch_country"]: int(r["total_employees"] or 0) for r in roster}
        out = []
        for r in daily:
            present = int(r["present"] or 0)
            emp = rmap.get(r["branch_country"], present)
            out.append({
                "attendance_date": r["attendance_date"],
                "branch_country": r["branch_country"],
                "present": present,
                "absent": max(0, emp - present),
                "late_arrivals": int(r["late_arrivals"] or 0),
                "total_employees": emp,
                "attendance_rate": round(present / emp * 100, 1) if emp else 0,
            })
        return out

    @app.get("/api/hr/dow-analysis")
    def hr_dow_analysis(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        roster = _rows(f"""
            SELECT COUNT(DISTINCT user_id) AS e FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
        """, params)
        emp = int(roster[0]["e"] or 0) if roster else 0
        rows = _rows(f"""
            SELECT EXTRACT(DOW FROM attendance_date)::int AS dow_num,
                   TRIM(to_char(attendance_date, 'Day'))  AS day_of_week,
                   COUNT(*) FILTER (WHERE {SHOWED})        AS showed,
                   COUNT(DISTINCT attendance_date)         AS open_days,
                   AVG(hours_worked) FILTER (WHERE COALESCE(is_complete,false)
                                             AND hours_worked IS NOT NULL) AS avg_hours
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            GROUP BY 1,2 ORDER BY 1
        """, params)
        out = []
        for r in rows:
            showed = int(r["showed"] or 0)
            open_days = int(r["open_days"] or 0)
            expected = emp * open_days
            out.append({
                "day_of_week": r["day_of_week"],
                "dow_num": int(r["dow_num"]),
                "attendance_rate": round(showed / expected * 100, 1) if expected else 0,
                "avg_hours": round(float(r["avg_hours"]), 2) if r["avg_hours"] is not None else 0,
            })
        return out

    @app.get("/api/hr/hours-lost")
    def hr_hours_lost(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location", "branch"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            SELECT employee_name, branch_name, MAX(location) AS location,
                   MAX(branch_country) AS branch_country,
                   COUNT(DISTINCT attendance_date) AS total_days_present,
                   SUM(hours_worked) FILTER (WHERE hours_worked IS NOT NULL) AS total_actual_hours
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s AND {SHOWED}{wsql}
            GROUP BY employee_name, branch_name
        """, params)
        out = []
        for r in rows:
            days = int(r["total_days_present"] or 0)
            actual = float(r["total_actual_hours"] or 0)
            expected = days * EXPECTED_HOURS
            allowable = days * ALLOWABLE_HOURS
            lost = max(0.0, allowable - actual)
            eff = round(actual / expected * 100, 1) if expected else 0
            cat = ("None" if lost <= 0 else
                   "Low" if lost < 10 else "Medium" if lost < 40 else "High")
            out.append({
                "employee_name": r["employee_name"],
                "branch_name": r["branch_name"],
                "location": r["location"],
                "branch_country": r["branch_country"],
                "total_days_present": days,
                "total_expected_hours": round(expected, 1),
                "total_actual_hours": round(actual, 1),
                "total_allowable_hours": round(allowable, 1),
                "total_hours_lost": round(lost, 1),
                "efficiency_pct": eff,
                "loss_category": cat,
            })
        out.sort(key=lambda x: x["total_hours_lost"], reverse=True)
        return out

    @app.get("/api/hr/heatmap")
    def hr_heatmap(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        roster = _rows(f"""
            SELECT branch_name, COUNT(DISTINCT user_id) AS e FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            GROUP BY branch_name
        """, params)
        rmap = {r["branch_name"]: int(r["e"] or 0) for r in roster}
        rows = _rows(f"""
            SELECT attendance_date::text AS attendance_date, branch_name,
                   MAX(location) AS location, MAX(branch_country) AS branch_country,
                   COUNT(*) FILTER (WHERE {SHOWED}) AS showed
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            GROUP BY attendance_date, branch_name
            ORDER BY attendance_date
        """, params)
        out = []
        for r in rows:
            showed = int(r["showed"] or 0)
            emp = rmap.get(r["branch_name"], showed)
            out.append({
                "attendance_date": r["attendance_date"],
                "branch_name": r["branch_name"],
                "location": r["location"],
                "branch_country": r["branch_country"],
                "attendance_rate": round(showed / emp * 100, 1) if emp else 0,
            })
        return out

    @app.get("/api/hr/days-worked")
    def hr_days_worked(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["country", "location", "branch", "employee"])
        params["df"] = dfrom
        params["dt"] = dto
        wsql = (" AND " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            WITH base AS (
                SELECT * FROM vivo_attendance
                WHERE attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            ),
            opendays AS (
                SELECT branch_name, COUNT(DISTINCT attendance_date) AS open_days
                FROM base GROUP BY branch_name
            )
            SELECT b.employee_name, b.branch_name, MAX(b.location) AS location,
                   MAX(b.branch_country) AS branch_country,
                   COUNT(*) AS total_days_recorded,
                   COUNT(*) FILTER (WHERE b.attendance_status='Present')           AS days_present,
                   COUNT(*) FILTER (WHERE b.attendance_status='Missing Check-Out') AS days_missing_checkout,
                   MAX(o.open_days) AS open_days,
                   SUM(b.hours_worked) FILTER (WHERE b.hours_worked IS NOT NULL)   AS total_hours_worked,
                   AVG(b.hours_worked) FILTER (WHERE COALESCE(b.is_complete,false)
                                               AND b.hours_worked IS NOT NULL)     AS avg_hours_per_day,
                   AVG(EXTRACT(EPOCH FROM ({_LIN})::time))  AS avg_in_sec,
                   AVG(EXTRACT(EPOCH FROM ({_LOUT})::time)) FILTER (WHERE check_out_time IS NOT NULL) AS avg_out_sec,
                   COUNT(*) FILTER (WHERE {IS_LATE.replace('check_in_time','b.check_in_time')}) AS days_late,
                   COUNT(*) FILTER (WHERE b.hours_worked > {EXPECTED_HOURS})        AS days_overtime,
                   COUNT(*) FILTER (WHERE COALESCE(b.is_complete,false)
                                    AND b.hours_worked < {ALLOWABLE_HOURS})         AS days_undertime
            FROM base b JOIN opendays o ON o.branch_name=b.branch_name
            GROUP BY b.employee_name, b.branch_name
            ORDER BY b.employee_name
        """, params)
        out = []
        for r in rows:
            recorded = int(r["total_days_recorded"] or 0)
            open_days = int(r["open_days"] or 0)
            out.append({
                "employee_name": r["employee_name"],
                "branch_name": r["branch_name"],
                "location": r["location"],
                "branch_country": r["branch_country"],
                "total_days_recorded": recorded,
                "days_present": int(r["days_present"] or 0),
                "days_missing_checkout": int(r["days_missing_checkout"] or 0),
                "days_absent": max(0, open_days - recorded),
                "total_hours_worked": round(float(r["total_hours_worked"]), 1) if r["total_hours_worked"] is not None else 0,
                "avg_hours_per_day": round(float(r["avg_hours_per_day"]), 2) if r["avg_hours_per_day"] is not None else 0,
                "avg_check_in_time": _fmt_clock(r["avg_in_sec"]),
                "avg_check_out_time": _fmt_clock(r["avg_out_sec"]),
                "days_late": int(r["days_late"] or 0),
                "days_overtime": int(r["days_overtime"] or 0),
                "days_undertime": int(r["days_undertime"] or 0),
            })
        return out

    @app.get("/api/hr/alerts")
    def hr_alerts(request: Request):
        qp = request.query_params
        d = _single_date(qp)
        d0 = str(date.fromisoformat(d) - timedelta(days=ROSTER_DAYS))
        where, params = _filters(qp, ["country", "location"])
        params["d"] = d
        params["d0"] = d0
        wsql = (" AND " + " AND ".join(where)) if where else ""

        # Missing check-out on the snapshot day.
        mco = _rows(f"""
            SELECT employee_name, branch_name, branch_country,
                   attendance_date::text AS attendance_date,
                   {CIN_LOCAL} AS check_in_time
            FROM vivo_attendance
            WHERE attendance_date = %(d)s AND attendance_status='Missing Check-Out'{wsql}
            ORDER BY branch_name, employee_name
        """, params)
        missing = [{**r, "attendance_status": "Missing Check-Out"} for r in mco]

        # Absent (missing check-in): rostered employees with no record that day.
        absent = _rows(f"""
            SELECT DISTINCT r.employee_name, r.branch_name, r.branch_country
            FROM (
                SELECT DISTINCT user_id, employee_name, branch_name, branch_country
                FROM vivo_attendance
                WHERE attendance_date BETWEEN %(d0)s AND %(d)s{wsql}
            ) r
            WHERE NOT EXISTS (
                SELECT 1 FROM vivo_attendance a
                WHERE a.user_id=r.user_id AND a.branch_name=r.branch_name
                  AND a.attendance_date=%(d)s
            )
            ORDER BY r.branch_name, r.employee_name
        """, params)
        for r in absent:
            missing.append({**r, "attendance_date": d,
                            "check_in_time": None, "attendance_status": "Absent"})

        # Offline devices: latest device row per branch not online.
        dev = _rows(f"""
            SELECT DISTINCT ON (branch_name) branch_name, branch_country, device_type,
                   COALESCE(device_fail_count,0) AS fail_count,
                   to_char(device_last_seen AT TIME ZONE '{SRC_TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS last_seen,
                   device_status
            FROM vivo_attendance
            WHERE attendance_date BETWEEN %(d0)s AND %(d)s{wsql}
            ORDER BY branch_name, device_last_seen DESC NULLS LAST, attendance_date DESC
        """, params)
        offline = [{"branch_name": r["branch_name"], "branch_country": r["branch_country"],
                    "device_type": r["device_type"], "fail_count": int(r["fail_count"] or 0),
                    "last_seen": r["last_seen"]}
                   for r in dev if str(r.get("device_status") or "").lower() != "online"]

        # Consecutive absences: walk each branch's open days backward from the
        # snapshot date, counting trailing days an active employee missed.
        consec = _consecutive_absences(d, d0, wsql, params)

        return {
            "missing_checkout_absent": missing,
            "consecutive_absences": consec,
            "offline_devices": offline,
        }

    # ---------------- Notes (apiClient → /api/notes) ---------------------- #

    @app.get("/api/hr/notes")
    def hr_notes_list(request: Request):
        qp = request.query_params
        where, params = [], {}
        if (qp.get("flagged_only") or "").lower() in ("1", "true", "yes"):
            where.append("flag = TRUE")
        emp = (qp.get("employee_name") or "").strip()
        if emp:
            where.append("employee_name = %(emp)s")
            params["emp"] = emp
        scope_sql, scope_params = _branch_scope(request)
        if scope_sql:
            where.append(scope_sql)
            params.update(scope_params)
        wsql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            SELECT id, employee_name, branch_name, user_id, note, flag, resolved,
                   created_by_name,
                   to_char(created_at AT TIME ZONE '{TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
            FROM hr_notes{wsql}
            ORDER BY created_at DESC LIMIT 500
        """, params)
        return rows

    @app.post("/api/hr/notes")
    async def hr_notes_create(request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        note = (body.get("note") or "").strip()
        if not note:
            return JSONResponse({"detail": "note is required"}, status_code=400)
        uid, name, _ = _actor(request)
        rows = _rows("""
            INSERT INTO hr_notes (employee_name, branch_name, user_id, note, flag,
                                  created_by, created_by_name)
            VALUES (%(en)s,%(bn)s,%(ui)s,%(note)s,%(flag)s,%(cb)s,%(cbn)s)
            RETURNING id
        """, {"en": body.get("employee_name"), "bn": body.get("branch_name"),
              "ui": body.get("user_id"), "note": note,
              "flag": bool(body.get("flag")), "cb": uid, "cbn": name})
        nid = rows[0]["id"] if rows else None
        A._crm_audit("hr_note", nid, "create", note[:200], request)
        return {"ok": True, "id": nid}

    @app.put("/api/hr/notes/{note_id}")
    async def hr_notes_update(note_id: int, request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        sets, params = [], {"id": note_id}
        if "note" in body:
            note = (body.get("note") or "").strip()
            if not note:
                return JSONResponse({"detail": "note cannot be empty"}, status_code=400)
            sets.append("note = %(note)s")
            params["note"] = note
        if "flag" in body:
            sets.append("flag = %(flag)s")
            params["flag"] = bool(body.get("flag"))
        if "resolved" in body:
            sets.append("resolved = %(resolved)s")
            params["resolved"] = bool(body.get("resolved"))
        if not sets:
            return JSONResponse({"detail": "no updatable fields supplied"}, status_code=400)
        rows = _rows(f"UPDATE hr_notes SET {', '.join(sets)} WHERE id=%(id)s RETURNING id", params)
        if not rows:
            return JSONResponse({"detail": "note not found"}, status_code=404)
        A._crm_audit("hr_note", note_id, "update", ",".join(sets), request)
        return {"ok": True, "id": note_id}

    @app.delete("/api/hr/notes/{note_id}")
    def hr_notes_delete(note_id: int, request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        _ex("DELETE FROM hr_notes WHERE id=%(id)s", {"id": note_id})
        A._crm_audit("hr_note", note_id, "delete", "", request)
        return {"ok": True}

    # ---------------- Leaves (apiClient → /api/leaves) -------------------- #

    @app.get("/api/hr/leaves")
    def hr_leaves_list(request: Request):
        scope_sql, scope_params = _branch_scope(request)
        wsql = (" WHERE " + scope_sql) if scope_sql else ""
        rows = _rows(f"""
            SELECT id, employee_name, branch_name, user_id,
                   date_from::text AS date_from, date_to::text AS date_to,
                   leave_type, status, reason, created_by_name,
                   to_char(created_at AT TIME ZONE '{TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
            FROM hr_leaves{wsql}
            ORDER BY created_at DESC LIMIT 500
        """, scope_params)
        return rows

    @app.post("/api/hr/leaves")
    async def hr_leaves_create(request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        uid, name, _ = _actor(request)
        status = (body.get("status") or "pending").strip().lower()
        rows = _rows("""
            INSERT INTO hr_leaves (employee_name, branch_name, user_id, date_from,
                                   date_to, leave_type, status, reason,
                                   created_by, created_by_name)
            VALUES (%(en)s,%(bn)s,%(ui)s,%(df)s,%(dt)s,%(lt)s,%(st)s,%(rs)s,%(cb)s,%(cbn)s)
            RETURNING id
        """, {"en": body.get("employee_name"), "bn": body.get("branch_name"),
              "ui": body.get("user_id"), "df": body.get("date_from") or None,
              "dt": body.get("date_to") or None, "lt": body.get("leave_type"),
              "st": status, "rs": body.get("reason"), "cb": uid, "cbn": name})
        lid = rows[0]["id"] if rows else None
        A._crm_audit("hr_leave", lid, "create", str(body.get("leave_type") or ""), request)
        return {"ok": True, "id": lid}

    @app.put("/api/hr/leaves/{leave_id}")
    async def hr_leaves_update(leave_id: int, request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        status = (body.get("status") or "").strip().lower()
        if status not in ("approved", "pending", "rejected"):
            return JSONResponse({"detail": "status must be approved|pending|rejected"}, status_code=400)
        _ex("UPDATE hr_leaves SET status=%(st)s WHERE id=%(id)s", {"st": status, "id": leave_id})
        A._crm_audit("hr_leave", leave_id, "status", status, request)
        return {"ok": True}

    @app.delete("/api/hr/leaves/{leave_id}")
    def hr_leaves_delete(leave_id: int, request: Request):
        if not _can_write(request):
            return JSONResponse({"detail": "Write access requires an HR or executive role"}, status_code=403)
        _ex("DELETE FROM hr_leaves WHERE id=%(id)s", {"id": leave_id})
        A._crm_audit("hr_leave", leave_id, "delete", "", request)
        return {"ok": True}

    A.log.info("HR attendance routes registered")


def _consecutive_absences(d, d0, wsql, params, threshold=3):
    """For each active employee, count trailing branch-open-days (from the
    snapshot date backward, within the roster window) on which they were absent.
    Returns rows with >= threshold consecutive missed days."""
    open_rows = _rows(f"""
        SELECT branch_name, attendance_date
        FROM vivo_attendance
        WHERE attendance_date BETWEEN %(d0)s AND %(d)s{wsql}
        GROUP BY branch_name, attendance_date
        ORDER BY branch_name, attendance_date DESC
    """, params)
    branch_days = {}
    for r in open_rows:
        branch_days.setdefault(r["branch_name"], []).append(r["attendance_date"])

    present_rows = _rows(f"""
        SELECT DISTINCT user_id, branch_name, attendance_date
        FROM vivo_attendance
        WHERE attendance_date BETWEEN %(d0)s AND %(d)s{wsql}
    """, params)
    present = set((r["user_id"], r["branch_name"], r["attendance_date"]) for r in present_rows)

    emp_rows = _rows(f"""
        SELECT DISTINCT ON (user_id, branch_name)
               user_id, branch_name, employee_name, branch_country
        FROM vivo_attendance
        WHERE attendance_date BETWEEN %(d0)s AND %(d)s{wsql}
        ORDER BY user_id, branch_name, attendance_date DESC
    """, params)

    out = []
    for e in emp_rows:
        days = branch_days.get(e["branch_name"], [])
        run = 0
        last_absent = None
        for day in days:  # already newest-first
            if (e["user_id"], e["branch_name"], day) in present:
                break
            run += 1
            if last_absent is None:
                last_absent = day
        if run >= threshold:
            out.append({
                "employee_name": e["employee_name"],
                "branch_name": e["branch_name"],
                "branch_country": e["branch_country"],
                "consecutive_days": run,
                "last_absent_date": str(last_absent) if last_absent else None,
            })
    out.sort(key=lambda x: x["consecutive_days"], reverse=True)
    return out[:200]
