"""
attendance_ingest_api.py
FastAPI sub-app for receiving attendance data pushed from Laptop 1.
Mounted at /api/public/attendance inside api_pg.py — the outer auth gate
requires X-Internal-Token == SESSION_SECRET (or ?t=<secret>, the pusher's
client contract) for this whole prefix, checked BEFORE the generic
/api/public/ bypass (see clerk_auth_gate in api_pg.py), so no separate
token check happens in here.
"""

import os
import psycopg2
from psycopg2.extras import execute_values
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI(title="Vivo Attendance Ingest API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.environ["DATABASE_URL"]


def get_conn():
    return psycopg2.connect(DATABASE_URL)


@app.get("/")
def root():
    return {"status": "ok", "service": "Vivo Attendance Ingest API"}


@app.get("/health")
def health():
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT MAX(attendance_date), COUNT(*) FROM vivo_attendance")
        result = cur.fetchone()
        conn.close()
        return {
            "status": "ok",
            "latest_date": str(result[0]),
            "total_records": result[1],
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.post("/ingest")
async def ingest_attendance(request: Request, t: str = ""):
    data = await request.json()
    rows = data.get("rows", [])
    if not rows:
        return {"status": "ok", "inserted": 0}

    conn = get_conn()
    cur = conn.cursor()
    try:
        # Ensure table exists
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vivo_attendance (
                user_id             INTEGER,
                employee_name       TEXT,
                privilege_level     TEXT,
                branch_name         TEXT,
                branch_country      TEXT,
                location            TEXT,
                device_type         TEXT,
                device_ip           TEXT,
                device_port         INTEGER,
                device_status       TEXT,
                device_fail_count   INTEGER,
                device_last_seen    TIMESTAMPTZ,
                attendance_date     DATE,
                check_in_time       TIMESTAMPTZ,
                check_out_time      TIMESTAMPTZ,
                hours_worked        FLOAT,
                is_complete         BOOLEAN,
                punch_count         INTEGER,
                attendance_status   TEXT,
                synced_at           TIMESTAMPTZ,
                pushed_at           TIMESTAMPTZ,
                PRIMARY KEY (user_id, branch_name, attendance_date)
            )
        """)
        conn.commit()

        execute_values(
            cur,
            """
            INSERT INTO vivo_attendance (
                user_id, employee_name, privilege_level,
                branch_name, branch_country, location,
                device_type, device_ip, device_port,
                device_status, device_fail_count, device_last_seen,
                attendance_date, check_in_time, check_out_time,
                hours_worked, is_complete, punch_count,
                attendance_status, synced_at, pushed_at
            ) VALUES %s
            ON CONFLICT (user_id, branch_name, attendance_date) DO UPDATE SET
                check_in_time     = EXCLUDED.check_in_time,
                check_out_time    = EXCLUDED.check_out_time,
                hours_worked      = EXCLUDED.hours_worked,
                is_complete       = EXCLUDED.is_complete,
                punch_count       = EXCLUDED.punch_count,
                attendance_status = EXCLUDED.attendance_status,
                device_status     = EXCLUDED.device_status,
                device_fail_count = EXCLUDED.device_fail_count,
                device_last_seen  = EXCLUDED.device_last_seen,
                synced_at         = EXCLUDED.synced_at,
                pushed_at         = EXCLUDED.pushed_at
        """,
            [
                (
                    r["user_id"],
                    r["employee_name"],
                    r["privilege_level"],
                    r["branch_name"],
                    r["branch_country"],
                    r["location"],
                    r["device_type"],
                    r["device_ip"],
                    r["device_port"],
                    r["device_status"],
                    r["device_fail_count"],
                    r["device_last_seen"],
                    r["attendance_date"],
                    r["check_in_time"],
                    r["check_out_time"],
                    r["hours_worked"],
                    r["is_complete"],
                    r["punch_count"],
                    r["attendance_status"],
                    r["synced_at"],
                    r["pushed_at"],
                )
                for r in rows
            ],
            page_size=500,
        )

        conn.commit()
        return {"status": "ok", "inserted": len(rows)}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        cur.close()
        conn.close()
