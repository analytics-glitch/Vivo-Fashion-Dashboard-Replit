"""Unit tests for the cross-surface (cross-endpoint) consistency agent.

These lock in the two pieces of behaviour the agent's value depends on:

1. ``_cmp`` -- the comparison/severity logic. A future edit that loosens a
   tolerance or breaks a field mapping would let real mismatches between
   dashboard pages slip past leadership; these assertions catch that.
2. The never-raise contract of the HTTP session / login / retry. This step runs
   inside the always-on sync loop, so an unreachable API, a bad login, or a
   single failing scenario must degrade to a skip reason -- never an exception --
   and a 401 must trigger exactly one re-login retry.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest validation_agent.test_cross_surface
"""
import unittest
from datetime import date
from unittest import mock

import requests

from . import config
from . import cross_surface


class FakeResponse:
    """Minimal stand-in for a ``requests.Response``."""

    def __init__(self, status_code=200, json_data=None, raise_json=False):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self._raise_json = raise_json

    def json(self):
        if self._raise_json:
            raise ValueError("not json")
        return self._json


class CmpTests(unittest.TestCase):
    """``_cmp`` comparison + severity behaviour."""

    def _cmp(self, a, b, money):
        return cross_surface._cmp(
            "scenario", "metric", "identity", "check_code",
            a, b, money, date(2026, 6, 27), {},
        )

    def test_identical_values_no_exception(self):
        # Same number on both pages -> nothing to report.
        self.assertIsNone(self._cmp(1_000_000, 1_000_000, money=True))
        self.assertIsNone(self._cmp(1234, 1234, money=False))

    def test_material_money_gap_is_red(self):
        # A large absolute KES gap (>= MATERIALITY_KES) is RED even when the
        # RELATIVE gap is below the red-relative threshold.
        a, b = 10_000_000.0, 10_060_000.0  # gap 60k KES, rel ~0.6%
        gap = abs(a - b)
        self.assertGreaterEqual(gap, config.MATERIALITY_KES)
        rel = gap / max(abs(a), abs(b))
        self.assertLess(rel, config.CROSS_SURFACE_RED_REL)  # red is driven by KES, not rel
        self.assertGreater(rel, config.CROSS_SURFACE_TOL)   # but still above tolerance

        exc = self._cmp(a, b, money=True)
        self.assertIsNotNone(exc)
        self.assertEqual(exc["severity"], "red")
        self.assertAlmostEqual(exc["materiality_kes"], gap)
        self.assertFalse(exc["auto_fixable"])
        self.assertEqual(exc["tier"], 1)
        self.assertEqual(exc["entity_type"], "cross_surface")

    def test_large_relative_count_gap_is_red(self):
        # A big relative count/unit gap is RED with zero KES at stake.
        a, b = 1000, 900  # rel ~11%
        rel = abs(a - b) / max(a, b)
        self.assertGreaterEqual(rel, config.CROSS_SURFACE_RED_REL)

        exc = self._cmp(a, b, money=False)
        self.assertIsNotNone(exc)
        self.assertEqual(exc["severity"], "red")
        self.assertEqual(exc["materiality_kes"], 0.0)  # counts carry no KES

    def test_sub_floor_gap_is_ignored(self):
        # Gap exceeds the relative tolerance but stays at/below the absolute
        # floor (integer-rounding noise) -> must be ignored.
        # Money: 90 KES gap is below the 100 KES money floor.
        a, b = 1090.0, 1000.0
        rel = abs(a - b) / max(a, b)
        self.assertGreater(rel, config.CROSS_SURFACE_TOL)
        self.assertLessEqual(abs(a - b), config.CROSS_SURFACE_MONEY_FLOOR)
        self.assertIsNone(self._cmp(a, b, money=True))

        # Count: a 2-unit gap is at the count floor.
        self.assertLessEqual(2, config.CROSS_SURFACE_COUNT_FLOOR)
        self.assertIsNone(self._cmp(102, 100, money=False))


class _FakeSession:
    """A ``requests.Session`` stand-in driving ``post``/``get`` from queues."""

    def __init__(self, post=None, get=None):
        self._post = post
        self._get = get
        self.post_calls = []
        self.get_calls = []

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return self._post(url, **kwargs)

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self._get(url, **kwargs)


