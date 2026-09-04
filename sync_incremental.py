import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta
import time
import logging
import uuid
from contextlib import contextmanager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]


# The watchdog's main-cycle liveness/recovery decision keys off ONLY the
# `sync_heartbeat` row (the sales/inventory cycle). The fabric worker runs on its
# own ~60s thread and must NOT write that row — otherwise its frequent beats
# would keep `sync_heartbeat` fresh even if the main cycle hangs, and the watchdog
# would never recover a stalled Main-BI sync. So fabric gets its OWN separate
# heartbeat table for /fabric observability. Both tables share the same shape.
_HEARTBEAT_TABLES = ("sync_heartbeat", "fabric_heartbeat", "sales_heartbeat")


def ensure_heartbeat_table(conn, table="sync_heartbeat"):
    assert table in _HEARTBEAT_TABLES, table
    with conn.cursor() as c:
        c.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                id            INT PRIMARY KEY DEFAULT 1,
                last_cycle_at TIMESTAMPTZ,
                last_status   TEXT,
                CONSTRAINT {table}_single CHECK (id = 1)
            )
        """)
    conn.commit()


def write_heartbeat(conn, status, table="sync_heartbeat"):
    """Record that a sync loop is alive and making progress.

    Deliberately decoupled from data freshness (all_sales.loaded_at): during
    quiet periods with no new sales, loaded_at stops advancing even though the
    loop is perfectly healthy. The watchdog keys off the `sync_heartbeat` table
    so it never restarts a working sync just because business was slow. The
    fabric worker passes table="fabric_heartbeat" so its independent ~60s beats
    can never mask a stalled main cycle from the watchdog.
    """
    assert table in _HEARTBEAT_TABLES, table
    try:
        with conn.cursor() as c:
            c.execute(
                f"""
                INSERT INTO {table} (id, last_cycle_at, last_status)
                VALUES (1, now(), %s)
                ON CONFLICT (id) DO UPDATE
                    SET last_cycle_at = now(), last_status = EXCLUDED.last_status
            """,
                (status,),
            )
        conn.commit()
    except Exception as e:
        log.warning("heartbeat write failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


def run_subprocess_with_heartbeat(
    cmd, status, interval=60, timeout=None, heartbeat_table="sync_heartbeat"
):
    """Run a blocking subprocess while keeping the sync heartbeat fresh.

    The heavy image extracts (Odoo base64 + the Shopify gallery crawl) sit in a
    stretch of the cycle that writes NO per-step heartbeat, and a first-time
    bootstrap crawl of tens of thousands of SKUs can easily run longer than the
    watchdog's staleness window (SYNC_FRESH_MIN). Without a keepalive the
    watchdog would treat the loop as stuck, restart the sync mid-crawl, and —
    because the gallery extract commits its TRUNCATE+repopulate in a SINGLE
    transaction at the very end — the crawl would be killed before it commits
    and prod's product_image_urls would never populate (an unbreakable loop).

    A daemon thread pulses the heartbeat on its OWN short-lived connection
    (never the caller's `conn`, which is not thread-safe to share) every
    `interval` seconds until the subprocess returns. Raises on non-zero exit
    (check=True) so the caller's existing try/except still handles failures.
    """
    import subprocess
    import threading

    stop = threading.Event()

    assert heartbeat_table in _HEARTBEAT_TABLES, heartbeat_table

    def _pulse():
        hb_conn = None
        try:
            hb_conn = psycopg2.connect(DATABASE_URL)
            hb_conn.autocommit = True
            while not stop.wait(interval):
                try:
                    with hb_conn.cursor() as c:
                        c.execute(
                            f"""
                            INSERT INTO {heartbeat_table} (id, last_cycle_at, last_status)
                            VALUES (1, now(), %s)
                            ON CONFLICT (id) DO UPDATE
                                SET last_cycle_at = now(), last_status = EXCLUDED.last_status
                        """,
                            (status,),
                        )
                except Exception as e:
                    log.warning("heartbeat keepalive write failed: %s", e)
        except Exception as e:
            log.warning("heartbeat keepalive connection failed: %s", e)
        finally:
            if hb_conn is not None:
                try:
                    hb_conn.close()
                except Exception:
                    pass

    t = threading.Thread(target=_pulse, daemon=True)
    t.start()
    try:
        subprocess.run(cmd, check=True, timeout=timeout)
    finally:
        stop.set()
        t.join(timeout=5)


@contextmanager
def heartbeat_keepalive(status, interval=60):
    """Keep the sync heartbeat fresh across a slow IN-PROCESS blocking call.

    Same guarantee as run_subprocess_with_heartbeat but for work that is NOT a
    subprocess — e.g. an internal HTTP POST that can legitimately run up to its
    server-side time budget (the social CRM sync's 240s per surface). A daemon
    thread pulses sync_heartbeat on its OWN short-lived autocommit connection
    (never the caller's `conn`, which is not thread-safe to share) every
    `interval` seconds until the `with` block exits, so a long deep-backfill run
    cannot look "stuck" to the watchdog and get killed mid-cycle.
    """
    import threading

    stop = threading.Event()

    def _pulse():
        hb_conn = None
        try:
            hb_conn = psycopg2.connect(DATABASE_URL)
            hb_conn.autocommit = True
            while not stop.wait(interval):
                try:
                    with hb_conn.cursor() as c:
                        c.execute(
                            """
                            INSERT INTO sync_heartbeat (id, last_cycle_at, last_status)
                            VALUES (1, now(), %s)
                            ON CONFLICT (id) DO UPDATE
                                SET last_cycle_at = now(), last_status = EXCLUDED.last_status
                        """,
                            (status,),
                        )
                except Exception as e:
                    log.warning("heartbeat keepalive write failed: %s", e)
        except Exception as e:
            log.warning("heartbeat keepalive connection failed: %s", e)
        finally:
            if hb_conn is not None:
                try:
                    hb_conn.close()
                except Exception:
                    pass

    t = threading.Thread(target=_pulse, daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join(timeout=5)


# ── Durable per-source pull-failure trail ────────────────────────────────────
# A dead sales source used to be a console-only `log.error(...)` line: on
# 13-Aug-2026 the Odoo login lost POS read access and Kenya sales froze 19+
# hours while every badge stayed green. These helpers persist source-tagged
# failure/recovery rows into sync_health_log (the watchdog's table) so the
# outage is queryable and /api/sync-status can surface it.
#
# Rate limiting: the sales worker retries every ~60s, so a broken source would
# otherwise write ~1.4k rows/day. We log on the ok→failing transition, then at
# most once per SOURCE_FAILURE_RELOG_SEC while it stays broken, and once on
# recovery. State is in-process; all callers run under _SALES_SYNC_LOCK.
# Both helpers use their own cursor, commit themselves, and NEVER raise —
# callers have just rolled back (failure) or committed (success), so the
# transaction is clean, and health bookkeeping must never break the sync.

SOURCE_FAILURE_RELOG_SEC = int(os.environ.get("SOURCE_FAILURE_RELOG_SEC", "3600"))
_SOURCE_FAIL_STATE = {}  # source -> {failing, first_failed_at, last_logged_at, fail_count}
_HEALTH_LOG_SOURCE_COLS_READY = False


def _ensure_health_log_source_cols(conn):
    """sync_health_log is created by watchdog.py; make sure it exists here too
    (fresh DBs) and carries the source/error columns (additive, same pattern
    as api_pg's data_quality_score migration)."""
    global _HEALTH_LOG_SOURCE_COLS_READY
    if _HEALTH_LOG_SOURCE_COLS_READY:
        return
    with conn.cursor() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_health_log (
                id BIGSERIAL PRIMARY KEY,
                checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                api_healthy BOOLEAN,
                sync_healthy BOOLEAN,
                last_sync_at TIMESTAMPTZ,
                action_taken TEXT,
                notes TEXT
            )
        """
        )
        c.execute("ALTER TABLE sync_health_log ADD COLUMN IF NOT EXISTS source TEXT")
        c.execute("ALTER TABLE sync_health_log ADD COLUMN IF NOT EXISTS error TEXT")
    conn.commit()
    _HEALTH_LOG_SOURCE_COLS_READY = True


def record_source_failure(conn, source, error, now=None):
    """Persist a rate-limited `source_failure` row. Returns True if written."""
    try:
        now = now or datetime.now(timezone.utc)
        st = _SOURCE_FAIL_STATE.get(source)
        if st is None or not st.get("failing"):
            st = {
                "failing": True,
                "first_failed_at": now,
                "last_logged_at": None,
                "fail_count": 0,
            }
            _SOURCE_FAIL_STATE[source] = st
        st["fail_count"] += 1
        last = st["last_logged_at"]
        if last is not None and (now - last).total_seconds() < SOURCE_FAILURE_RELOG_SEC:
            return False
        _ensure_health_log_source_cols(conn)
        if st["fail_count"] == 1:
            notes = f"{source} pull failed"
        else:
            first = st["first_failed_at"].strftime("%Y-%m-%d %H:%M")
            notes = (
                f"{source} pull still failing ({st['fail_count']} failures "
                f"since {first}Z)"
            )
        with conn.cursor() as c:
            c.execute(
                """
                INSERT INTO sync_health_log
                    (action_taken, notes, source, error)
                VALUES ('source_failure', %s, %s, %s)
            """,
                (notes, source, str(error)[:800]),
            )
        conn.commit()
        st["last_logged_at"] = now
        return True
    except Exception as e:  # pragma: no cover - defensive
        log.warning("record_source_failure(%s) could not write: %s", source, e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def record_source_success(conn, source, now=None):
    """On a failing→ok transition, persist one `source_recovered` row."""
    st = _SOURCE_FAIL_STATE.get(source)
    if not st or not st.get("failing"):
        return False
    try:
        now = now or datetime.now(timezone.utc)
        # Flip state FIRST: rate-limit correctness beats a best-effort row.
        st["failing"] = False
        dur_min = int(round((now - st["first_failed_at"]).total_seconds() / 60.0))
        notes = (
            f"{source} pull recovered after {st['fail_count']} failure(s) "
            f"over ~{dur_min} min"
        )
        st["fail_count"] = 0
        st["last_logged_at"] = None
        _ensure_health_log_source_cols(conn)
        with conn.cursor() as c:
            c.execute(
                """
                INSERT INTO sync_health_log (action_taken, notes, source)
                VALUES ('source_recovered', %s, %s)
            """,
                (notes, source),
            )
        conn.commit()
        return True
    except Exception as e:  # pragma: no cover - defensive
        log.warning("record_source_success(%s) could not write: %s", source, e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


STORES = [
    {
        "store_id": "vivo-uganda",
        "store_url": os.environ["SHOPIFY_UGANDA_STORE"],
        "token": os.environ["SHOPIFY_UGANDA_TOKEN"],
        "country": "Uganda",
        "currency": "UGX",
        "vat": 1.18,
    },
    {
        "store_id": "vivo-rwanda",
        "store_url": os.environ["SHOPIFY_RWANDA_STORE"],
        "token": os.environ["SHOPIFY_RWANDA_TOKEN"],
        "country": "Rwanda",
        "currency": "RWF",
        "vat": 1.18,
    },
    # shop-zetu handled separately via ShopifyQL
]

UGANDA_LOCATIONS = {
    59649392798: "The Oasis Mall",
    111194112366: "Vivo Acacia",
}
RWANDA_LOCATIONS = {
    65931444396: "Vivo Kigali Heights",
    69236097196: "Vivo M-peace Plaza",
}

SITE_LOCATION_MAP = {
    # Kenya — keys are EXACTLY what FootfallCam's API sends (SiteName)
    "Sarit Centre": "Vivo Sarit",
    "VFGJUNCTION": "Vivo Junction",
    "Vivo Junction": "Vivo Junction",
    "VIVO Mama Ngina": "Vivo Mama Ngina St",
    "Yaya Centre": "Vivo Yaya",
    "VivoVillageMKT": "Vivo Village Market",
    "VIVO Capital": "Vivo Capital Centre",
    "Vivo Imaara": "Vivo Imaara",
    "VIVO Mombasa": "Vivo City Mall",
    "VFGELDORET": "Vivo Eldoret",
    "VIVO Galleria": "Vivo Galleria",
    "VFGGALLERIAMALL": "Vivo Galleria",
    "VIVO Gardencity": "Vivo Garden City",
    "The Hub": "Vivo Hub",
    "VFGTHEHUB": "Vivo Hub",
    "VivoKisumu": "Vivo Kisumu",
    "VIVO MERU": "Vivo Meru",
    "Vivo MoiAV": "Vivo Moi Avenue",
    "Shop Zetu_MoiAv": "Vivo Moi Avenue",
    "Vivo_MSA_DigoRD": "Vivo MSA Digo Road",
    "VIVO Westside": "Vivo Nakuru",
    "Vivo Runda Mall": "Vivo Runda",
    "VFGSIGNATURE": "Vivo Signature Mall",
    "Vivo Greenspan": "Vivo Greenspan",
    "Vivo TRM": "Vivo TRM",
    "Two Rivers": "Vivo Two Rivers",
    "VIVO T-Mall": "Vivo T- Mall",
    "VFG T-MALL": "Vivo T- Mall",
    "KILELESHWA": "Vivo Kileleshwa",
    "Safari Sarit": "Safari Sarit",
    "Zoya Sarit": "Zoya Sarit",
    # Uganda
    " Oasis mall": "The Oasis Mall",
    "Acacia Mall": "Vivo Acacia",
    # Rwanda
    "Vivo Kigali ": "Vivo Kigali Heights",
    " Kigali M-peace": "Vivo M-peace Plaza",
}

# Canonical config_name → pos_location_name map now lives in the env-free
# odoo_locations.py so api_pg.py can import it without importing this module
# (which reads SHOPIFY_*/DATABASE_URL env vars at import time).
from odoo_locations import ODOO_LOCATION_MAP
from extract_odoo_inventory import LOCATION_COUNTRY_MAP
from transform_all_customers import norm_email, norm_phone, norm_name

UGANDA_VAT_LOCATIONS = {"The Oasis Mall", "Vivo Acacia"}
RWANDA_VAT_LOCATIONS = {"Vivo Kigali Heights", "Vivo M-peace Plaza"}


def get_exchange_rates(cur):
    """Get latest exchange rates from currency_rates table"""
    cur.execute("""
        SELECT DISTINCT ON (country) country, rate
        FROM currency_rates
        ORDER BY country, month DESC
    """)
    rates = {row[0]: float(row[1]) for row in cur.fetchall()}
    return rates


def get_vat(pos_location, store_vat=1.16):
    if pos_location in UGANDA_VAT_LOCATIONS:
        return 1.18
    if pos_location in RWANDA_VAT_LOCATIONS:
        return 1.18
    return store_vat


# How many days before the last known sale to re-pull each run. Defaults to 2
# (incremental overlap); the watchdog widens this for recovery backfills via the
# --days flag / SYNC_LOOKBACK_DAYS env var.
LOOKBACK_DAYS = int(os.environ.get("SYNC_LOOKBACK_DAYS", "2"))
# Module-level guard so the fabric (Odoo) extract runs at most once per minute even
# though main() is invoked every 60s by the supervising loop. Persists for the
# lifetime of the process.
_LAST_FABRIC_EXTRACT = None
# Guards the HEAVY fabric extract (full product reconcile + BOMs + stock moves +
# purchase orders — the slow, slow-changing pulls) to a much slower cadence so it
# never gates the fast ~60s product/inventory refresh. Default 30 min.
_LAST_FABRIC_HEAVY_EXTRACT = None
# Handle to the currently-running heavy extract subprocess (if any). The heavy
# pull is launched NON-BLOCKING (Popen, fire-and-forget) so the ~60s fast
# product/inventory refresh keeps firing every cycle while it runs; this handle
# is the concurrency guard so we never start a second heavy run on top of one
# still in flight. A pg advisory lock inside extract_fabric.py --mode heavy is
# the belt-and-braces guard against a concurrent standalone run.
_FABRIC_HEAVY_PROC = None
# UTC time the current heavy subprocess was launched, so a stalled/hung heavy run
# can be killed once it exceeds FABRIC_HEAVY_TIMEOUT_SEC (the Popen is
# non-blocking, so the timeout is enforced by the loop when it reaps the proc).
_FABRIC_HEAVY_STARTED_AT = None
FABRIC_HEAVY_INTERVAL_SEC = int(os.environ.get("FABRIC_HEAVY_INTERVAL_SEC", "1800"))
# Hard timeout for the fabric (Odoo) extract subprocess so a hung/slow Odoo pull
# can't stall the whole sync loop indefinitely. On timeout the subprocess is
# killed, the failure is logged, and the loop continues (the next cycle retries).
# The fast path is quick; the heavy path gets its own (longer) timeout below.
FABRIC_EXTRACT_TIMEOUT_SEC = int(os.environ.get("FABRIC_EXTRACT_TIMEOUT_SEC", "600"))
FABRIC_HEAVY_TIMEOUT_SEC = int(os.environ.get("FABRIC_HEAVY_TIMEOUT_SEC", "900"))
# extract_fabric.py exit-code contract: 0 = success, 1 = error, 3 = the run
# SKIPPED because another fabric run holds the pg advisory lock (nothing was
# extracted, _loaded_at did not advance). The worker treats 3 specially: no
# fabric heartbeat (a fresh beat would hide real data staleness from the
# watchdog) and no 60s rate-limit stamp (the next ~20s tick retries
# immediately, so the fast pull lands the moment the lock is released).
FABRIC_EXTRACT_EXIT_LOCK_SKIP = 3
# Tick of the dedicated fabric worker thread (fabric_worker_loop). The worker
# checks/reaps every tick but the FAST pull itself is still gated to ~60s by the
# _LAST_FABRIC_EXTRACT rate-limit below; a sub-60s tick means a fast pull that
# slips one tick is retried within seconds, so the /fabric feed reliably stays
# within ~1min (well under the 180s "running behind" banner threshold) instead of
# refreshing only once per full sales/inventory cycle (10-15 min).
FABRIC_WORKER_TICK_SEC = int(os.environ.get("FABRIC_WORKER_TICK_SEC", "20"))

# ---------------------------------------------------------------------------
# Dedicated sales fast-path worker (sales_worker_loop). Sales were only landing
# in all_sales once per FULL main() cycle, and the cycle has grown from the
# original ~1 min to 45-90 min (Shop Zetu inventory matching alone can run
# ~20 min), so dashboard sales sat up to ~1.5h stale. Same cure as /fabric:
# run the CHEAP sales pulls (Shopify stores + Odoo POS, ~5-30s total) on their
# own ~60s daemon-thread timer with a short sliding watermark window, while the
# main cycle keeps its wide multi-day self-healing anchors as the safety net.
# _SALES_SYNC_LOCK serialises the worker and the main cycle so their
# DELETE+INSERT passes over the same orders can never interleave (both paths
# are idempotent, the lock just removes the race entirely). The worker writes
# its OWN sales_heartbeat table — never sync_heartbeat — for the same reason
# fabric does: an independent beat must not hide a stalled main cycle from the
# watchdog.
# ---------------------------------------------------------------------------
import threading as _threading

_SALES_SYNC_LOCK = _threading.Lock()
SALES_WORKER_ENABLED = os.environ.get(
    "SALES_WORKER_ENABLED", "1"
).strip().lower() not in (
    "0",
    "false",
    "no",
)
SALES_WORKER_TICK_SEC = int(os.environ.get("SALES_WORKER_TICK_SEC", "60"))
# Sliding re-pull window per tick. New orders always carry a fresh
# write_date/updated_at so 30 min is generous; anything older (rare late edits,
# gap repairs) is covered by the main cycle's wide anchors each cycle.
SALES_WORKER_WINDOW_MIN = int(os.environ.get("SALES_WORKER_WINDOW_MIN", "30"))
# Shop Zetu rides ShopifyQL via a subprocess whose default window is ~4 days
# (DELETE+INSERT per day) — heavier than the in-process pulls, so it runs on a
# slower cadence inside the worker.
SALES_WORKER_SZ_INTERVAL_SEC = int(
    os.environ.get("SALES_WORKER_SZ_INTERVAL_SEC", "300")
)
SALES_WORKER_SZ_TIMEOUT_SEC = int(os.environ.get("SALES_WORKER_SZ_TIMEOUT_SEC", "300"))
_LAST_SALES_WORKER_SZ = None

# Same once-per-minute guard for the fabric consumption/returns sheet override loader.
_LAST_FABRIC_SHEET_EXTRACT = None
_LAST_RECON_RUN = None  # date of the last nightly reconciliation run
# Guards the fabric category update tracker (Task #295) — detection + Google Sheet
# mirror — to once every 5 minutes even though main() runs every 60s.
_LAST_FABRIC_CAT_TRACKER = None
# Guards the production tracker (Odoo DPS buying & manufacturing orders) sync to
# once per 30 minutes even though main() runs every 60s.
_LAST_PRODUCTION_SYNC = None
# Guards the Production Tracker Sheet feed (production_tracker_sheet_sync.py —
# governed Google Sheets ingestion, Task #1607) to once per 24 hours: this is a
# daily-class production-reporting cadence, not a wallboard-style poll. None on
# boot so a fresh DB gets its first live-sheet attempt (or seed check) promptly.
_LAST_TRACKER_SHEET_SYNC = None
# Guards the MO fabric-consumption extract (extract_mo_fabric_consumption.py —
# Done DPS manufacturing-order fabric usage feeding the "Avg metres per garment"
# KPI) to once per 30 minutes even though main() runs every 60s. None on boot so
# a fresh prod DB bootstraps on the first cycle.
_LAST_MO_FABRIC_CONSUMPTION = None
# Guards the Central Tracker Google Sheet extract (extract_central_tracker.py —
# Style No, Style Name, Order Qty, Order Date from the 4 year-tabs of the
# Central Tracker sheet → central_tracker_orders table) to once per 30 minutes
# even though main() runs every 60s. None on boot so a fresh prod DB bootstraps
# on the first cycle (or an empty table is filled immediately on restart).
_LAST_CENTRAL_TRACKER = None
# Module-level guard so attendance syncs at most once per hour even though main()
# runs every 60s. None on boot so the first cycle after a (re)start refreshes
# immediately. Persists for the lifetime of the process.
_LAST_ATTENDANCE_SYNC = None
# Guards the BI sales-rollup refresh (build_sales_rollups.py) to once per hour even
# though main() runs every 60s. The rollup windows are CURRENT_DATE-relative, so a
# daily refresh is the floor; hourly keeps them comfortably inside the read-path
# freshness gate. None on boot so the first cycle bootstraps immediately.
_LAST_ROLLUP_REFRESH = None
# Guards the product image extract (extract_product_images.py — base64 512px
# product photos from Odoo, feeding the /gallery thumbnails) to once per 24h
# even though main() runs every 60s. Product photos change rarely and this is
# the heaviest Odoo pull (full image fetch per template), so a daily cadence is
# plenty. None on boot so a fresh prod DB bootstraps on the first cycle.
_LAST_PRODUCT_MASTER_SYNC = (
    None  # nightly: extract_odoo_products + transform_all_products_clean
)
# Guards the Odoo stock-transfers extract (extract_odoo_transfers.py — pulls
# incoming pickings destined for known stores, in-flight plus last 7d done)
# to once per hour. None on boot so a fresh prod DB populates on the first cycle.
_LAST_TRANSFERS_SYNC = None
_LAST_PRODUCT_IMAGES_EXTRACT = None
# Guards the Shopify product-image GALLERY extract (extract_shopify_images.py —
# the multi-image scrollable lightbox gallery in product_image_urls, distinct
# from the single Odoo base64 photo above) to once per 24h. None on boot so a
# fresh prod DB bootstraps on the first cycle.
_LAST_SHOPIFY_IMAGES_EXTRACT = None
# Guards the FABRIC product-image extract (extract_fabric_images.py — ODOO-only:
# primary image_1920 'Face' at idx=-1 + product.image gallery photos labeled by
# their Odoo name e.g. 'Back', feeding the /fabric barcode-detail popup carousel
# via the fabric_images table) to once per 24h even though main() runs every 60s.
# Fabric photos change rarely and this is a per-template base64 fetch. None on
# boot so a fresh prod DB bootstraps on the first cycle. Dormant (no-op) until
# the ODOO_* secrets are set. The extract also purges retired drive/upload rows.
_LAST_FABRIC_IMAGES_EXTRACT = None
# Guards the social CRM sync (Facebook + Instagram → vivo-crm Inbox, feeding
# crm_social_feedback) to once per hour even though main() runs every 60s. The
# per-surface deep-backfill is cumulative toward its stored-row targets and
# resumes from persisted cursors, so an hourly cadence keeps the Inbox fresh
# without staff pressing "Sync". None on boot so a fresh prod DB bootstraps on
# the first cycle.
_LAST_SOCIAL_CRM_SYNC = None
# Guards the data-validation agent (validation_agent.run) to once per hour even
# though main() runs every 60s. The agent self-skips outside its active window
# (06:00-22:00 Africa/Nairobi), so this hourly cadence yields one audit per hour
# inside that window. None on boot so the first cycle runs immediately (the agent
# itself decides whether it is within active hours).
_LAST_VALIDATION_RUN = None


def _validation_gate(last_run, now_utc):
    """Pure schedule gate for the data-validation agent (unit-tested).

    Returns ``(due, stamp)``. On the first cycle after a (re)start
    (``last_run is None``) the agent must NOT fire: a fresh prod VM has cold
    API caches, and the agent's cross-surface HTTP sweep on top of the boot
    prewarm burst starved the event loop long enough to fail the platform
    runtime healthcheck (2026-08-13 uptime-monitor outage). The stamp is
    back-dated 30 minutes instead, so the first audit lands ~30 min after
    boot; afterwards the normal hourly cadence applies unchanged.
    """
    if last_run is None:
        return False, now_utc - timedelta(minutes=30)
    return (now_utc - last_run).total_seconds() >= 3600, last_run


# Guards the X (Twitter) CRM inbox sync to once per hour even though main() runs
# every 60s. The sync is idempotent + cursor-resumed, so hourly keeps the inbox
# fresh without hammering X's rate-limited API tiers. None on boot so a fresh
# prod DB bootstraps the inbox on the first cycle.
_LAST_X_SYNC = None
# Guards the TikTok CRM inbox sync to once per hour (same rationale as X above):
# idempotent + cursor-resumed, so hourly keeps posts+comments fresh without
# hammering TikTok's rate-limited API. None on boot so a fresh prod DB bootstraps
# the inbox on the first cycle.
_LAST_TIKTOK_SYNC = None
_LAST_GREVIEWS_SYNC = None
# Guards the incremental Odoo customer sync (extract_odoo_customers.py by
# write_date + gap-fill for partner IDs in all_sales not yet in
# raw_odoo_customers) to once per hour. None on boot so the first cycle
# picks up any customers missed since the last full rebuild immediately.
_LAST_ODOO_CUSTOMER_SYNC = None
# Guards the inventory extracts (Odoo + Shopify + Shop Zetu stock levels feeding
# all_inventory). Was once-a-day at midnight EAT, which left shelf stock up to
# ~24h stale — so the replenishment engine could recommend moving a unit that had
# already sold earlier that day. Now polled on a fast interval (default 5 min,
# override with INVENTORY_SYNC_INTERVAL_SEC) so all_inventory is near-live. None
# on boot so the first cycle after a (re)start refreshes immediately.
_LAST_INVENTORY_SYNC = None
INVENTORY_SYNC_INTERVAL_SEC = int(os.environ.get("INVENTORY_SYNC_INTERVAL_SEC", "300"))
# ── Attendance Sync ───────────────────────────────────────────────────────────
ATTENDANCE_API_URL = os.environ.get(
    "ATTENDANCE_API_URL",
    "https://0db75fc1b46ded8b-197-248-176-58.serveousercontent.com",
)


def ensure_attendance_table(cur):
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
        );
        CREATE INDEX IF NOT EXISTS idx_vivo_att_date     ON vivo_attendance (attendance_date);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_branch   ON vivo_attendance (branch_name);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_employee ON vivo_attendance (employee_name);
        CREATE INDEX IF NOT EXISTS idx_vivo_att_location ON vivo_attendance (location);
    """)


def get_attendance_cursor(cur):
    cur.execute("SELECT MAX(attendance_date) FROM vivo_attendance")
    result = cur.fetchone()[0]
    if result:
        from datetime import timedelta

        return (result - timedelta(days=2)).strftime("%Y-%m-%d")
    return "2000-01-01"


def sync_attendance(cur):
    since = get_attendance_cursor(cur)
    log.info("Syncing attendance since %s", since)
    headers = {
        "ngrok-skip-browser-warning": "true",
        "User-Agent": "python-requests/2.31.0",
    }

    # Retry up to 3 times on SSL/connection errors
    for attempt in range(3):
        try:
            resp = requests.get(
                f"{ATTENDANCE_API_URL}/attendance",
                params={"since": since},
                headers=headers,
                timeout=120,
                verify=False,  # skip SSL verification for ngrok
            )
            resp.raise_for_status()
            break
        except Exception as e:
            log.warning("Attendance fetch attempt %d failed: %s", attempt + 1, e)
            if attempt == 2:
                raise
            time.sleep(10)

    data = resp.json()
    rows = data.get("rows", [])
    if not rows:
        log.info("Attendance — no new records")
        return 0

    # Deduplicate
    seen = set()
    deduped = []
    for r in rows:
        key = (r["user_id"], r["branch_name"], r["attendance_date"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    log.info("Attendance — %d records after dedup (from %d)", len(deduped), len(rows))

    values = [
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
        for r in deduped
    ]
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
            ON CONFLICT (user_id, branch_name, attendance_date)
            DO UPDATE SET
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
        values,
        page_size=500,
    )
    log.info("✅ Attendance — %d records upserted", len(rows))
    return len(rows)


def get_last_sync(cur, store_id):
    cur.execute(
        "SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = %s", (store_id,)
    )
    result = cur.fetchone()[0]
    if result:
        since = result - timedelta(days=LOOKBACK_DAYS)
        return since.strftime("%Y-%m-%dT%H:%M:%SZ")
    return "2019-01-01T00:00:00Z"


def fetch_orders(store_url, token, since, limit=250):
    headers = {"X-Shopify-Access-Token": token}
    url = f"https://{store_url}/admin/api/2025-10/orders.json"
    params = {
        "status": "any",
        "updated_at_min": since,
        "limit": limit,
        "order": "updated_at asc",
    }
    all_orders = []
    seen_ids = set()
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    time.sleep(int(resp.headers.get("Retry-After", 10)))
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt + 1, e)
                time.sleep(10)
        orders = resp.json().get("orders", [])
        for o in orders:
            if o["id"] not in seen_ids:
                seen_ids.add(o["id"])
                all_orders.append(o)
        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_orders


KENYA_LOCATION_ID_MAP = {
    36310057056: "Vivo Sarit",
    36309925984: "Vivo Junction",
    36309958752: "Vivo Mama Ngina St",
    49383899291: "Vivo Moi Avenue",
    36309893216: "Vivo Garden City",
    36309991520: "Vivo Capital Centre",
    62460067995: "Vivo Imaara",
    50320343195: "Vivo Eldoret",
    61614751899: "Vivo Kisumu",
    36478648416: "Vivo Galleria",
    49363222683: "Vivo Hub",
    50320408731: "Vivo City Mall",
    50320277659: "Vivo Nakuru",
    73530376347: "Vivo Runda",
    66861301915: "Vivo Greenspan",
    66839806107: "Vivo Kileleshwa",
    66799567003: "Vivo Meru",
    69343084699: "Vivo MSA Digo Road",
    71464648859: "Safari Sarit",
    66820767899: "Staff purchases",
    66799599771: "vivowoman",
    49363320987: "Vivo Village Market",
    36478582880: "Vivo Yaya",
    49383833755: "Vivo Two Rivers",
    71464747163: "Vivo Village Market",
    63040127131: "Vivo TRM",
    61123592347: "Vivo Signature Mall",
    49363550363: "Vivo T- Mall",
    71464485019: "Zoya Sarit",
}


def get_pos_location(store, order):
    store_id = store["store_id"]
    location_id = order.get("location_id")
    fulfillments = order.get("fulfillments", [])
    if not location_id and fulfillments:
        location_id = fulfillments[0].get("location_id")
    if store_id == "vivo-uganda":
        return UGANDA_LOCATIONS.get(location_id, "Uganda")
    if store_id == "vivo-rwanda":
        return RWANDA_LOCATIONS.get(location_id, "Rwanda")
    if store_id == "shop-zetu":
        return "Online - Shop Zetu"
    if store_id == "vivowoman":
        return KENYA_LOCATION_ID_MAP.get(location_id, "vivowoman")
    return "vivowoman"


def process_shopify_store(store, cur, now, rates, since_override=None):
    store_id = store["store_id"]
    # since_override (sales_worker_loop fast path) = short sliding updated_at
    # window; default (main cycle) = wide MAX(sale_date)-LOOKBACK_DAYS anchor.
    since = since_override or get_last_sync(cur, store_id)
    log.info("Syncing %s since %s", store_id, since[:10])

    orders = fetch_orders(store["store_url"], store["token"], since)
    if not orders:
        log.info("%s — no new orders", store_id)
        return 0

    order_ids = [str(o["id"]) for o in orders]

    # Keep raw_shopify_orders (order headers WITH time-of-day in created_at)
    # fresh: the Overview "Sales by Hour" chart reads it, and outside a full
    # extract nothing else refreshes it. Data is already in hand — no extra
    # Shopify calls.
    hdr_rows = []
    for o in orders:
        cust = o.get("customer") or {}
        billing = o.get("billing_address") or {}
        shipping = o.get("shipping_address") or {}
        cust_id = cust.get("id")
        hdr_rows.append(
            (
                str(o["id"]),
                store_id,
                o.get("name", ""),
                o.get("created_at", ""),
                o.get("updated_at", ""),
                str(cust_id) if cust_id else None,
                cust.get("email"),
                cust.get("first_name"),
                cust.get("last_name"),
                float(o.get("total_price") or 0),
                o.get("financial_status", ""),
                o.get("fulfillment_status"),
                o.get("source_name"),
                billing.get("city"),
                billing.get("country"),
                shipping.get("city"),
                shipping.get("country"),
                now,
            )
        )
    if hdr_rows:
        execute_values(
            cur,
            """
            INSERT INTO raw_shopify_orders (
                id, store_id, name, created_at, updated_at,
                customer_id, customer_email, customer_first_name,
                customer_last_name, total_price, financial_status,
                fulfillment_status, source_name, billing_city,
                billing_country, shipping_city, shipping_country, _loaded_at
            ) VALUES %s
            ON CONFLICT (id, store_id) DO UPDATE SET
                updated_at         = EXCLUDED.updated_at,
                total_price        = EXCLUDED.total_price,
                financial_status   = EXCLUDED.financial_status,
                fulfillment_status = EXCLUDED.fulfillment_status,
                _loaded_at         = EXCLUDED._loaded_at
        """,
            hdr_rows,
        )

    rows = []

    for order in orders:
        order_id = str(order["id"])
        order_name = order.get("name", "")
        created_at = order.get("created_at", "")[:10]
        customer = order.get("customer") or {}
        customer_id = str(customer.get("id", "")) or None
        customer_type = "walk-in" if not customer_id else "registered"
        pos_location = get_pos_location(store, order)
        financial_status = order.get("financial_status", "")
        is_return = financial_status in ("refunded", "partially_refunded")
        sale_kind = "return" if is_return else "order"

        # Get exchange rate for this store's country
        rate = rates.get(store["country"], 1.0)
        vat = get_vat(pos_location, store["vat"])

        for line in order.get("line_items", []):
            sku = line.get("sku") or ""
            title = line.get("title", "")
            qty = int(line.get("quantity", 0))
            price = float(line.get("price", 0))  # VAT-inclusive in store currency
            disc = float(line.get("total_discount", 0))

            # Match BigQuery: total_sales = price * qty (VAT-inclusive, store currency)
            total_sales = price * qty
            gross_sales = total_sales  # before discounts
            discounts = disc
            net_sales = total_sales  # Shopify net_sales = total after discount
            returns = total_sales if is_return else 0.0
            total_out = 0.0 if is_return else total_sales

            # Convert to KES using exchange rate (matching BigQuery formula)
            total_sales_kes = round(total_sales / rate, 2)
            gross_sales_kes = round(gross_sales / rate, 2)
            discounts_kes = round(discounts / rate, 2)
            returns_kes = round(returns / rate, 2)
            net_sales_kes = round(total_sales / vat / rate, 2)
            product_price_kes = round(price / rate, 2)

            rows.append(
                (
                    str(uuid.uuid4()),
                    store_id,
                    order_id,
                    order_name,
                    created_at,
                    created_at,
                    pos_location,
                    store["country"],
                    (
                        "POS"
                        if (store_id == "vivowoman" and pos_location != "vivowoman")
                        else pos_location
                        if store_id == "vivo-uganda"
                        else "Online"
                    ),
                    customer_id,
                    customer_type,
                    sale_kind,
                    title,
                    sku,
                    qty,
                    product_price_kes,
                    price,
                    gross_sales_kes,
                    discounts_kes,
                    net_sales_kes,
                    round(total_out / rate, 2),
                    qty if not is_return else 0,
                    returns_kes,
                    now,
                )
            )

    cur.execute(
        "DELETE FROM all_sales WHERE store_id = %s AND order_id = ANY(%s)",
        (store_id, order_ids),
    )

    if rows:
        execute_values(
            cur,
            """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """,
            _dedup_all_sales_rows(rows),
            page_size=500,
        )

    log.info("✅ %s — %d orders, %d lines synced", store_id, len(orders), len(rows))
    return len(rows)


def _dedup_all_sales_rows(rows):
    """Collapse duplicate sync rows on the all_sales business grain
    (store_id, order_id, product_title, variant_sku, sale_kind, sale_date),
    keeping the first occurrence. Replaces the former DB-level arbiter
    `ON CONFLICT (...) DO NOTHING` (the uq_all_sales_line unique index, which
    production never had and could not accept due to legacy duplicate rows).
    The per-order DELETE-by-window before each INSERT handles cross-run
    idempotency; this only removes intra-batch duplicates. Tuple positions
    match the INSERT column order: 1=store_id, 2=order_id, 4=sale_date,
    11=sale_kind, 12=product_title, 13=variant_sku."""
    seen = set()
    out = []
    for r in rows:
        key = (r[1], r[2], r[12], r[13] or "", r[11], r[4])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def sync_odoo(cur, now, rates, since_override=None):
    import xmlrpc.client

    ODOO_URL = os.environ["ODOO_URL"]
    ODOO_DB = os.environ["ODOO_DB"]
    ODOO_USER = os.environ["ODOO_USER"]
    ODOO_PASS = os.environ["ODOO_PASSWORD"]

    if since_override is not None:
        # Fast-path caller (sales_worker_loop): short sliding write_date window.
        # Skips the coverage-anchor query AND the ODOO_SYNC_SINCE/UNTIL repair
        # overrides — those belong to the main cycle's wide self-healing pass,
        # which still runs every cycle as the safety net.
        since = since_override
        until = None
    else:
        # Anchor `since` to the actual data coverage, NOT loaded_at alone: a full
        # rebuild (transform_all_sales) resets every row's loaded_at to "today", which
        # would push `since` ahead of the data we actually have (the raw Odoo source
        # can lag a few days), permanently skipping orders in the gap. LEAST(loaded_at,
        # sale_date) never runs ahead of real coverage, so the next sync self-heals.
        cur.execute("""
            SELECT LEAST(MAX(loaded_at::date), MAX(sale_date::date))
            FROM all_sales WHERE store_id = 'vivofashiongroup'
        """)
        result = cur.fetchone()[0]
        since = (
            (result - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
            if result
            else "2026-03-19 00:00:00"
        )

        # One-off gap-repair overrides (e.g. backfilling a window the anchor has
        # already run past). ODOO_SYNC_UNTIL bounds write_date so a repair run
        # cannot collide with the live sync's recent window.
        since = os.environ.get("ODOO_SYNC_SINCE", since)
        until = os.environ.get("ODOO_SYNC_UNTIL")
        if until and until <= since:
            raise ValueError(
                f"ODOO_SYNC_UNTIL ({until}) must be after the sync window start ({since})"
            )

    log.info(
        "Odoo sync since %s%s", since[:10], f" until {until[:10]}" if until else ""
    )

    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    domain = [
        ["write_date", ">=", since],
        ["state", "in", ["done", "invoiced", "paid", "posted"]],
    ]
    if until:
        domain.append(["write_date", "<", until])

    # Paginate oldest-first: pos.order's default sort is date_order DESC, so a
    # single limited search_read over a wide catch-up window silently keeps only
    # the NEWEST orders and drops the oldest days — then the `since` anchor
    # advances past the hole and it never self-heals (this is exactly how the
    # 2026-06-14..18 Kenya gap formed after a full rebuild).
    _BATCH = 5000
    orders = []
    offset = 0
    while True:
        batch = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASS,
            "pos.order",
            "search_read",
            [domain],
            {
                "fields": [
                    "id",
                    "name",
                    "date_order",
                    "write_date",
                    "state",
                    "amount_total",
                    "amount_tax",
                    "partner_id",
                    "config_id",
                    "lines",
                    "session_id",
                ],
                "order": "write_date asc, id asc",
                "limit": _BATCH,
                "offset": offset,
            },
        )
        orders.extend(batch)
        if len(batch) < _BATCH:
            break
        offset += _BATCH
        if offset >= 200000:  # hard safety cap (~1 year of orders)
            log.error(
                "Odoo sync: pagination safety cap reached at %s orders — window NOT fully "
                "drained; rerun with a narrower ODOO_SYNC_SINCE/ODOO_SYNC_UNTIL window",
                offset,
            )
            break

    if not orders:
        log.info("Odoo — no new orders")
        return 0

    order_ids = [str(o["id"]) for o in orders]

    line_ids_all = [lid for o in orders for lid in o.get("lines", [])]
    lines_data = {}
    if line_ids_all:
        lines = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASS,
            "pos.order.line",
            "search_read",
            [[["id", "in", line_ids_all]]],
            {
                "fields": [
                    "order_id",
                    "product_id",
                    "qty",
                    "price_unit",
                    "price_subtotal_incl",
                    "discount",
                    "product_uom_id",
                ]
            },
        )
        for l in lines:
            oid = str(l["order_id"][0])
            lines_data.setdefault(oid, []).append(l)
        # Fetch product SKUs (default_code) for all products in these lines
        prod_ids = list({l["product_id"][0] for l in lines if l.get("product_id")})
        sku_map = {}
        if prod_ids:
            prods = models.execute_kw(
                ODOO_DB,
                uid,
                ODOO_PASS,
                "product.product",
                "search_read",
                [[["id", "in", prod_ids]]],
                {"fields": ["id", "default_code"]},
            )
            sku_map = {p["id"]: (p.get("default_code") or "") for p in prods}

    config_ids = list(set(o["config_id"][0] for o in orders if o.get("config_id")))
    configs = {}
    if config_ids:
        cfg_data = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASS,
            "pos.config",
            "search_read",
            [[["id", "in", config_ids]]],
            {"fields": ["id", "name"]},
        )
        configs = {c["id"]: c["name"] for c in cfg_data}

    # Keep raw_odoo_pos_orders (order headers with UTC time-of-day in
    # date_order) fresh: the Overview "Sales by Hour" chart reads it, and
    # outside a full rebuild only extract_odoo_orders.py writes it. Data is
    # already in hand — no extra Odoo calls. Only a stable subset of columns
    # is written; ON CONFLICT leaves the extractor's richer fields untouched.
    hdr_rows = []
    for o in orders:
        hdr_rows.append(
            (
                int(o["id"]),
                o.get("name", ""),
                o.get("date_order", ""),
                int(o["config_id"][0]) if o.get("config_id") else None,
                configs.get(o["config_id"][0], "") if o.get("config_id") else "",
                int(o["session_id"][0]) if o.get("session_id") else None,
                int(o["partner_id"][0]) if o.get("partner_id") else None,
                o["partner_id"][1] if o.get("partner_id") else None,
                float(o.get("amount_total") or 0),
                float(o.get("amount_tax") or 0),
                # state MUST be written: transform_odoo filters
                # o.state IN ('done','paid','invoiced'), so a NULL-state header
                # written here makes a scoped/full re-transform silently drop
                # every order first seen by the sync (recent-day sales vanish).
                # The fetch domain already restricts to valid states.
                o.get("state") or "done",
                o.get("write_date", ""),
                now,
            )
        )
    if hdr_rows:
        execute_values(
            cur,
            """
            INSERT INTO raw_odoo_pos_orders (
                id, name, date_order, config_id, config_name, session_id,
                partner_id, partner_name, amount_total, amount_tax,
                state, write_date, _synced_at
            ) VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                amount_total = EXCLUDED.amount_total,
                amount_tax   = EXCLUDED.amount_tax,
                state        = EXCLUDED.state,
                write_date   = EXCLUDED.write_date,
                _synced_at   = EXCLUDED._synced_at
        """,
            hdr_rows,
        )

    kenya_rate = rates.get("Kenya", 1.0)

    rows = []
    for order in orders:
        order_id = str(order["id"])
        order_name = order.get("name", "")
        # Convert date_order from UTC to EAT (UTC+3) to match BigQuery
        from datetime import datetime as dt

        date_order_utc = order.get("date_order", "")
        try:
            date_order = (
                dt.strptime(date_order_utc[:19], "%Y-%m-%d %H:%M:%S")
                + timedelta(hours=3)
            ).strftime("%Y-%m-%d")
        except:
            date_order = date_order_utc[:10]
        partner = order.get("partner_id")
        customer_id = str(partner[0]) if partner else None
        customer_type = "walk-in" if not customer_id else "registered"
        config_name = (
            configs.get(order["config_id"][0], "") if order.get("config_id") else ""
        )
        pos_location = ODOO_LOCATION_MAP.get(config_name, config_name)

        # Odoo Kenya only — rate=1, but use correct VAT per location
        rate = kenya_rate  # always 1.0 for Kenya
        vat = get_vat(pos_location, 1.16)

        for line in lines_data.get(order_id, []):
            product = line.get("product_id")
            title = product[1] if product else ""
            qty = float(line.get("qty", 0))
            price_unit = float(line.get("price_unit", 0))  # VAT-inclusive unit price
            total_incl = float(
                line.get("price_subtotal_incl", 0)
            )  # VAT-inclusive line total
            disc_pct = float(line.get("discount", 0))

            # Skip shopping bags (match BigQuery filter)
            if "shopping bag" in title.lower():
                continue

            is_return = qty < 0
            sale_kind = "return" if is_return else "order"

            # Amount-as-quantity guard (mirrors transform_all_sales.transform_odoo):
            # a nominal KES-1/0 catch-all product whose quantity encodes the
            # charged amount (e.g. price_unit=1, qty=8600) must not count as real
            # units — left unclamped one such line inflates Units Sold / MSI / ASP.
            # Money fields are derived from price_subtotal_incl and stay correct.
            units_qty = abs(qty)
            if units_qty >= 20 and price_unit <= 1.0:
                units_qty = 1

            # total_sales must be GROSS (pre-discount, VAT-inclusive) to match
            # the Shopify convention: the KPI SQL computes
            # net = total_sales_kes − discounts_kes, so storing the
            # post-discount price_subtotal_incl here double-subtracted the
            # discount (and made Net Sales == Total Sales on no-promo days).
            raw_gross = price_unit * qty  # before discount
            discounts = max(raw_gross - total_incl, 0.0) if not is_return else 0.0
            # Reconstruct gross as post-discount + discount so that
            # total − discounts == price_subtotal_incl exactly, even when a
            # cashier price-override makes raw_gross < total_incl.
            total_sales = (total_incl + discounts) if not is_return else total_incl
            gross_sales = total_sales
            returns = abs(total_incl) if is_return else 0.0
            total_out = total_sales if not is_return else 0.0

            # KES conversion (rate=1 for Kenya, formula matches BigQuery)
            total_sales_kes = round(total_out / rate, 2)
            gross_sales_kes = round((gross_sales if not is_return else 0.0) / rate, 2)
            discounts_kes = round(discounts / rate, 2)
            returns_kes = round(returns / rate, 2)
            # Ex-VAT net stays on the POST-discount amount (unchanged basis)
            net_sales_kes = round(
                (total_incl if not is_return else 0.0) / vat / rate, 2
            )
            product_price_kes = round(price_unit / rate, 2)

            sku = sku_map.get(product[0], "") if product else ""
            rows.append(
                (
                    str(uuid.uuid4()),
                    "vivofashiongroup",
                    order_id,
                    order_name,
                    date_order,
                    date_order,
                    pos_location,
                    "Kenya",
                    "POS",
                    customer_id,
                    customer_type,
                    sale_kind,
                    title,
                    sku,
                    int(units_qty),
                    product_price_kes,
                    price_unit,
                    gross_sales_kes,
                    discounts_kes,
                    net_sales_kes,
                    total_sales_kes,
                    int(units_qty) if not is_return else 0,
                    returns_kes,
                    now,
                )
            )

    cur.execute(
        "DELETE FROM all_sales WHERE store_id = 'vivofashiongroup' AND order_id = ANY(%s)",
        (order_ids,),
    )

    if rows:
        execute_values(
            cur,
            """
            INSERT INTO all_sales (
                id, store_id, order_id, order_name, sale_date, day,
                pos_location_name, country, channel,
                customer_id, customer_type, sale_kind,
                product_title, variant_sku,
                ordered_item_quantity, product_price_kes, product_price,
                gross_sales_kes, discounts_kes, net_sales_kes,
                total_sales_kes, net_quantity, returns_kes, loaded_at
            ) VALUES %s
        """,
            _dedup_all_sales_rows(rows),
            page_size=500,
        )

    log.info("✅ Odoo — %d orders, %d lines synced", len(orders), len(rows))
    return len(rows)


def sync_odoo_customers_incremental(conn):
    """
    Two-step incremental Odoo customer sync:
    1. Run extract_odoo_customers.py (write_date-based incremental) to pick up
       new/updated partners since the last sync.
    2. Gap-fill: find Odoo partner IDs (small integers ≤ 8 digits) that already
       appear in all_sales but are still missing from raw_odoo_customers — these
       are customers linked to POS orders whose partner record was never captured
       (e.g. created before the first rebuild with customer_rank=0 at the time).
       Fetch them directly from Odoo and upsert.
    3. Upsert both groups into all_customers and backfill order stats from
       all_sales so LTV / order counts are correct immediately.
    """
    import xmlrpc.client
    import sys as _sys
    from datetime import datetime, timezone
    from psycopg2.extras import execute_values

    now_utc = datetime.now(timezone.utc)

    # Step 1 — incremental extract (write_date ≥ MAX(_synced_at) in table)
    run_subprocess_with_heartbeat(
        [_sys.executable, "/home/runner/workspace/extract_odoo_customers.py"],
        "odoo_customer_extract",
    )

    # Step 2 — gap-fill: Odoo partner IDs in all_sales not in raw_odoo_customers.
    # Windowed to the last 90 days: new customers only ever appear in RECENT
    # sales, and older gaps were filled by previous runs — scanning the full
    # multi-year all_sales (~1.3 GB) hourly was a guaranteed seq scan. On a
    # fresh DB the incremental extract above re-fetches all partners anyway,
    # so no historical gap can persist.
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT s.customer_id::bigint
            FROM all_sales s
            WHERE s.customer_id ~ '^[0-9]{1,8}$'
              AND s.sale_date >= to_char(now() - interval '90 days', 'YYYY-MM-DD')
              AND NOT EXISTS (
                  SELECT 1 FROM raw_odoo_customers r
                  WHERE r.id = s.customer_id::bigint
              )
            LIMIT 2000
        """)
        missing_ids = [row[0] for row in cur.fetchall()]

    if missing_ids:
        log.info(
            "Odoo customer gap-fill: fetching %d missing partner IDs...",
            len(missing_ids),
        )
        try:
            odoo_url = os.environ["ODOO_URL"]
            odoo_db = os.environ["ODOO_DB"]
            odoo_user = os.environ["ODOO_USER"]
            odoo_password = os.environ["ODOO_PASSWORD"]
            common = xmlrpc.client.ServerProxy(f"{odoo_url}/xmlrpc/2/common")
            uid = common.authenticate(odoo_db, odoo_user, odoo_password, {})
            models = xmlrpc.client.ServerProxy(f"{odoo_url}/xmlrpc/2/object")
            fields = [
                "id",
                "name",
                "email",
                "phone",
                "mobile",
                "street",
                "city",
                "state_id",
                "country_id",
                "x_studio_shopify_user_id",
                "write_date",
            ]
            gap_rows = []
            for i in range(0, len(missing_ids), 200):
                batch = missing_ids[i : i + 200]
                records = models.execute_kw(
                    odoo_db,
                    uid,
                    odoo_password,
                    "res.partner",
                    "read",
                    [batch],
                    {"fields": fields},
                )
                for r in records:
                    shopify_id = r.get("x_studio_shopify_user_id") or None
                    state_name = (
                        r["state_id"][1]
                        if isinstance(r.get("state_id"), list)
                        else None
                    )
                    country_name = (
                        r["country_id"][1]
                        if isinstance(r.get("country_id"), list)
                        else None
                    )
                    gap_rows.append(
                        (
                            r["id"],
                            r.get("name"),
                            r.get("email") or None,
                            r.get("phone") or None,
                            r.get("mobile") or None,
                            r.get("street") or None,
                            r.get("city") or None,
                            state_name,
                            country_name,
                            int(shopify_id) if shopify_id else None,
                            "vivofashiongroup",
                            r.get("write_date"),
                            now_utc,
                        )
                    )
            if gap_rows:
                with conn.cursor() as cur:
                    execute_values(
                        cur,
                        """
                        INSERT INTO raw_odoo_customers (
                            id, name, email, phone, mobile,
                            street, city, state_name, country_name,
                            shopify_user_id, store_id,
                            write_date, _synced_at
                        ) VALUES %s
                        ON CONFLICT (id) DO UPDATE SET
                            name           = EXCLUDED.name,
                            email          = EXCLUDED.email,
                            phone          = EXCLUDED.phone,
                            mobile         = EXCLUDED.mobile,
                            shopify_user_id = EXCLUDED.shopify_user_id,
                            write_date     = EXCLUDED.write_date,
                            _synced_at     = EXCLUDED._synced_at
                    """,
                        gap_rows,
                    )
                conn.commit()
                log.info(
                    "Odoo customer gap-fill: upserted %d rows into raw_odoo_customers",
                    len(gap_rows),
                )
        except Exception as e:
            log.error("Odoo customer gap-fill error: %s", e)
            # Publishing identity after an incomplete customer source would
            # replace a known-good snapshot with a partial one.
            raise

    # Step 3 — upsert any raw_odoo_customers updated in this sync cycle into
    # all_customers, then backfill order stats from all_sales.
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, email, phone, mobile, city, country_name
            FROM raw_odoo_customers
            WHERE _synced_at >= NOW() - INTERVAL '25 hours'
        """)
        recent = cur.fetchall()

    if not recent:
        return

    ac_rows = []
    new_ids = []
    for oid, name, email, phone, mobile, city, country in recent:
        full = norm_name(name)
        ac_rows.append(
            (
                str(oid),
                "vivofashiongroup",
                full,
                None,
                norm_email(email),
                norm_phone(country or "Kenya", phone, mobile),
                city,
                country,
                now_utc,
            )
        )
        new_ids.append(str(oid))

    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO all_customers (
                customer_id, store_id, first_name, last_name,
                email, phone,
                city, country,
                last_synced
            ) VALUES %s
            ON CONFLICT (customer_id, store_id) DO UPDATE SET
                first_name  = EXCLUDED.first_name,
                last_name   = EXCLUDED.last_name,
                email       = COALESCE(EXCLUDED.email, all_customers.email),
                phone       = COALESCE(EXCLUDED.phone, all_customers.phone),
                city        = COALESCE(EXCLUDED.city, all_customers.city),
                country     = COALESCE(EXCLUDED.country, all_customers.country),
                last_synced = EXCLUDED.last_synced
        """,
            ac_rows,
        )

        # Backfill order stats from all_sales for these customer IDs
        cur.execute(
            """
            UPDATE all_customers c
            SET
                total_orders       = sub.cnt,
                total_spend_kes    = sub.spend,
                avg_order_value_kes = sub.aov,
                first_order_date   = sub.first_dt::text,
                last_order_date    = sub.last_dt::text,
                customer_type      = CASE WHEN sub.cnt > 1 THEN 'returning' ELSE 'new' END
            FROM (
                SELECT
                    customer_id,
                    COUNT(DISTINCT order_id)                             AS cnt,
                    SUM(net_sales_kes)                                   AS spend,
                    SUM(net_sales_kes) / NULLIF(COUNT(DISTINCT order_id), 0) AS aov,
                    MIN(sale_date::date)                                 AS first_dt,
                    MAX(sale_date::date)                                 AS last_dt
                FROM all_sales
                WHERE sale_kind   = 'order'
                  AND customer_id = ANY(%s)
                GROUP BY customer_id
            ) sub
            WHERE c.customer_id = sub.customer_id
        """,
            (new_ids,),
        )

    conn.commit()
    log.info("Odoo customer sync: upserted %d rows into all_customers", len(ac_rows))
    # Customer facts are now changed; publish the canonical phone-only identity
    # immediately so freshness metadata exposes either the new snapshot or a
    # visible failure to this caller.  publish uses a transaction row lock.
    from customer_identity import publish as publish_customer_identity
    try:
        report = publish_customer_identity(conn)
        log.info("✅ canonical customer identity refreshed: %s", report)
    except Exception:
        conn.rollback()
        log.exception("canonical customer identity refresh failed after customer update")
        raise


def sync_shopping_bags(cur, conn):
    """Sync shopping bag stock from Odoo into shopping_bags table."""
    import xmlrpc.client

    ODOO_URL = os.environ["ODOO_URL"]
    ODOO_DB = os.environ["ODOO_DB"]
    ODOO_USER = os.environ["ODOO_USER"]
    ODOO_PW = os.environ["ODOO_PASSWORD"]
    from psycopg2.extras import execute_values

    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PW, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    quants = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PW,
        "stock.quant",
        "search_read",
        [
            [
                ["product_id.name", "ilike", "shopping bag"],
                ["location_id.usage", "=", "internal"],
                ["quantity", ">", 0],
            ]
        ],
        {"fields": ["product_id", "location_id", "quantity", "reserved_quantity"]},
    )

    now = datetime.utcnow()
    rows = []
    for q in quants:
        raw = q["product_id"][1]
        sku = raw.split("]")[0].replace("[", "").strip() if "]" in raw else ""
        pname = raw.split("] ")[-1] if "] " in raw else raw
        loc_name = q["location_id"][1]
        loc_code = loc_name.split("/")[0]
        # Map location code to store name
        store = (
            LOCATION_COUNTRY_MAP.get(loc_code, (loc_name, ""))[0]
            if loc_code in LOCATION_COUNTRY_MAP
            else loc_name
        )
        # Fix known unmapped codes
        store = {
            "SARIT": "Vivo Sarit",
            "TMALL": "Vivo T- Mall",
            "HUB": "Vivo Hub",
            "ACHO": "Vivo Acacia",
        }.get(loc_code, store)
        size = (
            "S"
            if "S)" in pname
            else "M"
            if "M)" in pname
            else "L"
            if "L)" in pname
            else ""
        )
        brand = "Safari" if "SAF" in sku else "Zoya" if "ZB" in sku else "Vivo"
        qty = float(q["quantity"])
        res = float(q["reserved_quantity"])
        rows.append(
            (sku, pname, size, brand, loc_code, store, qty, res, qty - res, now)
        )

    cur.execute("DELETE FROM shopping_bags")
    if rows:
        execute_values(
            cur,
            """
            INSERT INTO shopping_bags (sku, product_name, size, brand, location_code,
                pos_location_name, qty_on_hand, qty_reserved, qty_available, _synced_at)
            VALUES %s""",
            rows,
        )
    conn.commit()
    log.info("✅ shopping_bags: %d rows synced", len(rows))
    return len(rows)


def sync_footfall(cur, now):
    FOOTFALL_URL = "https://v9.footfallcam.com"
    CUBE_URL = "https://cube.footfallcam.com/API/v1"
    EMAIL = os.environ.get("FOOTFALLCAM_EMAIL", "charles@vivofashiongroup.com")
    PASSWORD = os.environ.get("FOOTFALLCAM_PASSWORD", "Vivo@2030")

    expiration = (datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%d")
    resp = requests.post(
        f"{FOOTFALL_URL}/account/GenerateAccessToken",
        json={"email": EMAIL, "password": PASSWORD, "expiration": expiration},
        timeout=30,
    )
    resp.raise_for_status()
    token = resp.json().get("AToken")
    if not token:
        log.error("Footfall auth failed")
        return 0

    headers = {"Authorization": f"Bearer {token}"}

    cur.execute("SELECT MAX(time::date) FROM footfall")
    result = cur.fetchone()[0]
    since = (
        (result - timedelta(days=2)).strftime("%Y-%m-%d")
        if result
        else (now - timedelta(days=7)).strftime("%Y-%m-%d")
    )
    date_to = now.strftime("%Y-%m-%d")

    log.info("Footfall sync %s → %s", since, date_to)

    payload = {
        "query": {
            "measures": ["ffc_site_summary.A01", "ffc_site_summary.A05"],
            "timeDimensions": [
                {
                    "dimension": "ffc_site_summary.Time",
                    "granularity": "day",
                    "dateRange": [since, date_to],
                }
            ],
            "dimensions": ["ffc_site_summary.SiteName"],
            "limit": 50000,
        }
    }

    resp = requests.post(CUBE_URL + "/load", json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json().get("data", [])

    if not data:
        log.info("No footfall data")
        return 0

    rows = []
    seen = set()
    for rec in data:
        site = rec.get("ffc_site_summary.SiteName", "")
        pos_loc = SITE_LOCATION_MAP.get(site, site)
        day = (
            rec.get("ffc_site_summary.Time") or rec.get("ffc_site_summary.Time.day", "")
        )[:10]
        ff_in = int(float(rec.get("ffc_site_summary.A01") or 0))
        outside = int(float(rec.get("ffc_site_summary.A05") or 0))
        key = (day, site)
        if key in seen:
            continue
        seen.add(key)
        rows.append((f"{site}_{day}", day, site, pos_loc, ff_in, outside))

    if rows:
        cur.execute(
            "DELETE FROM footfall WHERE time >= %s AND time <= %s", (since, date_to)
        )
        execute_values(
            cur,
            """
            INSERT INTO footfall (site_id, time, site_name, pos_location_name,
                a01_footfall_in, a05_outside_traffic)
            VALUES %s
            ON CONFLICT DO NOTHING
        """,
            rows,
            page_size=500,
        )
        log.info("✅ Footfall — %d rows", len(rows))

    return len(rows)


def categorise_products(cur):
    """Fill missing product_type and category based on product name keywords."""
    cur.execute("""
        UPDATE all_products_clean
        SET product_type = CASE
            WHEN UPPER(product_name) LIKE '%SAMPLE%' OR UPPER(product_name) LIKE '%GIFT VOUCHER%'
                OR UPPER(product_name) LIKE '%GIFT CARD%' OR UPPER(sku) LIKE '%FS%'
                OR UPPER(sku) LIKE 'CS%' OR UPPER(sku) LIKE 'SALE%' THEN 'Sample & Sale Items'
            WHEN LOWER(product_name) LIKE '%fitness bra%' OR LOWER(product_name) LIKE '%sports bra%'
                OR LOWER(product_name) LIKE '%bralette%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%fitness tights%' OR LOWER(product_name) LIKE '%legging%'
                OR LOWER(product_name) LIKE '%biker%' THEN 'Leggings'
            WHEN LOWER(product_name) LIKE '%catsuit%' OR LOWER(product_name) LIKE '%jumpsuit%'
                OR LOWER(product_name) LIKE '%playsuit%' OR LOWER(product_name) LIKE '%romper%' THEN 'Jumpsuits & Playsuits'
            WHEN LOWER(product_name) LIKE '%scarf%' OR LOWER(product_name) LIKE '%hijab%'
                OR LOWER(product_name) LIKE '%shawl%' OR LOWER(product_name) LIKE '%sarong%'
                OR LOWER(product_name) LIKE '%wrap%' OR LOWER(product_name) LIKE '%scarve%' THEN 'Scarves'
            WHEN LOWER(product_name) LIKE '%blazer%' OR LOWER(product_name) LIKE '%jacket%'
                OR LOWER(product_name) LIKE '%cardigan%' OR LOWER(product_name) LIKE '%coat%' THEN 'Jackets & Coats'
            WHEN LOWER(product_name) LIKE '%poncho%' OR LOWER(product_name) LIKE '%sweater%' THEN 'Sweaters & Ponchos'
            WHEN LOWER(product_name) LIKE '%waterfall%' OR LOWER(product_name) LIKE '%kimono%'
                OR LOWER(product_name) LIKE '%shrug%' OR LOWER(product_name) LIKE '%cover%' THEN 'Waterfalls & Kimonos'
            WHEN LOWER(product_name) LIKE '%hoodie%' OR LOWER(product_name) LIKE '%sweatshirt%' THEN 'Hoodies & Sweatshirts'
            WHEN LOWER(product_name) LIKE '%bodysuit%' OR LOWER(product_name) LIKE '%bdodysuit%' THEN 'Bodysuits'
            WHEN LOWER(product_name) LIKE '%culotte%' THEN 'Culottes & Capri Pants'
            WHEN LOWER(product_name) LIKE '%palazzo%' OR LOWER(product_name) LIKE '%jogger%'
                OR LOWER(product_name) LIKE '%trouser%' OR LOWER(product_name) LIKE '%jeans%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%full%' AND LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%skort%' OR (LOWER(product_name) LIKE '%short%'
                AND LOWER(product_name) NOT LIKE '%top%' AND LOWER(product_name) NOT LIKE '%sleeve%') THEN 'Shorts & Skorts'
            WHEN LOWER(product_name) LIKE '%pant%' THEN 'Full Length Pants'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%knee%' AND LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%midi%' AND LOWER(product_name) LIKE '%dress%' THEN 'Midi & Capri Dresses'
            WHEN LOWER(product_name) LIKE '%mini%' AND LOWER(product_name) LIKE '%dress%' THEN 'Short & Mini Dresses'
            WHEN LOWER(product_name) LIKE '%bodycon%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%kaftan%' OR LOWER(product_name) LIKE '%maxi%' THEN 'Maxi Dresses'
            WHEN LOWER(product_name) LIKE '%dress%' THEN 'Knee Length Dresses'
            WHEN LOWER(product_name) LIKE '%maxi%' AND LOWER(product_name) LIKE '%skirt%' THEN 'Maxi Skirts'
            WHEN LOWER(product_name) LIKE '%skirt%' THEN 'Knee Length Skirts'
            WHEN LOWER(product_name) LIKE '%tee%' OR LOWER(product_name) LIKE '%t-shirt%'
                OR LOWER(product_name) LIKE '%tank%' THEN 'T-shirts & Tank Tops'
            WHEN LOWER(product_name) LIKE '%fitted%' AND LOWER(product_name) LIKE '%top%' THEN 'Fitted Tops'
            WHEN LOWER(product_name) LIKE '%loose%' AND LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%tunic%' OR LOWER(product_name) LIKE '%blouse%'
                OR LOWER(product_name) LIKE '%vest%' OR LOWER(product_name) LIKE '%chiffon%' THEN 'Loose Tops'
            WHEN LOWER(product_name) LIKE '%earring%' OR LOWER(product_name) LIKE '%bracelet%'
                OR LOWER(product_name) LIKE '%necklace%' OR LOWER(product_name) LIKE '%ring%'
                OR LOWER(product_name) LIKE '%belt%' OR LOWER(product_name) LIKE '%hat%'
                OR LOWER(product_name) LIKE '%cap%' OR LOWER(product_name) LIKE '%bag%'
                OR LOWER(product_name) LIKE '%sock%' OR LOWER(product_name) LIKE '%accessori%' THEN 'Accessories'
            WHEN LOWER(product_name) LIKE '%shirt%' OR LOWER(product_name) LIKE '%top%' THEN 'Loose Tops'
            ELSE 'Accessories'
        END
        WHERE product_type IS NULL OR TRIM(product_type) = ''
    """)

    cur.execute("""
        UPDATE all_products_clean
        SET category = CASE
            WHEN product_type IN ('Bodysuits','Fitted Tops','Loose Tops','Midriff & Crop Tops','T-shirts & Tank Tops') THEN 'Tops'
            WHEN product_type IN ('Culottes & Capri Pants','Full Length Pants','Jumpsuits & Playsuits','Leggings','Shorts & Skorts') THEN 'Bottoms'
            WHEN product_type IN ('Knee Length Dresses','Maxi Dresses','Midi & Capri Dresses','Short & Mini Dresses') THEN 'Dresses'
            WHEN product_type IN ('Knee Length Skirts','Maxi Skirts','Midi & Capri Skirts','Short & Mini Skirts') THEN 'Skirts'
            WHEN product_type IN ('Hoodies & Sweatshirts','Jackets & Coats','Sweaters & Ponchos','Waterfalls & Kimonos') THEN 'Outerwear'
            WHEN product_type IN ('Skirts & Top Set','Pants & Top Set','Two-Piece Sets') THEN 'Two-Piece Sets'
            WHEN product_type IN ('Accessories','Scarves','Belts','Earrings','Necklaces') THEN 'Accessories'
            WHEN product_type = 'Sample & Sale Items' THEN 'Sale'
            ELSE 'Accessories'
        END
        WHERE category IS NULL OR TRIM(category) = ''
    """)
    # Sync NOOS flag directly from Odoo tier field (single source of truth)
    cur.execute("""
        UPDATE all_products_clean
        SET is_noos = (tier = 'NOOS');
    """)
    log.info("✅ Product categorisation done")


def _recv_backfill_missing_kpm_sync(conn):
    """Standalone SQL helper (mirrors fabric_router._recv_backfill_missing_kpm).

    Called from the fabric worker loop after every successful fast extract so
    that within ~60s of a buying team entering Width/GSM in Odoo the
    corresponding receiving sheets' kg_per_mtr and roll qty_mtrs values are
    repaired automatically. Only patches sheets where kg_per_mtr IS NULL (safe
    to call on every cycle — it is a no-op once all sheets are fixed).
    """
    try:
        with conn.cursor() as cur:
            cur.execute("""
                WITH stale AS (
                    SELECT s.id             AS sheet_id,
                           p.kg_per_mtr_eff AS kpm
                    FROM fabric_receiving_sheets s
                    JOIN raw_fabric_products p ON p.id = s.product_id
                    WHERE s.kg_per_mtr IS NULL
                      AND p.kg_per_mtr_eff IS NOT NULL
                      AND p.kg_per_mtr_eff > 0
                )
                UPDATE fabric_receiving_sheets s
                   SET kg_per_mtr      = stale.kpm,
                       total_mtrs      = ROUND(s.total_kg / stale.kpm, 1),
                       updated_at      = now(),
                       updated_by_name = 'system (kpm backfill)'
                  FROM stale
                 WHERE s.id = stale.sheet_id
                RETURNING s.id
            """)
            updated_sheet_ids = [r[0] for r in cur.fetchall()]
            if not updated_sheet_ids:
                conn.commit()
                return
            cur.execute(
                """
                UPDATE fabric_receiving_rolls r
                   SET qty_mtrs = ROUND(r.qty_kg / p.kg_per_mtr_eff, 2)
                  FROM fabric_receiving_sheets s
                  JOIN raw_fabric_products p ON p.id = s.product_id
                 WHERE r.sheet_id = s.id
                   AND s.id = ANY(%s)
                   AND r.deleted_at IS NULL
                   AND p.kg_per_mtr_eff IS NOT NULL
                   AND p.kg_per_mtr_eff > 0
            """,
                (updated_sheet_ids,),
            )
            updated_rolls = cur.rowcount
        conn.commit()
        log.info(
            "kpm backfill: patched %d sheet(s) and %d roll(s) "
            "with newly-available Width/GSM conversion",
            len(updated_sheet_ids),
            updated_rolls,
        )
    except Exception as e:
        log.error("kpm backfill failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


def _recv_refresh_product_data_sync(conn):
    """After each successful fast product extract, patch fabric_receiving_sheets
    where the stored barcode or fabric_name has drifted from raw_fabric_products.
    This keeps the snapshot consistent so exports and printouts also reflect
    current Odoo data within ~60 s of an Odoo edit.
    Only rows where the values have actually changed are touched (no-op otherwise).
    """
    try:
        with conn.cursor() as cur:
            # s.barcode was originally populated from default_code (SKU) at
            # sheet creation.  We now refresh it to the best available Odoo
            # identifier: scannable barcode first, then SKU/default_code.
            # Only overwrite when upstream has a meaningful value, so we never
            # NULL out an existing snapshot value when both Odoo fields are blank.
            cur.execute("""
                UPDATE fabric_receiving_sheets s
                   SET barcode = CASE
                         WHEN NULLIF(BTRIM(p.barcode), '') IS NOT NULL
                              THEN BTRIM(p.barcode)
                         WHEN NULLIF(BTRIM(p.default_code), '') IS NOT NULL
                              THEN BTRIM(p.default_code)
                         ELSE s.barcode
                       END,
                       fabric_name     = COALESCE(NULLIF(BTRIM(p.name), ''), s.fabric_name),
                       updated_at      = now(),
                       updated_by_name = 'system (product sync)'
                  FROM raw_fabric_products p
                 WHERE p.id = s.product_id
                   AND s.deleted_at IS NULL
                   AND (
                       COALESCE(s.barcode, '') IS DISTINCT FROM
                         COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode, '')
                    OR (NULLIF(BTRIM(p.name), '') IS NOT NULL
                        AND COALESCE(s.fabric_name, '') IS DISTINCT FROM BTRIM(p.name))
                   )
                RETURNING s.id
            """)
            n = cur.rowcount
        conn.commit()
        if n:
            log.info(
                "product data sync: patched %d receiving sheet(s) "
                "with updated barcode/name from Odoo",
                n,
            )
    except Exception as e:
        log.error("recv_refresh_product_data_sync failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


def fabric_worker_loop(stop_event=None):
    """Dedicated ~60s fabric extract loop, independent of the main sales cycle.

    The /fabric dashboard wants near-real-time fabric figures, but the fast
    fabric pull used to sit at the top of main() — which also runs the heavy
    Shopify/ShopZetu/Odoo/inventory/production pulls and only completes every
    ~10-15 min. So even though the fabric step was rate-limited to once per 60s,
    it could only actually fire ONCE PER FULL CYCLE, leaving the /fabric feed
    10-15 min stale and the page's "sync running a little behind" banner
    permanently on. This worker runs the FAST fabric pull on its OWN ~60s timer,
    on its OWN dedicated Postgres connection, in a daemon thread started once
    alongside the sync loop, so it fires regardless of how long a
    sales/inventory cycle takes.

    Scope: it ONLY touches the raw_fabric_* tables (never all_sales /
    all_inventory), so Main BI is unaffected. It writes the "fabric" sync
    heartbeat ONLY after a genuinely successful extract — a lock-skipped run
    (extract_fabric.py exit code 3, see FABRIC_EXTRACT_EXIT_LOCK_SKIP) writes
    no heartbeat and rolls back the 60s rate-limit stamp so the next ~20s tick
    retries immediately. It keeps the per-minute rate-limit and the
    FABRIC_EXTRACT_TIMEOUT_SEC hard timeout, and the heavy pull it launches
    honours extract_fabric.py's pg advisory lock so a fast pull can never overlap
    a heavy pull or a standalone run. The heavy extract (BOMs/moves/POs, ~30-min
    cadence) and the fresh/empty-prod-DB bootstrap-on-empty behaviour move here
    unchanged in effect.
    """
    import sys
    import subprocess as _subprocess

    global _LAST_FABRIC_EXTRACT, _LAST_FABRIC_HEAVY_EXTRACT, _FABRIC_HEAVY_PROC
    global _FABRIC_HEAVY_STARTED_AT

    log.info("Fabric worker thread started (tick=%ss)", FABRIC_WORKER_TICK_SEC)
    conn = None
    while stop_event is None or not stop_event.is_set():
        try:
            if conn is None or conn.closed:
                conn = psycopg2.connect(DATABASE_URL)
                # Fabric writes its OWN heartbeat table, never the watchdog's
                # sync_heartbeat — see write_heartbeat() / _HEARTBEAT_TABLES.
                ensure_heartbeat_table(conn, "fabric_heartbeat")

            now_utc = datetime.now(timezone.utc)

            # Production runs on a SEPARATE DB that never ran extract_fabric.py, so
            # the tables start empty and /fabric shows zeros. Bootstrap immediately
            # when the tables are missing/empty (first deploy) so no manual step is
            # needed, then refresh every minute thereafter.
            fabric_empty = False
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT to_regclass('public.raw_fabric_inventory')")
                    if cur.fetchone()[0] is None:
                        fabric_empty = True
                    else:
                        cur.execute("SELECT COUNT(*) FROM raw_fabric_inventory")
                        fabric_empty = cur.fetchone()[0] == 0
                conn.commit()
            except Exception as e:
                log.error("Fabric presence check error: %s", e)
                conn.rollback()

            # FAST path (every ~60s): incremental product master + fabric
            # inventory. On a fresh/empty prod DB the first run is a FULL bootstrap
            # so every table populates; thereafter it is the cheap incremental
            # pull. Stamp the attempt time up front so a transient failure waits a
            # minute (when still empty, the fabric_empty branch retries next tick).
            fabric_due = (
                _LAST_FABRIC_EXTRACT is None
                or (now_utc - _LAST_FABRIC_EXTRACT).total_seconds() >= 60
            )
            if fabric_empty or fabric_due:
                _prev_fabric_extract = _LAST_FABRIC_EXTRACT
                _LAST_FABRIC_EXTRACT = now_utc
                fast_mode = "full" if fabric_empty else "fast"
                try:
                    log.info(
                        "Running fabric (Odoo) extract mode=%s (bootstrap=%s)...",
                        fast_mode,
                        fabric_empty,
                    )
                    run_subprocess_with_heartbeat(
                        [
                            sys.executable,
                            "/home/runner/workspace/extract_fabric.py",
                            "--mode",
                            fast_mode,
                        ],
                        "fabric",
                        timeout=FABRIC_EXTRACT_TIMEOUT_SEC,
                        heartbeat_table="fabric_heartbeat",
                    )
                    write_heartbeat(conn, "fabric", table="fabric_heartbeat")
                    log.info("✅ Fabric fast extract complete")
                    # Back-fill any receiving sheets whose kg_per_mtr was NULL
                    # at creation (product had no Width/GSM then) but whose
                    # product now has a valid kg_per_mtr_eff after this extract.
                    # No-op when all sheets are already repaired.
                    _recv_backfill_missing_kpm_sync(conn)
                    # Patch any receiving sheets whose barcode/name diverged from
                    # raw_fabric_products since the last sync (≤60s propagation).
                    _recv_refresh_product_data_sync(conn)
                    # A full bootstrap already pulled the heavy tables — start their
                    # slow timer now so we don't immediately re-run them.
                    if fabric_empty:
                        _LAST_FABRIC_HEAVY_EXTRACT = now_utc
                except _subprocess.CalledProcessError as e:
                    if e.returncode == FABRIC_EXTRACT_EXIT_LOCK_SKIP:
                        # Lock-skip: another fabric run (normally the 30-min
                        # heavy reconcile) holds the advisory lock, so NOTHING
                        # was extracted. Not a success: skip write_heartbeat()
                        # (a fresh beat would mask real data staleness from the
                        # watchdog — the exact bug behind the 15h-stale /fabric
                        # feed) and roll the rate-limit stamp back so the next
                        # ~20s tick retries immediately instead of waiting a
                        # full 60s.
                        _LAST_FABRIC_EXTRACT = _prev_fabric_extract
                        log.info(
                            "Fabric fast extract skipped (rc=%s: advisory lock "
                            "held) — retrying next tick",
                            e.returncode,
                        )
                    else:
                        log.error("Fabric extract error: %s", e)
                except Exception as e:
                    log.error("Fabric extract error: %s", e)

            # HEAVY path (slow cadence, default 30 min): full product reconcile +
            # BOMs + stock moves + purchase orders. Launched NON-BLOCKING as its
            # own subprocess so it never gates the fast ~60s refresh; the pg
            # advisory lock inside extract_fabric.py --mode heavy prevents overlap
            # with the fast pull or a standalone run.
            heavy_due = (
                _LAST_FABRIC_HEAVY_EXTRACT is None
                or (now_utc - _LAST_FABRIC_HEAVY_EXTRACT).total_seconds()
                >= FABRIC_HEAVY_INTERVAL_SEC
            )
            # Reap any previously-launched heavy run: log its outcome if finished,
            # or kill it if it has exceeded FABRIC_HEAVY_TIMEOUT_SEC.
            if _FABRIC_HEAVY_PROC is not None:
                if _FABRIC_HEAVY_PROC.poll() is not None:
                    rc = _FABRIC_HEAVY_PROC.returncode
                    if rc == 0:
                        log.info("✅ Fabric heavy extract complete")
                    elif rc == FABRIC_EXTRACT_EXIT_LOCK_SKIP:
                        # Benign: a fast pull / standalone run held the lock at
                        # launch time; the heavy reconcile retries on its normal
                        # 30-min cadence. Not an error — don't alarm the logs.
                        log.info(
                            "Fabric heavy extract skipped (advisory lock held) "
                            "— will retry on its normal cadence"
                        )
                    else:
                        log.error("Fabric heavy extract exited with code %s", rc)
                    _FABRIC_HEAVY_PROC = None
                    _FABRIC_HEAVY_STARTED_AT = None
                elif (
                    _FABRIC_HEAVY_STARTED_AT is not None
                    and (now_utc - _FABRIC_HEAVY_STARTED_AT).total_seconds()
                    > FABRIC_HEAVY_TIMEOUT_SEC
                ):
                    log.error(
                        "Fabric heavy extract exceeded %ss — killing it.",
                        FABRIC_HEAVY_TIMEOUT_SEC,
                    )
                    try:
                        _FABRIC_HEAVY_PROC.kill()
                        _FABRIC_HEAVY_PROC.wait(timeout=10)
                    except Exception as e:
                        log.error("Failed to kill hung fabric heavy extract: %s", e)
                    _FABRIC_HEAVY_PROC = None
                    _FABRIC_HEAVY_STARTED_AT = None
            heavy_running = (
                _FABRIC_HEAVY_PROC is not None and _FABRIC_HEAVY_PROC.poll() is None
            )
            if heavy_due and not fabric_empty and not heavy_running:
                _LAST_FABRIC_HEAVY_EXTRACT = now_utc
                try:
                    log.info(
                        "Launching fabric (Odoo) HEAVY extract (boms/moves/pos) in background..."
                    )
                    _FABRIC_HEAVY_PROC = _subprocess.Popen(
                        [
                            sys.executable,
                            "/home/runner/workspace/extract_fabric.py",
                            "--mode",
                            "heavy",
                        ],
                    )
                    _FABRIC_HEAVY_STARTED_AT = now_utc
                except Exception as e:
                    log.error("Fabric heavy extract launch error: %s", e)
                    _FABRIC_HEAVY_PROC = None
                    _FABRIC_HEAVY_STARTED_AT = None
        except Exception as e:
            # Never let the fabric worker die — drop the (possibly broken)
            # connection and rebuild it on the next tick.
            log.error("Fabric worker loop error: %s", e)
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
            conn = None

        if stop_event is not None:
            if stop_event.wait(FABRIC_WORKER_TICK_SEC):
                break
        else:
            time.sleep(FABRIC_WORKER_TICK_SEC)


def sales_worker_loop(stop_event=None):
    """Dedicated ~60s sales fast-path, independent of the main cycle.

    all_sales was only refreshed once per FULL main() cycle. The cycle was
    designed around ~10-15 min but has grown to 45-90 min as heavy phases
    accumulated (Shop Zetu inventory matching alone can run ~20 min), so
    dashboard sales figures sat up to ~1.5 h behind the tills. The sales pulls
    themselves are cheap (~5-30 s: Shopify country stores + Odoo POS), so —
    exactly like fabric_worker_loop — they move onto their OWN ~60s timer, on
    their OWN dedicated Postgres connection, in a daemon thread started once
    alongside the sync loop.

    Design points:
    * Short sliding watermark per tick (SALES_WORKER_WINDOW_MIN, default 30
      min): new orders always carry a fresh write_date/updated_at, so each tick
      re-pulls only the recent edge (a handful of orders) instead of the main
      cycle's multi-day anchors. Late edits and gap repairs remain the main
      cycle's job — it still runs the wide self-healing pass every cycle.
    * _SALES_SYNC_LOCK serialises worker ticks against the main cycle's sales
      phase. Both paths are idempotent (DELETE by order_id + INSERT + intra-
      batch dedup), the lock removes the interleaving race entirely. The
      worker acquires non-blocking and SKIPS the tick if the cycle holds it.
    * Shop Zetu runs via the ShopifyQL subprocess (default ~4-day window,
      DELETE+INSERT per day) — heavier, so it fires every
      SALES_WORKER_SZ_INTERVAL_SEC (default 5 min) instead of every tick.
    * Heartbeat goes to the worker's OWN sales_heartbeat table, NEVER
      sync_heartbeat — an independent beat must not hide a stalled main cycle
      from the watchdog (same rule as fabric_heartbeat).
    * Never dies: any error drops the (possibly broken) connection and the
      next tick rebuilds it.
    """
    import sys as _sys
    import subprocess as _subprocess

    global _LAST_SALES_WORKER_SZ

    log.info(
        "Sales worker thread started (tick=%ss, window=%smin)",
        SALES_WORKER_TICK_SEC,
        SALES_WORKER_WINDOW_MIN,
    )
    conn = None
    while stop_event is None or not stop_event.is_set():
        acquired = False
        try:
            if conn is None or conn.closed:
                conn = psycopg2.connect(DATABASE_URL)
                ensure_heartbeat_table(conn, "sales_heartbeat")

            acquired = _SALES_SYNC_LOCK.acquire(blocking=False)
            if acquired:
                now = datetime.now(timezone.utc)
                window_start = now - timedelta(minutes=SALES_WORKER_WINDOW_MIN)
                shopify_since = window_start.strftime("%Y-%m-%dT%H:%M:%SZ")
                odoo_since = window_start.strftime("%Y-%m-%d %H:%M:%S")

                with conn.cursor() as cur:
                    rates = get_exchange_rates(cur)

                    # Each source records success/failure into the durable
                    # trail so a silently dead feed (like the 13-Aug Odoo
                    # permission loss) leaves queryable evidence.
                    for store in STORES:
                        try:
                            process_shopify_store(
                                store, cur, now, rates, since_override=shopify_since
                            )
                            conn.commit()
                            record_source_success(conn, store["store_id"])
                        except Exception as e:
                            log.error("Sales worker %s error: %s", store["store_id"], e)
                            conn.rollback()
                            record_source_failure(conn, store["store_id"], e)

                    try:
                        sync_odoo(cur, now, rates, since_override=odoo_since)
                        conn.commit()
                        record_source_success(conn, "vivofashiongroup")
                    except Exception as e:
                        log.error("Sales worker Odoo error: %s", e)
                        conn.rollback()
                        record_source_failure(conn, "vivofashiongroup", e)

                    # Shop Zetu ShopifyQL — slower cadence (subprocess re-walks
                    # a ~4-day window; ~10s normally, hard timeout so a hung
                    # API walk can't wedge the worker).
                    sz_due = (
                        _LAST_SALES_WORKER_SZ is None
                        or (now - _LAST_SALES_WORKER_SZ).total_seconds()
                        >= SALES_WORKER_SZ_INTERVAL_SEC
                    )
                    if sz_due:
                        _LAST_SALES_WORKER_SZ = now
                        try:
                            _subprocess.run(
                                [
                                    _sys.executable,
                                    "/home/runner/workspace/extract_shopzetu_shopifyql.py",
                                ],
                                check=True,
                                timeout=SALES_WORKER_SZ_TIMEOUT_SEC,
                            )
                            log.info("Sales worker: Shop Zetu ShopifyQL sync done")
                            record_source_success(conn, "shop-zetu")
                        except Exception as e:
                            log.error("Sales worker Shop Zetu error: %s", e)
                            record_source_failure(conn, "shop-zetu", e)

                write_heartbeat(conn, "sales", table="sales_heartbeat")
        except Exception as e:
            # Never let the sales worker die — drop the (possibly broken)
            # connection and rebuild it on the next tick.
            log.error("Sales worker loop error: %s", e)
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
            conn = None
        finally:
            if acquired:
                _SALES_SYNC_LOCK.release()

        if stop_event is not None:
            if stop_event.wait(SALES_WORKER_TICK_SEC):
                break
        else:
            time.sleep(SALES_WORKER_TICK_SEC)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.now(timezone.utc)

    ensure_heartbeat_table(conn)
    write_heartbeat(conn, "cycle_start")

    # ---- One-time data fix: Kenya pre-cutover Odoo duplicates (prod) ----
    # Kenya POS moved from Shopify to Odoo on 2026-03-20. Production's all_sales
    # history was written by pre-cutover logic and still holds Odoo
    # (store_id='vivofashiongroup') rows dated 2026-03-01..2026-03-19 that
    # duplicate the Shopify (vivowoman) rows for the same days (~KES 44M
    # double-counted in March 2026). Dev was corrected by a full rebuild, but
    # prod NEVER runs the rebuild, so this marker-guarded delete ships the fix.
    # Idempotent: the delete is a no-op once the rows are gone, and the
    # app_config marker (written in the SAME transaction) stops it re-running.
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_config (
                key        TEXT PRIMARY KEY,
                value      JSONB,
                updated_at TIMESTAMPTZ DEFAULT now()
            )""")
        cur.execute(
            "SELECT 1 FROM app_config WHERE key='data_fix_kenya_precutover_odoo_v1'"
        )
        if cur.fetchone() is None:
            cur.execute("""
                DELETE FROM all_sales
                WHERE store_id = 'vivofashiongroup'
                  AND country = 'Kenya'
                  AND sale_date < '2026-03-20'
            """)
            deleted = cur.rowcount
            cur.execute(
                """
                INSERT INTO app_config (key, value, updated_at)
                VALUES ('data_fix_kenya_precutover_odoo_v1',
                        jsonb_build_object('deleted_rows', %s::int,
                                           'applied_at', now()::text),
                        now())
                ON CONFLICT (key) DO NOTHING
            """,
                (deleted,),
            )
            conn.commit()
            log.info(
                "Kenya pre-cutover Odoo duplicate fix applied: deleted %s rows",
                deleted,
            )
        conn.commit()
    except Exception as e:
        log.error("Kenya pre-cutover fix error: %s", e)
        conn.rollback()

    # ---- One-time data fix: Shop Zetu historical customer_id backfill ----
    # The incremental ShopifyQL sync only covers the last ~4 days, so production's
    # pre-recent Shop Zetu rows have NULL customer_id (the historical backfill ran
    # only in dev; publishing ships code, not data). This block detects >100 NULL
    # customer_id rows older than 10 days and re-extracts 2023-01-01 → (today-10d)
    # once. extract_shopzetu_shopifyql.py is idempotent (DELETE + INSERT per date
    # range), so a partial run that gets retried the next cycle is safe.
    # run_subprocess_with_heartbeat keeps the watchdog heartbeat fresh while the
    # ShopifyQL API walk runs (can take several minutes for 2+ years of history).
    try:
        import subprocess, sys as _sys

        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_config (
                key        TEXT PRIMARY KEY,
                value      JSONB,
                updated_at TIMESTAMPTZ DEFAULT now()
            )""")
        cur.execute(
            "SELECT 1 FROM app_config WHERE key='data_fix_shopzetu_customer_id_backfill_v1'"
        )
        if cur.fetchone() is None:
            _cutoff = (
                datetime.now(timezone.utc).date() - timedelta(days=10)
            ).isoformat()
            cur.execute(
                "SELECT COUNT(*) FROM all_sales "
                "WHERE store_id = 'shop-zetu' "
                "  AND customer_id IS NULL "
                "  AND sale_date::date < %s",
                (_cutoff,),
            )
            _missing = cur.fetchone()[0]
            if _missing > 100:
                log.info(
                    "Shop Zetu customer_id backfill: %d historical rows missing — "
                    "re-extracting 2023-01-01 → %s",
                    _missing,
                    _cutoff,
                )
                run_subprocess_with_heartbeat(
                    [
                        _sys.executable,
                        "/home/runner/workspace/extract_shopzetu_shopifyql.py",
                        "--since",
                        "2023-01-01",
                        "--until",
                        _cutoff,
                    ],
                    status="shopzetu_customer_id_backfill",
                )
                log.info("Shop Zetu customer_id backfill complete")
            else:
                log.info(
                    "Shop Zetu customer_id backfill: coverage OK (%d missing), skipping",
                    _missing,
                )
            cur.execute(
                """
                INSERT INTO app_config (key, value, updated_at)
                VALUES ('data_fix_shopzetu_customer_id_backfill_v1',
                        jsonb_build_object('missing_rows', %s::int,
                                           'cutoff', %s,
                                           'applied_at', now()::text),
                        now())
                ON CONFLICT (key) DO NOTHING
                """,
                (_missing if _missing > 100 else 0, _cutoff),
            )
            conn.commit()
        conn.commit()
    except Exception as e:
        log.error("Shop Zetu customer_id backfill error: %s", e)
        conn.rollback()

    # Load exchange rates once per sync cycle
    rates = get_exchange_rates(cur)
    log.info("Exchange rates: %s", rates)

    log.info("=== Starting incremental sync ===")

    # NOTE: The fabric (Odoo) extract used to run here at the top of every cycle,
    # but the cycle also runs the heavy sales/inventory/Odoo pulls (~10-15 min),
    # so the once-per-60s fabric rate-limit could only actually fire once per full
    # cycle and the /fabric feed sat 10-15 min stale. It now runs on its OWN ~60s
    # timer in fabric_worker_loop() (a dedicated daemon thread started alongside
    # the sync loop), independent of how long this cycle takes. It writes ONLY the
    # raw_fabric_* tables, so nothing here (Main BI) is affected.

    # Sales pulls (Shopify stores / Shop Zetu / Odoo POS). The dedicated
    # sales_worker_loop runs these same pulls every ~60s with a short sliding
    # window for freshness; this in-cycle pass keeps the WIDE self-healing
    # anchors (multi-day watermarks + ODOO_SYNC_SINCE/UNTIL repairs) as the
    # safety net. _SALES_SYNC_LOCK serialises the two so a worker tick can
    # never interleave with this pass's DELETE+INSERT on the same orders.
    with _SALES_SYNC_LOCK:
        for store in STORES:
            try:
                process_shopify_store(store, cur, now, rates)
                conn.commit()
                write_heartbeat(conn, f"store:{store['store_id']}")
                record_source_success(conn, store["store_id"])
            except Exception as e:
                log.error("Error syncing %s: %s", store["store_id"], e)
                conn.rollback()
                record_source_failure(conn, store["store_id"], e)

        # Shop Zetu via ShopifyQL. Bounded: this runs while holding
        # _SALES_SYNC_LOCK, so a hung API walk would otherwise stall the
        # per-minute sales worker until someone notices. Normal run ~10-20s;
        # 900s is generous headroom for slow days without risking a wedge.
        try:
            import subprocess, sys

            subprocess.run(
                [
                    sys.executable,
                    "/home/runner/workspace/extract_shopzetu_shopifyql.py",
                ],
                check=True,
                timeout=900,
            )
            log.info("Shop Zetu ShopifyQL sync done")
            record_source_success(conn, "shop-zetu")
        except Exception as e:
            log.error("Shop Zetu ShopifyQL sync error: %s", e)
            record_source_failure(conn, "shop-zetu", e)

        try:
            sync_odoo(cur, now, rates)
            conn.commit()
            write_heartbeat(conn, "odoo")
            record_source_success(conn, "vivofashiongroup")
        except Exception as e:
            log.error("Odoo sync error: %s", e)
            conn.rollback()
            record_source_failure(conn, "vivofashiongroup", e)

    # Categorise any new products
    try:
        categorise_products(cur)
        conn.commit()
    except Exception as e:
        log.error("Categorisation error: %s", e)
        conn.rollback()

    try:
        sync_footfall(cur, now)
        # Shopping bags stock sync
        try:
            sync_shopping_bags(cur, conn)
        except Exception as e:
            log.error("Shopping bags sync error: %s", e)
        conn.commit()
        write_heartbeat(conn, "footfall")
    except Exception as e:
        log.error("Footfall sync error: %s", e)
        conn.rollback()

    # Inventory sync — FAST POLL (default every 5 min, INVENTORY_SYNC_INTERVAL_SEC).
    # Was once-a-day at midnight EAT, which left shelf stock up to ~24h stale and
    # let the replenishment engine recommend moving units that had already sold.
    # Refreshing all_inventory on a short interval keeps stock near-live so the
    # engine sees the real shelf position. Rate-limited via a module-level guard
    # even though main() runs every 60s; runs immediately on the first cycle after
    # a (re)start. Stamped up front so a transient failure waits the full interval
    # before retrying instead of hammering Odoo/Shopify on every 60s cycle.
    now_utc = datetime.now(timezone.utc)
    # ---- Product master (Odoo products -> raw_odoo_products -> all_products_clean) ----
    # Runs once per 24h. The product master was previously ONLY refreshed by the
    # manual sync_all.py, so raw_odoo_products froze (e.g. at 2026-06-13) and every
    # product created after that was invisible to the dashboard AND replenishment.
    # Also bootstraps immediately when raw is stale (>36h old newest write_date) or
    # missing, so a fresh/behind prod DB catches up on the first cycle.
    global _LAST_PRODUCT_MASTER_SYNC
    try:
        import sys as _sys

        pm_conn = psycopg2.connect(DATABASE_URL)
        pm_stale = True
        try:
            with pm_conn.cursor() as _c:
                _c.execute("SELECT to_regclass('public.raw_odoo_products')")
                if _c.fetchone()[0]:
                    _c.execute(
                        "SELECT MAX(write_date::timestamp) FROM raw_odoo_products"
                    )
                    mx = _c.fetchone()[0]
                    pm_stale = (mx is None) or (
                        (now_utc.replace(tzinfo=None) - mx).total_seconds() > 129600
                    )  # >36h
        finally:
            pm_conn.close()
        pm_due = (
            _LAST_PRODUCT_MASTER_SYNC is None
            or (now_utc - _LAST_PRODUCT_MASTER_SYNC).total_seconds() >= 86400
        )
        if pm_stale or pm_due:
            _LAST_PRODUCT_MASTER_SYNC = now_utc
            log.info(
                "Running product master sync (stale=%s, due=%s)...", pm_stale, pm_due
            )
            run_subprocess_with_heartbeat(
                [_sys.executable, "/home/runner/workspace/extract_odoo_products.py"],
                "product_master_extract",
            )
            run_subprocess_with_heartbeat(
                [
                    _sys.executable,
                    "/home/runner/workspace/transform_all_products_clean.py",
                ],
                "product_master_transform",
            )
            log.info("\u2705 Product master sync complete")
    except Exception as e:
        log.error("Product master sync error: %s", e)
    # ---- Odoo customer incremental sync + gap-fill ----
    # Runs hourly. Calls extract_odoo_customers.py (write_date incremental) to
    # pick up new/updated partners, then fills any gaps where a partner_id
    # appears in all_sales but was never synced into raw_odoo_customers (e.g.
    # newly-linked POS customers whose customer_rank was 0 at rebuild time).
    # Finally upserts results into all_customers with stats backfilled from
    # all_sales so LTV/order-counts are correct immediately.
    global _LAST_ODOO_CUSTOMER_SYNC
    odoo_customer_sync_due = (
        _LAST_ODOO_CUSTOMER_SYNC is None
        or (now_utc - _LAST_ODOO_CUSTOMER_SYNC).total_seconds() >= 3600
    )
    if odoo_customer_sync_due:
        _LAST_ODOO_CUSTOMER_SYNC = now_utc
        try:
            log.info("Running incremental Odoo customer sync...")
            sync_odoo_customers_incremental(conn)
            log.info("✅ Odoo customer sync complete")
        except Exception as e:
            log.error("Odoo customer sync error: %s", e)
    # ---- Stock transfers (Odoo pickings -> stock_transfers) ----
    # Runs hourly. The extract refreshes open rows and upserts recent completed
    # rows without deleting retained done history. Store managers see both the
    # route-correct completed dispatch and "what's on the way" each hour.
    global _LAST_TRANSFERS_SYNC
    transfers_due = (
        _LAST_TRANSFERS_SYNC is None
        or (now_utc - _LAST_TRANSFERS_SYNC).total_seconds() >= 3600
    )
    if transfers_due:
        _LAST_TRANSFERS_SYNC = now_utc
        try:
            import sys as _sys

            log.info("Running stock transfers sync...")
            run_subprocess_with_heartbeat(
                [_sys.executable, "/home/runner/workspace/extract_odoo_transfers.py"],
                "stock_transfers_extract",
            )
            log.info("✅ Stock transfers sync complete")
        except Exception as e:
            log.error("Stock transfers sync error: %s", e)
    global _LAST_INVENTORY_SYNC
    inventory_due = (
        _LAST_INVENTORY_SYNC is None
        or (now_utc - _LAST_INVENTORY_SYNC).total_seconds()
        >= INVENTORY_SYNC_INTERVAL_SEC
    )
    if inventory_due:
        _LAST_INVENTORY_SYNC = now_utc
        try:
            import subprocess, sys

            log.info("Running inventory sync (fast poll)...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_odoo_inventory.py"],
                check=True,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_shopify_inventory.py"],
                check=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    "/home/runner/workspace/extract_shopzetu_inventory.py",
                ],
                check=True,
            )
            write_heartbeat(conn, "inventory")
            log.info("✅ Inventory sync complete")
        except Exception as e:
            log.error("Inventory sync error: %s", e)

    # Attendance sync — HOURLY (the HR dashboard wants near-real-time figures).
    # Rate-limited to once per hour via a module-level guard even though main()
    # runs every 60s; runs immediately on the first cycle after a (re)start.
    global _LAST_ATTENDANCE_SYNC
    attendance_due = (
        _LAST_ATTENDANCE_SYNC is None
        or (now_utc - _LAST_ATTENDANCE_SYNC).total_seconds() >= 3600
    )
    if attendance_due:
        # Stamp up front so a transient failure waits an hour before retrying.
        _LAST_ATTENDANCE_SYNC = now_utc
        try:
            ensure_attendance_table(cur)
            conn.commit()
            sync_attendance(cur)
            conn.commit()
            write_heartbeat(conn, "attendance")
        except Exception as e:
            log.error("Attendance sync error: %s", e)
            conn.rollback()

    # Data-validation agent — HOURLY during its active window (06:00-22:00 EAT).
    # Self-contained module (validation_agent/) that reads the live DB and writes
    # ONLY its own tables (metric_baselines, validation_audit, validation_exceptions).
    # Run as a subprocess via the same entry point as the standalone command so a
    # failure or a hung LLM call can never crash the sync loop. The agent self-skips
    # outside active hours, so this hourly guard yields at most one audit per hour
    # in-window. Rate-limited to once per hour even though main() runs every 60s.
    # BOOT GRACE: never fires on the first cycle after a (re)start — see
    # _validation_gate for the 2026-08-13 healthcheck-outage rationale.
    global _LAST_VALIDATION_RUN
    validation_due, _LAST_VALIDATION_RUN = _validation_gate(
        _LAST_VALIDATION_RUN, now_utc
    )
    if validation_due:
        # Stamp up front so a transient failure waits an hour before retrying.
        _LAST_VALIDATION_RUN = now_utc
        try:
            import subprocess, sys

            log.info("Running data-validation agent...")
            subprocess.run(
                [sys.executable, "-m", "validation_agent.run"],
                cwd="/home/runner/workspace",
                check=True,
                timeout=900,
            )
            log.info("✅ Data-validation agent run complete")
        except Exception as e:
            log.error("Data-validation agent error: %s", e)

    # Accounting sync — nightly at 21:00 UTC
    if 21 <= now_utc.hour < 22:
        try:
            import subprocess, sys

            log.info("Running nightly accounting sync...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_accounting.py"],
                check=True,
            )
            log.info("✅ Accounting sync complete")
        except Exception as e:
            log.error("Accounting sync error: %s", e)

    # Odoo Reconciliation Agent — nightly, after the accounting sync so it reads
    # fresh ledgers. Hour-gated blocks fire on EVERY loop cycle within the hour,
    # so a date guard keeps this to one run per day (the engine is also
    # advisory-locked + idempotent, this just avoids wasted re-runs).
    global _LAST_RECON_RUN
    if 21 <= now_utc.hour < 22 and _LAST_RECON_RUN != now_utc.date():
        try:
            import subprocess, sys

            log.info("Running nightly reconciliation...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/recon_engine.py", "nightly"],
                check=True,
                timeout=1800,
            )
            _LAST_RECON_RUN = now_utc.date()
            log.info("✅ Nightly reconciliation complete")
        except Exception as e:
            log.error("Nightly reconciliation error: %s", e)

    # Fabric sheet override — the buying team's reconciled Jan–Apr 2026 consumption &
    # returns (Google Sheet), which replace Odoo's inflated moves for that window via
    # the fabric_moves_effective view. Lives in fabric_sheet_* tables (outside
    # raw_fabric_*) so it survives the Odoo TRUNCATE/rebuild. Bootstrap when
    # the override is empty/missing (fresh prod DB), then refresh EVERY MINUTE. Runs after
    # the Odoo fabric extract so raw_fabric_* exist when the view is (re)created.
    global _LAST_FABRIC_SHEET_EXTRACT
    sheet_empty = False
    try:
        cur.execute("SELECT to_regclass('public.fabric_sheet_consumption')")
        if cur.fetchone()[0] is None:
            sheet_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM fabric_sheet_consumption")
            sheet_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Fabric sheet presence check error: %s", e)
        conn.rollback()
    sheet_due = (
        _LAST_FABRIC_SHEET_EXTRACT is None
        or (now_utc - _LAST_FABRIC_SHEET_EXTRACT).total_seconds() >= 60
    )
    if sheet_empty or sheet_due:
        _LAST_FABRIC_SHEET_EXTRACT = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running fabric sheet override extract (bootstrap=%s)...", sheet_empty
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_fabric_sheet.py"],
                check=True,
            )
            log.info("✅ Fabric sheet override extract complete")
        except Exception as e:
            log.error("Fabric sheet override extract error: %s", e)

    # Fabric category update tracker (Task #295) — detects fabric products whose
    # Odoo Category/Sub-Category changed from go-live onward (frozen cut-off =
    # start of today, Nairobi) and mirrors the running tracker to a Google Sheet
    # inside a NEW folder in the user's Drive folder. Runs AFTER the Odoo fabric
    # extract so write_date/category are fresh. Bootstrap immediately when the
    # baseline snapshot is missing/empty (fresh prod DB — freezes the cut-off +
    # captures baseline on first run post-publish), then refresh every 5 minutes.
    # Idempotent (one row per barcode) and isolated so a failure (incl. the
    # google-drive connector not yet authorized) only logs and never crashes the
    # loop.
    global _LAST_FABRIC_CAT_TRACKER
    tracker_needs_bootstrap = False
    try:
        cur.execute("SELECT to_regclass('public.fabric_cat_baseline')")
        if cur.fetchone()[0] is None:
            tracker_needs_bootstrap = True
        else:
            cur.execute("SELECT COUNT(*) FROM fabric_cat_baseline")
            tracker_needs_bootstrap = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Fabric category tracker presence check error: %s", e)
        conn.rollback()
    tracker_due = (
        _LAST_FABRIC_CAT_TRACKER is None
        or (now_utc - _LAST_FABRIC_CAT_TRACKER).total_seconds() >= 300
    )
    if tracker_needs_bootstrap or tracker_due:
        _LAST_FABRIC_CAT_TRACKER = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running fabric category update tracker (bootstrap=%s)...",
                tracker_needs_bootstrap,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/fabric_category_tracker.py"],
                check=True,
            )
            log.info("✅ Fabric category update tracker complete")
        except Exception as e:
            log.error("Fabric category update tracker error: %s", e)

    # Production tracker sync — feeds the /production board (production_orders +
    # stage_movements) with the buying & manufacturing orders. New Odoo buying
    # orders (DPS documents) won't appear until this runs, so fold it into the
    # supervised loop instead of the manual standalone run. Production runs on a
    # SEPARATE DB, so bootstrap immediately when production_orders is empty
    # (fresh prod DB), then refresh EVERY 30 MINUTES.
    # sync_production_tracker.py is idempotent — it upserts on order_ref and only
    # appends the intake DELTA per DPS, so re-running never doubles intake. Runs
    # as a subprocess like the other Odoo extracts. A module-level guard
    # rate-limits to once per 30 minutes even though main() runs every 60s. The
    # production_orders/stage_movements tables are created by api_pg's startup
    # hook (_ensure_production_tables), and the watchdog brings the API up before
    # this loop, so we skip entirely if the table is missing and let the next
    # cycle pick it up once it exists (avoids erroring every 60s on a cold DB).
    global _LAST_PRODUCTION_SYNC
    production_table_missing = False
    production_empty = False
    try:
        cur.execute("SELECT to_regclass('public.production_orders')")
        if cur.fetchone()[0] is None:
            production_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM production_orders")
            production_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Production tracker presence check error: %s", e)
        conn.rollback()
    production_due = (
        _LAST_PRODUCTION_SYNC is None
        or (now_utc - _LAST_PRODUCTION_SYNC).total_seconds() >= 1800
    )
    if not production_table_missing and (production_empty or production_due):
        # Stamp the attempt time up front so a transient failure waits a minute
        # (when still empty, the production_empty branch retries next cycle).
        _LAST_PRODUCTION_SYNC = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running production tracker (Odoo) sync (bootstrap=%s)...",
                production_empty,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_production_tracker.py"],
                check=True,
            )
            log.info("✅ Production tracker sync complete")
        except Exception as e:
            log.error("Production tracker sync error: %s", e)

    # Production Tracker Sheet feed — governed read-only Google Sheets ingestion
    # of "Production Tracker 2026" (Task #1607). Daily-class cadence: this is
    # production-reporting data (monthly output/transfer/mix/process figures),
    # not a wallboard-style poll. The sync script is idempotent (upsert on
    # metric/period, never on run) and self-claims via app_singleflight, so a
    # concurrent manual "Sync now" from the API can never collide with this.
    # It also creates its own tables on first run, so no table-existence guard
    # is needed here (unlike the Odoo-backed syncs above, which depend on
    # tables created elsewhere at boot).
    global _LAST_TRACKER_SHEET_SYNC
    tracker_sheet_due = (
        _LAST_TRACKER_SHEET_SYNC is None
        or (now_utc - _LAST_TRACKER_SHEET_SYNC).total_seconds() >= 86400
    )
    if tracker_sheet_due:
        _LAST_TRACKER_SHEET_SYNC = now_utc
        try:
            import subprocess, sys

            log.info("Running Production Tracker Sheet sync (scheduled)...")
            subprocess.run(
                [
                    sys.executable,
                    "/home/runner/workspace/production_tracker_sheet_sync.py",
                    "--scheduled",
                ],
                check=True,
                timeout=120,
            )
            log.info("✅ Production Tracker Sheet sync complete")
        except Exception as e:
            log.error("Production Tracker Sheet sync error: %s", e)

    # MO fabric-consumption extract — feeds the "Avg metres per garment" KPI on the
    # Fabric Overview (mo_fabric_consumption table). It reads Done DPS manufacturing
    # orders from Odoo (main-fabric components only). Production runs on a SEPARATE
    # DB that never ran extract_mo_fabric_consumption.py, so the table starts empty
    # and the KPI shows "—" until this runs. We bootstrap immediately when the table
    # is empty (fresh prod DB), then refresh EVERY 30 MINUTES on the same cadence as
    # the production tracker (both derive from the same DPS/MO documents). The
    # extract upserts on (odoo_mo_id, component_id) over a trailing window, so
    # re-running never duplicates and recently-closed MOs self-correct. The table is
    # created by the extract itself; we skip if it is missing and the extract creates
    # it on its first run (a later cycle picks up the count).
    global _LAST_MO_FABRIC_CONSUMPTION
    mo_fab_empty = False
    try:
        cur.execute("SELECT to_regclass('public.mo_fabric_consumption')")
        if cur.fetchone()[0] is None:
            mo_fab_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM mo_fabric_consumption")
            mo_fab_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("MO fabric-consumption presence check error: %s", e)
        conn.rollback()
    mo_fab_due = (
        _LAST_MO_FABRIC_CONSUMPTION is None
        or (now_utc - _LAST_MO_FABRIC_CONSUMPTION).total_seconds() >= 1800
    )
    if mo_fab_empty or mo_fab_due:
        # Stamp the attempt time up front so a transient failure waits a cycle
        # (when still empty, the mo_fab_empty branch retries next cycle).
        _LAST_MO_FABRIC_CONSUMPTION = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running MO fabric-consumption extract (bootstrap=%s)...", mo_fab_empty
            )
            subprocess.run(
                [
                    sys.executable,
                    "/home/runner/workspace/extract_mo_fabric_consumption.py",
                ],
                check=True,
            )
            log.info("✅ MO fabric-consumption extract complete")
        except Exception as e:
            log.error("MO fabric-consumption extract error: %s", e)

    # Central Tracker Google Sheet extract — mirrors Style No / Style Name /
    # Order Qty / Order Date from the 4 year-tabs of the Central Tracker sheet
    # into the central_tracker_orders Postgres table. Rate-limited to once per
    # 30 minutes; bootstraps immediately when the table is empty or missing so
    # a fresh prod DB is populated on the first cycle. The extractor itself
    # creates the table (CREATE TABLE IF NOT EXISTS), so we always attempt the
    # run when missing (treat as empty).
    global _LAST_CENTRAL_TRACKER
    central_tracker_empty = False
    try:
        cur.execute("SELECT to_regclass('public.central_tracker_orders')")
        if cur.fetchone()[0] is None:
            central_tracker_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM central_tracker_orders")
            central_tracker_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Central tracker presence check error: %s", e)
        conn.rollback()
    central_tracker_due = (
        _LAST_CENTRAL_TRACKER is None
        or (now_utc - _LAST_CENTRAL_TRACKER).total_seconds() >= 1800
    )
    if central_tracker_empty or central_tracker_due:
        _LAST_CENTRAL_TRACKER = now_utc
        try:
            import subprocess, sys

            log.info(
                "Running Central Tracker sheet extract (bootstrap=%s)...",
                central_tracker_empty,
            )
            subprocess.run(
                [sys.executable, "/home/runner/workspace/extract_central_tracker.py"],
                check=True,
            )
            log.info("✅ Central Tracker sheet extract complete")
        except Exception as e:
            log.error("Central Tracker sheet extract error: %s", e)

    # Fabric Months-of-Cover daily snapshot — logs the EXACT inputs behind the
    # Fabric "Months of Cover" KPI (RMAT/Stock kg + the 6-completed-month average
    # net-consumption run-rate + per-month breakdown, plus the Basic Fabrics
    # equivalents) once per EAT calendar day so the KPI card can show a
    # day-over-day "what changed since yesterday" decomposition (stock lever vs
    # run-rate lever). Production runs on a SEPARATE DB that never runs the dev
    # rebuild, so history must accrue from inside this loop. Idempotent: the
    # writer upserts on the EAT capture date, so re-running the same day
    # overwrites, never duplicates. We only run when today's EAT snapshot is
    # missing (fresh prod DB, or a new EAT day just began) — a cheap indexed
    # lookup, so no fixed timer is needed and each EAT day is captured on the
    # first cycle after midnight EAT. The writer reuses fabric_router's SAME
    # _months_of_cover helper behind the live card so the snapshot can never
    # diverge, and ensures its own schema. Gated on the fabric feed being present
    # (raw_fabric_products has rows) so a cold DB doesn't error before the fabric
    # extract has run; a later cycle picks it up.
    fabric_ready = False
    need_cover_snapshot = True
    try:
        cur.execute("SELECT to_regclass('public.raw_fabric_products')")
        if cur.fetchone()[0] is not None:
            cur.execute("SELECT EXISTS(SELECT 1 FROM raw_fabric_products)")
            fabric_ready = bool(cur.fetchone()[0])
        cur.execute("SELECT to_regclass('public.fabric_cover_snapshot')")
        if cur.fetchone()[0] is not None:
            cur.execute(
                "SELECT 1 FROM fabric_cover_snapshot "
                "WHERE capture_date = (now() AT TIME ZONE 'Africa/Nairobi')::date"
            )
            need_cover_snapshot = cur.fetchone() is None
        conn.commit()
    except Exception as e:
        log.error("Fabric cover snapshot presence check error: %s", e)
        conn.rollback()
    if fabric_ready and need_cover_snapshot:
        try:
            import fabric_router

            log.info("Writing fabric Months-of-Cover daily snapshot...")
            snap = fabric_router.write_cover_snapshot(conn)
            log.info(
                "✅ Fabric Months-of-Cover snapshot written (cover=%s, basic_cover=%s)",
                snap.get("months_of_cover"),
                snap.get("basic_months_of_cover"),
            )
        except Exception as e:
            log.error("Fabric cover snapshot error: %s", e)
            try:
                conn.rollback()
            except Exception:
                pass

    # Product image extract — feeds the /gallery thumbnails (product_images +
    # product_image_map: base64 512px photos keyed by Odoo template, plus a
    # sku->template map). Production runs on a SEPARATE DB that never ran the
    # manual extract_product_images.py, so /gallery shows only coloured-initials
    # placeholders until this runs. We bootstrap immediately when product_images
    # is missing/empty (fresh prod DB) so no manual step is needed, then refresh
    # EVERY 24 HOURS (photos change rarely and this is the heaviest Odoo pull —
    # a full base64 image fetch per template). The extract reads
    # all_products_clean, so we skip until that transform has populated rows (it
    # runs earlier in this same cycle) and let a later cycle pick it up — this
    # avoids writing an empty map on a cold DB. extract_product_images.py upserts
    # on tmpl_id/sku (ON CONFLICT), so re-running never duplicates. Run as a
    # subprocess like the other Odoo extracts. A module-level guard rate-limits
    # to once per 24h even though main() runs every 60s.
    global _LAST_PRODUCT_IMAGES_EXTRACT
    images_empty = False
    products_ready = False
    try:
        cur.execute("SELECT to_regclass('public.product_images')")
        if cur.fetchone()[0] is None:
            images_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM product_images")
            images_empty = cur.fetchone()[0] == 0
        cur.execute("SELECT to_regclass('public.all_products_clean')")
        if cur.fetchone()[0] is not None:
            cur.execute(
                "SELECT EXISTS(SELECT 1 FROM all_products_clean WHERE product_id IS NOT NULL)"
            )
            products_ready = bool(cur.fetchone()[0])
        conn.commit()
    except Exception as e:
        log.error("Product images presence check error: %s", e)
        conn.rollback()
    images_due = (
        _LAST_PRODUCT_IMAGES_EXTRACT is None
        or (now_utc - _LAST_PRODUCT_IMAGES_EXTRACT).total_seconds() >= 86400
    )
    if products_ready and (images_empty or images_due):
        # Stamp the attempt time up front so a transient failure waits 24h before
        # retrying — except while still empty, where the images_empty branch keeps
        # retrying every cycle until the bootstrap succeeds.
        _LAST_PRODUCT_IMAGES_EXTRACT = now_utc
        try:
            import sys

            log.info("Running product image extract (bootstrap=%s)...", images_empty)
            run_subprocess_with_heartbeat(
                [sys.executable, "/home/runner/workspace/extract_product_images.py"],
                "product_image_extract",
            )
            log.info("✅ Product image extract complete")
        except Exception as e:
            log.error("Product image extract error: %s", e)

    # Shopify product-image GALLERY extract — feeds the MULTI-IMAGE scrollable
    # lightbox carousel (product_image_urls: ordered gallery URLs per SKU, pulled
    # straight from the Shopify Admin API). This is DISTINCT from the Odoo base64
    # single-image extract above: that gives each style ONE photo, this gives the
    # full scrollable gallery. Production runs on a SEPARATE DB that never ran the
    # manual extract_shopify_images.py, so on a fresh prod DB product_image_urls
    # is EMPTY and GET /api/product-images returns nothing — the lightbox then
    # falls back to the single Odoo photo (only one image, no scroll, unlike dev).
    # We bootstrap immediately when product_image_urls is missing/empty (fresh
    # prod DB) so no manual step is needed, then refresh EVERY 24 HOURS (photos
    # change rarely and this is a full multi-store Shopify crawl). The extract
    # fetches all stores BEFORE it TRUNCATE+repopulates in one transaction, so a
    # mid-crawl failure leaves the existing gallery intact (idempotent). It reads
    # no DB source table, so the only prerequisite is the Shopify store/token
    # secrets — skip QUIETLY if any are missing so a DB without Shopify creds does
    # not crash-loop the subprocess every cycle. A module-level guard rate-limits
    # to once per 24h even though main() runs every 60s.
    global _LAST_SHOPIFY_IMAGES_EXTRACT
    piu_empty = False
    try:
        cur.execute("SELECT to_regclass('public.product_image_urls')")
        if cur.fetchone()[0] is None:
            piu_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM product_image_urls")
            piu_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Shopify image-URLs presence check error: %s", e)
        conn.rollback()
    piu_due = (
        _LAST_SHOPIFY_IMAGES_EXTRACT is None
        or (now_utc - _LAST_SHOPIFY_IMAGES_EXTRACT).total_seconds() >= 86400
    )
    shopify_creds_ok = all(
        os.environ.get(k)
        for k in (
            "SHOPIFY_KENYA_STORE",
            "SHOPIFY_KENYA_TOKEN",
            "SHOPIFY_UGANDA_STORE",
            "SHOPIFY_UGANDA_TOKEN",
            "SHOPIFY_RWANDA_STORE",
            "SHOPIFY_RWANDA_TOKEN",
        )
    )
    if shopify_creds_ok and (piu_empty or piu_due):
        # Stamp the attempt time up front so a transient failure waits 24h before
        # retrying — except while still empty, where the piu_empty branch keeps
        # retrying every cycle until the bootstrap succeeds.
        _LAST_SHOPIFY_IMAGES_EXTRACT = now_utc
        try:
            import sys

            log.info(
                "Running Shopify product-image gallery extract (bootstrap=%s)...",
                piu_empty,
            )
            run_subprocess_with_heartbeat(
                [sys.executable, "/home/runner/workspace/extract_shopify_images.py"],
                "shopify_gallery_extract",
            )
            log.info("✅ Shopify product-image gallery extract complete")
        except Exception as e:
            log.error("Shopify product-image gallery extract error: %s", e)
    elif (piu_empty or piu_due) and not shopify_creds_ok:
        log.info(
            "Skipping Shopify product-image gallery extract — Shopify store/token "
            "secrets not set (lightbox falls back to single Odoo photo)."
        )

    # Fabric product-image extract — feeds the /fabric barcode-detail popup carousel
    # (fabric_images: Drive photos matched to a fabric by filename=barcode). Same
    # self-refreshing pattern as the product-image extracts above. Production runs on
    # a SEPARATE DB, so we bootstrap immediately when fabric_images is missing/empty
    # (fresh prod DB), then refresh EVERY 24 HOURS (fabric photos change rarely and
    # this is a Drive crawl + base64 fetch). The extractor is DORMANT (no-op) until
    # FABRIC_IMAGES_GSA_JSON + FABRIC_IMAGES_DRIVE_FOLDER_ID are set, so a DB without
    # those secrets never crash-loops — skip QUIETLY in that case. It upserts idx
    # 0..n and prunes (idempotent), so re-running never duplicates. Run in-process
    # under a heartbeat keepalive so a slow Drive crawl can't stall the watchdog.
    global _LAST_FABRIC_IMAGES_EXTRACT
    fab_img_empty = False
    try:
        cur.execute("SELECT to_regclass('public.fabric_images')")
        if cur.fetchone()[0] is None:
            fab_img_empty = True
        else:
            cur.execute("SELECT COUNT(*) FROM fabric_images")
            fab_img_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Fabric images presence check error: %s", e)
        conn.rollback()
    fab_img_due = (
        _LAST_FABRIC_IMAGES_EXTRACT is None
        or (now_utc - _LAST_FABRIC_IMAGES_EXTRACT).total_seconds() >= 86400
    )
    fab_img_creds_ok = bool(
        os.environ.get("ODOO_URL")
        and os.environ.get("ODOO_DB")
        and os.environ.get("ODOO_USER")
        and os.environ.get("ODOO_PASSWORD")
    )
    if fab_img_creds_ok and (fab_img_empty or fab_img_due):
        # Stamp the attempt time up front so a transient failure waits 24h before
        # retrying — except while still empty, where the fab_img_empty branch keeps
        # retrying every cycle until the bootstrap succeeds.
        _LAST_FABRIC_IMAGES_EXTRACT = now_utc
        try:
            import extract_fabric_images

            log.info(
                "Running fabric product-image extract (bootstrap=%s)...",
                fab_img_empty,
            )

            def _run_fab_img(hb):
                with psycopg2.connect(DATABASE_URL) as fconn:
                    # Odoo is the EXCLUSIVE fabric image source: primary
                    # image_1920 ('Face', idx=-1) + extra-media gallery photos
                    # (idx 0..n, label = Odoo image name, e.g. 'Back').
                    # run_odoo also purges retired drive/upload rows, so the
                    # cleanup self-applies on prod after publish.
                    extract_fabric_images.run_odoo(fconn, heartbeat=hb)

            with heartbeat_keepalive("fabric_image_extract") as hb:
                _run_fab_img(hb)
            log.info("✅ Fabric product-image extract complete")
        except Exception as e:
            log.error("Fabric product-image extract error: %s", e)
    elif (fab_img_empty or fab_img_due) and not fab_img_creds_ok:
        log.info(
            "Skipping fabric product-image extract — ODOO_* secrets not set "
            "(popup shows 'No image')."
        )

    # Social CRM sync — pulls new Facebook + Instagram posts, comments, @-mentions
    # (and FB Messenger DMs) into the vivo-crm Inbox (crm_social_feedback) so they
    # appear without anyone pressing "Sync from Facebook/Instagram". Same
    # self-refreshing pattern as the fabric/production/product-image extracts.
    # Production runs on a SEPARATE DB, so we bootstrap immediately when
    # crm_social_feedback is empty (fresh prod DB), then refresh EVERY HOUR. The
    # sync endpoints are idempotent (ON CONFLICT(source_id) dedup + persisted
    # resume cursors) and each holds its own server-side 240s budget + non-blocking
    # lock, so an hourly cadence deep-backfills toward the stored-row targets over
    # successive runs, then settles to a ~5-10s incremental. We POST them over the
    # shared proxy authenticated with SESSION_SECRET (X-Internal-Token) — the same
    # mechanism the other sync-loop internal endpoints use — and wrap the calls in
    # heartbeat_keepalive so a long first-run deep-backfill can't look "stuck" to
    # the watchdog and get killed mid-cycle. FB is the token source for IG too, so
    # both are gated on FACEBOOK_PAGE_ACCESS_TOKEN / FACEBOOK_PAGE_ID being set;
    # skip QUIETLY when unconfigured so a DB without Meta creds does not log noise.
    global _LAST_SOCIAL_CRM_SYNC
    social_table_missing = False
    social_empty = False
    try:
        cur.execute("SELECT to_regclass('public.crm_social_feedback')")
        if cur.fetchone()[0] is None:
            social_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM crm_social_feedback")
            social_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Social CRM sync presence check error: %s", e)
        conn.rollback()
    social_due = (
        _LAST_SOCIAL_CRM_SYNC is None
        or (now_utc - _LAST_SOCIAL_CRM_SYNC).total_seconds() >= 3600
    )
    _fb_creds_ok = bool(
        os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN")
        and os.environ.get("FACEBOOK_PAGE_ID")
    )
    _internal_secret = os.environ.get("SESSION_SECRET")
    if not social_table_missing and (social_empty or social_due):
        if not _fb_creds_ok:
            log.info(
                "Skipping social CRM sync — FACEBOOK_PAGE_ACCESS_TOKEN / "
                "FACEBOOK_PAGE_ID not set (Instagram reuses the FB Page token)."
            )
        elif not _internal_secret:
            log.warning("Social CRM sync skipped — SESSION_SECRET unset")
        else:
            # Stamp the attempt time up front so a transient failure waits an hour
            # before retrying — except while still empty, where the social_empty
            # branch keeps retrying every cycle until the bootstrap succeeds.
            _LAST_SOCIAL_CRM_SYNC = now_utc
            # The FB Send-API-backed sync and the IG deep-backfill can each run up
            # to their 240s server budget, so keep the heartbeat alive throughout.
            with heartbeat_keepalive("social_crm_sync"):
                for _label, _url in (
                    ("Facebook", "http://localhost:80/api/social/facebook/sync"),
                    ("Instagram", "http://localhost:80/api/social/instagram/sync"),
                ):
                    try:
                        log.info(
                            "Running %s CRM sync (bootstrap=%s)...",
                            _label,
                            social_empty,
                        )
                        resp = requests.post(
                            _url,
                            headers={"X-Internal-Token": _internal_secret},
                            timeout=300,
                        )
                        log.info(
                            "%s CRM sync — HTTP %s %s",
                            _label,
                            resp.status_code,
                            resp.text[:200],
                        )
                    except Exception as e:
                        log.error("%s CRM sync error: %s", _label, e)

    # BI sales-rollup refresh — feeds the pre-aggregated rollup_* tables that make
    # the Customers / Range Management / Product Analysis endpoints fast. The read
    # paths in api_pg fall back to live SQL whenever a rollup is missing or stale,
    # so this is purely a performance refresh. Production runs on a SEPARATE DB that
    # never runs the full rebuild, so we bootstrap immediately when the rollup
    # tables are empty/missing (fresh prod DB) so the endpoints get fast on first
    # deploy, then refresh EVERY HOUR (the windows are CURRENT_DATE-relative, so a
    # daily refresh is the floor; hourly keeps them inside the freshness gate).
    # build_sales_rollups.py is a thin wrapper over api_pg.run_sales_rollup_refresh
    # (build-then-swap per table, idempotent), run as a subprocess like the other
    # extracts. rollup_meta is created by api_pg's startup hook and the watchdog
    # brings the API up before this loop, so skip if missing and let a later cycle
    # pick it up once it exists.
    global _LAST_ROLLUP_REFRESH
    rollup_table_missing = False
    rollup_empty = False
    try:
        cur.execute("SELECT to_regclass('public.rollup_meta')")
        if cur.fetchone()[0] is None:
            rollup_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM rollup_meta")
            rollup_empty = cur.fetchone()[0] == 0
        conn.commit()
    except Exception as e:
        log.error("Rollup presence check error: %s", e)
        conn.rollback()
    rollup_due = (
        _LAST_ROLLUP_REFRESH is None
        or (now_utc - _LAST_ROLLUP_REFRESH).total_seconds() >= 3600
    )
    if not rollup_table_missing and (rollup_empty or rollup_due):
        # Stamp the attempt time up front so a transient failure waits an hour
        # (when still empty, the rollup_empty branch retries on the next cycle).
        _LAST_ROLLUP_REFRESH = now_utc
        try:
            import subprocess, sys

            log.info("Refreshing BI sales rollups (bootstrap=%s)...", rollup_empty)
            subprocess.run(
                [sys.executable, "/home/runner/workspace/build_sales_rollups.py"],
                check=True,
            )
            log.info("✅ BI sales rollups refreshed")
        except Exception as e:
            log.error("BI sales rollup refresh error: %s", e)

    # HR roster bootstrap — the staff roster (hr_employees) is hand-imported from
    # a company Google Sheet and the HR attendance pages enrich raw biometric
    # attendance via hr_employee_match -> hr_employees. Production runs on a
    # SEPARATE DB that was never loaded with the roster, so a fresh prod DB shows
    # no departments/teams/job-titles until this runs. Bootstrap immediately when
    # hr_employees is empty (fresh prod DB) and re-read from the sheet (source of
    # truth), then rebuild the name-match table. Once both the roster AND the
    # name-match table are populated this stops firing (roster changes are picked
    # up on demand via POST /api/hr/employees/rematch?reimport=1) so there is no
    # recurring LLM cost. The guard is completeness-based (not just roster
    # COUNT==0): it ALSO fires when hr_employees has rows but hr_employee_match is
    # empty, so a partial/interrupted first load self-heals on a later cycle
    # rather than leaving HR enrichment permanently broken. sync_hr_roster.py is
    # an idempotent full-refresh, run as a subprocess like the other extracts; it
    # imports api_pg so we skip if the tables are missing and let a later cycle
    # pick it up once the API's startup hook has created them.
    roster_table_missing = False
    roster_incomplete = False
    try:
        cur.execute(
            "SELECT to_regclass('public.hr_employees'),"
            "       to_regclass('public.hr_employee_match')"
        )
        emp_reg, match_reg = cur.fetchone()
        if emp_reg is None or match_reg is None:
            roster_table_missing = True
        else:
            cur.execute("SELECT COUNT(*) FROM hr_employees")
            emp_n = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM hr_employee_match")
            match_n = cur.fetchone()[0]
            # Empty roster (fresh prod DB) OR a roster that loaded but never got
            # its name-match table rebuilt (partial first load).
            roster_incomplete = (emp_n == 0) or (emp_n > 0 and match_n == 0)
        conn.commit()
    except Exception as e:
        log.error("HR roster presence check error: %s", e)
        conn.rollback()
    if not roster_table_missing and roster_incomplete:
        try:
            import subprocess, sys

            log.info("Bootstrapping HR roster from Google Sheet...")
            subprocess.run(
                [sys.executable, "/home/runner/workspace/sync_hr_roster.py", "--ai"],
                check=True,
            )
            log.info("✅ HR roster bootstrap complete")
        except Exception as e:
            log.error("HR roster bootstrap error: %s", e)

    # Chronic-stockout snapshot — once a day around midnight EAT (21:00 UTC).
    # The API endpoint dedupes to a weekly cadence, so running it on every cycle
    # in this window is harmless; we only narrow to the hour to avoid pointless
    # calls the rest of the day. It authenticates with the shared SESSION_SECRET.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/replenishment/snapshot",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info(
                    "Stockout snapshot — HTTP %s %s", resp.status_code, resp.text[:200]
                )
            else:
                log.warning("Stockout snapshot skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Stockout snapshot error: %s", e)

    # Restatement check — once a day in the same 21:00 UTC window. Snapshots
    # closed-month canonical KPIs and records a restatement when history was
    # rewritten (re-extracts / re-netting / recovery backfills), so the
    # dashboard can badge affected comparison bases with "restated on DATE".
    # The endpoint is idempotent (drift-vs-snapshot compare; same-day upsert).
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/internal/restatement-check",
                    headers={"X-Internal-Token": _secret},
                    timeout=180,
                )
                log.info(
                    "Restatement check — HTTP %s %s", resp.status_code, resp.text[:200]
                )
            else:
                log.warning("Restatement check skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Restatement check error: %s", e)

    # Cross-page reconciliation — once a day in the same 21:00 UTC window.
    # Asserts the WS1-2 identities (Net/Total Sales + canonical GROSS units
    # equal across Overview KPIs / Locations country summary / Trend series)
    # and persists results to dq_cross_checks for the Data Quality page.
    # Idempotent per day (upsert on run_date+check_name).
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/data-quality/cross-check",
                    headers={"X-Internal-Token": _secret},
                    timeout=180,
                )
                log.info(
                    "Cross-page reconcile — HTTP %s %s",
                    resp.status_code,
                    resp.text[:200],
                )
            else:
                log.warning("Cross-page reconcile skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Cross-page reconcile error: %s", e)

    # Data-quality log — once a day in the same 21:00 UTC window. Records the
    # current overall data-quality score onto a sync_health_log row so quality
    # is tracked alongside sync health. Authenticates with the shared secret.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/data-quality/log",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info(
                    "Data-quality log — HTTP %s %s", resp.status_code, resp.text[:200]
                )
            else:
                log.warning("Data-quality log skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Data-quality log error: %s", e)

    # Replenishment SOR snapshot — once a day in the same 21:00 UTC window. The
    # endpoint ensures its own schema (so the fact tables self-bootstrap from the
    # sync loop on a fresh prod DB too) and is idempotent on run_id, so a daily
    # immutable pick-list snapshot accrues for SOR attributability even on days
    # with no staff page visit. Authenticates with the shared SESSION_SECRET.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/analytics/replenishment-sor/snapshot",
                    headers={"X-Internal-Token": _secret},
                    timeout=180,
                )
                log.info(
                    "Replen SOR snapshot — HTTP %s %s",
                    resp.status_code,
                    resp.text[:200],
                )
            else:
                log.warning("Replen SOR snapshot skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("Replen SOR snapshot error: %s", e)

    # IBT Phase-3 nightly reconcile — once a day in the same 21:00 UTC window. The
    # endpoint ensures its own lifecycle tables (so they self-bootstrap from the sync
    # loop on a fresh prod DB), self-heals expired soft-reservations, refreshes
    # observed corridor lead times, and records the projection calibration sample for
    # the latest landed run (idempotent per run_id). It never touches the canonical
    # SOR formula — calibration tempers the forward projection only. Authenticates
    # with the shared SESSION_SECRET via X-Internal-Token.
    try:
        if now.hour == 21:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/ibt/nightly-reconcile",
                    headers={"X-Internal-Token": _secret},
                    timeout=120,
                )
                log.info(
                    "IBT nightly reconcile — HTTP %s %s",
                    resp.status_code,
                    resp.text[:200],
                )
            else:
                log.warning("IBT nightly reconcile skipped — SESSION_SECRET unset")
    except Exception as e:
        log.error("IBT nightly reconcile error: %s", e)

    # X (Twitter) CRM inbox sync — self-bootstrap from inside the sync loop so a
    # fresh prod DB populates the social inbox on first publish, then refreshes
    # hourly (like the Facebook/Instagram engines). The endpoint is idempotent
    # (dedup by source_id) and cursor-resumed, so a cycle only ingests the delta.
    # Hour-gated (like the validation agent) even though main() runs every 60s so
    # we don't hammer X's rate-limited API tiers. We pass a small time budget so a
    # deep backfill cannot stall the sync loop past the watchdog heartbeat window;
    # successive hourly runs continue the backfill from the persisted cursor. Only
    # runs when X is configured on the server (a 400 "not configured" is expected
    # + harmless). A 409 means a run is already in flight — benign, log quietly.
    global _LAST_X_SYNC
    x_sync_due = _LAST_X_SYNC is None or (now - _LAST_X_SYNC).total_seconds() >= 3600
    if x_sync_due:
        try:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/social/x/sync",
                    headers={"X-Internal-Token": _secret},
                    json={"max_seconds": 90},
                    timeout=150,
                )
                if resp.status_code == 400:
                    # Not configured — stamp so we don't retry for an hour.
                    _LAST_X_SYNC = now
                    log.info("X sync skipped — not configured on the server")
                elif resp.status_code == 409:
                    # Already running (concurrent run) — benign; retry next hour.
                    _LAST_X_SYNC = now
                    log.info("X sync skipped — a sync is already running")
                else:
                    _LAST_X_SYNC = now
                    log.info(
                        "X CRM sync — HTTP %s %s", resp.status_code, resp.text[:200]
                    )
            else:
                log.warning("X sync skipped — SESSION_SECRET unset")
        except Exception as e:
            log.error("X CRM sync error: %s", e)

    # TikTok CRM inbox sync — once per hour, mirroring the X block. Own videos
    # (posts) ONLY — TikTok's public API has no DM API and grants no comment
    # scopes (comment sync is gated off in crm_clienteling.py). Idempotent +
    # cursor-resumed, small time budget so a deep backfill can't stall the loop.
    # A 400 "not configured" is expected + harmless; a 409 means a run is already
    # in flight — benign, log quietly.
    global _LAST_TIKTOK_SYNC
    tiktok_sync_due = (
        _LAST_TIKTOK_SYNC is None or (now - _LAST_TIKTOK_SYNC).total_seconds() >= 3600
    )
    if tiktok_sync_due:
        try:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/social/tiktok/sync",
                    headers={"X-Internal-Token": _secret},
                    json={"max_seconds": 90},
                    timeout=150,
                )
                if resp.status_code == 400:
                    # Not configured — stamp so we don't retry for an hour.
                    _LAST_TIKTOK_SYNC = now
                    log.info("TikTok sync skipped — not configured on the server")
                elif resp.status_code == 409:
                    # Already running (concurrent run) — benign; retry next hour.
                    _LAST_TIKTOK_SYNC = now
                    log.info("TikTok sync skipped — a sync is already running")
                else:
                    _LAST_TIKTOK_SYNC = now
                    log.info(
                        "TikTok CRM sync — HTTP %s %s",
                        resp.status_code,
                        resp.text[:200],
                    )
            else:
                log.warning("TikTok sync skipped — SESSION_SECRET unset")
        except Exception as e:
            log.error("TikTok CRM sync error: %s", e)

    # Google Reviews (Business Profile) CRM inbox sync — once per hour,
    # mirroring the TikTok block. Idempotent (unique source_id upserts), small
    # time budget so a large multi-location walk can't stall the loop. A 400
    # "not connected" is expected + harmless; a 409 means a run is already in
    # flight — benign, log quietly.
    global _LAST_GREVIEWS_SYNC
    greviews_sync_due = (
        _LAST_GREVIEWS_SYNC is None
        or (now - _LAST_GREVIEWS_SYNC).total_seconds() >= 3600
    )
    if greviews_sync_due:
        try:
            _secret = os.environ.get("SESSION_SECRET")
            if _secret:
                resp = requests.post(
                    "http://localhost:80/api/social/google/sync",
                    headers={"X-Internal-Token": _secret},
                    json={"max_seconds": 120},
                    timeout=150,
                )
                if resp.status_code == 400:
                    # Not connected — stamp so we don't retry for an hour.
                    _LAST_GREVIEWS_SYNC = now
                    log.info("Google Reviews sync skipped — not connected")
                elif resp.status_code == 409:
                    _LAST_GREVIEWS_SYNC = now
                    log.info("Google Reviews sync skipped — already running")
                else:
                    _LAST_GREVIEWS_SYNC = now
                    log.info(
                        "Google Reviews CRM sync — HTTP %s %s",
                        resp.status_code,
                        resp.text[:200],
                    )
            else:
                log.warning("Google Reviews sync skipped — SESSION_SECRET unset")
        except Exception as e:
            log.error("Google Reviews CRM sync error: %s", e)

    # Presence-column tidy-up — once a day in the 21:00 UTC window. Live-but-idle
    # user_sessions rows keep the last_active_at/last_active_page presence stamps
    # they were last written with, and a long-running Reserved VM rarely reboots
    # (the boot-time expired-session reap in api_pg._ensure_users_table only fires
    # then), so those stamps — and the presence index that covers them — accrete
    # over time. The active-viewers query filters by a 45s recency window, so a
    # stamp older than that is dead weight. Clear it on any session whose
    # last_active_at is far past the presence window (1h) to bound index bloat.
    # Correctness-neutral: expired sessions are still reaped on boot, and a stamp
    # this old could never satisfy the 45s active-viewers filter.
    try:
        if now.hour == 21:
            cur.execute(
                "UPDATE user_sessions SET last_active_page=NULL, last_active_at=NULL "
                "WHERE last_active_at IS NOT NULL "
                "  AND last_active_at < now() - interval '1 hour'"
            )
            log.info(
                "Presence sweep — cleared %d stale presence stamp(s)", cur.rowcount
            )
            conn.commit()
    except Exception as e:
        log.error("Presence sweep error: %s", e)
        conn.rollback()

    # AI nightly: compute baselines + generate digest (01:00–04:59 EAT, once per day).
    # ai_insights_router runs in standalone mode (DATABASE_URL) — no api_pg import needed.
    _eat_now = datetime.now(timezone.utc) + timedelta(hours=3)
    if 1 <= _eat_now.hour <= 4:
        try:
            _ai_date_str = str(_eat_now.date())
            _ai_skip = False
            try:
                with conn.cursor() as _ai_c:
                    _ai_c.execute("SELECT to_regclass('public.ai_daily_insights')")
                    if _ai_c.fetchone()[0] is not None:
                        _ai_c.execute(
                            "SELECT COUNT(*) FROM ai_daily_insights WHERE date=%s",
                            (_ai_date_str,),
                        )
                        _ai_skip = _ai_c.fetchone()[0] > 0
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            if not _ai_skip:
                log.info("AI nightly: starting for %s", _ai_date_str)
                write_heartbeat(conn, "ok")  # pulse before long LLM calls
                import ai_insights_router as _air

                _air.nightly_run()
        except Exception as _ai_err:
            log.error("AI nightly error: %s", _ai_err)

    write_heartbeat(conn, "ok")
    conn.close()
    log.info("=== Sync complete ===")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Vivo incremental sync")
    ap.add_argument(
        "--once",
        action="store_true",
        help="run a single sync cycle and exit (used for recovery)",
    )
    ap.add_argument(
        "--days",
        type=int,
        default=None,
        help="re-pull this many days before the last known sale",
    )
    cli = ap.parse_args()
    if cli.days is not None:
        LOOKBACK_DAYS = cli.days
        log.info("Lookback window overridden to %d days", LOOKBACK_DAYS)

    if cli.once:
        # Recovery / one-shot backfill: run a single sales cycle and exit. The
        # fabric worker is intentionally NOT started here — it belongs to the
        # long-running supervised loop (a one-shot backfill has no need to refresh
        # the fabric feed, and starting a background thread in a short-lived
        # process would only risk overlapping the supervised worker's pulls).
        main()
    else:
        # Start the dedicated fabric worker on its own ~60s timer, in a daemon
        # thread, BEFORE the sales loop — so the /fabric feed refreshes on a true
        # ~60s cadence regardless of how long each (10-15 min) sales/inventory
        # cycle takes. Daemon so it dies with the process (e.g. when the watchdog
        # terminates the sync for recovery). It uses its OWN DB connection and
        # writes ONLY the raw_fabric_* tables, so Main BI is unaffected.
        import threading

        _fabric_thread = threading.Thread(
            target=fabric_worker_loop, name="fabric-worker", daemon=True
        )
        _fabric_thread.start()

        # Dedicated ~60s sales fast-path (same rationale as the fabric worker):
        # all_sales refreshes every minute regardless of how long the full
        # sales/inventory cycle below takes. Continuous loop only — a --once
        # recovery run must not spawn a competing worker.
        if SALES_WORKER_ENABLED:
            _sales_thread = threading.Thread(
                target=sales_worker_loop, name="sales-worker", daemon=True
            )
            _sales_thread.start()
        else:
            log.info("Sales worker disabled (SALES_WORKER_ENABLED=0)")

        while True:
            try:
                main()
            except Exception as e:
                log.error("Fatal sync error: %s", e)
            log.info("Sleeping 1 minute...")
            time.sleep(60)
