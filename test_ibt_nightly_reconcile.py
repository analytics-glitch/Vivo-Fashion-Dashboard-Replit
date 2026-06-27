"""Idempotency tests for the nightly IBT self-heal (POST /api/ibt/nightly-reconcile).

The nightly reconcile fires on EVERY sync cycle inside the 21:00 UTC window (the
hook in ``sync_incremental.py`` is hour-gated, so it actually runs ~60x/night),
and it is unguarded by design: its safety rests entirely on every step being
idempotent. These tests pin that contract so a future edit that makes any step
accumulate (a duplicate calibration sample, a re-released reservation, a
corridor row that grows instead of upserting) is caught here instead of silently
double-correcting production overnight.

The real ``ibt_nightly_reconcile`` endpoint is driven twice against a small
stateful in-memory fake of ``_users_exec`` (no live Postgres needed), so the
actual production code path -- reservation release, corridor upsert,
calibration recording -- is exercised, not a reimplementation.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_ibt_nightly_reconcile
"""
import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import api_pg


def _now():
    return datetime.now(timezone.utc)


class _FakeUsersDB:
    """Minimal stateful stand-in for ``_users_exec`` covering only the SQL the
    nightly reconcile path issues. State persists across calls so running the
    endpoint twice exercises real idempotency (already-released reservations are
    not re-released, the corridor upsert overwrites instead of appending, and a
    same-run calibration sample is not re-recorded)."""

    def __init__(self, reservations, landed_runs, corridor_source, overdue=0):
        # app_config stores parsed JSON (psycopg2 returns jsonb as a dict).
        self.app_config = {}
        self.reservations = reservations          # list of mutable dicts
        self.landed_runs = landed_runs            # reconciliation source rows
        self.corridor_source = corridor_source    # [(from, to, lead_days, n_obs)]
        self.corridor = {}                        # (from, to) -> upserted row
        self.overdue = overdue

    def exec(self, query, params=None, fetch=False):
        q = " ".join(query.split())

        # (2) Self-heal: release expired ACTIVE reservations. Idempotent because
        # the WHERE clause only touches rows still 'active'.
        if q.startswith("UPDATE transfer_reservations SET status='released'"):
            released = []
            for r in self.reservations:
                if (r["status"] == "active" and r["expires_at"] is not None
                        and r["expires_at"] <= _now()):
                    r["status"] = "released"
                    released.append({"id": r["id"]})
            return released if fetch else None

        # Overdue in_transit count (read-only, never mutates).
        if "FROM ibt_transfer WHERE status='in_transit'" in q:
            return [{"n": self.overdue}]

        # (3) Corridor lead-time upsert. ON CONFLICT DO UPDATE => keyed by
        # (from, to), so re-running overwrites the same key (dict semantics)
        # rather than appending a duplicate row.
        if q.startswith("INSERT INTO corridor_leadtime"):
            returned = []
            for (fc, tc, lead, n) in self.corridor_source:
                if n >= 3:
                    self.corridor[(fc, tc)] = {
                        "lead_days": lead, "source": "observed", "n_obs": n}
                    returned.append({"from_country": fc})
            return returned if fetch else None

        # (4) Landed-run reconciliation source rows.
        if "FROM ibt_transfer WHERE status IN ('received','discrepancy')" in q:
            return [dict(r) for r in self.landed_runs]

        # Calibration read.
        if q.startswith("SELECT value FROM app_config WHERE key='ibt_proj_calibration'"):
            v = self.app_config.get("ibt_proj_calibration")
            return [{"value": v}] if v is not None else []

        # Calibration write (idempotency guard lives in the Python caller, which
        # short-circuits before reaching here when run_id is unchanged).
        if q.startswith("INSERT INTO app_config"):
            self.app_config["ibt_proj_calibration"] = json.loads(params[0])
            return None

        return [] if fetch else None


def _make_db():
    reservations = [
        {"id": 1, "status": "active",
         "expires_at": _now() - timedelta(hours=2)},   # expired -> release
        {"id": 2, "status": "active",
         "expires_at": _now() - timedelta(minutes=5)},  # expired -> release
        {"id": 3, "status": "active",
         "expires_at": _now() + timedelta(hours=6)},    # live -> stays active
        {"id": 4, "status": "consumed",
         "expires_at": _now() - timedelta(hours=2)},    # not 'active' -> untouched
    ]
    landed_runs = [{
        "run_id": "RUN-2026-06-26", "dispatched": 100, "received": 90,
        "proj_ccc_days": 50.0, "proj_value_kes": 200000.0,
        "lines": 12, "discrepancies": 1, "last_received": None,
    }]
    corridor_source = [
        ("Kenya", "Uganda", 4, 5),   # n>=3 -> upserted
        ("Kenya", "Rwanda", 3, 3),   # n>=3 -> upserted
        ("Uganda", "Kenya", 2, 2),   # n<3  -> skipped (keeps seeded default)
    ]
    return _FakeUsersDB(reservations, landed_runs, corridor_source)


