"""Best-effort, append-only audit log of Fabric BI dashboard reservation changes
to a single running Google Sheet.

The Fabric dashboard's only user-driven write actions are the buying team's
reservation actions (create / mark-used / delete). After each one is committed,
``log_change`` files one human-readable row at the bottom of a configured Google
Sheet so the buying team has a time-ordered audit trail (latest change last).

Design notes:
  * STRICTLY best-effort: the append runs in a daemon thread and NEVER raises into
    the request path, so a dashboard action always succeeds even if the Sheet is
    unreachable. A failed append is logged to the server log only.
  * A module-level lock serialises appends so rows stay append-only and in
    chronological order, and so the one-time header write can't race itself.
  * The target spreadsheet ID comes from the FABRIC_LOG_SHEET_ID env var/secret
    (optional FABRIC_LOG_SHEET_TAB picks the worksheet, default "Sheet1"). When it
    is unset the whole module is a no-op — zero regression until configured.
  * The Sheet itself must already exist in the user's Drive folder and be shared
    with edit rights to the connected google-sheet account (code has no Drive
    scope to create files). See the task notes / replit.md.

Google Sheets access reuses the read/append helpers in ``hr_attendance``.
"""
import os
import logging
import threading
from datetime import datetime, timezone, timedelta

from hr_attendance import _gsheet_values, _gsheet_append

log = logging.getLogger("fabric_change_log")

SHEET_ID = os.environ.get("FABRIC_LOG_SHEET_ID", "").strip()
SHEET_TAB = os.environ.get("FABRIC_LOG_SHEET_TAB", "").strip() or "Sheet1"

# Africa/Nairobi is a fixed UTC+3 (no DST), so a fixed offset is exact.
_EAT = timezone(timedelta(hours=3))

HEADER = ["Timestamp (EAT)", "User name", "User email", "Action",
          "Reservation ID", "Fabric / product", "Style", "Qty", "UoM",
          "Note", "Resulting status", "Style number"]

_append_lock = threading.Lock()


def _fmt_qty(v):
    if v is None:
        return ""
    try:
        f = float(v)
        return str(int(f)) if f == int(f) else f"{f:g}"
    except (TypeError, ValueError):
        return str(v)


def _ensure_header():
    """Write the header row once if the sheet/tab is currently empty."""
    try:
        existing = _gsheet_values(SHEET_ID, SHEET_TAB, "A1:A1")
    except Exception:
        existing = None
    if not existing:
        _gsheet_append(SHEET_ID, SHEET_TAB, [HEADER])


def _append_row(action, resv, actor_name, actor_email):
    ts = datetime.now(_EAT).strftime("%Y-%m-%d %H:%M:%S")
    row = [
        ts,
        actor_name or "",
        actor_email or "",
        action,
        str(resv.get("id") or ""),
        resv.get("product") or "",
        resv.get("style_name") or "",
        _fmt_qty(resv.get("qty")),
        resv.get("uom") or "",
        resv.get("note") or "",
        resv.get("status") or "",
        # Style number added later, appended LAST so existing sheets stay aligned.
        resv.get("style_number") or "",
    ]
    with _append_lock:
        _ensure_header()
        _gsheet_append(SHEET_ID, SHEET_TAB, [row])


def log_change(action, resv, actor_name, actor_email):
    """Append a reservation change to the audit Sheet in a daemon thread.

    NEVER blocks the request and NEVER raises. ``action`` is a human verb
    (e.g. "Created" / "Marked used" / "Deleted"); ``resv`` is a dict with id,
    product, style_name, qty, uom, note, status (any may be missing)."""
    if not SHEET_ID:
        return

    def _bg():
        try:
            _append_row(action, resv or {}, actor_name, actor_email)
        except Exception as e:
            log.error("fabric change log append failed (%s id=%s): %s",
                      action, (resv or {}).get("id"), e)

    try:
        threading.Thread(target=_bg, name="fabric-change-log",
                         daemon=True).start()
    except Exception as e:
        log.error("fabric change log thread start failed: %s", e)
