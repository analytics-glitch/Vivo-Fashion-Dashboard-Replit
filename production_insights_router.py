"""Productivity and delivery-recovery views for the Production Workspace.

This module is deliberately a read/action layer over the approved planning and
execution ledgers.  It never writes the legacy tracker tables and it never
turns a missing denominator into a zero or a ranking.
"""

import json
import logging
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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

# One place for the thresholds exposed by the Command Centre.  They are part
# of the response contract so a stand-up can see *why* a commitment is marked
# for attention instead of relying on a hidden UI-only rule.
COMMAND_CENTRE_THRESHOLDS = {
    "tracker_stale_seconds": 2 * 60 * 60,
    "source_stale_hours": 24,
    "due_soon_days": 14,
    "urgent_due_days": 7,
    "early_stages": ("buying_order", "cutting", "waiting_sewing", "sewing"),
    "high_load_pct": 85,
    "overloaded_pct": 100,
}

_COMMAND_REQUIRED_SECTIONS = (
    "plan_actual",
    "productivity",
    "delivery",
    "wip",
)
_COMMAND_UNHEALTHY_STATES = {"error", "unavailable", "stale", "incomplete", "missing", "unknown"}


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


def _nullable_sum(rows, field, *, when=None):
    """Sum only when every included source row carries the measure.

    A command metric is a decision aid, not a best-effort estimate.  Returning
    ``None`` makes partial source capture visible to the caller; returning zero
    would falsely imply that the factory produced nothing or had no quality
    events.
    """
    selected = [row for row in rows if when is None or when(row)]
    if not selected or any(row.get(field) is None for row in selected):
        return None
    return sum(_number(row.get(field)) for row in selected)


def _freshness_state(timestamp, *, stale_hours=None, now=None):
    """Return a timestamp-precise source health state.

    A calendar date says which operating day a record belongs to, not when the
    source was refreshed.  Date-only values therefore remain explicitly
    unknown instead of being silently rounded to midnight and presented as an
    hourly freshness calculation.
    """
    if not timestamp:
        return {"state": "missing", "as_of": None}
    stale_hours = stale_hours or COMMAND_CENTRE_THRESHOLDS["source_stale_hours"]
    try:
        if isinstance(timestamp, datetime):
            value = timestamp
        elif isinstance(timestamp, date):
            return {
                "state": "unknown",
                "as_of": _jsonable(timestamp),
                "detail": "A timestamp is required to calculate source freshness.",
            }
        else:
            raw = str(timestamp).strip()
            if "T" not in raw and " " not in raw:
                return {
                    "state": "unknown",
                    "as_of": _jsonable(timestamp),
                    "detail": "A timestamp is required to calculate source freshness.",
                }
            value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        age_seconds = max(0, (current.astimezone(timezone.utc) - value.astimezone(timezone.utc)).total_seconds())
        return {
            "state": "stale" if age_seconds > stale_hours * 60 * 60 else "fresh",
            "as_of": _jsonable(timestamp),
            "age_seconds": round(age_seconds),
            "age_hours": round(age_seconds / 3600, 2),
        }
    except (TypeError, ValueError):
        return {"state": "unknown", "as_of": _jsonable(timestamp)}


def _command_source_state(timestamp, *, query_failed=False, empty=False,
                          stale_hours=None, detail=None, refresh_status=None):
    """Build source health without confusing successful empty activity with loss."""
    if query_failed:
        state = {
            "state": "error",
            "as_of": None,
            "detail": detail or "This source could not be read.",
        }
    elif empty:
        state = {
            "state": "empty",
            "as_of": None,
            "detail": detail or "No activity was recorded in this scope.",
        }
    else:
        state = _freshness_state(timestamp, stale_hours=stale_hours)
        if detail:
            state["detail"] = detail
    if refresh_status:
        state["refresh_status"] = refresh_status
    return state


