"""Focused contract tests for the fixed Online September 2026 campaign."""

import unittest
from datetime import date as real_date
from unittest import mock

from fastapi import HTTPException

import api_pg


class _FakeDate(real_date):
    current = real_date(2026, 9, 3)

    @classmethod
    def today(cls):
        return cls.current


class OnlineSeptemberCampaignTests(unittest.TestCase):
    def _snapshot(self, today, achieved=3_000_000):
        _FakeDate.current = today
        with (
            mock.patch.object(api_pg, "date", _FakeDate),
            mock.patch.object(
                api_pg,
                "run_query",
                side_effect=[
                    [{"goal_kes": 10_000_000}],
                    [{"achieved_kes": achieved}],
                ],
            ) as query,
        ):
            payload = api_pg.analytics_online_september("2026-09-01")
        return payload, query.call_args_list

    def test_active_snapshot_uses_fixed_window_and_online_canonical_revenue(self):
        payload, calls = self._snapshot(real_date(2026, 9, 10))

        self.assertEqual(payload["month_start"], "2026-09-01")
        self.assertEqual(payload["month_end"], "2026-09-30")
        self.assertEqual(payload["as_of"], "2026-09-10")
        self.assertEqual(payload["goal_kes"], 10_000_000)
        self.assertEqual(payload["reward_kes"], 5_000)
        self.assertEqual(payload["achieved_kes"], 3_000_000)
        self.assertEqual(payload["progress_pct"], 30.0)
        self.assertEqual(payload["remaining_kes"], 7_000_000)
        self.assertEqual(payload["days_elapsed"], 10)
        self.assertEqual(payload["days_remaining"], 20)
        self.assertEqual(payload["projected_landing_kes"], 9_000_000)
        self.assertTrue(payload["projection_meaningful"])

        actual_sql = calls[1].args[0]
        self.assertIn("BETWEEN '2026-09-01' AND '2026-09-10'", actual_sql)
        self.assertIn("s.country = 'Online'", actual_sql)
        self.assertIn("s.pos_location_name ILIKE '%online%'", actual_sql)
        self.assertIn("s.sale_kind IN ('sale','order','return')", actual_sql)
        self.assertIn("s.total_sales_kes::numeric", actual_sql)
        self.assertIn("COALESCE(s.discounts_kes, 0)::numeric", actual_sql)
        self.assertIn("s.returns_kes::numeric", actual_sql)

    def test_prestart_is_zero_without_querying_outside_september(self):
        _FakeDate.current = real_date(2026, 8, 31)
        with (
            mock.patch.object(api_pg, "date", _FakeDate),
            mock.patch.object(
                api_pg,
                "run_query",
                return_value=[{"goal_kes": 10_000_000}],
            ) as query,
        ):
            payload = api_pg.analytics_online_september("2026-09-01")

        self.assertEqual(query.call_count, 1)
        self.assertEqual(payload["status"], "prestart")
        self.assertEqual(payload["achieved_kes"], 0)
        self.assertEqual(payload["days_elapsed"], 0)
        self.assertEqual(payload["days_remaining"], 30)
        self.assertIsNone(payload["projected_landing_kes"])
        self.assertFalse(payload["projection_meaningful"])

    def test_closed_snapshot_caps_actuals_at_month_end(self):
        payload, calls = self._snapshot(
            real_date(2026, 10, 5), achieved=8_500_000,
        )

        self.assertEqual(payload["status"], "closed")
        self.assertEqual(payload["as_of"], "2026-09-30")
        self.assertEqual(payload["days_elapsed"], 30)
        self.assertEqual(payload["days_remaining"], 0)
        self.assertIsNone(payload["projected_landing_kes"])
        self.assertIn("BETWEEN '2026-09-01' AND '2026-09-30'",
                      calls[1].args[0])

    def test_goal_row_is_isolated_from_finance_budget(self):
        campaign = api_pg._ONLINE_SEPTEMBER_CAMPAIGN
        self.assertEqual(campaign["scope"], "campaign")
        self.assertEqual(campaign["source"], "online_september_2026")
        self.assertEqual(campaign["goal_kes"], 10_000_000)
        self.assertNotEqual(campaign["scope"], "region")
        self.assertNotEqual(campaign["source"], "budget")

    def test_missing_configuration_is_explicit_not_zero_progress(self):
        with mock.patch.object(api_pg, "run_query", return_value=[]):
            with self.assertRaises(HTTPException) as error:
                api_pg.analytics_online_september("2026-09-01")
        self.assertEqual(error.exception.status_code, 404)
        self.assertIn("not configured", error.exception.detail)

    def test_unavailable_actuals_returns_clear_service_error(self):
        _FakeDate.current = real_date(2026, 9, 10)
        with (
            mock.patch.object(api_pg, "date", _FakeDate),
            mock.patch.object(
                api_pg,
                "run_query",
                side_effect=[
                    [{"goal_kes": 10_000_000}],
                    RuntimeError("database unavailable"),
                ],
            ),
        ):
            with self.assertRaises(HTTPException) as error:
                api_pg.analytics_online_september("2026-09-01")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("sales data is unavailable", error.exception.detail)

    def test_other_month_is_rejected(self):
        with self.assertRaises(HTTPException) as error:
            api_pg.analytics_online_september("2026-10-01")
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("only available for September 2026",
                      error.exception.detail)


if __name__ == "__main__":
    unittest.main()