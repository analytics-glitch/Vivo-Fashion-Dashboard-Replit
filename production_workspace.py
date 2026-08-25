#!/usr/bin/env python3
"""Production Workspace foundation API.

This is an additive planning domain for the existing Production Pipeline.  It
owns factory/planning records and immutable workflow history, while linking to
the existing Odoo-backed production_orders, production_stages,
stage_movements, and app_users records.  It intentionally does not write to
the legacy tracker ledger.
"""

import json
import logging
import os
import threading
import uuid
from datetime import date, datetime, time
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
        ) AS locked
        """,
        (plan_id, plan_id, plan_id),
    )
    if cur.fetchone()["locked"]:
        return (
            "Factory, line and shift cannot change after planning inputs have been added. "
            "Create or reopen a revision for a different production context."
        )
    return None


def _validate_complete(cur, plan):
    missing = []
    cur.execute(
        "SELECT COUNT(*) AS n FROM production_workspace_operations WHERE plan_version_id=%s",
        (plan["id"],),
    )
    if int(cur.fetchone()["n"]) < 1:
        missing.append("at least one operation/SAM")
    cur.execute(
        "SELECT COUNT(*) AS n FROM production_workspace_capacity_inputs "
        "WHERE plan_version_id=%s", (plan["id"],),
    )
    if int(cur.fetchone()["n"]) < 1:
        missing.append("capacity input")
    cur.execute(
        "SELECT gate_key FROM production_workspace_readiness_gates "
        "WHERE plan_version_id=%s AND status <> 'passed'", (plan["id"],),
    )
    missing.extend(f"readiness gate: {r['gate_key']}" for r in cur.fetchall())
    if missing:
        return "Complete the plan before submitting: " + ", ".join(missing)
    return None


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
            candidate = dict(before)
            candidate.update({c: value for c, value in updates})
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
            if any(c in {"factory_id", "line_id", "shift_id"} for c, _ in updates):
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
                missing = _validate_complete(cur, plan)
                if missing:
                    return _error(missing, 422, code="workspace_plan_incomplete")
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
                "SELECT gate_key,gate_name,status,quality_ref,note "
                "FROM production_workspace_readiness_gates WHERE plan_version_id=%s",
                (plan_id,),
            )
            for gate in cur.fetchall():
                cur.execute(
                    "INSERT INTO production_workspace_readiness_gates "
                    "(plan_version_id,gate_key,gate_name,status,quality_ref,note) "
                    "VALUES (%s,%s,%s,'pending',%s,%s)",
                    (reopened["id"], gate["gate_key"], gate["gate_name"],
                     gate["quality_ref"], gate["note"]),
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
                "quality_ref=%s, note=%s, checked_by=%s, checked_at=now(), "
                "version_token=version_token+1 WHERE id=%s RETURNING *",
                (status, body.get("quality_ref"), body.get("note"),
                 actor["user_id"], gate["id"]),
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
    required = ("operation_code", "name", "sequence_no", "sam_minutes")
    if not reason or any(body.get(c) in (None, "") for c in required):
        return _error("operation_code, name, sequence_no, sam_minutes and reason are required")
    actor = _actor(request)
    try:
        with _tx() as cur:
            plan, failure = _require_mutable_plan(cur, plan_id, body, actor)
            if failure:
                return failure
            relationship_error = _scope_relationship_error(
                cur, factory_id=plan["factory_id"],
                line_id=body.get("line_id") or plan.get("line_id"),
                capability_id=body.get("capability_id"),
            )
            if relationship_error:
                return _error(relationship_error, 400,
                              code="workspace_scope_mismatch")
            cur.execute(
                "INSERT INTO production_workspace_operations "
                "(work_item_id,plan_version_id,operation_code,name,sequence_no,sam_minutes,capability_id,line_id,created_by,updated_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (plan["work_item_id"], plan_id, body["operation_code"], body["name"],
                 body["sequence_no"], body["sam_minutes"], body.get("capability_id"),
                 body.get("line_id"), actor["user_id"], actor["user_id"]),
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
            if operation_id is not None:
                cur.execute(
                    "SELECT id FROM production_workspace_operations "
                    "WHERE id=%s AND plan_version_id=%s FOR UPDATE",
                    (operation_id, plan_id),
                )
                if not cur.fetchone():
                    return _error(
                        "The assigned operation must belong to this plan revision. Refresh and choose an operation from this plan.",
                        409, code="workspace_assignment_operation_mismatch",
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
    required = ("available_minutes", "required_minutes")
    if not reason or any(body.get(c) in (None, "") for c in required):
        return _error("available_minutes, required_minutes and reason are required")
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
                """
                INSERT INTO production_workspace_capacity_inputs
                    (plan_version_id,calendar_id,line_id,machine_id,
                     available_minutes,required_minutes,source,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
                """,
                (plan_id, body.get("calendar_id"), body.get("line_id"),
                 body.get("machine_id"), body["available_minutes"],
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


def _operator_skill_create_endpoint(operator_id: int, request: Request,
                                    body: dict = Body(default={})):
    return _operator_skill_create(operator_id, request, body)


def _work_item_create_endpoint(request: Request, body: dict = Body(default={})):
    return _work_item_create(request, body)


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
    app.add_api_route("/api/production-workspace/operators/{operator_id}/skills",
                      _operator_skill_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/work-items", _work_items, methods=["GET"])
    app.add_api_route("/api/production-workspace/work-items",
                      _work_item_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans", _plans, methods=["GET"])
    app.add_api_route("/api/production-workspace/work-items/{work_item_id}/plans",
                      _plan_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}",
                      _plan_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/plans/{plan_id}",
                      _plan_get, methods=["GET"])
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
    app.add_api_route("/api/production-workspace/plans/{plan_id}/execution-references",
                      _execution_ref_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/audit/{entity_type}/{entity_id}",
                      _audit_timeline_endpoint, methods=["GET"])
    app.add_api_route(
        "/api/production-workspace/tracker-references",
        _tracker_references, methods=["GET"],
    )