"""Productivity and delivery-recovery views for the Production Workspace.

This module is deliberately a read/action layer over the approved planning and
execution ledgers.  It never writes the legacy tracker tables and it never
turns a missing denominator into a zero or a ranking.
"""

import json
import logging
import os
from datetime import date, timedelta

from fastapi import Body, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("production_insights")
_API = None

READ_ROLES = {
    "admin", "production", "leadership", "smt", "product_development",
    "quality", "fabric_quality_supervisor",
}
AGGREGATE_ROLES = {"admin", "leadership", "smt"}
ACTION_ROLES = {"admin", "production", "leadership", "smt"}
ACTION_STATUSES = {"open", "in_progress", "blocked", "resolved", "closed"}
QUALITY_ROLES = {"quality", "fabric_quality_supervisor"}
PRODUCT_ROLES = {"product_development"}


def _jsonable(value):
    from datetime import datetime, time
    from decimal import Decimal
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
    return [_jsonable(dict(row)) for row in (rows or [])]


def _actor(request):
    user = getattr(request.state, "user", None) or {}
    return {
        "user_id": str(user.get("user_id") or user.get("id") or ""),
        "name": user.get("name") or user.get("email") or "Unknown user",
        "role": str(user.get("role") or "").lower(),
    }


def _error(detail, status=400, **extra):
    body = {"detail": detail}
    body.update(extra)
    return JSONResponse(body, status_code=status)


def _require(request, roles, action):
    actor = _actor(request)
    if actor["role"] not in roles:
        return _error(f"{action} requires an authorized production workspace role", 403)
    return None


def _db(query, params=None, fetch=False):
    return _API._users_exec(query, params or [], fetch=fetch)


def _tx():
    return _API._users_tx()


def _day(value, fallback):
    try:
        return date.fromisoformat(str(value)[:10]) if value else fallback
    except (TypeError, ValueError):
        return fallback


def _number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _ensure_tables():
    """Create only the additive action register; metric data remains source-led."""
    _db(
        """
        CREATE TABLE IF NOT EXISTS production_workspace_recovery_actions (
            id BIGSERIAL PRIMARY KEY,
            action_key TEXT NOT NULL UNIQUE,
            plan_version_id BIGINT NOT NULL
                REFERENCES production_workspace_plan_versions(id) ON DELETE RESTRICT,
            work_item_id BIGINT NOT NULL
                REFERENCES production_workspace_work_items(id) ON DELETE RESTRICT,
            production_order_ref TEXT,
            factory_id BIGINT REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
            line_id BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
            title TEXT NOT NULL,
            rationale JSONB NOT NULL DEFAULT '[]'::jsonb,
            priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
            source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            owner_user_id TEXT,
            due_date DATE,
            status TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','blocked','resolved','closed')),
            notes TEXT,
            version_token BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_recovery_queue
            ON production_workspace_recovery_actions(status, priority DESC, due_date);
        """,
        fetch=False,
    )


def ensure_production_insights_tables():
    try:
        _ensure_tables()
    except Exception:
        log.exception("Production insights action table initialization failed")
        raise


def _audit(cur, entity_id, action, actor, reason, before=None, after=None,
           request_id=None):
    cur.execute(
        """
        INSERT INTO production_workspace_audit_events
          (entity_type,entity_id,action,actor_user_id,actor_name,reason,
           before_json,after_json,request_id)
        VALUES ('recovery_action',%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)
        RETURNING id, occurred_at
        """,
        (
            str(entity_id), action, actor["user_id"], actor["name"], reason,
            json.dumps(_jsonable(before)) if before is not None else None,
            json.dumps(_jsonable(after)) if after is not None else None,
            request_id,
        ),
    )
    return cur.fetchone()


def _request_id(request):
    return (request.headers.get("x-request-id") or "")[:100] or None


def _reason(body):
    reason = str((body or {}).get("reason") or "").strip()
    return reason if len(reason) >= 3 else None


def _metric_contract():
    return {
        "earned_minutes": {
            "formula": "good_qty × approved operation SAM minutes",
            "source": "approved plan operation snapshot + execution output",
            "unavailable_when": ["good output or approved SAM is missing"],
        },
        "attended_minutes": {
            "formula": "sum of complete recorded attendance hours × 60",
            "source": "vivo_attendance",
            "unavailable_when": ["no complete attendance record is available"],
        },
        "efficiency": {
            "formula": "earned minutes ÷ attended minutes × 100",
            "source": "the two metrics above",
            "unavailable_when": ["earned minutes or attended minutes is unavailable",
                                 "attended minutes is zero"],
        },
        "target_actual": {
            "target": "approved plan planned_qty",
            "actual": "good + reject + rework captured in the selected window",
            "missing_state": "unavailable, never zero",
        },
        "quality": {
            "good": "accepted output",
            "reject": "rejected output",
            "rework": "rework output plus captured QC defects where available",
        },
        "ranking": "No default worker ranking; incomplete denominators remain unavailable.",
    }


