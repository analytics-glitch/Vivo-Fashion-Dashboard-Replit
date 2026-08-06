"""
push_to_replit.py
Runs on Laptop 1 (Windows, no Docker). Reads newly-synced attendance rows
from the local AttendanceDB Postgres instance and pushes them to Replit's
/api/attendance/ingest endpoint over outbound HTTPS.

Schedule as a Windows Task Scheduler task repeating every 5 minutes
(Trigger -> "Repeat task every: 5 minutes", indefinitely). This is push-only:
the laptop always calls OUT to Replit, so no inbound port, router rule, or
tunnel (ngrok/serveo/Cloudflare) is needed for this leg of the pipeline.

Config (set as Windows environment variables):
  LOCAL_DATABASE_URL      postgres connection string for the local AttendanceDB,
                           e.g. postgresql://postgres:PASSWORD@localhost:5432/AttendanceDB
  REPLIT_ATTENDANCE_URL   e.g. https://<your-repl-domain>/api/attendance/ingest
  ATTENDANCE_PUSH_TOKEN   must equal Replit's SESSION_SECRET (sent as X-Internal-Token;
                           the Replit-side auth gate checks this, not a separate ingest token)
  LOCAL_ATTENDANCE_TABLE  optional, defaults to "vivo_attendance" — the local table/view
                           already enriched by bq_sync.py. Change this if your local schema
                           names it differently, or point it at a view that joins
                           attendance_logs/employees/branches into the same shape.

State: writes push_state.json next to this script, tracking the last
successfully-pushed synced_at cursor. If that file is missing (first run, or
after a wipe), it falls back to a wide lookback so it catches up on
everything rather than silently skipping a gap.
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests

LOCAL_DATABASE_URL = os.environ["LOCAL_DATABASE_URL"]
REPLIT_URL = os.environ["REPLIT_ATTENDANCE_URL"]
PUSH_TOKEN = os.environ["ATTENDANCE_PUSH_TOKEN"]
LOCAL_TABLE = os.environ.get("LOCAL_ATTENDANCE_TABLE", "vivo_attendance")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(SCRIPT_DIR, "push_state.json")
LOG_FILE = os.path.join(SCRIPT_DIR, "push_to_replit.log")

# First-run catch-up window and steady-state overlap. Overlap re-sends a few
# minutes of already-pushed rows on every run -- harmless, since Replit's
# ingest is an upsert on (user_id, branch_name, attendance_date) -- and it
# absorbs clock skew / late commits landing right at the cursor boundary.
FIRST_RUN_LOOKBACK = timedelta(days=7)
OVERLAP = timedelta(minutes=5)
BATCH_LIMIT = 5000

COLUMNS = [
    "user_id", "employee_name", "privilege_level",
    "branch_name", "branch_country", "location",
    "device_type", "device_ip", "device_port",
    "device_status", "device_fail_count", "device_last_seen",
    "attendance_date", "check_in_time", "check_out_time",
    "hours_worked", "is_complete", "punch_count",
    "attendance_status", "synced_at",
]

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("push_to_replit")


def load_cursor():
    try:
        with open(STATE_FILE) as f:
            return datetime.fromisoformat(json.load(f)["last_synced_at"])
    except (FileNotFoundError, KeyError, ValueError):
        return datetime.now(timezone.utc) - FIRST_RUN_LOOKBACK


def save_cursor(dt):
    with open(STATE_FILE, "w") as f:
        json.dump({"last_synced_at": dt.isoformat()}, f)


def fetch_rows(since):
    conn = psycopg2.connect(LOCAL_DATABASE_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            f"""
            SELECT {", ".join(COLUMNS)}
            FROM {LOCAL_TABLE}
            WHERE synced_at > %s
            ORDER BY synced_at
            LIMIT %s
            """,
            (since, BATCH_LIMIT),
        )
        return cur.fetchall()
    finally:
        conn.close()


def to_payload(rows):
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for r in rows:
        row = dict(r)
        for k, v in row.items():
            if isinstance(v, datetime):
                row[k] = v.isoformat()
        row["pushed_at"] = now
        out.append(row)
    return out


def push(rows):
    resp = requests.post(
        REPLIT_URL,
        json={"rows": to_payload(rows)},
        headers={"X-Internal-Token": PUSH_TOKEN},
        timeout=60,
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(body["error"])
    return body


def run_once():
    cursor = load_cursor()
    fetch_since = cursor - OVERLAP
    rows = fetch_rows(fetch_since)
    if not rows:
        log.info("no new rows since %s", fetch_since)
        return
    result = push(rows)
    log.info("pushed %s rows (inserted=%s)", len(rows), result.get("inserted"))
    new_cursor = max(r["synced_at"] for r in rows)
    save_cursor(new_cursor)


def main():
    try:
        run_once()
    except Exception:
        log.exception("push failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