def _command_completeness(sections, source_freshness):
    """Summarise required section and source health for stand-up decisions."""
    issues = []
    for key in _COMMAND_REQUIRED_SECTIONS:
        section = sections.get(key, {})
        state = section.get("state")
        if state in _COMMAND_UNHEALTHY_STATES:
            issues.append({
                "key": key,
                "state": state,
                "message": section.get("message") or f"{key.replace('_', ' ')} is {state}.",
            })
    for key, source in source_freshness.items():
        state = source.get("state")
        if state in _COMMAND_UNHEALTHY_STATES:
            issues.append({
                "key": key,
                "state": state,
                "message": source.get("detail") or f"{key.replace('_', ' ')} is {state}.",
            })
    return {
        "state": "partial" if issues else "complete",
        "missing": [issue["key"] for issue in issues],
        "issues": issues,
        "message": (
            "One or more required decision sources are failed, unavailable, stale, or incomplete."
            if issues else
            "All required decision sources are available and current."
        ),
    }


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
      AND (NULLIF(%s,'') IS NULL OR p.shift_id=NULLIF(%s,'')::bigint)
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
            MAX(COALESCE(pushed_at, synced_at)) AS attendance_fresh_at
    FROM vivo_attendance
    WHERE attendance_date BETWEEN %s AND %s
    GROUP BY lower(trim(employee_name))
)
SELECT sp.id AS plan_version_id, sp.version_no, sp.status,
       sp.planned_start, sp.planned_end, sp.planned_qty,
       sp.external_ref, sp.style_number, sp.description,
       sp.production_order_ref, sp.stage_key AS current_stage,
       sp.factory_id, sp.factory_name, sp.line_id, sp.shift_id,
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


def _productivity_rows(start, end, actor, factory_id="", line_id="", shift_id=""):
    params = [
        end, start, str(factory_id or ""), str(factory_id or ""),
        str(line_id or ""), str(line_id or ""),
        str(shift_id or ""), str(shift_id or ""),
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
            MAX(COALESCE(pushed_at, synced_at)) AS attendance_fresh_at
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
        fallback_params = params[:14] + params[16:]
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
                  factory_id="", line_id="", shift_id=""):
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
    raw = _productivity_rows(start, end, actor, factory_id, line_id, shift_id)
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
       l.name AS line_name, p.factory_id, p.line_id, p.shift_id, p.status,
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
  AND (NULLIF(%s,'') IS NULL OR p.shift_id=NULLIF(%s,'')::bigint)
  AND (NULLIF(%s,'') IS NULL OR p.status=NULLIF(%s,''))
ORDER BY p.planned_end, f.name, l.name, wi.style_number
"""


def _recovery_candidates(start, end, factory_id="", line_id="", shift_id="", plan_status=""):
    params = [end, start, end, end, start, str(factory_id or ""), str(factory_id or ""),
              str(line_id or ""), str(line_id or ""), str(shift_id or ""), str(shift_id or ""),
              str(plan_status or ""), str(plan_status or "")]
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


def _recovery(request, date_from=None, date_to=None, factory_id="", line_id="", shift_id=""):
    denied = _require(request, READ_ROLES, "Delivery recovery viewing")
    if denied:
        return denied
    actor = _actor(request)
    end = _day(date_to, date.today())
    start = _day(date_from, end - timedelta(days=29))
    if start > end:
        return _error("date_from must be on or before date_to")
    candidates = _recovery_candidates(start, end, factory_id, line_id, shift_id)
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
          AND (NULLIF(%s,'') IS NULL OR a.factory_id=NULLIF(%s,'')::bigint)
          AND (NULLIF(%s,'') IS NULL OR a.line_id=NULLIF(%s,'')::bigint)
          AND (NULLIF(%s,'') IS NULL OR p.shift_id=NULLIF(%s,'')::bigint)
        ORDER BY a.priority DESC, a.due_date NULLS LAST, a.id DESC
        """,
        [
            actor["role"], actor["user_id"], actor["user_id"],
            factory_id, factory_id, line_id, line_id, shift_id, shift_id,
        ],
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


def _command_scope(request, *, stage="", factory_id="", line_id="", shift_id="", owner_user_id="",
                   plan_status="", delivery_risk="", search=""):
    """Build the Command Centre's explicit production-only scope.

    Sales filters deliberately do not enter this function: country, POS,
    channel, currency and comparison periods have no verified mapping to the
    production tracker or workspace ledgers.
    """
    actor = _actor(request)
    privacy_context = actor["role"] in QUALITY_ROLES | PRODUCT_ROLES
    return {
        "actor": actor,
        "stage": str(stage or "").strip(),
        "factory_id": str(factory_id or "").strip(),
        "line_id": str(line_id or "").strip(),
        "shift_id": str(shift_id or "").strip(),
        # Quality and Product Development can investigate plan and quality
        # evidence, but must not browse production staff identities. Ignore an
        # owner query supplied in a copied URL instead of exposing a side
        # channel through an owner-filtered response.
        "owner_user_id": "" if privacy_context else str(owner_user_id or "").strip(),
        "plan_status": str(plan_status or "").strip().lower(),
        "delivery_risk": str(delivery_risk or "").strip().lower(),
        "search": str(search or "").strip(),
        "owner_filter_allowed": not privacy_context,
        "privacy_context": privacy_context,
        "operational_scope": (
            "owned_or_assigned" if actor["role"] == "production" else "role_wide"
        ),
        "unsupported_sales_filters": [
            "country", "channel", "POS", "currency", "comparison period",
        ],
    }


