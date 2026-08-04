"""Store Feedback (Voice of Customer) — store teams log what customers say;
HQ reviews, responds and tracks it.

Design notes
------------
- Submission is open to every authed BI user (the employee self-service fence
  in clerk_auth_gate still applies — this module does not widen it).
- The review surface (list / status / notes / export) is server-gated to
  admin + leadership + smt roles; client tab-hiding is UX only.
- Attachments are stored as BYTEA in Postgres (same pattern as sop_files):
  survives deploys, no filesystem dependency. The frontend downscales photos
  before upload; the server still enforces size/type/count caps.
- New submissions notify active admins through the existing notification bell
  (user_notifications, dedupe_key ON CONFLICT DO NOTHING). Status changes
  notify the submitter back — closing the loop is what keeps stores
  submitting.
"""

import io
import re
import csv
import logging
import datetime as _dt
from typing import List, Optional

import psycopg2
from fastapi import Request, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("store_feedback")

# Categories the form offers. Key -> label (label used in notifications/CSV).
CATEGORIES = {
    "product_quality":    "Product quality issue",
    "fit_sizing":         "Fit & sizing",
    "price":              "Price",
    "product_request":    "Product request / range gap",
    "stock_availability": "Stock availability",
    "customer_service":   "Customer service",
    "store_experience":   "Store experience",
    "other":              "Other",
}
FREQUENCIES = {
    "first_time":     "First time hearing this",
    "few_customers":  "A few customers have said this",
    "many_customers": "Many customers keep saying this",
}
STATUSES = ("new", "reviewed", "actioned", "dismissed")
REVIEWER_ROLES = ("admin", "leadership", "smt")

MAX_FILES = 4
MAX_FILE_BYTES = 8 * 1024 * 1024  # 8 MB per file (frontend compresses first)


def _sniff_content_type(data: bytes):
    """Server-side file-signature (magic bytes) validation.

    Never trust the client-supplied MIME type: browsers/attackers can claim
    image/* for arbitrary payloads (incl. SVG/HTML → stored-XSS against
    reviewers). Only formats whose signature we recognize are accepted, and
    the STORED content type is derived from the signature, not the upload.
    SVG is deliberately unsupported (active content).
    """
    if not data or len(data) < 12:
        return None
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    return None

_TABLES_READY = False


def _A():
    import api_pg
    return api_pg