_PRODUCTIVITY_SQL = """
WITH selected_plans AS (
    SELECT p.*, wi.external_ref, wi.style_number, wi.description,
           wi.production_order_ref, wi.stage_key,
           f.name AS factory_name, l.name AS plan_line_name
    FROM production_workspace_plan_versions p
    JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
    JOIN production_workspace_factories f ON f.id=p.factory_id
    LEFT JOIN production_workspace_lines l ON l.id=p.line_id
    WHERE p.status IN ('approved','frozen')
      AND p.planned_start <= %s AND p.planned_end >= %s
      AND (NULLIF(%s,'') IS NULL OR p.factory_id=NULLIF(%s,'')::bigint)
      AND (NULLIF(%s,'') IS NULL OR p.line_id=NULLIF(%s,'')::bigint)
),
outputs AS (
    SELECT plan_version_id, assignment_id,
           SUM(good_qty) AS good_qty, SUM(reject_qty) AS reject_qty,
           SUM(rework_qty) AS rework_qty,
           MAX(created_at) AS output_fresh_at
    FROM production_workspace_execution_output
    WHERE capture_date BETWEEN %s AND %s
      AND assignment_id IS NOT NULL
    GROUP BY plan_version_id, assignment_id
),
downtime AS (
    SELECT plan_version_id, assignment_id,
           SUM(duration_minutes) AS downtime_minutes,
           MAX(created_at) AS downtime_fresh_at
    FROM production_workspace_execution_events
    WHERE event_type='downtime' AND event_date BETWEEN %s AND %s
      AND assignment_id IS NOT NULL
    GROUP BY plan_version_id, assignment_id
),
quality_events AS (
    SELECT plan_version_id, assignment_id,
           SUM(CASE WHEN event_type='qc_defect' THEN COALESCE(quantity,0) ELSE 0 END)
             AS qc_defect_qty,
           SUM(CASE WHEN event_type='qc_defect' AND
                         lower(COALESCE(reason,'')) LIKE '%%rework%%'
                    THEN COALESCE(quantity,0) ELSE 0 END) AS qc_rework_qty,
           MAX(created_at) AS quality_fresh_at
    FROM production_workspace_execution_events
    WHERE event_type='qc_defect' AND event_date BETWEEN %s AND %s
      AND assignment_id IS NOT NULL
    GROUP BY plan_version_id, assignment_id
),
attendance AS (
    SELECT lower(trim(employee_name)) AS person_key,
           SUM(hours_worked * 60) FILTER (
             WHERE COALESCE(is_complete,false) AND hours_worked IS NOT NULL
           ) AS attended_minutes,
           COUNT(*) FILTER (WHERE COALESCE(is_complete,false)) AS attendance_days,
           MAX(attendance_date) AS attendance_fresh_at
    FROM vivo_attendance
    WHERE attendance_date BETWEEN %s AND %s
    GROUP BY lower(trim(employee_name))
)
SELECT sp.id AS plan_version_id, sp.version_no, sp.status,
       sp.planned_start, sp.planned_end, sp.planned_qty,
       sp.external_ref, sp.style_number, sp.description,
       sp.production_order_ref, sp.stage_key AS current_stage,
       sp.factory_id, sp.factory_name, sp.line_id,
       COALESCE(sp.plan_line_name,'Unassigned line') AS line_name,
       a.id AS assignment_id, a.assignment_role, a.planned_minutes,
       o.id AS operator_id, o.user_id AS operator_user_id,
       o.display_name AS operator_name,
       a.operation_id, op.name AS operation_name, op.sam_minutes,
       CASE WHEN a.planned_minutes > 0 AND op.sam_minutes > 0
            THEN a.planned_minutes / op.sam_minutes ELSE NULL END AS assignment_target_qty,
       x.good_qty, x.reject_qty, x.rework_qty,
       x.output_fresh_at,
       q.qc_defect_qty, q.qc_rework_qty,
       q.quality_fresh_at,
       d.downtime_minutes,
       d.downtime_fresh_at,
       at.attended_minutes, at.attendance_days, at.attendance_fresh_at
FROM selected_plans sp
JOIN production_workspace_assignments a ON a.plan_version_id=sp.id
LEFT JOIN production_workspace_operators o ON o.id=a.operator_id AND o.active
LEFT JOIN production_workspace_operations op ON op.id=a.operation_id
LEFT JOIN outputs x ON x.plan_version_id=sp.id AND x.assignment_id=a.id
LEFT JOIN downtime d ON d.plan_version_id=sp.id AND d.assignment_id=a.id
LEFT JOIN quality_events q ON q.plan_version_id=sp.id AND q.assignment_id=a.id
LEFT JOIN attendance at ON at.person_key=lower(trim(o.display_name))
WHERE (%s <> 'production'
       OR sp.owner_user_id=%s OR o.user_id=%s)
ORDER BY sp.factory_name, line_name, operator_name NULLS LAST, sp.planned_start
"""


