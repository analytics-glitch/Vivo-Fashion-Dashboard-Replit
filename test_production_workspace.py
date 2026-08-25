"""Focused contracts for the additive Production Workspace foundation.

These tests deliberately avoid a live production database. They cover the
workflow/authorization contract and verify the idempotent SQL shape that the
deferred startup hook executes against the same database as the legacy tracker.
"""

import inspect
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from starlette.requests import Request
from starlette.responses import JSONResponse

import production_workspace as workspace


def request_for(role):
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/production-workspace",
        "headers": [],
        "state": {"user": {"user_id": "user-1", "name": "Test User", "role": role}},
    })


class FakeApi:
    def __init__(self):
        self.schema_calls = []

    def _users_exec(self, query, params=None, fetch=False):
        self.schema_calls.append(query)
        return []


class MutationCursor:
    """Strict cursor double: a result must be consumed before the next query."""

    def __init__(self):
        self.pending = None
        self.audit_after_json = []
        self.audit_count = 0

    def execute(self, query, params=None):
        query = " ".join(query.split())
        if query.startswith("SELECT * FROM production_workspace_readiness_gates"):
            self.pending = {"id": 22, "status": "pending", "version_token": 1}
        elif query.startswith("UPDATE production_workspace_readiness_gates"):
            self.pending = {"id": 22, "status": "passed", "version_token": 2}
        elif query.startswith("SELECT * FROM production_workspace_operation_definitions"):
            self.pending = {
                "id": 41, "operation_code": "CUT", "name": "Cutting",
                "default_sam_minutes": 1, "capability_id": None, "status": "approved",
            }
        elif query.startswith("INSERT INTO production_workspace_operations"):
            self.pending = {"id": 31, "operation_code": "CUT"}
        elif query.startswith("INSERT INTO production_workspace_assignments"):
            self.pending = {"id": 32, "assignment_role": "operator"}
        elif query.startswith("INSERT INTO production_workspace_capacity_inputs"):
            self.pending = {"id": 33, "available_minutes": 60}
        elif query.startswith("SELECT calendar_date,capacity_minutes FROM production_workspace_calendars"):
            self.pending = {"calendar_date": "2099-01-01", "capacity_minutes": 120}
        elif query.startswith("SELECT ci.available_minutes FROM production_workspace_capacity_inputs"):
            self.pending = []
        elif query.startswith("UPDATE production_workspace_plan_versions"):
            self.pending = {"id": 1, "version_token": 2}
        elif query.startswith("INSERT INTO production_workspace_audit_events"):
            self.audit_after_json.append(params[7])
            self.audit_count += 1
            self.pending = {"id": self.audit_count, "occurred_at": None}
        else:
            raise AssertionError(f"Unexpected workspace mutation query: {query}")

    def fetchone(self):
        if self.pending is None:
            raise AssertionError("The previous cursor result was not available to consume")
        result, self.pending = self.pending, None
        return result

    def fetchall(self):
        if self.pending is None:
            raise AssertionError("The previous cursor result was not available to consume")
        result, self.pending = self.pending, None
        return result


class FakeTransaction:
    def __init__(self, cursor):
        self.cursor = cursor

    def __enter__(self):
        return self.cursor

    def __exit__(self, exc_type, exc, tb):
        return False


