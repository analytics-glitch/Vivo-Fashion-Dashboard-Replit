"""Merch Hub cold-start timing regression tests.

Confirms the prewarm-then-serve contract that makes the first post-restart
/api/merch/styles request take seconds, not 15–30 s:

  1. The real api_pg._start_cache_prewarmer function contains a "merch-core"
     target that calls merch_router._styles_cached, and emits the
     "Cache prewarm cycle done" completion message — verified by inspecting
     the actual prewarmer source, not a hand-constructed stand-in.

  2. The prewarmer call (_styles_cached with all-None filters) populates the
     core cache so subsequent requests skip the heavy SQL.

  3. A pre-warmed request to _fetch_styles_core_cached returns in < 50 ms
     regardless of how long the cold SQL took (constant-time warm path).
     This is the key SLA mechanism: if the cold SQL takes 8 s the prewarm
     absorbs it; the first user pays only the warm-path overhead.

  4. A cold _fetch_styles_core_cached call (no prior prewarm) runs the SQL
     exactly once, even under concurrent load (single-flight lock).

No database access — _fetch_styles_core_sql is monkeypatched throughout.
"""

import inspect
import threading
import time
import unittest
from unittest import mock

import api_pg
import merch_router


# ── Test data ─────────────────────────────────────────────────────────────────

_FAKE_ROW = {
    "style_name": "Test Dress",
    "style_number": "TD001",
    "brand": "Vivo",
    "subcategory": "Dresses",
    "category": "Clothing",
    "status": "active",
    "has_any_retired_sku": False,
    "launch_date": "2024-01-15",
    "standard_cost_kes": 1500.0,
    "last_order_date": None,
    "full_price": 3999.0,
    "is_noos": False,
    "reorder_count": 2,
    "colour_count": 3,
    "colours_in_stock": 2,
    "soh_stores": 20,
    "soh_online": 5,
    "soh_warehouse": 10,
    "units_6m": 80,
    "revenue_6m": 250000.0,
    "orders_6m": 60,
    "units_full_price": 60,
    "last_sale_date": "2026-08-10",
    "units_period": 80,
    "revenue_period": 250000.0,
    "units_life": 300,
    "revenue_life": 900000.0,
    "ov_tier": None,
    "ov_status": None,
}


# ── Helper ─────────────────────────────────────────────────────────────────────

def _clear_merch_state():
    merch_router._cache_store.clear()
    merch_router._SF_LOCKS.clear()


# ── 1. Real prewarmer structural tests ────────────────────────────────────────

class TestRealPrewarmerStructure(unittest.TestCase):
    """Inspect the real api_pg._start_cache_prewarmer source to verify the
    'merch-core' target and completion log are present.

    These tests fail if either is removed or renamed, protecting the
    documented startup behaviour without running the full API server."""

    def _prewarmer_source(self):
        return inspect.getsource(api_pg._start_cache_prewarmer)

    def test_merch_core_target_present_in_real_prewarmer(self):
        """api_pg._start_cache_prewarmer must declare a 'merch-core' target.

        The prewarmer iterates a `targets` list of (name, fn) pairs and
        calls each fn() on startup.  If 'merch-core' is absent the core
        cache is never warmed and the first user pays the full cold cost."""
        src = self._prewarmer_source()
        self.assertIn(
            '"merch-core"', src,
            "'merch-core' target label must appear in "
            "api_pg._start_cache_prewarmer.  It was removed or renamed.")

    def test_merch_core_calls_styles_cached(self):
        """The 'merch-core' target must call merch_router._styles_cached —
        this is the function that populates the SWR core cache."""
        src = self._prewarmer_source()
        self.assertIn(
            "merch_router._styles_cached", src,
            "api_pg._start_cache_prewarmer must call "
            "merch_router._styles_cached for the 'merch-core' target.")

    def test_prewarmer_emits_cycle_done_log(self):
        """The prewarmer must print 'Cache prewarm cycle done' after all
        targets finish — this is the log line operators use to confirm
        startup completed in deployed logs."""
        src = self._prewarmer_source()
        self.assertIn(
            "Cache prewarm cycle done", src,
            "'Cache prewarm cycle done' must be printed inside "
            "api_pg._start_cache_prewarmer after the targets loop.")


# ── 2. Core cache population ────────────────────────────────────────────────────

