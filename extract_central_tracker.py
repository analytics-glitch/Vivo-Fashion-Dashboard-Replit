"""
Extract Style Name, Style Number, Order Creation Date from the
'Central Tracker - 2026' Google Sheet (4 year tabs) into PostgreSQL.

Full reload each run (TRUNCATE + insert) — the sheet is edited in place,
so a full mirror is always exact. ~9k rows, cheap.

Env: DATABASE_URL, plus the 'google-sheet' connector (auth via the
HR-version fallback, same as hr_attendance.py).

Table: central_tracker_orders
  style_number  text
  style_name    text
  order_date    date        (parsed from 'Order Creation Date'; NULL if unparseable)
  source_year   text        (which tab the row came from)
  _loaded_at    timestamptz
"""
import io, os, sys, requests, datetime as dt
import openpyxl
import psycopg2, psycopg2.extras

SHEET_ID = os.environ.get("CENTRAL_TRACKER_SHEET_ID", "1GlH4njBb3IfRtw1ojrbA4TLxqH1zfWVg")

# tab -> friendly source_year label
TABS = {
    " 2026 Central tracker":     "2026",
    "2025 Central tracker":      "2025",
    "Central tracker2024":       "2024",
    "Central tracker PRE 2024":  "PRE2024",
}

# header matching (case/space-insensitive); accept either 'Product Name'/'Product Names'
def _norm(h): return str(h).strip().lower()
STYLE_NO_HEADERS   = {"style number"}
STYLE_NAME_HEADERS = {"product name", "product names"}
ORDER_DATE_HEADERS = {"order creation date", "order date"}
ORDER_QTY_HEADERS  = {"order qty"}


def _connector_access_token(connector="google-sheet"):
    """Fetch a live OAuth access token via the Replit connectors proxy.

    Mirrors extract_fabric_sheet.py / hr_attendance.py. Falls back to the
    unfiltered connection list when the connector_names filter returns [] (a
    known proxy quirk documented in .agents/memory/connectors-proxy-name-filter.md).
    """
    hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME", "")
    if not hostname:
        raise RuntimeError("REPLIT_CONNECTORS_HOSTNAME is not set")
    repl_identity = os.environ.get("REPL_IDENTITY")
    web_renewal   = os.environ.get("WEB_REPL_RENEWAL")
    if repl_identity:
        xtok = "repl " + repl_identity
    elif web_renewal:
        xtok = "depl " + web_renewal
    else:
        raise RuntimeError("No REPL_IDENTITY / WEB_REPL_RENEWAL for connector auth")

    headers = {"Accept": "application/json", "X_REPLIT_TOKEN": xtok}

    def _tok_from_items(items):
        for item in items:
            s = item.get("settings") or {}
            tok = s.get("access_token") or (
                ((s.get("oauth") or {}).get("credentials") or {}).get("access_token"))
            if tok:
                return tok
        return None

    # Primary: filtered request
    r = requests.get(
        f"https://{hostname}/api/v2/connection",
        params={"include_secrets": "true", "connector_names": connector},
        headers=headers, timeout=20,
    )
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    tok = _tok_from_items(items)
    if tok:
        return tok

    # Fallback: unfiltered list + client-side match
    r2 = requests.get(
        f"https://{hostname}/api/v2/connection",
        params={"include_secrets": "true"},
        headers=headers, timeout=20,
    )
    r2.raise_for_status()
    all_items = (r2.json() or {}).get("items") or []
    matching = [i for i in all_items
                if (i.get("connector_name") or i.get("connectorName")) == connector]
    tok = _tok_from_items(matching or all_items)  # last-resort: any token
    if tok:
        return tok
    raise RuntimeError(f"No '{connector}' connection / access_token found")


