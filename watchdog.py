#!/usr/bin/env python3
"""
Vivo BI process supervisor + self-healing sync watchdog.

Single long-running entrypoint that keeps the data pipeline alive 24/7. It:

  * spawns and supervises the API (uvicorn) and the incremental sync loop,
    restarting either within ~10s of a crash;
  * every 5 minutes runs health checks (API /api/healthz + the sync-loop
    heartbeat in sync_heartbeat) and restarts whatever is unhealthy. Health is
    keyed off the sync heartbeat — NOT all_sales.loaded_at — so a quiet sales
    period never looks like a failure;
  * after 3 consecutive failed sync checks, stops the managed sync and runs a
    one-shot N-day backfill (never overlapping the supervised loop) to recover;
  * logs every check and action to the sync_health_log table;
  * tracks escalation thresholds (15 / 30 minutes stale) and records them.
    Email/webhook delivery is intentionally disabled (no channel configured);
    escalations are surfaced via sync_health_log and /api/sync-status.

This is the production entrypoint for the api-server service on a Reserved VM
(deploymentTarget = "vm"). Autoscale cannot keep a background loop alive.

Env:
  DATABASE_URL          required
  PORT                  API port (default 8080)
  WATCHDOG_MANAGE_API   "0" => supervise the sync only (dev: the API already
                        runs as its own workflow). Default "1" => manage both.
"""
import os
import sys
import time
import signal
import logging
import threading
import subprocess
import urllib.request
from datetime import datetime, timezone

import psycopg2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [watchdog] %(message)s",
)
log = logging.getLogger("watchdog")

ROOT = "/home/runner/workspace"
DATABASE_URL = os.environ["DATABASE_URL"]
API_PORT = int(os.environ.get("PORT", "8080"))
MANAGE_API = os.environ.get("WATCHDOG_MANAGE_API", "1") != "0"
HEALTHZ_URL = f"http://localhost:{API_PORT}/api/healthz"

PROCESS_POLL_SEC = 3        # liveness poll -> crash detected & respawned <10s
HEALTH_CHECK_SEC = 300      # 5 min health checks
SYNC_FRESH_MIN = 15         # healthy if the sync loop wrote a heartbeat within
                            # this many minutes (covers a slow cycle; the loop
                            # heartbeats per store, so 15m means truly stuck)
ESCALATE_1_MIN = 15
ESCALATE_2_MIN = 30
RECOVERY_THRESHOLD = 3      # consecutive failed sync checks before backfill
RECOVERY_DAYS = 4

API_CMD = [
    sys.executable, "-m", "uvicorn", "api_pg:app",
    "--app-dir", ROOT, "--host", "0.0.0.0", "--port", str(API_PORT),
]
SYNC_CMD = [sys.executable, os.path.join(ROOT, "sync_incremental.py")]

_procs = {}                  # name -> Popen
_suspended = set()           # names the supervisor must NOT auto-respawn
                             # (e.g. sync is intentionally stopped for recovery)
_proc_lock = threading.Lock()
_stop = threading.Event()
_sync_fail_streak = 0
_stale_since = None           # when the sync first went stale (for escalation)
_escalation_level = 0         # 0 none, 1 sent 15m, 2 sent 30m


def _db():
    return psycopg2.connect(DATABASE_URL)