def _command_plan_rows(start, end, scope):
    """Return approved-plan facts at plan grain without inventing joins.

    Every measure is isolated in a correlated aggregate.  Joining assignments,
    capacity inputs and execution rows directly would fan out quantities and
    create deceptively precise plan/actual or quality numbers.
    """
    return _db(
        """
        SELECT p.id AS plan_version_id,p.status,p.planned_start,p.planned_end,p.planned_qty,
               p.owner_user_id,p.updated_at AS plan_fresh_at,
               wi.id AS work_item_id,wi.external_ref,wi.style_number,
               wi.production_order_ref,wi.stage_key,
               f.id AS factory_id,f.name AS factory_name,
               l.id AS line_id,l.name AS line_name,
               sh.id AS shift_id,sh.name AS shift_name,
               (SELECT SUM(ci.available_minutes)
                  FROM production_workspace_capacity_inputs ci
                 WHERE ci.plan_version_id=p.id) AS available_minutes,
               (SELECT SUM(ci.required_minutes)
                  FROM production_workspace_capacity_inputs ci
                 WHERE ci.plan_version_id=p.id) AS required_minutes,
               (SELECT SUM(o.good_qty)
                  FROM production_workspace_execution_output o
                 WHERE o.plan_version_id=p.id AND o.capture_date BETWEEN %s AND %s) AS good_qty,
               (SELECT SUM(o.reject_qty)
                  FROM production_workspace_execution_output o
                 WHERE o.plan_version_id=p.id AND o.capture_date BETWEEN %s AND %s) AS reject_qty,
               (SELECT SUM(o.rework_qty)
                  FROM production_workspace_execution_output o
                 WHERE o.plan_version_id=p.id AND o.capture_date BETWEEN %s AND %s) AS rework_qty,
               (SELECT MAX(o.created_at)
                  FROM production_workspace_execution_output o
                 WHERE o.plan_version_id=p.id AND o.capture_date BETWEEN %s AND %s) AS output_fresh_at,
               (SELECT COALESCE(SUM(e.quantity) FILTER (WHERE e.event_type='qc_defect'),0)
                  FROM production_workspace_execution_events e
                 WHERE e.plan_version_id=p.id AND e.event_date BETWEEN %s AND %s) AS qc_defect_qty,
               (SELECT COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.event_type='downtime'),0)
                  FROM production_workspace_execution_events e
                 WHERE e.plan_version_id=p.id AND e.event_date BETWEEN %s AND %s) AS downtime_minutes,
               (SELECT MAX(e.created_at)
                  FROM production_workspace_execution_events e
                 WHERE e.plan_version_id=p.id AND e.event_date BETWEEN %s AND %s) AS event_fresh_at,
               (SELECT COUNT(*) FILTER (WHERE g.status NOT IN ('passed','waived'))
                  FROM production_workspace_readiness_gates g
                 WHERE g.plan_version_id=p.id) AS incomplete_gate_count
          FROM production_workspace_plan_versions p
          JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
          JOIN production_workspace_factories f ON f.id=p.factory_id
          LEFT JOIN production_workspace_lines l ON l.id=p.line_id
          LEFT JOIN production_workspace_shifts sh ON sh.id=p.shift_id
         WHERE p.status IN ('approved','frozen')
           -- A selected-period target must be fully source-backed. Do not
           -- compare a whole multi-week commitment with one day's output.
           AND p.planned_start >= %s AND p.planned_end <= %s
           AND (NULLIF(%s,'') IS NULL OR p.factory_id=NULLIF(%s,'')::bigint)
           AND (NULLIF(%s,'') IS NULL OR p.line_id=NULLIF(%s,'')::bigint)
           AND (NULLIF(%s,'') IS NULL OR p.shift_id=NULLIF(%s,'')::bigint)
           AND (NULLIF(%s,'') IS NULL OR p.owner_user_id=NULLIF(%s,''))
           AND (NULLIF(%s,'') IS NULL OR p.status=NULLIF(%s,''))
           AND (NULLIF(%s,'') IS NULL OR wi.stage_key=NULLIF(%s,''))
           AND (NULLIF(%s,'') IS NULL OR
                concat_ws(' ',wi.external_ref,wi.style_number,wi.production_order_ref,
                          f.name,l.name,
                          CASE WHEN %s THEN NULL ELSE p.owner_user_id END) ILIKE '%%' || %s || '%%')
           AND (
                %s <> 'production'
                OR p.owner_user_id=%s
                OR EXISTS (
                    SELECT 1
                    FROM production_workspace_assignments scoped_assignment
                    JOIN production_workspace_operators scoped_operator
                      ON scoped_operator.id=scoped_assignment.operator_id
                   WHERE scoped_assignment.plan_version_id=p.id
                     AND scoped_operator.user_id=%s
                )
           )
         ORDER BY p.planned_end,f.name,l.name,wi.style_number
        """,
        [
            start, end, start, end, start, end, start, end, start, end,
            start, end, start, end,
            start, end,
            scope["factory_id"], scope["factory_id"],
            scope["line_id"], scope["line_id"],
            scope["shift_id"], scope["shift_id"],
            scope["owner_user_id"], scope["owner_user_id"],
            scope["plan_status"], scope["plan_status"],
            scope["stage"], scope["stage"],
            scope["search"], scope.get("privacy_context", False), scope["search"],
            scope["actor"]["role"], scope["actor"]["user_id"], scope["actor"]["user_id"],
        ],
        fetch=True,
    )