def _productivity_rows(start, end, actor, factory_id="", line_id=""):
    params = [
        end, start, str(factory_id or ""), str(factory_id or ""),
        str(line_id or ""), str(line_id or ""),
        start, end, start, end, start, end, start, end,
        actor["role"], actor["user_id"], actor["user_id"],
    ]
    try:
        return _db(_PRODUCTIVITY_SQL, params, fetch=True)
    except Exception as exc:
        # An old environment can have no attendance ingest table yet. The rest
        # of the view remains useful, but attendance is explicitly unavailable.
        if "vivo_attendance" not in str(exc).lower():
            raise
        fallback = _PRODUCTIVITY_SQL.replace(
            ''',
attendance AS (
    SELECT lower(trim(employee_name)) AS person_key,
           SUM(hours_worked * 60) FILTER (
             WHERE COALESCE(is_complete,false) AND hours_worked IS NOT NULL
           ) AS attended_minutes,
           COUNT(*) FILTER (WHERE COALESCE(is_complete,false)) AS attendance_days,
           MAX(attendance_date) AS attendance_fresh_at
    FROM vivo_attendance
    WHERE attendance_date BETWEEN %s AND %s
    GROUP BY lower(trim(employee_name))
)''',
            "",
        ).replace(
            "       at.attended_minutes, at.attendance_days, at.attendance_fresh_at",
            "       NULL::numeric AS attended_minutes, 0 AS attendance_days, NULL::date AS attendance_fresh_at",
        ).replace(
            "LEFT JOIN attendance at ON at.person_key=lower(trim(o.display_name))",
            "",
        )
        # Remove the two attendance parameters immediately before the role
        # filters in the fallback call.
        fallback_params = params[:12] + params[14:]
        return _db(fallback, fallback_params, fetch=True)


def _metric_row(row):
    output_present = row.get("output_fresh_at") is not None
    quality_present = row.get("quality_fresh_at") is not None
    downtime_present = row.get("downtime_fresh_at") is not None
    good = _number(row.get("good_qty")) if output_present else None
    reject = _number(row.get("reject_qty")) if output_present else None
    rework = _number(row.get("rework_qty")) if output_present else None
    sam = row.get("sam_minutes")
    attended = row.get("attended_minutes")
    earned = good * _number(sam) if good is not None and sam is not None and _number(sam) > 0 else None
    attended_value = _number(attended) if attended is not None else None
    actual = good + reject + rework if output_present else None
    quality_total = (
        actual + _number(row.get("qc_defect_qty"))
        if actual is not None and quality_present else None
    )
    efficiency = (
        earned / attended_value * 100
        if earned is not None and attended_value is not None and attended_value > 0
        else None
    )
    data = dict(row)
    data.update({
        "plan_target_qty": _number(row.get("planned_qty")) if row.get("planned_qty") is not None else None,
        "target_qty": _number(row.get("assignment_target_qty")) if row.get("assignment_target_qty") is not None else None,
        "actual_qty": actual,
        "earned_minutes": earned,
        "attended_minutes": attended_value,
        "efficiency_pct": efficiency,
        "quality_total": quality_total if quality_total is not None and quality_total > 0 else None,
        "reject_rate_pct": reject / quality_total * 100
            if quality_total is not None and quality_total > 0 else None,
        "rework_rate_pct": (rework +
                            _number(row.get("qc_rework_qty"))) / quality_total * 100
            if quality_total is not None and quality_total > 0 else None,
        "metric_state": "available" if efficiency is not None else "unavailable",
        "metric_unavailable_reason": (
            None if efficiency is not None else
            "Execution output has not been captured for this assignment."
            if not output_present else
            "No complete recorded attendance for this scope."
            if attended is None or attended_value == 0 else
            "Approved operation/SAM is unavailable."
        ),
        "data_completeness": {
            "plan": bool(row.get("plan_version_id")),
            "sam": sam is not None and _number(sam) > 0,
            "attendance": attended is not None,
            "output": output_present,
            "quality": quality_present,
            "downtime": downtime_present,
        },
    })
    return data


