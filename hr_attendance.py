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

import difflib
import json
import os
import re
from datetime import date, datetime, timedelta

import requests
from fastapi import Request
from fastapi.responses import JSONResponse

# Google Sheet that backs the Staff Training surface (3 tabs: Training
# Registration / List of Staff / Training Targets). Synced into Postgres
# (hr_training*) via the Replit Google Sheets connector — see _sync_training().
TRAINING_SHEET_ID = "1K_cGADA67ymxruhcti5YvEY36qm7b1lbFNo65py20e4"

# Set in register_hr_routes() to the fully-loaded api_pg module. Routes only
# dereference it at request time, by which point it is populated.
A = None

# --- Derivation parameters (a standard 08:00-17:00, 9h work day) ----------- #
TZ = "Africa/Nairobi"     # for genuine-UTC app timestamps (note/leave created_at)
# Device/source timestamps (check_in_time, check_out_time, device_last_seen) are
# EAT wall-clock stored mislabeled as +00 (see module docstring). Reading them at
# 'UTC' returns that wall-clock as-is = the real East-Africa time. Do NOT use TZ
# here or you double-shift by +3h.
SRC_TZ = "UTC"
WORK_START_MIN = 8 * 60   # 08:00 — arrivals after this are "late"
WORK_END_MIN = 17 * 60    # 17:00 — departures before this are "early"
EXPECTED_HOURS = 9.0      # full scheduled day (08:00–17:00 = 9h)
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

# Department groups that may write notes/leaves (executive / HR-manager view).
# Plain store_manager (-> branch_manager) is read-only.
_WRITER_ROLES = {"admin", "leadership", "hr"}
# Roles that see ALL branches' notes/leaves (executive + HR-manager + retail
# oversight). Any other permitted HR role (store_manager -> branch_manager) is
# scoped to its own branch only — fail-closed: a branch with no resolvable
# assignment sees none.
_GLOBAL_VIEW_ROLES = {"admin", "leadership", "retail", "hr"}


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
# Google Sheets connector + training-sheet parsing                            #
# --------------------------------------------------------------------------- #
def _connector_access_token(connector="google-sheet"):
    """Fetch a live OAuth access token for a Replit-managed connector via the
    connectors proxy. Works both in the workspace (REPL_IDENTITY) and in a
    published deployment (WEB_REPL_RENEWAL)."""
    hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME")
    if not hostname:
        raise RuntimeError("connectors host unavailable")
    repl_identity = os.environ.get("REPL_IDENTITY")
    web_renewal = os.environ.get("WEB_REPL_RENEWAL")
    if repl_identity:
        xtok = "repl " + repl_identity
    elif web_renewal:
        xtok = "depl " + web_renewal
    else:
        raise RuntimeError("no repl identity token available")
    r = requests.get(
        f"https://{hostname}/api/v2/connection",
        params={"include_secrets": "true", "connector_names": connector},
        headers={"Accept": "application/json", "X_REPLIT_TOKEN": xtok},
        timeout=20,
    )
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    if not items:
        raise RuntimeError(f"no '{connector}' connection configured")
    s = items[0].get("settings") or {}
    tok = (s.get("access_token")
           or (((s.get("oauth") or {}).get("credentials") or {}).get("access_token")))
    if not tok:
        raise RuntimeError("connection has no access token")
    return tok


def _gsheet_values(sheet_id, tab, rng="A1:R5000"):
    """Read a tab's cell matrix from the Google Sheets v4 API."""
    tok = _connector_access_token("google-sheet")
    range_q = requests.utils.quote(f"{tab}!{rng}", safe="")
    r = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{range_q}",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    r.raise_for_status()
    return (r.json() or {}).get("values") or []


def _t_clean(v):
    return v.strip() if isinstance(v, str) else ("" if v is None else str(v).strip())


