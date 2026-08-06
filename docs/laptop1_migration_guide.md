# Laptop 1 Migration Guide — Docker/Tunnel → Native Windows Push Pipeline

**Goal:** replace the current Docker + serveo/ngrok tunnel pull path with a
Docker-free setup on Laptop 1 that pushes attendance data to Replit over
outbound HTTPS every 5 minutes. No inbound ports, no tunnel to babysit.

```
Before:  ZKTeco devices -> Docker Postgres -> attendance_server.py -> tunnel -> Replit pulls hourly
After:   ZKTeco devices -> native Postgres  -> push_to_replit.py -----------> Replit (push, every 5 min)
```

Replit-side auth/routing is already done (`/api/attendance/*` mounted in
`api_pg.py`, gated by `X-Internal-Token == SESSION_SECRET`). Everything
below happens on Laptop 1.

---

## Prerequisites

- Admin access to Laptop 1 (Windows)
- Replit's `SESSION_SECRET` value — Repl > Tools > Secrets (padlock icon).
  I can't read secret values myself; copy it yourself.
- Your Repl's actual public URL (the one the dashboard is served from)
- `zk_sync.py` and `bq_sync.py` — wherever they currently live inside the
  Docker image/container (I don't have these in the Replit repo, so I can't
  edit them directly — the steps below just change *how often* they run,
  not their internals)

---

## Phase 1 — Get data out of Docker safely (don't lose history)

While the Docker container is still running:

```
docker exec -t zkteco-postgres pg_dump -U postgres -d AttendanceDB -F c -f /tmp/attendancedb.dump
docker cp zkteco-postgres:/tmp/attendancedb.dump C:\attendance\attendancedb.dump
```

Keep the container running until Phase 2's native Postgres is verified with
the restored data — don't tear anything down yet.

---

## Phase 2 — Install PostgreSQL as a native Windows service

1. Download the PostgreSQL 16 Windows installer (EDB installer) from
   postgresql.org.
2. Check what port the Docker container currently publishes Postgres on
   (`docker port zkteco-postgres`) — if it's `5432`, either stop/remove that
   mapping first or install native Postgres on a different port (e.g.
   `5433`) to avoid a conflict.
3. Run the installer. It registers a Windows service
   (`postgresql-x64-16`) with Startup type **Automatic** — confirm in
   `services.msc` after install.
4. Create the database and restore:
   ```
   createdb -U postgres AttendanceDB
   pg_restore -U postgres -d AttendanceDB C:\attendance\attendancedb.dump
   ```
5. Verify row counts match the Docker version before moving on
   (`SELECT COUNT(*) FROM attendance_logs;` in both).

---

## Phase 3 — Move zk_sync.py / bq_sync.py off Docker

