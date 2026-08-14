"""Per-source sales staleness + durable pull-failure trail.

Pins the two halves of the silent-outage watch (born from the 13-Aug-2026
Odoo permission loss that froze Kenya sales 19+ hours behind green badges):

1. sync_source_health — the pure classifier /api/sync-status uses:
   * staleness accrues ONLY inside each source's EAT trading window, so an
     overnight/pre-open freeze is never "stale" (no false alarms while a
     store is merely closed);
   * a multi-hour freeze during trading hours IS stale, warning→critical;
   * long wall-clock freezes escalate to critical the moment the trading
     budget is burned (a 17h-old feed must be red, not amber, at 11am);
   * the retired `vivowoman` store is not in the registry and never alarms.

2. sync_incremental.record_source_failure/success — the durable trail in
   sync_health_log: first failure writes a row, a 60s retry loop cannot
   flood (re-log at most hourly), and the failing→ok transition writes one
   `source_recovered` row. Helpers never raise (health bookkeeping must not
   break the sync loop).
"""

import unittest
from datetime import datetime, timedelta, timezone

import sync_source_health as ssh
import sync_incremental as si


def utc(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)


def _kenya():
    return next(c for c in ssh.SOURCES if c["store_id"] == "vivofashiongroup")


class RegistryTests(unittest.TestCase):
    def test_active_sources_registered_vivowoman_excluded(self):
        ids = {c["store_id"] for c in ssh.SOURCES}
        self.assertEqual(
            ids, {"vivofashiongroup", "vivo-uganda", "vivo-rwanda", "shop-zetu"}
        )
        self.assertNotIn("vivowoman", ids)

    def test_registry_covers_every_synced_sales_source(self):
        # Lockstep guard: if someone adds a store to the sync loop without
        # registering it here, it would be invisible to the staleness watch —
        # exactly the silent-outage class this module exists to prevent.
        registered = {c["store_id"] for c in ssh.SOURCES}
        for store in si.STORES:
            sid = store["store_id"] if isinstance(store, dict) else store
            if sid == "vivowoman":  # retired July 2026, frozen by design
                continue
            self.assertIn(sid, registered)
        self.assertIn("vivofashiongroup", registered)  # Kenya Odoo
        self.assertIn("shop-zetu", registered)  # ShopifyQL online

    def test_thresholds_meet_task_contract(self):
        # The dominant market must degrade within ~2h of trading silence.
        self.assertLessEqual(_kenya()["warn_trading_min"], 120)
        for c in ssh.SOURCES:
            self.assertLess(c["warn_trading_min"], c["crit_trading_min"])
            self.assertLess(c["open_min"], c["close_min"])


class TradingMinutesTests(unittest.TestCase):
    """Kenya window: 09:30–20:30 EAT == 06:30–17:30 UTC (EAT = UTC+3)."""

    def _tm(self, a, b):
        k = _kenya()
        return ssh.trading_minutes_between(a, b, k["open_min"], k["close_min"])

    def test_overnight_gap_accrues_nothing(self):
        # 21:30 EAT → 08:00 EAT next day: entirely outside the window.
        self.assertEqual(self._tm(utc(2026, 8, 13, 18, 30), utc(2026, 8, 14, 5, 0)), 0.0)

    def test_gap_spanning_close_and_open_counts_both_tails(self):
        # 20:20 EAT → 09:45 EAT next day = 10 min before close + 15 after open.
        self.assertAlmostEqual(
            self._tm(utc(2026, 8, 13, 17, 20), utc(2026, 8, 14, 6, 45)), 25.0
        )

    def test_multi_day_gap_counts_full_windows(self):
        # Close Mon 10-Aug → open Thu 13-Aug: Tue + Wed = 2 × 660 min.
        self.assertAlmostEqual(
            self._tm(utc(2026, 8, 10, 17, 30), utc(2026, 8, 13, 6, 30)), 1320.0
        )

    def test_naive_datetimes_treated_as_utc(self):
        # all_sales.loaded_at is naive-UTC; must match the aware result.
        aware = self._tm(utc(2026, 8, 14, 7, 0), utc(2026, 8, 14, 9, 5))
        naive = self._tm(
            datetime(2026, 8, 14, 7, 0), datetime(2026, 8, 14, 9, 5)
        )
        self.assertAlmostEqual(aware, naive)
        self.assertAlmostEqual(aware, 125.0)


