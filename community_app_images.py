"""Community App marketing and prototype imagery.

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
from pathlib import Path
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
_SHOP_CARD_TABLES_READY = False

# Editorial Shop shortcuts are deliberately an allowlisted, finite set rather
# than the open-ended prototype-slot namespace above. This keeps public media
# reads predictable and prevents the CRM upload form becoming an asset library.
# The filenames point to the supplied campaign images; defaults are inserted
# only for an empty slot, so a staff replacement always wins over later boots.
SHOP_CARD_SLOTS = (
    {
        "id": "delivery",
        "label": "Free Delivery",
        "default_file": "shop-card-_MG_1219_1787221628550.jpg",
    },
    {
        "id": "collection",
        "label": "New Arrivals",
        "default_file": "shop-card-_MG_5933_1787221628562.jpg",
    },
    {
        "id": "quiz",
        "label": "Take Your Quiz",
        "default_file": "shop-card-_MG_5998_1787221628564.jpg",
    },
    {
        "id": "curators",
        "label": "Curated Looks By",
        "default_file": "shop-card-DSC_0212_1787221628565.jpg",
    },
)
_SHOP_CARD_BY_ID = {slot["id"]: slot for slot in SHOP_CARD_SLOTS}
_SHOP_ASSET_DIR = Path(__file__).resolve().parent / "attached_assets"


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


async def _read_upload_with_limit(file: UploadFile) -> bytes:
    """Read at most MAX_FILE_BYTES plus one byte from an uploaded file.

    UploadFile is backed by a spooled temporary file, but calling read() with
    no limit would still copy an arbitrarily large multipart body into memory.
    Reading bounded chunks keeps the staff-only endpoint safe from oversized
    upload attempts before the image validator runs.
    """
    chunks = []
    total = 0
    while total <= MAX_FILE_BYTES:
        chunk = await file.read(min(1024 * 1024, MAX_FILE_BYTES + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Image is too large (max 5 MB).")
    return b"".join(chunks)


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


def _require_shop_card_staff(request: Request) -> dict:
    """Return the already-authenticated CRM user for a Shop-card mutation.

    `clerk_auth_gate` enforces an active session and a permitted CRM role for
    every /api/crm/* endpoint before this handler runs. Keeping this small,
    explicit assertion here makes the boundary obvious and fails closed should
    this module ever be mounted elsewhere.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def _ensure_shop_card_tables():
    """Create and seed the four persistent Shop-card image slots.

    The launch files are read once from the supplied workspace assets and
    inserted with ON CONFLICT DO NOTHING. Therefore defaults reach a new
    environment but can never overwrite a staff upload or a removed image.
    """
    global _SHOP_CARD_TABLES_READY
    if _SHOP_CARD_TABLES_READY:
        return
    _A()._users_exec("""
        CREATE TABLE IF NOT EXISTS community_shop_card_images (
            slot_id           TEXT PRIMARY KEY,
            content_type      TEXT NOT NULL,
            size_bytes        INT NOT NULL,
            data              BYTEA,
            version           INT NOT NULL DEFAULT 1,
            source            TEXT NOT NULL DEFAULT 'staff',
            uploaded_by       TEXT,
            uploaded_by_name  TEXT,
            uploaded_by_email TEXT,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    # A removed card is a durable empty slot (rather than a deleted row) so
    # the default-seed insert cannot resurrect it after a restart.
    _A()._users_exec(
        "ALTER TABLE community_shop_card_images ALTER COLUMN data DROP NOT NULL")
    for slot in SHOP_CARD_SLOTS:
        path = _SHOP_ASSET_DIR / slot["default_file"]
        try:
            data = path.read_bytes()
        except OSError as exc:
            # A missing seed must not make Shop unavailable. The frontend has a
            # designed fallback, and an operator can upload artwork from CRM.
            log.error("Shop-card default image unavailable (%s): %s", path, exc)
            continue
        ctype = _sniff_image_type(data)
        if ctype is None:
            log.error("Shop-card default image has an unsupported format: %s", path)
            continue
        _A()._users_exec("""
            INSERT INTO community_shop_card_images
                (slot_id, content_type, size_bytes, data, source, uploaded_by)
            VALUES (%s,%s,%s,%s,'default','system:seed')
            ON CONFLICT (slot_id) DO NOTHING
        """, (slot["id"], ctype, len(data), psycopg2.Binary(data)))
        # A previous boot may have seeded the original, camera-sized asset.
        # Upgrade only default rows whose file size differs from the optimized
        # seed; staff replacements and durable removals are never touched.
        _A()._users_exec("""
            UPDATE community_shop_card_images
               SET content_type = %s,
                   size_bytes = %s,
                   data = %s,
                   version = version + 1,
                   updated_at = now()
             WHERE slot_id = %s
               AND source = 'default'
               AND data IS NOT NULL
               AND size_bytes <> %s
        """, (ctype, len(data), psycopg2.Binary(data), slot["id"],
              len(data)))
    _SHOP_CARD_TABLES_READY = True


def seed_shop_card_defaults():
    """Startup hook used by api_pg after the port is bound."""
    _ensure_shop_card_tables()


def _shop_card_rows():
    _ensure_shop_card_tables()
    return _A()._users_exec("""
        SELECT slot_id, content_type, size_bytes, data IS NOT NULL AS has_image,
               version, source,
               uploaded_by_name, updated_at
          FROM community_shop_card_images
         ORDER BY slot_id
    """, fetch=True) or []


def _shop_card_manifest(public: bool):
    by_slot = {r["slot_id"]: r for r in _shop_card_rows()
               if r.get("slot_id") in _SHOP_CARD_BY_ID}
    cards = []
    for slot in SHOP_CARD_SLOTS:
        row = by_slot.get(slot["id"])
        card = {
            "id": slot["id"],
            "label": slot["label"],
            "image_url": (
                f"/api/community/shop-cards/{slot['id']}/image?v={int(row['version'])}"
                if row and row.get("has_image") else None
            ),
            "version": int(row["version"]) if row and row.get("has_image") else None,
        }
        if not public:
            card.update({
                "content_type": row.get("content_type") if row and row.get("has_image") else None,
                "size_bytes": int(row.get("size_bytes") or 0) if row else 0,
                "source": row.get("source") if row else None,
                "uploaded_by_name": row.get("uploaded_by_name") if row else None,
                "updated_at": (
                    row["updated_at"].isoformat() if row and row.get("updated_at")
                    else None
                ),
            })
        cards.append(card)
    return {"cards": cards}


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

    # ---- Public Shop shortcut artwork -------------------------------------
    # These reads intentionally live under /api/community/ so the customer
    # app's self-auth bypass applies. They reveal only the four active image
    # URLs; staff metadata and every mutation remain on /api/crm/.

    @app.get("/api/community/shop-cards")
    def public_shop_card_manifest():
        return _shop_card_manifest(public=True)

    @app.get("/api/community/shop-cards/{slot_id}/image")
    def public_shop_card_image(slot_id: str, v: str = ""):
        if slot_id not in _SHOP_CARD_BY_ID:
            raise HTTPException(status_code=404, detail="No image for this Shop card")
        try:
            requested_version = int(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=404, detail="No image for this Shop card")
        # Require a canonical, positive generation identifier. Serving an
        # unversioned URL with immutable caching would let its bytes change
        # after replacement, so every valid public image URL is generation-keyed.
        if requested_version < 1 or str(requested_version) != v:
            raise HTTPException(status_code=404, detail="No image for this Shop card")
        _ensure_shop_card_tables()
        rows = _A()._users_exec(
            "SELECT content_type, data, version FROM community_shop_card_images "
            "WHERE slot_id=%s", (slot_id,), fetch=True)
        if not rows or rows[0].get("data") is None:
            raise HTTPException(status_code=404, detail="No image for this Shop card")
        current_version = int(rows[0].get("version") or 0)
        if requested_version != current_version:
            # The cache headers below are intentionally immutable. Refuse old
            # and speculative versions so a URL can never serve changing bytes.
            raise HTTPException(status_code=404, detail="No image for this Shop card")
        data = bytes(rows[0]["data"])
        ctype = _sniff_image_type(data) or rows[0].get("content_type") \
            or "application/octet-stream"
        ext = _EXT_FOR.get(ctype, "img")
        return Response(
            content=data,
            media_type=ctype,
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Disposition": f'inline; filename="shop-card-{slot_id}.{ext}"',
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy":
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            })

    # ---- Protected CRM controls -------------------------------------------

    @app.get("/api/crm/community-shop-cards")
    def staff_shop_card_manifest(request: Request):
        _require_shop_card_staff(request)
        return _shop_card_manifest(public=False)

    @app.post("/api/crm/community-shop-cards/{slot_id}")
    async def staff_shop_card_upload(slot_id: str, request: Request,
                                     file: UploadFile = File(...)):
        user = _require_shop_card_staff(request)
        if slot_id not in _SHOP_CARD_BY_ID:
            raise HTTPException(status_code=400, detail="Unknown Shop card")
        data = await _read_upload_with_limit(file)
        if not data:
            raise HTTPException(
                status_code=400,
                detail="That file looks empty — choose an image file.")
        ctype = _sniff_image_type(data)
        if ctype is None:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file type — JPEG, PNG, GIF or WebP images only.")
        _ensure_shop_card_tables()
        rows = _A()._users_exec("""
            INSERT INTO community_shop_card_images
                (slot_id, content_type, size_bytes, data, source,
                 uploaded_by, uploaded_by_name, uploaded_by_email)
            VALUES (%s,%s,%s,%s,'staff',%s,%s,%s)
            ON CONFLICT (slot_id) DO UPDATE SET
                content_type      = EXCLUDED.content_type,
                size_bytes        = EXCLUDED.size_bytes,
                data              = EXCLUDED.data,
                version           = community_shop_card_images.version + 1,
                source            = 'staff',
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
        version = int(rows[0]["version"])
        return {
            "ok": True,
            "slot_id": slot_id,
            "version": version,
            "image_url": f"/api/community/shop-cards/{slot_id}/image?v={version}",
        }

    @app.delete("/api/crm/community-shop-cards/{slot_id}")
    def staff_shop_card_delete(slot_id: str, request: Request):
        _require_shop_card_staff(request)
        if slot_id not in _SHOP_CARD_BY_ID:
            raise HTTPException(status_code=400, detail="Unknown Shop card")
        _ensure_shop_card_tables()
        rows = _A()._users_exec("""
            UPDATE community_shop_card_images
               SET data = NULL,
                   size_bytes = 0,
                   source = 'removed',
                   version = version + 1,
                   uploaded_by = %s,
                   uploaded_by_name = %s,
                   uploaded_by_email = %s,
                   updated_at = now()
             WHERE slot_id = %s
         RETURNING slot_id
        """, (
            str(user.get("user_id") or user.get("id") or "") or None,
            user.get("name") or None,
            user.get("email") or None,
            slot_id,
        ), fetch=True)
        return {"ok": True, "removed": bool(rows)}
