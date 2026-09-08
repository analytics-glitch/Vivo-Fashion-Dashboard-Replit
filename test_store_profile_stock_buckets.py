import unittest
from datetime import date
from unittest.mock import patch

import api_pg


class TestStoreProfileStockBuckets(unittest.TestCase):
    @patch("api_pg.run_query")
    def test_stock_buckets_use_strict_five_percent_optimal_variance(self, run_query):
        stores = [
            {"store": "Low", "country": "Kenya", "revenue": 100, "units": 10,
             "discount_rate": 0, "return_rate": 0},
            {"store": "Boundary Low", "country": "Kenya", "revenue": 100, "units": 10,
             "discount_rate": 0, "return_rate": 0},
            {"store": "Boundary High", "country": "Kenya", "revenue": 100, "units": 10,
             "discount_rate": 0, "return_rate": 0},
            {"store": "High", "country": "Kenya", "revenue": 100, "units": 10,
             "discount_rate": 0, "return_rate": 0},
        ]
        run_query.side_effect = [
            stores,
            [],
            [
                {"store": "Low", "soh": 94},
                {"store": "Boundary Low", "soh": 95},
                {"store": "Boundary High", "soh": 105},
                {"store": "High", "soh": 106},
            ],
            [],
            [
                {"store": "Low", "optimal_stock": 100},
                {"store": "Boundary Low", "optimal_stock": 100},
                {"store": "Boundary High", "optimal_stock": 100},
                {"store": "High", "optimal_stock": 100},
            ],
        ]

        out = api_pg._build_store_profile_network_summary(date(2026, 9, 8))

        self.assertEqual(out["buckets"]["low_stock"], ["Low"])
        self.assertEqual(out["buckets"]["overstocked"], ["High"])
        self.assertNotIn("heavy_stock", out["buckets"])
        by_store = {row["store"]: row for row in out["stores"]}
        self.assertEqual(by_store["Low"]["stock_variance_pct"], -6.0)
        self.assertEqual(by_store["High"]["stock_variance_pct"], 6.0)


if __name__ == "__main__":
    unittest.main()