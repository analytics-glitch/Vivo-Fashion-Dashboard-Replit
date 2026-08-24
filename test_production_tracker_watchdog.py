"""Regression coverage for production-tracker freshness recovery."""

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import watchdog as wd


class _Cursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split()).lower()
        if "to_regclass('public.production_sync_heartbeat')" in normalized:
            self.conn.result = (
                ("production_sync_heartbeat",) if self.conn.table_exists else (None,)
            )
        elif "from production_sync_heartbeat" in normalized:
            self.conn.result = (self.conn.last_run_at,)
        else:
            raise AssertionError(f"Unexpected SQL: {sql}")

    def fetchone(self):
        return self.conn.result


class _Connection:
    def __init__(self, last_run_at=None, table_exists=True):
        self.last_run_at = last_run_at
        self.table_exists = table_exists
        self.result = None

    def cursor(self):
        return _Cursor(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ProductionTrackerWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.original_recovery = wd._last_production_sync_recovery
        wd._last_production_sync_recovery = None
        self.addCleanup(
            setattr, wd, "_last_production_sync_recovery", self.original_recovery
        )

    def _check(self, **kwargs):
        with mock.patch.object(wd, "_db", return_value=_Connection(**kwargs)):
            return wd.check_production_tracker()

    def test_fresh_production_heartbeat_is_healthy(self):
        healthy, _, age = self._check(
            last_run_at=datetime.now(timezone.utc) - timedelta(minutes=1)
        )
        self.assertTrue(healthy)
        self.assertLess(age, wd.PRODUCTION_SYNC_FRESH_MIN)

    def test_stale_or_missing_production_heartbeat_is_unhealthy(self):
        healthy, _, age = self._check(
            last_run_at=datetime.now(timezone.utc) - timedelta(
                minutes=wd.PRODUCTION_SYNC_FRESH_MIN + 1
            )
        )
        self.assertFalse(healthy)
        self.assertGreater(age, wd.PRODUCTION_SYNC_FRESH_MIN)

        healthy, last_run, age = self._check(table_exists=False)
        self.assertFalse(healthy)
        self.assertIsNone(last_run)
        self.assertIsNone(age)

    def test_recovery_uses_bounded_standalone_sync(self):
        completed = mock.MagicMock(returncode=0)
        with mock.patch.object(wd.subprocess, "run", return_value=completed) as run:
            message = wd.run_production_tracker_recovery(reason="test")

        self.assertIn("completed", message)
        self.assertEqual(run.call_args.kwargs["timeout"], wd.PRODUCTION_SYNC_TIMEOUT_SEC)
        self.assertIsNotNone(wd._last_production_sync_recovery)


if __name__ == "__main__":
    unittest.main()