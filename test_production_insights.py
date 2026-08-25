"""Contract tests for humane Productivity & Recovery views.

These tests avoid a production database while protecting the metric rules that
must not silently turn missing evidence into performance scores.
"""

import unittest
import inspect

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
        self.assertIn("/api/production-workspace/recovery/actions/{action_id}/audit", paths)

    def test_recovery_is_cumulative_as_of_and_sensitive_routes_are_scoped(self):
        self.assertIn("WHERE capture_date <= %s", insights._RECOVERY_SQL)
        self.assertIn("current_wip_available", inspect.getsource(insights._recovery_candidates))
        self.assertIn("outside your coaching context", inspect.getsource(insights._action_update))
        self.assertIn("outside your coaching context", inspect.getsource(insights._action_audit))
        self.assertIn("Redaction happens at the API boundary",
                      inspect.getsource(insights._productivity))


if __name__ == "__main__":
    unittest.main()