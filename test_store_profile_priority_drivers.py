"""Unit tests pinning the Store Profile "Priority Focus" ranking rules.

The ranking was recently fixed so that:

* the TRANSACTIONS lever is added ONLY when neither the footfall nor the
  conversion lever could be computed (no sensor / no baseline). When either
  traffic lever is present, adding transactions would double-count the same
  traffic chain (Transactions = Footfall × Conversion);
* when transactions IS the fallback lever, its impact is
  (baseline_txn − projected_txn) × ABV;
* a %Returning pipeline driver appears when projected returning share drops
  below 90% of baseline.

These rules live in the pure module-level ``api_pg._build_priority_drivers``
(extracted from the performance-report endpoint precisely so they can be
tested without a live DB). A regression here would silently mislead store
managers about what to fix first.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_store_profile_priority_drivers
"""
import unittest

import api_pg


def _keys(drivers):
    return [d["key"] for d in drivers]


def _by_key(drivers, key):
    matches = [d for d in drivers if d["key"] == key]
    return matches[0] if matches else None


class TestTransactionsLeverGating(unittest.TestCase):
    """Transactions lever must NOT double-count the traffic chain."""

    def test_absent_when_footfall_and_conversion_available(self):
        # Both traffic levers computable and below baseline → conversion +
        # footfall drivers fire, transactions must be ABSENT even though the
        # projected transaction count is also below baseline.
        proj = {"footfall": 800, "conversion": 8.0, "abv": 3000,
                "transactions": 64, "units": 100, "revenue": 192000}
        expected = {"footfall": 1000, "conversion": 10.0, "abv": 3000,
                    "transactions": 100}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=100000)
        self.assertIn("conversion", _keys(drivers))
        self.assertIn("footfall", _keys(drivers))
        self.assertNotIn("transactions", _keys(drivers))

    def test_absent_when_only_conversion_available(self):
        # One traffic lever (conversion) fires → still no transactions lever.
        proj = {"footfall": 1000, "conversion": 8.0, "abv": 3000,
                "transactions": 80}
        expected = {"footfall": None, "conversion": 10.0, "abv": 3000,
                    "transactions": 100}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        self.assertIn("conversion", _keys(drivers))
        self.assertNotIn("transactions", _keys(drivers))

    def test_present_with_correct_impact_when_traffic_levers_unavailable(self):
        # No footfall sensor and no conversion baseline → transactions becomes
        # the combined traffic proxy with impact (baseline − projected) × ABV.
        proj = {"footfall": None, "conversion": None, "abv": 2500,
                "transactions": 70}
        expected = {"footfall": None, "conversion": None, "abv": 2500,
                    "transactions": 100}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        txn = _by_key(drivers, "transactions")
        self.assertIsNotNone(txn, "transactions lever missing when traffic levers can't be computed")
        self.assertEqual(txn["kes_impact"], round((100 - 70) * 2500))
        self.assertNotIn("footfall", _keys(drivers))
        self.assertNotIn("conversion", _keys(drivers))

    def test_transactions_uses_baseline_abv_when_projected_abv_missing(self):
        # abv_ref falls back to the baseline ABV when projected ABV is None.
        proj = {"abv": None, "transactions": 40}
        expected = {"abv": 1800, "transactions": 90}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        txn = _by_key(drivers, "transactions")
        self.assertIsNotNone(txn)
        self.assertEqual(txn["kes_impact"], round((90 - 40) * 1800))

    def test_absent_when_projected_txn_at_or_above_baseline(self):
        proj = {"transactions": 120, "abv": 2000}
        expected = {"transactions": 100, "abv": 2000}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        self.assertNotIn("transactions", _keys(drivers))


class TestReturningCustomerDriver(unittest.TestCase):
    """%Returning pipeline driver fires below 90% of baseline."""

    def test_present_when_projected_below_90pct_of_baseline(self):
        proj = {"returning_customer_pct": 35.0}
        expected = {"returning_customer_pct": 40.0}  # 35 < 36 = 0.9×40
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        ret = _by_key(drivers, "returning_customer_pct")
        self.assertIsNotNone(ret, "returning_customer_pct driver missing below 90% of baseline")
        # Pipeline driver: no KES impact (lands over coming months), ranked last.
        self.assertIsNone(ret["kes_impact"])
        self.assertEqual(ret["lever"], "pipeline")

    def test_absent_when_projected_within_90pct_of_baseline(self):
        proj = {"returning_customer_pct": 37.0}
        expected = {"returning_customer_pct": 40.0}  # 37 >= 36 → no driver
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        self.assertNotIn("returning_customer_pct", _keys(drivers))


class TestRanking(unittest.TestCase):
    def test_sorted_by_impact_with_none_last_and_ranked(self):
        proj = {"footfall": 800, "conversion": 8.0, "abv": 3000,
                "transactions": 64, "returning_customer_pct": 30.0}
        expected = {"footfall": 1000, "conversion": 10.0, "abv": 3000,
                    "transactions": 100, "returning_customer_pct": 40.0}
        drivers = api_pg._build_priority_drivers(proj, expected, rev_gap=None)
        impacts = [d["kes_impact"] for d in drivers if d["kes_impact"] is not None]
        self.assertEqual(impacts, sorted(impacts, reverse=True))
        # None-impact pipeline drivers sort after all KES-quantified ones.
        self.assertIsNone(drivers[-1]["kes_impact"])
        self.assertEqual([d["rank"] for d in drivers],
                         list(range(1, len(drivers) + 1)))


if __name__ == "__main__":
    unittest.main()
