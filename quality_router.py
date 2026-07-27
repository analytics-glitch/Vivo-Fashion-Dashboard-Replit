"""Quality Department Dashboard — FastAPI router.

Serves data for four trackers sourced from a Google Sheet
(QUALITY_SHEET_ID env var, defaulting to a hard-coded ID):

  1. Repairs per line (A–E) vs Actual Production  — daily / weekly / monthly
  2. Overall Repairs vs Actual Production          — daily / weekly / monthly
  3. Customer Complaint types                      — per week
  4. Washing Qty vs Actual Production              — per week

For trackers 3 & 4 the router falls back to manual-entry Postgres tables when
the relevant sheet tab is absent (giving the team an immediate capture path
while the sheet is being set up).

Sheet access reuses the Google Sheets helpers from hr_attendance.py.
Sheet metadata is cached for 5 minutes to avoid per-request API calls.
"""

import logging
import os
import re
import threading
import time
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from hr_attendance import _connector_access_token, _gsheet_values

log = logging.getLogger("quality_router")

quality_router = APIRouter(tags=["quality"])

# ── Sheet config ─────────────────────────────────────────────────────────────
_DEFAULT_SHEET_ID = "1RhV27RJD7S4s5AChiggAMkxRHUocAOqkWzzUIqcF31U"
QUALITY_SHEET_ID = os.environ.get("QUALITY_SHEET_ID", "").strip() or _DEFAULT_SHEET_ID

# ── DB tables (lazy creation) ─────────────────────────────────────────────────
_QUALITY_TABLES_READY = False
_quality_tables_lock = threading.Lock()