def _parse_tdate(s):
    """Parse the varied sheet date strings (e.g. 9-Mar-26, 31-March-2026)."""
    s = _t_clean(s)
    if not s:
        return None
    for fmt in ("%d-%b-%y", "%d-%b-%Y", "%d-%B-%Y", "%d-%B-%y",
                "%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_dur_sec(s):
    """Parse a duration string to seconds. Handles H:MM:SS, HH:MM and bare mins,
    tolerating a trailing am/pm token."""
    s = _t_clean(s)
    if not s:
        return None
    s2 = re.sub(r"\s*[ap]\.?m\.?\s*$", "", s, flags=re.I).strip()
    parts = s2.split(":")
    try:
        nums = [int(float(p)) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, m, sec = nums
    elif len(nums) == 2:
        h, m, sec = nums[0], nums[1], 0
    elif len(nums) == 1:
        h, m, sec = 0, nums[0], 0
    else:
        return None
    return h * 3600 + m * 60 + sec


def _parse_money(s):
    s = _t_clean(s)
    if not s:
        return None
    d = re.sub(r"[^0-9.\-]", "", s)
    if d in ("", "-", ".", "-."):
        return None
    try:
        return float(d)
    except ValueError:
        return None


def _ensure_training_tables():
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_training (
            id                SERIAL PRIMARY KEY,
            training_date     DATE,
            employee_code     TEXT,
            employee_name     TEXT,
            department        TEXT,
            team              TEXT,
            designation       TEXT,
            training_name     TEXT,
            category          TEXT,
            delivery_method   TEXT,
            start_time        TEXT,
            stop_time         TEXT,
            time_taken_sec    INTEGER,
            expected_sec      INTEGER,
            lateness_sec      INTEGER,
            training_location TEXT,
            facilitator       TEXT,
            co_facilitator    TEXT,
            actual_budget     NUMERIC
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_training_target (
            id            SERIAL PRIMARY KEY,
            training_area TEXT,
            target_count  NUMERIC,
            target_date   DATE,
            expected_time TEXT,
            audience      TEXT,
            week_of_year  TEXT
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_training_staff (
            pii         TEXT,
            name        TEXT,
            department  TEXT,
            team        TEXT,
            designation TEXT,
            gender      TEXT
        )
    """)
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_training_sync (
            id             INTEGER PRIMARY KEY DEFAULT 1,
            last_synced_at TIMESTAMPTZ,
            trainings      INTEGER,
            staff          INTEGER,
            targets        INTEGER,
            CHECK (id = 1)
        )
    """)


def _sync_training():
    """Pull all 3 tabs from the training Google Sheet and rebuild the hr_training*
    tables (TRUNCATE + insert in one transaction). Returns the row counts."""
    _ensure_training_tables()
    reg = _gsheet_values(TRAINING_SHEET_ID, "Training Registration")
    staff = _gsheet_values(TRAINING_SHEET_ID, "List of Staff")
    targets = _gsheet_values(TRAINING_SHEET_ID, "Training Targets")

    def body(rows):
        return rows[1:] if rows and len(rows) > 1 else []

    n_t = n_s = n_g = 0
    with A._users_tx() as cur:
        cur.execute("TRUNCATE hr_training")
        for raw in body(reg):
            r = (list(raw) + [""] * 18)[:18]
            (d, code, name, dept, team, desig, tname, cat, deliv, st, sp,
             taken, exp, late, loc, fac, cofac, bud) = r
            if not (_t_clean(name) or _t_clean(tname)):
                continue
            cur.execute(
                """INSERT INTO hr_training
                   (training_date, employee_code, employee_name, department, team,
                    designation, training_name, category, delivery_method,
                    start_time, stop_time, time_taken_sec, expected_sec,
                    lateness_sec, training_location, facilitator, co_facilitator,
                    actual_budget)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (_parse_tdate(d), _t_clean(code), _t_clean(name), _t_clean(dept),
                 _t_clean(team), _t_clean(desig), _t_clean(tname), _t_clean(cat),
                 _t_clean(deliv), _t_clean(st), _t_clean(sp), _parse_dur_sec(taken),
                 _parse_dur_sec(exp), _parse_dur_sec(late), _t_clean(loc),
                 _t_clean(fac), _t_clean(cofac), _parse_money(bud)),
            )
            n_t += 1
        cur.execute("TRUNCATE hr_training_staff")
        for raw in body(staff):
            r = (list(raw) + [""] * 6)[:6]
            pii, nm, dept, team, desig, gender = r
            if not _t_clean(nm):
                continue
            cur.execute(
                """INSERT INTO hr_training_staff
                   (pii, name, department, team, designation, gender)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (_t_clean(pii), _t_clean(nm), _t_clean(dept), _t_clean(team),
                 _t_clean(desig), _t_clean(gender)),
            )
            n_s += 1
        cur.execute("TRUNCATE hr_training_target")
        for raw in body(targets):
            r = (list(raw) + [""] * 6)[:6]
            area, tgt, dt, exptime, audience, week = r
            if not _t_clean(area):
                continue
            cur.execute(
                """INSERT INTO hr_training_target
                   (training_area, target_count, target_date, expected_time,
                    audience, week_of_year)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (_t_clean(area), _parse_money(tgt), _parse_tdate(dt),
                 _t_clean(exptime), _t_clean(audience), _t_clean(week)),
            )
            n_g += 1
        cur.execute(
            """INSERT INTO hr_training_sync (id, last_synced_at, trainings, staff, targets)
               VALUES (1, now(), %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET
                 last_synced_at = EXCLUDED.last_synced_at,
                 trainings = EXCLUDED.trainings,
                 staff = EXCLUDED.staff,
                 targets = EXCLUDED.targets""",
            (n_t, n_s, n_g),
        )
    return {"trainings": n_t, "staff": n_s, "targets": n_g}


def _training_autosync():
    """Populate the training tables from the sheet if they are still empty.
    Best-effort: never raises, so a missing connector just yields empty data."""
    try:
        _ensure_training_tables()
        r = _rows("SELECT COUNT(*) AS n FROM hr_training")
        if r and int(r[0]["n"] or 0) > 0:
            return
        _sync_training()
    except Exception:
        pass


# Filter WHERE builder shared by every training read endpoint.
def _training_where(qp):
    where, params = ["1=1"], {}
    df = (qp.get("date_from") or "").strip()
    dt = (qp.get("date_to") or "").strip()
    if df:
        where.append("training_date >= %(df)s")
        params["df"] = df
    if dt:
        where.append("training_date <= %(dt)s")
        params["dt"] = dt
    for key, col in (("category", "category"), ("training_name", "training_name"),
                     ("department", "department"), ("delivery_method", "delivery_method"),
                     ("location", "training_location")):
        v = (qp.get(key) or "").strip()
        if v and v.lower() != "all":
            where.append(f"{col} = %({key})s")
            params[key] = v
    return " AND ".join(where), params


# Distinct training "session" event key (one delivery = date + location + name).
_SESSION_EXPR = ("(COALESCE(training_date::text,'') || '|' || "
                 "COALESCE(training_location,'') || '|' || COALESCE(training_name,''))")


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
    # Authoritative employee roster imported from the company Google Sheet
    # ("Replit Data" — one tab per entity). Only Vivo Kenya carries
    # department/team; Rwanda/Uganda carry job_title; Shop Zetu name only.
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_employees (
            id              SERIAL PRIMARY KEY,
            employee_id     TEXT,           -- PII / Staff No from the sheet
            entity          TEXT NOT NULL,  -- tab: Vivo Kenya | Shop Zetu | Vivo Rwanda | Vivo Uganda
            country         TEXT,           -- Kenya | Rwanda | Uganda
            name            TEXT NOT NULL,
            name_norm       TEXT,           -- normalized for name matching
            department      TEXT,
            team            TEXT,
            job_title       TEXT,
            source          TEXT NOT NULL DEFAULT 'google_sheet',
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (entity, employee_id)
        )""")
    _ex("CREATE INDEX IF NOT EXISTS ix_hr_employees_name_norm ON hr_employees(name_norm)")
    # Resolved link from a (messy) distinct vivo_attendance.employee_name to a
    # roster row. employee_id NULL = could not be matched. match_method:
    # exact | token | fuzzy | ai | none.
    _ex("""
        CREATE TABLE IF NOT EXISTS hr_employee_match (
            employee_name   TEXT PRIMARY KEY,  -- raw distinct attendance name
            employee_id     INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL,
            name_norm       TEXT,
            match_method    TEXT NOT NULL DEFAULT 'none',
            confidence      REAL NOT NULL DEFAULT 0,
            matched_name    TEXT,              -- roster name it resolved to (debug/display)
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    _ex("CREATE INDEX IF NOT EXISTS ix_hr_employee_match_eid ON hr_employee_match(employee_id)")


# --------------------------------------------------------------------------- #
# Roster name matching (attendance employee_name -> hr_employees)              #
# --------------------------------------------------------------------------- #
# Obvious non-employee tokens that biometric devices leave behind.
_EMP_JUNK = {"unknown employee", "unknown", "test", "admin", "user", "n a", "na"}


def _emp_norm(name):
    """Normalize a name for matching: lowercase, strip punctuation, collapse
    whitespace. (Does not insert spaces, so 'MaryMACHARIA' stays one token —
    that gap is what the fuzzy/AI pass is for.)"""
    s = (name or "").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _emp_tokkey(norm):
    """Order-independent key so 'john otieno' == 'otieno john'."""
    return " ".join(sorted(norm.split(" ")))


def _emp_is_real(norm):
    """Reject junk attendance identities (blanks, pure numbers, 'Unknown
    Employee', single short fragments) so we don't waste AI calls on them."""
    if not norm or len(norm) < 3 or norm in _EMP_JUNK or norm.isdigit():
        return False
    alpha_toks = [t for t in norm.split(" ") if any(c.isalpha() for c in t)]
    return bool(alpha_toks)


def _hr_ai_match(queue, batch=15):
    """Resolve ambiguous (attendance_name, candidate roster rows) pairs with the
    shared LLM. Returns a list of (employee_name, employee_id|None, method,
    confidence, matched_name). Never raises — an AI failure degrades to 'none'."""
    out = []
    for i in range(0, len(queue), batch):
        chunk = queue[i:i + batch]
        items = [{"i": idx, "attendance_name": name,
                  "candidates": [c["name"] for c in cands]}
                 for idx, (name, _nn, cands) in enumerate(chunk)]
        sys_prompt = (
            "You match messy biometric attendance names to an official employee "
            "roster. Names may have typos, missing or extra spaces, swapped or "
            "dropped parts, or alternate spellings (e.g. 'William Manza' is the "
            "same person as 'William Mwanza'). For each item pick the candidate "
            "that is clearly the SAME person, or null if none clearly matches. "
            "Reply with ONLY JSON: "
            '{"matches":[{"i":0,"match":"<exact candidate text or null>",'
            '"confidence":0.0}]}'
        )
        mp = {}
        try:
            content = A._chat_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": json.dumps({"items": items})}],
                max_tokens=1500,
            )
            data = A._chat_extract_json(content) or {}
            mp = {m.get("i"): m for m in (data.get("matches") or [])
                  if isinstance(m, dict)}
        except Exception as e:
            A.log.warning("HR rematch: AI batch failed: %s", e)
        for idx, (name, _nn, cands) in enumerate(chunk):
            m = mp.get(idx) or {}
            chosen = m.get("match")
            try:
                conf = float(m.get("confidence") or 0)
            except Exception:
                conf = 0.0
            row = None
            if chosen:
                cn = _emp_norm(str(chosen))
                for c in cands:
                    if c["name"] == chosen or _emp_norm(c["name"]) == cn:
                        row = c
                        break
            if row is not None and conf >= 0.6:
                out.append((name, row["id"], "ai", round(conf, 3), row["name"]))
            else:
                out.append((name, None, "none", round(conf, 3), None))
    return out


def _hr_rematch(use_ai=True):
    """Rebuild hr_employee_match for every distinct attendance employee_name.
    Deterministic passes first (exact norm, order-independent tokens, high-ratio
    fuzzy), then the LLM for the remaining ambiguous-but-plausible names."""
    roster = _rows("SELECT id, name, name_norm FROM hr_employees")
    norm_map, tok_map, norm_list = {}, {}, []
    for r in roster:
        nn = r["name_norm"] or _emp_norm(r["name"])
        norm_map.setdefault(nn, r)
        tok_map.setdefault(_emp_tokkey(nn), r)
        norm_list.append(nn)

    att = _rows("SELECT DISTINCT employee_name FROM vivo_attendance "
                "WHERE employee_name IS NOT NULL AND employee_name <> ''")
    results, ai_queue = [], []
    for a in att:
        name = a["employee_name"]
        nn = _emp_norm(name)
        if not _emp_is_real(nn):
            results.append((name, None, "none", 0.0, None))
            continue
        if nn in norm_map:
            r = norm_map[nn]
            results.append((name, r["id"], "exact", 1.0, r["name"]))
            continue
        tk = _emp_tokkey(nn)
        if tk in tok_map:
            r = tok_map[tk]
            results.append((name, r["id"], "token", 0.97, r["name"]))
            continue
        cands = difflib.get_close_matches(nn, norm_list, n=5, cutoff=0.6)
        if not cands:
            results.append((name, None, "none", 0.0, None))
            continue
        best = cands[0]
        ratio = difflib.SequenceMatcher(None, nn, best).ratio()
        if ratio >= 0.92:
            r = norm_map[best]
            results.append((name, r["id"], "fuzzy", round(ratio, 3), r["name"]))
        elif use_ai:
            ai_queue.append((name, nn, [norm_map[c] for c in cands]))
        elif ratio >= 0.84:
            r = norm_map[best]
            results.append((name, r["id"], "fuzzy", round(ratio, 3), r["name"]))
        else:
            results.append((name, None, "none", round(ratio, 3), None))

    if use_ai and ai_queue:
        results.extend(_hr_ai_match(ai_queue))

    _ex("DELETE FROM hr_employee_match")
    for (name, eid, method, conf, mname) in results:
        _ex("""INSERT INTO hr_employee_match
                 (employee_name, employee_id, name_norm, match_method,
                  confidence, matched_name)
               VALUES (%(n)s,%(e)s,%(nn)s,%(m)s,%(c)s,%(mn)s)""",
            {"n": name, "e": eid, "nn": _emp_norm(name),
             "m": method, "c": conf, "mn": mname})
    return results


# --------------------------------------------------------------------------- #
# Roster import (company Google Sheet -> hr_employees)                          #
# The authoritative staff roster lives in a Google Sheet with one tab per       #
# entity; headers differ per tab (Vivo Kenya carries Department/Team,           #
# Rwanda/Uganda carry Job Title, Shop Zetu name only). Production runs on a      #
# SEPARATE DB that was never loaded with the roster, so the HR pages (which      #
# enrich attendance via hr_employee_match -> hr_employees) show no roster until  #
# this import runs. It is wired into the incremental sync loop as a bootstrap    #
# (see sync_incremental.py) and exposed for on-demand admin refresh.            #
# --------------------------------------------------------------------------- #
ROSTER_SHEET_ID = "1XiY1gRSqW2f3W_UJIp4_EcmW2QDjZfFhRyIkXppxq30"

# (tab title, country). Shop Zetu is Kenya-based.
ROSTER_TABS = [
    ("Vivo Kenya", "Kenya"),
    ("Shop Zetu", "Kenya"),
    ("Vivo Rwanda", "Rwanda"),
    ("Vivo Uganda", "Uganda"),
]

# Dedicated transaction-scoped advisory-lock key (distinct from api_pg's admin /
# targets / rollup keys) so the sync-loop bootstrap and an on-demand
# /rematch?reimport=1 can never run _sync_roster concurrently.
ROSTER_SYNC_LOCK_KEY = 0x52535452  # "RSTR"


def _hdr_index(header):
    """Map lower-cased header text -> column index (first occurrence wins)."""
    idx = {}
    for i, h in enumerate(header):
        key = _t_clean(h).lower()
        if key and key not in idx:
            idx[key] = i
    return idx


def _hdr_pick(idx, row, *aliases):
    """First non-empty cell for any of the given (lower-cased) header aliases."""
    for a in aliases:
        j = idx.get(a)
        if j is not None and j < len(row):
            v = _t_clean(row[j])
            if v:
                return v
    return ""


def _sync_roster():
    """Full-refresh import of the staff roster from the company Google Sheet
    into hr_employees. Header-mapped per tab so column re-ordering is tolerated.
    Guard: if the sheet read yields zero rows (e.g. a transient connector/Sheets
    failure) the existing roster is kept rather than wiped. Returns row count."""
    parsed = []
    for tab, country in ROSTER_TABS:
        vals = _gsheet_values(ROSTER_SHEET_ID, tab, "A1:Z2000")
        if not vals:
            continue
        idx = _hdr_index(vals[0])
        for row in vals[1:]:
            if not row:
                continue
            name = _hdr_pick(idx, row, "name of employees", "name",
                             "employee name")
            if not name:
                continue
            eid = _hdr_pick(idx, row, "pii", "staff no", "staff number",
                            "employee id")
            dept = _hdr_pick(idx, row, "department")
            team = _hdr_pick(idx, row, "team")
            jt = _hdr_pick(idx, row, "job title")
            parsed.append((eid or None, tab, country, name, _emp_norm(name),
                           dept or None, team or None, jt or None))
    if not parsed:
        A.log.warning("HR roster: sheet returned no rows; keeping existing roster")
        return 0
    # Parse happens above (outside the tx) so a slow/failed Sheets read never
    # holds the lock or touches data. The DELETE + all INSERTs then run in ONE
    # advisory-locked transaction: api_pg._users_exec is autocommit, so a
    # statement-by-statement load could leave a half-written roster (>0 rows)
    # that permanently disables the COUNT==0 bootstrap. Atomicity guarantees the
    # table flips wholesale from old->new (or rolls back fully on any error).
    with A._users_tx() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (ROSTER_SYNC_LOCK_KEY,))
        cur.execute("DELETE FROM hr_employees")
        for (eid, entity, country, name, nn, dept, team, jt) in parsed:
            cur.execute(
                """INSERT INTO hr_employees
                     (employee_id, entity, country, name, name_norm,
                      department, team, job_title, source, updated_at)
                   VALUES (%(e)s,%(en)s,%(c)s,%(n)s,%(nn)s,%(d)s,%(t)s,%(j)s,
                           'google_sheet', now())""",
                {"e": eid, "en": entity, "c": country, "n": name, "nn": nn,
                 "d": dept, "t": team, "j": jt})
    A.log.info("HR roster: imported %d employees from sheet", len(parsed))
    return len(parsed)


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
    try:
        _ensure_training_tables()
    except Exception as e:
        A.log.error("HR: training table init failed: %s", e)

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
        lin_b = _LIN.replace("check_in_time", "b.check_in_time")
        is_late_b = IS_LATE.replace("check_in_time", "b.check_in_time")
        checkin_sec_b = (f"(EXTRACT(HOUR FROM {lin_b})*3600 + "
                         f"EXTRACT(MINUTE FROM {lin_b})*60 + "
                         f"EXTRACT(SECOND FROM {lin_b}))")
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
                                               AND b.hours_worked IS NOT NULL) AS avg_hours,
                   COUNT(*) FILTER (WHERE {is_late_b})            AS late_days,
                   COUNT(*) FILTER (WHERE b.check_in_time IS NOT NULL) AS checkin_days,
                   AVG({checkin_sec_b}) FILTER (WHERE b.check_in_time IS NOT NULL)
                                                                  AS avg_checkin_sec,
                   MAX(e.name)        AS roster_name,
                   MAX(e.department)  AS department,
                   MAX(e.team)        AS team,
                   MAX(e.job_title)   AS job_title,
                   MAX(e.entity)      AS entity,
                   MAX(e.employee_id) AS staff_no
            FROM base b JOIN opendays o ON o.branch_name=b.branch_name
            LEFT JOIN hr_employee_match m ON m.employee_name = b.employee_name
            LEFT JOIN hr_employees e ON e.id = m.employee_id
            GROUP BY b.employee_name, b.user_id, b.branch_name
            ORDER BY b.employee_name
        """, params)
        out = []
        for r in rows:
            present = int(r["days_present"] or 0)
            total = int(r["total_days"] or 0)
            absent = max(0, total - present)
            late = int(r["late_days"] or 0)
            checkin_days = int(r["checkin_days"] or 0)
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
                "late_days": late,
                "late_rate": round(late / checkin_days * 100, 1) if checkin_days else 0,
                "avg_check_in": _fmt_clock(r["avg_checkin_sec"]),
                "roster_name": r["roster_name"],
                "department": r["department"],
                "team": r["team"],
                "job_title": r["job_title"],
                "entity": r["entity"],
                "staff_no": r["staff_no"],
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

    # ---------------- Employee roster (from the Google Sheet) ------------- #

    @app.get("/api/hr/employees")
    def hr_employees(request: Request):
        qp = request.query_params
        entity = (qp.get("entity") or "").strip()
        dept = (qp.get("department") or "").strip()
        q = (qp.get("q") or "").strip()
        matched = (qp.get("matched") or "").strip().lower()  # "yes" | "no" | ""
        where, params = [], {}
        if entity and entity.lower() != "all":
            where.append("e.entity = %(entity)s")
            params["entity"] = entity
        if dept and dept.lower() != "all":
            if dept.lower() in ("unassigned", "—", "-"):
                where.append("COALESCE(NULLIF(e.department,''), NULL) IS NULL")
            else:
                where.append("e.department = %(dept)s")
                params["dept"] = dept
        if q:
            where.append("(e.name ILIKE %(q)s OR COALESCE(e.employee_id,'') ILIKE %(q)s)")
            params["q"] = f"%{q}%"
        having = ""
        if matched == "yes":
            having = "HAVING COUNT(m.employee_name) > 0"
        elif matched == "no":
            having = "HAVING COUNT(m.employee_name) = 0"
        wsql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = _rows(f"""
            SELECT e.id, e.employee_id, e.entity, e.country, e.name,
                   e.department, e.team, e.job_title,
                   COUNT(DISTINCT m.employee_name) AS attendance_aliases
            FROM hr_employees e
            LEFT JOIN hr_employee_match m
                   ON m.employee_id = e.id AND m.employee_id IS NOT NULL
            {wsql}
            GROUP BY e.id
            {having}
            ORDER BY e.entity, e.name
        """, params)
        for r in rows:
            r["attendance_aliases"] = int(r["attendance_aliases"] or 0)
            r["linked"] = r["attendance_aliases"] > 0
        return rows

    @app.get("/api/hr/employees/summary")
    def hr_employees_summary(request: Request):
        def _n(sql):
            r = _rows(sql)
            return int((r[0]["n"] if r else 0) or 0)

        total = _n("SELECT COUNT(*) AS n FROM hr_employees")
        linked = _n("SELECT COUNT(DISTINCT employee_id) AS n FROM "
                    "hr_employee_match WHERE employee_id IS NOT NULL")
        matched_aliases = _n("SELECT COUNT(*) AS n FROM hr_employee_match "
                             "WHERE employee_id IS NOT NULL")
        unmatched_aliases = _n("SELECT COUNT(*) AS n FROM hr_employee_match "
                               "WHERE employee_id IS NULL")
        by_entity = _rows("SELECT entity, COUNT(*) AS n FROM hr_employees "
                          "GROUP BY entity ORDER BY n DESC")
        by_dept = _rows("SELECT COALESCE(NULLIF(department,''),'Unassigned') AS k, "
                        "COUNT(*) AS n FROM hr_employees GROUP BY 1 ORDER BY n DESC")
        by_team = _rows("SELECT COALESCE(NULLIF(team,''),'Unassigned') AS k, "
                        "COUNT(*) AS n FROM hr_employees GROUP BY 1 ORDER BY n DESC")
        by_method = _rows("SELECT match_method AS k, COUNT(*) AS n FROM "
                          "hr_employee_match GROUP BY 1 ORDER BY n DESC")
        return {
            "total_employees": total,
            "linked_employees": linked,
            "matched_aliases": matched_aliases,
            "unmatched_aliases": unmatched_aliases,
            "by_entity": [{"entity": r["entity"], "count": int(r["n"])} for r in by_entity],
            "by_department": [{"department": r["k"], "count": int(r["n"])} for r in by_dept],
            "by_team": [{"team": r["k"], "count": int(r["n"])} for r in by_team],
            "by_match_method": [{"method": r["k"], "count": int(r["n"])} for r in by_method],
        }

    @app.post("/api/hr/employees/rematch")
    def hr_employees_rematch(request: Request):
        _, _, role = _actor(request)
        if role not in ("admin", "leadership"):
            return JSONResponse({"detail": "forbidden"}, status_code=403)
        use_ai = (request.query_params.get("ai") or "1") != "0"
        reimport = (request.query_params.get("reimport") or "0") == "1"
        imported = None
        try:
            if reimport:
                imported = _sync_roster()
            results = _hr_rematch(use_ai=use_ai)
        except Exception as e:
            A.log.error("HR rematch failed: %s", e)
            return JSONResponse({"detail": "rematch_failed", "error": str(e)},
                                status_code=500)
        matched = sum(1 for r in results if r[1] is not None)
        methods = {}
        for r in results:
            methods[r[2]] = methods.get(r[2], 0) + 1
        A._crm_audit("hr_employee_match", 0, "rematch",
                     f"reimport={reimport} ai={use_ai} matched={matched}/{len(results)}",
                     request)
        return {"processed": len(results), "matched": matched,
                "unmatched": len(results) - matched, "by_method": methods,
                "roster_imported": imported}

    @app.get("/api/hr/department-performance")
    def hr_department_performance(request: Request):
        qp = request.query_params
        dfrom, dto = _range(qp)
        where, params = _filters(qp, ["location", "branch"])
        params["df"] = dfrom
        params["dt"] = dto
        entity = (qp.get("entity") or "").strip()
        if entity and entity.lower() != "all":
            where.append("e.entity = %(entity)s")
            params["entity"] = entity
        wsql = (" AND " + " AND ".join(where)) if where else ""
        # b-aliased fragments (base is aliased `b` in per_emp)
        lin_b = _LIN.replace("check_in_time", "b.check_in_time")
        is_late_b = IS_LATE.replace("check_in_time", "b.check_in_time")
        is_ut_b = IS_UT.replace("check_in_time", "b.check_in_time").replace("check_out_time", "b.check_out_time")
        checkin_sec_b = (f"(EXTRACT(HOUR FROM {lin_b})*3600 + "
                         f"EXTRACT(MINUTE FROM {lin_b})*60 + "
                         f"EXTRACT(SECOND FROM {lin_b}))")
        # vivo_attendance has no Absent rows, so attendance rate must use a real
        # expected-days baseline: per-employee branch open-days (same as employee-summary),
        # summed up to the department.
        # One scan returns per-employee rows; the department aggregate AND the
        # per-department best/worst ("notorious") performer lists are both
        # derived from them in Python so we never re-scan attendance.
        emp_rows = _rows(f"""
            WITH base AS (
                SELECT va.*, COALESCE(NULLIF(TRIM(e.department), ''), 'Unassigned') AS dept,
                       COALESCE(NULLIF(TRIM(e.job_title), ''), '') AS designation
                FROM vivo_attendance va
                JOIN hr_employee_match m ON m.employee_name = va.employee_name
                                        AND m.employee_id IS NOT NULL
                JOIN hr_employees e ON e.id = m.employee_id
                WHERE va.attendance_date BETWEEN %(df)s AND %(dt)s{wsql}
            ),
            opendays AS (
                SELECT branch_name, COUNT(DISTINCT attendance_date) AS open_days
                FROM base GROUP BY branch_name
            )
            SELECT b.dept, b.employee_name,
                   MAX(b.designation)                              AS designation,
                   COUNT(DISTINCT b.attendance_date)               AS days_present,
                   MAX(o.open_days)                                AS expected_days,
                   COUNT(*) FILTER (WHERE {is_late_b})             AS late_days,
                   COUNT(*) FILTER (WHERE b.check_in_time IS NOT NULL) AS checkin_days,
                   COUNT(*) FILTER (WHERE {is_ut_b})               AS undertime_days,
                   SUM(b.hours_worked) FILTER (WHERE COALESCE(b.is_complete,false)
                                               AND b.hours_worked IS NOT NULL) AS hours_sum,
                   COUNT(*) FILTER (WHERE COALESCE(b.is_complete,false)
                                    AND b.hours_worked IS NOT NULL) AS complete_days,
                   SUM({checkin_sec_b}) FILTER (WHERE b.check_in_time IS NOT NULL)
                                                                   AS checkin_sec_sum
            FROM base b JOIN opendays o ON o.branch_name = b.branch_name
            GROUP BY b.dept, b.employee_name
        """, params)

        # Group employees by department.
        by_dept = {}
        for r in emp_rows:
            by_dept.setdefault(r["dept"], []).append(r)

        def _emp_card(r):
            present = int(r["days_present"] or 0)
            expected = int(r["expected_days"] or 0)
            late = int(r["late_days"] or 0)
            checkin = int(r["checkin_days"] or 0)
            hsum = float(r["hours_sum"]) if r["hours_sum"] is not None else 0.0
            comp = int(r["complete_days"] or 0)
            csum = float(r["checkin_sec_sum"]) if r["checkin_sec_sum"] is not None else None
            return {
                "employee_name": r["employee_name"],
                "designation": r["designation"] or "",
                "attendance_rate": round(present / expected * 100, 1) if expected else 0,
                "late_rate": round(late / checkin * 100, 1) if checkin else 0,
                "late_days": late,
                "absent_days": max(expected - present, 0),
                "undertime_days": int(r["undertime_days"] or 0),
                "avg_hours": round(hsum / comp, 2) if comp else 0,
                "avg_check_in": _fmt_clock(csum / checkin) if checkin and csum is not None else None,
                "days_present": present,
                "expected_days": expected,
            }

        out = []
        for dept, members in by_dept.items():
            present = sum(int(r["days_present"] or 0) for r in members)
            expected = sum(int(r["expected_days"] or 0) for r in members)
            late = sum(int(r["late_days"] or 0) for r in members)
            checkin = sum(int(r["checkin_days"] or 0) for r in members)
            undertime = sum(int(r["undertime_days"] or 0) for r in members)
            hours_sum = sum(float(r["hours_sum"]) for r in members if r["hours_sum"] is not None)
            complete = sum(int(r["complete_days"] or 0) for r in members)
            checkin_sec_sum = sum(float(r["checkin_sec_sum"]) for r in members if r["checkin_sec_sum"] is not None)

            cards = [_emp_card(r) for r in members]
            # Only rank employees with a meaningful presence baseline so a
            # one-day record can't dominate the best/worst lists.
            rankable = [c for c in cards if c["expected_days"] >= 3]
            pool = rankable if rankable else cards
            # Notorious = worst attendance, then most lateness. Best = inverse.
            worst = sorted(pool, key=lambda c: (c["attendance_rate"], -c["late_rate"]))[:3]
            best = sorted(pool, key=lambda c: (-c["attendance_rate"], c["late_rate"]))[:3]

            out.append({
                "department": dept,
                "employees": len(members),
                "present_days": present,
                "expected_days": expected,
                "late_days": late,
                "undertime_days": undertime,
                "attendance_rate": round(present / expected * 100, 1) if expected else 0,
                "late_rate": round(late / checkin * 100, 1) if checkin else 0,
                "avg_hours": round(hours_sum / complete, 2) if complete else 0,
                "avg_check_in": _fmt_clock(checkin_sec_sum / checkin) if checkin and checkin_sec_sum else None,
                "worst_performers": worst,
                "best_performers": best,
            })
        out.sort(key=lambda d: (-d["employees"], d["department"]))
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

    # ---------------- Staff Training (Google Sheet → hr_training*) --------- #

    @app.post("/api/hr/training/sync")
    def hr_training_sync(request: Request):
        _, _, role = _actor(request)
        if role not in ("admin", "exec"):
            return JSONResponse({"detail": "Sync requires an executive or admin role"}, status_code=403)
        try:
            res = _sync_training()
        except Exception as e:
            A.log.error("HR: training sync failed: %s", e)
            return JSONResponse({"detail": f"Training sync failed: {e}"}, status_code=502)
        return {"ok": True, **res}

    @app.get("/api/hr/training/status")
    def hr_training_sync_status(request: Request):
        _ensure_training_tables()
        r = _rows("SELECT last_synced_at, trainings, staff, targets FROM hr_training_sync WHERE id=1")
        if not r:
            return {"synced": False, "last_synced_at": None, "trainings": 0, "staff": 0, "targets": 0}
        row = r[0]
        return {
            "synced": True,
            "last_synced_at": row["last_synced_at"].isoformat() if row["last_synced_at"] else None,
            "trainings": int(row["trainings"] or 0),
            "staff": int(row["staff"] or 0),
            "targets": int(row["targets"] or 0),
        }

    @app.get("/api/hr/training/filters")
    def hr_training_filters(request: Request):
        _training_autosync()
        def distinct(col):
            rows = _rows(f"SELECT DISTINCT {col} AS v FROM hr_training "
                         f"WHERE COALESCE(NULLIF(TRIM({col}),''),'') <> '' ORDER BY v")
            return [r["v"] for r in rows]
        bounds = _rows("SELECT MIN(training_date) AS lo, MAX(training_date) AS hi FROM hr_training")
        lo = bounds[0]["lo"] if bounds else None
        hi = bounds[0]["hi"] if bounds else None
        return {
            "categories": distinct("category"),
            "training_names": distinct("training_name"),
            "departments": distinct("department"),
            "delivery_methods": distinct("delivery_method"),
            "locations": distinct("training_location"),
            "earliest_date": lo.isoformat() if lo else None,
            "latest_date": hi.isoformat() if hi else None,
        }

    @app.get("/api/hr/training/overview")
    def hr_training_overview(request: Request):
        _training_autosync()
        w, p = _training_where(request.query_params)
        r = _rows(f"""
            SELECT COUNT(*) AS total_trained,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS unique_employees,
                   COUNT(DISTINCT training_name) FILTER (WHERE training_name <> '') AS total_trainings,
                   COUNT(DISTINCT NULLIF(TRIM(department),'')) AS departments_trained,
                   COUNT(DISTINCT {_SESSION_EXPR}) AS total_sessions,
                   SUM(actual_budget) AS total_actual_budget,
                   AVG(time_taken_sec) / 3600.0 AS avg_hours_per_session
            FROM hr_training WHERE {w}
        """, p)
        row = r[0] if r else {}
        return {
            "total_trained": int(row.get("total_trained") or 0),
            "unique_employees": int(row.get("unique_employees") or 0),
            "total_trainings": int(row.get("total_trainings") or 0),
            "departments_trained": int(row.get("departments_trained") or 0),
            "total_sessions": int(row.get("total_sessions") or 0),
            "total_actual_budget": float(row["total_actual_budget"]) if row.get("total_actual_budget") is not None else 0,
            "avg_hours_per_session": float(row["avg_hours_per_session"]) if row.get("avg_hours_per_session") is not None else None,
        }

    @app.get("/api/hr/training/training-status")
    def hr_training_status(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT training_name,
                   MAX(category) AS category,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS employees_trained,
                   COUNT(DISTINCT {_SESSION_EXPR}) AS total_sessions,
                   AVG(time_taken_sec) / 3600.0 AS avg_hours_actual,
                   AVG(expected_sec) / 3600.0 AS avg_hours_expected,
                   SUM(actual_budget) AS total_budget
            FROM hr_training
            WHERE {w} AND COALESCE(NULLIF(TRIM(training_name),''),'') <> ''
            GROUP BY training_name
            ORDER BY employees_trained DESC, total_sessions DESC
        """, p)
        return [{
            "training_name": r["training_name"],
            "category": r["category"] or "",
            "employees_trained": int(r["employees_trained"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
            "avg_hours_actual": float(r["avg_hours_actual"]) if r["avg_hours_actual"] is not None else None,
            "avg_hours_expected": float(r["avg_hours_expected"]) if r["avg_hours_expected"] is not None else None,
            "total_budget": float(r["total_budget"]) if r["total_budget"] is not None else 0,
        } for r in rows]

    @app.get("/api/hr/training/by-department")
    def hr_training_by_department(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT COALESCE(NULLIF(TRIM(department),''),'Unassigned') AS department,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS unique_employees,
                   COUNT(DISTINCT training_name) FILTER (WHERE training_name <> '') AS trainings_attended,
                   COUNT(DISTINCT {_SESSION_EXPR}) AS total_sessions,
                   AVG(time_taken_sec) / 3600.0 AS avg_hours
            FROM hr_training WHERE {w}
            GROUP BY 1 ORDER BY unique_employees DESC
        """, p)
        return [{
            "department": r["department"],
            "unique_employees": int(r["unique_employees"] or 0),
            "trainings_attended": int(r["trainings_attended"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
            "avg_hours": float(r["avg_hours"]) if r["avg_hours"] is not None else 0,
        } for r in rows]

    @app.get("/api/hr/training/by-delivery-method")
    def hr_training_by_delivery(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT COALESCE(NULLIF(TRIM(delivery_method),''),'Unknown') AS delivery_method,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS unique_employees,
                   COUNT(DISTINCT {_SESSION_EXPR}) AS total_sessions
            FROM hr_training WHERE {w}
            GROUP BY 1 ORDER BY unique_employees DESC
        """, p)
        return [{
            "delivery_method": r["delivery_method"],
            "unique_employees": int(r["unique_employees"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
        } for r in rows]

    @app.get("/api/hr/training/duration")
    def hr_training_duration(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT training_name,
                   AVG(expected_sec) / 3600.0 AS avg_expected_hours,
                   AVG(time_taken_sec) / 3600.0 AS avg_actual_hours
            FROM hr_training
            WHERE {w} AND COALESCE(NULLIF(TRIM(training_name),''),'') <> ''
            GROUP BY training_name
            ORDER BY avg_actual_hours DESC NULLS LAST
        """, p)
        return [{
            "training_name": r["training_name"],
            "avg_expected_hours": float(r["avg_expected_hours"]) if r["avg_expected_hours"] is not None else 0,
            "avg_actual_hours": float(r["avg_actual_hours"]) if r["avg_actual_hours"] is not None else 0,
        } for r in rows]

    @app.get("/api/hr/training/budget")
    def hr_training_budget(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT training_name,
                   SUM(actual_budget) AS actual_cost,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS employees
            FROM hr_training
            WHERE {w} AND COALESCE(NULLIF(TRIM(training_name),''),'') <> ''
            GROUP BY training_name
            HAVING SUM(actual_budget) IS NOT NULL AND SUM(actual_budget) > 0
            ORDER BY actual_cost DESC
        """, p)
        out = []
        for r in rows:
            cost = float(r["actual_cost"]) if r["actual_cost"] is not None else 0
            emp = int(r["employees"] or 0)
            out.append({
                "training_name": r["training_name"],
                "actual_cost": cost,
                "employees": emp,
                "avg_cost_per_person": round(cost / emp, 2) if emp else None,
            })
        return out

    @app.get("/api/hr/training/lateness")
    def hr_training_lateness(request: Request):
        w, p = _training_where(request.query_params)
        by_training = _rows(f"""
            SELECT training_name,
                   AVG(lateness_sec) / 3600.0 AS avg_lateness_hours,
                   MAX(lateness_sec) / 3600.0 AS max_lateness_hours,
                   COUNT(*) AS participants
            FROM hr_training
            WHERE {w} AND lateness_sec IS NOT NULL
              AND COALESCE(NULLIF(TRIM(training_name),''),'') <> ''
            GROUP BY training_name
            HAVING AVG(lateness_sec) > 0
            ORDER BY avg_lateness_hours DESC
        """, p)
        detail = _rows(f"""
            SELECT employee_name, training_name, training_date,
                   lateness_sec / 3600.0 AS lateness_hours,
                   COALESCE(NULLIF(TRIM(department),''),'Unassigned') AS department
            FROM hr_training
            WHERE {w} AND lateness_sec > 0
            ORDER BY lateness_sec DESC LIMIT 50
        """, p)
        return {
            "by_training": [{
                "training_name": r["training_name"],
                "avg_lateness_hours": float(r["avg_lateness_hours"]) if r["avg_lateness_hours"] is not None else 0,
                "max_lateness_hours": float(r["max_lateness_hours"]) if r["max_lateness_hours"] is not None else 0,
                "participants": int(r["participants"] or 0),
            } for r in by_training],
            "detail": [{
                "employee_name": r["employee_name"],
                "training_name": r["training_name"],
                "training_date": r["training_date"].isoformat() if r["training_date"] else None,
                "lateness_hours": float(r["lateness_hours"]) if r["lateness_hours"] is not None else 0,
                "department": r["department"],
            } for r in detail],
        }

    @app.get("/api/hr/training/top-employees")
    def hr_training_top_employees(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT employee_name,
                   MAX(employee_code) AS employee_code,
                   MAX(COALESCE(NULLIF(TRIM(department),''),'')) AS department,
                   MAX(COALESCE(NULLIF(TRIM(designation),''),'')) AS designation,
                   COUNT(DISTINCT training_name) FILTER (WHERE training_name <> '') AS unique_trainings,
                   COUNT(*) AS total_sessions,
                   SUM(time_taken_sec) / 3600.0 AS total_hours_trained
            FROM hr_training
            WHERE {w} AND COALESCE(NULLIF(TRIM(employee_name),''),'') <> ''
            GROUP BY employee_name
            ORDER BY total_sessions DESC, unique_trainings DESC
            LIMIT 100
        """, p)
        return [{
            "employee_name": r["employee_name"],
            "employee_code": r["employee_code"] or "",
            "department": r["department"] or "",
            "designation": r["designation"] or "",
            "unique_trainings": int(r["unique_trainings"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
            "total_hours_trained": float(r["total_hours_trained"]) if r["total_hours_trained"] is not None else 0,
        } for r in rows]

    @app.get("/api/hr/training/monthly-trend")
    def hr_training_monthly(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            SELECT to_char(date_trunc('month', training_date), 'Mon YY') AS month,
                   date_trunc('month', training_date) AS m,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS unique_employees,
                   COUNT(DISTINCT {_SESSION_EXPR}) AS total_sessions
            FROM hr_training
            WHERE {w} AND training_date IS NOT NULL
            GROUP BY 1, 2 ORDER BY 2
        """, p)
        return [{
            "month": r["month"],
            "unique_employees": int(r["unique_employees"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
        } for r in rows]

    @app.get("/api/hr/training/facilitators")
    def hr_training_facilitators(request: Request):
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            WITH f AS (
                SELECT facilitator AS facilitator, training_name, employee_name,
                       actual_budget, {_SESSION_EXPR} AS sess
                FROM hr_training
                WHERE {w} AND COALESCE(NULLIF(TRIM(facilitator),''),'') <> ''
                UNION ALL
                SELECT co_facilitator, training_name, employee_name,
                       actual_budget, {_SESSION_EXPR}
                FROM hr_training
                WHERE {w} AND COALESCE(NULLIF(TRIM(co_facilitator),''),'') <> ''
            )
            SELECT facilitator,
                   COUNT(DISTINCT training_name) FILTER (WHERE training_name <> '') AS trainings_conducted,
                   COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS employees_trained,
                   COUNT(DISTINCT sess) AS total_sessions,
                   SUM(actual_budget) AS total_budget
            FROM f GROUP BY facilitator
            ORDER BY total_sessions DESC, employees_trained DESC
        """, p)
        return [{
            "facilitator": r["facilitator"],
            "trainings_conducted": int(r["trainings_conducted"] or 0),
            "employees_trained": int(r["employees_trained"] or 0),
            "total_sessions": int(r["total_sessions"] or 0),
            "total_budget": float(r["total_budget"]) if r["total_budget"] is not None else 0,
        } for r in rows]

    @app.get("/api/hr/training/employee-history")
    def hr_training_employee_history(request: Request):
        emp = (request.query_params.get("employee") or "").strip()
        if not emp:
            return []
        rows = _rows("""
            SELECT training_date, training_name, category, delivery_method,
                   training_location, facilitator,
                   time_taken_sec / 3600.0 AS hours,
                   expected_sec / 3600.0 AS expected_hours,
                   lateness_sec / 3600.0 AS lateness_hours,
                   actual_budget
            FROM hr_training
            WHERE employee_name = %(emp)s
            ORDER BY training_date DESC NULLS LAST
        """, {"emp": emp})
        return [{
            "training_date": r["training_date"].isoformat() if r["training_date"] else None,
            "training_name": r["training_name"],
            "category": r["category"] or "",
            "delivery_method": r["delivery_method"] or "",
            "training_location": r["training_location"] or "",
            "facilitator": r["facilitator"] or "",
            "hours": float(r["hours"]) if r["hours"] is not None else None,
            "expected_hours": float(r["expected_hours"]) if r["expected_hours"] is not None else None,
            "lateness_hours": float(r["lateness_hours"]) if r["lateness_hours"] is not None else None,
            "actual_budget": float(r["actual_budget"]) if r["actual_budget"] is not None else None,
        } for r in rows]

    @app.get("/api/hr/training/coverage")
    def hr_training_coverage(request: Request):
        _training_autosync()
        w, p = _training_where(request.query_params)
        rows = _rows(f"""
            WITH staff AS (
                SELECT COALESCE(NULLIF(TRIM(department),''),'Unassigned') AS department,
                       COUNT(DISTINCT name) AS headcount
                FROM hr_training_staff
                WHERE COALESCE(NULLIF(TRIM(name),''),'') <> ''
                GROUP BY 1
            ),
            trained AS (
                SELECT COALESCE(NULLIF(TRIM(department),''),'Unassigned') AS department,
                       COUNT(DISTINCT employee_name) FILTER (WHERE employee_name <> '') AS trained
                FROM hr_training WHERE {w}
                GROUP BY 1
            )
            SELECT COALESCE(s.department, t.department) AS department,
                   COALESCE(s.headcount, 0) AS headcount,
                   COALESCE(t.trained, 0) AS trained
            FROM staff s FULL OUTER JOIN trained t ON s.department = t.department
            ORDER BY headcount DESC, trained DESC
        """, p)
        out = []
        for r in rows:
            hc = int(r["headcount"] or 0)
            tr = int(r["trained"] or 0)
            out.append({
                "department": r["department"],
                "headcount": hc,
                "trained": tr,
                "coverage_pct": round(min(tr, hc) / hc * 100, 1) if hc else None,
            })
        return out

    @app.get("/api/hr/training/targets")
    def hr_training_targets(request: Request):
        _training_autosync()
        rows = _rows("""
            SELECT t.training_area, t.target_count, t.target_date, t.expected_time,
                   t.audience, t.week_of_year,
                   (SELECT COUNT(*) FROM hr_training h
                    WHERE NULLIF(TRIM(t.training_area),'') IS NOT NULL
                      AND h.training_name ILIKE '%%' || split_part(t.training_area, ' ', 1) || '%%'
                   ) AS actual_trained
            FROM hr_training_target t
            WHERE COALESCE(NULLIF(TRIM(t.training_area),''),'') <> ''
            ORDER BY t.target_date NULLS LAST, t.training_area
        """)
        targets = [{
            "training_area": r["training_area"],
            "target_count": float(r["target_count"]) if r["target_count"] is not None else None,
            "target_date": r["target_date"].isoformat() if r["target_date"] else None,
            "expected_time": r["expected_time"] or "",
            "audience": r["audience"] or "",
            "week_of_year": r["week_of_year"] or "",
            "actual_trained": int(r["actual_trained"] or 0),
        } for r in rows]
        tot = _rows("SELECT SUM(target_count) AS tt FROM hr_training_target")
        act = _rows("SELECT COUNT(*) AS ta FROM hr_training")
        return {
            "targets": targets,
            "total_target": float(tot[0]["tt"]) if tot and tot[0]["tt"] is not None else 0,
            "total_actual": int(act[0]["ta"]) if act else 0,
        }

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