class NightlyReconcileIdempotencyTests(unittest.TestCase):
    """Running the nightly reconcile twice for the same run_id is a no-op the
    second time across all stateful steps."""

    def setUp(self):
        self.db = _make_db()
        # Ensure-table DDL is irrelevant to idempotency; stub to no-ops.
        patches = [
            mock.patch.object(api_pg, "_users_exec", side_effect=self.db.exec),
            mock.patch.object(api_pg, "_ensure_ibt_lifecycle_tables",
                              lambda: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_double_run_is_stable(self):
        out1 = api_pg.ibt_nightly_reconcile()
        cal_after_1 = copy.deepcopy(self.db.app_config.get("ibt_proj_calibration"))
        corridor_after_1 = copy.deepcopy(self.db.corridor)
        active_after_1 = sum(1 for r in self.db.reservations
                             if r["status"] == "active")

        out2 = api_pg.ibt_nightly_reconcile()
        cal_after_2 = copy.deepcopy(self.db.app_config.get("ibt_proj_calibration"))
        corridor_after_2 = copy.deepcopy(self.db.corridor)
        active_after_2 = sum(1 for r in self.db.reservations
                             if r["status"] == "active")

        # --- Reservations: the 2 expired holds release on run 1 only; run 2
        # finds nothing left to release and the live hold survives both runs.
        self.assertEqual(out1["reservations_released"], 2)
        self.assertEqual(out2["reservations_released"], 0)
        self.assertEqual(active_after_1, 1)
        self.assertEqual(active_after_2, 1)

        # --- Corridor upsert: same pairs refreshed each run, and the table holds
        # exactly the >=3-obs pairs (no duplicate/accumulated rows on re-run).
        self.assertEqual(out1["corridor_pairs_refreshed"],
                         out2["corridor_pairs_refreshed"])
        self.assertEqual(len(corridor_after_1), 2)
        self.assertEqual(corridor_after_1, corridor_after_2)

        # --- Calibration: one sample recorded on run 1, NOT duplicated on run 2
        # (same run_id), and the persisted value/median is unchanged.
        self.assertIsNotNone(cal_after_1)
        self.assertEqual(cal_after_1["last_run_id"], "RUN-2026-06-26")
        self.assertEqual(len(cal_after_1["samples"]), 1)
        self.assertEqual(len(cal_after_2["samples"]), 1)
        self.assertEqual(cal_after_1["value"], cal_after_2["value"])
        self.assertEqual(out1["calibration"], out2["calibration"])
        # 90/100 = 0.9 realised/projected for this run.
        self.assertAlmostEqual(cal_after_1["value"], 0.9, places=4)


class CalibrationRunIdGuardTests(unittest.TestCase):
    """``_ibt_record_calibration`` is idempotent per run_id: the same run never
    contributes a second sample, but a genuinely new run does."""

    def setUp(self):
        self.db = _make_db()
        p = mock.patch.object(api_pg, "_users_exec", side_effect=self.db.exec)
        p.start()
        self.addCleanup(p.stop)

    def test_same_run_id_does_not_append(self):
        m1 = api_pg._ibt_record_calibration(0.8, run_id="RUN-A")
        samples_1 = list(self.db.app_config["ibt_proj_calibration"]["samples"])

        # Same run, different (would-be) sample value -> must be ignored.
        m2 = api_pg._ibt_record_calibration(0.4, run_id="RUN-A")
        samples_2 = list(self.db.app_config["ibt_proj_calibration"]["samples"])

        self.assertEqual(samples_1, [0.8])
        self.assertEqual(samples_2, [0.8])   # unchanged: no second sample
        self.assertEqual(m1, m2)

    def test_new_run_id_appends_one_sample(self):
        api_pg._ibt_record_calibration(0.8, run_id="RUN-A")
        api_pg._ibt_record_calibration(0.6, run_id="RUN-B")
        samples = self.db.app_config["ibt_proj_calibration"]["samples"]
        self.assertEqual(samples, [0.8, 0.6])
        self.assertEqual(
            self.db.app_config["ibt_proj_calibration"]["last_run_id"], "RUN-B")


class CorridorRefreshIdempotencyTests(unittest.TestCase):
    """``_ibt_refresh_corridor_observed`` upserts (never accumulates) when run
    repeatedly within the same nightly window."""

    def setUp(self):
        self.db = _make_db()
        p = mock.patch.object(api_pg, "_users_exec", side_effect=self.db.exec)
        p.start()
        self.addCleanup(p.stop)

    def test_repeated_refresh_keeps_table_stable(self):
        n1 = api_pg._ibt_refresh_corridor_observed()
        snapshot_1 = copy.deepcopy(self.db.corridor)
        n2 = api_pg._ibt_refresh_corridor_observed()
        n3 = api_pg._ibt_refresh_corridor_observed()
        snapshot_3 = copy.deepcopy(self.db.corridor)

        self.assertEqual(n1, 2)
        self.assertEqual((n1, n2, n3), (2, 2, 2))
        self.assertEqual(len(self.db.corridor), 2)       # no growth
        self.assertEqual(snapshot_1, snapshot_3)         # identical content


if __name__ == "__main__":
    unittest.main()
