"""Behavioural tests pinning the dedicated fabric worker loop.

The fabric (Odoo) extract used to sit at the top of the incremental sync's
``main()`` cycle, which also runs the heavy Shopify/ShopZetu/Odoo/inventory/
production pulls and only completes every ~10-15 min. Even though the fabric
step was rate-limited to once per 60s, it could therefore only fire ONCE PER
FULL CYCLE, leaving the /fabric feed 10-15 min stale and the page's "sync
running a little behind" banner (fires when the last fabric pull is >180s old)
permanently on. ``fabric_worker_loop`` moved that fast pull onto its OWN ~60s
daemon-thread timer so /fabric refreshes on a true ~60s cadence.

These tests lock that behaviour in so a future refactor of the sync loop can't
silently re-couple fabric to the slow sales cycle (or drop the worker) without a
test failing. They exercise the REAL ``fabric_worker_loop`` against a fake DB
connection + stubbed extract subprocess (no live Postgres, no real Odoo pull),
asserting:

* the fast pull is gated to ~60s via ``_LAST_FABRIC_EXTRACT``;
* the worker respects ``stop_event`` and exits promptly (no full-tick sleep);
* an empty/missing fabric table triggers a FULL bootstrap;
* the worker only ever touches ``raw_fabric_*`` / its own ``fabric_heartbeat`` —
  never ``all_sales`` / ``all_inventory`` (Main BI stays untouched); and
* (regression) the worker thread is wired into the continuous loop path only,
  NOT the ``--once`` recovery path.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_fabric_worker_loop
"""
import ast
import os
import subprocess
import threading
import time
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

import sync_incremental as si


# ─────────────────────────────────────────────────────────────────────────────
# Fakes: a stateful stand-in for the fabric worker's dedicated psycopg2 conn.
# It only answers the two presence-check queries the loop issues
# (to_regclass + COUNT(*) FROM raw_fabric_inventory) and records every SQL
# string so a test can assert nothing ever hit all_sales / all_inventory.
# ─────────────────────────────────────────────────────────────────────────────
class _FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append(sql)
        s = " ".join(sql.split()).lower()
        if "to_regclass" in s:
            # to_regclass(...) returns NULL when the table does not exist.
            self.conn._last = (None,) if self.conn.missing else \
                ("public.raw_fabric_inventory",)
        elif "count(*) from raw_fabric_inventory" in s:
            self.conn._last = (0,) if self.conn.empty else (1234,)
        else:
            self.conn._last = None

    def fetchone(self):
        return self.conn._last


class _FakeConn:
    def __init__(self, empty=False, missing=False):
        self.empty = empty          # raw_fabric_inventory has 0 rows
        self.missing = missing      # raw_fabric_inventory does not exist yet
        self.executed = []          # every SQL string executed
        self.closed = False
        self.commits = 0
        self.rollbacks = 0
        self._last = None

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class _OneShotStop(threading.Event):
    """Runs the loop body EXACTLY once: is_set() is False at the while-check so
    the body runs, then the loop's end-of-iteration ``stop_event.wait(tick)``
    sets the flag and returns True immediately -> the loop breaks without ever
    sleeping the full tick. This deterministically exercises one iteration."""

    def wait(self, timeout=None):
        self.set()
        return True


