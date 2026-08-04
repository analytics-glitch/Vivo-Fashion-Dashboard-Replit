"""Behavioural tests pinning the dedicated sales fast-path worker.

Sales pulls used to land in ``all_sales`` only once per FULL ``main()`` cycle,
and that cycle has grown from the original ~1 min design to 45-90 min (Shop
Zetu inventory matching alone can run ~20 min), so dashboard sales sat up to
~1.5 h behind the tills. ``sales_worker_loop`` moved the CHEAP sales pulls
(Shopify country stores + Odoo POS, ~5-30 s total) onto their OWN ~60s
daemon-thread timer with a short sliding watermark window, while the main
cycle keeps its wide multi-day self-healing anchors.

These tests lock that behaviour in so a future refactor can't silently
re-couple sales freshness to the slow cycle (or drop the worker/lock) without
a test failing. They exercise the REAL ``sales_worker_loop`` against a fake DB
connection and stubbed pull functions (no live Postgres, no Shopify/Odoo
calls), asserting:

* each tick pulls every Shopify store AND Odoo with a sliding
  ``since_override`` ≈ now − SALES_WORKER_WINDOW_MIN (correct format per API);
* Shop Zetu's heavier ShopifyQL subprocess is gated to its own slower cadence;
* the worker SKIPS its tick (and releases nothing) when the main cycle holds
  ``_SALES_SYNC_LOCK`` — and never steals/releases a lock it didn't acquire;
* per-source failures roll back and the loop survives; connection errors drop
  the conn for rebuild on the next tick;
* the heartbeat goes to the worker's OWN ``sales_heartbeat`` table, never the
  watchdog's ``sync_heartbeat`` (which would mask a stalled main cycle);
* ``since_override`` on ``process_shopify_store`` / ``sync_odoo`` bypasses the
  wide anchors AND the ODOO_SYNC_SINCE/UNTIL repair env knobs (those stay
  main-cycle-only); and
* (regression, static) ``main()``'s sales phase runs under the lock, and the
  worker thread starts in the continuous loop path only — never ``--once``.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_sales_worker_loop
"""
import ast
import threading
import time
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

import sync_incremental as si


# ─────────────────────────────────────────────────────────────────────────────
# Fakes (same shape as test_fabric_worker_loop): a minimal stand-in for the
# worker's dedicated psycopg2 connection. All pull functions are mocked, so the
# cursor only needs to be a context manager that records SQL.
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
        if "least(max(loaded_at" in s:
            # sync_odoo's coverage-anchor query (control case only).
            from datetime import date

            self.conn._last = (date(2026, 8, 1),)
        else:
            self.conn._last = None

    def fetchone(self):
        return self.conn._last


