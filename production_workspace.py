#!/usr/bin/env python3
"""Production Workspace foundation API.

This is an additive planning domain for the existing Production Pipeline.  It
owns factory/planning records and immutable workflow history, while linking to
the existing Odoo-backed production_orders, production_stages,
stage_movements, and app_users records.  It intentionally does not write to
the legacy tracker ledger.
"""

import json
import csv
import io
import logging
import os
import threading
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from fastapi import Body, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("production_workspace")

_API = None
_SCHEMA_READY = False
_SCHEMA_LOCK = threading.Lock()

WORKSPACE_SCHEMA_VERSION = "1"
PLAN_STATUSES = ("draft", "submitted", "approved", "frozen", "reopened")
PLAN_STATUS_LABELS = {
    "draft": "Draft",
    "submitted": "Submitted",
    "approved": "Approved",
    "frozen": "Frozen",
    "reopened": "Reopened",
}
VALID_TRANSITIONS = {
    "draft": ("submitted",),
    "submitted": ("approved",),
    "approved": ("frozen",),
    "frozen": ("reopened",),
    "reopened": ("submitted",),
}
VIEW_ROLES = {
    "admin", "production", "product_development", "quality",
    "fabric_quality_supervisor", "leadership", "smt",
}
PLANNER_ROLES = {"admin", "production"}
APPROVER_ROLES = {"admin", "leadership", "smt"}

_CATALOGUE_TABLES = {
    "factories": "production_workspace_factories",
    "lines": "production_workspace_lines",
    "shifts": "production_workspace_shifts",
    "calendars": "production_workspace_calendars",
    "machines": "production_workspace_machines",
    "capabilities": "production_workspace_capabilities",
    "operators": "production_workspace_operators",
    "skills": "production_workspace_skills",
    "operation_definitions": "production_workspace_operation_definitions",
    "targets": "production_workspace_targets",
}
_CATALOGUE_COLUMNS = {
    "factories": ("code", "name", "timezone", "active"),
    "lines": ("factory_id", "code", "name", "active"),
    "shifts": ("factory_id", "code", "name", "start_time", "end_time", "active"),
    "calendars": ("factory_id", "calendar_date", "shift_id", "capacity_minutes", "day_status"),
    "machines": ("factory_id", "line_id", "code", "name", "active"),
    "capabilities": ("machine_id", "line_id", "capability_key", "name", "active"),
    "operators": ("user_id", "operator_code", "display_name", "active"),
    "skills": ("skill_key", "name", "active"),
    "operation_definitions": ("operation_code", "name", "default_sam_minutes", "capability_id", "active", "status"),
    "targets": ("factory_id", "line_id", "target_date", "target_qty", "status"),
}
_CATALOGUE_REQUIRED = {
    "factories": ("code", "name"),
    "lines": ("factory_id", "code", "name"),
    "shifts": ("factory_id", "code", "name", "start_time", "end_time"),
    "calendars": ("factory_id", "calendar_date"),
    "machines": ("factory_id", "code", "name"),
    "capabilities": ("capability_key", "name"),
    "operators": ("operator_code", "display_name"),
    "skills": ("skill_key", "name"),
    "operation_definitions": ("operation_code", "name", "default_sam_minutes"),
    "targets": ("factory_id", "target_date", "target_qty"),
}
_MUTABLE_CATALOGUE_COLUMNS = {
    key: tuple(c for c in cols if c not in {"factory_id", "operator_code", "skill_key", "capability_key"})
    for key, cols in _CATALOGUE_COLUMNS.items()
}
_DEFAULT_GATES = (
    ("materials", "Materials / BOM ready"),
    ("capacity", "Capacity confirmed"),
    ("quality", "Quality readiness confirmed"),
)


def _jsonable(value):
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _rows(rows):
    return [_jsonable(dict(r)) for r in (rows or [])]


def _user(request):
    return getattr(request.state, "user", None) or {}


def _actor(request):
    u = _user(request)
    return {
        "user_id": u.get("user_id") or u.get("id"),
        "name": u.get("name") or u.get("email") or "Unknown user",
        "role": (u.get("role") or "").lower(),
    }


def _reason(body):
    value = str((body or {}).get("reason") or "").strip()
    return value if len(value) >= 3 else None


def _request_id(request):
    return (request.headers.get("x-request-id") or uuid.uuid4().hex)[:100]


def _error(detail, status=400, **extra):
    payload = {"detail": detail}
    payload.update(extra)
    return JSONResponse(payload, status_code=status)


def _require_role(request, allowed, action):
    role = _actor(request)["role"]
    if role not in allowed:
        return _error(f"{action} requires an authorized production workspace role", 403)
    return None


def _db(query, params=None, fetch=False):
    return _API._users_exec(query, params, fetch=fetch)


def _tx():
    return _API._users_tx()


def _ensure_schema():
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    with _SCHEMA_LOCK:
        if _SCHEMA_READY:
            return
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "production_tracker_schema.sql")
        with open(path, "r", encoding="utf-8") as fh:
            full_schema = fh.read()
        marker = "-- ============================================================\n-- Production Workspace Foundation"
        schema = full_schema[full_schema.find(marker):] if marker in full_schema else ""
        if not schema:
            raise RuntimeError("production workspace schema section is missing")
        _db(schema)
        _SCHEMA_READY = True


def ensure_production_workspace_tables():
    """Idempotent boot hook and a public hook for focused schema tests."""
    try:
        _ensure_schema()
    except Exception:
        log.exception("Production workspace schema initialization failed")
        raise


def _audit(cur, entity_type, entity_id, action, actor, reason,
           before=None, after=None, request_id=None):
    cur.execute(
        """
        INSERT INTO production_workspace_audit_events
            (entity_type, entity_id, action, actor_user_id, actor_name,
             reason, before_json, after_json, request_id)
        VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)
        RETURNING id, occurred_at
        """,
        (
            entity_type, str(entity_id), action, actor.get("user_id"),
            actor.get("name"), reason,
            json.dumps(_jsonable(before)) if before is not None else None,
            json.dumps(_jsonable(after)) if after is not None else None,
            request_id,
        ),
    )
    return cur.fetchone()


def _mutation_result(record, audit_row=None):
    result = {"record": _jsonable(record)}
    if audit_row:
        result["changed_at"] = _jsonable(audit_row.get("occurred_at"))
        result["audit_event_id"] = audit_row.get("id")
    return result


def _expected(body):
    value = (body or {}).get("expected_version")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _version_error(expected, actual):
    return _error(
        "This record changed since you opened it. Refresh and retry your change.",
        409,
        code="stale_workspace_edit",
        expected_version=expected,
        current_version=actual,
    )


def _record_id(value, label):
    if value in (None, ""):
        return None, None
    try:
        return int(value), None
    except (TypeError, ValueError):
        return None, f"The selected {label} is invalid."


def _scope_relationship_error(cur, *, factory_id=None, line_id=None, shift_id=None,
                              machine_id=None, calendar_id=None, capability_id=None):
    """Return a useful error before a factory-scoped write reaches its FK/trigger."""
    ids = {}
    for label, value in (
        ("factory", factory_id), ("line", line_id), ("shift", shift_id),
        ("machine", machine_id), ("calendar", calendar_id),
        ("capability", capability_id),
    ):
        record_id, error = _record_id(value, label)
        if error:
            return error
        ids[label] = record_id

    rows = {}
    for label, table, columns in (
        ("factory", "production_workspace_factories", "id"),
        ("line", "production_workspace_lines", "factory_id"),
        ("shift", "production_workspace_shifts", "factory_id"),
        ("machine", "production_workspace_machines", "factory_id,line_id"),
        ("calendar", "production_workspace_calendars", "factory_id,shift_id"),
        ("capability", "production_workspace_capabilities", "machine_id,line_id"),
    ):
        if ids[label] is None:
            continue
        cur.execute(f"SELECT {columns} FROM {table} WHERE id=%s FOR SHARE", (ids[label],))
        rows[label] = cur.fetchone()
        if not rows[label]:
            return f"The selected {label} does not exist. Refresh and choose it again."

    scoped_factory = ids["factory"]
    if scoped_factory is None:
        scoped_factory = (
            rows.get("machine", {}).get("factory_id")
            or rows.get("calendar", {}).get("factory_id")
            or rows.get("line", {}).get("factory_id")
            or rows.get("shift", {}).get("factory_id")
        )
    for label in ("line", "shift", "machine", "calendar"):
        row = rows.get(label)
        if row and scoped_factory is not None and int(row["factory_id"]) != int(scoped_factory):
            return f"The selected {label} belongs to a different factory."

    machine = rows.get("machine")
    line = rows.get("line")
    if machine and line and machine.get("line_id") is not None \
            and int(machine["line_id"]) != ids["line"]:
        return "The selected machine is assigned to a different production line."
    calendar = rows.get("calendar")
    shift = rows.get("shift")
    if calendar and shift and calendar.get("shift_id") is not None \
            and int(calendar["shift_id"]) != ids["shift"]:
        return "The selected calendar belongs to a different shift."
    capability = rows.get("capability")
    if capability:
        if capability.get("line_id") is not None and ids["line"] is not None \
                and int(capability["line_id"]) != ids["line"]:
            return "The selected capability belongs to a different production line."
        if capability.get("machine_id") is not None:
            cur.execute(
                "SELECT factory_id,line_id FROM production_workspace_machines "
                "WHERE id=%s FOR SHARE",
                (capability["machine_id"],),
            )
            capability_machine = cur.fetchone()
            if not capability_machine:
                return "The selected capability has no valid machine."
            if scoped_factory is not None \
                    and int(capability_machine["factory_id"]) != int(scoped_factory):
                return "The selected capability belongs to a different factory."
            if ids["line"] is not None and capability_machine.get("line_id") is not None \
                    and int(capability_machine["line_id"]) != ids["line"]:
                return "The selected capability is attached to a different production line."
            if capability.get("line_id") is not None and capability_machine.get("line_id") is not None \
                    and int(capability["line_id"]) != int(capability_machine["line_id"]):
                return "The selected capability and machine use different production lines."
    return None


def _catalogue_relationship_error(cur, resource, values):
    if resource == "calendars":
        return _scope_relationship_error(
            cur, factory_id=values.get("factory_id"), shift_id=values.get("shift_id"))
    if resource == "machines":
        return _scope_relationship_error(
            cur, factory_id=values.get("factory_id"), line_id=values.get("line_id"))
    if resource == "capabilities":
        return _scope_relationship_error(
            cur, machine_id=values.get("machine_id"), line_id=values.get("line_id"))
    if resource == "targets":
        return _scope_relationship_error(
            cur, factory_id=values.get("factory_id"), line_id=values.get("line_id"))
    if resource == "operation_definitions" and values.get("capability_id") not in (None, ""):
        return _scope_relationship_error(cur, capability_id=values.get("capability_id"))
    return None


