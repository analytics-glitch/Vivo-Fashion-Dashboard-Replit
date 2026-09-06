"""Repeatable Merch Overview cold/warm performance regression harness.

The optional live benchmark is deliberately authenticated and opt-in: it never
guesses a staff credential and it never contacts an environment unless
``MERCH_BENCH_BASE_URL`` and ``MERCH_BENCH_AUTH_HEADER`` are supplied.  For
example, run it against a non-production staff session with::

    MERCH_BENCH_BASE_URL=https://bi.example \
    MERCH_BENCH_AUTH_HEADER='Cookie: session=...' \
    MERCH_BENCH_COLD_RESET_URL=https://bi.example/api/admin/cache/reset \
    python -m unittest test_merch_overview_benchmark.LiveMerchOverviewBenchmark

``MERCH_BENCH_COLD_RESET_URL`` is optional, but should be an authenticated
cache-reset endpoint in the disposable benchmark environment. Without it the
first pass is explicitly reported as ``baseline`` rather than mislabelled as
cold. Results are emitted as one JSON object, making CI artifact collection
and cold/warm threshold comparisons repeatable.

The fast unit checks below protect the important properties without a database:
one strict full-price raw scan per identical scope, rollup and live-fallback
period paths, and the independently settling browser endpoint contract.
"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest import mock
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import merch_router


OVERVIEW_ENDPOINTS = (
    "styles",
    "summary",
    "by-brand?trend=1",
    "by-subcategory?trend=1",
    "by-tier",
)
DEFAULT_MAX_WARM_MS = float(os.environ.get("MERCH_BENCH_MAX_WARM_MS", "5000"))


def _clear_merch_caches():
    merch_router._cache_store.clear()
    merch_router._cache_locks.clear()
    merch_router._SF_LOCKS.clear()
    merch_router._INFLIGHT.clear()


class AuthenticatedMerchOverviewRunner:
    """Small stdlib-only runner so it is usable in deployed API containers too."""

    def __init__(self, base_url, auth_header, timeout=30):
        if ":" not in auth_header:
            raise ValueError("MERCH_BENCH_AUTH_HEADER must be 'Header-Name: value'")
        self.base_url = base_url.rstrip("/")
        self.header_name, self.header_value = (
            part.strip() for part in auth_header.split(":", 1)
        )
        self.timeout = timeout

    def request(self, path, params=None):
        url = f"{self.base_url}/api/merch/{path}"
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        started = time.monotonic()
        request = Request(url, headers={self.header_name: self.header_value})
        with urlopen(request, timeout=self.timeout) as response:
            body = response.read()
            status = response.status
        return {
            "path": path,
            "status": status,
            "duration_ms": round((time.monotonic() - started) * 1000, 1),
            "response_bytes": len(body),
        }

    def run_pass(self, label, params):
        started = time.monotonic()
        # The Overview mounts all five requests together.  Preserve that shape:
        # serial probing hides the pool contention and duplicate-scan regression
        # this harness is intended to expose.
        with ThreadPoolExecutor(max_workers=len(OVERVIEW_ENDPOINTS)) as executor:
            futures = [
                executor.submit(self.request, endpoint, params)
                for endpoint in OVERVIEW_ENDPOINTS
            ]
            results = [future.result() for future in futures]
        return {
            "label": label,
            "duration_ms": round((time.monotonic() - started) * 1000, 1),
            "endpoints": results,
        }


class LiveMerchOverviewBenchmark(unittest.TestCase):
    """Opt-in authenticated cold/warm benchmark for an actual API deployment."""

    @classmethod
    def setUpClass(cls):
        base_url = os.environ.get("MERCH_BENCH_BASE_URL")
        auth_header = os.environ.get("MERCH_BENCH_AUTH_HEADER")
        if not base_url or not auth_header:
            raise unittest.SkipTest(
                "set MERCH_BENCH_BASE_URL and MERCH_BENCH_AUTH_HEADER to run live benchmark"
            )
        cls.runner = AuthenticatedMerchOverviewRunner(base_url, auth_header)

    def test_authenticated_cold_warm_and_representative_filter_scopes(self):
        # Filter values intentionally come from the target environment; invented
        # values could benchmark an empty universe instead of a real staff scope.
        scopes = {
            "default": {},
            "country": _optional_scope(country=os.environ.get("MERCH_BENCH_COUNTRY")),
            "channel": _optional_scope(pos_location=os.environ.get("MERCH_BENCH_CHANNEL")),
            "brand": _optional_scope(brand=os.environ.get("MERCH_BENCH_BRAND")),
            "subcategory": _optional_scope(
                subcategory=os.environ.get("MERCH_BENCH_SUBCATEGORY")
            ),
        }
        scopes = {name: params for name, params in scopes.items()
                  if name == "default" or params}
        reset_url = os.environ.get("MERCH_BENCH_COLD_RESET_URL")
        cold_label = "baseline"
        if reset_url:
            request = Request(
                reset_url,
                method="POST",
                headers={self.runner.header_name: self.runner.header_value},
            )
            with urlopen(request, timeout=self.runner.timeout) as response:
                self.assertLess(response.status, 300, "authenticated cold reset failed")
            cold_label = "cold"

        report = {
            "overview_endpoints": OVERVIEW_ENDPOINTS,
            "passes": [self.runner.run_pass(cold_label, scopes["default"])],
            "filter_changes": [
                self.runner.run_pass(name, params)
                for name, params in scopes.items() if name != "default"
            ],
        }
        report["passes"].append(self.runner.run_pass("warm", scopes["default"]))
        print(json.dumps(report, sort_keys=True))
        warm = report["passes"][-1]
        for endpoint in warm["endpoints"]:
            self.assertLessEqual(endpoint["status"], 299)
            self.assertLessEqual(endpoint["duration_ms"], DEFAULT_MAX_WARM_MS)


def _optional_scope(**values):
    return {key: value for key, value in values.items() if value}


class StrictFullPriceSingleScanTests(unittest.TestCase):
    def setUp(self):
        _clear_merch_caches()

    tearDown = setUp

    def test_identical_concurrent_scope_executes_one_strict_raw_scan(self):
        calls = []
        results = []

        def fake_db(sql, params=None, fetch=True):
            self.assertIn("COALESCE(s.discounts_kes, 0)::numeric = 0", sql)
            calls.append((sql, params))
            time.sleep(0.08)  # ensure all callers contend for the same cache lock
            return [{"style_name": "Dress", "units_full_price_period": 4,
                     "sales_value_period": 12000}]

        def worker():
            results.append(merch_router._fetch_full_price_period_by_style(
                "2026-08-01", "2026-08-31", country="Kenya", brand="Vivo"
            ))

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_db):
            threads = [threading.Thread(target=worker) for _ in range(5)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)

        self.assertEqual(len(calls), 1, "same scope must not duplicate raw full-price scans")
        self.assertEqual(len(results), 5)
        self.assertTrue(all(result is results[0] for result in results))


class PeriodOverlayPathTests(unittest.TestCase):
    def setUp(self):
        _clear_merch_caches()

    tearDown = setUp

    def test_fresh_rollup_uses_rollup_and_incremental_bridge(self):
        api = mock.MagicMock()
        api._rollup_fresh.return_value = True
        with mock.patch.object(merch_router, "A", api), mock.patch.object(
            merch_router, "_db_exec",
            side_effect=[
                [{"source_watermark": "2026-08-01T00:00:00Z"}],
                [{"style_name": "Dress", "units_period": 4, "revenue_period": 12000}],
            ],
        ) as db:
            rows = merch_router._fetch_period_overlay_sql(
                "2026-08-01", "2026-08-31", "Kenya", "Vivo Nairobi"
            )
        sql = db.call_args_list[-1].args[0]
        self.assertIn("FROM rollup_merch_style_day", sql)
        self.assertIn("s.loaded_at > %(wm)s", sql)
        self.assertEqual(rows["Dress"]["units_period"], 4)

    def test_unhealthy_rollup_uses_live_sales_fallback(self):
        api = mock.MagicMock()
        api._rollup_fresh.return_value = False
        with mock.patch.object(merch_router, "A", api), mock.patch.object(
            merch_router, "_db_exec",
            return_value=[{"style_name": "Dress", "units_period": 4, "revenue_period": 12000}],
        ) as db:
            merch_router._fetch_period_overlay_sql(
                "2026-08-01", "2026-08-31", None, None
            )
        sql = db.call_args.args[0]
        self.assertIn("FROM all_sales s", sql)
        self.assertNotIn("FROM rollup_merch_style_day", sql)


class ProgressiveOverviewContractTests(unittest.TestCase):
    def test_client_tracks_each_endpoint_and_does_not_use_all_or_nothing_promise(self):
        source = Path("artifacts/vivo-bi/src/pages/merch/MerchHelpers.jsx").read_text()
        hook = source[source.index("export const useMerchData"):source.index("// ── Chart helpers")]
        self.assertIn("loadingByEndpoint", hook)
        self.assertIn("errorByEndpoint", hook)
        self.assertIn("AbortController", hook)
        self.assertIn("endpointEntries.forEach", hook)
        self.assertNotIn("Promise.all", hook)
        self.assertIn("[key]: false", hook,
                      "a completed or failed section must settle independently")


if __name__ == "__main__":
    unittest.main()