class _FabricWorkerHarness(unittest.TestCase):
    """Common patching + a helper that runs ONE loop iteration against a
    configurable fake connection."""

    def setUp(self):
        # Snapshot + reset the module globals the loop mutates so tests are
        # isolated (each reassigns them via `global`).
        self._orig_globals = {
            k: getattr(si, k) for k in (
                "_LAST_FABRIC_EXTRACT", "_LAST_FABRIC_HEAVY_EXTRACT",
                "_FABRIC_HEAVY_PROC", "_FABRIC_HEAVY_STARTED_AT",
            )
        }
        si._LAST_FABRIC_EXTRACT = None
        si._LAST_FABRIC_HEAVY_EXTRACT = None
        si._FABRIC_HEAVY_PROC = None
        si._FABRIC_HEAVY_STARTED_AT = None

        def _restore():
            for k, v in self._orig_globals.items():
                setattr(si, k, v)
        self.addCleanup(_restore)

        self.run_extract = mock.MagicMock(name="run_subprocess_with_heartbeat")
        self.write_hb = mock.MagicMock(name="write_heartbeat")
        self.ensure_hb = mock.MagicMock(name="ensure_heartbeat_table")
        self.popen = mock.MagicMock(name="Popen")
        # A launched heavy proc that reports "still running" if ever polled.
        self.popen.return_value.poll.return_value = None

        patches = [
            mock.patch.object(si, "run_subprocess_with_heartbeat",
                              self.run_extract),
            mock.patch.object(si, "write_heartbeat", self.write_hb),
            mock.patch.object(si, "ensure_heartbeat_table", self.ensure_hb),
            mock.patch("subprocess.Popen", self.popen),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _run_once(self, conn, stop_event=None):
        """Run a single fabric_worker_loop iteration using `conn`."""
        if stop_event is None:
            stop_event = _OneShotStop()
        with mock.patch.object(si.psycopg2, "connect", return_value=conn):
            si.fabric_worker_loop(stop_event=stop_event)
        return conn

    # -- shared assertion helpers --------------------------------------------
    def _extract_cmds(self):
        """All extract commands the loop launched (fast via
        run_subprocess_with_heartbeat + heavy via Popen)."""
        cmds = [list(c.args[0]) for c in self.run_extract.call_args_list]
        cmds += [list(c.args[0]) for c in self.popen.call_args_list]
        return cmds


class FabricGatingTests(_FabricWorkerHarness):
    def test_recent_extract_is_gated_no_pull(self):
        # Non-empty DB, last pull 5s ago -> under the 60s rate-limit, so the
        # fast fabric extract must NOT run and _LAST_FABRIC_EXTRACT is untouched.
        recent = datetime.now(timezone.utc) - timedelta(seconds=5)
        si._LAST_FABRIC_EXTRACT = recent
        self._run_once(_FakeConn(empty=False))

        self.run_extract.assert_not_called()
        self.write_hb.assert_not_called()
        self.assertEqual(si._LAST_FABRIC_EXTRACT, recent)

    def test_stale_extract_triggers_fast_pull(self):
        # Non-empty DB, last pull 61s ago -> due, so a FAST (incremental) pull
        # runs and the timestamp advances.
        stale = datetime.now(timezone.utc) - timedelta(seconds=61)
        si._LAST_FABRIC_EXTRACT = stale
        self._run_once(_FakeConn(empty=False))

        self.run_extract.assert_called_once()
        cmd = self.run_extract.call_args.args[0]
        self.assertIn("extract_fabric.py", " ".join(cmd))
        self.assertEqual(cmd[cmd.index("--mode") + 1], "fast")
        # Fabric writes its OWN heartbeat table, never the watchdog's.
        self.write_hb.assert_called_once()
        self.assertEqual(self.write_hb.call_args.args[1], "fabric")
        self.assertEqual(self.write_hb.call_args.kwargs.get("heartbeat_table",
                         self.write_hb.call_args.kwargs.get("table")),
                         "fabric_heartbeat")
        self.assertGreater(si._LAST_FABRIC_EXTRACT, stale)


class FabricBootstrapTests(_FabricWorkerHarness):
    def test_empty_table_triggers_full_bootstrap(self):
        # Even with a recent _LAST_FABRIC_EXTRACT, an EMPTY table forces a run,
        # and the mode is a FULL bootstrap (populates every table on fresh prod).
        si._LAST_FABRIC_EXTRACT = datetime.now(timezone.utc)
        self._run_once(_FakeConn(empty=True))

        self.run_extract.assert_called_once()
        cmd = self.run_extract.call_args.args[0]
        self.assertEqual(cmd[cmd.index("--mode") + 1], "full")
        # A full bootstrap already pulled the heavy tables -> starts their slow
        # timer AND must NOT immediately launch the heavy extract.
        self.assertIsNotNone(si._LAST_FABRIC_HEAVY_EXTRACT)
        self.popen.assert_not_called()

    def test_missing_table_treated_as_empty(self):
        # to_regclass NULL (table absent on a fresh DB) => full bootstrap path.
        conn = self._run_once(_FakeConn(missing=True))
        self.run_extract.assert_called_once()
        cmd = self.run_extract.call_args.args[0]
        self.assertEqual(cmd[cmd.index("--mode") + 1], "full")
        # It never runs COUNT(*) once to_regclass reports the table is missing.
        self.assertFalse(any("count(*)" in s.lower() for s in conn.executed))


class FabricStopEventTests(_FabricWorkerHarness):
    def test_preset_stop_event_does_no_work(self):
        # A pre-set stop_event means the loop exits immediately: the body never
        # runs, so it never even opens a DB connection.
        connect = mock.MagicMock()
        with mock.patch.object(si.psycopg2, "connect", connect):
            ev = threading.Event()
            ev.set()
            si.fabric_worker_loop(stop_event=ev)
        connect.assert_not_called()
        self.run_extract.assert_not_called()

    def test_exits_promptly_without_sleeping_full_tick(self):
        # With a huge tick, the loop must still return quickly: the stop_event is
        # set mid-iteration and the end-of-loop wait() returns immediately rather
        # than sleeping FABRIC_WORKER_TICK_SEC.
        ev = threading.Event()
        self.run_extract.side_effect = lambda *a, **k: ev.set()
        with mock.patch.object(si, "FABRIC_WORKER_TICK_SEC", 9999):
            start = time.monotonic()
            self._run_once(_FakeConn(empty=True), stop_event=ev)
            elapsed = time.monotonic() - start
        self.assertLess(elapsed, 5.0)
        self.run_extract.assert_called_once()


class FabricMainBiUntouchedTests(_FabricWorkerHarness):
    def _assert_no_main_bi_writes(self, conn):
        for sql in conn.executed:
            low = sql.lower()
            self.assertNotIn("all_sales", low)
            self.assertNotIn("all_inventory", low)
        for cmd in self._extract_cmds():
            joined = " ".join(cmd)
            self.assertIn("extract_fabric.py", joined)
            self.assertNotIn("all_sales", joined)
            self.assertNotIn("transform_all_sales", joined)
        # Every heartbeat the worker writes goes to its OWN table, never the
        # watchdog's sync_heartbeat (which would mask a stalled main cycle).
        for call in self.write_hb.call_args_list:
            table = call.kwargs.get("table", call.kwargs.get("heartbeat_table"))
            self.assertEqual(table, "fabric_heartbeat")

    def test_fast_pull_never_writes_main_bi(self):
        si._LAST_FABRIC_EXTRACT = datetime.now(timezone.utc) - timedelta(seconds=61)
        conn = self._run_once(_FakeConn(empty=False))
        self.run_extract.assert_called_once()
        self._assert_no_main_bi_writes(conn)

    def test_heavy_pull_targets_only_fabric_extract(self):
        # Non-empty DB, heavy never run -> the heavy pull launches, and it too
        # only ever runs extract_fabric.py (--mode heavy), never a sales rebuild.
        si._LAST_FABRIC_EXTRACT = datetime.now(timezone.utc)   # gate the fast pull
        si._LAST_FABRIC_HEAVY_EXTRACT = None                    # heavy is due
        conn = self._run_once(_FakeConn(empty=False))
        self.popen.assert_called_once()
        hcmd = self.popen.call_args.args[0]
        self.assertIn("extract_fabric.py", " ".join(hcmd))
        self.assertEqual(hcmd[hcmd.index("--mode") + 1], "heavy")
        self._assert_no_main_bi_writes(conn)


class FabricWorkerWiringTests(unittest.TestCase):
    """Regression: the worker thread is started in the continuous loop path
    only, NOT the ``--once`` recovery path. Verified by static analysis of the
    module's ``if __name__ == '__main__'`` block so any re-coupling refactor
    (moving the thread start into the once branch, or dropping it) fails here."""

    def _main_block(self, tree):
        for node in tree.body:
            if isinstance(node, ast.If):
                t = node.test
                if (isinstance(t, ast.Compare)
                        and isinstance(t.left, ast.Name)
                        and t.left.id == "__name__"):
                    return node
        return None

    def _once_if(self, main_block):
        for node in ast.walk(main_block):
            if isinstance(node, ast.If):
                for sub in ast.walk(node.test):
                    if isinstance(sub, ast.Attribute) and sub.attr == "once" \
                            and isinstance(sub.value, ast.Name) \
                            and sub.value.id == "cli":
                        return node
        return None

    @staticmethod
    def _refs_worker(nodes):
        return any(
            isinstance(n, ast.Name) and n.id == "fabric_worker_loop"
            for stmt in nodes for n in ast.walk(stmt)
        )

    def test_worker_started_in_loop_path_not_once(self):
        with open(si.__file__, "r") as f:
            tree = ast.parse(f.read())

        main_block = self._main_block(tree)
        self.assertIsNotNone(main_block, "no `if __name__ == '__main__'` block")
        once_if = self._once_if(main_block)
        self.assertIsNotNone(once_if, "no `if cli.once:` branch found")

        # The --once (recovery) branch must NOT start the fabric worker.
        self.assertFalse(
            self._refs_worker(once_if.body),
            "fabric_worker_loop must NOT be started in the --once recovery path",
        )
        # The continuous-loop (else) branch MUST start it.
        self.assertTrue(
            self._refs_worker(once_if.orelse),
            "fabric_worker_loop must be started in the continuous loop path",
        )


class FabricLockSkipTests(_FabricWorkerHarness):
    """Exit-code-3 (advisory-lock skip) handling. A skipped extract refreshed
    NOTHING, so it must not look like a success: no fabric heartbeat (a fresh
    beat would hide real data staleness from the watchdog — the exact bug that
    left /fabric 15+ hours stale) and no 60s rate-limit stamp (the next ~20s
    tick must retry immediately, so the fast pull lands the moment the heavy
    run releases the lock). A REAL failure (rc=1) keeps the old behaviour:
    no heartbeat, but the stamp advances so a broken Odoo isn't hammered
    every 20s."""

    def test_lock_skip_writes_no_heartbeat_and_retries_next_tick(self):
        stale = datetime.now(timezone.utc) - timedelta(seconds=61)
        si._LAST_FABRIC_EXTRACT = stale
        self.run_extract.side_effect = subprocess.CalledProcessError(
            si.FABRIC_EXTRACT_EXIT_LOCK_SKIP, ["extract_fabric.py"])
        self._run_once(_FakeConn(empty=False))

        self.run_extract.assert_called_once()
        self.write_hb.assert_not_called()
        # Rate-limit stamp rolled back -> due again on the very next tick.
        self.assertEqual(si._LAST_FABRIC_EXTRACT, stale)

    def test_real_failure_keeps_rate_limit_and_no_heartbeat(self):
        stale = datetime.now(timezone.utc) - timedelta(seconds=61)
        si._LAST_FABRIC_EXTRACT = stale
        self.run_extract.side_effect = subprocess.CalledProcessError(
            1, ["extract_fabric.py"])
        self._run_once(_FakeConn(empty=False))

        self.run_extract.assert_called_once()
        self.write_hb.assert_not_called()
        # A real error keeps the advanced stamp: retry waits the normal ~60s.
        self.assertGreater(si._LAST_FABRIC_EXTRACT, stale)

    def test_exit_code_contract_pinned_on_both_sides(self):
        # The convention lives in extract_fabric.py's module header; the worker
        # (and watchdog) key off 3. Pin both sides so neither can drift alone.
        self.assertEqual(si.FABRIC_EXTRACT_EXIT_LOCK_SKIP, 3)
        path = os.path.join(os.path.dirname(os.path.abspath(si.__file__)),
                            "extract_fabric.py")
        with open(path, "r") as f:
            src = f.read()
        self.assertIn("EXIT_SKIPPED_LOCK = 3", src)
        self.assertIn("sys.exit(EXIT_SKIPPED_LOCK)", src)


# ─────────────────────────────────────────────────────────────────────────────
# Watchdog side of the same contract: check_fabric() gates on BOTH the
# heartbeat AND MAX(raw_fabric_products._loaded_at) — a fresh heartbeat with
# stale data (the lock-skip signature) is UNHEALTHY — and run_fabric_recovery()
# treats rc=3 as a non-success that feeds the escalation counter.
# ─────────────────────────────────────────────────────────────────────────────
class _WdFakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        s = " ".join(sql.split()).lower()
        c = self.conn
        if "to_regclass('public.fabric_heartbeat')" in s:
            c._last = ("fabric_heartbeat",) if c.hb_table else (None,)
        elif "to_regclass('public.raw_fabric_products')" in s:
            c._last = ("raw_fabric_products",) if c.data_table else (None,)
        elif "from fabric_heartbeat" in s:
            c._last = (c.hb_at,)
        elif "max(_loaded_at) from raw_fabric_products" in s:
            c._last = (c.data_at,)
        else:
            c._last = None

    def fetchone(self):
        return self.conn._last


class _WdFakeConn:
    def __init__(self, hb_at=None, data_at=None, hb_table=True, data_table=True):
        self.hb_at = hb_at
        self.data_at = data_at
        self.hb_table = hb_table
        self.data_table = data_table
        self._last = None

    def cursor(self):
        return _WdFakeCursor(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class WatchdogFabricDataGateTests(unittest.TestCase):
    def setUp(self):
        import watchdog as wd
        self.wd = wd
        orig = (wd._last_fabric_recovery, wd._fabric_recovery_failures)

        def _restore():
            wd._last_fabric_recovery, wd._fabric_recovery_failures = orig
        self.addCleanup(_restore)

    def _check(self, **kw):
        conn = _WdFakeConn(**kw)
        with mock.patch.object(self.wd, "_db", return_value=conn):
            return self.wd.check_fabric()

    def test_fresh_heartbeat_but_stale_data_is_unhealthy(self):
        # The lock-skip signature: worker loop alive (fresh beat) while
        # _loaded_at ages past the threshold. Must be UNHEALTHY, and the data
        # age must be reported so operators see the number the banner shows.
        now = datetime.now(timezone.utc)
        stale_naive = (now - timedelta(minutes=self.wd.FABRIC_FRESH_MIN + 60)
                       ).replace(tzinfo=None)  # naive UTC, like extract writes
        healthy, last_beat, hb_min, data_min = self._check(
            hb_at=now - timedelta(minutes=1), data_at=stale_naive)
        self.assertFalse(healthy)
        self.assertIsNotNone(hb_min)
        self.assertLessEqual(hb_min, self.wd.FABRIC_FRESH_MIN)
        self.assertIsNotNone(data_min)
        self.assertGreater(data_min, self.wd.FABRIC_FRESH_MIN)

    def test_both_fresh_is_healthy(self):
        now = datetime.now(timezone.utc)
        healthy, _, hb_min, data_min = self._check(
            hb_at=now - timedelta(minutes=1),
            data_at=(now - timedelta(minutes=2)).replace(tzinfo=None))
        self.assertTrue(healthy)
        self.assertIsNotNone(hb_min)
        self.assertIsNotNone(data_min)

    def test_missing_data_table_or_row_is_unhealthy(self):
        now = datetime.now(timezone.utc)
        healthy, _, _, data_min = self._check(
            hb_at=now - timedelta(minutes=1), data_table=False)
        self.assertFalse(healthy)
        self.assertIsNone(data_min)
        # Table present but MAX(_loaded_at) NULL (empty table) — same verdict.
        healthy, _, _, data_min = self._check(
            hb_at=now - timedelta(minutes=1), data_at=None)
        self.assertFalse(healthy)
        self.assertIsNone(data_min)

    def _run_recovery(self, returncode):
        fake_run = mock.MagicMock(
            return_value=mock.MagicMock(returncode=returncode))
        with mock.patch.object(self.wd.subprocess, "run", fake_run):
            result = self.wd.run_fabric_recovery(reason="test")
        return result, fake_run

    def test_recovery_lock_skip_counts_as_failure(self):
        self.wd._fabric_recovery_failures = 0
        result, fake_run = self._run_recovery(3)
        self.assertIn("SKIPPED", result)
        self.assertEqual(self.wd._fabric_recovery_failures, 1)
        # The one-shot rescue must use the raised (shared) timeout, not 120s.
        self.assertEqual(fake_run.call_args.kwargs["timeout"],
                         self.wd.FABRIC_EXTRACT_TIMEOUT_SEC)
        if "FABRIC_EXTRACT_TIMEOUT_SEC" not in os.environ:
            self.assertEqual(self.wd.FABRIC_EXTRACT_TIMEOUT_SEC, 300)
        self.assertIsNotNone(self.wd._last_fabric_recovery)  # cooldown stamped

    def test_recovery_success_resets_failure_counter(self):
        self.wd._fabric_recovery_failures = 2
        result, _ = self._run_recovery(0)
        self.assertIn("rc=0", result)
        self.assertEqual(self.wd._fabric_recovery_failures, 0)

    def test_recovery_real_failure_increments_counter(self):
        self.wd._fabric_recovery_failures = 1
        result, _ = self._run_recovery(1)
        self.assertIn("FAILED", result)
        self.assertEqual(self.wd._fabric_recovery_failures, 2)

    def test_escalation_wiring_present_in_health_loop(self):
        # Cheap source-level pin: the health loop must escalate prolonged data
        # staleness to a sync-process restart (re-spawning the fabric worker
        # thread), gated on the failure counter + the >6h data-age threshold.
        with open(self.wd.__file__, "r") as f:
            src = f.read()
        self.assertIn("restart:sync(fabric_escalation)", src)
        self.assertIn("FABRIC_ESCALATE_STALE_MIN", src)
        self.assertIn("FABRIC_ESCALATE_FAILURES", src)
        self.assertEqual(self.wd.FABRIC_ESCALATE_STALE_MIN, 360)
        self.assertEqual(self.wd.FABRIC_ESCALATE_FAILURES, 3)
        self.assertEqual(self.wd.FABRIC_DATA_CRITICAL_MIN, 240)


if __name__ == "__main__":
    unittest.main()