1. Install Python 3.x natively on Windows (python.org installer, check "Add
   to PATH") — not just inside the container.
2. Pull the scripts out of the container:
   ```
   docker cp zkteco-postgres:/app/zk_sync.py C:\attendance\scripts\
   docker cp zkteco-postgres:/app/bq_sync.py C:\attendance\scripts\
   ```
   (adjust the in-container path if different)
3. Open each script, note its `import` lines, and `pip install` matching
   packages (at minimum `pyzk psycopg2-binary`, plus whatever `bq_sync.py`
   uses for BigQuery, e.g. `google-cloud-bigquery`).
4. Update their DB connection string to point at
   `localhost:<port from Phase 2>` instead of the Docker-internal hostname.
5. Test manually:
   ```
   python C:\attendance\scripts\zk_sync.py
   python C:\attendance\scripts\bq_sync.py
   ```
   Confirm no errors and that new rows land in the native `AttendanceDB`.
   **Time how long each run takes** — this determines the safe Task
   Scheduler interval in Phase 5 (see caveat at the bottom).

---

## Phase 4 — Get push_to_replit.py onto Laptop 1

1. Copy `push_to_replit.py` from this Replit repo to
   `C:\attendance\scripts\push_to_replit.py`.
2. `pip install requests psycopg2-binary`
3. Set these as **System** environment variables (System Properties >
   Environment Variables > System variables > New) so they're visible to
   Task Scheduler regardless of which account runs the task:
   - `LOCAL_DATABASE_URL` = `postgresql://postgres:<password>@localhost:<port>/AttendanceDB`
   - `REPLIT_ATTENDANCE_URL` = `https://<your-actual-repl-domain>/api/attendance/ingest`
   - `ATTENDANCE_PUSH_TOKEN` = `<same value as Replit's SESSION_SECRET>`
   - `LOCAL_ATTENDANCE_TABLE` (optional) = only if your local enriched table
     isn't named `vivo_attendance` — check with `\d vivo_attendance` in
     `psql` first.
4. Test manually:
   ```
   python C:\attendance\scripts\push_to_replit.py
   ```
   Check `C:\attendance\scripts\push_to_replit.log` for a `pushed N rows`
   line, and confirm `MAX(synced_at)`/`MAX(pushed_at)` in Replit's
   `vivo_attendance` table advanced.

---

## Phase 5 — Windows Task Scheduler: automate all three scripts

Repeat this for `zk_sync.py`, `bq_sync.py`, and `push_to_replit.py`:

1. Open Task Scheduler > **Create Task** (not "Create Basic Task" — you
   need the repeat-every option).
2. **General** tab: name it (e.g. "Vivo - push_to_replit"), check "Run
   whether user is logged on or not", check "Run with highest privileges".
3. **Triggers** tab: New > "On a schedule" > Daily, start time now >
   Advanced settings > check **"Repeat task every: 5 minutes"** (or 10–15
   min for `zk_sync.py`/`bq_sync.py` if a full run takes longer than a
   couple of minutes — see caveat below), duration **Indefinitely**.
4. **Actions** tab: New > Program/script: full path to `python.exe` >
   Add arguments: full path to the script > Start in: the script's folder.
5. **Conditions** tab: uncheck "Start the task only if the computer is on
   AC power" (laptop).
6. **Settings** tab: check "If the task fails, restart every: 1 minute"
   (up to 3 attempts), and set "If the task is already running... Do not
   start a new instance" to avoid overlapping runs.
7. Right-click each task > **Run** to test immediately.

---

## Phase 6 — Verify end to end

1. Tail `push_to_replit.log` — confirm recurring `pushed N rows` lines.
2. In Replit, watch `MAX(synced_at)` / `MAX(pushed_at)` on `vivo_attendance`
   advance every 5–15 minutes.
3. Watch for a full day before decommissioning anything.

---

## Phase 7 — Decommission the old path (only once Phase 6 is stable for a few days)

1. Stop and remove the Docker container:
   `docker stop zkteco-postgres && docker rm zkteco-postgres`.
2. Stop the serveo/ngrok tunnel process.
3. Tell me once this is stable and I'll disable the hourly pull-based
   `sync_attendance()` in `sync_incremental.py` on the Replit side — keep
   it running as a safety net until then.

---

## Caveats I can't verify from here

- `zk_sync.py`/`bq_sync.py` aren't in the Replit repo, so I don't know if
  they do an incremental pull or a full re-scan of all 29 devices each run.
  If a full run takes several minutes, a 5-minute interval will cause
  overlapping runs — time it in Phase 3 and pick 10–15 min instead if needed.
  `push_to_replit.py` itself is a fast local-DB query, so it's safe at 5 min
  regardless.
- I assumed a local table named `vivo_attendance` already holds the enriched
  rows `bq_sync.py` produces. Confirm with `\d vivo_attendance` before first
  run; override via `LOCAL_ATTENDANCE_TABLE` if it's named differently.
- Check the Docker container's current Postgres port mapping before
  installing native Postgres, to avoid a `5432` conflict.
