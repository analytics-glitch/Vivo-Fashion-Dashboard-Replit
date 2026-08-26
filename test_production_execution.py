"""Focused safeguards for Production Execution Capture.

The database-backed workspace suite owns transaction integration coverage.  These
tests hold the lightweight public contract that protects supervisors from
overspend, duplicate retry writes, and accidental tracker-stage mutations.
"""

import inspect
from pathlib import Path
import unittest

from fastapi import FastAPI

import production_workspace as workspace


class ProductionExecutionCaptureTests(unittest.TestCase):
    def test_controlled_taxonomy_requires_active_codes_and_returns_immutable_snapshots(self):
        class CatalogueCursor:
            def __init__(self, row):
                self.row = row
                self.query = ""

            def execute(self, query, params):
                self.query = query

            def fetchone(self):
                return self.row

        active = CatalogueCursor({"id": 12, "code": "QC-01", "name": "Open seam"})
        snapshot, error = workspace._execution_catalogue_snapshot(
            active, "qc_defect", {"defect_code_id": "12"})
        self.assertIsNone(error)
        self.assertEqual(snapshot, {
            "defect_code_id": 12,
            "defect_code": "QC-01",
            "defect_code_name": "Open seam",
        })
        self.assertIn("production_workspace_defect_codes", active.query)
        self.assertIn("AND active", active.query)

        inactive = CatalogueCursor(None)
        snapshot, error = workspace._execution_catalogue_snapshot(
            inactive, "downtime", {"downtime_reason_id": "404"})
        self.assertIsNone(snapshot)
        self.assertEqual(error.status_code, 409)
        self.assertIn(b"inactive", error.body)

    def test_output_payload_reconciles_and_requires_a_retry_key(self):
        payload = workspace._execution_output_payload({
            "capture_kind": "hourly",
            "hour_no": 8,
            "planned_qty": 40,
            "good_qty": 35,
            "reject_qty": 2,
            "rework_qty": 3,
            "capture_key": "shift-a-8",
        })
        self.assertEqual(payload["capture_kind"], "hourly")
        self.assertEqual(payload["hour_no"], 8)
        with self.assertRaisesRegex(ValueError, "cannot exceed"):
            workspace._execution_output_payload({
                "capture_kind": "shift",
                "planned_qty": 10,
                "good_qty": 8,
                "reject_qty": 2,
                "rework_qty": 1,
                "capture_key": "overspend",
            })
        with self.assertRaisesRegex(ValueError, "capture_key"):
            workspace._execution_output_payload({
                "capture_kind": "shift",
                "planned_qty": 10,
                "good_qty": 10,
            })

    def test_execution_events_are_additive_and_wip_is_transition_checked(self):
        event_source = inspect.getsource(workspace._execution_event_create)
        output_source = inspect.getsource(workspace._execution_output_create)
        bulk_source = inspect.getsource(workspace._execution_bulk_commit)
        self.assertIn("production_workspace_execution_events", event_source)
        self.assertIn("allowed_next", event_source)
        self.assertIn("stage_movement_id", event_source)
        self.assertIn("stage_movement_id are required for WIP", event_source)
        self.assertIn("This event key already belongs to different values", event_source)
        self.assertIn("existing[\"operation_id\"]", event_source)
        self.assertIn("_execution_catalogue_snapshot", event_source)
        self.assertIn("defect_code_id,defect_code,defect_code_name", event_source)
        self.assertIn("downtime_reason_id,downtime_reason_code,downtime_reason_name", event_source)
        context_source = inspect.getsource(workspace._execution_context)
        self.assertIn("workspace_execution_operation_mismatch", context_source)
        self.assertIn("WHERE id=%s AND plan_version_id=%s", context_source)
        self.assertNotIn("INSERT INTO stage_movements", event_source)
        self.assertNotIn("INSERT INTO stage_movements", output_source)
        self.assertIn("production_workspace_execution_batches", bulk_source)
        self.assertIn("payload_hash", bulk_source)
        self.assertIn("prepared = []", bulk_source)
        self.assertIn("ExecutionBulkValidationError", bulk_source)
        self.assertIn("Check the durable idempotency marker before preview", bulk_source)
        self.assertLess(
            bulk_source.index("Check the durable idempotency marker before preview"),
            bulk_source.index("_execution_bulk_preview(request, body)"),
        )
        self.assertLess(
            bulk_source.index("prepared = []"),
            bulk_source.index("INSERT INTO production_workspace_execution_batches"),
        )
        output_insert = bulk_source[
            bulk_source.index("INSERT INTO production_workspace_execution_output"):
            bulk_source.index("RETURNING *", bulk_source.index("INSERT INTO production_workspace_execution_output"))
        ]
        self.assertEqual(output_insert.count("%s"), 20)

    def test_routes_expose_worklist_corrections_events_and_atomic_bulk(self):
        app = FastAPI()
        workspace.register_production_workspace_routes(app, workspace._API)
        routes = {route.path: route for route in app.routes if hasattr(route, "path")}
        required = {
            "/api/production-workspace/execution/worklist",
            "/api/production-workspace/execution/summary",
            "/api/production-workspace/execution/output",
            "/api/production-workspace/execution/output/{output_id}",
            "/api/production-workspace/execution/events",
            "/api/production-workspace/execution/events/{event_id}",
            "/api/production-workspace/execution/bulk/preview",
            "/api/production-workspace/execution/bulk/commit",
        }
        self.assertTrue(required.issubset(routes))
        self.assertIn("expected_version", inspect.getsource(workspace._execution_output_update))
        self.assertIn("expected_version", inspect.getsource(workspace._execution_event_update))
        self.assertIn("EXECUTION_OUTPUT_ROLES", inspect.getsource(workspace._execution_output_create))

    def test_optional_plan_context_is_explicitly_nullable(self):
        schema = Path("production_tracker_schema.sql").read_text()
        self.assertGreaterEqual(schema.count("line_id         BIGINT NULL REFERENCES production_workspace_lines"), 2)
        self.assertGreaterEqual(schema.count("shift_id        BIGINT NULL REFERENCES production_workspace_shifts"), 2)
        self.assertGreaterEqual(schema.count("operation_id    BIGINT NULL REFERENCES production_workspace_operations"), 2)
        self.assertIn("defect_code_id  BIGINT REFERENCES production_workspace_defect_codes", schema)
        self.assertIn("downtime_reason_id BIGINT REFERENCES production_workspace_downtime_reasons", schema)

    def test_execution_ui_selects_controlled_codes_and_displays_saved_snapshots(self):
        source = Path("artifacts/vivo-bi/src/pages/ProductionExecution.jsx").read_text()
        quality_source = Path("artifacts/vivo-bi/src/pages/ProductionWorkspaceHub.jsx").read_text()
        self.assertIn('label="Defect code"', source)
        self.assertIn('label="Downtime reason"', source)
        self.assertIn("defect_code_id: type ===", source)
        self.assertIn("downtime_reason_id: type ===", source)
        self.assertIn("e.defect_code || e.downtime_reason_code", source)
        self.assertIn("item.defect_code_name || item.defect_code", quality_source)


if __name__ == "__main__":
    unittest.main()