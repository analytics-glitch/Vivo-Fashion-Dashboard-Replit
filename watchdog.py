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
  REBUILD_ON_BOOT       "1"/"true" => run ONE full all_sales rebuild at startup
                        (after the API is up, before the sync loop) to correct
                        this environment's data, then continue normally. Default
                        "0" (off). Set it for a single publish to fix production
                        historical data, then unset and republish so it does not
                        rebuild on every VM restart. See replit.md.
  REBUILD_REFRESH_RAW   "0" => skip the source refresh and transform the raw
                        tables as-is (only safe if every source — shopify_sales,
                        raw_shopify_vendor_sales, raw_odoo_* — is already
                        complete & clean). Default "1" => re-extract ALL sources
                        first (Shopify full history -> shopify_sales, ShopZetu
                        full window -> raw_shopify_vendor_sales, Odoo products +
                        orders), so a fresh/incomplete environment (e.g. prod)
                        is corrected wholesale. Keep "1" for the prod fix.
  REBUILD_TIMEOUT_SEC   per-step subprocess timeout for the rebuild (default
                        5400 = 90 min). With REBUILD_REFRESH_RAW=1 the Shopify
                        full extract is the long pole; raise this (e.g. 7200) if
                        a fresh prod extract risks exceeding 90 min.