class ClassifierTests(unittest.TestCase):
    def test_fresh_during_trading_is_ok(self):
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 14, 9, 58), utc(2026, 8, 14, 10, 0)
        )
        self.assertEqual(out["status"], "ok")
        self.assertIsNone(out["severity"])

    def test_overnight_closure_is_not_stale(self):
        # Last rows at 21:30 EAT, checked 08:00 EAT next morning (10.5h wall):
        # a merely-closed store must stay green.
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 13, 18, 30), utc(2026, 8, 14, 5, 0)
        )
        self.assertEqual(out["status"], "ok")

    def test_pre_open_morning_is_not_stale(self):
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 13, 17, 20), utc(2026, 8, 14, 6, 45)
        )
        self.assertEqual(out["status"], "ok")

    def test_daytime_freeze_warns_within_two_hours(self):
        # Frozen 10:00→12:05 EAT (125 trading-min): stale, but young enough
        # wall-clock to be warning, not critical.
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 14, 7, 0), utc(2026, 8, 14, 9, 5)
        )
        self.assertEqual(out["status"], "stale")
        self.assertEqual(out["severity"], "warning")

    def test_the_13_aug_incident_is_critical(self):
        # The real outage: frozen 13-Aug 20:10 EAT, checked 14-Aug 13:07 EAT.
        # ~237 trading-min burned + ~17h wall age → critical, labeled "17h".
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 13, 17, 10, 25), utc(2026, 8, 14, 10, 7)
        )
        self.assertEqual(out["status"], "stale")
        self.assertEqual(out["severity"], "critical")
        self.assertEqual(out["age_label"], "17h")
        self.assertEqual(out["last_loaded_eat"], "13 Aug 20:10")

    def test_same_day_burn_hits_critical_via_trading_budget(self):
        # Frozen at open 09:30 EAT, checked 14:35 EAT = 305 trading-min ≥ 300,
        # while wall age (~5h) is below the 12h escalator.
        out = ssh.classify_source(
            _kenya(), utc(2026, 8, 14, 6, 30), utc(2026, 8, 14, 11, 35)
        )
        self.assertEqual(out["severity"], "critical")

    def test_missing_store_is_informational_no_data(self):
        # Absent from all_sales entirely = bootstrapping DB, not an outage.
        out = ssh.classify_source(_kenya(), None, utc(2026, 8, 14, 10, 0))
        self.assertEqual(out["status"], "no_data")
        self.assertIsNone(out["severity"])


class EvaluateTests(unittest.TestCase):
    NOW = utc(2026, 8, 14, 10, 7)  # 13:07 EAT — inside every trading window

    def _fresh_map(self):
        return {c["store_id"]: self.NOW - timedelta(minutes=2) for c in ssh.SOURCES}

    def test_all_fresh_is_ok_with_no_summary(self):
        out = ssh.evaluate_sources(self._fresh_map(), self.NOW)
        self.assertEqual(out["sources_health"], "OK")
        self.assertFalse(out["sources_stale"])
        self.assertIsNone(out["stale_summary"])
        self.assertEqual(len(out["sources"]), len(ssh.SOURCES))

    def test_vivowoman_in_input_is_ignored(self):
        m = self._fresh_map()
        m["vivowoman"] = self.NOW - timedelta(days=30)  # retired since July
        out = ssh.evaluate_sources(m, self.NOW)
        self.assertFalse(out["sources_stale"])
        self.assertNotIn(
            "vivowoman", {s["store_id"] for s in out["sources"]}
        )

    def test_stale_kenya_names_worst_offender(self):
        m = self._fresh_map()
        m["vivofashiongroup"] = utc(2026, 8, 13, 17, 10, 25)
        out = ssh.evaluate_sources(m, self.NOW)
        self.assertTrue(out["sources_stale"])
        self.assertEqual(out["sources_health"], "CRITICAL")
        self.assertEqual(out["stale_summary"], "Kenya feed 17h stale")

    def test_multiple_stale_sources_counted(self):
        m = self._fresh_map()
        m["vivofashiongroup"] = utc(2026, 8, 13, 17, 10, 25)  # critical, 17h
        m["vivo-rwanda"] = utc(2026, 8, 14, 3, 0)  # 187 trading-min → warning
        out = ssh.evaluate_sources(m, self.NOW)
        self.assertEqual(out["sources_health"], "CRITICAL")
        self.assertEqual(out["stale_summary"], "Kenya feed 17h stale +1 more")
        rw = next(s for s in out["sources"] if s["store_id"] == "vivo-rwanda")
        self.assertEqual(rw["severity"], "warning")


# ── Durable failure trail (sync_incremental helpers) ─────────────────────────


class _FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        if self.conn.raise_on_execute:
            raise RuntimeError("db down")
        self.conn.executed.append((" ".join(sql.split()), params))