def _command_public_rows(rows):
    """Return the Command Centre's non-personal plan/quality context.

    Quality and Product Development need operational evidence, not staff
    identities. Do this at the response boundary so a new UI field cannot
    accidentally turn a redacted command response back into a personnel view.
    """
    hidden = {"owner_user_id"}
    return [
        {key: value for key, value in dict(row).items() if key not in hidden}
        for row in rows
    ]


def _command_line_rows(plans, productivity, covered_plan_ids=None):
    """Produce one honest row per factory/line without shift misattribution."""
    covered_plan_ids = set(covered_plan_ids or [])
    rows = {}
    for raw in plans:
        plan = dict(raw)
        key = (plan.get("factory_id"), plan.get("line_id"))
        row = rows.setdefault(key, {
            "factory_id": plan.get("factory_id"),
            "factory_name": plan.get("factory_name") or "Unassigned factory",
            "line_id": plan.get("line_id"),
            "line_name": plan.get("line_name") or "Unassigned line",
            "shifts": set(),
            "plans": [],
        })
        row["plans"].append(plan)
    productivity_by_line = {
        (r.get("factory_id"), r.get("line_id")): r for r in productivity or []
    }
    out = []
    for row in rows.values():
        plans_for_line = row.pop("plans")
        shifts = {(plan.get("shift_id"), plan.get("shift_name")) for plan in plans_for_line}
        row["shift_id"] = next(iter(shifts))[0] if len(shifts) == 1 else None
        row["shift_name"] = next(iter(shifts))[1] if len(shifts) == 1 else "All shifts"
        row.pop("shifts", None)
        target = _nullable_sum(plans_for_line, "planned_qty")
        good = _nullable_sum(plans_for_line, "good_qty")
        reject = _nullable_sum(plans_for_line, "reject_qty")
        rework = _nullable_sum(plans_for_line, "rework_qty")
        capacity = _nullable_sum(plans_for_line, "available_minutes")
        required = _nullable_sum(plans_for_line, "required_minutes")
        actual = (good + reject + rework
                  if good is not None and reject is not None and rework is not None
                  else None)
        quality_total = actual + _nullable_sum(plans_for_line, "qc_defect_qty") \
            if actual is not None and _nullable_sum(plans_for_line, "qc_defect_qty") is not None else None
        effort = productivity_by_line.get((row["factory_id"], row["line_id"]), {})
        efficiency_available = (
            all(plan.get("plan_version_id") in covered_plan_ids for plan in plans_for_line)
            and effort.get("metric_state") == "available"
        )
        row.update({
            "plan_count": len(plans_for_line),
            "owner_count": len({p.get("owner_user_id") for p in plans_for_line if p.get("owner_user_id")}),
            "target_qty": target,
            "good_qty": good,
            "reject_qty": reject,
            "rework_qty": rework,
            "actual_qty": actual,
            "available_minutes": capacity,
            "required_minutes": required,
            "load_pct": required / capacity * 100 if required is not None and capacity and capacity > 0 else None,
            "quality_total": quality_total,
            "efficiency_pct": effort.get("efficiency_pct") if efficiency_available else None,
            "metric_state": "available" if actual is not None else "incomplete",
            "unavailable_reason": (
                None if actual is not None
                else "One or more approved plans have no validated execution capture in this period."
            ),
        })
        out.append(row)
    return sorted(out, key=lambda r: (str(r["factory_name"]), str(r["line_name"]), str(r["shift_name"])))


