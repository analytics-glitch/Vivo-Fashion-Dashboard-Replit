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

    def test_canonical_customer_sales_uses_store_qualified_person_identity(self):
        with mock.patch.object(api_pg, "_customer_identity_snapshot_version",
                               return_value="published-test"):
            sql = api_pg.canonical_customer_sales_cte("s.sale_kind IN ('sale','order')")
        self.assertIn(
            "ci.source_customer_id=s.customer_id::text AND ci.store_id=s.store_id",
            sql,
        )
        self.assertIn("SELECT ci.person_id, s.*", sql)
        self.assertNotIn("ci.person_id AS customer_id, s.*", sql)
        self.assertIn("ci.match_method <> 'pseudo'", sql)
        self.assertIn("identity_snapshot", sql)
        self.assertIn("customer_identity_snapshot:published-test", sql)

    def test_customer_products_accepts_stable_person_id(self):
        with mock.patch.object(api_pg, "run_query", return_value=[]) as run:
            api_pg.get_customer_products(person_id="42", customer_id="")
        self.assertIn("s.person_id = 42", run.call_args.args[0])

    def test_custom_report_customer_cache_tracks_identity_publication(self):
        captured = []

        def record(sql, **_kwargs):
            captured.append(sql)
            return []

        with mock.patch.object(api_pg, "run_query", side_effect=record), \
             mock.patch.object(api_pg, "_customer_identity_snapshot_version",
                               side_effect=["publish-a", "publish-b"]):
            api_pg.custom_report(
                dimensions="country", measures="customers",
                date_from="2026-01-01", date_to="2026-01-31",
                country=None, channel=None, sort=None, sort_dir="desc", limit=500,
            )
            api_pg.custom_report(
                dimensions="country", measures="customers",
                date_from="2026-01-01", date_to="2026-01-31",
                country=None, channel=None, sort=None, sort_dir="desc", limit=500,
            )
        self.assertIn("customer_identity_snapshot:publish-a", captured[0])
        self.assertIn("customer_identity_snapshot:publish-b", captured[1])
        self.assertNotEqual(captured[0], captured[1])

    def test_customer_type_spend_keeps_walkins_outside_person_counts(self):
        with mock.patch.object(api_pg, "run_query", return_value=[]) as run:
            api_pg.get_customer_type_spend(
                "2026-01-01", "2026-01-31", None, None)
        sql = run.call_args.args[0]
        self.assertIn("UNION ALL", sql)
        self.assertIn("'Walk-in'", sql)
        self.assertIn("ci.person_id IS NULL", sql)
        self.assertIn("ci.match_method='pseudo'", sql)
        self.assertIn("COUNT(DISTINCT person_id)", sql)
        self.assertIn("COUNT(DISTINCT order_key)", sql)

    def test_sales_export_resolves_store_qualified_person_id(self):
        with mock.patch.object(api_pg, "run_query", return_value=[]) as run, \
             mock.patch.object(api_pg, "_customer_identity_snapshot_version",
                               return_value="export-v1"):
            api_pg.get_orders(
                "2026-01-01", "2026-01-31", None, None, None, None, 1000, 0)
        sql = run.call_args.args[0]
        self.assertIn(
            "ci.source_customer_id=s.customer_id::text", sql)
        self.assertIn("ci.store_id=s.store_id", sql)
        self.assertIn("ci.person_id END AS person_id", sql)
        self.assertIn("customer_identity_snapshot:export-v1", sql)

    def test_customer_migration_register_covers_public_person_surfaces(self):
        register = api_pg.CUSTOMER_GRAIN_MIGRATION_REGISTER
        for route in ("/api/custom-report?measure=customers", "/api/customers",
                      "/api/analytics/rfm", "/api/analytics/customer-details",
                      "/api/analytics/customer-crosswalk"):
            self.assertIn(route, register)
            self.assertTrue(register[route].startswith("person"))

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
        with mock.patch.object(
                  api_pg, "_customer_identity_snapshot_version",
                  return_value="churn-v1"), \
             mock.patch.object(
                 api_pg, "run_query",
                 side_effect=self._record([{
                     "churned_count": 11, "active_count": 8,
                     "base": 20, "churn_rate": 55.0,
                 }])):
            result = api_pg.customers_churn_rate()

        query = self.queries[-1]
        self.assertIn("FROM customer_people", query)
        self.assertIn("last_purchase <= CURRENT_DATE", query)
        self.assertIn("INTERVAL '364 days'", query)
        self.assertIn("last_purchase > CURRENT_DATE", query)
        self.assertIn("INTERVAL '90 days'", query)
        self.assertIn("first_purchase <= CURRENT_DATE", query)
        self.assertIn("is_pseudo IS NOT TRUE", query)
        self.assertIn("customer_identity_snapshot:churn-v1", query)
        self.assertEqual(result["churned_customers"], 11)
        self.assertEqual(result["active_customers"], 8)
        self.assertEqual(result["churn_days"], 364)

    def test_new_customer_products_uses_person_first_purchase(self):
        with mock.patch.object(api_pg, "cache_get_swr",
                               return_value=(None, False)), \
             mock.patch.object(api_pg, "cache_set"), \
             mock.patch.object(api_pg, "run_query",
                               side_effect=self._record([])), \
             mock.patch.object(api_pg, "_customer_identity_snapshot_version",
                               return_value="products-v1"):
            api_pg.get_new_customer_products(
                "2026-01-01", "2026-01-31", None, None, 20)
        query = self.queries[-1]
        self.assertIn("FROM customer_people", query)
        self.assertIn("first_purchase BETWEEN", query)
        self.assertIn("s.person_id IN (SELECT person_id", query)
        self.assertNotIn("rollup_customer_first_purchase", query)

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
        self.assertIn("WITH candidate_activity AS", query)
        self.assertIn("s.sale_date >=", query)
        self.assertIn("ci.source_customer_id=s.customer_id::text", query)
        self.assertIn("ci.store_id=s.store_id", query)
        self.assertIn("FROM candidate_activity ca", query)
        self.assertIn("GROUP BY ci.person_id", query)
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