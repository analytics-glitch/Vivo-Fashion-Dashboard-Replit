"""
Load the production team's hourly output board from Google Sheets into the
`production_hourly` table, so the dashboard can show live actual-vs-target and
a projected end-of-day landing.

Mirrors the sheet the team already keeps on a whiteboard (Time slot | Target |
Actual | Style). Entry is PER HOUR (pieces made that hour), not cumulative.
Working window is 08:00-17:00 with a 13:00-14:00 lunch break = 8 productive
hours; hourly target 90 => daily target 720.

Self-contained: needs `requests`, `psycopg2`, stdlib only. The Google-Sheets
helpers are replicated from extract_fabric_sheet.py / hr_attendance.py so
importing this script has no side effects. Full refresh (TRUNCATE + reload),
safe to re-run; sync_incremental runs it on bootstrap and on a short interval.
"""

import os
import sys
from datetime import datetime

import requests
import psycopg2

# ── CONFIG ───────────────────────────────────────────────────────────────────
# Set PRODUCTION_SHEET_ID as a Replit secret (or replace the default below).
SHEET_ID = os.environ.get("PRODUCTION_SHEET_ID", "PUT_YOUR_SHEET_ID_HERE")
TAB = os.environ.get("PRODUCTION_SHEET_TAB", "Production")

# The 8 productive slots (lunch 13:00-14:00 excluded), in order. Used to
# normalise whatever the team types in the Time column and to know the full
# day's slot count for the projection.
CANONICAL_SLOTS = [
    "8:00-9:00",
    "9:00-10:00",
    "10:00-11:00",
    "11:00-12:00",
    "12:00-1:00",
    "2:00-3:00",
    "3:00-4:00",
    "4:00-5:00",
]
PRODUCTIVE_HOURS = len(CANONICAL_SLOTS)  # 8


# ── Google Sheets access (replicated from extract_fabric_sheet.py) ───────────
def _connector_access_token(connector="google-sheet"):
    host = os.environ["REPLIT_CONNECTORS_HOSTNAME"]
    repl_identity = os.environ.get("REPL_IDENTITY")
    web_renewal = os.environ.get("WEB_REPL_RENEWAL")
    if repl_identity:
        xtok = "repl " + repl_identity
    elif web_renewal:
        xtok = "depl " + web_renewal
    else:
        raise RuntimeError("No REPL_IDENTITY / WEB_REPL_RENEWAL for connector auth")
    r = requests.get(
        f"https://{host}/api/v2/connection",
        params={"include_secrets": "true", "connector_names": connector},
        headers={"Accept": "application/json", "X_REPLIT_TOKEN": xtok},
        timeout=20,
    )
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    if not items:
        # The proxy's connector_names filter can return [] even when the
        # connection exists. Fall back to the unfiltered list, match by name.
        r = requests.get(
            f"https://{host}/api/v2/connection",
            params={"include_secrets": "true"},
            headers={"Accept": "application/json", "X_REPLIT_TOKEN": xtok},
            timeout=20,
        )
        r.raise_for_status()
        items = [i for i in ((r.json() or {}).get("items") or [])
                 if (i.get("connector_name") or i.get("connectorName")) == connector]
    if not items:
        raise RuntimeError(f"No connection configured for connector '{connector}'")
    settings = items[0].get("settings") or {}
    tok = settings.get("access_token")
    if not tok:
        tok = ((settings.get("oauth") or {}).get("credentials") or {}).get(
            "access_token"
        )
    if not tok:
        raise RuntimeError("No access_token in connector settings")
    return tok


def _gsheet_values(sheet_id, tab, rng="A1:H20000"):
    tok = _connector_access_token("google-sheet")
    range_q = requests.utils.quote(f"{tab}!{rng}", safe="")
    r = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{range_q}",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    r.raise_for_status()
    return (r.json() or {}).get("values") or []


# ── Parsing ──────────────────────────────────────────────────────────────────
def _clean(v):
    return v.strip() if isinstance(v, str) else ("" if v is None else str(v).strip())


def _parse_date(s):
    """Accept common date formats the team might type."""
    s = _clean(s)
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _norm_slot(s):
    """Normalise the Time column to one of CANONICAL_SLOTS. Tolerates AM/PM,
    spaces, en-dashes, and 'to'."""
    s = _clean(s).upper().replace("–", "-").replace("—", "-")
    s = s.replace(" TO ", "-").replace("AM", "").replace("PM", "").strip()
    s = s.replace(" ", "")
    # Match against canonical by stripping the same way
    for canon in CANONICAL_SLOTS:
        c = canon.replace(" ", "")
        if s == c:
            return canon
    return None


def _to_int(v):
    v = _clean(v)
    if not v:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _parse_rows(values):
    """Sheet columns (header row 1):
       Sewing Line | Date | Time Slot | Target | Actual | Style
    Returns (sewing_line, work_date, slot, slot_index, target, actual, style)."""
    rows = []
    if not values:
        return rows
    body = values[1:] if values and any("date" in _clean(c).lower() for c in values[0]) else values
    for r in body:
        r = list(r) + [""] * (6 - len(r))  # pad to 6 cols
        line = _clean(r[0]) or "A"
        work_date = _parse_date(r[1])
        slot = _norm_slot(r[2])
        target = _to_int(r[3])
        actual = _to_int(r[4])
        style = _clean(r[5])
        if not work_date or not slot:
            continue
        slot_index = CANONICAL_SLOTS.index(slot)
        rows.append((line, work_date, slot, slot_index, target, actual, style))
    return rows


# ── DDL + Load ───────────────────────────────────────────────────────────────
def ensure_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS production_hourly (
            sewing_line text    NOT NULL DEFAULT 'A',
            work_date   date    NOT NULL,
            slot        text    NOT NULL,
            slot_index  int     NOT NULL,
            target      int,
            actual      int,
            style       text,
            loaded_at   timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (sewing_line, work_date, slot)
        )
    """)


def _refresh_table(cur, rows):
    cur.execute("TRUNCATE production_hourly")
    if rows:
        cur.executemany(
            "INSERT INTO production_hourly "
            "(sewing_line, work_date, slot, slot_index, target, actual, style) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            rows,
        )
    return len(rows)


def main():
    rows = _parse_rows(_gsheet_values(SHEET_ID, TAB))
    print(f"Parsed production rows: {len(rows)}")
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            ensure_table(cur)
            n = _refresh_table(cur, rows)
        conn.commit()
        print(f"Loaded {n} production_hourly rows")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Production tracker extract failed: {e}", file=sys.stderr)
        sys.exit(1)
