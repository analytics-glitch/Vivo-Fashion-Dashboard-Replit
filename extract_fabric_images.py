"""
extract_fabric_images.py — pull fabric product photos from a Google Drive folder
into the Postgres `fabric_images` table so the Fabric dashboard serves cached
image bytes from our own backend (no live Drive fetch per open, no browser Google
credentials).

Matching: a photo belongs to a fabric by its FILENAME prefix = the fabric barcode.
    "304649.jpg", "304649-2.jpg", "304649_back.png"  → barcode "304649"
The leading run of alphanumerics (before the first separator / extension) is the
barcode; the bare-barcode file sorts first (idx 0), the rest follow alphabetically.

Auth: a Google **service account** (the connected google-sheet OAuth app only has
drive.file scope and cannot read pre-existing Drive files). Provide:
    FABRIC_IMAGES_GSA_JSON          — the service-account JSON key (whole file)
    FABRIC_IMAGES_DRIVE_FOLDER_ID   — the fabric-photos Drive folder id
Share the folder with the service account's client_email (Viewer). Missing either
secret makes this a NO-OP (dormant) — safe to wire into the sync loop before the
credential exists.

Idempotent: upserts one row per (barcode, idx); prunes per-barcode extras and, on
a successful non-empty pull, barcodes no longer present in Drive. Runnable
standalone for a manual backfill:  python extract_fabric_images.py
Prod is a SEPARATE DB — this must run against prod (sync-loop bootstrap or a
one-off) before prod photos appear; verify with SELECT COUNT(*) FROM fabric_images.
"""
import base64
import json
import os
import re
import sys

import psycopg2

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
FOLDER_ENV = "FABRIC_IMAGES_DRIVE_FOLDER_ID"
GSA_ENV = "FABRIC_IMAGES_GSA_JSON"

_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff")
_IMAGE_MIME_PREFIX = "image/"


def _log(msg):
    print(f"[fabric-images] {msg}", flush=True)


def derive_barcode(filename):
    """Barcode = the leading run of alphanumerics in the filename, before any
    separator (-, _, space, '.') or extension. Returns None if none found."""
    if not filename:
        return None
    m = re.match(r"^\s*([0-9A-Za-z]+)", str(filename))
    return m.group(1) if m else None


def _is_image(name, mime):
    if mime and mime.startswith(_IMAGE_MIME_PREFIX):
        return True
    low = (name or "").lower()
    return low.endswith(_IMAGE_EXTS)


def _service_account_token():
    """Mint a Drive-readonly bearer token from the service-account JSON secret.
    Returns None (dormant) when the secret is absent/blank. Raises on a malformed
    key so a real misconfiguration is visible in the logs."""
    raw = (os.environ.get(GSA_ENV) or "").strip()
    if not raw:
        return None
    try:
        info = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"{GSA_ENV} is not valid JSON: {e}")
    # Imported lazily so the module still imports (and byte-compiles) when
    # google-auth isn't present / the feature is dormant.
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request as GAuthRequest
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=[DRIVE_SCOPE])
    creds.refresh(GAuthRequest())
    return creds.token


def _drive_list_folder(token, folder_id):
    """List every non-trashed image file directly in the folder (paginated)."""
    import requests
    files = []
    page_token = None
    q = f"'{folder_id}' in parents and trashed = false"
    while True:
        params = {
            "q": q,
            "fields": "nextPageToken, files(id, name, mimeType)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        r = requests.get(
            "https://www.googleapis.com/drive/v3/files",
            headers={"Authorization": f"Bearer {token}"},
            params=params, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(
                f"Drive list failed ({r.status_code}): {r.text[:300]}")
        data = r.json()
        for f in data.get("files", []):
            if _is_image(f.get("name"), f.get("mimeType")):
                files.append(f)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


def _drive_download(token, file_id):
    import requests
    r = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media", "supportsAllDrives": "true"},
        timeout=120)
    if r.status_code != 200:
        raise RuntimeError(
            f"Drive download {file_id} failed ({r.status_code}): {r.text[:200]}")
    return r.content


def _guess_mime(name):
    low = (name or "").lower()
    if low.endswith((".png",)):
        return "image/png"
    if low.endswith((".webp",)):
        return "image/webp"
    if low.endswith((".gif",)):
        return "image/gif"
    if low.endswith((".bmp",)):
        return "image/bmp"
    if low.endswith((".tif", ".tiff")):
        return "image/tiff"
    return "image/jpeg"


def _sort_key(name, barcode):
    """Bare-barcode file first (idx 0), then the rest alphabetically. The suffix
    is whatever follows the barcode before the extension."""
    base = name.rsplit(".", 1)[0]
    suffix = base[len(barcode):] if base.startswith(barcode) else base
    return (0 if suffix == "" else 1, name.lower())


