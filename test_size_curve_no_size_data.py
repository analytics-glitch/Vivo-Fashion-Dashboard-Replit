"""Regression test for the Size Health prod artefact (T1101).

On a catalog-heavy DB, styles with zero stock at every selling location AND
zero warehouse stock used to flood the size-curve LIMIT (ORDER BY
units_sold DESC, broken_sizes DESC), making every returned row read as a
broken curve (3000 broken / ~7.5% avg health). The fix tags those rows
no_size_data=True with NULL health fields and orders usable rows first.

Runs against the dev DB; skipped when DATABASE_URL is not set.
"""
import os
import unittest


@unittest.skipUnless(os.environ.get("DATABASE_URL"), "needs a database")
class TestSizeCurveNoSizeData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import api_pg
        cls.rows = api_pg.analytics_size_curve(
            date_from="2026-01-01", date_to="2026-07-08",
            country=None, channel=None)

    def test_no_size_data_rows_have_null_health(self):
        nd = [r for r in self.rows if r.get("no_size_data")]
        for r in nd:
            self.assertIsNone(r.get("health_pct"))
            self.assertIsNone(r.get("broken_sizes"))
            self.assertIsNone(r.get("demand_weighted_health"))
            self.assertIsNone(r.get("missing_sizes"))

    def test_usable_rows_fill_limit_first(self):
        # ORDER BY no_size_data ASC: once a no_size_data row appears, no
        # usable row may follow it.
        seen_nd = False
        for r in self.rows:
            if r.get("no_size_data"):
                seen_nd = True
            elif seen_nd:
                self.fail("usable row returned after a no_size_data row")

    def test_broken_less_than_tracked_when_sized_stock_exists(self):
        usable = [r for r in self.rows if not r.get("no_size_data")]
        if not usable:
            self.skipTest("no styles with stock in this DB")
        broken = [r for r in usable if (r.get("broken_sizes") or 0) > 0]
        # The artefact was broken == tracked (every row broken). With the
        # fix, styles with full curves must exist among usable rows.
        self.assertLess(len(broken), len(usable))

    def test_usable_rows_have_health(self):
        usable = [r for r in self.rows if not r.get("no_size_data")]
        for r in usable:
            self.assertIsNotNone(r.get("health_pct"))


@unittest.skipUnless(os.environ.get("DATABASE_URL"), "needs a database")
class TestSorStyleGrain(unittest.TestCase):
    """T1103: /api/sor and /api/top-skus must return ONE row per style —
    grouping by collection split styles (Poncho 458+19 vs Velocity 477)."""

    def test_sor_one_row_per_style(self):
        import api_pg
        rows = api_pg.get_sor(date_from="2026-01-01", date_to="2026-07-08",
                              country=None, channel=None)
        if isinstance(rows, dict):
            rows = rows.get("rows", rows)
        names = [r["style_name"] for r in rows]
        self.assertEqual(len(names), len(set(names)),
                         "duplicate style rows — collection back in the grain?")


if __name__ == "__main__":
    unittest.main()
