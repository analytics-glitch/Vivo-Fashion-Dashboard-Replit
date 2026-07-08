"""
extract_fabric_images.py — pull fabric product photos from ODOO (the only image
source) into the Postgres `fabric_images` table so the Fabric dashboard serves
cached image bytes from our own backend.

Odoo is the CANONICAL and EXCLUSIVE fabric image source:
  * the template/variant primary photo (`image_1920`) is the "Face" photo,
    stored at idx=-1 (sorts first) with label 'Face';
  * each extra-media gallery photo (`product.image` on the product template)
    is stored at idx 0..n (ordered by sequence, then name) with its Odoo name
    as the label — the team names the reverse-side photo "Back" in Odoo.

The old Google-Drive pull and the staff-upload flow are RETIRED: `run_odoo`
deletes any leftover source='drive'/'upload' rows every run (idempotent), so
the cleanup also self-applies on prod via the sync-loop bootstrap.

Idempotent: upserts per (barcode, idx), prunes stale odoo rows. Runnable
standalone for a manual backfill:  python extract_fabric_images.py
Prod is a SEPARATE DB — this must run against prod (sync-loop bootstrap or a
one-off) before prod photos appear; verify with SELECT COUNT(*) FROM fabric_images.
"""
import os
import sys
import xmlrpc.client as _xmlrpc

import psycopg2

_ODOO_FABRIC_CATS = [18, 19]   # 18=Raw Materials-Fabric, 19=Accessories & Trims
_ODOO_IMG_IDX = -1             # canonical primary "Face" slot (sorts first)


def _log(msg):
    print(f"[fabric-images] {msg}", flush=True)


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
                source     TEXT    NOT NULL DEFAULT 'odoo',
                label      TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (barcode, idx)
            )""")
        cur.execute("ALTER TABLE fabric_images "
                    "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'odoo'")
        cur.execute("ALTER TABLE fabric_images "
                    "ADD COLUMN IF NOT EXISTS label TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_images_barcode "
                    "ON fabric_images(barcode)")
    conn.commit()


def _purge_legacy_sources(conn):
    """One-time (but idempotent, runs every sync) removal of the retired Drive
    and staff-upload photo rows — Odoo is now the exclusive source. Running
    inside the sync loop means the cleanup also self-applies on PROD after
    publish (prod is a separate DB)."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM fabric_images WHERE source IN ('drive','upload')")
        n = cur.rowcount or 0
    conn.commit()
    if n:
        _log(f"purged {n} legacy drive/upload image row(s)")
    return n


