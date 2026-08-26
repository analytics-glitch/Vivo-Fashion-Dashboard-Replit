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

    def test_privacy_payload_removes_all_plan_and_revision_identity_fields(self):
        payload = {
            "plan": {"owner_user_id": "owner", "approved_by": "approver",
                     "frozen_by": "freezer"},
            "workflow_revisions": [{"changed_by": "reviewer"}],
            "audit": [{"actor_user_id": "actor", "actor_name": "Actor"}],
        }
        safe = workspace._privacy_safe_workspace_payload(request_for("quality"), payload)
        self.assertNotIn("owner_user_id", safe["plan"])
        self.assertNotIn("approved_by", safe["plan"])
        self.assertNotIn("frozen_by", safe["plan"])
        self.assertNotIn("changed_by", safe["workflow_revisions"][0])
        self.assertNotIn("actor_user_id", safe["audit"][0])
        self.assertNotIn("actor_name", safe["audit"][0])

    def test_quality_and_product_users_receive_redacted_execution_worklists(self):
        row = {
            "plan_version_id": 1, "style_number": "VIVO-1",
            "operator_id": 9, "operator_name": "Staff Member",
            "operator_code": "OP-9", "assignment_id": 3,
        }
        for role in ("quality", "product_development"):
            with self.subTest(role=role), \
                    patch.object(workspace, "_ensure_schema"), \
                    patch.object(workspace, "_require_role", return_value=None), \
                    patch.object(workspace, "_db", return_value=[row]):
                result = workspace._execution_worklist(request_for(role), "2099-01-01")
            worklist_row = result["worklist"][0]
            self.assertNotIn("operator_id", worklist_row)
            self.assertNotIn("operator_name", worklist_row)
            self.assertNotIn("operator_code", worklist_row)

    def test_production_worklist_uses_owner_or_assignee_scope(self):
        calls = []
        def fake_db(query, params=None, fetch=False):
            calls.append((query, params))
            return []
        with patch.object(workspace, "_ensure_schema"), \
                patch.object(workspace, "_require_role", return_value=None), \
                patch.object(workspace, "_db", side_effect=fake_db):
            workspace._execution_worklist(request_for("production"), "2099-01-01")
        query, params = calls[0]
        self.assertIn("p.owner_user_id=%s", query)
        self.assertIn("uo.user_id=%s", query)
        self.assertEqual(params[2], "production")

    def test_unassigned_production_user_cannot_read_plan_derived_bypasses(self):
        with patch.object(workspace, "_ensure_schema"), \
                patch.object(workspace, "_require_role", return_value=None), \
                patch.object(workspace, "_plan_is_visible", return_value=False), \
                patch.object(workspace, "_audit_entity_is_visible", return_value=False):
            feasibility = workspace._plan_feasibility(99, request_for("production"))
            timeline = workspace._audit_timeline("plan_version", "99", request_for("production"))
        self.assertIsInstance(feasibility, JSONResponse)
        self.assertEqual(feasibility.status_code, 404)
        self.assertIsInstance(timeline, JSONResponse)
        self.assertEqual(timeline.status_code, 404)

    def test_tracker_references_query_applies_plan_visibility_predicate(self):
        calls = []
        def fake_db(query, params=None, fetch=False):
            calls.append((query, params))
            return []
        with patch.object(workspace, "_ensure_schema"), \
                patch.object(workspace, "_require_role", return_value=None), \
                patch.object(workspace, "_db", side_effect=fake_db):
            result = workspace._tracker_references(request_for("production"))
        self.assertEqual(result["orders"], [])
        order_query, params = calls[0]
        self.assertIn("production_workspace_plan_versions p", order_query)
        self.assertIn("wi.production_order_ref=po.order_ref", order_query)
        self.assertIn("p.owner_user_id=%s", order_query)
        self.assertEqual(params[0], "production")

    def test_work_item_latest_plan_cannot_leak_a_newer_inaccessible_revision(self):
        calls = []
        def fake_db(query, params=None, fetch=False):
            calls.append((query, params))
            # This is the only revision that an older visible plan may expose;
            # the SQL, not a response-side filter, must reject a newer private one.
            return [{"id": 71, "latest_plan_id": 3, "latest_plan_version": 1,
                     "latest_plan_status": "draft", "latest_plan_token": 4}]
        with patch.object(workspace, "_ensure_schema"), \
                patch.object(workspace, "_require_role", return_value=None), \
                patch.object(workspace, "_db", side_effect=fake_db):
            result = workspace._work_items(request_for("production"))
        self.assertEqual(result["work_items"][0]["latest_plan_id"], 3)
        query, params = calls[0]
        lateral = query.split("LEFT JOIN LATERAL", 1)[1].split(") latest ON TRUE", 1)[0]
        self.assertIn("p.work_item_id=wi.id AND (p.owner_user_id=%s", lateral)
        self.assertIn("scoped_operator.active", lateral)
        # LATERAL predicate parameters precede the outer role and EXISTS scope.
        self.assertEqual(params, ["user-1", "user-1", "production", "user-1", "user-1"])


if __name__ == "__main__":
    unittest.main()