class NeverRaiseTests(unittest.TestCase):
    """``run_checks`` degrades to a skip reason and never raises."""

    def setUp(self):
        # Force a credential so run_checks does not bail early, and reset the
        # module-level token cache between tests.
        self._pw_patch = mock.patch.object(
            config, "CROSS_SURFACE_LOGIN_PASSWORD", "test-secret")
        self._pw_patch.start()
        self.addCleanup(self._pw_patch.stop)
        cross_surface._TOKEN = None
        self.addCleanup(lambda: setattr(cross_surface, "_TOKEN", None))

    def _run_with_session(self, session):
        with mock.patch.object(cross_surface.requests, "Session",
                               return_value=session):
            return cross_surface.run_checks(date(2026, 6, 27))

    def test_unreachable_api_returns_skip(self):
        def post(url, **kw):
            raise requests.ConnectionError("boom")

        session = _FakeSession(post=post)
        excs, skip = self._run_with_session(session)
        self.assertEqual(excs, [])
        self.assertIsNotNone(skip)
        self.assertIn("unreachable", skip.lower())

    def test_bad_login_returns_skip(self):
        def post(url, **kw):
            return FakeResponse(status_code=401, json_data={})

        session = _FakeSession(post=post)
        excs, skip = self._run_with_session(session)
        self.assertEqual(excs, [])
        self.assertIsNotNone(skip)
        self.assertIn("login failed", skip.lower())

    def test_per_scenario_error_returns_skip_not_raise(self):
        # Login succeeds; every GET blows up with an UNEXPECTED error. Each
        # scenario must be caught and turned into a skip, never propagated.
        def post(url, **kw):
            return FakeResponse(status_code=200, json_data={"token": "tok"})

        def get(url, **kw):
            raise RuntimeError("kaboom")

        session = _FakeSession(post=post, get=get)
        excs, skip = self._run_with_session(session)  # must not raise
        self.assertEqual(excs, [])
        self.assertIsNotNone(skip)
        # Both the sales scenarios and the inventory check should have skipped.
        self.assertIn("kaboom", skip)
        self.assertTrue(len(session.get_calls) >= 1)


class RetryTests(unittest.TestCase):
    """``_get`` re-logs in exactly once on a 401, then succeeds."""

    def setUp(self):
        cross_surface._TOKEN = "stale-token"
        self.addCleanup(lambda: setattr(cross_surface, "_TOKEN", None))

    def test_401_triggers_exactly_one_relogin(self):
        responses = [
            FakeResponse(status_code=401, json_data={}),
            FakeResponse(status_code=200, json_data={"ok": True}),
        ]

        def get(url, **kw):
            return responses.pop(0)

        session = _FakeSession(get=get)

        login = mock.Mock(return_value="fresh-token")
        with mock.patch.object(cross_surface, "_login", login):
            out = cross_surface._get(session, "/kpis", {})

        self.assertEqual(out, {"ok": True})
        self.assertEqual(login.call_count, 1)           # exactly one re-login
        self.assertEqual(len(session.get_calls), 2)     # one retry only
        # The retry used the refreshed token.
        self.assertEqual(
            session.get_calls[1][1]["headers"]["Authorization"],
            "Bearer fresh-token",
        )

    def test_persistent_401_raises_skip_after_single_retry(self):
        def get(url, **kw):
            return FakeResponse(status_code=401, json_data={})

        session = _FakeSession(get=get)
        login = mock.Mock(return_value="fresh-token")
        with mock.patch.object(cross_surface, "_login", login):
            with self.assertRaises(cross_surface._Skip):
                cross_surface._get(session, "/kpis", {})

        self.assertEqual(login.call_count, 1)           # did NOT loop forever
        self.assertEqual(len(session.get_calls), 2)     # one retry only