def _status_error(current, target):
    return _error(
        f"Cannot move a {PLAN_STATUS_LABELS.get(current, current)} plan to "
        f"{PLAN_STATUS_LABELS.get(target, target)}.",
        409,
        code="invalid_workspace_transition",
        current_status=current,
        allowed_next=list(VALID_TRANSITIONS.get(current, ())),
    )


def _plan_from_cur(cur, plan_id, lock=False):
    cur.execute(
        "SELECT * FROM production_workspace_plan_versions WHERE id=%s"
        + (" FOR UPDATE" if lock else ""),
        (plan_id,),
    )
    return cur.fetchone()


def _plan_detail(plan_id):
    with _tx() as cur:
        plan = _plan_from_cur(cur, plan_id)
        if not plan:
            return None
        return _plan_detail_from_cur(cur, plan)


def _plan_detail_from_cur(cur, plan):
    pid = plan["id"]
    wid = plan["work_item_id"]
    cur.execute(
        """
        SELECT wi.*, po.order_ref AS tracker_order_ref,
               po.product_name AS tracker_style_name,
               NULL::text AS tracker_order_state, po.order_qty AS tracker_order_qty,
               po.date_ordered AS tracker_order_date,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'stage', b.stage, 'qty_here', b.qty_here
                   ) ORDER BY s.sort_order)
                   FROM v_stage_balances b
                   JOIN production_stages s ON s.stage_key=b.stage
                   WHERE b.order_ref=po.order_ref
               ), '[]'::jsonb) AS tracker_stage_balances
        FROM production_workspace_work_items wi
        LEFT JOIN production_orders po ON po.order_ref=wi.production_order_ref
        WHERE wi.id=%s
        """,
        (wid,),
    )
    work_item = cur.fetchone()
    cur.execute(
        "SELECT * FROM production_workspace_operations "
        "WHERE plan_version_id=%s ORDER BY sequence_no, id", (pid,),
    )
    operations = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_readiness_gates "
        "WHERE plan_version_id=%s ORDER BY id", (pid,),
    )
    gates = cur.fetchall()
    cur.execute(
        """
        SELECT a.*, o.display_name AS operator_name, l.name AS line_name,
               m.name AS machine_name
        FROM production_workspace_assignments a
        LEFT JOIN production_workspace_operators o ON o.id=a.operator_id
        LEFT JOIN production_workspace_lines l ON l.id=a.line_id
        LEFT JOIN production_workspace_machines m ON m.id=a.machine_id
        WHERE a.plan_version_id=%s ORDER BY a.id
        """,
        (pid,),
    )
    assignments = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_capacity_inputs "
        "WHERE plan_version_id=%s ORDER BY id", (pid,),
    )
    capacity_inputs = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_changeovers "
        "WHERE plan_version_id=%s ORDER BY changeover_date, id", (pid,),
    )
    changeovers = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_execution_references "
        "WHERE plan_version_id=%s ORDER BY created_at DESC, id DESC", (pid,),
    )
    execution_references = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_workflow_revisions "
        "WHERE plan_version_id=%s ORDER BY revision_no", (pid,),
    )
    revisions = cur.fetchall()
    return {
        "plan": _jsonable(plan),
        "work_item": _jsonable(work_item),
        "operations": _rows(operations),
        "readiness_gates": _rows(gates),
        "assignments": _rows(assignments),
        "capacity_inputs": _rows(capacity_inputs),
        "changeovers": _rows(changeovers),
        "execution_references": _rows(execution_references),
        "workflow_revisions": _rows(revisions),
    }


def _can_manage_plan(actor, plan):
    """Production planners own their plans; admins can supervise any plan."""
    return actor.get("role") == "admin" or (
        actor.get("role") == "production"
        and plan.get("owner_user_id") == actor.get("user_id")
    )


def _require_mutable_plan(cur, plan_id, body, actor):
    plan = _plan_from_cur(cur, plan_id, lock=True)
    if not plan:
        return None, _error(f"Plan {plan_id} not found", 404)
    expected = _expected(body)
    if expected is None:
        return None, _error("expected_version is required for this change", 400)
    if expected != int(plan["version_token"]):
        return None, _version_error(expected, int(plan["version_token"]))
    if plan["status"] not in ("draft", "reopened"):
        return None, _error(
            "Only Draft or Reopened plans can be edited. Reopen a frozen plan "
            "with a reason to create a new revision.",
            409,
            code="workspace_plan_locked",
        )
    if not _can_manage_plan(actor, plan):
        return None, _error(
            "Only the plan owner or an administrator can change this plan.",
            403, code="workspace_plan_owner_required",
        )
    return plan, None


def _plan_context_lock_error(cur, plan_id):
    cur.execute(
        """
        SELECT EXISTS(
            SELECT 1 FROM production_workspace_operations WHERE plan_version_id=%s
            UNION ALL
            SELECT 1 FROM production_workspace_assignments WHERE plan_version_id=%s
            UNION ALL
            SELECT 1 FROM production_workspace_capacity_inputs WHERE plan_version_id=%s
            UNION ALL
            SELECT 1 FROM production_workspace_changeovers WHERE plan_version_id=%s
        ) AS locked
        """,
        (plan_id, plan_id, plan_id, plan_id),
    )
    if cur.fetchone()["locked"]:
        return (
            "Factory, line and shift cannot change after planning inputs have been added. "
            "Create or reopen a revision for a different production context."
        )
    return None


def _validate_complete(cur, plan):
    feasibility = _plan_feasibility_detail(cur, plan)
    if feasibility["blockers"]:
        messages = [b["message"] for b in feasibility["blockers"]]
        return "Complete the plan before submitting: " + " ".join(messages)
    return None