def _aggregate(rows, keys, label_key, *, worker=False):
    groups = {}
    for row in rows:
        key = tuple(row.get(k) for k in keys)
        out = groups.setdefault(key, {
            label_key: row.get(label_key) or "Unassigned",
            "factory_name": row.get("factory_name"),
            "line_name": row.get("line_name"),
            "plans": {},
            "operator_attendance": {},
            "source_rows": [],
            "rows": 0,
        })
        out["rows"] += 1
        out["plans"][row.get("plan_version_id")] = row.get("plan_target_qty")
        operator_key = row.get("operator_id") or row.get("operator_name") or f"assignment:{row.get('assignment_id')}"
        attendance = row.get("attended_minutes")
        previous = out["operator_attendance"].get(operator_key)
        if previous is None or attendance is None:
            out["operator_attendance"][operator_key] = attendance
        out["source_rows"].append(row)
    result = []
    for item in groups.values():
        sources = item.pop("source_rows")
        plans = item.pop("plans")
        attendance_values = item.pop("operator_attendance").values()
        all_output = all(row["data_completeness"]["output"] for row in sources)
        all_sam = all(row["data_completeness"]["sam"] for row in sources)
        all_attendance = all(value is not None and _number(value) > 0 for value in attendance_values)
        all_quality = all(row["data_completeness"]["quality"] for row in sources)
        all_downtime = all(row["data_completeness"]["downtime"] for row in sources)
        item["plan_count"] = len(plans)
        item["target_qty"] = (
            sum(_number(row.get("target_qty")) for row in sources)
            if worker and all(row.get("target_qty") is not None for row in sources)
            else sum(_number(value) for value in plans.values())
            if not worker and all(value is not None for value in plans.values())
            else None
        )
        for field in ("actual_qty", "good_qty", "reject_qty", "rework_qty", "earned_minutes"):
            item[field] = (
                sum(_number(row.get(field)) for row in sources)
                if all_output and (field != "earned_minutes" or all_sam) else None
            )
        item["attended_minutes"] = (
            sum(_number(value) for value in attendance_values) if all_attendance else None
        )
        item["downtime_minutes"] = (
            sum(_number(row.get("downtime_minutes")) for row in sources)
            if all_downtime else None
        )
        item["efficiency_pct"] = (
            item["earned_minutes"] / item["attended_minutes"] * 100
            if item["earned_minutes"] is not None and item["attended_minutes"] else None
        )
        item["quality_total"] = (
            sum(_number(row.get("quality_total")) for row in sources)
            if all_output and all_quality else None
        )
        item["metric_state"] = "available" if item["efficiency_pct"] is not None else "unavailable"
        item["metric_unavailable_reason"] = (
            None if item["metric_state"] == "available" else
            "At least one assignment lacks execution output, approved SAM, or complete recorded attendance."
        )
        item["data_completeness"] = {
            "plan": bool(plans),
            "sam": all_sam,
            "attendance": all_attendance,
            "output": all_output,
            "quality": all_quality,
            "downtime": all_downtime,
        }
        item["data_completeness_pct"] = round(
            sum(item["data_completeness"].values()) / len(item["data_completeness"]) * 100, 1
        )
        result.append(item)
    return result


def _freshness(rows):
    fields = ("output_fresh_at", "quality_fresh_at", "downtime_fresh_at",
              "attendance_fresh_at")
    return {
        field: max((row.get(field) for row in rows if row.get(field)), default=None)
        for field in fields
    }