def _ensure_quality_tables(conn):
    global _QUALITY_TABLES_READY
    if _QUALITY_TABLES_READY:
        return
    with _quality_tables_lock:
        if _QUALITY_TABLES_READY:
            return
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS quality_complaints (
                    id             SERIAL PRIMARY KEY,
                    week_start     DATE NOT NULL,
                    complaint_type TEXT NOT NULL,
                    count          INT  NOT NULL DEFAULT 0,
                    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS quality_washing (
                    id             SERIAL PRIMARY KEY,
                    week_start     DATE NOT NULL,
                    washing_qty    NUMERIC NOT NULL DEFAULT 0,
                    production_qty NUMERIC NOT NULL DEFAULT 0,
                    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
        conn.commit()
        _QUALITY_TABLES_READY = True


# ── Sheet metadata cache ──────────────────────────────────────────────────────
# _SHEET_CACHE: {sheet_id: {"ts": float, "tabs": {title: [header, ...]}} }
_SHEET_CACHE: dict = {}
_SHEET_CACHE_TTL = 300  # 5 minutes
_sheet_cache_lock = threading.Lock()


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


# Keyword map: each keyword maps to a canonical column role name.
_KEYWORD_MAP = {
    "repair":      "repairs",
    "rework":      "repairs",
    "product":     "production",
    "actual":      "production",
    "output":      "production",
    "line":        "line",
    "date":        "date",
    "type":        "complaint_type",
    "complaint":   "complaint_type",
    "category":    "complaint_type",
    "defect":      "complaint_type",
    "wash":        "washing_qty",
    "laundry":     "washing_qty",
    "week":        "week",
}


def _classify_header(header_cell):
    """Return a canonical role name for a column header, or None."""
    h = _norm(header_cell)
    for kw, role in _KEYWORD_MAP.items():
        if kw in h:
            return role
    return None


def _discover_sheet(sheet_id):
    """Return {tab_title: [header_col_names]} from the sheet metadata.
    Uses the Sheets v4 spreadsheet metadata + first-row values per tab.
    Cached for 5 minutes per sheet_id."""
    now = time.time()
    with _sheet_cache_lock:
        entry = _SHEET_CACHE.get(sheet_id)
        if entry and now - entry["ts"] < _SHEET_CACHE_TTL:
            return entry["tabs"]

    tok = _connector_access_token("google-sheet")
    r = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}",
        params={"fields": "sheets.properties"},
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    r.raise_for_status()
    sheets_meta = (r.json() or {}).get("sheets") or []
    tabs = {}
    for s in sheets_meta:
        title = (s.get("properties") or {}).get("title") or ""
        if not title:
            continue
        try:
            rows = _gsheet_values(sheet_id, title, "A1:Z1")
            if rows:
                tabs[title] = [str(c).strip() for c in rows[0]]
            else:
                tabs[title] = []
        except Exception as e:
            log.warning("quality: could not read headers for tab %r: %s", title, e)
            tabs[title] = []

    with _sheet_cache_lock:
        _SHEET_CACHE[sheet_id] = {"ts": now, "tabs": tabs}
    return tabs


def _invalidate_sheet_cache(sheet_id=None):
    with _sheet_cache_lock:
        if sheet_id:
            _SHEET_CACHE.pop(sheet_id, None)
        else:
            _SHEET_CACHE.clear()


def _find_tab(tabs, required_roles):
    """Find the first tab whose headers contain ALL required role names.
    required_roles is a set of canonical role names (e.g. {'repairs', 'date'}).
    Returns (tab_title, header_list) or (None, None)."""
    for title, headers in tabs.items():
        roles = {_classify_header(h) for h in headers}
        if required_roles.issubset(roles):
            return title, headers
    return None, None


def _col_index(headers, role):
    """Return the 0-based column index whose header maps to `role`, or -1."""
    for i, h in enumerate(headers):
        if _classify_header(h) == role:
            return i
    return -1


# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_date(val):
    """Parse mm/dd/yyyy, yyyy-mm-dd, dd/mm/yyyy, or Excel serial."""
    if not val:
        return None
    v = str(val).strip()
    # Excel serial (integer-like)
    if re.fullmatch(r"\d{4,6}", v):
        try:
            n = int(v)
            if 30000 < n < 60000:  # plausible Excel date
                return date(1899, 12, 30) + timedelta(days=n)
        except ValueError:
            pass
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def _week_start(d: date) -> date:
    """Return the Monday of the week containing d."""
    return d - timedelta(days=d.weekday())


def _period_label(d: date, period: str) -> str:
    if period == "daily":
        return d.isoformat()
    if period == "weekly":
        return _week_start(d).isoformat()
    if period == "monthly":
        return d.strftime("%Y-%m")
    return d.isoformat()


# ── Connection helper ─────────────────────────────────────────────────────────

def _get_conn():
    import sys
    sys.path.insert(0, "/home/runner/workspace")
    import importlib
    api = importlib.import_module("api_pg")
    return api.get_conn()


def _q(conn, sql, params=()):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


# ── Repairs endpoint ──────────────────────────────────────────────────────────

def _repairs_from_sheet(sheet_id, tab, headers, period):
    """Read the per-line repairs tab and return bucketed data."""
    rows = _gsheet_values(sheet_id, tab, "A1:Z5000")
    if not rows or len(rows) < 2:
        return []

    date_col = _col_index(headers, "date")
    line_col  = _col_index(headers, "line")
    rep_col   = _col_index(headers, "repairs")
    prod_col  = _col_index(headers, "production")

    # bucket: {period_label: {line_A: repairs, ..., production: prod}}
    bucket: dict = {}

    for row in rows[1:]:
        def cell(i):
            return row[i].strip() if i >= 0 and i < len(row) else ""

        d = _parse_date(cell(date_col)) if date_col >= 0 else None
        if not d:
            continue
        lbl = _period_label(d, period)
        line = cell(line_col).upper()[:1] if line_col >= 0 else "?"
        if not line:
            line = "?"
        try:
            rep = float(cell(rep_col)) if rep_col >= 0 and cell(rep_col) else 0
        except ValueError:
            rep = 0
        try:
            prod = float(cell(prod_col)) if prod_col >= 0 and cell(prod_col) else 0
        except ValueError:
            prod = 0

        b = bucket.setdefault(lbl, {"production": 0})
        b[line] = b.get(line, 0) + rep
        b["production"] += prod

    result = []
    for lbl in sorted(bucket.keys()):
        b = bucket[lbl]
        result.append({
            "period_label": lbl,
            "lines": {k: v for k, v in b.items() if k != "production"},
            "production": b["production"],
        })
    return result


def _overall_repairs_from_sheet(sheet_id, tab, headers, period):
    """Read the overall / Sewing Reworks tab and return bucketed data."""
    rows = _gsheet_values(sheet_id, tab, "A1:Z5000")
    if not rows or len(rows) < 2:
        return []

    date_col = _col_index(headers, "date")
    rep_col  = _col_index(headers, "repairs")
    prod_col = _col_index(headers, "production")

    bucket: dict = {}
    for row in rows[1:]:
        def cell(i):
            return row[i].strip() if i >= 0 and i < len(row) else ""

        d = _parse_date(cell(date_col)) if date_col >= 0 else None
        if not d:
            continue
        lbl = _period_label(d, period)
        try:
            rep = float(cell(rep_col)) if rep_col >= 0 and cell(rep_col) else 0
        except ValueError:
            rep = 0
        try:
            prod = float(cell(prod_col)) if prod_col >= 0 and cell(prod_col) else 0
        except ValueError:
            prod = 0
        b = bucket.setdefault(lbl, {"repairs": 0, "production": 0})
        b["repairs"] += rep
        b["production"] += prod

    result = []
    for lbl in sorted(bucket.keys()):
        b = bucket[lbl]
        result.append({
            "period_label": lbl,
            "repairs": b["repairs"],
            "production": b["production"],
        })
    return result


@quality_router.get("/api/quality/repairs")
def repairs_by_line(period: str = Query("weekly", pattern="^(daily|weekly|monthly)$")):
    """Grouped bar data: repairs per sewing line vs actual production.
    Returns [{period_label, lines: {A,B,...}, production}]."""
    try:
        tabs = _discover_sheet(QUALITY_SHEET_ID)
    except Exception as e:
        log.error("quality repairs: sheet discovery failed: %s", e)
        return {"data": [], "has_data": False, "source": "error", "error": str(e)}

    # Look for a tab with line + repair + production + date columns
    tab, headers = _find_tab(tabs, {"line", "repairs", "date"})
    if not tab:
        # Try without date (less ideal but usable)
        tab, headers = _find_tab(tabs, {"line", "repairs"})

    if not tab:
        return {"data": [], "has_data": False, "source": "no_tab"}

    try:
        data = _repairs_from_sheet(QUALITY_SHEET_ID, tab, headers, period)
    except Exception as e:
        log.error("quality repairs: read failed: %s", e)
        return {"data": [], "has_data": False, "source": "error", "error": str(e)}

    return {"data": data, "has_data": bool(data), "source": "sheet", "tab": tab, "period": period}


@quality_router.get("/api/quality/overall-repairs")
def overall_repairs(period: str = Query("weekly", pattern="^(daily|weekly|monthly)$")):
    """Overall repairs vs production (Sewing Reworks tab or a tab without a
    'line' column that still has 'repair' + 'production').
    Returns [{period_label, repairs, production}]."""
    try:
        tabs = _discover_sheet(QUALITY_SHEET_ID)
    except Exception as e:
        log.error("quality overall-repairs: sheet discovery failed: %s", e)
        return {"data": [], "has_data": False, "source": "error", "error": str(e)}

    # Prefer a tab explicitly named "Sewing Reworks" (case-insensitive)
    tab = None
    headers = None
    for title, hdrs in tabs.items():
        if "sewing rework" in title.lower():
            tab = title
            headers = hdrs
            break

    if not tab:
        # Fall back to a tab with repairs + production but NO line column
        for title, hdrs in tabs.items():
            roles = {_classify_header(h) for h in hdrs}
            if "repairs" in roles and "production" in roles and "line" not in roles:
                tab = title
                headers = hdrs
                break

    if not tab:
        # Last resort: any tab with repairs + production
        tab, headers = _find_tab(tabs, {"repairs", "production"})

    if not tab:
        return {"data": [], "has_data": False, "source": "no_tab"}

    try:
        data = _overall_repairs_from_sheet(QUALITY_SHEET_ID, tab, headers, period)
    except Exception as e:
        log.error("quality overall-repairs: read failed: %s", e)
        return {"data": [], "has_data": False, "source": "error", "error": str(e)}

    return {"data": data, "has_data": bool(data), "source": "sheet", "tab": tab, "period": period}


# ── Complaints endpoint ───────────────────────────────────────────────────────

def _complaints_from_sheet(sheet_id, tab, headers):
    rows = _gsheet_values(sheet_id, tab, "A1:Z5000")
    if not rows or len(rows) < 2:
        return []

    date_col = _col_index(headers, "date")
    week_col = _col_index(headers, "week")
    type_col = _col_index(headers, "complaint_type")
    # count — might be a "count" or "quantity" column; search broadly
    count_col = -1
    for i, h in enumerate(headers):
        if any(kw in _norm(h) for kw in ("count", "qty", "quantity", "number", "total")):
            count_col = i
            break

    bucket: dict = {}  # week_start_iso -> {type -> count}

    for row in rows[1:]:
        def cell(i):
            return row[i].strip() if i >= 0 and i < len(row) else ""

        # Determine week_start
        ws = None
        if date_col >= 0:
            d = _parse_date(cell(date_col))
            if d:
                ws = _week_start(d).isoformat()
        if not ws and week_col >= 0:
            d = _parse_date(cell(week_col))
            if d:
                ws = _week_start(d).isoformat()
        if not ws:
            continue

        ctype = cell(type_col) if type_col >= 0 else "Unknown"
        if not ctype:
            ctype = "Unknown"
        try:
            cnt = float(cell(count_col)) if count_col >= 0 and cell(count_col) else 1
        except ValueError:
            cnt = 1

        week_data = bucket.setdefault(ws, {})
        week_data[ctype] = week_data.get(ctype, 0) + cnt

    result = []
    for ws in sorted(bucket.keys()):
        breakdown = [{"type": t, "count": c} for t, c in sorted(bucket[ws].items())]
        result.append({"week_start": ws, "breakdown": breakdown})
    return result


@quality_router.get("/api/quality/complaints")
def get_complaints():
    """Complaint breakdown per week.
    Falls back to Postgres quality_complaints when no sheet tab found."""
    # Try sheet first
    sheet_data = None
    has_sheet = False
    try:
        tabs = _discover_sheet(QUALITY_SHEET_ID)
        tab, headers = _find_tab(tabs, {"complaint_type"})
        if tab:
            rows = _complaints_from_sheet(QUALITY_SHEET_ID, tab, headers)
            if rows:
                sheet_data = rows
                has_sheet = True
    except Exception as e:
        log.warning("quality complaints: sheet read failed: %s", e)

    if has_sheet:
        return {"data": sheet_data, "has_data": True, "source": "sheet"}

    # Fall back to Postgres
    with _get_conn() as conn:
        _ensure_quality_tables(conn)
        rows = _q(conn, """
            SELECT week_start::text, complaint_type,
                   SUM(count) AS total_count
            FROM quality_complaints
            GROUP BY week_start, complaint_type
            ORDER BY week_start, complaint_type
        """)

    by_week: dict = {}
    for r in rows:
        ws = r["week_start"]
        by_week.setdefault(ws, []).append({
            "type": r["complaint_type"],
            "count": float(r["total_count"] or 0),
        })
    data = [{"week_start": ws, "breakdown": by_week[ws]}
            for ws in sorted(by_week.keys())]
    return {"data": data, "has_data": bool(data), "source": "db"}


class ComplaintIn(BaseModel):
    week_start: str   # ISO date string YYYY-MM-DD
    complaint_type: str
    count: int


@quality_router.post("/api/quality/complaints")
def post_complaint(body: ComplaintIn):
    """Manual complaint entry — inserts into quality_complaints Postgres table."""
    try:
        ws = date.fromisoformat(body.week_start)
    except ValueError:
        raise HTTPException(status_code=422, detail="week_start must be YYYY-MM-DD")
    with _get_conn() as conn:
        _ensure_quality_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO quality_complaints (week_start, complaint_type, count) "
                "VALUES (%s, %s, %s)",
                (ws.isoformat(), body.complaint_type.strip(), max(0, body.count)),
            )
        conn.commit()
    return {"ok": True}


