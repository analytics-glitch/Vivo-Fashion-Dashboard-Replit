"""Odoo Reconciliation Agent API (/api/recon/*).

Registered from api_pg.py before the StaticFiles SPA catch-all, same pattern as
crm_clienteling / hr_attendance. Access is gated server-side in clerk_auth_gate
to leadership + admin (same surface as /api/finance).

Human approval is mandatory before any write-back, and write-back targets ONLY
the Odoo staging instance (ODOO_WRITE_* secrets) — see recon_engine.py.
"""
import csv
import io
import json
import logging
import os
import threading

import psycopg2
import psycopg2.extras
from fastapi import Body, HTTPException, Query, Request
from fastapi.responses import Response

import recon_engine

log = logging.getLogger("recon_api")

_ensured = False
_ensure_lock = threading.Lock()


def _conn():
    global _ensured
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    if not _ensured:
        with _ensure_lock:
            if not _ensured:
                recon_engine.ensure_recon_tables(conn)
                _ensured = True
    return conn


def _actor(request: Request):
    user = getattr(request.state, "user", None) or {}
    return user.get("email") or user.get("user_id") or "unknown"


_RUN_THREAD_LOCK = threading.Lock()
_run_thread = None


def register_recon_routes(app):

    @app.get("/api/recon/summary")
    def recon_summary():
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT recon_type, status, COUNT(*),
                           COALESCE(SUM(ABS(diff)), 0)
                    FROM recon_items GROUP BY 1, 2
                """)
                summary = {}
                for rtype, status, n, amt in cur.fetchall():
                    summary.setdefault(rtype, {})[status] = {
                        "count": int(n), "abs_diff": float(amt)}
                cur.execute("""
                    SELECT id, run_trigger, triggered_by, started_at,
                           finished_at, status, stats, error
                    FROM recon_runs ORDER BY id DESC LIMIT 1
                """)
                row = cur.fetchone()
                last_run = None
                if row:
                    last_run = {
                        "id": row[0], "trigger": row[1], "triggered_by": row[2],
                        "started_at": row[3].isoformat() if row[3] else None,
                        "finished_at": row[4].isoformat() if row[4] else None,
                        "status": row[5], "stats": row[6], "error": row[7],
                    }
            return {
                "summary": summary,
                "last_run": last_run,
                "writeback_configured": recon_engine.writeback_configured(),
                "run_in_progress": _run_thread is not None and _run_thread.is_alive(),
            }
        finally:
            conn.close()

    @app.get("/api/recon/runs")
    def recon_runs(limit: int = Query(default=20, le=100)):
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, run_trigger, triggered_by, started_at,
                           finished_at, status, stats, error
                    FROM recon_runs ORDER BY id DESC LIMIT %s
                """, (limit,))
                return {"runs": [{
                    "id": r[0], "trigger": r[1], "triggered_by": r[2],
                    "started_at": r[3].isoformat() if r[3] else None,
                    "finished_at": r[4].isoformat() if r[4] else None,
                    "status": r[5], "stats": r[6], "error": r[7],
                } for r in cur.fetchall()]}
        finally:
            conn.close()

    @app.get("/api/recon/items")
    def recon_items(
        recon_type: str = Query(default=None),
        status: str = Query(default=None),
        store: str = Query(default=None),
        limit: int = Query(default=200, le=500),
        offset: int = Query(default=0, ge=0),
    ):
        clauses, params = [], []
        if recon_type:
            if recon_type not in ("sales_ledger", "collections", "bank", "payables"):
                raise HTTPException(status_code=400, detail="invalid recon_type")
            clauses.append("recon_type = %s")
            params.append(recon_type)
        if status:
            valid = set(recon_engine._MACHINE_STATES) | {"approved", "rejected", "written"}
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if not statuses or any(s not in valid for s in statuses):
                raise HTTPException(status_code=400, detail="invalid status")
            clauses.append("status = ANY(%s)")
            params.append(statuses)
        if store:
            clauses.append("store = %s")
            params.append(store)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM recon_items {where}", params)
                total = cur.fetchone()[0]
                cur.execute(f"""
                    SELECT item_key, recon_type, store, day, status, confidence,
                           amount_a, amount_b, diff, details, run_id,
                           updated_at, approved_by, approved_at, rejected_by,
                           rejected_at, written_at, writeback_result
                    FROM recon_items {where}
                    ORDER BY CASE status
                               WHEN 'exception' THEN 0 WHEN 'suggested' THEN 1
                               WHEN 'variance' THEN 2 WHEN 'missing' THEN 3
                               WHEN 'approved' THEN 4 WHEN 'matched' THEN 5
                               WHEN 'written' THEN 6 ELSE 7 END,
                             ABS(COALESCE(diff, 0)) DESC, item_key
                    LIMIT %s OFFSET %s
                """, params + [limit, offset])
                cols = ["item_key", "recon_type", "store", "day", "status",
                        "confidence", "amount_a", "amount_b", "diff", "details",
                        "run_id", "updated_at", "approved_by", "approved_at",
                        "rejected_by", "rejected_at", "written_at",
                        "writeback_result"]
                items = []
                for row in cur.fetchall():
                    d = dict(zip(cols, row))
                    for k in ("confidence", "amount_a", "amount_b", "diff"):
                        d[k] = float(d[k]) if d[k] is not None else None
                    for k in ("day", "updated_at", "approved_at", "rejected_at",
                              "written_at"):
                        d[k] = d[k].isoformat() if d[k] is not None else None
                    items.append(d)
            return {"total": int(total), "items": items}
        finally:
            conn.close()

    @app.post("/api/recon/run")
    def recon_run(request: Request):
        global _run_thread
        with _RUN_THREAD_LOCK:
            if _run_thread is not None and _run_thread.is_alive():
                raise HTTPException(status_code=409,
                                    detail="A reconciliation run is already in progress")
            actor = _actor(request)
            # The engine takes a Postgres advisory lock, so a nightly/subprocess
            # run can also hold it. Wait synchronously until the thread either
            # REALLY starts (lock held, run row created → on_start fires) or
            # fails, so a lost lock race returns 409 instead of a false success.
            started_evt = threading.Event()
            outcome = {}

            def _bg():
                try:
                    recon_engine.run_reconciliation(trigger="manual",
                                                    triggered_by=actor,
                                                    on_start=started_evt.set)
                except Exception as e:
                    outcome["error"] = e
                    if not (isinstance(e, RuntimeError) and str(e) == "run_in_progress"):
                        log.exception("Manual reconciliation run failed")
                finally:
                    started_evt.set()

            _run_thread = threading.Thread(target=_bg, name="recon-manual-run",
                                           daemon=True)
            _run_thread.start()
            started = started_evt.wait(timeout=30)
        err = outcome.get("error")
        if err is not None:
            if isinstance(err, RuntimeError) and str(err) == "run_in_progress":
                raise HTTPException(status_code=409,
                                    detail="A reconciliation run is already in progress")
            raise HTTPException(status_code=502,
                                detail=f"Reconciliation run failed to start: {err}")
        if not started:
            # No on_start ack and no error within the window — do NOT claim
            # success; the thread may still be stuck acquiring a connection.
            raise HTTPException(status_code=504,
                                detail="Reconciliation run did not confirm start within 30s — check /api/recon/runs before retrying")
        return {"started": True}

    @app.post("/api/recon/decide")
    def recon_decide(request: Request, payload: dict = Body(...)):
        item_key = (payload.get("item_key") or "").strip()
        action = (payload.get("action") or "").strip()
        note = (payload.get("note") or "").strip() or None
        if not item_key or action not in ("approve", "reject", "reopen"):
            raise HTTPException(status_code=400,
                                detail="item_key and action (approve|reject|reopen) required")
        actor = _actor(request)
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT status, details FROM recon_items WHERE item_key = %s FOR UPDATE",
                            (item_key,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="item not found")
                status, details = row[0], row[1] or {}
                if note:
                    details["review_note"] = note
                if action == "approve":
                    # Only machine 'suggested' items are approvable — approval is
                    # the human gate in front of a write-back.
                    if status != "suggested":
                        raise HTTPException(status_code=409,
                                            detail=f"only 'suggested' items can be approved (is: {status})")
                    cur.execute("""
                        UPDATE recon_items SET status='approved', approved_by=%s,
                          approved_at=now(), details=%s, updated_at=now()
                        WHERE item_key=%s
                    """, (actor, json.dumps(details), item_key))
                elif action == "reject":
                    if status in ("written",):
                        raise HTTPException(status_code=409,
                                            detail="cannot reject a written item")
                    cur.execute("""
                        UPDATE recon_items SET status='rejected', rejected_by=%s,
                          rejected_at=now(), details=%s, updated_at=now()
                        WHERE item_key=%s
                    """, (actor, json.dumps(details), item_key))
                else:  # reopen
                    if status not in ("approved", "rejected"):
                        raise HTTPException(status_code=409,
                                            detail="only approved/rejected items can be reopened")
                    cur.execute("""
                        UPDATE recon_items SET status='suggested', approved_by=NULL,
                          approved_at=NULL, rejected_by=NULL, rejected_at=NULL,
                          details=%s, updated_at=now()
                        WHERE item_key=%s
                    """, (json.dumps(details), item_key))
                recon_engine.audit(conn, item_key, action, actor,
                                   {"note": note} if note else None)
            conn.commit()
            return {"ok": True, "item_key": item_key, "action": action}
        finally:
            conn.close()

    @app.post("/api/recon/decide-bulk")
    def recon_decide_bulk(request: Request, payload: dict = Body(...)):
        item_keys = payload.get("item_keys") or []
        action = (payload.get("action") or "").strip()
        note = (payload.get("note") or "").strip() or None
        if (not isinstance(item_keys, list) or not item_keys
                or any(not isinstance(k, str) or not k.strip() for k in item_keys)
                or action not in ("approve", "reject", "reopen")):
            raise HTTPException(status_code=400,
                                detail="item_keys (non-empty list) and action (approve|reject|reopen) required")
        if len(item_keys) > 500:
            raise HTTPException(status_code=400, detail="at most 500 items per bulk action")
        item_keys = [k.strip() for k in item_keys]
        actor = _actor(request)
        conn = _conn()
        done, skipped = [], []
        try:
            with conn.cursor() as cur:
                for item_key in item_keys:
                    cur.execute(
                        "SELECT status, details FROM recon_items WHERE item_key = %s FOR UPDATE",
                        (item_key,))
                    row = cur.fetchone()
                    if not row:
                        skipped.append({"item_key": item_key, "reason": "not found"})
                        continue
                    status, details = row[0], row[1] or {}
                    if note:
                        details["review_note"] = note
                    # Same transition rules as the single-item /decide endpoint.
                    if action == "approve":
                        if status != "suggested":
                            skipped.append({"item_key": item_key,
                                            "reason": f"only 'suggested' items can be approved (is: {status})"})
                            continue
                        cur.execute("""
                            UPDATE recon_items SET status='approved', approved_by=%s,
                              approved_at=now(), details=%s, updated_at=now()
                            WHERE item_key=%s
                        """, (actor, json.dumps(details), item_key))
                    elif action == "reject":
                        if status == "written":
                            skipped.append({"item_key": item_key,
                                            "reason": "cannot reject a written item"})
                            continue
                        cur.execute("""
                            UPDATE recon_items SET status='rejected', rejected_by=%s,
                              rejected_at=now(), details=%s, updated_at=now()
                            WHERE item_key=%s
                        """, (actor, json.dumps(details), item_key))
                    else:  # reopen
                        if status not in ("approved", "rejected"):
                            skipped.append({"item_key": item_key,
                                            "reason": "only approved/rejected items can be reopened"})
                            continue
                        cur.execute("""
                            UPDATE recon_items SET status='suggested', approved_by=NULL,
                              approved_at=NULL, rejected_by=NULL, rejected_at=NULL,
                              details=%s, updated_at=now()
                            WHERE item_key=%s
                        """, (json.dumps(details), item_key))
                    recon_engine.audit(conn, item_key, action, actor,
                                       {"note": note, "bulk": True} if note else {"bulk": True})
                    done.append(item_key)
            conn.commit()  # one commit — all applied decisions land atomically
            return {"ok": True, "action": action, "done": done, "skipped": skipped}
        except HTTPException:
            conn.rollback()
            raise
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @app.get("/api/recon/export.csv")
    def recon_export_csv(
        recon_type: str = Query(...),
        status: str = Query(default=None),
        store: str = Query(default=None),
    ):
        if recon_type not in ("sales_ledger", "collections", "bank", "payables"):
            raise HTTPException(status_code=400, detail="invalid recon_type")
        clauses, params = ["recon_type = %s"], [recon_type]
        if status:
            valid = set(recon_engine._MACHINE_STATES) | {"approved", "rejected", "written"}
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if not statuses or any(s not in valid for s in statuses):
                raise HTTPException(status_code=400, detail="invalid status")
            clauses.append("status = ANY(%s)")
            params.append(statuses)
        if store:
            clauses.append("store = %s")
            params.append(store)
        where = "WHERE " + " AND ".join(clauses)
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT item_key, recon_type, store, day, status, confidence,
                           amount_a, amount_b, diff, details,
                           approved_by, approved_at, rejected_by, rejected_at,
                           written_at, updated_at
                    FROM recon_items {where}
                    ORDER BY CASE status
                               WHEN 'exception' THEN 0 WHEN 'suggested' THEN 1
                               WHEN 'variance' THEN 2 WHEN 'missing' THEN 3
                               WHEN 'approved' THEN 4 WHEN 'matched' THEN 5
                               WHEN 'written' THEN 6 ELSE 7 END,
                             ABS(COALESCE(diff, 0)) DESC, item_key
                    LIMIT 20000
                """, params)
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(["item_key", "recon_type", "store", "day", "status",
                            "confidence", "amount_a", "amount_b", "diff",
                            "details", "approved_by", "approved_at",
                            "rejected_by", "rejected_at", "written_at",
                            "updated_at"])
                def _csv_safe(v):
                    # Guard against spreadsheet formula injection: prefix
                    # cells that Excel/Sheets would evaluate with a quote.
                    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
                        return "'" + v
                    return v
                for row in cur.fetchall():
                    out = list(row)
                    out[9] = json.dumps(out[9]) if out[9] is not None else ""
                    for i in (3, 11, 13, 14, 15):
                        out[i] = out[i].isoformat() if out[i] is not None else ""
                    w.writerow([_csv_safe(v) for v in out])
            return Response(
                content=buf.getvalue(),
                media_type="text/csv; charset=utf-8",
                headers={"Content-Disposition":
                         f'attachment; filename="recon-{recon_type}.csv"'})
        finally:
            conn.close()

    @app.post("/api/recon/writeback")
    def recon_writeback(request: Request, payload: dict = Body(...)):
        item_key = (payload.get("item_key") or "").strip()
        if not item_key:
            raise HTTPException(status_code=400, detail="item_key required")
        if not recon_engine.writeback_configured():
            raise HTTPException(
                status_code=503,
                detail="Write-back is not configured (ODOO_WRITE_* secrets missing). "
                       "Write-back targets the Odoo STAGING instance only.")
        actor = _actor(request)
        conn = _conn()
        try:
            if item_key.startswith("bank|"):
                result = recon_engine.writeback_bank_item(conn, item_key, actor)
            elif item_key.startswith("bill|"):
                result = recon_engine.writeback_bill_payment_item(conn, item_key, actor)
            else:
                raise HTTPException(status_code=400,
                                    detail="only bank| and bill| items support write-back")
            conn.commit()
            return {"ok": True, "item_key": item_key, "result": result}
        except HTTPException:
            raise
        except RuntimeError as e:
            conn.commit()  # drift re-queue must persist
            msg = str(e)
            code = 409 if msg.startswith("drift:") or "not approved" in msg else 502
            raise HTTPException(status_code=code, detail=msg)
        finally:
            conn.close()

    @app.get("/api/recon/audit")
    def recon_audit(item_key: str = Query(...), limit: int = Query(default=50, le=200)):
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT action, actor, at, payload FROM recon_audit
                    WHERE item_key = %s ORDER BY id DESC LIMIT %s
                """, (item_key, limit))
                return {"audit": [{
                    "action": r[0], "actor": r[1],
                    "at": r[2].isoformat() if r[2] else None,
                    "payload": r[3],
                } for r in cur.fetchall()]}
        finally:
            conn.close()