def _ensure_tables():
    global _TABLES_READY
    if _TABLES_READY:
        return
    A = _A()
    A._users_exec("""
        CREATE TABLE IF NOT EXISTS store_feedback (
            id                SERIAL PRIMARY KEY,
            feedback_date     DATE NOT NULL DEFAULT CURRENT_DATE,
            store_name        TEXT NOT NULL,
            category          TEXT NOT NULL DEFAULT 'other',
            frequency         TEXT,
            product_name      TEXT,
            style_number      TEXT,
            product_sku       TEXT,
            customer_name     TEXT,
            customer_contact  TEXT,
            wants_followup    BOOLEAN NOT NULL DEFAULT FALSE,
            feedback_text     TEXT NOT NULL,
            business_impact   TEXT,
            status            TEXT NOT NULL DEFAULT 'new',
            admin_notes       TEXT,
            status_updated_by TEXT,
            status_updated_at TIMESTAMPTZ,
            submitted_by       TEXT NOT NULL,
            submitted_by_name  TEXT,
            submitted_by_email TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    A._users_exec("""
        CREATE TABLE IF NOT EXISTS store_feedback_attachments (
            id           SERIAL PRIMARY KEY,
            feedback_id  INT NOT NULL REFERENCES store_feedback(id) ON DELETE CASCADE,
            filename     TEXT,
            content_type TEXT,
            size_bytes   INT,
            data         BYTEA,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    A._users_exec(
        "CREATE INDEX IF NOT EXISTS idx_store_feedback_created "
        "ON store_feedback (created_at DESC)")
    A._users_exec(
        "CREATE INDEX IF NOT EXISTS idx_store_feedback_att_fid "
        "ON store_feedback_attachments (feedback_id)")
    _TABLES_READY = True


# ── auth helpers ─────────────────────────────────────────────────────────────

def _req_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def _uid(user: dict) -> str:
    return str(user.get("user_id") or user.get("id") or "")


def _is_reviewer(user: dict) -> bool:
    return (user.get("role") or "") in REVIEWER_ROLES


def _require_reviewer(user: dict):
    if not _is_reviewer(user):
        raise HTTPException(
            status_code=403,
            detail="Store feedback review requires a leadership or admin role")


# ── notifications ────────────────────────────────────────────────────────────

def _notify(user_id: str, ntype: str, title: str, message: str,
            dedupe_key: str, link: str):
    try:
        _A()._users_exec("""
            INSERT INTO user_notifications
                (user_id, type, title, message, link, dedupe_key)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (dedupe_key) DO NOTHING
        """, (user_id, ntype, title, message, link, dedupe_key))
    except Exception as e:  # notifications must never break the main action
        log.warning("store_feedback notify failed: %s", e)


def _notify_admins_new(fid: int, store: str, category: str, excerpt: str):
    A = _A()
    try:
        admins = A._users_exec(
            "SELECT user_id FROM app_users "
            "WHERE role='admin' AND status='active'", fetch=True) or []
    except Exception as e:
        log.warning("store_feedback admin lookup failed: %s", e)
        return
    label = CATEGORIES.get(category, category)
    for a in admins:
        _notify(
            a["user_id"], "store_feedback",
            f"New store feedback · {store}",
            f"{label}: {excerpt}",
            f"store_feedback:new:{fid}:{a['user_id']}",
            f"/store-feedback?open={fid}",
        )


# ── row shaping ──────────────────────────────────────────────────────────────

def _row_out(r: dict, atts: Optional[List[dict]] = None) -> dict:
    return {
        "id": r["id"],
        "feedback_date": str(r.get("feedback_date") or "")[:10],
        "store_name": r.get("store_name"),
        "category": r.get("category"),
        "category_label": CATEGORIES.get(r.get("category"), r.get("category")),
        "frequency": r.get("frequency"),
        "frequency_label": FREQUENCIES.get(r.get("frequency")) if r.get("frequency") else None,
        "product_name": r.get("product_name"),
        "style_number": r.get("style_number"),
        "product_sku": r.get("product_sku"),
        "customer_name": r.get("customer_name"),
        "customer_contact": r.get("customer_contact"),
        "wants_followup": bool(r.get("wants_followup")),
        "feedback_text": r.get("feedback_text"),
        "business_impact": r.get("business_impact"),
        "status": r.get("status"),
        "admin_notes": r.get("admin_notes"),
        "status_updated_by": r.get("status_updated_by"),
        "status_updated_at": r["status_updated_at"].isoformat() if r.get("status_updated_at") else None,
        "submitted_by_name": r.get("submitted_by_name"),
        "submitted_by_email": r.get("submitted_by_email"),
        "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        "attachments": [
            {"id": a["id"], "filename": a.get("filename"),
             "content_type": a.get("content_type"),
             "size_bytes": a.get("size_bytes")}
            for a in (atts or [])
        ],
    }


def _fetch_attachments_meta(fids: List[int]) -> dict:
    if not fids:
        return {}
    rows = _A()._users_exec(
        "SELECT id, feedback_id, filename, content_type, size_bytes "
        "FROM store_feedback_attachments WHERE feedback_id = ANY(%s) "
        "ORDER BY id", (fids,), fetch=True) or []
    out = {}
    for a in rows:
        out.setdefault(a["feedback_id"], []).append(a)
    return out


# ── registration ─────────────────────────────────────────────────────────────

def register_store_feedback_routes(app):

    @app.get("/api/store-feedback/meta")
    def sf_meta(request: Request):
        _req_user(request)
        _ensure_tables()
        A = _A()
        try:
            rows = A.run_query("""
                SELECT DISTINCT pos_location_name AS store
                FROM all_sales
                WHERE COALESCE(pos_location_name,'') <> ''
                  AND sale_date::date >= CURRENT_DATE - INTERVAL '365 days'
                ORDER BY 1
            """) or []
            stores = [r["store"] for r in rows if r.get("store")]
        except Exception as e:
            log.warning("store_feedback stores lookup failed: %s", e)
            stores = []
        return {
            "stores": stores,
            "categories": [{"key": k, "label": v} for k, v in CATEGORIES.items()],
            "frequencies": [{"key": k, "label": v} for k, v in FREQUENCIES.items()],
            "statuses": list(STATUSES),
        }

    @app.get("/api/store-feedback/product-search")
    def sf_product_search(request: Request, q: str = Query(default="")):
        _req_user(request)
        q = (q or "").strip()
        if len(q) < 2:
            return {"items": []}
        like = f"%{q}%"
        rows = _A()._users_exec("""
            SELECT style_name,
                   MAX(COALESCE(style_number,'')) AS style_number,
                   MAX(sku)                        AS sku,
                   MAX(COALESCE(brand,''))         AS brand
            FROM all_products_clean
            WHERE COALESCE(style_name,'') <> ''
              AND (style_name ILIKE %s
                   OR COALESCE(style_number,'') ILIKE %s
                   OR COALESCE(product_name,'') ILIKE %s
                   OR sku ILIKE %s)
            GROUP BY style_name
            ORDER BY style_name
            LIMIT 10
        """, (like, like, like, like), fetch=True) or []
        return {"items": [
            {"style_name": r["style_name"],
             "style_number": r.get("style_number") or None,
             "sku": r.get("sku"),
             "brand": r.get("brand") or None}
            for r in rows
        ]}

    @app.post("/api/store-feedback")
    async def sf_submit(
        request: Request,
        feedback_date: str = Form(default=""),
        store_name: str = Form(...),
        category: str = Form(default="other"),
        frequency: str = Form(default=""),
        product_name: str = Form(default=""),
        style_number: str = Form(default=""),
        product_sku: str = Form(default=""),
        customer_name: str = Form(default=""),
        customer_contact: str = Form(default=""),
        wants_followup: str = Form(default="false"),
        feedback_text: str = Form(...),
        business_impact: str = Form(default=""),
        files: List[UploadFile] = File(default=None),
    ):
        user = _req_user(request)
        text = (feedback_text or "").strip()
        if len(text) < 5:
            raise HTTPException(status_code=400,
                                detail="Please write what the customer said (a few words at least).")
        store = (store_name or "").strip()
        if not store:
            raise HTTPException(status_code=400, detail="Store is required.")
        cat = category if category in CATEGORIES else "other"
        freq = frequency if frequency in FREQUENCIES else None
        try:
            fdate = _dt.date.fromisoformat((feedback_date or "").strip())
        except ValueError:
            fdate = _dt.date.today()
        if fdate > _dt.date.today():
            fdate = _dt.date.today()

        # Read + validate attachments up front (async), store later (threadpool).
        # Type is decided by file SIGNATURE, never by client-claimed MIME.
        blobs = []
        for f in (files or [])[:MAX_FILES]:
            if not f or not f.filename:
                continue
            data = await f.read()
            if len(data) > MAX_FILE_BYTES:
                raise HTTPException(status_code=400,
                                    detail=f"{f.filename} is too large (max 8 MB).")
            if not data:
                continue
            ctype = _sniff_content_type(data)
            if ctype is None:
                raise HTTPException(status_code=400,
                                    detail=f"Unsupported file type: {f.filename} — JPEG/PNG/WebP/GIF photos or PDF only.")
            blobs.append((f.filename[:200], ctype, data))

        def _insert():
            _ensure_tables()
            A = _A()
            rows = A._users_exec("""
                INSERT INTO store_feedback
                    (feedback_date, store_name, category, frequency,
                     product_name, style_number, product_sku,
                     customer_name, customer_contact, wants_followup,
                     feedback_text, business_impact,
                     submitted_by, submitted_by_name, submitted_by_email)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id, created_at
            """, (
                fdate, store, cat, freq,
                (product_name or "").strip() or None,
                (style_number or "").strip() or None,
                (product_sku or "").strip() or None,
                (customer_name or "").strip() or None,
                (customer_contact or "").strip() or None,
                str(wants_followup).lower() in ("true", "1", "yes", "on"),
                text,
                (business_impact or "").strip() or None,
                _uid(user),
                user.get("name") or None,
                user.get("email") or None,
            ), fetch=True)
            fid = rows[0]["id"]
            for (fname, ctype, data) in blobs:
                A._users_exec("""
                    INSERT INTO store_feedback_attachments
                        (feedback_id, filename, content_type, size_bytes, data)
                    VALUES (%s,%s,%s,%s,%s)
                """, (fid, fname, ctype, len(data), psycopg2.Binary(data)))
            excerpt = text if len(text) <= 120 else text[:117] + "…"
            _notify_admins_new(fid, store, cat, excerpt)
            return fid

        fid = await run_in_threadpool(_insert)
        return {"ok": True, "id": fid}

    @app.get("/api/store-feedback/mine")
    def sf_mine(request: Request):
        user = _req_user(request)
        _ensure_tables()
        rows = _A()._users_exec(
            "SELECT * FROM store_feedback WHERE submitted_by=%s "
            "ORDER BY created_at DESC LIMIT 200",
            (_uid(user),), fetch=True) or []
        atts = _fetch_attachments_meta([r["id"] for r in rows])
        return {"items": [_row_out(r, atts.get(r["id"])) for r in rows]}

    def _list_where(store, category, status, date_from, date_to, q):
        where, params = ["1=1"], []
        if store:
            where.append("store_name = %s"); params.append(store)
        if category:
            where.append("category = %s"); params.append(category)
        if status:
            where.append("status = %s"); params.append(status)
        if date_from:
            where.append("feedback_date >= %s"); params.append(date_from)
        if date_to:
            where.append("feedback_date <= %s"); params.append(date_to)
        if q:
            like = f"%{q.strip()}%"
            where.append("(feedback_text ILIKE %s OR business_impact ILIKE %s "
                         "OR product_name ILIKE %s OR style_number ILIKE %s "
                         "OR customer_name ILIKE %s OR store_name ILIKE %s "
                         "OR submitted_by_name ILIKE %s)")
            params.extend([like] * 7)
        return " AND ".join(where), params

    @app.get("/api/store-feedback/list")
    def sf_list(request: Request,
                store: str = Query(default=""),
                category: str = Query(default=""),
                status: str = Query(default=""),
                date_from: str = Query(default=""),
                date_to: str = Query(default=""),
                q: str = Query(default=""),
                limit: int = Query(default=50, le=200),
                offset: int = Query(default=0, ge=0)):
        user = _req_user(request)
        _require_reviewer(user)
        _ensure_tables()
        A = _A()
        wsql, params = _list_where(store, category, status, date_from, date_to, q)
        rows = A._users_exec(
            f"SELECT *, COUNT(*) OVER() AS _total FROM store_feedback "
            f"WHERE {wsql} ORDER BY created_at DESC LIMIT %s OFFSET %s",
            tuple(params + [limit, offset]), fetch=True) or []
        total = rows[0]["_total"] if rows else 0
        atts = _fetch_attachments_meta([r["id"] for r in rows])

        summ = A._users_exec("""
            SELECT
              COUNT(*) FILTER (WHERE status='new')                                   AS open_new,
              COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))       AS this_month,
              COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days')       AS last_30d
            FROM store_feedback
        """, fetch=True)
        by_cat = A._users_exec("""
            SELECT category, COUNT(*) AS n FROM store_feedback
            WHERE created_at >= now() - INTERVAL '30 days'
            GROUP BY category ORDER BY n DESC LIMIT 3
        """, fetch=True) or []
        by_store = A._users_exec("""
            SELECT store_name, COUNT(*) AS n FROM store_feedback
            WHERE created_at >= now() - INTERVAL '30 days'
            GROUP BY store_name ORDER BY n DESC LIMIT 3
        """, fetch=True) or []
        return {
            "items": [_row_out(r, atts.get(r["id"])) for r in rows],
            "total": int(total),
            "summary": {
                "open_new": int(summ[0]["open_new"]) if summ else 0,
                "this_month": int(summ[0]["this_month"]) if summ else 0,
                "last_30d": int(summ[0]["last_30d"]) if summ else 0,
                "top_categories": [
                    {"key": r["category"],
                     "label": CATEGORIES.get(r["category"], r["category"]),
                     "n": int(r["n"])} for r in by_cat],
                "top_stores": [
                    {"store": r["store_name"], "n": int(r["n"])} for r in by_store],
            },
        }

    @app.get("/api/store-feedback/item/{fid}")
    def sf_item(fid: int, request: Request):
        user = _req_user(request)
        _ensure_tables()
        rows = _A()._users_exec(
            "SELECT * FROM store_feedback WHERE id=%s", (fid,), fetch=True)
        if not rows:
            raise HTTPException(status_code=404, detail="Feedback not found")
        r = rows[0]
        if not _is_reviewer(user) and r.get("submitted_by") != _uid(user):
            raise HTTPException(status_code=403, detail="Not allowed")
        atts = _fetch_attachments_meta([fid])
        return {"item": _row_out(r, atts.get(fid))}

    @app.patch("/api/store-feedback/item/{fid}")
    async def sf_update(fid: int, request: Request):
        user = _req_user(request)
        _require_reviewer(user)
        _ensure_tables()
        body = await request.json()
        new_status = body.get("status")
        notes = body.get("admin_notes")
        if new_status is not None and new_status not in STATUSES:
            raise HTTPException(status_code=400, detail="Invalid status")

        def _apply():
            A = _A()
            rows = A._users_exec(
                "SELECT * FROM store_feedback WHERE id=%s", (fid,), fetch=True)
            if not rows:
                raise HTTPException(status_code=404, detail="Feedback not found")
            prev = rows[0]
            sets, params = [], []
            if new_status is not None and new_status != prev["status"]:
                sets += ["status=%s", "status_updated_by=%s", "status_updated_at=now()"]
                params += [new_status, user.get("email") or _uid(user)]
            if notes is not None:
                sets.append("admin_notes=%s")
                params.append((notes or "").strip() or None)
            if not sets:
                return _row_out(prev), False
            params.append(fid)
            upd = A._users_exec(
                f"UPDATE store_feedback SET {', '.join(sets)} WHERE id=%s RETURNING *",
                tuple(params), fetch=True)
            changed_status = new_status is not None and new_status != prev["status"]
            return _row_out(upd[0]), changed_status

        out, status_changed = await run_in_threadpool(_apply)
        if status_changed and out.get("status") != "new":
            label = {"reviewed": "reviewed", "actioned": "actioned",
                     "dismissed": "closed"}.get(out["status"], out["status"])
            rows = _A()._users_exec(
                "SELECT submitted_by FROM store_feedback WHERE id=%s",
                (fid,), fetch=True)
            if rows and rows[0].get("submitted_by"):
                _notify(
                    rows[0]["submitted_by"], "store_feedback_status",
                    f"Your store feedback was {label}",
                    f"{out.get('store_name')} · {out.get('category_label')}"
                    + (f" — {out.get('admin_notes')}" if out.get("admin_notes") else ""),
                    f"store_feedback:status:{fid}:{out['status']}",
                    "/store-feedback?tab=mine",
                )
        return {"ok": True, "item": out}

    @app.get("/api/store-feedback/attachment/{att_id}")
    def sf_attachment(att_id: int, request: Request):
        user = _req_user(request)
        _ensure_tables()
        rows = _A()._users_exec("""
            SELECT a.filename, a.content_type, a.data, f.submitted_by
            FROM store_feedback_attachments a
            JOIN store_feedback f ON f.id = a.feedback_id
            WHERE a.id=%s
        """, (att_id,), fetch=True)
        if not rows:
            raise HTTPException(status_code=404, detail="Attachment not found")
        r = rows[0]
        if not _is_reviewer(user) and r.get("submitted_by") != _uid(user):
            raise HTTPException(status_code=403, detail="Not allowed")
        data = bytes(r["data"]) if r.get("data") is not None else b""
        # Re-derive the type from the bytes (defense in depth; stored value is
        # already server-sniffed at upload). Unknown → force download.
        ctype = _sniff_content_type(data)
        fname = re.sub(r"[^A-Za-z0-9._ -]", "_", r.get("filename") or f"attachment-{att_id}")[:120] \
            or f"attachment-{att_id}"
        disposition = "inline" if ctype else "attachment"
        return Response(
            content=data,
            media_type=ctype or "application/octet-stream",
            headers={
                "Cache-Control": "private, max-age=3600",
                "Content-Disposition": f'{disposition}; filename="{fname}"',
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            })

    @app.get("/api/store-feedback/export.csv")
    def sf_export(request: Request,
                  store: str = Query(default=""),
                  category: str = Query(default=""),
                  status: str = Query(default=""),
                  date_from: str = Query(default=""),
                  date_to: str = Query(default=""),
                  q: str = Query(default="")):
        user = _req_user(request)
        _require_reviewer(user)
        _ensure_tables()
        wsql, params = _list_where(store, category, status, date_from, date_to, q)
        rows = _A()._users_exec(
            f"SELECT * FROM store_feedback WHERE {wsql} "
            f"ORDER BY created_at DESC LIMIT 5000",
            tuple(params), fetch=True) or []
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Date", "Store", "Category", "Frequency", "Product",
                    "Style Number", "Customer", "Wants Follow-up",
                    "Customer Feedback", "Business Impact", "Status",
                    "HQ Notes", "Submitted By", "Submitted At"])
        for r in rows:
            w.writerow([
                str(r.get("feedback_date") or "")[:10],
                r.get("store_name"),
                CATEGORIES.get(r.get("category"), r.get("category")),
                FREQUENCIES.get(r.get("frequency"), "") if r.get("frequency") else "",
                r.get("product_name") or "",
                r.get("style_number") or "",
                r.get("customer_name") or "",
                "yes" if r.get("wants_followup") else "no",
                r.get("feedback_text") or "",
                r.get("business_impact") or "",
                r.get("status"),
                r.get("admin_notes") or "",
                r.get("submitted_by_name") or r.get("submitted_by_email") or "",
                r["created_at"].isoformat() if r.get("created_at") else "",
            ])
        buf.seek(0)
        return StreamingResponse(
            iter([buf.getvalue()]), media_type="text/csv",
            headers={"Content-Disposition":
                     'attachment; filename="store-feedback.csv"'})

    log.info("store_feedback routes registered")