def _ensure_table(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_images (
                barcode    TEXT    NOT NULL,
                idx        INTEGER NOT NULL,
                filename   TEXT,
                mime       TEXT    NOT NULL DEFAULT 'image/jpeg',
                image_b64  TEXT    NOT NULL,
                drive_id   TEXT,
                source     TEXT    NOT NULL DEFAULT 'drive',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (barcode, idx)
            )""")
        # `source` tells Drive-sourced rows apart from staff uploads; this extract
        # only ever writes/prunes source='drive' rows so uploads survive a resync.
        cur.execute("ALTER TABLE fabric_images "
                    "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'drive'")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_images_barcode "
                    "ON fabric_images(barcode)")
    conn.commit()


def _store_barcode(conn, barcode, items):
    """Replace a barcode's stored images with `items` (ordered list of
    {filename, mime, b64, drive_id}). Idempotent: upsert idx 0..n, prune extras."""
    with conn.cursor() as cur:
        for idx, it in enumerate(items):
            # Drive photos always occupy idx 0..n; staff uploads live in a high
            # idx range (>= 100000, source='upload'), so this never collides with
            # an upload. Stamp source='drive' so the guarded prune below can tell
            # them apart.
            cur.execute("""
                INSERT INTO fabric_images
                    (barcode, idx, filename, mime, image_b64, drive_id, source, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, 'drive', now())
                ON CONFLICT (barcode, idx) DO UPDATE SET
                    filename   = EXCLUDED.filename,
                    mime       = EXCLUDED.mime,
                    image_b64  = EXCLUDED.image_b64,
                    drive_id   = EXCLUDED.drive_id,
                    source     = 'drive',
                    updated_at = now()
            """, (barcode, idx, it["filename"], it["mime"],
                  it["b64"], it.get("drive_id")))
        # Prune trailing Drive rows only — never touch staff uploads.
        cur.execute("DELETE FROM fabric_images "
                    "WHERE barcode=%s AND idx>=%s AND source='drive'",
                    (barcode, len(items)))
    conn.commit()


def run(conn=None, heartbeat=None):
    """Pull all fabric photos from Drive into `fabric_images`. Returns a summary
    dict. NO-OP (dormant) when the service-account secret or folder id is absent.
    `heartbeat` (optional callable) is pulsed between downloads so a supervised
    sync loop doesn't kill a long pull."""
    folder_id = (os.environ.get(FOLDER_ENV) or "").strip()
    if not folder_id:
        _log(f"{FOLDER_ENV} not set — skipping (dormant).")
        return {"status": "dormant", "reason": "no_folder_id"}
    token = _service_account_token()
    if not token:
        _log(f"{GSA_ENV} not set — skipping (dormant).")
        return {"status": "dormant", "reason": "no_credentials"}

    _log(f"Listing Drive folder {folder_id} …")
    files = _drive_list_folder(token, folder_id)
    _log(f"Found {len(files)} image file(s).")

    # Group by barcode.
    by_barcode = {}
    skipped = 0
    for f in files:
        bc = derive_barcode(f.get("name"))
        if not bc:
            skipped += 1
            continue
        by_barcode.setdefault(bc, []).append(f)

    owns_conn = conn is None
    if owns_conn:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        _ensure_table(conn)
        n_images = 0
        for bc, group in by_barcode.items():
            group.sort(key=lambda f: _sort_key(f.get("name", ""), bc))
            items = []
            for f in group:
                if heartbeat:
                    try:
                        heartbeat()
                    except Exception:
                        pass
                raw = _drive_download(token, f["id"])
                items.append({
                    "filename": f.get("name"),
                    "mime": (f.get("mimeType") if (f.get("mimeType") or "")
                             .startswith(_IMAGE_MIME_PREFIX)
                             else _guess_mime(f.get("name"))),
                    "b64": base64.b64encode(raw).decode("ascii"),
                    "drive_id": f.get("id"),
                })
            _store_barcode(conn, bc, items)
            n_images += len(items)

        # Prune barcodes that vanished from Drive — only when we actually saw
        # some (guards against an empty/failed listing wiping everything).
        pruned = 0
        if by_barcode:
            with conn.cursor() as cur:
                seen = list(by_barcode.keys())
                cur.execute(
                    "DELETE FROM fabric_images "
                    "WHERE source='drive' AND NOT (barcode = ANY(%s))",
                    (seen,))
                pruned = cur.rowcount or 0
            conn.commit()
    finally:
        if owns_conn:
            conn.close()

    _log(f"Stored {n_images} image(s) across {len(by_barcode)} barcode(s); "
         f"skipped {skipped} unmatched; pruned {pruned} stale row(s).")
    return {
        "status": "ok",
        "barcodes": len(by_barcode),
        "images": n_images,
        "skipped": skipped,
        "pruned": pruned,
    }


if __name__ == "__main__":
    try:
        result = run()
    except Exception as e:
        _log(f"FAILED: {e}")
        sys.exit(1)
    _log(f"Done: {result}")
