"""Fabric Category Update Tracker (Task #295).

Automatically tracks every fabric product whose Odoo Category (x_vivo_attr_102)
or Sub-Category (x_vivo_attr_103) is changed from go-live onward, and mirrors a
running tracker to a Google Sheet created in the user's Google Drive (My Drive
root). Keyed by barcode (default_code fallback).

Design notes
------------
* The deliverable is the Google Sheet only — no BI page/column.
* Detection is automatic, driven by Odoo `write_date` (pulled into
  raw_fabric_products by extract_fabric.py).
* Cut-off = start of today (Africa/Nairobi), captured ONCE at go-live and frozen
  (never rolls forward). A one-time baseline snapshot of every fabric product's
  (barcode, category, subcategory) is captured at the same moment.
* Idempotent and safe to re-run; one row per barcode.
* Drive/Sheets is best-effort: a Google API hiccup logs a warning and the DB
  detection still succeeds (so a publish never blocks on Google).
* Production is a SEPARATE DB and the agent cannot write to it — on first run
  post-publish the baseline/cut-off + the spreadsheet bootstrap themselves.
  Because dev and prod share the SAME Google account + OAuth app, the sheet is
  found by name (drive.file only lists files this app created) and reused, so the
  dev and prod sync loops never create duplicates.

Auth
----
* The sheet is created in My Drive root and written to using the `google-sheet`
  connector token alone (it carries `drive.file` for creating/listing files this
  app owns + `spreadsheets` for value writes). No full-Drive scope is needed
  because we never write into a pre-existing user folder. The user moves the
  resulting sheet into their preferred Drive folder manually (one-time).
"""
import os
import time
import logging
import datetime as dt

import psycopg2
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fabric_cat_tracker")

DATABASE_URL = os.environ["DATABASE_URL"]

# The user's preferred Drive folder (they move the sheet here manually one-time).
# We do NOT write into it (would need full-Drive scope); kept here for reference.
PREFERRED_FOLDER_ID = "1zn1h_pdWJeq4JHU6R0sB_OVvpNskEzol"
TRACKER_SHEET_NAME = "Fabric Category Update Tracker"
SHEET_TAB = "Sheet1"
HEADER = ["Barcode", "Category", "Sub-Category", "Status", "Updated At (EAT)"]
STATUS_LABEL = "\u2705 Updated"  # ✅ Updated

# barcode key: prefer the displayed BARCODE, fall back to default_code, then a
# stable odoo-id sentinel so null-barcode products never collapse into one row.
_KEY_SQL = (
    "COALESCE(NULLIF(BTRIM(p.barcode),''), "
    "NULLIF(BTRIM(p.default_code),''), 'odoo:'||p.id::text)"
)


# --------------------------------------------------------------------------- #
# Google auth (connector token) — self-contained so this runs as a lightweight
# subprocess without importing the FastAPI app module.
# --------------------------------------------------------------------------- #
def _connector_access_token(connector: str) -> str:
    hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME")
    x_token = os.environ.get("REPL_IDENTITY") or os.environ.get("WEB_REPL_RENEWAL")
    if not hostname or not x_token:
        raise RuntimeError("connector auth env not available (REPLIT_CONNECTORS_HOSTNAME / REPL_IDENTITY)")
    prefix = "repl " if os.environ.get("REPL_IDENTITY") else "depl "
    r = requests.get(
        f"https://{hostname}/api/v2/connection",
        params={"include_secrets": "true", "connector_names": connector},
        headers={"Accept": "application/json", "X_REPLIT_TOKEN": prefix + x_token},
        timeout=30,
    )
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    if not items:
        raise RuntimeError(f"no '{connector}' connection configured")
    settings = items[0].get("settings") or {}
    tok = settings.get("access_token") or (settings.get("oauth") or {}).get("credentials", {}).get("access_token")
    if not tok:
        raise RuntimeError(f"no access_token on '{connector}' connection")
    return tok


# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #
def ensure_tables(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_cat_tracker_meta (
                id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                cutoff_date         DATE,
                baseline_captured_at TIMESTAMPTZ,
                drive_folder_id     TEXT,
                sheet_id            TEXT,
                sheet_tab           TEXT,
                last_synced_at      TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS fabric_cat_baseline (
                barcode_key TEXT PRIMARY KEY,
                category    TEXT,
                subcategory TEXT
            );
            CREATE TABLE IF NOT EXISTS fabric_cat_tracker (
                barcode_key TEXT PRIMARY KEY,
                barcode     TEXT,
                category    TEXT,
                subcategory TEXT,
                updated_at  TIMESTAMPTZ
            );
        """)
        cur.execute("INSERT INTO fabric_cat_tracker_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
    conn.commit()


# --------------------------------------------------------------------------- #
# Baseline + frozen cut-off (captured once)
# --------------------------------------------------------------------------- #
def capture_baseline_if_needed(conn) -> bool:
    """Capture the frozen cut-off date + one-time baseline snapshot, atomically,
    only if not already captured AND raw_fabric_products has data.
    Returns True if it captured this run."""
    with conn.cursor() as cur:
        cur.execute("SELECT cutoff_date FROM fabric_cat_tracker_meta WHERE id = 1")
        row = cur.fetchone()
        if row and row[0] is not None:
            return False  # already frozen — never re-capture
        cur.execute("SELECT to_regclass('public.raw_fabric_products')")
        if cur.fetchone()[0] is None:
            return False
        cur.execute("SELECT COUNT(*) FROM raw_fabric_products")
        if cur.fetchone()[0] == 0:
            log.info("baseline deferred: raw_fabric_products is empty")
            return False

        # One atomic transaction: snapshot every fabric product's current
        # (barcode, category, subcategory) and freeze cut-off=today (Nairobi).
        cur.execute(f"""
            INSERT INTO fabric_cat_baseline (barcode_key, category, subcategory)
            SELECT DISTINCT ON (key) key, fabric_category, fabric_subcategory
            FROM (
                SELECT {_KEY_SQL} AS key, p.fabric_category, p.fabric_subcategory, p.id
                FROM raw_fabric_products p
            ) s
            ORDER BY key, id
            ON CONFLICT (barcode_key) DO NOTHING
        """)
        cur.execute("""
            UPDATE fabric_cat_tracker_meta
               SET cutoff_date = (now() AT TIME ZONE 'Africa/Nairobi')::date,
                   baseline_captured_at = now()
             WHERE id = 1
        """)
    conn.commit()
    log.info("✅ baseline captured + cut-off frozen (start of today, Africa/Nairobi)")
    return True


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #
def run_detection(conn) -> int:
    """Upsert one tracker row per fabric product whose Odoo write_date is on/after
    the frozen cut-off AND which is either an edit made before the baseline was
    captured (trust write_date) or differs from the baseline (category/sub-cat
    change). Returns the current total tracked count."""
    with conn.cursor() as cur:
        cur.execute("SELECT cutoff_date, baseline_captured_at FROM fabric_cat_tracker_meta WHERE id = 1")
        meta = cur.fetchone()
        if not meta or meta[0] is None or meta[1] is None:
            log.info("detection skipped: baseline/cut-off not captured yet")
            return 0
        cutoff_date, baseline_at = meta

        # write_date is stored naive-UTC; interpret as UTC for all comparisons.
        cur.execute(f"""
            INSERT INTO fabric_cat_tracker (barcode_key, barcode, category, subcategory, updated_at)
            SELECT key, key, category, subcategory, wd
            FROM (
                SELECT
                    {_KEY_SQL} AS key,
                    p.fabric_category AS category,
                    p.fabric_subcategory AS subcategory,
                    (p.write_date AT TIME ZONE 'UTC') AS wd,
                    b.category AS b_cat,
                    b.subcategory AS b_sub
                FROM raw_fabric_products p
                JOIN fabric_cat_baseline b ON b.barcode_key = {_KEY_SQL}
                WHERE p.write_date IS NOT NULL
                  AND (p.write_date AT TIME ZONE 'UTC')
                      >= (%(cutoff)s::timestamp AT TIME ZONE 'Africa/Nairobi')
            ) s
            WHERE s.wd < %(baseline_at)s
               OR s.category IS DISTINCT FROM s.b_cat
               OR s.subcategory IS DISTINCT FROM s.b_sub
            ON CONFLICT (barcode_key) DO UPDATE SET
                barcode     = EXCLUDED.barcode,
                category    = EXCLUDED.category,
                subcategory = EXCLUDED.subcategory,
                updated_at  = EXCLUDED.updated_at
        """, {"cutoff": cutoff_date, "baseline_at": baseline_at})
        cur.execute("SELECT COUNT(*) FROM fabric_cat_tracker")
        total = cur.fetchone()[0]
    conn.commit()
    log.info("✅ detection complete — %d fabric products tracked as updated", total)
    return total


# --------------------------------------------------------------------------- #
# Google Drive + Sheets (best-effort)
# --------------------------------------------------------------------------- #
def _drive_get(token, path, params=None):
    r = requests.get(f"https://www.googleapis.com/drive/v3/{path}",
                     headers={"Authorization": f"Bearer {token}"},
                     params=params or {}, timeout=60)
    r.raise_for_status()
    return r.json()


def _drive_post(token, path, body, params=None):
    r = requests.post(f"https://www.googleapis.com/drive/v3/{path}",
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                      params=params or {}, json=body, timeout=60)
    if not r.ok:
        raise RuntimeError(f"Drive {path} -> {r.status_code}: {r.text[:300]}")
    return r.json()


def _find_file(token, name, mime):
    """Find a file by name+mime owned by this app. drive.file scope only ever
    lists files this OAuth app created, so a name match is our own tracker sheet
    (dev/prod share the same account+app) — no parent constraint needed."""
    safe = name.replace("'", "\\'")
    q = f"name = '{safe}' and mimeType = '{mime}' and trashed = false"
    res = _drive_get(token, "files", {"q": q, "fields": "files(id,name)",
                                      "spaces": "drive", "pageSize": 10})
    files = res.get("files") or []
    return files[0]["id"] if files else None


def ensure_sheet_target(conn) -> bool:
    """Idempotently ensure the tracker spreadsheet exists in My Drive root
    (search-or-create, so dev/prod never duplicate) and persist its id. Uses the
    `google-sheet` connector token only (drive.file creates a file this app owns;
    no full-Drive scope needed). Returns True when the sheet id is present."""
    with conn.cursor() as cur:
        cur.execute("SELECT sheet_id FROM fabric_cat_tracker_meta WHERE id = 1")
        (sheet_id,) = cur.fetchone()
    if sheet_id:
        return True

    token = _connector_access_token("google-sheet")
    sheet_mime = "application/vnd.google-apps.spreadsheet"

    sheet_id = _find_file(token, TRACKER_SHEET_NAME, sheet_mime)
    if sheet_id:
        log.info("reusing tracker spreadsheet %s", sheet_id)
    else:
        created = _drive_post(token, "files",
                              {"name": TRACKER_SHEET_NAME, "mimeType": sheet_mime},
                              {"fields": "id"})
        sheet_id = created["id"]
        log.info("✅ created tracker spreadsheet %s (My Drive root)", sheet_id)

    with conn.cursor() as cur:
        cur.execute("""
            UPDATE fabric_cat_tracker_meta
               SET sheet_id = %s, sheet_tab = %s
             WHERE id = 1
        """, (sheet_id, SHEET_TAB))
    conn.commit()
    return bool(sheet_id)


def mirror_to_sheet(conn):
    """Push the full current tracker to the Google Sheet, replacing the data range
    so it always reflects live state. Best-effort: never raises out of the loop."""
    with conn.cursor() as cur:
        cur.execute("SELECT sheet_id, sheet_tab FROM fabric_cat_tracker_meta WHERE id = 1")
        row = cur.fetchone()
        if not row or not row[0]:
            log.warning("mirror skipped: no sheet_id yet")
            return
        sheet_id, sheet_tab = row[0], (row[1] or SHEET_TAB)
        cur.execute("""
            SELECT barcode, category, subcategory,
                   to_char(updated_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI:SS')
            FROM fabric_cat_tracker
            ORDER BY updated_at DESC
        """)
        data = cur.fetchall()

    values = [HEADER] + [
        [bc or "", cat or "", sub or "", STATUS_LABEL, ts or ""]
        for (bc, cat, sub, ts) in data
    ]

    sheets_token = _connector_access_token("google-sheet")
    base = f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}"
    headers = {"Authorization": f"Bearer {sheets_token}", "Content-Type": "application/json"}

    # Clear the data range first so a shrinking tracker never leaves stale rows.
    rc = requests.post(f"{base}/values/{sheet_tab}!A:E:clear", headers=headers, timeout=60)
    if not rc.ok:
        raise RuntimeError(f"sheet clear -> {rc.status_code}: {rc.text[:300]}")
    ru = requests.put(
        f"{base}/values/{sheet_tab}!A1",
        headers=headers,
        params={"valueInputOption": "RAW"},
        json={"values": values},
        timeout=120,
    )
    if not ru.ok:
        raise RuntimeError(f"sheet update -> {ru.status_code}: {ru.text[:300]}")

    with conn.cursor() as cur:
        cur.execute("UPDATE fabric_cat_tracker_meta SET last_synced_at = now() WHERE id = 1")
    conn.commit()
    log.info("✅ mirrored %d tracker rows to Google Sheet", len(data))


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run(conn):
    ensure_tables(conn)
    capture_baseline_if_needed(conn)
    run_detection(conn)
    # Drive/Sheets is best-effort — a Google hiccup (or google-sheet not yet
    # authorized) must not break the sync loop or the DB detection above.
    try:
        if ensure_sheet_target(conn):
            mirror_to_sheet(conn)
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        log.warning("Drive/Sheets mirror skipped (best-effort): %s", e)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        run(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
