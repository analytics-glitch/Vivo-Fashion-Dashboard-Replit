"""
Load the buying team's reconciled fabric consumption & returns (Jan–Apr 2026) from
Google Sheets into the `fabric_sheet_consumption` / `fabric_sheet_returns` override
tables, then (re)create the `fabric_moves_effective` view.

These override Odoo's inflated Jan–Apr 2026 moves (see fabric_sheet_override.py). The
tables live outside `raw_fabric_*` so they survive the hourly Odoo TRUNCATE/rebuild.
Run is a full refresh (TRUNCATE + reload), so it is safe to re-run; sync_incremental
runs it on bootstrap and hourly, mirroring the Odoo fabric extract.

Self-contained: only needs `requests`, `psycopg2`, stdlib. The two Google-Sheets
helpers are replicated from hr_attendance.py so importing this script has no side
effects.
"""
import os
import sys
from datetime import datetime

import requests
import psycopg2

import fabric_sheet_override as ov

SHEET_ID = "1C5m8RCMA_WHn-oywZCtyVPFH-32AYRjI3M7ZlB7Z1_Q"
CONSUMPTION_TAB = "Consumption Jan_April 2026"
RETURNS_TAB = "Returns Feb_April 2026"


# ── Google Sheets access (replicated from hr_attendance.py) ──────────────────
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
        raise RuntimeError(f"No connection configured for connector '{connector}'")
    settings = items[0].get("settings") or {}
    tok = settings.get("access_token")
    if not tok:
        tok = (((settings.get("oauth") or {}).get("credentials") or {})
               .get("access_token"))
    if not tok:
        raise RuntimeError("No access_token in connector settings")
    return tok


def _gsheet_values(sheet_id, tab, rng="A1:F20000"):
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


def _parse_month(s):
    """Map the sheet's Month column (e.g. 'Jan-26') to the first of that month.
    The Month column is authoritative; the Day column is unreliable."""
    s = _clean(s)
    if not s:
        return None
    for fmt in ("%b-%y", "%b-%Y", "%B-%y", "%B-%Y"):
        try:
            return datetime.strptime(s, fmt).date().replace(day=1)
        except ValueError:
            continue
    return None


def _parse_kg(s):
    s = _clean(s).replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_rows(values):
    """Sheet matrix → [(month_start, barcode|None, title, kg)] keeping unmatched/
    blank-barcode rows (they still count in aggregate totals)."""
    out = []
    if not values:
        return out
    # Skip the header row (first row holds the column names).
    for row in values[1:]:
        # Columns: Day, Month, Barcode, Product title, Kgs, Mtrs
        month = _parse_month(row[1] if len(row) > 1 else "")
        kg = _parse_kg(row[4] if len(row) > 4 else "")
        if month is None or kg is None or kg == 0:
            continue
        barcode = _clean(row[2] if len(row) > 2 else "") or None
        title = _clean(row[3] if len(row) > 3 else "") or None
        out.append((month, barcode, title, kg))
    return out


# ── Load ─────────────────────────────────────────────────────────────────────
def _refresh_table(cur, table, rows):
    cur.execute(f"TRUNCATE {table} RESTART IDENTITY")
    if rows:
        cur.executemany(
            f"INSERT INTO {table} (month_start, barcode, product_title, kg) "
            f"VALUES (%s,%s,%s,%s)",
            rows,
        )
    return len(rows)


def main():
    cons_rows = _parse_rows(_gsheet_values(SHEET_ID, CONSUMPTION_TAB))
    ret_rows = _parse_rows(_gsheet_values(SHEET_ID, RETURNS_TAB))
    print(f"Parsed consumption rows: {len(cons_rows)}")
    print(f"Parsed returns rows: {len(ret_rows)}")

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            ov.ensure_tables(cur)
            n_cons = _refresh_table(cur, "fabric_sheet_consumption", cons_rows)
            n_ret = _refresh_table(cur, "fabric_sheet_returns", ret_rows)
            if ov.base_tables_exist(cur):
                ov.ensure_view(cur)
                print("fabric_moves_effective view ready")
            else:
                print("raw_fabric_* not present yet — view deferred to API/next run")
        conn.commit()
        print(f"Loaded {n_cons} consumption + {n_ret} returns sheet rows")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fabric sheet extract failed: {e}", file=sys.stderr)
        sys.exit(1)
