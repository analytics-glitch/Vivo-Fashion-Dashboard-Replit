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
from urllib.parse import urlsplit

import psycopg2
import psycopg2.errors
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
QUALITY_ROLES = {"quality", "fabric_quality_supervisor"}
PRODUCT_ROLES = {"product_development"}
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
    "defect_codes": "production_workspace_defect_codes",
    "downtime_reasons": "production_workspace_downtime_reasons",
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
    "defect_codes": ("code", "name", "category", "active"),
    "downtime_reasons": ("code", "name", "category", "active"),
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
    "defect_codes": ("code", "name"),
    "downtime_reasons": ("code", "name"),
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
    _tracker_sheet_seed_if_needed()


def _tracker_sheet_seed_if_needed():
    """Fire-and-forget: launch the one-time Production Tracker Sheet baseline
    seed as a background subprocess so a fresh/rebuilt database always shows
    the confirmed baseline dataset without a manual step. The seed script is
    itself idempotent (no-ops once a 'seed' run already exists), so calling
    this on every boot is safe and never blocks the API port from opening."""
    import subprocess
    import sys
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.Popen(
            [sys.executable, os.path.join(here, "production_tracker_sheet_sync.py"),
             "--seed-baseline"],
            cwd=here, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        log.exception("Failed to launch Production Tracker Sheet baseline seed")


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


def _plan_scope_sql(actor, alias="p"):
    """SQL predicate for the operational owner-or-assignee boundary.

    Read endpoints use this exact predicate before aggregation.  Post-filtering
    a response would still leak totals, and caching a role-wide result would
    leak another operator's plan through a copied URL.
    """
    if actor["role"] != "production":
        return "TRUE", []
    # A missing authenticated identity must never turn into a broad plan read.
    # This also keeps every aggregate that embeds this predicate fail-closed.
    if not actor.get("user_id"):
        return "FALSE", []
    return (
        f"""({alias}.owner_user_id=%s OR EXISTS (
              SELECT 1
              FROM production_workspace_assignments scoped_assignment
              JOIN production_workspace_operators scoped_operator
                ON scoped_operator.id=scoped_assignment.operator_id
             WHERE scoped_assignment.plan_version_id={alias}.id
               AND scoped_operator.user_id=%s
               AND scoped_operator.active
            ))""",
        [actor["user_id"], actor["user_id"]],
    )


def _command_scope(request, *, date_from="", date_to="", stage="", factory_id="",
                   line_id="", shift_id="", owner_user_id="", plan_status="",
                   search=""):
    """Normalize Command Centre filters before they reach plan-backed rows."""
    actor = _actor(request)
    privacy = actor["role"] in QUALITY_ROLES | PRODUCT_ROLES
    return {
        "date_from": str(date_from or ""),
        "date_to": str(date_to or ""),
        "stage": str(stage or ""),
        "factory_id": str(factory_id or ""),
        "line_id": str(line_id or ""),
        "shift_id": str(shift_id or ""),
        "owner_user_id": "" if privacy else str(owner_user_id or ""),
        "plan_status": str(plan_status or "").lower(),
        "search": str(search or ""),
        "unsupported_filters": ["delivery_risk"],
    }


def _command_scope_sql(scope, *, plan_alias="p", work_item_alias="wi",
                       include_plan_dates=True):
    """Return a pre-aggregation predicate for every compatible Command filter."""
    clauses, params = [], []
    if include_plan_dates and scope["date_from"]:
        clauses.append(f"{plan_alias}.planned_start >= %s")
        params.append(scope["date_from"])
    if include_plan_dates and scope["date_to"]:
        clauses.append(f"{plan_alias}.planned_end <= %s")
        params.append(scope["date_to"])
    for key, column in (("factory_id", "factory_id"), ("line_id", "line_id"), ("shift_id", "shift_id")):
        if scope[key]:
            clauses.append(f"{plan_alias}.{column}=%s::bigint")
            params.append(scope[key])
    if scope["owner_user_id"]:
        clauses.append(f"{plan_alias}.owner_user_id=%s")
        params.append(scope["owner_user_id"])
    if scope["plan_status"]:
        clauses.append(f"{plan_alias}.status=%s")
        params.append(scope["plan_status"])
    if scope["stage"]:
        clauses.append(f"{work_item_alias}.stage_key=%s")
        params.append(scope["stage"])
    if scope["search"]:
        clauses.append(
            f"concat_ws(' ',{work_item_alias}.external_ref,{work_item_alias}.style_number,"
            f"{work_item_alias}.production_order_ref) ILIKE '%%' || %s || '%%'"
        )
        params.append(scope["search"])
    return clauses, params


def _plan_is_visible(request, plan_id):
    actor = _actor(request)
    predicate, params = _plan_scope_sql(actor)
    rows = _db(
        f"SELECT 1 FROM production_workspace_plan_versions p "
        f"WHERE p.id=%s AND {predicate}",
        [plan_id, *params], fetch=True,
    )
    return bool(rows)


def _privacy_safe_workspace_payload(request, value):
    """Remove staff/owner identity from Quality and Product Development reads."""
    if _actor(request)["role"] not in QUALITY_ROLES | PRODUCT_ROLES:
        return value
    hidden = {
        "owner_user_id", "operator_user_id", "operator_id", "operator_name",
        "operator_code", "created_by", "updated_by", "actor_user_id", "actor_name", "display_name",
        "user_id", "member_user_id", "owner_name",
        "approved_by", "frozen_by", "changed_by", "submitted_by", "reopened_by",
    }
    if isinstance(value, dict):
        return {key: _privacy_safe_workspace_payload(request, item)
                for key, item in value.items() if key not in hidden}
    if isinstance(value, list):
        return [_privacy_safe_workspace_payload(request, item) for item in value]
    return value


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
        "SELECT * FROM production_workspace_execution_output "
        "WHERE plan_version_id=%s ORDER BY capture_date DESC, id DESC LIMIT 200", (pid,),
    )
    execution_output = cur.fetchall()
    cur.execute(
        "SELECT * FROM production_workspace_execution_events "
        "WHERE plan_version_id=%s ORDER BY event_date DESC, id DESC LIMIT 200", (pid,),
    )
    execution_events = cur.fetchall()
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
        "execution_output": _rows(execution_output),
        "execution_events": _rows(execution_events),
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
    if not _plan_is_visible(request, plan_id):
        return _error(f"Plan {plan_id} not found", 404)
    with _tx() as cur:
        plan = _plan_from_cur(cur, plan_id)
        if not plan:
            return _error(f"Plan {plan_id} not found", 404)
        return _privacy_safe_workspace_payload(
            request, _jsonable(_plan_feasibility_detail(cur, plan)))


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
    return _privacy_safe_workspace_payload(
        request, {"schema_version": WORKSPACE_SCHEMA_VERSION, "catalogues": result})


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
    actor = _actor(request)
    predicate, params = _plan_scope_sql(actor, "p")
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
            WHERE p.work_item_id=wi.id AND """ + predicate + """
            ORDER BY p.version_no DESC LIMIT 1
        ) latest ON TRUE
        WHERE (%s <> 'production' OR EXISTS (
            SELECT 1 FROM production_workspace_plan_versions p
            WHERE p.work_item_id=wi.id AND """ + predicate + """))
        ORDER BY wi.updated_at DESC, wi.id DESC
        """, [*params, actor["role"], *params], fetch=True)
    return _privacy_safe_workspace_payload(
        request, {"schema_version": WORKSPACE_SCHEMA_VERSION, "work_items": _rows(rows)})


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


def _plans(request: Request, **scope_args):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    actor = _actor(request)
    predicate, params = _plan_scope_sql(actor)
    command_scope = _command_scope(request, **scope_args)
    command_clauses, command_params = _command_scope_sql(command_scope)
    rows = _db(
        """
        SELECT p.*, wi.external_ref, wi.style_number, wi.description,
               f.code AS factory_code, f.name AS factory_name,
               l.code AS line_code, l.name AS line_name
        FROM production_workspace_plan_versions p
        JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
        JOIN production_workspace_factories f ON f.id=p.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=p.line_id
        WHERE """ + predicate + ((" AND " + " AND ".join(command_clauses)) if command_clauses else "") + """
        ORDER BY p.updated_at DESC, p.id DESC
        """, [*params, *command_params], fetch=True)
    return _privacy_safe_workspace_payload(
        request, {"schema_version": WORKSPACE_SCHEMA_VERSION, "plans": _rows(rows),
                  "scope_applied": command_scope})


def _plan_get(plan_id: int, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    if not _plan_is_visible(request, plan_id):
        return _error(f"Plan {plan_id} not found", 404)
    detail = _plan_detail(plan_id)
    return _privacy_safe_workspace_payload(request, detail) if detail else _error(
        f"Plan {plan_id} not found", 404)


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
    "defect_codes": ("code",),
    "downtime_reasons": ("code",),
    "operator_skills": ("operator_code", "skill_key"),
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
    if resource not in _CATALOGUE_TABLES and resource != "operator_skills":
        return _error(f"Unknown template: {resource}", 404)
    rows = _bulk_rows(body)
    if not rows:
        return _error("Upload at least one data row to preview.", 400)
    if len(rows) > 2000:
        return _error("A single import is limited to 2,000 rows.", 400)
    cols = _CATALOGUE_COLUMNS.get(resource, ("operator_code", "skill_key", "skill_level"))
    required = _CATALOGUE_REQUIRED.get(resource, ("operator_code", "skill_key"))
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
            if resource == "operator_skills" and not errors:
                cur.execute("SELECT id FROM production_workspace_operators WHERE operator_code=%s",
                            (row["operator_code"],))
                if not cur.fetchone():
                    errors.append("operator_code does not match a maintained operator")
                cur.execute("SELECT id FROM production_workspace_skills WHERE skill_key=%s",
                            (row["skill_key"],))
                if not cur.fetchone():
                    errors.append("skill_key does not match a maintained skill")
            elif not errors:
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
    if resource == "operator_skills":
        written = []
        try:
            with _tx() as cur:
                for result in preview["rows"]:
                    values = result["values"]
                    cur.execute(
                        "SELECT id FROM production_workspace_operators WHERE operator_code=%s",
                        (values["operator_code"],),
                    )
                    operator = cur.fetchone()
                    cur.execute(
                        "SELECT id FROM production_workspace_skills WHERE skill_key=%s",
                        (values["skill_key"],),
                    )
                    skill = cur.fetchone()
                    cur.execute(
                        """
                        INSERT INTO production_workspace_operator_skills
                            (operator_id,skill_id,skill_level,verified_by)
                        VALUES (%s,%s,%s,%s)
                        ON CONFLICT (operator_id,skill_id) DO UPDATE
                        SET skill_level=EXCLUDED.skill_level, verified_by=EXCLUDED.verified_by,
                            verified_at=now()
                        RETURNING operator_id,skill_id,skill_level,verified_at,verified_by
                        """,
                        (operator["id"], skill["id"], values.get("skill_level") or None,
                         actor["user_id"]),
                    )
                    after = cur.fetchone()
                    entity_id = f"{after['operator_id']}:{after['skill_id']}"
                    _audit(cur, "operator_skill", entity_id, "bulk_upserted", actor, reason,
                           after=after, request_id=_request_id(request))
                    written.append(_jsonable(after))
            return {"resource": resource, "committed": len(written), "records": written}
        except Exception:
            log.exception("operator skill bulk import failed")
            return _error("The import was not committed. Correct the template and retry.", 500)
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
    if resource not in _CATALOGUE_COLUMNS and resource != "operator_skills":
        return _error(f"Unknown template: {resource}", 404)
    return {
        "resource": resource,
        "columns": list(_CATALOGUE_COLUMNS.get(
            resource, ("operator_code", "skill_key", "skill_level"))),
        "identity_columns": list(_BULK_IDENTITIES[resource]),
        "required_columns": list(_CATALOGUE_REQUIRED.get(
            resource, ("operator_code", "skill_key"))),
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


# ── Execution capture ---------------------------------------------------------
# These routes deliberately live beside the planning API, but execution data is
# a separate append-friendly ledger.  Plans become the authorization boundary:
# only approved/frozen plans can be captured, and no route here writes
# stage_movements (the Odoo-backed tracker remains the stage source of truth).
EXECUTION_CAPTURE_ROLES = VIEW_ROLES
# Viewing an approved plan is intentionally wider than changing its execution
# ledger. Production supervisors/admins own output and operational capture;
# Quality users may add or resolve QC evidence only.
EXECUTION_OUTPUT_ROLES = {"admin", "production"}
EXECUTION_EVENT_WRITE_ROLES = {
    "wip": {"admin", "production"},
    "downtime": {"admin", "production"},
    "attendance": {"admin", "production"},
    "qc_defect": {"admin", "production", "quality", "fabric_quality_supervisor"},
    "recovery": {"admin", "production"},
}
EXECUTION_EVENT_TYPES = {"wip", "downtime", "attendance", "qc_defect", "recovery"}
EXECUTION_EVENT_STATUSES = {"open", "in_progress", "resolved", "excused", "closed"}


class ExecutionBulkValidationError(Exception):
    """Abort an in-flight bulk transaction without committing partial rows."""


def _execution_date(value):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _execution_number(value, field, *, required=False):
    if value in (None, ""):
        if required:
            raise ValueError(f"{field} is required")
        return 0.0
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be numeric")
    if result < 0:
        raise ValueError(f"{field} cannot be negative")
    return result


def _execution_context(cur, body, actor, *, assignment_required=False,
                       event_type=None):
    """Validate the immutable plan/context tuple used by every capture."""
    try:
        plan_id = int(body.get("plan_version_id"))
    except (TypeError, ValueError):
        return None, None, _error("plan_version_id is required", 400)
    plan = _plan_from_cur(cur, plan_id, lock=True)
    if not plan:
        return None, None, _error(f"Plan {plan_id} not found", 404)
    if plan["status"] not in ("approved", "frozen"):
        return None, None, _error(
            "Execution can only be captured against an approved or frozen plan.",
            409, code="workspace_execution_plan_not_approved",
        )
    if actor["role"] == "production" and not _can_manage_plan(actor, plan):
        cur.execute(
            """
            SELECT 1
            FROM production_workspace_assignments a
            JOIN production_workspace_operators o ON o.id=a.operator_id
            WHERE a.plan_version_id=%s AND o.user_id=%s AND o.active
            LIMIT 1
            """,
            (plan_id, actor["user_id"]),
        )
        if not cur.fetchone():
            return None, None, _error(
                "This capture user is not assigned to the approved plan.",
                403, code="workspace_execution_assignment_required",
            )
    capture_date = _execution_date(body.get("capture_date") or body.get("event_date"))
    if not capture_date:
        return None, None, _error("A valid capture_date is required", 400)
    if capture_date < plan["planned_start"] or capture_date > plan["planned_end"]:
        return None, None, _error(
            "The capture date is outside the approved plan dates.",
            409, code="workspace_execution_plan_stale",
        )
    assignment = None
    assignment_id = body.get("assignment_id")
    if assignment_id not in (None, ""):
        try:
            assignment_id = int(assignment_id)
        except (TypeError, ValueError):
            return None, None, _error("assignment_id must be numeric", 400)
        cur.execute(
            """
            SELECT a.*, o.user_id AS operator_user_id
            FROM production_workspace_assignments a
            LEFT JOIN production_workspace_operators o ON o.id=a.operator_id
            WHERE a.id=%s AND a.plan_version_id=%s FOR UPDATE OF a
            """,
            (assignment_id, plan_id),
        )
        assignment = cur.fetchone()
        if not assignment:
            return None, None, _error(
                "The assignment does not belong to this plan revision.",
                409, code="workspace_execution_assignment_mismatch",
            )
    elif assignment_required:
        return None, None, _error(
            "Choose an approved line assignment before recording output.",
            400, code="workspace_execution_assignment_required",
        )
    if assignment and plan.get("line_id") and assignment.get("line_id") \
            and int(plan["line_id"]) != int(assignment["line_id"]):
        return None, None, _error(
            "The assignment line does not match the approved plan line.",
            409, code="workspace_execution_scope_mismatch",
        )
    if actor["role"] == "production" and assignment and assignment.get("operator_user_id") \
            and assignment["operator_user_id"] != actor["user_id"] \
            and not _can_manage_plan(actor, plan):
        return None, None, _error(
            "Only the assigned operator or plan owner can capture this row.",
            403, code="workspace_execution_assignment_required",
        )
    work_item_id = body.get("work_item_id") or plan["work_item_id"]
    try:
        work_item_id = int(work_item_id)
    except (TypeError, ValueError):
        return None, None, _error("work_item_id must be numeric", 400)
    if work_item_id != int(plan["work_item_id"]):
        return None, None, _error(
            "Execution must belong to the plan's work item.",
            409, code="workspace_execution_work_item_mismatch",
        )
    cur.execute(
        """
        SELECT wi.*, po.order_ref AS tracker_order_ref
        FROM production_workspace_work_items wi
        LEFT JOIN production_orders po ON po.order_ref=wi.production_order_ref
        WHERE wi.id=%s
        """,
        (work_item_id,),
    )
    work_item = cur.fetchone()
    if not work_item:
        return None, None, _error("The plan work item was not found.", 404)
    supplied_operation_id = body.get("operation_id")
    if assignment and assignment.get("operation_id"):
        if supplied_operation_id not in (None, "", assignment["operation_id"]):
            try:
                if int(supplied_operation_id) != int(assignment["operation_id"]):
                    return None, None, _error(
                        "The operation does not match the approved assignment.",
                        409, code="workspace_execution_operation_mismatch",
                    )
            except (TypeError, ValueError):
                return None, None, _error("operation_id must be numeric", 400)
    elif supplied_operation_id not in (None, ""):
        try:
            supplied_operation_id = int(supplied_operation_id)
        except (TypeError, ValueError):
            return None, None, _error("operation_id must be numeric", 400)
        cur.execute(
            "SELECT id FROM production_workspace_operations "
            "WHERE id=%s AND plan_version_id=%s",
            (supplied_operation_id, plan_id),
        )
        if not cur.fetchone():
            return None, None, _error(
                "The operation does not belong to this approved plan.",
                409, code="workspace_execution_operation_mismatch",
            )
    # Quality inspectors may capture a defect against an approved assignment,
    # but they cannot create production output, downtime, WIP, or recovery.
    if event_type == "qc_defect" and actor["role"] not in EXECUTION_EVENT_WRITE_ROLES[event_type]:
        return None, None, _error("Only authorized quality or production users can capture QC.", 403)
    return (plan, assignment, work_item, capture_date), None, None


def _execution_record_context_values(body, plan, assignment, work_item):
    operation_id = (assignment.get("operation_id") if assignment
                    and assignment.get("operation_id") else body.get("operation_id"))
    if operation_id not in (None, ""):
        operation_id = int(operation_id)
    return {
        "plan_version_id": plan["id"],
        "assignment_id": assignment["id"] if assignment else None,
        "work_item_id": work_item["id"],
        "production_order_ref": work_item.get("production_order_ref"),
        "factory_id": plan["factory_id"],
        "line_id": (assignment.get("line_id") if assignment and assignment.get("line_id")
                    else plan.get("line_id")),
        "shift_id": plan.get("shift_id"),
        "operation_id": operation_id,
    }


def _execution_output_payload(body):
    kind = str(body.get("capture_kind") or "").strip().lower()
    if kind not in ("hourly", "shift"):
        raise ValueError("capture_kind must be hourly or shift")
    hour = body.get("hour_no")
    if kind == "hourly":
        if hour in (None, ""):
            raise ValueError("hour_no is required for hourly capture")
        try:
            hour = int(hour)
        except (TypeError, ValueError):
            raise ValueError("hour_no must be an integer from 0 to 23")
        if hour < 0 or hour > 23:
            raise ValueError("hour_no must be an integer from 0 to 23")
    else:
        hour = None
    planned = _execution_number(body.get("planned_qty"), "planned_qty", required=True)
    good = _execution_number(body.get("good_qty"), "good_qty")
    reject = _execution_number(body.get("reject_qty"), "reject_qty")
    rework = _execution_number(body.get("rework_qty"), "rework_qty")
    total = good + reject + rework
    if planned <= 0:
        raise ValueError("planned_qty must be greater than zero")
    if total > planned:
        raise ValueError("Good + reject + rework cannot exceed planned quantity")
    key = str(body.get("capture_key") or "").strip()
    if not key:
        raise ValueError("capture_key is required for safe retry")
    if len(key) > 180:
        raise ValueError("capture_key is too long")
    return {
        "capture_kind": kind, "hour_no": hour, "capture_key": key,
        "planned_qty": planned, "good_qty": good, "reject_qty": reject,
        "rework_qty": rework, "comments": str(body.get("comments") or "").strip() or None,
    }


def _execution_output_response(row, *, idempotent=False):
    result = {"record": _jsonable(row), "idempotent": bool(idempotent)}
    return result


def _execution_output_create(plan_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_OUTPUT_ROLES, "Production output capture")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every execution capture")
    actor = _actor(request)
    try:
        output = _execution_output_payload(body)
    except ValueError as exc:
        return _error(str(exc), 400)
    # The path id and payload id must agree, avoiding a stale form writing to
    # another plan after the user changes tabs.
    if body.get("plan_version_id") not in (None, "", plan_id):
        try:
            if int(body["plan_version_id"]) != int(plan_id):
                return _error("The plan path and payload do not match.", 409)
        except (TypeError, ValueError):
            return _error("plan_version_id must be numeric", 400)
    body = dict(body)
    body["plan_version_id"] = plan_id
    try:
        with _tx() as cur:
            context, _, failure = _execution_context(
                cur, body, actor, assignment_required=True,
            )
            if failure:
                return failure
            plan, assignment, work_item, capture_date = context
            values = _execution_record_context_values(body, plan, assignment, work_item)
            cur.execute(
                "SELECT * FROM production_workspace_execution_output "
                "WHERE capture_key=%s FOR UPDATE", (output["capture_key"],),
            )
            existing = cur.fetchone()
            if existing:
                comparable = (
                    int(existing["plan_version_id"]) == int(values["plan_version_id"])
                    and (existing["assignment_id"] or None) == values["assignment_id"]
                    and str(existing["capture_kind"]) == output["capture_kind"]
                    and str(existing["capture_date"]) == capture_date.isoformat()
                    and (existing["hour_no"] or None) == output["hour_no"]
                    and all(abs(float(existing[k] or 0) - output[k]) < 0.00001
                            for k in ("planned_qty", "good_qty", "reject_qty", "rework_qty"))
                )
                if not comparable:
                    return _error(
                        "This capture key already belongs to different values. "
                        "Use a new key for a correction.",
                        409, code="workspace_execution_duplicate_conflict",
                    )
                return _execution_output_response(existing, idempotent=True)
            cur.execute(
                """
                INSERT INTO production_workspace_execution_output
                    (plan_version_id,assignment_id,work_item_id,production_order_ref,
                     factory_id,line_id,shift_id,operation_id,capture_kind,capture_date,
                     hour_no,capture_key,planned_qty,good_qty,reject_qty,rework_qty,
                     comments,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING *
                """,
                (
                    values["plan_version_id"], values["assignment_id"], values["work_item_id"],
                    values["production_order_ref"], values["factory_id"], values["line_id"],
                    values["shift_id"], values["operation_id"], output["capture_kind"],
                    capture_date, output["hour_no"], output["capture_key"],
                    output["planned_qty"], output["good_qty"], output["reject_qty"],
                    output["rework_qty"], output["comments"], actor["user_id"],
                    actor["user_id"],
                ),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, "execution_output", row["id"], "created", actor, reason,
                after=row, request_id=_request_id(request),
            )
        result = _execution_output_response(row)
        result["audit_event_id"] = audit["id"]
        return result
    except Exception as exc:
        if "check constraint" in str(exc).lower():
            return _error("Output quantities do not reconcile with planned quantity.", 400)
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("This capture was submitted already. Refresh and retry.", 409,
                          code="workspace_execution_duplicate_conflict")
        log.exception("execution output create failed")
        return _error("Could not save the output capture", 500)


def _execution_output_update(output_id: int, request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_OUTPUT_ROLES, "Production output correction")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required for a correction")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_execution_output WHERE id=%s FOR UPDATE",
                (output_id,),
            )
            before = cur.fetchone()
            if not before:
                return _error("Output capture not found", 404)
            if expected != int(before["version_token"]):
                return _version_error(expected, int(before["version_token"]))
            context_body = {
                "plan_version_id": before["plan_version_id"],
                "work_item_id": before["work_item_id"],
                "assignment_id": before["assignment_id"],
                "capture_date": before["capture_date"],
            }
            context, _, failure = _execution_context(cur, context_body, actor)
            if failure:
                return failure
            candidate = dict(before)
            candidate.update(body)
            candidate["planned_qty"] = body.get("planned_qty", before["planned_qty"])
            candidate["good_qty"] = body.get("good_qty", before["good_qty"])
            candidate["reject_qty"] = body.get("reject_qty", before["reject_qty"])
            candidate["rework_qty"] = body.get("rework_qty", before["rework_qty"])
            payload = _execution_output_payload({
                **candidate, "capture_kind": before["capture_kind"],
                "capture_key": before["capture_key"],
            })
            cur.execute(
                """
                UPDATE production_workspace_execution_output
                SET planned_qty=%s,good_qty=%s,reject_qty=%s,rework_qty=%s,
                    comments=%s,version_token=version_token+1,updated_by=%s,updated_at=now()
                WHERE id=%s RETURNING *
                """,
                (payload["planned_qty"], payload["good_qty"], payload["reject_qty"],
                 payload["rework_qty"], payload["comments"], actor["user_id"], output_id),
            )
            after = cur.fetchone()
            audit = _audit(
                cur, "execution_output", output_id, "corrected", actor, reason,
                before=before, after=after, request_id=_request_id(request),
            )
        result = _execution_output_response(after)
        result["audit_event_id"] = audit["id"]
        return result
    except ValueError as exc:
        return _error(str(exc), 400)
    except Exception:
        log.exception("execution output correction failed")
        return _error("Could not save the output correction", 500)


def _execution_outputs(request: Request, capture_date=None, plan_version_id=None, **scope_args):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_CAPTURE_ROLES, "Production execution viewing")
    if denied:
        return denied
    actor = _actor(request)
    clauses, params = [], []
    if capture_date and _execution_date(capture_date):
        clauses.append("o.capture_date=%s")
        params.append(_execution_date(capture_date))
    if plan_version_id:
        clauses.append("o.plan_version_id=%s")
        params.append(plan_version_id)
    scope, scope_params = _plan_scope_sql(actor, "p")
    command_scope = _command_scope(request, **scope_args)
    command_clauses, command_params = _command_scope_sql(
        command_scope, include_plan_dates=False)
    clauses.append(scope)
    params.extend(scope_params)
    clauses.extend(command_clauses)
    params.extend(command_params)
    where = " WHERE " + " AND ".join(clauses)
    rows = _db(
        f"""
        SELECT o.*,f.name AS factory_name,l.name AS line_name,sh.name AS shift_name,
               wi.external_ref,wi.style_number,po.product_name AS order_style_name,
               op.name AS operation_name
        FROM production_workspace_execution_output o
        JOIN production_workspace_plan_versions p ON p.id=o.plan_version_id
        JOIN production_workspace_factories f ON f.id=o.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=o.line_id
        LEFT JOIN production_workspace_shifts sh ON sh.id=o.shift_id
        JOIN production_workspace_work_items wi ON wi.id=o.work_item_id
        LEFT JOIN production_orders po ON po.order_ref=o.production_order_ref
        LEFT JOIN production_workspace_operations op ON op.id=o.operation_id
        {where}
        ORDER BY o.capture_date DESC,o.capture_kind,o.hour_no NULLS LAST,o.id DESC
        LIMIT 500
        """,
        params, fetch=True,
    )
    return _privacy_safe_workspace_payload(request, {"output": _rows(rows),
                  "scope_applied": command_scope})


def _execution_worklist(request: Request, capture_date=None, **scope_args):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_CAPTURE_ROLES, "Production execution viewing")
    if denied:
        return denied
    actor = _actor(request)
    day = _execution_date(capture_date) or date.today()
    scope, scope_params = _plan_scope_sql(actor, "p")
    command_scope = _command_scope(request, **scope_args)
    command_clauses, command_params = _command_scope_sql(
        command_scope, include_plan_dates=False)
    rows = _db(
        """
        SELECT p.id AS plan_version_id,p.version_no,p.status,p.planned_start,p.planned_end,
               p.planned_qty,p.factory_id,f.code AS factory_code,f.name AS factory_name,
               p.line_id,l.code AS line_code,l.name AS line_name,
               p.shift_id,sh.code AS shift_code,sh.name AS shift_name,
               wi.id AS work_item_id,wi.external_ref,wi.style_number,wi.description,
               wi.production_order_ref,po.product_name AS order_style_name,
               a.id AS assignment_id,a.assignment_role,a.planned_minutes,
               a.operation_id,op.operation_code,op.name AS operation_name,
               a.operator_id,worker.display_name AS operator_name,
               COALESCE(outp.output_qty,0) AS captured_qty,
               COALESCE(outp.capture_count,0) AS capture_count
        FROM production_workspace_plan_versions p
        JOIN production_workspace_factories f ON f.id=p.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=p.line_id
        LEFT JOIN production_workspace_shifts sh ON sh.id=p.shift_id
        JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
        LEFT JOIN production_orders po ON po.order_ref=wi.production_order_ref
        JOIN production_workspace_assignments a ON a.plan_version_id=p.id
        LEFT JOIN production_workspace_operators worker ON worker.id=a.operator_id
        LEFT JOIN production_workspace_operations op ON op.id=a.operation_id
        LEFT JOIN LATERAL (
            SELECT SUM(total_qty) AS output_qty, COUNT(*) AS capture_count
            FROM production_workspace_execution_output o
            WHERE o.plan_version_id=p.id AND o.capture_date=%s
        ) outp ON TRUE
        WHERE p.status IN ('approved','frozen')
          AND %s BETWEEN p.planned_start AND p.planned_end
          AND (""" + scope + """)""" + (("\n          AND " + " AND ".join(command_clauses)) if command_clauses else "") + """
        ORDER BY p.planned_start,p.id,a.id
        """,
        [day, day, *scope_params, *command_params], fetch=True,
    )
    return _privacy_safe_workspace_payload(request, {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "capture_date": day.isoformat(),
        "state": "ready" if rows else "missing_plan",
        "message": None if rows else "No approved production assignment is scheduled for this date.",
        "worklist": _rows(rows),
        "scope_applied": command_scope,
    })


def _execution_events(request: Request, event_type=None, plan_version_id=None,
                      event_date=None, **scope_args):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_CAPTURE_ROLES, "Production execution viewing")
    if denied:
        return denied
    actor = _actor(request)
    clauses, params = [], []
    if event_type:
        if event_type not in EXECUTION_EVENT_TYPES:
            return _error("Unknown execution event type", 400)
        clauses.append("e.event_type=%s")
        params.append(event_type)
    if plan_version_id:
        clauses.append("e.plan_version_id=%s")
        params.append(plan_version_id)
    if event_date and _execution_date(event_date):
        clauses.append("e.event_date=%s")
        params.append(_execution_date(event_date))
    scope, scope_params = _plan_scope_sql(actor, "p")
    command_scope = _command_scope(request, **scope_args)
    command_clauses, command_params = _command_scope_sql(
        command_scope, include_plan_dates=False)
    clauses.append(scope)
    params.extend(scope_params)
    clauses.extend(command_clauses)
    params.extend(command_params)
    where = " WHERE " + " AND ".join(clauses)
    rows = _db(
        f"""
        SELECT e.*,f.name AS factory_name,l.name AS line_name,sh.name AS shift_name,
               wi.external_ref,wi.style_number,po.product_name AS order_style_name,
               op.name AS operation_name
        FROM production_workspace_execution_events e
        JOIN production_workspace_plan_versions p ON p.id=e.plan_version_id
        JOIN production_workspace_factories f ON f.id=e.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=e.line_id
        LEFT JOIN production_workspace_shifts sh ON sh.id=e.shift_id
        JOIN production_workspace_work_items wi ON wi.id=e.work_item_id
        LEFT JOIN production_orders po ON po.order_ref=e.production_order_ref
        LEFT JOIN production_workspace_operations op ON op.id=e.operation_id
        {where}
        ORDER BY e.event_date DESC,e.created_at DESC,e.id DESC LIMIT 500
        """,
        params, fetch=True,
    )
    return _privacy_safe_workspace_payload(
        request, {"events": _rows(rows), "event_type": event_type,
                  "scope_applied": command_scope})


def _execution_catalogue_snapshot(cur, event_type, body):
    """Require an active controlled taxonomy item and preserve its historical label."""
    if event_type not in ("qc_defect", "downtime"):
        return {}, None
    is_defect = event_type == "qc_defect"
    resource = "defect" if is_defect else "downtime reason"
    table = ("production_workspace_defect_codes" if is_defect
             else "production_workspace_downtime_reasons")
    id_key = "defect_code_id" if is_defect else "downtime_reason_id"
    raw_id = body.get(id_key)
    try:
        record_id = int(raw_id)
    except (TypeError, ValueError):
        return None, _error(f"Choose an active {resource} code before recording this event.", 400)
    if record_id <= 0:
        return None, _error(f"Choose an active {resource} code before recording this event.", 400)
    cur.execute(
        f"SELECT id,code,name FROM {table} WHERE id=%s AND active FOR SHARE",
        (record_id,),
    )
    record = cur.fetchone()
    if not record:
        return None, _error(
            f"The selected {resource} code is inactive or no longer exists. Refresh and choose an active code.",
            409, code="workspace_execution_inactive_code",
        )
    if is_defect:
        return {
            "defect_code_id": record["id"],
            "defect_code": record["code"],
            "defect_code_name": record["name"],
        }, None
    return {
        "downtime_reason_id": record["id"],
        "downtime_reason_code": record["code"],
        "downtime_reason_name": record["name"],
    }, None


def _execution_event_create(request: Request, body: dict):
    _ensure_schema()
    event_type = str(body.get("event_type") or "").strip().lower()
    if event_type not in EXECUTION_EVENT_TYPES:
        return _error("event_type must be wip, downtime, attendance, qc_defect or recovery")
    denied = _require_role(request, EXECUTION_EVENT_WRITE_ROLES[event_type],
                           f"Production {event_type} capture")
    if denied:
        return denied
    reason = _reason(body)
    event_key = str(body.get("event_key") or "").strip()
    if not reason or not event_key:
        return _error("event_key and reason are required for safe retry")
    if event_type == "downtime" and not str(body.get("action") or "").strip():
        return _error("an immediate action is required for downtime")
    if event_type == "recovery" and not str(body.get("action") or "").strip():
        return _error("action is required for recovery")
    if event_type == "wip" and (
            not body.get("from_stage") or not body.get("to_stage")
            or not body.get("stage_movement_id")):
        return _error(
            "from_stage, to_stage and an existing tracker stage_movement_id are required for WIP"
        )
    if len(event_key) > 180:
        return _error("event_key is too long")
    actor = _actor(request)
    try:
        quantity = None if body.get("quantity") in (None, "") else _execution_number(body["quantity"], "quantity")
        duration = None if body.get("duration_minutes") in (None, "") else _execution_number(body["duration_minutes"], "duration_minutes")
    except ValueError as exc:
        return _error(str(exc), 400)
    body = dict(body)
    body["event_date"] = body.get("event_date") or body.get("capture_date")
    try:
        with _tx() as cur:
            context, _, failure = _execution_context(
                cur, body, actor, event_type=event_type,
            )
            if failure:
                return failure
            plan, assignment, work_item, event_date = context
            taxonomy, taxonomy_failure = _execution_catalogue_snapshot(
                cur, event_type, body)
            if taxonomy_failure:
                return taxonomy_failure
            if body.get("from_stage") and body.get("to_stage"):
                cur.execute(
                    "SELECT allowed_next FROM production_stages WHERE stage_key=%s",
                    (body["from_stage"],),
                )
                stage = cur.fetchone()
                if not stage or body["to_stage"] not in (stage["allowed_next"] or []):
                    return _error(
                        "The WIP transition is not an allowed production stage move.",
                        409, code="workspace_execution_invalid_stage_transition",
                    )
            movement_id = body.get("stage_movement_id")
            if movement_id:
                cur.execute(
                    """
                    SELECT id FROM stage_movements
                    WHERE id=%s AND order_ref=%s
                      AND (%s IS NULL OR from_stage=%s)
                      AND (%s IS NULL OR to_stage=%s)
                    """,
                    (movement_id, work_item.get("production_order_ref"),
                     body.get("from_stage"), body.get("from_stage"),
                     body.get("to_stage"), body.get("to_stage")),
                )
                if not cur.fetchone():
                    return _error(
                        "The linked stage movement does not match this order and WIP event.",
                        409, code="workspace_execution_movement_mismatch",
                    )
            values = _execution_record_context_values(body, plan, assignment, work_item)
            cur.execute(
                "SELECT * FROM production_workspace_execution_events "
                "WHERE event_key=%s FOR UPDATE", (event_key,),
            )
            existing = cur.fetchone()
            if existing:
                effective_owner = body.get("owner_user_id") or actor["user_id"]
                comparable = (
                    existing["event_type"] == event_type
                    and int(existing["plan_version_id"]) == int(plan["id"])
                    and (existing["assignment_id"] or None) == values["assignment_id"]
                    and int(existing["work_item_id"]) == int(values["work_item_id"])
                    and (existing["operation_id"] or None) == (values["operation_id"] or None)
                    and str(existing["event_date"]) == event_date.isoformat()
                    and existing["from_stage"] == body.get("from_stage")
                    and existing["to_stage"] == body.get("to_stage")
                    and (existing["stage_movement_id"] or None) == (movement_id or None)
                    and abs(float(existing["quantity"] or 0) - float(quantity or 0)) < 0.00001
                    and abs(float(existing["duration_minutes"] or 0) - float(duration or 0)) < 0.00001
                    and (existing["reason"] or "") == reason
                    and (existing["cause"] or "") == (body.get("cause") or "")
                    and (existing["action"] or "") == (body.get("action") or "")
                    and (existing.get("defect_code_id") or None) == (taxonomy.get("defect_code_id") if taxonomy else None)
                    and (existing.get("downtime_reason_id") or None) == (taxonomy.get("downtime_reason_id") if taxonomy else None)
                    and (existing["owner_user_id"] or "") == effective_owner
                    and existing["status"] == (body.get("status") or "open").strip().lower()
                    and (existing["evidence_ref"] or "") == (body.get("evidence_ref") or "")
                    and (existing["notes"] or "") == (body.get("notes") or "")
                )
                if not comparable:
                    return _error(
                        "This event key already belongs to different values. "
                        "Use a new key for a distinct event.",
                        409, code="workspace_execution_duplicate_conflict",
                    )
                return {"record": _jsonable(existing), "idempotent": True}
            status = str(body.get("status") or "open").strip().lower()
            if status not in EXECUTION_EVENT_STATUSES:
                return _error("Unknown event status", 400)
            cur.execute(
                """
                INSERT INTO production_workspace_execution_events
                    (plan_version_id,assignment_id,work_item_id,production_order_ref,
                     factory_id,line_id,shift_id,operation_id,event_type,event_date,
                     event_key,from_stage,to_stage,stage_movement_id,quantity,
                     duration_minutes,defect_code_id,defect_code,defect_code_name,
                     downtime_reason_id,downtime_reason_code,downtime_reason_name,
                     reason,cause,action,owner_user_id,status,
                     evidence_ref,notes,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING *
                """,
                (
                    values["plan_version_id"], values["assignment_id"], values["work_item_id"],
                    values["production_order_ref"], values["factory_id"], values["line_id"],
                    values["shift_id"], values["operation_id"], event_type, event_date,
                    event_key, body.get("from_stage"), body.get("to_stage"), movement_id,
                    quantity, duration,
                    taxonomy.get("defect_code_id"), taxonomy.get("defect_code"), taxonomy.get("defect_code_name"),
                    taxonomy.get("downtime_reason_id"), taxonomy.get("downtime_reason_code"), taxonomy.get("downtime_reason_name"),
                    reason, body.get("cause"), body.get("action"),
                    body.get("owner_user_id") or actor["user_id"], status,
                    body.get("evidence_ref"), body.get("notes"), actor["user_id"],
                    actor["user_id"],
                ),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, "execution_event", row["id"], "created", actor, reason,
                after=row, request_id=_request_id(request),
            )
        return {"record": _jsonable(row), "idempotent": False,
                "audit_event_id": audit["id"]}
    except Exception as exc:
        if "check constraint" in str(exc).lower():
            return _error("The event details are not valid for this event type.", 400)
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("This event was submitted already. Refresh and retry.", 409,
                          code="workspace_execution_duplicate_conflict")
        log.exception("execution event create failed")
        return _error("Could not save the execution event", 500)


def _execution_event_update(event_id: int, request: Request, body: dict):
    _ensure_schema()
    # The existing event tells us which narrowly-scoped write role is required.
    denied = _require_role(request, EXECUTION_CAPTURE_ROLES, "Production execution correction")
    if denied:
        return denied
    reason = _reason(body)
    expected = _expected(body)
    if not reason or expected is None:
        return _error("expected_version and reason are required for an event update")
    status = str(body.get("status") or "").strip().lower()
    if status not in EXECUTION_EVENT_STATUSES:
        return _error("A valid status is required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_execution_events WHERE id=%s FOR UPDATE",
                (event_id,),
            )
            before = cur.fetchone()
            if not before:
                return _error("Execution event not found", 404)
            if actor["role"] not in EXECUTION_EVENT_WRITE_ROLES[before["event_type"]]:
                return _error("This role cannot update that execution event type.", 403)
            if expected != int(before["version_token"]):
                return _version_error(expected, int(before["version_token"]))
            context_body = {
                "plan_version_id": before["plan_version_id"],
                "work_item_id": before["work_item_id"],
                "assignment_id": before["assignment_id"],
                "event_date": before["event_date"],
            }
            _, _, failure = _execution_context(
                cur, context_body, actor, event_type=before["event_type"],
            )
            if failure:
                return failure
            cur.execute(
                """
                UPDATE production_workspace_execution_events
                SET status=%s,action=COALESCE(%s,action),notes=COALESCE(%s,notes),
                    owner_user_id=COALESCE(%s,owner_user_id),
                    evidence_ref=COALESCE(%s,evidence_ref),
                    version_token=version_token+1,updated_by=%s,updated_at=now()
                WHERE id=%s RETURNING *
                """,
                (status, body.get("action"), body.get("notes"),
                 body.get("owner_user_id"), body.get("evidence_ref"),
                 actor["user_id"], event_id),
            )
            after = cur.fetchone()
            audit = _audit(
                cur, "execution_event", event_id, "updated", actor, reason,
                before=before, after=after, request_id=_request_id(request),
            )
        return {"record": _jsonable(after), "idempotent": False,
                "audit_event_id": audit["id"]}
    except Exception:
        log.exception("execution event update failed")
        return _error("Could not update the execution event", 500)


def _execution_summary(request: Request, capture_date=None, **scope_args):
    worklist = _execution_worklist(request, capture_date, **scope_args)
    if isinstance(worklist, JSONResponse):
        return worklist
    day = worklist["capture_date"]
    plan_ids = sorted({row["plan_version_id"] for row in worklist.get("worklist", [])})
    if not plan_ids:
        return {"capture_date": day, "state": worklist["state"], "scope_applied": worklist["scope_applied"],
                "summary": {"good_qty": 0, "reject_qty": 0, "rework_qty": 0,
                            "output_entries": 0, "events": []}}
    rows = _db(
        """
        SELECT
          COALESCE(SUM(good_qty),0) AS good_qty,
          COALESCE(SUM(reject_qty),0) AS reject_qty,
          COALESCE(SUM(rework_qty),0) AS rework_qty,
          COUNT(*) AS output_entries
        FROM production_workspace_execution_output
        WHERE capture_date=%s AND plan_version_id=ANY(%s)
        """, (day, plan_ids), fetch=True,
    )
    counts = _db(
        "SELECT event_type,COUNT(*) AS count FROM production_workspace_execution_events "
        "WHERE event_date=%s AND plan_version_id=ANY(%s) GROUP BY event_type ORDER BY event_type",
        (day, plan_ids), fetch=True,
    )
    summary = dict(rows[0]) if rows else {}
    summary["events"] = _rows(counts)
    return {"capture_date": day, "state": worklist["state"], "scope_applied": worklist["scope_applied"], "summary": _jsonable(summary)}


def _execution_bulk_rows(body):
    rows = body.get("rows") if isinstance(body, dict) else None
    if isinstance(rows, list):
        return rows
    text = str((body or {}).get("csv") or "").strip()
    if not text:
        return []
    return list(csv.DictReader(io.StringIO(text)))


def _execution_bulk_preview(request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_OUTPUT_ROLES, "Production output bulk capture")
    if denied:
        return denied
    rows = _execution_bulk_rows(body)
    if not rows:
        return _error("Upload at least one output row to preview.", 400)
    if len(rows) > 1000:
        return _error("A single execution import is limited to 1,000 rows.", 400)
    actor = _actor(request)
    results = []
    seen = set()
    with _tx() as cur:
        for index, raw in enumerate(rows, start=1):
            row = dict(raw or {})
            errors = []
            try:
                plan_id = int(row.get("plan_version_id"))
                row["plan_version_id"] = plan_id
            except (TypeError, ValueError):
                errors.append("plan_version_id is required")
            try:
                if not errors:
                    context, _, failure = _execution_context(
                        cur, row, actor, assignment_required=True,
                    )
                    if failure:
                        errors.append(failure.body.decode("utf-8") if hasattr(failure, "body") else "Invalid plan context")
            except Exception as exc:
                errors.append(str(exc))
            try:
                payload = _execution_output_payload(row)
            except ValueError as exc:
                payload = None
                errors.append(str(exc))
            key = str(row.get("capture_key") or "").strip()
            if key in seen:
                errors.append("duplicate capture_key in this batch")
            seen.add(key)
            if key:
                cur.execute("SELECT 1 FROM production_workspace_execution_output WHERE capture_key=%s", (key,))
                if cur.fetchone():
                    errors.append("capture_key already exists; retry the same row or use a correction")
            results.append({
                "row": index, "capture_key": key, "values": row,
                "valid": not errors, "errors": errors,
            })
    return {
        "batch_key": str(body.get("batch_key") or ""),
        "columns": [
            "plan_version_id", "assignment_id", "capture_kind", "capture_date",
            "hour_no", "planned_qty", "good_qty", "reject_qty", "rework_qty",
            "capture_key", "comments", "reason",
        ],
        "rows": results, "row_count": len(results),
        "valid": all(r["valid"] for r in results),
    }


def _execution_bulk_commit(request: Request, body: dict):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_OUTPUT_ROLES, "Production output bulk capture")
    if denied:
        return denied
    rows = _execution_bulk_rows(body)
    if not rows:
        return _error("Upload at least one output row to commit.", 400)
    if len(rows) > 1000:
        return _error("A single execution import is limited to 1,000 rows.", 400)
    batch_key = str(body.get("batch_key") or "").strip()
    if not batch_key:
        return _error("batch_key is required for an idempotent commit")
    reason = _reason(body)
    if not reason:
        return _error("reason is required before committing a bulk capture")
    payload_hash = uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(rows, sort_keys=True, default=str)).hex
    actor = _actor(request)
    try:
        # Check the durable idempotency marker before preview. A client may
        # retry after losing the response; preview quite correctly rejects
        # already-used capture keys, so it must not run first for a matching
        # completed batch.
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_execution_batches "
                "WHERE batch_key=%s FOR UPDATE", (batch_key,),
            )
            existing_batch = cur.fetchone()
            if existing_batch:
                if existing_batch["payload_hash"] != payload_hash:
                    return _error("batch_key was already used for different rows.", 409,
                                  code="workspace_execution_batch_conflict")
                cur.execute(
                    "SELECT * FROM production_workspace_execution_output "
                    "WHERE batch_key=%s ORDER BY id", (batch_key,),
                )
                return {
                    "batch_key": batch_key, "committed": len(rows),
                    "idempotent": True, "records": _rows(cur.fetchall()),
                }
        # The preview is useful feedback for a first attempt. The final
        # transaction below repeats all validation, so a race cannot create a
        # partial import.
        preview = _execution_bulk_preview(request, body)
        if isinstance(preview, JSONResponse):
            return preview
        if not preview["valid"]:
            return _error("Fix every row error before committing this import.", 422,
                          preview=preview, code="workspace_execution_bulk_invalid")
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_execution_batches "
                "WHERE batch_key=%s FOR UPDATE", (batch_key,),
            )
            existing_batch = cur.fetchone()
            if existing_batch:
                if existing_batch["payload_hash"] != payload_hash:
                    return _error("batch_key was already used for different rows.", 409,
                                  code="workspace_execution_batch_conflict")
                cur.execute(
                    "SELECT * FROM production_workspace_execution_output "
                    "WHERE batch_key=%s ORDER BY id", (batch_key,),
                )
                return {
                    "batch_key": batch_key, "committed": len(rows),
                    "idempotent": True, "records": _rows(cur.fetchall()),
                }
            # Preview is advisory: each row is checked again under the final
            # transaction before the batch marker or any output is written.
            # Raising (rather than returning) guarantees _tx rolls back if a
            # plan was frozen/reopened or a duplicate arrived after preview.
            prepared = []
            for raw in rows:
                row = dict(raw)
                try:
                    int(row["plan_version_id"])
                except (KeyError, TypeError, ValueError):
                    raise ExecutionBulkValidationError(
                        "The batch changed while committing; preview again."
                    )
                context, _, failure = _execution_context(
                    cur, row, actor, assignment_required=True,
                )
                if failure:
                    raise ExecutionBulkValidationError(
                        "The batch changed while committing; preview again."
                    )
                try:
                    payload = _execution_output_payload(row)
                except ValueError as exc:
                    raise ExecutionBulkValidationError(str(exc))
                cur.execute(
                    "SELECT 1 FROM production_workspace_execution_output "
                    "WHERE capture_key=%s FOR UPDATE",
                    (payload["capture_key"],),
                )
                if cur.fetchone():
                    raise ExecutionBulkValidationError(
                        "A capture row already exists. Preview again before retrying."
                    )
                plan, assignment, work_item, capture_date = context
                prepared.append((
                    _execution_record_context_values(row, plan, assignment, work_item),
                    payload, capture_date,
                ))
            cur.execute(
                """
                INSERT INTO production_workspace_execution_batches
                    (batch_key,payload_hash,row_count,created_by)
                VALUES (%s,%s,%s,%s)
                """,
                (batch_key, payload_hash, len(rows), actor["user_id"]),
            )
            written = []
            for values, payload, capture_date in prepared:
                cur.execute(
                    """
                    INSERT INTO production_workspace_execution_output
                        (plan_version_id,assignment_id,work_item_id,production_order_ref,
                         factory_id,line_id,shift_id,operation_id,capture_kind,capture_date,
                         hour_no,capture_key,planned_qty,good_qty,reject_qty,rework_qty,
                         comments,batch_key,created_by,updated_by)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING *
                    """,
                    (
                        values["plan_version_id"], values["assignment_id"], values["work_item_id"],
                        values["production_order_ref"], values["factory_id"], values["line_id"],
                        values["shift_id"], values["operation_id"], payload["capture_kind"],
                        capture_date, payload["hour_no"], payload["capture_key"],
                        payload["planned_qty"], payload["good_qty"], payload["reject_qty"],
                        payload["rework_qty"], payload["comments"], batch_key,
                        actor["user_id"], actor["user_id"],
                    ),
                )
                after = cur.fetchone()
                _audit(cur, "execution_output", after["id"], "bulk_created", actor,
                       reason, after=after, request_id=_request_id(request))
                written.append(after)
        return {"batch_key": batch_key, "committed": len(written),
                "idempotent": False, "records": _rows(written)}
    except ExecutionBulkValidationError as exc:
        return _error(str(exc), 409, code="workspace_execution_bulk_conflict")
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("A capture row already exists. Preview again before retrying.", 409,
                          code="workspace_execution_duplicate_conflict")
        log.exception("execution bulk commit failed")
        return _error("The execution import was not committed. No partial rows were saved.", 500)


def _execution_bulk_template(request: Request):
    _ensure_schema()
    denied = _require_role(request, EXECUTION_CAPTURE_ROLES, "Production execution viewing")
    if denied:
        return denied
    return {
        "columns": [
            "plan_version_id", "assignment_id", "capture_kind", "capture_date",
            "hour_no", "planned_qty", "good_qty", "reject_qty", "rework_qty",
            "capture_key", "comments", "reason",
        ],
        "example": {
            "capture_kind": "hourly", "hour_no": 8, "planned_qty": 40,
            "good_qty": 36, "reject_qty": 2, "rework_qty": 2,
            "capture_key": "plan-123-2026-08-25-08",
        },
    }


_AUDIT_PLAN_ENTITY_TABLES = {
    "plan_version": ("production_workspace_plan_versions", "id", "id"),
    "operation": ("production_workspace_operations", "id", "plan_version_id"),
    "assignment": ("production_workspace_assignments", "id", "plan_version_id"),
    "capacity_input": ("production_workspace_capacity_inputs", "id", "plan_version_id"),
    "changeover": ("production_workspace_changeovers", "id", "plan_version_id"),
    "execution_reference": ("production_workspace_execution_references", "id", "plan_version_id"),
    "execution_output": ("production_workspace_execution_output", "id", "plan_version_id"),
    "execution_event": ("production_workspace_execution_events", "id", "plan_version_id"),
}


def _audit_entity_is_visible(request, entity_type, entity_id):
    """Resolve audit child rows to their plan before returning any timeline."""
    if _actor(request)["role"] != "production":
        return True
    mapping = _AUDIT_PLAN_ENTITY_TABLES.get(entity_type)
    if not mapping:
        return False
    table, id_column, plan_column = mapping
    predicate, params = _plan_scope_sql(_actor(request), "p")
    rows = _db(
        f"SELECT 1 FROM {table} entity "
        f"JOIN production_workspace_plan_versions p ON p.id=entity.{plan_column} "
        f"WHERE entity.{id_column}=%s AND {predicate}",
        [str(entity_id), *params], fetch=True,
    )
    return bool(rows)


def _audit_timeline(entity_type: str, entity_id: str, request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace audit viewing")
    if denied:
        return denied
    if not _audit_entity_is_visible(request, entity_type, entity_id):
        return _error("Audit timeline not found", 404)
    rows = _db(
        "SELECT * FROM production_workspace_audit_events "
        "WHERE entity_type=%s AND entity_id=%s "
        "ORDER BY occurred_at DESC, id DESC",
        (entity_type, str(entity_id)), fetch=True,
    )
    return _privacy_safe_workspace_payload(
        request, {"entity_type": entity_type, "entity_id": str(entity_id),
                  "events": _rows(rows)})


def _tracker_references(request: Request, date_from: str = None, date_to: str = None,
                        stage: str = "", factory_id: str = "", line_id: str = "",
                        shift_id: str = "", owner_user_id: str = "",
                        plan_status: str = "", delivery_risk: str = "",
                        search: str = "", intake_scope: str = ""):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production workspace viewing")
    if denied:
        return denied
    actor = _actor(request)
    privacy = actor["role"] in QUALITY_ROLES | PRODUCT_ROLES
    owner_user_id = "" if privacy else str(owner_user_id or "")
    intake_scope = str(intake_scope or "all").strip().lower()
    if intake_scope not in {"all", "planned"}:
        return _error("intake_scope must be all or planned")
    # "planned" is an explicit opt-in view of only plan-backed orders. The
    # default "all" view is the authorized intake queue: every tracker order
    # an authorized viewer may see, whether or not it has been assigned to a
    # plan yet. A plan/date filter narrows the plan-backed rows it matches,
    # but must never silently drop the still-unplanned rows alongside them.
    plan_only = intake_scope == "planned"
    filters = []
    query_params = []
    if actor["role"] == "production":
        predicate, predicate_params = _plan_scope_sql(actor, "p")
        if not actor.get("user_id"):
            # No authenticated identity to scope by: fail closed exactly as
            # before, including for the otherwise-always-visible unplanned rows.
            filters.append("FALSE")
        elif plan_only:
            filters.append("p.id IS NOT NULL AND (" + predicate + ")")
        else:
            # An unplanned order has no owner or assignee yet, so there is
            # nothing to scope it against; only planned rows keep the
            # owner-or-assignee boundary.
            filters.append("(p.id IS NULL OR (" + predicate + "))")
        query_params.extend(predicate_params)
    elif plan_only:
        filters.append("p.id IS NOT NULL")
    plan_filters = []
    plan_params = []
    if date_from:
        plan_filters.append("p.planned_start >= %s")
        plan_params.append(str(date_from))
    if date_to:
        plan_filters.append("p.planned_end <= %s")
        plan_params.append(str(date_to))
    for value, expression in (
        (factory_id, "p.factory_id=%s::bigint"),
        (line_id, "p.line_id=%s::bigint"),
        (shift_id, "p.shift_id=%s::bigint"),
        (owner_user_id, "p.owner_user_id=%s"),
        (plan_status, "p.status=%s"),
    ):
        if value:
            plan_filters.append(expression)
            plan_params.append(str(value))
    if plan_filters:
        combined = " AND ".join(plan_filters)
        if plan_only:
            filters.append(combined)
        else:
            filters.append("(p.id IS NULL OR (" + combined + "))")
        query_params.extend(plan_params)
    if stage:
        filters.append("wi.stage_key=%s")
        query_params.append(str(stage))
    if search:
        filters.append(
            "concat_ws(' ',po.order_ref,po.style_number,po.product_name,"
            "wi.external_ref,wi.style_number) ILIKE '%%' || %s || '%%'"
        )
        query_params.append(str(search))
    where = " AND ".join(filters) if filters else "TRUE"
    orders = _db(
        """
        SELECT DISTINCT po.order_ref, po.style_number,
               po.product_name AS style_name, po.order_qty,
               po.updated_at AS tracker_updated_at,
               wi.id AS work_item_id, wi.stage_key AS workspace_stage,
               NULL::text AS tracker_stage,
               p.id AS plan_version_id, p.status AS plan_status,
               p.factory_id, p.line_id, p.shift_id, p.owner_user_id,
               p.planned_start, p.planned_end
          FROM production_orders po
          LEFT JOIN production_workspace_work_items wi
            ON wi.production_order_ref=po.order_ref
          LEFT JOIN LATERAL (
              SELECT p.*
                FROM production_workspace_plan_versions p
               WHERE p.work_item_id=wi.id
               ORDER BY p.version_no DESC
               LIMIT 1
          ) p ON TRUE
         WHERE """ + where + """
         ORDER BY po.updated_at DESC NULLS LAST, po.order_ref
        """,
        query_params, fetch=True,
    )
    order_rows = [dict(row) for row in orders]
    # Risk is calculated by the same source-backed recovery engine used by the
    # Command Centre.  It is deliberately applied after the scope query so a
    # copied risk URL cannot broaden a production user's visible universe.
    requested_risk = str(delivery_risk or "").strip().lower()
    if requested_risk:
        try:
            from production_insights_router import _recovery_candidates
            risk_start = _scope_day(date_from, date.today() - timedelta(days=29))
            risk_end = _scope_day(date_to, date.today())
            risk_rows = _recovery_candidates(
                risk_start, risk_end, factory_id, line_id, shift_id,
                plan_status, actor,
            )
            risk_by_order = {
                str(row.get("production_order_ref")): row
                for row in risk_rows
                if row.get("production_order_ref")
            }
            order_rows = [
                {**row, "delivery_risk": risk_by_order.get(
                    str(row.get("order_ref")), {}
                ).get("priority_band")}
                for row in order_rows
                if risk_by_order.get(str(row.get("order_ref")), {}).get("priority_band")
                == requested_risk
            ]
        except Exception:
            log.exception("Work Order delivery-risk filter failed")
            return _error(
                "Delivery-risk evidence is unavailable for this scope.", 503,
                code="workspace_delivery_risk_unavailable",
            )
    else:
        try:
            from production_insights_router import _recovery_candidates
            risk_start = _scope_day(date_from, date.today() - timedelta(days=29))
            risk_end = _scope_day(date_to, date.today())
            risk_rows = _recovery_candidates(
                risk_start, risk_end, factory_id, line_id, shift_id,
                plan_status, actor,
            )
            risk_by_order = {
                str(row.get("production_order_ref")): row.get("priority_band")
                for row in risk_rows if row.get("production_order_ref")
            }
            for row in order_rows:
                row["delivery_risk"] = risk_by_order.get(str(row["order_ref"]))
        except Exception:
            # Risk is an optional enrichment for the unfiltered list. Do not
            # turn a healthy tracker order list into a false empty state.
            log.warning("Work Order delivery-risk enrichment unavailable", exc_info=True)
    return _privacy_safe_workspace_payload(request, {
        "orders": _rows(order_rows),
        "scope_applied": {
            "date_from": str(date_from or ""), "date_to": str(date_to or ""),
            "stage": str(stage or ""), "factory_id": str(factory_id or ""),
            "line_id": str(line_id or ""), "shift_id": str(shift_id or ""),
            "owner_user_id": owner_user_id, "plan_status": str(plan_status or ""),
            "delivery_risk": requested_risk, "search": str(search or ""),
            "intake_scope": intake_scope,
        },
        "stages": _rows(_db(
            "SELECT stage_key, stage_name, sort_order, allowed_next, is_terminal "
            "FROM production_stages ORDER BY sort_order", fetch=True)),
        "contract": {
            "stage_movements_are_read_only_here": True,
            "quality_records_are_referenced_not_copied": True,
        },
    })


TEAM_WRITE_ROLES = {"admin", "production"}
RESOURCE_WRITE_ROLES = {"admin", "production"}
CADENCE_WRITE_ROLES = {"admin", "production", "leadership", "smt"}
CADENCE_ACTION_ROLES = {"admin", "production", "leadership", "smt"}


def _json_array(value):
    return value if isinstance(value, list) else []


def _json_object(value):
    return value if isinstance(value, dict) else {}


def _scope_day(value, fallback):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else fallback
    except (TypeError, ValueError):
        return fallback


def _workspace_person_scope(actor, alias="m"):
    if actor["role"] != "production":
        return "TRUE", []
    if not actor.get("user_id"):
        return "FALSE", []
    return f"""EXISTS (
        SELECT 1 FROM production_workspace_team_members scoped_member
         WHERE scoped_member.user_id=%s
           AND scoped_member.active
           AND (scoped_member.factory_id IS NULL OR scoped_member.factory_id={alias}.factory_id)
    )""", [actor["user_id"]]


def _factory_authorized(actor, factory_id, cur=None):
    """Production roles can only create records in an assigned factory."""
    if actor["role"] != "production":
        return True
    if not actor.get("user_id") or factory_id in (None, ""):
        return False
    query = (
        "SELECT 1 FROM production_workspace_team_members "
        "WHERE user_id=%s AND active AND (factory_id IS NULL OR factory_id=%s::bigint) "
        "LIMIT 1"
    )
    if cur:
        cur.execute(query, (actor["user_id"], factory_id))
        return bool(cur.fetchone())
    return bool(_db(query, (actor["user_id"], factory_id), fetch=True))


def _context_relationship_valid(factory_id, shift_id=None, line_id=None, cur=None):
    """Reject a shift or line that is owned by a different factory."""
    if factory_id in (None, ""):
        return line_id in (None, "") and shift_id in (None, "")
    checks = (
        ("production_workspace_shifts", shift_id, "Shift"),
        ("production_workspace_lines", line_id, "Line"),
    )
    for table, record_id, label in checks:
        if record_id in (None, ""):
            continue
        query = f"SELECT 1 FROM {table} WHERE id=%s AND factory_id=%s"
        if cur:
            cur.execute(query, (record_id, factory_id))
            valid = bool(cur.fetchone())
        else:
            valid = bool(_db(query, (record_id, factory_id), fetch=True))
        if not valid:
            return False, f"{label} must belong to the selected factory."
    return True, None


def _safe_resource_source_ref(value):
    """Accept only credential-free, absolute HTTPS resource references."""
    if value in (None, ""):
        return None, None
    if not isinstance(value, str):
        return None, "source_ref must be a URL."
    candidate = value.strip()
    if not candidate or any(ord(char) < 32 for char in candidate):
        return None, "source_ref must be a safe HTTPS URL."
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None, "source_ref must be a safe HTTPS URL."
    if (parsed.scheme.lower() != "https" or not parsed.netloc or
            parsed.username is not None or parsed.password is not None):
        return None, "source_ref must be an absolute HTTPS URL without credentials."
    return candidate, None


def _cadence_visible(request, cadence_id, lock=False):
    actor = _actor(request)
    predicate, params = _workspace_person_scope(actor, "c")
    rows = _db(
        "SELECT c.id FROM production_workspace_cadences c "
        "WHERE c.id=%s AND (" + predicate + ")" +
        (" FOR UPDATE" if lock else ""),
        [cadence_id, *params], fetch=True,
    )
    return bool(rows)


def _cadence_payload(request, row, cur=None):
    row = dict(row)
    fetch = cur.fetchall if cur else lambda: _db(
        "SELECT * FROM production_workspace_cadence_attendance "
        "WHERE cadence_id=%s ORDER BY display_name", (row["id"],), fetch=True)
    attendance = fetch()
    if cur:
        cur.execute(
            "SELECT * FROM production_workspace_cadence_attendance "
            "WHERE cadence_id=%s ORDER BY display_name", (row["id"],))
        attendance = cur.fetchall()
        cur.execute(
            "SELECT * FROM production_workspace_cadence_actions "
            "WHERE cadence_id=%s ORDER BY due_date NULLS LAST, id", (row["id"],))
        actions = cur.fetchall()
    else:
        actions = _db(
            "SELECT * FROM production_workspace_cadence_actions "
            "WHERE cadence_id=%s ORDER BY due_date NULLS LAST, id",
            (row["id"],), fetch=True)
    row["attendance"] = _rows(attendance)
    row["actions"] = _rows(actions)
    if row.get("cadence_type") == "l10":
        prior_sql = (
            "SELECT a.*, c.meeting_date AS source_meeting_date, c.id AS source_cadence_id "
            "FROM production_workspace_cadence_actions a "
            "JOIN production_workspace_cadences c ON c.id=a.cadence_id "
            "WHERE c.factory_id=%s AND c.cadence_type='l10' AND c.meeting_date<%s "
            "AND a.status NOT IN ('resolved','closed') "
            "AND NOT EXISTS (SELECT 1 FROM production_workspace_cadence_actions carried "
            "WHERE carried.cadence_id=%s AND carried.carried_forward_from=a.id) "
            "ORDER BY c.meeting_date DESC, a.due_date NULLS LAST, a.id LIMIT 50"
        )
        prior_params = (row["factory_id"], row["meeting_date"], row["id"])
        if cur:
            cur.execute(prior_sql, prior_params)
            prior = cur.fetchall()
        else:
            prior = _db(prior_sql, prior_params, fetch=True)
        row["prior_open_actions"] = _rows(prior)
    return _privacy_safe_workspace_payload(request, row)


def _cadences(request: Request, date_from: str = None, date_to: str = None,
              factory_id: str = "", shift_id: str = "", cadence_type: str = ""):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production cadence viewing")
    if denied:
        return denied
    actor = _actor(request)
    predicate, scope_params = _workspace_person_scope(actor, "c")
    clauses = [predicate]
    params = list(scope_params)
    if date_from:
        clauses.append("c.meeting_date >= %s")
        params.append(str(date_from))
    if date_to:
        clauses.append("c.meeting_date <= %s")
        params.append(str(date_to))
    if factory_id:
        clauses.append("c.factory_id=%s::bigint")
        params.append(str(factory_id))
    if shift_id:
        clauses.append("c.shift_id=%s::bigint")
        params.append(str(shift_id))
    if cadence_type:
        if cadence_type not in {"shift_huddle", "l10"}:
            return _error("Invalid cadence type")
        clauses.append("c.cadence_type=%s")
        params.append(cadence_type)
    rows = _db(
        "SELECT c.*, f.name AS factory_name, sh.name AS shift_name "
        "FROM production_workspace_cadences c "
        "JOIN production_workspace_factories f ON f.id=c.factory_id "
        "LEFT JOIN production_workspace_shifts sh ON sh.id=c.shift_id "
        "WHERE " + " AND ".join(clauses) +
        " ORDER BY c.meeting_date DESC, c.id DESC",
        params, fetch=True)
    return {"cadences": [_cadence_payload(request, row) for row in rows],
            "scope_applied": {
                "date_from": str(date_from or ""), "date_to": str(date_to or ""),
                "factory_id": str(factory_id or ""), "shift_id": str(shift_id or ""),
                "cadence_type": str(cadence_type or ""),
            }}


def _cadence_create(request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, CADENCE_WRITE_ROLES, "Cadence changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every cadence change")
    cadence_type = str(body.get("cadence_type") or "shift_huddle").strip().lower()
    if cadence_type not in {"shift_huddle", "l10"}:
        return _error("cadence_type must be shift_huddle or l10")
    try:
        factory_id = int(body.get("factory_id"))
        meeting_date = date.fromisoformat(str(body.get("meeting_date"))[:10])
    except (TypeError, ValueError):
        return _error("factory_id and meeting_date are required")
    shift_id = body.get("shift_id")
    try:
        shift_id = int(shift_id) if shift_id not in (None, "") else None
    except (TypeError, ValueError):
        return _error("shift_id must be numeric")
    if cadence_type == "l10" and shift_id is not None:
        return _error("A weekly L10 is factory-wide and cannot be scoped to a single shift.")
    actor = _actor(request)
    try:
        with _tx() as cur:
            if not _factory_authorized(actor, factory_id, cur):
                return _error("You are not assigned to this factory.", 403)
            context_ok, context_error = _context_relationship_valid(
                factory_id, shift_id=shift_id, cur=cur)
            if not context_ok:
                return _error(context_error)
            cur.execute(
                """
                INSERT INTO production_workspace_cadences
                    (cadence_type,factory_id,shift_id,meeting_date,headline,
                     priorities,scorecard,ids_items,status,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,%s)
                RETURNING *
                """,
                (cadence_type, factory_id, shift_id, meeting_date,
                 str(body.get("headline") or "").strip() or None,
                 json.dumps(_jsonable(_json_array(body.get("priorities")))),
                 json.dumps(_jsonable(_json_object(body.get("scorecard")))),
                 json.dumps(_jsonable(_json_array(body.get("ids_items")))),
                 str(body.get("status") or "open"), actor["user_id"], actor["user_id"]),
            )
            row = cur.fetchone()
            audit = _audit(cur, "cadence", row["id"], "created", actor, reason,
                           after=row, request_id=_request_id(request))
        return _mutation_result(_cadence_payload(request, row), audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("A cadence already exists for this factory, shift and date.", 409)
        log.exception("Cadence create failed")
        return _error("Could not create cadence", 500)


def _cadence_update(cadence_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, CADENCE_WRITE_ROLES, "Cadence changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every cadence change")
    try:
        expected = int(body.get("expected_version"))
    except (TypeError, ValueError):
        expected = None
    if expected is None:
        return _error("expected_version is required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            predicate, scope_params = _workspace_person_scope(actor, "c")
            cur.execute(
                "SELECT * FROM production_workspace_cadences c "
                "WHERE c.id=%s AND (" + predicate + ") FOR UPDATE",
                [cadence_id, *scope_params])
            before = cur.fetchone()
            if not before:
                return _error("Cadence not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, before["version_token"])
            fields = {
                "headline": str(body.get("headline") or "").strip() or None,
                "priorities": json.dumps(_jsonable(_json_array(body.get("priorities", before["priorities"])))),
                "scorecard": json.dumps(_jsonable(_json_object(body.get("scorecard", before["scorecard"])))),
                "ids_items": json.dumps(_jsonable(_json_array(body.get("ids_items", before["ids_items"])))),
                "status": str(body.get("status") or before["status"]),
            }
            cur.execute(
                """
                UPDATE production_workspace_cadences
                   SET headline=%s, priorities=%s::jsonb, scorecard=%s::jsonb,
                       ids_items=%s::jsonb, status=%s, version_token=version_token+1,
                       updated_by=%s, updated_at=now()
                 WHERE id=%s RETURNING *
                """,
                (*fields.values(), actor["user_id"], cadence_id))
            after = cur.fetchone()
            audit = _audit(cur, "cadence", cadence_id, "updated", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(_cadence_payload(request, after), audit)
    except Exception:
        log.exception("Cadence update failed")
        return _error("Could not update cadence", 500)


def _cadence_attendance(cadence_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, CADENCE_WRITE_ROLES, "Cadence attendance changes")
    if denied:
        return denied
    reason = _reason(body)
    member_user_id = str(body.get("member_user_id") or "").strip()
    display_name = str(body.get("display_name") or "").strip()
    state = str(body.get("attendance_state") or "present").lower()
    try:
        expected = int(body.get("expected_version", 0))
    except (TypeError, ValueError):
        expected = None
    if (not reason or not member_user_id or not display_name or expected is None
            or state not in {"present", "absent", "late", "excused"}):
        return _error("member_user_id, display_name, attendance_state, expected_version and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            predicate, scope_params = _workspace_person_scope(actor, "c")
            cur.execute(
                "SELECT c.* FROM production_workspace_cadences c WHERE c.id=%s "
                "AND (" + predicate + ") FOR UPDATE",
                [cadence_id, *scope_params])
            cadence = cur.fetchone()
            if not cadence:
                return _error("Cadence not found", 404)
            cur.execute(
                "SELECT * FROM production_workspace_cadence_attendance "
                "WHERE cadence_id=%s AND member_user_id=%s FOR UPDATE",
                (cadence_id, member_user_id))
            before = cur.fetchone()
            if before and int(before["version_token"]) != expected:
                return _version_error(expected, before["version_token"])
            if not before and expected != 0:
                return _version_error(expected, 0)
            if before:
                cur.execute(
                    """
                    UPDATE production_workspace_cadence_attendance
                       SET display_name=%s, attendance_state=%s, note=%s,
                           version_token=version_token+1, updated_by=%s, updated_at=now()
                     WHERE id=%s RETURNING *
                    """,
                    (display_name, state, str(body.get("note") or "").strip() or None,
                     actor["user_id"], before["id"]))
            else:
                cur.execute(
                    """
                    INSERT INTO production_workspace_cadence_attendance
                        (cadence_id,member_user_id,display_name,attendance_state,note,created_by,updated_by)
                    VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
                    """,
                    (cadence_id, member_user_id, display_name, state,
                     str(body.get("note") or "").strip() or None,
                     actor["user_id"], actor["user_id"]))
            row = cur.fetchone()
            audit = _audit(cur, "cadence_attendance", row["id"], "upserted", actor,
                           reason, before=before, after=row, request_id=_request_id(request))
        return _mutation_result(row, audit)
    except Exception:
        log.exception("Cadence attendance save failed")
        return _error("Could not save cadence attendance", 500)


def _cadence_action_create(cadence_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, CADENCE_ACTION_ROLES, "Cadence action changes")
    if denied:
        return denied
    reason = _reason(body)
    actor = _actor(request)
    try:
        with _tx() as cur:
            cur.execute(
                "SELECT * FROM production_workspace_cadences WHERE id=%s FOR SHARE", (cadence_id,))
            cadence = cur.fetchone()
            if not cadence or not _cadence_visible(request, cadence_id):
                return _error("Cadence not found", 404)
            carry_from_id = body.get("carry_forward_from")
            source_action = None
            if carry_from_id not in (None, ""):
                try:
                    carry_from_id = int(carry_from_id)
                except (TypeError, ValueError):
                    return _error("carry_forward_from must be numeric")
                if cadence["cadence_type"] != "l10":
                    return _error("Only a weekly L10 can carry an action forward.")
                # Lock the source action exclusively so two concurrent carry-
                # forward requests against it serialize instead of racing;
                # combined with the duplicate check below (re-evaluated after
                # the lock is acquired) this makes "carried forward at most
                # once" race-safe, not just checked-then-hoped.
                cur.execute(
                    "SELECT a.*, c.cadence_type AS source_cadence_type, "
                    "c.factory_id AS source_factory_id, c.meeting_date AS source_meeting_date "
                    "FROM production_workspace_cadence_actions a "
                    "JOIN production_workspace_cadences c ON c.id=a.cadence_id "
                    "WHERE a.id=%s AND a.cadence_id!=%s FOR UPDATE OF a",
                    (carry_from_id, cadence_id))
                source_action = cur.fetchone()
                if (not source_action or not _cadence_visible(request, source_action["cadence_id"])
                        or source_action["source_cadence_type"] != "l10"
                        or source_action["source_factory_id"] != cadence["factory_id"]
                        or source_action["source_meeting_date"] >= cadence["meeting_date"]):
                    return _error("The action being carried forward must come from an earlier "
                                  "L10 in the same factory.")
                # Lock the source row so a concurrent carry-forward request
                # can't race past this check; the unique index on
                # carried_forward_from is the final authority, but this keeps
                # the common case a clean 409 instead of a raw DB error.
                cur.execute(
                    "SELECT id FROM production_workspace_cadence_actions "
                    "WHERE carried_forward_from=%s FOR UPDATE", (carry_from_id,))
                if cur.fetchone():
                    return _error(
                        "This action has already been carried forward into a "
                        "later L10.", 409)
            title = str(body.get("title") or (source_action["title"] if source_action else "")).strip()
            if not reason or not title:
                return _error("title and reason are required")
            owner_user_id = body.get("owner_user_id")
            owner_name = body.get("owner_name")
            if source_action and owner_user_id is None and owner_name is None:
                owner_user_id = source_action["owner_user_id"]
                owner_name = source_action["owner_name"]
            due_date = body.get("due_date")
            due_date = date.fromisoformat(str(due_date)[:10]) if due_date else None
            cur.execute(
                """
                INSERT INTO production_workspace_cadence_actions
                    (cadence_id,title,owner_user_id,owner_name,due_date,status,notes,
                     carried_forward_from,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (cadence_id, title, owner_user_id, owner_name,
                 due_date, str(body.get("status") or "open"),
                 str(body.get("notes") or "").strip() or None,
                 source_action["id"] if source_action else None,
                 actor["user_id"], actor["user_id"]))
            row = cur.fetchone()
            audit = _audit(cur, "cadence_action",
                           row["id"], "carried_forward" if source_action else "created", actor, reason,
                           after=row, request_id=_request_id(request))
        return _mutation_result(row, audit)
    except psycopg2.errors.UniqueViolation:
        return _error(
            "This action has already been carried forward into a later L10.", 409)
    except Exception:
        log.exception("Cadence action create failed")
        return _error("Could not create cadence action", 500)


def _cadence_action_update(action_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, CADENCE_ACTION_ROLES, "Cadence action changes")
    if denied:
        return denied
    reason = _reason(body)
    try:
        expected = int(body.get("expected_version"))
    except (TypeError, ValueError):
        expected = None
    status = str(body.get("status") or "").lower()
    if expected is None or not reason or status not in {"open", "in_progress", "blocked", "resolved", "closed"}:
        return _error("expected_version, valid status and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            predicate, scope_params = _workspace_person_scope(actor, "c")
            cur.execute(
                "SELECT a.* FROM production_workspace_cadence_actions a "
                "JOIN production_workspace_cadences c ON c.id=a.cadence_id "
                "WHERE a.id=%s AND (" + predicate + ") FOR UPDATE",
                [action_id, *scope_params])
            before = cur.fetchone()
            if not before:
                return _error("Cadence action not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, before["version_token"])
            cur.execute(
                """
                UPDATE production_workspace_cadence_actions
                   SET status=%s, owner_user_id=COALESCE(%s,owner_user_id),
                       owner_name=COALESCE(%s,owner_name), notes=COALESCE(%s,notes),
                       version_token=version_token+1, updated_by=%s, updated_at=now()
                 WHERE id=%s RETURNING *
                """,
                (status, body.get("owner_user_id"), body.get("owner_name"),
                 body.get("notes"), actor["user_id"], action_id))
            after = cur.fetchone()
            audit = _audit(cur, "cadence_action", action_id, "updated", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("Cadence action update failed")
        return _error("Could not update cadence action", 500)


def _team(request: Request, factory_id: str = "", line_id: str = ""):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production team viewing")
    if denied:
        return denied
    actor = _actor(request)
    predicate, scope_params = _workspace_person_scope(actor, "m")
    clauses = [predicate]
    params = list(scope_params)
    if factory_id:
        clauses.append("(m.factory_id=%s::bigint OR m.factory_id IS NULL)")
        params.append(str(factory_id))
    if line_id:
        clauses.append("(m.line_id=%s::bigint OR m.line_id IS NULL)")
        params.append(str(line_id))
    rows = _db(
        "SELECT m.*, f.name AS factory_name, l.name AS line_name "
        "FROM production_workspace_team_members m "
        "LEFT JOIN production_workspace_factories f ON f.id=m.factory_id "
        "LEFT JOIN production_workspace_lines l ON l.id=m.line_id "
        "WHERE " + " AND ".join(clauses) +
        " ORDER BY m.active DESC, m.role_key, m.display_name",
        params, fetch=True)
    return _privacy_safe_workspace_payload(request, {"members": _rows(rows)})


def _team_create(request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, TEAM_WRITE_ROLES, "Team changes")
    if denied:
        return denied
    reason = _reason(body)
    name = str(body.get("display_name") or "").strip()
    role_key = str(body.get("role_key") or "").strip()
    if not reason or not name or not role_key:
        return _error("display_name, role_key and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            if not _factory_authorized(actor, body.get("factory_id"), cur):
                return _error("You are not assigned to this factory.", 403)
            context_ok, context_error = _context_relationship_valid(
                body.get("factory_id"), line_id=body.get("line_id"), cur=cur)
            if not context_ok:
                return _error(context_error)
            cur.execute(
                """
                INSERT INTO production_workspace_team_members
                    (user_id,display_name,role_key,responsibility,factory_id,line_id,
                     escalation_path,active,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (body.get("user_id"), name, role_key, body.get("responsibility"),
                 body.get("factory_id"), body.get("line_id"), body.get("escalation_path"),
                 bool(body.get("active", True)), actor["user_id"], actor["user_id"]))
            row = cur.fetchone()
            audit = _audit(cur, "team_member", row["id"], "created", actor, reason,
                           after=row, request_id=_request_id(request))
        return _mutation_result(row, audit)
    except Exception:
        log.exception("Team member create failed")
        return _error("Could not create team member", 500)


def _team_update(member_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, TEAM_WRITE_ROLES, "Team changes")
    if denied:
        return denied
    reason = _reason(body)
    try:
        expected = int(body.get("expected_version"))
    except (TypeError, ValueError):
        expected = None
    if expected is None or not reason:
        return _error("expected_version and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            predicate, scope_params = _workspace_person_scope(actor, "m")
            cur.execute(
                "SELECT * FROM production_workspace_team_members m WHERE m.id=%s "
                "AND (" + predicate + ") FOR UPDATE",
                [member_id, *scope_params])
            before = cur.fetchone()
            if not before:
                return _error("Team member not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, before["version_token"])
            factory_id = body.get("factory_id", before["factory_id"])
            if not _factory_authorized(actor, factory_id, cur):
                return _error("You are not assigned to this factory.", 403)
            line_id = body.get("line_id", before["line_id"])
            context_ok, context_error = _context_relationship_valid(
                factory_id, line_id=line_id, cur=cur)
            if not context_ok:
                return _error(context_error)
            cur.execute(
                """
                UPDATE production_workspace_team_members
                   SET display_name=COALESCE(%s,display_name), role_key=COALESCE(%s,role_key),
                       responsibility=COALESCE(%s,responsibility), factory_id=COALESCE(%s,factory_id),
                       line_id=COALESCE(%s,line_id), escalation_path=COALESCE(%s,escalation_path),
                       active=COALESCE(%s,active), version_token=version_token+1,
                       updated_by=%s, updated_at=now()
                 WHERE id=%s RETURNING *
                """,
                (body.get("display_name"), body.get("role_key"), body.get("responsibility"),
                 body.get("factory_id"), body.get("line_id"), body.get("escalation_path"),
                 body.get("active"), actor["user_id"], member_id))
            after = cur.fetchone()
            audit = _audit(cur, "team_member", member_id, "updated", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("Team member update failed")
        return _error("Could not update team member", 500)


def _resources(request: Request, factory_id: str = "", resource_type: str = "", status: str = ""):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production resource viewing")
    if denied:
        return denied
    actor = _actor(request)
    predicate, scope_params = _workspace_person_scope(actor, "r")
    clauses = [predicate]
    params = list(scope_params)
    if factory_id:
        clauses.append("(r.factory_id=%s::bigint OR r.factory_id IS NULL)")
        params.append(str(factory_id))
    if resource_type:
        clauses.append("r.resource_type=%s")
        params.append(str(resource_type))
    if status:
        clauses.append("r.status=%s")
        params.append(str(status))
    rows = _db(
        "SELECT r.*, f.name AS factory_name "
        "FROM production_workspace_resources r "
        "LEFT JOIN production_workspace_factories f ON f.id=r.factory_id "
        "WHERE " + " AND ".join(clauses) +
        " ORDER BY r.status, r.review_date NULLS LAST, r.title",
        params, fetch=True)
    return _privacy_safe_workspace_payload(request, {"resources": _rows(rows)})


def _resource_create(request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, RESOURCE_WRITE_ROLES, "Resource changes")
    if denied:
        return denied
    reason = _reason(body)
    key = str(body.get("resource_key") or "").strip()
    title_value = str(body.get("title") or "").strip()
    resource_type = str(body.get("resource_type") or "").strip()
    if not reason or not key or not title_value or not resource_type:
        return _error("resource_key, title, resource_type and reason are required")
    source_ref, source_error = _safe_resource_source_ref(body.get("source_ref"))
    if source_error:
        return _error(source_error)
    actor = _actor(request)
    try:
        with _tx() as cur:
            if not _factory_authorized(actor, body.get("factory_id"), cur):
                return _error("You are not assigned to this factory.", 403)
            cur.execute(
                """
                INSERT INTO production_workspace_resources
                    (resource_key,title,resource_type,description,factory_id,owner_user_id,
                     owner_name,status,effective_date,review_date,source_ref,provenance,
                     created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)
                RETURNING *
                """,
                (key, title_value, resource_type, body.get("description"),
                 body.get("factory_id"), body.get("owner_user_id"), body.get("owner_name"),
                 str(body.get("status") or "draft"),
                 body.get("effective_date") or None, body.get("review_date") or None,
                 source_ref, json.dumps(_jsonable(_json_object(body.get("provenance")))),
                 actor["user_id"], actor["user_id"]))
            row = cur.fetchone()
            audit = _audit(cur, "resource", row["id"], "created", actor, reason,
                           after=row, request_id=_request_id(request))
        return _mutation_result(row, audit)
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("resource_key already exists", 409)
        log.exception("Resource create failed")
        return _error("Could not create resource", 500)


def _resource_update(resource_id: int, request: Request, body: dict = Body(...)):
    _ensure_schema()
    denied = _require_role(request, RESOURCE_WRITE_ROLES, "Resource changes")
    if denied:
        return denied
    reason = _reason(body)
    try:
        expected = int(body.get("expected_version"))
    except (TypeError, ValueError):
        expected = None
    if expected is None or not reason:
        return _error("expected_version and reason are required")
    source_ref = None
    if "source_ref" in body:
        source_ref, source_error = _safe_resource_source_ref(body.get("source_ref"))
        if source_error:
            return _error(source_error)
    actor = _actor(request)
    try:
        with _tx() as cur:
            predicate, scope_params = _workspace_person_scope(actor, "r")
            cur.execute(
                "SELECT * FROM production_workspace_resources r WHERE r.id=%s "
                "AND (" + predicate + ") FOR UPDATE",
                [resource_id, *scope_params])
            before = cur.fetchone()
            if not before:
                return _error("Resource not found", 404)
            if int(before["version_token"]) != expected:
                return _version_error(expected, before["version_token"])
            factory_id = body.get("factory_id", before["factory_id"])
            if not _factory_authorized(actor, factory_id, cur):
                return _error("You are not assigned to this factory.", 403)
            cur.execute(
                """
                UPDATE production_workspace_resources
                   SET title=COALESCE(%s,title), description=COALESCE(%s,description),
                       resource_type=COALESCE(%s,resource_type), factory_id=COALESCE(%s,factory_id),
                       owner_user_id=COALESCE(%s,owner_user_id), owner_name=COALESCE(%s,owner_name),
                       status=COALESCE(%s,status), effective_date=COALESCE(%s,effective_date),
                       review_date=COALESCE(%s,review_date), source_ref=COALESCE(%s,source_ref),
                       provenance=COALESCE(%s::jsonb,provenance), version_token=version_token+1,
                       updated_by=%s, updated_at=now()
                 WHERE id=%s RETURNING *
                """,
                (body.get("title"), body.get("description"), body.get("resource_type"),
                 body.get("factory_id"), body.get("owner_user_id"), body.get("owner_name"),
                 body.get("status"), body.get("effective_date"), body.get("review_date"),
                 source_ref,
                 json.dumps(_jsonable(_json_object(body["provenance"]))) if "provenance" in body else None,
                 actor["user_id"], resource_id))
            after = cur.fetchone()
            audit = _audit(cur, "resource", resource_id, "updated", actor, reason,
                           before=before, after=after, request_id=_request_id(request))
        return _mutation_result(after, audit)
    except Exception:
        log.exception("Resource update failed")
        return _error("Could not update resource", 500)


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


def _execution_output_create_endpoint(plan_id: int, request: Request,
                                      body: dict = Body(default={})):
    return _execution_output_create(plan_id, request, body)


def _execution_output_update_endpoint(output_id: int, request: Request,
                                      body: dict = Body(default={})):
    return _execution_output_update(output_id, request, body)


def _execution_scope_args(date_from: str = None, date_to: str = None, stage: str = None,
                          factory_id: str = None, line_id: str = None, shift_id: str = None,
                          owner_user_id: str = None, plan_status: str = None,
                          search: str = None):
    return {"date_from": date_from, "date_to": date_to, "stage": stage,
            "factory_id": factory_id, "line_id": line_id, "shift_id": shift_id,
            "owner_user_id": owner_user_id, "plan_status": plan_status,
            "search": search}


def _plans_endpoint(request: Request, date_from: str = None, date_to: str = None,
                    stage: str = None, factory_id: str = None, line_id: str = None,
                    shift_id: str = None, owner_user_id: str = None,
                    plan_status: str = None, search: str = None):
    return _plans(request, **_execution_scope_args(
        date_from, date_to, stage, factory_id, line_id, shift_id,
        owner_user_id, plan_status, search))


def _execution_outputs_endpoint(request: Request, capture_date: str = None,
                                plan_version_id: int = None, date_from: str = None,
                                date_to: str = None, stage: str = None,
                                factory_id: str = None, line_id: str = None,
                                shift_id: str = None, owner_user_id: str = None,
                                plan_status: str = None, search: str = None):
    return _execution_outputs(request, capture_date, plan_version_id,
                              **_execution_scope_args(date_from, date_to, stage, factory_id, line_id, shift_id, owner_user_id, plan_status, search))


def _execution_worklist_endpoint(request: Request, capture_date: str = None,
                                 date_from: str = None, date_to: str = None,
                                 stage: str = None, factory_id: str = None,
                                 line_id: str = None, shift_id: str = None,
                                 owner_user_id: str = None, plan_status: str = None,
                                 search: str = None):
    return _execution_worklist(request, capture_date,
        **_execution_scope_args(date_from, date_to, stage, factory_id, line_id, shift_id, owner_user_id, plan_status, search))


def _execution_summary_endpoint(request: Request, capture_date: str = None,
                                date_from: str = None, date_to: str = None,
                                stage: str = None, factory_id: str = None,
                                line_id: str = None, shift_id: str = None,
                                owner_user_id: str = None, plan_status: str = None,
                                search: str = None):
    return _execution_summary(request, capture_date,
        **_execution_scope_args(date_from, date_to, stage, factory_id, line_id, shift_id, owner_user_id, plan_status, search))


def _execution_events_endpoint(request: Request, event_type: str = None,
                               plan_version_id: int = None,
                               event_date: str = None, date_from: str = None,
                               date_to: str = None, stage: str = None,
                               factory_id: str = None, line_id: str = None,
                               shift_id: str = None, owner_user_id: str = None,
                               plan_status: str = None, search: str = None):
    return _execution_events(request, event_type, plan_version_id, event_date,
        **_execution_scope_args(date_from, date_to, stage, factory_id, line_id, shift_id, owner_user_id, plan_status, search))


def _execution_event_create_endpoint(request: Request,
                                     body: dict = Body(default={})):
    return _execution_event_create(request, body)


def _execution_event_update_endpoint(event_id: int, request: Request,
                                     body: dict = Body(default={})):
    return _execution_event_update(event_id, request, body)


def _execution_bulk_preview_endpoint(request: Request,
                                     body: dict = Body(default={})):
    return _execution_bulk_preview(request, body)


def _execution_bulk_commit_endpoint(request: Request,
                                    body: dict = Body(default={})):
    return _execution_bulk_commit(request, body)


def _execution_bulk_template_endpoint(request: Request):
    return _execution_bulk_template(request)


def _audit_timeline_endpoint(entity_type: str, entity_id: str, request: Request):
    return _audit_timeline(entity_type, entity_id, request)


# --------------------------------------------------------------------------- #
# Production Tracker Sheet Feed (governed Google Sheets ingestion)            #
# --------------------------------------------------------------------------- #
SHEET_SOURCE_WRITE_ROLES = {"admin", "production"}
_TRACKER_SHEET_SOURCE_KEY = "production_tracker_2026"
_TRACKER_SHEET_METRIC_GROUPS = {
    "annual_totals", "category_mix", "stitched_output", "transfer_output",
    "fabric_mix", "process_productivity", "quality_defects",
}


def _tracker_sheet_source_row():
    rows = _db("""
        SELECT id, source_key, spreadsheet_id, tab_map, enabled, schedule_hint,
               version_token, updated_by, updated_at
          FROM production_tracker_sheet_sources WHERE source_key=%s
    """, (_TRACKER_SHEET_SOURCE_KEY,), fetch=True)
    return _rows(rows)[0] if rows else None


def _tracker_sheet_latest_run(source_id):
    rows = _db("""
        SELECT id, run_key, trigger_kind, triggered_by, started_at, finished_at,
               status, row_count, warning_count, error_message,
               source_updated_label, promoted
          FROM production_tracker_sheet_sync_runs
         WHERE source_id=%s ORDER BY started_at DESC LIMIT 1
    """, (source_id,), fetch=True)
    return _rows(rows)[0] if rows else None


def _tracker_sheet_get(request: Request):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production tracker sheet status")
    if denied:
        return denied
    source = _tracker_sheet_source_row()
    if not source:
        return {"configured": False, "can_edit": _actor(request)["role"] in SHEET_SOURCE_WRITE_ROLES}
    latest_run = _tracker_sheet_latest_run(source["id"])
    return {
        "configured": True,
        "spreadsheet_id": source["spreadsheet_id"],
        "spreadsheet_url": f"https://docs.google.com/spreadsheets/d/{source['spreadsheet_id']}",
        "tab_map": source["tab_map"],
        "enabled": source["enabled"],
        "schedule_hint": source["schedule_hint"],
        "updated_by": source["updated_by"],
        "updated_at": source["updated_at"],
        "can_edit": _actor(request)["role"] in SHEET_SOURCE_WRITE_ROLES,
        "latest_run": latest_run,
        # Explicit machine-readable state for the Setup panel's banner: the most
        # recent run's status IS the source's live connection state (never
        # inferred/guessed) — 'connection_pending' means the sheet still needs
        # to be shared with the connector's Google account.
        "connection_state": (latest_run or {}).get("status") or "never_synced",
    }


def _tracker_sheet_update(request: Request, body: dict = Body(default={})):
    _ensure_schema()
    denied = _require_role(request, SHEET_SOURCE_WRITE_ROLES, "Production tracker sheet configuration changes")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every source configuration change")
    source = _tracker_sheet_source_row()
    if not source:
        return _error("tracker sheet source is not initialized yet", 409)
    actor = _actor(request)
    updates = {}
    if "enabled" in body:
        updates["enabled"] = bool(body["enabled"])
    if "tab_map" in body and isinstance(body["tab_map"], dict):
        updates["tab_map"] = body["tab_map"]
    if "spreadsheet_id" in body and str(body["spreadsheet_id"]).strip():
        updates["spreadsheet_id"] = str(body["spreadsheet_id"]).strip()
    if not updates:
        return _error("no recognized fields to update (enabled, tab_map, spreadsheet_id)")
    sets, params = [], []
    for key, value in updates.items():
        if key == "tab_map":
            sets.append("tab_map = %s::jsonb")
            params.append(json.dumps(value))
        else:
            sets.append(f"{key} = %s")
            params.append(value)
    sets.append("version_token = version_token + 1")
    sets.append("updated_by = %s")
    params.append(actor["name"])
    sets.append("updated_at = now()")
    params.append(source["id"])
    with _tx() as cur:
        cur.execute(f"""
            UPDATE production_tracker_sheet_sources SET {", ".join(sets)}
             WHERE id = %s RETURNING id
        """, params)
        if cur.fetchone() is None:
            raise RuntimeError("tracker sheet source disappeared mid-update")
        _audit(cur, "tracker_sheet_source", source["id"], "update", actor, reason,
               before=source, after=updates)
    return _tracker_sheet_get(request)


def _tracker_sheet_sync_now(request: Request, body: dict = Body(default={})):
    _ensure_schema()
    denied = _require_role(request, SHEET_SOURCE_WRITE_ROLES, "Triggering a Production Tracker Sheet sync")
    if denied:
        return denied
    reason = _reason(body)
    if not reason:
        return _error("reason is required to trigger a Production Tracker Sheet sync")
    source = _tracker_sheet_source_row()
    if not source:
        return _error("tracker sheet source is not initialized yet", 409)
    if not source["enabled"]:
        return _error("the source is disabled; enable it before syncing", 409)
    actor = _actor(request)
    import subprocess
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        subprocess.Popen(
            [sys.executable, os.path.join(here, "production_tracker_sheet_sync.py"),
             "--manual", "--actor", actor.get("user_id") or actor.get("name") or "unknown"],
            cwd=here, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        return _error(f"failed to launch sync: {exc}", 500)
    with _tx() as cur:
        _audit(cur, "tracker_sheet_source", source["id"], "sync_now", actor,
               reason, before=None, after=None)
    return {"ok": True, "message": "Sync started in the background; poll status for the result."}


def _tracker_sheet_runs(request: Request, limit: int = 20):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production tracker sheet sync history")
    if denied:
        return denied
    source = _tracker_sheet_source_row()
    if not source:
        return {"runs": []}
    rows = _db("""
        SELECT id, run_key, trigger_kind, triggered_by, started_at, finished_at,
               status, row_count, warning_count, error_message,
               source_updated_label, promoted
          FROM production_tracker_sheet_sync_runs
         WHERE source_id=%s ORDER BY started_at DESC LIMIT %s
    """, (source["id"], max(1, min(int(limit or 20), 100))), fetch=True)
    return {"runs": _rows(rows)}


def _tracker_sheet_warnings(request: Request, resolved: bool = False, limit: int = 50):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production tracker sheet warnings")
    if denied:
        return denied
    rows = _db("""
        SELECT w.id, w.run_id, w.code, w.severity, w.message, w.detail,
               w.resolved, w.created_at, r.trigger_kind, r.started_at AS run_started_at
          FROM production_tracker_sheet_warnings w
          LEFT JOIN production_tracker_sheet_sync_runs r ON r.id = w.run_id
         WHERE w.resolved = %s
         ORDER BY w.created_at DESC LIMIT %s
    """, (bool(resolved), max(1, min(int(limit or 50), 200))), fetch=True)
    return {"warnings": _rows(rows)}


def _tracker_sheet_metrics(request: Request, metric_group: str, period_type: str = None,
                            period_from: str = None, period_to: str = None):
    _ensure_schema()
    denied = _require_role(request, VIEW_ROLES, "Production tracker sheet metrics")
    if denied:
        return denied
    if metric_group not in _TRACKER_SHEET_METRIC_GROUPS:
        return _error(f"unknown metric_group; expected one of {sorted(_TRACKER_SHEET_METRIC_GROUPS)}")
    clauses = ["metric_group = %s"]
    params = [metric_group]
    if period_type:
        clauses.append("period_type = %s")
        params.append(period_type)
    if period_from:
        clauses.append("period_key >= %s")
        params.append(period_from)
    if period_to:
        clauses.append("period_key <= %s")
        params.append(period_to)
    rows = _db(f"""
        SELECT metric_group, dimension, period_type, period_key, value,
               is_available, is_partial_period, source_label, normalized_label,
               updated_at
          FROM production_tracker_sheet_metrics
         WHERE {" AND ".join(clauses)}
         ORDER BY dimension, period_key
    """, params, fetch=True)
    return {"metrics": _rows(rows)}


def register_production_workspace_routes(app, api_module):
    """Register routes after the main API has defined its auth/db helpers."""
    global _API
    _API = api_module

    app.add_api_route("/api/production-workspace/tracker-sheet", _tracker_sheet_get, methods=["GET"])
    app.add_api_route("/api/production-workspace/tracker-sheet", _tracker_sheet_update, methods=["PUT"])
    app.add_api_route("/api/production-workspace/tracker-sheet/sync-now", _tracker_sheet_sync_now, methods=["POST"])
    app.add_api_route("/api/production-workspace/tracker-sheet/runs", _tracker_sheet_runs, methods=["GET"])
    app.add_api_route("/api/production-workspace/tracker-sheet/warnings", _tracker_sheet_warnings, methods=["GET"])
    app.add_api_route("/api/production-workspace/tracker-sheet/metrics", _tracker_sheet_metrics, methods=["GET"])

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
    app.add_api_route("/api/production-workspace/plans", _plans_endpoint, methods=["GET"])
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
    app.add_api_route("/api/production-workspace/execution/worklist",
                      _execution_worklist_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/execution/summary",
                      _execution_summary_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/execution/events",
                      _execution_events_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/execution/events",
                      _execution_event_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/execution/events/{event_id}",
                      _execution_event_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/execution/plans/{plan_id}/output",
                      _execution_output_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/execution/output",
                      _execution_outputs_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/execution/output/{output_id}",
                      _execution_output_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/execution/bulk/template",
                      _execution_bulk_template_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/execution/bulk/preview",
                      _execution_bulk_preview_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/execution/bulk/commit",
                      _execution_bulk_commit_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/audit/{entity_type}/{entity_id}",
                      _audit_timeline_endpoint, methods=["GET"])
    app.add_api_route(
        "/api/production-workspace/tracker-references",
        _tracker_references, methods=["GET"],
    )
    app.add_api_route("/api/production-workspace/cadences", _cadences, methods=["GET"])
    app.add_api_route("/api/production-workspace/cadences", _cadence_create, methods=["POST"])
    app.add_api_route("/api/production-workspace/cadences/{cadence_id}",
                      _cadence_update, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/cadences/{cadence_id}/attendance",
                      _cadence_attendance, methods=["POST"])
    app.add_api_route("/api/production-workspace/cadences/{cadence_id}/actions",
                      _cadence_action_create, methods=["POST"])
    app.add_api_route("/api/production-workspace/cadence-actions/{action_id}",
                      _cadence_action_update, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/team", _team, methods=["GET"])
    app.add_api_route("/api/production-workspace/team", _team_create, methods=["POST"])
    app.add_api_route("/api/production-workspace/team/{member_id}",
                      _team_update, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/resources", _resources, methods=["GET"])
    app.add_api_route("/api/production-workspace/resources",
                      _resource_create, methods=["POST"])
    app.add_api_route("/api/production-workspace/resources/{resource_id}",
                      _resource_update, methods=["PATCH"])
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