class TestPrewarmPopulatesCache(unittest.TestCase):
    """Calling _styles_cached(all-None) — the exact signature used by the
    api_pg prewarmer "merch-core" target — must populate the core cache so
    that subsequent calls to _fetch_styles_core_cached are cache hits."""

    def setUp(self):
        _clear_merch_state()
        # Put the router in production mode so the fast path is exercised.
        merch_router.A = mock.MagicMock()
        merch_router.A._rollup_fresh.return_value = False

    def tearDown(self):
        merch_router.A = None
        _clear_merch_state()

    def test_prewarm_populates_core_cache(self):
        """_styles_cached(all-None) stores a result under the merch_core key."""
        core_key = "merch_core|None|None"
        self.assertNotIn(core_key, merch_router._cache_store,
                         "cache must start empty")

        sql_calls = []

        def fake_core_sql(country, pos_location):
            sql_calls.append((country, pos_location))
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            merch_router._styles_cached(
                brand=None, subcategory=None, tier=None, status=None,
                from_date=None, to_date=None, country=None, pos_location=None)

        self.assertEqual(len(sql_calls), 1, "core SQL should run exactly once")
        self.assertIn(core_key, merch_router._cache_store,
                      "core cache must be populated after prewarm")

    def test_prewarm_then_first_user_request_is_cache_hit(self):
        """After _styles_cached(all-None), _fetch_styles_core_cached returns
        instantly without calling the SQL again."""
        sql_calls = []

        def fake_core_sql(country, pos_location):
            sql_calls.append((country, pos_location))
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            # Prewarmer step
            merch_router._styles_cached(
                brand=None, subcategory=None, tier=None, status=None,
                from_date=None, to_date=None, country=None, pos_location=None)
            calls_after_prewarm = len(sql_calls)

            # Simulate first user request
            t0 = time.monotonic()
            rows = merch_router._fetch_styles_core_cached(
                country=None, pos_location=None)
            elapsed_ms = (time.monotonic() - t0) * 1000

        self.assertEqual(calls_after_prewarm, 1, "prewarm ran the SQL once")
        self.assertEqual(len(sql_calls), 1,
                         "first user request must be a cache hit (no extra SQL)")
        self.assertGreater(len(rows), 0, "result must be non-empty")
        self.assertLess(elapsed_ms, 50,
                        f"warm cache hit took {elapsed_ms:.1f} ms — must be < 50 ms")


# ── 3. Timing contract ─────────────────────────────────────────────────────────

class TestWarmRequestTiming(unittest.TestCase):
    """The warm-cache path must be constant-time regardless of how long the
    cold SQL took — this is the key SLA mechanism."""

    def setUp(self):
        _clear_merch_state()
        merch_router.A = mock.MagicMock()
        merch_router.A._rollup_fresh.return_value = False

    def tearDown(self):
        merch_router.A = None
        _clear_merch_state()

    def test_warm_cache_hit_under_50ms(self):
        """After prewarm, a default-filter request must resolve in < 50 ms."""
        def fake_core_sql(country, pos_location):
            return [dict(_FAKE_ROW)] * 500

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            merch_router._styles_cached(
                brand=None, subcategory=None, tier=None, status=None,
                from_date=None, to_date=None, country=None, pos_location=None)

        def must_not_call(c, p):  # pragma: no cover
            raise AssertionError("SQL called on warm cache hit")

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=must_not_call):
            t0 = time.monotonic()
            merch_router._fetch_styles_core_cached(
                country=None, pos_location=None)
            elapsed_ms = (time.monotonic() - t0) * 1000

        self.assertLess(elapsed_ms, 50,
                        f"warm hit took {elapsed_ms:.1f} ms — must be < 50 ms")

    def test_warm_hit_is_fast_regardless_of_cold_sql_latency(self):
        """The warm-cache path must be constant-time regardless of how long
        the cold SQL took.

        This is the key SLA guarantee: in production the cold core SQL takes
        4–8 s; after the prewarmer runs it the first user request must return
        in milliseconds, not seconds.

        We simulate a slow cold SQL (300 ms) and assert the warm hit finishes
        in < 50 ms — a ratio of ≥ 6×.  If the code were to bypass the cache
        and re-run the SQL on the first user request, the warm hit would also
        take ~300 ms and this assertion would fail.
        """
        FAKE_SQL_MS = 300        # simulated slow cold query (production is ~4–8 s)
        WARM_HIT_BUDGET_MS = 50  # warm path must be far faster than the SQL

        sql_calls = []

        def fake_core_sql_slow(country, pos_location):
            sql_calls.append(1)
            time.sleep(FAKE_SQL_MS / 1000.0)
            return [dict(_FAKE_ROW)] * 500

        # Prewarmer runs the slow SQL once and caches the result.
        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql_slow):
            merch_router._styles_cached(
                brand=None, subcategory=None, tier=None, status=None,
                from_date=None, to_date=None, country=None, pos_location=None)

        self.assertEqual(len(sql_calls), 1, "prewarm must run SQL exactly once")

        # First user request: must be a cache hit — NOT re-running the SQL.
        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=AssertionError(
                                   "SQL was re-run on a warm cache hit")):
            t0 = time.monotonic()
            merch_router._fetch_styles_core_cached(
                country=None, pos_location=None)
            warm_ms = (time.monotonic() - t0) * 1000

        self.assertLess(
            warm_ms, WARM_HIT_BUDGET_MS,
            f"Warm hit took {warm_ms:.1f} ms after a {FAKE_SQL_MS} ms cold SQL. "
            f"Must be < {WARM_HIT_BUDGET_MS} ms. "
            f"In production (cold SQL ~4–8 s) this proves the ≤ 8 s SLA is met "
            f"by the prewarm strategy: the user never waits for the SQL.")


