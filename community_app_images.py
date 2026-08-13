"""Community App prototype dressing — slot-keyed placeholder images.

The Community App page (/community-app) is a clickable prototype whose picture
spots are beige 📸 placeholder boxes. This module lets the team upload a real
photo into each specific slot straight from the page, so the prototype can be
dressed with real imagery without code changes.

Design notes
------------
- Images are BYTEA rows in Postgres keyed by a stable slot id (same pattern as
  store_feedback attachments): survives deploys, no filesystem dependency.
  Prod is a separate DB — the team re-uploads there once published.
- Every route requires the existing session auth AND that the caller's
  allowed pages include the "community-app" page id (mirrors what
  /api/auth/me surfaces: effective role pages + personal extra_pages).
  Anyone who can VIEW the prototype can dress it — this is internal team
  tooling, not member-facing uploads.
- Upload type is decided by file SIGNATURE (jpeg/png/gif/webp only), never
  the client-claimed MIME; SVG is deliberately unsupported (active content).
- Replace-on-conflict bumps a version counter; the serve endpoint sends
  long-lived cache headers because the frontend cache-busts with ?v=<version>.
"""

import logging
import re
from typing import Optional

import psycopg2
from fastapi import File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("community_app_images")

PAGE_ID = "community-app"
MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB

# Stable, human-readable ids wired in the frontend (e.g. "shop-product-p1",
# "community-board-office-to-evening-tile-2"). Lowercase to keep the keyspace
# canonical; reject anything else so junk ids can't accumulate rows.
_SLOT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")

_EXT_FOR = {"image/jpeg": "jpg", "image/png": "png",
            "image/gif": "gif", "image/webp": "webp"}

_TABLES_READY = False


def _A():
    import api_pg
    return api_pg