class ProductCheckTests(unittest.TestCase):
    """``_check_products`` field mappings and green/red behaviour.

    These lock the product-page cross-surface identities so a future edit that
    mis-maps a summary field, a breakdown key, or the cross-page universe
    (PA styles == RM active + retired) is caught. ``_get`` is patched to return
    controlled payloads so no API is needed.
    """

    # A fully-consistent set of payloads: every breakdown sums to its KPI, the
    # tier counts + row list match the active total, the inventory parts sum to
    # the total, and PA styles == RM rows + retired_rows.
    GREEN = {
        "/analytics/product-analysis": {
            "summary": {"styles": 983, "units": 66665, "stock_units": 46756},
            "by_subcategory": [
                {"styles": 500, "units": 30000, "stock": 20000},
                {"styles": 483, "units": 36665, "stock": 26756},
            ],
            "by_brand": [
                {"styles": 983, "units": 66665, "stock": 46756},
            ],
        },
        "/range-mgmt/classify": {
            "summary": {
                "total_active_styles": 581,
                "tier_counts": {"Tier 1": 100, "Tier 2": 200,
                                "Tier 3": 150, "Tier 4": 131},
            },
            "rows": [0] * 581,
            "retired_rows": [0] * 402,
        },
        "/inventory-style-counts": {
            "active_styles": 1150, "retired_styles": 402, "total_styles": 1552,
        },
    }

    def _run(self, payloads):
        out = []
        with mock.patch.object(
                cross_surface, "_get",
                side_effect=lambda s, path, params, timeout=None: payloads[path]):
            cross_surface._check_products(None, date(2026, 6, 27), out)
        return out

    def test_consistent_payloads_no_exceptions(self):
        self.assertEqual(self._run(self.GREEN), [])

    def test_product_analysis_uses_product_timeout(self):
        # The heavy/cached product-analysis call must pass the longer product
        # timeout (not the default), so a slow response is not cut short.
        captured = {}

        def fake_get(s, path, params, timeout=None):
            captured[path] = timeout
            return self.GREEN[path]

        out = []
        with mock.patch.object(cross_surface, "_get", side_effect=fake_get):
            cross_surface._check_products(None, date(2026, 6, 27), out)
        self.assertEqual(captured["/analytics/product-analysis"],
                         config.CROSS_SURFACE_PRODUCT_TIMEOUT_SEC)

    def _broken(self, **patches):
        import copy
        p = copy.deepcopy(self.GREEN)
        for path, mutate in patches.items():
            mutate(p[path])
        return self._run(p)

    def test_pa_subcategory_styles_mismatch_fires(self):
        out = self._broken(**{
            "/analytics/product-analysis":
                lambda d: d["by_subcategory"].__setitem__(
                    0, {"styles": 400, "units": 30000, "stock": 20000}),
        })
        codes = {e["check_code"] for e in out}
        self.assertIn("xsurf_pa_subcat_styles", codes)
        self.assertTrue(all(e["severity"] in ("red", "amber") for e in out))

    def test_pa_brand_units_mismatch_fires(self):
        out = self._broken(**{
            "/analytics/product-analysis":
                lambda d: d["by_brand"].__setitem__(
                    0, {"styles": 983, "units": 60000, "stock": 46756}),
        })
        self.assertIn("xsurf_pa_brand_units",
                      {e["check_code"] for e in out})

    def test_rm_tier_counts_mismatch_fires(self):
        out = self._broken(**{
            "/range-mgmt/classify":
                lambda d: d["summary"]["tier_counts"].__setitem__("Tier 4", 50),
        })
        self.assertIn("xsurf_rm_tier_counts",
                      {e["check_code"] for e in out})

    def test_rm_active_rows_mismatch_fires(self):
        out = self._broken(**{
            "/range-mgmt/classify":
                lambda d: d.__setitem__("rows", [0] * 500),
        })
        self.assertIn("xsurf_rm_active_rows",
                      {e["check_code"] for e in out})

    def test_cross_page_pa_vs_rm_total_mismatch_fires(self):
        # PA reports 983 styles but RM's universe (rows + retired) only sums to
        # 900 -> the two pages disagree on the styles-with-stock universe.
        out = self._broken(**{
            "/range-mgmt/classify":
                lambda d: d.__setitem__("retired_rows", [0] * 319),
        })
        self.assertIn("xsurf_pa_vs_rm_total",
                      {e["check_code"] for e in out})

    def test_inventory_style_counts_parts_mismatch_fires(self):
        out = self._broken(**{
            "/inventory-style-counts":
                lambda d: d.__setitem__("retired_styles", 300),
        })
        self.assertIn("xsurf_isc_parts_sum",
                      {e["check_code"] for e in out})


if __name__ == "__main__":
    unittest.main()