def run_odoo(conn=None, heartbeat=None):
    """Pull the primary image_1920 ('Face', idx=-1) AND the extra-media gallery
    photos (product.image on the template; idx 0..n, label = Odoo image name,
    conventionally 'Back') for fabric products with a barcode. Idempotent
    upsert + prune of stale odoo rows + purge of retired drive/upload rows."""
    url = os.environ.get("ODOO_URL"); db = os.environ.get("ODOO_DB")
    user = os.environ.get("ODOO_USER"); pw = os.environ.get("ODOO_PASSWORD")
    if not all([url, db, user, pw]):
        _log("odoo: env not set — skipping (no-op)")
        return 0
    own_conn = conn is None
    if own_conn:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        _ensure_table(conn)
        _purge_legacy_sources(conn)
        common = _xmlrpc.ServerProxy(f"{url}/xmlrpc/2/common")
        uid = common.authenticate(db, user, pw, {})
        models = _xmlrpc.ServerProxy(f"{url}/xmlrpc/2/object")
        ids = models.execute_kw(db, uid, pw, "product.product", "search",
            [[["categ_id", "in", _ODOO_FABRIC_CATS], ["barcode", "!=", False]]])
        _log(f"odoo: {len(ids)} fabric products with a barcode")
        seen = []          # barcodes with at least one stored image
        keep = []          # (barcode, idx) pairs written this run
        stored = 0
        tmpl_by_barcode = {}   # barcode -> template id (for the gallery pass)
        for i in range(0, len(ids), 100):
            chunk = ids[i:i+100]
            recs = models.execute_kw(db, uid, pw, "product.product", "read",
                [chunk], {"fields": ["barcode", "image_1920", "product_tmpl_id"]})
            with conn.cursor() as cur:
                for r in recs:
                    bc = (r.get("barcode") or "").strip()
                    if not bc:
                        continue
                    tmpl = r.get("product_tmpl_id")
                    tmpl_id = tmpl[0] if isinstance(tmpl, (list, tuple)) and tmpl else None
                    if tmpl_id:
                        tmpl_by_barcode[bc] = tmpl_id
                    img = r.get("image_1920")
                    if not img or len(img) < 100:
                        continue
                    seen.append(bc)
                    keep.append((bc, _ODOO_IMG_IDX))
                    cur.execute("""
                        INSERT INTO fabric_images
                            (barcode, idx, filename, mime, image_b64, source, label, updated_at)
                        VALUES (%s,%s,%s,'image/jpeg',%s,'odoo','Face',now())
                        ON CONFLICT (barcode, idx) DO UPDATE SET
                            image_b64=EXCLUDED.image_b64, mime='image/jpeg',
                            source='odoo', label='Face', filename=EXCLUDED.filename,
                            updated_at=now()
                    """, (bc, _ODOO_IMG_IDX, f"{bc}_odoo.jpg", img))
                    stored += 1
            conn.commit()
            if heartbeat:
                try:
                    heartbeat()
                except Exception:
                    pass

        # ── Extra-media gallery pass (product.image on the templates) ──
        # The team names the reverse-side photo "Back" in Odoo; whatever the
        # image is named becomes its carousel label.
        gallery = 0
        tmpl_ids = sorted(set(tmpl_by_barcode.values()))
        bc_by_tmpl = {}
        for bc, t in tmpl_by_barcode.items():
            bc_by_tmpl.setdefault(t, []).append(bc)
        for i in range(0, len(tmpl_ids), 200):
            chunk = tmpl_ids[i:i+200]
            try:
                imgs = models.execute_kw(db, uid, pw, "product.image", "search_read",
                    [[["product_tmpl_id", "in", chunk]]],
                    {"fields": ["name", "sequence", "image_1920", "product_tmpl_id"]})
            except Exception as e:
                _log(f"odoo: gallery read failed for a chunk: {e}")
                continue
            by_tmpl = {}
            for im in imgs:
                t = im.get("product_tmpl_id")
                t_id = t[0] if isinstance(t, (list, tuple)) and t else None
                if t_id and im.get("image_1920") and len(im["image_1920"]) >= 100:
                    by_tmpl.setdefault(t_id, []).append(im)
            with conn.cursor() as cur:
                for t_id, ims in by_tmpl.items():
                    ims.sort(key=lambda x: (x.get("sequence") or 0,
                                            (x.get("name") or "").lower()))
                    for bc in bc_by_tmpl.get(t_id, []):
                        for gidx, im in enumerate(ims):
                            label = (im.get("name") or "").strip() or "Back"
                            seen.append(bc)
                            keep.append((bc, gidx))
                            cur.execute("""
                                INSERT INTO fabric_images
                                    (barcode, idx, filename, mime, image_b64, source, label, updated_at)
                                VALUES (%s,%s,%s,'image/jpeg',%s,'odoo',%s,now())
                                ON CONFLICT (barcode, idx) DO UPDATE SET
                                    image_b64=EXCLUDED.image_b64, mime='image/jpeg',
                                    source='odoo', label=EXCLUDED.label,
                                    filename=EXCLUDED.filename, updated_at=now()
                            """, (bc, gidx, f"{bc}_odoo_{gidx}.jpg",
                                  im["image_1920"], label))
                            gallery += 1
            conn.commit()
            if heartbeat:
                try:
                    heartbeat()
                except Exception:
                    pass

        # Prune stale odoo rows: barcodes gone from Odoo AND per-barcode slots
        # no longer present (e.g. a gallery photo deleted in Odoo).
        with conn.cursor() as cur:
            seen_set = sorted(set(seen))
            if seen_set:
                cur.execute("DELETE FROM fabric_images "
                            "WHERE source='odoo' AND NOT (barcode = ANY(%s))",
                            (seen_set,))
                pruned = cur.rowcount or 0
                keep_set = set(keep)
                cur.execute("SELECT barcode, idx FROM fabric_images "
                            "WHERE source='odoo' AND barcode = ANY(%s)",
                            (seen_set,))
                stale = [(b, i) for (b, i) in cur.fetchall()
                         if (b, i) not in keep_set]
                for b, i in stale:
                    cur.execute("DELETE FROM fabric_images "
                                "WHERE source='odoo' AND barcode=%s AND idx=%s",
                                (b, i))
                pruned += len(stale)
            else:
                cur.execute("DELETE FROM fabric_images WHERE source='odoo'")
                pruned = cur.rowcount or 0
        conn.commit()
        _log(f"odoo: stored/updated {stored} primary + {gallery} gallery "
             f"images, pruned {pruned} stale")
        return stored + gallery
    finally:
        if own_conn:
            conn.close()


def run(conn=None, heartbeat=None):
    """RETIRED Drive pull — kept as a no-op shim so any stale caller is safe.
    Odoo (run_odoo) is now the exclusive fabric-image source."""
    _log("Drive fabric-image pull is retired — Odoo is the only source (no-op).")
    return {"status": "disabled", "reason": "odoo_only"}


if __name__ == "__main__":
    try:
        n = run_odoo()
    except Exception as e:
        _log(f"FAILED: {e}")
        sys.exit(1)
    _log(f"Done: {n} image(s)")
