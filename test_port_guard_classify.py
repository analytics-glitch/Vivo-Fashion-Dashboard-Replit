"""Unit tests for the port-guard cmdline classifier.

The guard (``port_guard.free_port``) reclaims :PORT from a stale API launcher
before binding. Its kill decision ANDs two facts: the holder actually owns the
LISTEN socket AND its cmdline is one of THIS repo's own API launchers. This file
pins the second half — ``_classify_cmdline`` — which is pure and side-effect-free
(no sockets, no process kills), so it can be tested directly.

The bug this guards against: the in-process dev launcher ``run_api.py`` runs
uvicorn via ``uvicorn.run(...)`` inside its own process, so its cmdline is just
``python3 .../run_api.py`` — it contains NEITHER ``uvicorn`` NOR ``api_pg``. The
original classifier only matched ``uvicorn`` AND ``api_pg``, so a stale
``run_api.py`` was misread as an unrelated process and never killed, leaving the
dev workflow FAILED while the orphan served stale code.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_port_guard_classify
"""
import unittest

from port_guard import _classify_cmdline


class ClassifyCmdlineTest(unittest.TestCase):
    def test_run_api_dev_launcher_recognized(self):
        # In-process dev launcher: cmdline has neither 'uvicorn' nor 'api_pg'.
        self.assertTrue(
            _classify_cmdline("python3 /home/runner/workspace/run_api.py")
        )

    def test_uvicorn_api_pg_worker_recognized(self):
        # Direct uvicorn invocation (old dev workflow).
        self.assertTrue(_classify_cmdline("uvicorn api_pg:app --port 8080"))

    def test_watchdog_spawned_uvicorn_child_recognized(self):
        # Prod path: watchdog spawns uvicorn as a child whose cmdline has both.
        self.assertTrue(
            _classify_cmdline(
                "/usr/bin/python3 -m uvicorn api_pg:app "
                "--host 0.0.0.0 --port 8080"
            )
        )

    def test_unrelated_python_process_not_recognized(self):
        self.assertFalse(
            _classify_cmdline("python3 /home/runner/workspace/some_other_script.py")
        )

    def test_uvicorn_for_a_different_app_not_recognized(self):
        # uvicorn without api_pg is some other server — leave it alone.
        self.assertFalse(_classify_cmdline("uvicorn other_app:app --port 9000"))

    def test_api_pg_without_uvicorn_not_recognized(self):
        # A bare import/test of api_pg is not a launcher holding the port.
        self.assertFalse(_classify_cmdline("python3 -c import api_pg"))

    def test_empty_cmdline_not_recognized(self):
        # _cmdline returns "" when /proc read fails; must never raise/match.
        self.assertFalse(_classify_cmdline(""))


if __name__ == "__main__":
    unittest.main()