def _command_centre(request, date_from=None, date_to=None, stage="", factory_id="", line_id="",
                    shift_id="", owner_user_id="", plan_status="", delivery_risk="",
                    search=""):
    """A read-only, source-labelled stand-up contract for the production hub."""
    denied = _require(request, READ_ROLES, "Production Command Centre viewing")
    if denied:
        return denied
    end = _day(date_to, date.today())
    start = _day(date_from, end - timedelta(days=29))
    if start > end:
        return _error("date_from must be on or before date_to")
    scope = _command_scope(
        request, stage=stage, factory_id=factory_id, line_id=line_id, shift_id=shift_id,
        owner_user_id=owner_user_id, plan_status=plan_status,
        delivery_risk=delivery_risk, search=search,
    )
    sections, errors = {}, {}
    planned_ids = set()
    plans, productivity, productivity_raw, productivity_metrics, recovery, stages, tracker_status = [], [], [], [], [], [], {}
    plan_query_succeeded = productivity_query_succeeded = recovery_query_succeeded = False
    tracker_query_succeeded = heartbeat_query_failed = False
    try:
        plans = [dict(row) for row in _command_plan_rows(start, end, scope)]
        planned_ids = {
            plan.get("plan_version_id") for plan in plans if plan.get("plan_version_id") is not None
        }
        plan_query_succeeded = True
        sections["plan_actual"] = {"state": "ready" if plans else "empty", "rows": len(plans)}
    except Exception as exc:
        log.exception("Command Centre plan facts failed")
        errors["plan_actual"] = "Approved plan facts are unavailable."
        sections["plan_actual"] = {"state": "error", "message": errors["plan_actual"]}
    try:
        productivity_raw = _productivity_rows(
            start, end, scope["actor"], scope["factory_id"], scope["line_id"], scope["shift_id"],
        )
        # The productivity query's ordinary date semantics include plans that
        # overlap the window. Command Centre compares whole commitments only,
        # so its execution/attendance evidence must be restricted to exactly
        # that fully-contained approved-plan universe.
        productivity_raw = [
            row for row in productivity_raw if row.get("plan_version_id") in planned_ids
        ]
        productivity_metrics = [_metric_row(row) for row in productivity_raw]
        # Attendance is per person/day, not per operation. worker=True makes
        # the line aggregate deduplicate it across an operator's assignments.
        productivity = _aggregate(
            productivity_metrics, ("factory_id", "line_id"), "line_name", worker=True,
        )
        productivity_query_succeeded = True
        sections["productivity"] = {"state": "ready" if productivity else "empty", "rows": len(productivity)}
    except Exception:
        log.exception("Command Centre productivity facts failed")
        errors["productivity"] = "Attendance, approved SAM, or execution evidence is unavailable."
        sections["productivity"] = {"state": "error", "message": errors["productivity"]}
    try:
        recovery = _recovery_candidates(
            start, end, scope["factory_id"], scope["line_id"],
            scope["shift_id"], scope["plan_status"],
        )
        if scope["actor"]["role"] == "production":
            # Command Centre plan scope includes plans owned by the production
            # user OR plans with an operator assignment for them. Apply that
            # exact scope to recovery rather than leaking every commitment
            # through this separate evidence source.
            recovery = [
                row for row in recovery
                if row.get("plan_version_id") in planned_ids
            ]
        if scope["delivery_risk"]:
            recovery = [r for r in recovery if r.get("priority_band") == scope["delivery_risk"]]
        if scope["owner_user_id"]:
            recovery = [r for r in recovery if str(r.get("owner_user_id") or "") == scope["owner_user_id"]]
        if scope["search"]:
            needle = scope["search"].lower()
            recovery = [r for r in recovery if needle in " ".join(
                str(r.get(key) or "") for key in ("external_ref", "style_number", "production_order_ref", "factory_name", "line_name")
            ).lower()]
        if scope["stage"]:
            recovery = [r for r in recovery if str(r.get("current_stage") or "") == scope["stage"]]
        recovery_query_succeeded = True
        sections["delivery"] = {"state": "ready" if recovery else "empty", "rows": len(recovery)}
    except Exception:
        log.exception("Command Centre recovery facts failed")
        errors["delivery"] = "Approved commitments and recovery evidence are unavailable."
        sections["delivery"] = {"state": "error", "message": errors["delivery"]}
    # The tracker is deliberately global only.  There is no verified mapping
    # between legacy tracker balances and Workspace factory/line/shift keys.
    tracker_is_scoped = (
        scope["actor"]["role"] == "production"
        or any(scope[key] for key in ("factory_id", "line_id", "shift_id", "owner_user_id"))
    )
    if tracker_is_scoped:
        wip_message = (
            "Legacy tracker WIP has no approved owner or assignment mapping, so "
            "it is withheld from a production user's operational scope."
            if scope["actor"]["role"] == "production" else
            "Legacy tracker WIP has no approved factory, line, shift, or owner mapping for this scope."
        )
        sections["wip"] = {
            "state": "unavailable",
            "message": wip_message,
        }
    else:
        try:
            stages = [dict(row) for row in _API._production_flow_stages()[0]]
            if scope["stage"]:
                stages = [row for row in stages if row.get("stage_key") == scope["stage"]]
            tracker_query_succeeded = True
            sections["wip"] = {"state": "ready" if stages else "empty", "rows": len(stages)}
        except Exception:
            log.exception("Command Centre tracker facts failed")
            errors["wip"] = "Odoo tracker WIP is unavailable."
            sections["wip"] = {"state": "error", "message": errors["wip"]}
    try:
        heartbeat = _db(
            "SELECT last_run_at,last_status,orders_synced,"
            "EXTRACT(EPOCH FROM (now()-last_run_at)) AS age_seconds "
            "FROM production_sync_heartbeat WHERE id=1",
            fetch=True,
        )
        tracker_status = dict(heartbeat[0]) if heartbeat else {}
    except Exception:
        heartbeat_query_failed = True
        log.exception("Command Centre tracker heartbeat failed")
        tracker_status = {}

    captured_productivity_plan_ids = {
        row.get("plan_version_id") for row in productivity_metrics if row.get("plan_version_id") is not None
    }
    line_rows = _command_line_rows(plans, productivity, captured_productivity_plan_ids)
    target = _nullable_sum(plans, "planned_qty")
    good = _nullable_sum(plans, "good_qty")
    reject = _nullable_sum(plans, "reject_qty")
    rework = _nullable_sum(plans, "rework_qty")
    actual = good + reject + rework if None not in (good, reject, rework) else None
    available_minutes = _nullable_sum(plans, "available_minutes")
    required_minutes = _nullable_sum(plans, "required_minutes")
    qc_defects = _nullable_sum(plans, "qc_defect_qty")
    downtime = _nullable_sum(plans, "downtime_minutes")
    operator_line_scopes = {}
    for row in productivity_metrics:
        operator_id = row.get("operator_id")
        if operator_id is not None:
            operator_line_scopes.setdefault(operator_id, set()).add(
                (row.get("factory_id"), row.get("line_id"))
            )
    efficiency_evidence_complete = (
        bool(planned_ids)
        and planned_ids == captured_productivity_plan_ids
        and all(row.get("efficiency_pct") is not None for row in productivity)
        and all(len(scopes) == 1 for scopes in operator_line_scopes.values())
    )
    efficiency = (
        sum(_number(row.get("earned_minutes")) for row in productivity)
        / sum(_number(row.get("attended_minutes")) for row in productivity) * 100
        if efficiency_evidence_complete and sum(_number(row.get("attended_minutes")) for row in productivity) > 0
        else None
    )
    if plan_query_succeeded and not plans:
        # A successful selected scope with no commitments is a genuine zero,
        # not a missing plan source.
        target = actual = qc_defects = downtime = 0
    wip_rows = [row for row in stages if not row.get("is_terminal")]
    wip_units = sum(_number(row.get("units")) for row in wip_rows) if tracker_query_succeeded else None
    active_orders = sum(_number(row.get("orders")) for row in wip_rows) if tracker_query_succeeded else None
    source_freshness = {
        "odoo_tracker": _command_source_state(
            tracker_status.get("last_run_at"),
            query_failed=heartbeat_query_failed,
            empty=not tracker_query_succeeded and not heartbeat_query_failed,
            stale_hours=COMMAND_CENTRE_THRESHOLDS["tracker_stale_seconds"] / 3600,
            detail="Verified Odoo production tracker balances.",
            refresh_status=tracker_status.get("last_status") or "not recorded",
        ),
        "approved_plan": _command_source_state(
            max((p.get("plan_fresh_at") for p in plans if p.get("plan_fresh_at")), default=None),
            query_failed=not plan_query_succeeded,
            empty=plan_query_succeeded and not plans,
            detail="Approved-plan snapshot.",
            refresh_status="approved-plan snapshot",
        ),
        "execution_capture": _command_source_state(
            max((p.get("output_fresh_at") for p in plans if p.get("output_fresh_at")), default=None),
            query_failed=not productivity_query_succeeded,
            empty=plan_query_succeeded and not plans,
            detail="Validated execution capture ledger.",
            refresh_status="validated capture ledger",
        ),
        "quality_and_downtime": _command_source_state(
            max((p.get("event_fresh_at") for p in plans if p.get("event_fresh_at")), default=None),
            query_failed=not plan_query_succeeded,
            # No defect/downtime events is a valid zero-activity result.
            empty=plan_query_succeeded and not any(p.get("event_fresh_at") for p in plans),
            detail="Validated quality and downtime event ledger.",
            refresh_status="validated event ledger",
        ),
        "attendance_and_sam": _command_source_state(
            max((row.get("attendance_fresh_at") for row in productivity_raw if row.get("attendance_fresh_at")), default=None),
            query_failed=not productivity_query_succeeded,
            empty=plan_query_succeeded and not plans,
            detail="Complete attendance plus approved operation SAM are required before efficiency is available.",
            refresh_status="denominator validation",
        ),
    }
    if tracker_status.get("last_status", "").lower() in {"error", "failed", "failure", "timeout"}:
        source_freshness["odoo_tracker"]["state"] = "error"
        source_freshness["odoo_tracker"]["detail"] = "The latest Odoo tracker refresh failed."
    if sections.get("plan_actual", {}).get("state") == "ready" and (
        actual is None or available_minutes is None or required_minutes is None
    ):
        sections["plan_actual"].update({
            "state": "incomplete",
            "message": "Approved-plan, execution, or capacity evidence is incomplete for this scope.",
        })
    if sections.get("productivity", {}).get("state") == "ready" and efficiency is None:
        sections["productivity"].update({
            "state": "incomplete",
            "message": "Execution, attendance, or approved SAM evidence is incomplete for this scope.",
        })
    for section_key, source_keys in {
        "plan_actual": ("approved_plan", "execution_capture"),
        "productivity": ("execution_capture", "attendance_and_sam"),
        "delivery": ("approved_plan", "execution_capture", "quality_and_downtime"),
        "wip": ("odoo_tracker",),
    }.items():
        section = sections.get(section_key, {})
        if section.get("state") in {"empty", "error", "unavailable", "incomplete"}:
            continue
        bad_source = next(
            (source_freshness[key] for key in source_keys
             if source_freshness[key].get("state") in _COMMAND_UNHEALTHY_STATES),
            None,
        )
        if bad_source:
            sections[section_key] = {
                **section,
                "state": bad_source["state"],
                "message": bad_source.get("detail") or "A required source is not healthy.",
            }
    options = {
        "factories": sorted({(p.get("factory_id"), p.get("factory_name")) for p in plans if p.get("factory_id")}, key=lambda x: str(x[1])),
        "lines": sorted({(p.get("line_id"), p.get("line_name")) for p in plans if p.get("line_id")}, key=lambda x: str(x[1])),
        "shifts": sorted({(p.get("shift_id"), p.get("shift_name")) for p in plans if p.get("shift_id")}, key=lambda x: str(x[1])),
        "owners": [] if scope["privacy_context"] else sorted({p.get("owner_user_id") for p in plans if p.get("owner_user_id")}),
        "stages": sorted({(row.get("stage_key"), row.get("stage_name")) for row in stages if row.get("stage_key")}, key=lambda x: str(x[1])),
    }
    response_plans = _command_public_rows(plans) if scope["privacy_context"] else plans
    response_recovery = _command_public_rows(recovery) if scope["privacy_context"] else recovery
    return {
        "schema_version": "1",
        "as_of": datetime.now(ZoneInfo("Africa/Nairobi")).isoformat(),
        "timezone": "Africa/Nairobi",
        "scope": {
            **{key: value for key, value in scope.items() if key != "actor"},
            "snapshot_semantics": "Tracker WIP is a live current snapshot; approved plans and execution use the selected date range.",
        },
        "source_freshness": source_freshness,
        "sections": sections,
        "partial_errors": errors,
        "completeness": _command_completeness(sections, source_freshness),
        "thresholds": COMMAND_CENTRE_THRESHOLDS,
        "definitions": {
            "wip": "Current units from verified Odoo tracker stage balances.",
            "plan_vs_actual": "Full approved commitments wholly contained in the selected period versus validated good + reject + rework capture in that same period.",
            "capacity_load": "Saved approved capacity input required minutes ÷ available minutes.",
            "quality": "Validated execution good/reject/rework plus captured QC defects where available.",
            "productivity": "Good quantity × approved SAM ÷ complete attendance minutes; unavailable without either denominator.",
            "delivery_risk": "Explainable recovery priority from approved commitments, remaining work, live WIP, capacity, quality and downtime.",
        },
        "metrics": {
            "wip_units": wip_units,
            "active_orders": active_orders,
            "plan_qty": target,
            "actual_qty": actual,
            "good_qty": good,
            "reject_qty": reject,
            "rework_qty": rework,
            "qc_defect_qty": qc_defects,
            "available_minutes": available_minutes,
            "required_minutes": required_minutes,
            "load_pct": required_minutes / available_minutes * 100 if required_minutes is not None and available_minutes and available_minutes > 0 else None,
            "downtime_minutes": downtime,
            "efficiency_pct": efficiency,
            "delivery_risk_count": len(recovery),
            "assigned_owner_count": len({p.get("owner_user_id") for p in plans if p.get("owner_user_id")}),
        },
        "stage_wip": _rows(wip_rows),
        "line_performance": _rows(line_rows),
        "plan_vs_actual": _rows(response_plans),
        "delivery_risk": _rows(response_recovery),
        "filter_options": {
            key: [{"id": value[0], "label": value[1]} for value in values]
            if key != "owners" else [{"id": value, "label": value} for value in values]
            for key, values in options.items()
        },
    }