def _productivity(request, date_from=None, date_to=None, view="worker",
                  factory_id="", line_id=""):
    denied = _require(request, READ_ROLES, "Productivity viewing")
    if denied:
        return denied
    actor = _actor(request)
    end = _day(date_to, date.today())
    start = _day(date_from, end - timedelta(days=29))
    if start > end:
        return _error("date_from must be on or before date_to")
    if view not in {"worker", "line", "factory"}:
        return _error("view must be worker, line or factory")
    raw = _productivity_rows(start, end, actor, factory_id, line_id)
    rows = [_metric_row(row) for row in raw]
    if view == "worker":
        data = _aggregate(rows, ("operator_id", "operator_name"), "operator_name", worker=True)
    elif view == "line":
        data = _aggregate(rows, ("factory_id", "line_id"), "line_name")
    else:
        data = _aggregate(rows, ("factory_id",), "factory_name")
    if actor["role"] in QUALITY_ROLES | PRODUCT_ROLES:
        # These stakeholders investigate plan/quality evidence, not individual
        # attendance or efficiency. Redaction happens at the API boundary.
        for row in data:
            for field in ("operator_user_id", "operator_id", "operator_name",
                          "attended_minutes", "earned_minutes", "efficiency_pct"):
                row.pop(field, None)
    return {
        "schema_version": "1",
        "as_of": date.today().isoformat(),
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "view": view,
        "rows": _rows(data),
        "freshness": _jsonable(_freshness(rows)),
        "metric_contract": _metric_contract(),
        "scope": {
            "role": actor["role"],
            "private_worker_context": actor["role"] == "production",
            "comparison_allowed": actor["role"] in AGGREGATE_ROLES,
            "supervisor_scope": (
                "Production users only receive plans they own or assignments "
                "attached to their user account."
                if actor["role"] == "production" else "Role-wide scope"
            ),
            "quality_context_only": actor["role"] in QUALITY_ROLES,
            "plan_context_only": actor["role"] in PRODUCT_ROLES,
        },
    }


_RECOVERY_SQL = """
WITH outputs AS (
  SELECT plan_version_id, SUM(good_qty) AS good_qty,
         SUM(reject_qty) AS reject_qty, SUM(rework_qty) AS rework_qty,
         MAX(capture_date) AS last_output_date
  FROM production_workspace_execution_output
  -- Delivery remaining is a cumulative position as of the selected end date,
  -- not a window-only comparison against the full approved commitment.
  WHERE capture_date <= %s
  GROUP BY plan_version_id
),
events AS (
  SELECT plan_version_id,
         SUM(duration_minutes) FILTER (WHERE event_type='downtime') AS downtime_minutes,
         SUM(quantity) FILTER (WHERE event_type='qc_defect') AS qc_defect_qty,
         SUM(quantity) FILTER (WHERE event_type='qc_defect' AND
             lower(COALESCE(reason,'')) LIKE '%%rework%%') AS qc_rework_qty,
         MAX(event_date) AS last_event_date
  FROM production_workspace_execution_events
  WHERE event_date BETWEEN %s AND %s
  GROUP BY plan_version_id
),
capacity AS (
  SELECT plan_version_id, SUM(available_minutes) AS available_minutes,
         SUM(required_minutes) AS required_minutes
  FROM production_workspace_capacity_inputs
  GROUP BY plan_version_id
),
wip AS (
  SELECT b.order_ref, SUM(b.qty_here) AS wip_units,
         (array_agg(b.stage ORDER BY b.qty_here DESC, b.stage))[1] AS tracker_stage
  FROM v_stage_balances b
  WHERE b.qty_here > 0
  GROUP BY b.order_ref
)
SELECT p.id AS plan_version_id, p.version_no, p.planned_start, p.planned_end,
       p.planned_qty, p.owner_user_id, wi.id AS work_item_id,
       wi.external_ref, wi.style_number, wi.production_order_ref,
       COALESCE(w.tracker_stage, wi.stage_key) AS current_stage, f.name AS factory_name,
       l.name AS line_name, p.factory_id, p.line_id,
       x.good_qty, x.reject_qty, x.rework_qty,
       x.last_output_date,
       e.downtime_minutes, e.qc_defect_qty, e.qc_rework_qty,
       e.last_event_date,
       c.available_minutes, c.required_minutes,
       COALESCE(w.wip_units,0) AS wip_units
FROM production_workspace_plan_versions p
JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
JOIN production_workspace_factories f ON f.id=p.factory_id
LEFT JOIN production_workspace_lines l ON l.id=p.line_id
LEFT JOIN outputs x ON x.plan_version_id=p.id
LEFT JOIN events e ON e.plan_version_id=p.id
LEFT JOIN capacity c ON c.plan_version_id=p.id
LEFT JOIN wip w ON w.order_ref=wi.production_order_ref
WHERE p.status IN ('approved','frozen')
  AND p.planned_start <= %s AND p.planned_end >= %s
  AND (NULLIF(%s,'') IS NULL OR p.factory_id=NULLIF(%s,'')::bigint)
  AND (NULLIF(%s,'') IS NULL OR p.line_id=NULLIF(%s,'')::bigint)
ORDER BY p.planned_end, f.name, l.name, wi.style_number
"""


