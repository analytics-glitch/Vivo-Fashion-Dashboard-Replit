"""Single-flight regression tests for the merch style-universe cache.

2026-08-13 incident: the Merchandising Overview tab fires five endpoints in
parallel that all need the same ~15s _fetch_styles rowset. The originals were
async-def handlers running the blocking query directly on the event loop —
five duplicate executions serialized into a ~100s page load that froze the
whole app. These tests pin the dedup contract that fixed it:

  * concurrent _styles_async callers for one key run _fetch_styles exactly
    ONCE and share the same result object (waiters await a future; only the
    winner occupies a threadpool worker);
  * _INFLIGHT cleans up after both success and failure, and failures
    propagate to every waiter;
  * a warm cache entry short-circuits without any fetch;
  * the sync _styles_cached path (CSV export / standalone) dedupes racing
    threads through the per-key lock.

No database access — _fetch_styles is monkeypatched throughout.
"""

import asyncio
import threading
import time
import unittest
from unittest import mock

import merch_router


class StylesAsyncSingleFlightTests(unittest.TestCase):
    def setUp(self):
        merch_router._cache_store.clear()
        merch_router._INFLIGHT.clear()
        merch_router._SF_LOCKS.clear()

    def tearDown(self):
        merch_router._cache_store.clear()
        merch_router._INFLIGHT.clear()
        merch_router._SF_LOCKS.clear()

    def test_five_concurrent_callers_share_one_fetch(self):
        calls = []

        def fake_fetch(**kw):
            calls.append(kw)
            time.sleep(0.15)  # long enough for all siblings to pile up
            return [{"style_name": "X"}]

        async def main():
            with mock.patch.object(merch_router, "_fetch_styles",
                                   side_effect=fake_fetch):
                return await asyncio.gather(*[
                    merch_router._styles_async(brand="B", ttl=600)
                    for _ in range(5)
                ])

        rows = asyncio.run(main())
        self.assertEqual(len(calls), 1, "siblings must not re-run the query")
        for r in rows[1:]:
            self.assertIs(r, rows[0], "all callers share the winner's rowset")
        self.assertEqual(merch_router._INFLIGHT, {}, "in-flight map must drain")

    def test_distinct_keys_fetch_independently(self):
        calls = []

        def fake_fetch(**kw):
            calls.append(kw)
            return [kw]

        async def main():
            with mock.patch.object(merch_router, "_fetch_styles",
                                   side_effect=fake_fetch):
                return await asyncio.gather(
                    merch_router._styles_async(brand="A", ttl=600),
                    merch_router._styles_async(brand="B", ttl=600),
                )

        a, b = asyncio.run(main())
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(a, b)

    def test_failure_propagates_to_all_waiters_and_cleans_up(self):
        def boom(**kw):
            time.sleep(0.05)
            raise RuntimeError("db down")

        async def main():
            with mock.patch.object(merch_router, "_fetch_styles",
                                   side_effect=boom):
                return await asyncio.gather(
                    *[merch_router._styles_async(brand="F", ttl=600)
                      for _ in range(3)],
                    return_exceptions=True)

        results = asyncio.run(main())
        self.assertEqual(len(results), 3)
        for r in results:
            self.assertIsInstance(r, RuntimeError)
        self.assertEqual(merch_router._INFLIGHT, {})
        # Nothing was cached, so a later call retries the fetch.
        ok = [{"style_name": "recovered"}]
        with mock.patch.object(merch_router, "_fetch_styles",
                               return_value=ok):
            rows = asyncio.run(merch_router._styles_async(brand="F", ttl=600))
        self.assertEqual(rows, ok)

    def test_warm_cache_short_circuits_without_fetch(self):
        seed = [{"style_name": "warm"}]
        with mock.patch.object(merch_router, "_fetch_styles",
                               return_value=seed):
            first = asyncio.run(merch_router._styles_async(brand="W", ttl=600))
        self.assertIs(first, seed)

        def must_not_run(**kw):  # pragma: no cover - failure path
            raise AssertionError("fetch ran despite warm cache")

        with mock.patch.object(merch_router, "_fetch_styles",
                               side_effect=must_not_run):
            again = asyncio.run(merch_router._styles_async(brand="W", ttl=600))
        self.assertIs(again, seed)


class StylesCachedSyncSingleFlightTests(unittest.TestCase):
    def setUp(self):
        merch_router._cache_store.clear()
        merch_router._SF_LOCKS.clear()

    tearDown = setUp

    def test_racing_threads_run_one_fetch(self):
        calls = []
        results = []

        def fake_fetch(**kw):
            calls.append(kw)
            time.sleep(0.15)
            return [{"style_name": "sync"}]

        def worker():
            results.append(merch_router._styles_cached(brand="S", ttl=600))

        with mock.patch.object(merch_router, "_fetch_styles",
                               side_effect=fake_fetch):
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=5)

        self.assertEqual(len(calls), 1, "per-key lock must dedupe threads")
        self.assertEqual(len(results), 4)
        for r in results[1:]:
            self.assertIs(r, results[0])

    def test_lock_dict_stays_bounded(self):
        with mock.patch.object(merch_router, "_fetch_styles",
                               return_value=[]):
            for i in range(600):
                merch_router._styles_cached(brand=f"b{i}", ttl=600)
        self.assertLessEqual(len(merch_router._SF_LOCKS), 512)


if __name__ == "__main__":
    unittest.main()
