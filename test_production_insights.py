"""Contract tests for humane Productivity & Recovery views.

These tests avoid a production database while protecting the metric rules that
must not silently turn missing evidence into performance scores.
"""

import unittest
import inspect
from datetime import date

from fastapi import FastAPI

import production_insights_router as insights


def assignment_row(**overrides):
    row = {
        "plan_version_id": 11,
        "assignment_id": 101,
        "operator_id": 5,
        "operator_name": "Amina",
        "factory_id": 1,
        "factory_name": "Factory One",
        "line_id": 3,
        "line_name": "Line Three",
        "planned_qty": 100,
        "assignment_target_qty": 40,
        "sam_minutes": 2.5,
        "good_qty": 20,
        "reject_qty": 1,
        "rework_qty": 2,
        "qc_defect_qty": 0,
        "qc_rework_qty": 0,
        "downtime_minutes": 15,
        "output_fresh_at": "2026-08-25T10:00:00Z",
        "quality_fresh_at": "2026-08-25T10:00:00Z",
        "downtime_fresh_at": "2026-08-25T10:00:00Z",
        "attended_minutes": 120,
    }
    row.update(overrides)
    return row


class ProductionInsightsContractTests(unittest.TestCase):
    def test_earned_minutes_and_efficiency_use_approved_sam_and_attendance(self):
        metric = insights._metric_row(assignment_row())
        self.assertEqual(metric["earned_minutes"], 50)
        self.assertEqual(metric["attended_minutes"], 120)
        self.assertAlmostEqual(metric["efficiency_pct"], 50 / 120 * 100)
        self.assertEqual(metric["metric_state"], "available")

    def test_missing_output_or_attendance_is_unavailable_not_zero(self):
        missing_output = insights._metric_row(assignment_row(
            good_qty=None, reject_qty=None, rework_qty=None, output_fresh_at=None,
        ))
        self.assertIsNone(missing_output["actual_qty"])
        self.assertIsNone(missing_output["earned_minutes"])
        self.assertIsNone(missing_output["efficiency_pct"])
        self.assertEqual(missing_output["metric_state"], "unavailable")

        missing_attendance = insights._metric_row(assignment_row(attended_minutes=None))
        self.assertIsNone(missing_attendance["efficiency_pct"])
        self.assertEqual(missing_attendance["metric_state"], "unavailable")

    def test_worker_aggregate_deduplicates_attendance_across_assignments(self):
        first = insights._metric_row(assignment_row())
        second = insights._metric_row(assignment_row(
            assignment_id=102, assignment_target_qty=25, good_qty=10,
            reject_qty=0, rework_qty=0,
        ))
        grouped = insights._aggregate(
            [first, second], ("operator_id", "operator_name"), "operator_name",
            worker=True,
        )
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["attended_minutes"], 120)
        self.assertEqual(grouped[0]["earned_minutes"], 75)
        self.assertAlmostEqual(grouped[0]["efficiency_pct"], 75 / 120 * 100)

    def test_routes_include_scoped_productivity_recovery_and_audit(self):
        app = FastAPI()
        insights.register_production_insights_routes(app, object())
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        self.assertIn("/api/production-workspace/productivity", paths)
        self.assertIn("/api/production-workspace/recovery", paths)
        self.assertIn("/api/production-workspace/command-centre", paths)
        self.assertIn("/api/production-workspace/recovery/actions/{action_id}/audit", paths)

    def test_command_centre_line_totals_refuse_partial_execution_or_capacity(self):
        ready = {
            "factory_id": 1, "factory_name": "Factory One",
            "line_id": 3, "line_name": "Line Three", "shift_id": None,
            "shift_name": None, "owner_user_id": "owner-a",
            "planned_qty": 100, "good_qty": 80, "reject_qty": 2, "rework_qty": 3,
            "available_minutes": 600, "required_minutes": 480, "qc_defect_qty": 1,
        }
        incomplete = dict(ready, plan_version_id=12, good_qty=None, reject_qty=None,
                          rework_qty=None, available_minutes=None)
        rows = insights._command_line_rows([ready, incomplete], [])
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["actual_qty"])
        self.assertIsNone(rows[0]["available_minutes"])
        self.assertEqual(rows[0]["metric_state"], "incomplete")
        self.assertIsNone(rows[0]["efficiency_pct"])

    def test_command_contract_keeps_sales_filters_out_of_production_scope(self):
        source = inspect.getsource(insights._command_scope)
        self.assertIn("unsupported_sales_filters", source)
        self.assertIn("Sales filters deliberately do not enter", source)
        self.assertIn("COMMAND_CENTRE_THRESHOLDS", inspect.getsource(insights._command_centre))
        self.assertIn("p.planned_start >= %s AND p.planned_end <= %s",
                      inspect.getsource(insights._command_plan_rows))

    def test_command_plan_query_binds_every_placeholder(self):
        captured = {}
        original_db = insights._db
        try:
            insights._db = lambda query, params, fetch=True: captured.update(
                query=query, params=params, fetch=fetch
            ) or []
            insights._command_plan_rows(date(2026, 8, 1), date(2026, 8, 25), {
                "factory_id": "", "line_id": "", "shift_id": "",
                "owner_user_id": "", "plan_status": "", "stage": "", "search": "",
                "actor": {"role": "admin", "user_id": "test-user"},
            })
        finally:
            insights._db = original_db
        self.assertEqual(captured["query"].count("%s"), len(captured["params"]))

    def test_delivery_scope_binds_shift_and_plan_status(self):
        captured = {}
        original_db = insights._db
        try:
            insights._db = lambda query, params, fetch=True: captured.update(
                query=query, params=params, fetch=fetch
            ) or []
            insights._recovery_candidates(
                date(2026, 8, 1), date(2026, 8, 25), "1", "2", "3", "frozen",
            )
        finally:
            insights._db = original_db
        self.assertIn("p.shift_id", captured["query"])
        self.assertIn("p.status=NULLIF", captured["query"])
        self.assertEqual(captured["query"].count("%s"), len(captured["params"]))
        self.assertEqual(captured["params"][-4:], ["3", "3", "frozen", "frozen"])

    def test_recovery_is_cumulative_as_of_and_sensitive_routes_are_scoped(self):
        self.assertIn("WHERE capture_date <= %s", insights._RECOVERY_SQL)
        self.assertIn("current_wip_available", inspect.getsource(insights._recovery_candidates))
        self.assertIn("outside your coaching context", inspect.getsource(insights._action_update))
        self.assertIn("outside your coaching context", inspect.getsource(insights._action_audit))
        self.assertIn("Redaction happens at the API boundary",
                      inspect.getsource(insights._productivity))


if __name__ == "__main__":
    unittest.main()