def _recovery_candidates(start, end, factory_id="", line_id=""):
    params = [end, start, end, end, start, str(factory_id or ""), str(factory_id or ""),
              str(line_id or ""), str(line_id or "")]
    rows = _db(_RECOVERY_SQL, params, fetch=True)
    # Every delivery-position signal is evaluated as of the selected end date.
    # The tracker balance view is live-only, so it is deliberately withheld
    # for historical/future views rather than misrepresented as history.
    as_of = end
    current_wip_available = as_of == date.today()
    result = []
    for raw in rows:
        row = dict(raw)
        planned = _number(row.get("planned_qty"))
        execution_present = row.get("last_output_date") is not None
        actual = (
            sum(_number(row.get(k)) for k in ("good_qty", "reject_qty", "rework_qty"))
            if execution_present else None
        )
        remaining = max(0, planned - actual) if actual is not None else None
        due = _day(row.get("planned_end"), as_of)
        days_to_due = (due - as_of).days
        if not current_wip_available:
            row["current_stage"] = None
            row["wip_units"] = None
        capacity = row.get("available_minutes")
        required = _number(row.get("required_minutes"))
        load_pct = required / _number(capacity) * 100 if capacity and _number(capacity) > 0 else None
        reasons = []
        score = 0
        if not execution_present:
            reasons.append("Execution capture is unavailable for this period; this is a data-completeness follow-up, not a performance failure.")
        elif days_to_due <= 0 and remaining > 0:
            score += 40
            reasons.append("Approved commitment is due or overdue.")
        elif days_to_due <= 7 and remaining > 0:
            score += 30
            reasons.append(f"Only {max(days_to_due, 0)} days remain on the approved plan.")
        elif days_to_due <= 14 and remaining > 0:
            score += 20
            reasons.append("Commitment is due within 14 days.")
        if remaining is not None and remaining > 0 and planned > 0:
            remaining_pct = remaining / planned * 100
            score += min(25, round(remaining_pct / 4))
            reasons.append(f"{remaining_pct:.0f}% of planned work remains.")
        if current_wip_available and execution_present and row.get("current_stage") and str(row["current_stage"]).lower() in {
            "buying_order", "cutting", "waiting_sewing", "sewing"
        } and days_to_due <= 14:
            score += 12
            reasons.append(f"Work is still in {str(row['current_stage']).replace('_',' ')}.")
        if current_wip_available and _number(row.get("wip_units")) > 0:
            reasons.append(
                f"{_number(row['wip_units']):.0f} units of tracker WIP exist across stages; "
                f"the largest recorded stage is {str(row.get('current_stage') or 'unavailable').replace('_',' ')}."
            )
        elif not current_wip_available:
            reasons.append(
                "Tracker WIP is live/current and is unavailable for a non-current as-of date."
            )
        if load_pct is None:
            reasons.append("Capacity/load denominator is unavailable.")
        elif load_pct > 100:
            score += 15
            reasons.append(f"Approved load is {load_pct:.0f}% of saved capacity.")
        elif load_pct > 85:
            score += 8
            reasons.append(f"Approved load is {load_pct:.0f}% of saved capacity.")
        quality = _number(row.get("qc_defect_qty")) + _number(row.get("rework_qty"))
        if quality > 0:
            score += min(15, round(quality / max(actual, 1) * 100 / 5))
            reasons.append(f"{quality:.0f} units have reject/rework or QC-defect context.")
        downtime = _number(row.get("downtime_minutes"))
        if downtime > 0:
            score += min(15, round(downtime / 60))
            reasons.append(f"{downtime:.0f} minutes of downtime are recorded.")
        if remaining is not None and remaining <= 0:
            continue
        row.update({
            "remaining_qty": remaining,
            "actual_qty": actual,
            "days_to_due": days_to_due,
            "load_pct": load_pct,
            "priority_score": min(score, 100),
            "priority_band": (
                "data_needed" if not execution_present else
                "urgent" if score >= 70 else "watch" if score >= 40 else "planned"
            ),
            "reasons": reasons,
            "data_completeness": {
                "approved_plan": True,
                "remaining_work": remaining is not None,
                "stage_wip": current_wip_available and row.get("current_stage") is not None,
                "capacity": capacity is not None,
                "quality": row.get("last_event_date") is not None,
                "downtime": row.get("last_event_date") is not None,
            },
        })
        result.append(row)
    return sorted(result, key=lambda r: (-r["priority_score"], r["planned_end"]))


