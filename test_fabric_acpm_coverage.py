"""Focused contracts for the Fabric Avg cost/metre coverage warning."""
import unittest
from unittest import mock

import fabric_router as fr


class ConversionCoverageTests(unittest.TestCase):
    def test_valid_reported_conversion_has_no_missing_width_or_gsm_label(self):
        # Once barcode 105433's valid source values arrive in the Fabric master,
        # its generated kg/m is positive and neither exclusion drill-down should
        # label it as a Width/GSM data gap.
        self.assertEqual(fr._width_gsm_missing_str(1.70, 157.0), "")
        self.assertAlmostEqual(1.70 * 157.0 / 1000.0, 0.2669)

    def test_absent_zero_and_invalid_inputs_remain_clearly_excluded(self):
        self.assertEqual(fr._width_gsm_missing_str(None, None), "Width, GSM")
        self.assertEqual(fr._width_gsm_missing_str(0, 157), "Width")
        self.assertEqual(fr._width_gsm_missing_str(1.7, "not set"), "GSM")

    def test_master_refresh_rolls_the_summary_cache_key(self):
        with mock.patch.object(fr, "_fabric_master_version", side_effect=[
                "2026-08-25 10:00:00", "2026-08-25 10:01:00"]):
            before = fr._fabric_summary_cache_key("RMAT/Stock", "main")
            after = fr._fabric_summary_cache_key("RMAT/Stock", "main")
        self.assertNotEqual(before, after)

    def test_purchase_coverage_uses_the_drilldowns_distinct_product_grain(self):
        with open(fr.__file__, "r") as source:
            body = source.read()
        coverage_start = body.index("acpm_purchases_coverage = q(conn")
        coverage_end = body.index("missing_rows = q(conn", coverage_start)
        coverage_sql = body[coverage_start:coverage_end]
        self.assertIn("COUNT(DISTINCT p.id)", coverage_sql)
        self.assertIn("p.kg_per_mtr_eff IS NULL", coverage_sql)


if __name__ == "__main__":
    unittest.main()