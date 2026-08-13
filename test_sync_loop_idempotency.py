"""Idempotency tests for the remaining hour-gated internal sync-loop POSTs.

The incremental sync loop (``sync_incremental.py``) runs a full cycle roughly
every 60s, and its "once a day" work is gated only by ``if now.hour == 21``
(UTC) — so every endpoint it POSTs in that window is actually hit ~60x that
night, not once. Each must therefore dedupe its own writes; the hour gate is NOT
a once-a-day guarantee (see ``.agents/memory/sync-loop-idempotent-endpoints.md``).

``test_ibt_nightly_reconcile.py`` already pins this contract for
``/api/ibt/nightly-reconcile``. This file does the same for the other three
hour-gated POSTs the loop fires in the 21:00 window:

* ``POST /api/replenishment/snapshot``            -> weekly-cadence skip guard
* ``POST /api/data-quality/log``                  -> one row per UTC day
* ``POST /api/analytics/replenishment-sor/snapshot`` -> run_id ON CONFLICT upsert

Each endpoint is driven twice against a small stateful in-memory fake of the
user-store access helpers (no live Postgres), so the real production code path is
exercised — not a reimplementation — and the second run is asserted to be a
no-op (no duplicate rows, counts unchanged).

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_sync_loop_idempotency
"""
import asyncio
import contextlib
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

import api_pg


def _eat_today():
    return (datetime.now(timezone.utc) + timedelta(hours=3)).date()


def _utc_today():
    return datetime.now(timezone.utc).date()


# ─────────────────────────────────────────────────────────────────────────────
# 1) POST /api/replenishment/snapshot — chronic-stockout weekly snapshot.
#    Idempotency rests on a weekly-cadence skip (MAX(snapshot_date) within 6
#    days short-circuits) PLUS an ON CONFLICT (snapshot_date, style_name,
#    country) upsert so even a forced re-run never duplicates a row.
# ─────────────────────────────────────────────────────────────────────────────
class _FakeStockoutDB:
    """Stateful stand-in covering only the SQL the snapshot path issues.
    ``stockout_snapshots`` is a dict keyed (snapshot_date, style_name, country)
    so an INSERT ... ON CONFLICT overwrites rather than appends."""

    def __init__(self):
        self.stockout_snapshots = {}

    def users_exec(self, query, params=None, fetch=False):
        q = " ".join(query.split())
        if q.startswith("SELECT MAX(snapshot_date)"):
            dates = [k[0] for k in self.stockout_snapshots]
            return [{"d": max(dates) if dates else None}]
        return [] if fetch else None

    @contextlib.contextmanager
    def users_tx(self, lock=False):
        yield _FakeStockoutCursor(self)


class _FakeStockoutCursor:
    def __init__(self, db):
        self.db = db

    def execute(self, query, params=None):
        q = " ".join(query.split())
        if q.startswith("INSERT INTO stockout_snapshots"):
            # params: (snapshot_date, style_name, brand, subcategory, country,
            #          woc, at_risk, weekly, soh_total)
            key = (params[0], params[1], params[4])
            self.db.stockout_snapshots[key] = params

    def fetchone(self):
        return None


_STOCKOUT_ROWS = [
    {"style_name": "VW-DRESS-01", "country": "Kenya", "brand": "Vivo",
     "subcategory": "Dresses", "u28": 14, "u56": 20, "soh_total": 6},
    {"style_name": "VW-TOP-02", "country": "Uganda", "brand": "Vivo",
     "subcategory": "Tops", "u28": 7, "u56": 12, "soh_total": 30},
    # weekly velocity 0 -> intentionally skipped by the endpoint (not tracked).
    {"style_name": "DEAD-03", "country": "Kenya", "brand": "Vivo",
     "subcategory": "Tops", "u28": 0, "u56": 0, "soh_total": 100},
]


class ReplenishmentSnapshotIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.db = _FakeStockoutDB()
        patches = [
            mock.patch.object(api_pg, "_ensure_stockout_table", lambda: None),
            mock.patch.object(api_pg, "run_query",
                              side_effect=lambda *a, **k: list(_STOCKOUT_ROWS)),
            mock.patch.object(api_pg, "_users_exec",
                              side_effect=self.db.users_exec),
            mock.patch.object(api_pg, "_users_tx", side_effect=self.db.users_tx),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _run(self, force=False):
        return asyncio.run(api_pg.replenishment_snapshot(None, force=force))

    def test_second_same_day_run_is_skipped(self):
        out1 = self._run()
        rows_after_1 = dict(self.db.stockout_snapshots)
        out2 = self._run()
        rows_after_2 = dict(self.db.stockout_snapshots)

        # Run 1 writes the 2 actively-selling styles (the velocity-0 row drops).
        self.assertFalse(out1["skipped"])
        self.assertEqual(out1["rows_written"], 2)
        self.assertEqual(len(rows_after_1), 2)
        # Run 2 short-circuits on the weekly-cadence guard: no new writes.
        self.assertTrue(out2["skipped"])
        self.assertEqual(rows_after_1, rows_after_2)

    def test_forced_rerun_upserts_without_duplicating(self):
        # Even bypassing the weekly skip, the ON CONFLICT upsert keeps the table
        # at exactly one row per (date, style, country).
        out1 = self._run(force=True)
        out2 = self._run(force=True)
        self.assertFalse(out1["skipped"])
        self.assertFalse(out2["skipped"])
        self.assertEqual(out1["rows_written"], out2["rows_written"])
        self.assertEqual(len(self.db.stockout_snapshots), 2)


# ─────────────────────────────────────────────────────────────────────────────
# 2) POST /api/data-quality/log — daily data-quality score row.
#    Idempotency: under the advisory lock, skip if a 'data_quality' row already
#    exists for today (UTC). So only ONE row accrues per day no matter how many
#    times the 21:00 window fires it.
# ─────────────────────────────────────────────────────────────────────────────
class _FakeHealthLogDB:
    def __init__(self):
        self.sync_health_log = []   # list of dicts (action_taken, checked_at_date)

    @contextlib.contextmanager
    def users_tx(self, lock=False):
        yield _FakeHealthLogCursor(self)


class _FakeHealthLogCursor:
    def __init__(self, db):
        self.db = db
        self._last = None

    def execute(self, query, params=None):
        q = " ".join(query.split())
        if q.startswith("SELECT 1 FROM sync_health_log"):
            today = _utc_today()
            hit = any(r["action_taken"] == "data_quality"
                      and r["checked_at_date"] == today
                      for r in self.db.sync_health_log)
            self._last = {"?column?": 1} if hit else None
        elif q.startswith("INSERT INTO sync_health_log"):
            # params: (action_taken, notes, data_quality_score)
            self.db.sync_health_log.append({
                "action_taken": params[0],
                "checked_at_date": _utc_today(),
                "data_quality_score": params[2],
            })
            self._last = None

    def fetchone(self):
        return self._last


_DQ_REPORT = {
    "overall_score": 92.5,
    "checks": [
        {"check": "inventory_freshness", "status": "ok", "score": 95.0},
        {"check": "sku_match_rate", "status": "alert", "score": 70.0},
    ],
}


class DataQualityLogIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.db = _FakeHealthLogDB()
        patches = [
            mock.patch.object(api_pg, "_ensure_data_quality_column",
                              lambda: None),
            mock.patch.object(api_pg, "_data_quality_report_dict",
                              lambda: dict(_DQ_REPORT)),
            mock.patch.object(api_pg, "_users_tx", side_effect=self.db.users_tx),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_second_same_day_run_logs_no_duplicate(self):
        out1 = api_pg.data_quality_log(None)
        out2 = api_pg.data_quality_log(None)

        # Run 1 inserts exactly one row; run 2 finds today's row and skips.
        self.assertFalse(out1["skipped"])
        self.assertTrue(out2["skipped"])
        self.assertEqual(out2["reason"], "already logged today")
        self.assertEqual(len(self.db.sync_health_log), 1)
        self.assertEqual(self.db.sync_health_log[0]["action_taken"],
                         "data_quality")
        self.assertEqual(self.db.sync_health_log[0]["data_quality_score"], 92.5)
        # The score is reported identically on both runs.
        self.assertEqual(out1["data_quality_score"], out2["data_quality_score"])


# ─────────────────────────────────────────────────────────────────────────────
# 3) POST /api/analytics/replenishment-sor/snapshot — immutable pick-list fact.
#    Idempotency: the run_id is a hash of (business_date|scope|ruleset|weeks),
#    and _persist_replen_suggestions upserts ON CONFLICT (run_id, pos_location,
#    sku). So re-stamping the same day's snapshot overwrites the same run rather
#    than accumulating duplicate fact rows.
# ─────────────────────────────────────────────────────────────────────────────
class _FakeReplenFactDB:
    def __init__(self):
        # keyed (run_id, pos_location, sku) so ON CONFLICT overwrites.
        self.fact_replen_suggestion = {}

    def users_exec(self, query, params=None, fetch=False):
        q = " ".join(query.split())
        if q.startswith("INSERT INTO fact_replen_suggestion"):
            # params[0]=run_id, params[4]=pos_location, params[6]=sku
            key = (params[0], params[4], params[6])
            self.fact_replen_suggestion[key] = params
            return None
        return [] if fetch else None


def _sor_result():
    return {
        "business_date": str(_eat_today()),
        "demand_weeks": api_pg.REPLEN_DEMAND_WEEKS_DEFAULT,
        "rows": [
            {"pos_location": "Vivo Sarit", "country": "Kenya",
             "sku": "SKU-A", "barcode": "B-A", "size": "M",
             "style_name": "VW-DRESS-01", "units_sold": 12, "soh_store": 3,
             "soh_wh": 40, "velocity": 4.0, "sku_class": "A", "floor": 4,
             "target": 12, "replenish": 9, "deploy_now": True,
             "censored": False, "wh_constrained": False},
            {"pos_location": "Vivo Yaya", "country": "Kenya",
             "sku": "SKU-B", "barcode": "B-B", "size": "L",
             "style_name": "VW-TOP-02", "units_sold": 5, "soh_store": 1,
             "soh_wh": 10, "velocity": 1.5, "sku_class": "B", "floor": 2,
             "target": 5, "replenish": 4, "deploy_now": False,
             "censored": False, "wh_constrained": False},
        ],
    }


class ReplenSorSnapshotIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.db = _FakeReplenFactDB()
        patches = [
            mock.patch.object(api_pg, "_ensure_replen_tables", lambda: None),
            mock.patch.object(api_pg, "_compute_replenishment_sor",
                              side_effect=lambda *a, **k: _sor_result()),
            mock.patch.object(api_pg, "_users_exec",
                              side_effect=self.db.users_exec),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_second_run_same_run_id_upserts_no_duplicate(self):
        out1 = api_pg.analytics_replenishment_sor_snapshot()
        facts_after_1 = dict(self.db.fact_replen_suggestion)
        out2 = api_pg.analytics_replenishment_sor_snapshot()
        facts_after_2 = dict(self.db.fact_replen_suggestion)

        # Same business_date + demand_weeks -> identical run_id both runs.
        self.assertEqual(out1["run_id"], out2["run_id"])
        self.assertEqual(out1["suggested_rows"], 2)
        # Run 1 wrote 2 distinct fact rows; run 2 upserted the SAME keys, so the
        # table holds exactly those 2 rows (no accumulation/duplication).
        self.assertEqual(len(facts_after_1), 2)
        self.assertEqual(set(facts_after_1), set(facts_after_2))
        self.assertEqual(len(facts_after_2), 2)


class ValidationBootGraceTests(unittest.TestCase):
    """The data-validation agent must NOT fire on the first cycle after boot.

    2026-08-13: the agent's cross-surface HTTP sweep on a fresh prod VM (cold
    caches + boot prewarm + live traffic) starved the event loop and failed
    the platform runtime healthcheck. ``_validation_gate`` back-dates the
    first stamp 30 minutes so the first audit lands ~30 min after boot; the
    hourly cadence is unchanged after that.
    """

    def test_first_cycle_not_due_and_backdates_stamp(self):
        import sync_incremental as si
        now = datetime(2026, 8, 13, 12, 4, tzinfo=timezone.utc)
        due, stamp = si._validation_gate(None, now)
        self.assertFalse(due)
        self.assertEqual(stamp, now - timedelta(minutes=30))

    def test_due_about_30_minutes_after_boot(self):
        import sync_incremental as si
        boot = datetime(2026, 8, 13, 12, 4, tzinfo=timezone.utc)
        _, stamp = si._validation_gate(None, boot)
        due29, s29 = si._validation_gate(stamp, boot + timedelta(minutes=29))
        self.assertFalse(due29)
        self.assertEqual(s29, stamp)  # stamp untouched until due
        due30, _ = si._validation_gate(stamp, boot + timedelta(minutes=30))
        self.assertTrue(due30)

    def test_hourly_cadence_with_existing_stamp(self):
        import sync_incremental as si
        last = datetime(2026, 8, 13, 9, 0, tzinfo=timezone.utc)
        due, _ = si._validation_gate(last, last + timedelta(minutes=59))
        self.assertFalse(due)
        due2, _ = si._validation_gate(last, last + timedelta(hours=1))
        self.assertTrue(due2)


if __name__ == "__main__":
    unittest.main()
