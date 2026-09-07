import ast
import os
from pathlib import Path
import threading
import time
import types
import unittest
from unittest.mock import patch


def _load_snapshot_helper():
    """Load the production helper without importing api_pg's DB/startup stack."""
    source = Path("api_pg.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_cached_dashboard_snapshot"
    )
    module = types.SimpleNamespace()
    namespace = {
        "os": os,
        "threading": threading,
        "time": time,
        "_CACHE_LOCK": threading.Lock(),
        "_dashboard_snapshot_inflight": {},
        "_swr_ctx": types.SimpleNamespace(bypass_key=None),
        "_snapshot_ctx": types.SimpleNamespace(force_fresh_inner=False),
        "SLOW_QUERY_WARN_SEC": 999,
        "log": types.SimpleNamespace(warning=lambda *args: None),
        "smart_ttl": lambda _date_to: 60,
        "swr_refresh": lambda *args, **kwargs: None,
    }

    class _Load:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    namespace["_interactive_dashboard_load"] = _Load
    exec(compile(ast.Module(body=[function], type_ignores=[]), "api_pg.py", "exec"), namespace)
    module.namespace = namespace
    module.snapshot = namespace["_cached_dashboard_snapshot"]
    return module


class OverviewSnapshotRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_snapshot_helper()
        self.key = "test:overview-loading"

    def test_successful_build_is_returned(self):
        self.module.namespace["cache_get_swr"] = lambda _key: (None, False)
        self.module.namespace["cache_set"] = lambda *args, **kwargs: None
        result = self.module.snapshot(
                self.key, "2026-09-07", lambda: {"ok": True}, "test")
        self.assertEqual(result, {"ok": True})

    def test_stale_snapshot_returns_immediately_and_schedules_one_refresh(self):
        refreshes = []
        cached = {"stale": True}
        self.module.namespace["cache_get_swr"] = lambda _key: (cached, False)
        self.module.namespace["swr_refresh"] = (
            lambda key, build, label: refreshes.append((key, build, label))
        )

        result = self.module.snapshot(
            self.key, "2026-09-07", lambda: {"fresh": True}, "test")

        self.assertIs(result, cached)
        self.assertEqual(len(refreshes), 1)
        self.assertEqual(refreshes[0][0], self.key)

    def test_failed_owner_releases_waiters(self):
        entered = threading.Event()
        release = threading.Event()

        def failed_build():
            entered.set()
            release.wait(1)
            raise RuntimeError("boom")

        errors = []
        self.module.namespace["cache_get_swr"] = lambda _key: (None, False)
        self.module.namespace["cache_set"] = lambda *args, **kwargs: None
        with patch.dict(os.environ, {}, clear=False):
            owner = threading.Thread(
                target=lambda: self._capture_error(failed_build, errors))
            owner.start()
            self.assertTrue(entered.wait(1))
            waiter = threading.Thread(
                target=lambda: self._capture_error(lambda: None, errors))
            waiter.start()
            release.set()
            owner.join(1)
            waiter.join(1)

        self.assertFalse(owner.is_alive())
        self.assertFalse(waiter.is_alive())
        self.assertEqual([str(error) for error in errors], ["boom", "boom"])

    def test_stalled_owner_does_not_strand_waiter(self):
        entered = threading.Event()
        release = threading.Event()

        def stalled_build():
            entered.set()
            release.wait(1)
            return {"late": True}

        errors = []
        self.module.namespace["cache_get_swr"] = lambda _key: (None, False)
        self.module.namespace["cache_set"] = lambda *args, **kwargs: None
        with patch.dict(os.environ, {"DASHBOARD_SNAPSHOT_WAIT_SEC": "0.03"}):
            owner = threading.Thread(
                target=lambda: self.module.snapshot(
                    self.key, "2026-09-07", stalled_build, "test"))
            owner.start()
            self.assertTrue(entered.wait(1))
            started = time.monotonic()
            self._capture_error(lambda: None, errors)
            elapsed = time.monotonic() - started
            release.set()
            owner.join(1)

        self.assertLess(elapsed, 0.5)
        self.assertIsInstance(errors[0], TimeoutError)

    def _capture_error(self, build, errors):
        try:
            self.module.snapshot(
                self.key, "2026-09-07", build, "test")
        except Exception as error:
            errors.append(error)


if __name__ == "__main__":
    unittest.main()