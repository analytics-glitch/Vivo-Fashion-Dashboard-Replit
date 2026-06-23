"""Warehouse bin locations sourced from a daily-updated Google Sheet.

The warehouse maintains a NATIVE Google Sheet mapping each product BARCODE to its
physical warehouse BIN/location and refreshes it daily. This module mirrors that
sheet into a small Postgres table (``warehouse_bins``) which the Replenishment and
IBT endpoints LEFT JOIN by barcode so pickers see the live warehouse bin instead
of the generic ``all_inventory.location_name``.

Design notes:
  * Idempotent DDL — safe on the SEPARATE production DB on first boot.
  * Lazy, best-effort refresh (NEVER raises) on a ~1h interval, triggered from the
    endpoints that read bins.
  * An empty / unset ``WAREHOUSE_BINS_SHEET_ID`` is a no-op: the table stays empty,
    the JOIN finds nothing, and callers fall back to their previous bin value, so
    there is ZERO regression until the sheet link is connected.
  * Flexible header detection — the barcode + bin columns are located by header
    name, so the warehouse can reorder / rename columns without breaking the sync.

The Google Sheets access reuses the Replit ``google-sheet`` connector helpers in
``hr_attendance`` (works both in the workspace via REPL_IDENTITY and in a published
deployment via WEB_REPL_RENEWAL).
"""
import os
import re
import logging
import threading
from datetime import datetime, timezone

import requests
from psycopg2.extras import execute_values

from hr_attendance import _connector_access_token, _gsheet_values

log = logging.getLogger("warehouse_bins")

# Native Google Sheet (barcode -> bin) maintained daily by the warehouse.
# This is the canonical bin source and is ALWAYS used by default, so the sync works
# on a fresh deploy even if the WAREHOUSE_BINS_SHEET_ID secret is absent. The env
# var still wins if explicitly set, but it defaults to this exact spreadsheet + tab.
# https://docs.google.com/spreadsheets/d/1XiY1gRSqW2f3W_UJIp4_EcmW2QDjZfFhRyIkXppxq30/edit?gid=403172947
_DEFAULT_SHEET_ID = "1XiY1gRSqW2f3W_UJIp4_EcmW2QDjZfFhRyIkXppxq30"
_DEFAULT_SHEET_GID = "403172947"
SHEET_ID = os.environ.get("WAREHOUSE_BINS_SHEET_ID", "").strip() or _DEFAULT_SHEET_ID
# Worksheet selection. Priority: an explicit tab TITLE (WAREHOUSE_BINS_TAB), then a
# tab GID (WAREHOUSE_BINS_GID — the stable numeric id in a sheet URL's #gid=...),
# else auto-detect the first tab in the spreadsheet.
SHEET_TAB = os.environ.get("WAREHOUSE_BINS_TAB", "").strip()
SHEET_GID = os.environ.get("WAREHOUSE_BINS_GID", "").strip() or _DEFAULT_SHEET_GID
REFRESH_INTERVAL_SEC = int(os.environ.get("WAREHOUSE_BINS_REFRESH_SEC", str(3600)))

_refresh_lock = threading.Lock()

# Header tokens used to locate the relevant columns (case-insensitive, exact match
# preferred, then "contains").
_BARCODE_TOKENS = ("barcode", "bar code", "ean", "upc")
_BIN_TOKENS = ("bin", "location", "rack", "shelf", "slot", "position")


def _norm_header(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _norm_barcode(s):
    """Normalise a barcode cell to plain digits-as-text. Excel-origin sheets can
    surface barcodes as floats ('5.01E+12', '12345.0'); expand those so they match
    ``all_products_clean.barcode``."""
    v = str(s or "").strip()
    if not v:
        return ""
    if re.fullmatch(r"\d+\.0+", v):                      # 12345.0 -> 12345
        v = v.split(".")[0]
    elif re.fullmatch(r"\d+(\.\d+)?[eE]\+?\d+", v):       # 5.01E+12 -> 5010000000000
        try:
            v = str(int(float(v)))
        except (ValueError, OverflowError):
            pass
    return v.strip()


def ensure_table(conn):
    """Idempotently create the warehouse_bins table + its refresh-meta row."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS warehouse_bins (
                barcode    TEXT PRIMARY KEY,
                bin        TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS warehouse_bins_meta (
                id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                refreshed_at TIMESTAMPTZ,
                row_count    INT  NOT NULL DEFAULT 0,
                status       TEXT NOT NULL DEFAULT ''
            )
        """)
        cur.execute("INSERT INTO warehouse_bins_meta (id) VALUES (1) "
                    "ON CONFLICT (id) DO NOTHING")
    conn.commit()


def _resolve_tab(sheet_id):
    """Return (worksheet TITLE, grid row_count) to read. Priority: an explicit
    WAREHOUSE_BINS_TAB title (no API call needed → unknown row count), then a
    WAREHOUSE_BINS_GID match (resolved to its title via the sheet metadata), else
    the first tab in the spreadsheet. The row_count lets the caller fetch the WHOLE
    grid instead of a fixed cap — the Bins tab has tens of thousands of rows, so a
    too-small range silently drops every barcode past the cap."""
    if SHEET_TAB:
        return SHEET_TAB, None
    tok = _connector_access_token("google-sheet")
    r = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}",
        params={"fields": "sheets.properties(sheetId,title,gridProperties(rowCount))"},
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    r.raise_for_status()
    sheets = (r.json() or {}).get("sheets") or []
    if not sheets:
        raise RuntimeError("spreadsheet has no tabs")

    def _rc(s):
        return ((s["properties"].get("gridProperties") or {}).get("rowCount"))

    if SHEET_GID:
        for s in sheets:
            if str(s["properties"].get("sheetId")) == SHEET_GID:
                return s["properties"]["title"], _rc(s)
        raise RuntimeError(
            f"WAREHOUSE_BINS_GID={SHEET_GID} not found among "
            f"{[s['properties'].get('sheetId') for s in sheets]}")
    return sheets[0]["properties"]["title"], _rc(sheets[0])


