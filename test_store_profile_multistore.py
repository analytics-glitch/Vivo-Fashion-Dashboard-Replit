"""Regression tests for Store Profile multi-store scopes and weekday revenue."""

import unittest
from unittest.mock import patch

import api_pg


class TestStoreProfileScopes(unittest.TestCase):
    def test_single_store_scope(self):
        self.assertEqual(
            api_pg._sp_scope_sql("Vivo Meru", "s.pos_location_name"),
            "s.pos_location_name IN ('Vivo Meru')",
        )
        self.assertFalse(api_pg._sp_is_aggregate("Vivo Meru"))

    def test_multi_store_scope(self):
        self.assertEqual(
            api_pg._sp_scope_sql(
                "Vivo Meru,Vivo Nakuru", "s.pos_location_name"
            ),
            "s.pos_location_name IN ('Vivo Meru','Vivo Nakuru')",
        )
        self.assertTrue(api_pg._sp_is_aggregate("Vivo Meru,Vivo Nakuru"))

    def test_all_stores_uses_surface_specific_predicate(self):
        self.assertEqual(
            api_pg._sp_scope_sql(
                "All Stores", "i.pos_location_name", api_pg._SP_ALL_INV_PRED
            ),
            api_pg._SP_ALL_INV_PRED,
        )
        self.assertTrue(api_pg._sp_is_aggregate("All Stores"))

    def test_store_names_are_sql_escaped(self):
        self.assertEqual(
            api_pg._sp_scope_sql("Manager's Store,Vivo Meru", "s.pos_location_name"),
            "s.pos_location_name IN ('Manager''s Store','Vivo Meru')",
        )


class TestWeekdayRevenuePayload(unittest.TestCase):
    @patch("api_pg.run_query")
    def test_dense_weekday_payload_carries_average_net_revenue(self, run_query):
        run_query.return_value = [{
            "location": "Vivo Meru",
            "weekday": 0,
            "avg_footfall": 120,
            "avg_outside_traffic": 500,
            "avg_revenue": 123456,
            "avg_conversion_rate": 12.5,
            "avg_turn_in_rate": 24.0,
            "days": 4,
            "sum_outside": 2000,
        }]

        out = api_pg.get_footfall_weekday(
            date_from="2026-08-01",
            date_to="2026-08-28",
            channel="Vivo Meru",
        )

        self.assertEqual(len(out["rows"][0]["by_weekday"]), 7)
        self.assertEqual(out["rows"][0]["by_weekday"][0]["avg_revenue"], 123456)
        self.assertEqual(out["group_avg_by_weekday"][0]["avg_revenue"], 123456)
        sql = run_query.call_args.args[0]
        self.assertIn("s.sale_kind IN ('sale','order','return')", sql)
        self.assertIn("COALESCE(s.discounts_kes,0)", sql)
        self.assertIn("-s.returns_kes", sql)


if __name__ == "__main__":
    unittest.main()