def _download_workbook(token):
    """Download the Central Tracker xlsx via the Google Docs export URL and
    return an openpyxl workbook. The Sheets API rejects xlsx (Office) files
    with FAILED_PRECONDITION; the export URL works with the same OAuth token."""
    r = requests.get(
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export",
        params={"format": "xlsx"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=120, allow_redirects=True,
    )
    r.raise_for_status()
    return openpyxl.load_workbook(io.BytesIO(r.content), read_only=True, data_only=True)


def _read_tab(ws):
    """Return list of (style_number, style_name, order_date_raw, order_qty_raw)
    from one openpyxl worksheet."""
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header_raw = next(rows_iter)
    except StopIteration:
        return []
    header = [_norm(h) for h in header_raw]

    def col_idx(candidates):
        for i, h in enumerate(header):
            if h in candidates:
                return i
        return None

    i_no   = col_idx(STYLE_NO_HEADERS)
    i_name = col_idx(STYLE_NAME_HEADERS)
    i_date = col_idx(ORDER_DATE_HEADERS)
    i_qty  = col_idx(ORDER_QTY_HEADERS)
    if i_no is None:
        print(f"  WARN sheet '{ws.title}': no Style number column; skipping", file=sys.stderr)
        return []

    def cell(row, i):
        if i is None or i >= len(row):
            return None
        return row[i]

    out = []
    for row in rows_iter:
        sn = cell(row, i_no)
        nm = cell(row, i_name)
        od = cell(row, i_date)
        oq = cell(row, i_qty)
        # skip fully blank lines
        if not any([sn, nm, od, oq]):
            continue
        out.append((sn, nm, od, oq))
    return out


def _parse_date(v):
    """Coerce an openpyxl cell value to a Python date (or None).

    openpyxl returns:
      • datetime.datetime / datetime.date objects for formatted date cells
      • float (Excel serial) for some date cells without explicit format
      • str for text-formatted cells
      • None for blank cells
    """
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    # Excel serial number (days since 1899-12-30)
    if isinstance(v, (int, float)):
        try:
            n = float(v)
            if 1 < n < 100000:
                return dt.date(1899, 12, 30) + dt.timedelta(days=int(n))
        except (ValueError, OverflowError):
            pass
        return None
    # String fallback
    s = str(v).strip()
    if not s:
        return None
    fmts = ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%d-%b-%y",
            "%Y/%m/%d", "%d %B %Y", "%d %b %Y"]
    for f in fmts:
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            pass
    return None


def _parse_qty(v):
    """Coerce an openpyxl cell value to an integer quantity (or None)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        try:
            return int(round(float(v)))
        except (ValueError, OverflowError):
            return None
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def main():
    token = _connector_access_token()
    # Download the xlsx once (the Sheets API rejects xlsx/Office files).
    wb = _download_workbook(token)
    all_rows = []
    for tab, year in TABS.items():
        if tab not in wb.sheetnames:
            print(f"  WARN tab '{tab}' not found in workbook; skipping", file=sys.stderr)
            continue
        ws = wb[tab]
        rows = _read_tab(ws)
        print(f"  '{tab}': {len(rows)} rows")
        for sn, nm, od, oq in rows:
            all_rows.append((
                str(sn).strip() if sn is not None else None,
                str(nm).strip() if nm is not None else None,
                _parse_date(od),
                _parse_qty(oq),
                year,
            ))
    print(f"TOTAL rows: {len(all_rows)}")

    conn = psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit = False
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS central_tracker_orders (
            style_number text,
            style_name   text,
            order_date   date,
            order_qty    integer,
            source_year  text,
            _loaded_at   timestamptz DEFAULT now()
        )""")
    cur.execute("ALTER TABLE central_tracker_orders ADD COLUMN IF NOT EXISTS order_qty integer")
    cur.execute("TRUNCATE central_tracker_orders")
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO central_tracker_orders (style_number, style_name, order_date, order_qty, source_year) VALUES %s",
        all_rows, page_size=1000)
    # helpful index for lookups by style number / date
    cur.execute("CREATE INDEX IF NOT EXISTS idx_cto_style ON central_tracker_orders(style_number)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_cto_date  ON central_tracker_orders(order_date)")
    conn.commit()
    cur.execute("SELECT COUNT(*), COUNT(order_date), MIN(order_date), MAX(order_date) FROM central_tracker_orders")
    n, nd, mn, mx = cur.fetchone()
    conn.close()
    print(f"Loaded {n} rows ({nd} with a parseable order_date). Date range: {mn} .. {mx}")


if __name__ == "__main__":
    main()