def _plan_feasibility_detail(cur, plan):
    """Return transparent load, allocation, and readiness checks for one plan.

    This deliberately uses only saved, approved master data and recorded plan
    inputs. It does not invent efficiency, staffing, or machine availability
    when a denominator has not been maintained.
    """
    plan_id = plan["id"]
    blockers, warnings = [], []
    cur.execute(
        """
        SELECT COALESCE(SUM(available_minutes),0) AS available_minutes,
               COALESCE(SUM(required_minutes),0) AS stated_required_minutes,
               COUNT(*) AS input_count
        FROM production_workspace_capacity_inputs
        WHERE plan_version_id=%s
        """, (plan_id,),
    )
    capacity = cur.fetchone()
    cur.execute(
        """
        SELECT o.*, c.capability_key, c.active AS capability_active,
               c.name AS capability_name
        FROM production_workspace_operations o
        LEFT JOIN production_workspace_capabilities c ON c.id=o.capability_id
        WHERE o.plan_version_id=%s
        ORDER BY o.sequence_no, o.id
        """, (plan_id,),
    )
    operations = cur.fetchall()
    sam_required = sum(
        float(op["sam_minutes"] or 0) * float(plan["planned_qty"] or 0)
        for op in operations
    )
    available = float(capacity["available_minutes"] or 0)
    stated_required = float(capacity["stated_required_minutes"] or 0)
    if not operations:
        blockers.append({"code": "missing_operations", "message": "Add at least one approved operation/SAM."})
    if not capacity["input_count"]:
        blockers.append({"code": "missing_capacity", "message": "Add approved calendar, staffing or machine capacity inputs."})
    if available <= 0:
        blockers.append({"code": "missing_available_minutes", "message": "Available minutes are missing or zero; load cannot be calculated."})
    if sam_required <= 0:
        blockers.append({"code": "missing_sam_denominator", "message": "Required minutes cannot be calculated without positive SAM values."})
    if stated_required and abs(stated_required - sam_required) > 0.01:
        warnings.append({
            "code": "required_minutes_mismatch",
            "message": "Saved capacity required minutes differ from planned quantity × operation SAM.",
            "stated_required_minutes": stated_required,
            "sam_required_minutes": sam_required,
        })

    cur.execute(
        """
        SELECT a.id, a.operation_id, a.operator_id, a.machine_id, a.line_id,
               a.planned_minutes, op.operation_code, cap.capability_key,
               cap.machine_id AS capability_machine_id,
               worker.operator_code, worker.display_name, worker.active AS operator_active,
               machine.active AS machine_active,
               CASE WHEN cap.capability_key IS NULL OR a.operator_id IS NULL THEN TRUE
                    ELSE EXISTS (
                        SELECT 1
                        FROM production_workspace_operator_skills os
                        JOIN production_workspace_skills sk ON sk.id=os.skill_id
                        WHERE os.operator_id=a.operator_id
                          AND sk.skill_key=cap.capability_key
                          AND sk.active
                    )
               END AS skill_matches
        FROM production_workspace_assignments a
        LEFT JOIN production_workspace_operations op ON op.id=a.operation_id
        LEFT JOIN production_workspace_capabilities cap ON cap.id=op.capability_id
        LEFT JOIN production_workspace_operators worker ON worker.id=a.operator_id
        LEFT JOIN production_workspace_machines machine ON machine.id=a.machine_id
        WHERE a.plan_version_id=%s
        ORDER BY a.id
        """, (plan_id,),
    )
    assignments = cur.fetchall()
    assigned_operation_ids = {a["operation_id"] for a in assignments if a.get("operation_id")}
    for op in operations:
        if op.get("capability_id") and not op.get("capability_active"):
            blockers.append({"code": "unavailable_capability", "operation_id": op["id"],
                             "message": f"Operation {op['operation_code']} uses an inactive capability."})
        if op.get("capability_id") and op["id"] not in assigned_operation_ids:
            blockers.append({"code": "unassigned_capability", "operation_id": op["id"],
                             "message": f"Operation {op['operation_code']} has no machine/operator allocation."})
        if op.get("capability_id") and not any(
            a.get("operation_id") == op["id"] and a.get("operator_id") and a.get("machine_id")
            and a.get("operator_active") and a.get("machine_active") and a.get("skill_matches")
            and (a.get("capability_machine_id") is None
                 or int(a["capability_machine_id"]) == int(a["machine_id"]))
            for a in assignments
        ):
            blockers.append({"code": "capability_allocation_incomplete", "operation_id": op["id"],
                             "message": f"Operation {op['operation_code']} needs an active compatible machine and skill-qualified operator."})
    for assignment in assignments:
        if assignment.get("operator_id") and not assignment.get("operator_active"):
            blockers.append({"code": "inactive_operator", "assignment_id": assignment["id"],
                             "message": f"{assignment.get('display_name') or assignment.get('operator_code')} is inactive."})
        if assignment.get("machine_id") and not assignment.get("machine_active"):
            blockers.append({"code": "inactive_machine", "assignment_id": assignment["id"],
                             "message": "An assignment uses an inactive machine."})
        if assignment.get("capability_key") and assignment.get("operator_id") and not assignment.get("skill_matches"):
            blockers.append({"code": "skill_mismatch", "assignment_id": assignment["id"],
                             "message": f"The assigned operator is not qualified for {assignment['capability_key']}."})
        if assignment.get("capability_machine_id") is not None and assignment.get("machine_id") \
                and int(assignment["capability_machine_id"]) != int(assignment["machine_id"]):
            blockers.append({"code": "capability_machine_mismatch", "assignment_id": assignment["id"],
                             "message": "The assigned machine is incompatible with the operation capability."})

    cur.execute(
        """
        SELECT COALESCE(machine_id,-1) AS machine_key, SUM(planned_minutes) AS assigned_minutes
        FROM production_workspace_assignments
        WHERE plan_version_id=%s GROUP BY COALESCE(machine_id,-1)
        """, (plan_id,),
    )
    allocations = _rows(cur.fetchall())
    machine_capacity = {}
    cur.execute(
        """
        SELECT COALESCE(machine_id,-1) AS machine_key, SUM(available_minutes) AS available_minutes
        FROM production_workspace_capacity_inputs
        WHERE plan_version_id=%s GROUP BY COALESCE(machine_id,-1)
        """, (plan_id,),
    )
    for row in cur.fetchall():
        machine_capacity[row["machine_key"]] = float(row["available_minutes"] or 0)
    for allocation in allocations:
        allocation["available_minutes"] = machine_capacity.get(allocation["machine_key"], 0)
        allocation["gap_minutes"] = allocation["available_minutes"] - float(allocation["assigned_minutes"] or 0)
        if allocation["gap_minutes"] < 0:
            blockers.append({"code": "over_allocated_machine", "machine_id": allocation["machine_key"] or None,
                             "message": "Machine allocation exceeds its approved available minutes.",
                             "gap_minutes": allocation["gap_minutes"]})

    cur.execute(
        "SELECT gate_key,gate_name,status,note,evidence_ref,due_date,owner_user_id,"
        "exception_authorized_by FROM production_workspace_readiness_gates "
        "WHERE plan_version_id=%s ORDER BY id", (plan_id,),
    )
    gates = _rows(cur.fetchall())
    for gate in gates:
        if gate["status"] not in ("passed", "waived"):
            blockers.append({"code": "readiness_blocker", "gate_key": gate["gate_key"],
                             "message": f"Readiness gate '{gate['gate_name']}' is {gate['status']}."})
        if not gate.get("owner_user_id") or not gate.get("due_date"):
            blockers.append({"code": "readiness_accountability_missing", "gate_key": gate["gate_key"],
                             "message": f"Readiness gate '{gate['gate_name']}' needs an owner and due date."})
        if gate["status"] == "waived" and not gate.get("exception_authorized_by"):
            blockers.append({"code": "unauthorized_exception", "gate_key": gate["gate_key"],
                             "message": f"Readiness exception for '{gate['gate_name']}' lacks authorization."})

    cur.execute(
        """
        SELECT id,target_date,target_qty,status
        FROM production_workspace_targets
        WHERE factory_id=%s
          AND (line_id IS NOT DISTINCT FROM %s)
          AND target_date BETWEEN %s AND %s
          AND status='approved'
        ORDER BY target_date
        """, (plan["factory_id"], plan.get("line_id"), plan["planned_start"], plan["planned_end"]),
    )
    targets = _rows(cur.fetchall())
    if not targets:
        blockers.append({"code": "missing_approved_target",
                         "message": "No approved output target is maintained for this plan's line and date range."})
    else:
        target_dates = {str(target["target_date"]) for target in targets}
        expected_dates = {
            (plan["planned_start"] + timedelta(days=offset)).isoformat()
            for offset in range((plan["planned_end"] - plan["planned_start"]).days + 1)
        }
        missing_target_dates = sorted(expected_dates - target_dates)
        if missing_target_dates:
            blockers.append({
                "code": "missing_approved_target_dates",
                "message": "Approved output targets are missing for: " + ", ".join(missing_target_dates),
                "missing_dates": missing_target_dates,
            })
        target_qty = sum(float(target["target_qty"] or 0) for target in targets)
        if float(plan["planned_qty"] or 0) > target_qty:
            blockers.append({
                "code": "target_output_gap",
                "message": "Planned output exceeds the approved target output for this dated line plan.",
                "target_qty": target_qty,
                "planned_qty": float(plan["planned_qty"] or 0),
            })
    cur.execute(
        "SELECT COALESCE(SUM(minutes),0) AS minutes FROM production_workspace_changeovers "
        "WHERE plan_version_id=%s", (plan_id,),
    )
    changeover_minutes = float(cur.fetchone()["minutes"] or 0)
    required = sam_required + changeover_minutes
    gap = available - required if available > 0 else None
    if gap is not None and gap < 0:
        blockers.append({"code": "capacity_gap", "message": "Approved capacity is below operation and changeover demand.",
                         "gap_minutes": gap})
    return {
        "plan_id": plan_id,
        "available_minutes": available,
        "required_minutes": required,
        "sam_required_minutes": sam_required,
        "changeover_minutes": changeover_minutes,
        "stated_required_minutes": stated_required,
        "capacity_gap_minutes": gap,
        "load_pct": round((required / available) * 100, 1) if available > 0 else None,
        "targets": targets,
        "approved_target_qty": sum(float(target["target_qty"] or 0) for target in targets),
        "assignments": _rows(assignments),
        "allocations": allocations,
        "readiness_gates": gates,
        "blockers": blockers,
        "warnings": warnings,
        "feasible": len(blockers) == 0,
        "incomplete": any(b["code"].startswith("missing_") for b in blockers),
    }