def _productivity_endpoint(request: Request, date_from: str = None,
                           date_to: str = None, view: str = "worker",
                           factory_id: str = "", line_id: str = "",
                           shift_id: str = ""):
    return _productivity(
        request, date_from, date_to, view, factory_id, line_id, shift_id,
    )


def _recovery_endpoint(request: Request, date_from: str = None,
                       date_to: str = None, factory_id: str = "",
                       line_id: str = "", shift_id: str = ""):
    return _recovery(request, date_from, date_to, factory_id, line_id, shift_id)


def _command_centre_endpoint(
        request: Request, date_from: str = None, date_to: str = None, stage: str = "",
        factory_id: str = "", line_id: str = "", shift_id: str = "",
        owner_user_id: str = "", plan_status: str = "", delivery_risk: str = "",
        search: str = ""):
    return _command_centre(
        request, date_from, date_to, stage, factory_id, line_id, shift_id,
        owner_user_id, plan_status, delivery_risk, search,
    )


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
    app.add_api_route("/api/production-workspace/command-centre",
                      _command_centre_endpoint, methods=["GET"])
    app.add_api_route("/api/production-workspace/recovery/actions",
                      _action_create_endpoint, methods=["POST"])
    app.add_api_route("/api/production-workspace/recovery/actions/{action_id}",
                      _action_update_endpoint, methods=["PATCH"])
    app.add_api_route("/api/production-workspace/recovery/actions/{action_id}/audit",
                      _action_audit_endpoint, methods=["GET"])