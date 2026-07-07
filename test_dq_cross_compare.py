"""Regression tests for the nightly cross-page reconciliation compare logic
(WS9 T904). Proves the check FAILS when surfaces diverge — the original
implementation re-ran one shared SQL for both sides and could never fire."""
import unittest

from dq_cross_compare import cross_surface_compare


def _kpi(total=1000.0, net=900.0, units=50):
    return {"total_sales": total, "net_sales": net, "total_units": units}


def _countries(splits):
    return [{"country": f"C{i}", "total_sales": t, "units_sold": u}
            for i, (t, u) in enumerate(splits)]


def _trend(buckets):
    return [{"date": f"2026-06-{i+1:02d}", "total_sales": t,
             "net_sales": n, "units_sold": u}
            for i, (t, n, u) in enumerate(buckets)]


class TestCrossSurfaceCompare(unittest.TestCase):
    def test_all_ok_when_surfaces_agree(self):
        checks = cross_surface_compare(
            _kpi(), _countries([(600, 30), (400, 20)]),
            _trend([(700, 630, 35), (300, 270, 15)]))
        self.assertEqual(len(checks), 5)
        self.assertTrue(all(c["status"] == "ok" for c in checks))

    def test_rounding_tolerance_per_group(self):
        # Per-group ROUND() drift of ±0.5/group must not fire.
        checks = cross_surface_compare(
            _kpi(total=1000.0), _countries([(600.5, 30), (400.5, 20)]),
            _trend([(700, 630, 35), (300, 270, 15)]))
        by = {c["check_name"]: c["status"] for c in checks}
        self.assertEqual(by["total_sales_overview_vs_locations"], "ok")

    def test_fails_when_trend_path_diverges(self):
        # Simulate a trend-series regression (e.g. formula drift): sums no
        # longer match the KPI headline -> the trend checks MUST fail.
        checks = cross_surface_compare(
            _kpi(), _countries([(600, 30), (400, 20)]),
            _trend([(650, 600, 33), (300, 270, 15)]))
        by = {c["check_name"]: c["status"] for c in checks}
        self.assertEqual(by["total_sales_overview_vs_trend"], "fail")
        self.assertEqual(by["net_sales_overview_vs_trend"], "fail")
        self.assertEqual(by["units_overview_vs_trend"], "fail")
        # Country side unaffected.
        self.assertEqual(by["total_sales_overview_vs_locations"], "ok")
        self.assertEqual(by["units_overview_vs_locations"], "ok")

    def test_fails_when_country_summary_diverges(self):
        checks = cross_surface_compare(
            _kpi(), _countries([(600, 30), (350, 18)]),
            _trend([(700, 630, 35), (300, 270, 15)]))
        by = {c["check_name"]: c["status"] for c in checks}
        self.assertEqual(by["total_sales_overview_vs_locations"], "fail")
        self.assertEqual(by["units_overview_vs_locations"], "fail")

    def test_units_exact_integer_equality(self):
        # Units are integers — a drift of even 1 unit must fail.
        checks = cross_surface_compare(
            _kpi(units=50), _countries([(600, 30), (400, 21)]),
            _trend([(700, 630, 35), (300, 270, 15)]))
        by = {c["check_name"]: c["status"] for c in checks}
        self.assertEqual(by["units_overview_vs_locations"], "fail")
        self.assertEqual(by["units_overview_vs_trend"], "ok")

    def test_empty_surfaces_fail_not_crash(self):
        checks = cross_surface_compare(_kpi(), [], [])
        by = {c["check_name"]: c["status"] for c in checks}
        self.assertEqual(by["total_sales_overview_vs_locations"], "fail")
        self.assertEqual(by["units_overview_vs_trend"], "fail")


if __name__ == "__main__":
    unittest.main()
