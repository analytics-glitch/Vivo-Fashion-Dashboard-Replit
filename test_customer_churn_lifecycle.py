"""Focused contracts for the fixed Customers lifecycle definitions.

These endpoint tests use a query recorder rather than a database. They pin the
boundary values and verify legacy query parameters cannot change the API's
server-owned lifecycle logic.
"""
import unittest
from unittest import mock

import api_pg


class CustomerChurnLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.queries = []

    def _record(self, rows):
        def record(query, *args, **kwargs):
            self.queries.append(" ".join(query.split()))
            return rows
        return record

    def test_fixed_lifecycle_boundaries_are_explicit(self):
        self.assertEqual(api_pg.CUSTOMER_ACTIVE_WINDOW_DAYS, 90)
        self.assertEqual(api_pg.CUSTOMER_AT_RISK_MIN_DAYS, 90)
        self.assertEqual(api_pg.CUSTOMER_AT_RISK_MAX_DAYS, 363)
        self.assertEqual(api_pg.CUSTOMER_CHURN_DAYS, 364)
        self.assertEqual(api_pg.CUSTOMER_RETURN_GAP_DAYS, 365)

    def test_churned_list_ignores_legacy_days_and_honours_scope(self):
        with mock.patch.object(api_pg, "run_query", side_effect=self._record([])), \
             mock.patch.object(api_pg, "mask_pii_rows", side_effect=lambda rows, _request: rows):
            rows = api_pg.get_churned_customers(
                object(), days=30, country="Kenya,Uganda", channel="Village Market")

        self.assertEqual(rows, [])
        query = self.queries[-1]
        self.assertIn("CURRENT_DATE - lp.last_purchase_date >= 364", query)
        self.assertIn("s.country IN ('Kenya','Uganda')", query)
        self.assertIn("s.pos_location_name IN ('Village Market')", query)

    def test_rate_uses_364_day_churn_and_under_90_day_active_bands(self):
        with mock.patch.object(api_pg, "_rollup_fresh", return_value=True), \
             mock.patch.object(
                 api_pg, "run_query",
                 side_effect=self._record([{
                     "churned_count": 11, "active_count": 8,
                     "base": 20, "churn_rate": 55.0,
                 }])):
            result = api_pg.customers_churn_rate()

        query = self.queries[-1]
        self.assertIn("last_sale <= CURRENT_DATE - INTERVAL '364 days'", query)
        self.assertIn("last_sale > CURRENT_DATE - INTERVAL '90 days'", query)
        self.assertIn("first_sale <= CURRENT_DATE - INTERVAL '364 days'", query)
        self.assertEqual(result["churned_customers"], 11)
        self.assertEqual(result["active_customers"], 8)
        self.assertEqual(result["churn_days"], 364)

    def test_period_events_keep_364_day_churn_and_365_day_return_separate(self):
        with mock.patch.object(
            api_pg, "run_query",
            side_effect=self._record([{"churned_count": 2, "returned_count": 1}]),
        ):
            result = api_pg.customers_churn_events(
                date_from="2026-08-01", date_to="2026-08-31",
                country="Kenya", channel="Village Market", churn_days=30,
            )

        query = self.queries[-1]
        self.assertIn("(d + 364) BETWEEN '2026-08-01'::date AND '2026-08-31'::date", query)
        self.assertIn("(g.d - g.prev_d) >= 365", query)
        self.assertIn("s.country IN ('Kenya')", query)
        self.assertEqual(result["churned_count"], 2)
        self.assertEqual(result["returned_count"], 1)
        self.assertEqual(result["unchurned_count"], 1)  # compatibility alias
        self.assertEqual(result["return_gap_days"], 365)

    def test_at_risk_band_is_exactly_90_through_363(self):
        row = {
            "customer_id": "c-1", "at_risk_total": 1,
            "days_since_last_purchase": 90,
        }
        with mock.patch.object(api_pg, "run_query", side_effect=self._record([row])), \
             mock.patch.object(api_pg, "mask_pii_rows", side_effect=lambda rows, _request: rows):
            result = api_pg.customers_at_risk(
                object(), country="Kenya", channel="Village Market",
                churn_days=30, band_days=5, limit=500,
            )

        query = self.queries[-1]
        self.assertIn("BETWEEN 90 AND 363", query)
        self.assertEqual(result["band_from_days"], 90)
        self.assertEqual(result["band_to_days"], 363)
        self.assertEqual(result["churn_days"], 364)

    def test_recently_returned_is_period_scoped_and_fixed_at_365_days(self):
        expected = [{"customer_id": "c-1", "gap_days": 365}]
        with mock.patch.object(api_pg, "run_query", side_effect=self._record(expected)):
            result = api_pg.analytics_recently_returned(
                date_from="2026-08-01", date_to="2026-08-31",
                country="Kenya", channel="Village Market", min_gap_days=30,
                limit=100,
            )

        query = self.queries[-1]
        self.assertIn("s.sale_date >= '2026-08-01' AND s.sale_date < '2026-09-01'", query)
        self.assertIn("CROSS JOIN LATERAL", query)
        self.assertIn("(p.return_date - prev.prev_order_date) >= 365", query)
        self.assertIn("s.country IN ('Kenya')", query)
        self.assertIn("s.pos_location_name IN ('Village Market')", query)
        self.assertEqual(result, expected)

    def test_legacy_return_route_delegates_to_fixed_handler(self):
        with mock.patch.object(api_pg, "analytics_recently_returned", return_value=[{"ok": True}]) as returned:
            result = api_pg.analytics_recently_unchurned_legacy(
                date_from="2026-08-01", date_to="2026-08-31",
                country="Kenya", channel="Village Market", min_gap_days=30,
            )

        self.assertEqual(result, [{"ok": True}])
        self.assertEqual(returned.call_args.kwargs["min_gap_days"], 30)