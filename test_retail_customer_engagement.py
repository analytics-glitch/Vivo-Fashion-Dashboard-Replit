"""Contracts for the aggregate-only Retail Customer Engagement endpoint."""
import unittest
from unittest import mock

import api_pg


class RetailCustomerEngagementTests(unittest.TestCase):
    def test_recency_boundaries_are_mutually_exclusive(self):
        expected = {
            0: "active", 90: "active",
            91: "cooling", 180: "cooling",
            181: "at_risk", 270: "at_risk",
            271: "high_risk", 365: "high_risk",
            366: "lapsed",
        }
        for days, key in expected.items():
            self.assertEqual(api_pg._retail_engagement_bucket(days)[0], key)

    def test_history_query_keeps_full_scope_and_canonical_identity_rules(self):
        query = " ".join(
            api_pg._retail_customer_health_sql(
                "2026-08-25", "2025-08-25", country="Kenya,Uganda", channel="Vivo Sarit"
            ).split()
        )
        self.assertIn("s.sale_date::date <= '2026-08-25'::date", query)
        self.assertNotIn("s.sale_date BETWEEN", query)
        self.assertIn("s.country IN ('Kenya','Uganda')", query)
        self.assertIn("s.pos_location_name IN ('Vivo Sarit')", query)
        self.assertIn("ci.source_customer_id=s.customer_id::text", query)
        self.assertIn("ci.store_id=s.store_id", query)
        self.assertIn("ci.match_method <> 'pseudo'", query)
        self.assertIn("SELECT s.person_id AS customer_id", query)
        self.assertIn("ARRAY_AGG(store ORDER BY purchase_date DESC, store DESC)", query)
        self.assertIn("'2025-08-25'::date", query)
        self.assertIn("WHEN days_since_purchase BETWEEN 0 AND 90 THEN 'active'", query)
        self.assertIn("WHEN days_since_purchase BETWEEN 271 AND 365 THEN 'high_risk'", query)
        self.assertIn("ELSE 'lapsed'", query)

    def test_payload_allocates_store_rows_once_and_returns_csv_ready_aggregates(self):
        current_rows = [
            {"period": "current", "status": "active", "store": "Vivo Sarit", "customer_count": 2, "revenue_at_risk": 1200},
            {"period": "current", "status": "active", "store": "Vivo Junction", "customer_count": 1, "revenue_at_risk": 400},
            {"period": "current", "status": "lapsed", "store": "Vivo Sarit", "customer_count": 3, "revenue_at_risk": 2400},
            {"period": "prior_year", "status": "active", "store": "Vivo Sarit", "customer_count": 2, "revenue_at_risk": 800},
            {"period": "prior_year", "status": "lapsed", "store": "Vivo Sarit", "customer_count": 2, "revenue_at_risk": 1500},
        ]
        with mock.patch.object(
            api_pg,
            "run_query",
            side_effect=[
                current_rows,
                [{"unique_customers": 7, "transactions": 10, "total_sales": 10000}],
                [{"unique_customers": 5, "transactions": 8, "total_sales": 7000}],
            ],
        ), mock.patch.object(
            api_pg,
            "footfall_clean_rows",
            side_effect=[
                [{"total_footfall": 100, "clean_orders": 12, "ff_counter_ok": True}],
                [{"total_footfall": 80, "clean_orders": 8, "ff_counter_ok": True}],
            ],
        ):
            result = api_pg._retail_customer_health_payload(
                "2026-08-01", "2026-08-25", country="Kenya", channel="Vivo Sarit,Vivo Junction"
            )

        self.assertEqual(result["scope"]["comparison"]["date_to"], "2025-08-25")
        self.assertEqual(result["metrics"]["unique_customers"], 7)
        self.assertEqual(result["metrics"]["footfall"], 100)
        self.assertEqual(result["metrics"]["conversion_rate"], 12.0)
        active = next(row for row in result["cohorts"] if row["key"] == "active")
        self.assertEqual(active["count"], 3)
        self.assertEqual(sum(row["count"] for row in active["stores"]), 3)
        self.assertTrue(active["store_count_reconciles"])
        self.assertEqual(active["previous_count"], 2)
        self.assertEqual(active["change_pct"], 50.0)
        self.assertEqual(active["stores"][0]["store"], "Vivo Sarit")
        self.assertNotIn("customer_id", active["stores"][0])

    def test_no_reliable_traffic_is_explicitly_unavailable(self):
        with mock.patch.object(
            api_pg,
            "run_query",
            side_effect=[[], [{}], [{}]],
        ), mock.patch.object(
            api_pg,
            "footfall_clean_rows",
            side_effect=[
                [{"total_footfall": 500, "clean_orders": 20, "ff_counter_ok": False}],
                [],
            ],
        ):
            result = api_pg._retail_customer_health_payload("2026-08-01", "2026-08-25")

        self.assertIsNone(result["metrics"]["footfall"])
        self.assertFalse(result["metrics"]["footfall_available"])
        self.assertIsNone(result["metrics"]["conversion_rate"])
        self.assertEqual(result["metrics"]["unavailable_traffic_stores"], 1)

    def test_reliable_zero_footfall_is_not_an_unavailable_sensor(self):
        with mock.patch.object(
            api_pg,
            "run_query",
            side_effect=[[], [{}], [{}]],
        ), mock.patch.object(
            api_pg,
            "footfall_clean_rows",
            side_effect=[
                [{"total_footfall": 0, "clean_orders": 0, "ff_counter_ok": True}],
                [],
            ],
        ):
            result = api_pg._retail_customer_health_payload("2026-08-01", "2026-08-25")

        self.assertEqual(result["metrics"]["footfall"], 0)
        self.assertTrue(result["metrics"]["footfall_available"])
        self.assertIsNone(result["metrics"]["conversion_rate"])

    def test_clean_footfall_country_and_pos_scope_are_forwarded(self):
        with mock.patch.object(
            api_pg,
            "run_query",
            side_effect=[[], [{}], [{}]],
        ), mock.patch.object(api_pg, "footfall_clean_rows", return_value=[]) as clean:
            api_pg._retail_customer_health_payload(
                "2026-08-01", "2026-08-25", country="Kenya", channel="Vivo Sarit"
            )

        self.assertEqual(clean.call_args_list[0].args, ("2026-08-01", "2026-08-25", "Vivo Sarit", "Kenya"))
        self.assertEqual(clean.call_args_list[1].args[2:], ("Vivo Sarit", "Kenya"))