class ProductionWorkspaceFoundationTests(unittest.TestCase):
    def setUp(self):
        self.original_api = workspace._API
        self.original_ready = workspace._SCHEMA_READY
        workspace._API = FakeApi()
        workspace._SCHEMA_READY = False

    def tearDown(self):
        workspace._API = self.original_api
        workspace._SCHEMA_READY = self.original_ready

    def test_schema_bootstrap_is_additive_and_idempotent_shape(self):
        workspace.ensure_production_workspace_tables()
        sql = workspace._API.schema_calls[-1]
        self.assertIn("CREATE TABLE IF NOT EXISTS production_workspace_factories", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS production_workspace_plan_versions", sql)
        self.assertIn("production_orders(order_ref)", sql)
        self.assertIn("stage_movements(id)", sql)
        self.assertNotIn("TRUNCATE production_orders", sql)
        self.assertNotIn("DELETE FROM production_orders", sql)
        self.assertIn("CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_capacity_grain", sql)
        self.assertIn("plan_version_id  BIGINT NOT NULL", sql)
        self.assertIn("uq_workspace_reopened_source", sql)
        self.assertIn("production_workspace_plan_input_mutable", sql)
        self.assertIn("production_workspace_assignment_operation_matches_plan", sql)
        self.assertIn("production_workspace_plan_scope_guard", sql)
        self.assertIn("production_workspace_master_scope_guard", sql)
        self.assertIn("production_workspace_factory_owner_immutable", sql)
        self.assertIn("Plan factory, line and shift are locked after planning inputs are added", sql)
        plan_scope = sql.split("CREATE OR REPLACE FUNCTION production_workspace_plan_scope_guard()", 1)[1]
        self.assertIn("SELECT 1 FROM production_workspace_changeovers", plan_scope)
        self.assertIn("UPDATE OF factory_id, line_id, shift_id, planned_start, planned_end", sql)
        self.assertIn("UPDATE OF plan_version_id, operation_id, operator_id, line_id, machine_id", sql)

        workspace._SCHEMA_READY = False
        workspace.ensure_production_workspace_tables()
        self.assertEqual(len(workspace._API.schema_calls), 2)

    def test_workflow_only_permits_governed_transitions(self):
        self.assertEqual(workspace.VALID_TRANSITIONS["draft"], ("submitted",))
        self.assertEqual(workspace.VALID_TRANSITIONS["submitted"], ("approved",))
        self.assertEqual(workspace.VALID_TRANSITIONS["approved"], ("frozen",))
        self.assertEqual(workspace.VALID_TRANSITIONS["frozen"], ("reopened",))
        self.assertEqual(workspace.VALID_TRANSITIONS["reopened"], ("submitted",))
        self.assertNotIn("frozen", workspace.VALID_TRANSITIONS["draft"])

    def test_role_fence_distinguishes_view_plan_and_approval(self):
        self.assertIsNone(workspace._require_role(
            request_for("quality"), workspace.VIEW_ROLES, "viewing"))
        self.assertIsInstance(workspace._require_role(
            request_for("quality"), workspace.PLANNER_ROLES, "planning"), JSONResponse)
        self.assertIsNone(workspace._require_role(
            request_for("production"), workspace.PLANNER_ROLES, "planning"))
        self.assertIsNone(workspace._require_role(
            request_for("leadership"), workspace.APPROVER_ROLES, "approval"))
        self.assertIsInstance(workspace._require_role(
            request_for("product_development"), workspace.APPROVER_ROLES, "approval"), JSONResponse)

    def test_planner_cannot_mutate_another_planners_plan(self):
        plan = {"owner_user_id": "planner-1"}
        self.assertTrue(workspace._can_manage_plan(
            {"role": "production", "user_id": "planner-1"}, plan))
        self.assertFalse(workspace._can_manage_plan(
            {"role": "production", "user_id": "planner-2"}, plan))
        self.assertTrue(workspace._can_manage_plan(
            {"role": "admin", "user_id": "admin-1"}, plan))

    def test_stale_conflict_is_clear_and_recoverable(self):
        response = workspace._version_error(3, 4)
        self.assertEqual(response.status_code, 409)
        self.assertIn(b"Refresh and retry", response.body)
        self.assertIn(b"stale_workspace_edit", response.body)

    def test_audit_captures_actor_reason_and_before_after(self):
        calls = []

        class Cursor:
            def execute(self, query, params):
                calls.append((query, params))

            def fetchone(self):
                return {"id": 9, "occurred_at": "2026-08-25T10:00:00Z"}

        workspace._audit(
            Cursor(), "plan_version", 7, "updated",
            {"user_id": "planner-1", "name": "Planner"},
            "Corrected the approved quantity",
            before={"version_token": 2}, after={"version_token": 3},
            request_id="request-1",
        )
        params = calls[0][1]
        self.assertEqual(params[3], "planner-1")
        self.assertEqual(params[5], "Corrected the approved quantity")
        self.assertIn('"version_token": 2', params[6])
        self.assertIn('"version_token": 3', params[7])

    def test_registered_routes_accept_json_bodies_not_query_only_mutations(self):
        app = FastAPI()
        workspace.register_production_workspace_routes(app, workspace._API)
        routes = {route.path: route for route in app.routes if hasattr(route, "path")}
        self.assertIn("/api/production-workspace/plans/{plan_id}/submit", routes)
        endpoint = routes["/api/production-workspace/plans/{plan_id}/submit"].endpoint
        self.assertIn("body", endpoint.__annotations__)

    def test_revision_inputs_and_tracker_reference_use_safe_contracts(self):
        detail_source = inspect.getsource(workspace._plan_detail_from_cur)
        reopen_source = inspect.getsource(workspace._plan_reopen)
        tracker_source = inspect.getsource(workspace._tracker_references)
        self.assertIn("WHERE plan_version_id=%s ORDER BY sequence_no", detail_source)
        self.assertIn("production_workspace_operations", reopen_source)
        self.assertIn("production_workspace_assignments", reopen_source)
        self.assertIn("production_workspace_capacity_inputs", reopen_source)
        self.assertNotIn("version_token=version_token+1", reopen_source)
        self.assertIn("product_name AS style_name", tracker_source)
        self.assertIn("NULL::text AS bo_state", tracker_source)
        assignment_source = inspect.getsource(workspace._assignment_create)
        self.assertIn("plan_version_id=%s FOR UPDATE", assignment_source)
        self.assertIn("workspace_assignment_operation_mismatch", assignment_source)
        self.assertIn("workspace_scope_mismatch", assignment_source)
        plan_source = inspect.getsource(workspace._plan_create)
        capacity_source = inspect.getsource(workspace._capacity_create)
        self.assertIn("_scope_relationship_error", plan_source)
        self.assertIn("_scope_relationship_error", capacity_source)
        self.assertIn("plan.get(\"line_id\")", assignment_source)
        self.assertIn("workspace_plan_context_locked", inspect.getsource(workspace._plan_update))

    def test_plan_input_mutations_capture_the_plan_row_before_audit_queries(self):
        for handler in (
            workspace._gate_update,
            workspace._operation_create,
            workspace._assignment_create,
            workspace._capacity_create,
        ):
            source = inspect.getsource(handler)
            self.assertIn("plan_after = cur.fetchone()", source)
            self.assertIn("after=plan_after", source)

    def test_plan_input_mutations_complete_when_audit_consumes_cursor_results(self):
        plan = {
            "id": 1, "work_item_id": 7, "factory_id": 4, "line_id": 5,
            "shift_id": 6, "owner_user_id": "user-1", "status": "draft",
            "version_token": 1, "planned_start": "2099-01-01",
            "planned_end": "2099-01-01",
        }
        cases = (
            (workspace._gate_update, (1, "quality"), {
                "status": "passed", "expected_version": 1, "reason": "quality cleared",
                "owner_user_id": "quality-owner", "due_date": "2099-01-01",
            }),
            (workspace._operation_create, (1,), {
                "operation_definition_id": 41, "sequence_no": 1,
                "expected_version": 1, "reason": "add operation",
            }),
            (workspace._assignment_create, (1,), {
                "planned_minutes": 60, "expected_version": 1, "reason": "assign operator",
            }),
            (workspace._capacity_create, (1,), {
                "calendar_id": 9, "available_minutes": 60, "required_minutes": 45,
                "expected_version": 1, "reason": "set capacity",
            }),
        )
        for handler, prefix_args, body in cases:
            cursor = MutationCursor()
            with self.subTest(handler=handler.__name__), \
                    patch.object(workspace, "_ensure_schema"), \
                    patch.object(workspace, "_require_role", return_value=None), \
                    patch.object(workspace, "_require_mutable_plan",
                                 return_value=(dict(plan), None)), \
                    patch.object(workspace, "_scope_relationship_error", return_value=None), \
                    patch.object(workspace, "_plan_detail", return_value={"id": 1}), \
                    patch.object(workspace, "_tx", return_value=FakeTransaction(cursor)):
                result = handler(*prefix_args, request_for("production"), body)
            self.assertEqual(result["record"]["id"], 1)
            self.assertEqual(cursor.audit_count, 2)
            self.assertIn('"version_token": 2', cursor.audit_after_json[-1])

    def test_bulk_import_rejects_approved_governed_master_records(self):
        class ApprovedMasterCursor:
            def execute(self, query, params=None):
                self.query = " ".join(query.split())

            def fetchone(self):
                self.assert_called = True
                return {"status": "approved"}

        preview = {
            "valid": True,
            "rows": [{"values": {
                "operation_code": "CUT", "name": "Cutting", "default_sam_minutes": 1,
                "capability_id": None, "active": True, "status": "draft",
            }}],
        }
        cursor = ApprovedMasterCursor()
        with patch.object(workspace, "_bulk_validate", return_value=preview), \
                patch.object(workspace, "_ensure_schema"), \
                patch.object(workspace, "_require_role", return_value=None), \
                patch.object(workspace, "_tx", return_value=FakeTransaction(cursor)):
            result = workspace._bulk_import(
                "operation_definitions", request_for("production"),
                {"rows": preview["rows"], "reason": "load definitions"},
            )
        self.assertIsInstance(result, JSONResponse)
        self.assertEqual(result.status_code, 409)


if __name__ == "__main__":
    unittest.main()