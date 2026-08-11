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
import os, sys, requests, datetime as dt
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
ORDER_DATE_HEADERS = {"order creation date"}
ORDER_QTY_HEADERS  = {"order qty"}


def _connector_access_token():
    conn = psycopg2.connect(os.environ["DATABASE_URL"]); conn.autocommit = True
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    def q(sql, args=None):
        cur.execute(sql, args or ()); return cur.fetchall()
    rows = q("""SELECT settings->>'access_token' AS tok
                FROM connection WHERE connector_names && ARRAY['google-sheet']
                ORDER BY updated_at DESC LIMIT 1""")
    if not rows:  # HR-version fallback: unfiltered
        rows = q("""SELECT settings->>'access_token' AS tok
                    FROM connection WHERE settings ? 'access_token'
                    ORDER BY updated_at DESC LIMIT 1""")
    conn.close()
    if not rows or not rows[0]["tok"]:
        raise RuntimeError("No google-sheet connector access token found")
    return rows[0]["tok"]


def _read_tab(tab, token):
    """Return list of (style_number, style_name, order_date_raw, order_qty_raw) from one tab."""
    H = {"Authorization": f"Bearer {token}"}
    # pull a generous range; header on row 1
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{requests.utils.quote(tab)}!A1:AF20000"
    r = requests.get(url, headers=H, timeout=120)
    r.raise_for_status()
    vals = r.json().get("values", [])
    if not vals:
        return []
    header = [ _norm(h) for h in vals[0] ]
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
        print(f"  WARN '{tab}': no Style number column found; skipping", file=sys.stderr)
        return []
    out = []
    for row in vals[1:]:
        def cell(i):
            return (row[i].strip() if i is not None and i < len(row) and row[i] is not None else "")
        sn = cell(i_no); nm = cell(i_name); od = cell(i_date); oq = cell(i_qty)
        if not sn and not nm and not od and not oq:
            continue  # fully blank line
        out.append((sn, nm, od, oq))
    return out


def _parse_date(s):
    if not s:
        return None
    s = s.strip()
    # Google Sheets values API returns display strings; try common formats + serials
    fmts = ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%d-%b-%y",
            "%Y/%m/%d", "%d %B %Y", "%d %b %Y"]
    for f in fmts:
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            pass
    # serial number (days since 1899-12-30, the Sheets/Excel epoch)
    try:
        n = float(s)
        if 1 < n < 100000:
            return (dt.date(1899, 12, 30) + dt.timedelta(days=int(n)))
    except ValueError:
        pass
    return None


def _parse_qty(s):
    if not s:
        return None
    s = str(s).strip().replace(",", "")
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def main():
    token = _connector_access_token()
    all_rows = []
    for tab, year in TABS.items():
        rows = _read_tab(tab, token)
        print(f"  '{tab}': {len(rows)} rows")
        for sn, nm, od, oq in rows:
            all_rows.append((sn, nm, _parse_date(od), _parse_qty(oq), year))
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