class _FakeConn:
    def __init__(self):
        self.executed = []
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
    the body runs, then the end-of-iteration ``stop_event.wait(tick)`` sets the
    flag and returns True immediately -> the loop breaks without sleeping."""

    def wait(self, timeout=None):
        self.set()
        return True


class _SalesWorkerHarness(unittest.TestCase):
    """Common patching + a helper that runs ONE loop iteration."""

    def setUp(self):
        self._orig_sz_stamp = si._LAST_SALES_WORKER_SZ
        si._LAST_SALES_WORKER_SZ = None
        self.addCleanup(
            lambda: setattr(si, "_LAST_SALES_WORKER_SZ", self._orig_sz_stamp)
        )

        self.pull_store = mock.MagicMock(name="process_shopify_store")
        self.pull_odoo = mock.MagicMock(name="sync_odoo")
        self.rates = mock.MagicMock(name="get_exchange_rates",
                                    return_value={"Kenya": 1.0})
        self.write_hb = mock.MagicMock(name="write_heartbeat")
        self.ensure_hb = mock.MagicMock(name="ensure_heartbeat_table")
        self.sz_run = mock.MagicMock(name="subprocess.run")

        patches = [
            mock.patch.object(si, "process_shopify_store", self.pull_store),
            mock.patch.object(si, "sync_odoo", self.pull_odoo),
            mock.patch.object(si, "get_exchange_rates", self.rates),
            mock.patch.object(si, "write_heartbeat", self.write_hb),
            mock.patch.object(si, "ensure_heartbeat_table", self.ensure_hb),
            mock.patch("subprocess.run", self.sz_run),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _run_once(self, conn, stop_event=None):
        if stop_event is None:
            stop_event = _OneShotStop()
        with mock.patch.object(si.psycopg2, "connect", return_value=conn):
            si.sales_worker_loop(stop_event=stop_event)
        return conn


class SalesTickTests(_SalesWorkerHarness):
    def test_tick_pulls_all_sources_with_sliding_window(self):
        before = datetime.now(timezone.utc)
        conn = self._run_once(_FakeConn())
        after = datetime.now(timezone.utc)

        # Every Shopify country store pulled once, each with a sliding
        # since_override in Shopify ISO-Z format ≈ now − window.
        self.assertEqual(self.pull_store.call_count, len(si.STORES))
        pulled_ids = {c.args[0]["store_id"] for c in self.pull_store.call_args_list}
        self.assertEqual(pulled_ids, {s["store_id"] for s in si.STORES})
        lo = before - timedelta(minutes=si.SALES_WORKER_WINDOW_MIN, seconds=90)
        hi = after - timedelta(minutes=si.SALES_WORKER_WINDOW_MIN) + timedelta(seconds=90)
        for call in self.pull_store.call_args_list:
            since = call.kwargs["since_override"]
            parsed = datetime.strptime(since, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
            self.assertTrue(lo <= parsed <= hi, f"bad shopify window: {since}")

        # Odoo pulled once with the same window in Odoo's naive-UTC format.
        self.pull_odoo.assert_called_once()
        osince = self.pull_odoo.call_args.kwargs["since_override"]
        oparsed = datetime.strptime(osince, "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
        self.assertTrue(lo <= oparsed <= hi, f"bad odoo window: {osince}")

        # Shop Zetu due on the very first tick (no stamp yet): the ShopifyQL
        # subprocess runs with a hard timeout so a hung walk can't wedge us.
        self.sz_run.assert_called_once()
        cmd = " ".join(self.sz_run.call_args.args[0])
        self.assertIn("extract_shopzetu_shopifyql.py", cmd)
        self.assertEqual(
            self.sz_run.call_args.kwargs.get("timeout"),
            si.SALES_WORKER_SZ_TIMEOUT_SEC,
        )
        self.assertIsNotNone(si._LAST_SALES_WORKER_SZ)

        # Per-phase commits (stores + odoo), no rollbacks on the happy path.
        self.assertGreaterEqual(conn.commits, 2)
        self.assertEqual(conn.rollbacks, 0)

        # Heartbeat: the worker's OWN table, NEVER the watchdog's
        # sync_heartbeat (an independent beat must not hide a stalled cycle).
        self.ensure_hb.assert_called_once_with(conn, "sales_heartbeat")
        self.write_hb.assert_called_once()
        self.assertEqual(self.write_hb.call_args.args[1], "sales")
        self.assertEqual(self.write_hb.call_args.kwargs.get("table"),
                         "sales_heartbeat")

    def test_shopzetu_gated_to_slower_cadence(self):
        # A fresh stamp (< interval) must gate the subprocess entirely while
        # the cheap in-process pulls still run every tick.
        si._LAST_SALES_WORKER_SZ = datetime.now(timezone.utc)
        self._run_once(_FakeConn())
        self.sz_run.assert_not_called()
        self.assertEqual(self.pull_store.call_count, len(si.STORES))
        self.pull_odoo.assert_called_once()

        # A stale stamp (> interval) makes it due again.
        si._LAST_SALES_WORKER_SZ = datetime.now(timezone.utc) - timedelta(
            seconds=si.SALES_WORKER_SZ_INTERVAL_SEC + 5
        )
        self._run_once(_FakeConn())
        self.sz_run.assert_called_once()

    def test_heartbeat_allowlist_contains_sales(self):
        # ensure_heartbeat_table/write_heartbeat assert membership in
        # _HEARTBEAT_TABLES; the worker's table must stay allowlisted.
        self.assertIn("sales_heartbeat", si._HEARTBEAT_TABLES)


class SalesLockTests(_SalesWorkerHarness):
    def test_tick_skipped_when_main_cycle_holds_lock(self):
        # Simulate main()'s sales phase holding the lock: the worker must do
        # NOTHING this tick (no pulls, no heartbeat) and must NOT release a
        # lock it never acquired.
        si._SALES_SYNC_LOCK.acquire()
        self.addCleanup(
            lambda: si._SALES_SYNC_LOCK.locked() and si._SALES_SYNC_LOCK.release()
        )
        self._run_once(_FakeConn())

        self.pull_store.assert_not_called()
        self.pull_odoo.assert_not_called()
        self.sz_run.assert_not_called()
        self.write_hb.assert_not_called()
        # Still held by the test — the worker didn't steal/release it.
        self.assertTrue(si._SALES_SYNC_LOCK.locked())

    def test_lock_released_after_normal_tick(self):
        self._run_once(_FakeConn())
        self.assertFalse(si._SALES_SYNC_LOCK.locked())
        # And a follow-up tick can acquire it again (no leak).
        self._run_once(_FakeConn())
        self.assertEqual(self.pull_odoo.call_count, 2)
        self.assertFalse(si._SALES_SYNC_LOCK.locked())


class SalesResilienceTests(_SalesWorkerHarness):
    def test_per_source_failure_rolls_back_and_survives(self):
        # Every pull blows up -> each failure rolls back, the loop finishes the
        # tick, still writes its own heartbeat (beat = worker alive, not
        # all-sources-green), and the lock is released.
        self.pull_store.side_effect = RuntimeError("shopify down")
        self.pull_odoo.side_effect = RuntimeError("odoo down")
        conn = self._run_once(_FakeConn())

        self.assertEqual(conn.rollbacks, len(si.STORES) + 1)
        self.assertFalse(conn.closed)
        self.write_hb.assert_called_once()
        self.assertFalse(si._SALES_SYNC_LOCK.locked())

    def test_connection_error_drops_conn_for_rebuild(self):
        # An error outside the per-source guards (e.g. rates query on a dead
        # conn) must close/drop the connection so the next tick rebuilds it —
        # and must still release the lock.
        self.rates.side_effect = RuntimeError("conn dead")
        conn = self._run_once(_FakeConn())

        self.assertTrue(conn.closed)
        self.write_hb.assert_not_called()
        self.assertFalse(si._SALES_SYNC_LOCK.locked())

    def test_preset_stop_event_does_no_work(self):
        connect = mock.MagicMock()
        with mock.patch.object(si.psycopg2, "connect", connect):
            ev = threading.Event()
            ev.set()
            si.sales_worker_loop(stop_event=ev)
        connect.assert_not_called()
        self.pull_store.assert_not_called()

    def test_exits_promptly_without_sleeping_full_tick(self):
        ev = threading.Event()
        self.pull_odoo.side_effect = lambda *a, **k: ev.set()
        with mock.patch.object(si, "SALES_WORKER_TICK_SEC", 9999):
            start = time.monotonic()
            self._run_once(_FakeConn(), stop_event=ev)
            elapsed = time.monotonic() - start
        self.assertLess(elapsed, 5.0)
        self.pull_odoo.assert_called_once()


class SinceOverrideContractTests(unittest.TestCase):
    """The trailing since_override kwargs are the worker's ONLY hook — pin that
    they bypass the wide anchors (and Odoo's repair env knobs) exactly."""

    def test_shopify_override_bypasses_watermark_anchor(self):
        fake_last = mock.MagicMock(name="get_last_sync",
                                   return_value="2026-08-01T00:00:00Z")
        fake_fetch = mock.MagicMock(name="fetch_orders", return_value=[])
        conn = _FakeConn()
        store = dict(si.STORES[0])
        now = datetime.now(timezone.utc)

        with mock.patch.object(si, "get_last_sync", fake_last), \
                mock.patch.object(si, "fetch_orders", fake_fetch):
            # With an override: the anchor helper must NOT run, and the pull
            # must use the override verbatim.
            si.process_shopify_store(store, conn.cursor(), now, {"Kenya": 1.0},
                                     since_override="2026-08-04T10:00:00Z")
            fake_last.assert_not_called()
            self.assertIn("2026-08-04T10:00:00Z",
                          repr(fake_fetch.call_args_list))

            # Without it (main cycle): the anchor helper is the source.
            fake_fetch.reset_mock()
            si.process_shopify_store(store, conn.cursor(), now, {"Kenya": 1.0})
            fake_last.assert_called_once()
            self.assertIn("2026-08-01T00:00:00Z",
                          repr(fake_fetch.call_args_list))

    def test_odoo_override_skips_anchor_and_repair_env(self):
        sp = mock.MagicMock(name="ServerProxy")
        sp.return_value.authenticate.return_value = 7
        sp.return_value.execute_kw.return_value = []  # zero orders -> early out
        conn = _FakeConn()
        now = datetime.now(timezone.utc)

        env = {"ODOO_SYNC_SINCE": "1999-01-01 00:00:00"}
        with mock.patch("xmlrpc.client.ServerProxy", sp), \
                mock.patch.dict("os.environ", env):
            si.sync_odoo(conn.cursor(), now, {"Kenya": 1.0},
                         since_override="2026-08-04 10:00:00")

        # Anchor query skipped entirely...
        self.assertFalse(
            any("least(max(loaded_at" in " ".join(s.split()).lower()
                for s in conn.executed),
            "override must skip the coverage-anchor query",
        )
        # ...the RPC window uses the override, and the repair env knob is
        # ignored (it stays a main-cycle-only tool).
        calls = repr(sp.return_value.execute_kw.call_args_list)
        self.assertIn("2026-08-04 10:00:00", calls)
        self.assertNotIn("1999-01-01", calls)

    def test_odoo_default_path_still_uses_anchor(self):
        sp = mock.MagicMock(name="ServerProxy")
        sp.return_value.authenticate.return_value = 7
        sp.return_value.execute_kw.return_value = []
        conn = _FakeConn()
        now = datetime.now(timezone.utc)

        with mock.patch("xmlrpc.client.ServerProxy", sp):
            si.sync_odoo(conn.cursor(), now, {"Kenya": 1.0})

        self.assertTrue(
            any("least(max(loaded_at" in " ".join(s.split()).lower()
                for s in conn.executed),
            "main-cycle path must keep the coverage-anchor query",
        )


class SalesWorkerWiringTests(unittest.TestCase):
    """Static regressions on sync_incremental's structure."""

    @classmethod
    def setUpClass(cls):
        with open(si.__file__, "r") as f:
            cls.tree = ast.parse(f.read())

    # -- helpers (same approach as the fabric wiring test) --------------------
    def _main_guard(self):
        for node in self.tree.body:
            if isinstance(node, ast.If):
                t = node.test
                if (isinstance(t, ast.Compare)
                        and isinstance(t.left, ast.Name)
                        and t.left.id == "__name__"):
                    return node
        return None

    def _once_if(self, main_guard):
        for node in ast.walk(main_guard):
            if isinstance(node, ast.If):
                for sub in ast.walk(node.test):
                    if isinstance(sub, ast.Attribute) and sub.attr == "once" \
                            and isinstance(sub.value, ast.Name) \
                            and sub.value.id == "cli":
                        return node
        return None

    @staticmethod
    def _refs(nodes, name):
        return any(
            isinstance(n, ast.Name) and n.id == name
            for stmt in nodes for n in ast.walk(stmt)
        )

    def test_worker_started_in_loop_path_not_once(self):
        guard = self._main_guard()
        self.assertIsNotNone(guard)
        once_if = self._once_if(guard)
        self.assertIsNotNone(once_if)

        # --once (recovery) must NOT spawn a competing sales worker.
        self.assertFalse(
            self._refs(once_if.body, "sales_worker_loop"),
            "sales_worker_loop must NOT start in the --once recovery path",
        )
        # The continuous path MUST start it, behind the env kill-switch.
        self.assertTrue(
            self._refs(once_if.orelse, "sales_worker_loop"),
            "sales_worker_loop must start in the continuous loop path",
        )
        gated = False
        for stmt in once_if.orelse:
            for node in ast.walk(stmt):
                if isinstance(node, ast.If) and self._refs(
                        [node.test], "SALES_WORKER_ENABLED"):
                    if self._refs(node.body, "sales_worker_loop"):
                        gated = True
        self.assertTrue(
            gated,
            "sales worker start must be gated on SALES_WORKER_ENABLED",
        )

    def test_main_sales_phase_runs_under_the_lock(self):
        # Every process_shopify_store / sync_odoo call inside main() must sit
        # under `with _SALES_SYNC_LOCK:` — otherwise a worker tick can
        # interleave with the cycle's DELETE+INSERT on the same orders.
        main_def = next(
            (n for n in self.tree.body
             if isinstance(n, ast.FunctionDef) and n.name == "main"),
            None,
        )
        self.assertIsNotNone(main_def, "main() not found")

        def _str_consts(call):
            return [s.value for s in ast.walk(call)
                    if isinstance(s, ast.Constant) and isinstance(s.value, str)]

        def _sales_calls(root):
            """(lineno, tag) of every LIVE-window sales write inside `root`:
            the two pull functions plus any Shop Zetu ShopifyQL launch pulling
            the recent default window. Historical repairs bounded strictly into
            the past with an explicit ``--until`` (e.g. the one-time
            customer_id backfill, until = today-10d) can never overlap the
            worker's recent window and are exempt from the lock."""
            found = set()
            for node in ast.walk(root):
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name) and node.func.id in (
                        "process_shopify_store", "sync_odoo"):
                    found.add((node.lineno, node.func.id))
                    continue
                consts = _str_consts(node)
                if any("extract_shopzetu_shopifyql" in c for c in consts) \
                        and "--until" not in consts:
                    found.add((node.lineno, "shopzetu_subprocess"))
            return found

        all_calls = _sales_calls(main_def)
        locked_calls = set()
        locked_sz_nodes = []
        for node in ast.walk(main_def):
            if isinstance(node, ast.With):
                held = any(
                    isinstance(item.context_expr, ast.Name)
                    and item.context_expr.id == "_SALES_SYNC_LOCK"
                    for item in node.items
                )
                if held:
                    locked_calls |= _sales_calls(node)
                    for sub in ast.walk(node):
                        if isinstance(sub, ast.Call) and any(
                                "extract_shopzetu_shopifyql" in c
                                for c in _str_consts(sub)):
                            locked_sz_nodes.append(sub)

        self.assertTrue(all_calls, "main() no longer calls the sales pulls?")
        self.assertEqual(
            all_calls, locked_calls,
            "live-window sales pulls in main() (incl. the default-window Shop "
            "Zetu subprocess) must ALL run under _SALES_SYNC_LOCK",
        )
        # And any Shop Zetu subprocess launched WHILE HOLDING the lock must be
        # time-bounded — a hung API walk holding the lock would stall the
        # per-minute worker until someone notices.
        self.assertTrue(locked_sz_nodes,
                        "main() lost its in-cycle Shop Zetu pull?")
        for call in locked_sz_nodes:
            self.assertTrue(
                any(kw.arg == "timeout" for kw in call.keywords),
                "a lock-held Shop Zetu subprocess in main() must set a timeout",
            )


if __name__ == "__main__":
    unittest.main()