# ── Washing endpoint ──────────────────────────────────────────────────────────

def _washing_from_sheet(sheet_id, tab, headers):
    rows = _gsheet_values(sheet_id, tab, "A1:Z5000")
    if not rows or len(rows) < 2:
        return []

    date_col = _col_index(headers, "date")
    week_col = _col_index(headers, "week")
    wash_col = _col_index(headers, "washing_qty")
    prod_col = _col_index(headers, "production")

    bucket: dict = {}  # week_start_iso -> {washing, production}

    for row in rows[1:]:
        def cell(i):
            return row[i].strip() if i >= 0 and i < len(row) else ""

        ws = None
        if date_col >= 0:
            d = _parse_date(cell(date_col))
            if d:
                ws = _week_start(d).isoformat()
        if not ws and week_col >= 0:
            d = _parse_date(cell(week_col))
            if d:
                ws = _week_start(d).isoformat()
        if not ws:
            continue

        try:
            wqty = float(cell(wash_col)) if wash_col >= 0 and cell(wash_col) else 0
        except ValueError:
            wqty = 0
        try:
            pqty = float(cell(prod_col)) if prod_col >= 0 and cell(prod_col) else 0
        except ValueError:
            pqty = 0

        b = bucket.setdefault(ws, {"washing_qty": 0, "production_qty": 0})
        b["washing_qty"] += wqty
        b["production_qty"] += pqty

    result = []
    for ws in sorted(bucket.keys()):
        b = bucket[ws]
        result.append({"week_start": ws, **b})
    return result