def _recovery(request, date_from=None, date_to=None, factory_id="", line_id=""):
    denied = _require(request, READ_ROLES, "Delivery recovery viewing")
    if denied:
        return denied
    actor = _actor(request)
    end = _day(date_to, date.today())
    start = _day(date_from, end - timedelta(days=29))
    if start > end:
        return _error("date_from must be on or before date_to")
    candidates = _recovery_candidates(start, end, factory_id, line_id)
    if actor["role"] == "production":
        candidates = [
            row for row in candidates
            if str(row.get("owner_user_id") or "") == actor["user_id"]
        ]
    actions = _db(
        """
        SELECT a.*, f.name AS factory_name, l.name AS line_name,
               wi.style_number, wi.external_ref
        FROM production_workspace_recovery_actions a
        LEFT JOIN production_workspace_factories f ON f.id=a.factory_id
        LEFT JOIN production_workspace_lines l ON l.id=a.line_id
        JOIN production_workspace_work_items wi ON wi.id=a.work_item_id
        JOIN production_workspace_plan_versions p ON p.id=a.plan_version_id
        WHERE (%s <> 'production' OR a.owner_user_id=%s OR p.owner_user_id=%s)
        ORDER BY a.priority DESC, a.due_date NULLS LAST, a.id DESC
        """,
        [actor["role"], actor["user_id"], actor["user_id"]],
        fetch=True,
    )
    return {
        "schema_version": "1",
        "as_of": date.today().isoformat(),
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "queue": _rows(candidates),
        "actions": _rows(actions),
        "priority_contract": (
            "Priority is explainable urgency from approved due date, remaining "
            "work, current stage/WIP, saved capacity/load, quality/rework and "
            "downtime. It is not a worker score."
        ),
        "freshness": {
            "plan_inputs": "approved plan records",
            "execution": max(
                (r.get("last_output_date") for r in candidates if r.get("last_output_date")),
                default=None,
            ),
            "events": max(
                (r.get("last_event_date") for r in candidates if r.get("last_event_date")),
                default=None,
            ),
        },
    }


def _action_create(request, body):
    denied = _require(request, ACTION_ROLES, "Recovery action changes")
    if denied:
        return denied
    actor = _actor(request)
    reason = _reason(body)
    if not reason:
        return _error("reason is required for every recovery action")
    action_key = str(body.get("action_key") or "").strip()
    title = str(body.get("title") or "").strip()
    if not action_key or not title:
        return _error("action_key and title are required")
    try:
        plan_id = int(body.get("plan_version_id"))
        work_item_id = int(body.get("work_item_id"))
    except (TypeError, ValueError):
        return _error("plan_version_id and work_item_id must be numeric")
    status = str(body.get("status") or "open").lower()
    if status not in ACTION_STATUSES:
        return _error("Invalid recovery action status")
    due_date = _day(body.get("due_date"), None) if body.get("due_date") else None
    rationale = body.get("rationale") if isinstance(body.get("rationale"), list) else []
    snapshot = body.get("source_snapshot") if isinstance(body.get("source_snapshot"), dict) else {}
    try:
        with _tx() as cur:
            cur.execute(
                """
                SELECT p.*, wi.production_order_ref, wi.external_ref, wi.style_number
                FROM production_workspace_plan_versions p
                JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
                WHERE p.id=%s AND p.work_item_id=%s AND p.status IN ('approved','frozen')
                FOR SHARE
                """,
                (plan_id, work_item_id),
            )
            plan = cur.fetchone()
            if not plan:
                return _error("Recovery actions must link to an approved plan and work item.", 409)
            if actor["role"] == "production" and plan.get("owner_user_id") != actor["user_id"]:
                return _error("Production users can only create actions for their plan context.", 403)
            cur.execute(
                """
                INSERT INTO production_workspace_recovery_actions
                  (action_key,plan_version_id,work_item_id,production_order_ref,
                   factory_id,line_id,title,rationale,priority,source_snapshot,
                   owner_user_id,due_date,status,notes,created_by,updated_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s,%s,%s,%s,%s,%s)
                RETURNING *
                """,
                (
                    action_key, plan_id, work_item_id, plan.get("production_order_ref"),
                    plan.get("factory_id"), plan.get("line_id"), title,
                    json.dumps(_jsonable(rationale)),
                    max(0, min(100, int(body.get("priority") or 50))),
                    json.dumps(_jsonable(snapshot)), body.get("owner_user_id"),
                    due_date, status, body.get("notes"), actor["user_id"],
                    actor["user_id"],
                ),
            )
            row = cur.fetchone()
            audit = _audit(
                cur, row["id"], "created", actor, reason, after=row,
                request_id=_request_id(request),
            )
        return {"record": _jsonable(row), "audit_event_id": audit["id"]}
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            return _error("That recovery action key already exists.", 409)
        log.exception("Recovery action create failed")
        return _error("Could not create recovery action", 500)