def _ensure_tables():
    global _TABLES_READY
    if _TABLES_READY:
        return
    _A()._users_exec("""
        CREATE TABLE IF NOT EXISTS community_app_slot_images (
            slot_id           TEXT PRIMARY KEY,
            content_type      TEXT NOT NULL,
            size_bytes        INT  NOT NULL,
            data              BYTEA NOT NULL,
            version           INT  NOT NULL DEFAULT 1,
            uploaded_by       TEXT,
            uploaded_by_name  TEXT,
            uploaded_by_email TEXT,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    _TABLES_READY = True


def _sniff_image_type(data: bytes) -> Optional[str]:
    """Magic-byte sniff — images only.

    Never trust the client-supplied MIME type: browsers/attackers can claim
    image/* for arbitrary payloads (incl. SVG/HTML → stored-XSS against
    everyone who views the page). The STORED content type is derived from the
    signature, not the upload. No PDF here (unlike store feedback) — these
    slots render straight into <img> tags.
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
    return None


def _require_page_user(request: Request) -> dict:
    """Session user whose allowed pages include the community-app page.

    Mirrors the /api/auth/me composition (effective role pages + personal
    extra_pages union) so the server-side gate always agrees with what the
    nav shows. Client hiding alone is never enforcement.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    A = _A()
    try:
        u = dict(user)
        u["allowed_pages"] = A._effective_pages_for_role(u.get("role"))
        A._apply_extra_pages(u)
        pages = u.get("allowed_pages") or []
    except Exception as e:  # fail closed, but distinguish from a real 403
        log.warning("community-app page-access check failed: %s", e)
        raise HTTPException(status_code=503, detail="Access check unavailable")
    if PAGE_ID not in pages:
        raise HTTPException(
            status_code=403, detail="Community App access required")
    return user


def register_community_app_image_routes(app):

    @app.get("/api/community-app/images")
    def community_slot_manifest(request: Request):
        """One manifest call listing every filled slot (id → version/meta).

        The page fetches this once per visit and passes it down, so empty
        placeholders never fire per-slot requests.
        """
        _require_page_user(request)
        _ensure_tables()
        rows = _A()._users_exec(
            "SELECT slot_id, content_type, size_bytes, version, "
            "       uploaded_by_name, updated_at "
            "FROM community_app_slot_images ORDER BY slot_id",
            fetch=True) or []
        return {"slots": {
            r["slot_id"]: {
                "version": int(r.get("version") or 1),
                "content_type": r.get("content_type"),
                "size_bytes": int(r.get("size_bytes") or 0),
                "uploaded_by_name": r.get("uploaded_by_name"),
                "updated_at": r["updated_at"].isoformat()
                              if r.get("updated_at") else None,
            } for r in rows
        }}

    @app.post("/api/community-app/images/{slot_id}")
    async def community_slot_upload(slot_id: str, request: Request,
                                    file: UploadFile = File(...)):
        user = _require_page_user(request)
        if not _SLOT_RE.match(slot_id or ""):
            raise HTTPException(status_code=400, detail="Invalid slot id")
        data = await file.read()
        if not data:
            raise HTTPException(
                status_code=400,
                detail="That file looks empty — pick an image file.")
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=400, detail="Image is too large (max 5 MB).")
        ctype = _sniff_image_type(data)
        if ctype is None:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file type — JPEG, PNG, GIF or WebP "
                       "images only.")

        def _upsert():
            _ensure_tables()
            rows = _A()._users_exec("""
                INSERT INTO community_app_slot_images
                    (slot_id, content_type, size_bytes, data,
                     uploaded_by, uploaded_by_name, uploaded_by_email)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (slot_id) DO UPDATE SET
                    content_type      = EXCLUDED.content_type,
                    size_bytes        = EXCLUDED.size_bytes,
                    data              = EXCLUDED.data,
                    version           = community_app_slot_images.version + 1,
                    uploaded_by       = EXCLUDED.uploaded_by,
                    uploaded_by_name  = EXCLUDED.uploaded_by_name,
                    uploaded_by_email = EXCLUDED.uploaded_by_email,
                    updated_at        = now()
                RETURNING version
            """, (
                slot_id, ctype, len(data), psycopg2.Binary(data),
                str(user.get("user_id") or user.get("id") or "") or None,
                user.get("name") or None,
                user.get("email") or None,
            ), fetch=True)
            return int(rows[0]["version"])

        version = await run_in_threadpool(_upsert)
        return {"ok": True, "slot_id": slot_id, "version": version,
                "content_type": ctype, "size_bytes": len(data),
                "url": f"/api/community-app/images/{slot_id}?v={version}"}

    @app.get("/api/community-app/images/{slot_id}")
    def community_slot_image(slot_id: str, request: Request, v: str = ""):
        # `v` is the cache-busting version param — unused server-side by
        # design: a given (slot, version) URL always serves whatever bytes
        # are current, and the long cache below is safe because the frontend
        # changes the URL whenever the image is replaced.
        _require_page_user(request)
        if not _SLOT_RE.match(slot_id or ""):
            raise HTTPException(status_code=404, detail="No image for this slot")
        _ensure_tables()
        rows = _A()._users_exec(
            "SELECT content_type, data FROM community_app_slot_images "
            "WHERE slot_id=%s", (slot_id,), fetch=True)
        if not rows or rows[0].get("data") is None:
            raise HTTPException(status_code=404, detail="No image for this slot")
        data = bytes(rows[0]["data"])
        # Re-derive the type from the bytes (defense in depth; stored value
        # is already server-sniffed at upload).
        ctype = _sniff_image_type(data) or rows[0].get("content_type") \
            or "application/octet-stream"
        ext = _EXT_FOR.get(ctype, "img")
        return Response(
            content=data,
            media_type=ctype,
            headers={
                "Cache-Control": "private, max-age=31536000, immutable",
                "Content-Disposition": f'inline; filename="{slot_id}.{ext}"',
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy":
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            })

    @app.delete("/api/community-app/images/{slot_id}")
    def community_slot_delete(slot_id: str, request: Request):
        _require_page_user(request)
        if not _SLOT_RE.match(slot_id or ""):
            raise HTTPException(status_code=400, detail="Invalid slot id")
        _ensure_tables()
        rows = _A()._users_exec(
            "DELETE FROM community_app_slot_images WHERE slot_id=%s "
            "RETURNING slot_id", (slot_id,), fetch=True)
        return {"ok": True, "removed": bool(rows)}