@quality_router.get("/api/quality/washing")
def get_washing():
    """Washing qty vs production per week.
    Falls back to Postgres quality_washing when no sheet tab found."""
    sheet_data = None
    has_sheet = False
    try:
        tabs = _discover_sheet(QUALITY_SHEET_ID)
        tab, headers = _find_tab(tabs, {"washing_qty"})
        if tab:
            rows = _washing_from_sheet(QUALITY_SHEET_ID, tab, headers)
            if rows:
                sheet_data = rows
                has_sheet = True
    except Exception as e:
        log.warning("quality washing: sheet read failed: %s", e)

    if has_sheet:
        return {"data": sheet_data, "has_data": True, "source": "sheet"}

    # Fall back to Postgres
    with _get_conn() as conn:
        _ensure_quality_tables(conn)
        rows = _q(conn, """
            SELECT week_start::text, SUM(washing_qty) AS washing_qty,
                   SUM(production_qty) AS production_qty
            FROM quality_washing
            GROUP BY week_start
            ORDER BY week_start
        """)

    data = [{
        "week_start": r["week_start"],
        "washing_qty": float(r["washing_qty"] or 0),
        "production_qty": float(r["production_qty"] or 0),
    } for r in rows]
    return {"data": data, "has_data": bool(data), "source": "db"}


class WashingIn(BaseModel):
    week_start: str
    washing_qty: float
    production_qty: float


@quality_router.post("/api/quality/washing")
def post_washing(body: WashingIn):
    """Manual washing entry — inserts into quality_washing Postgres table."""
    try:
        ws = date.fromisoformat(body.week_start)
    except ValueError:
        raise HTTPException(status_code=422, detail="week_start must be YYYY-MM-DD")
    with _get_conn() as conn:
        _ensure_quality_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO quality_washing (week_start, washing_qty, production_qty) "
                "VALUES (%s, %s, %s)",
                (ws.isoformat(), max(0, body.washing_qty), max(0, body.production_qty)),
            )
        conn.commit()
    return {"ok": True}