def _action_update(action_id, request, body):
    denied = _require(request, ACTION_ROLES, "Recovery action changes")
    if denied:
        return denied
    actor = _actor(request)
    reason = _reason(body)
    try:
        expected = int(body.get("expected_version"))
    except (TypeError, ValueError):
        expected = None
    if expected is None or not reason:
        return _error("expected_version and reason are required")
    status = str(body.get("status") or "").lower()
    if status not in ACTION_STATUSES:
        return _error("A valid recovery action status is required")
    due_date = _day(body.get("due_date"), None) if body.get("due_date") else None
    try:
        with _tx() as cur:
            cur.execute(
                """
                SELECT a.*, p.owner_user_id AS plan_owner_user_id
                FROM production_workspace_recovery_actions a
                JOIN production_workspace_plan_versions p ON p.id=a.plan_version_id
                WHERE a.id=%s FOR UPDATE
                """,
                (action_id,),
            )
            before = cur.fetchone()
            if not before:
                return _error("Recovery action not found", 404)
            if actor["role"] == "production" and (
                before.get("owner_user_id") != actor["user_id"]
                and before.get("plan_owner_user_id") != actor["user_id"]
            ):
                return _error("This recovery action is outside your coaching context.", 403)
            if expected != int(before["version_token"]):
                return _error(
                    "This recovery action changed since you opened it. Refresh and retry.",
                    409, code="stale_recovery_action",
                )
            cur.execute(
                """
                UPDATE production_workspace_recovery_actions
                SET status=%s, owner_user_id=COALESCE(%s,owner_user_id),
                    due_date=%s, notes=COALESCE(%s,notes),
                    version_token=version_token+1, updated_by=%s, updated_at=now()
                WHERE id=%s RETURNING *
                """,
                (
                    status, body.get("owner_user_id"), due_date, body.get("notes"),
                    actor["user_id"], action_id,
                ),
            )
            after = cur.fetchone()
            audit = _audit(
                cur, action_id, "updated", actor, reason, before=before,
                after=after, request_id=_request_id(request),
            )
        return {"record": _jsonable(after), "audit_event_id": audit["id"]}
    except Exception:
        log.exception("Recovery action update failed")
        return _error("Could not update recovery action", 500)


def _action_audit(action_id, request):
    denied = _require(request, READ_ROLES, "Recovery action audit viewing")
    if denied:
        return denied
    actor = _actor(request)
    scope = _db(
        """
        SELECT a.owner_user_id, p.owner_user_id AS plan_owner_user_id
        FROM production_workspace_recovery_actions a
        JOIN production_workspace_plan_versions p ON p.id=a.plan_version_id
        WHERE a.id=%s
        """,
        [action_id], fetch=True,
    )
    if not scope:
        return _error("Recovery action not found", 404)
    action = scope[0]
    if actor["role"] == "production" and (
        action.get("owner_user_id") != actor["user_id"]
        and action.get("plan_owner_user_id") != actor["user_id"]
    ):
        return _error("This recovery action is outside your coaching context.", 403)
    rows = _db(
        """
        SELECT id, entity_type, entity_id, action, actor_user_id, actor_name,
               reason, before_json, after_json, occurred_at, request_id
        FROM production_workspace_audit_events
        WHERE entity_type='recovery_action' AND entity_id=%s
        ORDER BY occurred_at DESC, id DESC
        """,
        [str(action_id)],
        fetch=True,
    )
    return {"action_id": action_id, "audit": _rows(rows)}


def _productivity_endpoint(request: Request, date_from: str = None,
                           date_to: str = None, view: str = "worker",
                           factory_id: str = "", line_id: str = ""):
    return _productivity(request, date_from, date_to, view, factory_id, line_id)


def _recovery_endpoint(request: Request, date_from: str = None,
                       date_to: str = None, factory_id: str = "",
                       line_id: str = ""):
    return _recovery(request, date_from, date_to, factory_id, line_id)


def _action_create_endpoint(request: Request, body: dict = Body(default={})):
    return _action_create(request, body)


def _action_update_endpoint(action_id: int, request: Request,
                            body: dict = Body(default={})):
    return _action_update(action_id, request, body)


def _action_audit_endpoint(action_id: int, request: Request):
    return _action_audit(action_id, request)


def register_production_insights_routes(app, api_module):
    global _API
    _API = api_module
    app.add_api_route("/api/production-workspace/productivity",
                      _productivity_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/recovery",
                      _recovery_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/recovery/actions",
                      _action_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/recovery/actions/{action_id}",
                      _action_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/recovery/actions/{action_id}/audit",
                      _action_audit_endpoint, methods=["GET"])