# ── 4. Cold-start single-flight ─────────────────────────────────────────────────

class TestColdStartSingleFlight(unittest.TestCase):
    """Without prewarm, a cold _fetch_styles_core_cached must run the SQL
    exactly once even when concurrent callers arrive simultaneously."""

    def setUp(self):
        _clear_merch_state()
        merch_router.A = mock.MagicMock()
        merch_router.A._rollup_fresh.return_value = False

    def tearDown(self):
        merch_router.A = None
        _clear_merch_state()

    def test_concurrent_cold_callers_run_sql_once(self):
        sql_calls = []
        results = []

        def fake_core_sql(country, pos_location):
            sql_calls.append(1)
            time.sleep(0.15)  # long enough for threads to pile up
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            threads = [
                threading.Thread(
                    target=lambda: results.append(
                        merch_router._fetch_styles_core_cached(
                            country=None, pos_location=None)))
                for _ in range(4)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)

        self.assertEqual(len(sql_calls), 1,
                         "single-flight lock must dedupe concurrent cold callers")
        self.assertEqual(len(results), 4, "all callers must get a result")
        for r in results[1:]:
            self.assertIs(r, results[0], "all callers share the winning rowset")

    def test_second_call_same_key_is_cache_hit(self):
        sql_calls = []

        def fake_core_sql(country, pos_location):
            sql_calls.append(1)
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            merch_router._fetch_styles_core_cached(country=None, pos_location=None)
            merch_router._fetch_styles_core_cached(country=None, pos_location=None)

        self.assertEqual(len(sql_calls), 1,
                         "second call for same (country, pos) must be a cache hit")


# ── 5. Prewarm key alignment ──────────────────────────────────────────────────

class TestPrewarmKeyAlignment(unittest.TestCase):
    """The "merch-core" prewarmer target in api_pg must warm exactly the cache
    key that _fetch_styles_core_cached reads on the first user request."""

    def setUp(self):
        _clear_merch_state()
        merch_router.A = mock.MagicMock()
        merch_router.A._rollup_fresh.return_value = False

    def tearDown(self):
        merch_router.A = None
        _clear_merch_state()

    def test_prewarmer_and_user_request_share_cache_key(self):
        """After the prewarmer runs, the first user request is a cache hit.

        Simulates the exact api_pg prewarmer call:
            merch_router._styles_cached(brand=None, subcategory=None,
                tier=None, status=None, from_date=None, to_date=None,
                country=None, pos_location=None)
        and then the default /api/merch/styles user request:
            _fetch_styles_core_cached(country=None, pos_location=None)
        """
        core_key = "merch_core|None|None"
        sql_calls = []

        def fake_core_sql(country, pos_location):
            sql_calls.append((country, pos_location))
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            # Exact call from api_pg._start_cache_prewarmer "merch-core" target
            merch_router._styles_cached(
                brand=None, subcategory=None, tier=None, status=None,
                from_date=None, to_date=None, country=None, pos_location=None)

            self.assertIn(core_key, merch_router._cache_store,
                          "prewarm must populate the merch_core|None|None key")

            # Now the user hits /api/merch/styles with default (no) filters
            merch_router._fetch_styles_core_cached(
                country=None, pos_location=None)

        self.assertEqual(len(sql_calls), 1,
                         "user request must share the prewarmer's cache entry "
                         "— SQL must run exactly once total")

    def test_different_country_filter_is_different_cache_key(self):
        """A request with country='Kenya' must NOT share the unfiltered prewarm
        cache entry — it needs its own SQL call."""
        sql_calls = []

        def fake_core_sql(country, pos_location):
            sql_calls.append((country, pos_location))
            return [dict(_FAKE_ROW)]

        with mock.patch.object(merch_router, "_fetch_styles_core_sql",
                               side_effect=fake_core_sql):
            # Prewarm (unfiltered)
            merch_router._fetch_styles_core_cached(
                country=None, pos_location=None)
            # Filtered user request
            merch_router._fetch_styles_core_cached(
                country="Kenya", pos_location=None)

        self.assertEqual(len(sql_calls), 2,
                         "Kenya-filtered request must have its own SQL call; "
                         "it cannot serve data from the unfiltered prewarm cache")


if __name__ == "__main__":
    unittest.main()
