"""
Product Development Flow router — pre-production style tracker.

A fixed 9-stage kanban (Adopted → Pattern → Sampling → Review → Pattern
Transfer → CAD → Buying → Set Sample → Final Review) tracking each adopted
style with per-stage assignees, an immutable movement/decision log, aging vs
admin-editable SLA days, and analytics derived from the movement log.

Registered via register_pd_routes(app, api_pg_module) from api_pg.py.
Gate: /api/pd/* requires product_development / production / leadership / smt /
admin (enforced in clerk_auth_gate). SLA edits are admin-only (checked here).

No Odoo linkage — styles are entered manually at adoption (out of scope by
design). The movement log is append-only: there are no update/delete endpoints
for pd_movements, so the audit trail can never be rewritten.
"""

import json
import logging
from datetime import datetime, timezone

from fastapi import HTTPException, Request

log = logging.getLogger("pd_flow")

A = None  # api_pg module reference — set in register_pd_routes()

# Canonical stage catalog. sort_order drives forward-only progression; SLA days
# are only the SEED — admins edit them in pd_stages and the seed never
# overwrites an edited value (ON CONFLICT updates name/sort/role only).
_STAGES = [
    # key, name, sort, default SLA days, default owner role, terminal
    ("adopted",          "Adopted",          0, 3,  "Product Development", False),
    ("pattern",          "Pattern",          1, 5,  "Pattern Maker",       False),
    ("sampling",         "Sampling",         2, 5,  "Sample Maker",        False),
    ("review",           "Review",           3, 2,  "Reviewer",            False),
    ("pattern_transfer", "Pattern Transfer", 4, 3,  "Pattern Maker",       False),
    ("cad",              "CAD",              5, 4,  "CAD Designer",        False),
    ("buying",           "Buying",           6, 5,  "Buyer",               False),
    ("set_sample",       "Set Sample",       7, 5,  "QA Team",             False),
    ("final_review",     "Final Review",     8, 2,  "Approver",            True),
]
_STAGE_ORDER = {k: i for k, (k2, _, i, *_r) in enumerate(_STAGES) for k in [k2]}
_STAGE_KEYS = [s[0] for s in _STAGES]
_STAGE_NAMES = {s[0]: s[1] for s in _STAGES}


def _db(sql, params=None, fetch=True):
    return A._users_exec(sql, params, fetch=fetch)