class _FakeConn:
    def __init__(self):
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self.raise_on_execute = False

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class FailureTrailTests(unittest.TestCase):
    T0 = utc(2026, 8, 13, 17, 11)

    def setUp(self):
        self._state = dict(si._SOURCE_FAIL_STATE)
        self._ready = si._HEALTH_LOG_SOURCE_COLS_READY
        si._SOURCE_FAIL_STATE.clear()
        si._HEALTH_LOG_SOURCE_COLS_READY = True  # skip DDL noise in asserts
        self.addCleanup(self._restore)

    def _restore(self):
        si._SOURCE_FAIL_STATE.clear()
        si._SOURCE_FAIL_STATE.update(self._state)
        si._HEALTH_LOG_SOURCE_COLS_READY = self._ready

    @staticmethod
    def _inserts(conn, action):
        return [
            (sql, params)
            for sql, params in conn.executed
            if "INSERT INTO sync_health_log" in sql and action in sql
        ]

    def test_first_failure_writes_source_and_error(self):
        conn = _FakeConn()
        err = RuntimeError(
            "Fault 4: not allowed to access 'Point of Sale Order Lines'"
        )
        wrote = si.record_source_failure(conn, "vivofashiongroup", err, now=self.T0)
        self.assertTrue(wrote)
        rows = self._inserts(conn, "source_failure")
        self.assertEqual(len(rows), 1)
        _, params = rows[0]
        self.assertIn("vivofashiongroup", params)
        self.assertTrue(any("Fault 4" in str(p) for p in params))
        self.assertEqual(conn.commits, 1)

    def test_sixty_second_retry_loop_cannot_flood(self):
        # The sales worker retries every ~60s; only the transition row lands,
        # then at most one row per SOURCE_FAILURE_RELOG_SEC.
        conn = _FakeConn()
        for i in range(50):
            si.record_source_failure(
                conn, "vivofashiongroup", RuntimeError("Fault 4"),
                now=self.T0 + timedelta(seconds=60 * i),
            )
        self.assertEqual(len(self._inserts(conn, "source_failure")), 1)

    def test_relogs_after_the_rate_limit_interval(self):
        conn = _FakeConn()
        si.record_source_failure(conn, "shop-zetu", RuntimeError("boom"), now=self.T0)
        si.record_source_failure(
            conn, "shop-zetu", RuntimeError("boom"),
            now=self.T0 + timedelta(seconds=si.SOURCE_FAILURE_RELOG_SEC + 1),
        )
        rows = self._inserts(conn, "source_failure")
        self.assertEqual(len(rows), 2)
        # The re-log row carries the running failure count for triage.
        self.assertIn("still failing", str(rows[1][1]))

    def test_recovery_writes_once_on_transition_only(self):
        conn = _FakeConn()
        si.record_source_failure(conn, "vivo-uganda", RuntimeError("x"), now=self.T0)
        si.record_source_success(conn, "vivo-uganda", now=self.T0 + timedelta(hours=2))
        si.record_source_success(conn, "vivo-uganda", now=self.T0 + timedelta(hours=3))
        rows = self._inserts(conn, "source_recovered")
        self.assertEqual(len(rows), 1)
        self.assertIn("vivo-uganda", rows[0][1])

    def test_success_without_prior_failure_is_a_noop(self):
        conn = _FakeConn()
        self.assertFalse(si.record_source_success(conn, "vivo-rwanda"))
        self.assertEqual(conn.executed, [])
        self.assertEqual(conn.commits, 0)

    def test_new_incident_after_recovery_logs_again(self):
        conn = _FakeConn()
        si.record_source_failure(conn, "shop-zetu", RuntimeError("a"), now=self.T0)
        si.record_source_success(conn, "shop-zetu", now=self.T0 + timedelta(hours=1))
        si.record_source_failure(
            conn, "shop-zetu", RuntimeError("b"), now=self.T0 + timedelta(hours=1, minutes=5)
        )
        self.assertEqual(len(self._inserts(conn, "source_failure")), 2)

    def test_helpers_never_raise_when_db_is_down(self):
        conn = _FakeConn()
        conn.raise_on_execute = True
        self.assertFalse(
            si.record_source_failure(conn, "vivofashiongroup", RuntimeError("x"))
        )
        self.assertGreaterEqual(conn.rollbacks, 1)
        # State still flipped → a later success records the recovery attempt.
        conn2 = _FakeConn()
        self.assertTrue(si.record_source_success(conn2, "vivofashiongroup"))


# ── API disclosure contract ──────────────────────────────────────────────────


class ApiContractTests(unittest.TestCase):
    """/api/sync-status is on the public auth allowlist, so it must expose
    ONLY timestamps and health flags. The failure trail carries raw upstream
    error text (e.g. Odoo fault messages) and therefore lives behind the
    blanket /api/admin middleware gate instead."""

    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import api_pg

        # No context manager: startup (deferred-init) hooks must not run.
        cls.client = TestClient(api_pg.app)

    def test_public_sync_status_keeps_staleness_but_no_error_text(self):
        r = self.client.get("/api/sync-status")
        self.assertEqual(r.status_code, 200)
        d = r.json()
        for key in ("sources", "sources_stale", "sources_health", "stale_summary"):
            self.assertIn(key, d)
        self.assertNotIn("source_failures", d)
        for s in d["sources"]:
            self.assertNotIn("error", s)

    def test_failure_trail_endpoint_requires_admin_auth(self):
        r = self.client.get("/api/admin/source-failures")
        self.assertIn(r.status_code, (401, 403))

    def test_failure_trail_handler_returns_rows_shape(self):
        # Auth lives in middleware, so calling the handler directly exercises
        # the body (the DB path an unauth 401 never reaches).
        import api_pg

        out = api_pg.admin_source_failures()
        self.assertIn("failures", out)
        self.assertIsInstance(out["failures"], list)
        for row in out["failures"]:
            self.assertIn("source", row)
            self.assertIn("action", row)


if __name__ == "__main__":
    unittest.main()