def ensure_table():
    with _db() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sync_health_log (
                id           BIGSERIAL PRIMARY KEY,
                checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                api_healthy  BOOLEAN,
                sync_healthy BOOLEAN,
                last_sync_at TIMESTAMPTZ,
                action_taken TEXT,
                notes        TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sync_heartbeat (
                id            INT PRIMARY KEY DEFAULT 1,
                last_cycle_at TIMESTAMPTZ,
                last_status   TEXT,
                CONSTRAINT sync_heartbeat_single CHECK (id = 1)
            )
        """)
        conn.commit()


def log_health(api_healthy, sync_healthy, last_sync_at, action_taken, notes):
    try:
        with _db() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sync_health_log "
                "(api_healthy, sync_healthy, last_sync_at, action_taken, notes) "
                "VALUES (%s, %s, %s, %s, %s)",
                (api_healthy, sync_healthy, last_sync_at, action_taken, notes),
            )
            conn.commit()
    except Exception as e:
        log.error("Failed to write sync_health_log: %s", e)


def _cmd_for(name):
    return API_CMD if name == "api" else SYNC_CMD


def spawn(name):
    """Start a managed process. Caller must hold _proc_lock (except at boot)."""
    cmd = _cmd_for(name)
    log.info("Starting %s: %s", name, " ".join(cmd))
    _procs[name] = subprocess.Popen(cmd, cwd=ROOT)


def restart_proc(name):
    with _proc_lock:
        p = _procs.get(name)
        if p and p.poll() is None:
            log.info("Restarting %s (terminating pid %s)", name, p.pid)
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        spawn(name)


def supervise_loop():
    """Respawn any managed process that has exited, within ~10s."""
    while not _stop.is_set():
        with _proc_lock:
            for name, p in list(_procs.items()):
                if name in _suspended:
                    continue  # intentionally stopped (e.g. recovery) — leave it
                if p.poll() is not None:
                    code = p.returncode
                    log.error("%s exited (code=%s) — respawning", name, code)
                    log_health(None, None, None, f"restart:{name}",
                               f"{name} exited code={code}; respawned by supervisor")
                    spawn(name)
        _stop.wait(PROCESS_POLL_SEC)


def check_api():
    try:
        with urllib.request.urlopen(HEALTHZ_URL, timeout=8) as r:
            return r.status == 200
    except Exception as e:
        log.warning("API health check failed: %s", e)
        return False


def check_sync():
    """Health of the sync LOOP via its heartbeat — NOT data freshness.

    Keying off the heartbeat (written every cycle / per store) means a quiet
    sales period, where all_sales.loaded_at legitimately stops advancing, is
    never mistaken for a failure. Returns (healthy, last_cycle_at, minutes).
    """
    try:
        with _db() as conn, conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.sync_heartbeat')")
            if cur.fetchone()[0] is None:
                return False, None, None  # not created yet (sync hasn't run)
            cur.execute("SELECT last_cycle_at FROM sync_heartbeat WHERE id = 1")
            row = cur.fetchone()
            last = row[0] if row else None
    except Exception as e:
        log.error("Sync heartbeat query failed: %s", e)
        return False, None, None
    if last is None:
        return False, None, None
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    minutes = (datetime.now(timezone.utc) - last).total_seconds() / 60.0
    return minutes <= SYNC_FRESH_MIN, last, minutes


def run_recovery():
    """Stop the supervised sync, run a one-shot backfill, then respawn it.

    Suspending the managed sync first guarantees the backfill never overlaps the
    supervised loop (no duplicate expensive pulls / rate-limit pressure). The
    long subprocess runs WITHOUT holding _proc_lock so the supervisor stays
    responsive. The subprocess return code is validated so a failed backfill is
    reported truthfully rather than always claiming success.
    """
    log.warning("Recovery: stopping managed sync, running one-shot %d-day backfill",
                RECOVERY_DAYS)
    with _proc_lock:
        _suspended.add("sync")
        p = _procs.get("sync")
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "sync_incremental.py"),
             "--once", "--days", str(RECOVERY_DAYS)],
            cwd=ROOT, timeout=1800,
        )
        if r.returncode == 0:
            result = f"{RECOVERY_DAYS}-day backfill completed (rc=0)"
        else:
            result = f"{RECOVERY_DAYS}-day backfill FAILED (rc={r.returncode})"
            log.error(result)
    except Exception as e:
        result = f"{RECOVERY_DAYS}-day backfill error: {e}"
        log.error(result)
    finally:
        with _proc_lock:
            _suspended.discard("sync")
            spawn("sync")  # resume supervised loop
    log.warning("Recovery result: %s", result)
    return result


def notify(level, last_sync, stale_min, action):
    # Email/webhook delivery is intentionally disabled — no channel is
    # configured (the operator opted to log only). Escalations are persisted to
    # sync_health_log and exposed through /api/sync-status. To enable email or a
    # webhook later, send it here using the `requests` library.
    log.error("ESCALATION[%s]: sync stale %.1f min (last=%s); action=%s",
              level, stale_min, last_sync, action)


def health_loop():
    global _sync_fail_streak, _stale_since, _escalation_level
    while not _stop.is_set():
        _stop.wait(HEALTH_CHECK_SEC)
        if _stop.is_set():
            break

        api_ok = check_api()
        sync_ok, last_sync, minutes = check_sync()
        actions, notes = [], []
        if minutes is not None:
            notes.append(f"{minutes:.1f} min since last sync")

        if not api_ok:
            if MANAGE_API:
                restart_proc("api")
                actions.append("restart:api")
            else:
                notes.append("API unhealthy (managed elsewhere)")

        if sync_ok:
            _sync_fail_streak = 0
            _stale_since = None
            _escalation_level = 0
        else:
            _sync_fail_streak += 1
            if _stale_since is None:
                _stale_since = datetime.now(timezone.utc)
            notes.append(f"sync unhealthy (streak={_sync_fail_streak})")

            # Restart OR recover — never both in one cycle. run_recovery() stops
            # the supervised sync, backfills, then respawns it, so a plain
            # restart here would needlessly overlap the recovery backfill.
            if _sync_fail_streak >= RECOVERY_THRESHOLD:
                actions.append("recovery")
                notes.append(run_recovery())
                _sync_fail_streak = 0
            else:
                restart_proc("sync")
                actions.append("restart:sync")

            stale_min = (datetime.now(timezone.utc) - _stale_since).total_seconds() / 60.0
            if stale_min >= ESCALATE_2_MIN and _escalation_level < 2:
                _escalation_level = 2
                actions.append("escalation_2")
                notify("CRITICAL", last_sync, stale_min, ", ".join(actions))
            elif stale_min >= ESCALATE_1_MIN and _escalation_level < 1:
                _escalation_level = 1
                actions.append("escalation_1")
                notify("WARNING", last_sync, stale_min, ", ".join(actions))

        log_health(api_ok, sync_ok, last_sync,
                   ", ".join(actions) or "ok", "; ".join(notes))


def shutdown(*_):
    log.info("Shutting down watchdog…")
    _stop.set()
    with _proc_lock:
        for name, p in _procs.items():
            if p.poll() is None:
                p.terminate()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    ensure_table()
    log.info("Watchdog starting (manage_api=%s, api_port=%s)", MANAGE_API, API_PORT)

    if MANAGE_API:
        spawn("api")
        time.sleep(3)  # let uvicorn bind before the sync hammers the DB
    spawn("sync")

    threading.Thread(target=supervise_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    log.info("Watchdog up — supervising %s", ", ".join(_procs.keys()))

    while not _stop.is_set():
        time.sleep(1)


if __name__ == "__main__":
    main()