def _plan_feasibility(plan_id: int, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    with _tx() as cur:
        plan = _plan_from_cur(cur, plan_id)
        if not plan:
            return _error(f"Plan {plan_id} not found", 404)
        return _jsonable(_plan_feasibility_detail(cur, plan))


def _workspace_root(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    role = _actor(request)["role"]
    return {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "domain": "production_workspace",
        "legacy_tracker": {
            "orders": "production_orders",
            "stages": "production_stages",
            "movements": "stage_movements",
        },
        "workflow": {
            "statuses": [
                {"key": s, "label": PLAN_STATUS_LABELS[s],
                 "allowed_next": list(VALID_TRANSITIONS.get(s, ()))}
                for s in PLAN_STATUSES
            ],
            "reopen_creates_revision": True,
        },
        "permissions": {
            "role": role,
            "can_view": role in VIEW_ROLES,
            "can_plan": role in PLANNER_ROLES,
            "can_approve": role in APPROVER_ROLES,
            "can_reopen": role in APPROVER_ROLES,
        },
    }


def _catalogues(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    result = {}
    for resource, table in _CATALOGUE_TABLES.items():
        result[resource] = _rows(_db(
            f"SELECT * FROM {table} ORDER BY id", fetch=True))
    result["operator_skills"] = _rows(_db(
        """
        SELECT os.*, o.operator_code, o.display_name, s.skill_key, s.name AS skill_name
        FROM production_workspace_operator_skills os
        JOIN production_workspace_operators o ON o.id=os.operator_id
        JOIN production_workspace_skills s ON s.id=os.skill_id
        ORDER BY o.display_name, s.name
        """, fetch=True))
    result["tracker_stages"] = _rows(_db(
        "SELECT stage_key, stage_name, sort_order, allowed_next, is_terminal "
        "FROM production_stages ORDER BY sort_order", fetch=True))
    return {"schema_version": WORKSPACE_SCHEMA_VERSION, "catalogues": result}


def _catalogue_create(resource, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace catalogue changes")
    if denied:
        return denied
    if resource not in _CATALOGUE_TABLES:
        return _error(f"Unknown catalogue: {resource}", 404)
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every production workspace change")
    missing = [c for c in _CATALOGUE_REQUIRED[resource]
               if body.get(c) in (None, "")]
    if missing:
        return _error("Required fields: " + ", ".join(missing))
    actor = _actor(request)
    if resource in ("targets", "operation_definitions"):
        # Governed records always enter as drafts. Separate approver transitions
        # make publication visible in workflow/audit history.
        body = dict(body)
        body["status"] = "draft"
    table = _CATALOGUE_TABLES[resource]
    cols = list(_CATALOGUE_COLUMNS[resource])
    values = [body.get(c) for c in cols]
    placeholders = ",".join(["%s"] * len(cols))
    try:
        with _tx() as cur:
            relationship_error = _catalogue_relationship_error(cur, resource, body)
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                f"INSERT INTO {table} ({','.join(cols)},created_by,updated_by) "
                f"VALUES ({placeholders},%s,%s) RETURNING *",
                values + [actor["user_id"], actor["user_id"]],
            )
            row = cur.fetchone()
            audit = _audit(
                cur, resource, row["id"], "created", actor, reason,
                after=row, request_id=_request_id(request),
            )
        return _mutation_result(row, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error(
                "A record with that identifier already exists. Refresh and choose a unique value.",
                409, code="duplicate_workspace_record",
            )
        log.exception("workspace catalogue create failed")
        return _error("Could not create the production workspace record", 500)


def _catalogue_update(resource, record_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace catalogue changes")
    if denied:
        return denied
    if resource not in _CATALOGUE_TABLES:
        return _error(f"Unknown catalogue: {resource}", 404)
    reason = _reason(body)
    expected = _expected(body)
    if not reason:
        return _error("reason is required for every production workspace change")
    if expected is None:
        return _error("expected_version is required for this change")
    updates = [(c, body[c]) for c in _MUTABLE_CATALOGUE_COLUMNS[resource] if c in body]
    if not updates:
        return _error("At least one editable field is required")
    actor = _actor(request)
    table = _CATALOGUE_TABLES[resource]
    try:
        with _tx() as cur:
            cur.execute(f"SELECT * FROM {table} WHERE id=%s FOR UPDATE", (record_id,))
            before = cur.fetchone()
            if not before:
                return _error(f"{resource[:-1].capitalize()} {record_id} not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, int(before["version_token"]))
            if resource in ("targets", "operation_definitions") and before.get("status") != "draft":
                return _error(
                    "Approved master data is immutable. Create a new draft and send it through approval instead.",
                    409, code="workspace_approved_master_immutable",
                )
            candidate = dict(before)
            candidate.update({c: value for c, value in updates})
            if resource in ("targets", "operation_definitions") and "status" in body \
                    and body.get("status") != before.get("status"):
                return _error(
                    "Use the governed approval workflow to change this record's status.",
                    409, code="workspace_governed_status_required",
                )
            relationship_error = _catalogue_relationship_error(cur, resource, candidate)
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            assignments = ",".join(f"{c}=%s" for c, _ in updates)
            cur.execute(
                f"UPDATE {table} SET {assignments}, version_token=version_token+1, "
                "updated_by=%s, updated_at=now() WHERE id=%s RETURNING *",
                [v for _, v in updates] + [actor["user_id"], record_id],
            )
            after = cur.fetchone()
            audit = _audit(
                cur, resource, record_id, "updated", actor, reason,
                before=before, after=after, request_id=_request_id(request),
            )
        return _mutation_result(after, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error(
                "That change duplicates an existing production workspace record.",
                409, code="duplicate_workspace_record",
            )
        log.exception("workspace catalogue update failed")
        return _error("Could not update the production workspace record", 500)


def _target_approve(target_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, APPROVER_ROLES, "Production target approval")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required to approve a target")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute("SELECT * FROM production_workspace_targets WHERE id=%s FOR UPDATE",
                        (target_id,))
            before = cur.fetchone()
            if not before:
                return _error(f"Production target {target_id} not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, int(before["version_token"]))
            if before["status"] == "retired":
                return _error("A retired target cannot be approved. Create a new draft.", 409)
            cur.execute(
                "UPDATE production_workspace_targets SET status='approved',"
                "version_token=version_token+1,updated_by=%s,updated_at=now() "
                "WHERE id=%s RETURNING *",
                (actor["user_id"], target_id),
            )
            after = cur.fetchone()
            audit = _audit(cur, "target", target_id, "approved", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("workspace target approval failed")
        return _error("Could not approve the production target", 500)


def _operation_definition_approve(definition_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, APPROVER_ROLES, "Operation/SAM definition approval")
    if denied:
        return denied
    reason, expected = _reason(body), _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required to approve a definition")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute("SELECT * FROM production_workspace_operation_definitions WHERE id=%s FOR UPDATE",
                        (definition_id,))
            before = cur.fetchone()
            if not before:
                return _error(f"Operation/SAM definition {definition_id} not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, int(before["version_token"]))
            if before["status"] == "retired":
                return _error("A retired definition cannot be approved. Create a new draft.", 409)
            cur.execute(
                "UPDATE production_workspace_operation_definitions SET status='approved',"
                "version_token=version_token+1,updated_by=%s,updated_at=now() "
                "WHERE id=%s RETURNING *", (actor["user_id"], definition_id),
            )
            after = cur.fetchone()
            audit = _audit(cur, "operation_definition", definition_id, "approved", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("workspace operation definition approval failed")
        return _error("Could not approve the operation/SAM definition", 500)


def _catalogue_revise(resource: str, record_id: int, request: Request, body: dict):
    _ensure_schema()
    if resource not in ("targets", "operation_definitions"):
        return _error("This master record has no governed revision workflow.", 404)
    denied = _require_role(request, APPROVER_ROLES, "Production master-data revision")
    if denied:
        return denied
    reason, expected = _reason(body), _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required to revise approved master data")
    actor = _actor(request)
    table = _CATALOGUE_TABLES[resource]
    try:
        with _tx() as cur:
            cur.execute(f"SELECT * FROM {table} WHERE id=%s FOR UPDATE", (record_id,))
            before = cur.fetchone()
            if not before:
                return _error("Master-data record not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, int(before["version_token"]))
            if before["status"] != "approved":
                return _error("Only an approved record can be revised into a draft.", 409)
            cur.execute(
                f"UPDATE {table} SET status='draft',version_token=version_token+1,"
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], record_id),
            )
            after = cur.fetchone()
            audit = _audit(cur, resource, record_id, "revised_to_draft", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("workspace catalogue revision failed")
        return _error("Could not create a governed draft revision", 500)


def _operator_skill_create(operator_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace skill changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason or body.get("skill_id") in (None, ""):
        return _error("skill_id and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                "INSERT INTO production_workspace_operator_skills "
                "(operator_id,skill_id,skill_level,verified_at,verified_by) "
                "VALUES (%s,%s,%s,now(),%s) RETURNING *",
                (operator_id, body["skill_id"], body.get("skill_level"), actor["user_id"]),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, "operator_skill", f"{operator_id}:{body['skill_id']}",
                "created", actor, reason, after=row, request_id=_request_id(request),
            )
        return _mutation_result(row, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("This operator already has that skill.", 409,
                          code="duplicate_workspace_record")
        return _error("Could not assign the operator skill", 500)


def _work_items(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    rows = _db(
        """
        SELECT wi.*, po.order_ref AS tracker_order_ref,
               po.product_name AS tracker_style_name,
               NULL::text AS tracker_order_state, po.order_qty AS tracker_order_qty,
               latest.id AS latest_plan_id, latest.version_no AS latest_plan_version,
               latest.status AS latest_plan_status, latest.version_token AS latest_plan_token
        FROM production_workspace_work_items wi
        LEFT JOIN production_orders po ON po.order_ref=wi.production_order_ref
        LEFT JOIN LATERAL (
            SELECT p.* FROM production_workspace_plan_versions p
            WHERE p.work_item_id=wi.id ORDER BY p.version_no DESC LIMIT 1
        ) latest ON TRUE
        ORDER BY wi.updated_at DESC, wi.id DESC
        """, fetch=True)
    return {"schema_version": WORKSPACE_SCHEMA_VERSION, "work_items": _rows(rows)}


def _work_item_create(request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace planning")
    if denied:
        return denied
    reason = _reason(body)
    if not reason or body.get("external_ref") in (None, "") or body.get("planned_qty") in (None, ""):
        return _error("external_ref, planned_qty and reason are required")
    try:
        qty = float(body["planned_qty"])
        if qty <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return _error("planned_qty must be greater than zero")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                """
                INSERT INTO production_workspace_work_items
                    (production_order_ref,external_ref,style_number,description,
                     planned_qty,stage_key,owner_user_id,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (
                    body.get("production_order_ref"), body["external_ref"],
                    body.get("style_number"), body.get("description"), qty,
                    body.get("stage_key"),
                    (body.get("owner_user_id") if actor["role"] == "admin"
                     else actor["user_id"]),
                    actor["user_id"], actor["user_id"],
                ),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, "work_item", row["id"], "created", actor, reason,
                after=row, request_id=_request_id(request),
            )
        return _mutation_result(row, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error(
                "A work item already exists for that external reference or tracker order.",
                409, code="duplicate_workspace_record",
            )
        if "foreign key" in str(exc).lower():
            return _error("The linked tracker order or stage does not exist.", 400)
        log.exception("workspace work item create failed")
        return _error("Could not create the production work item", 500)


def _work_item_update(work_item_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace planning")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required")
    allowed = ("production_order_ref", "external_ref", "style_number",
               "description", "planned_qty", "stage_key")
    updates = [(field, body[field]) for field in allowed if field in body]
    if not updates:
        return _error("At least one editable work item field is required")
    if any(field == "planned_qty" for field, _ in updates):
        try:
            if float(body["planned_qty"]) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return _error("planned_qty must be greater than zero")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute("SELECT * FROM production_workspace_work_items WHERE id=%s FOR UPDATE",
                        (work_item_id,))
            before = cur.fetchone()
            if not before:
                return _error(f"Work item {work_item_id} not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, int(before["version_token"]))
            if actor["role"] != "admin" and before.get("owner_user_id") != actor["user_id"]:
                return _error("Only the work item owner or an administrator can edit it.", 403,
                              code="workspace_work_item_owner_required")
            assignments = ",".join(f"{field}=%s" for field, _ in updates)
            cur.execute(
                f"UPDATE production_workspace_work_items SET {assignments}, "
                "version_token=version_token+1,updated_by=%s,updated_at=now() "
                "WHERE id=%s RETURNING *",
                [value for _, value in updates] + [actor["user_id"], work_item_id],
            )
            after = cur.fetchone()
            audit = _audit(cur, "work_item", work_item_id, "updated", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That work item reference already exists.", 409,
                          code="duplicate_workspace_record")
        if "foreign key" in str(exc).lower():
            return _error("The linked tracker order or stage does not exist.", 400)
        log.exception("workspace work item update failed")
        return _error("Could not update the production work item", 500)


def _plans(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    rows = _db(
        """
        SELECT p.*, wi.external_ref, wi.style_number, wi.description,
               f.code AS factory_code, f.name AS factory_name,
               l.code AS line_code, l.name AS line_name
        FROM production_workspace_plan_versions p
        JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
        JOIN production_workspace_factories f ON f.id=p.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=p.line_id
        ORDER BY p.updated_at DESC, p.id DESC
        """, fetch=True)
    return {"schema_version": WORKSPACE_SCHEMA_VERSION, "plans": _rows(rows)}


def _plan_get(plan_id: int, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    return _plan_detail(plan_id) or _error(f"Plan {plan_id} not found", 404)


def _plan_create(work_item_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace planning")
    if denied:
        return denied
    reason = _reason(body)
    required = ("factory_id", "planned_start", "planned_end", "planned_qty")
    if not reason or any(body.get(c) in (None, "") for c in required):
        return _error("factory_id, planned_start, planned_end, planned_qty and reason are required")
    try:
        qty = float(body["planned_qty"])
        start = date.fromisoformat(str(body["planned_start"]))
        end = date.fromisoformat(str(body["planned_end"]))
        if qty <= 0 or end < start:
            raise ValueError
    except (TypeError, ValueError):
        return _error("planned dates must be ISO dates and planned_qty must be positive")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_work_items WHERE id=%s FOR UPDATE",
                (work_item_id,),
            )
            work_item = cur.fetchone()
            if not work_item:
                return _error(f"Work item {work_item_id} not found", 404)
            if actor["role"] != "admin" and work_item["owner_user_id"] != actor["user_id"]:
                return _error(
                    "Only the work-item owner or an administrator can create its plan.",
                    403, code="workspace_plan_owner_required",
                )
            relationship_error = _scope_relationship_error(
                cur, factory_id=body.get("factory_id"), line_id=body.get("line_id"),
                shift_id=body.get("shift_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                "SELECT COALESCE(MAX(version_no),0) AS n, "
                "MAX(status) FILTER (WHERE version_no=(SELECT MAX(version_no) "
                "FROM production_workspace_plan_versions WHERE work_item_id=%s)) AS latest "
                "FROM production_workspace_plan_versions WHERE work_item_id=%s",
                (work_item_id, work_item_id),
            )
            current = cur.fetchone()
            version_no = int(current["n"] or 0) + 1
            if current["latest"] not in (None, "frozen"):
                return _error(
                    "A non-frozen plan already exists for this work item. Edit it or freeze it before creating another version.",
                    409, code="workspace_plan_already_open",
                )
            cur.execute(
                """
                INSERT INTO production_workspace_plan_versions
                    (work_item_id,version_no,status,factory_id,line_id,shift_id,
                     planned_start,planned_end,planned_qty,owner_user_id,
                     created_by,updated_by)
                VALUES (%s,%s,'draft',%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING *
                """,
                (
                    work_item_id, version_no, body["factory_id"], body.get("line_id"),
                    body.get("shift_id"), start, end, qty,
                    (body.get("owner_user_id") if actor["role"] == "admin"
                     else actor["user_id"]),
                    actor["user_id"], actor["user_id"],
                ),
            )
            plan = cur.fetchone()
            for key, name in _DEFAULT_GATES:
                cur.execute(
                    "INSERT INTO production_workspace_readiness_gates "
                    "(plan_version_id,gate_key,gate_name) VALUES (%s,%s,%s)",
                    (plan["id"], key, name),
                )
            cur.execute(
                "INSERT INTO production_workspace_workflow_revisions "
                "(plan_version_id,from_status,to_status,reason,changed_by,revision_no) "
                "VALUES (%s,NULL,'draft',%s,%s,1)",
                (plan["id"], reason, actor["user_id"]),
            )
            audit = _audit(
                cur, "plan_version", plan["id"], "created", actor, reason,
                after=plan, request_id=_request_id(request),
            )
        return _mutation_result(_plan_detail(plan["id"]), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That plan version already exists.", 409,
                          code="duplicate_workspace_record")
        if "foreign key" in str(exc).lower():
            return _error("The selected factory, line, shift or work item does not exist.", 400)
        log.exception("workspace plan create failed")
        return _error("Could not create the production plan", 500)


def _plan_update(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace planning")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every production workspace change")
    allowed = ("factory_id", "line_id", "shift_id", "planned_start",
               "planned_end", "planned_qty", "owner_user_id")
    updates = [(c, body[c]) for c in allowed if c in body]
    if not updates:
        return _error("At least one editable plan field is required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            if actor["role"] != "admin" and any(c == "owner_user_id" for c, _ in updates):
                return _error(
                    "Only an administrator can reassign a plan owner.",
                    403, code="workspace_plan_owner_required",
                )
            if any(c in {"factory_id", "line_id", "shift_id", "planned_start", "planned_end"} for c, _ in updates):
                context_lock = _plan_context_lock_error(cur, plan_id)
                if context_lock:
                    return _error(context_lock, 409,
                                  code="workspace_plan_context_locked")
            candidate = dict(plan)
            candidate.update({c: value for c, value in updates})
            relationship_error = _scope_relationship_error(
                cur, factory_id=candidate.get("factory_id"),
                line_id=candidate.get("line_id"), shift_id=candidate.get("shift_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            values = [v for _, v in updates]
            assignments = ",".join(f"{c}=%s" for c, _ in updates)
            cur.execute(
                f"UPDATE production_workspace_plan_versions SET {assignments}, "
                "version_token=version_token+1, updated_by=%s, updated_at=now() "
                "WHERE id=%s RETURNING *",
                values + [actor["user_id"], plan_id],
            )
            after = cur.fetchone()
            audit = _audit(
                cur, "plan_version", plan_id, "updated", actor, reason,
                before=plan, after=after, request_id=_request_id(request),
            )
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception as exc:
        if "check constraint" in str(exc).lower():
            return _error("The plan dates and quantity are not valid.", 400)
        return _error("Could not update the production plan", 500)


def _plan_transition(plan_id: int, target: str, request: Request, body: dict):
    _ensure_schema()
    actor = _actor(request)
    if target in ("approved", "frozen", "reopened"):
        denied = _require_role(request, APPROVER_ROLES, "Plan approval and reopening")
        if denied:
            return denied
    else:
        denied = _require_role(request, PLANNER_ROLES, "Plan submission")
        if denied:
            return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every workflow transition")
    expected = _expected(body)
    if expected is None:
        return _error("expected_version is required for this transition")
    if target not in PLAN_STATUSES:
        return _error("Unknown plan status")
    try:
        with _tx() as cur:
            plan = _plan_from_cur(cur, plan_id, lock=True)
            if not plan:
                return _error(f"Plan {plan_id} not found", 404)
            if expected != int(plan["version_token"]):
                return _version_error(expected, int(plan["version_token"]))
            current = plan["status"]
            if target not in VALID_TRANSITIONS.get(current, ()):
                return _status_error(current, target)
            if target == "submitted":
                if not _can_manage_plan(actor, plan):
                    return _error(
                        "Only the plan owner or an administrator can submit this plan.",
                        403, code="workspace_plan_owner_required",
                    )
            if target in ("submitted", "frozen"):
                missing = _validate_complete(cur, plan)
                if missing:
                    return _error(
                        missing, 422,
                        code=("workspace_plan_incomplete" if target == "submitted"
                              else "workspace_plan_freeze_blocked"),
                    )
            now_fields = []
            if target == "approved":
                now_fields = ["approved_by=%s", "approved_at=now()"]
            elif target == "frozen":
                now_fields = ["frozen_by=%s", "frozen_at=now()"]
            suffix = ("," + ",".join(now_fields)) if now_fields else ""
            cur.execute(
                "UPDATE production_workspace_plan_versions SET status=%s, "
                "version_token=version_token+1, updated_by=%s, updated_at=now()"
                + suffix + " WHERE id=%s RETURNING *",
                [target, actor["user_id"]] +
                ([actor["user_id"]] if now_fields else []) + [plan_id],
            )
            after = cur.fetchone()
            cur.execute(
                "SELECT COALESCE(MAX(revision_no),0)+1 AS n "
                "FROM production_workspace_workflow_revisions WHERE plan_version_id=%s",
                (plan_id,),
            )
            rev_no = int(cur.fetchone()["n"])
            cur.execute(
                "INSERT INTO production_workspace_workflow_revisions "
                "(plan_version_id,from_status,to_status,reason,changed_by,revision_no) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (plan_id, current, target, reason, actor["user_id"], rev_no),
            )
            audit = _audit(
                cur, "plan_version", plan_id, f"status_{target}", actor, reason,
                before=plan, after=after, request_id=_request_id(request),
            )
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception:
        log.exception("workspace plan transition failed")
        return _error("Could not transition the production plan", 500)


def _plan_reopen(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, APPROVER_ROLES, "Plan reopening")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    if not reason:
        return _error("A reason is required to reopen a frozen plan")
    if expected is None:
        return _error("expected_version is required for reopening")
    actor = _actor(request)
    try:
        with _tx() as cur:
            frozen = _plan_from_cur(cur, plan_id, lock=True)
            if not frozen:
                return _error(f"Plan {plan_id} not found", 404)
            if expected != int(frozen["version_token"]):
                return _version_error(expected, int(frozen["version_token"]))
            if frozen["status"] != "frozen":
                return _status_error(frozen["status"], "reopened")
            # A frozen plan is an immutable snapshot. A partial-unique source
            # link rejects a second reopened revision without modifying it.
            cur.execute(
                "SELECT id FROM production_workspace_plan_versions "
                "WHERE reopened_from_id=%s FOR UPDATE",
                (plan_id,),
            )
            existing_reopen = cur.fetchone()
            if existing_reopen:
                return _error(
                    "This frozen plan has already been reopened as a new revision. Refresh the plan list.",
                    409, code="workspace_plan_already_reopened",
                )
            cur.execute(
                "SELECT COALESCE(MAX(version_no),0)+1 AS n "
                "FROM production_workspace_plan_versions WHERE work_item_id=%s",
                (frozen["work_item_id"],),
            )
            version_no = int(cur.fetchone()["n"])
            cur.execute(
                """
                INSERT INTO production_workspace_plan_versions
                    (work_item_id,version_no,status,factory_id,line_id,shift_id,
                     planned_start,planned_end,planned_qty,owner_user_id,
                     reopened_from_id,reopen_reason,created_by,updated_by)
                VALUES (%s,%s,'reopened',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING *
                """,
                (
                    frozen["work_item_id"], version_no, frozen["factory_id"],
                    frozen["line_id"], frozen["shift_id"], frozen["planned_start"],
                    frozen["planned_end"], frozen["planned_qty"], frozen["owner_user_id"],
                    plan_id, reason, actor["user_id"], actor["user_id"],
                ),
            )
            reopened = cur.fetchone()
            cur.execute(
                "SELECT gate_key,gate_name,status,quality_ref,evidence_ref,owner_user_id,due_date,note "
                "FROM production_workspace_readiness_gates WHERE plan_version_id=%s",
                (plan_id,),
            )
            for gate in cur.fetchall():
                cur.execute(
                    "INSERT INTO production_workspace_readiness_gates "
                    "(plan_version_id,gate_key,gate_name,status,quality_ref,evidence_ref,owner_user_id,due_date,note) "
                    "VALUES (%s,%s,%s,'pending',%s,%s,%s,%s,%s)",
                    (reopened["id"], gate["gate_key"], gate["gate_name"],
                     gate["quality_ref"], gate["evidence_ref"], gate["owner_user_id"],
                     gate["due_date"], gate["note"]),
                )
            cur.execute(
                """
                INSERT INTO production_workspace_operations
                    (work_item_id,plan_version_id,operation_code,name,sequence_no,
                     sam_minutes,capability_id,line_id,created_by,updated_by)
                SELECT work_item_id,%s,operation_code,name,sequence_no,sam_minutes,
                       capability_id,line_id,%s,%s
                FROM production_workspace_operations
                WHERE plan_version_id=%s
                """,
                (reopened["id"], actor["user_id"], actor["user_id"], plan_id),
            )
            cur.execute(
                """
                INSERT INTO production_workspace_assignments
                    (plan_version_id,operation_id,operator_id,line_id,machine_id,
                     assignment_role,planned_minutes,created_by)
                SELECT %s,new_op.id,a.operator_id,a.line_id,a.machine_id,
                       a.assignment_role,a.planned_minutes,%s
                FROM production_workspace_assignments a
                LEFT JOIN production_workspace_operations old_op
                    ON old_op.id=a.operation_id
                LEFT JOIN production_workspace_operations new_op
                    ON new_op.plan_version_id=%s
                   AND new_op.operation_code=old_op.operation_code
                WHERE a.plan_version_id=%s
                """,
                (reopened["id"], actor["user_id"], reopened["id"], plan_id),
            )
            cur.execute(
                """
                INSERT INTO production_workspace_capacity_inputs
                    (plan_version_id,calendar_id,line_id,machine_id,available_minutes,
                     required_minutes,source,created_by)
                SELECT %s,calendar_id,line_id,machine_id,available_minutes,
                       required_minutes,source,%s
                FROM production_workspace_capacity_inputs
                WHERE plan_version_id=%s
                """,
                (reopened["id"], actor["user_id"], plan_id),
            )
            cur.execute(
                """
                INSERT INTO production_workspace_changeovers
                    (plan_version_id,line_id,from_work_item_id,to_work_item_id,
                     changeover_date,minutes,note,created_by)
                SELECT %s,line_id,from_work_item_id,to_work_item_id,
                       changeover_date,minutes,note,%s
                FROM production_workspace_changeovers
                WHERE plan_version_id=%s
                """,
                (reopened["id"], actor["user_id"], plan_id),
            )
            cur.execute(
                "INSERT INTO production_workspace_workflow_revisions "
                "(plan_version_id,from_status,to_status,reason,changed_by,revision_no) "
                "VALUES (%s,'frozen','reopened',%s,%s,1)",
                (reopened["id"], reason, actor["user_id"]),
            )
            audit = _audit(
                cur, "plan_version", reopened["id"], "reopened_revision", actor, reason,
                before=frozen, after=reopened, request_id=_request_id(request),
            )
            _audit(
                cur, "plan_version", plan_id, "reopened_as_new_revision", actor, reason,
                before=frozen, after=frozen, request_id=_request_id(request),
            )
        return _mutation_result(_plan_detail(reopened["id"]), audit)
    except Exception:
        log.exception("workspace plan reopen failed")
        return _error("Could not reopen the production plan", 500)


def _gate_update(plan_id: int, gate_key: str, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace readiness changes")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    status = str(body.get("status") or "").lower()
    if not reason or expected is None or status not in ("pending", "passed", "failed", "waived"):
        return _error("status, expected_version and reason are required")
    actor = _actor(request)
    if status == "waived" and actor["role"] != "admin":
        return _error(
            "Only an administrator can record a readiness exception.",
            403, code="workspace_exception_not_authorized",
        )
    if status == "waived" and not str(body.get("note") or "").strip():
        return _error(
            "A recorded exception needs a note explaining why the gate is waived.",
            400, code="workspace_exception_reason_required",
        )
    if status in ("passed", "waived") and (
            body.get("owner_user_id") in (None, "") or body.get("due_date") in (None, "")):
        return _error(
            "A readiness gate needs an accountable owner and due date before it can pass or be waived.",
            400, code="workspace_readiness_accountability_required",
        )
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            cur.execute(
                "SELECT * FROM production_workspace_readiness_gates "
                "WHERE plan_version_id=%s AND gate_key=%s FOR UPDATE",
                (plan_id, gate_key),
            )
            gate = cur.fetchone()
            if not gate:
                return _error(f"Readiness gate {gate_key} not found", 404)
            cur.execute(
                "UPDATE production_workspace_readiness_gates SET status=%s, "
                "quality_ref=COALESCE(%s,quality_ref), evidence_ref=COALESCE(%s,evidence_ref), "
                "owner_user_id=COALESCE(%s,owner_user_id), due_date=COALESCE(%s,due_date), "
                "note=%s, checked_by=%s, checked_at=now(), "
                "exception_authorized_by=%s, "
                "exception_authorized_at=CASE WHEN %s THEN now() ELSE NULL END, "
                "version_token=version_token+1 WHERE id=%s RETURNING *",
                (
                    status, body.get("quality_ref"), body.get("evidence_ref"),
                    body.get("owner_user_id"), body.get("due_date"), body.get("note"),
                    actor["user_id"],
                    actor["user_id"] if status == "waived" else None,
                    status == "waived",
                    gate["id"],
                ),
            )
            after = cur.fetchone()
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1, "
                "updated_by=%s, updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(
                cur, "readiness_gate", gate["id"], "updated", actor, reason,
                before=gate, after=after, request_id=_request_id(request),
            )
            audit = _audit(
                cur, "plan_version", plan_id, "readiness_gate_updated", actor, reason,
                before=plan, after=plan_after, request_id=_request_id(request),
            )
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception:
        log.exception("workspace readiness update failed")
        return _error("Could not update the readiness gate", 500)


def _operation_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace operation changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            values = dict(body)
            definition_id = values.get("operation_definition_id")
            if definition_id in (None, ""):
                return _error("Choose an approved operation/SAM definition.", 400)
            cur.execute(
                "SELECT * FROM production_workspace_operation_definitions "
                "WHERE id=%s AND active AND status='approved' FOR SHARE", (definition_id,),
            )
            definition = cur.fetchone()
            if not definition:
                return _error("Choose an approved active operation/SAM definition.", 400)
            values.update({
                "operation_code": definition["operation_code"],
                "name": definition["name"],
                "sam_minutes": definition["default_sam_minutes"],
                "capability_id": definition["capability_id"],
            })
            required = ("operation_code", "name", "sequence_no", "sam_minutes")
            if any(values.get(c) in (None, "") for c in required):
                return _error(
                    "The selected operation/SAM definition needs a sequence number."
                )
            relationship_error = _scope_relationship_error(
                cur, factory_id=plan["factory_id"],
                line_id=values.get("line_id") or plan.get("line_id"),
                capability_id=values.get("capability_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                "INSERT INTO production_workspace_operations "
                "(work_item_id,plan_version_id,operation_code,name,sequence_no,sam_minutes,capability_id,line_id,created_by,updated_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (plan["work_item_id"], plan_id, values["operation_code"], values["name"],
                 values["sequence_no"], values["sam_minutes"], values.get("capability_id"),
                 values.get("line_id"), actor["user_id"], actor["user_id"]),
            )
            row = cur.fetchone()
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1, "
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(cur, "operation", row["id"], "created", actor, reason,
                   after=row, request_id=_request_id(request))
            audit = _audit(cur, "plan_version", plan_id, "operation_created",
                           actor, reason, before=plan, after=plan_after,
                           request_id=_request_id(request))
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That operation code or sequence already exists for this plan version.",
                          409, code="duplicate_workspace_record")
        return _error("Could not create the operation/SAM", 500)


def _assignment_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace assignment changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every production workspace change")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            operation_id = body.get("operation_id")
            operation = None
            if operation_id is not None:
                cur.execute(
                    "SELECT id,capability_id FROM production_workspace_operations "
                    "WHERE id=%s AND plan_version_id=%s FOR UPDATE",
                    (operation_id, plan_id),
                )
                operation = cur.fetchone()
                if not operation:
                    return _error(
                        "The assigned operation must belong to this plan revision. Refresh and choose an operation from this plan.",
                        409, code="workspace_assignment_operation_mismatch",
                    )
            if operation and operation.get("capability_id") and (
                    body.get("operator_id") in (None, "") or body.get("machine_id") in (None, "")):
                return _error(
                    "A capability-bound operation needs both a qualified operator and a compatible machine.",
                    400, code="workspace_capability_allocation_required",
                )
            if operation and operation.get("capability_id"):
                cur.execute(
                    """
                    SELECT worker.active AS operator_active, machine.active AS machine_active,
                           cap.machine_id AS capability_machine_id,
                           EXISTS (
                               SELECT 1 FROM production_workspace_operator_skills os
                               JOIN production_workspace_skills sk ON sk.id=os.skill_id
                               WHERE os.operator_id=worker.id AND sk.skill_key=cap.capability_key AND sk.active
                           ) AS skill_matches
                    FROM production_workspace_capabilities cap
                    JOIN production_workspace_operators worker ON worker.id=%s
                    JOIN production_workspace_machines machine ON machine.id=%s
                    WHERE cap.id=%s
                    """,
                    (body["operator_id"], body["machine_id"], operation["capability_id"]),
                )
                allocation = cur.fetchone()
                if not allocation or not allocation["operator_active"] or not allocation["machine_active"] \
                        or not allocation["skill_matches"] \
                        or (allocation["capability_machine_id"] is not None
                            and int(allocation["capability_machine_id"]) != int(body["machine_id"])):
                    return _error(
                        "The allocation must use active, skill-qualified staff and a machine compatible with the operation.",
                        400, code="workspace_capability_allocation_invalid",
                    )
            relationship_error = _scope_relationship_error(
                cur, factory_id=plan["factory_id"],
                line_id=body.get("line_id") or plan.get("line_id"),
                machine_id=body.get("machine_id"), capability_id=None,
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                """
                INSERT INTO production_workspace_assignments
                    (plan_version_id,operation_id,operator_id,line_id,machine_id,
                     assignment_role,planned_minutes,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (plan_id, operation_id, body.get("operator_id"),
                 body.get("line_id"), body.get("machine_id"),
                 body.get("assignment_role") or "operator",
                 body.get("planned_minutes") or 0, actor["user_id"]),
            )
            row = cur.fetchone()
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1, "
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(cur, "assignment", row["id"], "created", actor, reason,
                   after=row, request_id=_request_id(request))
            audit = _audit(cur, "plan_version", plan_id, "assignment_created",
                           actor, reason, before=plan, after=plan_after,
                           request_id=_request_id(request))
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That assignment already exists.", 409,
                          code="duplicate_workspace_record")
        return _error("Could not create the production assignment", 500)


def _capacity_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace capacity changes")
    if denied:
        return denied
    reason = _reason(body)
    required = ("calendar_id", "available_minutes", "required_minutes")
    if not reason or any(body.get(c) in (None, "") for c in required):
        return _error("calendar_id, available_minutes, required_minutes and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            relationship_error = _scope_relationship_error(
                cur, factory_id=plan["factory_id"],
                line_id=body.get("line_id") or plan.get("line_id"),
                shift_id=plan.get("shift_id"), machine_id=body.get("machine_id"),
                calendar_id=body.get("calendar_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                "SELECT calendar_date,capacity_minutes FROM production_workspace_calendars "
                "WHERE id=%s FOR UPDATE", (body["calendar_id"],),
            )
            calendar = cur.fetchone()
            if not calendar or not (plan["planned_start"] <= calendar["calendar_date"] <= plan["planned_end"]):
                return _error(
                    "Capacity calendar date must fall within this plan's dated window.",
                    400, code="workspace_capacity_date_outside_plan",
                )
            available_minutes = float(body["available_minutes"])
            if available_minutes < 0 or float(body["required_minutes"]) < 0:
                return _error("Capacity minutes cannot be negative.")
            cur.execute(
                """
                SELECT ci.available_minutes
                FROM production_workspace_capacity_inputs ci
                JOIN production_workspace_plan_versions p ON p.id=ci.plan_version_id
                WHERE ci.calendar_id=%s
                  AND p.status IN ('draft','reopened','submitted','approved','frozen')
                  AND NOT EXISTS (
                      SELECT 1 FROM production_workspace_plan_versions superseding
                      WHERE superseding.reopened_from_id=p.id
                  )
                FOR UPDATE OF ci, p
                """,
                (body["calendar_id"],),
            )
            already_allocated = sum(float(row["available_minutes"] or 0) for row in cur.fetchall())
            calendar_minutes = float(calendar["capacity_minutes"] or 0)
            if available_minutes + already_allocated > calendar_minutes:
                return _error(
                    "This capacity input would allocate more minutes than the approved calendar provides.",
                    422, code="workspace_calendar_over_allocated",
                )
            cur.execute(
                """
                INSERT INTO production_workspace_capacity_inputs
                    (plan_version_id,calendar_id,line_id,machine_id,
                     available_minutes,required_minutes,source,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (plan_id, body.get("calendar_id"), body.get("line_id"),
                  body.get("machine_id"), available_minutes,
                 body["required_minutes"], body.get("source") or "planner",
                 actor["user_id"]),
            )
            row = cur.fetchone()
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1, "
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(cur, "capacity_input", row["id"], "created", actor, reason,
                   after=row, request_id=_request_id(request))
            audit = _audit(cur, "plan_version", plan_id, "capacity_created",
                           actor, reason, before=plan, after=plan_after,
                           request_id=_request_id(request))
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That capacity input already exists.", 409,
                          code="duplicate_workspace_record")
        return _error("Could not create the capacity input", 500)


def _changeover_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace changeover changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason or body.get("changeover_date") in (None, "") or body.get("minutes") in (None, ""):
        return _error("changeover_date, minutes and reason are required")
    try:
        minutes = float(body["minutes"])
        date.fromisoformat(str(body["changeover_date"]))
        if minutes < 0:
            raise ValueError
    except (TypeError, ValueError):
        return _error("Changeover date must be ISO format and minutes cannot be negative")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            relationship_error = _scope_relationship_error(
                cur, factory_id=plan["factory_id"],
                line_id=body.get("line_id") or plan.get("line_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400, code="workspace_scope_mismatch")
            changeover_date = date.fromisoformat(str(body["changeover_date"]))
            if not (plan["planned_start"] <= changeover_date <= plan["planned_end"]):
                return _error(
                    "Changeover date must fall within this plan's dated window.",
                    400, code="workspace_changeover_date_outside_plan",
                )
            for work_item_id in (body.get("from_work_item_id"), body.get("to_work_item_id")):
                if work_item_id in (None, ""):
                    continue
                cur.execute(
                    """
                    SELECT EXISTS(
                        SELECT 1 FROM production_workspace_plan_versions peer
                        WHERE peer.work_item_id=%s AND peer.factory_id=%s
                          AND peer.line_id IS NOT DISTINCT FROM %s
                    ) AS allowed
                    """,
                    (work_item_id, plan["factory_id"], plan.get("line_id")),
                )
                if not cur.fetchone()["allowed"]:
                    return _error(
                        "Changeover work items must be planned on the same factory and line.",
                        400, code="workspace_changeover_scope_mismatch",
                    )
            cur.execute(
                """
                INSERT INTO production_workspace_changeovers
                    (plan_version_id,line_id,from_work_item_id,to_work_item_id,
                     changeover_date,minutes,note,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (plan_id, body.get("line_id"), body.get("from_work_item_id"),
                 body.get("to_work_item_id"), body["changeover_date"], minutes,
                 body.get("note"), actor["user_id"]),
            )
            row = cur.fetchone()
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1, "
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(cur, "changeover", row["id"], "created", actor, reason,
                   after=row, request_id=_request_id(request))
            audit = _audit(cur, "plan_version", plan_id, "changeover_created",
                           actor, reason, before=plan, after=plan_after,
                           request_id=_request_id(request))
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That changeover is already recorded for this line and date.", 409,
                          code="duplicate_workspace_record")
        return _error("Could not create the changeover", 500)


_PLAN_INPUT_TABLES = {
    "operations": "production_workspace_operations",
    "assignments": "production_workspace_assignments",
    "capacity-inputs": "production_workspace_capacity_inputs",
    "changeovers": "production_workspace_changeovers",
}


def _plan_input_delete(plan_id: int, kind: str, record_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace plan input correction")
    if denied:
        return denied
    if kind not in _PLAN_INPUT_TABLES:
        return _error("Unknown plan input type.", 404)
    reason = _reason(body)
    if not reason:
        return _error("reason is required when removing a plan input")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            table = _PLAN_INPUT_TABLES[kind]
            cur.execute(f"SELECT * FROM {table} WHERE id=%s AND plan_version_id=%s FOR UPDATE",
                        (record_id, plan_id))
            before = cur.fetchone()
            if not before:
                return _error("Plan input not found in this revision.", 404)
            cur.execute(f"DELETE FROM {table} WHERE id=%s", (record_id,))
            cur.execute(
                "UPDATE production_workspace_plan_versions SET version_token=version_token+1,"
                "updated_by=%s,updated_at=now() WHERE id=%s RETURNING *",
                (actor["user_id"], plan_id),
            )
            plan_after = cur.fetchone()
            _audit(cur, kind.rstrip("s"), record_id, "removed", actor, reason,
                   before=before, request_id=_request_id(request))
            audit = _audit(cur, "plan_version", plan_id, f"{kind}_removed", actor, reason,
                           before=plan, after=plan_after, request_id=_request_id(request))
        return _mutation_result(_plan_detail(plan_id), audit)
    except Exception:
        log.exception("workspace plan input removal failed")
        return _error("Could not remove the plan input", 500)


_BULK_IDENTITIES = {
    "factories": ("code",),
    "lines": ("factory_id", "code"),
    "shifts": ("factory_id", "code"),
    "calendars": ("factory_id", "calendar_date", "shift_id"),
    "machines": ("factory_id", "code"),
    "capabilities": ("capability_key",),
    "operators": ("operator_code",),
    "skills": ("skill_key",),
    "operation_definitions": ("operation_code",),
    "targets": ("factory_id", "line_id", "target_date"),
}


def _bulk_rows(body):
    rows = body.get("rows") if isinstance(body, dict) else None
    if isinstance(rows, list):
        return rows
    text = str((body or {}).get("csv") or "").strip()
    if not text:
        return []
    return list(csv.DictReader(io.StringIO(text)))


def _bulk_validate(resource, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES, "Production workspace bulk planning")
    if denied:
        return denied
    if resource not in _CATALOGUE_TABLES:
        return _error(f"Unknown template: {resource}", 404)
    rows = _bulk_rows(body)
    if not rows:
        return _error("Upload at least one data row to preview.", 400)
    if len(rows) > 2000:
        return _error("A single import is limited to 2,000 rows.", 400)
    cols = _CATALOGUE_COLUMNS[resource]
    required = _CATALOGUE_REQUIRED[resource]
    identities = _BULK_IDENTITIES[resource]
    seen = set()
    results = []
    with _tx() as cur:
        for index, raw in enumerate(rows, start=2):
            row = {key: raw.get(key) for key in cols}
            if resource in ("targets", "operation_definitions"):
                row["status"] = "draft"
            errors = [f"{field} is required" for field in required if row.get(field) in (None, "")]
            if resource in ("targets",) and row.get("target_qty") not in (None, ""):
                try:
                    if float(row["target_qty"]) <= 0:
                        errors.append("target_qty must be greater than zero")
                except (TypeError, ValueError):
                    errors.append("target_qty must be numeric")
            if resource == "operation_definitions" and row.get("default_sam_minutes") not in (None, ""):
                try:
                    if float(row["default_sam_minutes"]) <= 0:
                        errors.append("default_sam_minutes must be greater than zero")
                except (TypeError, ValueError):
                    errors.append("default_sam_minutes must be numeric")
            identity = tuple(str(row.get(field) or "").strip() for field in identities)
            if identity in seen:
                errors.append("duplicate row identity in this file")
            seen.add(identity)
            if not errors:
                relationship_error = _catalogue_relationship_error(cur, resource, row)
                if relationship_error:
                    errors.append(relationship_error)
            results.append({"row": index, "identity": " / ".join(identity),
                            "values": row, "errors": errors, "valid": not errors})
    return {
        "resource": resource, "columns": list(cols), "rows": results,
        "valid": all(r["valid"] for r in results), "row_count": len(results),
    }


def _bulk_import(resource: str, request: Request, body: dict):
    preview = _bulk_validate(resource, request, body)
    if isinstance(preview, JSONResponse):
        return preview
    if not preview["valid"]:
        return _error("Fix every row error before committing this import.", 422,
                      preview=preview, code="workspace_bulk_invalid")
    reason = _reason(body)
    if not reason:
        return _error("reason is required before committing a bulk import", 400)
    actor = _actor(request)
    table = _CATALOGUE_TABLES[resource]
    cols = list(_CATALOGUE_COLUMNS[resource])
    identities = _BULK_IDENTITIES[resource]
    written = []
    try:
        with _tx() as cur:
            if resource in ("targets", "operation_definitions"):
                for result in preview["rows"]:
                    values = result["values"]
                    where = " AND ".join(f"{field} IS NOT DISTINCT FROM %s" for field in identities)
                    cur.execute(f"SELECT status FROM {table} WHERE {where} FOR UPDATE",
                                [values.get(field) for field in identities])
                    existing = cur.fetchone()
                    if existing and existing["status"] != "draft":
                        return _error(
                            "Bulk import cannot alter approved master data. Create and approve a replacement through the governed workflow.",
                            409, code="workspace_approved_master_immutable",
                        )
            for result in preview["rows"]:
                values = result["values"]
                where = " AND ".join(f"{field} IS NOT DISTINCT FROM %s" for field in identities)
                cur.execute(
                    f"SELECT * FROM {table} WHERE {where} FOR UPDATE",
                    [values.get(field) for field in identities],
                )
                before = cur.fetchone()
                if before:
                    editable = [field for field in cols if field not in identities]
                    assignments = ",".join(f"{field}=%s" for field in editable)
                    cur.execute(
                        f"UPDATE {table} SET {assignments}, version_token=version_token+1, "
                        "updated_by=%s, updated_at=now() WHERE id=%s RETURNING *",
                        [values.get(field) for field in editable] + [actor["user_id"], before["id"]],
                    )
                    after = cur.fetchone()
                    action = "bulk_updated"
                else:
                    placeholders = ",".join(["%s"] * len(cols))
                    cur.execute(
                        f"INSERT INTO {table} ({','.join(cols)},created_by,updated_by) "
                        f"VALUES ({placeholders},%s,%s) RETURNING *",
                        [values.get(field) for field in cols] + [actor["user_id"], actor["user_id"]],
                    )
                    after, action = cur.fetchone(), "bulk_created"
                _audit(cur, resource, after["id"], action, actor, reason,
                       before=before, after=after, request_id=_request_id(request))
                written.append(_jsonable(after))
        return {"resource": resource, "committed": len(written), "records": written}
    except Exception:
        log.exception("workspace bulk import failed")
        return _error("The import was not committed. Correct the template and retry.", 500)


def _bulk_template(resource: str, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    if resource not in _CATALOGUE_COLUMNS:
        return _error(f"Unknown template: {resource}", 404)
    return {
        "resource": resource,
        "columns": list(_CATALOGUE_COLUMNS[resource]),
        "identity_columns": list(_BULK_IDENTITIES[resource]),
        "required_columns": list(_CATALOGUE_REQUIRED[resource]),
    }


def _execution_ref_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, PLANNER_ROLES | APPROVER_ROLES,
                           "Production workspace execution references")
    if denied:
        return denied
    reason = _reason(body)
    if not reason or body.get("work_item_id") in (None, "") \
            or body.get("reference_type") in (None, "") \
            or body.get("reference_key") in (None, ""):
        return _error("work_item_id, reference_type, reference_key and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan = _plan_from_cur(cur, plan_id, lock=True)
            if not plan:
                return _error(f"Plan {plan_id} not found", 404)
            if actor["role"] == "production" and not _can_manage_plan(actor, plan):
                return _error(
                    "Only the plan owner or an administrator can link execution references.",
                    403, code="workspace_plan_owner_required",
                )
            if int(body["work_item_id"]) != int(plan["work_item_id"]):
                return _error(
                    "Execution references must belong to the plan's work item.",
                    400, code="workspace_execution_work_item_mismatch",
                )
            cur.execute(
                """
                INSERT INTO production_workspace_execution_references
                    (plan_version_id,work_item_id,production_order_ref,stage_movement_id,
                     reference_type,reference_key,quantity,observed_at,note,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (plan_id, body["work_item_id"], body.get("production_order_ref"),
                 body.get("stage_movement_id"), body["reference_type"],
                 body["reference_key"], body.get("quantity"),
                 body.get("observed_at"), body.get("note"), actor["user_id"]),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, "execution_reference", row["id"], "created", actor, reason,
                after=row, request_id=_request_id(request),
            )
        return _mutation_result(row, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That execution reference already exists.", 409,
                          code="duplicate_workspace_record")
        return _error("Could not create the execution reference", 500)


def _audit_timeline(entity_type: str, entity_id: str, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace audit viewing")
    if denied:
        return denied
    rows = _db(
        "SELECT * FROM production_workspace_audit_events "
        "WHERE entity_type=%s AND entity_id=%s "
        "ORDER BY occurred_at DESC, id DESC",
        (entity_type, str(entity_id)), fetch=True,
    )
    return {"entity_type": entity_type, "entity_id": str(entity_id),
            "events": _rows(rows)}


def _tracker_references(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    return {
        "orders": _rows(_db(
            "SELECT order_ref, style_number, product_name AS style_name, order_qty, "
            "NULL::text AS bo_state "
            "FROM production_orders ORDER BY updated_at DESC NULLS LAST, order_ref",
            fetch=True)),
        "stages": _rows(_db(
            "SELECT stage_key, stage_name, sort_order, allowed_next, is_terminal "
            "FROM production_stages ORDER BY sort_order", fetch=True)),
        "contract": {
            "stage_movements_are_read_only_here": True,
            "quality_records_are_referenced_not_copied": True,
        },
    }


def _catalogue_create_endpoint(resource: str, request: Request,
                               body: dict = Body(default={})):
    return _catalogue_create(resource, request, body)


def _catalogue_update_endpoint(resource: str, record_id: int, request: Request,
                               body: dict = Body(default={})):
    return _catalogue_update(resource, record_id, request, body)


def _target_approve_endpoint(target_id: int, request: Request,
                             body: dict = Body(default={})):
    return _target_approve(target_id, request, body)


def _operation_definition_approve_endpoint(definition_id: int, request: Request,
                                           body: dict = Body(default={})):
    return _operation_definition_approve(definition_id, request, body)


def _catalogue_revise_endpoint(resource: str, record_id: int, request: Request,
                               body: dict = Body(default={})):
    return _catalogue_revise(resource, record_id, request, body)


def _operator_skill_create_endpoint(operator_id: int, request: Request,
                                    body: dict = Body(default={})):
    return _operator_skill_create(operator_id, request, body)


def _work_item_create_endpoint(request: Request, body: dict = Body(default={})):
    return _work_item_create(request, body)


def _work_item_update_endpoint(work_item_id: int, request: Request,
                               body: dict = Body(default={})):
    return _work_item_update(work_item_id, request, body)


def _plan_create_endpoint(work_item_id: int, request: Request,
                          body: dict = Body(default={})):
    return _plan_create(work_item_id, request, body)


def _plan_update_endpoint(plan_id: int, request: Request,
                          body: dict = Body(default={})):
    return _plan_update(plan_id, request, body)


def _plan_submit_endpoint(plan_id: int, request: Request,
                          body: dict = Body(default={})):
    return _plan_transition(plan_id, "submitted", request, body)


def _plan_approve_endpoint(plan_id: int, request: Request,
                           body: dict = Body(default={})):
    return _plan_transition(plan_id, "approved", request, body)


def _plan_freeze_endpoint(plan_id: int, request: Request,
                          body: dict = Body(default={})):
    return _plan_transition(plan_id, "frozen", request, body)


def _plan_reopen_endpoint(plan_id: int, request: Request,
                           body: dict = Body(default={})):
    return _plan_reopen(plan_id, request, body)


def _gate_update_endpoint(plan_id: int, gate_key: str, request: Request,
                          body: dict = Body(default={})):
    return _gate_update(plan_id, gate_key, request, body)


def _operation_create_endpoint(plan_id: int, request: Request,
                               body: dict = Body(default={})):
    return _operation_create(plan_id, request, body)


def _assignment_create_endpoint(plan_id: int, request: Request,
                                body: dict = Body(default={})):
    return _assignment_create(plan_id, request, body)


def _capacity_create_endpoint(plan_id: int, request: Request,
                              body: dict = Body(default={})):
    return _capacity_create(plan_id, request, body)


def _changeover_create_endpoint(plan_id: int, request: Request,
                                body: dict = Body(default={})):
    return _changeover_create(plan_id, request, body)


def _plan_input_delete_endpoint(plan_id: int, kind: str, record_id: int, request: Request,
                                body: dict = Body(default={})):
    return _plan_input_delete(plan_id, kind, record_id, request, body)


def _bulk_validate_endpoint(resource: str, request: Request,
                            body: dict = Body(default={})):
    return _bulk_validate(resource, request, body)


def _bulk_import_endpoint(resource: str, request: Request,
                          body: dict = Body(default={})):
    return _bulk_import(resource, request, body)


def _execution_ref_create_endpoint(plan_id: int, request: Request,
                                   body: dict = Body(default={})):
    return _execution_ref_create(plan_id, request, body)


def _audit_timeline_endpoint(entity_type: str, entity_id: str, request: Request):
    return _audit_timeline(entity_type, entity_id, request)


def register_production_workspace_routes(app, api_module):
    """Register routes after the main API has defined its auth/db helpers."""
    global _API
    _API = api_module

    app.add_api_route("/api/production-workspace", _workspace_root, methods=["GET"])
    app.add_api_route("/api/production-workspace/catalogues", _catalogues, methods=["GET"])
    app.add_api_route("/api/production-workspace/catalogues/{resource}",
                      _catalogue_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/catalogues/{resource}/{record_id}",
                      _catalogue_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/catalogues/{resource}/{record_id}/revise",
                      _catalogue_revise_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/targets/{target_id}/approve",
                      _target_approve_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/operation-definitions/{definition_id}/approve",
                      _operation_definition_approve_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/operators/{operator_id}/skills",
                      _operator_skill_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/work-items", _work_items, methods=["GET"])
    app.add_api_route("/api/production-workspace/work-items",
                      _work_item_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/work-items/{work_item_id}",
                      _work_item_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/plans", _plans, methods=["GET"])
    app.add_api_route("/api/production-workspace/work-items/{work_item_id}/plans",
                      _plan_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}",
                      _plan_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}",
                      _plan_get, methods=["GET"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/feasibility",
                      _plan_feasibility, methods=["GET"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/submit",
                      _plan_submit_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/approve",
                      _plan_approve_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/freeze",
                      _plan_freeze_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/reopen",
                      _plan_reopen_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/gates/{gate_key}",
                      _gate_update_endpoint, methods=["PUT"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/operations",
                      _operation_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/assignments",
                      _assignment_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/capacity-inputs",
                      _capacity_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/changeovers",
                      _changeover_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/{kind}/{record_id}",
                      _plan_input_delete_endpoint, methods=["DELETE"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}/execution-references",
                      _execution_ref_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/audit/{entity_type}/{entity_id}",
                      _audit_timeline_endpoint, methods=["GET"])
    app.add_api_route(
        "/api/production-workspace/tracker-references",
        _tracker_references, methods=["GET"],
    )
    app.add_api_route(
        "/api/production-workspace/bulk/{resource}/template",
        _bulk_template, methods=["GET"],
    )
    app.add_api_route(
        "/api/production-workspace/bulk/{resource}/preview",
        _bulk_validate_endpoint, methods=["POST"],
    )
    app.add_api_route(
        "/api/production-workspace/bulk/{resource}/commit",
        _bulk_import_endpoint, methods=["POST"],
    )