def _parse_rows(values):
    """From a raw cell matrix, locate the barcode + bin columns by header name and
    return a list of (barcode, bins) tuples. When a barcode appears in multiple rows
    (or a single cell lists several bins), all DISTINCT bins are kept in first-seen
    order and joined by ', ' so pickers see every location for that barcode."""
    if not values:
        return []
    header = [_norm_header(c) for c in values[0]]

    def find_col(tokens):
        for i, h in enumerate(header):       # exact header match first
            if h in tokens:
                return i
        for i, h in enumerate(header):       # then "contains"
            if any(t in h for t in tokens):
                return i
        return -1

    bc = find_col(_BARCODE_TOKENS)
    bn = find_col(_BIN_TOKENS)
    if bc < 0 or bn < 0:
        raise RuntimeError(f"could not locate barcode/bin columns in headers={header!r}")
    out = {}
    for row in values[1:]:
        barcode = _norm_barcode(row[bc]) if len(row) > bc else ""
        binv = str(row[bn]).strip() if len(row) > bn else ""
        if not barcode:
            continue
        bins = out.setdefault(barcode, [])
        # A barcode may span several rows, and a single cell may itself list more
        # than one bin (comma / semicolon / newline separated). Collect distinct.
        for b in re.split(r"[,;\n]+", binv):
            b = b.strip()
            if b and b not in bins:
                bins.append(b)
    return [(barcode, ", ".join(bins)) for barcode, bins in out.items()]


def _is_stale(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT refreshed_at FROM warehouse_bins_meta WHERE id=1")
        row = cur.fetchone()
    if not row or not row[0]:
        return True
    age = (datetime.now(timezone.utc) - row[0]).total_seconds()
    return age >= REFRESH_INTERVAL_SEC


def refresh(conn, force=False):
    """Best-effort refresh of warehouse_bins from the sheet. NEVER raises; returns
    a short status string.

    The pooled connection may arrive with ``autocommit=True`` (``run_query`` leaves
    it that way). We force transactional mode so the TRUNCATE + repopulate runs in a
    SINGLE transaction — on any error the rollback restores the prior bins instead
    of leaving the table emptied. The Google fetch happens BEFORE the TRUNCATE, so a
    fetch failure never touches existing rows either. Prior autocommit state is
    restored before the connection returns to the pool."""
    prev_autocommit = conn.autocommit
    try:
        conn.autocommit = False
    except Exception:
        pass
    try:
        ensure_table(conn)
        if not SHEET_ID:
            return "no_sheet_id"
        if not force and not _is_stale(conn):
            return "fresh"
        # Only one refresh at a time; concurrent callers skip and use what's there.
        if not _refresh_lock.acquire(blocking=False):
            return "in_progress"
        try:
            # Network fetch first — if it fails we never TRUNCATE.
            # Read the WHOLE grid: the Bins tab has tens of thousands of rows, so a
            # fixed cap would silently drop every barcode past it. Fall back to a
            # generous bound when the row count is unknown (explicit-tab path).
            tab, row_count = _resolve_tab(SHEET_ID)
            last_row = int(row_count) if row_count else 200000
            values = _gsheet_values(SHEET_ID, tab, f"A1:Z{last_row}")
            pairs = _parse_rows(values)
            with conn.cursor() as cur:
                cur.execute("TRUNCATE warehouse_bins")
                if pairs:
                    execute_values(
                        cur,
                        "INSERT INTO warehouse_bins (barcode, bin) VALUES %s "
                        "ON CONFLICT (barcode) DO UPDATE SET bin=EXCLUDED.bin, "
                        "updated_at=now()",
                        pairs,
                    )
                cur.execute(
                    "UPDATE warehouse_bins_meta SET refreshed_at=now(), "
                    "row_count=%s, status='ok' WHERE id=1", (len(pairs),))
            conn.commit()
            log.info("warehouse_bins refreshed: %d bins from tab %r", len(pairs), tab)
            return f"ok:{len(pairs)}"
        except Exception as e:
            try:
                conn.rollback()       # restore prior bins
            except Exception:
                pass
            try:
                with conn.cursor() as cur:
                    cur.execute("UPDATE warehouse_bins_meta SET status=%s "
                                "WHERE id=1", (("error:" + str(e))[:300],))
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            log.error("warehouse_bins refresh failed: %s", e)
            return "error"
        finally:
            _refresh_lock.release()
    finally:
        try:
            conn.rollback()           # close any open read txn (e.g. "fresh" path)
        except Exception:
            pass
        try:
            conn.autocommit = prev_autocommit
        except Exception:
            pass


def ensure_fresh(conn):
    """Idempotent + best-effort: ensure the table exists and refresh if stale.
    NEVER raises (a missing connector / sheet just yields the prior bins)."""
    try:
        refresh(conn, force=False)
    except Exception as e:
        log.error("warehouse_bins ensure_fresh failed: %s", e)