"""
import os
import sys
import time
import signal
import logging
import threading
import subprocess
import urllib.request
import urllib.error
import json as _json
from datetime import datetime, timezone

import psycopg2

from port_guard import free_port

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [watchdog] %(message)s",
)
log = logging.getLogger("watchdog")

ROOT = "/home/runner/workspace"
DATABASE_URL = os.environ["DATABASE_URL"]
# Watchdog is a long-running supervisor (not a request handler); it uses DDL,
# session-level heartbeat writes, and advisory-lock-free transactions — none of
# which need the pooler, and all of which are safer on a direct connection.
# Falls back to DATABASE_URL so dev environments without a separate direct URL
# continue to work unchanged.
DATABASE_URL_DIRECT = os.environ.get("DATABASE_URL_DIRECT") or DATABASE_URL
API_PORT = int(os.environ.get("PORT", "8080"))
MANAGE_API = os.environ.get("WATCHDOG_MANAGE_API", "1") != "0"
HEALTHZ_URL = f"http://localhost:{API_PORT}/api/healthz"
READYZ_URL = f"http://localhost:{API_PORT}/api/readyz"

PROCESS_POLL_SEC = 3        # liveness poll -> crash detected & respawned <10s
HEALTH_CHECK_SEC = 300      # 5 min health checks
SYNC_FRESH_MIN = 15         # healthy if the sync loop wrote a heartbeat within
                            # this many minutes (covers a slow cycle; the loop
                            # heartbeats per store, so 15m means truly stuck)
ESCALATE_1_MIN = 15
ESCALATE_2_MIN = 30
RECOVERY_THRESHOLD = 3      # consecutive failed sync checks before backfill
RECOVERY_DAYS = 4

# Fabric feed freshness — the fabric worker is a daemon thread inside the
# supervised sync process with its OWN heartbeat table (fabric_heartbeat), so
# it can silently die or stall while sync_heartbeat stays perfectly fresh. The
# watchdog watches it separately, gating on BOTH the heartbeat AND the data
# timestamp MAX(raw_fabric_products._loaded_at) — the heartbeat alone lied for
# 15+ hours when lock-skipped extracts were still counted as successes — and
# rescues a stale feed with a one-shot `extract_fabric.py --mode fast` (its pg
# advisory lock makes overlap with a live fabric thread impossible — the
# losing run just skips with exit code 3). Recovery is rate-limited so a
# persistent Odoo outage doesn't spam extractions: normally
# FABRIC_RECOVERY_COOLDOWN_MIN, tightened to
# FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN once the data itself is >4h stale (a
# real outage should retry aggressively). After FABRIC_ESCALATE_FAILURES
# consecutive failed recoveries with data >6h stale, the health loop escalates
# to a full sync-process restart so the fabric worker thread re-spawns with a
# fresh connection.
try:
    FABRIC_FRESH_MIN = int(os.environ.get("FABRIC_FRESH_MIN", "120"))
except ValueError:
    log.warning("Invalid FABRIC_FRESH_MIN — falling back to 120")
    FABRIC_FRESH_MIN = 120
try:
    FABRIC_RECOVERY_COOLDOWN_MIN = int(
        os.environ.get("FABRIC_RECOVERY_COOLDOWN_MIN", "60"))
except ValueError:
    log.warning("Invalid FABRIC_RECOVERY_COOLDOWN_MIN — falling back to 60")
    FABRIC_RECOVERY_COOLDOWN_MIN = 60
try:
    FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN = int(
        os.environ.get("FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN", "10"))
except ValueError:
    log.warning("Invalid FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN — falling back to 10")
    FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN = 10
# One-shot fast-extract subprocess budget. Matches the sync worker's own
# budget (sync_incremental.py reads the SAME env var, default 600s there) so a
# slow-but-alive Odoo can still complete a recovery pull — the old hardcoded
# 120s meant any Odoo response >2 min failed every recovery, reset the
# cooldown, and never recovered. Deliberately read from the env rather than
# imported from sync_incremental: importing that module would drag the whole
# sync dependency chain (and its import-time env requirements) into the
# watchdog. Fallback when the env var is unset: 300s.
try:
    FABRIC_EXTRACT_TIMEOUT_SEC = int(
        os.environ.get("FABRIC_EXTRACT_TIMEOUT_SEC", "300"))
except ValueError:
    log.warning("Invalid FABRIC_EXTRACT_TIMEOUT_SEC — falling back to 300")
    FABRIC_EXTRACT_TIMEOUT_SEC = 300
FABRIC_DATA_CRITICAL_MIN = 240    # data >4h stale → critical (tight) cooldown
FABRIC_ESCALATE_STALE_MIN = 360   # data >6h stale AND…
FABRIC_ESCALATE_FAILURES = 3      # …≥3 consecutive failed recoveries → restart sync

# One-time full rebuild (correct this environment's historical all_sales).
REBUILD_ON_BOOT = os.environ.get("REBUILD_ON_BOOT", "0").lower() not in ("0", "", "false")
REBUILD_REFRESH_RAW = os.environ.get("REBUILD_REFRESH_RAW", "1").lower() not in ("0", "", "false")
try:
    REBUILD_TIMEOUT = int(os.environ.get("REBUILD_TIMEOUT_SEC", "5400"))  # 90 min / step
except ValueError:
    log.warning("Invalid REBUILD_TIMEOUT_SEC — falling back to 5400")
    REBUILD_TIMEOUT = 5400

_API_WORKERS = os.environ.get("API_WORKERS", "1")  # 1 = stable default; multi-worker needs shared cache + the startup advisory-lock guard (both now in place) before raising
API_CMD = [
    sys.executable, "-m", "uvicorn", "api_pg:app",
    "--app-dir", ROOT, "--host", "0.0.0.0", "--port", str(API_PORT),
    "--workers", _API_WORKERS,
]
SYNC_CMD = [sys.executable, os.path.join(ROOT, "sync_incremental.py")]

_procs = {}                  # name -> Popen
_suspended = set()           # names the supervisor must NOT auto-respawn
                             # (e.g. sync is intentionally stopped for recovery)
_proc_lock = threading.Lock()
_stop = threading.Event()
_rebuild_proc = None         # in-flight one-time rebuild step (for SIGTERM)
_sync_fail_streak = 0
_stale_since = None           # when the sync first went stale (for escalation)
_escalation_level = 0         # 0 none, 1 sent 15m, 2 sent 30m
_last_fabric_recovery = None  # when the last one-shot fabric rescue ran (cooldown stamp)
_fabric_recovery_failures = 0  # consecutive failed fabric recoveries (reset on
                               # success) — drives the >6h-stale escalation to a
                               # full sync-process restart


def _db():
    return psycopg2.connect(DATABASE_URL_DIRECT)


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


def check_ready():
    """Readiness (API + DB reachable) via /api/readyz — for OBSERVABILITY only.

    Deliberately NOT used to trigger restarts: the restart decision stays on
    check_api() (DB-free liveness) + check_sync() so a database blip never makes
    the watchdog bounce the API (which can't fix a DB outage and would only flap).
    /api/readyz returns 503 when the DB is unreachable, so read the body on both
    2xx and HTTPError. Returns (ready_bool, db_state_str|None).
    """
    def _parse(raw):
        body = _json.loads(raw.decode())
        return bool(body.get("ready")), body.get("checks", {}).get("db")
    try:
        with urllib.request.urlopen(READYZ_URL, timeout=8) as r:
            return _parse(r.read())
    except urllib.error.HTTPError as e:
        try:
            return _parse(e.read())
        except Exception:
            return False, None
    except Exception as e:
        log.warning("Readiness check failed: %s", e)
        return False, None


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


def check_fabric():
    """Health of the fabric feed: its heartbeat AND the data timestamp.

    The fabric worker is a daemon thread inside the supervised sync process
    that beats its own table (fabric_heartbeat) every ~60s cycle precisely so
    a stalled main cycle can't hide behind it — and, symmetrically, a dead
    fabric thread can't hide behind a healthy sync_heartbeat.

    The heartbeat alone is NOT enough: it says "the worker loop is alive",
    not "data refreshed". The user-visible freshness metric (and the /fabric
    "last successful pull" banner) is MAX(raw_fabric_products._loaded_at),
    which only a successful extract advances. Unlike all_sales.loaded_at —
    where quiet sales periods legitimately stall the data clock, so
    check_sync() must gate on the heartbeat only — EVERY successful fabric
    pull rewrites _loaded_at across the whole table even with 0 changed rows,
    so its age is a true failure signal. The two metrics diverged for 15+
    hours when lock-skipped extracts kept the heartbeat fresh, so health now
    requires BOTH to be within FABRIC_FRESH_MIN.

    Returns (healthy, last_beat_at, beat_minutes, data_minutes). Any DB
    error → (False, None, None, None); a missing table / empty row leaves the
    corresponding age None, which counts as unhealthy. `_loaded_at` is
    written by extract_fabric.py as a NAIVE UTC timestamp (datetime.utcnow()),
    so naive values are interpreted as UTC.
    """
    hb_last = None
    data_last = None
    try:
        with _db() as conn, conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.fabric_heartbeat')")
            if cur.fetchone()[0] is not None:
                cur.execute("SELECT last_cycle_at FROM fabric_heartbeat WHERE id = 1")
                row = cur.fetchone()
                hb_last = row[0] if row else None
            cur.execute("SELECT to_regclass('public.raw_fabric_products')")
            if cur.fetchone()[0] is not None:
                cur.execute("SELECT MAX(_loaded_at) FROM raw_fabric_products")
                row = cur.fetchone()
                data_last = row[0] if row else None
    except Exception as e:
        log.error("Fabric freshness query failed: %s", e)
        return False, None, None, None

    now = datetime.now(timezone.utc)

    def _age_min(ts):
        if ts is None:
            return None
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (now - ts).total_seconds() / 60.0

    hb_min = _age_min(hb_last)
    data_min = _age_min(data_last)
    healthy = (
        hb_min is not None and hb_min <= FABRIC_FRESH_MIN
        and data_min is not None and data_min <= FABRIC_FRESH_MIN
    )
    return healthy, hb_last, hb_min, data_min


def run_fabric_recovery(reason=""):
    """One-shot fabric rescue: run `extract_fabric.py --mode fast`.

    Safe to fire at any moment: extract_fabric.py takes a pg advisory lock
    shared with the supervised fabric thread's own pulls, so an overlapping
    run SKIPS (exit code 3) instead of colliding, and a fast pull only upserts
    the incremental window (no truncate). Independent of the sync recovery
    path — the fabric feed can be stale while the main sync is healthy (the
    daemon thread died) and vice versa. Logs every outcome at WARNING so it
    lands in the existing log trail, stamps the recovery cooldown, maintains
    the consecutive-failure counter that drives the health loop's
    process-restart escalation (reset on success, incremented on anything
    else — a lock-skip refreshed nothing, so it counts as a failure; the
    >6h data-age gate keeps that from escalating prematurely), and returns a
    short result string for sync_health_log notes.
    """
    global _last_fabric_recovery, _fabric_recovery_failures
    log.warning("Fabric recovery: running one-shot fast extract%s",
                f" ({reason})" if reason else "")
    success = False
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "extract_fabric.py"),
             "--mode", "fast"],
            cwd=ROOT, timeout=FABRIC_EXTRACT_TIMEOUT_SEC,
        )
        if r.returncode == 0:
            result = "fabric fast extract completed (rc=0)"
            success = True
        elif r.returncode == 3:
            # extract_fabric.py's lock-skip convention (see its module header):
            # another fabric run holds the advisory lock; nothing was refreshed.
            result = "fabric fast extract SKIPPED (rc=3: advisory lock held)"
        else:
            result = f"fabric fast extract FAILED (rc={r.returncode})"
    except subprocess.TimeoutExpired:
        result = f"fabric fast extract TIMED OUT ({FABRIC_EXTRACT_TIMEOUT_SEC}s)"
    except Exception as e:
        result = f"fabric fast extract error: {e}"
    finally:
        _last_fabric_recovery = datetime.now(timezone.utc)
    if success:
        _fabric_recovery_failures = 0
    else:
        _fabric_recovery_failures += 1
    log.warning("Fabric recovery result: %s (consecutive failures: %s)",
                result, _fabric_recovery_failures)
    return result


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
    # The --once backfill above deliberately skips the fabric worker, and the
    # freshly spawned sync's fabric thread has its own first-tick delay — so
    # without this kick every recovery cycle grows the fabric feed's staleness
    # gap by the whole backfill window (up to 30 min). Runs OUTSIDE _proc_lock
    # (long subprocess; the supervisor must stay responsive) and after the
    # respawn — the advisory lock makes a collision with the new thread's
    # first pull harmless.
    result += "; " + run_fabric_recovery(reason="post-recovery refresh")
    return result


def run_full_rebuild():
    """One-time full rebuild of all_sales for THIS environment's database.

    Gated behind REBUILD_ON_BOOT. Called from main() AFTER the API is spawned
    (so the deployment's startup health check on /api/ can pass) but BEFORE the
    supervised sync loop and the supervise/health threads start — so nothing
    ever overlaps the rebuild. An overlapping sync would double history (row
    ids don't collide and all_sales has no PK guard against re-insert).

    Steps (each validated by return code; any failure aborts the remainder and
    returns False):
      1. optional (REBUILD_REFRESH_RAW): refresh EVERY source table the
         transform reads, so a fresh/incomplete environment (e.g. production,
         whose shopify_sales is empty and whose raw_shopify_vendor_sales may be
         doubled/un-netted) is corrected wholesale before the transform runs:
           a. shopify_full_extract.py  -> shopify_sales (Shopify retail history;
              populated ONLY here, never by the incremental sync)
           b. extract_shopzetu_sales.py --since=2022-01-01 --until=today
              -> raw_shopify_vendor_sales (Online; full re-extract un-doubles +
              re-nets via delete-by-window + insert)
           c. extract_odoo_products.py then extract_odoo_orders.py -> raw_odoo_*
      2. transform_all_sales.py — TRUNCATE + repopulate all_sales from those
         source tables using the current (fixed) transform logic.

    Because transform_all_sales (the only TRUNCATEing step) runs LAST, an
    aborted source refresh leaves all_sales untouched (no truncate), so the
    dashboard keeps its current rows rather than going empty.

    NOTE: transform_all_sales TRUNCATEs then repopulates in a single run, so for
    the rebuild's duration the live dashboard reads a partially populated table
    — publish this off-peak. On failure all_sales may be left partial; the
    supervised sync that follows only refreshes recent days, so re-run the
    rebuild (republish with REBUILD_ON_BOOT still set) to finish it.
    """
    log.warning("REBUILD_ON_BOOT set — running one-time full all_sales rebuild "
                "(refresh_raw=%s, timeout=%ss/step)",
                REBUILD_REFRESH_RAW, REBUILD_TIMEOUT)
    steps = []
    if REBUILD_REFRESH_RAW:
        # Shopify retail history (vivowoman / vivo-uganda / vivo-rwanda) lives in
        # the `shopify_sales` table, which is populated ONLY by this full extract
        # — the incremental sync never writes it. A fresh environment (e.g. the
        # production DB) has an EMPTY shopify_sales, so transform_all_sales would
        # silently drop every Shopify retail row (Kenya pre-2026-03-20, Uganda,
        # Rwanda). The extract is resumable + idempotent (delete-by-key+insert),
        # so retrying after a timeout is safe.
        steps.append(("shopify_full_extract",
                      [sys.executable, os.path.join(ROOT, "shopify_full_extract.py")]))
        # Online (Shop Zetu) source = raw_shopify_vendor_sales. Re-extract the
        # FULL window from ShopifyQL (delete-by-window + insert) so a doubled /
        # un-netted legacy table is corrected wholesale, not just the recent
        # incremental tail. Pass an explicit window or the script would default
        # to incremental (max(day)-4 -> today) and leave bad history in place.
        _sz_until = datetime.now(timezone.utc).date().isoformat()
        steps.append(("extract_shopzetu_sales",
                      [sys.executable, os.path.join(ROOT, "extract_shopzetu_sales.py"),
                       "--since=2022-01-01", f"--until={_sz_until}"]))
        steps.append(("extract_odoo_products",
                      [sys.executable, os.path.join(ROOT, "extract_odoo_products.py")]))
        steps.append(("extract_odoo_orders",
                      [sys.executable, os.path.join(ROOT, "extract_odoo_orders.py")]))
    steps.append(("transform_all_sales",
                  [sys.executable, os.path.join(ROOT, "transform_all_sales.py")]))

    global _rebuild_proc
    for name, cmd in steps:
        log.warning("Rebuild step starting: %s", name)
        try:
            _rebuild_proc = subprocess.Popen(cmd, cwd=ROOT)
            rc = _rebuild_proc.wait(timeout=REBUILD_TIMEOUT)
        except subprocess.TimeoutExpired:
            log.error("Rebuild step %s timed out after %ss — killing & ABORTING",
                      name, REBUILD_TIMEOUT)
            try:
                _rebuild_proc.kill()
            except Exception:
                pass
            _rebuild_proc = None
            return False
        except Exception as e:
            log.error("Rebuild step %s errored (%s) — ABORTING rebuild", name, e)
            _rebuild_proc = None
            return False
        if rc != 0:
            _rebuild_proc = None
            log.error("Rebuild step %s FAILED (rc=%s) — ABORTING rebuild", name, rc)
            return False
        _rebuild_proc = None
        log.warning("Rebuild step done: %s", name)
    log.warning("One-time full all_sales rebuild COMPLETED successfully")
    return True


def notify(level, last_sync, stale_min, action):
    # Email/webhook delivery is intentionally disabled — no channel is
    # configured (the operator opted to log only). Escalations are persisted to
    # sync_health_log and exposed through /api/sync-status. To enable email or a
    # webhook later, send it here using the `requests` library.
    log.error("ESCALATION[%s]: sync stale %.1f min (last=%s); action=%s",
              level, stale_min, last_sync, action)


def health_loop():
    global _sync_fail_streak, _stale_since, _escalation_level
    global _fabric_recovery_failures
    while not _stop.is_set():
        _stop.wait(HEALTH_CHECK_SEC)
        if _stop.is_set():
            break

        api_ok = check_api()
        sync_ok, last_sync, minutes = check_sync()
        actions, notes = [], []
        if minutes is not None:
            notes.append(f"{minutes:.1f} min since last sync")

        # Readiness (DB reachability) — recorded for observability; does NOT drive
        # restart decisions (see check_ready docstring).
        ready_ok, db_state = check_ready()
        if not ready_ok:
            notes.append(f"not ready (db={db_state})")

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

        # Fabric feed staleness — checked INDEPENDENTLY of the sync branch
        # above: the fabric worker is a daemon thread with its own heartbeat,
        # so it can be dead while sync_heartbeat is perfectly fresh (and vice
        # versa). Placed AFTER the sync branch on purpose — run_recovery()
        # already ends with a fabric extract that stamps the cooldown, so this
        # can't double-fire in the same cycle. Health gates on BOTH the
        # heartbeat AND the data timestamp (MAX(raw_fabric_products._loaded_at));
        # the DATA age is what operators and the /fabric banner actually see,
        # so it is the number recorded in the notes. Recovery is a one-shot
        # fast extract, rate-limited by FABRIC_RECOVERY_COOLDOWN_MIN and
        # tightened to FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN once the data is
        # >4h stale; after FABRIC_ESCALATE_FAILURES consecutive failed
        # recoveries with data >6h stale it escalates to a sync-process
        # restart (the same restart_proc("sync") mechanism the main-sync
        # branch uses) so the fabric worker thread re-spawns with a fresh
        # process and connection.
        fabric_ok, last_fabric, fabric_min, fabric_data_min = check_fabric()
        if fabric_data_min is not None:
            notes.append(f"fabric data {fabric_data_min:.1f} min old")
        elif fabric_min is not None:
            notes.append(f"{fabric_min:.1f} min since last fabric beat")
        if not fabric_ok:
            log.warning(
                "Fabric feed stale: data %s, beat %s (threshold %s min)",
                f"{fabric_data_min:.1f} min old" if fabric_data_min is not None
                else "never loaded",
                f"{fabric_min:.1f} min ago" if fabric_min is not None
                else "no heartbeat",
                FABRIC_FRESH_MIN,
            )
            data_critical = (fabric_data_min is not None
                             and fabric_data_min > FABRIC_DATA_CRITICAL_MIN)
            cooldown_limit = (FABRIC_RECOVERY_COOLDOWN_CRITICAL_MIN if data_critical
                              else FABRIC_RECOVERY_COOLDOWN_MIN)
            cooldown_min = (
                None if _last_fabric_recovery is None else
                (datetime.now(timezone.utc) - _last_fabric_recovery).total_seconds() / 60.0
            )
            if cooldown_min is None or cooldown_min >= cooldown_limit:
                actions.append("fabric_recovery")
                reason = ("fabric data stale"
                          if (fabric_data_min is None
                              or fabric_data_min > FABRIC_FRESH_MIN)
                          else "fabric heartbeat stale")
                notes.append(run_fabric_recovery(reason=reason))
                # Escalation: one-shot extracts keep failing AND the data is
                # very stale — the fabric worker thread (or its process) is
                # presumed wedged; a process restart re-spawns the thread with
                # a fresh connection. Skipped if this cycle already restarted
                # the sync (no point killing it twice).
                if (fabric_data_min is not None
                        and fabric_data_min > FABRIC_ESCALATE_STALE_MIN
                        and _fabric_recovery_failures >= FABRIC_ESCALATE_FAILURES
                        and "restart:sync" not in actions):
                    log.warning(
                        "Fabric ESCALATION: data %.0f min stale and %d "
                        "consecutive failed recoveries — restarting the sync "
                        "process so the fabric worker thread re-spawns with a "
                        "fresh connection",
                        fabric_data_min, _fabric_recovery_failures,
                    )
                    restart_proc("sync")
                    actions.append("restart:sync(fabric_escalation)")
                    notes.append("fabric escalation: sync process restarted")
                    _fabric_recovery_failures = 0
            else:
                notes.append(
                    f"fabric stale; recovery on cooldown "
                    f"({cooldown_min:.0f}/{cooldown_limit} min)"
                )

        log_health(api_ok, sync_ok, last_sync,
                   ", ".join(actions) or "ok", "; ".join(notes))


def shutdown(*_):
    log.info("Shutting down watchdog…")
    _stop.set()
    rp = _rebuild_proc
    if rp is not None and rp.poll() is None:
        log.info("Terminating in-flight rebuild step")
        try:
            rp.terminate()
        except Exception:
            pass
    with _proc_lock:
        for name, p in _procs.items():
            if p.poll() is None:
                p.terminate()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    ensure_table()

    # Pre-flight code-health gate: byte-compile every backend Python file before
    # anything else starts. A syntactically broken backend (e.g. a botched edit
    # that leaves a file unparseable) must never be brought up: in a deployment
    # this fails the boot so the broken version is NOT promoted (the previous
    # healthy version keeps serving), and in dev it stops the watchdog loudly
    # instead of crash-looping a child process forever. This is the guard that
    # would have caught the sync_incremental.py IndentationError at publish time.
    try:
        chk = subprocess.run(
            [sys.executable, os.path.join(ROOT, "check_python_syntax.py")],
            cwd=ROOT, timeout=120,
        )
        if chk.returncode != 0:
            try:
                notify("CRITICAL", None, 0.0, "python_compile_check_failed")
            except Exception:
                pass
            log.error("Python compile check FAILED — backend has a syntax error; "
                      "refusing to start. Fix the error and republish.")
            sys.exit(1)
        log.info("Python compile check passed")
    except SystemExit:
        raise
    except Exception as e:
        # Fail CLOSED: if the checker itself can't run, we cannot prove the
        # backend is healthy, so refuse to start rather than risk bringing up a
        # broken version.
        try:
            notify("CRITICAL", None, 0.0, "python_compile_check_unrunnable")
        except Exception:
            pass
        log.error("Could not run python compile check: %s — refusing to start "
                  "(failing closed). Fix the cause and republish.", e)
        sys.exit(1)

    # Apply any pending schema migrations BEFORE the API or sync start, so the
    # database structure is current on every deploy. Runs against DATABASE_URL
    # (= Neon in the deployment). Idempotent; logs and continues on failure so a
    # migration issue stays observable without taking the whole service down.
    try:
        log.info("Applying schema migrations…")
        r = subprocess.run([sys.executable, os.path.join(ROOT, "migrate.py")],
                           cwd=ROOT, timeout=600)
        if r.returncode == 0:
            log.info("Schema migrations up to date")
        else:
            log.error("migrate.py exited %s — continuing startup; check schema", r.returncode)
    except Exception as e:
        log.error("Migration run failed: %s — continuing startup", e)
    log.info("Watchdog starting (manage_api=%s, api_port=%s)", MANAGE_API, API_PORT)

    if MANAGE_API:
        # Clear any stale uvicorn left holding the port (an orphan from a
        # crashed/replaced run) so the fresh API can bind instead of dying with
        # 'address already in use' while the orphan keeps serving stale code.
        free_port(API_PORT, log=log.info)
        spawn("api")
        # Wait until uvicorn actually binds the port before anything else is
        # allowed to hammer the DB. Bounded — after 60s we proceed anyway so a
        # degraded API can still be supervised/restarted by the health loop.
        import socket as _socket
        _deadline = time.time() + 60
        while time.time() < _deadline:
            try:
                with _socket.create_connection(("127.0.0.1", API_PORT), timeout=1):
                    log.info("API port %s is open — proceeding", API_PORT)
                    break
            except OSError:
                time.sleep(1)
        else:
            log.warning("API port %s still not open after 60s — proceeding "
                        "anyway (supervision will keep restarting it)", API_PORT)

    if REBUILD_ON_BOOT:
        # The API is up (so the deployment startup health check can pass); run
        # the one-time full rebuild synchronously now — BEFORE the supervised
        # sync loop and the supervise/health threads start — so nothing ever
        # overlaps it (an overlapping sync would double history).
        if not run_full_rebuild():
            # Fail closed: the rebuild may have left all_sales partially
            # populated. Do NOT resume the incremental sync (it heals only
            # recent days and would mask a broken history) and do NOT start the
            # health loop (which would auto-recover sync). Keep the API
            # supervised so the failure stays observable, log a CRITICAL
            # escalation, and idle until an operator intervenes (fix the cause
            # and republish, or unset REBUILD_ON_BOOT and republish to resume).
            notify("CRITICAL", None, 0.0, "rebuild_on_boot_failed")
            log.error("One-time rebuild FAILED — NOT starting sync; watchdog "
                      "idling in degraded mode, operator action required "
                      "(see replit.md).")
            threading.Thread(target=supervise_loop, daemon=True).start()
            while not _stop.is_set():
                time.sleep(1)
            return
        log.warning("Rebuild-on-boot result: ok")

        # Immediately refresh the BI sales rollups so exec-summary and the
        # Customers page use first-purchase classifications derived from the
        # freshly rebuilt all_sales, not the pre-rebuild ones.  Without this
        # the rollup stays stale (now > 2h threshold) and falls back to the
        # live unified-first-purchase CTE — correct but slow (~18s per exec-
        # summary load) until the sync loop's next hourly refresh fires.
        log.info("Rebuild-on-boot: refreshing BI sales rollups...")
        try:
            _rollup_proc = subprocess.Popen(
                [sys.executable, os.path.join(ROOT, "build_sales_rollups.py")],
                cwd=ROOT
            )
            rc_rollup = _rollup_proc.wait(timeout=600)
            if rc_rollup == 0:
                log.info("Rebuild-on-boot: rollup refresh complete")
            else:
                log.warning("Rebuild-on-boot: rollup refresh exited %s — "
                            "will self-heal on next sync cycle", rc_rollup)
        except Exception as _re:
            log.warning("Rebuild-on-boot: rollup refresh failed (%s) — "
                        "will self-heal on next sync cycle", _re)

    spawn("sync")

    threading.Thread(target=supervise_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    log.info("Watchdog up — supervising %s", ", ".join(_procs.keys()))

    while not _stop.is_set():
        time.sleep(1)


if __name__ == "__main__":
    main()