def ensure_pd_tables():
    """Idempotent DDL + stage seed. Never truncates; SLA edits survive reboots."""
    _db("""
        CREATE TABLE IF NOT EXISTS pd_stages (
            stage_key    TEXT PRIMARY KEY,
            stage_name   TEXT NOT NULL,
            sort_order   INT  NOT NULL,
            sla_days     INT  NOT NULL DEFAULT 5,
            default_role TEXT,
            is_terminal  BOOLEAN NOT NULL DEFAULT FALSE
        )""", fetch=False)
    for key, name, sort, sla, role, term in _STAGES:
        _db("""
            INSERT INTO pd_stages (stage_key, stage_name, sort_order, sla_days, default_role, is_terminal)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT (stage_key) DO UPDATE
              SET stage_name = EXCLUDED.stage_name,
                  sort_order = EXCLUDED.sort_order,
                  default_role = EXCLUDED.default_role,
                  is_terminal = EXCLUDED.is_terminal
        """, (key, name, sort, sla, role, term), fetch=False)
    _db("""
        CREATE TABLE IF NOT EXISTS pd_styles (
            id               BIGSERIAL PRIMARY KEY,
            style_name       TEXT NOT NULL,
            brand            TEXT,
            category         TEXT,
            status           TEXT NOT NULL DEFAULT 'active',  -- active | completed
            outcome          TEXT,                            -- approved (on completion)
            current_stage    TEXT NOT NULL DEFAULT 'adopted' REFERENCES pd_stages(stage_key),
            stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            assignee_user_id TEXT,
            assignee_name    TEXT,
            created_by_email TEXT,
            created_by_name  TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at     TIMESTAMPTZ
        )""", fetch=False)
    _db("""
        CREATE TABLE IF NOT EXISTS pd_movements (
            id               BIGSERIAL PRIMARY KEY,
            style_id         BIGINT NOT NULL REFERENCES pd_styles(id) ON DELETE CASCADE,
            from_stage       TEXT,
            to_stage         TEXT,
            direction        TEXT NOT NULL,  -- adopt | forward | back | approve | reject
            assignee_user_id TEXT,
            assignee_name    TEXT,
            decisions        TEXT,
            moved_by_email   TEXT,
            moved_by_name    TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )""", fetch=False)
    _db("CREATE INDEX IF NOT EXISTS pd_movements_style_idx ON pd_movements (style_id, created_at)", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS style_number    TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS sub_category    TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS lifecycle_type  TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS adoption_date   DATE", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS target_order_week TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS fabric_type     TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS fabric_name     TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS sample_colour   TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS theme           TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS print_solid     TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS pattern_maker   TEXT", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS order_date      DATE", fetch=False)
    _db("ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS sample_approval_date DATE", fetch=False)


# ── helpers ───────────────────────────────────────────────────────────────────

def _actor(request: Request):
    u = getattr(request.state, "user", None) or {}
    return (u.get("email") or "unknown", u.get("name") or u.get("email") or "Unknown", (u.get("role") or "").lower())


def _stages():
    return _db("SELECT stage_key, stage_name, sort_order, sla_days, default_role, is_terminal FROM pd_stages ORDER BY sort_order") or []


def _style(style_id):
    rows = _db("SELECT * FROM pd_styles WHERE id = %s", (int(style_id),))
    if not rows:
        raise HTTPException(status_code=404, detail="Style not found")
    return rows[0]


def _resolve_assignee(assignee_user_id):
    """Look up the assignee in app_users; returns (user_id, display-name snapshot)."""
    if not assignee_user_id:
        return None, None
    rows = _db("SELECT user_id, name, email FROM app_users WHERE user_id = %s", (str(assignee_user_id),))
    if not rows:
        raise HTTPException(status_code=400, detail="Assignee not found among registered users")
    return rows[0]["user_id"], rows[0]["name"] or rows[0]["email"]


def _log_move(style_id, from_stage, to_stage, direction, assignee_id, assignee_name, decisions, by_email, by_name):
    _db("""
        INSERT INTO pd_movements (style_id, from_stage, to_stage, direction,
            assignee_user_id, assignee_name, decisions, moved_by_email, moved_by_name)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (style_id, from_stage, to_stage, direction, assignee_id, assignee_name,
          (decisions or "").strip() or None, by_email, by_name), fetch=False)


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _style_out(r, sla_map=None):
    days = None
    if r.get("stage_entered_at"):
        days = round((datetime.now(timezone.utc) - r["stage_entered_at"]).total_seconds() / 86400.0, 1)
    sla = (sla_map or {}).get(r["current_stage"])
    out = {
        "id": r["id"], "style_name": r["style_name"],
        "style_number": r.get("style_number"),
        "brand": r["brand"],
        "category": r["category"],
        "sub_category": r.get("sub_category"),
        "lifecycle_type": r.get("lifecycle_type"),
        "status": r["status"], "outcome": r.get("outcome"),
        "current_stage": r["current_stage"],
        "stage_entered_at": _iso(r.get("stage_entered_at")),
        "days_in_stage": days,
        "sla_days": sla,
        "aging": (None if days is None or sla is None
                  else "stuck" if days > sla
                  else "warning" if days > sla * 0.7
                  else "ok"),
        "assignee_user_id": r.get("assignee_user_id"),
        "assignee_name": r.get("assignee_name"),
        "pattern_maker": r.get("pattern_maker"),
        "created_by_name": r.get("created_by_name"),
        "created_at": _iso(r.get("created_at")),
        "completed_at": _iso(r.get("completed_at")),
        "adoption_date": _iso(r.get("adoption_date")),
        "target_order_week": r.get("target_order_week"),
        "order_date": _iso(r.get("order_date")),
        "sample_approval_date": _iso(r.get("sample_approval_date")),
        "fabric_type": r.get("fabric_type"),
        "fabric_name": r.get("fabric_name"),
        "sample_colour": r.get("sample_colour"),
        "theme": r.get("theme"),
        "print_solid": r.get("print_solid"),
    }
    return out


# ── registration ──────────────────────────────────────────────────────────────

def register_pd_routes(app, api_pg_module):
    global A
    A = api_pg_module

    @app.get("/api/pd/stages")
    def pd_stages():
        return {"stages": _stages()}

    @app.patch("/api/pd/stages/{stage_key}")
    async def pd_stage_update(stage_key: str, request: Request):
        email, name, role = _actor(request)
        if role != "admin":
            raise HTTPException(status_code=403, detail="Only admins can edit stage SLAs")
        body = await request.json()
        if stage_key not in _STAGE_KEYS:
            raise HTTPException(status_code=404, detail="Unknown stage")
        sets, params = [], []
        if "sla_days" in body:
            try:
                sla = int(body["sla_days"])
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="sla_days must be an integer")
            if not (1 <= sla <= 365):
                raise HTTPException(status_code=400, detail="sla_days must be between 1 and 365")
            sets.append("sla_days = %s"); params.append(sla)
        if "default_role" in body:
            sets.append("default_role = %s"); params.append((str(body["default_role"] or "")).strip() or None)
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        params.append(stage_key)
        _db(f"UPDATE pd_stages SET {', '.join(sets)} WHERE stage_key = %s", tuple(params), fetch=False)
        try:
            A._log_activity(request, "PATCH", f"/api/pd/stages/{stage_key}", json.dumps({"action": "pd_stage_sla_update", **{k: body.get(k) for k in ("sla_days", "default_role") if k in body}}))
        except Exception:
            pass
        return {"ok": True, "stages": _stages()}

    @app.get("/api/pd/assignees")
    def pd_assignees():
        rows = _db("""
            SELECT user_id, COALESCE(NULLIF(name,''), email) AS name, email, role
            FROM app_users
            WHERE COALESCE(status,'active') = 'active'
            ORDER BY LOWER(COALESCE(NULLIF(name,''), email))
        """) or []
        return {"users": rows}

    @app.get("/api/pd/board")
    def pd_board(include_completed: int = 0):
        stages = _stages()
        sla_map = {s["stage_key"]: s["sla_days"] for s in stages}
        where = "TRUE" if include_completed else "status = 'active'"
        rows = _db(f"SELECT * FROM pd_styles WHERE {where} ORDER BY stage_entered_at ASC") or []
        cards = [_style_out(r, sla_map) for r in rows]
        return {"stages": stages, "cards": cards}

    @app.get("/api/pd/completed")
    def pd_completed():
        rows = _db("""
            SELECT s.*,
                   EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) / 86400.0 AS cycle_days
            FROM pd_styles s WHERE s.status = 'completed'
            ORDER BY s.completed_at DESC
        """) or []
        out = []
        for r in rows:
            cyc = r.pop("cycle_days", None)
            o = _style_out(r)
            o["cycle_days"] = round(float(cyc), 1) if cyc is not None else None
            out.append(o)
        return {"styles": out}

    @app.post("/api/pd/styles")
    async def pd_style_create(request: Request):
        email, name, _role = _actor(request)
        body = await request.json()
        style_name = (body.get("style_name") or "").strip()
        if not style_name:
            raise HTTPException(status_code=400, detail="style_name is required")
        # Assignee: prefer user_id lookup; fall back to a plain name string for
        # the hardcoded assignee list (names that may not have app_users accounts).
        if body.get("assignee_user_id"):
            aid, aname = _resolve_assignee(body.get("assignee_user_id"))
        else:
            aid = None
            aname = (body.get("assignee_name") or "").strip() or None
        style_number  = (body.get("style_number")  or "").strip() or None
        sub_category  = (body.get("sub_category")  or "").strip() or None
        lifecycle_type = (body.get("lifecycle_type") or "").strip() or None
        rows = _db("""
            INSERT INTO pd_styles (style_name, style_number, brand, category, sub_category,
                                   lifecycle_type, assignee_user_id, assignee_name,
                                   created_by_email, created_by_name)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
        """, (style_name, style_number,
              (body.get("brand") or "").strip() or None,
              (body.get("category") or "").strip() or None,
              sub_category, lifecycle_type,
              aid, aname, email, name))
        st = rows[0]
        _log_move(st["id"], None, "adopted", "adopt", aid, aname, body.get("decisions"), email, name)
        try:
            A._log_activity(request, "POST", "/api/pd/styles", json.dumps({"action": "pd_style_adopt", "style_id": st["id"], "style_name": style_name}))
        except Exception:
            pass
        return {"ok": True, "style": _style_out(st)}

    @app.patch("/api/pd/styles/{style_id}")
    async def pd_style_edit(style_id: int, request: Request):
        email, name, _role = _actor(request)
        body = await request.json()
        _style(style_id)  # 404 if not found
        _EDITABLE = {
            "style_name", "style_number", "brand", "category", "sub_category",
            "lifecycle_type", "pattern_maker", "target_order_week",
            "fabric_type", "fabric_name", "sample_colour", "theme", "print_solid",
            "adoption_date", "order_date", "sample_approval_date",
            "assignee_name", "assignee_user_id",
        }
        _DATE_FIELDS = {"adoption_date", "order_date", "sample_approval_date"}
        sets, params = [], []
        for key in _EDITABLE:
            if key not in body:
                continue
            val = body[key]
            if isinstance(val, str):
                val = val.strip() or None
            if key in _DATE_FIELDS and val == "":
                val = None
            sets.append(f"{key} = %s")
            params.append(val)
        # Handle assignee resolution
        if "assignee_user_id" in body and body["assignee_user_id"]:
            aid, aname = _resolve_assignee(body["assignee_user_id"])
            sets = [s for s in sets if "assignee_user_id" not in s and "assignee_name" not in s]
            params_clean = []
            for s, p in zip(sets[:], params[:]):
                if "assignee" not in s:
                    params_clean.append(p)
            sets = [s for s in sets if "assignee" not in s]
            params = params_clean
            sets += ["assignee_user_id = %s", "assignee_name = %s"]
            params += [aid, aname]
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        params.append(style_id)
        _db(f"UPDATE pd_styles SET {', '.join(sets)} WHERE id = %s", tuple(params), fetch=False)
        try:
            A._log_activity(request, "PATCH", f"/api/pd/styles/{style_id}",
                            json.dumps({"action": "pd_style_edit", "style_id": style_id,
                                        "fields": list(body.keys())}))
        except Exception:
            pass
        return {"ok": True, "style": _style_out(_style(style_id))}

    @app.post("/api/pd/styles/{style_id}/move")
    async def pd_style_move(style_id: int, request: Request):
        email, name, _role = _actor(request)
        body = await request.json()
        action = (body.get("action") or "forward").lower()
        if action not in ("forward", "back", "approve", "reject"):
            raise HTTPException(status_code=400, detail="action must be forward, back, approve or reject")
        st = _style(style_id)
        if st["status"] != "active":
            raise HTTPException(status_code=400, detail="Style is completed — reopen is not supported")
        cur = st["current_stage"]
        cur_idx = _STAGE_ORDER[cur]
        decisions = (body.get("decisions") or "").strip()

        if action == "approve":
            if cur != "final_review":
                raise HTTPException(status_code=400, detail="Approval is only possible at Final Review")
            _db("UPDATE pd_styles SET status='completed', outcome='approved', completed_at=now() WHERE id=%s",
                (style_id,), fetch=False)
            _log_move(style_id, cur, None, "approve", st.get("assignee_user_id"), st.get("assignee_name"),
                      decisions, email, name)
            try:
                A._log_activity(request, "POST", f"/api/pd/styles/{style_id}/move", json.dumps({"action": "pd_style_approve"}))
            except Exception:
                pass
            return {"ok": True, "style": _style_out(_style(style_id))}

        # forward / back / reject all target another stage
        if action == "forward":
            if cur_idx >= len(_STAGE_KEYS) - 1:
                raise HTTPException(status_code=400, detail="Final Review is the last stage — use approve or reject")
            to_stage = body.get("to_stage") or _STAGE_KEYS[cur_idx + 1]
            if _STAGE_ORDER.get(to_stage) != cur_idx + 1:
                raise HTTPException(status_code=400, detail="Forward moves must go to the next stage only")
        else:  # back or reject
            to_stage = body.get("to_stage")
            if to_stage not in _STAGE_ORDER:
                raise HTTPException(status_code=400, detail="to_stage is required for send-back")
            if _STAGE_ORDER[to_stage] >= cur_idx:
                raise HTTPException(status_code=400, detail="Send-back must target an earlier stage")
            if action == "reject" and cur != "final_review":
                raise HTTPException(status_code=400, detail="Reject is only possible at Final Review")
            if not decisions:
                raise HTTPException(status_code=400, detail="A reason is required when sending a style back")

        if body.get("assignee_user_id"):
            aid, aname = _resolve_assignee(body.get("assignee_user_id"))
        else:
            aid, aname = None, (body.get("assignee_name") or "").strip() or None
        _db("""
            UPDATE pd_styles SET current_stage=%s, stage_entered_at=now(),
                   assignee_user_id=%s, assignee_name=%s
            WHERE id=%s
        """, (to_stage, aid, aname, style_id), fetch=False)
        _log_move(style_id, cur, to_stage, action if action != "reject" else "reject",
                  aid, aname, decisions, email, name)
        try:
            A._log_activity(request, "POST", f"/api/pd/styles/{style_id}/move", json.dumps({"action": f"pd_style_{action}", "from": cur, "to": to_stage}))
        except Exception:
            pass
        return {"ok": True, "style": _style_out(_style(style_id))}

    @app.get("/api/pd/styles/{style_id}")
    def pd_style_detail(style_id: int):
        st = _style(style_id)
        stages = _stages()
        sla_map = {s["stage_key"]: s["sla_days"] for s in stages}
        moves = _db("""
            SELECT id, from_stage, to_stage, direction, assignee_user_id, assignee_name,
                   decisions, moved_by_email, moved_by_name, created_at
            FROM pd_movements WHERE style_id = %s ORDER BY created_at, id
        """, (style_id,)) or []
        # Build the stage-by-stage timeline: each movement INTO a stage opens a
        # visit; the next movement (or approval) closes it.
        timeline = []
        open_visit = None
        for m in moves:
            when = m["created_at"]
            if open_visit is not None:
                open_visit["exited_at"] = when
                open_visit["duration_days"] = round((when - open_visit["_in"]).total_seconds() / 86400.0, 1)
                open_visit["exit_direction"] = m["direction"]
                open_visit["exited_by"] = m["moved_by_name"]
                timeline.append(open_visit)
                open_visit = None
            if m["to_stage"]:
                open_visit = {
                    "stage": m["to_stage"],
                    "stage_name": _STAGE_NAMES.get(m["to_stage"], m["to_stage"]),
                    "_in": when,
                    "entered_at": _iso(when),
                    "exited_at": None, "duration_days": None,
                    "exit_direction": None, "exited_by": None,
                    "assignee_name": m["assignee_name"],
                    "decisions": m["decisions"],
                    "moved_by": m["moved_by_name"],
                    "direction": m["direction"],
                }
        if open_visit is not None:
            if st["status"] == "active":
                open_visit["duration_days"] = round(
                    (datetime.now(timezone.utc) - open_visit["_in"]).total_seconds() / 86400.0, 1)
            timeline.append(open_visit)
        for t in timeline:
            t.pop("_in", None)
            t["exited_at"] = _iso(t["exited_at"])
        movements = [{**m, "created_at": _iso(m["created_at"])} for m in moves]
        return {"style": _style_out(st, sla_map), "timeline": timeline, "movements": movements}

    @app.get("/api/pd/history")
    def pd_history(limit: int = 2000):
        rows = _db("""
            SELECT m.id, m.style_id, s.style_name, s.style_number, s.brand,
                   s.lifecycle_type, m.from_stage, m.to_stage,
                   m.direction, m.assignee_name, m.decisions, m.moved_by_name,
                   m.moved_by_email, m.created_at
            FROM pd_movements m JOIN pd_styles s ON s.id = m.style_id
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT %s
        """, (min(int(limit), 10000),)) or []
        for r in rows:
            r["created_at"] = _iso(r["created_at"])
        return {"movements": rows}

    @app.delete("/api/pd/movements/{movement_id}")
    async def pd_movement_delete(movement_id: int, request: Request):
        email, name, role = _actor(request)
        if role != "admin":
            raise HTTPException(status_code=403, detail="Only admins can delete movement log entries")
        existing = _db("SELECT id FROM pd_movements WHERE id = %s", (movement_id,))
        if not existing:
            raise HTTPException(status_code=404, detail="Movement not found")
        _db("DELETE FROM pd_movements WHERE id = %s", (movement_id,), fetch=False)
        try:
            A._log_activity(request, "DELETE", f"/api/pd/movements/{movement_id}",
                            json.dumps({"action": "pd_movement_delete", "movement_id": movement_id}))
        except Exception:
            pass
        return {"ok": True}

    @app.get("/api/pd/analytics")
    def pd_analytics():
        stages = _stages()
        sla_map = {s["stage_key"]: s["sla_days"] for s in stages}
        # Completed stage visits, derived from consecutive movement pairs.
        visits = _db("""
            WITH mv AS (
                SELECT m.style_id, m.to_stage, m.assignee_name, m.created_at,
                       LEAD(m.created_at) OVER (PARTITION BY m.style_id ORDER BY m.created_at, m.id) AS next_at
                FROM pd_movements m
            )
            SELECT style_id, to_stage AS stage, assignee_name,
                   EXTRACT(EPOCH FROM (next_at - created_at)) / 86400.0 AS days
            FROM mv WHERE to_stage IS NOT NULL AND next_at IS NOT NULL
        """) or []
        # Stage duration stats (avg + median).
        stage_stats = {}
        for v in visits:
            stage_stats.setdefault(v["stage"], []).append(float(v["days"]))
        def _agg(vals):
            n = len(vals)
            if not n:
                return {"count": 0, "avg_days": None, "median_days": None}
            sv = sorted(vals)
            med = sv[n // 2] if n % 2 else (sv[n // 2 - 1] + sv[n // 2]) / 2
            return {"count": n, "avg_days": round(sum(vals) / n, 1), "median_days": round(med, 1)}
        stage_durations = [
            {"stage": s["stage_key"], "stage_name": s["stage_name"], "sla_days": s["sla_days"],
             **_agg(stage_stats.get(s["stage_key"], []))}
            for s in stages
        ]
        # Per-assignee per-stage durations.
        by_assignee = {}
        for v in visits:
            key = v["assignee_name"] or "Unassigned"
            by_assignee.setdefault(key, []).append(float(v["days"]))
        assignee_turnaround = sorted(
            [{"assignee": k, **_agg(vals)} for k, vals in by_assignee.items()],
            key=lambda r: -(r["avg_days"] or 0))
        # Current workload per assignee.
        workload = _db("""
            SELECT COALESCE(NULLIF(assignee_name,''), 'Unassigned') AS assignee,
                   COUNT(*) AS active_styles,
                   ROUND(AVG(EXTRACT(EPOCH FROM (now() - stage_entered_at)) / 86400.0)::numeric, 1) AS avg_days_holding
            FROM pd_styles WHERE status = 'active'
            GROUP BY 1 ORDER BY active_styles DESC
        """) or []
        # Stuck styles: active styles over their stage SLA, worst first.
        actives = _db("SELECT * FROM pd_styles WHERE status = 'active'") or []
        stuck = []
        for r in actives:
            o = _style_out(r, sla_map)
            if o["days_in_stage"] is not None and o["sla_days"] is not None and o["days_in_stage"] > o["sla_days"]:
                o["days_overdue"] = round(o["days_in_stage"] - o["sla_days"], 1)
                stuck.append(o)
        stuck.sort(key=lambda x: -x["days_overdue"])
        # Cycle times for completed styles + monthly trend.
        cycles = _db("""
            SELECT id, style_name, brand, completed_at,
                   EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400.0 AS cycle_days
            FROM pd_styles WHERE status = 'completed' AND completed_at IS NOT NULL
            ORDER BY completed_at
        """) or []
        cycle_rows, trend = [], {}
        for c in cycles:
            d = round(float(c["cycle_days"]), 1)
            cycle_rows.append({"id": c["id"], "style_name": c["style_name"], "brand": c["brand"],
                               "completed_at": _iso(c["completed_at"]), "cycle_days": d})
            mo = c["completed_at"].strftime("%Y-%m")
            trend.setdefault(mo, []).append(d)
        cycle_trend = [{"month": mo, "avg_cycle_days": round(sum(v) / len(v), 1), "styles": len(v)}
                       for mo, v in sorted(trend.items())]
        return {
            "stage_durations": stage_durations,
            "assignee_turnaround": assignee_turnaround,
            "workload": workload,
            "stuck_styles": stuck,
            "cycle_times": cycle_rows,
            "cycle_trend": cycle_trend,
        }

    log.info("Product Development Flow routes registered (/api/pd/*)")
