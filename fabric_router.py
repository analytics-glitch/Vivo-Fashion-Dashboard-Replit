"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
import base64
import datetime
from zoneinfo import ZoneInfo
import json
import math
import os
import re
from urllib.parse import quote
import psycopg2.extras
from fastapi import APIRouter, Query, Request, Body, HTTPException
from fastapi.responses import Response

import fabric_sheet_override as ov

fabric_router = APIRouter(tags=["fabric"])


def _odoo_product_url(product_id):
    """Build a deep link to an Odoo product.product form so a buyer can open the
    fabric and fill in its Width/GSM or a stored kg/m. `product_id` is the Odoo
    product.product id (= raw_fabric_products.id / mo_fabric_consumption.component_id).
    Returns None when there is no id or ODOO_URL is not configured (so the UI can
    simply omit the link rather than render a broken one)."""
    base = (os.environ.get("ODOO_URL") or "").rstrip("/")
    if not base or not product_id:
        return None
    return f"{base}/web#id={int(product_id)}&model=product.product&view_type=form"

# Manual buying-team reservations are stored in an app-owned table created lazily
# (idempotent) the first time a reservation endpoint is hit. This is distinct from
# Odoo's own `raw_fabric_inventory.reserved_qty` (ERP allocations).
_FABRIC_TABLES_READY = False

# The Jan–Apr 2026 consumption/returns sheet override (see fabric_sheet_override.py)
# replaces Odoo's inflated moves for that window. Every consumption/returns read
# goes through the `fabric_moves_effective` view (= ov.EFFECTIVE_MOVES) instead of
# raw_fabric_moves; the view is created lazily here, mirroring _ensure_fabric_tables.
EFFECTIVE_MOVES = ov.EFFECTIVE_MOVES
_FABRIC_SHEET_READY = False

def _ensure_fabric_sheet(conn):
    """Create the override tables + the unified view (idempotent, once per process).
    The view needs raw_fabric_moves/products to exist; if they don't yet (fresh DB),
    create the tables now and retry the view on a later call."""
    global _FABRIC_SHEET_READY
    if _FABRIC_SHEET_READY:
        return
    with conn.cursor() as cur:
        ov.ensure_tables(cur)
        ready = ov.base_tables_exist(cur)
        if ready:
            ov.ensure_view(cur)
    conn.commit()
    if ready:
        _FABRIC_SHEET_READY = True

def _ensure_fabric_tables(conn):
    global _FABRIC_TABLES_READY
    if _FABRIC_TABLES_READY:
        return
    with conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS fabric_reservations (
                id               SERIAL PRIMARY KEY,
                product_id       INTEGER NOT NULL,
                qty              NUMERIC NOT NULL,
                uom              TEXT NOT NULL,
                qty_kg           NUMERIC NOT NULL,
                style_name       TEXT NOT NULL,
                note             TEXT,
                status           TEXT NOT NULL DEFAULT 'active',
                reserved_by      TEXT,
                reserved_by_name TEXT,
                reserved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                used_at          TIMESTAMPTZ,
                used_by          TEXT
            )""")
        # style_number: the garment style's identifier from the BI product
        # master, captured when the reservation is created via the strict style
        # picker. Nullable — legacy free-text reservations have no number.
        cur.execute("ALTER TABLE fabric_reservations "
                    "ADD COLUMN IF NOT EXISTS style_number TEXT")
        # Aging/expiry bookkeeping: aging_notified_at stamps the one-time
        # 14-day "still open" bell notification; expired_at stamps the lazy
        # auto-expiry (status flips to 'expired' and the qty frees up again).
        cur.execute("ALTER TABLE fabric_reservations "
                    "ADD COLUMN IF NOT EXISTS aging_notified_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE fabric_reservations "
                    "ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ")
        # Per-user persisted bell notifications (read by /api/notifications in
        # api_pg). dedupe_key makes every notify idempotent — re-running a sweep
        # can never double-notify (INSERT ... ON CONFLICT DO NOTHING).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_notifications (
                id          SERIAL PRIMARY KEY,
                user_id     TEXT NOT NULL,
                type        TEXT NOT NULL,
                title       TEXT NOT NULL,
                message     TEXT,
                link        TEXT,
                dedupe_key  TEXT UNIQUE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                read_at     TIMESTAMPTZ
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_user_notif_user "
                    "ON user_notifications(user_id, read_at)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_resv_product "
                    "ON fabric_reservations(product_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_resv_status "
                    "ON fabric_reservations(status)")
        # Manual physical-roll counts the fabric team hand-maintains per fabric
        # product per stock location. Odoo only knows quantity by weight/length,
        # not the number of physical rolls, so this is a purely manual figure
        # (admin-editable) shown alongside the Odoo qty for eyeballing. Keyed by
        # (product_id, location_name); the audit fields stamp who set it + when.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_roll_counts (
                product_id      INTEGER NOT NULL,
                location_name   TEXT NOT NULL,
                rolls           INTEGER NOT NULL DEFAULT 0,
                updated_by      TEXT,
                updated_by_name TEXT,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (product_id, location_name)
            )""")
        # Indexes on the core fabric read tables — wrapped in a DO/IF guard
        # so they are safe to create even when the Odoo extract hasn't run
        # yet (tables absent = guard fires, no error). IF NOT EXISTS makes
        # every subsequent call a no-op once _FABRIC_TABLES_READY is set.
        cur.execute("""
            DO $$
            BEGIN
                IF to_regclass('public.raw_fabric_moves') IS NOT NULL THEN
                    CREATE INDEX IF NOT EXISTS idx_rfm_product_id
                        ON raw_fabric_moves(product_id);
                    CREATE INDEX IF NOT EXISTS idx_rfm_date
                        ON raw_fabric_moves(date);
                    CREATE INDEX IF NOT EXISTS idx_rfm_move_types
                        ON raw_fabric_moves(move_type, location_from, location_to);
                END IF;
                IF to_regclass('public.raw_fabric_inventory') IS NOT NULL THEN
                    CREATE INDEX IF NOT EXISTS idx_rfi_product_id
                        ON raw_fabric_inventory(product_id);
                    CREATE INDEX IF NOT EXISTS idx_rfi_location_name
                        ON raw_fabric_inventory(location_name);
                END IF;
            END $$;
        """)
    conn.commit()
    _FABRIC_TABLES_READY = True

# ── Fabric product images (barcode-keyed, ODOO-only) ────────────────
# Fabric photos come EXCLUSIVELY from Odoo: the template's primary image
# ("Face", idx=-1) plus its extra-media gallery photos (idx 0..n, label = the
# Odoo image name, conventionally "Back"). extract_fabric_images.run_odoo pulls
# them into `fabric_images` (base64, one row per image, ordered by `idx`) so the
# dashboard serves cached bytes from our own API. The old Drive/upload sources
# are retired (the extract purges leftover rows; the endpoints below only ever
# serve source='odoo'). Table is created lazily (idempotent), mirroring
# _ensure_fabric_tables. Prod is a SEPARATE DB, so it stays empty until the
# sync-loop bootstrap populates it after publish.
_FABRIC_IMAGES_READY = False

def _ensure_fabric_images_table(conn):
    global _FABRIC_IMAGES_READY
    if _FABRIC_IMAGES_READY:
        return
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
        # Older tables predate `source`/`label`; add them so the Odoo-only
        # filter and the Face/Back labels work on an existing DB.
        cur.execute("ALTER TABLE fabric_images "
                    "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'odoo'")
        cur.execute("ALTER TABLE fabric_images "
                    "ADD COLUMN IF NOT EXISTS label TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_images_barcode "
                    "ON fabric_images(barcode)")
    conn.commit()
    _FABRIC_IMAGES_READY = True

@fabric_router.get("/api/fabric/images/{barcode}")
def fabric_images_list(barcode: str):
    """List the stored ODOO photos for a fabric barcode, in display order
    (primary "Face" first, then the gallery photos). Each entry carries a
    `label` ("Face" / "Back" / the Odoo gallery-image name) and a `url`
    pointing at our own cached-bytes endpoint. Empty list when none, so the
    popup shows a friendly placeholder."""
    barcode = (barcode or "").strip()
    if not barcode:
        return {"barcode": barcode, "count": 0, "images": []}
    with _get_conn() as conn:
        _ensure_fabric_images_table(conn)
        rows = q(conn,
                 "SELECT idx, filename, label FROM fabric_images "
                 "WHERE barcode=%s AND source='odoo' ORDER BY idx", (barcode,))
    images = [{
        "idx": r["idx"],
        "filename": r["filename"],
        "label": (r.get("label") or "").strip()
                 or ("Face" if i == 0 else "Back"),
        "url": "/api/fabric/image/" + quote(barcode, safe="") + "/" + str(r["idx"]),
    } for i, r in enumerate(rows)]
    return {"barcode": barcode, "count": len(images), "images": images}

@fabric_router.get("/api/fabric/images-index")
def fabric_images_index():
    """Barcode -> first stored photo idx, for every fabric that has at least one
    photo. One tiny query so the register table can render thumbnails without a
    per-row probe (and without 404 churn for fabrics that have no photo)."""
    with _get_conn() as conn:
        _ensure_fabric_images_table(conn)
        rows = q(conn,
                 "SELECT barcode, MIN(idx) AS idx FROM fabric_images "
                 "WHERE source='odoo' GROUP BY barcode")
    return {"barcodes": {r["barcode"]: r["idx"] for r in rows}}

@fabric_router.get("/api/fabric/image/{barcode}/{idx}")
def fabric_image_bytes(barcode: str, idx: int):
    """Serve one stored fabric photo as raw image bytes (long-cached). 404 when
    the (barcode, idx) has no stored image so the frontend falls back cleanly."""
    barcode = (barcode or "").strip()
    if not barcode:
        return Response(status_code=404)
    with _get_conn() as conn:
        _ensure_fabric_images_table(conn)
        rows = q(conn,
                 "SELECT image_b64, mime FROM fabric_images "
                 "WHERE barcode=%s AND idx=%s AND source='odoo'",
                 (barcode, idx))
    if not rows or not rows[0].get("image_b64"):
        return Response(status_code=404)
    try:
        raw = base64.b64decode(rows[0]["image_b64"])
    except Exception:
        return Response(status_code=404)
    return Response(content=raw,
                    media_type=rows[0].get("mime") or "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})

# Staff uploads are RETIRED — fabric photos are maintained in Odoo only
# (primary = "Face", extra-media gallery photo named "Back" = Back). The old
# POST route now answers 410 Gone so any stale client gets a clear message
# instead of silently writing rows the Odoo-only reads would never serve.
@fabric_router.post("/api/fabric/images/{barcode}")
async def fabric_image_upload(barcode: str):
    raise HTTPException(
        status_code=410,
        detail="Fabric photo uploads are retired — add photos to the product "
               "in Odoo instead (primary image = Face; extra media image "
               "named 'Back' = Back).")

def _fabric_actor(request):
    """(user_id, name) for the current signed-in user, mirroring CRM's actor helper."""
    u = getattr(request.state, "user", None) or {}
    uid = u.get("user_id") or u.get("id") or "system"
    name = u.get("name") or u.get("email") or "system"
    return uid, name

def _fabric_actor_email(request):
    """The signed-in user's email (for the change-log audit trail), '' if unknown."""
    u = getattr(request.state, "user", None) or {}
    return u.get("email") or ""

def _log_fabric_change(action, resv, request):
    """Best-effort: file a reservation change into the Google-Sheet audit log.
    NEVER raises (the helper swallows/logs errors in a daemon thread)."""
    try:
        import fabric_change_log
        _uid, name = _fabric_actor(request)
        fabric_change_log.log_change(action, resv, name,
                                     _fabric_actor_email(request))
    except Exception:
        pass

def _resv_for_log(conn, resv_id):
    """Reservation row enriched with the fabric product name, for the audit log."""
    rows = q(conn, """
        SELECT r.id, r.qty, r.uom, r.style_name, r.style_number, r.note, r.status,
               p.name AS product
        FROM fabric_reservations r
        LEFT JOIN raw_fabric_products p ON p.id = r.product_id
        WHERE r.id=%s
    """, (resv_id,))
    return rows[0] if rows else None

def _get_conn():
    """Use the main app's connection pool."""
    import sys, os
    sys.path.insert(0, '/home/runner/workspace')
    # Import lazily to avoid circular import at module load time
    import importlib
    api = importlib.import_module('api_pg')
    return api.get_conn()

def _get_api():
    """Lazy import of api_pg to access the shared SWR cache layer."""
    import sys, importlib
    sys.path.insert(0, '/home/runner/workspace')
    return importlib.import_module('api_pg')

_MO_CONS_COLS_READY = False

def _ensure_mo_cons_cols():
    """Lazily add the accessories-support columns to mo_fabric_consumption
    (idempotent, once per process, own pooled connection). Readers filter on
    is_main_fabric, so the column must exist even on a DB whose extract has
    not yet re-run with the widened schema. ALTER TABLE IF EXISTS makes this
    a no-op on a fresh DB where the extract hasn't created the table at all."""
    global _MO_CONS_COLS_READY
    if _MO_CONS_COLS_READY:
        return
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                ALTER TABLE IF EXISTS mo_fabric_consumption
                    ADD COLUMN IF NOT EXISTS is_main_fabric BOOLEAN NOT NULL DEFAULT TRUE;
                ALTER TABLE IF EXISTS mo_fabric_consumption
                    ADD COLUMN IF NOT EXISTS unit_cost_mo NUMERIC;
            """)
        conn.commit()
        _MO_CONS_COLS_READY = True
    except Exception:
        conn.rollback()
    finally:
        conn.close()

def q(conn, sql, params=()):
    # Every fabric read funnels through here, so this is the one choke point
    # where the support-override table can be lazily ensured before any query
    # that embeds _scope_sql (which subselects from it) runs. Uses its OWN
    # pooled connection so it never disturbs the caller's transaction.
    _ensure_support_overrides()
    if "mo_fabric_consumption" in sql:
        _ensure_mo_cons_cols()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]

# ── Consumption / returns model ─────────────────────────────
# Consumption is measured strictly at the raw-material EXIT point — the moment
# fabric leaves the raw-material store RMAT/Stock:
#   * consumption (adds) — an INTERNAL move RMAT/Stock → PROD/Stock (into production)
#     or RMAT/Stock → Samp/Fabric (pulled to make samples). A plain OUT move (e.g. a
#     downstream PROD/Stock → Virtual Locations/Production leg) does NOT count.
# Some of it comes back as a return:
#   * returns (nets off) — an INTERNAL move whose location_to is RMAT/Stock, coming
#     from production (Virtual Locations/Production) OR any real (non-virtual) stock
#     location. Inventory-adjustment write-ons
#     (Virtual Locations/Inventory adjustment → RMAT/Stock) are stock-count
#     corrections, not returned fabric, and are excluded.
# Net consumption = (RMAT→PROD/Stock + RMAT→Samp) − (genuine returns into RMAT/Stock).
# Location literals are single fixed values (returns use split_part, never LIKE '%'),
# which also avoids the psycopg2 literal-% trap on the no-param queries.
PROD_LOC = "Virtual Locations/Production"
STOCK_LOC = "RMAT/Stock"          # the raw-material fabric store (consumption exits here)
PROD_STOCK_LOC = "PROD/Stock"     # the production real-stock location (an RMAT exit target)
SAMP_LOC = "Samp/Fabric"          # the sampling location (an RMAT exit target)

def _kg(alias="m"):
    return f"(CASE WHEN {alias}.uom='g' THEN {alias}.qty/1000 ELSE {alias}.qty END)"

def _consume_pred(alias="m"):
    """Consumption is booked at the raw-material EXIT point: an INTERNAL move OUT of
    RMAT/Stock into production real-stock (PROD/Stock) or the sampling location
    (Samp/Fabric). Nothing else counts — a plain 'OUT' move (e.g.
    PROD/Stock → Virtual Locations/Production) is a downstream leg, not the
    raw-material exit, and is deliberately excluded. All location literals are single
    fixed values (no LIKE), so the no-param q() queries dodge the literal-% trap."""
    return (f"{alias}.move_type='INTERNAL' "
            f"AND {alias}.location_from = '{STOCK_LOC}' "
            f"AND {alias}.location_to IN ('{PROD_STOCK_LOC}', '{SAMP_LOC}')")

def _rmat_return_pred(alias="m"):
    """A genuine physical return INTO the raw-material store: an INTERNAL move whose
    location_to = RMAT/Stock, coming from production ('Virtual Locations/Production')
    OR from any real (non-virtual) stock location (PROD/Stock, FABPR/Stock,
    Samp/Fabric, …). Inventory-adjustment write-ons
    ('Virtual Locations/Inventory adjustment' → RMAT/Stock) are stock-count
    corrections, NOT returned fabric, and are excluded — we keep the production
    virtual location but drop every other 'Virtual Locations/...' source.
    `split_part(..., '/', 1)` (not LIKE '%') dodges the psycopg2 literal-% trap on
    the no-param queries."""
    return (f"{alias}.move_type='INTERNAL' "
            f"AND {alias}.location_to = '{STOCK_LOC}' "
            f"AND (split_part({alias}.location_from, '/', 1) <> 'Virtual Locations' "
            f"OR {alias}.location_from = '{PROD_LOC}')")

def _net_kg(alias="m"):
    """Signed kg per move row: +kg for consumption (RMAT/Stock → PROD/Stock or
    Samp/Fabric), −kg for genuine returns back into RMAT/Stock. Inventory-adjustment
    write-ons into RMAT/Stock are excluded from the return leg. Kept in lockstep with
    `_net_cons_where`."""
    kg = _kg(alias)
    return (f"CASE WHEN {_consume_pred(alias)} THEN {kg} "
            f"WHEN {_rmat_return_pred(alias)} THEN -{kg} "
            f"ELSE 0 END")

def _net_cons_where(alias="m"):
    """Rows that make up net consumption: the RMAT-exit consumption legs plus the
    genuine returns back into RMAT/Stock (inventory-adjustment write-ons excluded).
    Identical leg definitions to `_net_kg` so every dependent metric stays
    consistent."""
    return (f"(({_consume_pred(alias)}) "
            f"OR ({_rmat_return_pred(alias)})) "
            f"AND {alias}.uom IN ('g','kg') "
            f"AND {alias}.is_fabric")

# Number of weeks in a calendar month, used to turn a monthly average run-rate
# into a weekly run-rate for weeks-of-cover.
WEEKS_PER_MONTH = 52.0 / 12.0
DAYS_PER_MONTH = 30.4375

# ── Vivo Colour Directory 2025 ──────────────────────────────
# Canonical fabric-colour → primary-colour map (98 fabric colours → 14 primary
# colours). Used to derive a clean colour breakdown of fabric stock from the
# messy source columns (the DB `primary_color` is empty and `fabric_color` is
# inconsistent), primarily by parsing each product's name. Casing here IS the
# canonical output casing.
_FABRIC_COLOR_DIRECTORY = {
    "Black": "Black",
    "Baby Blue": "Blue", "Blue": "Blue", "Dark Blue": "Blue", "Dark Teal": "Blue",
    "Denim Blue": "Blue", "Light Blue": "Blue", "Light Teal": "Blue",
    "Navy Blue": "Blue", "Royal Blue": "Blue", "Teal": "Blue", "Turquoise": "Blue",
    "Beige": "Brown", "Brown": "Brown", "Caramel": "Brown", "Chocolate Brown": "Brown",
    "Dark Beige": "Brown", "Dark Brown": "Brown", "Dark Tan": "Brown", "Dark Taupe": "Brown",
    "Khaki Beige": "Brown", "Khaki Brown": "Brown", "Light Beige": "Brown",
    "Light Brown": "Brown", "Light Tan": "Brown", "Light Taupe": "Brown",
    "Sand": "Brown", "Tan": "Brown", "Taupe": "Brown",
    "Army Green": "Green", "Dark Green": "Green", "Dark Olive Green": "Green",
    "Emerald Green": "Green", "Forest Green": "Green", "Green": "Green",
    "Hunters Green": "Green", "Jungle Green": "Green", "Khaki Green": "Green",
    "Light Green": "Green", "Light Olive Green": "Green", "Lime Green": "Green",
    "Neon Green": "Green", "Olive Green": "Green", "Sea Green": "Green",
    "Dark Grey": "Grey", "Grey": "Grey", "Khaki Grey": "Grey", "Light Grey": "Grey",
    "Brass": "Metallic", "Copper": "Metallic", "Gold": "Metallic", "Silver": "Metallic",
    "Multicolor": "Multicolor",
    "None": "None",
    "Burnt Orange": "Orange", "Coral": "Orange", "Dark Orange": "Orange",
    "Dark Rust": "Orange", "Light Orange": "Orange", "Light Rust": "Orange",
    "Orange": "Orange", "Peach": "Orange", "Rust": "Orange",
    "Dark Pink": "Pink", "Dusty Pink": "Pink", "Fuchsia": "Pink", "Light Pink": "Pink",
    "Magenta": "Pink", "Neon Pink": "Pink", "Pink": "Pink", "Rose Pink": "Pink",
    "Bright Purple": "Purple", "Dark Purple": "Purple", "Light Purple": "Purple",
    "Lilac": "Purple", "Plum": "Purple", "Purple": "Purple", "Violet": "Purple",
    "Burgundy": "Red", "Dark Burgundy": "Red", "Dark Maroon": "Red", "Dark Red": "Red",
    "Light Burgundy": "Red", "Light Red": "Red", "Maroon": "Red", "Red": "Red",
    "Cream": "White", "Ivory": "White", "Off White": "White", "White": "White",
    "Bright Yellow": "Yellow", "Buttermilk": "Yellow", "Dark Mustard": "Yellow",
    "Light Mustard": "Yellow", "Lime Yellow": "Yellow", "Marigold": "Yellow",
    "Mustard": "Yellow", "Yellow": "Yellow",
}

# Common short forms found in product names → canonical directory fabric colour.
_FABRIC_COLOR_ALIASES = {
    "navy": "Navy Blue",
    "olive": "Olive Green",
    "chocolate": "Chocolate Brown",
    "denim": "Denim Blue",
    "royal": "Royal Blue",
    "emerald": "Emerald Green",
    "forest": "Forest Green",
    "army": "Army Green",
    "jungle": "Jungle Green",
    "hunter": "Hunters Green",
    "hunters": "Hunters Green",
    "lime": "Lime Green",
    "charcoal": "Dark Grey",
    "wine": "Burgundy",
    "dusty rose": "Dusty Pink",
    "aqua": "Turquoise",
}

def _build_color_match_list():
    """Match candidates = every directory fabric colour + every alias, lowercased,
    sorted longest-first so the most-specific phrase wins (e.g. 'Olive Green'
    before 'Green', 'Light Blue' before 'Blue')."""
    cands = {}
    for canon in _FABRIC_COLOR_DIRECTORY:
        if canon == "None":
            continue
        cands[canon.lower()] = canon
    for alias, canon in _FABRIC_COLOR_ALIASES.items():
        cands.setdefault(alias.lower(), canon)
    return sorted(cands.items(), key=lambda kv: len(kv[0]), reverse=True)

_COLOR_MATCH_LIST = _build_color_match_list()

def _match_fabric_color(text):
    """Scan free text (case-insensitive) for any directory fabric colour or alias,
    returning the canonical fabric colour (most-specific/longest match wins).
    Matching is token-aware (non-alphanumerics become word breaks) so a colour
    never matches inside another word. Returns None when nothing resolves."""
    if not text:
        return None
    norm = " " + re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip() + " "
    for phrase, canon in _COLOR_MATCH_LIST:
        if " " + phrase + " " in norm:
            return canon
    return None

def _derive_fabric_colors(name, fabric_color):
    """Resolve (fabric_color, primary_color) for a fabric product: first parse the
    product name, then fall back to the source `fabric_color` column run through
    the same matcher. Returns (None, None) when neither resolves."""
    fc = _match_fabric_color(name)
    if not fc:
        fc = _match_fabric_color(fabric_color)
    if not fc:
        return None, None
    return fc, _FABRIC_COLOR_DIRECTORY.get(fc)

def _months_of_cover(conn, fabric_stock_kg, scope="main", product_ids=None):
    """Months-of-cover from a trailing 6-fully-completed-months average monthly
    run-rate (no current-month projection).

    The window is the 6 most-recent COMPLETED calendar months (M-6 .. M-1); the
    current, in-progress month is excluded entirely. The denominator is total net
    consumption over those 6 months ÷ 6, so it rolls automatically and self-heals
    as months advance (e.g. in August the window becomes Feb–Jul). Consumption
    stays net-of-production-returns + fabric-only via the shared net-consumption
    model.
    """
    fabric_stock_kg = float(fabric_stock_kg or 0)
    # When a curated product-id set is supplied (e.g. the Basic Fabrics KPI) the
    # consumption universe is JUST those products — the support/main scope filter
    # is bypassed entirely. Ids come straight from the DB (integers), so inlining
    # them is injection-safe.
    if product_ids is not None:
        if not product_ids:
            cons_scope = "FALSE"
        else:
            ids_csv = ",".join(str(int(i)) for i in product_ids)
            cons_scope = f"m.product_id IN ({ids_csv})"
    else:
        cons_scope = _scope_sql(scope)
    months = q(conn, f"""
        SELECT to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
               SUM({_net_kg('m')})::numeric AS kg
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE {_net_cons_where('m')}
          AND {cons_scope}
          AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date
          AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
        GROUP BY 1
    """)
    mon_kg = {r['mon']: float(r['kg'] or 0) for r in months}
    today = q(conn, "SELECT CURRENT_DATE AS today")[0]['today']

    def _key(delta):
        idx = today.year * 12 + (today.month - 1) + delta
        return f"{idx // 12:04d}-{idx % 12 + 1:02d}"

    complete = [_key(d) for d in range(-6, 0)]   # M-6 .. M-1 (last 6 completed months)

    sum_complete = sum(mon_kg.get(k, 0.0) for k in complete)
    avg_monthly = sum_complete / 6.0
    cover_now = (fabric_stock_kg / avg_monthly) if avg_monthly > 0 else None

    # Status lets the frontend degrade gracefully instead of collapsing a card
    # with real stock to a bare "—". Three cases:
    #   "ok"          – run-rate present, months_of_cover is a real number.
    #   "overstocked" – stock on hand but ZERO consumption over the trailing 6
    #                   completed months, so the divide is undefined yet cover is
    #                   effectively "very high" (a genuinely slow staple, or
    #                   mid-rebuild). Render a capped "12+"/"no recent use"
    #                   marker, not a dash.
    #   "no_data"     – neither stock nor consumption (truly nothing to show).
    if avg_monthly > 0:
        cover_status = "ok"
    elif fabric_stock_kg > 0:
        cover_status = "overstocked"
    else:
        cover_status = "no_data"

    return {
        "months_of_cover": round(cover_now, 2) if cover_now is not None else None,
        "months_of_cover_status": cover_status,
        "months_of_cover_stock_kg": round(fabric_stock_kg, 1),
        "avg_monthly_consumption_kg": round(avg_monthly, 1),
        "cover_window_months": 6,
        # The per-month net-consumption breakdown for the 6 completed months in
        # the window (M-6 .. M-1), so a daily snapshot can record the exact inputs
        # behind the denominator without re-deriving them.
        "months_breakdown": [
            {"month": k, "kg": round(mon_kg.get(k, 0.0), 1)} for k in complete
        ],
    }

def _months_of_cover_prev_month(conn, fabric_stock_kg, scope="main", product_ids=None):
    """Months-of-cover derived from ONLY the previous FULL calendar month's (M-1)
    net consumption run-rate, giving a more reactive cover signal than the trailing
    6-month average.

    The window is exactly the previous completed calendar month (the current,
    in-progress month is excluded). Consumption stays net-of-production-returns +
    fabric-only via the shared net-consumption model, and honours the support/main
    scope (or a curated product-id set), identically to `_months_of_cover`.
    """
    fabric_stock_kg = float(fabric_stock_kg or 0)
    # Curated product-id set bypasses the support/main scope filter entirely (same
    # contract as `_months_of_cover`). Ids come from the DB, so inlining is safe.
    if product_ids is not None:
        if not product_ids:
            cons_scope = "FALSE"
        else:
            ids_csv = ",".join(str(int(i)) for i in product_ids)
            cons_scope = f"m.product_id IN ({ids_csv})"
    else:
        cons_scope = _scope_sql(scope)
    row = q(conn, f"""
        SELECT SUM({_net_kg('m')})::numeric AS kg
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE {_net_cons_where('m')}
          AND {cons_scope}
          AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
          AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
    """)[0]
    prev_kg = float(row['kg'] or 0)
    cover_now = (fabric_stock_kg / prev_kg) if prev_kg > 0 else None
    # Same three-way edge-case marker as the 6-month card so the frontend can
    # degrade identically ("ok" / "overstocked" / "no_data").
    if prev_kg > 0:
        cover_status = "ok"
    elif fabric_stock_kg > 0:
        cover_status = "overstocked"
    else:
        cover_status = "no_data"
    # Derive the previous-month label in Python — no extra DB round-trip.
    _today = datetime.date.today()
    _prev = _today.replace(day=1) - datetime.timedelta(days=1)
    mon_label = _prev.strftime('%Y-%m')
    return {
        "months_of_cover_prev_month": round(cover_now, 2) if cover_now is not None else None,
        "months_of_cover_prev_month_status": cover_status,
        "months_of_cover_prev_month_consumption_kg": round(prev_kg, 1),
        "months_of_cover_prev_month_label": mon_label,
    }

# ── Location filter ─────────────────────────────────────────
# The business only tracks real fabric stock in two locations. "All"/empty must
# resolve to the SET of these two (never every warehouse location); a specific
# location filters to just that one. Any other/unknown location falls back to the
# two-location set so excluded locations (FABRR/HQ/PROD/Samp/…) never leak in.
_ALL_LOC = {"", "all", "__all__"}
_FABRIC_LOCATIONS = ("RMAT/Stock", "Dead/Stock Fabric")

# "Last Move" must reflect REAL movements only (vendor receipts, consumption,
# genuine internal transfers) — never a stocktake/inventory adjustment, which
# lands in raw_fabric_moves as INTERNAL with Odoo's virtual adjustment location
# on one side. Use this predicate at EVERY MAX(date) last_move/days_since_move
# site so ordering, aging bands and detail cards stay consistent.
# NOTE: exact label match (verified in raw_fabric_moves) — deliberately avoids
# %/ILIKE wildcards because some q() call sites run with no params and a
# literal % breaks psycopg2 interpolation at the parametrized sites.
_ADJ_LOCATION = "Virtual Locations/Inventory adjustment"

def _real_move_sql(alias="m"):
    return (f"COALESCE({alias}.location_from,'') <> '{_ADJ_LOCATION}' "
            f"AND COALESCE({alias}.location_to,'') <> '{_ADJ_LOCATION}'")

def _loc_filter(location, alias="i"):
    """Return (sql_fragment, params) for the location_name filter.

    A recognised specific location → that location only. "All"/empty/unknown →
    the two real fabric-stock locations (RMAT/Stock + Dead/Stock Fabric)."""
    loc = None if location is None else str(location).strip()
    if loc and loc.lower() not in _ALL_LOC and loc in _FABRIC_LOCATIONS:
        return (f" AND {alias}.location_name = %s", [loc])
    placeholders = ", ".join(["%s"] * len(_FABRIC_LOCATIONS))
    return (f" AND {alias}.location_name IN ({placeholders})", list(_FABRIC_LOCATIONS))

# ── Support-fabric scope (Lining + Fusable Interfacing) ─────────────
# "Support fabrics" = EXACTLY the two Odoo categories the user defined:
# 'Lining' and 'Fusable Interfacing'. Matched on a NORMALIZED (lower/trim,
# NULL→'') EXACT category equality — NOT a substring — so near-named variants
# like 'Crepe Lining' deliberately stay in the MAIN dashboard. Every aggregating
# endpoint takes a `scope` query param:
#   'main'   (default) → EXCLUDES support fabrics  (the existing dashboard tabs)
#   'support'          → keeps ONLY support fabrics (the new Support Fabrics tab)
# Rows with no classifiable category (NULL/'' — e.g. sheet-override moves whose
# product_id didn't resolve to a product master) normalize to '' → NOT support →
# they stay in MAIN. That preserves the reconciliation main + support == the old
# all-fabric totals (and honours the "sheet rows always count" rule).
# In addition to the two categories, a DB-stored, admin-editable list of
# case-insensitive product-family NAME PREFIXES (fabric_support_overrides)
# forces matching products into the support scope regardless of their Odoo
# category — used for sampling-only families that Odoo categorises as regular
# fabric. Matching uses starts_with() (never LIKE '%') so the fragment is safe
# at BOTH parametrized and no-param q() call sites (psycopg2 literal-% trap).
_SUPPORT_OVERRIDE_SEED = [
    "Dexing 100D",
    "Dexing 30S",
    "Dexing 45S",
    "Dexing 491709",
    "Dexing 491725",
    "Dexing 491774",
    "Dexing 491880",
    "Dexing CEY",
    "Dexing Nylon Rayon Slub",
    "Dexing SPH",
    "Huaming Imitation Hemp",
    "Yiyi 7294",
    "Al Sawae-Zara China-Lining",
]

_SUPPORT_OVR_READY = False

def _ensure_support_overrides():
    """Lazily create + seed the fabric_support_overrides table (idempotent,
    process-flagged). Opens its OWN pooled connection so it never commits a
    caller's in-flight transaction. Safe on a fresh prod DB: the first fabric
    query of the process runs this before any _scope_sql subselect executes."""
    global _SUPPORT_OVR_READY
    if _SUPPORT_OVR_READY:
        return
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS fabric_support_overrides (
                    id          SERIAL PRIMARY KEY,
                    name_prefix TEXT NOT NULL,
                    created_by  TEXT,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS fabric_support_overrides_prefix_uq
                ON fabric_support_overrides ((LOWER(BTRIM(name_prefix))))
            """)
            for prefix in _SUPPORT_OVERRIDE_SEED:
                cur.execute("""
                    INSERT INTO fabric_support_overrides (name_prefix, created_by)
                    VALUES (%s, 'seed')
                    ON CONFLICT ((LOWER(BTRIM(name_prefix)))) DO NOTHING
                """, (prefix,))
        conn.commit()
    finally:
        conn.close()
    _SUPPORT_OVR_READY = True

def _support_ovr_ids_sql():
    """Subselect of product ids whose name starts with any override prefix."""
    return ("SELECT rp.id FROM raw_fabric_products rp "
            "JOIN fabric_support_overrides so "
            "ON starts_with(LOWER(BTRIM(rp.name)), LOWER(BTRIM(so.name_prefix)))")

def _id_col_for(col):
    """Derive the product-id column matching a category column reference:
    'p.fabric_category' → 'p.id'; bare 'fabric_category' (a query directly on
    raw_fabric_products) → 'id'."""
    return f"{col.rsplit('.', 1)[0]}.id" if "." in col else "id"

def _support_ovr_match(col):
    # COALESCE(..., FALSE) is load-bearing: LEFT-JOINed rows with a NULL
    # product id (e.g. sheet-override moves) must evaluate FALSE, not NULL,
    # or `NOT (…)` silently drops them from MAIN and breaks the
    # main + support == all-fabric reconciliation.
    return f"COALESCE({_id_col_for(col)} IN ({_support_ovr_ids_sql()}), FALSE)"

def _support_match(col):
    # Support fabrics = EXACTLY the two Odoo categories the user defined:
    # "Lining" and "Fusable Interfacing". Matched case-insensitively and trimmed.
    # An exact IN (not a substring LIKE) so near-named categories like
    # "Crepe Lining" stay in the MAIN dashboard, per the user's explicit scope.
    # OR'd with the admin-editable product-name-prefix override list.
    c = f"LOWER(BTRIM(COALESCE({col},'')))"
    return (f"({c} IN ('lining', 'fusable interfacing') "
            f"OR {_support_ovr_match(col)})")

def _scope_sql(scope, col="p.fabric_category"):
    """SQL boolean fragment restricting rows to the requested support-fabric scope."""
    m = _support_match(col)
    return m if str(scope or "").lower() == "support" else f"NOT {m}"

def _category_label_sql(scope, col="p.fabric_category"):
    """Display expression for the fabric category: the product's REAL Odoo
    category, with NULL/blank bucketed as 'Unknown'. Support-override
    products (pulled into the support scope by the name-prefix list) are NOT
    relabelled — they show under their real category/subcategory exactly like
    the two native support categories, so the Support tab integrates them with
    Lining / Fusable Interfacing instead of a generic 'Lining/Sampling' bucket.
    `scope` is kept in the signature for call-site stability (labeling is now
    scope-independent)."""
    _ = scope
    return f"COALESCE(NULLIF({col},''),'Unknown')"

# ── Basic (core staple) fabrics ─────────────────────────────
# A curated set of staple fabrics the buying team always wants to keep in stock,
# identified by a (vendor/supplier → fabric-code) pairing. SINGLE SOURCE OF TRUTH
# for the "Basic Fabrics — Months of Cover" Overview KPI; edit here to change it.
# A row qualifies only when its supplier matches the listed vendor AND its
# name/default_code/barcode contains the listed code — code alone is not enough,
# so an unrelated fabric sharing a number is never pulled in. Matching is
# case-insensitive and tolerant of surrounding text (the code is embedded in a
# longer fabric name) and supplier-name casing variants. '367#' carries a literal
# '#' handled as plain text. A listed pairing that matches nothing simply
# contributes zero (the KPI never errors); the matched-count is surfaced.
BASIC_FABRICS = {
    "Runfeng":            ["8003", "8004", "8224"],
    "Yat Taj Hong":       ["CA10091", "CA12220"],
    "Reeyon":             ["LY001", "LY004", "LY470"],
    "Yitai Cloth Trade":  ["91005"],
    "Dong Sheng (DS)":    ["82033"],
    "Fashion Knitted":    ["1629"],
    "Shunwang Textiles":  ["367#"],
    "Yajun":              ["HS8912"],
    "Worldview":          ["Interfacing"],
    "Lexin":              ["Interlining"],
    "Yun Xiang":          ["A1507"],
}

def _resolve_basic_fabrics(conn):
    """Resolve the curated supplier→codes map to matching raw_fabric_products.

    Returns (product_ids, matched_pairs, total_pairs):
      product_ids  – distinct ids across every matched pairing (the KPI universe)
      matched_pairs – count of (supplier, code) entries that matched ≥1 product
      total_pairs   – total curated (supplier, code) entries
    Matching is per-pair so the matched-count is meaningful (an unmatched code is
    visible in the KPI sub-line). Supplier is matched case-insensitively/trimmed;
    the code is matched as a substring of name/default_code/barcode (ILIKE), with
    LIKE wildcards in the code escaped so '%'/'_' (and the literal '#') are inert.
    """
    ids = set()
    matched = 0
    total = 0
    for supplier, codes in BASIC_FABRICS.items():
        for code in codes:
            total += 1
            esc = (str(code).replace("\\", "\\\\")
                            .replace("%", "\\%")
                            .replace("_", "\\_"))
            like = f"%{esc}%"
            rows = q(conn, r"""
                SELECT id FROM raw_fabric_products p
                WHERE lower(btrim(COALESCE(p.supplier,''))) = lower(btrim(%s))
                  AND (COALESCE(p.name,'')         ILIKE %s ESCAPE '\'
                    OR COALESCE(p.default_code,'') ILIKE %s ESCAPE '\'
                    OR COALESCE(p.barcode,'')      ILIKE %s ESCAPE '\')
            """, [supplier, like, like, like])
            if rows:
                matched += 1
                ids.update(r["id"] for r in rows)
    return list(ids), matched, total

# ── Months-of-Cover daily snapshot ─────────────────────────
# The Fabric "Months of Cover" KPI is a ratio of two independently-moving parts:
# RMAT/Stock on-hand kg (numerator) and the 6-completed-month average net
# consumption run-rate (denominator). Either can move overnight (a stock count,
# or the hourly Odoo re-extract / Jan–Apr sheet reload revising the run-rate), so
# a swing like 5.1 → 5.8 has no visible cause. We log a once-per-EAT-day snapshot
# of the EXACT inputs (reusing `_months_of_cover` so the snapshot can never
# diverge from the live card) and expose a day-over-day "what changed since
# yesterday" decomposition attributing the change to the stock lever vs the
# run-rate lever. Production is a SEPARATE DB that never runs the dev rebuild, so
# history is accrued from inside the incremental sync loop; the writer is
# standalone + idempotent (upsert on the EAT capture date).
_COVER_SNAPSHOT_READY = False

def _ensure_cover_snapshot_table(conn):
    """Create the months-of-cover snapshot table (idempotent, once per process)."""
    global _COVER_SNAPSHOT_READY
    if _COVER_SNAPSHOT_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_cover_snapshot (
                capture_date                     DATE PRIMARY KEY,
                rmat_stock_kg                    NUMERIC,
                avg_monthly_consumption_kg       NUMERIC,
                months_of_cover                  NUMERIC,
                months_breakdown                 JSONB,
                basic_stock_kg                   NUMERIC,
                basic_avg_monthly_consumption_kg NUMERIC,
                basic_months_of_cover            NUMERIC,
                basic_months_breakdown           JSONB,
                captured_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
    conn.commit()
    _COVER_SNAPSHOT_READY = True

def _compute_cover_snapshot(conn):
    """Compute the current Months-of-Cover inputs (headline + Basic Fabrics) using
    the SAME helpers behind the live summary card, so the snapshot always agrees
    with what the KPI shows. Returns a dict ready to upsert."""
    # Headline — live RMAT/Stock fabric base (main scope), same base the summary
    # card feeds into `_months_of_cover`.
    rmat_kg = q(conn, f"""
        SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
        FROM raw_fabric_inventory i
        JOIN raw_fabric_products p ON p.id = i.product_id
        WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
          AND {_scope_sql('main')}
    """)[0]['kg'] or 0
    cover = _months_of_cover(conn, rmat_kg, "main")

    # Basic Fabrics — curated staple set only (bypasses the support/main scope),
    # mirroring the summary card's Basic Fabrics computation.
    basic_ids, _matched, _total = _resolve_basic_fabrics(conn)
    if basic_ids:
        basic_kg = q(conn, f"""
            SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
            FROM raw_fabric_inventory i
            WHERE i.quantity > 0 AND i.location_name='RMAT/Stock'
              AND i.product_id IN ({",".join(str(int(x)) for x in basic_ids)})
        """)[0]['kg'] or 0
        basic = _months_of_cover(conn, basic_kg, "main", product_ids=basic_ids)
    else:
        basic_kg = 0
        basic = {"avg_monthly_consumption_kg": 0.0,
                 "months_of_cover": None, "months_breakdown": []}

    return {
        "rmat_stock_kg": round(float(rmat_kg or 0), 1),
        "avg_monthly_consumption_kg": cover["avg_monthly_consumption_kg"],
        "months_of_cover": cover["months_of_cover"],
        "months_breakdown": cover["months_breakdown"],
        "basic_stock_kg": round(float(basic_kg or 0), 1),
        "basic_avg_monthly_consumption_kg": basic["avg_monthly_consumption_kg"],
        "basic_months_of_cover": basic["months_of_cover"],
        "basic_months_breakdown": basic["months_breakdown"],
    }

def write_cover_snapshot(conn=None):
    """Capture ONE Months-of-Cover snapshot for today's EAT calendar day.

    Idempotent: upserts on the EAT capture date, so re-running the same day
    overwrites rather than duplicating. Ensures its own schema (and the fabric
    override view) so it self-bootstraps on a fresh production DB and is safe to
    run standalone as a one-time backfill. Reuses the shared connection when the
    sync loop passes one; otherwise opens (and closes) its own. The EAT day
    boundary matches how the rest of the fabric page reasons about dates even
    when the DB session is UTC. Returns the computed snapshot dict."""
    import json
    own = conn is None
    if own:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        _ensure_cover_snapshot_table(conn)
        _ensure_fabric_sheet(conn)
        snap = _compute_cover_snapshot(conn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_cover_snapshot (
                    capture_date, rmat_stock_kg, avg_monthly_consumption_kg,
                    months_of_cover, months_breakdown, basic_stock_kg,
                    basic_avg_monthly_consumption_kg, basic_months_of_cover,
                    basic_months_breakdown, captured_at
                ) VALUES (
                    (now() AT TIME ZONE 'Africa/Nairobi')::date,
                    %s, %s, %s, %s, %s, %s, %s, %s, now()
                )
                ON CONFLICT (capture_date) DO UPDATE SET
                    rmat_stock_kg = EXCLUDED.rmat_stock_kg,
                    avg_monthly_consumption_kg = EXCLUDED.avg_monthly_consumption_kg,
                    months_of_cover = EXCLUDED.months_of_cover,
                    months_breakdown = EXCLUDED.months_breakdown,
                    basic_stock_kg = EXCLUDED.basic_stock_kg,
                    basic_avg_monthly_consumption_kg = EXCLUDED.basic_avg_monthly_consumption_kg,
                    basic_months_of_cover = EXCLUDED.basic_months_of_cover,
                    basic_months_breakdown = EXCLUDED.basic_months_breakdown,
                    captured_at = now()
            """, (
                snap["rmat_stock_kg"], snap["avg_monthly_consumption_kg"],
                snap["months_of_cover"], json.dumps(snap["months_breakdown"]),
                snap["basic_stock_kg"], snap["basic_avg_monthly_consumption_kg"],
                snap["basic_months_of_cover"],
                json.dumps(snap["basic_months_breakdown"]),
            ))
        conn.commit()
        return snap
    finally:
        if own:
            conn.close()

def _cover_delta(now_row, prev_row):
    """Decompose the day-over-day months-of-cover change for one series (headline
    or Basic Fabrics) into a stock lever and a run-rate lever, so the frontend
    does no maths. cover = stock ÷ rate; the change splits as:
      stock component = (stock_now − stock_prev) ÷ rate_prev   (rate held at prior)
      rate component  = stock_now ÷ rate_now − stock_now ÷ rate_prev (stock at now)
    which sum exactly to Δcover. Also returns the raw input deltas (stock kg,
    run-rate kg/mo) shown in the card sub-line. Cover contributions are None when
    a run-rate is zero on either side (divide undefined / overstocked)."""
    def _f(v):
        return None if v is None else float(v)
    stock_now, stock_prev = _f(now_row["stock_kg"]), _f(prev_row["stock_kg"])
    rate_now, rate_prev = _f(now_row["rate_kg"]), _f(prev_row["rate_kg"])
    cover_now, cover_prev = _f(now_row["cover"]), _f(prev_row["cover"])
    stock_delta = (stock_now - stock_prev) if (stock_now is not None and stock_prev is not None) else None
    rate_delta = (rate_now - rate_prev) if (rate_now is not None and rate_prev is not None) else None
    cover_delta = (cover_now - cover_prev) if (cover_now is not None and cover_prev is not None) else None
    if rate_prev and rate_now and rate_prev > 0 and rate_now > 0 and stock_now is not None and stock_prev is not None:
        cover_from_stock = (stock_now - stock_prev) / rate_prev
        cover_from_rate = stock_now / rate_now - stock_now / rate_prev
    else:
        cover_from_stock = None
        cover_from_rate = None
    return {
        "cover_now": round(cover_now, 2) if cover_now is not None else None,
        "cover_prev": round(cover_prev, 2) if cover_prev is not None else None,
        "cover_delta": round(cover_delta, 2) if cover_delta is not None else None,
        "stock_now_kg": round(stock_now, 1) if stock_now is not None else None,
        "stock_prev_kg": round(stock_prev, 1) if stock_prev is not None else None,
        "stock_delta_kg": round(stock_delta, 1) if stock_delta is not None else None,
        "rate_now_kg": round(rate_now, 1) if rate_now is not None else None,
        "rate_prev_kg": round(rate_prev, 1) if rate_prev is not None else None,
        "rate_delta_kg": round(rate_delta, 1) if rate_delta is not None else None,
        "cover_from_stock": round(cover_from_stock, 2) if cover_from_stock is not None else None,
        "cover_from_rate": round(cover_from_rate, 2) if cover_from_rate is not None else None,
    }

@fabric_router.get("/api/fabric/cover-snapshot-delta")
def cover_snapshot_delta():
    """The two most-recent Months-of-Cover snapshots and the day-over-day change,
    decomposed into a stock lever and a run-rate lever (headline + Basic Fabrics).
    Returns status 'no_data' when no snapshots exist yet and 'no_prior' when only
    one day of history exists, so the card can degrade gracefully."""
    with _get_conn() as conn:
        _ensure_cover_snapshot_table(conn)
        rows = q(conn, """
            SELECT capture_date, rmat_stock_kg, avg_monthly_consumption_kg,
                   months_of_cover, basic_stock_kg,
                   basic_avg_monthly_consumption_kg, basic_months_of_cover
            FROM fabric_cover_snapshot
            ORDER BY capture_date DESC
            LIMIT 2
        """)
        if not rows:
            return {"status": "no_data"}
        cur = rows[0]
        if len(rows) < 2:
            return {
                "status": "no_prior",
                "capture_date": cur["capture_date"].isoformat(),
            }
        prev = rows[1]
        headline = _cover_delta(
            {"stock_kg": cur["rmat_stock_kg"], "rate_kg": cur["avg_monthly_consumption_kg"], "cover": cur["months_of_cover"]},
            {"stock_kg": prev["rmat_stock_kg"], "rate_kg": prev["avg_monthly_consumption_kg"], "cover": prev["months_of_cover"]},
        )
        basic = _cover_delta(
            {"stock_kg": cur["basic_stock_kg"], "rate_kg": cur["basic_avg_monthly_consumption_kg"], "cover": cur["basic_months_of_cover"]},
            {"stock_kg": prev["basic_stock_kg"], "rate_kg": prev["basic_avg_monthly_consumption_kg"], "cover": prev["basic_months_of_cover"]},
        )
        return {
            "status": "ok",
            "capture_date": cur["capture_date"].isoformat(),
            "prior_date": prev["capture_date"].isoformat(),
            "headline": headline,
            "basic": basic,
        }

@fabric_router.get("/api/fabric/cover-snapshot/dates")
def cover_snapshot_dates():
    """All available capture dates in the fabric_cover_snapshot table, sorted
    ascending. Used by the Historical Snapshot picker to set a min-date and to
    tell the frontend the earliest available snapshot date."""
    with _get_conn() as conn:
        _ensure_cover_snapshot_table(conn)
        rows = q(conn, """
            SELECT capture_date
            FROM fabric_cover_snapshot
            ORDER BY capture_date ASC
        """)
    dates = [r["capture_date"].isoformat() for r in rows]
    return {"dates": dates, "earliest": dates[0] if dates else None, "count": len(dates)}


@fabric_router.get("/api/fabric/cover-snapshot")
def cover_snapshot_lookup(date: str = Query(default=None)):
    """Point-in-time SOH + Months-of-Cover summary for a chosen date.

    Returns the most-recent snapshot whose capture_date is <= the requested
    date. When the exact date has no snapshot the nearest earlier one is used
    and `actual_capture_date` will differ from the requested date. Returns
    status='no_data' when no snapshots exist, and status='before_earliest'
    when the requested date precedes the earliest available snapshot."""
    import datetime as _dt
    today_eat = _dt.datetime.now(_dt.timezone.utc).astimezone(
        ZoneInfo("Africa/Nairobi")).date()
    if date:
        try:
            req_date = _dt.date.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format — use YYYY-MM-DD")
    else:
        req_date = today_eat
    with _get_conn() as conn:
        _ensure_cover_snapshot_table(conn)
        earliest_rows = q(conn, "SELECT MIN(capture_date) AS d FROM fabric_cover_snapshot")
        earliest = earliest_rows[0]["d"] if earliest_rows else None
        if earliest is None:
            return {"status": "no_data"}
        if req_date < earliest:
            return {
                "status": "before_earliest",
                "earliest_date": earliest.isoformat(),
                "requested_date": req_date.isoformat(),
            }
        rows = q(conn, """
            SELECT capture_date,
                   rmat_stock_kg,
                   avg_monthly_consumption_kg,
                   months_of_cover,
                   basic_stock_kg,
                   basic_avg_monthly_consumption_kg,
                   basic_months_of_cover
            FROM fabric_cover_snapshot
            WHERE capture_date <= %s
            ORDER BY capture_date DESC
            LIMIT 1
        """, (req_date,))
    if not rows:
        return {"status": "no_data"}
    r = rows[0]
    actual = r["capture_date"]
    return {
        "status": "ok",
        "requested_date": req_date.isoformat(),
        "actual_capture_date": actual.isoformat(),
        "date_differs": actual != req_date,
        "rmat_stock_kg": float(r["rmat_stock_kg"]) if r["rmat_stock_kg"] is not None else None,
        "avg_monthly_consumption_kg": float(r["avg_monthly_consumption_kg"]) if r["avg_monthly_consumption_kg"] is not None else None,
        "months_of_cover": float(r["months_of_cover"]) if r["months_of_cover"] is not None else None,
        "basic_stock_kg": float(r["basic_stock_kg"]) if r["basic_stock_kg"] is not None else None,
        "basic_avg_monthly_consumption_kg": float(r["basic_avg_monthly_consumption_kg"]) if r["basic_avg_monthly_consumption_kg"] is not None else None,
        "basic_months_of_cover": float(r["basic_months_of_cover"]) if r["basic_months_of_cover"] is not None else None,
    }


# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary(location: str = Query(default="RMAT/Stock"),
            scope: str = Query(default="main")):
    _api = _get_api()
    _ck = f"fabric:summary:{location}:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # Capture the requested support-scope BEFORE `scope` is reused below as the
        # location-bucket row list (rmat/dead) — they share the name historically.
        scope_param = str(scope or "main")
        scope_sql = _scope_sql(scope_param)
        # Stock by location
        stock = q(conn, f"""
            SELECT 
              i.location_name,
              p.category,
              COUNT(DISTINCT i.product_id) as products,
              ROUND(SUM(i.quantity)::numeric,1) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND {scope_sql}
            GROUP BY i.location_name, p.category
        """)
        
        sel = None if location is None else str(location).strip()
        all_loc = sel is None or sel.lower() in _ALL_LOC or sel not in _FABRIC_LOCATIONS
        # The two real fabric-stock buckets. Everything else (FABRR/HQ/PROD/Samp/…)
        # is excluded entirely from the headline figures.
        rmat = [r for r in stock if r['category'] == 'Fabric'
                and r['location_name'] == 'RMAT/Stock']
        dead = [r for r in stock if r['location_name'] == 'Dead/Stock Fabric']
        trim = [r for r in stock if r['category'] == 'Trim']
        # Selected scope feeds the three headline KPIs. "All" = RMAT + Dead;
        # a specific location = just that bucket (so totals reconcile: All = RMAT + Dead).
        if all_loc:
            scope = rmat + dead
        elif sel == 'Dead/Stock Fabric':
            scope = dead
        else:  # RMAT/Stock
            scope = rmat
        
        # POs outstanding (product-matched so it can honour the support scope)
        pos = q(conn, f"""
            SELECT COUNT(DISTINCT po.po_name) as count,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as value
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.qty_ordered > po.qty_received AND po.state != 'cancel'
              AND {scope_sql}
        """)[0]

        # Average cost per metre — STOCK ON HAND. Blended cost of the LIVE
        # RMAT/Stock fabric base (excludes Dead/Production/Virtual — same base as
        # the on-hand headline & Months of cover): stock value (KES) ÷ stock metres,
        # computed ONLY over fabrics that have a kg→metre conversion (kg_per_mtr_eff>0).
        # BOTH the value (numerator) and the metres (denominator) are restricted to
        # convertible fabrics so the figure is not distorted by value that has no
        # matching metres. Fabrics missing Width/GSM are excluded and reported as a
        # coverage signal (count + value) rather than blanking the headline figure.
        acpm_stock = q(conn, f"""
            SELECT ROUND(SUM(i.total_value) FILTER (WHERE p.kg_per_mtr_eff>0)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as metres,
                   COUNT(DISTINCT p.id) FILTER (WHERE p.kg_per_mtr_eff IS NULL) as excluded_count,
                   ROUND(SUM(i.total_value) FILTER (WHERE p.kg_per_mtr_eff IS NULL)::numeric,0) as excluded_value
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
              AND {scope_sql}
        """)[0]
        acpm_stock_excluded_count = int(acpm_stock['excluded_count'] or 0)
        acpm_stock_excluded_value = round(float(acpm_stock['excluded_value'] or 0))
        acpm_stock_metres = float(acpm_stock['metres'] or 0)
        acpm_stock_value = float(acpm_stock['value_kes'] or 0)
        avg_cost_per_metre_stock = (
            round(acpm_stock_value / acpm_stock_metres, 2)
            if acpm_stock_metres > 0 else None)

        # Average cost per metre — PURCHASES. SUM(received qty × unit price) ÷
        # SUM(received metres) over ALL non-cancelled POs (entire history), using
        # RECEIVED quantity (what actually landed), converted to metres via the
        # product master's kg_per_mtr. Per-supplier breakdown lets a supplier whose
        # fabrics lack the conversion be pinpointed (its row + the headline → "—").
        # Scoped to category='Fabric' (Raw Materials-Fabric) only, identically to
        # the STOCK side above — Trim/unmatched PO lines are excluded entirely.
        pur_rows = q(conn, f"""
            SELECT po.supplier as supplier,
                   ROUND(SUM(po.qty_received*po.price_unit) FILTER (WHERE p.kg_per_mtr_eff>0)::numeric,0) as value_kes,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN po.qty_received/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as metres,
                   COUNT(DISTINCT p.id) FILTER (WHERE p.kg_per_mtr_eff IS NULL) as excluded_count,
                   ROUND(SUM(po.qty_received*po.price_unit) FILTER (WHERE p.kg_per_mtr_eff IS NULL)::numeric,0) as excluded_value
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
              AND {scope_sql}
            GROUP BY po.supplier
        """)
        # Culprit fabrics behind every "incomplete" supplier: received fabrics whose
        # kg→metre conversion is missing (kg_per_mtr_eff IS NULL) so their value lands
        # in the numerator but contributes no metres. Same base/filters as pur_rows
        # above so the per-supplier counts line up with the `incomplete` flag. Grouped
        # per (supplier, product) so a fabric received over multiple POs shows once.
        missing_rows = q(conn, f"""
            SELECT po.supplier as supplier,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as name,
                   p.default_code as sku,
                   ROUND(SUM(po.qty_received)::numeric,1) as qty_kg,
                   ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) as value_kes
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
              AND p.kg_per_mtr_eff IS NULL
              AND {scope_sql}
            GROUP BY po.supplier, p.name, p.default_code
            ORDER BY value_kes DESC
        """)
        missing_by_supplier = {}
        for m in missing_rows:
            missing_by_supplier.setdefault(m['supplier'], []).append({
                "name": m['name'],
                "sku": m['sku'],
                "qty_kg": float(m['qty_kg'] or 0),
                "value_kes": round(float(m['value_kes'] or 0)),
            })

        purchases_by_supplier = []
        pur_total_value = 0.0
        pur_total_metres = 0.0
        pur_excluded_count = 0
        pur_excluded_value = 0.0
        for r in pur_rows:
            exc = int(r['excluded_count'] or 0)
            exc_val = float(r['excluded_value'] or 0)
            val = float(r['value_kes'] or 0)
            met = float(r['metres'] or 0)
            pur_total_value += val
            pur_total_metres += met
            pur_excluded_count += exc
            pur_excluded_value += exc_val
            purchases_by_supplier.append({
                "supplier": r['supplier'] or "(unknown)",
                "value_kes": round(val),
                "metres": round(met, 1),
                # Cost/metre now computed over the supplier's CONVERTIBLE fabrics only
                # (value & metres both restricted), so a supplier with some missing
                # Width/GSM still shows a figure; the gap is surfaced via incomplete.
                "cost_per_metre": (round(val / met, 2) if met > 0 else None),
                "incomplete": exc > 0,
                "excluded_count": exc,
                "excluded_value": round(exc_val),
                "missing_fabrics": missing_by_supplier.get(r['supplier'], []),
            })
        # Sort by cost per metre desc; rows with no figure (no convertible metres)
        # sink to the bottom.
        purchases_by_supplier.sort(
            key=lambda x: (x['cost_per_metre'] is None, -(x['cost_per_metre'] or 0)))
        avg_cost_per_metre_purchases = (
            round(pur_total_value / pur_total_metres, 2)
            if pur_total_metres > 0 else None)
        pur_excluded_value = round(pur_excluded_value)
        
        # Consumption last 30 days — net of fabric returned from production.
        # Metres = each move's net kg ÷ the fabric's kg-per-metre (skip rows with
        # no/zero kg_per_mtr — negligible; RMAT/Stock has zero fabrics missing it).
        cons = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= NOW() - INTERVAL '30 days'
        """)[0]

        # Consumption so far today — net of production returns (m.date is a date/ts).
        # Also split the gross legs (issued OUT vs returned from production) so the
        # UI can explain a negative net figure ("returns exceeded issues").
        cons_today = q(conn, f"""
            SELECT ROUND(SUM({_net_kg('m')})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as metres,
                   ROUND(SUM(CASE WHEN {_consume_pred('m')} THEN {_kg('m')} ELSE 0 END)::numeric,1) as issued_kg,
                   ROUND(SUM(CASE WHEN {_consume_pred('m')} AND p.kg_per_mtr_eff>0 THEN {_kg('m')}/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as issued_metres,
                   ROUND(SUM(CASE WHEN {_rmat_return_pred('m')} THEN {_kg('m')} ELSE 0 END)::numeric,1) as returned_kg,
                   ROUND(SUM(CASE WHEN {_rmat_return_pred('m')} AND p.kg_per_mtr_eff>0 THEN {_kg('m')}/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as returned_metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {scope_sql}
              AND m.date >= CURRENT_DATE
        """)[0]

        # Most recent day an actual consumption move (RMAT/Stock exit) was posted
        # within scope. Lets the UI distinguish a legitimate quiet-day 0 from a
        # stalled feed. NULL when there is no consumption history for this scope.
        last_cons = q(conn, f"""
            SELECT MAX(m.date::date) as d
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE ({_consume_pred('m')})
              AND m.uom IN ('g','kg')
              AND m.is_fabric
              AND {scope_sql}
        """)[0]

        # BOM styles
        bom = q(conn, "SELECT COUNT(DISTINCT finished_product_name) as styles FROM raw_fabric_boms")[0]

        # Fabric-feed freshness — the most recent SUCCESSFUL Odoo fabric pull, used
        # by the page to show a real "last updated" age (not the browser clock) and
        # to flag a frozen feed (e.g. Odoo "Access Denied"). `_loaded_at` is written
        # by extract_fabric.py as a NAIVE UTC timestamp (datetime.utcnow()), so the
        # age is measured against UTC `now()` to stay correct regardless of the DB
        # session timezone. The extract normally runs many times a day, so >6h with
        # no successful pull means the feed is genuinely frozen.
        STALE_THRESHOLD_HOURS = 6
        # Well past threshold (or never loaded) = the pull is genuinely failing, not
        # merely mid-catch-up. The banner escalates from calm/informational to an
        # alarming warning only above this critical mark. On the always-on prod VM the
        # fabric extract runs every minute, so this only trips on a real outage.
        CRITICAL_THRESHOLD_HOURS = 24
        # The product master now refreshes on a strict ~60s cadence. When the last
        # successful pull slips past this small margin (default 180s ≈ 3 min) — but
        # is still well short of the 6h "stale" mark — surface a calm, informational
        # "sync running behind" note. The margin is a few minutes so a single
        # transient blip (one skipped 60s cycle) never raises it.
        DELAYED_THRESHOLD_SEC = int(os.environ.get("FABRIC_DELAYED_THRESHOLD_SEC", "180"))
        fresh = q(conn, """
            SELECT MAX(_loaded_at) AS last_loaded,
                   EXTRACT(EPOCH FROM (timezone('UTC', now()) - MAX(_loaded_at))) AS secs
            FROM raw_fabric_products
        """)[0]
        fresh_secs = float(fresh['secs']) if fresh and fresh['secs'] is not None else None
        fresh_hours = round(fresh_secs / 3600.0, 2) if fresh_secs is not None else None
        # `_loaded_at` is written by extract_fabric.py as a NAIVE UTC timestamp
        # (datetime.utcnow()), so serialize it with an explicit 'Z' UTC marker; the
        # frontend converts it to Africa/Nairobi for the exact "last successful pull"
        # time shown alongside the relative age.
        fresh_at_iso = (
            fresh['last_loaded'].isoformat() + 'Z'
            if fresh and fresh['last_loaded'] is not None
            else None
        )
        # No successful pull at all (empty table / never loaded) is treated as stale.
        fabric_stale = (fresh_hours is None) or (fresh_hours > STALE_THRESHOLD_HOURS)
        # Severity tier drives the banner styling: ok (fresh, no banner) /
        # delayed (a few minutes behind the 60s target — calm note) / info
        # (hours behind but not yet critical — calm, catching up) / warn (well past
        # threshold or never loaded — genuinely failing).
        if fresh_hours is None or fresh_hours > CRITICAL_THRESHOLD_HOURS:
            fabric_freshness_severity = "warn"
        elif fresh_hours > STALE_THRESHOLD_HOURS:
            fabric_freshness_severity = "info"
        elif fresh_secs is not None and fresh_secs > DELAYED_THRESHOLD_SEC:
            fabric_freshness_severity = "delayed"
        else:
            fabric_freshness_severity = "ok"

        # Months of cover — 6-month average monthly run-rate with the in-progress
        # month projected to its end-of-month figure (fabric consumption is lumpy
        # — production-run driven — so a single 30-day denominator swings wildly).
        # Cover always tracks the LIVE RMAT/Stock base (dead stock isn't "cover"),
        # so it doesn't change with the selected scope.
        rmat_stock_kg = round(sum(r['qty_kg'] or 0 for r in rmat), 1)
        rmat_stock_value = round(sum(r['value_kes'] or 0 for r in rmat))
        dead_stock_value = sum(r['value_kes'] or 0 for r in dead)
        cover = _months_of_cover(conn, rmat_stock_kg, scope_param)
        # Prev-month cover — same live RMAT/Stock base ÷ the previous FULL calendar
        # month's net consumption (a more reactive signal than the 6-month average).
        cover_prev = _months_of_cover_prev_month(conn, rmat_stock_kg, scope_param)

        # Basic Fabrics — Months of Cover. One combined cover figure across the
        # curated staple-fabric set ONLY (supplier+code pairs in BASIC_FABRICS),
        # computed with the SAME method as the headline cover: live RMAT/Stock kg
        # base ÷ the average net run-rate over the last 6 fully completed months,
        # restricted to the curated product
        # ids. Bypasses the support/main scope (the curated set is its own
        # universe). Never errors — an unmatched pairing just contributes nothing;
        # the matched/total counts are surfaced so a gap is noticeable.
        basic_ids, basic_matched, basic_total = _resolve_basic_fabrics(conn)
        if basic_ids:
            basic_stock_kg = q(conn, f"""
                SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name='RMAT/Stock'
                  AND i.product_id IN ({",".join(str(int(x)) for x in basic_ids)})
            """)[0]['kg'] or 0
            _basic = _months_of_cover(
                conn, basic_stock_kg, scope_param, product_ids=basic_ids
            )
            basic_cover = _basic['months_of_cover']
            basic_cover_status = _basic['months_of_cover_status']
        else:
            # No curated pairing matched any product (e.g. mid-rebuild): there is
            # genuinely nothing to compute. Surface this distinctly from a
            # stock-but-no-usage "overstocked" state so the card stays legible.
            basic_stock_kg = 0
            basic_cover = None
            basic_cover_status = "no_match"

        # Headline KPIs reflect the selected scope; All = RMAT + Dead.
        _result = {
            "fabric_stock_kg": round(sum(r['qty_kg'] or 0 for r in scope), 1),
            "fabric_stock_metres": round(sum(r['qty_metres'] or 0 for r in scope)),
            "fabric_stock_value": round(sum(r['value_kes'] or 0 for r in scope)),
            "fabric_products": sum(r['products'] or 0 for r in scope),
            # Stable grand total (RMAT + Dead) for the dead-stock % regardless of scope.
            "total_fabric_value": rmat_stock_value + dead_stock_value,
            "dead_stock_value": dead_stock_value,
            "dead_stock_kg": sum(r['qty_kg'] or 0 for r in dead),
            "outstanding_pos": pos['count'] or 0,
            "outstanding_po_value": pos['value'] or 0,
            "avg_cost_per_metre_stock": avg_cost_per_metre_stock,
            "avg_cost_per_metre_stock_incomplete": acpm_stock_excluded_count > 0,
            "avg_cost_per_metre_stock_excluded_count": acpm_stock_excluded_count,
            "avg_cost_per_metre_stock_excluded_value": acpm_stock_excluded_value,
            "avg_cost_per_metre_purchases": avg_cost_per_metre_purchases,
            "avg_cost_per_metre_purchases_incomplete": pur_excluded_count > 0,
            "avg_cost_per_metre_purchases_excluded_count": pur_excluded_count,
            "avg_cost_per_metre_purchases_excluded_value": pur_excluded_value,
            "purchases_by_supplier": purchases_by_supplier,
            "consumption_30d_kg": cons['kg'] or 0,
            "consumption_30d_metres": cons['metres'] or 0,
            "consumption_today_kg": cons_today['kg'] or 0,
            "consumption_today_metres": cons_today['metres'] or 0,
            "consumption_today_issued_kg": cons_today['issued_kg'] or 0,
            "consumption_today_issued_metres": cons_today['issued_metres'] or 0,
            "consumption_today_returned_kg": cons_today['returned_kg'] or 0,
            "consumption_today_returned_metres": cons_today['returned_metres'] or 0,
            "last_consumption_date": (last_cons['d'].isoformat() if last_cons['d'] else None),
            "styles_with_bom": bom['styles'] or 0,
            "basic_months_of_cover": basic_cover,
            "basic_months_of_cover_status": basic_cover_status,
            "basic_fabrics_matched": basic_matched,
            "basic_fabrics_total": basic_total,
            "basic_fabrics_stock_kg": round(float(basic_stock_kg or 0), 1),
            # Fabric-feed freshness (display-only; same value regardless of scope).
            "fabric_last_loaded_secs": round(fresh_secs) if fresh_secs is not None else None,
            "fabric_last_loaded_hours": fresh_hours,
            "fabric_last_loaded_at": fresh_at_iso,
            "fabric_data_stale": fabric_stale,
            "fabric_stale_threshold_hours": STALE_THRESHOLD_HOURS,
            "fabric_critical_threshold_hours": CRITICAL_THRESHOLD_HOURS,
            "fabric_delayed_threshold_sec": DELAYED_THRESHOLD_SEC,
            "fabric_freshness_severity": fabric_freshness_severity,
            **cover,
            **cover_prev,
        }
        _api.cache_set(_ck, _result, ttl=90)
        return _result

# ── Fabrics excluded from the Avg cost/metre figure (missing Width/GSM) ──────
# Companion download for the "N missing Width/GSM excluded" note on the Avg
# cost/metre KPI cards. Lists exactly the in-scope fabrics that were dropped from
# a given figure because they have no kg→metre conversion (kg_per_mtr_eff IS
# NULL), so a buyer can go fill in Width/GSM in Odoo. `figure` selects which
# card's scope to report (whitelisted to purchases | stock); the `scope`
# (main/support) + `location` params mirror the summary endpoint so the row set
# reconciles with the excluded-count shown on the card. Each row carries the
# barcode-or-SKU, product name, and a computed missing-parameters string, reusing
# the SAME Width/GSM logic as the xlsx "Fabrics to fix" export (missing = null or
# <= 0). Read-only.
def _width_gsm_missing_str(width_m, gsm):
    """Which of Width / GSM a fabric is missing (null or <= 0). Mirrors the
    xlsx export's _missing_str — kg/m is derived purely from Width x GSM, so
    those are the only two a buyer can fill in to clear the fabric."""
    m = []
    try:
        if not (width_m is not None and float(width_m) > 0):
            m.append("Width")
    except (TypeError, ValueError):
        m.append("Width")
    try:
        if not (gsm is not None and float(gsm) > 0):
            m.append("GSM")
    except (TypeError, ValueError):
        m.append("GSM")
    return ", ".join(m)

@fabric_router.get("/api/fabric/acpm-excluded")
def acpm_excluded(figure: str = Query(default="stock"),
                  scope: str = Query(default="main"),
                  location: str = Query(default="RMAT/Stock")):
    fig = str(figure or "").strip().lower()
    if fig not in ("stock", "purchases"):
        raise HTTPException(status_code=400, detail="figure must be 'stock' or 'purchases'")
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        scope_sql = _scope_sql(scope)
        if fig == "stock":
            # Same base/filters as the acpm_stock KPI query in summary(): live
            # RMAT/Stock fabric, in the requested support scope, whose kg->metre
            # conversion is missing. One row per product.
            rows = q(conn, f"""
                SELECT p.barcode AS barcode, p.default_code AS default_code,
                       COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') AS name,
                       p.width_m AS width_m, p.gsm AS gsm
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
                  AND p.kg_per_mtr_eff IS NULL
                  AND {scope_sql}
                GROUP BY p.id, p.barcode, p.default_code, p.name, p.width_m, p.gsm
                ORDER BY name
            """)
        else:
            # Same base/filters as the pur_rows / missing_rows KPI queries in
            # summary(): received, non-cancelled fabric PO lines whose kg->metre
            # conversion is missing. One row per product (received over 1+ POs).
            rows = q(conn, f"""
                SELECT p.barcode AS barcode, p.default_code AS default_code,
                       COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') AS name,
                       p.width_m AS width_m, p.gsm AS gsm
                FROM raw_fabric_purchase_orders po
                JOIN raw_fabric_products p ON p.id = po.product_id
                WHERE po.state != 'cancel' AND po.qty_received > 0 AND p.category='Fabric'
                  AND p.kg_per_mtr_eff IS NULL
                  AND {scope_sql}
                GROUP BY p.id, p.barcode, p.default_code, p.name, p.width_m, p.gsm
                ORDER BY name
            """)
        items = []
        for r in rows:
            sku = (r.get("barcode") or "").strip() or (r.get("default_code") or "").strip()
            items.append({
                "sku": sku,
                "name": r.get("name") or "Unknown",
                "missing": _width_gsm_missing_str(r.get("width_m"), r.get("gsm")),
            })
        return {"figure": fig, "count": len(items), "items": items}

# ── Avg metres of fabric consumed per garment ──────────────
# Derived from Done DPS manufacturing orders (mo_fabric_consumption, populated by
# extract_mo_fabric_consumption.py). Metric = Σ(main-fabric metres consumed across
# qualifying MOs) ÷ Σ(garments produced across those MOs), rolling last `days`
# (default 30) by MO completion date. kg→metres via each fabric SKU's
# kg_per_mtr_eff (metres = kg / kg_per_mtr_eff; consumed qty in grams is /1000
# first; a UoM already in metres is used as-is). A fabric with no kg_per_mtr_eff
# (no stored value, no Width/GSM) is converted with the overall fabric-average
# Kg/Mtr fallback so its MO is still counted rather than dropped. An MO is
# excluded ONLY when it produced 0 garments or had no fabric; the count of MOs
# that relied on the fallback (and the fallback value) is reported separately.
@fabric_router.get("/api/fabric/metres-per-garment")
def metres_per_garment(days: int = Query(default=30)):
    days = max(1, min(int(days or 30), 730))
    with _get_conn() as conn:
        # Fallback Kg/Mtr — the overall average kg_per_mtr_eff across every fabric
        # that HAS a usable value (stored, or derived from Width × GSM ÷ 1000).
        # ~1,017 fabrics have no Kg/Mtr at all (no stored value, no Width/GSM);
        # a production order using one of those used to be dropped from the
        # average, quietly shrinking the basis. We instead convert those kg with
        # this fallback average so the order is still counted. Computed once.
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
              AND c.is_main_fabric
        """, [days])

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "has_fabric": False, "used_fallback": False},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        if u in M_UOMS:
            # Already in metres — keep exactly as-is.
            d["metres"] += qty
        else:
            # kg/g-unit fabric (or a component absent from the master with no
            # metre uom): convert kg→metres. Use the fabric's own Kg/Mtr when it
            # has one; otherwise fall back to the overall average so the order is
            # still counted instead of being dropped.
            kg = qty / 1000.0 if u == "g" else qty
            if kpm and float(kpm) > 0:
                d["metres"] += kg / float(kpm)
            elif fallback_kpm:
                d["metres"] += kg / fallback_kpm
                d["used_fallback"] = True
            # If there is no fallback at all (no fabric has a Kg/Mtr), this
            # component contributes 0 metres but the order is still counted.

    total_metres = 0.0
    total_garments = 0.0
    n_mos = 0
    fallback_mos = 0
    for d in mos.values():
        # An order is excluded ONLY when it produced 0 garments or had no fabric.
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        total_metres += d["metres"]
        total_garments += d["produced"]
        n_mos += 1
        if d["used_fallback"]:
            fallback_mos += 1

    value = round(total_metres / total_garments, 2) if total_garments > 0 else None
    return {
        "metres_per_garment": value,
        "total_metres": round(total_metres, 1),
        "garments": round(total_garments),
        "mos": n_mos,
        "mos_using_fallback": fallback_mos,
        "fallback_kg_per_mtr": round(fallback_kpm, 4) if fallback_kpm else None,
        "window_days": days,
    }


# ── Avg metres / garment: downloadable .xlsx calculations report ─────────
# A full audit trail behind the "Avg metres / garment" KPI card: every qualifying
# Done-DPS MO, its fabric components, the kg→metre conversion applied, and how it
# all rolls up to the headline value. The per-MO conversion + exclusion logic MUST
# mirror metres_per_garment EXACTLY (same window, same UoM handling, same own-vs-
# fallback kg/m, same NULL-kpm-as-missing treatment) so the workbook reconciles to
# the card. The Summary sheet reuses metres_per_garment's own totals so it is
# guaranteed identical to what the card shows.
@fabric_router.get("/api/fabric/metres-per-garment.xlsx")
def metres_per_garment_xlsx(days: int = Query(default=30)):
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    days = max(1, min(int(days or 30), 730))

    # Reuse the headline endpoint's totals so the Summary sheet matches the card.
    summary = metres_per_garment(days=days)
    fallback_kpm = None  # recomputed below for the per-component "kg/m used" column

    with _get_conn() as conn:
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.mo_ref,
                   c.dps_ref,
                   c.done_date,
                   c.produced_qty,
                   c.style_name,
                   c.finished_sku,
                   c.component_id,
                   c.fabric_sku,
                   c.fabric_name,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   p.kg_per_mtr AS kpm_stored,
                   p.width_m,
                   p.gsm,
                   p.supplier
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
              AND c.is_main_fabric
            ORDER BY c.done_date DESC, c.odoo_mo_id, c.fabric_sku
        """, [days])

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    # Fold component rows -> per-MO (identical maths to metres_per_garment), while
    # keeping every component's contribution for the detail sheet.
    mos = {}
    components = []
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"mo_ref": r["mo_ref"], "dps_ref": r["dps_ref"],
             "done_date": r["done_date"],
             "style": (r["style_name"] or "").strip() or None,
             "finished_sku": r["finished_sku"],
             "produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "has_fabric": False, "used_fallback": False},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        comp = {
            "odoo_mo_id": r["odoo_mo_id"], "mo_ref": r["mo_ref"],
            "component_id": r["component_id"],
            "fabric_sku": r["fabric_sku"], "fabric_name": r["fabric_name"],
            "supplier": r["supplier"],
            "width_m": r["width_m"], "gsm": r["gsm"], "kpm_stored": r["kpm_stored"],
            "uom": r["uom"], "consumed_qty": qty,
            "kpm_used": None, "used_fallback": False, "metres": 0.0,
        }
        if u in M_UOMS:
            d["metres"] += qty
            comp["metres"] = qty  # already metres; no conversion applied
        else:
            kg = qty / 1000.0 if u == "g" else qty
            if kpm and float(kpm) > 0:
                m = kg / float(kpm)
                d["metres"] += m
                comp["kpm_used"] = float(kpm)
                comp["metres"] = m
            elif fallback_kpm:
                m = kg / fallback_kpm
                d["metres"] += m
                d["used_fallback"] = True
                comp["kpm_used"] = fallback_kpm
                comp["used_fallback"] = True
                comp["metres"] = m
            # No fallback at all: contributes 0 metres (MO still counted).
        components.append(comp)

    # Per-MO rows (only qualifying MOs — excluded exactly as the KPI does).
    per_mo = []
    qualifying_mo_ids = set()
    for mo_id, d in mos.items():
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        qualifying_mo_ids.add(mo_id)
        per_mo.append({
            "odoo_mo_id": mo_id, "mo_ref": d["mo_ref"], "dps_ref": d["dps_ref"],
            "done_date": d["done_date"], "style": d["style"],
            "finished_sku": d["finished_sku"], "garments": d["produced"],
            "total_metres": d["metres"],
            "metres_per_garment": (d["metres"] / d["produced"]) if d["produced"] > 0 else None,
            "used_fallback": d["used_fallback"],
        })
    per_mo.sort(key=lambda x: (x["done_date"] is None, x["done_date"], x["odoo_mo_id"]), reverse=True)

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    R = Alignment(horizontal="right")

    def _style_header(ws, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Avg metres / garment — calculations report"
    ws["A1"].font = TITLE
    kpi_val = summary.get("metres_per_garment")
    srows = [
        ("Rolling window (days)", summary.get("window_days")),
        ("Avg metres / garment (KPI)", kpi_val),
        ("Total main-fabric metres", summary.get("total_metres")),
        ("Total garments", summary.get("garments")),
        ("MOs counted", summary.get("mos")),
        ("MOs using fallback conversion", summary.get("mos_using_fallback")),
        ("Fallback kg per metre", summary.get("fallback_kg_per_mtr")),
        ("Basis", "Done DPS manufacturing orders, main-fabric components only"),
        ("Reconciliation", "Total metres ÷ Total garments = Avg metres / garment"),
    ]
    r0 = 3
    for i, (label, val) in enumerate(srows):
        ws.cell(row=r0 + i, column=1, value=label).font = LBL
        ws.cell(row=r0 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 56

    # Per-MO sheet
    ws2 = wb.create_sheet("Per-MO")
    mo_cols = ["MO ref", "DPS ref", "Done date", "Finished style",
               "Finished SKU", "Garments produced", "Total metres",
               "Metres / garment", "Used fallback conversion"]
    ws2.append(mo_cols)
    _style_header(ws2, len(mo_cols))
    for m in per_mo:
        ws2.append([
            m["mo_ref"], m["dps_ref"],
            (m["done_date"].isoformat() if hasattr(m["done_date"], "isoformat") else m["done_date"]),
            m["style"], m["finished_sku"],
            round(m["garments"], 2),
            round(m["total_metres"], 3),
            (round(m["metres_per_garment"], 3) if m["metres_per_garment"] is not None else None),
            "Yes" if m["used_fallback"] else "No",
        ])
    for col, w in zip("ABCDEFGHI", [16, 22, 12, 34, 16, 16, 14, 16, 22]):
        ws2.column_dimensions[col].width = w

    # Per-component sheet (only components of qualifying MOs, to reconcile).
    # The "Open in Odoo" column deep-links the fabric so a buyer can jump straight
    # to the product and fill in its Width/GSM or a stored kg/m.
    ws3 = wb.create_sheet("Per-component")
    comp_cols = ["MO ref", "Fabric SKU", "Fabric name", "UoM",
                 "Consumed qty", "Kg per metre used", "Used fallback",
                 "Metres contributed", "Open in Odoo"]
    ws3.append(comp_cols)
    _style_header(ws3, len(comp_cols))
    LINK = Font(color="1A5C38", underline="single")
    for c in components:
        if c["odoo_mo_id"] not in qualifying_mo_ids:
            continue
        ws3.append([
            c["mo_ref"], c["fabric_sku"], c["fabric_name"], c["uom"],
            round(c["consumed_qty"], 3),
            (round(c["kpm_used"], 4) if c["kpm_used"] is not None else None),
            "Yes" if c["used_fallback"] else "No",
            round(c["metres"], 3),
            None,
        ])
        # Only fabrics on the fallback need fixing — link those.
        if c["used_fallback"]:
            url = _odoo_product_url(c["component_id"])
            if url:
                cell = ws3.cell(row=ws3.max_row, column=len(comp_cols))
                cell.value = "Open in Odoo"
                cell.hyperlink = url
                cell.font = LINK
    for col, w in zip("ABCDEFGHI", [16, 18, 40, 8, 14, 18, 14, 18, 14]):
        ws3.column_dimensions[col].width = w

    # ── "Fabrics to fix" sheet — the companion view the buyers actually act on ──
    # One row per fabric that forced the fallback (no own kg→metre conversion),
    # ranked by impact, with what's missing and a direct Odoo link.
    fix = {}
    for c in components:
        if c["odoo_mo_id"] not in qualifying_mo_ids or not c["used_fallback"]:
            continue
        cid = c["component_id"]
        f = fix.setdefault(cid, {
            "component_id": cid, "sku": c["fabric_sku"], "name": c["fabric_name"],
            "supplier": c["supplier"], "width_m": c["width_m"], "gsm": c["gsm"],
            "kpm_stored": c["kpm_stored"], "_mos": set(),
            "metres": 0.0, "consumed_qty": 0.0,
        })
        f["_mos"].add(c["odoo_mo_id"])
        f["metres"] += c["metres"]
        f["consumed_qty"] += c["consumed_qty"]

    def _missing_str(f):
        # Kg/Mtr is now derived PURELY from Width × GSM ÷ 1000 (the stored Odoo
        # value is ignored), so the only thing a buyer can fill in to clear a
        # fabric is its Width and/or GSM.
        m = []
        if not (f["width_m"] and float(f["width_m"]) > 0):
            m.append("Width")
        if not (f["gsm"] and float(f["gsm"]) > 0):
            m.append("GSM")
        return ", ".join(m)

    fix_rows = sorted(fix.values(), key=lambda f: (len(f["_mos"]), f["metres"]), reverse=True)
    ws4 = wb.create_sheet("Fabrics to fix")
    ws4["A1"] = "Fabrics driving the fallback conversion — fill in Width/GSM or a kg/m in Odoo"
    ws4["A1"].font = TITLE
    fix_cols = ["Fabric SKU", "Fabric name", "Supplier", "Missing",
                "MOs affected", "Fallback metres", "Consumed (kg)", "Open in Odoo"]
    ws4.append([])  # spacer row 2
    ws4.append(fix_cols)  # header on row 3
    for col in range(1, len(fix_cols) + 1):
        cell = ws4.cell(row=3, column=col)
        cell.font = HEAD
        cell.fill = HEAD_FILL
    if not fix_rows:
        ws4.append(["No fabrics relied on the fallback in this window. 🎉"])
    for f in fix_rows:
        ws4.append([
            f["sku"], f["name"], f["supplier"], _missing_str(f),
            len(f["_mos"]), round(f["metres"], 1), round(f["consumed_qty"], 1),
            None,
        ])
        url = _odoo_product_url(f["component_id"])
        if url:
            cell = ws4.cell(row=ws4.max_row, column=len(fix_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEFGH", [18, 40, 22, 16, 14, 16, 14, 14]):
        ws4.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    fname = "avg-metres-per-garment-%dd.xlsx" % days
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


# ── Avg metres / garment: category lookup shared by the by-category endpoints ─
# Category comes from all_products_clean.category joined on the MO's finished
# garment SKU (finished_sku = apc.sku). NOT on style_name: MO style names embed
# fabric + colour ("… in Rib - Dark Olive") and never match the product master.
# MOs whose finished SKU is missing from the product master fall into an
# explicit "Uncategorised" bucket so the breakdown reconciles to the headline.
_MPG_CATEGORY_SUBQ = """
    SELECT DISTINCT ON (sku) sku, category
    FROM all_products_clean
    WHERE category IS NOT NULL AND trim(category) != ''
    ORDER BY sku, category
"""
_MPG_UNCATEGORISED = "Uncategorised"


def _mpg_category_where(category, params):
    """WHERE fragment for an optional category filter (handles Uncategorised)."""
    if not category:
        return ""
    if category.strip().lower() == _MPG_UNCATEGORISED.lower():
        return "AND apc.category IS NULL"
    params.append(category)
    return "AND lower(trim(apc.category)) = lower(trim(%s))"


# ── Avg metres / garment: distinct garment categories in Done-DPS MOs ────────
# Returns the sorted list of garment categories that appear in qualifying
# Done-DPS MOs in the rolling window (+ "Uncategorised" when applicable).
# Used to populate the by-category card's dropdown.
@fabric_router.get("/api/fabric/metres-per-garment-categories")
def metres_per_garment_categories(days: int = Query(default=30)):
    days = max(1, min(int(days or 30), 730))
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT apc.category, COUNT(*) FILTER (WHERE apc.category IS NULL) AS n_uncat
            FROM mo_fabric_consumption c
            LEFT JOIN (%s) apc ON apc.sku = c.finished_sku
            WHERE c.done_date >= CURRENT_DATE - (%%s || ' days')::interval
              AND c.is_main_fabric
            GROUP BY apc.category
            ORDER BY apc.category
        """ % _MPG_CATEGORY_SUBQ, [days])
    cats = sorted({r["category"] for r in rows if r["category"]})
    if any(r["category"] is None for r in rows):
        cats.append(_MPG_UNCATEGORISED)
    return {"categories": cats, "window_days": days}


# ── Avg metres / garment: by garment category ────────────────────────────────
# When `category` is supplied: returns the same shape as /metres-per-garment
# but scoped to that garment category only.
# When `category` is omitted: returns a ranked list of all categories with
# their avg m/garment and MO count, sorted by avg desc — used as the default
# state of the by-category card on the dashboard.
# The fallback kg/m logic (and MO inclusion/exclusion rules) mirror the global
# endpoint exactly so the ranked totals reconcile to the global card.
@fabric_router.get("/api/fabric/metres-per-garment-by-category")
def metres_per_garment_by_category(
    days: int = Query(default=30),
    category: str = Query(default=None),
):
    days = max(1, min(int(days or 30), 730))
    with _get_conn() as conn:
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        # Optional category filter; "Uncategorised" selects MOs whose finished
        # SKU has no category in the product master.
        params = [days]
        extra_where = _mpg_category_where(category, params)

        rows = q(conn, ("""
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   apc.category
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            LEFT JOIN (%s) apc ON apc.sku = c.finished_sku
            WHERE c.done_date >= CURRENT_DATE - (%%s || ' days')::interval
              AND c.is_main_fabric
            """ % _MPG_CATEGORY_SUBQ) + extra_where, params)

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    if category:
        # Single-category path: same aggregation logic as the global card.
        mos = {}
        for r in rows:
            d = mos.setdefault(
                r["odoo_mo_id"],
                {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
                 "has_fabric": False, "used_fallback": False},
            )
            d["has_fabric"] = True
            qty = float(r["consumed_qty"] or 0)
            u = r["uom"]
            kpm = r["kpm"]
            if u in M_UOMS:
                d["metres"] += qty
            else:
                kg = qty / 1000.0 if u == "g" else qty
                if kpm and float(kpm) > 0:
                    d["metres"] += kg / float(kpm)
                elif fallback_kpm:
                    d["metres"] += kg / fallback_kpm
                    d["used_fallback"] = True
        total_metres = total_garments = 0.0
        n_mos = fallback_mos = 0
        for d in mos.values():
            if d["produced"] <= 0 or not d["has_fabric"]:
                continue
            total_metres += d["metres"]
            total_garments += d["produced"]
            n_mos += 1
            if d["used_fallback"]:
                fallback_mos += 1
        value = round(total_metres / total_garments, 2) if total_garments > 0 else None
        return {
            "category": category,
            "metres_per_garment": value,
            "total_metres": round(total_metres, 1),
            "garments": round(total_garments),
            "mos": n_mos,
            "mos_using_fallback": fallback_mos,
            "fallback_kg_per_mtr": round(fallback_kpm, 4) if fallback_kpm else None,
            "window_days": days,
        }
    else:
        # No-category path: fold per-MO → per-category ranked list.
        # An MO is assigned to its finished SKU's category; MOs with no match
        # in the product master go into an explicit "Uncategorised" bucket so
        # the breakdown reconciles to the headline KPI.
        cat_mos = {}
        for r in rows:
            cat = r["category"] or _MPG_UNCATEGORISED
            d = cat_mos.setdefault(cat, {}).setdefault(
                r["odoo_mo_id"],
                {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
                 "has_fabric": False, "used_fallback": False},
            )
            d["has_fabric"] = True
            qty = float(r["consumed_qty"] or 0)
            u = r["uom"]
            kpm = r["kpm"]
            if u in M_UOMS:
                d["metres"] += qty
            else:
                kg = qty / 1000.0 if u == "g" else qty
                if kpm and float(kpm) > 0:
                    d["metres"] += kg / float(kpm)
                elif fallback_kpm:
                    d["metres"] += kg / fallback_kpm
                    d["used_fallback"] = True

        out = []
        for cat, mos_dict in cat_mos.items():
            total_m = total_g = 0.0
            n = 0
            for d in mos_dict.values():
                if d["produced"] <= 0 or not d["has_fabric"]:
                    continue
                total_m += d["metres"]
                total_g += d["produced"]
                n += 1
            if total_g > 0:
                out.append({
                    "category": cat,
                    "metres_per_garment": round(total_m / total_g, 2),
                    "mos": n,
                })
        out.sort(key=lambda x: x["metres_per_garment"], reverse=True)
        return {
            "categories": out,
            "window_days": days,
            "fallback_kg_per_mtr": round(fallback_kpm, 4) if fallback_kpm else None,
        }


# ── Avg metres / garment by category: downloadable .xlsx audit trail ─────────
# Mirrors /metres-per-garment.xlsx with an added category join + optional filter.
# The per-MO exclusion / kg→metre conversion logic is identical to the by-category
# JSON endpoint so the workbook reconciles to the on-screen figure.
@fabric_router.get("/api/fabric/metres-per-garment-by-category.xlsx")
def metres_per_garment_by_category_xlsx(
    days: int = Query(default=30),
    category: str = Query(default=None),
):
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    days = max(1, min(int(days or 30), 730))

    with _get_conn() as conn:
        fb = q(conn, """
            SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
            FROM raw_fabric_products
            WHERE kg_per_mtr_eff > 0
        """)[0]
        fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None

        params = [days]
        extra_where = _mpg_category_where(category, params)

        rows = q(conn, ("""
            SELECT c.odoo_mo_id,
                   c.mo_ref,
                   c.dps_ref,
                   c.done_date,
                   c.produced_qty,
                   c.style_name,
                   c.finished_sku,
                   c.component_id,
                   c.fabric_sku,
                   c.fabric_name,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   p.kg_per_mtr AS kpm_stored,
                   p.width_m,
                   p.gsm,
                   p.supplier,
                   apc.category
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            LEFT JOIN (%s) apc ON apc.sku = c.finished_sku
            WHERE c.done_date >= CURRENT_DATE - (%%s || ' days')::interval
              AND c.is_main_fabric
            """ % _MPG_CATEGORY_SUBQ) + extra_where + """
            ORDER BY c.done_date DESC, c.odoo_mo_id, c.fabric_sku
        """, params)

    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    # Fold component rows → per-MO (same maths as the JSON endpoint).
    mos = {}
    components = []
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"mo_ref": r["mo_ref"], "dps_ref": r["dps_ref"],
             "done_date": r["done_date"],
             "style": (r["style_name"] or "").strip() or None,
             "category": r["category"] or _MPG_UNCATEGORISED,
             "finished_sku": r["finished_sku"],
             "produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "has_fabric": False, "used_fallback": False},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        comp = {
            "odoo_mo_id": r["odoo_mo_id"], "mo_ref": r["mo_ref"],
            "component_id": r["component_id"],
            "fabric_sku": r["fabric_sku"], "fabric_name": r["fabric_name"],
            "supplier": r["supplier"],
            "width_m": r["width_m"], "gsm": r["gsm"], "kpm_stored": r["kpm_stored"],
            "uom": r["uom"], "consumed_qty": qty,
            "kpm_used": None, "used_fallback": False, "metres": 0.0,
        }
        if u in M_UOMS:
            d["metres"] += qty
            comp["metres"] = qty
        else:
            kg = qty / 1000.0 if u == "g" else qty
            if kpm and float(kpm) > 0:
                m = kg / float(kpm)
                d["metres"] += m
                comp["kpm_used"] = float(kpm)
                comp["metres"] = m
            elif fallback_kpm:
                m = kg / fallback_kpm
                d["metres"] += m
                d["used_fallback"] = True
                comp["kpm_used"] = fallback_kpm
                comp["used_fallback"] = True
                comp["metres"] = m
        components.append(comp)

    per_mo = []
    qualifying_mo_ids = set()
    for mo_id, d in mos.items():
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        qualifying_mo_ids.add(mo_id)
        per_mo.append({
            "odoo_mo_id": mo_id, "mo_ref": d["mo_ref"], "dps_ref": d["dps_ref"],
            "done_date": d["done_date"], "style": d["style"],
            "category": d["category"],
            "finished_sku": d["finished_sku"], "garments": d["produced"],
            "total_metres": d["metres"],
            "metres_per_garment": (d["metres"] / d["produced"]) if d["produced"] > 0 else None,
            "used_fallback": d["used_fallback"],
        })
    per_mo.sort(key=lambda x: (x["done_date"] is None, x["done_date"], x["odoo_mo_id"]), reverse=True)

    # Summary totals (mirrors the JSON endpoint logic).
    total_m = sum(m["total_metres"] for m in per_mo)
    total_g = sum(m["garments"] for m in per_mo)
    n_mos = len(per_mo)
    n_fb = sum(1 for m in per_mo if m["used_fallback"])
    avg_mpg = round(total_m / total_g, 2) if total_g > 0 else None

    # ── Build workbook ───────────────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)

    def _style_header(ws, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    cat_label = category if category else "All categories"
    ws["A1"] = "Avg metres / garment by category — %s" % cat_label
    ws["A1"].font = TITLE
    srows = [
        ("Category filter", cat_label),
        ("Rolling window (days)", days),
        ("Avg metres / garment", avg_mpg),
        ("Total main-fabric metres", round(total_m, 1)),
        ("Total garments", round(total_g)),
        ("MOs counted", n_mos),
        ("MOs using fallback conversion", n_fb),
        ("Fallback kg per metre", round(fallback_kpm, 4) if fallback_kpm else None),
        ("Basis", "Done DPS manufacturing orders, main-fabric components only"),
    ]
    r0 = 3
    for i, (label, val) in enumerate(srows):
        ws.cell(row=r0 + i, column=1, value=label).font = LBL
        ws.cell(row=r0 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 56

    # Per-MO sheet (includes Category column)
    ws2 = wb.create_sheet("Per-MO")
    mo_cols = ["MO ref", "DPS ref", "Done date", "Finished style", "Category",
               "Finished SKU", "Garments produced", "Total metres",
               "Metres / garment", "Used fallback conversion"]
    ws2.append(mo_cols)
    _style_header(ws2, len(mo_cols))
    for m in per_mo:
        ws2.append([
            m["mo_ref"], m["dps_ref"],
            (m["done_date"].isoformat() if hasattr(m["done_date"], "isoformat") else m["done_date"]),
            m["style"], m["category"], m["finished_sku"],
            round(m["garments"], 2),
            round(m["total_metres"], 3),
            (round(m["metres_per_garment"], 3) if m["metres_per_garment"] is not None else None),
            "Yes" if m["used_fallback"] else "No",
        ])
    for col, w in zip("ABCDEFGHIJ", [16, 22, 12, 34, 16, 16, 16, 14, 16, 22]):
        ws2.column_dimensions[col].width = w

    # Per-component sheet
    ws3 = wb.create_sheet("Per-component")
    comp_cols = ["MO ref", "Fabric SKU", "Fabric name", "UoM",
                 "Consumed qty", "Kg per metre used", "Used fallback",
                 "Metres contributed", "Open in Odoo"]
    ws3.append(comp_cols)
    _style_header(ws3, len(comp_cols))
    LINK = Font(color="1A5C38", underline="single")
    for c in components:
        if c["odoo_mo_id"] not in qualifying_mo_ids:
            continue
        ws3.append([
            c["mo_ref"], c["fabric_sku"], c["fabric_name"], c["uom"],
            round(c["consumed_qty"], 3),
            (round(c["kpm_used"], 4) if c["kpm_used"] is not None else None),
            "Yes" if c["used_fallback"] else "No",
            round(c["metres"], 3),
            None,
        ])
        if c["used_fallback"]:
            url = _odoo_product_url(c["component_id"])
            if url:
                cell = ws3.cell(row=ws3.max_row, column=len(comp_cols))
                cell.value = "Open in Odoo"
                cell.hyperlink = url
                cell.font = LINK
    for col, w in zip("ABCDEFGHI", [16, 18, 40, 8, 14, 18, 14, 18, 14]):
        ws3.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    safe_cat = (category or "all-categories").replace(" ", "-").lower()
    fname = "avg-metres-per-garment-%s-%dd.xlsx" % (safe_cat, days)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


# ── Minimum received roll width per supplier fabric code + colour ────────────
# Buying & PD card: the narrowest MEASURED width received per (supplier fabric
# code, effective colour) combination, so buyers/PD know the minimum usable
# width they can plan markers against.
#
# A roll's measured width (priority order, per the 4-Point inspection
# convention — the receiving-sheet reference width NEVER counts):
#   1. the inspector's cuttable (usable) width from the latest inspection
#      ticket for that roll (cuttable_width_cm),
#   2. else the inspector's manual full width (manual_width_cm),
#   3. else the width captured on the receiving roll itself (width_measured_m,
#      the width_edit grantee's per-roll measurement).
# Combinations whose rolls have NO measured width return min_width_m = null so
# the UI can show "no data" instead of a misleading zero.
@fabric_router.get("/api/fabric/min-roll-width")
def min_roll_width(search: str = Query(default=None)):
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, """
            WITH insp AS (
                SELECT DISTINCT ON (sheet_id, roll_no)
                       sheet_id, roll_no, cuttable_width_cm, manual_width_cm
                FROM fabric_inspection_tickets
                ORDER BY sheet_id, roll_no, id DESC
            )
            SELECT r.id AS roll_id,
                   r.width_measured_m,
                   i.cuttable_width_cm,
                   i.manual_width_cm,
                   s.product_id,
                   COALESCE(NULLIF(BTRIM(p.name),''), s.fabric_name) AS fabric_name,
                   NULLIF(BTRIM(p.supplier_fabric_code),'') AS supplier_fabric_code,
                   NULLIF(BTRIM(p.odoo_fabric_color),'')    AS odoo_fabric_color,
                   p.fabric_color
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            LEFT JOIN insp i ON i.sheet_id = r.sheet_id AND i.roll_no = r.roll_no
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL
        """)

    def _roll_width(r):
        """(width_m, source) for one roll, or (None, None) when unmeasured."""
        for col, src, div in (("cuttable_width_cm", "cuttable", 100.0),
                              ("manual_width_cm", "manual", 100.0),
                              ("width_measured_m", "roll", 1.0)):
            v = r.get(col)
            try:
                if v is not None and float(v) > 0:
                    return float(v) / div, src
            except (TypeError, ValueError):
                pass
        return None, None

    combos = {}
    for r in rows:
        code = r.get("supplier_fabric_code") or (r.get("fabric_name") or "Unknown fabric")
        # Effective colour: Odoo fabric colour first, else the shared
        # name/fabric_color parser (same rule as fabric_color_effective).
        color = r.get("odoo_fabric_color")
        if not color:
            fc, _pc = _derive_fabric_colors(r.get("fabric_name"), r.get("fabric_color"))
            color = fc
        key = (code, color or "")
        c = combos.setdefault(key, {
            "fabric_code": code,
            "color": color,
            "label": code + " - " + (color or "No colour"),
            "min_width_m": None,
            "min_width_source": None,
            "rolls_total": 0,
            "rolls_measured": 0,
        })
        c["rolls_total"] += 1
        w, src = _roll_width(r)
        if w is not None:
            c["rolls_measured"] += 1
            if c["min_width_m"] is None or w < c["min_width_m"]:
                c["min_width_m"] = w
                c["min_width_source"] = src

    out = list(combos.values())
    if search:
        needle = search.strip().lower()
        out = [c for c in out if needle in c["label"].lower()]
    # Narrowest measured combinations first; unmeasured ("no data") last.
    out.sort(key=lambda c: (c["min_width_m"] is None,
                            c["min_width_m"] if c["min_width_m"] is not None else 0,
                            c["label"].lower()))
    for c in out:
        if c["min_width_m"] is not None:
            c["min_width_m"] = round(c["min_width_m"], 2)
    return {"combinations": out, "total": len(out)}


# ── Minimum CUTTABLE width per supplier fabric code + colour ─────────────────
# Buying & PD card: strict variant of min-roll-width. Per roll, ONLY the
# inspector's cuttable (usable) width from the latest 4-Point inspection
# ticket counts — no manual-width or receiving-roll fallback — so buyers/PD
# can plan markers against a strictly inspected usable width. Combinations
# with no cuttable widths return min_cuttable_m = null ("no data", never a
# misleading zero); rolls_total / rolls_with_cuttable let the UI flag rolls
# still pending inspection input.
@fabric_router.get("/api/fabric/min-cuttable-width")
def min_cuttable_width(search: str = Query(default=None)):
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, """
            WITH insp AS (
                SELECT DISTINCT ON (sheet_id, roll_no)
                       sheet_id, roll_no, cuttable_width_cm
                FROM fabric_inspection_tickets
                ORDER BY sheet_id, roll_no, id DESC
            )
            SELECT i.cuttable_width_cm,
                   s.product_id,
                   COALESCE(NULLIF(BTRIM(p.name),''), s.fabric_name) AS fabric_name,
                   NULLIF(BTRIM(p.supplier_fabric_code),'') AS supplier_fabric_code,
                   NULLIF(BTRIM(p.odoo_fabric_color),'')    AS odoo_fabric_color,
                   p.fabric_color
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            LEFT JOIN insp i ON i.sheet_id = r.sheet_id AND i.roll_no = r.roll_no
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL
        """)

    combos = {}
    for r in rows:
        code = r.get("supplier_fabric_code") or (r.get("fabric_name") or "Unknown fabric")
        # Same effective-colour rule as min-roll-width so both cards agree on
        # the combination list.
        color = r.get("odoo_fabric_color")
        if not color:
            fc, _pc = _derive_fabric_colors(r.get("fabric_name"), r.get("fabric_color"))
            color = fc
        key = (code, color or "")
        c = combos.setdefault(key, {
            "fabric_code": code,
            "color": color,
            "label": code + " - " + (color or "No colour"),
            "min_cuttable_m": None,
            "rolls_total": 0,
            "rolls_with_cuttable": 0,
        })
        c["rolls_total"] += 1
        v = r.get("cuttable_width_cm")
        try:
            w = float(v) / 100.0 if v is not None and float(v) > 0 else None
        except (TypeError, ValueError):
            w = None
        if w is not None:
            c["rolls_with_cuttable"] += 1
            if c["min_cuttable_m"] is None or w < c["min_cuttable_m"]:
                c["min_cuttable_m"] = w

    out = list(combos.values())
    if search:
        needle = search.strip().lower()
        out = [c for c in out if needle in c["label"].lower()]
    # Narrowest inspected combinations first; no-data last.
    out.sort(key=lambda c: (c["min_cuttable_m"] is None,
                            c["min_cuttable_m"] if c["min_cuttable_m"] is not None else 0,
                            c["label"].lower()))
    rolls_total = sum(c["rolls_total"] for c in out)
    rolls_with = sum(c["rolls_with_cuttable"] for c in out)
    for c in out:
        if c["min_cuttable_m"] is not None:
            c["min_cuttable_m"] = round(c["min_cuttable_m"], 2)
    return {"combinations": out, "total": len(out),
            "rolls_total": rolls_total, "rolls_with_cuttable": rolls_with}


# ── Shrinkage Report · by supplier fabric code + colour (Buying & PD) ────────
# Worst after-wash shrinkage per (supplier fabric code, effective colour), so
# buyers/PD can adjust patterns and supplier decisions. Per axis (W and L),
# INDEPENDENTLY: the worst shrinkage across all measured rolls of the combo —
# W and L may come from different rolls.
#   Modern gauge-square rolls: pct = (35 − after-wash cm) / 35 × 100;
#   inches lost = (35 − after-wash cm) / 2.54 against the 13.78" gauge.
#   Legacy rolls (single shrinkage_inches, no axis split): pct ≈
#   inches × 2.54 / 35 × 100, shown in BOTH axes and flagged legacy.
# Combos exceeding the 14.3% action threshold on either axis are flagged.
_SHRINK_FLAG_PCT = 14.3
_SHRINK_GAUGE_IN = 35.0 / 2.54  # 13.78"

_SHRINK_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def _shrink_axis_from_cm(v):
    """(inches_lost, pct) for one gauge-square axis measurement, or None."""
    try:
        c = float(v)
    except (TypeError, ValueError):
        return None
    if c <= 0:
        return None
    lost_cm = 35.0 - c
    return (lost_cm / 2.54, lost_cm / 35.0 * 100.0)

def _shrink_legacy(v):
    """(inches_lost, pct) for a legacy single shrinkage_inches figure."""
    try:
        inches = float(v)
    except (TypeError, ValueError):
        return None
    return (inches, inches * 2.54 / 35.0 * 100.0)

def _shrinkage_report_data(date_from=None, date_to=None, search=None):
    """Shared builder for the shrinkage report endpoint and its export.
    Receiving-date window = PO date, falling back to the sheet's EAT save
    date (same rule as the QC report)."""
    where, params = [], []
    if date_from:
        where.append("COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) >= %s::date")
        params.append(date_from)
    if date_to:
        where.append("COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) <= %s::date")
        params.append(date_to)
    extra = (" AND " + " AND ".join(where)) if where else ""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            SELECT r.id AS roll_id, r.roll_no,
                   r.after_wash_width_cm, r.after_wash_length_cm,
                   r.shrinkage_inches,
                   s.id AS sheet_id, s.po_name,
                   COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date)::text AS recv_date,
                   COALESCE(NULLIF(BTRIM(p.name),''), s.fabric_name) AS fabric_name,
                   NULLIF(BTRIM(p.supplier_fabric_code),'') AS supplier_fabric_code,
                   NULLIF(BTRIM(p.odoo_fabric_color),'')    AS odoo_fabric_color,
                   p.fabric_color
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL{extra}
            ORDER BY s.id, r.roll_no
        """, tuple(params) if params else None)

    combos = {}
    for r in rows:
        code = r.get("supplier_fabric_code") or (r.get("fabric_name") or "Unknown fabric")
        # Effective colour — same rule as min-roll-width / min-cuttable-width
        # so all Buying & PD combination lists agree.
        color = r.get("odoo_fabric_color")
        if not color:
            fc, _pc = _derive_fabric_colors(r.get("fabric_name"), r.get("fabric_color"))
            color = fc
        key = (code, color or "")
        c = combos.setdefault(key, {
            "fabric_code": code,
            "color": color,
            "label": code + " - " + (color or "No colour"),
            "worst_w": None,   # {"in","pct","sheet_id","po_name","recv_date","roll_no","legacy"}
            "worst_l": None,
            "rolls_total": 0,
            "rolls_measured": 0,
            "legacy_rolls": 0,
            "flagged": False,
            "rolls": [],
        })
        c["rolls_total"] += 1
        aw = _shrink_axis_from_cm(r.get("after_wash_width_cm"))
        al = _shrink_axis_from_cm(r.get("after_wash_length_cm"))
        legacy = None
        if aw is None and al is None:
            legacy = _shrink_legacy(r.get("shrinkage_inches"))
            if legacy is not None:
                aw = al = legacy
        if aw is None and al is None:
            continue
        c["rolls_measured"] += 1
        is_legacy = legacy is not None
        if is_legacy:
            c["legacy_rolls"] += 1
        meta = {"sheet_id": r["sheet_id"], "po_name": r.get("po_name"),
                "recv_date": r.get("recv_date"), "roll_no": r.get("roll_no"),
                "legacy": is_legacy}
        detail = dict(meta)
        detail.update({
            "roll_id": r["roll_id"],
            "w_in": round(aw[0], 2) if aw else None,
            "w_pct": round(aw[1], 1) if aw else None,
            "l_in": round(al[0], 2) if al else None,
            "l_pct": round(al[1], 1) if al else None,
            "shrinkage_inches": (float(r["shrinkage_inches"])
                                 if is_legacy and r.get("shrinkage_inches") is not None else None),
        })
        c["rolls"].append(detail)
        for axis, val in (("worst_w", aw), ("worst_l", al)):
            if val is None:
                continue
            cur = c[axis]
            if cur is None or val[1] > cur["pct"]:
                c[axis] = dict(meta, **{"in": round(val[0], 2),
                                        "pct": round(val[1], 1)})

    out = []
    for c in combos.values():
        if not c["rolls_measured"]:
            continue  # nothing measured in this window — no row
        worst = max((a["pct"] for a in (c["worst_w"], c["worst_l"]) if a),
                    default=None)
        c["worst_pct"] = worst
        c["flagged"] = worst is not None and worst > _SHRINK_FLAG_PCT
        out.append(c)
    if search:
        needle = search.strip().lower()
        out = [c for c in out if needle in c["label"].lower()]
    # Worst shrinkers first.
    out.sort(key=lambda c: (-(c["worst_pct"] or 0), c["label"].lower()))
    return out

@fabric_router.get("/api/fabric/shrinkage-report")
def shrinkage_report(date_from: str = Query(default=""),
                     date_to: str = Query(default=""),
                     search: str = Query(default=None)):
    df = date_from.strip() if date_from and _SHRINK_DATE_RE.match(date_from.strip()) else None
    dt_ = date_to.strip() if date_to and _SHRINK_DATE_RE.match(date_to.strip()) else None
    out = _shrinkage_report_data(df, dt_, search)
    return {"combinations": out, "total": len(out),
            "flag_pct": _SHRINK_FLAG_PCT,
            "gauge_in": round(_SHRINK_GAUGE_IN, 2)}

@fabric_router.get("/api/fabric/shrinkage-report.csv")
def shrinkage_report_csv(date_from: str = Query(default=""),
                         date_to: str = Query(default="")):
    """CSV export of the shrinkage report, honouring the active date filter."""
    from fastapi.responses import Response
    import csv as _csv
    import io
    df = date_from.strip() if date_from and _SHRINK_DATE_RE.match(date_from.strip()) else None
    dt_ = date_to.strip() if date_to and _SHRINK_DATE_RE.match(date_to.strip()) else None
    out = _shrinkage_report_data(df, dt_)
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(["Fabric code", "Colour",
                "Worst W (in lost on 13.78\" gauge)", "Worst W (%)",
                "Worst W source (sheet / date)",
                "Worst L (in lost on 13.78\" gauge)", "Worst L (%)",
                "Worst L source (sheet / date)",
                "Rolls measured", "Rolls total", "Legacy rolls",
                "Flagged (> %s%% either axis)" % _SHRINK_FLAG_PCT])
    def _src(a):
        if not a:
            return ""
        s = "%s roll %s · %s" % (a.get("po_name") or ("Sheet #%s" % a["sheet_id"]),
                                 a.get("roll_no"), a.get("recv_date") or "")
        return s + (" (legacy)" if a.get("legacy") else "")
    for c in out:
        ww, wl = c["worst_w"], c["worst_l"]
        w.writerow([c["fabric_code"], c["color"] or "No colour",
                    ww["in"] if ww else "", ww["pct"] if ww else "", _src(ww),
                    wl["in"] if wl else "", wl["pct"] if wl else "", _src(wl),
                    c["rolls_measured"], c["rolls_total"], c["legacy_rolls"],
                    "YES" if c["flagged"] else ""])
    fname = "shrinkage-report"
    if df or dt_:
        fname += "_%s_to_%s" % (df or "start", dt_ or "today")
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="%s.csv"' % fname},
    )

@fabric_router.put("/api/fabric/receiving/roll/{roll_id}/legacy-shrinkage")
def receiving_roll_legacy_shrinkage(roll_id: int, request: Request,
                                    body: dict = Body(...)):
    """Correct a LEGACY roll's single shrinkage figure (inches) from the
    Buying & PD shrinkage report. Only rolls WITHOUT gauge-square after-wash
    measurements are editable here (modern measurements stay read-only).
    Gated to the same authority as receiving-sheet QC sign-off (admin or
    fabric_quality_supervisor). Every edit is audited to fabric_recv_audit
    (who, when, old → new)."""
    if not _insp_can_approve(request):
        raise HTTPException(status_code=403,
            detail="Only admins or fabric quality supervisors may edit legacy shrinkage figures")
    raw = body.get("shrinkage_inches")
    if raw in (None, ""):
        new_v = None
    else:
        try:
            new_v = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail="shrinkage_inches must be a number")
        if not (0 <= new_v <= _SHRINK_GAUGE_IN):
            raise HTTPException(status_code=400,
                detail="shrinkage_inches must be between 0 and 13.78 (the gauge width)")
        new_v = round(new_v, 2)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rolls = q(conn, """
            SELECT r.id, r.sheet_id, r.roll_no, r.shrinkage_inches,
                   r.after_wash_width_cm, r.after_wash_length_cm,
                   s.fabric_name, s.po_id
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            WHERE r.id=%s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
        """, (roll_id,))
        if not rolls:
            raise HTTPException(status_code=404, detail="roll not found")
        roll = rolls[0]
        if roll.get("after_wash_width_cm") is not None or roll.get("after_wash_length_cm") is not None:
            raise HTTPException(status_code=409,
                detail="This roll has gauge-square measurements — only legacy single-figure entries are editable here")
        old_v = roll.get("shrinkage_inches")
        old_v = float(old_v) if old_v is not None else None
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_rolls
                   SET shrinkage_inches=%s
                 WHERE id=%s
            """, (new_v, roll_id))
            _recv_audit(cur, roll.get("po_id"), roll["sheet_id"],
                        roll.get("fabric_name"), "legacy_shrinkage_updated",
                        {"roll_id": roll_id,
                         "roll_no": roll["roll_no"],
                         "old_inches": old_v,
                         "new_inches": new_v},
                        name)
        conn.commit()
    _fabric_log_activity(request, "PUT",
                         f"/api/fabric/receiving/roll/{roll_id}/legacy-shrinkage",
                         f"shrinkage_inches: {old_v} -> {new_v}")
    return {"ok": True, "roll_id": roll_id, "roll_no": roll["roll_no"],
            "shrinkage_inches": new_v}

@fabric_router.get("/api/fabric/shrinkage-audit")
def shrinkage_audit(roll_id: int = Query(default=None),
                    limit: int = Query(default=100)):
    """Edit history for legacy shrinkage corrections (who, when, old → new).
    Optionally filtered to one roll."""
    limit = max(1, min(int(limit or 100), 500))
    where = "action='legacy_shrinkage_updated'"
    params = []
    if roll_id is not None:
        where += " AND (details->>'roll_id')::bigint = %s"
        params.append(roll_id)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            SELECT id, sheet_id, fabric_name, details, actor_name,
                   to_char(at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY HH24:MI') AS at
            FROM fabric_recv_audit
            WHERE {where}
            ORDER BY id DESC
            LIMIT {limit}
        """, tuple(params) if params else None)
    out = []
    for r in rows:
        d = r.get("details") or {}
        out.append({"id": r["id"], "sheet_id": r.get("sheet_id"),
                    "fabric_name": r.get("fabric_name"),
                    "roll_id": d.get("roll_id"), "roll_no": d.get("roll_no"),
                    "old_inches": d.get("old_inches"),
                    "new_inches": d.get("new_inches"),
                    "actor": r.get("actor_name"), "at": r.get("at")})
    return {"entries": out, "total": len(out)}


# ── Basic Fabrics — Months of Cover: downloadable .xlsx calculations report ──
# The full audit trail behind the "Basic Fabrics — Months of Cover" Overview KPI:
# every curated (vendor, fabric-code) pairing and whether it matched a product,
# each matched product with its RMAT/Stock on-hand kg, and the 6-month net
# consumption that drives the run-rate denominator. The cover figure and the
# stock/run-rate it divides MUST mirror the summary KPI exactly (same resolver,
# same RMAT/Stock base, same _months_of_cover projection over the curated ids) so
# the workbook reconciles to the card.
@fabric_router.get("/api/fabric/basic-fabrics-cover.xlsx")
def basic_fabrics_cover_xlsx():
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    with _get_conn() as conn:
        # Per-pair resolution — same matching as _resolve_basic_fabrics, but the
        # per-pairing product ids are kept so the "Curated fabrics" sheet can show
        # exactly which pairings matched and what each one holds in stock.
        pair_rows = []   # {supplier, code, ids:set}
        all_ids = set()
        for supplier, codes in BASIC_FABRICS.items():
            for code in codes:
                esc = (str(code).replace("\\", "\\\\")
                                .replace("%", "\\%")
                                .replace("_", "\\_"))
                like = f"%{esc}%"
                rows = q(conn, r"""
                    SELECT id FROM raw_fabric_products p
                    WHERE lower(btrim(COALESCE(p.supplier,''))) = lower(btrim(%s))
                      AND (COALESCE(p.name,'')         ILIKE %s ESCAPE '\'
                        OR COALESCE(p.default_code,'') ILIKE %s ESCAPE '\'
                        OR COALESCE(p.barcode,'')      ILIKE %s ESCAPE '\')
                """, [supplier, like, like, like])
                ids = {r["id"] for r in rows}
                all_ids.update(ids)
                pair_rows.append({"supplier": supplier, "code": code, "ids": ids})

        basic_ids = list(all_ids)
        matched = sum(1 for p in pair_rows if p["ids"])
        total = len(pair_rows)

        # Per-product master info + RMAT/Stock on-hand kg (the cover stock base).
        prod_info, stock_by_pid = {}, {}
        if basic_ids:
            ids_csv = ",".join(str(int(x)) for x in basic_ids)
            for r in q(conn, f"""
                SELECT id, default_code AS sku, name, supplier,
                       fabric_category AS category
                FROM raw_fabric_products WHERE id IN ({ids_csv})
            """):
                prod_info[r["id"]] = r
            for r in q(conn, f"""
                SELECT i.product_id AS pid, ROUND(SUM(i.quantity)::numeric, 1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name = 'RMAT/Stock'
                  AND i.product_id IN ({ids_csv})
                GROUP BY i.product_id
            """):
                stock_by_pid[r["pid"]] = float(r["kg"] or 0)
            # Headline stock MUST use the SAME single-aggregate ROUND(SUM(...))
            # the KPI uses (NOT SUM of per-product ROUNDs — that drifts by a few
            # tenths and breaks reconciliation). Per-product values above stay for
            # the detail sheet only.
            basic_stock_kg = q(conn, f"""
                SELECT ROUND(SUM(i.quantity)::numeric, 1) AS kg
                FROM raw_fabric_inventory i
                WHERE i.quantity > 0
                  AND i.location_name = 'RMAT/Stock'
                  AND i.product_id IN ({ids_csv})
            """)[0]["kg"] or 0
            basic_stock_kg = round(float(basic_stock_kg), 1)
        else:
            basic_stock_kg = 0.0

        # Cover + run-rate (identical to the summary KPI: bypasses main/support
        # scope, restricted to the curated ids, RMAT/Stock kg base).
        if basic_ids:
            cov = _months_of_cover(conn, basic_stock_kg, "main",
                                   product_ids=basic_ids)
            status = cov["months_of_cover_status"]
        else:
            cov = {"months_of_cover": None, "months_of_cover_status": "no_match",
                   "avg_monthly_consumption_kg": 0.0}
            status = "no_match"

        # 6-month net consumption by month for the curated set (same window/model
        # as _months_of_cover so the run-rate denominator is auditable).
        if basic_ids:
            ids_csv = ",".join(str(int(x)) for x in basic_ids)
            month_rows = q(conn, f"""
                SELECT to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
                       SUM({_net_kg('m')})::numeric AS kg
                FROM {EFFECTIVE_MOVES} m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {_net_cons_where('m')}
                  AND m.product_id IN ({ids_csv})
                  AND m.date::date >= (date_trunc('month', CURRENT_DATE)
                                       - INTERVAL '6 months')::date
                  AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
                GROUP BY 1 ORDER BY 1
            """)
        else:
            month_rows = []

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    LINK = Font(color="1A5C38", underline="single")

    def _style_header(ws, ncols, row=1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    _status_text = {
        "ok": "OK — computed from run-rate",
        "overstocked": "Overstocked — stock on hand but no recent consumption",
        "no_data": "No data — no curated stock or consumption",
        "no_match": "No match — no curated fabric resolved to a product",
    }
    cover_disp = (cov["months_of_cover"] if status == "ok"
                  and cov["months_of_cover"] is not None
                  else ("12+ (overstocked)" if status == "overstocked" else "—"))

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Basic Fabrics — Months of Cover — calculations report"
    ws["A1"].font = TITLE
    srows = [
        ("Basic Fabrics — Months of Cover (KPI)", cover_disp),
        ("Status", _status_text.get(status, status)),
        ("Curated fabrics matched", "%d of %d" % (matched, total)),
        ("RMAT/Stock on hand (kg)", basic_stock_kg),
        ("Avg monthly net consumption (kg)", cov.get("avg_monthly_consumption_kg")),
        ("Cover window (months)", 6),
        ("Basis", "RMAT/Stock on-hand kg ÷ average net monthly consumption over "
                  "the last 6 fully completed months, restricted to the curated "
                  "staple fabrics"),
        ("Reconciliation", "Stock on hand ÷ Avg monthly net consumption "
                           "= Months of cover"),
    ]
    for i, (label, val) in enumerate(srows):
        ws.cell(row=3 + i, column=1, value=label).font = LBL
        ws.cell(row=3 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 58

    # Curated fabrics sheet (one row per vendor+code pairing)
    ws2 = wb.create_sheet("Curated fabrics")
    cur_cols = ["Vendor / supplier", "Fabric code", "Matched",
                "Products matched", "Stock on hand (kg)"]
    ws2.append(cur_cols)
    _style_header(ws2, len(cur_cols))
    for p in pair_rows:
        pkg = round(sum(stock_by_pid.get(pid, 0.0) for pid in p["ids"]), 1)
        ws2.append([
            p["supplier"], str(p["code"]),
            "Yes" if p["ids"] else "No",
            len(p["ids"]),
            pkg if p["ids"] else None,
        ])
    for col, w in zip("ABCDE", [24, 18, 10, 18, 18]):
        ws2.column_dimensions[col].width = w

    # Matched products sheet (one row per resolved product; reconciles to stock)
    ws3 = wb.create_sheet("Matched products")
    prod_cols = ["Fabric SKU", "Fabric name", "Supplier", "Category",
                 "Stock on hand (kg)", "Open in Odoo"]
    ws3.append(prod_cols)
    _style_header(ws3, len(prod_cols))
    prod_sorted = sorted(
        basic_ids, key=lambda pid: stock_by_pid.get(pid, 0.0), reverse=True)
    if not prod_sorted:
        ws3.append(["No curated fabric currently resolves to a product."])
    for pid in prod_sorted:
        info = prod_info.get(pid, {})
        ws3.append([
            info.get("sku"), info.get("name"), info.get("supplier"),
            info.get("category"), round(stock_by_pid.get(pid, 0.0), 1), None,
        ])
        url = _odoo_product_url(pid)
        if url:
            cell = ws3.cell(row=ws3.max_row, column=len(prod_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEF", [18, 40, 22, 18, 18, 14]):
        ws3.column_dimensions[col].width = w

    # Monthly consumption sheet (the 6-month net run-rate detail)
    ws4 = wb.create_sheet("Monthly consumption")
    mc_cols = ["Month", "Net consumption (kg)"]
    ws4.append(mc_cols)
    _style_header(ws4, len(mc_cols))
    for r in month_rows:
        ws4.append([r["mon"], round(float(r["kg"] or 0), 1)])
    ws4.append([])
    ws4.append(["Avg monthly net consumption (kg)",
                cov.get("avg_monthly_consumption_kg")])
    ws4.cell(row=ws4.max_row, column=1).font = LBL
    for col, w in zip("AB", [34, 22]):
        ws4.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="basic-fabrics-months-of-cover.xlsx"'},
    )


# ── Months of Cover (general) — downloadable .xlsx calculations report ──
# The full audit trail behind the general "Months of cover" Overview KPI (the
# main-scope figure, NOT the curated Basic-Fabrics set): the current RMAT/Stock
# fabric on-hand kg, the trailing 6-completed-month average net monthly run-rate,
# and the resulting cover value — with the per-month net-consumption breakdown
# that drives the denominator. Stock base + run-rate MUST mirror the summary KPI
# exactly (same RMAT/Stock main-scope base + same `_months_of_cover` projection)
# so the workbook reconciles to the card.
@fabric_router.get("/api/fabric/months-of-cover.xlsx")
def months_of_cover_xlsx():
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, PatternFill

    with _get_conn() as conn:
        # Headline stock base — identical query to the live summary card /
        # snapshot: main-scope Fabric RMAT/Stock on-hand kg (single-aggregate
        # ROUND(SUM(...)) so it matches to the tenth).
        rmat_kg = q(conn, f"""
            SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
              AND {_scope_sql('main')}
        """)[0]['kg'] or 0
        rmat_kg = round(float(rmat_kg), 1)

        cov = _months_of_cover(conn, rmat_kg, "main")
        status = cov["months_of_cover_status"]
        breakdown = cov.get("months_breakdown") or []

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)

    def _style_header(ws, ncols, row=1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    _status_text = {
        "ok": "OK — computed from run-rate",
        "overstocked": "Overstocked — stock on hand but no recent consumption",
        "no_data": "No data — no stock or consumption",
    }
    cover_disp = (cov["months_of_cover"] if status == "ok"
                  and cov["months_of_cover"] is not None
                  else ("12+ (overstocked)" if status == "overstocked" else "—"))

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Months of cover — calculations report"
    ws["A1"].font = TITLE
    srows = [
        ("Months of cover (KPI)", cover_disp),
        ("Status", _status_text.get(status, status)),
        ("RMAT/Stock on hand (kg)", rmat_kg),
        ("Avg monthly net consumption (kg)", cov.get("avg_monthly_consumption_kg")),
        ("Cover window (months)", cov.get("cover_window_months", 6)),
        ("Basis", "RMAT/Stock on-hand kg ÷ average net monthly consumption over "
                  "the last 6 fully completed months (main-scope fabrics)"),
        ("Reconciliation", "Stock on hand ÷ Avg monthly net consumption "
                           "= Months of cover"),
    ]
    for i, (label, val) in enumerate(srows):
        ws.cell(row=3 + i, column=1, value=label).font = LBL
        ws.cell(row=3 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 58

    # Monthly consumption sheet (the 6-month net run-rate detail that feeds the
    # denominator — the average of these equals the run-rate above).
    ws2 = wb.create_sheet("Monthly consumption")
    mc_cols = ["Month", "Net consumption (kg)"]
    ws2.append(mc_cols)
    _style_header(ws2, len(mc_cols))
    for r in breakdown:
        ws2.append([r.get("month"), round(float(r.get("kg") or 0), 1)])
    ws2.append([])
    ws2.append(["Avg monthly net consumption (kg)",
                cov.get("avg_monthly_consumption_kg")])
    ws2.cell(row=ws2.max_row, column=1).font = LBL
    for col, w in zip("AB", [34, 22]):
        ws2.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="months-of-cover.xlsx"'},
    )


# ── Months of Cover (prev month) — downloadable .xlsx calculations report ──
# Audit trail behind the "Months of cover · Prev Month Consumpt." KPI card: the
# same main-scope RMAT/Stock on-hand kg, but divided by ONLY the previous full
# calendar month's (M-1) net consumption instead of the 6-month run-rate. Stock
# base + figure MUST mirror the summary card exactly (same RMAT/Stock query +
# same `_months_of_cover_prev_month` projection) so the workbook reconciles.
@fabric_router.get("/api/fabric/months-of-cover-prev-month.xlsx")
def months_of_cover_prev_month_xlsx():
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font

    with _get_conn() as conn:
        rmat_kg = q(conn, f"""
            SELECT ROUND(SUM(i.quantity)::numeric,1) AS kg
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category='Fabric' AND i.location_name='RMAT/Stock'
              AND {_scope_sql('main')}
        """)[0]['kg'] or 0
        rmat_kg = round(float(rmat_kg), 1)

        cov = _months_of_cover_prev_month(conn, rmat_kg, "main")

    status = cov["months_of_cover_prev_month_status"]
    _status_text = {
        "ok": "OK — computed from last month's net consumption",
        "overstocked": "Overstocked — stock on hand but no consumption last month",
        "no_data": "No data — no stock or last-month consumption",
    }
    cover_disp = (cov["months_of_cover_prev_month"]
                  if status == "ok" and cov["months_of_cover_prev_month"] is not None
                  else ("12+ (overstocked)" if status == "overstocked" else "—"))

    wb = openpyxl.Workbook()
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Months of cover (prev month) — calculations report"
    ws["A1"].font = TITLE
    srows = [
        ("Months of cover, prev month (KPI)", cover_disp),
        ("Status", _status_text.get(status, status)),
        ("RMAT/Stock on hand (kg)", rmat_kg),
        ("Previous month", cov.get("months_of_cover_prev_month_label")),
        ("Prev-month net consumption (kg)",
         cov.get("months_of_cover_prev_month_consumption_kg")),
        ("Basis", "RMAT/Stock on-hand kg ÷ the net consumption of the previous "
                  "full calendar month (M-1), main-scope fabrics — more reactive "
                  "than the 6-month average"),
        ("Reconciliation", "Stock on hand ÷ Prev-month net consumption "
                           "= Months of cover (prev month)"),
    ]
    for i, (label, val) in enumerate(srows):
        ws.cell(row=3 + i, column=1, value=label).font = LBL
        ws.cell(row=3 + i, column=2, value=val)
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 70

    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="months-of-cover-prev-month.xlsx"'},
    )


# ── Data quality: fabrics driving the metres/garment fallback ──────────
# The "Avg metres / garment" KPI converts any Done-DPS MO whose main fabric has
# no usable kg→metre conversion using the overall fabric-average (fallback) so the
# MO is still counted — but the figure is then approximate. This lists the fabric
# SKUs responsible, how many MOs and garments each one affects, what's missing
# (Width/GSM or a stored kg/m), and a deep link to its Odoo product so a buyer can
# fill it in and make the KPI exact. The bad-MO determination MUST mirror
# metres_per_garment exactly (same window, same convertibility test, NULL kpm
# treated as missing). A garment/MO can be affected by more than one fabric, so
# per-fabric counts can sum to more than the total.
@fabric_router.get("/api/fabric/data-quality/mo-missing-conversion")
def mo_missing_conversion(days: int = Query(default=90)):
    days = max(1, min(int(days or 90), 730))
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   c.component_id,
                   c.fabric_sku,
                   c.fabric_name,
                   lower(coalesce(c.uom,'')) AS uom,
                   p.kg_per_mtr_eff AS kpm,
                   p.kg_per_mtr AS kpm_stored,
                   p.width_m,
                   p.gsm,
                   p.fabric_category,
                   p.fabric_subcategory,
                   p.supplier
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
              AND c.is_main_fabric
        """, [days])

    KG_UOMS = {"kg", "g"}
    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}

    # Pass 1: per-MO bad flag + produced qty (identical logic to metres_per_garment).
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "bad": False, "has_fabric": False},
        )
        d["has_fabric"] = True
        u = r["uom"]
        kpm = r["kpm"]
        convertible = (u in M_UOMS) or (u in KG_UOMS and kpm and float(kpm) > 0)
        if not convertible:
            d["bad"] = True

    excluded = sum(
        1 for d in mos.values()
        if d["produced"] > 0 and d["has_fabric"] and d["bad"]
    )

    # Pass 2: attribute each excluded MO to the unconvertible fabric(s) inside it.
    fabrics = {}
    for r in rows:
        mo = mos.get(r["odoo_mo_id"])
        if not mo or mo["produced"] <= 0 or not mo["bad"]:
            continue
        u = r["uom"]
        kpm = r["kpm"]
        convertible = (u in M_UOMS) or (u in KG_UOMS and kpm and float(kpm) > 0)
        if convertible:
            continue
        cid = r["component_id"]
        f = fabrics.setdefault(cid, {
            "component_id": cid,
            "sku": r["fabric_sku"],
            "name": r["fabric_name"],
            "fabric_category": r["fabric_category"],
            "fabric_subcategory": r["fabric_subcategory"],
            "supplier": r["supplier"],
            "in_master": r["kpm"] is not None or r["fabric_category"] is not None,
            "width_m": r["width_m"],
            "gsm": r["gsm"],
            "kpm_stored": r["kpm_stored"],
            "_mos": set(),
            "garments": 0.0,
            "consumed_kg": 0.0,
        })
        if r["odoo_mo_id"] not in f["_mos"]:
            f["_mos"].add(r["odoo_mo_id"])
            f["garments"] += mo["produced"]
        qty = float(r["consumed_qty"] or 0)
        f["consumed_kg"] += qty / 1000.0 if u == "g" else qty

    items = []
    for f in fabrics.values():
        # What a buyer needs to fill in on the Odoo product to clear this fabric:
        # both Width and GSM (Kg/Mtr = Width × GSM ÷ 1000 — the stored Odoo
        # Kg/Mtr value is ignored, so it can no longer rescue a fabric).
        missing = []
        if not (f["width_m"] and float(f["width_m"]) > 0):
            missing.append("Width")
        if not (f["gsm"] and float(f["gsm"]) > 0):
            missing.append("GSM")
        items.append({
            "component_id": f["component_id"],
            "sku": f["sku"],
            "name": f["name"],
            "fabric_category": f["fabric_category"],
            "fabric_subcategory": f["fabric_subcategory"],
            "supplier": f["supplier"],
            "in_master": f["in_master"],
            "missing_fields": missing,
            "odoo_url": _odoo_product_url(f["component_id"]),
            "mos_blocked": len(f["_mos"]),
            "garments_blocked": round(f["garments"]),
            "consumed_kg": round(f["consumed_kg"], 1),
        })
    items.sort(key=lambda x: (x["mos_blocked"], x["garments_blocked"]), reverse=True)
    return {
        "count": len(items),
        "mos_excluded_missing_conversion": excluded,
        "window_days": days,
        "items": items,
    }


# ── Metres per garment, broken down by finished style ──────
# Same per-MO conversion + exclusion rule as the headline KPI above, but the
# qualifying MOs are grouped by their finished-product style (mo_fabric_consumption
# .style_name, captured from mrp.production.product_id's template in the extract).
# Returns one row per style: total metres, garments produced, MO count, and the
# style's metres-per-garment — so the team can spot the heaviest fabric consumers.
@fabric_router.get("/api/fabric/metres-per-garment-by-style")
def metres_per_garment_by_style(days: int = Query(default=90),
                                limit: int = Query(default=100)):
    days = max(1, min(int(days or 90), 730))
    limit = max(1, min(int(limit or 100), 1000))
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT c.odoo_mo_id,
                   c.produced_qty,
                   c.consumed_qty,
                   lower(coalesce(c.uom,'')) AS uom,
                   c.style_name,
                   c.finished_sku,
                   p.kg_per_mtr_eff AS kpm
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.done_date >= CURRENT_DATE - (%s || ' days')::interval
              AND c.is_main_fabric
        """, [days])

    KG_UOMS = {"kg", "g"}
    M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
    # First fold rows -> per-MO (metres + bad flag), carrying the MO's style.
    mos = {}
    for r in rows:
        d = mos.setdefault(
            r["odoo_mo_id"],
            {"produced": float(r["produced_qty"] or 0), "metres": 0.0,
             "bad": False, "has_fabric": False,
             "style": (r["style_name"] or "").strip() or None,
             "sku": r["finished_sku"]},
        )
        d["has_fabric"] = True
        qty = float(r["consumed_qty"] or 0)
        u = r["uom"]
        kpm = r["kpm"]
        if u in M_UOMS:
            d["metres"] += qty
        elif u in KG_UOMS and kpm and float(kpm) > 0:
            kg = qty / 1000.0 if u == "g" else qty
            d["metres"] += kg / float(kpm)
        else:
            d["bad"] = True

    # Then roll qualifying MOs up by style (excluded MOs counted but not summed).
    styles = {}
    for d in mos.values():
        key = d["style"] or "(unknown style)"
        s = styles.setdefault(
            key, {"style": key, "metres": 0.0, "garments": 0.0,
                  "mos": 0, "mos_excluded": 0, "sku": d["sku"]},
        )
        if d["produced"] <= 0 or not d["has_fabric"]:
            continue
        if d["bad"]:
            s["mos_excluded"] += 1
            continue
        s["metres"] += d["metres"]
        s["garments"] += d["produced"]
        s["mos"] += 1

    out = []
    for s in styles.values():
        if s["garments"] <= 0:
            continue
        out.append({
            "style": s["style"],
            "finished_sku": s["sku"],
            "metres_per_garment": round(s["metres"] / s["garments"], 2),
            "total_metres": round(s["metres"], 1),
            "garments": round(s["garments"]),
            "mos": s["mos"],
            "mos_excluded_missing_conversion": s["mos_excluded"],
        })
    out.sort(key=lambda r: r["metres_per_garment"], reverse=True)
    return {"rows": out[:limit], "window_days": days, "styles": len(out)}


# ── Stock by category ──────────────────────────────────────
@fabric_router.get("/api/fabric/by-category")
def by_category(location: str = Query(default="RMAT/Stock"),
                scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        return q(conn, f"""
            SELECT 
              {_category_label_sql(scope)} as category,
              p.fabric_subcategory as subcategory,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(i.quantity)::numeric,1) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes,
              -- Weighted-average cost per Kg = Σ(standard_price × kg) ÷ Σ(kg),
              -- consistent with the register's per-product cost_per_kg (standard_price).
              ROUND(CASE WHEN SUM(i.quantity) > 0
                   THEN SUM(p.standard_price*i.quantity)/SUM(i.quantity)
                   ELSE NULL END::numeric,2) as cost_per_kg,
              -- Weighted-average cost per metre = Σ(standard_price × kg) ÷ Σ(metres)
              -- over products with a kg→metre conversion, consistent with the
              -- register's per-product cost_metre (standard_price × kg_per_mtr_eff).
              ROUND(CASE WHEN SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END) > 0
                   THEN SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*i.quantity ELSE 0 END)
                        /SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)
                   ELSE NULL END::numeric,2) as cost_metre
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0
              {loc_sql}
              AND p.category = 'Fabric'
              AND p.fabric_category IS NOT NULL
              AND {_scope_sql(scope)}
            GROUP BY 1, 2
            ORDER BY value_kes DESC
        """, loc_params)

# ── Fabric register (full list) ────────────────────────────
@fabric_router.get("/api/fabric/register")
def register(
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    plain_print: str = Query(default=None),
    weight_range: str = Query(default=None),
    fabric_color: str = Query(default=None),
    supplier: str = Query(default=None),
    structure: str = Query(default=None),
    location: str = Query(default="RMAT/Stock"),
    search: str = Query(default=None),
    min_qty: float = Query(default=0),
    sort: str = Query(default="value_kes"),
    dir: str = Query(default="desc"),
    days: int = Query(default=90),
    limit: int = Query(default=200),
    offset: int = Query(default=0),
    scope: str = Query(default="main"),
):
    # Consumption window for the cover columns — same preset set as the Fabric mix
    # page (30/90/180/365), clamped identically so both pages reconcile.
    days = max(1, min(int(days or 90), 730))
    _api = _get_api()
    _ck = (f"fabric:register:{category}:{subcategory}:{plain_print}:{weight_range}:"
           f"{fabric_color}:{supplier}:{structure}:{location}:{search}:"
           f"{min_qty}:{sort}:{dir}:{days}:{limit}:{offset}:{scope}")
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        # The register's `resv` CTE reads fabric_reservations; ensure it exists even
        # on a fresh DB where no reservation endpoint has been hit yet.
        _ensure_fabric_tables(conn)
        _ensure_fabric_sheet(conn)
        # Whitelist of sortable output columns (aliases in the SELECT below) so the
        # client can drive ORDER BY without any SQL-injection surface.
        ALLOWED_SORT = {
            "default_code", "barcode", "name", "fabric_category", "fabric_subcategory",
            "plain_print", "weight_range", "fabric_structure", "gsm", "width_m",
            "kg_per_mtr", "m_per_kg", "fiber_content", "fabric_type", "supplier", "primary_color", "fabric_color",
            "qty_kg", "available_kg", "qty_metres", "available_metres", "value_kes",
            "cost_kes", "cost_per_kg", "cost_metre", "weeks_cover", "months_cover",
            "team_reserved_kg", "team_reserved_metres",
            "last_move", "days_since_move",
        }
        sort_col = sort if sort in ALLOWED_SORT else "value_kes"
        sort_dir = "ASC" if str(dir).lower() == "asc" else "DESC"
        order_by = f"ORDER BY {sort_col} {sort_dir} NULLS LAST"
        where = ["i.quantity > %s"]
        params = [min_qty]
        loc_sql, loc_params = _loc_filter(location)
        if loc_sql:
            where.append(loc_sql.replace(" AND ", "", 1)); params.extend(loc_params)
        if category:
            where.append("p.fabric_category = %s"); params.append(category)
        if subcategory:
            where.append("p.fabric_subcategory = %s"); params.append(subcategory)
        if plain_print:
            where.append("p.plain_print = %s"); params.append(plain_print)
        if weight_range:
            where.append("p.weight_range = %s"); params.append(weight_range)
        if fabric_color:
            where.append("UPPER(BTRIM(p.fabric_color)) = UPPER(BTRIM(%s))"); params.append(fabric_color)
        if supplier:
            where.append("NULLIF(BTRIM(p.fabric_supplier_name),'') = %s"); params.append(supplier)
        if structure:
            where.append("p.fabric_structure = %s"); params.append(structure)
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        # Fabric-only: exclude trims (zippers, thread, etc.) so the register reconciles
        # to the "Fabric" bucket on the summary KPI (is_fabric = category='Fabric').
        where.append("p.category = 'Fabric'")
        # Support-fabric scope: main excludes Lining/Interfacing, support keeps only them.
        where.append(_scope_sql(scope))

        # Cover columns aligned with the Fabric mix page, using IDENTICAL maths so the
        # two pages reconcile for the same scope/period:
        #   weeks of cover  = on-hand kg ÷ (consumption ÷ weeks-in-window),  weeks  = days/7
        #   months of cover = on-hand kg ÷ (consumption ÷ months-in-window), months = days/DAYS_PER_MONTH
        # Same location-scoped on-hand numerator and warehouse-wide net consumption
        # (effective-moves view) the mix page uses; `days` is the selected consumption
        # period (30/90/180/365). Cover is NULL when there was no consumption in the
        # window (matches the mix page's c>0 guard) — shown as "—".
        # `resv` = sum of OPEN (active) buying-team reservations, in kg, per fabric.
        rows = q(conn, f"""
            WITH cons_win AS (
              SELECT m.product_id, SUM({_net_kg('m')}) as consumed_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
                AND m.date >= NOW() - INTERVAL '{days} days'
              GROUP BY m.product_id
            ), resv AS (
              SELECT product_id, SUM(qty_kg) as reserved_kg
              FROM fabric_reservations
              WHERE status='active'
              GROUP BY product_id
            ), last_move_cte AS (
              SELECT lm.product_id, MAX(lm.date)::date AS last_move
              FROM raw_fabric_moves lm
              WHERE {_real_move_sql('lm')}
              GROUP BY lm.product_id
            )
            SELECT 
              p.id, p.name, p.default_code, p.barcode,
              {_category_label_sql(scope)} as fabric_category, p.fabric_subcategory,
              p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
              p.width_m, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.fiber_content, p.fabric_type,
              p.supplier, p.primary_color, INITCAP(BTRIM(p.fabric_color)) as fabric_color,
              NULLIF(BTRIM(p.odoo_fabric_color),'') as odoo_fabric_color,
              NULLIF(BTRIM(p.fabric_supplier_name),'') as fabric_supplier_name,
              p.standard_price, p.uom,
              ROUND(p.standard_price::numeric,2) as cost_kes,
              ROUND(p.standard_price::numeric,2) as cost_per_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*p.kg_per_mtr_eff ELSE NULL END::numeric,2) as cost_metre,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN 1.0/p.kg_per_mtr_eff ELSE NULL END::numeric,3) as m_per_kg,
              ROUND(i.quantity::numeric,2) as qty_kg,
              ROUND(i.reserved_qty::numeric,2) as reserved_kg,
              ROUND(i.available::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.available/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as weeks_cover,
              CASE WHEN COALESCE(c.consumed_kg,0) > 0
                   THEN ROUND((i.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                   ELSE NULL END as months_cover,
              ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as team_reserved_metres,
              lmc.last_move AS last_move,
              CURRENT_DATE - lmc.last_move AS days_since_move
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN cons_win c ON c.product_id = i.product_id
            LEFT JOIN resv rv ON rv.product_id = i.product_id
            LEFT JOIN last_move_cte lmc ON lmc.product_id = i.product_id
            WHERE {' AND '.join(where)}
            {order_by}
            LIMIT %s OFFSET %s
        """, params + [limit, offset])

        total = q(conn, f"""
            SELECT COUNT(*) as n FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {' AND '.join(where)}
        """, params)[0]['n']

        _result = {"total": total, "items": rows}
        _api.cache_set(_ck, _result, ttl=60)
        return _result

# ── Ageing ──────────────────────────────────────────────────
@fabric_router.get("/api/fabric/ageing")
def ageing(location: str = Query(default="RMAT/Stock"),
           scope: str = Query(default="main")):
    _api = _get_api()
    _ck = f"fabric:ageing:{location}:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        _result = q(conn, f"""
            SELECT 
              CASE 
                WHEN days_since <= 90  THEN '0-3 months'
                WHEN days_since <= 180 THEN '3-6 months'
                WHEN days_since <= 365 THEN '6-12 months'
                ELSE '12+ months'
              END as age_band,
              CASE 
                WHEN days_since <= 90  THEN 1
                WHEN days_since <= 180 THEN 2
                WHEN days_since <= 365 THEN 3
                ELSE 4
              END as sort_order,
              COUNT(DISTINCT product_id) as fabrics,
              ROUND(SUM(qty_kg)::numeric,1) as qty_kg,
              ROUND(SUM(qty_metres)::numeric,0) as qty_metres,
              ROUND(SUM(value_kes)::numeric,0) as value_kes
            FROM (
              SELECT 
                i.product_id,
                i.quantity as qty_kg,
                CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END as qty_metres,
                i.total_value as value_kes,
                COALESCE(
                  CURRENT_DATE - MAX(m.date::date),
                  999
                ) as days_since
              FROM raw_fabric_inventory i
              JOIN raw_fabric_products p ON p.id = i.product_id
              LEFT JOIN raw_fabric_moves m ON m.product_id = i.product_id
                AND {_real_move_sql('m')}
              WHERE i.quantity > 0 {loc_sql}
                AND p.category = 'Fabric'
                AND {_scope_sql(scope)}
              GROUP BY i.product_id, i.quantity, p.kg_per_mtr_eff, i.total_value
            ) sub
            GROUP BY age_band, sort_order
            ORDER BY sort_order
        """, loc_params)
        _api.cache_set(_ck, _result, ttl=120)
        return _result

# ── Consumption over time ───────────────────────────────────
@fabric_router.get("/api/fabric/consumption")
def consumption(
    since: str = Query(default="2026-01-01"),
    until: str = Query(default="2099-12-31"),
    group_by: str = Query(default="month"),
    scope: str = Query(default="main"),
):
    _api = _get_api()
    _ck = f"fabric:consumption:{since}:{until}:{group_by}:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        kg_expr = _net_kg("m")  # net of returns: +OUT, −production returns
        mtr_expr = f"CASE WHEN p.kg_per_mtr_eff>0 THEN ({kg_expr})/p.kg_per_mtr_eff ELSE 0 END"
        base_where = (f"{_net_cons_where('m')} "
                      f"AND {_scope_sql(scope)} "
                      "AND m.date BETWEEN %s AND %s")
        metrics = (f"COUNT(DISTINCT m.product_id) FILTER (WHERE {_consume_pred('m')}) as fabrics_used, "
                   f"ROUND(SUM({kg_expr})::numeric,1) as qty_kg, "
                   f"ROUND(SUM({mtr_expr})::numeric,0) as qty_metres, "
                   f"COUNT(*) FILTER (WHERE {_consume_pred('m')}) as moves")
        # Dimension breakdowns (by fabric category or individual fabric) vs.
        # the default time-series (day/week/month).
        if group_by in ("category", "fabric"):
            dim = (_category_label_sql(scope)
                   if group_by == "category"
                   else "COALESCE(NULLIF(m.product_name,''),'Unknown')")
            limit = "" if group_by == "category" else "LIMIT 50"
            _result = q(conn, f"""
                SELECT {dim} as period, {metrics}
                FROM {EFFECTIVE_MOVES} m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {base_where}
                GROUP BY 1 ORDER BY qty_kg DESC NULLS LAST {limit}
            """, (since, until))
            _api.cache_set(_ck, _result, ttl=120)
            return _result
        trunc = {"day": "day", "week": "week"}.get(group_by, "month")
        _result = q(conn, f"""
            SELECT DATE_TRUNC('{trunc}', m.date)::date as period, {metrics}
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {base_where}
            GROUP BY 1 ORDER BY 1
        """, (since, until))
        _api.cache_set(_ck, _result, ttl=120)
        return _result

# ── Consumption sources: today's move-level audit CSV ───────
@fabric_router.get("/api/fabric/consumption-sources.csv")
def consumption_sources_csv(scope: str = Query(default="main")):
    """Flat, move-level list of TODAY's rows that make up the net "Consumed today"
    KPI — one row per move — so a user can audit exactly what the figure is built
    from. Uses the EXACT SAME predicates as the KPI (`_net_cons_where` + `_net_kg`)
    and honours the same main/support `scope`, so the signed net kg column sums to
    the value shown on the card. Positive = consumption (OUT to production or
    RMAT→Samp sampling), negative = a netted return (Production→stock, Samp→stock)."""
    import csv, io
    from fastapi.responses import Response
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        rows = q(conn, f"""
            SELECT m.date::date as move_date,
                   COALESCE(NULLIF(m.product_name,''), NULLIF(p.name,''), '(unknown)') as fabric,
                   COALESCE(NULLIF(m.product_sku,''), NULLIF(p.default_code,''), '') as sku,
                   m.location_from as from_loc,
                   m.location_to as to_loc,
                   m.move_type as move_type,
                   ROUND(({_net_kg('m')})::numeric,3) as net_kg,
                   ROUND((CASE WHEN p.kg_per_mtr_eff>0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as net_metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date >= CURRENT_DATE
            ORDER BY fabric, m.location_from, m.location_to
        """)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Fabric", "SKU", "From location", "To location",
                "Move type", "Net kg", "Net metres"])
    for r in rows:
        w.writerow([r["move_date"], r["fabric"], r["sku"], r["from_loc"],
                    r["to_loc"], r["move_type"], r["net_kg"], r["net_metres"]])
    scope_tag = "support" if str(scope or "").lower() == "support" else "main"
    fname = f"consumption-sources-today-{scope_tag}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )

# ── Stock vs consumption by category/subcategory ────────────
@fabric_router.get("/api/fabric/category-stock-consumption")
def category_stock_consumption(
    location: str = Query(default="RMAT/Stock"),
    days: int = Query(default=30),
    scope: str = Query(default="main"),
):
    """Nested category→subcategory stock (location-scoped) vs net consumption
    (warehouse-wide, trailing N days). Derived %s / cover / SOR / variance / risk
    are computed client-side from these raw kg figures + the returned totals."""
    days = max(1, min(int(days or 30), 730))
    _api = _get_api()
    _ck = f"fabric:cat-stock:{location}:{days}:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        loc_sql, loc_params = _loc_filter(location)
        stock = q(conn, f"""
            SELECT {_category_label_sql(scope)} as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   ROUND(SUM(i.quantity)::numeric,1) as stock_kg
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND p.category = 'Fabric'
              AND {_scope_sql(scope)}
            GROUP BY 1, 2
        """, loc_params)
        cons = q(conn, f"""
            SELECT {_category_label_sql(scope)} as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   ROUND(SUM({_net_kg('m')})::numeric,1) as consumed_kg
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date >= NOW() - (%s || ' days')::interval
            GROUP BY 1, 2
        """, (days,))

        cats = {}
        def _cat(name):
            return cats.setdefault(name, {"category": name, "stock_kg": 0.0,
                                          "consumed_kg": 0.0, "_subs": {}})
        def _sub(cat, name):
            c = _cat(cat)
            return c["_subs"].setdefault(name, {"subcategory": name,
                                                "stock_kg": 0.0, "consumed_kg": 0.0})
        for r in stock:
            v = float(r["stock_kg"] or 0)
            _cat(r["category"])["stock_kg"] += v
            _sub(r["category"], r["subcategory"])["stock_kg"] += v
        for r in cons:
            v = float(r["consumed_kg"] or 0)
            _cat(r["category"])["consumed_kg"] += v
            _sub(r["category"], r["subcategory"])["consumed_kg"] += v

        out = []
        for c in cats.values():
            subs = sorted(c.pop("_subs").values(),
                          key=lambda s: s["consumed_kg"], reverse=True)
            c["stock_kg"] = round(c["stock_kg"], 1)
            c["consumed_kg"] = round(c["consumed_kg"], 1)
            c["subcategories"] = subs
            out.append(c)
        out.sort(key=lambda c: c["consumed_kg"], reverse=True)

        _result = {
            "days": days,
            "total_stock_kg": round(sum(c["stock_kg"] for c in out), 1),
            "total_consumed_kg": round(sum(c["consumed_kg"] for c in out), 1),
            "categories": out,
        }
        _api.cache_set(_ck, _result, ttl=90)
        return _result

# ── Fabric mix (consumption share vs stock share) ───────────
# A group is "idle" when it holds available stock but recorded ~zero net
# consumption over the window. Use the canonical kg figure (no metres-conversion
# gap) so a fabric consumed only in unconvertible kg is never mislabelled idle.
IDLE_KG_EPS = 0.1

def _parse_date_range(date_from: str, date_to: str):
    """Return (date, date) for a valid YYYY-MM-DD from/to pair (swapped if
    reversed), else (None, None). strptime both validates and sanitises, so the
    values are safe to pass as query parameters."""
    try:
        f = datetime.datetime.strptime((date_from or "").strip(), "%Y-%m-%d").date()
        t = datetime.datetime.strptime((date_to or "").strip(), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None, None
    return (f, t) if f <= t else (t, f)


@fabric_router.get("/api/fabric/mix")
def fabric_mix(
    group_by: str = Query(default="category"),
    days: int = Query(default=90),
    location: str = Query(default="RMAT/Stock"),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
    scope: str = Query(default="main"),
):
    """The fabric equivalent of the BI app's Stock Mix: compare each fabric
    category's (or sub-category's) share of CONSUMPTION against its share of
    AVAILABLE stock, and flag short / overstocked / idle groups.

    Available stock is location-scoped (default RMAT/Stock); net consumption is
    warehouse-wide and ALWAYS reads through the effective-moves view so the
    Jan–Apr 2026 Odoo correction applies. The consumption window is either the
    trailing `days` preset OR an explicit `date_from`/`date_to` range (the custom
    range, when both are valid, wins and resets `days`/`months` to its span).
    Metres are derived per fabric via its kg-per-metre; kg with no kg-per-metre
    cannot be converted, so each group carries the unconvertible kg (cons/avail)
    and a `metres_incomplete` flag instead of silently showing 0. Derived columns
    use metres (the spreadsheet's primary unit); the raw kg + metres figures +
    totals let the client re-derive everything for the Kg toggle.

    Gap (`gap_pp`) follows the house convention: % Available − % Consumption, so
    POSITIVE = overstock. `variance_pp` (% Consumption − % Available) is kept for
    backward compatibility only. When grouping by category each row carries a
    nested `subcategories` array (same fields) for in-place drill-down; the
    sub-rows' percentages share the grand totals so they stay comparable."""
    group_by = "subcategory" if str(group_by).lower().startswith("sub") else "category"
    win_from, win_to = _parse_date_range(date_from, date_to)
    if win_from and win_to:
        days = max(1, min((win_to - win_from).days + 1, 1825))
    else:
        days = max(1, min(int(days or 90), 730))
    months = days / DAYS_PER_MONTH
    _api = _get_api()
    _ck = f"fabric:mix:{group_by}:{days}:{location}:{date_from}:{date_to}:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # The per-product detail query (below) joins fabric_reservations, which is
        # created lazily — ensure it exists even on a fresh DB.
        _ensure_fabric_tables(conn)
        loc_sql, loc_params = _loc_filter(location)
        stock = q(conn, f"""
            SELECT {_category_label_sql(scope)} as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   i.product_id as product_id,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as product_name,
                   ROUND(SUM(i.quantity)::numeric,1) as available_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as available_metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN i.quantity ELSE 0 END)::numeric,1) as available_kg_nometre,
                   ROUND(SUM(i.total_value)::numeric,0) as tied_up_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category = 'Fabric' {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3, 4
        """, loc_params)
        net = _net_kg('m')
        kg = _kg('m')
        if win_from and win_to:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= %s AND m.date < (%s::date + 1)"
            cons_params = (win_from, win_to)
        else:
            cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= NOW() - (%s || ' days')::interval"
            cons_params = (days,)
        # Net consumption = OUT − production returns. We also pull the raw OUT
        # ("sent to production") and the production-return credit separately so the
        # UI can explain a net figure that has been floored to 0 (a window-aligned
        # return can otherwise read as "negative usage").
        cons = q(conn, f"""
            SELECT {_category_label_sql(scope)} as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   m.product_id as product_id,
                   COALESCE(NULLIF(p.name,''), NULLIF(p.default_code,''), 'Unknown') as product_name,
                   ROUND(SUM({net})::numeric,1) as consumption_kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as consumption_metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN ({net}) ELSE 0 END)::numeric,1) as consumption_kg_nometre,
                   ROUND(SUM(CASE WHEN {_consume_pred('m')} THEN {kg} ELSE 0 END)::numeric,1) as out_kg,
                   ROUND(SUM(CASE WHEN ({_consume_pred('m')}) AND p.kg_per_mtr_eff>0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as out_metres,
                   ROUND(SUM(CASE WHEN {_rmat_return_pred('m')} THEN {kg} ELSE 0 END)::numeric,1) as return_kg,
                   ROUND(SUM(CASE WHEN ({_rmat_return_pred('m')}) AND p.kg_per_mtr_eff>0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as return_metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {cons_where}
            GROUP BY 1, 2, 3, 4
        """, cons_params)

        # Smoothed 6-month run-rate per group (for Weeks/Months of Cover). This is
        # deliberately INDEPENDENT of the selected consumption window so cover
        # reflects sustained usage rather than a short window where a single
        # return can zero out (or invert) net consumption. The run-rate mirrors
        # _months_of_cover (warehouse-wide) exactly — the trailing 6 fully
        # completed months, no current-month projection — and because every step
        # is a linear combination of the group's monthly net kg, the category
        # run-rates sum back to the warehouse-wide run-rate (so covers reconcile).
        rr_rows = q(conn, f"""
            SELECT {_category_label_sql(scope)} as category,
                   COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') as subcategory,
                   m.product_id as product_id,
                   to_char(date_trunc('month', m.date::date),'YYYY-MM') AS mon,
                   SUM({net})::numeric as kg,
                   SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric as metres
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {_net_cons_where('m')}
              AND {_scope_sql(scope)}
              AND m.date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date
              AND m.date::date <  date_trunc('month', CURRENT_DATE)::date
            GROUP BY 1, 2, 3, 4
        """)
        rr_cal = q(conn, """
            SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS yr,
                   EXTRACT(MONTH FROM CURRENT_DATE)::int AS mo
        """)[0]

        def _rr_key(delta):
            idx = rr_cal['yr'] * 12 + (rr_cal['mo'] - 1) + delta
            return f"{idx // 12:04d}-{idx % 12 + 1:02d}"
        rr_complete = [_rr_key(d) for d in range(-6, 0)]  # M-6 .. M-1 (completed)

        def _runrate(mon_map):
            """Trailing 6-fully-completed-months average monthly run-rate from a
            {YYYY-MM: value} map, matching _months_of_cover. No current-month
            projection."""
            return sum(mon_map.get(k, 0.0) for k in rr_complete) / 6.0

        def _node(name):
            return {"group": name, "consumption_kg": 0.0, "consumption_metres": 0.0,
                    "available_kg": 0.0, "available_metres": 0.0, "tied_up_kes": 0.0,
                    "_cons_kg_nometre": 0.0, "_avail_kg_nometre": 0.0,
                    "out_kg": 0.0, "out_metres": 0.0, "return_kg": 0.0, "return_metres": 0.0,
                    "_mon_kg": {}, "_mon_m": {}}
        cats = {}
        def _cat(name):
            return cats.setdefault(name, {"_node": _node(name), "_subs": {}})
        def _sub(cat, name):
            return _cat(cat)["_subs"].setdefault(name, {"_node": _node(name), "_prods": {}})
        def _prod(cat, sub, pid, name):
            prods = _sub(cat, sub)["_prods"]
            node = prods.get(pid)
            if node is None:
                node = _node(name)
                node["_pid"] = pid
                prods[pid] = node
            return node
        for r in cons:
            cv_kg = float(r["consumption_kg"] or 0)
            cv_m = float(r["consumption_metres"] or 0)
            cv_nm = float(r["consumption_kg_nometre"] or 0)
            o_kg = float(r["out_kg"] or 0)
            o_m = float(r["out_metres"] or 0)
            rt_kg = float(r["return_kg"] or 0)
            rt_m = float(r["return_metres"] or 0)
            for x in (_cat(r["category"])["_node"],
                      _sub(r["category"], r["subcategory"])["_node"],
                      _prod(r["category"], r["subcategory"], r["product_id"], r["product_name"])):
                x["consumption_kg"] += cv_kg
                x["consumption_metres"] += cv_m
                x["_cons_kg_nometre"] += cv_nm
                x["out_kg"] += o_kg
                x["out_metres"] += o_m
                x["return_kg"] += rt_kg
                x["return_metres"] += rt_m
        for r in stock:
            av_kg = float(r["available_kg"] or 0)
            av_m = float(r["available_metres"] or 0)
            av_nm = float(r["available_kg_nometre"] or 0)
            kes = float(r["tied_up_kes"] or 0)
            for x in (_cat(r["category"])["_node"],
                      _sub(r["category"], r["subcategory"])["_node"],
                      _prod(r["category"], r["subcategory"], r["product_id"], r["product_name"])):
                x["available_kg"] += av_kg
                x["available_metres"] += av_m
                x["tied_up_kes"] += kes
                x["_avail_kg_nometre"] += av_nm
        # Fold the 6-month monthly run-rate into the EXISTING tree nodes only — a
        # product that moved months ago but has no current stock and no usage in
        # the selected window must not spawn a phantom row, so we look nodes up
        # rather than creating them.
        for r in rr_rows:
            catw = cats.get(r["category"])
            if not catw:
                continue
            targets = [catw["_node"]]
            subw = catw["_subs"].get(r["subcategory"])
            if subw:
                targets.append(subw["_node"])
                prodn = subw["_prods"].get(r["product_id"])
                if prodn is not None:
                    targets.append(prodn)
            mon = r["mon"]
            m_kg = float(r["kg"] or 0)
            m_m = float(r["metres"] or 0)
            for t in targets:
                t["_mon_kg"][mon] = t["_mon_kg"].get(mon, 0.0) + m_kg
                t["_mon_m"][mon] = t["_mon_m"].get(mon, 0.0) + m_m

        cat_nodes = [c["_node"] for c in cats.values()]
        sub_nodes = [s["_node"] for c in cats.values() for s in c["_subs"].values()]
        # Consumption is floored at 0 per group (a window-aligned return can push
        # net negative), so the page Total is the sum of the FLOORED rows at the
        # level being displayed. Flooring is non-linear, so the floored-subcategory
        # sum ≠ the floored-category sum; we base the total (and the % denominator)
        # on the displayed level so the Total reconciles with the rows above it and
        # each level's shares add to 100%. Available/tied aren't floored, so they
        # sum identically at either level (computed from categories).
        cons_nodes = sub_nodes if group_by == "subcategory" else cat_nodes
        tot_cons_kg = sum(max(0.0, x["consumption_kg"]) for x in cons_nodes)
        tot_cons_m = sum(max(0.0, x["consumption_metres"]) for x in cons_nodes)
        tot_avail_kg = sum(x["available_kg"] for x in cat_nodes)
        tot_avail_m = sum(x["available_metres"] for x in cat_nodes)
        tot_kes = sum(x["tied_up_kes"] for x in cat_nodes)

        def _finalize(x):
            # Floor net consumption at 0 (negative = window-aligned production
            # return outran the OUT it cancels); keep the gross OUT + return credit
            # for the UI to explain a floored row.
            c = max(0.0, x["consumption_metres"])
            c_kg = max(0.0, x["consumption_kg"])
            a = x["available_metres"]
            pct_c = (c / tot_cons_m * 100) if tot_cons_m > 0 else 0.0
            pct_a = (a / tot_avail_m * 100) if tot_avail_m > 0 else 0.0
            gap = pct_a - pct_c
            shortfall = a - c
            # Weeks/Months of Cover use the smoothed 6-month run-rate (not the raw
            # selected window) so cover populates for rows with sustained usage.
            rr_m = _runrate(x["_mon_m"])
            rr_kg = _runrate(x["_mon_kg"])
            covers = (a / rr_m) if rr_m > 0 else None
            idle = (x["available_kg"] > 0 and abs(x["consumption_kg"]) <= IDLE_KG_EPS)
            status = "Shortage" if (shortfall < 0 or (covers is not None and covers < 1)) else "OK"
            return {
                "group": x["group"],
                "consumption_kg": round(c_kg, 1),
                "consumption_metres": round(c, 1),
                "available_kg": round(x["available_kg"], 1),
                "available_metres": round(a, 1),
                "out_kg": round(x["out_kg"], 1),
                "out_metres": round(x["out_metres"], 1),
                "return_kg": round(x["return_kg"], 1),
                "return_metres": round(x["return_metres"], 1),
                "runrate_monthly_kg": round(rr_kg, 3),
                "runrate_monthly_metres": round(rr_m, 3),
                "tied_up_kes": round(x["tied_up_kes"]),
                "pct_consumption": round(pct_c, 1),
                "pct_available": round(pct_a, 1),
                "gap_pp": round(gap, 1),
                "variance_pp": round(-gap, 1),
                "shortfall_metres": round(shortfall, 1),
                "monthly_covers": round(covers, 2) if covers is not None else None,
                "idle": idle,
                "status": status,
                "metres_incomplete": (x["_cons_kg_nometre"] > 0.05 or x["_avail_kg_nometre"] > 0.05),
                "cons_kg_nometre": round(x["_cons_kg_nometre"], 1),
                "avail_kg_nometre": round(x["_avail_kg_nometre"], 1),
            }

        # Per-product register detail (same data source/maths as the register page)
        # so each product drill-down row can open the shared fabric detail card.
        # Keyed by product_id; location-scoped + same consumption window as the
        # cover columns. m_per_kg (metres per kg) is the inverse of kg_per_mtr.
        pids = sorted({p["_pid"] for c in cats.values()
                       for s in c["_subs"].values()
                       for p in s["_prods"].values()
                       if p.get("_pid") is not None})
        det_by_pid = {}
        if pids:
            # Anchor on the product master (the ids already collected from the mix
            # tree) and LEFT JOIN the location-scoped inventory, so every product
            # in the tree gets a detail row (carrying default_code/name/identity)
            # even when it has no stock in the selected location — that is what
            # lets consumption-only / zero-stock rows still show a barcode. The
            # inventory is pre-aggregated per product within the location (inv CTE)
            # so multi-row products don't duplicate and no-row products yield NULL
            # metrics that degrade gracefully.
            det_rows = q(conn, f"""
                WITH cons_win AS (
                  SELECT m.product_id, SUM({_net_kg('m')}) as consumed_kg
                  FROM {EFFECTIVE_MOVES} m
                  WHERE {_net_cons_where('m')}
                    AND m.date >= NOW() - INTERVAL '{days} days'
                  GROUP BY m.product_id
                ), resv AS (
                  SELECT product_id, SUM(qty_kg) as reserved_kg
                  FROM fabric_reservations
                  WHERE status='active'
                  GROUP BY product_id
                ), inv AS (
                  SELECT i.product_id,
                         SUM(i.quantity) as quantity,
                         SUM(i.available) as available,
                         SUM(i.total_value) as total_value
                  FROM raw_fabric_inventory i
                  WHERE i.product_id = ANY(%s) {loc_sql}
                  GROUP BY i.product_id
                ), last_move_cte AS (
                  SELECT lm.product_id, MAX(lm.date)::date AS last_move
                  FROM raw_fabric_moves lm
                  WHERE {_real_move_sql('lm')}
                  GROUP BY lm.product_id
                )
                SELECT
                  p.id, p.name, p.default_code, p.barcode, p.fabric_category, p.fabric_subcategory,
                  p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
                  p.width_m, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.fiber_content, p.fabric_type,
                  COALESCE(NULLIF(BTRIM(p.fabric_supplier_name),''), p.supplier) as supplier,
                  p.supplier_fabric_code, p.active, p.primary_color, p.source_city, p.source_country,
                  INITCAP(BTRIM(p.fabric_color)) as fabric_color,
                  NULLIF(BTRIM(p.fabric_name),'') as fabric_name,
                  NULLIF(BTRIM(p.fabric_supplier_name),'') as fabric_supplier_name,
                  NULLIF(BTRIM(p.odoo_fabric_color),'') as odoo_fabric_color,
                  ROUND(p.standard_price::numeric,2) as cost_kes,
                  ROUND(p.standard_price::numeric,2) as cost_per_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN p.standard_price*p.kg_per_mtr_eff ELSE NULL END::numeric,2) as cost_metre,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN 1.0/p.kg_per_mtr_eff ELSE NULL END::numeric,3) as m_per_kg,
                  ROUND(inv.quantity::numeric,2) as qty_kg,
                  ROUND(inv.available::numeric,2) as available_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN inv.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN inv.available/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres,
                  ROUND(inv.total_value::numeric,0) as value_kes,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/7.0) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as weeks_cover,
                  CASE WHEN COALESCE(c.consumed_kg,0) > 0 AND inv.quantity IS NOT NULL
                       THEN ROUND((inv.quantity * ({days}/{DAYS_PER_MONTH}) / c.consumed_kg)::numeric,1)
                       ELSE NULL END as months_cover,
                  ROUND(COALESCE(rv.reserved_kg,0)::numeric,2) as team_reserved_kg,
                  ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(rv.reserved_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as team_reserved_metres,
                  lmc.last_move AS last_move,
                  CURRENT_DATE - lmc.last_move AS days_since_move
                FROM raw_fabric_products p
                LEFT JOIN inv ON inv.product_id = p.id
                LEFT JOIN cons_win c ON c.product_id = p.id
                LEFT JOIN resv rv ON rv.product_id = p.id
                LEFT JOIN last_move_cte lmc ON lmc.product_id = p.id
                WHERE p.id = ANY(%s)
            """, [pids] + list(loc_params) + [pids])
            for dr in det_rows:
                if dr["id"] not in det_by_pid:
                    det_by_pid[dr["id"]] = dr

        # Blank/NULL fabric name bucket label at the Fabric Name drill level.
        NO_FABRIC_NAME = "(No fabric name)"

        # Roll a set of raw product nodes up into one aggregate raw node (so a
        # Fabric Name group carries the same rolled-up sums a category / sub-
        # category node does, and _finalize derives its %/gap/cover/status the
        # identical way). Monthly run-rate maps are merged so cover reconciles.
        def _sum_nodes(name, nodes):
            agg = _node(name)
            for n in nodes:
                for k in ("consumption_kg", "consumption_metres",
                          "available_kg", "available_metres", "tied_up_kes",
                          "_cons_kg_nometre", "_avail_kg_nometre",
                          "out_kg", "out_metres", "return_kg", "return_metres"):
                    agg[k] += n[k]
                for mk, mv in n["_mon_kg"].items():
                    agg["_mon_kg"][mk] = agg["_mon_kg"].get(mk, 0.0) + mv
                for mk, mv in n["_mon_m"].items():
                    agg["_mon_m"][mk] = agg["_mon_m"].get(mk, 0.0) + mv
            return agg

        def _finalize_prod(p):
            prow = _finalize(p)
            pid = p.get("_pid")
            prow["id"] = pid
            det = det_by_pid.get(pid)
            if det:
                prow["default_code"] = det.get("default_code")
                fc, pc = _derive_fabric_colors(det.get("name"), det.get("fabric_color"))
                det["derived_fabric_color"] = fc
                det["derived_primary_color"] = pc
                # Effective Fabric Colour = the dedicated Odoo field first, the
                # regex-derived colour only as a fallback when Odoo is empty.
                det["fabric_color_effective"] = det.get("odoo_fabric_color") or fc
                prow["detail"] = det
            return prow

        def _finalize_sub(s):
            srow = _finalize(s["_node"])
            # Group the sub-category's products by their Fabric Name (from the
            # product master detail; blank/NULL → one "(No fabric name)" bucket)
            # so the drill becomes Sub-Category → Fabric Name → Product. As
            # fabric names get filled in on the master, items move out of the
            # bucket automatically — it is purely derived from the data.
            fab_groups = {}
            for p in s["_prods"].values():
                det = det_by_pid.get(p.get("_pid"))
                fname = (det.get("fabric_name") if det else None) or NO_FABRIC_NAME
                fab_groups.setdefault(fname, []).append(p)
            fabrics = []
            for fname, pnodes in fab_groups.items():
                frow = _finalize(_sum_nodes(fname, pnodes))
                prods = [_finalize_prod(p) for p in pnodes]
                prods.sort(key=lambda r: r["consumption_metres"], reverse=True)
                frow["fabric_name"] = fname
                frow["products"] = prods
                fabrics.append(frow)
            fabrics.sort(key=lambda r: r["consumption_metres"], reverse=True)
            srow["fabrics"] = fabrics
            return srow

        if group_by == "subcategory":
            out = []
            for c in cats.values():
                cat_name = c["_node"]["group"]
                for s in c["_subs"].values():
                    srow = _finalize_sub(s)
                    srow["category"] = cat_name
                    out.append(srow)
            out.sort(key=lambda r: r["consumption_metres"], reverse=True)
        else:
            out = []
            for c in cats.values():
                row = _finalize(c["_node"])
                subs = [_finalize_sub(s) for s in c["_subs"].values()]
                subs.sort(key=lambda r: r["consumption_metres"], reverse=True)
                row["subcategories"] = subs
                out.append(row)
            out.sort(key=lambda r: r["consumption_metres"], reverse=True)
        _result = {
            "group_by": group_by,
            "days": days,
            "months": round(months, 2),
            "date_from": win_from.isoformat() if win_from else None,
            "date_to": win_to.isoformat() if win_to else None,
            "total_consumption_kg": round(tot_cons_kg, 1),
            "total_consumption_metres": round(tot_cons_m, 1),
            "total_available_kg": round(tot_avail_kg, 1),
            "total_available_metres": round(tot_avail_m, 1),
            "total_out_kg": round(sum(x["out_kg"] for x in cat_nodes), 1),
            "total_out_metres": round(sum(x["out_metres"] for x in cat_nodes), 1),
            "total_return_kg": round(sum(x["return_kg"] for x in cat_nodes), 1),
            "total_return_metres": round(sum(x["return_metres"] for x in cat_nodes), 1),
            "total_tied_up_kes": round(tot_kes),
            "rows": out,
        }
        _api.cache_set(_ck, _result, ttl=90)
        return _result

# ── Data quality: fabrics missing kg-per-metre ──────────────
@fabric_router.get("/api/fabric/data-quality/missing-kg-per-metre")
def missing_kg_per_metre(scope: str = Query(default="main")):
    """Every fabric product with NO usable kg-per-metre on the Odoo product master
    (kg_per_mtr missing or <= 0) that still has stock on hand OR recorded usage —
    i.e. real quantities that can only be shown in kg, never metres. Stock is the
    on-hand quantity across the two real fabric-stock locations; usage is net
    consumption (OUT − production returns) through the same effective-moves source
    every other fabric view uses, so the numbers reconcile. A `source` flag marks
    each row as stock-only / usage-only / both. Aggregate count + total
    unconvertible kg are returned so progress is visible as conversions get
    backfilled in Odoo."""
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # Stock across the two real fabric-stock locations (the "All" resolution).
        loc_sql, loc_params = _loc_filter("All")
        rows = q(conn, f"""
            WITH stock AS (
              SELECT i.product_id, SUM(i.quantity) AS stock_kg,
                     STRING_AGG(DISTINCT i.location_name, ', '
                                ORDER BY i.location_name) AS locations
              FROM raw_fabric_inventory i
              WHERE i.quantity > 0 {loc_sql}
              GROUP BY i.product_id
            ), usage AS (
              SELECT m.product_id, SUM({_net_kg('m')}) AS usage_kg
              FROM {EFFECTIVE_MOVES} m
              WHERE {_net_cons_where('m')}
              GROUP BY m.product_id
            ), last_loc AS (
              -- Last-known REAL stock location: the destination of the most recent
              -- move that landed in a recognised fabric-stock location. Used as a
              -- historical fallback for usage-only rows that have no current stock.
              SELECT DISTINCT ON (mm.product_id)
                     mm.product_id, mm.location_to AS last_known_location
              FROM raw_fabric_moves mm
              WHERE mm.location_to IN ({", ".join(["%s"] * len(_FABRIC_LOCATIONS))})
              ORDER BY mm.product_id, mm.date DESC NULLS LAST
            ), last_move_cte AS (
              SELECT lm.product_id, MAX(lm.date)::date AS last_move
              FROM raw_fabric_moves lm
              WHERE {_real_move_sql('lm')}
              GROUP BY lm.product_id
            )
            SELECT
              p.id, p.default_code, p.name,
              COALESCE(NULLIF(p.fabric_category,''),'Unknown') AS fabric_category,
              COALESCE(NULLIF(p.fabric_subcategory,''),'Unknown') AS fabric_subcategory,
              p.supplier, p.width_m, p.gsm, p.fiber_content, p.kg_per_mtr_src,
              st.locations AS location,
              ll.last_known_location AS last_known_location,
              ROUND(COALESCE(st.stock_kg,0)::numeric,1) AS stock_kg,
              ROUND(GREATEST(COALESCE(us.usage_kg,0),0)::numeric,1) AS usage_kg,
              lmc.last_move AS last_move
            FROM raw_fabric_products p
            LEFT JOIN stock st ON st.product_id = p.id
            LEFT JOIN usage us ON us.product_id = p.id
            LEFT JOIN last_loc ll ON ll.product_id = p.id
            LEFT JOIN last_move_cte lmc ON lmc.product_id = p.id
            WHERE p.kg_per_mtr_eff IS NULL
              AND p.category = 'Fabric'
              AND {_scope_sql(scope)}
              AND (COALESCE(st.stock_kg,0) > 0 OR COALESCE(us.usage_kg,0) > 0.05)
        """, list(_FABRIC_LOCATIONS) + list(loc_params))

        tot_stock = 0.0
        tot_usage = 0.0
        for r in rows:
            sk = float(r["stock_kg"] or 0)
            uk = float(r["usage_kg"] or 0)
            tot_stock += sk
            tot_usage += uk
            if sk > 0 and uk > 0.05:
                r["source"] = "both"
            elif uk > 0.05:
                r["source"] = "usage"
            else:
                r["source"] = "stock"
            r["last_move"] = r["last_move"].isoformat() if r.get("last_move") else None
        # Most material gaps first (biggest unconvertible quantity).
        rows.sort(key=lambda r: (float(r["stock_kg"] or 0) + float(r["usage_kg"] or 0)),
                  reverse=True)
        return {
            "count": len(rows),
            "total_stock_kg": round(tot_stock, 1),
            "total_usage_kg": round(tot_usage, 1),
            "total_unconvertible_kg": round(tot_stock + tot_usage, 1),
            "items": rows,
        }

@fabric_router.get("/api/fabric/data-quality/unmatched-purchase-lines")
def unmatched_purchase_lines(scope: str = Query(default="main")):
    """Received, non-cancelled purchase-order lines whose product is NOT counted in
    the fabric metrics — either the product has no row in the fabric master, or the
    matched master product is not categorized as 'Fabric' (e.g. it is a Trim). The
    supplier totals and avg cost-per-metre only sum lines that JOIN the master with
    category='Fabric', so these lines' received quantity and value are silently
    dropped and never trigger the missing-kg/m warning. Grouped per (supplier,
    product) so a line received over several POs shows once; a `reason` flag marks
    each as 'not_in_master' vs 'not_fabric'. The fix is to correct the product's
    category / master record in Odoo, after which the value flows into the supplier
    figures automatically. Returns the rows plus an excluded line count and total
    KES so the size of the gap is visible."""
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT po.supplier AS supplier,
                   COALESCE(NULLIF(po.product_name,''), NULLIF(p.name,''), 'Unknown') AS name,
                   COALESCE(NULLIF(po.product_sku,''), p.default_code) AS sku,
                   ROUND(SUM(po.qty_received)::numeric,1) AS qty_kg,
                   ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) AS value_kes,
                   CASE WHEN p.id IS NULL THEN 'not_in_master' ELSE 'not_fabric' END AS reason
            FROM raw_fabric_purchase_orders po
            LEFT JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND po.qty_received > 0
              AND (p.id IS NULL OR p.category <> 'Fabric')
              AND {_scope_sql(scope)}
            GROUP BY po.supplier, po.product_id, po.product_name, p.name,
                     po.product_sku, p.default_code,
                     (CASE WHEN p.id IS NULL THEN 'not_in_master' ELSE 'not_fabric' END)
            ORDER BY value_kes DESC NULLS LAST
        """)
        total_value = sum(float(r["value_kes"] or 0) for r in rows)
        return {
            "count": len(rows),
            "total_value_kes": round(total_value, 0),
            "items": rows,
        }

# ── Dead stock ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/dead-stock")
def dead_stock(scope: str = Query(default="main")):
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT 
              i.product_name, {_category_label_sql(scope)} as fabric_category, p.fabric_subcategory,
              p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.width_m, p.gsm, p.plain_print,
              ROUND(i.quantity::numeric,1) as qty_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(i.total_value::numeric,0) as value_kes,
              MAX(m.date)::date as last_move,
              CURRENT_DATE - MAX(m.date)::date as days_since_move
            FROM raw_fabric_inventory i
            LEFT JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN raw_fabric_moves m ON m.product_id = i.product_id
              AND {_real_move_sql('m')}
            WHERE i.location_name = 'Dead/Stock Fabric' AND i.quantity > 0
              AND p.category = 'Fabric'
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3,
                     p.kg_per_mtr_eff, p.kg_per_mtr_src, p.width_m, p.gsm, p.plain_print,
                     i.quantity, i.total_value
            ORDER BY i.total_value DESC
        """)
        total_value = sum(r['value_kes'] or 0 for r in rows)
        return {"total_value": total_value, "items": rows}

# ── Purchase orders ─────────────────────────────────────────
@fabric_router.get("/api/fabric/purchase-orders")
def purchase_orders(supplier: str = Query(default=None), month: str = Query(default=None), scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = f"p.category = 'Fabric' AND {_scope_sql(scope)}"
        params = []
        if supplier:
            where += " AND po.supplier ILIKE %s"; params.append(f"%{supplier}%")
        if month:
            where += " AND DATE_TRUNC('month', po.order_date)::date = %s"; params.append(month)
        return q(conn, f"""
            SELECT po.po_name, po.supplier, po.order_date, po.state,
              COUNT(*) as lines,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM(po.qty_ordered)::numeric,2) as qty_ordered,
              ROUND(SUM(po.qty_received)::numeric,2) as qty_received,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,2) as outstanding
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE {where}
            GROUP BY po.po_name, po.supplier, po.order_date, po.state
            ORDER BY po.order_date DESC
        """, params)

# ── BOM lookup ──────────────────────────────────────────────
@fabric_router.get("/api/fabric/bom")
def bom_lookup(sku: str = Query(default=None), style: str = Query(default=None),
               scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = "1=1"
        params = []
        if sku:
            where = "b.finished_product_sku ILIKE %s"; params.append(f"%{sku}%")
        elif style:
            where = "b.finished_product_name ILIKE %s"; params.append(f"%{style}%")
        return q(conn, f"""
            SELECT b.finished_product_name, b.finished_product_sku,
              b.component_name, b.component_qty, b.component_uom,
              p.fabric_category, p.fabric_subcategory, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src,
              i.quantity as stock_kg,
              CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE NULL END as stock_metres,
              i.location_name
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            LEFT JOIN raw_fabric_inventory i ON i.product_id = b.component_id AND i.quantity > 0
            WHERE {where}
              AND p.category = 'Fabric'
              AND {_scope_sql(scope)}
            ORDER BY b.finished_product_name, b.component_name
        """, params)

# ── Attribute split (plain/print, weight, structure) ────────
@fabric_router.get("/api/fabric/attribute-split")
def attribute_split(location: str = Query(default="RMAT/Stock"), scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        def split(col):
            return q(conn, f"""
                SELECT COALESCE(NULLIF(p.{col},''),'Unknown') as value,
                  COUNT(DISTINCT i.product_id) as fabrics,
                  ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
                  ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
                  ROUND(SUM(i.total_value)::numeric,0) as value_kes
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 {loc_sql}
                  AND p.category = 'Fabric'
                  AND {_scope_sql(scope)}
                GROUP BY 1
                ORDER BY value_kes DESC NULLS LAST
            """, loc_params)
        # Solid vs Print: the Odoo `plain_print` attribute is blank for the vast
        # majority of fabrics, so trusting it alone collapses ~94% into "Unknown".
        # Instead DERIVE the split: an explicit "Print" tag OR a name that clearly
        # signals a print (PRINT/AOP/FLORAL/STRIPE/ANKARA/etc.) → Print; an explicit
        # "Plain" tag OR otherwise genuine fabric (it carries a fabric_category) →
        # Solid; only rows with no category and no print signal (indeterminate junk
        # e.g. "ASSORTED FABRIC RETURNS/DEFECTS") remain a small "Unknown" residual.
        def split_plain_print():
            return q(conn, f"""
                SELECT CASE
                    WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'Print'
                    WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'Print'
                    WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'Solid'
                    WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'Solid'
                    ELSE 'Unknown'
                  END as value,
                  COUNT(DISTINCT i.product_id) as fabrics,
                  ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
                  ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
                  ROUND(SUM(i.total_value)::numeric,0) as value_kes
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 {loc_sql}
                  AND p.category = 'Fabric'
                  AND {_scope_sql(scope)}
                GROUP BY 1
                ORDER BY value_kes DESC NULLS LAST
            """, loc_params)
        # Fiber content: many rows blank — keep only fabrics that declare a fiber,
        # rolled up to the top values by stock value.
        fiber = q(conn, f"""
            SELECT p.fiber_content as value,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND p.category = 'Fabric'
              AND {_scope_sql(scope)}
              AND p.fiber_content IS NOT NULL AND p.fiber_content <> ''
            GROUP BY 1
            ORDER BY value_kes DESC NULLS LAST
            LIMIT 8
        """, loc_params)
        return {
            "plain_print": split_plain_print(),
            "weight_range": split("weight_range"),
            "structure": split("fabric_structure"),
            "fiber": fiber,
        }

# ── Solid vs Print: downloadable .xlsx calculations report ──────────────
# The full audit trail behind the "Solid vs Print" donut: every fabric product
# that contributes, its derived classification (Solid/Print/Unknown), WHICH rule
# matched it, its on-hand kg, the kg→metre conversion applied, its derived metres
# and KES value. The classification CASE + filters (i.quantity > 0, location,
# scope) MUST mirror attribute_split's split_plain_print EXACTLY so the workbook
# reconciles to the donut. The Summary sheet reuses the SAME single-aggregate
# GROUP BY query the donut is fed, so its totals are guaranteed identical.
@fabric_router.get("/api/fabric/solid-vs-print.xlsx")
def solid_vs_print_xlsx(location: str = Query(default="RMAT/Stock"),
                        scope: str = Query(default="main")):
    from fastapi.responses import Response
    import io
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill

    # The exact classification CASE from attribute_split.split_plain_print — kept
    # verbatim so the workbook reconciles to the donut.
    CLASS_CASE = """CASE
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'Print'
        WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'Print'
        WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'Solid'
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'Solid'
        ELSE 'Unknown'
      END"""
    # The matching rule that fired, in the SAME priority order, for the audit trail.
    RULE_CASE = """CASE
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'print' THEN 'plain_print=print'
        WHEN p.name ~* 'print|aop|floral|camouflage|stripe|polka|paisley|leopard|ankara' THEN 'name matched print regex'
        WHEN NULLIF(BTRIM(COALESCE(p.fabric_category,'')),'') IS NOT NULL THEN 'has fabric_category'
        WHEN LOWER(BTRIM(COALESCE(p.plain_print,''))) = 'plain' THEN 'plain_print=plain'
        ELSE 'fell through -> Unknown'
      END"""

    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        # Summary — the SAME aggregated query the donut is fed (split_plain_print).
        summary = q(conn, f"""
            SELECT {CLASS_CASE} as value,
              COUNT(DISTINCT i.product_id) as fabrics,
              ROUND(SUM(i.quantity)::numeric,0) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,0) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1
            ORDER BY value_kes DESC NULLS LAST
        """, loc_params)

        # Detail — one row per contributing fabric product, with its rule.
        detail = q(conn, f"""
            SELECT i.product_id,
              p.name, p.default_code AS sku, p.supplier,
              p.plain_print, p.fabric_category, p.kg_per_mtr_eff,
              {CLASS_CASE} as classification,
              {RULE_CASE} as rule,
              ROUND(SUM(i.quantity)::numeric,2) as qty_kg,
              ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,2) as qty_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY i.product_id, p.name, p.default_code, p.supplier,
                     p.plain_print, p.fabric_category, p.kg_per_mtr_eff,
                     {CLASS_CASE}, {RULE_CASE}
            ORDER BY value_kes DESC NULLS LAST
        """, loc_params)

    # Grand totals (reconcile to the donut centre / legend).
    tot_kg = sum(float(r["qty_kg"] or 0) for r in summary)
    tot_metres = sum(float(r["qty_metres"] or 0) for r in summary)
    tot_value = sum(float(r["value_kes"] or 0) for r in summary)
    tot_fabrics = sum(int(r["fabrics"] or 0) for r in summary)

    # ── Build the workbook ───────────────────────────────────────────────
    wb = openpyxl.Workbook()
    HEAD = Font(bold=True, color="FFFFFF")
    HEAD_FILL = PatternFill("solid", fgColor="1A5C38")
    TITLE = Font(bold=True, size=13)
    LBL = Font(bold=True)
    LINK = Font(color="1A5C38", underline="single")

    def _style_header(ws, ncols, row=1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = HEAD
            cell.fill = HEAD_FILL

    _loc_label = (location or "").strip() or "All fabric stock"
    _scope_label = "Support fabrics" if str(scope or "").lower() == "support" else "Main fabrics"

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Solid vs Print — calculations report"
    ws["A1"].font = TITLE
    ws["A2"] = "Location: %s    Scope: %s" % (_loc_label, _scope_label)
    sum_cols = ["Classification", "Fabrics", "Total kg", "Total metres",
                "Value (KES)", "% of value", "% of metres (chart)"]
    ws.append([])  # spacer row 3
    ws.append(sum_cols)  # header on row 4
    _style_header(ws, len(sum_cols), row=4)
    for r in summary:
        val = float(r["value_kes"] or 0)
        met = float(r["qty_metres"] or 0)
        ws.append([
            r["value"], int(r["fabrics"] or 0),
            float(r["qty_kg"] or 0), met, val,
            round(val / tot_value * 100, 1) if tot_value else 0.0,
            round(met / tot_metres * 100, 1) if tot_metres else 0.0,
        ])
    grand = ws.max_row + 1
    ws.append(["Grand total", tot_fabrics, round(tot_kg, 0),
               round(tot_metres, 0), round(tot_value, 0),
               100.0 if tot_value else 0.0,
               100.0 if tot_metres else 0.0])
    for c in range(1, len(sum_cols) + 1):
        ws.cell(row=grand, column=c).font = LBL
    ws.append([])
    note = ws.max_row + 1
    ws.cell(row=note, column=1,
            value="Reconciliation: Value (KES) grand total matches the figure "
                  "in the donut centre; '% of metres (chart)' matches the "
                  "donut legend percentages.").font = LBL
    for col, w in zip("ABCDEFG", [22, 10, 14, 16, 16, 12, 18]):
        ws.column_dimensions[col].width = w

    # Detail sheet — one row per contributing fabric product
    ws2 = wb.create_sheet("Detail")
    det_cols = ["Fabric name", "Fabric SKU", "Supplier", "Classification",
                "Rule matched", "plain_print", "fabric_category",
                "On-hand kg", "Kg per metre", "Derived metres", "Value (KES)",
                "Open in Odoo"]
    ws2.append(det_cols)
    _style_header(ws2, len(det_cols))
    if not detail:
        ws2.append(["No contributing fabric for this location / scope."])
    for r in detail:
        kpm = r["kg_per_mtr_eff"]
        ws2.append([
            r["name"], r["sku"], r["supplier"], r["classification"], r["rule"],
            r["plain_print"], r["fabric_category"],
            float(r["qty_kg"] or 0),
            (round(float(kpm), 4) if kpm and float(kpm) > 0 else None),
            float(r["qty_metres"] or 0),
            float(r["value_kes"] or 0),
            None,
        ])
        url = _odoo_product_url(r["product_id"])
        if url:
            cell = ws2.cell(row=ws2.max_row, column=len(det_cols))
            cell.value = "Open in Odoo"
            cell.hyperlink = url
            cell.font = LINK
    for col, w in zip("ABCDEFGHIJKL",
                      [40, 18, 22, 14, 26, 12, 18, 12, 14, 14, 14, 14]):
        ws2.column_dimensions[col].width = w

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="solid-vs-print-calculations.xlsx"'},
    )

# ── Fabric base by primary colour ──────────────────────────
@fabric_router.get("/api/fabric/color-mix")
def color_mix(
    location: str = Query(default="RMAT/Stock"),
    days: int = Query(default=90),
    scope: str = Query(default="main"),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
):
    """Fabric base broken down by PRIMARY COLOUR for the merged Overview table:
    per colour, ON-HAND stock (location-scoped, same basis as the
    attribute-split / Stock-on-hand KPI — category='Fabric'), net CONSUMPTION
    over a FIXED trailing 30-day window (warehouse-wide via the effective-moves
    view), and MONTHLY COVERS (stock metres ÷ 30-day consumption metres).

    The consumption window is fixed at the trailing 30 days and DOES NOT follow
    the page's `days`/`date_from`/`date_to` consumption filter (those params are
    accepted for backward compatibility but no longer scope this view), so the
    merged covers figure always reflects a one-month run-rate.

    The primary colour is DERIVED in Python via the Vivo Colour Directory 2025
    (`_derive_fabric_colors`) — the DB `primary_color` column is empty — so we
    aggregate raw per-product kg/metres in SQL, then bucket by derived colour.
    Metres come from each fabric's kg-per-metre; kg that can't be converted are
    carried per panel as `*_kg_nometre` + a `*_metres_incomplete` flag rather
    than silently showing 0 (same convention as the Stock Mix blocks). Colours
    are sorted by on-hand metres descending; unresolved colours bucket to
    'Unknown'. Colours with stock but ~no 30-day consumption return
    `covers_months: null` (rendered as "no usage / ∞") rather than a misleading
    huge number or 0."""
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        # On-hand stock per product (Fabric only, location-scoped) — same basis as
        # the Stock-on-hand KPI so the panel totals reconcile with the page.
        stock = q(conn, f"""
            SELECT i.product_id as product_id,
                   COALESCE(NULLIF(p.name,''),'') as name,
                   COALESCE(NULLIF(p.fabric_color,''),'') as fabric_color,
                   ROUND(SUM(i.quantity)::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN i.quantity ELSE 0 END)::numeric,1) as kg_nometre
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.category = 'Fabric' {loc_sql}
              AND {_scope_sql(scope)}
            GROUP BY 1, 2, 3
        """, loc_params)
        net = _net_kg('m')
        # Consumption is FIXED at the trailing 30 days for the merged covers view —
        # it deliberately ignores the page's days/date_from/date_to filter so the
        # one-month run-rate (and therefore Monthly Covers) is stable.
        cons_where = f"{_net_cons_where('m')} AND {_scope_sql(scope)} AND m.date >= NOW() - interval '30 days'"
        cons = q(conn, f"""
            SELECT m.product_id as product_id,
                   COALESCE(NULLIF(p.name,''),'') as name,
                   COALESCE(NULLIF(p.fabric_color,''),'') as fabric_color,
                   ROUND(SUM({net})::numeric,1) as kg,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff>0 THEN ({net})/p.kg_per_mtr_eff ELSE 0 END)::numeric,1) as metres,
                   ROUND(SUM(CASE WHEN p.kg_per_mtr_eff IS NULL THEN ({net}) ELSE 0 END)::numeric,1) as kg_nometre
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {cons_where}
            GROUP BY 1, 2, 3
        """, None)

        buckets = {}
        def _b(color):
            return buckets.setdefault(color, {
                "color": color,
                "stock_kg": 0.0, "stock_metres": 0.0, "stock_kg_nometre": 0.0,
                "cons_kg": 0.0, "cons_metres": 0.0, "cons_kg_nometre": 0.0,
            })
        for r in stock:
            _, primary = _derive_fabric_colors(r["name"], r["fabric_color"])
            b = _b(primary or "Unknown")
            b["stock_kg"] += float(r["kg"] or 0)
            b["stock_metres"] += float(r["metres"] or 0)
            b["stock_kg_nometre"] += float(r["kg_nometre"] or 0)
        for r in cons:
            _, primary = _derive_fabric_colors(r["name"], r["fabric_color"])
            b = _b(primary or "Unknown")
            b["cons_kg"] += float(r["kg"] or 0)
            b["cons_metres"] += float(r["metres"] or 0)
            b["cons_kg_nometre"] += float(r["kg_nometre"] or 0)

        rows = []
        for b in buckets.values():
            stock_m = round(b["stock_metres"], 1)
            cons_m = round(b["cons_metres"], 1)
            # Monthly Covers = on-hand stock metres ÷ 30-day consumption metres
            # (30 days ≈ one month). Colours with stock but ~no consumption in the
            # window get a null sentinel so the frontend can show "no usage / ∞"
            # instead of a divide-by-zero or a misleading huge number.
            covers_months = round(stock_m / cons_m, 1) if cons_m > 0.05 else None
            rows.append({
                "color": b["color"],
                "stock_kg": round(b["stock_kg"], 1),
                "stock_metres": stock_m,
                "stock_metres_incomplete": b["stock_kg_nometre"] > 0.05,
                "cons_kg": round(b["cons_kg"], 1),
                "cons_metres": cons_m,
                "cons_metres_incomplete": b["cons_kg_nometre"] > 0.05,
                "covers_months": covers_months,
            })
        # Sort by on-hand metres desc; colours with stock only in kg (no metres)
        # fall back to kg so they don't all pile at the bottom in metre order.
        rows.sort(key=lambda x: (x["stock_metres"], x["stock_kg"]), reverse=True)
        return {
            "days": days,
            "rows": rows,
            "total_stock_kg": round(sum(r["stock_kg"] for r in rows), 1),
            "total_stock_metres": round(sum(r["stock_metres"] for r in rows), 1),
            "total_cons_kg": round(sum(r["cons_kg"] for r in rows), 1),
            "total_cons_metres": round(sum(r["cons_metres"] for r in rows), 1),
        }

# ── Top consumed fabrics (what's actually moving out) ───────
@fabric_router.get("/api/fabric/top-consumed")
def top_consumed(days: int = Query(default=90), limit: int = Query(default=20), scope: str = Query(default="main")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        # weeks_cover uses the average monthly run-rate: total net consumption over
        # the window ÷ number of months in the window = monthly average, converted
        # to a weekly rate (÷ weeks/month), then stock ÷ weekly rate.
        # product_id IS NOT NULL drops sheet rows whose barcode didn't match a
        # product master — this is a per-fabric view that needs a product identity.
        return q(conn, f"""
            WITH out_moves AS (
              SELECT m.product_id,
                MAX(m.product_name) FILTER (WHERE {_consume_pred('m')}) as product_name,
                SUM({_net_kg('m')}) as consumed_kg,
                COUNT(*) FILTER (WHERE {_consume_pred('m')}) as moves,
                MAX(m.date) FILTER (WHERE {_consume_pred('m')})::date as last_out
              FROM {EFFECTIVE_MOVES} m
              LEFT JOIN raw_fabric_products p ON p.id = m.product_id
              WHERE {_net_cons_where('m')}
                AND {_scope_sql(scope)}
                AND m.product_id IS NOT NULL
                AND m.date >= NOW() - (%s || ' days')::interval
              GROUP BY m.product_id
              HAVING SUM({_net_kg('m')}) > 0
            ), stock AS (
              SELECT product_id, SUM(quantity) as qty_kg
              FROM raw_fabric_inventory WHERE quantity>0 GROUP BY 1
            )
            SELECT o.product_name,
              ROUND(o.consumed_kg::numeric,1) as consumed_kg,
              o.moves, o.last_out,
              ROUND(COALESCE(s.qty_kg,0)::numeric,1) as stock_kg,
              ROUND((COALESCE(s.qty_kg,0) / NULLIF(
                (o.consumed_kg / ((%s)::numeric/{DAYS_PER_MONTH})) / {WEEKS_PER_MONTH}, 0))::numeric,1) as weeks_cover
            FROM out_moves o
            LEFT JOIN stock s ON s.product_id = o.product_id
            ORDER BY o.consumed_kg DESC
            LIMIT %s
        """, (days, days, limit))

# ── Movement flow (IN / OUT / INTERNAL by month) ────────────
@fabric_router.get("/api/fabric/movement-flow")
def movement_flow(months: int = Query(default=6), scope: str = Query(default="main")):
    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)
        return q(conn, f"""
            SELECT DATE_TRUNC('month', m.date)::date as period,
              ROUND(SUM(CASE WHEN m.move_type='IN'       THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as in_kg,
              ROUND(SUM(CASE WHEN m.move_type='OUT'      THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as out_kg,
              ROUND(SUM(CASE WHEN m.move_type='INTERNAL' THEN (CASE WHEN m.uom='g' THEN m.qty/1000 ELSE m.qty END) ELSE 0 END)::numeric,1) as internal_kg
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE m.is_fabric AND m.uom IN ('g','kg')
              AND {_scope_sql(scope)}
              AND m.date >= DATE_TRUNC('month', NOW() - (%s || ' months')::interval)
            GROUP BY 1 ORDER BY 1
        """, (months,))

# ── Trend Analysis builder (multi-panel KPI-over-time, METRES only) ──────────
# Backs the Fabric dashboard's "Trend Analysis" tab. ONE endpoint returns a time
# series for a chosen KPI at a chosen granularity (day/week/month), date range and
# scope (Overall / fabric category / sub-category / specific fabric / location).
# EVERY KPI is reported in METRES (never kg) via the established kg_per_mtr_eff
# conversion, and surfaces an `incomplete` flag where a fabric has no usable
# Kg/Mtr (NULL/<=0) — the same "incomplete, never silently dropped" convention
# used elsewhere in this module.
_TREND_KPIS = {
    "consumption", "net_consumption", "received",
    "stock_on_hand", "returns", "metres_per_garment",
}
_TREND_TRUNC = {"day": "day", "week": "week", "month": "month"}

def _trend_prod_scope(category, subcategory, product_id):
    """Product-attribute WHERE fragment (for the `p` = raw_fabric_products alias)
    + params, narrowing to a fabric category / sub-category / specific fabric.
    Mutually exclusive in priority product_id > subcategory > category."""
    sql, params = "", []
    pid = None
    if product_id not in (None, "", "0"):
        try:
            pid = int(product_id)
        except (TypeError, ValueError):
            pid = None
    if pid is not None:
        sql += " AND p.id = %s"; params.append(pid)
    elif subcategory:
        sql += " AND p.fabric_subcategory = %s"; params.append(subcategory)
        if category:
            sql += " AND p.fabric_category = %s"; params.append(category)
    elif category:
        sql += " AND p.fabric_category = %s"; params.append(category)
    return sql, params

def _trend_move_loc(location):
    """Location scope for MOVE-based KPIs: a move "touches" a location when it is
    either side of the transfer (location_from OR location_to)."""
    loc = (location or "").strip()
    if loc and loc.lower() not in _ALL_LOC:
        return " AND (m.location_from = %s OR m.location_to = %s)", [loc, loc]
    return "", []

def _trend_inv_loc(location):
    """Location scope for the INVENTORY snapshot (stock on hand). Honours ANY
    selected location; "All"/empty falls back to the two real fabric-stock
    locations (RMAT/Stock + Dead/Stock Fabric)."""
    loc = (location or "").strip()
    if loc and loc.lower() not in _ALL_LOC:
        return " AND i.location_name = %s", [loc]
    ph = ", ".join(["%s"] * len(_FABRIC_LOCATIONS))
    return f" AND i.location_name IN ({ph})", list(_FABRIC_LOCATIONS)

def _trend_move_series(conn, trunc, where_pred, value_expr,
                       scope_sql, scope_params, loc_sql, loc_params, since, until):
    """Bucketed metres series for a move-based KPI. `value_expr` is the per-row
    metres expression; `where_pred` selects the KPI's rows. The support-fabric
    'main' scope is always applied (this tab replaces the old main movement page)."""
    sql = f"""
        SELECT DATE_TRUNC('{trunc}', m.date)::date AS period,
               ROUND(COALESCE(SUM({value_expr}), 0)::numeric, 1) AS value,
               BOOL_OR(p.kg_per_mtr_eff IS NULL OR p.kg_per_mtr_eff <= 0) AS incomplete
        FROM {EFFECTIVE_MOVES} m
        LEFT JOIN raw_fabric_products p ON p.id = m.product_id
        WHERE ({where_pred})
          AND {_scope_sql('main')}
          {scope_sql}{loc_sql}
          AND m.date::date BETWEEN %s AND %s
        GROUP BY 1 ORDER BY 1
    """
    return q(conn, sql, list(scope_params) + list(loc_params) + [since, until])

def _trend_norm(rows):
    """Normalize SQL rows → JSON-friendly {period,value,incomplete}."""
    out = []
    for r in rows:
        p = r["period"]
        out.append({
            "period": p.isoformat() if hasattr(p, "isoformat") else str(p),
            "value": float(r["value"] or 0),
            "incomplete": bool(r["incomplete"]),
        })
    return out

def _bucket_start(d, trunc):
    if trunc == "month":
        return d.replace(day=1)
    if trunc == "week":  # DATE_TRUNC('week') = Monday
        return d - datetime.timedelta(days=d.weekday())
    return d

def _next_bucket(d, trunc):
    if trunc == "month":
        return (d.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    if trunc == "week":
        return d + datetime.timedelta(days=7)
    return d + datetime.timedelta(days=1)

@fabric_router.get("/api/fabric/trend-series")
def trend_series(
    kpi: str = Query(default="consumption"),
    bucket: str = Query(default="month"),
    since: str = Query(default=None),
    until: str = Query(default=None),
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    product_id: str = Query(default=None),
    location: str = Query(default=None),
):
    kpi = (kpi or "").strip()
    if kpi not in _TREND_KPIS:
        return {"kpi": kpi, "error": "unknown_kpi", "rows": [], "incomplete": False, "unit": "m"}
    trunc = _TREND_TRUNC.get((bucket or "month").strip(), "month")
    # Date range: default last 12 months.
    today = datetime.date.today()
    try:
        until_d = datetime.date.fromisoformat(until) if until else today
    except ValueError:
        until_d = today
    try:
        since_d = datetime.date.fromisoformat(since) if since else (until_d.replace(day=1) - datetime.timedelta(days=365))
    except ValueError:
        since_d = until_d - datetime.timedelta(days=365)
    if since_d > until_d:
        since_d, until_d = until_d, since_d
    since, until = since_d.isoformat(), until_d.isoformat()

    scope_sql, scope_params = _trend_prod_scope(category, subcategory, product_id)
    mloc_sql, mloc_params = _trend_move_loc(location)
    kg = _kg("m")
    metres = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN {kg}/p.kg_per_mtr_eff ELSE 0 END"

    with _get_conn() as conn:
        _ensure_fabric_sheet(conn)

        if kpi == "consumption":  # gross consumption (RMAT/Stock exit), metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, f"({_consume_pred('m')}) AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "net_consumption":  # consumption − genuine returns into RMAT, metres
            net = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END"
            rows = _trend_norm(_trend_move_series(
                conn, trunc, _net_cons_where("m"),
                net, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "received":  # IN moves, metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, "m.move_type='IN' AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "returns":  # genuine returns back into RMAT/Stock, metres
            rows = _trend_norm(_trend_move_series(
                conn, trunc, f"({_rmat_return_pred('m')}) AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, since, until))

        elif kpi == "stock_on_hand":
            # No historical inventory snapshots exist, so back-cast from the CURRENT
            # snapshot using the net physical flow (received − net consumption):
            #   stock(end of bucket b) = stock_at_start + Σ flow up to b
            #   stock_at_start         = current_total − Σ flow over ALL history
            # The latest bucket therefore always equals the true current snapshot;
            # earlier buckets are the current value minus the moves that came after.
            iloc_sql, iloc_params = _trend_inv_loc(location)
            inv = q(conn, f"""
                SELECT COALESCE(SUM(CASE WHEN p.kg_per_mtr_eff > 0
                                         THEN i.quantity/p.kg_per_mtr_eff ELSE 0 END), 0) AS metres,
                       BOOL_OR(p.kg_per_mtr_eff IS NULL OR p.kg_per_mtr_eff <= 0) AS incomplete
                FROM raw_fabric_inventory i
                JOIN raw_fabric_products p ON p.id = i.product_id
                WHERE i.quantity > 0 AND {_scope_sql('main')}
                  {scope_sql}{iloc_sql}
            """, list(scope_params) + list(iloc_params))[0]
            current_m = float(inv["metres"] or 0)
            # Net flow per bucket over ALL history (wide range), scoped the same way.
            recv_rows = _trend_move_series(
                conn, trunc, "m.move_type='IN' AND m.uom IN ('g','kg') AND m.is_fabric",
                metres, scope_sql, scope_params, mloc_sql, mloc_params, "2000-01-01", "2100-01-01")
            net = f"CASE WHEN p.kg_per_mtr_eff > 0 THEN ({_net_kg('m')})/p.kg_per_mtr_eff ELSE 0 END"
            nc_rows = _trend_move_series(
                conn, trunc, _net_cons_where("m"),
                net, scope_sql, scope_params, mloc_sql, mloc_params, "2000-01-01", "2100-01-01")
            recv = {r["period"]: float(r["value"] or 0) for r in recv_rows}
            ncon = {r["period"]: float(r["value"] or 0) for r in nc_rows}
            flow = {k: recv.get(k, 0) - ncon.get(k, 0) for k in set(recv) | set(ncon)}
            total_flow = sum(flow.values())
            stock_at_start = current_m - total_flow
            inc = bool(inv["incomplete"]) or any(r["incomplete"] for r in recv_rows) \
                or any(r["incomplete"] for r in nc_rows)
            rows = []
            b, end = _bucket_start(since_d, trunc), _bucket_start(until_d, trunc)
            items = sorted(flow.items())
            while b <= end:
                cum = sum(v for k, v in items if k <= b)
                rows.append({"period": b.isoformat(),
                             "value": round(stock_at_start + cum, 1),
                             "incomplete": inc})
                b = _next_bucket(b, trunc)

        else:  # metres_per_garment — done-MO fabric metres ÷ garments, in Python
            fb = q(conn, """
                SELECT AVG(kg_per_mtr_eff)::float AS avg_kpm
                FROM raw_fabric_products WHERE kg_per_mtr_eff > 0
            """)[0]
            fallback_kpm = float(fb["avg_kpm"]) if fb and fb["avg_kpm"] else None
            mrows = q(conn, f"""
                SELECT DATE_TRUNC('{trunc}', c.done_date)::date AS bucket,
                       c.odoo_mo_id, c.produced_qty, c.consumed_qty,
                       lower(coalesce(c.uom,'')) AS uom, p.kg_per_mtr_eff AS kpm
                FROM mo_fabric_consumption c
                LEFT JOIN raw_fabric_products p ON p.id = c.component_id
                WHERE c.done_date BETWEEN %s AND %s AND c.is_main_fabric {scope_sql}
            """, [since, until] + list(scope_params))
            M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}
            by_bucket = {}
            for r in mrows:
                bk = r["bucket"]
                mos = by_bucket.setdefault(bk, {})
                d = mos.setdefault(r["odoo_mo_id"], {
                    "produced": float(r["produced_qty"] or 0), "metres": 0.0,
                    "has_fabric": False, "used_fallback": False})
                d["has_fabric"] = True
                qty = float(r["consumed_qty"] or 0)
                u, kpm = r["uom"], r["kpm"]
                if u in M_UOMS:
                    d["metres"] += qty
                else:
                    kgv = qty / 1000.0 if u == "g" else qty
                    if kpm and float(kpm) > 0:
                        d["metres"] += kgv / float(kpm)
                    elif fallback_kpm:
                        d["metres"] += kgv / fallback_kpm
                        d["used_fallback"] = True
            rows = []
            for bk in sorted(by_bucket):
                tm = tg = 0.0
                inc = False
                for d in by_bucket[bk].values():
                    if d["produced"] <= 0 or not d["has_fabric"]:
                        continue
                    tm += d["metres"]; tg += d["produced"]
                    if d["used_fallback"]:
                        inc = True
                if tg > 0:
                    rows.append({"period": bk.isoformat(),
                                 "value": round(tm / tg, 2), "incomplete": inc})

    return {
        "kpi": kpi, "bucket": trunc, "unit": "m",
        "since": since, "until": until,
        "rows": rows, "incomplete": any(r["incomplete"] for r in rows),
    }

@fabric_router.get("/api/fabric/trend-options")
def trend_options():
    """Scope-selector option lists for the Trend Analysis panels: fabric
    categories, sub-categories (with parent), the fabric list, and locations.
    All restricted to the 'main' (non-support) scope to match the rest of the
    dashboard tabs that this builder replaces."""
    with _get_conn() as conn:
        cats = q(conn, f"""
            SELECT DISTINCT fabric_category AS value
            FROM raw_fabric_products p
            WHERE fabric_category IS NOT NULL AND btrim(fabric_category) <> ''
              AND {_scope_sql('main')}
            ORDER BY 1
        """)
        subs = q(conn, f"""
            SELECT DISTINCT fabric_category AS category, fabric_subcategory AS subcategory
            FROM raw_fabric_products p
            WHERE fabric_subcategory IS NOT NULL AND btrim(fabric_subcategory) <> ''
              AND {_scope_sql('main')}
            ORDER BY 1, 2
        """)
        fabrics = q(conn, f"""
            SELECT p.id, p.name
            FROM raw_fabric_products p
            WHERE p.id IN (SELECT DISTINCT product_id FROM raw_fabric_inventory WHERE quantity > 0)
              AND {_scope_sql('main')}
            ORDER BY p.name
            LIMIT 2000
        """)
        locs = q(conn, """
            SELECT DISTINCT location_name AS value
            FROM raw_fabric_inventory
            WHERE quantity > 0 AND location_name IS NOT NULL AND btrim(location_name) <> ''
            ORDER BY 1
        """)
    return {
        "categories": [r["value"] for r in cats],
        "subcategories": subs,
        "fabrics": [{"id": r["id"], "name": r["name"]} for r in fabrics],
        "locations": [r["value"] for r in locs],
    }

# ── BOM styles (default explorer view) ──────────────────────
@fabric_router.get("/api/fabric/bom-styles")
def bom_styles(search: str = Query(default=None), limit: int = Query(default=300),
               scope: str = Query(default="main")):
    with _get_conn() as conn:
        where = "b.finished_product_name IS NOT NULL AND b.finished_product_name <> ''"
        params = []
        if search:
            where += " AND (b.finished_product_name ILIKE %s OR b.finished_product_sku ILIKE %s)"
            params = [f"%{search}%", f"%{search}%"]
        scope_clause = _scope_sql(scope)
        rows = q(conn, f"""
            SELECT b.finished_product_name as style, b.finished_product_sku as sku,
              COUNT(*) as components,
              COUNT(*) FILTER (WHERE b.component_uom IN ('kg','g')) as fabric_components,
              ROUND(SUM(CASE WHEN b.component_uom='g' THEN b.component_qty/1000
                             WHEN b.component_uom='kg' THEN b.component_qty ELSE 0 END)::numeric,3) as fabric_kg,
              COUNT(*) FILTER (WHERE b.component_uom='Pcs') as trim_pieces
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            WHERE {where}
              AND p.category = 'Fabric'
              AND {scope_clause}
            GROUP BY 1,2
            ORDER BY fabric_kg DESC NULLS LAST
            LIMIT %s
        """, params + [limit])
        total = q(conn, f"""
            SELECT COUNT(DISTINCT b.finished_product_name) as n
            FROM raw_fabric_boms b
            LEFT JOIN raw_fabric_products p ON p.id = b.component_id
            WHERE b.finished_product_name IS NOT NULL AND b.finished_product_name <> ''
              AND p.category = 'Fabric'
              AND {scope_clause}
        """)[0]['n']
        return {"total_styles": total, "items": rows}

# ── Where-used (reverse BOM: styles using a fabric) ─────────
@fabric_router.get("/api/fabric/where-used")
def where_used(component: str = Query(...)):
    with _get_conn() as conn:
        return q(conn, """
            SELECT b.finished_product_name as style, b.finished_product_sku as sku,
              b.component_name, ROUND(b.component_qty::numeric,3) as component_qty, b.component_uom
            FROM raw_fabric_boms b
            WHERE b.component_name ILIKE %s
            ORDER BY b.finished_product_name
            LIMIT 300
        """, (f"%{component}%",))

# ── Purchase-order delivery performance ─────────────────────
@fabric_router.get("/api/fabric/po-performance")
def po_performance(scope: str = Query(default="main")):
    _api = _get_api()
    _ck = f"fabric:po-perf:{scope}"
    _hit = _api.cache_get(_ck)
    if _hit is not None:
        return _hit
    with _get_conn() as conn:
        kpis = q(conn, f"""
            SELECT
              COUNT(DISTINCT po.po_name) as pos,
              COUNT(*) as lines,
              COUNT(DISTINCT po.po_name) FILTER (WHERE po.state='done') as done_pos,
              ROUND(SUM(po.total_value)::numeric,0) as ordered_value,
              ROUND(SUM(po.qty_received*po.price_unit)::numeric,0) as received_value,
              ROUND((SUM(po.qty_received)/NULLIF(SUM(po.qty_ordered),0)*100)::numeric,1) as fill_rate,
              ROUND(AVG(po.date_planned - po.order_date)::numeric,0) as avg_lead_days,
              COUNT(DISTINCT po.po_name) FILTER (WHERE po.date_planned < CURRENT_DATE AND po.qty_ordered>po.qty_received) as overdue_open
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)}
        """)[0]
        by_month = q(conn, f"""
            SELECT DATE_TRUNC('month', po.order_date)::date as period,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as value_kes
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)} AND po.order_date IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """)
        _result = {"kpis": kpis, "by_month": by_month}
        _api.cache_set(_ck, _result, ttl=120)
        return _result

# ── Supplier rollup (outstanding exposure) ──────────────────
@fabric_router.get("/api/fabric/suppliers")
def suppliers(scope: str = Query(default="main")):
    with _get_conn() as conn:
        return q(conn, f"""
            SELECT
              COALESCE(NULLIF(po.supplier,''),'Unknown') as supplier,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as outstanding_value,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,1) as outstanding_qty
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)}
            GROUP BY 1
            ORDER BY outstanding_value DESC NULLS LAST
        """)

# ── Supplier → Source City breakdown (consolidator drill-down) ──
@fabric_router.get("/api/fabric/suppliers/source-cities")
def supplier_source_cities(supplier: str = Query(...),
                           scope: str = Query(default="main")):
    """Per-Source-City breakdown of one supplier's outstanding exposure.

    Reuses the exact same filters/joins as /api/fabric/suppliers (exclude
    cancelled POs, join raw_fabric_products on product_id, respect scope) so the
    city rows reconcile back to the supplier's parent totals. Empty / 'false'
    Odoo city values are bucketed into a single 'Unknown / unset' row.
    """
    with _get_conn() as conn:
        return q(conn, f"""
            SELECT
              CASE
                WHEN NULLIF(BTRIM(LOWER(COALESCE(p.source_city,''))),'') IS NULL
                  OR LOWER(BTRIM(p.source_city)) = 'false'
                THEN 'Unknown / unset'
                ELSE BTRIM(p.source_city)
              END as source_city,
              COUNT(DISTINCT po.po_name) as pos,
              ROUND(SUM(po.total_value)::numeric,0) as po_value,
              ROUND(SUM((po.qty_ordered-po.qty_received)*po.price_unit)::numeric,0) as outstanding_value,
              ROUND(SUM(po.qty_ordered-po.qty_received)::numeric,1) as outstanding_qty
            FROM raw_fabric_purchase_orders po
            JOIN raw_fabric_products p ON p.id = po.product_id
            WHERE po.state != 'cancel' AND p.category = 'Fabric' AND {_scope_sql(scope)}
              AND COALESCE(NULLIF(po.supplier,''),'Unknown') = %s
            GROUP BY 1
            ORDER BY outstanding_value DESC NULLS LAST
        """, (supplier,))

# ── Filter options ──────────────────────────────────────────
@fabric_router.get("/api/fabric/suppliers/names")
def fabric_supplier_names():
    """Return a sorted, deduplicated list of non-blank fabric_supplier_name values
    from raw_fabric_products. Used to populate supplier dropdowns across all
    Fabric tabs (QC, Mix, Support, Register) with the dedicated Odoo product field
    rather than PO partner names."""
    with _get_conn() as conn:
        rows = q(conn, """
            SELECT DISTINCT NULLIF(BTRIM(fabric_supplier_name),'') AS name
            FROM raw_fabric_products
            WHERE fabric_supplier_name IS NOT NULL AND BTRIM(fabric_supplier_name) != ''
            ORDER BY 1
        """)
        return {"suppliers": [r["name"] for r in rows if r["name"]]}

@fabric_router.get("/api/fabric/filters")
def filters(scope: str = Query(default="main")):
    with _get_conn() as conn:
        cats = q(conn, f"""
            SELECT DISTINCT {_category_label_sql(scope, 'fabric_category')} as value FROM raw_fabric_products 
            WHERE fabric_category IS NOT NULL AND {_scope_sql(scope, 'fabric_category')} ORDER BY 1
        """)
        subcats = q(conn, f"""
            SELECT DISTINCT {_category_label_sql(scope, 'fabric_category')} as fabric_category, fabric_subcategory
            FROM raw_fabric_products
            WHERE fabric_subcategory IS NOT NULL AND {_scope_sql(scope, 'fabric_category')} ORDER BY 1, 2
        """)
        locs = q(conn, """
            SELECT DISTINCT location_name as value FROM raw_fabric_inventory
            WHERE quantity > 0 ORDER BY 1
        """)
        colors = q(conn, """
            SELECT DISTINCT INITCAP(BTRIM(fabric_color)) as value FROM raw_fabric_products
            WHERE fabric_color IS NOT NULL AND btrim(fabric_color) <> '' ORDER BY 1
        """)
        structs = q(conn, """
            SELECT DISTINCT NULLIF(BTRIM(fabric_structure),'') as value FROM raw_fabric_products
            WHERE fabric_structure IS NOT NULL AND BTRIM(fabric_structure) != '' ORDER BY 1
        """)
        return {
            "categories": [r['value'] for r in cats],
            "subcategories": subcats,
            "locations": [r['value'] for r in locs],
            "fabric_colors": [r['value'] for r in colors],
            "structures": [r['value'] for r in structs if r['value']],
            "plain_print": ["Solid", "Print"],
            "weight_range": ["Light", "Medium", "Heavy"],
        }

# ── Buying-team manual reservations ─────────────────────────
# Distinct from Odoo's ERP `reserved_qty`: the buying team earmarks fabric for a
# specific style, tracks how long it has been held, then marks it used.
_RESV_UOMS = {"m", "kg"}

@fabric_router.get("/api/fabric/product-search")
def product_search(q_: str = Query(default="", alias="q"), limit: int = Query(default=20)):
    """Lightweight fabric picker for the reservation form."""
    term = (q_ or "").strip()
    limit = max(1, min(int(limit or 20), 50))
    with _get_conn() as conn:
        where = "i.quantity > 0"
        params = []
        if term:
            where += " AND (p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)"
            params += [f"%{term}%", f"%{term}%", f"%{term}%"]
        return q(conn, f"""
            SELECT p.id, p.name, p.default_code, p.uom,
              ROUND(p.kg_per_mtr_eff::numeric,4) as kg_per_mtr, p.kg_per_mtr_src,
              ROUND(SUM(i.available)::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN SUM(i.available)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as available_metres
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {where}
            GROUP BY p.id, p.name, p.default_code, p.uom, p.kg_per_mtr_eff, p.kg_per_mtr_src
            ORDER BY p.name
            LIMIT %s
        """, params + [limit])

# ── Garment style picker (own styles from the BI product master) ────────────
# The reservation form's Style field is a STRICT typeahead over the deduplicated
# own-style universe in all_products_clean: partner brands excluded (row-level,
# before GROUP BY, per the style-universe brand-filter rule), retired styles
# INCLUDED. Served from api_pg.run_query with a short TTL so it stays live but
# cheap; search filtering happens in-process over the ~3.5k cached rows.
_STYLE_UNIVERSE_SQL = """
    WITH apc AS (
        SELECT style_name,
               mode() WITHIN GROUP (ORDER BY style_number) AS style_number,
               ARRAY_AGG(DISTINCT style_number)
                   FILTER (WHERE style_number IS NOT NULL AND style_number <> '')
                   AS style_numbers,
               MAX(brand) AS brand,
               'apc' AS source
        FROM all_products_clean
        WHERE style_name IS NOT NULL AND style_name <> ''
        GROUP BY style_name
        HAVING COALESCE(MAX(brand), '') NOT ILIKE '%third party%'
    ),
    rop AS (
        SELECT
            COALESCE(NULLIF(TRIM(style_name), ''),
                     NULLIF(SPLIT_PART(name, ' - ', 1), '')) AS style_name,
            mode() WITHIN GROUP (ORDER BY style_number) AS style_number,
            ARRAY_AGG(DISTINCT style_number)
                FILTER (WHERE style_number IS NOT NULL AND style_number <> '')
                AS style_numbers,
            MAX(brand) AS brand,
            'rop' AS source
        FROM raw_odoo_products
        WHERE COALESCE(NULLIF(TRIM(style_name), ''),
                       NULLIF(SPLIT_PART(name, ' - ', 1), '')) IS NOT NULL
          AND (
              COALESCE(brand, '') NOT ILIKE '%third party%'
              AND (
                  brand IS NOT NULL
                  OR name ILIKE 'Vivo%'
                  OR name ILIKE 'Safari%'
                  OR name ILIKE 'Zoya%'
              )
          )
        GROUP BY 1
    ),
    combined AS (
        SELECT * FROM apc
        UNION ALL
        SELECT * FROM rop
    ),
    deduped AS (
        SELECT DISTINCT ON (lower(style_name))
               style_name, style_number, style_numbers, brand, source
        FROM combined
        ORDER BY lower(style_name), CASE source WHEN 'apc' THEN 0 ELSE 1 END
    ),
    -- A rop-sourced name that shares a style_number with an apc entry is the
    -- SAME physical style wearing its pre-canonicalization name (apc unifies
    -- every SKU of a style_number to the dominant name, e.g. "… Maxi Dress",
    -- while raw Odoo still carries "… Maxi Dress in Crepe"). Fold it into the
    -- apc row as a searchable alias so the picker shows ONE entry whose
    -- displayed/stored name stays byte-identical to all_products_clean.
    -- Rop-only styles (no apc twin sharing a number) keep their own row.
    alias_map AS (
        SELECT DISTINCT ON (lower(r.style_name))
               lower(a.style_name) AS apc_key,
               r.style_name       AS alias_name
        FROM deduped r
        JOIN deduped a
          ON a.source = 'apc'
         AND a.style_numbers && r.style_numbers
        WHERE r.source = 'rop'
        ORDER BY lower(r.style_name), lower(a.style_name)
    )
    SELECT d.style_name, d.style_number, d.style_numbers, d.brand,
           al.aliases
    FROM deduped d
    LEFT JOIN (SELECT apc_key,
                      ARRAY_AGG(alias_name ORDER BY alias_name) AS aliases
               FROM alias_map GROUP BY apc_key) al
           ON al.apc_key = lower(d.style_name)
    WHERE d.source = 'apc'
       OR NOT EXISTS (SELECT 1 FROM alias_map m
                      WHERE lower(m.alias_name) = lower(d.style_name))
    ORDER BY d.style_name
"""


def _own_styles():
    """Deduplicated own-style list (live, 60s-cached via api_pg.run_query).
    Merges all_products_clean (apc) and raw_odoo_products (rop) so styles
    that exist in Odoo but have not yet flowed through a full rebuild are
    still findable.  apc rows win when both sources carry the same style; a
    rop name that shares a style_number with an apc row (the style was
    renamed by apc's dominant-name canonicalization) is folded into that apc
    row as a searchable alias (aliases column) instead of a duplicate entry.
    Each row carries style_numbers = ALL distinct numbers on the style's SKUs
    (230 styles have several, e.g. SAF10BT/SAF10GR/SAF10WH) for matching;
    style_number stays the single modal one that is displayed and stored."""
    import importlib
    api = importlib.import_module('api_pg')
    return api.run_query(_STYLE_UNIVERSE_SQL, ttl=60)


def _style_norm(s):
    """Lowercase + collapse every whitespace run (incl. non-breaking spaces —
    14 own styles carry double/NBSP spaces) to a single space, trimmed."""
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


# Normalized companion of the cached universe, memoized per cache generation
# (run_query hands back the same list object for the TTL; rows are shared with
# other callers so we must never mutate them — build a parallel index instead).
_style_index_memo = (None, None)


def _style_index():
    """[(row, norm_name, [norm_numbers…], [norm_aliases…])] for the current
    cached universe. Aliases are the folded pre-canonicalization rop names."""
    global _style_index_memo
    rows = _own_styles()
    memo_rows, memo_idx = _style_index_memo
    if memo_rows is rows and memo_idx is not None:
        return memo_idx
    idx = []
    for s in rows:
        nums = s.get("style_numbers") or []
        if not isinstance(nums, (list, tuple)):
            nums = [nums]
        modal = s.get("style_number")
        if modal and modal not in nums:
            nums = list(nums) + [modal]
        aliases = s.get("aliases") or []
        if not isinstance(aliases, (list, tuple)):
            aliases = [aliases]
        idx.append((s, _style_norm(s.get("style_name")),
                    [_style_norm(n) for n in nums if n],
                    [_style_norm(a) for a in aliases if a]))
    _style_index_memo = (rows, idx)
    return idx


def _style_search_rows(term, limit):
    """Shared tolerant matcher for the reservation + costing style pickers.

    Case-insensitive and whitespace-normalized; EVERY typed token must appear
    (as a substring) in the style name, any of the style's numbers or any of
    its alias names (folded pre-canonicalization rop names — typing "in
    crepe" finds the canonical entry), so out-of-order words ("arusha
    kaftan"), single-spaced quirk names and non-modal style numbers all hit.
    Rank: exact name/number match, then prefix, then contiguous substring,
    then looser token matches; hits that needed an alias always rank BELOW
    every primary-name hit, in the same exact/prefix/substring/token order —
    alphabetical within each band — so the result cap never buries the target.
    """
    term_n = _style_norm(term)
    tokens = term_n.split(" ") if term_n else []
    scored = []
    for s, name_n, nums_n, aliases_n in _style_index():
        if tokens:
            hay = name_n + " " + " ".join(nums_n) if nums_n else name_n
            if all(t in hay for t in tokens):
                if term_n == name_n or term_n in nums_n:
                    rank = 0
                elif name_n.startswith(term_n) or any(n.startswith(term_n) for n in nums_n):
                    rank = 1
                elif term_n in name_n:
                    rank = 2
                else:
                    rank = 3
            elif aliases_n and all(
                    t in hay + " " + " ".join(aliases_n) for t in tokens):
                # Alias band: matched only thanks to a folded former name.
                if term_n in aliases_n:
                    rank = 4
                elif any(a.startswith(term_n) for a in aliases_n):
                    rank = 5
                elif any(term_n in a for a in aliases_n):
                    rank = 6
                else:
                    rank = 7
            else:
                continue
        else:
            rank = 0
        scored.append((rank, name_n, s))
    scored.sort(key=lambda r: (r[0], r[1]))
    return [s for _, _, s in scored[:limit]]


def _match_style(style_name):
    """Strict membership check of a posted style against the allowed universe.
    Tolerant of case + whitespace quirks ONLY (runs of spaces / non-breaking
    spaces compare as one space) so picked suggestions never bounce; an exact
    trimmed match is preferred when both variants exist as distinct rows. A
    folded alias name (the style's pre-canonicalization rop name) also
    matches — LAST, so it can never shadow a real entry — and resolves to
    the canonical row, so a sheet posted with the old name stores the
    canonical one. Returns the UNTOUCHED canonical row — what gets stored
    (and used for DPS/MO lookups) stays byte-identical to
    all_products_clean — or None."""
    want = (style_name or "").strip().lower()
    if not want:
        return None
    for s in _own_styles():
        if (s.get("style_name") or "").strip().lower() == want:
            return s
    want_n = _style_norm(style_name)
    for s, name_n, _nums, _aliases in _style_index():
        if name_n == want_n:
            return s
    for s, _name_n, _nums, aliases_n in _style_index():
        if want_n in aliases_n:
            return s
    return None


@fabric_router.get("/api/fabric/style-search")
def style_search(q_: str = Query(default="", alias="q"),
                 limit: int = Query(default=20)):
    """Strict style picker for the reservation form: tolerant token match on
    style name OR any of the style's numbers (see _style_search_rows), returns
    name + modal number + brand."""
    limit = max(1, min(int(limit or 20), 50))
    return [{"style_name": s.get("style_name"),
             "style_number": s.get("style_number"),
             "brand": s.get("brand")}
            for s in _style_search_rows(q_, limit)]


# ── Reservation aging + expiry thresholds (the ONE place to tune them) ──
# A still-open reservation gets a one-time bell notification to the reserver
# after _RESV_AGING_NOTICE_DAYS, and auto-expires (status='expired', quantity
# freed) _RESV_EXPIRE_GRACE_DAYS after that notice (21 days total by default).
_RESV_AGING_NOTICE_DAYS = 14
_RESV_EXPIRE_GRACE_DAYS = 7

def _notify_user(conn, user_id, ntype, title, message, dedupe_key, link="/fabric"):
    """Insert a persisted bell notification for one user. Idempotent via the
    UNIQUE dedupe_key (ON CONFLICT DO NOTHING) — safe to call from a sweep that
    may re-run. Skips rows with no real user to notify."""
    if not user_id or user_id == "system":
        return
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO user_notifications (user_id, type, title, message, link, dedupe_key)
            VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (dedupe_key) DO NOTHING
        """, (user_id, ntype, title, message, link, dedupe_key))

def _resv_available_kg(conn, product_id):
    """Available-to-reserve (kg) for one fabric = RMAT/Stock on-hand − ERP
    reserved on RMAT/Stock (raw_fabric_inventory.reserved_qty, already synced)
    − sum of OPEN app reservations. Can go negative when over-reserved."""
    rows = q(conn, """
        SELECT
          COALESCE((SELECT SUM(quantity - reserved_qty) FROM raw_fabric_inventory
                    WHERE product_id=%s AND location_name=%s), 0) AS free_kg,
          COALESCE((SELECT SUM(qty_kg) FROM fabric_reservations
                    WHERE product_id=%s AND status='active'), 0) AS open_kg
    """, (product_id, STOCK_LOC, product_id))
    r = rows[0]
    return float(r["free_kg"] or 0) - float(r["open_kg"] or 0)

def _sweep_reservations(conn, request=None):
    """Lazy, idempotent aging/expiry sweep, run on every reservations-list read.

    1) Auto-expire: open reservations older than notice+grace days flip to
       status='expired' (quantity immediately counts as available again — every
       availability reader filters status='active'), the reserver is notified,
       and the change is audit-logged like other status changes.
    2) 14-day notice: open reservations older than the notice window get a
       one-time bell notification to the reserver (aging_notified_at stamp +
       dedupe_key make re-runs no-ops).
    Never raises — a broken sweep must not take down the list endpoint."""
    try:
        expire_days = _RESV_AGING_NOTICE_DAYS + _RESV_EXPIRE_GRACE_DAYS
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                UPDATE fabric_reservations r
                SET status='expired', expired_at=now()
                WHERE r.status='active'
                  AND r.reserved_at < now() - make_interval(days => %s)
                RETURNING r.id, r.product_id, r.qty, r.uom, r.qty_kg, r.style_name,
                          r.style_number, r.note, r.reserved_by, r.reserved_by_name,
                          (SELECT name FROM raw_fabric_products p WHERE p.id=r.product_id) AS product
            """, (expire_days,))
            expired = [dict(x) for x in cur.fetchall()]
            cur.execute("""
                UPDATE fabric_reservations r
                SET aging_notified_at=now()
                WHERE r.status='active' AND r.aging_notified_at IS NULL
                  AND r.reserved_at < now() - make_interval(days => %s)
                RETURNING r.id, r.qty, r.uom, r.reserved_by,
                          (SELECT name FROM raw_fabric_products p WHERE p.id=r.product_id) AS product
            """, (_RESV_AGING_NOTICE_DAYS,))
            aging = [dict(x) for x in cur.fetchall()]
        for e in expired:
            qty_txt = f"{float(e['qty']):g} {e['uom']}"
            _notify_user(conn, e.get("reserved_by"), "fabric_resv_expired",
                "Fabric reservation expired",
                (f"Your reservation of {qty_txt} of {e.get('product') or 'a fabric'} "
                 f"for {e.get('style_name') or '—'} was open for over {expire_days} days "
                 "and has expired — the quantity is available to others again. "
                 "Re-reserve it if you still need the fabric."),
                f"fabric_resv_expired:{e['id']}")
        for a in aging:
            qty_txt = f"{float(a['qty']):g} {a['uom']}"
            _notify_user(conn, a.get("reserved_by"), "fabric_resv_aging",
                "Fabric reservation still open",
                (f"Your reservation of {qty_txt} of {a.get('product') or 'a fabric'} has been "
                 f"open for over {_RESV_AGING_NOTICE_DAYS} days. Mark it used or delete it — "
                 f"it will auto-expire {_RESV_EXPIRE_GRACE_DAYS} days from now."),
                f"fabric_resv_aging:{a['id']}")
        conn.commit()
        for e in expired:
            e["status"] = "expired"
            _log_fabric_change("Expired", e, request)
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

@fabric_router.get("/api/fabric/reservations")
def list_reservations(request: Request, status: str = Query(default="active"), search: str = Query(default=None)):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        _sweep_reservations(conn, request)
        where = ["1=1"]
        params = []
        status = (status or "").lower()
        if status == "aging":
            # Open reservations held over the notice window.
            where.append("r.status='active'")
            where.append("r.reserved_at < now() - make_interval(days => %s)")
            params.append(_RESV_AGING_NOTICE_DAYS)
        elif status and status != "all":
            where.append("r.status = %s"); params.append(status)
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR r.style_name ILIKE %s)")
            params += [f"%{search}%", f"%{search}%", f"%{search}%"]
        # `soh` = current total stock on hand (kg) per fabric across all locations.
        # `rmat` = RMAT/Stock on-hand minus the ERP (Odoo) reserved qty there.
        # `appr` = sum of OPEN app reservations per fabric.
        # available_kg = rmat.free_kg − appr.open_kg (all open reservations
        # subtracted — the same figure the create endpoint enforces against).
        # over_stock flags an OPEN row whose qty now exceeds availability when
        # every OTHER open reservation is honoured (⇔ open total > free stock).
        rows = q(conn, f"""
            WITH soh AS (
              SELECT product_id, SUM(quantity) as soh_kg
              FROM raw_fabric_inventory
              GROUP BY product_id
            ), rmat AS (
              SELECT product_id, SUM(quantity - reserved_qty) as free_kg
              FROM raw_fabric_inventory
              WHERE location_name = %s
              GROUP BY product_id
            ), appr AS (
              SELECT product_id, SUM(qty_kg) as open_kg
              FROM fabric_reservations
              WHERE status='active'
              GROUP BY product_id
            )
            SELECT r.id, r.product_id, r.qty, r.uom, r.qty_kg, r.style_name, r.style_number, r.note,
              r.status, r.reserved_by_name, r.reserved_at::date as reserved_on,
              r.used_at::date as used_on, r.used_by, r.expired_at::date as expired_on,
              p.name as fabric_name, p.default_code, p.kg_per_mtr_eff as kg_per_mtr,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN r.qty_kg/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(COALESCE(s.soh_kg,0)::numeric,2) as soh_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(s.soh_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as soh_metres,
              ROUND((COALESCE(rm.free_kg,0) - COALESCE(ap.open_kg,0))::numeric,2) as available_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0
                    THEN (COALESCE(rm.free_kg,0) - COALESCE(ap.open_kg,0))/p.kg_per_mtr_eff
                    END::numeric,1) as available_metres,
              (r.status='active' AND r.qty_kg >
                 COALESCE(rm.free_kg,0) - (COALESCE(ap.open_kg,0) - r.qty_kg) + 0.001) as over_stock,
              (CURRENT_DATE - r.reserved_at::date) as days_reserved,
              CASE WHEN r.used_at IS NOT NULL
                   THEN (r.used_at::date - r.reserved_at::date) END as days_to_use
            FROM fabric_reservations r
            LEFT JOIN raw_fabric_products p ON p.id = r.product_id
            LEFT JOIN soh s ON s.product_id = r.product_id
            LEFT JOIN rmat rm ON rm.product_id = r.product_id
            LEFT JOIN appr ap ON ap.product_id = r.product_id
            WHERE {' AND '.join(where)}
            ORDER BY (r.status='active') DESC, r.reserved_at DESC
            LIMIT 500
        """, [STOCK_LOC] + params)
        return {"items": rows, "aging_days": _RESV_AGING_NOTICE_DAYS,
                "expire_days": _RESV_AGING_NOTICE_DAYS + _RESV_EXPIRE_GRACE_DAYS}

@fabric_router.get("/api/fabric/reservations/availability")
def reservation_availability(product_id: int = Query(...)):
    """'Available to reserve' for one fabric, shown on the reservation form
    before the user commits. Same computation the create endpoint enforces."""
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        avail_kg = _resv_available_kg(conn, product_id)
        prod = q(conn, "SELECT kg_per_mtr_eff FROM raw_fabric_products WHERE id=%s",
                 (product_id,))
        kgm = float(prod[0].get("kg_per_mtr_eff") or 0) if prod else 0
        return {"product_id": product_id,
                "available_kg": round(avail_kg, 2),
                "available_metres": round(avail_kg / kgm, 1) if kgm > 0 else None,
                "kg_per_mtr": kgm or None}

@fabric_router.post("/api/fabric/reservations")
def create_reservation(request: Request, body: dict = Body(...)):
    product_id = body.get("product_id")
    style_name = (body.get("style_name") or "").strip()
    uom = (body.get("uom") or "").strip().lower()
    note = (body.get("note") or "").strip() or None
    try:
        qty = float(body.get("qty"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="qty must be a number")
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id is required")
    if qty <= 0:
        raise HTTPException(status_code=400, detail="qty must be greater than zero")
    if uom not in _RESV_UOMS:
        raise HTTPException(status_code=400, detail="uom must be 'm' or 'kg'")
    if not style_name:
        raise HTTPException(status_code=400, detail="style_name is required")
    # STRICT style picker: the posted style must exist in the own-style universe
    # (all_products_clean, partner brands excluded, retired included). The
    # canonical name + style number come from the matched row, never the client.
    style_row = _match_style(style_name)
    if not style_row:
        raise HTTPException(status_code=400,
            detail="style not recognised — pick a style from the suggestions list")
    style_name = (style_row.get("style_name") or "").strip()
    style_number = (style_row.get("style_number") or "").strip() or None
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        prod = q(conn, "SELECT id, name, kg_per_mtr_eff FROM raw_fabric_products WHERE id=%s",
                 (product_id,))
        if not prod:
            raise HTTPException(status_code=404, detail="fabric not found")
        kg_per_mtr = prod[0].get("kg_per_mtr_eff") or 0
        if uom == "kg":
            qty_kg = qty
        else:  # metres → kg
            if not kg_per_mtr or kg_per_mtr <= 0:
                raise HTTPException(status_code=400,
                    detail="this fabric has no kg/m factor; reserve it in kg instead")
            qty_kg = qty * float(kg_per_mtr)
        # Stock cap: never let a new reservation exceed what's truly available
        # at RMAT/Stock (on-hand − ERP reserved − other open app reservations).
        avail_kg = _resv_available_kg(conn, product_id)
        if qty_kg > avail_kg + 1e-6:
            if uom == "m" and kg_per_mtr and float(kg_per_mtr) > 0:
                avail_txt = f"{max(avail_kg, 0) / float(kg_per_mtr):.1f} m"
            else:
                avail_txt = f"{max(avail_kg, 0):.1f} kg"
            raise HTTPException(status_code=400,
                detail=(f"only {avail_txt} of this fabric is available to reserve "
                        "(RMAT stock minus Odoo allocations and other open "
                        "reservations) — reduce the quantity"))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO fabric_reservations
                  (product_id, qty, uom, qty_kg, style_name, style_number, note, reserved_by, reserved_by_name)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (product_id, qty, uom, round(qty_kg, 3), style_name, style_number, note, uid, name))
            new_id = cur.fetchone()["id"]
        conn.commit()
        _log_fabric_change("Created", {
            "id": new_id, "product": prod[0].get("name"),
            "style_name": style_name, "style_number": style_number,
            "qty": qty, "uom": uom,
            "note": note, "status": "active",
        }, request)
        return {"id": new_id, "ok": True}

@fabric_router.post("/api/fabric/reservations/{resv_id}/use")
def mark_reservation_used(resv_id: int, request: Request):
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_reservations
                SET status='used', used_at=now(), used_by=%s
                WHERE id=%s AND status='active'
            """, (name, resv_id))
            updated = cur.rowcount
        conn.commit()
        if not updated:
            raise HTTPException(status_code=404,
                detail="reservation not found or already closed")
        _log_fabric_change("Marked used", _resv_for_log(conn, resv_id)
                           or {"id": resv_id, "status": "used"}, request)
        return {"ok": True}

@fabric_router.delete("/api/fabric/reservations/{resv_id}")
def delete_reservation(resv_id: int, request: Request):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        # Capture details BEFORE the row is gone so the audit log is human-readable.
        snapshot = _resv_for_log(conn, resv_id)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fabric_reservations WHERE id=%s", (resv_id,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            raise HTTPException(status_code=404, detail="reservation not found")
        log_row = snapshot or {"id": resv_id}
        log_row["status"] = "deleted"
        _log_fabric_change("Deleted", log_row, request)
        return {"ok": True}

# ── Support-scope name-prefix overrides (admin-editable) ─────────────────────
# CRUD for the fabric_support_overrides list that _scope_sql consults. Viewing
# is broadly accessible (the Support tab shows the active rules); WRITES are
# admin-only, gated server-side in the api_pg auth gate (same pattern as
# /api/fabric/rolls). Rules take effect immediately — the scope predicate
# subselects the table live on every query.

def _support_ovr_rule_stats(conn, prefix):
    """Live matched-product stats for a prefix: how many product rows match,
    and a small sample of names for eyeballing."""
    rows = q(conn, """
        SELECT name FROM raw_fabric_products
        WHERE starts_with(LOWER(BTRIM(name)), LOWER(BTRIM(%s)))
        ORDER BY name
    """, (prefix,))
    names = [r["name"] for r in rows]
    return {"matched_products": len(names), "sample_names": names[:8]}

@fabric_router.get("/api/fabric/support-overrides")
def support_overrides_list():
    with _get_conn() as conn:
        rules = q(conn, """
            SELECT o.id, o.name_prefix, o.created_by,
                   to_char(o.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY') as created_at,
                   COUNT(rp.id) as matched_products
            FROM fabric_support_overrides o
            LEFT JOIN raw_fabric_products rp
              ON starts_with(LOWER(BTRIM(rp.name)), LOWER(BTRIM(o.name_prefix)))
            GROUP BY o.id, o.name_prefix, o.created_by, o.created_at
            ORDER BY LOWER(o.name_prefix)
        """)
        return {"rules": rules}

@fabric_router.get("/api/fabric/support-overrides/preview")
def support_overrides_preview(prefix: str = Query(default="")):
    """Live preview while typing a new rule: how many products the prefix
    would pull into the support scope, with sample names."""
    prefix = (prefix or "").strip()
    if not prefix:
        return {"matched_products": 0, "sample_names": []}
    with _get_conn() as conn:
        _ensure_support_overrides()
        return _support_ovr_rule_stats(conn, prefix)

@fabric_router.post("/api/fabric/support-overrides")
def support_overrides_add(request: Request, body: dict = Body(...)):
    """Add a name-prefix rule (admin-only via the api_pg auth gate)."""
    prefix = str(body.get("name_prefix") or "").strip()
    if len(prefix) < 3:
        raise HTTPException(status_code=400,
            detail="name_prefix must be at least 3 characters")
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_support_overrides()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO fabric_support_overrides (name_prefix, created_by)
                VALUES (%s, %s)
                ON CONFLICT ((LOWER(BTRIM(name_prefix)))) DO NOTHING
                RETURNING id, name_prefix
            """, (prefix, name or uid or "admin"))
            row = cur.fetchone()
        conn.commit()
        if not row:
            raise HTTPException(status_code=409, detail="rule already exists")
        stats = _support_ovr_rule_stats(conn, prefix)
        _log_fabric_change("Added support override",
                           {"id": row["id"], "name_prefix": row["name_prefix"],
                            "status": "created"}, request)
        return {"ok": True, "id": row["id"], "name_prefix": row["name_prefix"],
                **stats}

@fabric_router.delete("/api/fabric/support-overrides/{rule_id}")
def support_overrides_delete(rule_id: int, request: Request):
    """Remove a rule (admin-only via the api_pg auth gate)."""
    with _get_conn() as conn:
        _ensure_support_overrides()
        rows = q(conn, "SELECT id, name_prefix FROM fabric_support_overrides WHERE id=%s",
                 (rule_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="rule not found")
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fabric_support_overrides WHERE id=%s", (rule_id,))
        conn.commit()
        _log_fabric_change("Removed support override",
                           {"id": rule_id, "name_prefix": rows[0]["name_prefix"],
                            "status": "deleted"}, request)
        return {"ok": True}

# ── Fabric roll tracking (manual per-location physical roll counts) ──────────
# Odoo only tracks fabric quantity by weight (kg) / length (m), never the number
# of physical rolls. The Rolls tab lets the fabric team hand-maintain a roll
# count per fabric product per stock location, shown alongside the Odoo quantity
# purely for eyeballing physical stock. Editing is limited to the admin ROLE plus
# the named fabric-team emails below (enforced in the api_pg auth gate on the
# POST method); the GET is broadly viewable like the rest of Fabric BI.
_ROLL_TZ = "Africa/Nairobi"

# Users allowed to EDIT roll counts: the admin role plus an explicit per-email
# allowance for the fabric team (mirrors the _FABRIC_ADMIN_EMAILS pattern used
# for receiving-sheet editing). Everyone else keeps view-only access.
_ROLLS_EDIT_EMAILS = {
    "bedan@vivofashiongroup.com",
    "hagai@vivofashiongroup.com",
    "kevinl@vivofashiongroup.com",
    "admin@vivofashiongroup.com",
    "analytics@vivofashiongroup.com",
}

def _rolls_can_edit(user):
    """True when this user dict may edit manual roll counts (admin role or an
    explicitly allowlisted email, matched case-insensitively/trimmed)."""
    u = user or {}
    if u.get("role") == "admin":
        return True
    return (u.get("email") or "").strip().lower() in _ROLLS_EDIT_EMAILS

@fabric_router.get("/api/fabric/rolls")
def rolls_list(
    request: Request,
    category: str = Query(default=None),
    subcategory: str = Query(default=None),
    plain_print: str = Query(default=None),
    weight_range: str = Query(default=None),
    fabric_color: str = Query(default=None),
    search: str = Query(default=None),
    sort: str = Query(default="value_kes"),
    dir: str = Query(default="desc"),
    limit: int = Query(default=100),
    offset: int = Query(default=0),
    scope: str = Query(default="main"),
):
    """Fabric products with their per-location Odoo quantity (kg + metres where a
    kg→metre conversion exists) joined to the stored manual roll counts. Shows the
    two real fabric-stock buckets (RMAT/Stock + Dead/Stock Fabric) side by side.
    Supports the same search/filter parameters as the Register so the list is
    navigable identically."""
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        ALLOWED_SORT = {
            "default_code", "name", "fabric_category", "fabric_subcategory",
            "rmat_kg", "dead_kg", "value_kes",
        }
        sort_col = sort if sort in ALLOWED_SORT else "value_kes"
        sort_dir = "ASC" if str(dir).lower() == "asc" else "DESC"
        order_by = f"ORDER BY {sort_col} {sort_dir} NULLS LAST, p.id ASC"

        where = ["i.location_name IN ('RMAT/Stock','Dead/Stock Fabric')",
                 "i.quantity > 0", "p.category = 'Fabric'", _scope_sql(scope)]
        params = []
        if category:
            where.append("p.fabric_category = %s"); params.append(category)
        if subcategory:
            where.append("p.fabric_subcategory = %s"); params.append(subcategory)
        if plain_print:
            where.append("p.plain_print = %s"); params.append(plain_print)
        if weight_range:
            where.append("p.weight_range = %s"); params.append(weight_range)
        if fabric_color:
            where.append("UPPER(BTRIM(p.fabric_color)) = UPPER(BTRIM(%s))"); params.append(fabric_color)
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        where_sql = " AND ".join(where)

        rows = q(conn, f"""
            SELECT
              p.id, p.name, p.default_code, p.barcode,
              {_category_label_sql(scope)} as fabric_category, p.fabric_subcategory,
              p.plain_print, p.weight_range,
              INITCAP(BTRIM(p.fabric_color)) as fabric_color,
              p.kg_per_mtr_eff as kg_per_mtr,
              ROUND(SUM(i.quantity) FILTER (WHERE i.location_name='RMAT/Stock')::numeric,2) as rmat_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0
                    THEN SUM(i.quantity) FILTER (WHERE i.location_name='RMAT/Stock')/p.kg_per_mtr_eff
                    ELSE NULL END::numeric,1) as rmat_metres,
              ROUND(SUM(i.quantity) FILTER (WHERE i.location_name='Dead/Stock Fabric')::numeric,2) as dead_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0
                    THEN SUM(i.quantity) FILTER (WHERE i.location_name='Dead/Stock Fabric')/p.kg_per_mtr_eff
                    ELSE NULL END::numeric,1) as dead_metres,
              ROUND(SUM(i.total_value)::numeric,0) as value_kes,
              rc_r.rolls as rmat_rolls, rc_r.updated_by_name as rmat_updated_by,
              to_char(rc_r.updated_at AT TIME ZONE '{_ROLL_TZ}','DD Mon YYYY, HH24:MI') as rmat_updated_at,
              rc_d.rolls as dead_rolls, rc_d.updated_by_name as dead_updated_by,
              to_char(rc_d.updated_at AT TIME ZONE '{_ROLL_TZ}','DD Mon YYYY, HH24:MI') as dead_updated_at
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN fabric_roll_counts rc_r ON rc_r.product_id = p.id AND rc_r.location_name='RMAT/Stock'
            LEFT JOIN fabric_roll_counts rc_d ON rc_d.product_id = p.id AND rc_d.location_name='Dead/Stock Fabric'
            WHERE {where_sql}
            GROUP BY p.id, p.name, p.default_code, p.barcode,
                     p.fabric_category, p.fabric_subcategory,
                     p.plain_print, p.weight_range, p.fabric_color, p.kg_per_mtr_eff,
                     rc_r.rolls, rc_r.updated_by_name, rc_r.updated_at,
                     rc_d.rolls, rc_d.updated_by_name, rc_d.updated_at
            {order_by}
            LIMIT %s OFFSET %s
        """, params + [limit, offset])

        total = q(conn, f"""
            SELECT COUNT(*) as n FROM (
              SELECT p.id
              FROM raw_fabric_inventory i
              JOIN raw_fabric_products p ON p.id = i.product_id
              WHERE {where_sql}
              GROUP BY p.id
            ) sub
        """, params)[0]['n']

        # The page learns its edit rights from the server (admin role or the
        # rolls-edit email allowlist) instead of duplicating the list client-side.
        return {"total": total, "items": rows,
                "can_edit": _rolls_can_edit(getattr(request.state, "user", None))}

@fabric_router.post("/api/fabric/rolls")
def set_roll_count(request: Request, body: dict = Body(...)):
    """Upsert a manual roll count for a (product, location). Limited to the
    admin role or the rolls-edit email allowlist — the write is gated
    server-side in the api_pg auth gate; client hiding of the edit controls is
    not the enforcement point."""
    product_id = body.get("product_id")
    location = (body.get("location") or "").strip()
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id is required")
    if location not in _FABRIC_LOCATIONS:
        raise HTTPException(status_code=400,
            detail="location must be RMAT/Stock or Dead/Stock Fabric")
    try:
        rolls = int(body.get("rolls"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="rolls must be a whole number")
    if rolls < 0:
        raise HTTPException(status_code=400, detail="rolls cannot be negative")
    uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        prod = q(conn, "SELECT id FROM raw_fabric_products WHERE id=%s", (product_id,))
        if not prod:
            raise HTTPException(status_code=404, detail="fabric not found")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                INSERT INTO fabric_roll_counts
                  (product_id, location_name, rolls, updated_by, updated_by_name, updated_at)
                VALUES (%s,%s,%s,%s,%s, now())
                ON CONFLICT (product_id, location_name) DO UPDATE
                  SET rolls           = EXCLUDED.rolls,
                      updated_by      = EXCLUDED.updated_by,
                      updated_by_name = EXCLUDED.updated_by_name,
                      updated_at      = now()
                RETURNING rolls, updated_by_name,
                  to_char(updated_at AT TIME ZONE '{_ROLL_TZ}','DD Mon YYYY, HH24:MI') as updated_at
            """, (product_id, location, rolls, uid, name))
            row = cur.fetchone()
        conn.commit()
        return {"ok": True, "rolls": row["rolls"],
                "updated_by_name": row["updated_by_name"],
                "updated_at": row["updated_at"]}


# ── Fabric receiving sheets (printable roll-by-roll intake records) ──────────
# When a fabric delivery arrives, the team records each physical roll's weight
# (kg) and prints a "FABRIC RECEIVING INFORMATION SHEET" — the same product
# header as the Buying sheet plus a rolls table where metres are derived from
# the product's kg->metre conversion (kg_per_mtr_eff). Sheets persist in
# Postgres ONLY (no Odoo writes); the conversion factor is SNAPSHOTTED on the
# sheet at save time so a later Width/GSM correction never silently rewrites an
# already-printed historical record. A missing conversion is stored as NULL
# metres and explicitly flagged (never a silent 0/blank). Tables are created
# lazily, mirroring the fabric_reservations pattern. Auth: same broad session
# gate as the rest of /api/fabric/* (no extra role gating).
_RECEIVING_TABLES_READY = False

def _ensure_receiving_tables(conn):
    global _RECEIVING_TABLES_READY
    if _RECEIVING_TABLES_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_receiving_sheets (
                id              SERIAL PRIMARY KEY,
                product_id      INTEGER NOT NULL,
                barcode         TEXT,
                fabric_name     TEXT,
                kg_per_mtr      NUMERIC,
                total_kg        NUMERIC NOT NULL DEFAULT 0,
                total_mtrs      NUMERIC,
                rolls_count     INTEGER NOT NULL DEFAULT 0,
                note            TEXT,
                created_by      TEXT,
                created_by_name TEXT,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_receiving_rolls (
                id       SERIAL PRIMARY KEY,
                sheet_id INTEGER NOT NULL
                         REFERENCES fabric_receiving_sheets(id) ON DELETE CASCADE,
                roll_no  INTEGER NOT NULL,
                qty_kg   NUMERIC NOT NULL,
                qty_mtrs NUMERIC
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_recv_rolls_sheet "
                    "ON fabric_receiving_rolls(sheet_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_recv_product "
                    "ON fabric_receiving_sheets(product_id)")
        # Quality inspection / testing results, recorded PER ROLL and fillable
        # AFTER the sheet is saved (data comes later). Status is one of
        # Pass/Fail/Pending (NULL = not yet inspected); notes is free text.
        # Each update stamps who/when. Added idempotently so an existing table
        # gains the columns on first touch.
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS quality_status TEXT")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS quality_notes TEXT")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS quality_updated_by TEXT")
        # Admin-only edits to rolls/quantities are timestamped on the sheet.
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS updated_by_name TEXT")
        # Odoo purchase-order link: a sheet may (optionally) point at ONE draft
        # PO so partial deliveries batch per PO (many sheets share one po_id).
        # po_name/po_date snapshot the PO header at link time; po_date becomes
        # the sheet's displayed "Receiving Date" (the true created_at stays
        # stored untouched). Added idempotently so prod gains the columns on
        # first touch after publish (prod is a separate DB).
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS po_id BIGINT")
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS po_name TEXT")
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS po_date DATE")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_recv_po "
                    "ON fabric_receiving_sheets(po_id)")
        # ONE receiving sheet per PO (enforced): the PO-level sheet is the
        # unit of receiving. Product rows in fabric_receiving_sheets act as
        # CHILD SECTIONS of this sheet (linked via po_sheet_id); rolls hang
        # off the sections. UNIQUE(po_id) makes a second sheet for the same
        # PO impossible at the database level. Legacy per-fabric sheets
        # (po_sheet_id NULL) stay readable in their old shape. Safe for prod
        # publish: brand-new table, so the UNIQUE can't fail on dirty rows.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_receiving_po_sheets (
                id              SERIAL PRIMARY KEY,
                po_id           BIGINT NOT NULL UNIQUE,
                po_name         TEXT,
                po_date         DATE,
                created_by      TEXT,
                created_by_name TEXT,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        # Delivery-level signoff: who (supervisor or admin) formally approved
        # this whole PO batch once every roll inspection is done. These columns
        # are added lazily (idempotent ALTER IF NOT EXISTS) so existing rows
        # on prod keep working; the approve endpoint writes them; the receiving
        # list and QC report read them.
        cur.execute("ALTER TABLE fabric_receiving_po_sheets "
                    "ADD COLUMN IF NOT EXISTS delivery_approved_by TEXT")
        cur.execute("ALTER TABLE fabric_receiving_po_sheets "
                    "ADD COLUMN IF NOT EXISTS delivery_approved_by_email TEXT")
        cur.execute("ALTER TABLE fabric_receiving_po_sheets "
                    "ADD COLUMN IF NOT EXISTS delivery_approved_at TIMESTAMPTZ")
        # Credit / back-order status for the delivery: NULL (not set),
        # 'credit_note' (Credit Note Raised) or 'back_order' (Back Order Raised).
        # Toggled exclusively by bedan@vivofashiongroup.com via the invoice-status
        # endpoint; a second click on the active flag clears it back to NULL.
        cur.execute("ALTER TABLE fabric_receiving_po_sheets "
                    "ADD COLUMN IF NOT EXISTS invoice_status TEXT")
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS po_sheet_id INTEGER")
        # Audit of every "Upload to Odoo PO" push: who pushed, when, to which
        # PO, and the full per-product result summary (exactly what the UI was
        # shown). Failed attempts are recorded too (status='failed') so the
        # trail is honest about partial writes.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_po_uploads (
                id               SERIAL PRIMARY KEY,
                po_id            BIGINT NOT NULL,
                po_name          TEXT,
                status           TEXT NOT NULL,
                summary          JSONB,
                uploaded_by      TEXT,
                uploaded_by_name TEXT,
                uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_po_uploads_po "
                    "ON fabric_po_uploads(po_id)")
        # Per-PO Yuan pricing entered by the buying team before an upload:
        # two FX rates on the PO header row, plus one Yuan price per
        # Supplier Fabric Code (or per product when the fabric has no code).
        # price_key is 'code:<supplier fabric code>' or 'product:<odoo id>'.
        # quote_unit is the unit the Yuan price was quoted in ('kg' | 'm');
        # the upload converts to the PO line's own unit via kg_per_mtr_eff.
        # direct_kes (whole-PO): a local Kenya purchase priced directly in
        # KES — yuan_price then HOLDS the KES price and the two FX rates are
        # ignored/not required (no conversion anywhere).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_po_pricing (
                po_id           BIGINT PRIMARY KEY,
                yuan_to_usd     NUMERIC,
                usd_to_kes      NUMERIC,
                updated_by_name TEXT,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        cur.execute("ALTER TABLE fabric_po_pricing "
                    "ADD COLUMN IF NOT EXISTS direct_kes BOOLEAN "
                    "NOT NULL DEFAULT FALSE")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_po_pricing_items (
                po_id      BIGINT NOT NULL,
                price_key  TEXT   NOT NULL,
                yuan_price NUMERIC,
                quote_unit TEXT   NOT NULL DEFAULT 'kg',
                PRIMARY KEY (po_id, price_key)
            )""")
        # Who/what/when audit trail for roll & quantity changes on a PO's
        # receiving sheets (adds, edits, deletes — including post-upload admin
        # corrections). Shown on the PO sheet drill-down next to the upload
        # history. details is a small JSON blob describing exactly what changed.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_recv_audit (
                id          SERIAL PRIMARY KEY,
                po_id       BIGINT,
                sheet_id    INTEGER,
                fabric_name TEXT,
                action      TEXT NOT NULL,
                details     JSONB,
                actor_name  TEXT,
                at          TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_recv_audit_po "
                    "ON fabric_recv_audit(po_id)")
        # Soft-delete (Recovery Bin): deleted sheets/rolls keep their rows with
        # deleted_at/deleted_by stamped; every reader excludes them. Restore /
        # permanent purge is gated to full fabric admins; rows older than 90
        # days are lazily hard-purged when the bin is opened. Idempotent adds
        # so prod gains the columns on first touch after publish.
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS deleted_by TEXT")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS deleted_by TEXT")
        # Structured per-roll quality measurements (alongside the Pass/Fail/
        # Pending status + free-text notes): length in yards, shrinkage in
        # inches, bleeding test result, measured width in metres.
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS length_yards NUMERIC")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS shrinkage_inches NUMERIC")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS bleeding_test TEXT")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS width_measured_m NUMERIC")
        # Structured shrinkage: the QC team re-measures a 35cm x 35cm gauge
        # square after wash and records the resulting size in cm along the
        # Width and along the Length. We persist the RAW entered cm (e.g.
        # 33.5) so inches / percent can always be re-derived; the legacy
        # single shrinkage_inches stays readable for historical rolls.
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS after_wash_width_cm NUMERIC")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS after_wash_length_cm NUMERIC")
        # Invoiced-quantity columns: manually entered by bedan@vivofashiongroup.com
        # after reconciling the physical delivery against the supplier's invoice.
        # NULL = not yet entered (blank dash in the UI). The variance (Received −
        # Invoiced) is derived on the fly; positive = over-invoiced, negative =
        # under-invoiced.
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS inv_kg NUMERIC")
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS inv_mtrs NUMERIC")
        # Per-user field-level edit grants: controls who may write
        # after_wash_width_cm (width_edit) and who may renumber rolls
        # (roll_no_edit). Soft-revocable via revoked_at (NULL = active).
        # Admin panel (BI app) manages entries. Unique per (user, field).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_field_grants (
                id          SERIAL PRIMARY KEY,
                user_id     TEXT NOT NULL,
                field_name  TEXT NOT NULL
                    CHECK (field_name IN ('width_edit','roll_no_edit')),
                granted_by  TEXT,
                granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                revoked_at  TIMESTAMPTZ,
                UNIQUE (user_id, field_name)
            )""")
        # Defective yards: the number of yards in a roll found to be defective
        # during QC inspection (e.g. 15 out of 80 yards). Okay yards are
        # derived server-side as length_yards - defective_yards. Informational
        # only — does not affect stock or weeks-of-cover figures.
        cur.execute("ALTER TABLE fabric_receiving_rolls "
                    "ADD COLUMN IF NOT EXISTS defective_yards NUMERIC")
        # Lot-level (delivery average) acceptance limit for the 4-Point
        # standard: average pts/100 sq.yd across the sheet's submitted
        # tickets. NULL = the default (20). Configurable per sheet by the
        # QC supervisor / admin.
        cur.execute("ALTER TABLE fabric_receiving_sheets "
                    "ADD COLUMN IF NOT EXISTS lot_acceptable_limit NUMERIC")
        # 4-Point (American system) inspection tickets, one or more VERSIONS
        # per roll. Keyed by (sheet_id, roll_no) — NOT roll_id — because the
        # admin sheet PUT deletes + reinserts rolls (new ids); roll_no is the
        # stable user-facing identity within a sheet, exactly like the quality
        # carry-over. roll_id is a snapshot used only for the ticket number.
        # defects is a JSONB list of rows; points/grade are recomputed
        # SERVER-SIDE on save/submit (client values are display-only).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_inspection_tickets (
                id               SERIAL PRIMARY KEY,
                sheet_id         INTEGER NOT NULL,
                po_id            BIGINT,
                roll_no          INTEGER NOT NULL,
                roll_id          INTEGER,
                version          INTEGER NOT NULL DEFAULT 1,
                ticket_no        TEXT,
                status           TEXT NOT NULL DEFAULT 'Draft',
                style_article    TEXT,
                construction     TEXT,
                color            TEXT,
                lot_batch        TEXT,
                buyer            TEXT,
                yards_inspected  NUMERIC,
                width_inches     NUMERIC,
                inspector_name   TEXT,
                inspection_date  DATE,
                face_back        TEXT,
                defects          JSONB,
                acceptable_limit NUMERIC NOT NULL DEFAULT 40,
                remarks          TEXT,
                discrepancy_note TEXT,
                total_points     NUMERIC,
                points_per_100   NUMERIC,
                grade            TEXT,
                submitted_by     TEXT,
                submitted_at     TIMESTAMPTZ,
                approved_by      TEXT,
                approved_at      TIMESTAMPTZ,
                created_by       TEXT,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at       TIMESTAMPTZ
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_insp_sheet_roll "
                    "ON fabric_inspection_tickets(sheet_id, roll_no)")
        # Inspector-entered after-wash width (cm) stored directly on the ticket.
        # Distinct from fabric_receiving_rolls.after_wash_width_cm (set by the
        # width_edit grantee on the receiving sheet); this column captures the
        # QC inspector's own post-wash measurement taken during inspection.
        cur.execute("ALTER TABLE fabric_inspection_tickets "
                    "ADD COLUMN IF NOT EXISTS after_wash_width_cm NUMERIC")
        # Score-width source: the receiving sheet's width_measured_m (metres,
        # auto-converted to inches) feeds the 4-Point score; manual_width_cm
        # is the inspector's fallback used ONLY when the sheet width is blank.
        # width_source records which one fed width_inches ('sheet'|'manual').
        cur.execute("ALTER TABLE fabric_inspection_tickets "
                    "ADD COLUMN IF NOT EXISTS manual_width_cm NUMERIC")
        cur.execute("ALTER TABLE fabric_inspection_tickets "
                    "ADD COLUMN IF NOT EXISTS width_source TEXT")
        # Cuttable (usable) width in cm — the ASTM/industry 4-Point standard
        # scores on usable width, not full width. When the inspector fills it,
        # it takes PRIORITY over the sheet/manual width for the score
        # (width_source='cuttable'); sheet/manual stay the fallback.
        cur.execute("ALTER TABLE fabric_inspection_tickets "
                    "ADD COLUMN IF NOT EXISTS cuttable_width_cm NUMERIC")
        # One-time markers for receiving data migrations (idempotent — prod is
        # a separate DB and picks these up on first touch after publish).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_recv_migrations (
                key TEXT PRIMARY KEY,
                at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
    conn.commit()
    _migrate_recv_one_sheet_per_po(conn)
    _migrate_recv_fix_false_barcodes(conn)
    _migrate_insp_score_width_from_sheet(conn)
    _RECEIVING_TABLES_READY = True

def _migrate_recv_one_sheet_per_po(conn):
    """One-time legacy migration guaranteeing 1 PO = 1 Sheet#:
      * every PO-linked receiving section gets a fabric_receiving_po_sheets
        parent row (the PO's single Sheet#) and po_sheet_id set;
      * legacy POs whose fabric was split across several sections (the old
        per-delivery model) are MERGED into one section per (po, fabric) —
        rolls (quality travels ON the roll rows) and audit refs move to the
        kept section, notes are concatenated, totals recomputed;
      * all PO-linked rolls are RENUMBERED 1..n per (po, fabric) in original
        receipt order (roll id order = insertion order across days).
    Runs ONCE (marker row), whole thing in one transaction under an advisory
    lock so concurrent workers can't interleave. Idempotent by construction."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("one_sheet_per_po_v1",))
        if cur.fetchone():
            return
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('fabric_recv_migrate'))")
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("one_sheet_per_po_v1",))
        if cur.fetchone():  # another worker won the race
            conn.commit()
            return
        # 1) Merge duplicate sections per (po, fabric): keep the OLDEST
        #    (lowest id) section, move rolls + audit refs onto it, merge notes.
        cur.execute("""
            SELECT po_id, product_id,
                   (array_agg(id ORDER BY id))[1]  as keep_id,
                   array_agg(id ORDER BY id)       as all_ids,
                   string_agg(NULLIF(BTRIM(note), ''), ' | ' ORDER BY id) as notes
            FROM fabric_receiving_sheets
            WHERE po_id IS NOT NULL
            GROUP BY po_id, product_id
            HAVING COUNT(*) > 1
        """)
        merged_pos = set()
        merged_sheet_ids = []
        for po_id, _product_id, keep_id, all_ids, notes in cur.fetchall():
            dupes = [i for i in all_ids if i != keep_id]
            cur.execute("UPDATE fabric_receiving_rolls SET sheet_id=%s "
                        "WHERE sheet_id = ANY(%s)", (keep_id, dupes))
            cur.execute("UPDATE fabric_recv_audit SET sheet_id=%s "
                        "WHERE sheet_id = ANY(%s)", (keep_id, dupes))
            cur.execute("UPDATE fabric_receiving_sheets SET note=%s "
                        "WHERE id=%s", (notes, keep_id))
            cur.execute("DELETE FROM fabric_receiving_sheets "
                        "WHERE id = ANY(%s)", (dupes,))
            merged_pos.add(po_id)
            merged_sheet_ids.append(keep_id)
        # 2) Ensure every PO with sections has its single PO sheet row, and
        #    link every PO-linked section to it.
        cur.execute("""
            INSERT INTO fabric_receiving_po_sheets
                   (po_id, po_name, po_date, created_by_name, created_at)
            SELECT s.po_id, MAX(s.po_name), MAX(s.po_date),
                   MAX(s.created_by_name), MIN(s.created_at)
            FROM fabric_receiving_sheets s
            WHERE s.po_id IS NOT NULL
            GROUP BY s.po_id
            ON CONFLICT (po_id) DO NOTHING
        """)
        cur.execute("""
            UPDATE fabric_receiving_sheets s
               SET po_sheet_id = ps.id
              FROM fabric_receiving_po_sheets ps
             WHERE ps.po_id = s.po_id
               AND s.po_id IS NOT NULL
               AND (s.po_sheet_id IS DISTINCT FROM ps.id)
        """)
        # 3) Renumber ALL PO-linked rolls 1..n per (po, fabric) in receipt
        #    order. Quality lives on these same rows, so it carries over —
        #    nothing is rewritten, only roll_no updates in place.
        cur.execute("""
            WITH nn AS (
                SELECT r.id,
                       ROW_NUMBER() OVER (
                           PARTITION BY s.po_id, s.product_id
                           ORDER BY r.id) as rn
                FROM fabric_receiving_rolls r
                JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
                WHERE s.po_id IS NOT NULL
            )
            UPDATE fabric_receiving_rolls r
               SET roll_no = nn.rn
              FROM nn
             WHERE r.id = nn.id AND r.roll_no <> nn.rn
        """)
        renumbered = cur.rowcount
        # Audit the migration on each merged PO (who/what/when trail).
        for po_id in sorted(merged_pos):
            _recv_audit(cur, po_id, None, None, "sheets_merged",
                        {"note": "legacy multi-sheet PO merged into one "
                                 "PO sheet; rolls renumbered per fabric"},
                        "system (migration)")
        cur.execute("INSERT INTO fabric_recv_migrations (key) VALUES (%s) "
                    "ON CONFLICT (key) DO NOTHING", ("one_sheet_per_po_v1",))
    conn.commit()
    # Recompute totals on the merged (kept) sections outside the tx above —
    # helper commits per sheet via the same connection.
    for sid in merged_sheet_ids:
        _recv_refresh_sheet_totals(conn, sid, "system (migration)")
    if merged_sheet_ids or renumbered:
        conn.commit()


def _migrate_recv_fix_false_barcodes(conn):
    """One-time patch: Odoo's XML-RPC returns the boolean False for an unset
    barcode field; older extracts stored that as the literal text 'false'
    before the `or None` normalisation was added.  This migration NULLs them
    so the UI never shows the word "false" as a barcode value.
    Idempotent via the fabric_recv_migrations marker table."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("fix_false_barcodes_v1",))
        if cur.fetchone():
            return
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('fabric_recv_migrate'))")
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("fix_false_barcodes_v1",))
        if cur.fetchone():
            conn.commit()
            return
        cur.execute("""
            UPDATE fabric_receiving_sheets
               SET barcode = NULL
             WHERE LOWER(barcode) = 'false'
        """)
        cur.execute("INSERT INTO fabric_recv_migrations(key) VALUES (%s)",
                    ("fix_false_barcodes_v1",))
    conn.commit()


def _migrate_insp_score_width_from_sheet(conn):
    """One-time recalculation of ALL 4-Point inspection tickets (any status,
    incl. Submitted/Approved): the score width now comes from the roll's
    receiving-sheet width (width_measured_m, metres → inches) instead of the
    inspector-typed after-wash width. Tickets whose roll has no sheet width
    (and no manual fallback — none exist historically) get a BLANK score and
    grade. after_wash_width_cm columns stay untouched (shrinkage-only now).
    Idempotent via the fabric_recv_migrations marker table."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("insp_score_width_from_sheet_v1",))
        if cur.fetchone():
            return
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('fabric_recv_migrate'))")
        cur.execute("SELECT 1 FROM fabric_recv_migrations WHERE key=%s",
                    ("insp_score_width_from_sheet_v1",))
        if cur.fetchone():
            conn.commit()
            return
        # Tickets join their roll on (sheet_id, roll_no) — the stable identity
        # (admin sheet edits delete + reinsert rolls with new ids).
        cur.execute("""
            WITH w AS (
                SELECT t.id AS ticket_id,
                       (SELECT r.width_measured_m
                          FROM fabric_receiving_rolls r
                         WHERE r.sheet_id = t.sheet_id
                           AND r.roll_no = t.roll_no
                           AND r.deleted_at IS NULL
                         ORDER BY r.id DESC LIMIT 1) AS width_m,
                       t.total_points, t.yards_inspected,
                       COALESCE(t.acceptable_limit, 40) AS lim
                FROM fabric_inspection_tickets t
            ), calc AS (
                SELECT ticket_id,
                       CASE WHEN width_m IS NOT NULL AND width_m > 0
                            THEN ROUND((width_m / 0.0254)::numeric, 1) END
                           AS new_w,
                       total_points, yards_inspected, lim
                FROM w
            ), scored AS (
                SELECT ticket_id, new_w,
                       CASE WHEN new_w > 0 AND yards_inspected > 0
                                 AND total_points IS NOT NULL
                            THEN ROUND((total_points * 3600.0
                                        / (new_w * yards_inspected))::numeric, 2)
                       END AS pp, lim
                FROM calc
            )
            UPDATE fabric_inspection_tickets t
               SET width_inches   = s.new_w,
                   width_source   = CASE WHEN s.new_w IS NOT NULL
                                         THEN 'sheet' END,
                   points_per_100 = s.pp,
                   grade          = CASE WHEN s.pp IS NULL THEN NULL
                                         WHEN s.pp <= s.lim THEN 'Pass'
                                         ELSE 'Reject' END,
                   updated_at     = now()
              FROM scored s
             WHERE t.id = s.ticket_id
               AND (t.width_inches   IS DISTINCT FROM s.new_w
                 OR t.points_per_100 IS DISTINCT FROM s.pp)
        """)
        n = cur.rowcount
        cur.execute("INSERT INTO fabric_recv_migrations(key) VALUES (%s)",
                    ("insp_score_width_from_sheet_v1",))
        import logging
        logging.getLogger(__name__).info(
            "inspection score-width migration: recalculated %s tickets", n)
    conn.commit()


# Allowed per-roll quality statuses (NULL/'' = not yet inspected → treated as
# Pending in the UI). Kept small + explicit; validated server-side.
_RECV_QUALITY_STATUSES = ("Pass", "Fail", "Pending")

# Structured per-roll quality measurement fields (task: replace free-text-only
# quality with structured numbers + the existing status/notes).
_RECV_MEAS_NUM = ("length_yards", "shrinkage_inches", "width_measured_m",
                  "after_wash_width_cm", "after_wash_length_cm")

# The QC shrinkage gauge square is fixed at 35cm x 35cm (task-mandated, no
# configuration UI). shrink_cm = 35 - entered_cm; negative = fabric grew.
_RECV_SHRINK_GAUGE_CM = 35.0

def _recv_shrink_txt(after_wash_cm):
    """'0.59 in (4.3%)' derived from a raw after-wash cm measurement, or None.
    Negative values (fabric grew) render with their sign."""
    if after_wash_cm in (None, ""):
        return None
    try:
        cm = _RECV_SHRINK_GAUGE_CM - float(after_wash_cm)
    except (TypeError, ValueError):
        return None
    inches = cm / 2.54
    pct = cm / _RECV_SHRINK_GAUGE_CM * 100.0
    return f"{inches:.2f} in ({pct:.1f}%)"

def _recv_parse_measurements(it):
    """Validate the 4 structured quality fields out of one rolls[] entry.
    Numbers must be >= 0 (blank/None clears); bleeding_test is short text."""
    meas = {}
    for k in _RECV_MEAS_NUM:
        v = it.get(k)
        if v in (None, ""):
            meas[k] = None
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail=f"{k} must be a number")
        if f < 0:
            raise HTTPException(status_code=400,
                                detail=f"{k} cannot be negative")
        meas[k] = round(f, 3)
    bt = str(it.get("bleeding_test") or "").strip() or None
    if bt is not None and len(bt) > 120:
        raise HTTPException(status_code=400,
                            detail="bleeding_test must be 120 characters or fewer")
    meas["bleeding_test"] = bt
    return meas

def _recv_meas_changed(old_row, meas):
    """True when any structured measurement differs from the stored row."""
    for k in _RECV_MEAS_NUM:
        ov = old_row.get(k)
        ov = round(float(ov), 3) if ov not in (None, "") else None
        if ov != meas.get(k):
            return True
    return (old_row.get("bleeding_test") or None) != meas.get("bleeding_test")

def _recv_quality_summary(rolls):
    """Roll up the per-roll quality of a sheet into counts for the printed
    summary box: total rolls, how many Pass/Fail/Pending, and how many are
    still uninspected (NULL/'' status)."""
    total = len(rolls)
    counts = {"Pass": 0, "Fail": 0, "Pending": 0}
    inspected = 0
    for r in rolls:
        st = (r.get("quality_status") or "").strip()
        if st in counts:
            counts[st] += 1
            if st in ("Pass", "Fail"):
                inspected += 1
    return {
        "rolls": total,
        "pass": counts["Pass"],
        "fail": counts["Fail"],
        "pending": counts["Pending"] + (total - inspected - counts["Pending"]),
        "inspected": inspected,
    }

# The full product-info block the printed sheet header needs (same fields the
# Buying sheet uses). Anchored on the product master — NO stock requirement,
# because a delivery being received often has zero current Odoo stock.
_RECV_PRODUCT_SQL = """
    SELECT
      p.id, p.name, p.default_code, p.barcode,
      p.fabric_category, p.fabric_subcategory, p.fiber_content,
      p.gsm, p.width_m, p.kg_per_mtr_eff as kg_per_mtr,
      p.source_city, p.source_country, p.supplier_fabric_code,
      NULLIF(BTRIM(p.fabric_supplier_name),'') as fabric_supplier_name,
      NULLIF(BTRIM(p.odoo_fabric_color),'')    as odoo_fabric_color,
      ROUND(CASE WHEN p.kg_per_mtr_eff>0
            THEN p.standard_price*p.kg_per_mtr_eff ELSE NULL END::numeric,2)
        as cost_metre
    FROM raw_fabric_products p
"""

def _recv_product_info(conn, product_id):
    rows = q(conn, _RECV_PRODUCT_SQL + " WHERE p.id=%s", (product_id,))
    return rows[0] if rows else None

@fabric_router.get("/api/fabric/receiving/product-search")
def receiving_product_search(q_: str = Query(default="", alias="q"),
                             limit: int = Query(default=20)):
    """Fabric picker for the Receiving tab: searches the register (product
    master) by name / internal code / barcode WITHOUT a stock-on-hand filter,
    since newly arriving fabric may have no Odoo stock yet. Returns the full
    product-info block so the picked row can drive the sheet header directly."""
    term = (q_ or "").strip()
    limit = max(1, min(int(limit or 20), 50))
    with _get_conn() as conn:
        where = "p.category = 'Fabric'"
        params = []
        if term:
            where += " AND (p.name ILIKE %s OR p.default_code ILIKE %s OR p.barcode ILIKE %s)"
            like = f"%{term}%"
            params = [like, like, like]
        rows = q(conn, _RECV_PRODUCT_SQL +
                 f" WHERE {where} ORDER BY p.name LIMIT %s",
                 params + [limit])
    return rows

def _recv_parse_rolls(body):
    """Validate + normalize the rolls payload: 1..50 rows, each with a whole
    roll number > 0 and a kg weight > 0. Raises 400 with a specific message."""
    rolls_in = body.get("rolls")
    if not isinstance(rolls_in, list) or not rolls_in:
        raise HTTPException(status_code=400, detail="rolls list is required")
    if len(rolls_in) > 50:
        raise HTTPException(status_code=400, detail="a sheet holds at most 50 rolls")
    rolls = []
    seen = set()
    for i, r in enumerate(rolls_in, start=1):
        if not isinstance(r, dict):
            raise HTTPException(status_code=400, detail=f"roll {i}: invalid entry")
        try:
            roll_no = int(r.get("roll_no"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail=f"roll {i}: roll number must be a whole number")
        if roll_no <= 0:
            raise HTTPException(status_code=400,
                detail=f"roll {i}: roll number must be greater than zero")
        if roll_no in seen:
            raise HTTPException(status_code=400,
                detail=f"roll number {roll_no} is used more than once — "
                       "each roll must have a unique number")
        seen.add(roll_no)
        try:
            qty_kg = float(r.get("qty_kg"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail=f"roll {i}: kgs must be a number")
        if not (qty_kg > 0):
            raise HTTPException(status_code=400,
                detail=f"roll {i}: kgs must be greater than zero")
        rolls.append((roll_no, round(qty_kg, 3)))
    return rolls

@fabric_router.post("/api/fabric/receiving")
def receiving_create(request: Request, body: dict = Body(...)):
    """Save a receiving sheet: the picked fabric + its roll weights. Metres are
    derived server-side from the product's CURRENT kg_per_mtr_eff and the factor
    is snapshotted on the sheet; a missing conversion stores NULL metres and is
    flagged in the response (missing_conversion) — never a silent zero."""
    product_id = body.get("product_id")
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id is required")
    note = str(body.get("note") or "").strip() or None
    rolls = _recv_parse_rolls(body)
    # MANDATORY draft-PO link: every NEW sheet must be saved against a draft
    # Odoo purchase order (re-validated LIVE — must still exist and still be
    # draft); its name/creation date are snapshotted onto the sheet. Legacy
    # PO-less sheets remain readable/editable, only creation requires a PO.
    if body.get("po_id") in (None, "", 0, "0"):
        raise HTTPException(status_code=400,
            detail="A purchase order is required — pick the draft PO this "
                   "delivery belongs to before saving the sheet")
    try:
        po_id_in = int(body.get("po_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="po_id must be a number")
    # Route through the ONE-sheet-per-PO append path (client-supplied roll
    # numbers are ignored — the server assigns them). This endpoint can never
    # create a second sheet for the same PO: it creates/reopens the PO sheet
    # and appends into the product's section, exactly like the new endpoint.
    res = receiving_po_sheet_add_rolls(po_id_in, request, {
        "product_id": product_id,
        "rolls": [{"qty_kg": kg} for _no, kg in rolls],
        "note": note,
    })
    return {"ok": True, "id": res["sheet_id"],
            "roll_nos": res.get("roll_nos"),
            "missing_conversion": res.get("missing_conversion")}

# ── One-sheet-per-PO receiving: auto roll numbers, lock-after-upload, audit ──
# Each Odoo PO has exactly ONE receiving sheet (fabric_receiving_po_sheets,
# UNIQUE po_id) holding one SECTION per product (fabric_receiving_sheets rows
# linked via po_sheet_id): rolls append into their product's section across
# multi-day deliveries with roll numbers ASSIGNED BY THE SERVER (progressive per
# product per PO, concurrency-safe via an advisory lock — never duplicated).
# Once the PO has been SUCCESSFULLY uploaded to Odoo the rolls/quantities lock
# for non-admins (quality stays open to everyone); admin corrections after the
# lock are allowed and every add/edit/delete is written to fabric_recv_audit
# (who / what / when), shown on the PO sheet.

# Users with FULL fabric receiving admin rights (post-upload edit/delete):
# the admin ROLE plus an explicit per-email allowance for the fabric team
# leads. Mirrors the roster-editor email-allowlist pattern used elsewhere.
_FABRIC_ADMIN_EMAILS = {"admin@vivofashiongroup.com",
                        "bedan@vivofashiongroup.com"}

def _fabric_full_admin(user):
    """True when this user dict has full fabric-receiving admin rights."""
    u = user or {}
    if u.get("role") == "admin":
        return True
    return (u.get("email") or "").strip().lower() in _FABRIC_ADMIN_EMAILS

def _recv_is_admin(request):
    return _fabric_full_admin(getattr(request.state, "user", None))

# Users restricted to QUALITY-ONLY on receiving: they may record per-roll
# quality results but may NOT add/edit/delete rolls or sheets. Enforced
# server-side in every receiving write endpoint; the UI hides the controls.
_RECV_QUALITY_ONLY_EMAILS = {"costing@vivofashiongroup.com"}

def _fabric_field_grants_for_user(user_id):
    """Return the set of active field_names granted to this user_id.
    Empty set when the user has no grants or on any DB error."""
    if not user_id:
        return set()
    try:
        with _get_conn() as conn:
            rows = q(conn, """
                SELECT field_name FROM fabric_field_grants
                WHERE user_id = %s AND revoked_at IS NULL
            """, (user_id,))
            return {r["field_name"] for r in rows}
    except Exception:
        return set()


def _recv_can_edit_width(request):
    """True when this user may write width_measured_m / after_wash_width_cm
    on a roll: either a full admin, OR the user has an active width_edit
    grant in fabric_field_grants."""
    u = getattr(request.state, "user", None) or {}
    if _fabric_full_admin(u):
        return True
    user_id = str(u.get("user_id") or "")
    return "width_edit" in _fabric_field_grants_for_user(user_id)


def _recv_can_roll_no_edit(request):
    """True when this user may renumber rolls on a sheet: either a full
    admin, OR the user has an active roll_no_edit grant."""
    u = getattr(request.state, "user", None) or {}
    if _fabric_full_admin(u):
        return True
    user_id = str(u.get("user_id") or "")
    return "roll_no_edit" in _fabric_field_grants_for_user(user_id)

def _recv_quality_only(request):
    """True when this user is restricted to quality-only receiving edits.
    A full fabric admin is never quality-only (admin wins)."""
    u = getattr(request.state, "user", None) or {}
    if _fabric_full_admin(u):
        return False
    return (u.get("email") or "").strip().lower() in _RECV_QUALITY_ONLY_EMAILS

# The one user allowed to write invoiced quantities and set the credit /
# back-order delivery status flag. Strictly email-gated (not role-based)
# so the privilege is narrow and explicit.
_INVOICE_EMAIL = "bedan@vivofashiongroup.com"

# Users allowed to type measured widths directly into the Receiving table's
# Width (CM) column (inline edit path). Strictly email-gated like the
# invoice fields — narrow and explicit, independent of the width_edit
# grant system used by the inspection form.
_INLINE_WIDTH_EMAILS = {"bedan@vivofashiongroup.com",
                        "hagai@vivofashiongroup.com"}

def _recv_can_inline_width(request):
    """True when the signed-in user may edit measured width inline on the
    Receiving table (bedan@ and hagai@ only)."""
    u = getattr(request.state, "user", None) or {}
    return (u.get("email") or "").strip().lower() in _INLINE_WIDTH_EMAILS

def _recv_block_non_inline_width(request):
    """403 any inline width write from a user outside the allowlist."""
    if not _recv_can_inline_width(request):
        raise HTTPException(status_code=403,
            detail="Only bedan@vivofashiongroup.com and "
                   "hagai@vivofashiongroup.com may edit widths inline "
                   "on the Receiving table")

def _recv_is_bedan(request):
    """True when the signed-in user is bedan@vivofashiongroup.com (the only
    person authorised to enter invoiced quantities and toggle the
    Credit Note / Back Order delivery flag)."""
    u = getattr(request.state, "user", None) or {}
    return (u.get("email") or "").strip().lower() == _INVOICE_EMAIL

def _recv_block_non_bedan_invoice(request):
    """403 any invoice-quantity or invoice-status write from a non-bedan user."""
    if not _recv_is_bedan(request):
        raise HTTPException(status_code=403,
            detail="Only bedan@vivofashiongroup.com may enter invoiced "
                   "quantities or set the credit / back-order status")

def _recv_block_quality_only(request):
    """403 any roll/sheet write from a quality-only user."""
    if _recv_quality_only(request):
        raise HTTPException(status_code=403,
            detail="Your account is limited to recording QUALITY results on "
                   "receiving sheets — adding, editing or deleting rolls and "
                   "sheets is not allowed")

@fabric_router.get("/api/fabric/receiving/rights")
def receiving_rights(request: Request):
    """Whether the signed-in user has full fabric-receiving admin rights
    (role admin OR the explicit fabric-admin email allowance). The dashboard
    uses this instead of checking role==='admin' client-side so the email
    allowance shows the same controls the server actually permits.
    quality_only marks users who may ONLY record quality results.
    can_approve_delivery: True for fabric_quality_supervisor + admin roles.
    can_edit_width: True for admin or active width_edit grantees.
    can_roll_no_edit: True for admin or active roll_no_edit grantees.
    user_id: the signed-in user's id (for client-side sheet-ownership checks)."""
    u = getattr(request.state, "user", None) or {}
    return {"admin": _recv_is_admin(request),
            "quality_only": _recv_quality_only(request),
            "can_approve_delivery": _insp_can_approve(request),
            "can_edit_width": _recv_can_edit_width(request),
            "can_roll_no_edit": _recv_can_roll_no_edit(request),
            "can_invoice": _recv_is_bedan(request),
            "can_inline_width": _recv_can_inline_width(request),
            "user_id": str(u.get("user_id") or "")}


@fabric_router.post("/api/fabric/receiving/po/{po_id}/approve-delivery")
def approve_delivery(po_id: int, request: Request):
    """Stamp a delivery-level signoff on a PO receiving batch.
    Gated to fabric_quality_supervisor + admin. Validates all rolls have
    at least a non-Pending status (or an approved 4-Point ticket) before
    allowing approval. Writes delivery_approved_by/email/at on the
    fabric_receiving_po_sheets row and a 'delivery_approved' row to
    fabric_recv_audit. Idempotent check: returns 409 if already approved."""
    if not _insp_can_approve(request):
        raise HTTPException(status_code=403,
            detail="Only Fabric Quality Supervisors and admins can approve deliveries")
    u = getattr(request.state, "user", None) or {}
    actor_name  = u.get("name") or u.get("email") or "system"
    actor_email = (u.get("email") or "").strip()
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        # Confirm the PO sheet exists
        ps = q(conn,
               "SELECT id, po_name, delivery_approved_at "
               "FROM fabric_receiving_po_sheets WHERE po_id=%s",
               (po_id,))
        if not ps:
            raise HTTPException(status_code=404,
                detail="No receiving sheet found for this PO")
        sheet = ps[0]
        if sheet.get("delivery_approved_at") is not None:
            raise HTTPException(status_code=409,
                detail="This delivery has already been approved")
        # Check that no rolls still have Pending quality status without an
        # approved 4-Point ticket. A roll counts as reviewed when:
        #   (a) its quality_status is Pass or Fail, OR
        #   (b) it has at least one ticket in Approved status.
        pending_rolls = q(conn, """
            SELECT r.id
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            WHERE s.po_id = %s
              AND r.deleted_at IS NULL
              AND s.deleted_at IS NULL
              AND (r.quality_status IS NULL OR r.quality_status = '' OR r.quality_status = 'Pending')
              AND NOT EXISTS (
                  SELECT 1 FROM fabric_inspection_tickets t
                  WHERE t.sheet_id = r.sheet_id
                    AND t.roll_no  = r.roll_no
                    AND t.status   = 'Approved'
              )
        """, (po_id,))
        if pending_rolls:
            raise HTTPException(status_code=422,
                detail=f"{len(pending_rolls)} roll(s) still have a Pending quality "
                       "status and no approved 4-Point inspection ticket. "
                       "Complete or approve all inspections before signing off the delivery.")
        # Lot-level (delivery average) 4-Point summary per fabric sheet —
        # surfaced in the signoff response and frozen into the audit trail.
        lot_sheets = q(conn, """
            SELECT s.id, COALESCE(NULLIF(BTRIM(p.name),''), s.fabric_name)
                       AS fabric_name
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE s.po_id = %s AND s.deleted_at IS NULL
            ORDER BY s.id
        """, (po_id,))
        lot_map = _insp_lot_summaries(conn, [r["id"] for r in lot_sheets])
        lots = []
        for r in lot_sheets:
            lot = lot_map.get(int(r["id"])) or {}
            lots.append({"sheet_id": int(r["id"]),
                         "fabric_name": r.get("fabric_name"),
                         "lot_avg_pp100": lot.get("lot_avg_pp100"),
                         "lot_limit": lot.get("lot_limit",
                                              _INSP_LOT_LIMIT_DEFAULT),
                         "lot_rolls_scored": lot.get("lot_rolls_scored", 0),
                         "lot_pass": lot.get("lot_pass")})
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_po_sheets
                   SET delivery_approved_by       = %s,
                       delivery_approved_by_email = %s,
                       delivery_approved_at       = now()
                 WHERE po_id = %s
            """, (actor_name, actor_email, po_id))
            cur.execute("""
                INSERT INTO fabric_recv_audit
                    (po_id, fabric_name, action, details, actor_name)
                VALUES (%s, NULL, 'delivery_approved',
                        %s::jsonb, %s)
            """, (po_id,
                  json.dumps({"po_name": sheet.get("po_name") or "",
                              "lots": lots}),
                  actor_name))
        conn.commit()
        updated = q(conn,
                    "SELECT delivery_approved_by, delivery_approved_by_email, "
                    "delivery_approved_at FROM fabric_receiving_po_sheets "
                    "WHERE po_id=%s", (po_id,))
        row = updated[0] if updated else {}
        at_fmt = None
        if row.get("delivery_approved_at"):
            try:
                at_fmt = row["delivery_approved_at"].astimezone(
                    ZoneInfo("Africa/Nairobi")).strftime("%d %b %Y, %H:%M")
            except Exception:
                at_fmt = str(row["delivery_approved_at"])[:16]
        return {
            "approved": True,
            "delivery_approved_by":       row.get("delivery_approved_by"),
            "delivery_approved_by_email": row.get("delivery_approved_by_email"),
            "delivery_approved_at":       at_fmt,
            "lots":                       lots,
        }

# ── 4-Point fabric inspection tickets ───────────────────────────────────────
# Digital 4-Point (American system) inspection ticket per receiving roll.
# Anyone signed in may inspect (it is quality work — quality-only users
# included). Supervisor APPROVAL is restricted server-side to full fabric
# admins plus an explicit allow-list. Tickets are keyed by (sheet_id,
# roll_no) so they survive the admin sheet rewrite (new roll ids).

def _insp_can_approve(request):
    """True when the signed-in user may approve inspection tickets and sign off
    deliveries. Strictly role-based — admin OR fabric_quality_supervisor.
    Does NOT inherit the email-allowance path of _fabric_full_admin so that
    fabric-receiving admin (add/edit/delete rolls) and QC approval authority
    remain separate. Managed exclusively through the Users panel."""
    u = getattr(request.state, "user", None) or {}
    return (u.get("role") or "").strip().lower() in ("admin", "fabric_quality_supervisor")

# 4-point rule: points per defect from its measured length in inches.
# <= 3in = 1pt, 3–6 = 2, 6–9 = 3, > 9in = 4. Holes split by size per the
# ASTM D5430 convention: <= 1in = 2 pts, > 1in OR unsized = 4 pts
# (conservative when no size is entered). Max 4 pts/defect.
def _insp_defect_points(size_in, is_hole):
    if is_hole:
        try:
            s = float(size_in)
        except (TypeError, ValueError):
            s = None
        return 2 if (s is not None and s <= 1) else 4
    try:
        s = float(size_in)
    except (TypeError, ValueError):
        s = 0.0
    if s > 9:
        return 4
    if s > 6:
        return 3
    if s > 3:
        return 2
    return 1

def _insp_run_span(run_yards, location_yd, yards_inspected):
    """Number of whole linear yards a RUNNING defect saturates (>=1), capped
    so the span never extends past the roll's inspected yardage. A running
    defect scores 4 points for EACH yard it crosses."""
    try:
        n = int(math.ceil(float(run_yards)))
    except (TypeError, ValueError):
        n = 1
    n = max(1, n)
    if yards_inspected:
        try:
            total_yds = int(math.ceil(float(yards_inspected)))
        except (TypeError, ValueError):
            total_yds = None
        if total_yds and total_yds > 0:
            if location_yd is not None:
                start = int(math.floor(float(location_yd)))
                n = max(1, min(n, total_yds - min(start, total_yds - 1)))
            else:
                n = max(1, min(n, total_yds))
    return n

_INSP_DEFECT_TYPES = {"Hole", "Slub", "Stain", "Shade variation", "Misweave",
                      "Broken pick", "Knot", "Barre", "Crease", "Dye spot",
                      "Selvage defect", "Snag", "Thick place", "Thin place",
                      "Neps", "Missing yarn", "Broken end",
                      "Double yarn / doubled end", "Loose yarn (slack end)",
                      "Tight yarn", "Yarn contamination (foreign fiber)",
                      "Count variation", "Coarse yarn", "Crossed ends",
                      "Snarls", "Hairiness", "Fuzz balls / pilling",
                      "Uneven twist", "Yarn slippage", "Other"}

def _insp_parse_defects(body):
    """Validate + normalize the defects payload; points are ALWAYS recomputed
    server-side from size + hole flag (4-point caps enforced here)."""
    rows_in = body.get("defects")
    if rows_in in (None, ""):
        rows_in = []
    if not isinstance(rows_in, list):
        raise HTTPException(status_code=400, detail="defects must be a list")
    if len(rows_in) > 200:
        raise HTTPException(status_code=400,
                            detail="at most 200 defect rows per ticket")
    # The roll's inspected yardage caps how far a RUNNING defect can score.
    try:
        yards_inspected = float(body.get("yards_inspected"))
        if yards_inspected <= 0:
            yards_inspected = None
    except (TypeError, ValueError):
        yards_inspected = None
    out = []
    for i, r in enumerate(rows_in, start=1):
        if not isinstance(r, dict):
            raise HTTPException(status_code=400,
                                detail=f"defect {i}: invalid entry")
        dtype = str(r.get("defect_type") or "").strip()[:60] or "Other"
        side = str(r.get("side") or "").strip()[:10]
        if side not in ("", "Face", "Back"):
            side = ""
        try:
            loc = float(r.get("location_yd")) if r.get("location_yd") not in (None, "") else None
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail=f"defect {i}: location (yd) must be a number")
        size_v = r.get("size_in")
        if size_v in (None, ""):
            size = None
        else:
            try:
                size = float(size_v)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400,
                    detail=f"defect {i}: size (inches) must be a number")
            if size < 0:
                raise HTTPException(status_code=400,
                    detail=f"defect {i}: size cannot be negative")
        is_hole = dtype.lower() == "hole" or bool(r.get("is_hole"))
        is_running = bool(r.get("is_running"))
        selvedge = bool(r.get("selvedge"))
        run_yards = None
        if is_running:
            rv = r.get("run_yards")
            if rv not in (None, ""):
                try:
                    run_yards = float(rv)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400,
                        detail=f"defect {i}: yards run must be a number")
                if run_yards < 0:
                    raise HTTPException(status_code=400,
                        detail=f"defect {i}: yards run cannot be negative")
        if selvedge:
            # Selvedge/uncuttable-zone defect: logged for the record but
            # EXCLUDED from the point total (zone is outside cuttable width).
            pts = 0
        elif is_running:
            pts = 4 * _insp_run_span(run_yards, loc, yards_inspected)
        else:
            pts = _insp_defect_points(size, is_hole)
        out.append({"location_yd": loc, "defect_type": dtype,
                    "size_in": size, "side": side, "points": pts,
                    "is_running": is_running,
                    "run_yards": run_yards, "selvedge": selvedge})
    return out, _insp_total_points(out, yards_inspected)

def _insp_total_points(defect_rows, yards_inspected=None):
    """Total penalty points with the 4-Point standard's max-4-points-per-
    linear-yard cap: defects sharing the same linear yard (floor(location_yd))
    contribute at most 4 points together. Defects WITHOUT a location keep
    plain per-defect scoring (no cap can be applied without a position).
    Selvedge-flagged rows carry 0 points (excluded). RUNNING defects
    saturate (4 pts) each linear yard they cross, capped at the inspected
    yardage; without a location their full run total is added directly."""
    per_yard, total = {}, 0
    for d in defect_rows:
        if d.get("selvedge"):
            continue
        loc = d.get("location_yd")
        if d.get("is_running"):
            n = _insp_run_span(d.get("run_yards"), loc, yards_inspected)
            if loc is None:
                total += 4 * n
            else:
                start = int(math.floor(float(loc)))
                for yd in range(start, start + n):
                    per_yard[yd] = per_yard.get(yd, 0) + 4
            continue
        pts = int(d.get("points") or 0)
        if loc is None:
            total += pts
        else:
            yd = int(math.floor(float(loc)))
            per_yard[yd] = per_yard.get(yd, 0) + pts
    total += sum(min(v, 4) for v in per_yard.values())
    return total

def _insp_num(v, name, required=False):
    if v in (None, ""):
        if required:
            raise HTTPException(status_code=400, detail=f"{name} is required")
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be a number")
    if f < 0:
        raise HTTPException(status_code=400, detail=f"{name} cannot be negative")
    return f

# Default LOT (delivery-average) acceptance limit: average pts/100 sq.yd
# across a receiving sheet's submitted tickets. Configurable per sheet via
# fabric_receiving_sheets.lot_acceptable_limit (NULL = this default).
_INSP_LOT_LIMIT_DEFAULT = 20.0

def _insp_lot_summaries(conn, sheet_ids):
    """Lot-level 4-Point summary per receiving sheet: the average pts/100
    sq.yd over the LATEST Submitted ticket of each roll, the sheet's lot
    limit (default 20) and the lot Pass/Fail. Returns {sheet_id: {...}} for
    every requested sheet (sheets with no scored tickets get lot_avg None)."""
    ids = [int(s) for s in sheet_ids]
    if not ids:
        return {}
    rows = q(conn, """
        WITH latest AS (
            SELECT DISTINCT ON (t.sheet_id, t.roll_no)
                   t.sheet_id, t.points_per_100
            FROM fabric_inspection_tickets t
            WHERE t.sheet_id = ANY(%s) AND t.status = 'Submitted'
            ORDER BY t.sheet_id, t.roll_no, t.version DESC, t.id DESC
        )
        SELECT s.id AS sheet_id, s.lot_acceptable_limit,
               COUNT(l.points_per_100)      AS rolls_scored,
               AVG(l.points_per_100)        AS avg_pp100
        FROM fabric_receiving_sheets s
        LEFT JOIN latest l ON l.sheet_id = s.id
                          AND l.points_per_100 IS NOT NULL
        WHERE s.id = ANY(%s)
        GROUP BY s.id, s.lot_acceptable_limit
    """, (ids, ids))
    out = {}
    for r in rows:
        lim = (float(r["lot_acceptable_limit"])
               if r.get("lot_acceptable_limit") not in (None, "")
               else _INSP_LOT_LIMIT_DEFAULT)
        avg = (round(float(r["avg_pp100"]), 2)
               if r.get("avg_pp100") is not None else None)
        out[int(r["sheet_id"])] = {
            "lot_avg_pp100": avg,
            "lot_limit": lim,
            "lot_rolls_scored": int(r.get("rolls_scored") or 0),
            "lot_pass": (avg <= lim) if avg is not None else None,
        }
    return out

@fabric_router.post("/api/fabric/receiving/{sheet_id}/lot-limit")
def receiving_set_lot_limit(sheet_id: int, request: Request,
                            body: dict = Body(...)):
    """Set (or reset) the lot acceptance limit for one receiving sheet.
    Gated to QC supervisors + admins; blank/null resets to the default
    (20 pts/100 sq.yd). Audited."""
    if not _insp_can_approve(request):
        raise HTTPException(status_code=403,
            detail="Only the QC supervisor or a fabric admin may change the "
                   "lot acceptance limit")
    lim = _insp_num(body.get("lot_limit"), "lot limit")
    if lim is not None and lim <= 0:
        raise HTTPException(status_code=400,
                            detail="lot limit must be greater than zero")
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, "SELECT id, po_id, fabric_name, lot_acceptable_limit "
                       "FROM fabric_receiving_sheets "
                       "WHERE id=%s AND deleted_at IS NULL", (sheet_id,))
        if not rows:
            raise HTTPException(status_code=404,
                                detail="receiving sheet not found")
        sh = rows[0]
        with conn.cursor() as cur:
            cur.execute("UPDATE fabric_receiving_sheets "
                        "SET lot_acceptable_limit=%s WHERE id=%s",
                        (lim, sheet_id))
            _recv_audit(cur, sh.get("po_id"), sheet_id, sh.get("fabric_name"),
                        "lot_limit_updated",
                        {"old": (float(sh["lot_acceptable_limit"])
                                 if sh.get("lot_acceptable_limit") is not None
                                 else None),
                         "new": lim,
                         "effective": lim if lim is not None
                                      else _INSP_LOT_LIMIT_DEFAULT}, name)
        conn.commit()
        lot = _insp_lot_summaries(conn, [sheet_id]).get(int(sheet_id))
    return {"ok": True, "lot": lot}

def _insp_score(total_points, width_in, yards):
    """Points per 100 sq.yd = points × 3600 ÷ (width_in × yards). None when
    width/yards are missing or zero (score not computable yet)."""
    if not width_in or not yards or width_in <= 0 or yards <= 0:
        return None
    return round(float(total_points) * 3600.0 / (float(width_in) * float(yards)), 2)

def _insp_enforce_source_width(ctx, fields):
    """Resolve the SCORE width server-side from the INSPECTOR'S OWN
    measurements only: the CUTTABLE width (cm → inches) takes priority when
    entered — the 4-Point standard scores on usable width — otherwise the
    inspector's manual full width (cm). The receiving sheet's width is shown
    as a reference on the ticket but NEVER feeds the score (the inspection
    measures the roll independently). The after-wash measurements never feed
    the score either (shrinkage-only)."""
    cut = fields.get("cuttable_width_cm")
    if cut and cut > 0:
        fields["width_inches"] = round(float(cut) / 2.54, 1)
        fields["width_source"] = "cuttable"
    elif fields.get("manual_width_cm") and fields["manual_width_cm"] > 0:
        fields["width_inches"] = round(float(fields["manual_width_cm"]) / 2.54, 1)
        fields["width_source"] = "manual"
    else:
        fields["width_inches"] = None
        fields["width_source"] = None
    return fields

def _insp_roll_ctx(conn, roll_id):
    rows = q(conn, """
        SELECT r.id as roll_id, r.sheet_id, r.roll_no, r.qty_kg,
               r.length_yards, r.width_measured_m, r.quality_status,
               r.quality_notes, r.shrinkage_inches, r.bleeding_test,
               r.after_wash_width_cm, r.after_wash_length_cm,
               s.po_id, s.po_name, s.product_id,
               COALESCE(p.name,    s.fabric_name) AS fabric_name,
               COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode)     AS barcode
        FROM fabric_receiving_rolls r
        JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
        LEFT JOIN raw_fabric_products p ON p.id = s.product_id
        WHERE r.id=%s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
    """, (roll_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="roll not found")
    return rows[0]

_INSP_TEXT_FIELDS = ("color", "inspector_name", "face_back", "remarks",
                     "discrepancy_note")

def _insp_collect_fields(body):
    """The fillable ticket fields out of a save/submit payload, validated."""
    f = {}
    for k in _INSP_TEXT_FIELDS:
        v = str(body.get(k) or "").strip()
        if len(v) > (2000 if k in ("remarks", "discrepancy_note") else 200):
            raise HTTPException(status_code=400, detail=f"{k} is too long")
        f[k] = v or None
    if f["face_back"] not in (None, "Face", "Back", "Both"):
        raise HTTPException(status_code=400,
                            detail="face_back must be Face, Back or Both")
    f["yards_inspected"] = _insp_num(body.get("yards_inspected"), "yards inspected")
    # After-wash width (cm) is a SHRINKAGE-ONLY measurement (vs the 35 cm
    # gauge square) — it never feeds the score. The score width comes from
    # the inspector's own measurements in _insp_enforce_source_width:
    # cuttable_width_cm (priority) or manual_width_cm (full width).
    f["after_wash_width_cm"] = _insp_num(body.get("after_wash_width_cm"), "after-wash width (cm)")
    f["manual_width_cm"] = _insp_num(body.get("manual_width_cm"), "manual width (cm)")
    f["cuttable_width_cm"] = _insp_num(body.get("cuttable_width_cm"),
                                       "cuttable width (cm)")
    f["width_inches"] = None  # resolved server-side from ctx
    lim = _insp_num(body.get("acceptable_limit"), "acceptable limit")
    f["acceptable_limit"] = lim if lim and lim > 0 else 40
    d = str(body.get("inspection_date") or "").strip()
    if d:
        try:
            datetime.datetime.strptime(d, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400,
                                detail="inspection_date must be YYYY-MM-DD")
    f["inspection_date"] = d or None
    return f

def _insp_ticket_row(t):
    """One ticket dict for the API (dates → text, defects already JSON)."""
    out = dict(t)
    for k in ("submitted_at", "approved_at", "created_at", "updated_at"):
        v = out.get(k)
        out[k] = v.astimezone().strftime("%d %b %Y, %H:%M") if v is not None else None
    v = out.get("inspection_date")
    out["inspection_date"] = v.strftime("%Y-%m-%d") if v is not None else None
    for k in ("yards_inspected", "width_inches", "after_wash_width_cm",
              "manual_width_cm", "cuttable_width_cm",
              "acceptable_limit", "total_points", "points_per_100"):
        if out.get(k) is not None:
            out[k] = float(out[k])
    return out

@fabric_router.get("/api/fabric/receiving/inspection/context")
def inspection_context(request: Request, roll_id: int = Query(...)):
    """Everything the inspection ticket UI needs for one roll: the prefilled
    read-only header (roll + sheet + PO supplier + best-effort Odoo product
    attributes, with a `resolved` map saying which prefills the server could
    fill — unresolved ones stay fillable), the latest ticket (any status) and
    the full version history."""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _insp_roll_ctx(conn, roll_id)
        locked = _recv_po_locked(conn, ctx.get("po_id"))
        prod = _recv_product_info(conn, ctx["product_id"]) or {}
        tickets = q(conn, """
            SELECT * FROM fabric_inspection_tickets
            WHERE sheet_id=%s AND roll_no=%s
            ORDER BY version DESC, id DESC
        """, (ctx["sheet_id"], ctx["roll_no"]))
    # Supplier: live from the Odoo PO header (best-effort — Odoo being down
    # must never block an inspection); fallback to the product master's
    # supplier name.
    supplier, supplier_src = None, None
    if ctx.get("po_id"):
        try:
            po = _recv_read_po(_odoo_connect(), ctx["po_id"], require_draft=False)
            supplier, supplier_src = (po.get("supplier") or None), "odoo_po"
        except Exception:
            supplier = None
    if not supplier and prod.get("fabric_supplier_name"):
        supplier, supplier_src = prod["fabric_supplier_name"], "product_master"
    # Best-effort product attributes: color and construction (fiber content /
    # subcategory) resolve from the product master when present; Style,
    # Lot/Batch and Buyer have no upstream source — always fillable.
    color = prod.get("odoo_fabric_color") or None
    construction = (prod.get("fiber_content") or
                    prod.get("fabric_subcategory") or None)
    # The inspector now enters after_wash_width_cm directly on the inspection
    # form; it is saved on the ticket (not the roll). Pre-fill from the latest
    # ticket when one exists so re-opened tickets show the original measurement.
    # The receiving-roll's after_wash_width_cm is no longer used as the
    # authoritative source for the 4-point score calculation.
    latest_ticket = tickets[0] if tickets else None
    ticket_w_cm = None
    if latest_ticket:
        raw = latest_ticket.get("after_wash_width_cm")
        if raw not in (None, ""):
            try:
                ticket_w_cm = float(raw)
            except (TypeError, ValueError):
                pass
        # Backward-compatible fallback: tickets created before the cm column
        # existed only have width_inches — back-derive cm = in × 2.54 so
        # re-opened old tickets still pre-fill the inspector's original entry.
        if ticket_w_cm is None:
            raw_in = latest_ticket.get("width_inches")
            if raw_in not in (None, ""):
                try:
                    ticket_w_cm = round(float(raw_in) * 2.54, 1)
                except (TypeError, ValueError):
                    pass
    kg = float(ctx["qty_kg"]) if ctx.get("qty_kg") is not None else None
    yards = float(ctx["length_yards"]) if ctx.get("length_yards") not in (None, "") else None
    u = getattr(request.state, "user", None) or {}
    return {
        "roll": {"roll_id": ctx["roll_id"], "sheet_id": ctx["sheet_id"],
                 "roll_no": ctx["roll_no"], "qty_kg": kg,
                 "length_yards": yards,
                 "quality_status": ctx.get("quality_status"),
                 "quality_notes": ctx.get("quality_notes"),
                 "shrinkage_inches": (float(ctx["shrinkage_inches"])
                                      if ctx.get("shrinkage_inches") not in (None, "") else None),
                 "bleeding_test": ctx.get("bleeding_test"),
                 "width_measured_m": (float(ctx["width_measured_m"])
                                      if ctx.get("width_measured_m") not in (None, "") else None),
                 "after_wash_length_cm": (float(ctx["after_wash_length_cm"])
                                          if ctx.get("after_wash_length_cm") not in (None, "") else None),
                 "ticket_after_wash_width_cm": ticket_w_cm},
        "po": {"po_id": ctx.get("po_id"), "po_name": ctx.get("po_name")},
        "fabric": {"name": ctx.get("fabric_name"), "barcode": ctx.get("barcode")},
        "prefill": {"supplier": supplier, "supplier_source": supplier_src,
                    "color": color},
        "resolved": {"supplier": bool(supplier), "color": bool(color),
                     "yards": yards is not None},
        "defaults": {"inspector_name": u.get("name") or u.get("email") or "",
                     "acceptable_limit": 40,
                     "inspection_date": datetime.datetime.now(
                         ZoneInfo("Africa/Nairobi")).strftime("%Y-%m-%d")},
        "can_approve": _insp_can_approve(request),
        "can_edit_rolls": bool(
            (not locked or _fabric_full_admin(u)) and not _recv_quality_only(request)),
        "tickets": [_insp_ticket_row(t) for t in tickets],
    }

_INSP_MEAS_KEYS = _RECV_MEAS_NUM + ("bleeding_test",)

def _insp_apply_measurements(conn, ctx, body, actor):
    """Persist the ticket's Measurements section onto the roll itself (same
    columns the old standalone Quality dialog wrote), so the merged form stays
    the single source. Only fires when the payload carries measurement keys;
    no-op writes are skipped, changes audit as quality_updated. Mutates ctx so
    the ticket's width prefill uses the fresh width_measured_m."""
    if not any(k in body for k in _INSP_MEAS_KEYS + ("quality_notes",)):
        return
    meas = _recv_parse_measurements(body)
    # The inspection ticket no longer collects a separate roll length —
    # preserve the roll's stored length_yards when the payload omits the key
    # (a blank value in an explicit key still clears, matching old behavior).
    if "length_yards" not in body:
        ov = ctx.get("length_yards")
        meas["length_yards"] = round(float(ov), 3) if ov not in (None, "") else None
    # The ticket never carries width_measured_m (the receiving-sheet width is
    # read-only on the inspection form and now feeds the SCORE) — preserve the
    # roll's stored value when the payload omits the key so a ticket save can
    # never wipe the score-width source.
    if "width_measured_m" not in body:
        ov = ctx.get("width_measured_m")
        meas["width_measured_m"] = round(float(ov), 3) if ov not in (None, "") else None
    notes = str(body.get("quality_notes") or "").strip() or None \
        if "quality_notes" in body else (ctx.get("quality_notes") or None)
    if not _recv_meas_changed(ctx, meas) and \
       (ctx.get("quality_notes") or None) == notes:
        return
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE fabric_receiving_rolls
               SET length_yards=%s, shrinkage_inches=%s, width_measured_m=%s,
                   after_wash_length_cm=%s,
                   bleeding_test=%s, quality_notes=%s,
                   quality_updated_at=now(), quality_updated_by=%s
             WHERE id=%s AND deleted_at IS NULL
        """, (meas["length_yards"], meas["shrinkage_inches"],
              meas["width_measured_m"],
              meas["after_wash_length_cm"], meas["bleeding_test"], notes,
              actor, ctx["roll_id"]))
        if cur.rowcount:
            _recv_audit(cur, ctx.get("po_id"), ctx["sheet_id"],
                        ctx.get("fabric_name"), "quality_updated",
                        {"roll_no": ctx.get("roll_no"),
                         "old_status": ctx.get("quality_status"),
                         "new_status": ctx.get("quality_status"),
                         "old_notes": ctx.get("quality_notes"),
                         "new_notes": notes,
                         "via": "inspection_ticket",
                         "measurements": {k: (float(v) if isinstance(v, (int, float)) else v)
                                          for k, v in meas.items()}}, actor)
    for k in _INSP_MEAS_KEYS:
        if k == "after_wash_width_cm":
            continue  # read-only in inspection; preserved from DB context
        ctx[k] = meas[k]
    ctx["quality_notes"] = notes

def _insp_upsert_draft(conn, ctx, fields, defects, total_points, actor,
                       submit, request):
    """Create-or-update the CURRENT draft for a roll (latest version if it is
    a Draft; otherwise a NEW version). Returns the fresh ticket row. When
    submit=True the ticket locks, the roll's quality_status is auto-filled and
    the change is audited."""
    pp100 = _insp_score(total_points, fields.get("width_inches"),
                        fields.get("yards_inspected"))
    limit = fields.get("acceptable_limit") or 40
    grade = None
    if pp100 is not None:
        grade = "Pass" if pp100 <= limit else "Reject"
    if submit:
        if fields.get("yards_inspected") in (None, 0):
            raise HTTPException(status_code=400,
                detail="Total yards inspected is required to submit")
        if fields.get("width_inches") in (None, 0):
            raise HTTPException(status_code=400,
                detail="No width available for scoring — enter the measured "
                       "cuttable width (cm) or a manual full width (cm)")
        if not fields.get("inspector_name"):
            raise HTTPException(status_code=400,
                detail="Inspector name is required to submit")
        if grade is None:
            raise HTTPException(status_code=400,
                detail="Score could not be computed — check width and yardage")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT * FROM fabric_inspection_tickets
            WHERE sheet_id=%s AND roll_no=%s
            ORDER BY version DESC, id DESC LIMIT 1
            FOR UPDATE
        """, (ctx["sheet_id"], ctx["roll_no"]))
        latest = cur.fetchone()
        common = (fields["color"],
                  fields["yards_inspected"], fields["width_inches"],
                  fields.get("after_wash_width_cm"),
                  fields.get("manual_width_cm"), fields.get("width_source"),
                  fields.get("cuttable_width_cm"),
                  fields["inspector_name"], fields["inspection_date"],
                  fields["face_back"],
                  psycopg2.extras.Json(defects), limit,
                  fields["remarks"], fields["discrepancy_note"],
                  total_points, pp100, grade)
        if latest and latest["status"] == "Draft":
            cur.execute("""
                UPDATE fabric_inspection_tickets SET
                    color=%s, yards_inspected=%s,
                    width_inches=%s, after_wash_width_cm=%s,
                    manual_width_cm=%s, width_source=%s,
                    cuttable_width_cm=%s,
                    inspector_name=%s, inspection_date=%s,
                    face_back=%s, defects=%s, acceptable_limit=%s,
                    remarks=%s, discrepancy_note=%s, total_points=%s,
                    points_per_100=%s, grade=%s, updated_at=now()
                WHERE id=%s RETURNING *
            """, common + (latest["id"],))
        else:
            version = (int(latest["version"]) + 1) if latest else 1
            ticket_no = f"INS-{ctx['roll_id']}-v{version}"
            cur.execute("""
                INSERT INTO fabric_inspection_tickets
                    (sheet_id, po_id, roll_no, roll_id, version, ticket_no,
                     status, color, yards_inspected, width_inches,
                     after_wash_width_cm, manual_width_cm, width_source,
                     cuttable_width_cm,
                     inspector_name, inspection_date, face_back, defects,
                     acceptable_limit, remarks, discrepancy_note,
                     total_points, points_per_100, grade, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,'Draft',
                        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING *
            """, (ctx["sheet_id"], ctx.get("po_id"), ctx["roll_no"],
                  ctx["roll_id"], version, ticket_no) + common + (actor,))
        ticket = cur.fetchone()
        if submit:
            cur.execute("""
                UPDATE fabric_inspection_tickets
                SET status='Submitted', submitted_by=%s, submitted_at=now(),
                    updated_at=now()
                WHERE id=%s RETURNING *
            """, (actor, ticket["id"]))
            ticket = cur.fetchone()
            # Auto-fill the roll's existing quality flow: Pass stays Pass,
            # Reject maps to Fail. Manual overrides stay possible afterwards
            # (they audit with an override flag in the quality endpoint).
            new_q = "Pass" if grade == "Pass" else "Fail"
            cur.execute("""
                UPDATE fabric_receiving_rolls
                SET quality_status=%s, quality_updated_at=now(),
                    quality_updated_by=%s
                WHERE id=%s AND deleted_at IS NULL
            """, (new_q, actor, ctx["roll_id"]))
            _recv_audit(cur, ctx.get("po_id"), ctx["sheet_id"],
                        ctx.get("fabric_name"), "inspection_submitted",
                        {"roll_no": ctx["roll_no"],
                         "ticket_no": ticket.get("ticket_no"),
                         "version": ticket.get("version"),
                         "points_per_100": float(pp100),
                         "acceptable_limit": float(limit),
                         "grade": grade, "quality_status": new_q}, actor)
    conn.commit()
    return ticket

@fabric_router.post("/api/fabric/receiving/inspection/save")
def inspection_save(request: Request, body: dict = Body(...)):
    """Save the roll's inspection ticket as a DRAFT (create the next version
    when the latest ticket is already Submitted). Points + score + grade are
    recomputed server-side."""
    roll_id = body.get("roll_id")
    try:
        roll_id = int(roll_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="roll_id is required")
    fields = _insp_collect_fields(body)
    defects, total_points = _insp_parse_defects(body)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _insp_roll_ctx(conn, roll_id)
        _insp_apply_measurements(conn, ctx, body, name)
        fields = _insp_enforce_source_width(ctx, fields)
        ticket = _insp_upsert_draft(conn, ctx, fields, defects, total_points,
                                    name, submit=False, request=request)
    return {"ok": True, "ticket": _insp_ticket_row(ticket)}

@fabric_router.post("/api/fabric/receiving/inspection/submit")
def inspection_submit(request: Request, body: dict = Body(...)):
    """Submit the roll's inspection ticket: saves the payload, validates the
    required fields, locks the ticket (Draft → Submitted), stamps the
    inspector sign-off, auto-fills the roll's quality_status (Pass / Fail)
    and writes the audit row. Re-inspection later creates a NEW version."""
    roll_id = body.get("roll_id")
    try:
        roll_id = int(roll_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="roll_id is required")
    fields = _insp_collect_fields(body)
    defects, total_points = _insp_parse_defects(body)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _insp_roll_ctx(conn, roll_id)
        _insp_apply_measurements(conn, ctx, body, name)
        fields = _insp_enforce_source_width(ctx, fields)
        ticket = _insp_upsert_draft(conn, ctx, fields, defects, total_points,
                                    name, submit=True, request=request)
    return {"ok": True, "ticket": _insp_ticket_row(ticket)}

@fabric_router.post("/api/fabric/receiving/inspection/approve")
def inspection_approve(request: Request, body: dict = Body(...)):
    """QC Supervisor approval of a SUBMITTED ticket. Server-enforced
    allow-list: full fabric admins + the explicit supervisor emails."""
    if not _insp_can_approve(request):
        raise HTTPException(status_code=403,
            detail="Only the QC supervisor or a fabric admin may approve "
                   "inspection tickets")
    ticket_id = body.get("ticket_id")
    try:
        ticket_id = int(ticket_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="ticket_id is required")
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM fabric_inspection_tickets WHERE id=%s "
                        "FOR UPDATE", (ticket_id,))
            t = cur.fetchone()
            if not t:
                raise HTTPException(status_code=404, detail="ticket not found")
            if t["status"] != "Submitted":
                raise HTTPException(status_code=400,
                    detail="Only a submitted ticket can be approved")
            if t.get("approved_at") is not None:
                raise HTTPException(status_code=400,
                    detail="This ticket is already approved")
            cur.execute("""
                UPDATE fabric_inspection_tickets
                SET approved_by=%s, approved_at=now(), updated_at=now()
                WHERE id=%s RETURNING *
            """, (name, ticket_id))
            t = cur.fetchone()
            _recv_audit(cur, t.get("po_id"), t["sheet_id"], None,
                        "inspection_approved",
                        {"roll_no": t["roll_no"], "ticket_no": t.get("ticket_no"),
                         "version": t.get("version"), "grade": t.get("grade")},
                        name)
        conn.commit()
    return {"ok": True, "ticket": _insp_ticket_row(t)}

@fabric_router.post("/api/fabric/receiving/inspection/cuttable-width")
def inspection_set_cuttable_width(request: Request, body: dict = Body(...)):
    """Add or correct the CUTTABLE width (cm) on an EXISTING inspection
    ticket, regardless of status. Rolls scored on a fallback width because no
    cuttable width was entered stay flagged until this runs; saving here
    re-resolves the score width (cuttable takes priority), recomputes
    points_per_100 and the Pass/Reject grade in the same request — no
    migration/sweep. Draft & Submitted tickets: any signed-in user (same as
    creating the ticket); Approved tickets: QC supervisor / fabric admin only
    (mirrors the approval permission). When the LATEST Submitted ticket's
    grade changes, the roll's auto-set quality_status follows (audited)."""
    ticket_id = body.get("ticket_id")
    try:
        ticket_id = int(ticket_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="ticket_id is required")
    cut = _insp_num(body.get("cuttable_width_cm"), "cuttable width (cm)")
    if cut is None or cut <= 0:
        raise HTTPException(status_code=400,
            detail="cuttable width (cm) must be greater than zero")
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM fabric_inspection_tickets WHERE id=%s "
                        "FOR UPDATE", (ticket_id,))
            t = cur.fetchone()
            if not t:
                raise HTTPException(status_code=404, detail="ticket not found")
            if t.get("approved_at") is not None and not _insp_can_approve(request):
                raise HTTPException(status_code=403,
                    detail="This ticket is supervisor-approved — only the QC "
                           "supervisor or a fabric admin may change its "
                           "cuttable width")
            # Cuttable width always takes priority for the score width
            # (same rule as _insp_enforce_source_width).
            width_in = round(float(cut) / 2.54, 1)
            yards = (float(t["yards_inspected"])
                     if t.get("yards_inspected") is not None else None)
            total_points = t.get("total_points")
            pp100 = _insp_score(total_points, width_in, yards)
            limit = (float(t["acceptable_limit"])
                     if t.get("acceptable_limit") is not None else 40)
            grade = None
            if pp100 is not None:
                grade = "Pass" if pp100 <= limit else "Reject"
            old_grade = t.get("grade")
            cur.execute("""
                UPDATE fabric_inspection_tickets
                SET cuttable_width_cm=%s, width_inches=%s,
                    width_source='cuttable', points_per_100=%s, grade=%s,
                    updated_at=now()
                WHERE id=%s RETURNING *
            """, (cut, width_in, pp100, grade, ticket_id))
            t = cur.fetchone()
            # Roll quality_status follows the auto-set flow ONLY when this is
            # the roll's LATEST Submitted ticket and the grade actually
            # computed (mirrors submit; manual overrides stay possible after).
            roll_status = None
            if t["status"] == "Submitted" and grade is not None:
                cur.execute("""
                    SELECT id FROM fabric_inspection_tickets
                    WHERE sheet_id=%s AND roll_no=%s AND status='Submitted'
                    ORDER BY version DESC, id DESC LIMIT 1
                """, (t["sheet_id"], t["roll_no"]))
                lat = cur.fetchone()
                if lat and int(lat["id"]) == int(t["id"]):
                    roll_status = "Pass" if grade == "Pass" else "Fail"
                    cur.execute("""
                        UPDATE fabric_receiving_rolls
                        SET quality_status=%s, quality_updated_at=now(),
                            quality_updated_by=%s
                        WHERE sheet_id=%s AND roll_no=%s
                          AND deleted_at IS NULL
                    """, (roll_status, name, t["sheet_id"], t["roll_no"]))
            _recv_audit(cur, t.get("po_id"), t["sheet_id"], None,
                        "inspection_cuttable_updated",
                        {"roll_no": t["roll_no"],
                         "ticket_no": t.get("ticket_no"),
                         "version": t.get("version"),
                         "status": t.get("status"),
                         "cuttable_width_cm": float(cut),
                         "width_inches": width_in,
                         "points_per_100": (float(pp100)
                                            if pp100 is not None else None),
                         "old_grade": old_grade, "grade": grade,
                         "quality_status": roll_status}, name)
        conn.commit()
    return {"ok": True, "ticket": _insp_ticket_row(t)}

def _recv_po_locked(conn, po_id):
    """A PO's rolls/quantities are LOCKED once it has at least one SUCCESSFUL
    Odoo upload. Failed attempts do not lock."""
    if po_id is None:
        return False
    rows = q(conn, "SELECT 1 FROM fabric_po_uploads "
                   "WHERE po_id=%s AND status='success' LIMIT 1", (po_id,))
    return bool(rows)

def _fabric_log_activity(request, method, path, detail):
    """Best-effort write to app_activity_log for fabric field-grant / width /
    renumber actions. Never raises — a log failure must not fail the action."""
    try:
        u = getattr(request.state, "user", None) or {}
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO app_activity_log "
                    "(user_id, email, method, path, query, status_code) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (u.get("user_id"), u.get("email"),
                     (method or "")[:10], (path or "")[:300],
                     (detail or "")[:500], 200))
            conn.commit()
    except Exception as exc:
        log.warning("fabric activity log write failed: %s", exc)


def _recv_audit(cur, po_id, sheet_id, fabric_name, action, details, actor):
    cur.execute("""
        INSERT INTO fabric_recv_audit
          (po_id, sheet_id, fabric_name, action, details, actor_name)
        VALUES (%s,%s,%s,%s,%s,%s)
    """, (po_id, sheet_id, fabric_name, action,
          psycopg2.extras.Json(details or {}), actor))

def _recv_backfill_missing_kpm(conn):
    """Back-fill kg_per_mtr on receiving sheets whose product now has Width/GSM.

    When a receiving sheet is created for a product that has no Width/GSM in
    Odoo yet, kg_per_mtr=NULL is frozen into fabric_receiving_sheets. After the
    buying team later enters Width/GSM in Odoo and the ~60s sync updates
    raw_fabric_products, this function finds every sheet where:
      - fabric_receiving_sheets.kg_per_mtr IS NULL (never filled in)
      - raw_fabric_products.kg_per_mtr_eff IS NOT NULL (now derivable)
    and repairs them in a single transaction:
      - Sets sheet.kg_per_mtr = kg_per_mtr_eff
      - Recomputes sheet.total_mtrs = ROUND(total_kg / kg_per_mtr_eff, 1)
      - Sets qty_mtrs on every non-deleted roll = ROUND(qty_kg / kg_per_mtr_eff, 2)
    Sheets that already had a valid kg_per_mtr at creation are untouched.
    Safe to call repeatedly — NULL-only guard means it is a no-op once fixed.
    """
    import logging as _log
    _logger = _log.getLogger(__name__)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                WITH stale AS (
                    SELECT s.id             AS sheet_id,
                           p.kg_per_mtr_eff AS kpm
                    FROM fabric_receiving_sheets s
                    JOIN raw_fabric_products p ON p.id = s.product_id
                    WHERE s.kg_per_mtr IS NULL
                      AND p.kg_per_mtr_eff IS NOT NULL
                      AND p.kg_per_mtr_eff > 0
                )
                UPDATE fabric_receiving_sheets s
                   SET kg_per_mtr     = stale.kpm,
                       total_mtrs     = ROUND(s.total_kg / stale.kpm, 1),
                       updated_at     = now(),
                       updated_by_name = 'system (kpm backfill)'
                  FROM stale
                 WHERE s.id = stale.sheet_id
                RETURNING s.id
            """)
            updated_sheet_ids = [r[0] for r in cur.fetchall()]
            if not updated_sheet_ids:
                conn.commit()
                return
            cur.execute("""
                UPDATE fabric_receiving_rolls r
                   SET qty_mtrs = ROUND(r.qty_kg / p.kg_per_mtr_eff, 2)
                  FROM fabric_receiving_sheets s
                  JOIN raw_fabric_products p ON p.id = s.product_id
                 WHERE r.sheet_id = s.id
                   AND s.id = ANY(%s)
                   AND r.deleted_at IS NULL
                   AND p.kg_per_mtr_eff IS NOT NULL
                   AND p.kg_per_mtr_eff > 0
            """, (updated_sheet_ids,))
            updated_rolls = cur.rowcount
        conn.commit()
        _logger.info(
            "kpm backfill: patched %d sheet(s) and %d roll(s) "
            "with newly-available Width/GSM conversion",
            len(updated_sheet_ids), updated_rolls)
    except Exception as e:
        _logger.error("kpm backfill failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


def _recv_refresh_sheet_totals(conn, sheet_id, actor_name):
    """Recompute a sheet's totals from its rolls (using the sheet's SNAPSHOTTED
    kg->metre conversion) and stamp the edit."""
    rows = q(conn, """
        SELECT s.kg_per_mtr,
               COALESCE(SUM(r.qty_kg),0) as kg, COUNT(r.id) as n
        FROM fabric_receiving_sheets s
        LEFT JOIN fabric_receiving_rolls r
               ON r.sheet_id = s.id AND r.deleted_at IS NULL
        WHERE s.id=%s GROUP BY s.kg_per_mtr
    """, (sheet_id,))
    if not rows:
        return
    kpm = rows[0].get("kg_per_mtr")
    kpm = float(kpm) if kpm not in (None, "") and float(kpm) > 0 else None
    total_kg = round(float(rows[0]["kg"] or 0), 3)
    total_mtrs = round(total_kg / kpm, 1) if kpm else None
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE fabric_receiving_sheets
               SET total_kg=%s, total_mtrs=%s, rolls_count=%s,
                   updated_at=now(), updated_by_name=%s
             WHERE id=%s
        """, (total_kg, total_mtrs, int(rows[0]["n"] or 0),
              actor_name, sheet_id))

_RECV_LOCKED_MSG = ("This PO has already been uploaded to Odoo — roll and "
                    "quantity changes are locked to admins now (quality "
                    "results stay editable by everyone)")

def _recv_parse_weights(body, key="rolls"):
    """Validate a rolls payload where roll NUMBERS are server-assigned: a list
    of 1..50 entries each carrying only qty_kg > 0."""
    rolls_in = body.get(key)
    if not isinstance(rolls_in, list) or not rolls_in:
        raise HTTPException(status_code=400, detail="rolls list is required")
    if len(rolls_in) > 50:
        raise HTTPException(status_code=400,
                            detail="add at most 50 rolls at a time")
    weights = []
    for i, r in enumerate(rolls_in, start=1):
        v = r.get("qty_kg") if isinstance(r, dict) else r
        try:
            kg = float(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail=f"roll {i}: kgs must be a number")
        if not (kg > 0):
            raise HTTPException(status_code=400,
                detail=f"roll {i}: kgs must be greater than zero")
        weights.append(round(kg, 3))
    return weights

@fabric_router.post("/api/fabric/receiving/po-sheet/{po_id}/rolls")
def receiving_po_sheet_add_rolls(po_id: int, request: Request,
                                 body: dict = Body(...)):
    """Append rolls of one fabric to a PO's receiving sheet. The PO holds ONE
    sheet per product; if none exists yet it is created (reopening/appending
    across multi-day deliveries just adds rolls to the same sheet). Roll
    numbers are assigned SERVER-SIDE, continuing from the product's highest
    number on this PO, under a per-(PO,product) advisory lock so two clerks
    saving at once can never duplicate a number. Body:
      {"product_id": <odoo id>, "rolls": [{"qty_kg": 12.5}, ...], "note": "…"}
    After a successful Odoo upload only an admin may add rolls (audited)."""
    product_id = body.get("product_id")
    try:
        product_id = int(product_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="product_id is required")
    _recv_block_quality_only(request)
    weights = _recv_parse_weights(body)
    note = str(body.get("note") or "").strip() or None
    uid, name = _fabric_actor(request)
    admin = _recv_is_admin(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        locked = _recv_po_locked(conn, po_id)
        if locked and not admin:
            raise HTTPException(status_code=403, detail=_RECV_LOCKED_MSG)
        prod = _recv_product_info(conn, product_id)
        if not prod:
            raise HTTPException(status_code=404, detail="fabric not found")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Serialize the whole PO: the lock holds until COMMIT, so the
            # PO-sheet get-or-create, the section get-or-create AND the
            # MAX(roll_no) read below can never race a concurrent save.
            cur.execute(
                "SELECT pg_advisory_xact_lock("
                "hashtextextended('fabric-recv-po-' || %s, 42))",
                (str(po_id),))
            # ONE sheet per PO (UNIQUE po_id): reopen it if it exists,
            # create it on the PO's very first receiving.
            cur.execute("SELECT id, po_name, po_date "
                        "FROM fabric_receiving_po_sheets WHERE po_id=%s",
                        (po_id,))
            po_sheet = cur.fetchone()
            if po_sheet is None:
                # Snapshot the PO header from a legacy sibling section when
                # one exists (no Odoo round-trip needed); only a brand-new
                # PO validates live against Odoo (must exist + be draft).
                cur.execute("""
                    SELECT po_name, po_date FROM fabric_receiving_sheets
                    WHERE po_id=%s AND po_name IS NOT NULL
                    ORDER BY id LIMIT 1
                """, (po_id,))
                sib = cur.fetchone()
                if sib:
                    po_name, po_date = sib["po_name"], sib["po_date"]
                else:
                    po_link = _recv_fetch_draft_po(po_id)
                    po_name, po_date = po_link["name"], po_link["date_order"]
                cur.execute("""
                    INSERT INTO fabric_receiving_po_sheets
                      (po_id, po_name, po_date, created_by, created_by_name)
                    VALUES (%s,%s,%s,%s,%s)
                    ON CONFLICT (po_id) DO UPDATE SET po_id=EXCLUDED.po_id
                    RETURNING id, po_name, po_date
                """, (po_id, po_name, po_date, uid, name))
                po_sheet = cur.fetchone()
            po_sheet_id = po_sheet["id"]
            po_name, po_date = po_sheet["po_name"], po_sheet["po_date"]
            # Product SECTION of the PO sheet (one per fabric under the PO).
            cur.execute("""
                SELECT id, kg_per_mtr, fabric_name, po_sheet_id
                FROM fabric_receiving_sheets
                WHERE po_id=%s AND product_id=%s AND deleted_at IS NULL
                ORDER BY id LIMIT 1
            """, (po_id, product_id))
            sheet = cur.fetchone()
            section_created = sheet is None
            if sheet is None:
                kpm = prod.get("kg_per_mtr")
                kpm = (float(kpm)
                       if kpm not in (None, "") and float(kpm) > 0 else None)
                cur.execute("""
                    INSERT INTO fabric_receiving_sheets
                      (product_id, barcode, fabric_name, kg_per_mtr,
                       total_kg, total_mtrs, rolls_count, note,
                       created_by, created_by_name, po_id, po_name, po_date,
                       po_sheet_id)
                    VALUES (%s,%s,%s,%s,0,NULL,0,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING id, kg_per_mtr, fabric_name
                """, (product_id, prod.get("default_code"), prod.get("name"),
                      kpm, note, uid, name, po_id, po_name, po_date,
                      po_sheet_id))
                sheet = cur.fetchone()
            elif sheet.get("po_sheet_id") is None:
                # Legacy section created before the PO-sheet model: adopt it
                # into the PO's single sheet so appends keep one sheet per PO.
                cur.execute("UPDATE fabric_receiving_sheets SET po_sheet_id=%s"
                            " WHERE id=%s", (po_sheet_id, sheet["id"]))
            if note and not section_created:
                cur.execute("""
                    UPDATE fabric_receiving_sheets
                       SET note = CASE WHEN COALESCE(note,'')='' THEN %s
                                       ELSE note || ' | ' || %s END
                     WHERE id=%s
                """, (note, note, sheet["id"]))
            sheet_id = sheet["id"]
            kpm = sheet.get("kg_per_mtr")
            kpm = (float(kpm)
                   if kpm not in (None, "") and float(kpm) > 0 else None)
            # Next roll number continues from this product's highest number
            # anywhere on this PO (legacy multi-sheet groups included).
            cur.execute("""
                SELECT COALESCE(MAX(r.roll_no),0) as mx
                FROM fabric_receiving_rolls r
                JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
                WHERE s.po_id=%s AND s.product_id=%s
            """, (po_id, product_id))
            next_no = int(cur.fetchone()["mx"]) + 1
            roll_nos = []
            for kg in weights:
                cur.execute("""
                    INSERT INTO fabric_receiving_rolls
                      (sheet_id, roll_no, qty_kg, qty_mtrs)
                    VALUES (%s,%s,%s,%s)
                """, (sheet_id, next_no, kg,
                      round(kg / kpm, 2) if kpm else None))
                roll_nos.append(next_no)
                next_no += 1
            _recv_audit(cur, po_id, sheet_id, sheet.get("fabric_name"),
                        "rolls_added",
                        {"rolls": roll_nos,
                         "total_kg": round(sum(weights), 3),
                         "after_upload": bool(locked)}, name)
        _recv_refresh_sheet_totals(conn, sheet_id, name)
        conn.commit()
        _log_fabric_change("Receiving rolls added", {
            "id": sheet_id, "product": sheet.get("fabric_name"),
            "style_name": "", "qty": round(sum(weights), 3), "uom": "kg",
            "note": f"rolls {roll_nos[0]}–{roll_nos[-1]} (PO {po_id})",
            "status": "received"}, request)
        return {"ok": True, "sheet_id": sheet_id, "roll_nos": roll_nos,
                "missing_conversion": kpm is None, "locked": locked}

def _recv_roll_ctx(conn, roll_id):
    """One roll + its sheet's PO context, or 404."""
    rows = q(conn, """
        SELECT r.id as roll_id, r.roll_no, r.qty_kg, r.sheet_id,
               s.po_id, s.fabric_name, s.kg_per_mtr, s.rolls_count
        FROM fabric_receiving_rolls r
        JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
        WHERE r.id=%s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
    """, (roll_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="roll not found")
    return rows[0]

@fabric_router.put("/api/fabric/receiving/roll/{roll_id}")
def receiving_roll_edit(roll_id: int, request: Request,
                        body: dict = Body(...)):
    """Correct ONE roll's weight. Open to any fabric user while the PO is
    still un-uploaded; after a successful upload only an admin may edit
    (the change is audited who/what/when either way). Body: {"qty_kg": 12.5}"""
    try:
        kg = float(body.get("qty_kg"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="qty_kg must be a number")
    if not (kg > 0):
        raise HTTPException(status_code=400,
                            detail="qty_kg must be greater than zero")
    kg = round(kg, 3)
    _recv_block_quality_only(request)
    _uid, name = _fabric_actor(request)
    admin = _recv_is_admin(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _recv_roll_ctx(conn, roll_id)
        locked = _recv_po_locked(conn, ctx["po_id"])
        if locked and not admin:
            raise HTTPException(status_code=403, detail=_RECV_LOCKED_MSG)
        kpm = ctx.get("kg_per_mtr")
        kpm = float(kpm) if kpm not in (None, "") and float(kpm) > 0 else None
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_rolls SET qty_kg=%s, qty_mtrs=%s
                WHERE id=%s
            """, (kg, round(kg / kpm, 2) if kpm else None, roll_id))
            _recv_audit(cur, ctx["po_id"], ctx["sheet_id"],
                        ctx.get("fabric_name"), "roll_edited",
                        {"roll_no": ctx["roll_no"],
                         "old_kg": float(ctx["qty_kg"] or 0), "new_kg": kg,
                         "after_upload": bool(locked)}, name)
        _recv_refresh_sheet_totals(conn, ctx["sheet_id"], name)
        conn.commit()
        _log_fabric_change("Receiving roll edited", {
            "id": ctx["sheet_id"], "product": ctx.get("fabric_name"),
            "style_name": "", "qty": kg, "uom": "kg",
            "note": f"roll {ctx['roll_no']} "
                    f"{float(ctx['qty_kg'] or 0)}→{kg} kg",
            "status": "edited"}, request)
    return {"ok": True}

@fabric_router.patch("/api/fabric/receiving/roll/{roll_id}/defective-yards")
def receiving_roll_patch_defective(roll_id: int, request: Request,
                                   body: dict = Body(...)):
    """Set or clear the defective_yards field on a single roll. Any
    authenticated fabric QC user may call this (same permission as quality
    grading — no extra admin gate). Body: {"defective_yards": <number|null>}.
    Validates: defective_yards <= length_yards when length_yards is known.
    Returns: {ok, defective_yards, okay_yards}."""
    raw = body.get("defective_yards")
    if raw in (None, ""):
        defective = None
    else:
        try:
            defective = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail="defective_yards must be a number")
        if defective < 0:
            raise HTTPException(status_code=400,
                                detail="defective_yards cannot be negative")
        defective = round(defective, 3)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn,
                 "SELECT id, length_yards, defective_yards "
                 "FROM fabric_receiving_rolls "
                 "WHERE id=%s AND deleted_at IS NULL", (roll_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="roll not found")
        length = rows[0].get("length_yards")
        if defective is not None and length not in (None, ""):
            try:
                ly = float(length)
            except (TypeError, ValueError):
                ly = None
            if ly is not None and defective > ly:
                raise HTTPException(
                    status_code=422,
                    detail=f"Defective yards ({defective}) cannot exceed "
                           f"roll length ({ly} yds)")
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE fabric_receiving_rolls "
                "SET defective_yards=%s, quality_updated_at=now(), "
                "    quality_updated_by=%s "
                "WHERE id=%s AND deleted_at IS NULL",
                (defective, name, roll_id))
        conn.commit()
    okay = None
    if defective is not None and length not in (None, ""):
        try:
            okay = round(float(length) - defective, 3)
        except (TypeError, ValueError):
            pass
    return {"ok": True, "defective_yards": defective, "okay_yards": okay}


@fabric_router.delete("/api/fabric/receiving/roll/{roll_id}")
def receiving_roll_delete(roll_id: int, request: Request):
    """Remove ONE roll (same lock rule as editing: any user pre-upload, admin
    after — audited either way). SOFT delete: the roll goes to the Recovery
    Bin (90 days) instead of being destroyed. Deleting the sheet's last roll
    soft-deletes the now-empty sheet so the PO group stays clean."""
    _recv_block_quality_only(request)
    _uid, name = _fabric_actor(request)
    admin = _recv_is_admin(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _recv_roll_ctx(conn, roll_id)
        locked = _recv_po_locked(conn, ctx["po_id"])
        if locked and not admin:
            raise HTTPException(status_code=403, detail=_RECV_LOCKED_MSG)
        with conn.cursor() as cur:
            cur.execute("UPDATE fabric_receiving_rolls "
                        "SET deleted_at=now(), deleted_by=%s WHERE id=%s",
                        (name, roll_id))
            cur.execute("SELECT COUNT(*) FROM fabric_receiving_rolls "
                        "WHERE sheet_id=%s AND deleted_at IS NULL",
                        (ctx["sheet_id"],))
            remaining = int(cur.fetchone()[0])
            _recv_audit(cur, ctx["po_id"], ctx["sheet_id"],
                        ctx.get("fabric_name"), "roll_deleted",
                        {"roll_no": ctx["roll_no"],
                         "old_kg": float(ctx["qty_kg"] or 0),
                         "after_upload": bool(locked)}, name)
            if remaining == 0:
                cur.execute("UPDATE fabric_receiving_sheets "
                            "SET deleted_at=now(), deleted_by=%s WHERE id=%s",
                            (name, ctx["sheet_id"]))
        if remaining > 0:
            _recv_refresh_sheet_totals(conn, ctx["sheet_id"], name)
        conn.commit()
        _log_fabric_change("Receiving roll deleted", {
            "id": ctx["sheet_id"], "product": ctx.get("fabric_name"),
            "style_name": "", "qty": float(ctx["qty_kg"] or 0), "uom": "kg",
            "note": f"roll {ctx['roll_no']}"
                    + (" (sheet emptied & removed)" if remaining == 0 else ""),
            "status": "deleted"}, request)
    return {"ok": True, "sheet_removed": remaining == 0}

@fabric_router.put("/api/fabric/receiving/roll/{roll_id}/invoiced")
def receiving_roll_invoiced(roll_id: int, request: Request,
                            body: dict = Body(...)):
    """Write invoiced-quantity (KGs and/or Mtrs) for one roll.
    Gated to bedan@vivofashiongroup.com only — any other user gets 403.
    Accepts {"inv_kg": <number|null>, "inv_mtrs": <number|null>}.
    Returns the updated roll including the computed variances
    (delta_kg = qty_kg − inv_kg, delta_mtrs = qty_mtrs − inv_mtrs)."""
    _recv_block_non_bedan_invoice(request)

    def _parse_opt_num(key):
        v = body.get(key)
        if v in (None, ""):
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail=f"{key} must be a number or null")
        if f < 0:
            raise HTTPException(status_code=400,
                                detail=f"{key} cannot be negative")
        return round(f, 3)

    inv_kg = _parse_opt_num("inv_kg")
    inv_mtrs = _parse_opt_num("inv_mtrs")

    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        ctx = _recv_roll_ctx(conn, roll_id)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_rolls
                   SET inv_kg=%s, inv_mtrs=%s
                 WHERE id=%s
            """, (inv_kg, inv_mtrs, roll_id))
        conn.commit()
        updated = q(conn,
                    "SELECT id as roll_id, roll_no, qty_kg, qty_mtrs, "
                    "inv_kg, inv_mtrs "
                    "FROM fabric_receiving_rolls WHERE id=%s", (roll_id,))
    row = updated[0] if updated else {}
    qty_kg = float(row.get("qty_kg") or 0)
    qty_mtrs = row.get("qty_mtrs")
    inv_kg_v = row.get("inv_kg")
    inv_mtrs_v = row.get("inv_mtrs")
    delta_kg = (round(qty_kg - float(inv_kg_v), 3)
                if inv_kg_v is not None else None)
    delta_mtrs = (round(float(qty_mtrs) - float(inv_mtrs_v), 3)
                  if (qty_mtrs is not None and inv_mtrs_v is not None) else None)
    return {"ok": True,
            "roll_id": row.get("roll_id"),
            "inv_kg": inv_kg_v,
            "inv_mtrs": inv_mtrs_v,
            "delta_kg": delta_kg,
            "delta_mtrs": delta_mtrs}

@fabric_router.put("/api/fabric/receiving/roll/{roll_id}/width-inline")
def receiving_roll_width_inline(roll_id: int, request: Request,
                                body: dict = Body(...)):
    """Inline Width (CM) edit from the Receiving table. Writes the roll's
    measured width (width_measured_m — the SAME field the inspection form
    writes), taking centimetres in and storing metres.
    Gated to bedan@ and hagai@vivofashiongroup.com only — any other user
    gets 403. Accepts {"width_cm": <number|null>} (null clears the value).
    Audited to fabric_recv_audit with old/new cm values."""
    _recv_block_non_inline_width(request)
    raw = body.get("width_cm")
    if raw in (None, ""):
        width_cm = None
    else:
        try:
            width_cm = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                detail="width_cm must be a number")
        if not (0 < width_cm <= 500):
            raise HTTPException(status_code=400,
                detail="width_cm must be a positive number (0–500)")
        width_cm = round(width_cm, 1)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rolls = q(conn, """
            SELECT r.id, r.sheet_id, r.roll_no, r.width_measured_m,
                   s.fabric_name, s.po_id
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            WHERE r.id=%s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
        """, (roll_id,))
        if not rolls:
            raise HTTPException(status_code=404, detail="roll not found")
        roll = rolls[0]
        old_m = roll.get("width_measured_m")
        old_cm = (round(float(old_m) * 100, 1)
                  if old_m not in (None, "") else None)
        new_m = (round(width_cm / 100.0, 4)
                 if width_cm is not None else None)
        po_id = roll.get("po_id")
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_rolls
                   SET width_measured_m=%s
                 WHERE id=%s
            """, (new_m, roll_id))
            _recv_audit(cur, po_id, roll["sheet_id"], roll.get("fabric_name"),
                        "width_inline_updated",
                        {"roll_no": roll["roll_no"],
                         "old_cm": old_cm,
                         "new_cm": width_cm},
                        name)
        conn.commit()
    _fabric_log_activity(request, "PUT",
                         f"/api/fabric/receiving/roll/{roll_id}/width-inline",
                         f"width_measured_m: {old_cm} -> {width_cm} cm")
    return {"ok": True, "roll_id": roll_id,
            "roll_no": roll["roll_no"],
            "width_measured_m": new_m,
            "width_cm": width_cm}


_INVOICE_STATUSES = {"credit_note", "back_order"}

@fabric_router.put("/api/fabric/receiving/po-sheet/{po_id}/invoice-status")
def receiving_invoice_status(po_id: int, request: Request,
                             body: dict = Body(...)):
    """Set (or clear) the credit-note / back-order flag on a PO's delivery.
    Gated to bedan@vivofashiongroup.com only — any other user gets 403.
    Accepts {"status": "credit_note" | "back_order" | null}.
    A second PUT with the currently-active status clears it back to null
    (the toggle is enforced client-side; the server accepts any valid value)."""
    _recv_block_non_bedan_invoice(request)
    raw = body.get("status")
    if raw in (None, "", "null"):
        status = None
    else:
        status = str(raw).strip().lower()
        if status not in _INVOICE_STATUSES:
            raise HTTPException(status_code=400,
                detail="status must be 'credit_note', 'back_order', or null")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn,
                 "SELECT id FROM fabric_receiving_po_sheets WHERE po_id=%s",
                 (po_id,))
        if not rows:
            raise HTTPException(status_code=404,
                detail="No receiving sheet found for this PO")
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_po_sheets
                   SET invoice_status=%s
                 WHERE po_id=%s
            """, (status, po_id))
        conn.commit()
    return {"ok": True, "invoice_status": status}

@fabric_router.get("/api/fabric/receiving")
def receiving_list(search: str = Query(default=""),
                   limit: int = Query(default=200)):
    """Saved receiving sheets, newest first, for the Receiving tab list."""
    limit = max(1, min(int(limit or 200), 500))
    term = (search or "").strip()
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        where, params = "WHERE s.deleted_at IS NULL", []
        if term:
            where += (" AND (s.fabric_name ILIKE %s OR s.barcode ILIKE %s "
                      "OR p.barcode ILIKE %s OR s.po_name ILIKE %s)")
            like = f"%{term}%"
            params = [like, like, like, like]
        rows = q(conn, f"""
            SELECT s.id, s.product_id,
                   COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode)     AS barcode,
                   COALESCE(p.name,    s.fabric_name) AS fabric_name,
                   s.kg_per_mtr, s.total_kg, s.total_mtrs, s.rolls_count,
                   s.note, s.created_by_name,
                   s.po_id, s.po_name,
                   to_char(s.po_date, 'DD Mon YYYY') as po_date,
                   COALESCE(to_char(s.po_date, 'DD Mon YYYY'),
                            to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                                    'DD Mon YYYY')) as receiving_date,
                   to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as created_at,
                   to_char(s.updated_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as updated_at,
                   s.updated_by_name,
                   COALESCE(qc.pass_n,0)    as q_pass,
                   COALESCE(qc.fail_n,0)    as q_fail,
                   COALESCE(qc.inspected,0) as q_inspected
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            LEFT JOIN (
                SELECT sheet_id,
                       COUNT(*) FILTER (WHERE quality_status='Pass') as pass_n,
                       COUNT(*) FILTER (WHERE quality_status='Fail') as fail_n,
                       COUNT(*) FILTER (WHERE quality_status IN ('Pass','Fail')) as inspected
                FROM fabric_receiving_rolls WHERE deleted_at IS NULL
                GROUP BY sheet_id
            ) qc ON qc.sheet_id = s.id
            {where}
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT %s
        """, params + [limit])
    return {"items": rows}

# ── Receiving Recovery Bin (soft-deleted sheets & rolls, 90-day hold) ──
# Deleted sheets/rolls are only FLAGGED (deleted_at/deleted_by); a full
# fabric admin can restore or permanently purge them here. Anything older
# than 90 days is lazily purged whenever the bin is opened (no cron).

_RECV_BIN_DAYS = 90

def _recv_bin_lazy_purge(conn):
    """Hard-delete bin items past the 90-day hold. Rolls of purged sheets go
    with their sheet; individually-deleted rolls purge on their own clock."""
    with conn.cursor() as cur:
        cur.execute("""
            DELETE FROM fabric_receiving_rolls
             WHERE sheet_id IN (SELECT id FROM fabric_receiving_sheets
                                WHERE deleted_at IS NOT NULL
                                  AND deleted_at < now() - interval '%s days')
        """ % _RECV_BIN_DAYS)
        cur.execute("""
            DELETE FROM fabric_receiving_sheets
             WHERE deleted_at IS NOT NULL
               AND deleted_at < now() - interval '%s days'
        """ % _RECV_BIN_DAYS)
        cur.execute("""
            DELETE FROM fabric_receiving_rolls
             WHERE deleted_at IS NOT NULL
               AND deleted_at < now() - interval '%s days'
        """ % _RECV_BIN_DAYS)
    conn.commit()

def _recv_require_full_admin(request):
    if not _recv_is_admin(request):
        raise HTTPException(status_code=403,
            detail="Recovery Bin is restricted to fabric admins")

@fabric_router.get("/api/fabric/receiving/recovery-bin")
def receiving_recovery_bin(request: Request):
    """List soft-deleted receiving sheets and individually deleted rolls
    (whose sheet is still live). Any signed-in receiving viewer may LOOK at
    the bin; restore/purge stay gated to full fabric admins."""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        _recv_bin_lazy_purge(conn)
        sheets = q(conn, """
            SELECT s.id,
                   COALESCE(p.name,    s.fabric_name) AS fabric_name,
                   COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode)     AS barcode,
                   s.po_id, s.po_name,
                   s.total_kg, s.rolls_count, s.deleted_by,
                   to_char(s.deleted_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as deleted_at,
                   GREATEST(0, %s - EXTRACT(day FROM now() - s.deleted_at)::int)
                     as days_left
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE s.deleted_at IS NOT NULL
            ORDER BY s.deleted_at DESC
        """, (_RECV_BIN_DAYS,))
        rolls = q(conn, """
            SELECT r.id, r.roll_no, r.qty_kg, r.deleted_by,
                   s.id as sheet_id, s.fabric_name, s.po_id, s.po_name,
                   to_char(r.deleted_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as deleted_at,
                   GREATEST(0, %s - EXTRACT(day FROM now() - r.deleted_at)::int)
                     as days_left
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            WHERE r.deleted_at IS NOT NULL AND s.deleted_at IS NULL
            ORDER BY r.deleted_at DESC
        """, (_RECV_BIN_DAYS,))
    return {"sheets": sheets, "rolls": rolls, "hold_days": _RECV_BIN_DAYS}

@fabric_router.post("/api/fabric/receiving/recovery-bin/restore")
def receiving_recovery_restore(request: Request, body: dict = Body(...)):
    """Restore a soft-deleted sheet or roll. Body: {"kind":"sheet"|"roll","id":n}"""
    _recv_require_full_admin(request)
    kind = str(body.get("kind") or "")
    try:
        item_id = int(body.get("id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="id is required")
    if kind not in ("sheet", "roll"):
        raise HTTPException(status_code=400, detail="kind must be sheet or roll")
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if kind == "sheet":
                cur.execute("""
                    UPDATE fabric_receiving_sheets
                       SET deleted_at=NULL, deleted_by=NULL,
                           updated_at=now(), updated_by_name=%s
                     WHERE id=%s AND deleted_at IS NOT NULL
                    RETURNING id, po_id, fabric_name
                """, (name, item_id))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="sheet not found in the bin")
                if row["po_id"] is not None:
                    _recv_audit(cur, row["po_id"], row["id"],
                                row.get("fabric_name"), "sheet_restored",
                                {}, name)
                sheet_id = row["id"]
            else:
                cur.execute("""
                    UPDATE fabric_receiving_rolls r
                       SET deleted_at=NULL, deleted_by=NULL
                      FROM fabric_receiving_sheets s
                     WHERE r.id=%s AND r.deleted_at IS NOT NULL
                       AND s.id = r.sheet_id
                    RETURNING r.id, r.roll_no, r.sheet_id,
                              s.po_id, s.fabric_name, s.deleted_at as s_deleted
                """, (item_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="roll not found in the bin")
                if row.get("s_deleted") is not None:
                    # Bring the parent sheet back too, or the roll stays invisible.
                    cur.execute("UPDATE fabric_receiving_sheets "
                                "SET deleted_at=NULL, deleted_by=NULL "
                                "WHERE id=%s", (row["sheet_id"],))
                if row["po_id"] is not None:
                    _recv_audit(cur, row["po_id"], row["sheet_id"],
                                row.get("fabric_name"), "roll_restored",
                                {"roll_no": row.get("roll_no")}, name)
                sheet_id = row["sheet_id"]
        _recv_refresh_sheet_totals(conn, sheet_id, name)
        conn.commit()
    return {"ok": True}

@fabric_router.post("/api/fabric/receiving/recovery-bin/purge")
def receiving_recovery_purge(request: Request, body: dict = Body(...)):
    """PERMANENTLY delete a binned sheet (with its rolls) or roll.
    Body: {"kind":"sheet"|"roll","id":n}"""
    _recv_require_full_admin(request)
    kind = str(body.get("kind") or "")
    try:
        item_id = int(body.get("id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="id is required")
    if kind not in ("sheet", "roll"):
        raise HTTPException(status_code=400, detail="kind must be sheet or roll")
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if kind == "sheet":
                cur.execute("SELECT id, po_id, fabric_name, rolls_count "
                            "FROM fabric_receiving_sheets "
                            "WHERE id=%s AND deleted_at IS NOT NULL", (item_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="sheet not found in the bin")
                cur.execute("DELETE FROM fabric_receiving_rolls "
                            "WHERE sheet_id=%s", (item_id,))
                cur.execute("DELETE FROM fabric_receiving_sheets "
                            "WHERE id=%s", (item_id,))
                if row["po_id"] is not None:
                    _recv_audit(cur, row["po_id"], item_id,
                                row.get("fabric_name"), "sheet_purged",
                                {"rolls": int(row.get("rolls_count") or 0)},
                                name)
            else:
                cur.execute("""
                    SELECT r.id, r.roll_no, r.sheet_id, s.po_id, s.fabric_name
                    FROM fabric_receiving_rolls r
                    JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
                    WHERE r.id=%s AND r.deleted_at IS NOT NULL
                """, (item_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404,
                                        detail="roll not found in the bin")
                cur.execute("DELETE FROM fabric_receiving_rolls WHERE id=%s",
                            (item_id,))
                if row["po_id"] is not None:
                    _recv_audit(cur, row["po_id"], row["sheet_id"],
                                row.get("fabric_name"), "roll_purged",
                                {"roll_no": row.get("roll_no")}, name)
        conn.commit()
    return {"ok": True}

# ── Receiving sheet downloads (PDF / Excel per PO batch) ─────────────

def _recv_download_data(conn, po_id):
    """All live sheets + rolls of one PO, ordered for the printable sheet.
    Also returns the PO-level pricing (FX rates + per-price-key yuan prices)."""
    sheets = q(conn, """
        SELECT s.id,
               s.product_id,
               COALESCE(p.name, s.fabric_name) AS fabric_name,
               COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode) AS barcode,
               NULLIF(BTRIM(p.supplier_fabric_code), '') AS supplier_fabric_code,
               s.kg_per_mtr,
               s.total_kg, s.total_mtrs, s.rolls_count, s.note,
               s.po_id, s.po_name,
               to_char(s.po_date, 'DD Mon YYYY') as po_date,
               s.created_by_name,
               to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                       'DD Mon YYYY, HH24:MI') as created_at
        FROM fabric_receiving_sheets s
        LEFT JOIN raw_fabric_products p ON p.id = s.product_id
        WHERE s.po_id=%s AND s.deleted_at IS NULL
        ORDER BY s.fabric_name, s.id
    """, (po_id,))
    if not sheets:
        raise HTTPException(status_code=404,
                            detail="no receiving sheets for this PO")
    rolls = q(conn, """
        SELECT r.sheet_id, r.roll_no, r.qty_kg, r.qty_mtrs,
               r.quality_status, r.quality_notes,
               r.length_yards, r.shrinkage_inches,
               r.bleeding_test, r.width_measured_m,
               r.after_wash_width_cm, r.after_wash_length_cm
        FROM fabric_receiving_rolls r
        WHERE r.sheet_id = ANY(%s) AND r.deleted_at IS NULL
        ORDER BY r.sheet_id, r.roll_no, r.id
    """, ([int(s["id"]) for s in sheets],))
    by_sheet = {}
    for r in rolls:
        by_sheet.setdefault(r["sheet_id"], []).append(r)
    pricing = _recv_po_pricing(conn, po_id)
    return sheets, by_sheet, pricing

_RECV_DL_HEADERS = ["Roll #", "Kgs", "Metres", "Value (Yuan)", "Value (Kes)",
                    "Length (yds)", "Shrink W", "Shrink L", "Bleeding test",
                    "Width (m)", "Quality", "Notes"]

def _recv_dl_shrink_cells(r):
    """(W, L) shrinkage export cells: inches + percent derived from the raw
    after-wash cm; falls back to the legacy single measurement when the new
    fields are empty (labelled as legacy, shown in the W cell)."""
    w = _recv_shrink_txt(r.get("after_wash_width_cm"))
    l = _recv_shrink_txt(r.get("after_wash_length_cm"))
    if w is None and l is None:
        legacy = r.get("shrinkage_inches")
        if legacy not in (None, ""):
            return (f"{float(legacy):.2f} in (legacy)", "")
        return ("", "")
    return (w or "", l or "")

def _recv_roll_value(r, item, yuan_to_usd, usd_to_kes, direct_kes=False):
    """Return (value_yuan, value_kes) rounded to 2 dp, or (None, None) when any
    required pricing field is absent.  yuan_to_usd is Yuan-per-USD (e.g. 7.9998).
    direct_kes (local purchase): the entered price IS KES — value_kes comes
    straight from price × qty, value_yuan is always None (no FX involved)."""
    if not item:
        return None, None
    yp = item.get("yuan_price")
    qu = item.get("quote_unit") or "kg"
    if yp is None:
        return None, None
    if not direct_kes and (yuan_to_usd is None or usd_to_kes is None):
        return None, None
    raw_qty = r.get("qty_kg") if qu == "kg" else r.get("qty_mtrs")
    if raw_qty is None:
        return None, None
    try:
        qty = float(raw_qty)
    except (TypeError, ValueError):
        return None, None
    if direct_kes:
        return None, round(yp * qty, 2)
    value_yuan = round(yp * qty, 2)
    value_kes = round(value_yuan / yuan_to_usd * usd_to_kes, 2)
    return value_yuan, value_kes

def _recv_sheet_price_key(s):
    """Derive the fabric_po_pricing_items price_key for a receiving sheet row."""
    sfc = s.get("supplier_fabric_code") or None
    pid = s.get("product_id")
    if sfc:
        return f"code:{sfc}"
    derived = _derive_supplier_code(s.get("fabric_name") or "")
    if derived:
        return f"code:{derived}"
    return f"product:{pid}" if pid else None

def _recv_dl_row(r, value_yuan=None, value_kes=None):
    def _n(v):
        return float(v) if v not in (None, "") else None
    sw, sl = _recv_dl_shrink_cells(r)
    return [int(r["roll_no"]), _n(r["qty_kg"]), _n(r["qty_mtrs"]),
            value_yuan, value_kes,
            _n(r.get("length_yards")), sw, sl,
            (r.get("bleeding_test") or ""), _n(r.get("width_measured_m")),
            (r.get("quality_status") or "Pending"),
            (r.get("quality_notes") or "")]

def _recv_build_xlsx(sheets, by_sheet, pricing):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = "Receiving Sheet"
    bold = Font(bold=True)
    po_name = sheets[0].get("po_name") or f"PO {sheets[0].get('po_id')}"
    ws.append([f"Fabric Receiving Sheet — {po_name}"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"PO date: {sheets[0].get('po_date') or '—'}"])
    ws.append([])
    y2u = pricing.get("yuan_to_usd")
    u2k = pricing.get("usd_to_kes")
    direct = bool(pricing.get("direct_kes"))
    for s in sheets:
        ws.append([f"{s.get('fabric_name') or ''}"
                   + (f"  [{s.get('barcode')}]" if s.get("barcode") else "")])
        ws.cell(row=ws.max_row, column=1).font = bold
        ws.append([f"Received by {s.get('created_by_name') or '—'} "
                   f"on {s.get('created_at') or '—'}"
                   + (f" — note: {s.get('note')}" if s.get("note") else "")])
        ws.append(_RECV_DL_HEADERS)
        for c in range(1, len(_RECV_DL_HEADERS) + 1):
            ws.cell(row=ws.max_row, column=c).font = bold
        pkey = _recv_sheet_price_key(s)
        item = pricing["items"].get(pkey) if pkey else None
        if item is None and pkey and pkey.startswith("code:"):
            item = pricing["items"].get("derived:" + pkey[5:])
        total_kg = 0.0
        total_yuan = 0.0
        total_kes = 0.0
        has_yuan = False
        has_kes = False
        for r in by_sheet.get(s["id"], []):
            vy, vk = _recv_roll_value(r, item, y2u, u2k, direct)
            ws.append(_recv_dl_row(r, vy, vk))
            total_kg += float(r["qty_kg"] or 0)
            if vy is not None:
                total_yuan += vy
                has_yuan = True
            if vk is not None:
                total_kes += vk
                has_kes = True
        tm = s.get("total_mtrs")
        ws.append(["Total", round(total_kg, 3),
                   float(tm) if tm not in (None, "") else None,
                   ("Local (KES)" if direct
                    else (round(total_yuan, 2) if has_yuan else None)),
                   round(total_kes, 2) if has_kes else None])
        ws.cell(row=ws.max_row, column=1).font = bold
        ws.cell(row=ws.max_row, column=2).font = bold
        ws.append([])
    widths = [8, 10, 10, 14, 14, 13, 16, 16, 16, 10, 10, 30]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

def _recv_build_pdf(sheets, by_sheet, pricing):
    import io
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                    Paragraph, Spacer)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4),
                            leftMargin=12*mm, rightMargin=12*mm,
                            topMargin=12*mm, bottomMargin=12*mm)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=14,
                        textColor=colors.HexColor("#1a5c38"))
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=11)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8,
                           textColor=colors.HexColor("#555555"))
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=8)
    po_name = sheets[0].get("po_name") or f"PO {sheets[0].get('po_id')}"
    story = [Paragraph(f"Fabric Receiving Sheet — {po_name}", h1),
             Paragraph(f"PO date: {sheets[0].get('po_date') or '—'}", small),
             Spacer(1, 4*mm)]
    y2u = pricing.get("yuan_to_usd")
    u2k = pricing.get("usd_to_kes")
    direct = bool(pricing.get("direct_kes"))
    for s in sheets:
        title = (s.get("fabric_name") or "") + \
                (f"  [{s.get('barcode')}]" if s.get("barcode") else "")
        story.append(Paragraph(title, h2))
        story.append(Paragraph(
            f"Received by {s.get('created_by_name') or '—'} on "
            f"{s.get('created_at') or '—'}"
            + (f" — note: {s.get('note')}" if s.get("note") else ""), small))
        pkey = _recv_sheet_price_key(s)
        item = pricing["items"].get(pkey) if pkey else None
        if item is None and pkey and pkey.startswith("code:"):
            item = pricing["items"].get("derived:" + pkey[5:])
        data = [_RECV_DL_HEADERS]
        total_kg = 0.0
        total_yuan = 0.0
        total_kes = 0.0
        has_yuan = False
        has_kes = False
        for r in by_sheet.get(s["id"], []):
            vy, vk = _recv_roll_value(r, item, y2u, u2k, direct)
            row = _recv_dl_row(r, vy, vk)
            row[-1] = Paragraph(str(row[-1]), cell)
            data.append(["" if v is None else v for v in row])
            total_kg += float(r["qty_kg"] or 0)
            if vy is not None:
                total_yuan += vy
                has_yuan = True
            if vk is not None:
                total_kes += vk
                has_kes = True
        tm = s.get("total_mtrs")
        data.append(["Total", round(total_kg, 3),
                     "" if tm in (None, "") else float(tm),
                     ("Local (KES)" if direct
                      else (round(total_yuan, 2) if has_yuan else "")),
                     round(total_kes, 2) if has_kes else "",
                     "", "", "", "", "", "", ""])
        t = Table(data, repeatRows=1,
                  colWidths=[12*mm, 15*mm, 15*mm, 22*mm, 22*mm,
                             18*mm, 22*mm, 22*mm, 25*mm, 15*mm,
                             16*mm, 69*mm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a5c38")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -2),
             [colors.white, colors.HexColor("#f6f4ef")]),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(t)
        story.append(Spacer(1, 6*mm))
    doc.build(story)
    return buf.getvalue()

@fabric_router.get("/api/fabric/receiving/po-batch-download")
def receiving_po_batch_download(po_id: int = Query(...),
                                fmt: str = Query(default="pdf")):
    """Download the FULL receiving sheet of one PO as a PDF or Excel file."""
    fmt = (fmt or "pdf").lower()
    if fmt not in ("pdf", "xlsx"):
        raise HTTPException(status_code=400, detail="fmt must be pdf or xlsx")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        sheets, by_sheet, pricing = _recv_download_data(conn, po_id)
    po_name = (sheets[0].get("po_name") or f"PO-{po_id}").replace("/", "-")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", po_name)
    try:
        if fmt == "xlsx":
            payload = _recv_build_xlsx(sheets, by_sheet, pricing)
            media = ("application/vnd.openxmlformats-officedocument"
                     ".spreadsheetml.sheet")
            fname = f"receiving_{safe}.xlsx"
        else:
            payload = _recv_build_pdf(sheets, by_sheet, pricing)
            media = "application/pdf"
            fname = f"receiving_{safe}.pdf"
    except ModuleNotFoundError as e:
        raise HTTPException(
            status_code=500,
            detail=(f"{'PDF' if fmt == 'pdf' else 'Excel'} library "
                    f"unavailable on server ({e.name}); contact admin."))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=(f"Could not build the "
                    f"{'PDF' if fmt == 'pdf' else 'Excel'} sheet: {e}"))
    from fastapi import Response
    return Response(content=payload, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{fname}"'})

# ── Receiving → Odoo draft-PO link & write-back ─────────────────────
# The receiving flow can tie sheets to a DRAFT Odoo purchase order and later
# push the summed received quantities back onto that PO's lines. This is the
# fabric surface's FIRST Odoo WRITE-back, so it is deliberately narrow:
#   * upload SETS purchase.order.line.product_qty to the summed received total
#     (idempotent — re-uploading after more sheets arrive just re-sets totals);
#   * quantities go in the LINE's OWN unit (kg pushed as-is; metre lines
#     converted via the live kg_per_mtr_eff); anything else is BLOCKED, never
#     guessed;
#   * products received but missing from the PO get a NEW line (product's own
#     purchase unit + default cost price), flagged for review;
#   * confirming the PO / receipts / pickings / price changes stay in Odoo.
# Every push (including failures) is audited in fabric_po_uploads.

def _odoo_env():
    url = (os.environ.get("ODOO_URL") or "").rstrip("/")
    db = os.environ.get("ODOO_DB")
    user = os.environ.get("ODOO_USER")
    pwd = os.environ.get("ODOO_PASSWORD")
    if not (url and db and user and pwd):
        raise HTTPException(status_code=503,
            detail="Odoo credentials are not configured on this server "
                   "(ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD)")
    return url, db, user, pwd

def _odoo_connect(timeout=40):
    """Authenticated XML-RPC session (db, uid, pwd, models proxy) with a real
    socket timeout on every call, so a slow/unreachable Odoo can never hang an
    API worker. 502 with a clear message on any connection/auth failure."""
    import xmlrpc.client
    from urllib.parse import urlparse
    url, db, user, pwd = _odoo_env()
    base_cls = (xmlrpc.client.SafeTransport
                if urlparse(url).scheme == "https" else xmlrpc.client.Transport)

    class _TimeoutTransport(base_cls):
        def make_connection(self, host):
            c = base_cls.make_connection(self, host)
            c.timeout = timeout
            return c

    try:
        common = xmlrpc.client.ServerProxy(
            f"{url}/xmlrpc/2/common", transport=_TimeoutTransport(),
            allow_none=True)
        uid = common.authenticate(db, user, pwd, {})
        if not uid:
            raise HTTPException(status_code=502,
                                detail="Odoo authentication failed")
        models = xmlrpc.client.ServerProxy(
            f"{url}/xmlrpc/2/object", transport=_TimeoutTransport(),
            allow_none=True)
        return db, uid, pwd, models
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Could not reach Odoo: {e}")

def _odoo_kw(models, db, uid, pwd, model, method, args, kw=None):
    """execute_kw that surfaces the ACTUAL Odoo error message verbatim (the
    last line of the server fault, which is Odoo's human-readable reason)."""
    import xmlrpc.client
    try:
        return models.execute_kw(db, uid, pwd, model, method, args, kw or {})
    except xmlrpc.client.Fault as f:
        msg = (f.faultString or "").strip()
        lines = [ln.strip() for ln in msg.splitlines() if ln.strip()]
        raise HTTPException(status_code=502,
            detail="Odoo error: " + (lines[-1] if lines else str(f.faultCode)))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Odoo request failed: {e}")

def _recv_read_po(odoo, po_id, require_draft=True):
    """One PO header, live from Odoo. 404 when it no longer exists; 400 when a
    draft is required but the PO has moved on (state surfaced verbatim)."""
    db, uid, pwd, models = odoo
    rows = _odoo_kw(models, db, uid, pwd, "purchase.order", "search_read",
                    [[["id", "=", int(po_id)]]],
                    {"fields": ["name", "state", "date_order", "partner_id"],
                     "limit": 1})
    if not rows:
        raise HTTPException(status_code=404,
            detail=f"Purchase order {po_id} no longer exists in Odoo")
    p = rows[0]
    if require_draft and p.get("state") != "draft":
        raise HTTPException(status_code=400,
            detail=f"PO {p.get('name')} is no longer a draft in Odoo "
                   f"(state: {p.get('state')}) — quantities were NOT uploaded")
    return {"po_id": p["id"], "name": p.get("name"),
            "supplier": (p.get("partner_id") or [None, ""])[1] or "",
            "date_order": (p.get("date_order") or "")[:10] or None,
            "state": p.get("state")}

def _recv_fetch_draft_po(po_id):
    """Validate a PO link at save time: connect + require it to still be draft."""
    return _recv_read_po(_odoo_connect(), po_id, require_draft=True)

def _po_uom_kind(uom_name):
    """Classify a PO line's unit into 'kg' / 'm' (metres) / None (unsupported).
    Quantities are always pushed in the line's OWN unit; an unrecognised unit
    blocks that product from upload rather than guessing a conversion."""
    n = (uom_name or "").strip().lower()
    if not n:
        return None
    if "kg" in n or "kilo" in n:
        return "kg"
    if n in ("m", "mt", "mtr", "mtrs") or "met" in n:
        return "m"
    return None

_PO_QUOTE_UNITS = ("kg", "m")

def _recv_po_num(v):
    """Positive float or None (pricing inputs: NULL/0/garbage all mean 'not set')."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None

def _recv_po_pricing(conn, po_id):
    """The saved pricing for one PO: the two FX rates + the per-price-key
    prices/quote units, normalized (only positive numbers count as set).
    direct_kes marks a whole-PO local purchase: yuan_price then holds the
    KES price and the FX rates are ignored."""
    head_rows = q(conn, """
        SELECT yuan_to_usd, usd_to_kes, direct_kes, updated_by_name,
               to_char(updated_at AT TIME ZONE 'Africa/Nairobi',
                       'DD Mon YYYY, HH24:MI') as updated_at
        FROM fabric_po_pricing WHERE po_id=%s
    """, (po_id,))
    item_rows = q(conn, """
        SELECT price_key, yuan_price, quote_unit
        FROM fabric_po_pricing_items WHERE po_id=%s
    """, (po_id,))
    head = head_rows[0] if head_rows else {}
    return {
        "yuan_to_usd": _recv_po_num(head.get("yuan_to_usd")),
        "usd_to_kes": _recv_po_num(head.get("usd_to_kes")),
        "direct_kes": bool(head.get("direct_kes")),
        "updated_by_name": head.get("updated_by_name"),
        "updated_at": head.get("updated_at"),
        "items": {r["price_key"]: {
                      "yuan_price": _recv_po_num(r["yuan_price"]),
                      "quote_unit": (r["quote_unit"]
                                     if r["quote_unit"] in _PO_QUOTE_UNITS
                                     else "kg")}
                  for r in item_rows},
    }

def _derive_supplier_code(product_name: str):
    """Extract a supplier fabric code from a product name when Odoo has none
    set.  Convention: '<supplier> <code> - <colour>'; split on the LAST ' - '
    and return the trimmed left part as the derived code.  Returns None when
    no ' - ' separator is present (name cannot be parsed)."""
    if not product_name:
        return None
    idx = product_name.rfind(" - ")
    if idx < 0:
        return None
    return product_name[:idx].strip() or None


def _recv_pricing_groups(plan):
    """Group the plan's products by price key for the pricing form: products
    sharing a Supplier Fabric Code share one Yuan price row; code-less fabrics
    get their own row keyed by product."""
    groups, order = {}, []
    for e in plan:
        key = e.get("price_key")
        if not key:
            continue
        g = groups.get(key)
        if g is None:
            sfc = e.get("supplier_fabric_code")
            dc  = e.get("derived_code")
            g = {"price_key": key,
                 "code": sfc or dc,
                 "_all_derived": not sfc and bool(dc),
                 "yuan_price": e.get("yuan_price"),
                 "quote_unit": e.get("quote_unit") or "kg",
                 "products": []}
            groups[key] = g
            order.append(key)
        else:
            if e.get("supplier_fabric_code"):
                g["_all_derived"] = False
        g["products"].append({
            "product_id": e.get("product_id"),
            "fabric_name": e.get("fabric_name"),
            "barcode": e.get("barcode"),
            "line_uom": e.get("line_uom"),
            "line_kind": _po_uom_kind(e.get("line_uom")),
            "kg_per_mtr": e.get("kg_per_mtr"),
            "action": e.get("action"),
            "no_code_no_dash": e.get("no_code_no_dash", False),
        })
    out = []
    for k in order:
        g = groups[k]
        g["is_derived"] = g.pop("_all_derived")
        out.append(g)
    return out

def _recv_po_plan(conn, odoo, po_id):
    """Build the per-product upload plan for a PO batch: summed sheet totals
    (kg always; metres via the LIVE kg_per_mtr_eff), the matching PO line,
    exactly what would be pushed in the line's own unit AND the KES unit price
    computed from the saved per-PO pricing (Yuan via the two FX rates, or the
    entered price as-is on a direct-KES local PO). Returns (plan, po_lines,
    pricing) where po_lines is the PO's current lines for display."""
    db, uid, pwd, models = odoo
    line_rows = _odoo_kw(models, db, uid, pwd, "purchase.order.line",
                         "search_read", [[["order_id", "=", int(po_id)]]],
                         {"fields": ["product_id", "product_qty",
                                     "product_uom", "qty_received"]})
    po_lines, by_product = [], {}
    for l in line_rows:
        pid = (l.get("product_id") or [None])[0]
        po_lines.append({
            "line_id": l["id"],
            "product_id": pid,
            "product_name": (l.get("product_id") or [None, ""])[1] or "",
            "qty": l.get("product_qty"),
            "uom": (l.get("product_uom") or [None, ""])[1] or "",
            "qty_received": l.get("qty_received"),
        })
        if pid is not None:
            by_product.setdefault(int(pid), []).append(l)
    totals = q(conn, """
        SELECT s.product_id,
               MAX(s.fabric_name)    as fabric_name,
               MAX(s.barcode)        as barcode,
               COUNT(*)              as sheets,
               SUM(s.total_kg)       as total_kg,
               MAX(p.kg_per_mtr_eff) as kg_per_mtr,
               MAX(NULLIF(BTRIM(p.supplier_fabric_code),''))
                                     as supplier_fabric_code
        FROM fabric_receiving_sheets s
        LEFT JOIN raw_fabric_products p ON p.id = s.product_id
        WHERE s.po_id=%s AND s.deleted_at IS NULL
        GROUP BY s.product_id
        ORDER BY MAX(s.fabric_name)
    """, (po_id,))
    pricing = _recv_po_pricing(conn, po_id)
    # Products needing a NEW PO line → read their purchase unit + default cost
    # from Odoo once (active_test False so an archived product still resolves).
    missing = [int(t["product_id"]) for t in totals
               if int(t["product_id"]) not in by_product]
    prod_info = {}
    if missing:
        prows = _odoo_kw(models, db, uid, pwd, "product.product",
                         "search_read", [[["id", "in", missing]]],
                         {"fields": ["display_name", "uom_po_id", "uom_id",
                                     "standard_price"],
                          "context": {"active_test": False}})
        for pr in prows:
            uom = pr.get("uom_po_id") or pr.get("uom_id") or [None, ""]
            prod_info[int(pr["id"])] = {
                "name": pr.get("display_name") or "",
                "uom_id": uom[0], "uom": uom[1] or "",
                "price": pr.get("standard_price") or 0,
            }
    plan = []
    for t in totals:
        pid = int(t["product_id"])
        kg = round(float(t["total_kg"] or 0), 3)
        kpm = t.get("kg_per_mtr")
        kpm = float(kpm) if kpm not in (None, "") and float(kpm) > 0 else None
        mtrs = round(kg / kpm, 1) if kpm else None
        sfc = t.get("supplier_fabric_code") or None
        derived_code = None
        no_code_no_dash = False
        if sfc is None:
            derived_code = _derive_supplier_code(t.get("fabric_name") or "")
            if derived_code is None:
                no_code_no_dash = True
        price_key = (f"code:{sfc}" if sfc
                     else (f"code:{derived_code}" if derived_code
                           else f"product:{pid}"))
        e = {"product_id": pid,
             "fabric_name": t.get("fabric_name"),
             "barcode": t.get("barcode"),
             "sheets": int(t.get("sheets") or 0),
             "total_kg": kg, "total_mtrs": mtrs,
             "kg_per_mtr": kpm,
             "supplier_fabric_code": sfc,
             "derived_code": derived_code,
             "no_code_no_dash": no_code_no_dash,
             "price_key": price_key,
             "yuan_price": None, "quote_unit": "kg",
             "push_price": None, "price_missing": False,
             "action": None, "flags": [],
             "line_id": None, "line_qty": None, "line_uom": None,
             "push_qty": None, "push_uom": None}
        _pkey = e["price_key"]
        it = pricing["items"].get(_pkey)
        if it is None and _pkey.startswith("code:"):
            it = pricing["items"].get("derived:" + _pkey[5:])
        it = it or {}
        e["yuan_price"] = it.get("yuan_price")
        e["quote_unit"] = it.get("quote_unit") or "kg"
        matches = by_product.get(pid, [])
        if matches:
            l = matches[0]
            uom = (l.get("product_uom") or [None, ""])[1] or ""
            e.update({"line_id": l["id"], "line_qty": l.get("product_qty"),
                      "line_uom": uom, "action": "update"})
            if len(matches) > 1:
                e["flags"].append(
                    f"{len(matches)} PO lines carry this product — only the "
                    "first is updated; review the PO in Odoo")
        else:
            info = prod_info.get(pid)
            if info is None:
                e["action"] = "blocked"
                e["flags"].append("product not found in Odoo")
                plan.append(e)
                continue
            uom = info["uom"]
            e.update({"action": "create", "line_uom": uom,
                      "_uom_id": info["uom_id"], "_price": info["price"],
                      "_odoo_name": info["name"]})
            e["flags"].append("not on the PO — a new line will be added "
                              "(review the price in Odoo)")
        kind = _po_uom_kind(e["line_uom"])
        if kind == "kg":
            e["push_qty"], e["push_uom"] = kg, e["line_uom"]
        elif kind == "m":
            if mtrs is None:
                e["action"] = "blocked"
                e["flags"].append(
                    "PO line is in metres but this fabric has no usable "
                    "kg→metre conversion — fix Width/GSM (or a stored kg/m) "
                    "in Odoo first")
            else:
                e["push_qty"], e["push_uom"] = mtrs, e["line_uom"]
        else:
            e["action"] = "blocked"
            e["flags"].append(
                f"unsupported unit '{e['line_uom'] or '?'}' — only kg / "
                "metre lines can be uploaded")
        # Price: quote → the PO line's OWN unit → KES. Yuan mode converts
        # via the two FX rates; direct-KES mode (local purchase) uses the
        # entered price as-is — no FX at all.
        # A cross-unit quote (per-kg on a metre line or per-metre on a kg
        # line) needs the fabric's live kg/m factor; without one the product
        # is BLOCKED (same pattern as the quantity block) — never guessed.
        # Missing rates / missing price do not block per-product; they
        # block the WHOLE upload (the pricing form must be completed first).
        if e["action"] in ("update", "create"):
            direct = pricing["direct_kes"]
            y2u, u2k = pricing["yuan_to_usd"], pricing["usd_to_kes"]
            yp, qu = e["yuan_price"], e["quote_unit"]
            if qu != kind and not kpm:
                e["action"] = "blocked"
                e["flags"].append(
                    f"price is quoted per {'metre' if qu == 'm' else 'kg'} "
                    f"but the PO line is in "
                    f"{'metres' if kind == 'm' else 'kg'} and this fabric "
                    "has no usable kg→metre conversion — fix Width/GSM "
                    "(or a stored kg/m) in Odoo first")
            elif yp is None or (not direct
                                and (y2u is None or u2k is None)):
                e["price_missing"] = True
                e["flags"].append(
                    "KES price not entered yet — complete the pricing form "
                    "before uploading" if direct else
                    "Yuan price / FX rates not entered yet — complete the "
                    "pricing form before uploading")
            else:
                unit_price = yp
                if qu == "kg" and kind == "m":
                    unit_price = yp * kpm
                elif qu == "m" and kind == "kg":
                    unit_price = yp / kpm
                if direct:
                    # Local purchase: the entered price IS the KES price.
                    e["push_price"] = round(unit_price, 4)
                else:
                    # yuan_to_usd is quoted as Yuan PER USD (e.g. 7.9998), so
                    # Yuan → USD is a DIVISION; USD → KES is a multiplication.
                    e["push_price"] = round(unit_price / y2u * u2k, 4)
        plan.append(e)
    return plan, po_lines, pricing

@fabric_router.get("/api/fabric/receiving/draft-pos")
def receiving_draft_pos(q_: str = Query(default="", alias="q"),
                        limit: int = Query(default=100)):
    """Draft purchase orders pulled LIVE from Odoo for the receiving PO picker
    (PO number, supplier, creation date, line count). The search term narrows
    by PO number or supplier name."""
    limit = max(1, min(int(limit or 100), 200))
    term = (q_ or "").strip()
    domain = [["state", "=", "draft"]]
    if term:
        domain = ["&", ["state", "=", "draft"],
                  "|", ["name", "ilike", term], ["partner_id", "ilike", term]]
    db, uid, pwd, models = _odoo_connect()
    pos = _odoo_kw(models, db, uid, pwd, "purchase.order", "search_read",
                   [domain],
                   {"fields": ["name", "partner_id", "date_order",
                               "order_line"],
                    "order": "date_order desc, id desc", "limit": limit})
    return {"items": [{
        "po_id": p["id"],
        "name": p.get("name"),
        "supplier": (p.get("partner_id") or [None, ""])[1] or "",
        "date_order": (p.get("date_order") or "")[:10] or None,
        "line_count": len(p.get("order_line") or []),
    } for p in pos]}

@fabric_router.get("/api/fabric/receiving/po-names")
def receiving_po_names(q_: str = Query(default="", alias="q"),
                       limit: int = Query(default=100)):
    """Distinct POs that have at least one receiving sheet (Postgres only).
    Used for the multi-select PO chip-input typeahead on the QC and Receiving
    tabs. Accepts an optional `q` param that ILIKE-matches po_name; ordered by
    po_date DESC. Only returns POs with actual sheets (not Odoo draft POs)."""
    limit = max(1, min(int(limit or 100), 200))
    term = (q_ or "").strip()
    where_extra = ""
    params: list = []
    if term:
        where_extra = " AND s.po_name ILIKE %s"
        params.append(f"%{term}%")
    params.append(limit)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            SELECT s.po_id,
                   MAX(s.po_name) AS po_name,
                   MAX(s.po_date) AS po_date
            FROM fabric_receiving_sheets s
            WHERE s.po_id IS NOT NULL AND s.deleted_at IS NULL{where_extra}
            GROUP BY s.po_id
            ORDER BY MAX(s.po_date) DESC NULLS LAST, s.po_id DESC
            LIMIT %s
        """, tuple(params))
    return {"items": [{
        "po_id": r["po_id"],
        "po_name": r.get("po_name") or f"PO #{r['po_id']}",
        "po_date": r["po_date"].isoformat() if hasattr(r.get("po_date"), "isoformat") else (str(r["po_date"])[:10] if r.get("po_date") else None),
    } for r in rows]}

@fabric_router.get("/api/fabric/receiving/po-batches")
def receiving_po_batches(po_ids: str = Query(default="")):
    """POs that have at least one linked receiving sheet (Postgres only — no
    Odoo round-trip), with sheet/product counts, summed kgs and the latest
    upload attempt, for the batches table on the Receiving tab."""
    # Parse optional po_ids filter (comma-separated integers).
    _po_id_list: list = []
    for _p in (po_ids or "").split(","):
        _p = _p.strip()
        if _p.isdigit():
            _po_id_list.append(int(_p))
    _po_filter = " AND s.po_id = ANY(%s)" if _po_id_list else ""
    _po_params = (_po_id_list,) if _po_id_list else ()
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            WITH g AS (
                SELECT s.po_id,
                       MAX(s.po_name)  as po_name,
                       MAX(s.po_date)  as po_date,
                       COUNT(*)        as sheets,
                       COUNT(DISTINCT s.product_id) as products,
                       SUM(s.total_kg) as total_kg
                FROM fabric_receiving_sheets s
                WHERE s.po_id IS NOT NULL AND s.deleted_at IS NULL{_po_filter}
                GROUP BY s.po_id
            ),
            rc AS (
                SELECT s.po_id, COUNT(r.id) as rolls
                FROM fabric_receiving_sheets s
                JOIN fabric_receiving_rolls r
                     ON r.sheet_id = s.id AND r.deleted_at IS NULL
                WHERE s.po_id IS NOT NULL AND s.deleted_at IS NULL{_po_filter}
                GROUP BY s.po_id
            )
            SELECT g.po_id, g.po_name,
                   to_char(g.po_date, 'DD Mon YYYY') as po_date,
                   g.sheets, g.products, g.total_kg,
                   COALESCE(rc.rolls, 0) as rolls,
                   ps.id as sheet_no,
                   ps.delivery_approved_by,
                   ps.delivery_approved_by_email,
                   to_char(ps.delivery_approved_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as delivery_approved_at,
                   COALESCE(pq.q_pending, 0) as q_pending,
                   COALESCE(lots.lots_scored, 0) as lots_scored,
                   COALESCE(lots.lots_failed, 0) as lots_failed,
                   lu.status           as last_upload_status,
                   lu.uploaded_by_name as last_uploaded_by,
                   to_char(lu.uploaded_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as last_uploaded_at
            FROM g
            LEFT JOIN rc ON rc.po_id = g.po_id
            LEFT JOIN fabric_receiving_po_sheets ps ON ps.po_id = g.po_id
            LEFT JOIN LATERAL (
                SELECT COUNT(*) AS q_pending
                FROM fabric_receiving_rolls r2
                JOIN fabric_receiving_sheets s2 ON s2.id = r2.sheet_id
                WHERE s2.po_id = g.po_id
                  AND r2.deleted_at IS NULL AND s2.deleted_at IS NULL
                  AND (r2.quality_status IS NULL OR r2.quality_status = ''
                       OR r2.quality_status = 'Pending')
                  AND NOT EXISTS (
                      SELECT 1 FROM fabric_inspection_tickets t2
                      WHERE t2.sheet_id = r2.sheet_id
                        AND t2.roll_no  = r2.roll_no
                        AND t2.status   = 'Approved')
            ) pq ON true
            LEFT JOIN LATERAL (
                -- Lot (delivery-average) 4-Point acceptance per sheet:
                -- avg pts/100 sq.yd over each roll's latest Submitted ticket
                -- vs the sheet's lot limit (NULL = default 20).
                SELECT COUNT(*) AS lots_scored,
                       COUNT(*) FILTER (
                           WHERE l.avg_pp > COALESCE(l.lot_lim, 20)
                       ) AS lots_failed
                FROM (
                    SELECT s3.id, s3.lot_acceptable_limit AS lot_lim,
                           (SELECT AVG(x.points_per_100) FROM (
                                SELECT DISTINCT ON (t3.roll_no)
                                       t3.points_per_100
                                FROM fabric_inspection_tickets t3
                                WHERE t3.sheet_id = s3.id
                                  AND t3.status = 'Submitted'
                                ORDER BY t3.roll_no, t3.version DESC,
                                         t3.id DESC
                            ) x WHERE x.points_per_100 IS NOT NULL) AS avg_pp
                    FROM fabric_receiving_sheets s3
                    WHERE s3.po_id = g.po_id AND s3.deleted_at IS NULL
                ) l
                WHERE l.avg_pp IS NOT NULL
            ) lots ON true
            LEFT JOIN LATERAL (
                SELECT status, uploaded_by_name, uploaded_at
                FROM fabric_po_uploads u
                WHERE u.po_id = g.po_id
                ORDER BY u.id DESC LIMIT 1
            ) lu ON true
            ORDER BY g.po_date DESC NULLS LAST, g.po_id DESC
        """, _po_params + _po_params if _po_id_list else ())
        # Legacy sheets saved before the PO link became mandatory: surface
        # them as one "No PO" group row so they stay reachable (no upload).
        # When a PO filter is active, skip the no-PO group (it can't match).
        if _po_id_list:
            nopo = [{"sheets": 0}]
        else:
            nopo = q(conn, """
                SELECT COUNT(*)                    as sheets,
                       COUNT(DISTINCT s.product_id) as products,
                       SUM(s.total_kg)             as total_kg,
                       (SELECT COUNT(*) FROM fabric_receiving_rolls r
                        JOIN fabric_receiving_sheets s2 ON s2.id = r.sheet_id
                        WHERE s2.po_id IS NULL AND s2.deleted_at IS NULL
                          AND r.deleted_at IS NULL) as rolls
                FROM fabric_receiving_sheets s
                WHERE s.po_id IS NULL AND s.deleted_at IS NULL
            """)
        # Compute value_kes and value_yuan for each PO in one pass.
        all_po_ids = [int(r["po_id"]) for r in rows if r.get("po_id") is not None]
        kes_data, yuan_data = {}, {}
        direct_pos: set = set()
        if all_po_ids:
            # Per-(po_id, product_id) kg totals, kg_per_mtr and supplier_fabric_code.
            prod_totals = q(conn, """
                SELECT s.po_id, s.product_id,
                       SUM(s.total_kg) as total_kg,
                       MAX(p.kg_per_mtr_eff) as kg_per_mtr,
                       MAX(NULLIF(BTRIM(p.supplier_fabric_code),'')) as supplier_fabric_code,
                       MAX(COALESCE(p.name, s.fabric_name)) as fabric_name
                FROM fabric_receiving_sheets s
                LEFT JOIN raw_fabric_products p ON p.id = s.product_id
                WHERE s.po_id = ANY(%s) AND s.deleted_at IS NULL
                GROUP BY s.po_id, s.product_id
            """, (all_po_ids,))
            # MAX(price_unit) per (po_id, product_id) — same strategy as detail endpoint.
            pu_rows = q(conn, """
                SELECT po.po_id, po.product_id, MAX(po.price_unit) as price_unit
                FROM raw_fabric_purchase_orders po
                WHERE po.po_id = ANY(%s)
                GROUP BY po.po_id, po.product_id
            """, (all_po_ids,))
            pu_map = {(r["po_id"], r["product_id"]): r["price_unit"] for r in pu_rows}
            pitems: dict = {}
            for r in q(conn,
                "SELECT po_id, price_key, yuan_price, quote_unit"
                " FROM fabric_po_pricing_items WHERE po_id = ANY(%s)",
                (all_po_ids,)):
                pitems.setdefault(r["po_id"], {})[r["price_key"]] = r
            # Direct-KES POs (local purchases): no Yuan value exists at all —
            # the table shows a "Local (KES)" label instead.
            direct_pos = {int(r["po_id"]) for r in q(conn,
                "SELECT po_id FROM fabric_po_pricing"
                " WHERE direct_kes AND po_id = ANY(%s)", (all_po_ids,))}
            prod_by_po: dict = {}
            for pt in prod_totals:
                prod_by_po.setdefault(pt["po_id"], []).append(pt)
            # Compute value_kes and value_yuan using identical per-fabric arithmetic
            # as the detail endpoint — no pre-rounding so PO total = sum of fabric rows.
            for po_id in all_po_ids:
                items = pitems.get(po_id, {})
                products = prod_by_po.get(po_id, [])
                if not products:
                    kes_data[po_id] = None
                    yuan_data[po_id] = None
                    continue
                total_kes = 0.0
                total_yuan = 0.0
                kes_ok = True
                yuan_ok = True
                for pt in products:
                    pid = pt["product_id"]
                    kg = float(pt["total_kg"] or 0)
                    kpm_val = pt.get("kg_per_mtr")
                    try:
                        kpm = float(kpm_val) if kpm_val not in (None, "") and float(kpm_val) > 0 else None
                    except (TypeError, ValueError):
                        kpm = None
                    # KES
                    pu = pu_map.get((po_id, pid))
                    if pu is None:
                        kes_ok = False
                    elif kes_ok:
                        total_kes += float(pu) * kg
                    # Yuan
                    sfc = pt.get("supplier_fabric_code") or None
                    if sfc:
                        pkey = f"code:{sfc}"
                    else:
                        _dc = _derive_supplier_code(pt.get("fabric_name") or "")
                        pkey = f"code:{_dc}" if _dc else f"product:{pid}"
                    it = items.get(pkey)
                    if it is None and pkey.startswith("code:"):
                        it = items.get("derived:" + pkey[5:])
                    it = it or {}
                    yp = _recv_po_num(it.get("yuan_price"))
                    qu = it.get("quote_unit") if it.get("quote_unit") in _PO_QUOTE_UNITS else "kg"
                    if yp is None:
                        yuan_ok = False
                    elif yuan_ok:
                        if qu == "kg":
                            total_yuan += yp * kg
                        elif kpm is None:
                            yuan_ok = False
                        else:
                            total_yuan += yp * (kg / kpm)
                kes_data[po_id] = total_kes if kes_ok else None
                yuan_data[po_id] = (None if po_id in direct_pos
                                    else (total_yuan if yuan_ok else None))
    for r in rows:
        po_id = r.get("po_id")
        r["value_kes"] = kes_data.get(po_id) if po_id is not None else None
        r["value_yuan"] = yuan_data.get(po_id) if po_id is not None else None
        r["yuan_local"] = po_id is not None and int(po_id) in direct_pos
    no_po_group = None
    if nopo and int(nopo[0].get("sheets") or 0) > 0:
        no_po_group = {"po_id": None, "po_name": None, "po_date": None,
                       "sheets": int(nopo[0]["sheets"]),
                       "products": int(nopo[0]["products"] or 0),
                       "total_kg": nopo[0]["total_kg"],
                       "rolls": int(nopo[0].get("rolls") or 0),
                       "last_upload_status": None, "last_uploaded_by": None,
                       "last_uploaded_at": None,
                       "value_kes": None, "value_yuan": None}
    return {"items": rows, "no_po": no_po_group}


@fabric_router.get("/api/fabric/receiving/supplier-summary")
def receiving_supplier_summary(
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
):
    """Cross-PO supplier code summary for the Receiving tab.
    Groups all received sheets by (fabric_supplier_name, supplier_code)
    and returns rolls, kg, metres, KES value and Yuan value.
    date_from / date_to are optional YYYY-MM-DD filters on po_date."""
    date_where = ""
    date_params: list = []
    if date_from and date_from.strip():
        date_where += " AND s.po_date::date >= %s"
        date_params.append(date_from.strip())
    if date_to and date_to.strip():
        date_where += " AND s.po_date::date <= %s"
        date_params.append(date_to.strip())

    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        prod_rows = q(conn, f"""
            SELECT s.po_id,
                   s.product_id,
                   SUM(s.total_kg)                                               AS total_kg,
                   COUNT(r.id)                                                   AS rolls,
                   MAX(p.kg_per_mtr_eff)                                         AS kg_per_mtr,
                   MAX(NULLIF(BTRIM(p.supplier_fabric_code), ''))                AS supplier_fabric_code,
                   MAX(COALESCE(NULLIF(BTRIM(p.fabric_supplier_name), ''), ''))  AS fabric_supplier_name,
                   MAX(COALESCE(p.name, s.fabric_name))                          AS fabric_name
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            LEFT JOIN fabric_receiving_rolls r
                   ON r.sheet_id = s.id AND r.deleted_at IS NULL
            WHERE s.deleted_at IS NULL
              AND s.po_id IS NOT NULL{date_where}
            GROUP BY s.po_id, s.product_id
        """, date_params if date_params else ())

        if not prod_rows:
            return []

        all_po_ids = list({int(r["po_id"]) for r in prod_rows})

        pu_rows = q(conn, """
            SELECT po.po_id, po.product_id, MAX(po.price_unit) AS price_unit
            FROM raw_fabric_purchase_orders po
            WHERE po.po_id = ANY(%s)
            GROUP BY po.po_id, po.product_id
        """, (all_po_ids,))
        pu_map = {(r["po_id"], r["product_id"]): r["price_unit"] for r in pu_rows}

        pitems: dict = {}
        for r in q(conn,
            "SELECT po_id, price_key, yuan_price, quote_unit"
            " FROM fabric_po_pricing_items WHERE po_id = ANY(%s)",
            (all_po_ids,)):
            pitems.setdefault(r["po_id"], {})[r["price_key"]] = r

        # Direct-KES POs (local purchases): their entered prices are KES, so
        # they contribute NO Yuan value — the group gets a "Local (KES)"
        # indicator instead.
        ss_direct_pos = {int(r["po_id"]) for r in q(conn,
            "SELECT po_id FROM fabric_po_pricing"
            " WHERE direct_kes AND po_id = ANY(%s)", (all_po_ids,))}

    groups: dict = {}
    for pt in prod_rows:
        po_id = int(pt["po_id"])
        pid   = int(pt["product_id"])
        kg    = float(pt["total_kg"] or 0)
        rolls = int(pt["rolls"] or 0)

        kpm_val = pt.get("kg_per_mtr")
        try:
            kpm = float(kpm_val) if kpm_val not in (None, "") and float(kpm_val) > 0 else None
        except (TypeError, ValueError):
            kpm = None
        mtrs = (kg / kpm) if kpm else None

        sfc = pt.get("supplier_fabric_code") or None
        if sfc:
            supplier_code = sfc
        else:
            supplier_code = _derive_supplier_code(pt.get("fabric_name") or "") or ""

        supplier_name = pt.get("fabric_supplier_name") or ""
        group_key = (supplier_name, supplier_code)

        g = groups.get(group_key)
        if g is None:
            g = {"supplier": supplier_name, "supplier_code": supplier_code,
                 "rolls": 0, "total_kg": 0.0, "total_mtrs": 0.0,
                 "_mtrs_ok": True, "_kes_ok": True,
                 "_has_yuan": False,   # True once at least one entry has pricing
                 "_has_local": False,  # True once a direct-KES PO contributes
                 "value_kes": 0.0, "value_yuan": 0.0}
            groups[group_key] = g

        g["rolls"]    += rolls
        g["total_kg"] += kg
        if mtrs is None:
            g["_mtrs_ok"] = False
        else:
            g["total_mtrs"] += mtrs

        pu = pu_map.get((po_id, pid))
        if pu is None:
            g["_kes_ok"] = False
        elif g["_kes_ok"]:
            g["value_kes"] += float(pu) * kg

        items_po = pitems.get(po_id, {})
        if sfc:
            pkey = f"code:{sfc}"
        else:
            dc = _derive_supplier_code(pt.get("fabric_name") or "")
            pkey = f"code:{dc}" if dc else f"product:{pid}"
        it = items_po.get(pkey)
        if it is None and pkey.startswith("code:"):
            it = items_po.get("derived:" + pkey[5:])
        it = it or {}
        yp = _recv_po_num(it.get("yuan_price"))
        qu = it.get("quote_unit") if it.get("quote_unit") in _PO_QUOTE_UNITS else "kg"
        # Partial coverage is fine for Yuan: accumulate only priced entries;
        # return None only when NO entry for this (supplier, code) has any pricing.
        # Direct-KES POs never contribute Yuan (their prices ARE KES) — they
        # flag the group as containing local purchases instead.
        if po_id in ss_direct_pos:
            g["_has_local"] = True
        elif yp is not None:
            if qu == "kg":
                g["_has_yuan"] = True
                g["value_yuan"] += yp * kg
            elif kpm is not None:
                g["_has_yuan"] = True
                g["value_yuan"] += yp * (kg / kpm)
            # qu=="m" but kpm missing: skip this entry (partial is still fine)

    rows_out = []
    for g in groups.values():
        rows_out.append({
            "supplier":      g["supplier"],
            "supplier_code": g["supplier_code"],
            "rolls":         g["rolls"],
            "total_kg":      round(g["total_kg"], 2),
            "total_mtrs":    round(g["total_mtrs"], 1) if g["_mtrs_ok"] else None,
            "value_kes":     round(g["value_kes"], 2)  if g["_kes_ok"]  else None,
            "value_yuan":    round(g["value_yuan"], 2) if g["_has_yuan"] else None,
            "yuan_local":    g["_has_local"],
        })

    rows_out.sort(key=lambda r: (r["value_kes"] is None, -(r["value_kes"] or 0)))
    return rows_out


@fabric_router.get("/api/fabric/receiving/po-batch-detail")
def receiving_po_batch_detail(po_id: str = Query(default="")):
    """Inline drill-down for one PO group on the Receiving tab (Postgres only —
    no Odoo round-trip): the PO's fabrics with summed totals, each fabric's
    sheets, and each sheet's rolls (incl. quality). po_id is the Odoo PO id, or
    empty/"none" for the legacy "No PO" group (sheets saved without a PO)."""
    pid = (po_id or "").strip().lower()
    if pid in ("", "none", "null", "0"):
        where, params = "s.po_id IS NULL", []
    else:
        try:
            where, params = "s.po_id=%s", [int(pid)]
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="po_id must be a number")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        sheets = q(conn, f"""
            SELECT s.id, s.product_id,
                   COALESCE(NULLIF(BTRIM(p.barcode),''), NULLIF(BTRIM(p.default_code),''), s.barcode)     AS barcode,
                   COALESCE(p.name,    s.fabric_name) AS fabric_name,
                   s.total_kg, s.total_mtrs, s.rolls_count, s.note,
                   s.lot_acceptable_limit,
                   s.created_by_name, s.updated_by_name,
                   COALESCE(to_char(s.po_date, 'DD Mon YYYY'),
                            to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                                    'DD Mon YYYY')) as receiving_date,
                   to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as created_at,
                   to_char(s.updated_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as updated_at,
                   COALESCE(qc.pass_n,0)    as q_pass,
                   COALESCE(qc.fail_n,0)    as q_fail,
                   COALESCE(qc.inspected,0) as q_inspected
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            LEFT JOIN (
                SELECT sheet_id,
                       COUNT(*) FILTER (WHERE quality_status='Pass') as pass_n,
                       COUNT(*) FILTER (WHERE quality_status='Fail') as fail_n,
                       COUNT(*) FILTER (WHERE quality_status IN ('Pass','Fail')) as inspected
                FROM fabric_receiving_rolls WHERE deleted_at IS NULL
                GROUP BY sheet_id
            ) qc ON qc.sheet_id = s.id
            WHERE {where} AND s.deleted_at IS NULL
            ORDER BY s.created_at DESC, s.id DESC
        """, params)
        rolls = []
        if sheets:
            rolls = q(conn, """
                SELECT r.sheet_id, r.id as roll_id, r.roll_no,
                       r.qty_kg, r.qty_mtrs,
                       r.inv_kg, r.inv_mtrs,
                       r.quality_status, r.quality_notes,
                       r.length_yards, r.shrinkage_inches,
                       r.bleeding_test, r.width_measured_m,
                       r.after_wash_width_cm, r.after_wash_length_cm,
                       t.grade as insp_grade, t.version as insp_version,
                       t.points_per_100 as insp_points,
                       (t.approved_at IS NOT NULL) as insp_approved,
                       COALESCE(lt.missing_cuttable, false)
                           as insp_missing_cuttable
                FROM fabric_receiving_rolls r
                LEFT JOIN LATERAL (
                    SELECT grade, version, points_per_100, approved_at
                    FROM fabric_inspection_tickets t
                    WHERE t.sheet_id = r.sheet_id AND t.roll_no = r.roll_no
                      AND t.status = 'Submitted'
                    ORDER BY t.version DESC, t.id DESC LIMIT 1
                ) t ON TRUE
                LEFT JOIN LATERAL (
                    -- Missing-cuttable flag: the roll's LATEST ticket (ANY
                    -- status — Submitted/Approved included) scored on a
                    -- fallback width because no cuttable width was entered.
                    SELECT (lt0.cuttable_width_cm IS NULL
                            OR lt0.cuttable_width_cm <= 0) as missing_cuttable
                    FROM fabric_inspection_tickets lt0
                    WHERE lt0.sheet_id = r.sheet_id
                      AND lt0.roll_no = r.roll_no
                    ORDER BY lt0.version DESC, lt0.id DESC LIMIT 1
                ) lt ON TRUE
                WHERE r.sheet_id = ANY(%s) AND r.deleted_at IS NULL
                ORDER BY r.sheet_id, r.roll_no, r.id
            """, ([int(s["id"]) for s in sheets],))
        # Lock state + the who/what/when trail (roll changes merged with the
        # Odoo upload history, newest first) for this PO group.
        locked, audit, po_sheet = False, [], None
        # Value fields — populated for real POs only.
        detail_price_units: dict = {}   # product_id → price_unit (KES per unit)
        detail_pricing: dict = {}       # price_key → {yuan_price, quote_unit}
        detail_kpm: dict = {}           # product_id → kg_per_mtr_eff
        detail_sfc: dict = {}           # product_id → supplier_fabric_code
        detail_direct = False           # whole-PO direct-KES (local) purchase
        if params:  # a real PO id (not the legacy "No PO" group)
            ps = q(conn, """
                SELECT id, po_name,
                       to_char(po_date, 'DD Mon YYYY') as po_date,
                       created_by_name,
                       invoice_status,
                       to_char(created_at AT TIME ZONE 'Africa/Nairobi',
                               'DD Mon YYYY, HH24:MI') as created_at
                FROM fabric_receiving_po_sheets WHERE po_id=%s
            """, (params[0],))
            po_sheet = ps[0] if ps else None
            locked = _recv_po_locked(conn, params[0])
            audit = q(conn, """
                SELECT * FROM (
                    SELECT a.at, a.action, a.fabric_name, a.actor_name,
                           a.details,
                           to_char(a.at AT TIME ZONE 'Africa/Nairobi',
                                   'DD Mon YYYY, HH24:MI') as at_txt
                    FROM fabric_recv_audit a WHERE a.po_id=%s
                    UNION ALL
                    SELECT u.uploaded_at as at,
                           'odoo_upload' as action, NULL as fabric_name,
                           u.uploaded_by_name as actor_name,
                           jsonb_build_object('status', u.status) as details,
                           to_char(u.uploaded_at AT TIME ZONE 'Africa/Nairobi',
                                   'DD Mon YYYY, HH24:MI') as at_txt
                    FROM fabric_po_uploads u WHERE u.po_id=%s
                ) t ORDER BY t.at DESC LIMIT 60
            """, (params[0], params[0]))
            for a in audit:
                a.pop("at", None)
            # Load MAX(price_unit) per product for KES value — same strategy
            # as the batch endpoint so PO total = sum of fabric-row values exactly.
            pu_rows = q(conn, """
                SELECT po.product_id, MAX(po.price_unit) as price_unit
                FROM raw_fabric_purchase_orders po
                WHERE po.po_id = %s
                GROUP BY po.product_id
            """, (params[0],))
            detail_price_units = {r["product_id"]: r["price_unit"] for r in pu_rows}
            # Load Yuan pricing items for this PO.
            yi_rows = q(conn,
                "SELECT price_key, yuan_price, quote_unit"
                " FROM fabric_po_pricing_items WHERE po_id=%s", (params[0],))
            detail_pricing = {r["price_key"]: r for r in yi_rows}
            ph_rows = q(conn,
                "SELECT direct_kes FROM fabric_po_pricing WHERE po_id=%s",
                (params[0],))
            detail_direct = bool(ph_rows and ph_rows[0].get("direct_kes"))
            # kg_per_mtr and supplier_fabric_code per product.
            kpm_rows = q(conn, """
                SELECT p.id as product_id,
                       p.kg_per_mtr_eff,
                       NULLIF(BTRIM(p.supplier_fabric_code),'') as supplier_fabric_code
                FROM raw_fabric_products p
                WHERE p.id = ANY(%s)
            """, ([s["product_id"] for s in sheets if s.get("product_id")],))
            for r in kpm_rows:
                detail_kpm[r["product_id"]] = r.get("kg_per_mtr_eff")
                detail_sfc[r["product_id"]] = r.get("supplier_fabric_code")
    rolls_by_sheet = {}
    for r in rolls:
        qty_kg_v = r.get("qty_kg")
        qty_mtrs_v = r.get("qty_mtrs")
        inv_kg_v = r.get("inv_kg")
        inv_mtrs_v = r.get("inv_mtrs")
        try:
            delta_kg_v = (round(float(qty_kg_v) - float(inv_kg_v), 3)
                          if (qty_kg_v is not None and inv_kg_v is not None)
                          else None)
        except (TypeError, ValueError):
            delta_kg_v = None
        try:
            delta_mtrs_v = (round(float(qty_mtrs_v) - float(inv_mtrs_v), 3)
                            if (qty_mtrs_v is not None and inv_mtrs_v is not None)
                            else None)
        except (TypeError, ValueError):
            delta_mtrs_v = None
        row = {k: r[k] for k in ("roll_id", "roll_no", "qty_kg", "qty_mtrs",
                                  "inv_kg", "inv_mtrs",
                                  "quality_status", "quality_notes",
                                  "length_yards", "shrinkage_inches",
                                  "bleeding_test", "width_measured_m",
                                  "after_wash_width_cm", "after_wash_length_cm",
                                  "insp_grade", "insp_version", "insp_points",
                                  "insp_approved", "insp_missing_cuttable")}
        row["delta_kg"] = delta_kg_v
        row["delta_mtrs"] = delta_mtrs_v
        rolls_by_sheet.setdefault(r["sheet_id"], []).append(row)
    # Lot-level (delivery average) 4-Point summary, one per sheet.
    with _get_conn() as conn2:
        lot_by_sheet = _insp_lot_summaries(conn2,
                                           [int(s["id"]) for s in sheets])
    fabrics, order = {}, []
    for s in sheets:
        key = (s["product_id"], s.get("barcode") or "")
        g = fabrics.get(key)
        if g is None:
            g = {"product_id": s["product_id"],
                 "fabric_name": s.get("fabric_name"),
                 "barcode": s.get("barcode"),
                 "sheets_count": 0, "total_kg": 0.0,
                 "total_mtrs": 0.0, "mtrs_missing": False,
                 "rolls_count": 0, "q_pass": 0, "q_fail": 0, "q_pending": 0,
                 "sheets": []}
            fabrics[key] = g
            order.append(key)
        g["sheets_count"] += 1
        g["rolls_count"] += int(s.get("rolls_count") or 0)
        g["q_pass"] += int(s.get("q_pass") or 0)
        g["q_fail"] += int(s.get("q_fail") or 0)
        g["q_pending"] += max(int(s.get("rolls_count") or 0)
                              - int(s.get("q_inspected") or 0), 0)
        g["total_kg"] += float(s.get("total_kg") or 0)
        if s.get("total_mtrs") is None:
            g["mtrs_missing"] = True
        else:
            g["total_mtrs"] += float(s["total_mtrs"])
        sd = dict(s)
        sd["rolls"] = rolls_by_sheet.get(s["id"], [])
        sd["lot"] = lot_by_sheet.get(int(s["id"]))
        g["sheets"].append(sd)
        # 1 sheet per (PO, fabric) is guaranteed by the migration, so the
        # fabric group carries its (only) sheet's lot summary for the header.
        if g.get("lot") is None:
            g["lot"] = sd["lot"]
    out = []
    for key in order:
        g = fabrics[key]
        g["total_kg"] = round(g["total_kg"], 3)
        g["total_mtrs"] = None if g["mtrs_missing"] else round(g["total_mtrs"], 1)
        # Compute value_kes and value_yuan for this fabric group.
        pid = g.get("product_id")
        kg = g["total_kg"]
        pu = detail_price_units.get(pid)
        g["value_kes"] = float(pu) * kg if pu is not None else None
        sfc = detail_sfc.get(pid)
        if not sfc:
            _dc = _derive_supplier_code(g.get("fabric_name") or "")
            pkey = (f"code:{_dc}" if _dc
                    else (f"product:{pid}" if pid else None))
        else:
            pkey = f"code:{sfc}"
        if pkey:
            it = detail_pricing.get(pkey)
            if it is None and pkey.startswith("code:"):
                it = detail_pricing.get("derived:" + pkey[5:])
            it = it or {}
        else:
            it = {}
        yp = _recv_po_num(it.get("yuan_price"))
        qu = it.get("quote_unit") if it.get("quote_unit") in _PO_QUOTE_UNITS else "kg"
        # Direct-KES PO (local purchase): the entered prices are KES, so no
        # Yuan value exists — the UI shows a "Local (KES)" label instead.
        if detail_direct or yp is None:
            g["value_yuan"] = None
        elif qu == "kg":
            g["value_yuan"] = yp * kg
        else:
            kpm_val = detail_kpm.get(pid)
            try:
                kpm = float(kpm_val) if kpm_val not in (None, "") and float(kpm_val) > 0 else None
            except (TypeError, ValueError):
                kpm = None
            g["value_yuan"] = yp * (kg / kpm) if kpm else None
        out.append(g)
    out.sort(key=lambda g: (g.get("fabric_name") or "").lower())
    return {"fabrics": out, "locked": locked, "audit": audit,
            "po_sheet": po_sheet, "direct_kes": detail_direct}

@fabric_router.get("/api/fabric/receiving/po-batch/{po_id}")
def receiving_po_batch(po_id: int):
    """One PO batch for the review modal: the live PO header (any state — the
    UI disables upload when it is no longer draft), the per-product upload
    plan, the PO's current lines, the linked sheets and the latest upload."""
    odoo = _odoo_connect()
    po = _recv_read_po(odoo, po_id, require_draft=False)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        plan, po_lines, pricing = _recv_po_plan(conn, odoo, po_id)
        sheets = q(conn, """
            SELECT s.id, s.fabric_name, s.barcode, s.rolls_count,
                   s.total_kg, s.total_mtrs, s.created_by_name,
                   to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as created_at
            FROM fabric_receiving_sheets s
            WHERE s.po_id=%s AND s.deleted_at IS NULL
            ORDER BY s.created_at DESC, s.id DESC
        """, (po_id,))
        last = q(conn, """
            SELECT status, uploaded_by_name,
                   to_char(uploaded_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as uploaded_at
            FROM fabric_po_uploads WHERE po_id=%s
            ORDER BY id DESC LIMIT 1
        """, (po_id,))
        # Invoice status for this PO's delivery (bedan-only write, all can read).
        po_sheet_rows = q(conn,
                          "SELECT invoice_status FROM fabric_receiving_po_sheets "
                          "WHERE po_id=%s LIMIT 1", (po_id,))
        invoice_status = po_sheet_rows[0].get("invoice_status") if po_sheet_rows else None
    for e in plan:  # strip create-only internals from the response
        e.pop("_uom_id", None); e.pop("_price", None); e.pop("_odoo_name", None)
    pricing["groups"] = _recv_pricing_groups(plan)
    pricing.pop("items", None)  # the groups carry the saved values
    return {"po": po, "plan": plan, "lines": po_lines, "sheets": sheets,
            "pricing": pricing, "last_upload": last[0] if last else None,
            "invoice_status": invoice_status}

@fabric_router.post("/api/fabric/receiving/po-batch/{po_id}/pricing")
def receiving_po_pricing_save(po_id: int, request: Request,
                              body: dict = Body(...)):
    """Save the per-PO pricing form: the two FX rates (Yuan→USD and
    USD→KES) plus one price + quote unit per price key, and the whole-PO
    direct_kes flag (local purchase priced directly in KES — FX rates not
    required, the entered prices ARE KES). Values persist per PO (survive
    reload, reused on re-upload) and stay editable until the upload.
    Empty/zero inputs are stored as NULL ('not set yet')."""
    _recv_block_quality_only(request)
    direct_kes = bool(body.get("direct_kes"))
    price_word = "KES price" if direct_kes else "Yuan price"
    def _rate(name):
        v = body.get(name)
        if v in (None, ""):
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail=f"{name} must be a number")
        if not (f > 0):
            raise HTTPException(status_code=400,
                                detail=f"{name} must be greater than zero")
        return f
    y2u, u2k = _rate("yuan_to_usd"), _rate("usd_to_kes")
    items_in = body.get("items")
    if not isinstance(items_in, list):
        items_in = []
    items = []
    for i, it in enumerate(items_in, start=1):
        if not isinstance(it, dict):
            raise HTTPException(status_code=400,
                                detail=f"pricing row {i}: invalid entry")
        key = str(it.get("price_key") or "").strip()
        if key.startswith("derived:"):
            key = "code:" + key[8:]
        if not (key.startswith("code:") or key.startswith("product:")):
            raise HTTPException(status_code=400,
                                detail=f"pricing row {i}: bad price key")
        qu = str(it.get("quote_unit") or "kg").strip().lower()
        if qu not in _PO_QUOTE_UNITS:
            raise HTTPException(status_code=400,
                detail=f"pricing row {i}: unit must be per kg or per metre")
        yp = it.get("yuan_price")
        if yp in (None, ""):
            yp = None
        else:
            try:
                yp = float(yp)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400,
                    detail=f"pricing row {i}: {price_word} must be a number")
            if not (yp > 0):
                raise HTTPException(status_code=400,
                    detail=f"pricing row {i}: {price_word} must be greater "
                           "than zero")
        items.append((key, yp, qu))
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_po_pricing
                  (po_id, yuan_to_usd, usd_to_kes, direct_kes,
                   updated_by_name, updated_at)
                VALUES (%s,%s,%s,%s,%s,now())
                ON CONFLICT (po_id) DO UPDATE SET
                  yuan_to_usd=EXCLUDED.yuan_to_usd,
                  usd_to_kes=EXCLUDED.usd_to_kes,
                  direct_kes=EXCLUDED.direct_kes,
                  updated_by_name=EXCLUDED.updated_by_name,
                  updated_at=now()
            """, (po_id, y2u, u2k, direct_kes, name))
            # The form always posts the FULL set of rows for this PO, so a
            # delete + reinsert keeps the stored keys in lockstep with the
            # products actually on the batch (no stale leftovers).
            cur.execute("DELETE FROM fabric_po_pricing_items WHERE po_id=%s",
                        (po_id,))
            for key, yp, qu in items:
                cur.execute("""
                    INSERT INTO fabric_po_pricing_items
                      (po_id, price_key, yuan_price, quote_unit)
                    VALUES (%s,%s,%s,%s)
                """, (po_id, key, yp, qu))
        conn.commit()
    return {"ok": True}

def _recv_hq_analytic_id(odoo):
    """Resolve the 'HQ' analytic account in Odoo by name (case-insensitive
    exact match), once per upload. Fails loudly when it cannot be found so
    lines are never written without their analytic distribution."""
    db, uid, pwd, models = odoo
    rows = _odoo_kw(models, db, uid, pwd, "account.analytic.account",
                    "search_read", [[["name", "=ilike", "hq"]]],
                    {"fields": ["name"], "limit": 1})
    if not rows:
        raise HTTPException(status_code=502,
            detail='The "HQ" analytic account was not found in Odoo — '
                   "nothing was uploaded. Create (or rename) it under "
                   "Accounting → Analytic Accounts, then retry.")
    return int(rows[0]["id"])

@fabric_router.post("/api/fabric/receiving/po-batch/{po_id}/upload")
def receiving_po_upload(po_id: int, request: Request):
    """Push the batch's summed received quantities onto the draft PO in Odoo.
    Idempotent by design: each line's product_qty is SET to the summed total
    (not incremented), so re-uploading after more sheets arrive is safe. The
    PO must still be draft. Writes stop at the first Odoo error — what was
    already written and what was skipped is reported honestly, and every
    attempt (success or failure) is recorded in fabric_po_uploads."""
    _recv_block_quality_only(request)
    actor_id, actor_name = _fabric_actor(request)
    odoo = _odoo_connect()
    db, ouid, pwd, models = odoo
    po = _recv_read_po(odoo, po_id, require_draft=True)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        plan, _po_lines, pricing = _recv_po_plan(conn, odoo, po_id)
        if not plan:
            raise HTTPException(status_code=400,
                detail="No receiving sheets are linked to this PO yet")
        # Pricing gate: a price for every product that would actually be
        # pushed — plus BOTH FX rates in Yuan mode (direct-KES POs need no
        # FX) — must be in place before anything is written. Blocked
        # products (quantity or conversion blocks) are excluded — they
        # never reach Odoo anyway.
        direct = pricing["direct_kes"]
        missing_bits = []
        if not direct and (pricing["yuan_to_usd"] is None
                           or pricing["usd_to_kes"] is None):
            missing_bits.append("both FX rates (Yuan→USD and USD→KES)")
        unpriced = sorted({(e.get("fabric_name") or e.get("barcode")
                            or f"product {e['product_id']}")
                           for e in plan
                           if e["action"] in ("update", "create")
                           and e.get("push_price") is None})
        if unpriced:
            missing_bits.append(("a KES price for: " if direct
                                 else "a Yuan price for: ")
                                + ", ".join(unpriced))
        if missing_bits:
            raise HTTPException(status_code=400,
                detail="Pricing is incomplete — enter "
                       + " and ".join(missing_bits)
                       + " in the pricing form, then upload again. "
                       "Nothing was uploaded.")
        # Resolve the HQ analytic account ONCE per upload; a missing account
        # aborts before any line is touched (lines are never written without
        # their 100% HQ analytic distribution).
        hq_id = _recv_hq_analytic_id(odoo)
        # Every touched line gets the computed KES price, an explicitly
        # EMPTY tax set (command 5 = clear all, so the Taxes column stays
        # blank even when Odoo auto-applied a default) and 100% HQ.
        def _line_extras(e):
            return {"price_unit": e["push_price"],
                    "taxes_id": [[5, 0, 0]],
                    "analytic_distribution": {str(hq_id): 100}}
        results, error = [], None
        for e in plan:
            row = {k: e.get(k) for k in (
                "product_id", "fabric_name", "barcode", "sheets", "total_kg",
                "total_mtrs", "line_id", "line_qty", "line_uom",
                "push_qty", "push_uom", "push_price", "yuan_price",
                "quote_unit", "flags")}
            if error is not None:
                row["result"] = "skipped"
                results.append(row)
                continue
            if e["action"] == "blocked":
                row["result"] = "blocked"
                results.append(row)
                continue
            try:
                if e["action"] == "update":
                    vals = {"product_qty": e["push_qty"]}
                    vals.update(_line_extras(e))
                    _odoo_kw(models, db, ouid, pwd, "purchase.order.line",
                             "write", [[int(e["line_id"])], vals])
                    row["result"] = "updated"
                else:
                    vals = {"order_id": int(po_id),
                            "product_id": int(e["product_id"]),
                            "name": e.get("_odoo_name")
                                    or e.get("fabric_name") or "",
                            "product_qty": e["push_qty"],
                            "date_planned": datetime.datetime.utcnow()
                                            .strftime("%Y-%m-%d %H:%M:%S")}
                    vals.update(_line_extras(e))
                    if e.get("_uom_id"):
                        vals["product_uom"] = int(e["_uom_id"])
                    new_id = _odoo_kw(models, db, ouid, pwd,
                                      "purchase.order.line", "create", [vals])
                    row["result"] = "created"
                    row["line_id"] = new_id
            except HTTPException as ex:
                row["result"] = "error"
                row["error"] = str(ex.detail)
                error = str(ex.detail)
            results.append(row)
        pushed = [r for r in results if r["result"] in ("updated", "created")]
        status = ("failed" if error
                  else ("success" if pushed else "nothing_to_push"))
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_po_uploads
                  (po_id, po_name, status, summary,
                   uploaded_by, uploaded_by_name)
                VALUES (%s,%s,%s,%s,%s,%s)
            """, (po_id, po.get("name"), status,
                  psycopg2.extras.Json({
                      "results": results, "error": error,
                      "pricing": {"direct_kes": direct,
                                  "yuan_to_usd": pricing["yuan_to_usd"],
                                  "usd_to_kes": pricing["usd_to_kes"],
                                  "hq_analytic_id": hq_id}}),
                  actor_id, actor_name))
        conn.commit()
    _log_fabric_change("PO upload to Odoo", {
        "id": po_id, "product": po.get("name"), "style_name": "",
        "qty": round(sum(float(r.get("push_qty") or 0) for r in pushed), 2),
        "uom": "PO lines", "note": f"{len(pushed)} lines pushed ({status})",
        "status": status}, request)
    return {"ok": error is None, "po": po, "status": status,
            "error": error, "results": results}

# ── Landed Cost upload (draft stock.landed.cost in Odoo) ──────────────────
# Lets a buyer attach a DRAFT landed cost (clearing, duty, freight …) to a
# PO's receipt picking(s). The record is created in Odoo as a draft only —
# accounting reviews and validates it inside Odoo. Same auth model as the
# rest of /api/fabric/* (no extra role gating; the actor is logged).

_LC_PERM_MSG = (
    "The Odoo connection user is not allowed to access Landed Costs "
    "(stock.landed.cost) — this needs the 'Inventory / Administrator' "
    "access right. Ask your Odoo administrator to add that group to the "
    "API user, then retry. Nothing was created.")

def _lc_kw(odoo, model, method, args, kw=None):
    """Like _odoo_kw but keeps the FULL Odoo fault text so the landed-cost
    permission error can be mapped to an actionable message, and other Odoo
    validation errors surface readably instead of as a bare last line."""
    import xmlrpc.client as _x
    db, uid, pwd, models = odoo
    try:
        return models.execute_kw(db, uid, pwd, model, method, args, kw or {})
    except _x.Fault as f:
        msg = str(f.faultString or "")
        if "not allowed" in msg and "stock.landed.cost" in msg:
            raise HTTPException(status_code=403, detail=_LC_PERM_MSG)
        lines = [ln.strip() for ln in msg.splitlines() if ln.strip()]
        # Odoo tracebacks end with the human message; plain errors are 1 line.
        raise HTTPException(status_code=502,
            detail="Odoo said: " + (lines[-1] if lines else msg or "unknown error"))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Odoo request failed: {e}")

def _lc_record_url(lc_id):
    base = (os.environ.get("ODOO_URL") or "").rstrip("/")
    if not base or not lc_id:
        return None
    return f"{base}/web#id={int(lc_id)}&model=stock.landed.cost&view_type=form"

# The five standard Odoo split methods — the fallback when the live
# fields_get call is blocked for the API user (labels match stock's own).
_LC_SPLIT_METHODS_FALLBACK = [
    ("equal", "Equal"),
    ("by_quantity", "By Quantity"),
    ("by_current_cost_price", "By Current Cost"),
    ("by_weight", "By Weight"),
    ("by_volume", "By Volume"),
]
_LC_SPLIT_DEFAULT = "by_current_cost_price"   # today's historical behaviour

def _lc_split_methods(odoo):
    """Split-method choices for landed-cost lines, read live from Odoo so
    values/labels match the instance (incl. any customised selection);
    falls back to the standard five when the call is blocked or malformed."""
    try:
        fg = _lc_kw(odoo, "stock.landed.cost.lines", "fields_get",
                    [["split_method"]], {"attributes": ["selection"]})
        sel = ((fg or {}).get("split_method") or {}).get("selection") or []
        out = [{"value": str(s[0]), "label": str(s[1])} for s in sel
               if isinstance(s, (list, tuple)) and len(s) == 2 and s[0]]
        if out:
            return out
    except Exception:
        pass
    return [{"value": v, "label": l} for v, l in _LC_SPLIT_METHODS_FALLBACK]

def _lc_cost_type_split_field(odoo):
    """Name of the product field holding a cost type's default split method
    (varies across Odoo versions), or None when the instance has neither."""
    try:
        fg = _lc_kw(odoo, "product.product", "fields_get",
                    [["split_method_landed_cost", "split_method"]],
                    {"attributes": ["type"]})
        for cand in ("split_method_landed_cost", "split_method"):
            if cand in (fg or {}):
                return cand
    except Exception:
        pass
    return None

def _lc_default_split(split_methods):
    """The default split method for new lines and for requests that don't
    send one (older/cached forms) — GUARANTEED to be one of the given
    choices: the historical By Current Cost when the instance offers it
    (always true on the standard-five fallback), else the instance's first
    choice. `split_methods` is never empty (see _lc_split_methods)."""
    vals = [s["value"] for s in split_methods]
    return _LC_SPLIT_DEFAULT if _LC_SPLIT_DEFAULT in vals else vals[0]

def _lc_po_and_pickings(odoo, po_id):
    """The PO header (any state) + its incoming (receipt) pickings. 404 when
    the PO does not exist; the caller decides what 'usable' means."""
    po_rows = _lc_kw(odoo, "purchase.order", "read", [[int(po_id)]],
                     {"fields": ["name", "partner_id", "state", "date_order",
                                 "picking_ids", "company_id"]})
    if not po_rows:
        raise HTTPException(status_code=404, detail="Purchase order not found in Odoo")
    po = po_rows[0]
    pickings = []
    if po.get("picking_ids"):
        rows = _lc_kw(odoo, "stock.picking", "search_read",
                      [[["id", "in", list(po["picking_ids"])]]],
                      {"fields": ["name", "state", "picking_type_id",
                                  "scheduled_date", "date_done", "company_id"]})
        for p in rows:
            ptype = p.get("picking_type_id") or []
            pickings.append({
                "id": p["id"], "name": p.get("name"),
                "state": p.get("state"),
                "type": ptype[1] if len(ptype) > 1 else "",
                "date_done": p.get("date_done") or None,
                "scheduled_date": p.get("scheduled_date") or None,
                "company_id": (p.get("company_id") or [None])[0],
                "usable": p.get("state") not in ("cancel", "draft"),
            })
    return {
        "po_id": int(po_id), "name": po.get("name"),
        "supplier": (po.get("partner_id") or [None, ""])[1],
        "state": po.get("state"), "date_order": po.get("date_order"),
        "company_id": (po.get("company_id") or [None])[0],
    }, pickings

@fabric_router.get("/api/fabric/receiving/landed-cost/options")
def landed_cost_options():
    """Form options: the landed-cost 'cost type' products (live from Odoo,
    landed_cost_ok=True, each with its own default split method when the
    instance has that product field), the split-method choices for cost
    lines, and the general journals with a suggested default (Miscellaneous
    Operations, Odoo's usual landed-cost journal)."""
    odoo = _odoo_connect()
    split_methods = _lc_split_methods(odoo)
    split_values = {s["value"] for s in split_methods}
    split_field = _lc_cost_type_split_field(odoo)
    prods = _lc_kw(odoo, "product.product", "search_read",
                   [[["landed_cost_ok", "=", True]]],
                   {"fields": ["display_name"]
                              + ([split_field] if split_field else []),
                    "order": "name",
                    "context": {"active_test": True}})
    journals = _lc_kw(odoo, "account.journal", "search_read",
                      [[["type", "=", "general"]]],
                      {"fields": ["name", "code"], "order": "name"})
    default_id = None
    for j in journals:
        if (j.get("name") or "").strip().lower() == "miscellaneous operations":
            default_id = j["id"]
            break
    if default_id is None and journals:
        default_id = journals[0]["id"]
    cost_types = []
    for p in prods:
        d = (p.get(split_field) or None) if split_field else None
        cost_types.append({"id": p["id"], "name": p["display_name"],
                           "default_split_method":
                               d if d in split_values else None})
    return {"cost_types": cost_types,
            "journals": [{"id": j["id"], "name": j["name"], "code": j["code"]}
                         for j in journals],
            "default_journal_id": default_id,
            "split_methods": split_methods,
            "default_split_method": _lc_default_split(split_methods)}

@fabric_router.get("/api/fabric/receiving/landed-cost/pos")
def landed_cost_pos(q_: str = Query(default="", alias="q"),
                    limit: int = Query(default=20)):
    """PO picker for the landed-cost form: purchase orders that HAVE at least
    one picking (a receipt exists only once the PO is confirmed), searchable
    by number or supplier, newest first."""
    odoo = _odoo_connect()
    dom = [["picking_ids", "!=", False]]
    term = (q_ or "").strip()
    if term:
        dom = ["&"] + dom + ["|", ["name", "ilike", term],
                             ["partner_id", "ilike", term]]
    rows = _lc_kw(odoo, "purchase.order", "search_read", [dom],
                  {"fields": ["name", "partner_id", "state", "date_order",
                              "picking_ids"],
                   "limit": max(1, min(int(limit or 20), 50)),
                   "order": "date_order desc, id desc"})
    return {"items": [{
        "po_id": r["id"], "name": r.get("name"),
        "supplier": (r.get("partner_id") or [None, ""])[1],
        "state": r.get("state"),
        "date_order": (r.get("date_order") or "")[:10],
        "receipts": len(r.get("picking_ids") or []),
    } for r in rows]}

@fabric_router.get("/api/fabric/receiving/landed-cost/po/{po_id}")
def landed_cost_po(po_id: int):
    """One PO for the landed-cost form: header, its receipt pickings, and any
    EXISTING landed costs already referencing those pickings (duplicate
    warning). When the Odoo user cannot read stock.landed.cost the pickings
    still load and `lc_access` flags the blocker so the UI can explain it
    up front instead of failing on submit."""
    odoo = _odoo_connect()
    po, pickings = _lc_po_and_pickings(odoo, po_id)
    existing, lc_access, lc_access_error = [], True, None
    pids = [p["id"] for p in pickings]
    if pids:
        try:
            rows = _lc_kw(odoo, "stock.landed.cost", "search_read",
                          [[["picking_ids", "in", pids]]],
                          {"fields": ["name", "state", "date", "amount_total",
                                      "picking_ids"]})
            for r in rows:
                existing.append({
                    "id": r["id"], "name": r.get("name"),
                    "state": r.get("state"), "date": r.get("date"),
                    "amount_total": r.get("amount_total"),
                    "picking_ids": [i for i in (r.get("picking_ids") or [])
                                    if i in pids],
                    "odoo_url": _lc_record_url(r["id"]),
                })
        except HTTPException as ex:
            if ex.status_code == 403:
                lc_access, lc_access_error = False, str(ex.detail)
            else:
                raise
    return {"po": po, "pickings": pickings, "existing": existing,
            "lc_access": lc_access, "lc_access_error": lc_access_error}

@fabric_router.post("/api/fabric/receiving/landed-cost")
def landed_cost_create(request: Request, body: dict = Body(...)):
    """Create a DRAFT stock.landed.cost in Odoo attached to the chosen receipt
    picking(s). Gate ordering: validate the whole payload first (400, nothing
    written), then re-verify the PO/pickings/options live in Odoo (still
    nothing written), and only then create. The record is NEVER validated
    here — accounting posts it in Odoo. If a landed cost already references
    one of the pickings, a 409 lists it unless `force` is true."""
    _recv_block_quality_only(request)
    # ── 1. Local payload validation (nothing touches Odoo yet) ──
    try:
        po_id = int(body.get("po_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="po_id is required")
    picking_ids = body.get("picking_ids")
    if not isinstance(picking_ids, list) or not picking_ids:
        raise HTTPException(status_code=400,
            detail="Select at least one receipt to attach the landed cost to")
    try:
        picking_ids = sorted({int(p) for p in picking_ids})
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="picking_ids must be numbers")
    date_s = str(body.get("date") or "").strip()
    try:
        datetime.datetime.strptime(date_s, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400,
                            detail="Enter the landed-cost date (YYYY-MM-DD)")
    try:
        journal_id = int(body.get("journal_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pick an account journal")
    description = str(body.get("description") or "").strip() or None
    lines_in = body.get("lines")
    if not isinstance(lines_in, list) or not lines_in:
        raise HTTPException(status_code=400, detail="Add at least one cost line")
    if len(lines_in) > 50:
        raise HTTPException(status_code=400, detail="At most 50 cost lines")
    lines = []
    for i, ln in enumerate(lines_in, start=1):
        if not isinstance(ln, dict):
            raise HTTPException(status_code=400, detail=f"Line {i}: invalid entry")
        try:
            pid = int(ln.get("product_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail=f"Line {i}: pick a cost type")
        mode = str(ln.get("mode") or "kes").strip().lower()
        if mode not in ("kes", "fx"):
            raise HTTPException(status_code=400,
                detail=f"Line {i}: amount mode must be KES or foreign currency")
        try:
            amount = float(ln.get("amount"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400,
                                detail=f"Line {i}: enter the amount")
        if not (amount > 0):
            raise HTTPException(status_code=400,
                detail=f"Line {i}: the amount must be greater than zero")
        if mode == "fx":
            try:
                rate = float(ln.get("fx_rate"))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400,
                    detail=f"Line {i}: enter the exchange rate to KES")
            if not (rate > 0):
                raise HTTPException(status_code=400,
                    detail=f"Line {i}: the exchange rate must be greater than zero")
            kes = round(amount * rate, 2)
        else:
            rate = None
            kes = round(amount, 2)
        if not (kes > 0):
            raise HTTPException(status_code=400,
                detail=f"Line {i}: the KES amount must be greater than zero")
        # Optional per-line split method — absent/blank (older or cached
        # forms) keeps today's default; values are checked against Odoo's
        # own selection later, once connected.
        sm = ln.get("split_method")
        split_method = (str(sm).strip() or None) if sm is not None else None
        lines.append({"product_id": pid,
                      "name": str(ln.get("name") or "").strip() or None,
                      "mode": mode, "amount": amount, "fx_rate": rate,
                      "kes": kes, "split_method": split_method})
    # ── 2. Live re-verification in Odoo (still nothing written) ──
    actor_id, actor_name = _fabric_actor(request)
    odoo = _odoo_connect()
    po, pickings = _lc_po_and_pickings(odoo, po_id)
    by_id = {p["id"]: p for p in pickings}
    usable = [p["id"] for p in pickings if p["usable"]]
    if not usable:
        raise HTTPException(status_code=400,
            detail=f"PO {po.get('name') or po_id} has no usable receipt yet — "
                   "the receipt is created when the PO is confirmed in Odoo. "
                   "Confirm the PO (and its receipt) first, then retry.")
    bad = [str(p) for p in picking_ids if p not in usable]
    if bad:
        names = ", ".join((by_id.get(int(b), {}) or {}).get("name") or b
                          for b in bad)
        raise HTTPException(status_code=400,
            detail=f"These receipts cannot take a landed cost (cancelled, "
                   f"draft or not on this PO): {names}")
    # Split methods must be ones Odoo's landed-cost lines accept. Absent →
    # the default (so requests from an older/cached form keep working);
    # the default is by construction one of the allowed values, and every
    # resulting value — defaulted or explicit — is validated against the
    # live set, no exceptions.
    split_methods = _lc_split_methods(odoo)
    allowed_sm = {s["value"] for s in split_methods}
    default_sm = _lc_default_split(split_methods)
    for i, l in enumerate(lines, start=1):
        if l["split_method"] is None:
            l["split_method"] = default_sm
        if l["split_method"] not in allowed_sm:
            raise HTTPException(status_code=400,
                detail=f"Line {i}: '{l['split_method']}' is not a valid "
                       "split method — allowed: "
                       + ", ".join(sorted(allowed_sm)))
    # Cost-type products must still be landed-cost products in Odoo.
    prod_ids = sorted({l["product_id"] for l in lines})
    prods = _lc_kw(odoo, "product.product", "search_read",
                   [[["id", "in", prod_ids]]],
                   {"fields": ["display_name", "landed_cost_ok"],
                    "context": {"active_test": False}})
    pmap = {p["id"]: p for p in prods}
    for l in lines:
        p = pmap.get(l["product_id"])
        if not p:
            raise HTTPException(status_code=400,
                detail=f"Cost type {l['product_id']} no longer exists in Odoo")
        if not p.get("landed_cost_ok"):
            raise HTTPException(status_code=400,
                detail=f"'{p.get('display_name')}' is not flagged as a "
                       "landed-cost product in Odoo any more")
        if not l["name"]:
            l["name"] = p.get("display_name") or ""
    # The journal must still be a general journal.
    jrows = _lc_kw(odoo, "account.journal", "search_read",
                   [[["id", "=", journal_id], ["type", "=", "general"]]],
                   {"fields": ["name"], "limit": 1})
    if not jrows:
        raise HTTPException(status_code=400,
            detail="The chosen journal is not a general journal in Odoo — "
                   "pick another one")
    # ── 3. Duplicate guard (this read also proves LC access) ──
    dup = _lc_kw(odoo, "stock.landed.cost", "search_read",
                 [[["picking_ids", "in", picking_ids]]],
                 {"fields": ["name", "state", "date", "amount_total"]})
    if dup and not body.get("force"):
        names = ", ".join(f"{d.get('name')} ({d.get('state')})" for d in dup)
        raise HTTPException(status_code=409,
            detail="A landed cost already references the selected receipt(s): "
                   f"{names}. Tick 'create anyway' if this is an additional, "
                   "intentional landed cost. Nothing was created.")
    # ── 4. Create the DRAFT landed cost (never validated from here) ──
    vals = {
        "date": date_s,
        "target_model": "picking",
        "account_journal_id": journal_id,
        "picking_ids": [[6, 0, picking_ids]],
        "cost_lines": [[0, 0, {
            "product_id": l["product_id"],
            "name": l["name"],
            "price_unit": l["kes"],
            "split_method": l["split_method"],
        }] for l in lines],
    }
    if description:
        vals["description"] = description
    company_id = (by_id.get(picking_ids[0], {}) or {}).get("company_id") \
                 or po.get("company_id")
    if company_id:
        vals["company_id"] = int(company_id)
    lc_id = _lc_kw(odoo, "stock.landed.cost", "create", [vals])
    lc = (_lc_kw(odoo, "stock.landed.cost", "read", [[int(lc_id)]],
                 {"fields": ["name", "state", "amount_total"]}) or [{}])[0]
    total_kes = round(sum(l["kes"] for l in lines), 2)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor() as cur:
            _recv_audit(cur, po_id, None, None, "landed_cost_created", {
                "lc_id": int(lc_id), "lc_name": lc.get("name"),
                "date": date_s, "journal_id": journal_id,
                "description": description,
                "picking_ids": picking_ids,
                "pickings": [by_id[p]["name"] for p in picking_ids
                             if p in by_id],
                "total_kes": total_kes,
                "lines": [{"product_id": l["product_id"], "name": l["name"],
                           "mode": l["mode"], "amount": l["amount"],
                           "fx_rate": l["fx_rate"], "kes": l["kes"],
                           "split_method": l["split_method"]}
                          for l in lines],
            }, actor_name)
        conn.commit()
    _log_fabric_change("Landed cost draft created", {
        "id": po_id, "product": po.get("name"), "style_name": "",
        "qty": total_kes, "uom": "KES",
        "note": f"{lc.get('name') or lc_id} · {len(lines)} cost lines (draft)",
        "status": "draft"}, request)
    return {"ok": True, "lc_id": int(lc_id), "name": lc.get("name"),
            "state": lc.get("state"), "amount_total": lc.get("amount_total"),
            "total_kes": total_kes, "odoo_url": _lc_record_url(lc_id),
            "po": po}

@fabric_router.get("/api/fabric/receiving/{sheet_id}")
def receiving_fetch(sheet_id: int):
    """One sheet + its rolls + the LIVE product-info block for reprinting.
    Rolls keep the metres computed with the conversion snapshotted at save time
    (historical record); the header product fields are re-read live so contact/
    source details stay current. Falls back to the stored name/barcode when the
    product row no longer exists."""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        sheets = q(conn, """
            SELECT s.id, s.product_id, s.barcode, s.fabric_name,
                   s.kg_per_mtr, s.total_kg, s.total_mtrs, s.rolls_count,
                   s.note, s.created_by, s.created_by_name, s.updated_by_name,
                   s.po_id, s.po_name,
                   to_char(s.po_date, 'DD Mon YYYY') as po_date,
                   COALESCE(to_char(s.po_date, 'DD Mon YYYY'),
                            to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                                    'DD Mon YYYY')) as receiving_date,
                   to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY') as created_date,
                   to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as created_at,
                   to_char(s.updated_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as updated_at
            FROM fabric_receiving_sheets s
            WHERE s.id=%s AND s.deleted_at IS NULL
        """, (sheet_id,))
        if not sheets:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        sheet = sheets[0]
        rolls = q(conn, """
            SELECT id as roll_id, roll_no, qty_kg, qty_mtrs,
                   inv_kg, inv_mtrs,
                   quality_status, quality_notes, quality_updated_by,
                   length_yards, shrinkage_inches,
                   bleeding_test, width_measured_m,
                   after_wash_width_cm, after_wash_length_cm,
                   defective_yards,
                   CASE WHEN length_yards IS NOT NULL AND defective_yards IS NOT NULL
                        THEN length_yards - defective_yards END AS okay_yards,
                   to_char(quality_updated_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as quality_updated_at
            FROM fabric_receiving_rolls
            WHERE sheet_id=%s AND deleted_at IS NULL
            ORDER BY roll_no, id
        """, (sheet_id,))
        prod = _recv_product_info(conn, sheet["product_id"]) or {
            "id": sheet["product_id"], "name": sheet["fabric_name"],
            "default_code": sheet["barcode"], "kg_per_mtr": sheet["kg_per_mtr"],
        }
    # Derive variance columns from the invoiced quantities (delta = received − invoiced).
    for r in rolls:
        qkg = r.get("qty_kg")
        qmt = r.get("qty_mtrs")
        ikg = r.get("inv_kg")
        imt = r.get("inv_mtrs")
        try:
            r["delta_kg"] = round(float(qkg) - float(ikg), 3) if (qkg is not None and ikg is not None) else None
        except (TypeError, ValueError):
            r["delta_kg"] = None
        try:
            r["delta_mtrs"] = round(float(qmt) - float(imt), 3) if (qmt is not None and imt is not None) else None
        except (TypeError, ValueError):
            r["delta_mtrs"] = None
    return {"sheet": sheet, "rolls": rolls, "fabric": prod,
            "quality_summary": _recv_quality_summary(rolls),
            "missing_conversion": sheet.get("kg_per_mtr") in (None, "")}

@fabric_router.post("/api/fabric/receiving/{sheet_id}/quality")
def receiving_update_quality(sheet_id: int, request: Request, body: dict = Body(...)):
    """Record per-roll quality inspection / testing results on a SAVED sheet.
    This is fillable by any signed-in fabric user AFTER the sheet exists (the
    rolls/quantities themselves stay locked to admins). Body:
      {"rolls":[{"roll_id":<id>, "status":"Pass|Fail|Pending"|"", "notes":"…",
                 "length_yards":n, "shrinkage_inches":n,
                 "bleeding_test":"…", "width_measured_m":n}]}
    (roll_no accepted as a fallback key). Each changed roll stamps who/when."""
    items = body.get("rolls")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="rolls list is required")
    _uid, name = _fabric_actor(request)
    can_edit_width = _recv_can_edit_width(request)
    is_admin = _recv_is_admin(request)
    u_req = getattr(request.state, "user", None) or {}
    req_user_id = str(u_req.get("user_id") or "")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        exists = q(conn, "SELECT id, fabric_name, po_id, created_by "
                         "FROM fabric_receiving_sheets "
                         "WHERE id=%s AND deleted_at IS NULL", (sheet_id,))
        if not exists:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        po_id = exists[0].get("po_id")
        sheet_created_by = exists[0].get("created_by")
        # For after_wash_width_cm: width_edit grant is required AND the user
        # must have received (created) this specific sheet.  Admins bypass both.
        can_edit_width_cm = is_admin or (
            can_edit_width and sheet_created_by == req_user_id)
        after_upload = _recv_po_locked(conn, po_id)
        updated = 0
        with conn.cursor() as cur:
            for it in items:
                if not isinstance(it, dict):
                    raise HTTPException(status_code=400, detail="invalid roll entry")
                status = (str(it.get("status") or "").strip() or None)
                if status is not None and status not in _RECV_QUALITY_STATUSES:
                    raise HTTPException(status_code=400,
                        detail=f"status must be one of {', '.join(_RECV_QUALITY_STATUSES)}")
                notes = (str(it.get("notes") or "").strip() or None)
                meas = _recv_parse_measurements(it)
                # width_measured_m and after_wash_width_cm are restricted fields
                # — silently preserve the stored value for users without
                # permission so their quality save never wipes the width.
                if not can_edit_width:
                    meas["width_measured_m"] = None  # placeholder; replaced below
                # after_wash_width_cm is managed exclusively via PATCH
                # /api/fabric/rolls/{id}/width — quality save never touches it.
                # Unconditionally set placeholder so it's always restored from DB.
                meas["after_wash_width_cm"] = None  # always overwritten from stored below
                roll_id = it.get("roll_id")
                roll_no = it.get("roll_no")
                # Look up the current values first so we can (a) skip no-op
                # writes and (b) audit the old -> new change.
                _q_cols = ("id, roll_no, quality_status, quality_notes, "
                           "length_yards, shrinkage_inches, bleeding_test, "
                           "width_measured_m, after_wash_width_cm, "
                           "after_wash_length_cm, defective_yards")
                if roll_id not in (None, ""):
                    old = q(conn, f"SELECT {_q_cols} "
                                  "FROM fabric_receiving_rolls "
                                  "WHERE id=%s AND sheet_id=%s "
                                  "AND deleted_at IS NULL",
                            (roll_id, sheet_id))
                elif roll_no not in (None, ""):
                    old = q(conn, f"SELECT {_q_cols} "
                                  "FROM fabric_receiving_rolls "
                                  "WHERE sheet_id=%s AND roll_no=%s "
                                  "AND deleted_at IS NULL",
                            (sheet_id, int(roll_no)))
                else:
                    raise HTTPException(status_code=400,
                        detail="each roll needs a roll_id or roll_no")
                if not old:
                    continue
                o = old[0]
                # Restore the stored width / after-wash width for users who
                # can't edit them, so their quality save is a no-op for those
                # fields.
                if not can_edit_width:
                    stored_w = o.get("width_measured_m")
                    meas["width_measured_m"] = (
                        float(stored_w) if stored_w not in (None, "") else None)
                # Always restore after_wash_width_cm from DB — it is ONLY
                # written by PATCH /api/fabric/rolls/{id}/width (never quality save).
                stored_w_cm = o.get("after_wash_width_cm")
                meas["after_wash_width_cm"] = (
                    float(stored_w_cm) if stored_w_cm not in (None, "") else None)
                # Parse and validate defective_yards (kept separate from
                # _RECV_MEAS_NUM because its upper bound depends on the
                # effective length_yards — either the new value or the stored one).
                raw_def = it.get("defective_yards")
                if raw_def in (None, ""):
                    def_yds = None
                else:
                    try:
                        def_yds = round(float(raw_def), 3)
                    except (TypeError, ValueError):
                        raise HTTPException(status_code=400,
                                            detail="defective_yards must be a number")
                    if def_yds < 0:
                        raise HTTPException(status_code=400,
                                            detail="defective_yards cannot be negative")
                    eff_ly = meas.get("length_yards")
                    if eff_ly is None:
                        stored_ly = o.get("length_yards")
                        eff_ly = float(stored_ly) if stored_ly not in (None, "") else None
                    if eff_ly is not None and def_yds > eff_ly:
                        raise HTTPException(status_code=422,
                            detail=f"defective_yards ({def_yds:.2f} yd) cannot exceed "
                                   f"length_yards ({eff_ly:.2f} yd)")
                stored_def = o.get("defective_yards")
                stored_def = round(float(stored_def), 3) if stored_def not in (None, "") else None
                def_yds_changed = ("defective_yards" in it) and (stored_def != def_yds)
                if not ("defective_yards" in it):
                    # Key absent from payload — preserve stored value so existing
                    # callers (e.g. quality modal) never accidentally clear it.
                    def_yds = stored_def
                if (o.get("quality_status") or None) == status and \
                   (o.get("quality_notes") or None) == notes and \
                   not _recv_meas_changed(o, meas) and \
                   not def_yds_changed:
                    continue  # no actual change: no write, no audit row
                # Changing the status of a roll that already has a SUBMITTED
                # 4-Point inspection ticket OVERRIDES the ticket's auto-set
                # grade — supervisor/admin only, always audited (with an
                # optional comment).
                override_tk = None
                if (o.get("quality_status") or None) != status:
                    override_tk = q(conn, """
                        SELECT ticket_no, version, grade
                        FROM fabric_inspection_tickets
                        WHERE sheet_id=%s AND roll_no=%s
                          AND status='Submitted'
                        ORDER BY version DESC, id DESC LIMIT 1
                    """, (sheet_id, o.get("roll_no")))
                    if override_tk and not _insp_can_approve(request):
                        raise HTTPException(status_code=403,
                            detail="This roll's Pass/Fail was set by a "
                                   "submitted 4-Point inspection ticket — "
                                   "only the QC supervisor or a fabric admin "
                                   "may override it")
                cur.execute("""
                    UPDATE fabric_receiving_rolls
                       SET quality_status=%s, quality_notes=%s,
                           length_yards=%s, shrinkage_inches=%s,
                           bleeding_test=%s, width_measured_m=%s,
                           after_wash_width_cm=%s, after_wash_length_cm=%s,
                           defective_yards=%s,
                           quality_updated_at=now(), quality_updated_by=%s
                     WHERE id=%s AND sheet_id=%s
                """, (status, notes,
                      meas["length_yards"], meas["shrinkage_inches"],
                      meas["bleeding_test"], meas["width_measured_m"],
                      meas["after_wash_width_cm"], meas["after_wash_length_cm"],
                      def_yds,
                      name, o["id"], sheet_id))
                updated += cur.rowcount
                if po_id is not None:
                    details = {"roll_no": o.get("roll_no"),
                               "old_status": o.get("quality_status"),
                               "new_status": status,
                               "old_notes": o.get("quality_notes"),
                               "new_notes": notes,
                               "measurements": {k: (float(v) if isinstance(v, (int, float)) else v)
                                                for k, v in meas.items()},
                               "after_upload": bool(after_upload)}
                    # A manual status change on a roll that already has a
                    # SUBMITTED 4-Point inspection ticket is an OVERRIDE of
                    # the ticket's auto-filled grade — flag it in the trail
                    # (fenced to supervisor/admin above).
                    if override_tk:
                        details["inspection_override"] = True
                        details["ticket_no"] = override_tk[0].get("ticket_no")
                        details["ticket_grade"] = override_tk[0].get("grade")
                        oc = str(it.get("override_comment") or "").strip()
                        if oc:
                            details["override_comment"] = oc[:500]
                    _recv_audit(cur, po_id, sheet_id,
                                exists[0].get("fabric_name"), "quality_updated",
                                details, name)
        conn.commit()
        _log_fabric_change("Receiving quality updated", {
            "id": sheet_id, "product": exists[0].get("fabric_name"),
            "style_name": "", "qty": updated, "uom": "rolls",
            "note": "quality results", "status": "quality",
        }, request)
    return {"ok": True, "updated": updated}

@fabric_router.patch("/api/fabric/rolls/{roll_id}/width")
async def roll_update_width(roll_id: int, request: Request):
    """Write after_wash_width_cm on a single roll. Requires the width_edit
    grant AND sheet ownership (created_by == caller) — or admin.
    Body: {"width_cm": <number>}"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    width_cm = body.get("width_cm")
    if width_cm is None:
        raise HTTPException(status_code=400, detail="width_cm is required")
    try:
        width_cm = float(width_cm)
        if width_cm <= 0 or width_cm > 500:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="width_cm must be a positive number (0–500)")
    _uid, name = _fabric_actor(request)
    is_admin = _recv_is_admin(request)
    can_edit_width = _recv_can_edit_width(request)
    u_req = getattr(request.state, "user", None) or {}
    req_user_id = str(u_req.get("user_id") or "")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rolls = q(conn, """
            SELECT r.id, r.sheet_id, r.roll_no, r.after_wash_width_cm,
                   s.created_by, s.fabric_name, s.po_id
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            WHERE r.id = %s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
        """, (roll_id,))
        if not rolls:
            raise HTTPException(status_code=404, detail="roll not found")
        roll = rolls[0]
        sheet_created_by = roll.get("created_by")
        can_edit = is_admin or (can_edit_width and sheet_created_by == req_user_id)
        if not can_edit:
            raise HTTPException(
                status_code=403,
                detail="You need the width_edit grant and must have "
                       "received this sheet to edit its width")
        po_id = roll.get("po_id")
        if _recv_po_locked(conn, po_id) and not is_admin:
            raise HTTPException(
                status_code=403,
                detail="This PO is locked after delivery approval")
        old_w = roll.get("after_wash_width_cm")
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_receiving_rolls
                SET after_wash_width_cm = %s,
                    updated_by      = %s,
                    updated_by_name = %s,
                    updated_at      = now()
                WHERE id = %s
            """, (width_cm, _uid, name, roll_id))
            _recv_audit(cur, po_id, roll["sheet_id"], roll.get("fabric_name"),
                        "width_updated",
                        {"roll_no": roll["roll_no"],
                         "old_cm": float(old_w) if old_w is not None else None,
                         "new_cm": width_cm},
                        name)
        conn.commit()
    _fabric_log_activity(request, "PATCH",
                         f"/api/fabric/rolls/{roll_id}/width",
                         f"after_wash_width_cm: {old_w} -> {width_cm} cm")
    return {"ok": True, "roll_id": roll_id,
            "roll_no": roll["roll_no"],
            "after_wash_width_cm": width_cm}


@fabric_router.post("/api/fabric/sheets/{sheet_id}/renumber")
async def sheet_renumber_rolls(sheet_id: int, request: Request):
    """Renumber all non-deleted rolls on a sheet sequentially starting from
    `start_from` (default 1), ordered by current roll_no then id. Requires
    an active roll_no_edit grant OR admin. Does NOT require sheet ownership.
    Body: {"start_from": 1}"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    start_from = int(body.get("start_from") or 1)
    if start_from < 1:
        raise HTTPException(status_code=400, detail="start_from must be >= 1")
    _uid, name = _fabric_actor(request)
    if not _recv_can_roll_no_edit(request):
        raise HTTPException(
            status_code=403,
            detail="You need the roll_no_edit grant to renumber rolls")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        exists = q(conn, """
            SELECT id, fabric_name, po_id
            FROM fabric_receiving_sheets
            WHERE id = %s AND deleted_at IS NULL
        """, (sheet_id,))
        if not exists:
            raise HTTPException(
                status_code=404, detail="receiving sheet not found")
        po_id = exists[0].get("po_id")
        rolls = q(conn, """
            SELECT id, roll_no FROM fabric_receiving_rolls
            WHERE sheet_id = %s AND deleted_at IS NULL
            ORDER BY roll_no, id
        """, (sheet_id,))
        if not rolls:
            return {"ok": True, "renumbered": 0}
        old_first = rolls[0]["roll_no"]
        with conn.cursor() as cur:
            for i, r in enumerate(rolls):
                cur.execute(
                    "UPDATE fabric_receiving_rolls "
                    "SET roll_no = %s, updated_by = %s, "
                    "    updated_by_name = %s, updated_at = now() "
                    "WHERE id = %s",
                    (start_from + i, _uid, name, r["id"]))
            _recv_audit(cur, po_id, sheet_id, exists[0].get("fabric_name"),
                        "rolls_renumbered",
                        {"rolls": len(rolls),
                         "old_first_roll_no": old_first,
                         "new_first_roll_no": start_from},
                        name)
        conn.commit()
    _fabric_log_activity(request, "POST",
                         f"/api/fabric/sheets/{sheet_id}/renumber",
                         f"renumbered {len(rolls)} rolls: roll_no {old_first} -> {start_from}")
    return {"ok": True, "renumbered": len(rolls)}


@fabric_router.get("/api/admin/fabric-field-grants")
def fabric_field_grants_list(request: Request):
    """List all active fabric field-edit grants (admin only)."""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, """
            SELECT g.id, g.user_id, g.field_name,
                   g.granted_by, g.granted_at,
                   u.name, u.email
            FROM fabric_field_grants g
            LEFT JOIN app_users u ON u.user_id = g.user_id
            WHERE g.revoked_at IS NULL
            ORDER BY g.field_name, g.granted_at
        """)
    return [dict(r) for r in rows]


@fabric_router.post("/api/admin/fabric-field-grants")
async def fabric_field_grants_add(request: Request):
    """Grant a user a fabric field-edit right (admin only).
    Body: {"user_id": "…", "field_name": "width_edit"|"roll_no_edit"}"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    user_id    = str(body.get("user_id")    or "").strip()
    field_name = str(body.get("field_name") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if field_name not in ("width_edit", "roll_no_edit"):
        raise HTTPException(
            status_code=400,
            detail="field_name must be width_edit or roll_no_edit")
    u = getattr(request.state, "user", None) or {}
    granted_by = str(
        u.get("email") or u.get("name") or u.get("user_id") or "admin")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        users_check = q(conn,
            "SELECT user_id FROM app_users WHERE user_id = %s", (user_id,))
        if not users_check:
            raise HTTPException(status_code=404, detail="user not found")
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_field_grants
                  (user_id, field_name, granted_by, granted_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (user_id, field_name) DO UPDATE
                  SET revoked_at = NULL,
                      granted_by = EXCLUDED.granted_by,
                      granted_at = EXCLUDED.granted_at
            """, (user_id, field_name, granted_by))
        conn.commit()
    _fabric_log_activity(request, "POST",
                         "/api/admin/fabric-field-grants",
                         f"grant: user_id={user_id} field={field_name}")
    return {"ok": True}


@fabric_router.delete("/api/admin/fabric-field-grants")
def fabric_field_grants_revoke(request: Request,
                               user_id: str = Query(...),
                               field_name: str = Query(...)):
    """Revoke a fabric field-edit grant (admin only)."""
    if field_name not in ("width_edit", "roll_no_edit"):
        raise HTTPException(
            status_code=400,
            detail="field_name must be width_edit or roll_no_edit")
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_field_grants
                SET revoked_at = now()
                WHERE user_id = %s AND field_name = %s AND revoked_at IS NULL
            """, (user_id, field_name))
        conn.commit()
    _fabric_log_activity(request, "DELETE",
                         "/api/admin/fabric-field-grants",
                         f"revoke: user_id={user_id} field={field_name}")
    return {"ok": True}


@fabric_router.put("/api/fabric/receiving/{sheet_id}")
def receiving_edit(sheet_id: int, request: Request, body: dict = Body(...)):
    """ADMIN-ONLY (gated by path in api_pg's auth middleware): correct the rolls,
    quantities and note of a saved sheet. Metres re-derive from the sheet's
    snapshotted kg->metre conversion (the historical factor, not a live re-read),
    per-roll quality is carried over by roll number, and the edit is timestamped
    on the sheet."""
    rolls = _recv_parse_rolls(body)
    note = str(body.get("note") or "").strip() or None
    # Optional inline quality edits, keyed by roll_no (unique per sheet, enforced
    # by _recv_parse_rolls). Folding quality into this one admin transaction keeps
    # the rolls rewrite + quality write ATOMIC — no separate, swallow-able call.
    q_in = {}
    for r in (body.get("rolls") or []):
        if not isinstance(r, dict) or "roll_no" not in r:
            continue
        if "status" not in r and "notes" not in r and \
           not any(k in r for k in _RECV_MEAS_NUM) and "bleeding_test" not in r and \
           "defective_yards" not in r:
            continue  # roll carries no explicit quality edit → fall back to prev
        try:
            rn = int(r.get("roll_no"))
        except (TypeError, ValueError):
            continue
        st = (str(r.get("status") or "").strip() or None)
        if st is not None and st not in _RECV_QUALITY_STATUSES:
            raise HTTPException(status_code=400,
                detail=f"status must be one of {', '.join(_RECV_QUALITY_STATUSES)}")
        # Parse defective_yards for this roll (upper-bound validated later when
        # length_yards is known from the measurement block or the stored row).
        _def_yds_set = "defective_yards" in r
        _raw_def = r.get("defective_yards")
        if _def_yds_set and _raw_def not in (None, ""):
            try:
                _def_yds_val = round(float(_raw_def), 3)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400,
                                    detail="defective_yards must be a number")
            if _def_yds_val < 0:
                raise HTTPException(status_code=400,
                                    detail="defective_yards cannot be negative")
        else:
            _def_yds_val = None
        q_in[rn] = {"status": st,
                    "notes": (str(r.get("notes") or "").strip() or None),
                    "meas": _recv_parse_measurements(r),
                    "defective_yards": _def_yds_val,
                    "defective_yards_set": _def_yds_set}
    # Optional PO re-link: pass "po_id": <id> to link/relink (re-validated LIVE
    # in Odoo as a draft) or "po_id": null/"" to unlink. Omitting the key
    # leaves the current link untouched.
    po_change = "po_id" in body
    po_link = None
    if po_change and body.get("po_id") not in (None, "", 0, "0"):
        try:
            po_new = int(body.get("po_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="po_id must be a number")
        po_link = _recv_fetch_draft_po(po_new)
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        srow = q(conn, "SELECT id, kg_per_mtr, fabric_name, po_id, total_kg "
                       "FROM fabric_receiving_sheets "
                       "WHERE id=%s AND deleted_at IS NULL", (sheet_id,))
        if not srow:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        kpm = srow[0].get("kg_per_mtr")
        kpm = float(kpm) if kpm not in (None, "") and float(kpm) > 0 else None
        # Preserve existing per-roll quality across the rolls rewrite, keyed by
        # roll number (the stable, user-facing identifier).
        prev = q(conn, "SELECT roll_no, quality_status, quality_notes, "
                       "quality_updated_by, quality_updated_at, "
                       "length_yards, shrinkage_inches, bleeding_test, "
                       "width_measured_m, after_wash_width_cm, "
                       "after_wash_length_cm, defective_yards "
                       "FROM fabric_receiving_rolls "
                       "WHERE sheet_id=%s AND deleted_at IS NULL", (sheet_id,))
        qmap = {r["roll_no"]: r for r in prev}
        total_kg = round(sum(kg for _, kg in rolls), 3)
        total_mtrs = round(total_kg / kpm, 1) if kpm else None
        quality_changes = []  # (roll_no, old_status, new_status, old_notes, new_notes)
        with conn.cursor() as cur:
            # Soft-deleted rolls stay put for the Recovery Bin — only rewrite
            # the LIVE rolls of this sheet.
            cur.execute("DELETE FROM fabric_receiving_rolls "
                        "WHERE sheet_id=%s AND deleted_at IS NULL",
                        (sheet_id,))
            for roll_no, qty_kg in rolls:
                pq = qmap.get(roll_no)
                edit = q_in.get(roll_no)
                if edit is not None:
                    # Explicit quality edit in this request wins; stamp the editor.
                    q_status, q_notes = edit["status"], edit["notes"]
                    q_meas = edit["meas"]
                    q_by, q_at = name, None  # None → SQL now() below
                    old_status = (pq.get("quality_status") if pq else None) or None
                    old_notes = (pq.get("quality_notes") if pq else None) or None
                    if old_status != q_status or old_notes != q_notes or \
                       (pq is not None and _recv_meas_changed(pq, q_meas)) or \
                       (pq is None and any(v is not None for v in q_meas.values())):
                        quality_changes.append(
                            (roll_no, old_status, q_status, old_notes, q_notes))
                    # defective_yards: use explicit value if key was in payload;
                    # otherwise fall back to the stored value.
                    if edit.get("defective_yards_set"):
                        q_def = edit["defective_yards"]
                        # Cross-field upper-bound check: now that length_yards is known
                        eff_ly = q_meas.get("length_yards")
                        if eff_ly is None and pq:
                            stored_ly = pq.get("length_yards")
                            eff_ly = float(stored_ly) if stored_ly not in (None, "") else None
                        if q_def is not None and eff_ly is not None and q_def > eff_ly:
                            raise HTTPException(status_code=422,
                                detail=f"defective_yards ({q_def:.2f} yd) cannot exceed "
                                       f"length_yards ({eff_ly:.2f} yd)")
                    else:
                        q_def = pq.get("defective_yards") if pq else None
                        q_def = round(float(q_def), 3) if q_def not in (None, "") else None
                else:
                    q_status = pq.get("quality_status") if pq else None
                    q_notes = pq.get("quality_notes") if pq else None
                    q_meas = {"length_yards": pq.get("length_yards") if pq else None,
                              "shrinkage_inches": pq.get("shrinkage_inches") if pq else None,
                              "bleeding_test": pq.get("bleeding_test") if pq else None,
                              "width_measured_m": pq.get("width_measured_m") if pq else None,
                              "after_wash_width_cm": pq.get("after_wash_width_cm") if pq else None,
                              "after_wash_length_cm": pq.get("after_wash_length_cm") if pq else None}
                    q_by = pq.get("quality_updated_by") if pq else None
                    q_at = pq.get("quality_updated_at") if pq else None
                    stored_def = pq.get("defective_yards") if pq else None
                    q_def = round(float(stored_def), 3) if stored_def not in (None, "") else None
                cur.execute("""
                    INSERT INTO fabric_receiving_rolls
                      (sheet_id, roll_no, qty_kg, qty_mtrs,
                       quality_status, quality_notes,
                       length_yards, shrinkage_inches,
                       bleeding_test, width_measured_m,
                       after_wash_width_cm, after_wash_length_cm,
                       defective_yards,
                       quality_updated_by, quality_updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                            COALESCE(%s, CASE WHEN %s THEN now() ELSE NULL END))
                """, (sheet_id, roll_no, qty_kg,
                      round(qty_kg / kpm, 2) if kpm else None,
                      q_status, q_notes,
                      q_meas["length_yards"], q_meas["shrinkage_inches"],
                      q_meas["bleeding_test"], q_meas["width_measured_m"],
                      q_meas["after_wash_width_cm"], q_meas["after_wash_length_cm"],
                      q_def,
                      q_by, q_at, edit is not None))
            cur.execute("""
                UPDATE fabric_receiving_sheets
                   SET total_kg=%s, total_mtrs=%s, rolls_count=%s, note=%s,
                       updated_at=now(), updated_by_name=%s
                 WHERE id=%s
            """, (total_kg, total_mtrs, len(rolls), note, name, sheet_id))
            if po_change:
                new_ps_id = None
                if po_link:
                    # Keep the ONE-sheet-per-PO invariant on relink: attach
                    # the section to the target PO's (get-or-created) sheet.
                    cur.execute("""
                        INSERT INTO fabric_receiving_po_sheets
                          (po_id, po_name, po_date, created_by_name)
                        VALUES (%s,%s,%s,%s)
                        ON CONFLICT (po_id) DO UPDATE SET po_id=EXCLUDED.po_id
                        RETURNING id
                    """, (po_link["po_id"], po_link["name"],
                          po_link["date_order"], name))
                    new_ps_id = cur.fetchone()[0]
                cur.execute("""
                    UPDATE fabric_receiving_sheets
                       SET po_id=%s, po_name=%s, po_date=%s, po_sheet_id=%s
                     WHERE id=%s
                """, (po_link["po_id"] if po_link else None,
                      po_link["name"] if po_link else None,
                      po_link["date_order"] if po_link else None,
                      new_ps_id, sheet_id))
            # Audit the admin rewrite on the sheet's (final) PO group.
            audit_po = (po_link["po_id"] if (po_change and po_link)
                        else (None if po_change else srow[0].get("po_id")))
            if audit_po is not None:
                after_upload = _recv_po_locked(conn, audit_po)
                _recv_audit(cur, audit_po, sheet_id,
                            srow[0].get("fabric_name"), "sheet_edited",
                            {"rolls": len(rolls),
                             "old_kg": float(srow[0].get("total_kg") or 0),
                             "new_kg": total_kg,
                             "after_upload": after_upload},
                            name)
                for rn, o_st, n_st, o_nt, n_nt in quality_changes:
                    _recv_audit(cur, audit_po, sheet_id,
                                srow[0].get("fabric_name"), "quality_updated",
                                {"roll_no": rn,
                                 "old_status": o_st, "new_status": n_st,
                                 "old_notes": o_nt, "new_notes": n_nt,
                                 "after_upload": bool(after_upload)}, name)
        conn.commit()
        _log_fabric_change("Receiving sheet edited", {
            "id": sheet_id, "product": srow[0].get("fabric_name"),
            "style_name": "", "qty": total_kg, "uom": "kg",
            "note": f"{len(rolls)} rolls (admin edit)", "status": "edited",
        }, request)
    return {"ok": True, "id": sheet_id, "total_kg": total_kg,
            "total_mtrs": total_mtrs, "missing_conversion": kpm is None}

@fabric_router.delete("/api/fabric/receiving/{sheet_id}")
def receiving_delete(sheet_id: int, request: Request):
    """SOFT-delete a receiving sheet: it moves to the Recovery Bin where a
    full fabric admin can restore or permanently purge it (auto-purged after
    90 days). Same lock rule as roll edits."""
    _recv_block_quality_only(request)
    _uid, name = _fabric_actor(request)
    admin = _recv_is_admin(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        snap = q(conn, "SELECT id, fabric_name, total_kg, rolls_count, po_id "
                       "FROM fabric_receiving_sheets "
                       "WHERE id=%s AND deleted_at IS NULL", (sheet_id,))
        # Same lock rule as roll edits: once the PO has a successful Odoo
        # upload, only an admin may delete a sheet (and it is audited).
        po_id = snap[0].get("po_id") if snap else None
        locked = _recv_po_locked(conn, po_id)
        if locked and not admin:
            raise HTTPException(status_code=403, detail=_RECV_LOCKED_MSG)
        with conn.cursor() as cur:
            cur.execute("UPDATE fabric_receiving_sheets "
                        "SET deleted_at=now(), deleted_by=%s "
                        "WHERE id=%s AND deleted_at IS NULL",
                        (name, sheet_id))
            deleted = cur.rowcount
            if deleted and po_id is not None:
                _recv_audit(cur, po_id, sheet_id,
                            snap[0].get("fabric_name"), "sheet_deleted",
                            {"rolls": int(snap[0].get("rolls_count") or 0),
                             "total_kg": float(snap[0].get("total_kg") or 0),
                             "after_upload": bool(locked)}, name)
        conn.commit()
        if not deleted:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        s = snap[0] if snap else {"id": sheet_id}
        _log_fabric_change("Receiving sheet deleted", {
            "id": sheet_id, "product": s.get("fabric_name"),
            "style_name": "", "qty": s.get("total_kg"), "uom": "kg",
            "note": f"{s.get('rolls_count') or 0} rolls", "status": "deleted",
        }, request)
        return {"ok": True}


# ── Fabric QC report ────────────────────────────────────────
# Aggregated quality-control reporting over the per-roll inspection data
# recorded on the Receiving tab (fabric_receiving_rolls / _sheets). One
# endpoint returns KPIs, breakdowns (supplier / fabric / month), shrinkage
# distribution, bleeding outcomes, width-discrepancy summary and a capped
# roll-level detail list. All figures respect ALL applied filters (including
# the status filter) so the on-screen tables always reconcile with the cards.
# No extra role gate: any signed-in fabric user (page-level gate only).

# High-shrinkage threshold for the QC report (percent of the 35 cm gauge).
# The Receiving tab's informational flag stays at ≥2 inches; this report uses
# a percent threshold so it is comparable across axes — echoed in the payload
# so the UI always displays the active rule.
_QC_HIGH_SHRINK_PCT = 5.0
# Width discrepancy tolerance (cm) between the measured roll width and the
# product master width before a roll counts as a width mismatch.
_QC_WIDTH_TOL_CM = 2.0

def _qc_shrink_pct(r):
    """Worst-axis shrinkage percent for one roll: structured after-wash cm
    measurements against the fixed 35 cm gauge first (either axis), legacy
    single-inches fallback. None when nothing was measured. Negative = grew."""
    pcts = []
    for k in ("after_wash_width_cm", "after_wash_length_cm"):
        v = r.get(k)
        if v is None or v == "":
            continue
        try:
            c = float(v)
        except (TypeError, ValueError):
            continue
        pcts.append((_RECV_SHRINK_GAUGE_CM - c) / _RECV_SHRINK_GAUGE_CM * 100.0)
    if pcts:
        return max(pcts)
    v = r.get("shrinkage_inches")
    if v is None or v == "":
        return None
    try:
        inches = float(v)
    except (TypeError, ValueError):
        return None
    return inches * 2.54 / _RECV_SHRINK_GAUGE_CM * 100.0

def _qc_bleed_outcome(txt):
    """Classify the free-text bleeding_test field. 'not_tested' when blank;
    negation-style answers = pass; bleed/fail language = fail; anything else
    'other' (shown, never guessed)."""
    t = (txt or "").strip().lower()
    if not t:
        return "not_tested"
    if re.match(r"^(no\b|none\b|nil\b|negative\b|pass(ed)?\b|ok(ay)?\b|"
                r"n/?a\b|not\b|doesn|didn)", t):
        return "pass"
    if re.search(r"fail|yes\b|bleed|positive|colou?r\s*(run|loss)|runs\b", t):
        return "fail"
    return "other"

@fabric_router.get("/api/fabric/qc/report")
def fabric_qc_report(date_from: str = Query(default=""),
                     date_to: str = Query(default=""),
                     supplier: str = Query(default=""),
                     fabric: str = Query(default=""),
                     status: str = Query(default=""),
                     po_ids: str = Query(default="")):
    """Fabric QC report over per-roll inspection data. Filters: receiving date
    window (PO date, falling back to the sheet's EAT save date), supplier
    (derived from the PO's supplier in raw_fabric_purchase_orders via po_name),
    fabric search (name or barcode) and inspection status (Pass / Fail /
    Pending — Pending includes never-inspected NULL/blank rolls)."""
    date_re = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    df = date_from.strip() if date_from and date_re.match(date_from.strip()) else None
    dt_ = date_to.strip() if date_to and date_re.match(date_to.strip()) else None
    sup = (supplier or "").strip()
    fab = (fabric or "").strip()
    st = (status or "").strip().title()
    if st not in ("Pass", "Fail", "Pending"):
        st = ""
    where, params = [], []
    if df:
        where.append("COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) >= %s::date")
        params.append(df)
    if dt_:
        where.append("COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) <= %s::date")
        params.append(dt_)
    if fab:
        where.append("(s.fabric_name ILIKE %s OR s.barcode ILIKE %s)")
        params.extend([f"%{fab}%", f"%{fab}%"])
    if st == "Pending":
        where.append("(r.quality_status IS NULL OR r.quality_status = '' OR r.quality_status = 'Pending')")
    elif st:
        where.append("r.quality_status = %s")
        params.append(st)
    # Optional po_ids filter: comma-separated integer po_id values.
    _qc_po_ids: list = []
    for _p in (po_ids or "").split(","):
        _p = _p.strip()
        if _p.isdigit():
            _qc_po_ids.append(int(_p))
    if _qc_po_ids:
        where.append("s.po_id = ANY(%s)")
        params.append(_qc_po_ids)
    extra = (" AND " + " AND ".join(where)) if where else ""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            SELECT r.id as roll_id, r.roll_no, r.qty_kg, r.quality_status, r.quality_notes,
                   r.quality_updated_by, r.quality_updated_at,
                   r.length_yards, r.shrinkage_inches, r.bleeding_test,
                   r.width_measured_m, r.after_wash_width_cm, r.after_wash_length_cm,
                   r.defective_yards,
                   s.id as sheet_id, s.fabric_name, s.barcode, s.po_name,
                   COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) as recv_date,
                   p.width_m as expected_width_m,
                   COALESCE(NULLIF(BTRIM(p.fabric_supplier_name),''), 'No PO / unknown') as supplier
            FROM fabric_receiving_rolls r
            JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL{extra}
            ORDER BY recv_date DESC, s.id DESC, r.roll_no
        """, tuple(params) if params else None)
        # Filter dropdown options come from the UNFILTERED universe so picking
        # one supplier never empties the other dropdowns.
        opts = q(conn, """
            SELECT DISTINCT
                   COALESCE(NULLIF(BTRIM(p.fabric_supplier_name),''), 'No PO / unknown') as supplier,
                   s.fabric_name
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE s.deleted_at IS NULL
        """)
    if sup:
        rows = [r for r in rows if (r.get("supplier") or "") == sup]

    def _norm_status(r):
        v = (r.get("quality_status") or "").strip()
        return v if v in ("Pass", "Fail") else "Pending"

    today = datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=3))).date()
    cur_month = today.strftime("%Y-%m")
    n = len(rows)
    pass_n = fail_n = pending_n = 0
    shrink_vals, high_shrink_n = [], 0
    bleed = {"pass": 0, "fail": 0, "other": 0, "not_tested": 0}
    width_meas_n = width_bad_n = 0
    width_diffs = []
    insp_lag_days = []
    month_rolls = month_inspected = 0
    by_sup, by_fab, by_mon = {}, {}, {}
    detail = []
    for r in rows:
        stt = _norm_status(r)
        if stt == "Pass":
            pass_n += 1
        elif stt == "Fail":
            fail_n += 1
        else:
            pending_n += 1
        sp = _qc_shrink_pct(r)
        if sp is not None:
            shrink_vals.append(sp)
            if sp >= _QC_HIGH_SHRINK_PCT:
                high_shrink_n += 1
        bo = _qc_bleed_outcome(r.get("bleeding_test"))
        bleed[bo] += 1
        wdiff = None
        wm, we = r.get("width_measured_m"), r.get("expected_width_m")
        try:
            if wm not in (None, "") and we not in (None, "") and float(we) > 0:
                wdiff = (float(wm) - float(we)) * 100.0  # cm
                width_meas_n += 1
                width_diffs.append(wdiff)
                if abs(wdiff) > _QC_WIDTH_TOL_CM:
                    width_bad_n += 1
        except (TypeError, ValueError):
            wdiff = None
        rd = r.get("recv_date")
        rd_iso = rd.isoformat() if hasattr(rd, "isoformat") else (str(rd)[:10] if rd else None)
        mon = rd_iso[:7] if rd_iso else "unknown"
        if mon == cur_month:
            month_rolls += 1
            if stt != "Pending":
                month_inspected += 1
        qat = r.get("quality_updated_at")
        if stt != "Pending" and qat is not None and rd is not None:
            try:
                lag = (qat.date() - rd).days
                if 0 <= lag <= 365:
                    insp_lag_days.append(lag)
            except (TypeError, AttributeError):
                pass
        for key, bucket in ((r.get("supplier") or "No PO / unknown", by_sup),
                            (r.get("fabric_name") or "Unknown fabric", by_fab),
                            (mon, by_mon)):
            g = bucket.setdefault(key, {
                "rolls": 0, "pass": 0, "fail": 0, "pending": 0,
                "high_shrink": 0, "bleed_fail": 0, "shrinks": []})
            g["rolls"] += 1
            g["pass" if stt == "Pass" else ("fail" if stt == "Fail" else "pending")] += 1
            if sp is not None:
                g["shrinks"].append(sp)
                if sp >= _QC_HIGH_SHRINK_PCT:
                    g["high_shrink"] += 1
            if bo == "fail":
                g["bleed_fail"] += 1
        if len(detail) < 1000:
            ly = float(r["length_yards"]) if r.get("length_yards") not in (None, "") else None
            def_yds_raw = r.get("defective_yards")
            def_yds = float(def_yds_raw) if def_yds_raw not in (None, "") else None
            okay_yds = round(ly - def_yds, 3) if (ly is not None and def_yds is not None) else None
            detail.append({
                "roll_id": r.get("roll_id"),
                "sheet_id": r.get("sheet_id"),
                "po_name": r.get("po_name"),
                "supplier": r.get("supplier"),
                "fabric_name": r.get("fabric_name"),
                "barcode": r.get("barcode"),
                "roll_no": r.get("roll_no"),
                "recv_date": rd_iso,
                "status": stt,
                "qty_kg": float(r["qty_kg"]) if r.get("qty_kg") is not None else None,
                "length_yards": ly,
                "defective_yards": def_yds,
                "okay_yards": okay_yds,
                "width_measured_m": float(wm) if wm not in (None, "") else None,
                "expected_width_m": float(we) if we not in (None, "") else None,
                "width_diff_cm": round(wdiff, 1) if wdiff is not None else None,
                "shrink_pct": round(sp, 1) if sp is not None else None,
                "high_shrink": bool(sp is not None and sp >= _QC_HIGH_SHRINK_PCT),
                "bleeding_test": r.get("bleeding_test") or None,
                "bleeding_outcome": bo,
                "notes": r.get("quality_notes") or None,
                "inspected_by": r.get("quality_updated_by") or None,
                "inspected_at": (r["quality_updated_at"].strftime("%Y-%m-%d %H:%M")
                                 if r.get("quality_updated_at") is not None else None),
            })

    def _grp_out(bucket, label_key):
        out = []
        for k, g in bucket.items():
            insp = g["pass"] + g["fail"]
            out.append({
                label_key: k, "rolls": g["rolls"], "pass": g["pass"],
                "fail": g["fail"], "pending": g["pending"],
                "pass_pct": round(g["pass"] / insp * 100.0, 1) if insp else None,
                "avg_shrink_pct": round(sum(g["shrinks"]) / len(g["shrinks"]), 1) if g["shrinks"] else None,
                "high_shrink": g["high_shrink"], "bleed_fail": g["bleed_fail"],
            })
        return out

    inspected = pass_n + fail_n
    shrink_buckets = [
        {"label": "None / grew (≤0%)", "n": sum(1 for v in shrink_vals if v <= 0)},
        {"label": "0–2%", "n": sum(1 for v in shrink_vals if 0 < v <= 2)},
        {"label": "2–5%", "n": sum(1 for v in shrink_vals if 2 < v <= 5)},
        {"label": "5–8%", "n": sum(1 for v in shrink_vals if 5 < v <= 8)},
        {"label": ">8%", "n": sum(1 for v in shrink_vals if v > 8)},
    ]
    by_month = sorted(_grp_out(by_mon, "month"), key=lambda x: x["month"])
    # Delivery approval summary — one row per PO that appears in the filtered
    # roll set. Opens a fresh connection (the main `with` block already closed).
    po_names_in_filter = list({r.get("po_name") for r in rows if r.get("po_name")})
    delivery_approvals = []
    if po_names_in_filter:
        try:
            with _get_conn() as conn2:
                dap = q(conn2, """
                    SELECT ps.po_name,
                           ps.delivery_approved_by,
                           ps.delivery_approved_by_email,
                           ps.delivery_approved_at
                    FROM fabric_receiving_po_sheets ps
                    WHERE ps.po_name = ANY(%s)
                    ORDER BY ps.delivery_approved_at DESC NULLS LAST, ps.po_name
                """, (po_names_in_filter,))
            eat = ZoneInfo("Africa/Nairobi")
            for da_row in dap:
                at_fmt = None
                if da_row.get("delivery_approved_at"):
                    try:
                        at_fmt = da_row["delivery_approved_at"].astimezone(eat).strftime("%d %b %Y, %H:%M")
                    except Exception:
                        at_fmt = str(da_row["delivery_approved_at"])[:16]
                delivery_approvals.append({
                    "po_name": da_row.get("po_name"),
                    "approved": da_row.get("delivery_approved_at") is not None,
                    "approved_by": da_row.get("delivery_approved_by"),
                    "approved_by_email": da_row.get("delivery_approved_by_email"),
                    "approved_at": at_fmt,
                })
        except Exception:
            pass  # Non-fatal: delivery approval data is supplementary
    return {
        "high_shrink_pct": _QC_HIGH_SHRINK_PCT,
        "width_tol_cm": _QC_WIDTH_TOL_CM,
        "shrink_gauge_cm": _RECV_SHRINK_GAUGE_CM,
        "kpis": {
            "rolls": n, "inspected": inspected,
            "pass": pass_n, "fail": fail_n, "pending": pending_n,
            "pass_pct": round(pass_n / inspected * 100.0, 1) if inspected else None,
            "fail_pct": round(fail_n / inspected * 100.0, 1) if inspected else None,
            "coverage_pct": round(inspected / n * 100.0, 1) if n else None,
            "avg_shrink_pct": round(sum(shrink_vals) / len(shrink_vals), 1) if shrink_vals else None,
            "shrink_measured": len(shrink_vals),
            "high_shrink": high_shrink_n,
            "bleed_tested": n - bleed["not_tested"],
            "bleed_fail": bleed["fail"],
            "width_measured": width_meas_n,
            "width_mismatch": width_bad_n,
            "avg_width_diff_cm": round(sum(width_diffs) / len(width_diffs), 1) if width_diffs else None,
            "month_rolls": month_rolls,
            "month_inspected": month_inspected,
            "avg_inspect_lag_days": round(sum(insp_lag_days) / len(insp_lag_days), 1) if insp_lag_days else None,
        },
        "by_supplier": sorted(_grp_out(by_sup, "supplier"),
                              key=lambda x: (-x["fail"], -x["rolls"])),
        "by_fabric": sorted(_grp_out(by_fab, "fabric"),
                            key=lambda x: (-x["fail"], -x["rolls"]))[:100],
        "by_month": by_month,
        "shrink_buckets": shrink_buckets,
        "shrink_not_measured": n - len(shrink_vals),
        "bleeding": bleed,
        "detail": detail,
        "detail_truncated": n > 1000,
        "delivery_approvals": delivery_approvals,
        "delivery_approvals_summary": {
            "total_pos": len(delivery_approvals),
            "approved": sum(1 for d in delivery_approvals if d["approved"]),
            "pending": sum(1 for d in delivery_approvals if not d["approved"]),
        },
        "options": {
            "suppliers": sorted({o["supplier"] for o in opts if o.get("supplier")}),
            "fabrics": sorted({o["fabric_name"] for o in opts if o.get("fabric_name")}),
        },
    }


# ── 4-Point QC Score Sheet ─────────────────────────────────────────────────
# Self-contained, print-ready HTML page for a fabric receiving sheet.
# Path /api/fabric/receiving/sheets/{sheet_id}/scoresheet avoids any clash
# with the existing /api/fabric/receiving/{sheet_id} JSON endpoint.
# Auth passes through the standard clerk_auth_gate.

_SCORESHEET_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAbgAAADRCAYAAAC+RqeVAAA8sUlEQVR42u2deZyU1ZX+v/d9q3pjETfEDUUUN9wVVBbXuMQlZszEaOKWuCeaRE1mkswv85lk4swkbtG4xyXGJWrilkWNggiyKYKgqOAGsgiCLA3dTXfV+97fH+e+Xd0I1K3q6qa76jyfT8UkdvVy6773Oefc8zzHRJcHq4OAvrHFGjAoFAqFQlEGCHQJFAqFQqEEp1AoFAqFEpxCoVAoFEpwCoVCoVAowSkUCoVCoQSnUCgUCiU4hUKhUCiU4BQKhUKhUIJTKBQKhUIJTqFQKBQKJTiFQqFQKJTgFAqFQqEEp1AoFAqFEpxCoVAoFEpwCoVCoVAowSkUCoVCoQSnUCgUCoUSnEKhUCiU4BQKhUKhUIJTKBQKhUIJTqFQKBQKJTiFQqFQKJTgFAqFQqEEp1AoFAqFEpxCoVAoFEpwCoVCoVAowSkUCoVCoQSnUCgUCoUSnEKhUCiU4BQKhUKhUIJTKBQKhUIJTqFQKBQKJTiFQqFQKJTgFAqFQqFQglMoFApFZSClS6AoLxgw7gVgLWDdPxUKhRKcQtHjeM2ACSHOQIuFWHiNAAiBVEq+Jo50rRQKJTiFoocgCCGTgeYI6kLYYTfouz2EKWiqhxXzYcUyIb26sE1mp1AolOAUiu5Mbg0Z2GYA5qjL4aAzYbshEKZzX9PwOXw8FTvhHpj+tGR1VSmIY10/haKMYaLLg9VBQN/YYg0YXRJFjyK3tRk48uuYs34LfQfk/p115GUM7bb1rL9i/3gprPoUapTkFIqyPiJ0CRQ9mtxOuRpz8WNCblHWEZsFE8gLI+XIOII4C/ufhvm3CdB/N2jOQqCPgEKhBNfzktNcN10hL0UJlr6YdS9g7ZOy5KizMV+7QcjLxnLnlpDa+r9PEEKQgigD2wzGXPV3qN0CslY/d4VCCa4nHbABRBFkCnxlIy3SliCuIFvE2keRIyePz7Ylgu12wpx9hxCbMX7vBbmbizKw3V6Yr/8G1kX+71UoFD0K5dVkYowcrn23wlz8Z0jXIr3ieVjLRhCksGNuglcfhV5pbScvKlwKoTELB34Jc9p/y7qa0OON0tFo7z8HlnwE6VTuDm1DBNecxZxwrWRgcVYys0IQpuTzPeLbMPZm+OQdqN7Ez1QoFEpwmx3WQjoNny+HdfWwx1GF8eNJP8W+9rgedMV/AGAs5sSfwK7DCnvrvKnw6Xzpbtzo+hvIZmDL3nDw12m9aysqzbQQpDCHfRP74c+gJtDPXaEot5i7bI/aF/5HDqwo6xoM8ryiDOwwFPY5BpoiyUYUBXBGCOuysPtBEljEHutu3bpjsc//SkqVmyKsIICMlc9pi+1dcl7sFnZZ/e6joQolN4VCCa4HII6gNoT3p8D8aRA6ogrCTb9co4E56ntJxUxRKF9kwYz+Xo508q05Ru7Els6Ft16AukCIcVM/JAK2HuSimA6QUtJYsuVOUFPtfq5ewCoUSnA9IZtosdhXfud/aAWhlDiHngy7DJEWcm0+8FzvAFqyMGAHOCQpHXpkwI6g7IQ7oaHF/y6tunfyDTr+u6eqIVXldVWrUCiU4LpJFmdgxlOwapEjr3zRvpGSWViFGXGx+BkqwfkTXLPFHPltIZ84yt96b+UOjMYVMPUh+bysR2OPAZob2vyPDiLbDNmW1ms5hUKhBNfNYaX0tWotdvJ97bKFvJkfwPDzYOt+0tCgGqn8jBNloW8djLg4R3h5PyJHZq89DMuWQyrt4Q9pZcd+/qH/z9kUwWJh5QJY1+yyR2U4hUIJrkdwXAzVBibdCy1N7s4nzwGWuM336Q+HngXrPEttFb2DQmiK4eCvwlYDXfbmo2cLIcpgJ9wBaeMXgMQxVBlY9LZk5r6By8bIEgNzx0ELmq0rFEpwPYzgqlKwaD7MeloOs9izBIbFjLoCakLVw/lkYmmDOepK/wwoKWG+8wLMe1fW2Yuoksy8AaY9Kt+jKIKzrZmnff0h7aJUKJTgeu5faF+5zZGXZ2ZhLey0v0gG1qlkYNPZWwR7jYBBw929msdaubKvHXdL26jCn1BrAuw/r5cpASYsnJyirPyeE26HeXOhOq0Ep1AowfUwxJFkB3MnwcdT/QdeusPOjE4kA3o3s6lkSLI3zywoyd4WzoTZY0XSUUiWbC2kQ1i+FPvgt9tM7vb8HlFGssAF07F//qn8fCU3hUIJrkcikQyMv43iJQPqV/jFdXXSgJ13g/2/Ikznnekayaqbo+LuOONI7NReexb7x4vc5IBQtGw2Xq9ZxeamCdhIyG3RLOytp0GmAQKjw08VCiW4HpzF1QYwvVjJwCUqGdgYwTVbzIhLIV3tsjAfaUAI9Utg2mNQY/wzrw19rr3TMPZe7C0nw7IPpRPSBG06X91dWzJNwIQw9SHsb46GVYvz2IIpFAoluG4PK+a6q9fCpGIkA+eqZOALa+M8IbfaAo44P0d4eT8KR2aTH4CV9Z7SAA+Sm/k89leHYJ+4Gj6aLD6kSaASZ2HFAnjtEexNx2HvPheaV4q5sg47VSjK+6iqiIneJhCfw/4DMT9/F9I1uQMw3wEahNhHLoMX74LeVXmspColLErBmhY48VLM2Xe2rlPeQMMC2WbsL/eBpfPkLq0UGVQQCuGuQzoit9oe+mwnv2fzGli5COrXSjhXmxJS1bKkQqEZXHkkcU4ysHA+zHyGwiQDYEZfDtUqGWhH/LUpzOjvCnH5ZLZJc8msZ2Dhx6UtD8aReI72rhLSXPkpfPwmfDgNFs2BlrVyZ1eblqxNyU2hUIIrO4Q4f0oKkAzEsNMBKhlomy2ti2Df42HH/YQsfAeVAnbcrZ2z66x1TSYWUqGUIKtTQqQmzE0wUCgUSnBlmXXUhDCnUMmARPvm6CtVMkDu7zdHX9Vufbyyt4+nyPp3toDeWtdN6V4q81AolODKHiaETKGSgUAOzH1PUsmACSR7GzQU9vmSv7Bb3izZW0btzxQKhRJc52RxtQFMfxJWLVTJQDEEl7GY0VdIA4f1FM0HIayYL9MdagMtFSoUCiW40iORDDTApPtzB7BP5geVPWXAGMhkoH9/OOxsCp35xqv3QH2TrL+WDBUKhRJcZ3CcTBmwk+6FTKFTBrat3CkDJpS/+/DzoLZfATPfQmheg518v0x3UGG1QqFQgutEgkumDMx8moIlA6Mur8ApA04w3bsaM+oy93/5CrsNvPEELFHnEIVCoQTXNQiLmTLgJAN7V5hkIJn5dsBpsO1gIa4C1syOvw20MqlQKJTgugBtJQPzipgycFSFTRmwEYROKuH7ZyclzLnj4IPpokmz2lyiUCiU4DofiWTgFZ0ykHed1kWwxzDYfVSuKzLv+xwXjrsFYtSsWqFQKMF1aRaXSAZWFiEZGHlpZUgGDBC5rNV3graNhRiXzoFZzzlpgHp4KhQKJbguQhvJwOQipgwMq4ApA8nMtx0GwkFn4j3zza2jnXAnNLSIZk6hKNsI0I1kou1LoQS32TkukQzcBy3FSAa+Ud6SgdaZb9+BqrrCZr41roCpD0Gt0bs3RQ9+Bow8B0GqzStsP0neRhBFuaG6UpPf9PsUSnBdQnAdkQyMLmfJgIEoA/16w5HfyRFe3jV1JPjaw7BsecdnvikUXU1oQeiG5xohruasVCLWtMDaFmjKyPgtgFQ1VPWCmt5Q00tGcZlA3rduA+/LuvclpKd3050KrR2BSAbG34Y57OzCJAM77i9TBt58CerS5UV0QQhrIzjia9BvR8+Zb25togx2wh2Q7iJhtwkKOyjiiKI6YAv9OVB5d49FrVGRn0dJs7RQMq9MFloi+XXSQN+tYZtB0H8IbLs7ZutdoO8A6LU11PYVQgur3P00EGcgs07mEDaslOn1Kxdgl30Ey96XyfOrFkFji/zsKmTEU3KmqE5UCa6kWH/KwKBhfoe5jcEEmKO+h53xEmUnGbARVMnf5/23Jev2zvMw712o64Kp2QaJsAvhkRrERLuzf45BGmwqhtxwBFHIPgNqi/g8ShXEgVjQNYsUhq0GwKBhmD2OgkHDYbs9ofc2JVkaANathWUfwPxp2A8mwIcT4bMP5edX4cY7GffcaOVDCa4kD2YImUiyuEHDPR8ONxl6XycZWPQ+VIXlEYEFITRmYP9jYOAhBUgD5DG2425d/7HuvGyhOcKMPBcGj3TauyDvSWOfvw6WLYB04Fc+TX7OMZfAwIPl8Nnkz3HdtWuXY//688o4qEwoAcDeozDDvuX3WWAhSGNf+g0sngPpLnK6STqmmzJyXbbt9rDvlzEHngG7j4C6Lb/4e7YjHNNuv2/8z7PtP3sTSClz5wNh5wMxIy+SbG/+NOysv8KsZ2Hhe/I71RoI0ps/u1WCK5MsLpEMfOU66LdTa4aWN8txUwbsQ9dCdVAmJQYrZ3TrzDePtYgjicIXzoTZY7vmbtIEkjHs+2Vp+PHFxN/D0k/cQeVDcAYii21eI/KQQvDBeJjxQvmVsDeYilnMV38Ngw73f9uaz+DxH0IYdP5dbUJsDRk5+fY6CjPiQtj/NOi1VfvqjG3TKJLcyxWdtm2A9JLvn66B3Udidh8Jp/8S3huDnXS/kN3aZsluw7RO4Cj2I9clcA9n65SBIiQD5TRlwGUr7DIEhn658Jlvr9wm7+8qGzOD3HfEWciuk3/6vAoOgEKY/CjMnybNN9nmTX//bDPEEeb4ax2PlnEUHoTSULH3SCnrRS351z/bDNZin/0ZrFrTuVMmTJCrSmQiOOwMzLUvY64dB0ecL+SWTHxPJtR3Vtdju65M17UdR7ImqSoYejLmkscxP5sOX7oCUr1gbUY2eqBzFJXgiua4NlMGWhqLkww0lYFkwATQYjEjL5PLc1uANKB+CUx7DGq6WBrwhXbsPK9iSqdBCBnnzBKm8/+MVLXsjz2PgyGHCQGU8wSKGMxx17isJ9z02phADvP6JTDtcagLOm+/hCnJ8hszsN+XMNeOx1z+FAw5WvZtQmpBuJna+Nt0bbaSXQTb74M55zbMf0yHY74NkZWSqkoNlOCKJriqFCz+BGY+Q1GSgdoeLhkwRrLQbbaCw8/Ff+ab+5snPwAr68tTGpCUsaf9GT7/2E16j/PvKWPk4I8pT/2vCYS8B+0DQ0/1y/hdec5OuMvtl1Tp90vSzVnfAtvshrn8UcwP/gl7jMqRSFJ67DaEYXJEa2P5HfsPwZx3L+ZHE2DPUZLNxbFmc0pwxa+IHV/ElIEd94d9ju3ZUwZMKFnosG9Cr238Zr4lJJhZh514dxnPfHNl7DVNronG4+9MvEsP+CoMHCJNGOWmezJGprwffZWsT75MzLr9sq4eXr3bZfsl3i9BCNmsEO8JV2D+Y5pUWBLSSEikuwcObYlu8JGYH72C+eaNENZJNhdqC4USXKFReqtkYEpxUwZ69N+fhbq0ZKO+BJ+Q4KxnYOHH5T3zzbosbtIDsHaZC27spiNyG0GqCnPMVc67tIzSuKTJZ/sd4LBz/DJ+6/bL1Idgyael75wMU9JE0md7zJVPY865DWq3zHV19rTgs5XonDbv+B9i/n0yDB4m2amWLJXgCs5iip0ysO9JMHDPnhmpBymZ+bb/STBgb7/OyTYkaMfdWv67yVopp32+Ejvx907cG+XfT1gYfi4MGCCEUC4HkgnEqm7kJVDTxyPjdwQYtchdZpUpbWkySMmhP/QYzE+nwgFfkaCtoEYpj0w+6bJMmkO+8EoaVkqoZTOOyOIs7Lgf5sfj4YTLpGRpUUcUJbgCsrhaAzOeglXFTBm4uGdOGbAxBG2lAdZvrYyRbHfOpMqYdO6akRh/BzQ35M/ikipATV8YdWkZeZcaKQNu2Rcz8hJatX8++2XmszB/jpsRWILsLXEiWdMCJ1yG+eGLsOXOQgaJ5VZHgpqEyNpJB4Jcc8gXXknDSkBrKTshvo4SeuDKwGE15pw7MBf8DjKxWIMFepyvDy3ibihCC9OwugE76T7Ml3/ul820Thk4D/7x39C4umu0PaWKxJsjGHwg7Hmsv7DbHXR23K2QsVAdgi1za6rWZqQFMO1RGHGRHF4mlSfLtZiRl2JfukncLELTsxtxglB8Fo86B7bY3s/9x62DHXtD6UJrY8AaWJfBfOM6OOknsq427sAUC5tz4AnC9gFJlIH6pfJa+xk0rpKu66hFyqPpOqjtJ+4nfQdA3+1y/pRt91AiRyiGfJOgykZw1HcxW+2Cvfsb0NIgezNWuy8lOJ8ofdJ9cPyPoKrGlRpM/kg9kQz8807o3UMOfGMgazGjvysPXexRYk1IcMV8mPG0m/lWIWJUayFlsC/fjDn8Ar+DPY6ECA7/Fjx3O/Sp6tnBQJyFuirM0d932ZvJn70FoUx4nzMFalId3y8JuTVnMRfcKRly7OQYxVRQEtJo1agBjSth3uvw4UTs/Gnw2Vyo/xTWNYht2/pVyGRaTgqoroU+/aH/HrDzIZjdR4hOsE//3FGSZLWF/r7GSFAVZWC/UzE//Cf21tOgYQVUqzBcCc4nSl80H2Y+JRfoSbkjT9UGLGb05djx9/SMTZY0CgzYHg45C39pgGS19tV7oL5RDuxKMRa2sRzQH82Gt/4GB56Rf38YcU0xx3wfO/73PfsAClKSvR1xKgzYyzWO5CN5Z+M25nqI3L7rSHmyLbl95z444kI57MN0kcTmAjaTkoxs9vPYN54QQl6xRMgsdCdmCKRCsXrLPfjtM0AbQ7YJls+HJfNhxkvYEOi3NQweiTnka7DfqVDXrw3RFZHRhWmIsrDbkUJyN50IjZ9rJpdsVWWzTW2eYiQDtmdJBlyjgDn8Qs9GAXKX9s1rYfL9ThoQVeTTY8de77c/TCAHTv8hcPAZ0Bj13EGwNoYUmGOvbj3PN/31bk8tmgWznnd60Y4EQ0YWf10Wc+FdHSO3tnq41Yvhb7/A/mJ/7O/OhEl/EjF6TUoCuLq0dH0mz3nSTLKhJpNEDpFOyfuS9zd+DtOewd51Lva/hmL/8m8yYSDphiwm8AlT8nMHHoL5wT+guq/cy2njiRLcJjd+TQhzJndQMtCd71mMRH99a2Hkxf5EnribvPE4LFnspAG2AvdHCt6dKH6TxrdEa0X4XdVDg4IghKYs7DUSBo/wu6+1stfs2JtKE/QFIazNYL7xfzDikuLIrW3W1rgC++zPsb84APvn/xTCqUtDr7Rkau2aRArpjLTrdVtGEIbyfXulYfUi+Ouvsb88CPvYD4Rgk47sQrPbwJHcLsMw33tSovOYipcQKMHly8gKlgw4y519T3aSgaj7RlJBKNKAg86ArXf1dICnVdxux98mJZtKNTs3AURgX7p+w5WqDa23tbDrMNj3WGjqiaYAzoj7uGvaBXSbDPiCAFZ8Aq8/3vG72jAl3ZKnXAVf+nFx5Nb23mvKg9hfHgxP/hIal0PfKsm62npTlnT52mR+qVB+XnYNPPdb7C8Ogpdvzf1uhWa5gbuTG3Ic5jv3i1yJgPK00FGCK02UXhuIZGClr2TAvS9MS/t0d5YM2AjSBnPUlRQ0880YuZv4YLpr9a7QC+04K+W2mc/B4rfcvZKHkweICXO3z/A3QOjNkbPlOsWVqlMeFQ0jwVB9Y8dMlcNQJmMfejLmX38r61+om0ecled41ULsHf+Cvet8aZTqWyXfP8p2nVGBtfLzjCO6xs+wf7gKe8OxsPQ9l5UV+GyFaSG5w74J//Jz0cmFlWvrpQSXL1pNpgxMLmbKwLndd8pAEEq5aM8jYbcj/MWw7s+w425xJZAK30LOSd+OuUkWx3p8vY1h7xNgj4PlM+gpurh2tlxpPzJ3JUAm3tcxE+7AeV7usBvm2w/n2uy9sxOXOQUpmP0c9rrh8NpT0Nvdq0XZzVhmd0QXOqJ752XsdYfDaw/l9kshv5u7kzOn/BcMP10y3golOSW4vHuvA1MGejvJQHcV90Zt7gp9iDvRAy6dA7Oec+WmbGXvjyTLf/0xKcN5mzAH0qSRtT2jgmQCaMnCAGfLZT1tuTDSiLRsOaSLNeE2EkwFIeaiR2QgqS2gicLaHNm+dD325i/LfVefqjb3at3hrHFEV5eGltXYO8/FPvVvrruSAn5PV+K0FnPe/TBgYHn6oCrBlYjgqlKwqANTBrqbw4cJZMPvPAgOOMM/e2t1gb9T2sQDVZm0Zvn1jbm7Wl8T5oPOhJ136xmHjwmg2UrZvaZPrjNyU+uSmHC/clvHTLiDEBqymDP/G3Ydnisz+pKGc1mxj12FfehHUlZPsrbuGjQlzShP/xr7+29I2bEQaUXytb22wlx4P8SJjrey7uOU4LzTfrDjf5fbPHk3WDeeMuBmvjHiYnFZKGTmW8MKMcqtMZV797ahTKXWGQM0rMgR2KaiHxvJ2h99ZQ+wdsvZclGoLdf0P8OCDphwByE0tsB+I+H4HxdPbn84H/5xq2Rt2O5vCJ40o2xRDRMew952ulSQCiG5wMkxhhwLJ37f3cdV1pGvBOcbUZVEMtAdzio3823LvpgjLvQ7rNqWm15/uIPlpnIkOCsz8JYtdxPhPU2YrRUnlO36Q6YbT4NPum2Hf9PZcsV+uj8bY1++EVKmyL4SI5lHdTXmnDvbOH74rJPNmRE8cB6MfVDIIs72rH0bZeT3nv4C9vbTZWo9Bdi8GZlEYE77lVRs1lVWqVIJzvtZ68iUgZO7z5QBE8qd4GFniVdeHPtnpFEGO+EOp+FSl4QvBDPVrlsw05ibIrCpQMNGUNcPM+Ki7m3CHEfQK40YcXvacpkA3v0nvD9DgsNisn1XmuSkq2H7ff0s5Nr+DkGI/dMV8PIfhSSiTM/cW1EG+lbDm2Ow95zVJnj2IDnjgovqXpiv3ejufCunTKkEV8hDnkwZWLmgwCkDaczIS7tHKcplo+ao77rDyvM9xsA7L8C8d52pshLcFwiuKgUL58G0x/2yfGc+zOgroF9vdyfU3bptU6LXO/A0seXyyt6cLddLN+Seg4IDMdfUssPOmBN+4rIxzwDA2abZF66D5+7o2eS2PslNeRb76GWu/OgZNCRfe8AZcNCXoDFTMRPBleD8T7B2UwZyUZRH5gMw/Fuw9ZabVzKQSAP2OQ52PMCvE67tgTXuluIPrIrYIokJ801+ovnEvqvfjjDsHCkDdreDx0btbbl8g6H5r8Pssc6Wq4jszRhoiTGn/Nw1tcR+z00iBZj5FDz+M7lzi8qk0zfKiIzghbvh5Ztz7iWFLOtXrsu5syjBKTZUhmLyfcVJBg47azOXopzI+JgCZr4l3XILZ8qBVQkz3zqyP2pC+HAWzH7Oz40iMWE+9gdQm+5esoskINprlL8tlwuA7JgboSUubq8nXb677gnDz/P/ucnXLf8Ie/+3oSrki3b/PX2PRdA7jf3TNfDRxNx8ON8sbuChcMjpPdsLVQmuk8tQiz6BmU9TsGRg1GaUDCQuFLvuA/ucWIA0wB1Yr9wm7w9C3QceH7YdU4AJs41livqBp7ksrhsdPDGY4672q1gktlzLPoDpT0FdUHz2lrHi9pKqyg0azbdRnYejffACWLMKUkH5ZSrWQuD+zvvPh3VrKKjpBIs58acyCaECuqCV4IpBUVMGNrNkwEkDzOgr/KM+a+XAql8C0x5TaYAXIURQm4J3xsNHk/xMmN3ZZI6/xnUcdoM1Ns45ZNA+MPRUT1su0VrZcbfC2uacL2vB+1Tu3jjsbP9ALHbZ29ibYeYE6FVVvpWGOIaaKljwIfbpH/tLB5Kmt10OhX2P6aFeqEpwnX+A9bQpA8ZIG3r/bcWFwnvmW+JE8QCsrJdWeJUG+B3SWYsdc0O7DH7TB08Mux0J+4zuHgdPMgT36KtEyJ7Xlstlb2s+gykPirtLMUSdCMqPuACqenlqNF3jy4r52Gf/E3pVQBk9yorN2Ni7JJDybTpJzqHR36sIk3QluKIe/iKnDNjNNGUgkQYMP1dsjnxmvrV1oph4d8ecKCouCMo6k+6/wpJ3/SLs5OA5rhuYMLcOwd1Bml+8bLlcGXHiPfD5KkgVM0LJjW/qXQ3Dz/evkFhpfbfP/gzq14oLSCUEYgaILfYv1/g34SR9A/ueBDvuCi2ZstbFKcEVXYYqYsqAkwzQ1VMGYjk0zKjL/A+NhARnPdMxJ4pKRZCCpgx27M143ZG0DYAG7795TZjdEFxGXQrVHrZcCQE2N4iNW7HBUBBAcwx7HgXbDvbzm3R6NxZMh8mPQq9U5fijxpE0Jr07Bd580nPEjqs4pWvgoK9BM0pwig1kN27KgJ10b7sIPG8mBZjh53adZCBISePCAadA/z3cYeVzbyhfY8fdCtpXUnwQ9NojsGqRpwmzHNbmmB9uPhNmk7PlMr62XAkBTnsEFi/sQDAkpsrmkLPwttNKplu88D+VOcXaAqHBPn+d/zxHt2jm4H91wUj5lnOV4IreWB2VDHwDmrpAMmBjCHEz3/CrfCXZ28dTYM4klQZ0JAhatRY7/nYKMmE+9Ouw0y7SbNHVB7YJYZ2z5fJ1ujHieWhf/q1rkilyYkCUgS3qpMs3ccTPt7dNKNMtZjxbmdMtrOsJ+GAGvPeiX1NTclbtfBDssAe0RGUbGCjBdYQ4OioZqO1k4jAyq4zdD4U9jipAxyS/qB13K2Rsz5lX1i0PHwOv/h4aVxVgwlwnTQDNm8H5Js5CbRX+tlxZ+Zq3/g4fzYaaVAfKkxZ2OUyE7z7lSfdz7MR7K3y6RSAJ7/g72p0xeYPYMA17Hg8tKMEpNoIQ12xCgZKB/TpfMmDIzXwzxn/mWxDKlOMZT7uoWLO34gjOiin1Z5/BlAfwNmHGwpHfhm236Vrnm6ScfdCpYstlPU2VQTpGTQc3awTseVw78tpkhhykINME0x+Dair3jjh2gdQ7L8pza/ydSsxexzsWKM+mHCW4Dm+sEOZOho8nFyAZcI4iSdmwMzZXoifafie5TPaWBrio+NV7oL5RymyoNKBjmb7BvvI7yKzzM2GOI+i1lZBcUxdm0IktV6uw22P/mwA+nAjvThD9X7HBkI0hDWb3kXilIbE7wN8fD0s+kfluFdsE5WwE65vczEoPsk8Cl10Ogz613dMHVQmuG6BVMnA7hU8ZOAl26STJQKInGvEdqO7lJw1IRLXNa2QKc7UKu0tCcNUp+ORDmPGXgkyYzVHfhb51XXP4BKHo7/YaBbt52nIlDR5jbpDsq9g9bJw8oO8WsMN+ntUQYV8761mITEVOq/4iyYF9669+65cYfffbEbYb4q4ilOAUG4piC54yQG7KwIjOmDLgDowtesGRF3keGOREtW88AUsWu244zd5KcfaQMtixN/q54icmzFsNFP/SLjFhtpLkF2LLZQL49B14828dbPAwkAH6D4He27Tq2vISchzB++MgbVXCYmOoAua9BmuXOe2l9cjADeywP2QpyyBBCa5U5YHVDW7YJZt/ykAyoPKQM2HLnfzbh13t3o6/DbQyWcIt4krZ70+Hd/7pmcXJ3jLH/VAaNzq1Gcn5lA7aB4aeUpgt18u/haZMxxo8TCAZ4Pb7tAm08hzmGFj+ISx9H9JqQiCTLFJQXw/zp/mfQ4DZcb+yfdaV4EpWhjLYYiUDh5Z4yoCNoCpwd3yeOzeJ5uaOgw+mS1lNy5Olzappa8JsvIINdtgPDjjZ2Xd1UpegMeJTevRVEqz52nKtWiQ6v5oSNCJZMNvt5f+8ASyY4WabpXR7Jcd5Fpg3tU3pIP+eZLs9ndbVluOKKEpTHkgkA09RsGRg9BUuSi+Bhie5S9l7lJiq+prVJvcp426RCSNGt0ZJEUciC5k9VspIPllcqwnztXIAdUaWkthybb+Dv09pkkFNuBNWrZXMoUOHo5WTaNvBhb1r4ZuyV3U+Ybt1tAtntn+oNxXYAGy1C1SZsuyW1lOslOiIZGDfY0VgW4q7FgvmqKv8yxTJfcrSOTDrucoUzHZJEhdCS2LC7OkbaGPYfTTsNUI0jaW+i2try1XTJ38zUhIwNa2WTttSTJiwsZTE++3odzAn/37Je2Xd4l74OkqjCcs+8Axs3Tr26Q81vZyov7yCBSW4UkboNSHMnVKgZKCEUwaSQZED94D9Tilg5ptE5HbCnRUumO3sPZKVGWnTn4HP5nrad8W5LC4u8WFerC0XBqY+CEuXis6vQ41IJlcB6b1t+8xio6eW+x1XzHeZrRJc69kRAqs/haZVOdLLw2/U9pNXGWbDSnCljtCLnTKwTwkkA27mGyMvhVS156gRR4INK2DqQ9IRqndvnfjEpaChGTv2txRkwjz0VBi0b2klJcY1I3nbcrnyZbZZXG6qStDc4Rzxqe4FNX3zZ3CuuYVME6xZphnceh8PgYGm1dCw3D9gTtdA7RZluYxKcKXO4moDcQDpasmAMdKJufWWmMPPp+CZb68/DMuW68y3Tj+E3B6Z+pBE2r4mzGEKc+wPSqtXiiPoVYU5xteWy5UvZz4Nn7zvGpFKcC9ogXQtVNX6v2ddveg19QRrv5CBu1NtWJk/g0sCLGOgure7e9cMTrHJEkEyZaCLJQMmFNeLYeeIlsi3nm5CiDLYCXeUJiJX5M+YUykZIPvqXRRmwny2TLouhQlzkJJmpANPhe0KsOWyFjvmxhKeHMbpBKvlRb6igzuwmxucM4zRBG799YxcAOAdXVBYcKEEV8kHWAmmDBQjGYgjqEtLRyaeUX4Skb/zAsx7F6pDJbiu2iM1BjvhbjmIfE2Yq3thRl9eGhPmxJbr2AJtuea+DHNfK702L0wV1kATtcj0AWNQhlvvLLEI+Re0/lVaolR4Hl5FTRlwM5pGXV74eJpEGjD0BBHLWs+5WO5n2nG34BE6K0q5R9IpWPIpTP0jBZkwj7io48YAbaUkg31tudxeeen60peyrPv7Cvme2YwGY5taz6gFr8glCazKtLFMCa6zULBkIOjAlAHRv8hdimdAmwypXDhTtFk6862LDyErJswv3wLZFn8T5t7bwpEXdNyE2YI59poc4fpk+gvfhLf+WfoxTwbpMI0LIKwwLEvvxJKtZytheWrhoowSnMITXTllwIRChrvtL6NGvKUBsvntK7dJZ16gM9+6PIurTsEnc8UcoCAT5iuLd4BPpCSF2HK5g9KOvanz9kqUKUx7GVbnOky18tD+DDFIZ2RB699SlsuoBNdpUVQxkoG2Uwb28msJN0DWYkZ/173fk0iDAOqXwLTHSiPWVRSVRRE4N35r/Zo84hi2GQSHfq04E2ZjIGMxx3xf7r18bbk+nwevP9EJ8wHdgZxtlpdvBaKqTg7x5EBXtD/Va/r47weQph1D2XVQK8F1ZhbXEcnAyEvySwaMkZbg7QbAod+gYGnA5Aekm0+lAZuJ4CJp1pj7OswZ4wjMhzysNIdUF1gqTGYEDtgRDjvbkYOfLZd95TZY01T6+YCO5GlpgOZGr0wSgNq+UN1H+0vWXxsbQTqEui3bE9hGF99I0NS8RjM4RYFPbqtk4N42h4VH5gcw7Nz8zQQmlI7Lwy8QkazPzLeEBDPrsBPvdjPf9LJ+851JBmLXvJH3QGqT5e98IOx/gjNh9szi3IxARl3iyMHTlqvhc5kP2CkmAC6Ia27KuW/ku4tMMrje20hLvKZwOe6PrZB/4gqzSdG8+2fLWmhcVZaieSW4TuW4RDJwfxGSgW3ySAbczLc+Nc5mCb9mloQEZz0DCz92M9+U4DZrpl8XwlsvwifTXZt3vrKhu6s97lp5gr2y7w7Yck26D5Z93nmZvgkgE0vJHPzmmGHEJDhCm03anQmIK413Bgc0rpTgIig7flOC63SCSyQDbxYzZeDyjU8ZSGa+HfgVuZPxnvkmX2PH3aqffrc5l0JoibFjnQlzvkMmKXcPOQb2HO5nwhyEYuZdqC1XSxN2/O2dm+kbN+Zl5Sf5M7i2/37A3jpNYP3gOAtsu7tfuTsJJFYvhuZmvwBcCU7xBYTIEFHfLKvtLLCNTRmwEaTBHF3EzLePp8CcSSoN6E5ZXG0A056UIZ6+JszGYI67xh3yeSKmOAt1VZijC7Tlmv44LJzX+Zm+BfvZ+4Wd5zsfqF6UX/icwex0YGGBwrKPZKK6Kb9OaiW4rji8Sj1lIHDSgCFHOKGuLaCbzkj2lrFluaF7aKov97Vr12FfvhU/E2Z3F3fAV2DXPaX1f2PBU2u2fxoMKMCWK45EGpDqbDssNw/u03falzDyVCHY+RCoTelop3b7CBg03G8dk3d9OtsjSFKCU2wqIytWMrCxKQNRG72c78y3IJQRIzOe7oR2b0XHziaXxU35A6z5zCOLc3d1YRXm6O+7jluz8e+dMpjjCrTleucF+HCmBGidKSOxVubBffqOkFW+UpnTA7LtYNhuiAvWKvwoS8zWt+gjg459qkXJv184Uyd6KzqYxRUsGTAbnjKQtHrvtCsceIaLfn1nviFDKusbS9/urSjBIZ+Cz1dhX70bLxNm44KgYd+SidyZDWRxSba/90jY7cjCbLnG3FBQJtCxv92I1u7z+bn/L98zFYQw5GhoMUpwJoAWYJfDoM92rSXsTWZ7JpCxQ4vfkgDDKsEpii4diGSAYiQDw8+FbZxkIAih2WJGXCwjRuICZr41r5GOThV2d9Nt4rpuJ9wJzWtzBLYpIrKRiHpHXeo6boMv7r24CFuueVNh9sult+Xa1PPR0AKfTPN8Ppx36wFfgZTVTmDXQWn2O91v/ZJ9teQ9+HwhpIKyXEMluC4+vOykNlMGbAGSgUPPlgMsllZvjrgQr1bvpESFgTeegCWLxehXhd3dc49UpWDxInjtYT/JQGLfNfIS2GqL9rpJEzgbt33bTHhPefCGkZE42a68p5V7PjtnrOfJ5fb97qNgwMANZ68VRW4Z6FMjd7Kt+yJfRcfCB+PlXFGzZUVpDq8FOcmALUQycBnUVUFDDId+HbbY3qPVu00maGPp5NTKZDffJxbSBjvut24cTL5yorPv6jsADj+vvQlzYst19FXOt9HDlssE8Nn7MP0Zd0+b7brnI42M44ky7sDNM0IozkoV4+CzoJnKJbjAGT7sfRxsvat/ExEG+84LZXv/pgS3OdARycDex0DsDiw8PfiSktPccfDBdDeFWcuT3ToQqknBx+/CrL+6LD6bP9PHYo65EnpXy9cbN9l5hx3hsHM8bbnEusmOuwUamrs2qrcxVIXw6QewYIbbu/nuIOX5MUd+G3qlK7hpKgbjguDWzzHP52wCaWb6cGJZDzpWguvSfdhGMvBRoVMGLGbYuTB0uIzUsZ7lI0eCdtwtbo6XfuQ95cm0Y673C4SSLG7bPeDgr0JjLK4j6yyMvASqe3vYcjlT5fqlMOWPkr11dSBk5H7Zvvlk8kvl/7ttJNKHA051tmWpytonyTSRQUOl49pHMmQjWdt3nndetOV7ZaGn3ebYkBnrsrgCJAMY2O8UzDfv9S8nJKWKpXNg1nNdW3JSdDAQSsGcyZJ5F2LCfNw1UB1ASwtsuUUBtlzOVPnVu2HF6s1z6NkYqoAZf5EZeT7OGu5fmxP+3en1KqzZJJkm8qUf+5WhWwMmg339kbJnACW4zXF4FTNlAKC2H+ywr+xqr+YSd2hNuFM61Cotuu3RB5d0xeWyOI8gyFrRQO1/IqyI4Ijz/Gy52nbZTrjLddluBqJI7qkXfiDTFSB/mTIZEbXrMDj0DGjMVs4+N6HYtA0eKtNEfCQgbe9Z33sZaspbD6sE1/VPcRvJwH1tiMjzvb5f2+oEvwKmPqTSgB4ZCIUw63lYNCtXjsv3mePuaOsMrTZu+Wy5ki7b1x6BJYtcl+1myoSM66accIcL5HyqHO4O8vTroKbKkWIF+FO66QHmjP+FMO03/DXRw066F9aWf9CrBLdZOM5JBibf6z9lINnRvndoyaH1+sOwbDmkdeZbz3s65X7FjrkRbxNmDOw+GvOt30D/Pfz2jAkhykjnZsps3n2SVDhmPS/OJsZH8O7uIAfsBSdeDQ1ZCMPy3xsNGRh2ukxmjz3GJiX39k2rZBZkBQS9SnCbi+CqUrBoAbz5JN5TBgotX0QZiYSrdOZbz83iApj2hLh8BJ5i3Ko6OPYav6ApzgqJvPU36dys6Qbjk4IUNGWck4on4boM15z8/2DXIdDUktPKlV3mZiAbQ9++mH+9xRGXR8aaNBpNug+WLq2IoFcJbnMiREaRJA9oKQ9GY8RLcN67ThqgBNcDIyEpZ9c35nxMCylR+5TpkvFJY27oPqdBMiNvyiNyV2Q8iN2VNqmqw5x7n8vqDGVZqjQhNEWYb9wsM/F8dG+JNGDdGqkI1FRG0KsEtzkf4mIkA74RHk4aoOjhHBfJJO1J98Pa5X4OOG32QP5AKBA3i/cmutmD3aFkldwfr8P+/T8deXn8zUEoGengEZgz/xvWZpznajkFxSlY0wLHngeHX9jGnNonewtg3C3ilFMhg46V4DZ3JJax2Fd+V7pIMylDLJwJs8fqzLceT3BWNG3LP3c+piW8N0k0kmNucJOxu9FxEGehVwomPyYBYOC5jxOSO/EnMOrrUN8sDRjlQm4NLbDnoZiz73QBiqfRuglh1SLsC79x/qKVUdFRgtvcWVxtAG8+XbhkYBPBLxgpaTVHBcyJU3RfknNNSeNvl6YkU4LJy0lEv/htePMf7tDrZhpJYyCOsX/+fpvnIt/fbVrdf8z5D8A+R8KaMiC5MJR7xf4DMZc/JRZlxrPL1E0WsE//G6xa7YyVK6PhTAluc5diwhSsbpS23WQzdiTaD0KoXwLTHhONi0oDyoPgqlKw6BOY9qfSlLOTQOjl34qWqjsGQnEEtWl453Uprflmccmhn67FfPdZ2O0AWNuDSS6Uphu22A5z1XPQb6dcedlnDYOU3Me/+nDFWZopwXWT6JzJ9xUoGdhIVA7SAlzmFjyVt09kZpode7PrfAw7tueCAFYuhNf+1L2H38Yx1IXYJ/8DPpvr3Dp8Rk25xpReW2N++E/Y/ZCemcklZcktd8Rc/SJsv4+fJCDZM8bAunrsw5e5rtLKOg+U4LpNdN5mykBRh43TuGTWYSferdKActwnNSF89Ba8/Q8/E+ZNfS8MdvwdsHptNx9+ayEMoLEB++CFQnjJqBdfkuvdH3P1GDjoRFjdLORgunl3pTGug7YFBu6H+fErYrgeF3Dt4MrQ9vErYfE8N5m9ss4EJbhuE6kVOGVgQ6UIY2DmM7DwY5UGlCWM9Jj4mjBvLKoPQmhcBZN+3zPEvnEEvarg7UnYv/5UsrjIk9wTkqvZAnPl3+HLV4pAOht13w7LpFO2vgWGfxXz4/GwzeDCyC12lmVTHoBxD0LvKogq77pCCa67PMA1IcydDB9NKu6OJdEzvXKrfqrlvE9qU/DOBPjw1QJMmNeL6jEw5Q+w9LOeI/aNstA7Dc/+n5gjhGn/DNYkTRUB5qxbMJc/DHXbSrt9EHYfQbgJXPCRAZvGnPNrzOVPigetj89k230SpGDhm9g/XuHE+5V5F69HYbcJzkPIkBP0FpO9fTwF5kxSaUBZ75NATJhfuqE1qSuA3WSfZZslEOpxZWyZGWfvOx8Wz5JD3HefG+O8GyM47BzMf7wOh/+rNG8kTTabSyZhAskmM1nR7u19FOYnE+GEH8nnY20BFn2OCNcux955JmSaZKBphd7FK8F1q+g8kQx8UoRkwGDH3QoZ27EGBEU33ydZaemf+Xf4dLafy8f6gdCMJ+GTD3teGds12rBuLfa2M6RbOJkm4PmMtHZibrUL5tLHMVc9C7seKsTSnJVsrkvu6NzvEoRCbPUtsO1gzEW/x1w7DnY+JDe41vd3SUgsasHedSYs/ghq0hWjeVOC695Pb6tkgIkFTBlIIrYV82UET22g2VvZP7WheDWOvQlvr8YkU7AxduyNLqrviQQfy6G95GPsbafLiB9TYDCYBI82hv1Pw/x0CubSB2HQodCUlTu6KMoRUKkyO5OQmisZNmbkZ/UfgvnWjZj/NwNGfEc+TxsX5vSfvMcE2Pu+BW+Nr9h7NyW4bstxyZSBAiQDyfiLV++B+sZu3hGnKGm2/9qfnEGARxaX6KbeGwPvT+vZ9zKRazqZ+zr29jMgu66wTDYh++QO04Rw+LmYn76G+cE/4IivQ00/yeoaMpJhgRBOkMqRXpJdfeEV5O7TkvcYI40tjRkZUxPWwgEnYS5/FPPzN+H4H0J1n1yWXQipWgtIoGsfuggmPgF9q/wbccoYOgGzuxFcVQoWO8nAsG/muqE2trGTQZWT79eZbxWX7Tdgx9+O+cr/5JxJNpU94Gy5LDlz4p6KKAt9qmDWWOztZ0gzRrqusE7DJJvDSmYYhDD0ZMzQk2HVInj3Rezbz8G8qfD5fGhskTULkAxYBmO3vwe17hW3eQGkgS0HwMBDMPucBPueBP13bxOAOG1joYL7hNRNiH3kMnjpXlkXJTcluG4LJxkww76ZZxJzBCYFbzwBSxZLl5mWJyuE45wJ88R74Us/hrp+Gx+bEkeS5S2YDm+/6Gy5ymCfJCQ34wXsLV8WC6u6LTcdFG6Y/XPEkqxLvx3hiAswR1wg1ZQl78HCmdhPZ8OyD4QAG1dAcwNELbkycZiG6l5QuyVssT1sMxiz/T6w0wEi0q7doj05Wevu/Yo4ihMytzH2gfNg3B9lPWIlNyW47lx+ajtlYLfDNx6VJncq42+TT1IrkxVEcM6E+bNlkr0fdzXYrAQ8GznE7ZiboDmGdJV8bTkgIbnZr2CvPxpzxZNOM5YtjjSS58zanKSiqg4GHgwDD27ftBplpEsx29Lq90hYBekaSFVvPONKxtuYoHiP9eTva1qF/f058MZzWpbc0MepS9AN4TNlILlTmTsOPpjuOuI0e6sskouhysg+yTRt2IQ5seVa/hG88ZfybEKKstJQ8cks7P+OgPdeyll6Fdslakzuvi1p4Iiz7hXJOodpqOkLvbeBPv2h97aSoSXktv57knb/IFV844q1OXL7dDb216NhupKbElxPy+JqjXRFrtiIZCAZdTLuFqnzG/0oK5LgqlOw4GOY/sSGDQLc4FP7yu9gTVP5NiFFWTFmXrMUe9OJ8ML/tWkk6eDBnzR9tG0ywcg62g28kvVd/z0dlR4kDShBCl57WMh84Vt656YE1+NOLokO6zcyZSApcSydA7Oec1G5bvBK3SpiwnyTu5MN25NbEMig1Ml/kKCpnLP8OIJ0Stbj0X/H3vplWPahK1XaTshczYa7KEs9RTzJRIMQGlZgH7wIe9e3oGW1SCaU3JTgemZ0buR+ZX3JQGKWO+FOcRoP9Cq1cveJu7P94E2Y/UL7LC65Q5p0LyxfIXd25e5okQSCfapgxnPYXx0GY2/JEYSNe06JNvldk0z0jSewvzoUXr4X6tIyI06bypTgeuyD2ioZeJLWKQOJNKBhBUx9SKUBitaMIWfC7MTfJoSWRhmUWl1J0yXcPVWvNDSvxP7x+1LOm/18Tp9mbe556na/eySyheR3nT8N+7vTsLd/HT7/2HVKRjoKSwmuDNA6ZUDuUogy8s/XH4Zly3uOWW6nngk2V8bxeZUb4kha/2ePEz9ScOJnA288JoNSqypwukQcSZbTOw0fTcXefLKULd8bk3MVScYOJY0jmzVby5Kz8ApgwQzs/edh//dwmPE3qEtJCVZLkt7Q2lZ3f0BrUiIZ+HgqDDq8tY3Zjr9DZ7617uIqZ1hb5ZnwlGFcZ0LIRtiXbsBc/ASka2WfjL1Z/BsrNQZK2v1rUrIGbz6Hfes52PMozKhLYP/ToKZP+2cuyYI74z5t/aAMm+uqTBpi3n0JO+EemPWsWIfVBVKS1HKkElz5HVwBZMG+dD3mjP+T5+398bDgXZ35hpX1WLVYmgk2qQNrg0xTp51bmy8Yykqz0cxn4d0XYdvdYO4rMG+WSkggZzhcl5Zn5t1XsLNfgQG7wIFnYA76Fxg0/Iv6tXaZXRvSM+QhP+veZnOEllRhksyxbUPQghnYmc/A9L/AJ29LZ3RtkDNvUHIr7viMLg9WBwF9Y4s15ffYl9cDmkrLf89m/HwqKykIKKQFO47Ld+2SgzRM6z7ZFBJBd0sGWhArrQF7wJCjMXseC7seBtsMyp/tt5UFtCPBPFi1SEhtzjiYMxYWvglNFqqQcrIx5b1PleAU631UbXzn9GPacLTsu5QVsH6tM8T0gMwfHAWS4bZE4K646VUN2w6G7YdidhwK2+0JWw2EvgPEFq2qlwQRG13/CFqaoGkVrPkMViyAz97HLn4bFr8Nn70Pa+ohQupoVUHHxekKJbgeT3Kgh9Ym18aTECtiPXSfFEV2WGnmyiKvGGnHSwPV1VDbF6r7Qk1vMXgO07kJ41FWSuAtDbCuHprqxa+yBSEz4wgthavIGCW1ToTewfW0TEWha6Pr0UlLFrdz56fKiLyi1bUkhmwzrF4G8bLc5IC2y23avILkFUqjSKv9kCs96r2aEpxCoVBslgDBbqD0bUJ3ajqy2lC527ZhvaTRRMlMCU6hUCi6P/G1Sdk0Ue7WUKG3QqFQKJTgFAqFQqFQglMoFAqFQglOoVAoFAolOIVCoVAolOAUCoVCoQSnUCgUCoUSnEKhUCgUSnAKhUKhUCjBKRQKhUKhBKdQKBQKhRKcQqFQKJTgFAqFQqFQglMoFAqFQglOoVAoFAolOIVCoVAolOAUCoVCoVCCUygUCoUSnEKhUCgUSnAKhUKhUCjBKRQKhUKhBKdQKBQKhRKcQqFQKJTgFAqFQqFQglMoFAqFQglOoVAoFAolOIVCoVAolOAUCoVCoVCCUygUCoUSnEKhUCgUSnAKhUKhUCjBKRQKhUKhBKdQKBQKRQeRAgzyH8boeigUCoWijAguA2QsWOvITqFQKBSKno7/D0xpA5bI189hAAAAAElFTkSuQmCC"

@fabric_router.get("/api/fabric/receiving/sheets/{sheet_id}/scoresheet",
                   response_class=Response)
def receiving_scoresheet(sheet_id: int):
    """Print-ready 4-Point QC score sheet (blank for hand-written scoring).
    Returns self-contained HTML with Vivo logo, PO/fabric header, and a
    per-roll scoring table (Roll No., Length, four defect columns, Total
    Points, Pts/100 yd, Pass/Fail, Notes). A reference legend for the
    AATCC/ASTM 4-point scale and the pass threshold (<=40 pts/100 yd) sits
    at the bottom."""
    def _e(v):
        v = "" if v is None else str(v)
        return (v.replace("&", "&amp;").replace("<", "&lt;")
                  .replace(">", "&gt;").replace('"', "&quot;"))

    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        sheets = q(conn, """
            SELECT s.id,
                   COALESCE(NULLIF(BTRIM(p.barcode),''),
                            NULLIF(BTRIM(p.default_code),''), s.barcode) AS barcode,
                   COALESCE(NULLIF(BTRIM(p.name),''),  s.fabric_name)   AS fabric_name,
                   COALESCE(NULLIF(BTRIM(p.fabric_supplier_name),''), '') AS supplier,
                   s.po_name,
                   to_char(s.po_date, 'DD Mon YYYY')  AS po_date,
                   s.rolls_count,
                   to_char(now() AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY') AS today
            FROM fabric_receiving_sheets s
            LEFT JOIN raw_fabric_products p ON p.id = s.product_id
            WHERE s.id = %s AND s.deleted_at IS NULL
        """, (sheet_id,))
        if not sheets:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        sh = sheets[0]
        if not sh.get("rolls_count"):
            raise HTTPException(status_code=400,
                                detail="no rolls recorded on this sheet")
        rolls = q(conn, """
            SELECT roll_no, length_yards, after_wash_width_cm
            FROM fabric_receiving_rolls
            WHERE sheet_id = %s AND deleted_at IS NULL
            ORDER BY roll_no, id
        """, (sheet_id,))

    # Build roll rows — scoring columns blank for hand-filling; pre-fill
    # Length (yards) and Width (cm post-wash) from stored measurements.
    roll_rows = []
    for r in rolls:
        yds = "" if r.get("length_yards") is None else str(r["length_yards"])
        raw_w = r.get("after_wash_width_cm")
        wid_cm = "\u2014 not measured" if raw_w is None else str(round(float(raw_w), 1))
        roll_rows.append(
            "<tr>"
            "<td class=\"c\">" + _e(str(r["roll_no"])) + "</td>"
            "<td>" + _e(yds) + "</td>"
            "<td class=\"c\">" + _e(wid_cm) + "</td>"
            "<td></td>"
            "<td></td><td></td><td></td><td></td>"
            "<td></td><td></td>"
            "<td></td>"
            "<td></td><td></td><td class=\"c\"></td><td></td>"
            "</tr>"
        )
    # Pad to at least 5 rows for readability
    for _ in range(max(0, 5 - len(rolls))):
        roll_rows.append(
            "<tr>"
            "<td></td><td></td><td></td><td></td><td></td><td></td>"
            "<td></td><td></td><td></td><td></td><td></td><td></td>"
            "<td></td><td></td><td></td>"
            "</tr>"
        )
    roll_rows_html = "\n".join(roll_rows)

    fabric_name = _e(sh.get("fabric_name") or "")
    barcode     = _e(sh.get("barcode")     or "")
    supplier    = _e(sh.get("supplier")    or "")
    po_name     = _e(sh.get("po_name")     or "")
    po_date     = _e(sh.get("po_date")     or "")
    rolls_count = _e(str(sh.get("rolls_count") or len(rolls)))
    today       = _e(sh.get("today")       or "")
    sid         = _e(str(sheet_id))

    css = """
@page{size:A4 landscape;margin:10mm;}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:11px;}
@media screen{
  body{padding:12px;background:#f5f5f5;}
  .page{background:#fff;max-width:1060px;margin:0 auto;padding:12px 16px;
        box-shadow:0 2px 12px rgba(0,0,0,.18);border-radius:4px;}
}
@media print{
  body{background:#fff;}
  .page{padding:0;box-shadow:none;}
  .no-print{display:none!important;}
}
.hd{display:flex;align-items:flex-start;justify-content:space-between;
    border-bottom:2.5px solid #111;padding-bottom:8px;margin-bottom:10px;}
.hd-left{flex:1;}
.hd h1{margin:0 0 2px;font-size:17px;font-weight:800;letter-spacing:.02em;
       text-decoration:underline;text-underline-offset:4px;}
.hd-sub{font-size:11px;color:#444;margin-top:2px;}
.logo{height:44px;width:auto;border-radius:3px;flex-shrink:0;margin-left:16px;}
.info{display:grid;grid-template-columns:repeat(4,1fr);gap:0;
      border:1.5px solid #111;margin-bottom:10px;}
.info-cell{border-right:1px solid #111;border-bottom:1px solid #111;
           padding:4px 7px;min-height:28px;}
.info-cell:nth-child(4n){border-right:none;}
.info-cell:nth-last-child(-n+4){border-bottom:none;}
.info-lbl{font-size:9px;font-weight:700;text-transform:uppercase;
          letter-spacing:.04em;color:#555;display:block;margin-bottom:1px;}
.info-val{font-size:12px;font-weight:700;}
.score-wrap{overflow-x:auto;margin-bottom:10px;}
table.score{width:100%;border-collapse:collapse;font-size:10.5px;}
table.score th,table.score td{border:1px solid #111;padding:3px 5px;white-space:nowrap;}
table.score thead th{background:#333;color:#fff;font-size:9.5px;
                     text-transform:uppercase;letter-spacing:.03em;
                     text-align:center;line-height:1.3;}
table.score thead .grp{background:#555;color:#fff;text-align:center;
                       font-size:9px;letter-spacing:.04em;padding:2px 5px;}
table.score tbody td{height:22px;}
table.score tbody td.c{text-align:center;}
table.score tfoot td{background:#f0f0f0;font-weight:700;font-size:10px;padding:4px 5px;}
.legend{border:1.5px solid #111;padding:6px 10px;}
.legend h3{margin:0 0 5px;font-size:11px;font-weight:800;text-transform:uppercase;
           letter-spacing:.04em;}
.legend-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 24px;}
.legend-row{display:flex;gap:8px;line-height:1.4;}
.legend-pt{flex-shrink:0;font-weight:700;min-width:22px;color:#c00;}
.threshold{margin-top:6px;padding:4px 8px;background:#fff3cd;
           border:1px solid #f0c040;border-radius:3px;
           font-size:10px;font-weight:700;}
.threshold b{color:#c00;}
.footer{margin-top:8px;font-size:9px;color:#777;text-align:right;}
"""

    html = (
        "<!DOCTYPE html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<title>4-Point QC Score Sheet \u2014 " + fabric_name + "</title>\n"
        "<style>" + css + "</style>\n"
        "</head>\n"
        "<body>\n"
        "<div class=\"page\">\n"
        "\n"
        "<div class=\"hd\">\n"
        "  <div class=\"hd-left\">\n"
        "    <h1>4-POINT QC SCORE SHEET</h1>\n"
        "    <div class=\"hd-sub\">AATCC/ASTM 4-Point Fabric Inspection System"
        " &mdash; recorded roll lengths are pre-filled; remaining columns"
        " are hand-written during inspection</div>\n"
        "  </div>\n"
        "  <img class=\"logo\" src=\"" + _SCORESHEET_LOGO + "\" alt=\"Vivo\">\n"
        "</div>\n"
        "\n"
        "<div class=\"info\">\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">Supplier</span>"
        "<span class=\"info-val\">" + supplier + "</span></div>\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">PO Number</span>"
        "<span class=\"info-val\">" + po_name + "</span></div>\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">PO Date</span>"
        "<span class=\"info-val\">" + po_date + "</span></div>\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">Date Printed</span>"
        "<span class=\"info-val\">" + today + "</span></div>\n"
        "  <div class=\"info-cell\" style=\"grid-column:span 2\">"
        "<span class=\"info-lbl\">Fabric Name</span>"
        "<span class=\"info-val\">" + fabric_name + "</span></div>\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">Barcode</span>"
        "<span class=\"info-val\">" + barcode + "</span></div>\n"
        "  <div class=\"info-cell\"><span class=\"info-lbl\">Total Rolls</span>"
        "<span class=\"info-val\">" + rolls_count + "</span></div>\n"
        "</div>\n"
        "\n"
        "<div class=\"score-wrap\">\n"
        "<table class=\"score\">\n"
        "  <thead>\n"
        "    <tr>\n"
        "      <th rowspan=\"2\">Roll No.</th>\n"
        "      <th rowspan=\"2\">Length<br>(yards)</th>\n"
        "      <th rowspan=\"2\">Width<br>(cm)</th>\n"
        "      <th rowspan=\"2\">Cuttable<br>Width (cm)</th>\n"
        "      <th colspan=\"4\" class=\"grp\">Defect Points (circle applicable)</th>\n"
        "      <th rowspan=\"2\">Running<br>(yds run)</th>\n"
        "      <th rowspan=\"2\">Selvedge<br>(excl.)</th>\n"
        "      <th rowspan=\"2\">Defects<br>At (yd)</th>\n"
        "      <th rowspan=\"2\">Total<br>Points</th>\n"
        "      <th rowspan=\"2\">Pts /100 yd</th>\n"
        "      <th rowspan=\"2\">Pass / Fail<br>(&#x2264;40 pts)</th>\n"
        "      <th rowspan=\"2\">Notes</th>\n"
        "    </tr>\n"
        "    <tr>\n"
        "      <th>&#x2264;3&Prime; defect<br>&times;1 pt</th>\n"
        "      <th>3&ndash;6&Prime; defect<br>&times;2 pts</th>\n"
        "      <th>6&ndash;9&Prime; defect<br>&times;3 pts</th>\n"
        "      <th>&gt;9&Prime; defect<br>&times;4 pts<br>hole &gt;1&Prime;=4 / &#x2264;1&Prime;=2</th>\n"
        "    </tr>\n"
        "  </thead>\n"
        "  <tbody>\n"
        + roll_rows_html + "\n"
        "  </tbody>\n"
        "  <tfoot>\n"
        "    <tr>\n"
        "      <td colspan=\"11\" style=\"text-align:right;\">TOTALS</td>\n"
        "      <td></td><td></td><td></td><td></td>\n"
        "    </tr>\n"
        "  </tfoot>\n"
        "</table>\n"
        "</div>\n"
        "\n"
        "<div class=\"legend\">\n"
        "  <h3>AATCC/ASTM 4-Point Defect Scale Reference</h3>\n"
        "  <div class=\"legend-grid\">\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">1 pt</span>"
        "<span>Defect up to 3&Prime; (7.5 cm) in length</span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">2 pts</span>"
        "<span>Defect over 3&Prime; up to 6&Prime; (15 cm) in length</span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">3 pts</span>"
        "<span>Defect over 6&Prime; up to 9&Prime; (22.5 cm) in length</span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">4 pts</span>"
        "<span>Defect over 9&Prime; (22.5 cm) in length</span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">Holes</span>"
        "<span>Hole &#x2264; 1&Prime; = <b>2 pts</b>; hole &gt; 1&Prime; "
        "(or size not measured) = <b>4 pts</b></span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">Run</span>"
        "<span>RUNNING defect = <b>4 pts per yard</b> it runs "
        "(note yards run in the Running column)</span></div>\n"
        "    <div class=\"legend-row\"><span class=\"legend-pt\">Selv.</span>"
        "<span>Selvedge / uncuttable-zone defects: tick Selvedge and "
        "<b>exclude from the point total</b> (logged for the record)</span></div>\n"
        "  </div>\n"
        "  <div class=\"threshold\">\n"
        "    Formula: <b>Pts / 100 yd = (Total Points &divide; Roll Length in yards)"
        " &times; 100</b> &nbsp;&nbsp; "
        "Pass threshold: <b>&#x2264; 40 points per 100 yards</b>"
        " &nbsp;&nbsp; Max 4 penalty points per linear yard regardless of"
        " defect count.\n"
        "  </div>\n"
        "  <div class=\"threshold\">\n"
        "    Lot acceptance: <b>average Pts/100 sq.yd across the delivery's"
        " rolls &#x2264; 20</b> (or the sheet's configured lot limit) &mdash;"
        " the lot fails even when individual rolls pass if the average"
        " exceeds the limit.\n"
        "  </div>\n"
        "</div>\n"
        "\n"
        "<div class=\"footer\">Sheet ID " + sid
        + " &middot; Printed " + today
        + " &middot; Vivo Fashion Group</div>\n"
        "\n"
        "<div class=\"no-print\" style=\"margin-top:16px;text-align:center;\">\n"
        "  <button onclick=\"window.print()\" "
        "style=\"padding:8px 24px;font-size:14px;cursor:pointer;"
        "background:#1a5c38;color:#fff;border:none;border-radius:6px;"
        "font-weight:700;\">Print / Save as PDF</button>\n"
        "</div>\n"
        "\n"
        "</div>\n"
        "</body>\n"
        "</html>"
    )
    return Response(content=html, media_type="text/html; charset=utf-8")


# ═════════════════════════════════════════════════════════════════════════════
# Create Products in Odoo — bulk fabric product creation with preview/confirm.
#
# The fabric/buying team enters rows in an editable grid (or uploads the .xlsx
# template). Rows are STAGED in Postgres and validated read-only against live
# Odoo (required fields, numerics, duplicate SKU/barcode lookup). Nothing is
# written to Odoo until the user reviews the preview and explicitly confirms;
# duplicates are ALWAYS skipped, never overwritten. Every batch and per-row
# outcome is audited to app_activity_log.
#
# Access is deliberately narrow: admin role OR the explicit allow-list below —
# ONE helper (_product_create_allowed), enforced on every endpoint, mirroring
# the _insp_can_approve pattern (no scattered checks).
# ═════════════════════════════════════════════════════════════════════════════

_PRODUCT_CREATE_EMAILS = {"bedan@vivofashiongroup.com"}


def _product_create_allowed(request):
    """True when the signed-in user may use the Create Products feature:
    admin role OR an explicitly allow-listed email. THE single gate."""
    u = getattr(request.state, "user", None) or {}
    if (u.get("role") or "").strip().lower() == "admin":
        return True
    return (u.get("email") or "").strip().lower() in _PRODUCT_CREATE_EMAILS


def _require_product_create(request):
    if not _product_create_allowed(request):
        raise HTTPException(status_code=403,
                            detail="Product creation is restricted")


_PC_TABLES_READY = False


def _ensure_pc_tables(conn):
    global _PC_TABLES_READY
    if _PC_TABLES_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_product_batches (
                id               SERIAL PRIMARY KEY,
                created_by       TEXT,
                created_by_email TEXT,
                status           TEXT NOT NULL DEFAULT 'preview',
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                confirmed_at     TIMESTAMPTZ,
                summary          JSONB
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_product_batch_rows (
                id            SERIAL PRIMARY KEY,
                batch_id      INTEGER NOT NULL,
                row_no        INTEGER NOT NULL,
                data          JSONB NOT NULL,
                status        TEXT NOT NULL,
                message       TEXT,
                existing_odoo TEXT,
                odoo_id       BIGINT
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fabric_pc_rows_batch "
                    "ON fabric_product_batch_rows(batch_id)")
    conn.commit()
    _PC_TABLES_READY = True


# Grid/template columns. kind: 'text' | 'num'. Required: product_name + sku.
# Order here IS the template column order and the grid column order.
_PC_FIELDS = [
    ("product_name",         "Product Name",          "text", True),
    ("sku",                  "SKU (default_code)",    "text", True),
    ("barcode",              "Barcode (blank = SKU)", "text", False),
    ("sales_price",          "Sales Price (per kg)",  "num",  False),
    ("cost",                 "Cost (per kg)",         "num",  False),
    ("fabric_name",          "Fabric Name",           "text", False),
    ("fabric_status",        "Fabric Status",         "text", False),
    ("fabric_colour",        "Fabric Colour",         "text", False),
    ("fabric_supplier_name", "Fabric Supplier Name",  "text", False),
    ("plain_print",          "Plain/Print",           "text", False),
    ("source_country",       "Source Country",        "text", False),
    ("source_city",          "Source City",           "text", False),
    ("fabric_structure",     "Fabric Structure",      "text", False),
    ("fabric_category",      "Fabric Category",       "text", False),
    ("fabric_subcategory",   "Fabric Sub-Category",   "text", False),
    ("width_m",              "Width (m)",             "num",  False),
    ("primary_color",        "Primary Color",         "text", False),
    ("supplier_fabric_code", "Supplier Fabric Code",  "text", False),
    ("gsm",                  "GSM",                   "num",  False),
    ("fiber_content",        "Fiber Content %",       "text", False),
    ("noos_fabric",          "NOOS Fabric (yes/no)",  "text", False),
]
_PC_KEYS = [f[0] for f in _PC_FIELDS]
_PC_LABEL_TO_KEY = {f[1].strip().lower(): f[0] for f in _PC_FIELDS}
# Also accept the bare key as a header when re-uploading edited files.
_PC_LABEL_TO_KEY.update({f[0]: f[0] for f in _PC_FIELDS})

# Odoo custom attribute columns (same mapping extract_fabric.py reads).
# Each is a many2one to an options model; values are resolved by name and
# created when missing.
_PC_ATTR_FIELDS = {
    "plain_print":          "x_vivo_attr_100",
    "fabric_structure":     "x_vivo_attr_101",
    "fabric_category":      "x_vivo_attr_102",
    "fabric_subcategory":   "x_vivo_attr_103",
    "width_m":              "x_vivo_attr_25",
    "gsm":                  "x_vivo_attr_38",
    "primary_color":        "x_vivo_attr_48",
    "supplier_fabric_code": "x_vivo_attr_43",
    "fiber_content":        "x_vivo_attr_46",
    "source_city":          "x_vivo_attr_124",
    "source_country":       "x_vivo_attr_125",
    "fabric_supplier_name": "x_vivo_attr_42",   # Vendor/Supplier attribute
}

# Fields that live in the `product_properties` properties bag (matched by the
# property definition's display label, case-insensitive substring).
_PC_PROPERTY_LABELS = {
    "fabric_name":          ("fabric name",),
    "fabric_supplier_name": ("fabric supplier name",),
    "fabric_colour":        ("fabric colour", "fabric color"),
    "fabric_status":        ("fabric status",),
    "noos_fabric":          ("noos",),
}

_PC_FIXED_DEFAULTS = {
    "purchase_ok": True,
    "sale_ok": False,
}


def _pc_num(v):
    """Parse a numeric cell; returns (float_or_None, error_or_None)."""
    if v in (None, ""):
        return None, None
    try:
        f = float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None, "not a number"
    if f < 0:
        return None, "cannot be negative"
    return f, None


def _pc_clean_rows(raw_rows):
    """Normalize incoming grid rows → list of {key: str} dicts + per-row errors.
    Returns (rows, None) where each row dict carries _errors: [msgs]."""
    if not isinstance(raw_rows, list):
        raise HTTPException(status_code=400, detail="rows must be a list")
    if len(raw_rows) > 500:
        raise HTTPException(status_code=400,
                            detail="at most 500 rows per batch")
    out = []
    for i, r in enumerate(raw_rows, start=1):
        if not isinstance(r, dict):
            raise HTTPException(status_code=400, detail=f"row {i}: invalid")
        row, errs = {}, []
        for key, label, kind, required in _PC_FIELDS:
            v = r.get(key)
            if v is None:
                v = ""
            v = str(v).strip()
            if kind == "num" and v:
                f, err = _pc_num(v)
                if err:
                    errs.append(f"{label}: {err}")
                else:
                    v = ("%g" % f)
            row[key] = v[:300]
            if required and not row[key]:
                errs.append(f"{label} is required")
        if not row.get("barcode"):
            row["barcode"] = row.get("sku", "")
        if not row.get("fabric_status"):
            row["fabric_status"] = "Active"
        row["_errors"] = errs
        out.append(row)
    # Intra-batch duplicate SKUs/barcodes (first occurrence wins)
    seen = {}
    for i, row in enumerate(out):
        for k in ("sku", "barcode"):
            v = (row.get(k) or "").lower()
            if not v:
                continue
            if v in seen and seen[v] != i:
                row["_errors"].append(
                    f"duplicate {k.upper()} within this batch (row {seen[v]+1})")
            else:
                seen.setdefault(v, i)
    return out


def _pc_find_existing(odoo, rows):
    """Read-only duplicate lookup against live Odoo. Returns
    {lowercased code: 'name [default_code]'} for every SKU/barcode that
    already exists on any product.product."""
    codes = set()
    for r in rows:
        for k in ("sku", "barcode"):
            v = (r.get(k) or "").strip()
            if v:
                codes.add(v)
    if not codes:
        return {}
    db, uid, pwd, models = odoo
    codes_l = sorted(codes)
    hits = _odoo_kw(models, db, uid, pwd, "product.product", "search_read",
                    [["|", ["default_code", "in", codes_l],
                          ["barcode", "in", codes_l]]],
                    {"fields": ["id", "name", "default_code", "barcode"],
                     "limit": 2000})
    existing = {}
    for h in hits:
        ident = "%s (Odoo id %s, SKU %s)" % (
            h.get("name") or "?", h.get("id"), h.get("default_code") or "—")
        for k in ("default_code", "barcode"):
            v = (h.get(k) or "").strip().lower()
            if v:
                existing[v] = ident
    return existing


def _pc_apply_dup_status(rows, existing):
    """Set per-row preview status from validation errors + duplicate lookup."""
    for r in rows:
        errs = r.get("_errors") or []
        dup = None
        for k in ("sku", "barcode"):
            v = (r.get(k) or "").strip().lower()
            if v and v in existing:
                dup = existing[v]
                break
        if errs:
            r["_status"], r["_message"], r["_existing"] = \
                "error", "; ".join(errs)[:500], None
        elif dup:
            r["_status"] = "duplicate"
            r["_message"] = "Already exists in Odoo — will be skipped"
            r["_existing"] = dup[:300]
        else:
            r["_status"], r["_message"], r["_existing"] = "will_create", "", None
    return rows


def _pc_summary(rows, key="_status"):
    s = {}
    for r in rows:
        s[r.get(key) or "?"] = s.get(r.get(key) or "?", 0) + 1
    return s


@fabric_router.get("/api/fabric/products/rights")
def pc_rights(request: Request):
    return {"allowed": _product_create_allowed(request)}


@fabric_router.get("/api/fabric/products/template")
def pc_template(request: Request):
    _require_product_create(request)
    import io
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Products"
    head_fill = PatternFill("solid", fgColor="1A5C38")
    for c, (_key, label, kind, required) in enumerate(_PC_FIELDS, start=1):
        cell = ws.cell(row=1, column=c, value=label + (" *" if required else ""))
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = head_fill
        cell.alignment = Alignment(vertical="center")
        ws.column_dimensions[cell.column_letter].width = max(len(label) + 4, 14)
    ws.freeze_panes = "A2"
    ex = ["AL SAWAE Linen - Beige", "ALSW-LIN-BEI", "", "950", "620",
          "AL SAWAE Linen", "Active", "Beige", "Al Sawae Textiles", "Plain",
          "China", "Guangzhou", "Woven", "Linen", "Linen Blend", "1.45",
          "Beige", "ALS-889", "180", "55% Linen 45% Viscose", "no"]
    for c, v in enumerate(ex, start=1):
        ws.cell(row=2, column=c, value=v).font = Font(italic=True, color="888888")
    notes = wb.create_sheet("Instructions")
    notes["A1"] = "Create Products in Odoo — template"
    notes["A1"].font = Font(bold=True)
    for i, t in enumerate([
        "Columns marked * are required (Product Name, SKU).",
        "Barcode defaults to the SKU when left blank.",
        "Sales Price / Cost / Width (m) / GSM must be numbers.",
        "Row 2 of the Products sheet is an EXAMPLE — replace or delete it.",
        "Fixed values applied automatically: Purchase=on, Sales & POS=off, "
        "Product Type=Goods (tracked), Unit=kg, Category=02. Raw Materials-Fabric.",
        "Duplicate SKUs/barcodes already in Odoo are SKIPPED, never overwritten.",
    ], start=3):
        notes.cell(row=i, column=1, value="• " + t)
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument"
                   ".spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="create_products_template.xlsx"'})


@fabric_router.post("/api/fabric/products/upload")
async def pc_upload(request: Request):
    """Parse an uploaded .xlsx/.csv (raw body; filename via X-Filename header)
    into grid rows. Nothing is staged — the client loads these into the grid
    for review and then calls /stage."""
    _require_product_create(request)
    import io
    fname = (request.headers.get("x-filename") or "upload.xlsx").lower()
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(body) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 5 MB)")
    grid = []
    try:
        if fname.endswith(".csv"):
            import csv
            text = body.decode("utf-8-sig", errors="replace")
            grid = [row for row in csv.reader(io.StringIO(text))]
        else:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(body), read_only=True,
                                        data_only=True)
            ws = wb["Products"] if "Products" in wb.sheetnames else wb.active
            for row in ws.iter_rows(values_only=True):
                grid.append(["" if v is None else str(v) for v in row])
            wb.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400,
                            detail=f"Could not read the file: {e}")
    if not grid:
        raise HTTPException(status_code=400, detail="The file has no rows")
    # Map headers → keys (accept label with/without trailing " *", or raw key)
    hdr = [str(h or "").strip().rstrip("*").strip().lower() for h in grid[0]]
    col_keys = [_PC_LABEL_TO_KEY.get(h) for h in hdr]
    if not any(col_keys):
        raise HTTPException(status_code=400,
            detail="No recognizable columns — download the template and "
                   "keep its header row")
    rows = []
    for raw in grid[1:]:
        if not any(str(v or "").strip() for v in raw):
            continue
        row = {}
        for idx, key in enumerate(col_keys):
            if key and idx < len(raw):
                row[key] = str(raw[idx] or "").strip()
        # Drop the untouched example row from the template
        if row.get("sku") == "ALSW-LIN-BEI" and \
           row.get("product_name") == "AL SAWAE Linen - Beige":
            continue
        rows.append(row)
    if len(rows) > 500:
        raise HTTPException(status_code=400,
                            detail="at most 500 rows per batch")
    return {"rows": rows, "count": len(rows)}


@fabric_router.post("/api/fabric/products/stage")
def pc_stage(request: Request, body: dict = Body(...)):
    """Stage a batch: normalize + validate rows, run the READ-ONLY duplicate
    lookup against live Odoo, persist the batch + per-row preview statuses,
    and return the preview. Nothing is written to Odoo here."""
    _require_product_create(request)
    rows = _pc_clean_rows(body.get("rows"))
    if not rows:
        raise HTTPException(status_code=400, detail="No rows to stage")
    existing = _pc_find_existing(_odoo_connect(), rows)
    _pc_apply_dup_status(rows, existing)
    u = getattr(request.state, "user", None) or {}
    summary = _pc_summary(rows)
    with _get_conn() as conn:
        _ensure_pc_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO fabric_product_batches "
                "(created_by, created_by_email, status, summary) "
                "VALUES (%s,%s,'preview',%s) RETURNING id",
                (str(u.get("user_id") or ""), u.get("email"),
                 psycopg2.extras.Json(summary)))
            bid = cur.fetchone()[0]
            for i, r in enumerate(rows, start=1):
                data = {k: r.get(k, "") for k in _PC_KEYS}
                cur.execute(
                    "INSERT INTO fabric_product_batch_rows "
                    "(batch_id, row_no, data, status, message, existing_odoo) "
                    "VALUES (%s,%s,%s,%s,%s,%s)",
                    (bid, i, psycopg2.extras.Json(data), r["_status"],
                     r.get("_message") or None, r.get("_existing")))
        conn.commit()
    _fabric_log_activity(
        request, "POST", "/api/fabric/products/stage",
        f"Staged product batch #{bid}: {len(rows)} rows — "
        f"{summary.get('will_create', 0)} will create, "
        f"{summary.get('duplicate', 0)} duplicates, "
        f"{summary.get('error', 0)} errors")
    return {"batch_id": bid, "summary": summary,
            "rows": [{"row_no": i + 1,
                      "data": {k: r.get(k, "") for k in _PC_KEYS},
                      "status": r["_status"],
                      "message": r.get("_message") or "",
                      "existing_odoo": r.get("_existing")}
                     for i, r in enumerate(rows)]}


def _pc_odoo_field_meta(odoo):
    """Introspect product.template fields once per confirm via fields_get
    (the integration user is NOT allowed to read ir.model.fields).
    Returns ({field_name: {ttype, relation, string}}, core_field_names,
    noos_field_meta_or_None)."""
    db, uid, pwd, models = odoo
    try:
        fg = models.execute_kw(db, uid, pwd, "product.template", "fields_get",
                               [], {"attributes": ["string", "type",
                                                   "relation"]})
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Odoo field introspection failed: {e}")
    by_name = {}
    for name, meta in fg.items():
        by_name[name] = {"name": name,
                         "ttype": meta.get("type"),
                         "relation": meta.get("relation"),
                         "string": meta.get("string") or ""}
    core_names = {n for n in ("is_storable", "detailed_type",
                              "available_in_pos") if n in fg}
    # NOOS lives in a custom attribute field discovered by its label
    # (x_vivo_attr_45 today, but never hardcode a studio field id).
    noos_field = None
    for name in sorted(by_name):
        if name.startswith("x_vivo_attr_") and \
                "noos" in by_name[name]["string"].lower():
            noos_field = by_name[name]
            break
    if noos_field is None:
        for name in sorted(by_name):
            if name.startswith("x_") and \
                    "noos" in by_name[name]["string"].lower():
                noos_field = by_name[name]
                break
    return by_name, core_names, noos_field


_PC_ATTR_ID_RE = re.compile(r"^x_vivo_attr_(\d+)$")


def _pc_attr_scope(field_name):
    """x_vivo_attr_<N> fields point at vivo.product.attribute.value rows that
    are SCOPED to vivo.product.attribute id N (option names repeat across
    attributes, so an unscoped name lookup can bind the wrong attribute)."""
    m = _PC_ATTR_ID_RE.match(field_name or "")
    return int(m.group(1)) if m else None


def _pc_lookup_one(odoo, model, domain, fields):
    db, uid, pwd, models = odoo
    rows = _odoo_kw(models, db, uid, pwd, model, "search_read",
                    [domain], {"fields": fields, "limit": 1})
    return rows[0] if rows else None


def _pc_resolve_option(odoo, relation, value, cache, attr_id=None):
    """Resolve a many2one option value by name, creating it when missing.
    For vivo.product.attribute.value the lookup/create is SCOPED to the
    owning attribute (attr_id) — option names repeat across attributes.
    Cached per (relation, attr_id, lowercased value)."""
    val = str(value).strip()
    key = (relation, attr_id, val.lower())
    if key in cache:
        return cache[key]
    db, uid, pwd, models = odoo
    domain = [["name", "=ilike", val]]
    if attr_id is not None:
        domain.insert(0, ["attribute_id", "=", attr_id])
    hit = _pc_lookup_one(odoo, relation, domain, ["id"])
    if hit:
        cache[key] = hit["id"]
        return hit["id"]
    vals = {"name": val}
    if attr_id is not None:
        vals["attribute_id"] = attr_id
    new_id = _odoo_kw(models, db, uid, pwd, relation, "create", [vals])
    cache[key] = new_id
    return new_id


def _pc_set_properties(odoo, template_id, row, warnings):
    """Best-effort write of the product_properties bag (Fabric Name / Supplier
    Name / Colour / Status / NOOS) by matching each definition's label. A
    failure here never fails the row — the product exists; we warn instead."""
    db, uid, pwd, models = odoo
    try:
        recs = _odoo_kw(models, db, uid, pwd, "product.template", "read",
                        [[template_id], ["product_properties"]])
        props = (recs[0] if recs else {}).get("product_properties")
        if not isinstance(props, list) or not props:
            return
        changed = False
        for p in props:
            if not isinstance(p, dict):
                continue
            label = str(p.get("string") or "").strip().lower()
            for key, needles in _PC_PROPERTY_LABELS.items():
                val = (row.get(key) or "").strip()
                if not val or not any(n in label for n in needles):
                    continue
                ptype = p.get("type")
                if ptype == "boolean":
                    p["value"] = val.lower() in ("yes", "y", "true", "1", "on")
                elif ptype in ("char", "text", None):
                    p["value"] = val
                elif ptype == "selection":
                    opts = p.get("selection") or []
                    match = next((o[0] for o in opts
                                  if str(o[1]).strip().lower() == val.lower()),
                                 None)
                    if match is None:
                        warnings.append(
                            f"property '{p.get('string')}': no option '{val}'")
                        continue
                    p["value"] = match
                elif ptype == "many2one":
                    rel = p.get("comodel")
                    if not rel:
                        warnings.append(
                            f"property '{p.get('string')}': cannot resolve")
                        continue
                    oid = _pc_lookup_one(odoo, rel,
                                         [["name", "=ilike", val]], ["id"])
                    if not oid:
                        oid_new = _odoo_kw(models, db, uid, pwd, rel,
                                           "create", [{"name": val}])
                        p["value"] = oid_new
                    else:
                        p["value"] = oid["id"]
                else:
                    warnings.append(
                        f"property '{p.get('string')}': unsupported type "
                        f"{ptype}")
                    continue
                changed = True
        if changed:
            _odoo_kw(models, db, uid, pwd, "product.template", "write",
                     [[template_id], {"product_properties": props}])
    except HTTPException as e:
        warnings.append(f"properties not set: {e.detail}")
    except Exception as e:
        warnings.append(f"properties not set: {e}")


@fabric_router.post("/api/fabric/products/batch/{bid}/confirm")
def pc_confirm(bid: int, request: Request):
    """The EXPLICIT write step. Re-checks duplicates against live Odoo (not
    just preview time), then creates product.template records row by row with
    the fixed defaults + custom attributes. Per-row outcome recorded; the
    batch summary + every outcome class is audited."""
    _require_product_create(request)
    with _get_conn() as conn:
        _ensure_pc_tables(conn)
        with conn.cursor() as cur:
            # Single-shot guard: only a 'preview' batch can be confirmed.
            cur.execute("UPDATE fabric_product_batches SET status='confirming' "
                        "WHERE id=%s AND status='preview' RETURNING id", (bid,))
            if not cur.fetchone():
                conn.rollback()
                raise HTTPException(status_code=409,
                    detail="Batch not found or already confirmed")
        conn.commit()
        db_rows = q(conn, "SELECT id, row_no, data, status FROM "
                          "fabric_product_batch_rows WHERE batch_id=%s "
                          "ORDER BY row_no", (bid,))

    # Batch setup (connect, re-check duplicates, introspect fields, shared
    # lookups). A failure HERE must release the 'confirming' guard so the
    # batch can be retried — nothing has been written to Odoo yet.
    try:
        odoo = _odoo_connect(timeout=60)
        db, uid, pwd, models = odoo
        rows_data = [dict(r["data"]) for r in db_rows]
        existing = _pc_find_existing(odoo, rows_data)

        # Shared lookups resolved once per batch
        fmeta, core_names, noos_field = _pc_odoo_field_meta(odoo)
        uom = (_pc_lookup_one(odoo, "uom.uom",
                              [["name", "=ilike", "kg"]], ["id"])
               or _pc_lookup_one(odoo, "uom.uom",
                                 [["name", "ilike", "kg"]], ["id"]))
        if not uom:
            raise HTTPException(status_code=502,
                                detail="Could not find the 'kg' unit in Odoo")
        cat = (_pc_lookup_one(odoo, "product.category",
                              [["name", "ilike", "Raw Materials-Fabric"]],
                              ["id"])
               or {"id": 18})
    except Exception:
        try:
            with _get_conn() as conn2:
                with conn2.cursor() as cur2:
                    cur2.execute("UPDATE fabric_product_batches SET "
                                 "status='preview' WHERE id=%s AND "
                                 "status='confirming'", (bid,))
                conn2.commit()
        except Exception:
            pass
        raise
    opt_cache = {}
    results = []

    for r in db_rows:
        row = dict(r["data"])
        row_no = r["row_no"]
        prev_status = r["status"]
        sku = (row.get("sku") or "").strip()
        bc = (row.get("barcode") or sku).strip()
        outcome = {"row_id": r["id"], "row_no": row_no, "sku": sku}

        if prev_status == "error":
            outcome.update(status="failed",
                           message="Validation errors — not sent to Odoo")
            results.append(outcome)
            continue
        dup = existing.get(sku.lower()) or existing.get(bc.lower())
        if dup:
            outcome.update(status="skipped",
                           message="Duplicate in Odoo — skipped",
                           existing=dup[:300])
            results.append(outcome)
            continue

        warnings = []
        vals = dict(_PC_FIXED_DEFAULTS)
        vals.update({
            "name": row.get("product_name"),
            "default_code": sku,
            "barcode": bc or False,
            "uom_id": uom["id"], "uom_po_id": uom["id"],
            "categ_id": cat["id"],
        })
        if "available_in_pos" in core_names:
            vals["available_in_pos"] = False
        # Product Type = Goods, tracked — field names differ across versions
        if "is_storable" in core_names:
            vals["type"] = "consu"
            vals["is_storable"] = True
        elif "detailed_type" in core_names:
            vals["detailed_type"] = "product"
        else:
            vals["type"] = "product"
        sp, _ = _pc_num(row.get("sales_price"))
        cp, _ = _pc_num(row.get("cost"))
        if sp is not None:
            vals["list_price"] = sp
        # NOTE: standard_price (cost) is written AFTER create, best-effort —
        # with automated valuation a cost write posts a journal entry, which
        # this integration user may not be allowed to do. That must not fail
        # the product creation itself.
        st = (row.get("fabric_status") or "Active").strip().lower()
        vals["active"] = st not in ("inactive", "archived", "retired")

        try:
            # Custom many2one attribute columns
            for key, fname in _PC_ATTR_FIELDS.items():
                val = (row.get(key) or "").strip()
                if not val:
                    continue
                meta = fmeta.get(fname)
                if not meta:
                    warnings.append(f"{fname} not found in Odoo — "
                                    f"'{key}' not set")
                    continue
                if meta.get("ttype") == "many2one" and meta.get("relation"):
                    vals[fname] = _pc_resolve_option(
                        odoo, meta["relation"], val, opt_cache,
                        attr_id=_pc_attr_scope(fname))
                elif meta.get("ttype") in ("char", "text"):
                    vals[fname] = val
                elif meta.get("ttype") in ("float", "integer"):
                    f, err = _pc_num(val)
                    if err:
                        warnings.append(f"{key}: {err} — not set")
                    else:
                        vals[fname] = f
                else:
                    warnings.append(f"{key}: unsupported field type "
                                    f"{meta.get('ttype')} — not set")
            # NOOS flag (introspected — no stable field id known)
            noos_val = (row.get("noos_fabric") or "").strip().lower()
            if noos_val and noos_field:
                truthy = noos_val in ("yes", "y", "true", "1", "on")
                if noos_field.get("ttype") == "boolean":
                    vals[noos_field["name"]] = truthy
                elif noos_field.get("ttype") == "many2one" and \
                        noos_field.get("relation"):
                    vals[noos_field["name"]] = _pc_resolve_option(
                        odoo, noos_field["relation"],
                        "Yes" if truthy else "No", opt_cache,
                        attr_id=_pc_attr_scope(noos_field["name"]))
            elif noos_val and not noos_field:
                warnings.append("NOOS field not found in Odoo — not set")

            new_id = _odoo_kw(models, db, uid, pwd, "product.template",
                              "create", [vals])
            if cp is not None:
                try:
                    _odoo_kw(models, db, uid, pwd, "product.template",
                             "write", [[new_id], {"standard_price": cp}])
                except Exception as ce:
                    warnings.append(
                        "cost not set (Odoo valuation restriction): "
                        + str(ce)[:120])
            _pc_set_properties(odoo, new_id, row, warnings)
            msg = ("Created" + ("; " + "; ".join(warnings) if warnings else ""))
            outcome.update(status="created", odoo_id=new_id, message=msg[:500])
            # Guard against a same-batch row reusing this SKU/barcode
            ident = "%s (Odoo template %s, SKU %s)" % (
                row.get("product_name") or "?", new_id, sku or "—")
            for c in (sku, bc):
                if c:
                    existing[c.lower()] = ident
        except HTTPException as e:
            outcome.update(status="failed", message=str(e.detail)[:500])
        except Exception as e:
            outcome.update(status="failed", message=str(e)[:500])
        results.append(outcome)

    summary = _pc_summary(results, key="status")
    with _get_conn() as conn:
        with conn.cursor() as cur:
            for o in results:
                cur.execute(
                    "UPDATE fabric_product_batch_rows SET status=%s, "
                    "message=%s, odoo_id=%s, existing_odoo=COALESCE(%s, "
                    "existing_odoo) WHERE id=%s",
                    (o["status"], o.get("message"), o.get("odoo_id"),
                     o.get("existing"), o["row_id"]))
            cur.execute(
                "UPDATE fabric_product_batches SET status='done', "
                "confirmed_at=now(), summary=%s WHERE id=%s",
                (psycopg2.extras.Json(summary), bid))
        conn.commit()

    def _skus(status):
        s = ", ".join(o["sku"] or "?" for o in results if o["status"] == status)
        return s[:400]
    _fabric_log_activity(
        request, "POST", f"/api/fabric/products/batch/{bid}/confirm",
        f"Batch #{bid} confirmed: {summary.get('created', 0)} created, "
        f"{summary.get('skipped', 0)} skipped, {summary.get('failed', 0)} failed")
    for status in ("created", "skipped", "failed"):
        if summary.get(status):
            _fabric_log_activity(
                request, "POST", f"/api/fabric/products/batch/{bid}/confirm",
                f"Batch #{bid} {status} SKUs: {_skus(status)}")
    return {"batch_id": bid, "summary": summary,
            "rows": [{k: v for k, v in o.items() if k != "row_id"}
                     for o in results]}


@fabric_router.get("/api/fabric/products/batches")
def pc_batches(request: Request, limit: int = Query(20, ge=1, le=100)):
    _require_product_create(request)
    with _get_conn() as conn:
        _ensure_pc_tables(conn)
        rows = q(conn, """
            SELECT id, created_by_email, status, created_at, confirmed_at,
                   summary,
                   (SELECT COUNT(*) FROM fabric_product_batch_rows r
                     WHERE r.batch_id = b.id) AS row_count
            FROM fabric_product_batches b
            ORDER BY id DESC LIMIT %s""", (limit,))
    for r in rows:
        r["created_at"] = r["created_at"].isoformat() if r["created_at"] else None
        r["confirmed_at"] = (r["confirmed_at"].isoformat()
                             if r["confirmed_at"] else None)
    return {"batches": rows}


@fabric_router.get("/api/fabric/products/batch/{bid}")
def pc_batch_detail(bid: int, request: Request):
    _require_product_create(request)
    with _get_conn() as conn:
        _ensure_pc_tables(conn)
        batches = q(conn, "SELECT id, created_by_email, status, created_at, "
                          "confirmed_at, summary FROM fabric_product_batches "
                          "WHERE id=%s", (bid,))
        if not batches:
            raise HTTPException(status_code=404, detail="Batch not found")
        rows = q(conn, "SELECT row_no, data, status, message, existing_odoo, "
                       "odoo_id FROM fabric_product_batch_rows "
                       "WHERE batch_id=%s ORDER BY row_no", (bid,))
    b = batches[0]
    b["created_at"] = b["created_at"].isoformat() if b["created_at"] else None
    b["confirmed_at"] = (b["confirmed_at"].isoformat()
                         if b["confirmed_at"] else None)
    return {"batch": b, "rows": rows}


# ═══════════════════════════════════════════════════════════════════════════
# Product Costing (per-style cost sheets)
# ═══════════════════════════════════════════════════════════════════════════
# Per-style cost sheets (fabric, trims, CMT/labour, overheads) with margin vs
# the style's current selling price. Access is STRICTLY email-allowlisted —
# enforced server-side for every /api/fabric/costing path in api_pg's auth
# middleware via _fabric_costing_allowed below (the tab is also hidden in the
# UI for everyone else, but the middleware is the enforcement).
# Per-step sign-off rights: each of the three sign-off steps has its OWN
# email allowlist (server-enforced in the signoff endpoint). The combined
# set below is the tab/API access gate used by api_pg's middleware — anyone
# who can sign at least one step can open the Product Costing tab.
_COSTING_STEP_EMAILS = {
    1: {  # Prepared by
        "bedan@vivofashiongroup.com",
        "kevinl@vivofashiongroup.com",
        "costing@vivofashiongroup.com",
        "admin@vivofashiongroup.com",
        "analytics@vivofashiongroup.com",
    },
    2: {  # Checked by
        "bedan@vivofashiongroup.com",
        "stephen@vivofashiongroup.com",
    },
    3: {  # Approved by
        "marynyambura@vivofashiongroup.com",
        "rosebella@vivofashiongroup.com",
        "wandia@vivofashiongroup.com",
    },
}

_COSTING_VIEW_EMAILS = frozenset({
    "admin@vivofashiongroup.com",
    "analytics@vivofashiongroup.com",
})

_FABRIC_COSTING_EMAILS = frozenset().union(
    *_COSTING_STEP_EMAILS.values(), _COSTING_VIEW_EMAILS
)


def _fabric_costing_allowed(user):
    """True when this user dict may use the Product Costing tab/API."""
    u = user or {}
    return (u.get("email") or "").strip().lower() in _FABRIC_COSTING_EMAILS


_COSTING_TABLES_READY = False
_COSTING_LINE_KINDS = ("fabric", "trim", "cmt", "overhead")


_PP_DEFECT_ALLOWANCE_DEFAULT_PCT = 4.0
_PP_COST_PER_MINUTE_DEFAULT = 22.71
_PP_DEFAULTS_BACKFILL_KEY = "preprod_cost_defaults_v1"


def _ensure_costing_tables(conn):
    """Lazily create the costing tables (idempotent, once per process).
    Prod is a separate DB, so tables appear there on first use."""
    global _COSTING_TABLES_READY
    if _COSTING_TABLES_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_costing_sheets (
                id            SERIAL PRIMARY KEY,
                style_name    TEXT NOT NULL,
                style_number  TEXT,
                selling_price NUMERIC,
                selling_price_is_auto BOOLEAN DEFAULT TRUE,
                notes         TEXT,
                created_by    TEXT,
                created_by_name TEXT,
                created_at    TIMESTAMPTZ DEFAULT now(),
                updated_by    TEXT,
                updated_by_name TEXT,
                updated_at    TIMESTAMPTZ DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fab_costing_style
                ON fabric_costing_sheets (lower(style_name));
            CREATE TABLE IF NOT EXISTS fabric_costing_lines (
                id        SERIAL PRIMARY KEY,
                sheet_id  INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                          ON DELETE CASCADE,
                kind      TEXT NOT NULL,
                label     TEXT,
                qty       NUMERIC,
                unit_cost NUMERIC,
                total     NUMERIC,
                is_auto   BOOLEAN DEFAULT FALSE,
                source    TEXT,
                position  INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_fab_costing_lines_sheet
                ON fabric_costing_lines(sheet_id);
            CREATE TABLE IF NOT EXISTS fabric_costing_history (
                id         SERIAL PRIMARY KEY,
                sheet_id   INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                           ON DELETE CASCADE,
                action     TEXT NOT NULL,
                changed_by TEXT,
                changed_by_name TEXT,
                changed_at TIMESTAMPTZ DEFAULT now(),
                summary    TEXT,
                snapshot   JSONB
            );
            CREATE INDEX IF NOT EXISTS idx_fab_costing_hist_sheet
                ON fabric_costing_history(sheet_id, changed_at DESC);
            -- The Done DPS the sheet's auto-suggestions were built from.
            -- Mandatory on new sheets; NULL only on legacy sheets created
            -- before DPS selection became required.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS dps_ref TEXT;
            -- Fabric-master product reference for auto fabric lines so saved
            -- sheets can re-price at the fabric's CURRENT cost/metre on read.
            ALTER TABLE fabric_costing_lines
                ADD COLUMN IF NOT EXISTS component_id BIGINT;
            -- Colour the sheet's suggestions were scoped to (product-master
            -- color_print of the finished SKUs). NULL = all colours (legacy
            -- sheets and single-colour DPSes where no narrowing was needed).
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS color TEXT;
            -- Three-step digital sign-off (Prepared/Checked/Approved by
            -- default; titles customizable at signing time). A row exists
            -- ONLY for a signed step; unsigned steps render from defaults.
            -- Step 3 signed = the sheet is APPROVED and locked against edits
            -- (enforced server-side in the sheet/line mutation endpoints).
            CREATE TABLE IF NOT EXISTS fabric_costing_signoffs (
                id             SERIAL PRIMARY KEY,
                sheet_id       INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                               ON DELETE CASCADE,
                step           INTEGER NOT NULL CHECK (step BETWEEN 1 AND 3),
                title          TEXT NOT NULL,
                signed_by      TEXT,
                signed_by_name TEXT,
                signed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (sheet_id, step)
            );
            -- Manually-entered embroidery cost (no Odoo source yet).
            -- Stored as JSONB {enabled, cost_per_run, run_count}. NULL = not set.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS embroidery_data JSONB;
            -- Pre-production costing stage and per-sheet inputs.
            -- stage: 'main_production' (default) or 'pre_production'.
            -- Pre-production sheets have no Done DPS; fabric metres, accessory
            -- percentage, defect allowance, and CMT time/rate are entered manually.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'main_production';
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS accessories_pct NUMERIC DEFAULT 13;
            -- Provenance of the AUTO-PICKED Accessories % (pre-production
            -- sheets created since the previous-month Done-DPS auto-pick):
            -- {pct, source_month, month_label, dps_count, fallback,
            --  is_default, requested_month, requested_month_label, picked_at}.
            -- NULL = legacy sheet created before the auto-pick existed — its
            -- hand-typed accessories_pct is preserved and never re-picked.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS accessories_pct_meta JSONB;
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS defect_allowance_pct NUMERIC
                DEFAULT 10;
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS mtrs_per_garment NUMERIC;
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS cost_per_minute NUMERIC;
            -- Controlled Pre-production default retrofit marker. Kept
            -- separate from Accessories provenance so each maintenance
            -- operation remains independently idempotent and auditable.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS preprod_defaults_meta JSONB;
            ALTER TABLE fabric_costing_sheets
                ALTER COLUMN defect_allowance_pct
                SET DEFAULT 10;
            ALTER TABLE fabric_costing_sheets
                ALTER COLUMN cost_per_minute
                DROP DEFAULT;
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS cmt_start_time TEXT;
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS cmt_stop_time TEXT;
            -- CMT efficiency factor ("Production Multiplier") the sheet used.
            -- NULL = saved before the field existed → read as the legacy 1.40
            -- so old sheets' totals stay identical.
            ALTER TABLE fabric_costing_sheets
                ADD COLUMN IF NOT EXISTS production_multiplier NUMERIC;
        """)
        # One-time backfill: link existing auto fabric lines to their fabric
        # product by matching the line label ("Main fabric (<name>)" from the
        # suggester, or the bare fabric name from the typeahead) to the fabric
        # master's name. Only unambiguous (single-product) matches are linked.
        cur.execute(r"""
            UPDATE fabric_costing_lines l
            SET component_id = m.pid
            FROM (
                SELECT l2.id AS lid, MIN(p.id) AS pid
                FROM fabric_costing_lines l2
                JOIN raw_fabric_products p
                  ON lower(trim(p.name)) = lower(trim(
                       CASE WHEN l2.label ~* '^main fabric \(.*\)$'
                            THEN substring(l2.label from '^[Mm]ain [Ff]abric \((.*)\)$')
                            ELSE l2.label END))
                WHERE l2.kind = 'fabric' AND l2.is_auto
                  AND l2.component_id IS NULL
                GROUP BY l2.id
                HAVING COUNT(DISTINCT p.id) = 1
            ) m
            WHERE l.id = m.lid
        """)
    conn.commit()
    _COSTING_TABLES_READY = True


def _costing_user(request):
    u = getattr(request.state, "user", None) or {}
    return (str(u.get("user_id") or u.get("id") or ""),
            u.get("name") or u.get("email") or "unknown")


def _costing_user_email(request):
    u = getattr(request.state, "user", None) or {}
    return (u.get("email") or "").strip().lower()


def _costing_require_editor(request):
    """Raise 403 when the signed-in user has view-only access to the costing tab.
    View-only users are in _COSTING_VIEW_EMAILS but NOT in any _COSTING_STEP_EMAILS
    set; they may read sheets but may not create, update, or sign them.

    In dev/preview (REPLIT_DEPLOYMENT != '1') the view-only gate is skipped so
    that admin@ and analytics@ can save sheets while the production decision is
    pending.  Production behaviour is fully preserved."""
    email = _costing_user_email(request)
    if email in _COSTING_VIEW_EMAILS:
        if os.environ.get("REPLIT_DEPLOYMENT") == "1":
            raise HTTPException(
                status_code=403,
                detail="Your account has read-only access to the Product Costing tab")


def _costing_signer_email(conn, uid):
    """Resolve a stored signoff signed_by (a user_id) back to an email for the
    separation-of-duties comparison. Emails are the canonical identity here
    (user_ids can differ between local: and google: sign-ins for one person)."""
    if not uid:
        return None
    try:
        rows = q(conn, "SELECT lower(email) AS email FROM app_users "
                       "WHERE user_id = %s", (uid,))
        return (rows[0]["email"] or "").strip().lower() if rows else None
    except Exception:
        return None


def _costing_signer_list(step):
    """Human-readable 'who may sign this step' list for error messages/UI."""
    return ", ".join(sorted(_COSTING_STEP_EMAILS[step]))


def _notify_costing_users(conn, actor_uid, ntype, title, message, dedupe_prefix,
                          link="/fabric"):
    """Bell-notify every OTHER allowlisted costing user (the actor already knows
    what they just did). Recipients are resolved live from app_users by the
    costing email allowlist, so an allowlisted user who has never signed in
    simply gets skipped. Reuses the persisted user_notifications store via
    _notify_user (idempotent per recipient through the UNIQUE dedupe_key —
    dedupe_prefix must identify the EVENT, the recipient id is appended here).
    Never raises — a notification hiccup must not fail the sign-off itself."""
    try:
        rows = q(conn, """
            SELECT user_id FROM app_users
            WHERE lower(email) = ANY(%s) AND status = 'active'
        """, (sorted(_FABRIC_COSTING_EMAILS),))
        for r in rows:
            uid = r["user_id"]
            if not uid or uid == actor_uid:
                continue
            _notify_user(conn, uid, ntype, title, message,
                         f"{dedupe_prefix}:{uid}", link=link)
    except Exception:
        pass


def _style_selling_price(conn, style_name):
    """Modal (most common) SKU price for the style from the product master —
    per the style-full-price rule (modal, never MAX). None when unknown."""
    rows = q(conn, """
        SELECT mode() WITHIN GROUP (ORDER BY price) AS price
        FROM all_products_clean
        WHERE lower(style_name) = lower(%s)
          AND price IS NOT NULL AND price > 0
    """, [style_name])
    p = rows[0]["price"] if rows else None
    return float(p) if p else None


# Fixed 16% Kenyan VAT. Stored/entered selling_price is the VAT-INCLUSIVE
# retail price (both auto modal-SKU pulls and manual entry); margin is ALWAYS
# computed against the derived ex-VAT selling price (retail ÷ 1.16), never the
# retail price itself. Derived at read time so existing (even signed-off)
# sheets show the corrected margin without touching stored inputs.
_COSTING_VAT_DIVISOR = 1.16


def _costing_ex_vat(price):
    """Ex-VAT selling price from the VAT-inclusive retail price; None-safe."""
    return (round(float(price) / _COSTING_VAT_DIVISOR, 2)
            if price is not None else None)


def _costing_margin(retail_price, total_cost):
    """(ex_vat_price, margin, margin_pct) vs the ex-VAT selling price."""
    ex = _costing_ex_vat(retail_price)
    if ex is None:
        return None, None, None
    margin = round(ex - total_cost, 2)
    pct = round((ex - total_cost) / ex * 100, 2) if ex else None
    return ex, margin, pct


def _preproduction_proposed_prices(total_cost):
    """Back-calculate selling_price_ex_vat and retail_price_vat_incl to hit
    exactly 70% margin ex-VAT.  Formula: selling_ex = total_cost / 0.30.
    Returns (selling_ex_vat, retail_incl_vat) or (None, None) for zero cost."""
    if total_cost is None or float(total_cost) <= 0:
        return None, None
    selling_ex = round(float(total_cost) / 0.30, 2)
    retail = round(selling_ex * _COSTING_VAT_DIVISOR, 2)
    return selling_ex, retail


def _require_style_dps(conn, canon_style, dps_ref, color=None):
    """The DPS must belong to this style (finished_sku match rule) — 404s
    otherwise. With a colour, the DPS must also have MOs whose finished SKU is
    that colour of the style. Shared by the suggest endpoint and sheet create."""
    scope_sql, scope_params, color = _costing_color_scope(canon_style, color)
    chk = q(conn, f"""
        SELECT 1 FROM mo_fabric_consumption c
        WHERE c.dps_ref = %s
          AND {scope_sql}
        LIMIT 1
    """, [dps_ref] + scope_params)
    if not chk:
        raise HTTPException(status_code=404,
                            detail=("No Done MOs in that colour on this DPS for the style"
                                    if color else
                                    "No Done DPS with that reference for this style"))


# One row per finished SKU of a style — (sku, color) — resolved from BOTH
# product layers so renamed and brand-new styles find their DPSes:
#   • all_products_clean by (canonical) style name — colour = color_print;
#   • UNION raw_odoo_products by the SAME derived-style rule the picker
#     universe uses (style_name attr, else the name up to the first " - "),
#     covering styles/SKUs that have not flowed through a rebuild yet.
#     Colour falls back to the raw name's LAST " - " segment (last, so
#     "Off - Shoulder …" names never split into a bogus colour).
# DISTINCT ON keeps ONE colour per SKU, preferring the product master's
# color_print over the raw-name fallback. Takes the style name TWICE as
# params; %% escapes survive the psycopg2 param interpolation every consumer
# performs.
_STYLE_SKU_COLORS_SQL = """
    SELECT DISTINCT ON (u.sku) u.sku, u.color
    FROM (
        SELECT apc.sku, NULLIF(TRIM(apc.color_print), '') AS color, 0 AS pref
        FROM all_products_clean apc
        WHERE lower(apc.style_name) = lower(%s)
        UNION ALL
        SELECT NULLIF(TRIM(r.default_code), ''),
               CASE WHEN r.name LIKE '%% - %%'
                    THEN NULLIF(TRIM(regexp_replace(r.name, '.* - ', '')), '')
               END,
               1
        FROM raw_odoo_products r
        WHERE lower(COALESCE(NULLIF(TRIM(r.style_name), ''),
                             NULLIF(SPLIT_PART(r.name, ' - ', 1), '')))
              = lower(%s)
    ) u
    WHERE u.sku IS NOT NULL
    ORDER BY u.sku, (u.color IS NULL), u.pref
"""


def _costing_color_scope(style_name, color):
    """SQL fragment + params restricting MO finished SKUs to the style — and,
    when a colour is given, to that colour's SKUs only. The style's SKU set
    is the UNION of all_products_clean (by name) and raw_odoo_products (by
    the picker universe's derived-name rule), with colour per SKU falling
    back from the master's color_print to the raw name's colour segment
    (see _STYLE_SKU_COLORS_SQL) — so styles not yet in the product master
    still resolve. Shared by every suggestion reader so fabrics,
    accessories, metres/garment, labour AND the typeahead all come from the
    SAME colour-scoped MO set."""
    color = (color or "").strip() or None
    sql = f"""c.finished_sku IN (
                SELECT sc.sku FROM ({_STYLE_SKU_COLORS_SQL}) sc"""
    params = [style_name, style_name]
    if color:
        sql += "\n                WHERE lower(coalesce(sc.color,'')) = lower(%s)"
        params.append(color)
    sql += "\n              )"
    return sql, params, color


_KG_UOMS = {"kg", "g"}
_M_UOMS = {"m", "metre", "meter", "mtr", "metres", "meters", "metre(s)"}


def _costing_style_facts(conn, style_name, dps_ref, color=None):
    """Auto-suggestion facts for a style from ONE Done DPS's consumption:
    metres per garment, weighted labour cost per garment, the fabrics used AND
    the accessories/trims components consumed. Fabric cost/metre suggestions
    use the fabric master's CURRENT cost/metre (standard_price ×
    kg_per_mtr_eff — the modal's Cost/Metre figure) first, falling back to the
    cost recorded on the DPS/MO consumption, then the latest PO price.
    Accessories keep the DPS/MO recorded cost only — never latest-PO
    pricing. Every suggestion (fabric, accessories, labour) is scoped strictly
    to the selected Done DPS — the old 365-day trailing-window average is gone
    (DPS selection is mandatory).
    MOs are matched to the BI style via finished_sku = all_products_clean.sku
    — NOT on style_name: MO style names embed fabric + colour ("… in Jersey -
    Dark Red") and never match the product master (same rule as the
    metres-per-garment category breakdown above)."""
    if not dps_ref:
        raise HTTPException(status_code=400,
                            detail="dps_ref is required — pick a DPS # for the style")
    scope_sql = "AND c.dps_ref = %s"
    scope_params = [dps_ref]
    # Colour scope: when set, MOs are restricted to finished SKUs of that
    # colour so a one-colour sheet never blends in sibling colours' components.
    style_sql, style_params, color = _costing_color_scope(style_name, color)
    rows = q(conn, f"""
        SELECT c.odoo_mo_id, c.produced_qty, c.consumed_qty,
               lower(coalesce(c.uom,'')) AS uom,
               c.component_id, c.fabric_sku, c.fabric_name,
               c.dps_cost_per_unit, c.unit_cost_mo,
               p.kg_per_mtr_eff AS kpm, p.standard_price, p.barcode
        FROM mo_fabric_consumption c
        LEFT JOIN raw_fabric_products p ON p.id = c.component_id
        WHERE {style_sql}
          {scope_sql}
          AND c.is_main_fabric
    """, style_params + scope_params)

    mos, fabrics = {}, {}
    for r in rows:
        d = mos.setdefault(r["odoo_mo_id"], {
            "produced": float(r["produced_qty"] or 0), "metres": 0.0,
            "bad": False,
            "labour_pu": float(r["dps_cost_per_unit"]) if r["dps_cost_per_unit"] is not None else None,
        })
        qty = float(r["consumed_qty"] or 0)
        u, kpm = r["uom"], r["kpm"]
        metres = None
        if u in _M_UOMS:
            metres = qty
        elif u in _KG_UOMS and kpm and float(kpm) > 0:
            kg = qty / 1000.0 if u == "g" else qty
            metres = kg / float(kpm)
        if metres is None:
            d["bad"] = True
        else:
            d["metres"] += metres
        f = fabrics.setdefault(r["component_id"], {
            "component_id": r["component_id"], "sku": r["fabric_sku"],
            "name": r["fabric_name"], "metres": 0.0,
            "barcode": (r["barcode"] or "").strip() or None,
            "kpm": float(kpm) if kpm else None,
            "standard_price": float(r["standard_price"]) if r["standard_price"] else None,
            "mo_cost_amt": 0.0, "mo_cost_qty": 0.0, "mo_cost_uom": None,
        })
        if metres is not None:
            f["metres"] += metres
        # DPS/MO-recorded cost basis: unit_cost_mo is per UoM unit as valued
        # on the MO move; accumulate consumed-qty-weighted for a per-unit avg.
        mc = r["unit_cost_mo"]
        if mc is not None and float(mc) > 0 and qty > 0:
            f["mo_cost_amt"] += float(mc) * qty
            f["mo_cost_qty"] += qty
            f["mo_cost_uom"] = u

    tot_m = tot_g = 0.0
    lab_cost = lab_units = 0.0
    n_mos = 0
    for d in mos.values():
        if d["produced"] <= 0:
            continue
        if not d["bad"]:
            tot_m += d["metres"]
            tot_g += d["produced"]
            n_mos += 1
        if d["labour_pu"] is not None and d["labour_pu"] > 0:
            lab_cost += d["labour_pu"] * d["produced"]
            lab_units += d["produced"]

    # Suggested cost per metre for each fabric: PRIMARY basis is the fabric
    # master's CURRENT cost/metre — standard_price × kg_per_mtr_eff — the same
    # figure the fabric popup modal shows as Cost/Metre, so cost sheets
    # reflect today's fabric cost. When that can't be computed (missing
    # standard price or kg/mtr conversion) we fall back to the cost recorded
    # on the DPS/MO consumption itself (unit_cost_mo, per UoM unit → per metre
    # via kg_per_mtr_eff when the MO consumed in kg/g), then the latest PO
    # price as a last resort.
    fab_list = sorted(fabrics.values(), key=lambda f: -f["metres"])
    ids = [f["component_id"] for f in fab_list if f["component_id"]]
    po_price = {}
    if ids:
        for r in q(conn, """
            SELECT DISTINCT ON (product_id) product_id, price_unit,
                   lower(coalesce(uom,'')) AS uom, order_date
            FROM raw_fabric_purchase_orders
            WHERE product_id = ANY(%s) AND price_unit > 0
            ORDER BY product_id, order_date DESC NULLS LAST
        """, [ids]):
            po_price[r["product_id"]] = r
    for f in fab_list:
        cpm = src = None
        if f["standard_price"] and f["kpm"]:
            cpm, src = f["standard_price"] * f["kpm"], "fabric master cost/metre (current)"
        if cpm is None and f["mo_cost_qty"] > 0:
            per_unit = f["mo_cost_amt"] / f["mo_cost_qty"]
            u = f["mo_cost_uom"]
            if u in _M_UOMS:
                cpm, src = per_unit, "DPS/MO recorded cost (per metre)"
            elif u in _KG_UOMS and f["kpm"]:
                per_kg = per_unit * 1000.0 if u == "g" else per_unit
                cpm, src = per_kg * f["kpm"], "DPS/MO recorded cost (per kg × kg/m)"
        if cpm is None:
            po = po_price.get(f["component_id"])
            if po:
                pu = float(po["price_unit"] or 0)
                if po["uom"] in _M_UOMS:
                    cpm, src = pu, "latest PO price (per metre)"
                elif f["kpm"]:
                    cpm, src = pu * f["kpm"], "latest PO price (per kg × kg/m)"
        f["cost_per_metre"] = round(cpm, 2) if cpm else None
        f["cost_source"] = src
        f["metres"] = round(f["metres"], 1)
        for k in ("mo_cost_amt", "mo_cost_qty", "mo_cost_uom"):
            f.pop(k, None)

    # Weighted-average cost/metre across the style's fabrics (by metres used).
    wm = [(f["metres"], f["cost_per_metre"]) for f in fab_list
          if f["cost_per_metre"] and f["metres"] > 0]
    fabric_cpm = (round(sum(m * c for m, c in wm) / sum(m for m, _ in wm), 2)
                  if wm else None)

    # Accessories & Trims components (is_main_fabric = FALSE) consumed on the
    # same scoped Done-DPS MOs. Per component: qty per garment = Σ consumed ÷
    # Σ produced over the MOs where the component appears; unit cost = the
    # consumed-qty-weighted average of the cost recorded on the MO consumption
    # itself (unit_cost_mo) — DPS cost only, never latest-PO pricing.
    acc_rows = q(conn, f"""
        SELECT c.component_id, c.fabric_sku AS sku, c.fabric_name AS name,
               coalesce(c.uom,'') AS uom,
               MAX(p.barcode) AS barcode,
               SUM(c.consumed_qty) AS consumed,
               SUM(c.produced_qty) AS produced,
               SUM(c.unit_cost_mo * c.consumed_qty)
                   FILTER (WHERE c.unit_cost_mo > 0 AND c.consumed_qty > 0) AS cost_amt,
               SUM(c.consumed_qty)
                   FILTER (WHERE c.unit_cost_mo > 0 AND c.consumed_qty > 0) AS cost_qty
        FROM mo_fabric_consumption c
        LEFT JOIN raw_fabric_products p ON p.id = c.component_id
        WHERE {style_sql}
          {scope_sql}
          AND NOT c.is_main_fabric
        GROUP BY c.component_id, c.fabric_sku, c.fabric_name, coalesce(c.uom,'')
        ORDER BY SUM(c.consumed_qty) DESC
    """, style_params + scope_params)
    accessories = []
    for r in acc_rows[:25]:
        consumed = float(r["consumed"] or 0)
        produced = float(r["produced"] or 0)
        if consumed <= 0 or produced <= 0:
            continue
        unit_cost = None
        if r["cost_qty"] and float(r["cost_qty"]) > 0:
            unit_cost = round(float(r["cost_amt"]) / float(r["cost_qty"]), 2)
        accessories.append({
            "component_id": r["component_id"],
            "sku": r["sku"], "name": r["name"], "uom": r["uom"],
            "barcode": (r["barcode"] or "").strip() or None,
            "qty_per_garment": round(consumed / produced, 4),
            "unit_cost": unit_cost,
            "cost_source": ("DPS/MO recorded cost" if unit_cost is not None
                            else None),
        })

    return {
        "dps_ref": dps_ref,
        "color": color,
        "accessories": accessories,
        "metres_per_garment": round(tot_m / tot_g, 2) if tot_g > 0 else None,
        "metres_mos": n_mos,
        "labour_per_garment": round(lab_cost / lab_units, 2) if lab_units > 0 else None,
        "labour_garments": round(lab_units),
        "labour_available": lab_units > 0,
        "fabric_cost_per_metre": fabric_cpm,
        "fabrics": fab_list[:10],
    }


@fabric_router.get("/api/fabric/costing/access")
def costing_access(request: Request):
    """Reachable only through the middleware allowlist gate — the dashboard
    uses it to decide whether to reveal the Product Costing tab (fails closed).
    labour_available reports whether the DPS labour-cost columns are populated
    at all, so the UI can explain a manual-only labour fallback."""
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        try:
            r = q(conn, """SELECT COUNT(dps_cost_per_unit) AS n
                           FROM mo_fabric_consumption""")
            lab = bool(r and r[0]["n"])
        except Exception:
            lab = False
    email = _costing_user_email(request)
    uid, _ = _costing_user(request)
    return {
        "allowed": True,
        "labour_data_available": lab,
        # Per-step sign-off rights for THIS user plus the authorized-signer
        # lists, so the UI can disable/hide sign buttons and explain who may
        # sign each step. Server-side enforcement lives in the sign endpoint.
        "user_id": uid,
        "email": email,
        "can_sign_steps": sorted(s for s, emails in _COSTING_STEP_EMAILS.items()
                                 if email in emails),
        "step_signers": {str(s): sorted(v)
                         for s, v in _COSTING_STEP_EMAILS.items()},
    }


@fabric_router.get("/api/fabric/costing/styles")
def costing_styles(q_: str = Query(default="", alias="q"),
                   limit: int = Query(default=20)):
    """Searchable style list for the sheet creator — same strict own-style
    universe and tolerant matcher as the reservation picker."""
    limit = max(1, min(int(limit or 20), 50))
    return [{"style_name": s.get("style_name"),
             "style_number": s.get("style_number")}
            for s in _style_search_rows(q_, limit)]


@fabric_router.get("/api/fabric/costing/style-debug")
def costing_style_debug(name: str = Query(default=""),
                        request: Request = None):
    """Diagnostic endpoint (costing-role only).
    For a given style name, reports whether it is found in each data layer
    so the team can self-diagnose 'No matching style' mismatches without
    asking engineering."""
    # Middleware already gates /api/fabric/costing/* by _fabric_costing_allowed,
    # but guard explicitly so the endpoint is self-documenting.
    u = getattr(request.state, "user", None) if request else None
    if not _fabric_costing_allowed(u or {}):
        raise HTTPException(status_code=403, detail="Costing access required")
    if not (name or "").strip():
        raise HTTPException(status_code=400, detail="name query param is required")

    name_q = f"%{name.strip()}%"

    with _get_conn() as conn:
        # --- all_products_clean layer ---
        apc_rows = q(conn, """
            SELECT style_name, brand
            FROM all_products_clean
            WHERE style_name ILIKE %(n)s
              AND style_name IS NOT NULL AND style_name <> ''
            ORDER BY style_name
            LIMIT 5
        """, {"n": name_q})

        # --- raw_odoo_products layer ---
        rop_rows = q(conn, """
            SELECT COALESCE(NULLIF(TRIM(style_name), ''),
                            NULLIF(SPLIT_PART(name, ' - ', 1), '')) AS style_name,
                   brand
            FROM raw_odoo_products
            WHERE (style_name ILIKE %(n)s
                   OR (NULLIF(TRIM(style_name), '') IS NULL
                       AND SPLIT_PART(name, ' - ', 1) ILIKE %(n)s))
            ORDER BY 1
            LIMIT 5
        """, {"n": name_q})

    apc_found = len(apc_rows) > 0
    apc_sample = apc_rows[0].get("style_name") if apc_found else None
    rop_found = len(rop_rows) > 0
    rop_sample = rop_rows[0] if rop_found else None

    # --- picker search layer ---
    picker_hits = _style_search_rows(name, 5)
    q_low = name.strip().lower()
    matched_by_search = any(
        q_low in n.lower()
        for h in picker_hits
        for n in [h.get("style_name") or ""] + list(h.get("aliases") or [])
    )

    # --- Done-DPS visibility layer ---
    # Probes the exact union scope the DPS # picker uses (all_products_clean
    # ∪ raw_odoo_products, see _STYLE_SKU_COLORS_SQL) so "style resolves but
    # the DPS # picker is empty" cases are self-diagnosable. Probes the
    # exactly-matched style, falling back to the top picker hit for
    # substring queries.
    probe_row = _match_style(name) or (picker_hits[0] if picker_hits else None)
    dps_probe = {"style_name": None, "done_dps_count": 0,
                 "latest_done_date": None, "visible": False}
    if probe_row:
        scope_sql, scope_params, _ = _costing_color_scope(
            probe_row.get("style_name"), None)
        with _get_conn() as conn:
            r = q(conn, f"""
                SELECT COUNT(DISTINCT c.dps_ref) AS n,
                       MAX(c.done_date) AS latest
                FROM mo_fabric_consumption c
                WHERE {scope_sql}
                  AND c.dps_ref IS NOT NULL
            """, scope_params)
        n_dps = int(r[0]["n"] or 0)
        latest = r[0]["latest"]
        dps_probe = {"style_name": probe_row.get("style_name"),
                     "done_dps_count": n_dps,
                     "latest_done_date": latest.isoformat() if latest else None,
                     "visible": n_dps > 0}

    # --- human-readable suggestion ---
    if matched_by_search:
        suggestion = "Style is visible in the picker right now."
        if not dps_probe["visible"]:
            suggestion += (" No Done DPS is visible for it yet — the DPS # "
                           "picker stays empty until a DPS for this style "
                           "is Done and its MOs have synced.")
    elif rop_found and not apc_found:
        suggestion = (
            "Style is in raw_odoo_products (last nightly extract) but has not "
            "yet been through a full rebuild — it should appear in the picker "
            "within 60 s of the next nightly extract completing."
        )
    elif not rop_found and not apc_found:
        suggestion = (
            "Style not found in either layer. Check that the product exists in "
            "Odoo with a style name (x_vivo_attr_16) set and that the nightly "
            "extract has run since it was created."
        )
    elif apc_found and not matched_by_search:
        suggestion = (
            "Style is in all_products_clean but the picker did not match the "
            "search term — try a shorter or differently-spaced substring."
        )
    else:
        suggestion = (
            "Style appears in all_products_clean but not in the picker results "
            "for this search term — try a shorter substring."
        )

    return {
        "query": name,
        "all_products_clean": {
            "found": apc_found,
            "style_name": apc_sample,
        },
        "raw_odoo_products": {
            "found": rop_found,
            "style_name": rop_sample.get("style_name") if rop_sample else None,
            "brand": rop_sample.get("brand") if rop_sample else None,
        },
        "matched_by_search": matched_by_search,
        "picker_hits": [h.get("style_name") for h in picker_hits],
        "done_dps": dps_probe,
        "suggestion": suggestion,
    }


def _fabric_cost_missing_reason(in_master, kg_eff, std_price):
    """Why the standard cost/metre conversion (standard_price × kg_per_mtr_eff,
    i.e. cost/kg × Width(m) × GSM ÷ 1000) can't be derived for a fabric.
    Returns None when it IS derivable. The UI shows this instead of a silent 0."""
    if not in_master:
        return "Not linked to an Odoo fabric product — enter cost manually"
    no_conv = kg_eff is None or float(kg_eff) <= 0
    no_cost = std_price is None or float(std_price) <= 0
    if no_conv and no_cost:
        return ("No Width/GSM and no cost in Odoo — "
                "enter cost manually or fix the product")
    if no_conv:
        return "No Width/GSM in Odoo — enter cost manually or fix the product"
    if no_cost:
        return "No cost in Odoo — enter cost manually or fix the product"
    return None


@fabric_router.get("/api/fabric/costing/fabrics")
def costing_fabric_search(q_: str = Query(default="", alias="q"),
                          dps_ref: str = Query(default=None),
                          style_name: str = Query(default=None),
                          color: str = Query(default=None),
                          limit: int = Query(default=20)):
    """Component typeahead for costing lines. With `dps_ref` it is restricted
    to the components (main fabrics AND accessories/trims) actually consumed
    on the selected DPS's Done MOs; without one (Pre-production sheets) it
    searches the whole raw-material master. Both modes match name, internal
    code AND barcode. Fabrics return the master's CURRENT cost/metre
    (standard_price × kg_per_mtr_eff, the popup modal's Cost/Metre figure);
    accessories return the DPS/MO recorded unit cost (consumed-qty-weighted,
    never latest-PO). cost_per_metre / unit_cost are NULL when unknown, with
    cost_missing_reason saying why so the UI can explain the blank."""
    term = (q_ or "").strip()
    dps = (dps_ref or "").strip()
    if not dps:
        # Pre-production mode: search the whole raw-material master without
        # DPS scope, by name, internal code (default_code) or barcode.
        # Fabric-category rows carry the master conversion cost/metre;
        # Trim-category rows carry their Odoo standard cost per unit.
        if not term or len(term) < 2:
            return []
        _limit = max(1, min(int(limit or 20), 50))
        with _get_conn() as conn:
            rows = q(conn, """
                SELECT p.id, p.default_code AS sku, p.name,
                       NULLIF(TRIM(p.barcode), '') AS barcode,
                       p.category, p.kg_per_mtr_eff, p.standard_price,
                       ROUND(CASE WHEN p.category = 'Fabric'
                                   AND p.kg_per_mtr_eff > 0
                                   AND p.standard_price > 0
                                  THEN (p.standard_price * p.kg_per_mtr_eff)::numeric
                                  ELSE NULL END, 2) AS cost_per_metre
                FROM raw_fabric_products p
                WHERE p.name ILIKE %s OR p.default_code ILIKE %s
                   OR p.barcode ILIKE %s
                ORDER BY (p.category <> 'Fabric'), p.name
                LIMIT %s
            """, [f"%{term}%", f"%{term}%", f"%{term}%", _limit])
        out = []
        for r in rows:
            is_fab = (r["category"] or "").strip().lower() == "fabric"
            cpm = (float(r["cost_per_metre"])
                   if r["cost_per_metre"] is not None else None)
            unit_cost, reason = None, None
            if is_fab:
                if cpm is None:
                    reason = _fabric_cost_missing_reason(
                        True, r["kg_per_mtr_eff"], r["standard_price"])
            else:
                # Accessory/trim: no metre conversion — its Odoo standard
                # cost is the per-unit cost (same basis the MO extract records).
                std = float(r["standard_price"] or 0)
                unit_cost = round(std, 2) if std > 0 else None
                if unit_cost is None:
                    reason = ("No cost in Odoo — enter cost manually "
                              "or fix the product")
            out.append({"id": r["id"], "sku": r["sku"], "name": r["name"],
                        "barcode": r["barcode"],
                        "is_main_fabric": is_fab,
                        "cost_per_metre": cpm,
                        "unit_cost": unit_cost,
                        "cost_missing_reason": reason})
        return out
    limit = max(1, min(int(limit or 20), 50))
    # Optional colour scope (with the style): restrict to components consumed
    # on the MOs whose finished SKU is that colour of the style, so the
    # typeahead matches the colour-scoped suggestions exactly.
    style = (style_name or "").strip() or None
    col = (color or "").strip() or None
    color_sql, color_params = "", []
    if style and col:
        scope_sql, scope_params, _ = _costing_color_scope(style, col)
        color_sql = f"AND {scope_sql}"
        color_params = scope_params
    with _get_conn() as conn:
        rows = q(conn, f"""
            SELECT c.component_id AS id,
                   MAX(c.fabric_sku)  AS sku,
                   MAX(c.fabric_name) AS name,
                   MAX(p.barcode)     AS barcode,
                   bool_or(c.is_main_fabric) AS is_main_fabric,
                   MAX(p.id)             AS master_id,
                   MAX(p.kg_per_mtr_eff) AS kg_per_mtr_eff,
                   MAX(p.standard_price) AS standard_price,
                   ROUND(MAX(CASE WHEN p.kg_per_mtr_eff > 0 AND p.standard_price > 0
                             THEN p.standard_price * p.kg_per_mtr_eff
                             ELSE NULL END)::numeric, 2) AS cost_per_metre,
                   ROUND((SUM(c.unit_cost_mo * c.consumed_qty)
                              FILTER (WHERE c.unit_cost_mo > 0 AND c.consumed_qty > 0)
                          / NULLIF(SUM(c.consumed_qty)
                              FILTER (WHERE c.unit_cost_mo > 0 AND c.consumed_qty > 0), 0)
                         )::numeric, 2) AS unit_cost
            FROM mo_fabric_consumption c
            LEFT JOIN raw_fabric_products p ON p.id = c.component_id
            WHERE c.dps_ref = %s
              {color_sql}
              AND (%s = '' OR c.fabric_name ILIKE %s OR c.fabric_sku ILIKE %s
                   OR p.barcode ILIKE %s)
            GROUP BY c.component_id
            ORDER BY bool_or(c.is_main_fabric) DESC, MAX(c.fabric_name)
            LIMIT %s
        """, [dps] + color_params + [term, f"%{term}%", f"%{term}%",
                                     f"%{term}%", limit])
    out = []
    for r in rows:
        is_main = bool(r["is_main_fabric"])
        cpm = (float(r["cost_per_metre"])
               if r["cost_per_metre"] is not None else None)
        uc = float(r["unit_cost"]) if r["unit_cost"] is not None else None
        reason = None
        if is_main and cpm is None:
            reason = _fabric_cost_missing_reason(
                r["master_id"] is not None,
                r["kg_per_mtr_eff"], r["standard_price"])
        elif not is_main and uc is None:
            reason = "No recorded cost on this DPS's MOs — enter cost manually"
        out.append({"id": r["id"], "sku": r["sku"], "name": r["name"],
                    "barcode": (r["barcode"] or "").strip() or None,
                    "is_main_fabric": is_main,
                    "cost_per_metre": cpm,
                    "unit_cost": uc,
                    "cost_missing_reason": reason})
    return out


@fabric_router.get("/api/fabric/costing/dps")
def costing_dps_list(style_name: str = Query(...)):
    """Done DPS list for a style (DPS ref, latest done date, produced garments,
    MO count) — feeds the DPS # picker on the new-sheet form. Produced qty is
    summed over the DPS's MOs at the MO grain (component rows would repeat it).
    The style's finished-SKU set unions all_products_clean with
    raw_odoo_products (_STYLE_SKU_COLORS_SQL) so brand-new styles that only
    exist in the raw extract list their DPSes too."""
    style_row = _match_style(style_name)
    if not style_row:
        raise HTTPException(status_code=404, detail="Unknown style")
    canon = style_row.get("style_name")
    with _get_conn() as conn:
        rows = q(conn, f"""
            WITH sku_colors AS ({_STYLE_SKU_COLORS_SQL}),
            mo AS (
                SELECT DISTINCT c.dps_ref, c.odoo_mo_id, c.produced_qty,
                       c.done_date, c.finished_sku
                FROM mo_fabric_consumption c
                WHERE c.finished_sku IN (SELECT sku FROM sku_colors)
                  AND c.dps_ref IS NOT NULL
            )
            SELECT mo.dps_ref, MAX(mo.done_date) AS done_date,
                   SUM(mo.produced_qty) AS produced_qty,
                   COUNT(*) AS mo_count,
                   -- Distinct colours of the finished SKUs this DPS produced
                   -- for the style (master color_print, falling back to the
                   -- raw product name's colour segment for SKUs not in the
                   -- master yet) — feeds the sheet creator's colour picker.
                   ARRAY_AGG(DISTINCT sc.color)
                       FILTER (WHERE sc.color IS NOT NULL) AS colors
            FROM mo
            LEFT JOIN sku_colors sc ON sc.sku = mo.finished_sku
            GROUP BY mo.dps_ref
            ORDER BY MAX(mo.done_date) DESC NULLS LAST, mo.dps_ref DESC
            LIMIT 100
        """, [canon, canon])
    return {"style_name": canon, "dps": [{
        "dps_ref": r["dps_ref"],
        "done_date": r["done_date"].isoformat() if r["done_date"] else None,
        "produced_qty": round(float(r["produced_qty"] or 0)),
        "mo_count": r["mo_count"],
        "colors": sorted(r["colors"] or []),
    } for r in rows]}


@fabric_router.get("/api/fabric/costing/suggest")
def costing_suggest(style_name: str = Query(...),
                    dps_ref: str = Query(default=None),
                    color: str = Query(default=None)):
    style_row = _match_style(style_name)
    if not style_row:
        raise HTTPException(status_code=404, detail="Unknown style")
    canon = style_row.get("style_name")
    dps_ref = (dps_ref or "").strip() or None
    if not dps_ref:
        raise HTTPException(status_code=400,
                            detail="dps_ref is required — pick a DPS # for the style")
    color = (color or "").strip() or None
    with _get_conn() as conn:
        _require_style_dps(conn, canon, dps_ref, color=color)
        facts = _costing_style_facts(conn, canon, dps_ref=dps_ref, color=color)
        sp = _style_selling_price(conn, canon)
    facts["style_name"] = canon
    facts["style_number"] = style_row.get("style_number")
    facts["selling_price"] = sp
    return facts


# ── Pre-production Accessories % — previous-month Done-DPS average ──────
# The Pre-production "Accessories % of fabric cost" is no longer hand-typed:
# it is picked ONCE at sheet creation from the previous CALENDAR month's
# Done-DPS actuals and persisted with full provenance (source month, DPS
# count, fallback flag). Pooled ratio on the same MO-valued basis as the
# costing consumption analysis: Σ(consumed_qty × unit_cost_mo) of trims rows
# ÷ the same sum of fabric rows. A DPS qualifies when it has ≥1 fabric
# component (is_main_fabric) AND ≥1 trims component and its fabric value is
# > 0; each DPS is attributed to the month of its LATEST done_date. No
# qualifying DPS in the previous month → walk back to the most recent
# earlier month that has them (flagged as fallback); no month at all → the
# legacy 13% default, labelled as such.

_PP_ACC_DEFAULT_PCT = 13.0
_PP_MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _preprod_month_label(ym):
    """'2026-07' → 'Jul 2026' (locale-independent)."""
    try:
        y, m = str(ym).split("-")[:2]
        return f"{_PP_MONTH_ABBR[int(m) - 1]} {int(y)}"
    except Exception:
        return str(ym)


def _preprod_acc_pct_fmt(pct):
    """Display form of the % — rounded HALF-UP to 2 dp with trailing zeros
    dropped ('8.98', '13'). Mirrors costAccPctFmt in the editor JS
    (Math.round semantics) so server-stamped and editor-recalculated labels
    stay byte-identical."""
    try:
        return f"{math.floor(float(pct) * 100 + 0.5) / 100.0:g}"
    except (TypeError, ValueError):
        return str(pct)


def _preprod_acc_provenance_suffix(meta):
    """Canonical ' — <Mon YYYY> Done-DPS avg, N DPS' provenance suffix used
    in the auto Accessories line label AND source. Empty for legacy sheets
    (meta None) so their labels stay exactly as saved. Must match
    costAccProvSuffix in the editor JS character-for-character."""
    if not isinstance(meta, dict):
        return ""
    if meta.get("retrofit_status") == "retained_no_history":
        return " — retained (no qualifying Done-DPS history)"
    if meta.get("is_default"):
        return " — default (no Done-DPS history)"
    lbl = meta.get("month_label") or _preprod_month_label(meta.get("source_month"))
    suffix = f" — {lbl} Done-DPS avg, {int(meta.get('dps_count') or 0)} DPS"
    if meta.get("fallback"):
        suffix += " (fallback)"
    return suffix


def _preprod_acc_month_rows(conn):
    """Per-month pooled trims/fabric MO value over QUALIFYING Done DPS,
    newest month first. Same valuation filters as the MO-valued accessory
    basis used for main-production suggestions (unit_cost_mo > 0 AND
    consumed_qty > 0 rows only)."""
    return q(conn, """
        WITH dps AS (
            SELECT dps_ref,
                   to_char(date_trunc('month', MAX(done_date)), 'YYYY-MM') AS month,
                   SUM(consumed_qty * unit_cost_mo)
                       FILTER (WHERE is_main_fabric
                               AND unit_cost_mo > 0 AND consumed_qty > 0) AS fabric_val,
                   SUM(consumed_qty * unit_cost_mo)
                       FILTER (WHERE NOT is_main_fabric
                               AND unit_cost_mo > 0 AND consumed_qty > 0) AS trims_val,
                   COUNT(*) FILTER (WHERE is_main_fabric)     AS fabric_rows,
                   COUNT(*) FILTER (WHERE NOT is_main_fabric) AS trims_rows
            FROM mo_fabric_consumption
            WHERE dps_ref IS NOT NULL AND done_date IS NOT NULL
            GROUP BY dps_ref
        )
        SELECT month,
               COUNT(*)                    AS dps_count,
               SUM(COALESCE(trims_val, 0)) AS trims_total,
               SUM(fabric_val)             AS fabric_total
        FROM dps
        WHERE fabric_rows > 0 AND trims_rows > 0 AND COALESCE(fabric_val, 0) > 0
        GROUP BY month
        ORDER BY month DESC
    """)


def _preprod_acc_pick_from_months(month_rows, today):
    """Pure picker: previous calendar month relative to `today`, walking back
    to the most recent earlier month with qualifying DPS (fallback=True), or
    the 13% default when no month qualifies. Months at/after the current one
    are never considered. Returns {"pct": float, "meta": dict} — pct is the
    PRECISE value (the maths uses it); display rounds to 2 dp."""
    first_this = today.replace(day=1)
    prev = first_this - datetime.timedelta(days=1)
    want = f"{prev.year:04d}-{prev.month:02d}"
    picked_at = datetime.datetime.now(ZoneInfo("Africa/Nairobi")).isoformat()
    usable = []
    for r in month_rows or []:
        m = str(r.get("month") or "")
        fab = float(r.get("fabric_total") or 0)
        n = int(r.get("dps_count") or 0)
        if not m or m > want or fab <= 0 or n <= 0:
            continue
        usable.append((m, n, float(r.get("trims_total") or 0), fab))
    usable.sort(key=lambda t: t[0], reverse=True)
    if usable:
        m, n, trims, fab = usable[0]
        pct = trims / fab * 100.0
        meta = {
            "pct": pct,
            "source_month": m,
            "month_label": _preprod_month_label(m),
            "dps_count": n,
            "fallback": m != want,
            "is_default": False,
            "requested_month": want,
            "requested_month_label": _preprod_month_label(want),
            "picked_at": picked_at,
        }
        return {"pct": pct, "meta": meta}
    meta = {
        "pct": _PP_ACC_DEFAULT_PCT,
        "source_month": None,
        "month_label": None,
        "dps_count": 0,
        "fallback": False,
        "is_default": True,
        "requested_month": want,
        "requested_month_label": _preprod_month_label(want),
        "picked_at": picked_at,
    }
    return {"pct": _PP_ACC_DEFAULT_PCT, "meta": meta}


def _preprod_accessories_pick(conn, today=None):
    """The % a pre-production sheet created `today` (EAT) uses. A missing
    mo_fabric_consumption table (brand-new DB, extract never ran) is
    genuinely 'no data' → the labelled 13% default; any other DB error
    surfaces."""
    if today is None:
        today = datetime.datetime.now(ZoneInfo("Africa/Nairobi")).date()
    try:
        rows = _preprod_acc_month_rows(conn)
    except Exception as e:
        if getattr(e, "pgcode", None) == "42P01":  # undefined_table
            conn.rollback()
            rows = []
        else:
            raise
    return _preprod_acc_pick_from_months(rows, today)


_PP_AUTO_SOURCE_PREFIX = "pre-production auto"
# Machine-generated Accessories line label: the legacy form and the
# provenance-suffixed form ("… — Jul 2026 Done-DPS avg, 75 DPS"). Kept in
# lockstep with COST_PP_LEGACY_LABELS.trim in the editor JS.
_PP_ACC_LINE_LABEL_RE = re.compile(
    r"^Accessories \([\d.]+% of fabric cost( — .*)?\)$")
_PP_CMT_LINE_LABEL_RE = re.compile(r"^CMT \([^)]*×[\d.]+\)$")
_PP_DEFECT_LINE_LABEL_RE = re.compile(
    r"^Defect Allowance \([\d.]+% of fabric cost\)$")


def _preprod_machine_line_indexes(lines, kind, label_re):
    """Return only conclusively machine-generated Pre-production rows.

    A controlled backfill is intentionally stricter than the live editor's
    legacy-label adoption. A source tag proves machine ownership; a matching
    historical label alone cannot distinguish an old generated row from a
    user-authored same-label cost and must remain untouched.
    """
    return [
        i for i, line in enumerate(lines)
        if line.get("kind") == kind
        and line.get("is_auto")
        and (line.get("source") or "").startswith(_PP_AUTO_SOURCE_PREFIX)
    ]


def _preprod_fabric_total(lines):
    return sum(
        float(line.get("qty") or 0) * float(line.get("unit_cost") or 0)
        for line in lines if line.get("kind") == "fabric")


def _preprod_cmt_amount(start_time, stop_time, cost_per_minute,
                        production_multiplier):
    """Mirror the editor's time-based CMT calculation.

    Invalid/missing times deliberately produce a zero auto line, which is the
    existing client-side behavior. A stop before start wraps over midnight.
    """
    def minutes(value):
        try:
            parts = str(value or "").strip().split(":")
            if len(parts) not in (2, 3):
                return None
            hour, minute = int(parts[0]), int(parts[1])
            second = float(parts[2]) if len(parts) == 3 else 0.0
            if not (0 <= hour < 24 and 0 <= minute < 60 and 0 <= second < 60):
                return None
            return hour * 60 + minute + second / 60.0
        except (TypeError, ValueError):
            return None

    start, stop = minutes(start_time), minutes(stop_time)
    if start is None or stop is None:
        return 0.0
    raw_minutes = stop - start
    if raw_minutes < 0:
        raw_minutes += 24 * 60
    try:
        multiplier = float(production_multiplier)
    except (TypeError, ValueError):
        multiplier = 1.40
    if multiplier <= 0:
        multiplier = 1.40
    adjusted_minutes = math.floor(raw_minutes * multiplier * 100 + 0.5) / 100.0
    return math.floor(adjusted_minutes * float(cost_per_minute) * 100 + 0.5) / 100.0


def _preprod_stamp_default_lines(lines, defect_allowance_pct,
                                 cost_per_minute, cmt_start_time,
                                 cmt_stop_time, production_multiplier):
    """Recalculate only the machine Pre-production CMT and defect rows.

    The controlled default retrofit must not add rows that were never present
    or rewrite user-added labour/overhead entries. Existing duplicate machine
    rows are folded into the first, matching the editor's adoption behavior.
    """
    fabric_total = _preprod_fabric_total(lines)
    defect_amount = math.floor(
        float(defect_allowance_pct) / 100.0 * fabric_total * 100 + 0.5) / 100.0
    cmt_amount = _preprod_cmt_amount(
        cmt_start_time, cmt_stop_time, cost_per_minute, production_multiplier)
    multiplier_text = _costing_mult_fmt(production_multiplier)
    cpm_text = f"{float(cost_per_minute):g}"
    cmt_label = (
        f"CMT ({str(cmt_start_time or '?')}–{str(cmt_stop_time or '?')}, "
        f"KES {cpm_text}/min ×{multiplier_text})")
    defect_text = f"{float(defect_allowance_pct):g}% of fabric cost"
    defaults = (
        ("cmt", _PP_CMT_LINE_LABEL_RE, {
            "label": cmt_label, "qty": 1.0, "unit_cost": round(cmt_amount, 4),
            "total": round(cmt_amount, 2), "is_auto": True,
            "source": f"{_PP_AUTO_SOURCE_PREFIX}: time-based CMT",
            "component_id": None,
        }),
        ("overhead", _PP_DEFECT_LINE_LABEL_RE, {
            "label": f"Defect Allowance ({defect_text})",
            "qty": 1.0, "unit_cost": round(defect_amount, 4),
            "total": round(defect_amount, 2), "is_auto": True,
            "source": f"{_PP_AUTO_SOURCE_PREFIX}: {defect_text}",
            "component_id": None,
        }),
    )
    for kind, label_re, patch in defaults:
        indexes = _preprod_machine_line_indexes(lines, kind, label_re)
        if not indexes:
            continue
        lines[indexes[0]].update(patch)
        for index in reversed(indexes[1:]):
            lines.pop(index)
    return lines


def _preprod_embroidery_total(data):
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            data = None
    if not isinstance(data, dict) or not data.get("enabled"):
        return 0.0
    try:
        return float(data.get("cost_per_run") or 0) * float(data.get("run_count") or 0)
    except (TypeError, ValueError):
        return 0.0


def _preprod_stamp_accessories(lines, pct, meta, recalculate=True):
    """Server-authoritative Accessories auto line for pre-production sheets.

    When ``recalculate`` is true, the amount is rebuilt from all fabric line
    totals. The one-time legacy retrofit passes false only when there is no
    qualifying Done-DPS history: in that case the saved amount is deliberately
    retained while the machine row gains explicit retained-value provenance.
    Sheets with no matching row are left alone — the server never injects
    lines."""
    idxs = []
    for i, ln in enumerate(lines):
        if ln.get("kind") != "trim":
            continue
        src = ln.get("source") or ""
        label = (ln.get("label") or "").strip()
        if ((ln.get("is_auto") and src.startswith(_PP_AUTO_SOURCE_PREFIX))
                or _PP_ACC_LINE_LABEL_RE.match(label)):
            idxs.append(i)
    if not idxs:
        return lines
    txt = (f"{_preprod_acc_pct_fmt(pct)}% of fabric cost"
           f"{_preprod_acc_provenance_suffix(meta)}")
    keep = lines[idxs[0]]
    patch = {
        "label": f"Accessories ({txt})",
        "is_auto": True,
        "source": f"{_PP_AUTO_SOURCE_PREFIX}: {txt}",
        "component_id": None,
    }
    if recalculate:
        fab_total = sum(
            float(ln.get("qty") or 0) * float(ln.get("unit_cost") or 0)
            for ln in lines if ln.get("kind") == "fabric")
        # Same rounding as the editor (Math.round half-up) on the PRECISE %.
        amount = math.floor(
            float(pct) / 100.0 * fab_total * 100 + 0.5) / 100.0
        patch.update({
            "qty": 1.0,
            "unit_cost": round(amount, 4),
            "total": round(amount, 2),
        })
    keep.update(patch)
    for j in reversed(idxs[1:]):
        lines.pop(j)
    return lines


def _preprod_apply_accessories(lines, pct, meta):
    """Re-stamp and recalculate the machine Accessories row from sheet state."""
    return _preprod_stamp_accessories(lines, pct, meta, recalculate=True)


def _preprod_restore_retained_amount(lines, saved_lines):
    """Keep a no-history retrofit's original Accessories amount authoritative.

    The browser normally posts the unchanged disabled derived row, but a
    server-side restore is still required so a stale or tampered client cannot
    turn a retained legacy cost into a user-editable override.
    """
    saved = next(
        (l for l in saved_lines
         if l.get("kind") == "trim"
         and ((_PP_ACC_LINE_LABEL_RE.match((l.get("label") or "").strip()))
              or (l.get("is_auto")
                  and (l.get("source") or "").startswith(
                      _PP_AUTO_SOURCE_PREFIX)))),
        None)
    posted = next(
        (l for l in lines
         if l.get("kind") == "trim"
         and ((_PP_ACC_LINE_LABEL_RE.match((l.get("label") or "").strip()))
              or (l.get("is_auto")
                  and (l.get("source") or "").startswith(
                      _PP_AUTO_SOURCE_PREFIX)))),
        None)
    if saved is not None and posted is not None:
        posted.update({
            "qty": saved.get("qty"),
            "unit_cost": saved.get("unit_cost"),
            "total": saved.get("total"),
        })
    return lines


_PP_ACC_BACKFILL_KEY = "preprod_accessories_pct_v1"


def _preprod_accessories_backfill(conn, uid, uname, today=None):
    """Retrofit legacy pre-production sheets with one common Done-DPS pick.

    The picker runs exactly once. Each eligible sheet is isolated by a
    savepoint so a malformed legacy row cannot block the rest; successful
    sheets receive an idempotency marker in ``accessories_pct_meta``. Approved
    sheets are intentionally included without calling the normal edit-lock
    guard because this migration may only touch Accessories provenance and its
    existing machine-generated line.
    """
    pick = _preprod_accessories_pick(conn, today=today)
    picked_meta = dict(pick["meta"])
    has_history = not bool(picked_meta.get("is_default"))
    run_at = datetime.datetime.now(ZoneInfo("Africa/Nairobi")).isoformat()
    sheets = q(conn, """
        SELECT s.id, s.style_name, s.accessories_pct,
               s.accessories_pct_meta,
               EXISTS (
                   SELECT 1 FROM fabric_costing_signoffs so
                   WHERE so.sheet_id=s.id AND so.step=3
               ) AS locked
        FROM fabric_costing_sheets s
        WHERE COALESCE(s.stage, 'main_production')='pre_production'
        ORDER BY s.id
        FOR UPDATE
    """)
    result = {
        "migration_key": _PP_ACC_BACKFILL_KEY,
        "source_month": picked_meta.get("source_month") if has_history else None,
        "month_label": picked_meta.get("month_label") if has_history else None,
        "dps_count": int(picked_meta.get("dps_count") or 0) if has_history else 0,
        "picked": 0,
        "retained": 0,
        "skipped": 0,
        "errors": 0,
        "locked_updated": 0,
        "error_rows": [],
    }
    for sheet in sheets:
        raw_meta = sheet.get("accessories_pct_meta")
        if isinstance(raw_meta, str):
            try:
                raw_meta = json.loads(raw_meta)
            except Exception:
                raw_meta = None
        if isinstance(raw_meta, dict):
            result["skipped"] += 1
            continue

        sid = int(sheet["id"])
        savepoint = f"cost_acc_backfill_{sid}"
        with conn.cursor() as cur:
            cur.execute(f"SAVEPOINT {savepoint}")
        try:
            old_pct = (float(sheet["accessories_pct"])
                       if sheet.get("accessories_pct") is not None
                       else _PP_ACC_DEFAULT_PCT)
            if has_history:
                pct = float(pick["pct"])
                meta = dict(picked_meta)
                meta.update({
                    "migration_key": _PP_ACC_BACKFILL_KEY,
                    "retrofit_status": "picked",
                    "backfilled_at": run_at,
                })
                outcome = "picked"
            else:
                pct = old_pct
                meta = {
                    "pct": pct,
                    "source_month": None,
                    "month_label": None,
                    "dps_count": 0,
                    "fallback": False,
                    "is_default": False,
                    "requested_month": picked_meta.get("requested_month"),
                    "requested_month_label": picked_meta.get(
                        "requested_month_label"),
                    "migration_key": _PP_ACC_BACKFILL_KEY,
                    "retrofit_status": "retained_no_history",
                    "backfilled_at": run_at,
                }
                outcome = "retained"

            lines = [dict(r) for r in q(conn, """
                SELECT id, kind, label, qty, unit_cost, total, is_auto,
                       source, position, component_id
                FROM fabric_costing_lines
                WHERE sheet_id=%s
                ORDER BY position, id
            """, (sid,))]
            original_by_id = {int(l["id"]): dict(l) for l in lines}
            _preprod_stamp_accessories(
                lines, pct, meta, recalculate=has_history)
            kept_ids = {int(l["id"]) for l in lines}
            removed_ids = [
                line_id for line_id in original_by_id if line_id not in kept_ids]
            changed_lines = []
            for line in lines:
                line_id = int(line["id"])
                old = original_by_id[line_id]
                fields = ("label", "qty", "unit_cost", "total", "is_auto",
                          "source", "component_id")
                if any(old.get(k) != line.get(k) for k in fields):
                    changed_lines.append(line)

            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE fabric_costing_sheets
                    SET accessories_pct=%s, accessories_pct_meta=%s
                    WHERE id=%s AND accessories_pct_meta IS NULL
                """, (pct, json.dumps(meta), sid))
                for line in changed_lines:
                    if has_history:
                        cur.execute("""
                            UPDATE fabric_costing_lines
                            SET label=%s, qty=%s, unit_cost=%s, total=%s,
                                is_auto=%s, source=%s, component_id=%s
                            WHERE id=%s AND sheet_id=%s
                        """, (line.get("label"), line.get("qty"),
                              line.get("unit_cost"), line.get("total"),
                              line.get("is_auto"), line.get("source"),
                              line.get("component_id"), line["id"], sid))
                    else:
                        cur.execute("""
                            UPDATE fabric_costing_lines
                            SET label=%s, is_auto=%s, source=%s
                            WHERE id=%s AND sheet_id=%s
                        """, (line.get("label"), line.get("is_auto"),
                              line.get("source"), line["id"], sid))
                if removed_ids:
                    cur.execute("""
                        DELETE FROM fabric_costing_lines
                        WHERE sheet_id=%s AND id = ANY(%s)
                    """, (sid, removed_ids))

            summary = (
                f"Accessories % retrofit: {_preprod_acc_pct_fmt(pct)}% from "
                f"{meta.get('month_label')} Done-DPS average "
                f"({int(meta.get('dps_count') or 0)} DPS)"
                if has_history else
                f"Accessories % retrofit: retained {_preprod_acc_pct_fmt(pct)}% "
                "because no qualifying Done-DPS history was available"
            )
            _costing_history_write(
                conn, sid, "accessories_pct_retrofit", uid, uname, summary, {
                    "migration_key": _PP_ACC_BACKFILL_KEY,
                    "retrofit_status": meta["retrofit_status"],
                    "previous_pct": old_pct,
                    "accessories_pct": pct,
                    "accessories_pct_meta": meta,
                    "accessories_line_updated": bool(changed_lines),
                    "duplicate_machine_lines_removed": len(removed_ids),
                    "approved_sheet": bool(sheet.get("locked")),
                })
            with conn.cursor() as cur:
                cur.execute(f"RELEASE SAVEPOINT {savepoint}")
            result[outcome] += 1
            if sheet.get("locked"):
                result["locked_updated"] += 1
        except Exception as exc:
            with conn.cursor() as cur:
                cur.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                cur.execute(f"RELEASE SAVEPOINT {savepoint}")
            result["errors"] += 1
            result["error_rows"].append({
                "sheet_id": sid,
                "style_name": sheet.get("style_name"),
                "error": str(exc)[:300],
            })
    return result


def _preprod_defaults_backfill(conn, uid, uname):
    """Apply the requested Pre-production defect/CMT defaults once per sheet.

    This deliberately includes approved sheets: it is a narrowly-scoped,
    recorded maintenance operation, not an editor mutation. It updates only
    the two requested header inputs, their existing machine lines, and the
    dependent proposed price; Main Production, user-added rows, signoffs, and
    all unrelated headers are left intact.
    """
    run_at = datetime.datetime.now(ZoneInfo("Africa/Nairobi")).isoformat()
    sheets = q(conn, """
        SELECT s.id, s.style_name, s.defect_allowance_pct, s.cost_per_minute,
               s.cmt_start_time, s.cmt_stop_time, s.production_multiplier,
               s.selling_price, s.embroidery_data, s.preprod_defaults_meta,
               EXISTS (
                   SELECT 1 FROM fabric_costing_signoffs so
                   WHERE so.sheet_id=s.id AND so.step=3
               ) AS locked
        FROM fabric_costing_sheets s
        WHERE COALESCE(s.stage, 'main_production')='pre_production'
        ORDER BY s.id
        FOR UPDATE
    """)
    result = {
        "migration_key": _PP_DEFAULTS_BACKFILL_KEY,
        "defect_allowance_pct": _PP_DEFECT_ALLOWANCE_DEFAULT_PCT,
        "cost_per_minute": _PP_COST_PER_MINUTE_DEFAULT,
        "updated": 0,
        "skipped": 0,
        "errors": 0,
        "locked_updated": 0,
        "error_rows": [],
    }
    for sheet in sheets:
        meta = sheet.get("preprod_defaults_meta")
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = None
        if isinstance(meta, dict) and meta.get("migration_key") == _PP_DEFAULTS_BACKFILL_KEY:
            result["skipped"] += 1
            continue

        sid = int(sheet["id"])
        savepoint = f"cost_defaults_backfill_{sid}"
        with conn.cursor() as cur:
            cur.execute(f"SAVEPOINT {savepoint}")
        try:
            old_defect = sheet.get("defect_allowance_pct")
            old_cpm = sheet.get("cost_per_minute")
            old_price = sheet.get("selling_price")
            lines = [dict(row) for row in q(conn, """
                SELECT id, kind, label, qty, unit_cost, total, is_auto,
                       source, position, component_id
                FROM fabric_costing_lines
                WHERE sheet_id=%s
                ORDER BY position, id
            """, (sid,))]
            original_by_id = {int(line["id"]): dict(line) for line in lines}
            _preprod_stamp_default_lines(
                lines, _PP_DEFECT_ALLOWANCE_DEFAULT_PCT,
                _PP_COST_PER_MINUTE_DEFAULT, sheet.get("cmt_start_time"),
                sheet.get("cmt_stop_time"), sheet.get("production_multiplier"))
            kept_ids = {int(line["id"]) for line in lines}
            removed_ids = [
                line_id for line_id in original_by_id if line_id not in kept_ids]
            changed_lines = [
                line for line in lines
                if any(
                    original_by_id[int(line["id"])].get(field) != line.get(field)
                    for field in ("label", "qty", "unit_cost", "total", "is_auto",
                                  "source", "component_id"))
            ]
            new_total = round(
                sum(float(line.get("total") or 0) for line in lines)
                + _preprod_embroidery_total(sheet.get("embroidery_data")), 2)
            _, new_price = _preproduction_proposed_prices(new_total)
            new_meta = dict(meta) if isinstance(meta, dict) else {}
            new_meta.update({
                "migration_key": _PP_DEFAULTS_BACKFILL_KEY,
                "backfilled_at": run_at,
                "defect_allowance_pct": _PP_DEFECT_ALLOWANCE_DEFAULT_PCT,
                "cost_per_minute": _PP_COST_PER_MINUTE_DEFAULT,
            })
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE fabric_costing_sheets
                    SET defect_allowance_pct=%s, cost_per_minute=%s,
                        selling_price=%s, preprod_defaults_meta=%s
                    WHERE id=%s
                """, (_PP_DEFECT_ALLOWANCE_DEFAULT_PCT,
                      _PP_COST_PER_MINUTE_DEFAULT, new_price,
                      json.dumps(new_meta), sid))
                for line in changed_lines:
                    cur.execute("""
                        UPDATE fabric_costing_lines
                        SET label=%s, qty=%s, unit_cost=%s, total=%s,
                            is_auto=%s, source=%s, component_id=%s
                        WHERE id=%s AND sheet_id=%s
                    """, (line.get("label"), line.get("qty"),
                          line.get("unit_cost"), line.get("total"),
                          line.get("is_auto"), line.get("source"),
                          line.get("component_id"), line["id"], sid))
                if removed_ids:
                    cur.execute("""
                        DELETE FROM fabric_costing_lines
                        WHERE sheet_id=%s AND id = ANY(%s)
                    """, (sid, removed_ids))
            _costing_history_write(
                conn, sid, "preprod_defaults_backfill", uid, uname,
                ("Pre-production defaults updated: Defect Allowance "
                 f"{_PP_DEFECT_ALLOWANCE_DEFAULT_PCT:g}%; Cost per Minute "
                 f"KES {_PP_COST_PER_MINUTE_DEFAULT:g}"),
                {
                    "migration_key": _PP_DEFAULTS_BACKFILL_KEY,
                    "previous_defect_allowance_pct": old_defect,
                    "defect_allowance_pct": _PP_DEFECT_ALLOWANCE_DEFAULT_PCT,
                    "previous_cost_per_minute": old_cpm,
                    "cost_per_minute": _PP_COST_PER_MINUTE_DEFAULT,
                    "previous_selling_price": old_price,
                    "selling_price": new_price,
                    "default_lines_updated": len(changed_lines),
                    "duplicate_machine_lines_removed": len(removed_ids),
                    "approved_sheet": bool(sheet.get("locked")),
                })
            with conn.cursor() as cur:
                cur.execute(f"RELEASE SAVEPOINT {savepoint}")
            result["updated"] += 1
            if sheet.get("locked"):
                result["locked_updated"] += 1
        except Exception as exc:
            with conn.cursor() as cur:
                cur.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                cur.execute(f"RELEASE SAVEPOINT {savepoint}")
            result["errors"] += 1
            result["error_rows"].append({
                "sheet_id": sid,
                "style_name": sheet.get("style_name"),
                "error": str(exc)[:300],
            })
    return result


def _clean_costing_lines(lines):
    """Validate + normalise posted cost lines; totals are recomputed
    server-side (never trusted from the client)."""
    out = []
    if not isinstance(lines, list) or not lines:
        raise HTTPException(status_code=400, detail="At least one cost line is required")
    if len(lines) > 100:
        raise HTTPException(status_code=400, detail="Too many lines")
    for i, ln in enumerate(lines):
        if not isinstance(ln, dict):
            raise HTTPException(status_code=400, detail="Bad line")
        kind = (ln.get("kind") or "").strip().lower()
        if kind not in _COSTING_LINE_KINDS:
            raise HTTPException(status_code=400,
                                detail=f"Line {i+1}: kind must be one of {_COSTING_LINE_KINDS}")
        try:
            qty = float(ln.get("qty") if ln.get("qty") not in (None, "") else 1)
            unit_cost = float(ln.get("unit_cost") if ln.get("unit_cost") not in (None, "") else 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Line {i+1}: qty/unit cost must be numbers")
        if qty < 0 or unit_cost < 0:
            raise HTTPException(status_code=400, detail=f"Line {i+1}: negative values not allowed")
        comp = ln.get("component_id")
        try:
            comp = int(comp) if comp not in (None, "", 0) else None
        except (TypeError, ValueError):
            comp = None
        # The component link only means anything on raw-material lines
        # (fabric + trim/accessory) — it resolves the Odoo product's barcode
        # on read. CMT/overhead lines never link to a product.
        if kind not in ("fabric", "trim"):
            comp = None
        out.append({
            "component_id": comp,
            "kind": kind,
            "label": (str(ln.get("label") or "").strip())[:200],
            "qty": round(qty, 4),
            "unit_cost": round(unit_cost, 4),
            "total": round(qty * unit_cost, 2),
            "is_auto": bool(ln.get("is_auto")),
            "source": (str(ln.get("source") or "").strip())[:200] or None,
            "position": i,
        })
    return out


# Saved costing sheets are a SNAPSHOT: fabric lines keep the cost/metre
# captured when the DPS was costed / the sheet was created — they must NOT
# re-price as the fabric master's cost drifts (explicit product decision,
# reversing an earlier read-time re-pricing behaviour). The component_id
# fabric-product link is still stored so drift can be *reported* separately
# without ever changing the saved figures. This regex strips the legacy
# "· current cost/metre" note some sheets picked up while re-pricing was live.
_COSTING_REPRICE_NOTE_RE = re.compile(
    r"(?:\s*·\s*|^\s*)current cost/metre(?: \(was [\d,.\u2014-]+\))?\s*$")


def _strip_reprice_notes(lines):
    """Remove the legacy read-time re-pricing note from line source text.
    Stored costs are left exactly as saved."""
    for l in lines:
        src = l.get("source")
        if src:
            l["source"] = _COSTING_REPRICE_NOTE_RE.sub("", src) or None
    return lines


# Default sign-off block titles — used when a step has never been signed
# (customized titles are stored on the signature row itself at signing time).
_COSTING_SIGNOFF_DEFAULTS = {1: "Prepared by", 2: "Checked by", 3: "Approved by"}


def _costing_signoff_rows(conn, sheet_id):
    """Always THREE ordered blocks: stored signature rows merged over the
    defaults, so unsigned steps render as pending with the default title."""
    rows = q(conn, """
        SELECT step, title, signed_by, signed_by_name, signed_at
        FROM fabric_costing_signoffs WHERE sheet_id=%s
    """, (sheet_id,))
    by = {r["step"]: r for r in rows}
    out = []
    for step in (1, 2, 3):
        r = by.get(step)
        out.append({
            "step": step,
            "title": (r and (r["title"] or "").strip()) or _COSTING_SIGNOFF_DEFAULTS[step],
            "signed": bool(r),
            "signed_by": r["signed_by"] if r else None,
            "signed_by_name": r["signed_by_name"] if r else None,
            "signed_at": (r["signed_at"].isoformat()
                          if r and r["signed_at"] else None),
        })
    return out


def _costing_signoff_status(signoffs):
    """draft / partial / approved. Approved = the FINAL step (3) is signed —
    that is also the edit-lock condition."""
    if signoffs[2]["signed"]:
        return "approved"
    if any(s["signed"] for s in signoffs):
        return "partial"
    return "draft"


def _costing_reject_if_locked(conn, sheet_id):
    """409 when the sheet is approved (step-3 signed). Called by every sheet/
    line mutation endpoint — the server, not the UI, is the enforcement."""
    rows = q(conn, "SELECT 1 FROM fabric_costing_signoffs "
                   "WHERE sheet_id=%s AND step=3", (sheet_id,))
    if rows:
        raise HTTPException(
            status_code=409,
            detail="This sheet is approved and locked — un-approve it to edit")


def _sheet_payload(conn, sheet_id, with_history=True):
    sheets = q(conn, "SELECT * FROM fabric_costing_sheets WHERE id=%s", (sheet_id,))
    if not sheets:
        raise HTTPException(status_code=404, detail="Sheet not found")
    s = dict(sheets[0])
    # Fabric rows always list FIRST (stable within each group) — the editor,
    # the per-sheet XLSX and the PDF all read this payload, so every surface
    # shows the same fabric-first order, including sheets saved before the
    # rule existed. Ordering only — stored amounts are untouched.
    lines = [dict(l) for l in q(conn, """
        SELECT l.id, l.kind, l.label, l.qty, l.unit_cost, l.total, l.is_auto,
               l.source, l.position, l.component_id,
               NULLIF(TRIM(p.barcode), '') AS barcode,
               (p.id IS NOT NULL)  AS _in_master,
               p.kg_per_mtr_eff    AS _kg_eff,
               p.standard_price    AS _std_price,
               ROUND(CASE WHEN p.kg_per_mtr_eff > 0 AND p.standard_price > 0
                          THEN (p.standard_price * p.kg_per_mtr_eff)::numeric
                          ELSE NULL END, 2) AS _current_cpm
        FROM fabric_costing_lines l
        LEFT JOIN raw_fabric_products p ON p.id = l.component_id
        WHERE l.sheet_id=%s ORDER BY (l.kind <> 'fabric'), l.position, l.id
    """, (sheet_id,))]
    for l in lines:
        for k in ("qty", "unit_cost", "total"):
            l[k] = float(l[k]) if l[k] is not None else None
        # Advisory CURRENT master conversion for fabric lines linked to a
        # product — editor-only information (blank-cost self-heal + reason).
        # Saved sheets are a SNAPSHOT: this read never modifies stored costs.
        in_master = bool(l.pop("_in_master"))
        kg_eff, std_price = l.pop("_kg_eff"), l.pop("_std_price")
        cur_cpm = l.pop("_current_cpm")
        if l["kind"] == "fabric" and l["component_id"] is not None:
            l["current_cost_per_metre"] = (float(cur_cpm)
                                           if cur_cpm is not None else None)
            l["cost_missing_reason"] = (
                None if cur_cpm is not None
                else _fabric_cost_missing_reason(in_master, kg_eff, std_price))
    _strip_reprice_notes(lines)
    lines_total = round(sum(l["total"] or 0 for l in lines), 2)
    # Embroidery cost — stored in embroidery_data JSONB; provide defaults when NULL.
    raw_emb = s.get("embroidery_data") or {}
    if not isinstance(raw_emb, dict):
        raw_emb = {}
    emb_enabled = bool(raw_emb.get("enabled", False))
    emb_cpr = float(raw_emb.get("cost_per_run") or 0)
    emb_rc = float(raw_emb.get("run_count") or 0)
    emb_total = round(emb_cpr * emb_rc, 2) if emb_enabled else 0.0
    s["embroidery_data"] = {
        "enabled": emb_enabled,
        "cost_per_run": emb_cpr,
        "run_count": emb_rc,
        "embroidery_total": emb_total,
    }
    total = round(lines_total + emb_total, 2)
    sp = float(s["selling_price"]) if s["selling_price"] is not None else None
    s["selling_price"] = sp
    for k in ("created_at", "updated_at"):
        s[k] = s[k].isoformat() if s.get(k) else None
    s["lines"] = lines
    s["total_cost"] = total
    sp_ex, margin, margin_pct = _costing_margin(sp, total)
    s["selling_price_ex_vat"] = sp_ex
    s["margin"] = margin
    s["margin_pct"] = margin_pct
    stage = s.get("stage") or "main_production"
    s["stage"] = stage
    if stage == "pre_production":
        # A sheet opened before the controlled maintenance route is run still
        # renders the new defaults consistently; the backfill persists them.
        if s.get("defect_allowance_pct") is None:
            s["defect_allowance_pct"] = _PP_DEFECT_ALLOWANCE_DEFAULT_PCT
        if s.get("cost_per_minute") is None:
            s["cost_per_minute"] = _PP_COST_PER_MINUTE_DEFAULT
    for _k in ("accessories_pct", "defect_allowance_pct", "mtrs_per_garment",
               "cost_per_minute", "production_multiplier"):
        s[_k] = float(s[_k]) if s.get(_k) is not None else None
    # Accessories % provenance (auto-picked at creation for pre-production
    # sheets). None = legacy sheet — its saved % is shown as-is.
    _acc_meta = s.get("accessories_pct_meta")
    if isinstance(_acc_meta, str):
        try:
            _acc_meta = json.loads(_acc_meta)
        except Exception:
            _acc_meta = None
    s["accessories_pct_meta"] = _acc_meta if isinstance(_acc_meta, dict) else None
    if stage == "pre_production":
        prop_ex, prop_retail = _preproduction_proposed_prices(total)
        s["proposed_selling_price"] = prop_ex
        s["proposed_retail_price"] = prop_retail
    else:
        s["proposed_selling_price"] = None
        s["proposed_retail_price"] = None
    signoffs = _costing_signoff_rows(conn, sheet_id)
    s["signoffs"] = signoffs
    s["signoff_status"] = _costing_signoff_status(signoffs)
    s["locked"] = s["signoff_status"] == "approved"
    if with_history:
        hist = [dict(h) for h in q(conn, """
            SELECT action, changed_by_name, changed_at, summary
            FROM fabric_costing_history WHERE sheet_id=%s
            ORDER BY changed_at DESC, id DESC LIMIT 50
        """, (sheet_id,))]
        for h in hist:
            h["changed_at"] = h["changed_at"].isoformat() if h.get("changed_at") else None
        s["history"] = hist
    return s


def _costing_history_write(conn, sheet_id, action, uid, uname, summary, snapshot):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO fabric_costing_history
                (sheet_id, action, changed_by, changed_by_name, summary, snapshot)
            VALUES (%s,%s,%s,%s,%s,%s)
        """, (sheet_id, action, uid, uname, summary,
              json.dumps(snapshot, default=str)))


def _costing_change_summary(old, new_lines, old_sp, new_sp):
    """Human-readable what-changed summary for the history trail."""
    bits = []
    old_total = round(sum(float(l["total"] or 0) for l in old), 2)
    new_total = round(sum(l["total"] for l in new_lines), 2)
    if old_total != new_total:
        bits.append(f"total cost {old_total:,.2f} → {new_total:,.2f}")
    if (old_sp or None) != (new_sp or None):
        bits.append(f"selling price {old_sp or 0:,.2f} → {new_sp or 0:,.2f}")
    if len(old) != len(new_lines):
        bits.append(f"lines {len(old)} → {len(new_lines)}")
    else:
        changed = sum(1 for a, b in zip(old, new_lines)
                      if (a["kind"], a["label"], float(a["qty"] or 0), float(a["unit_cost"] or 0))
                      != (b["kind"], b["label"], b["qty"], b["unit_cost"]))
        if changed:
            bits.append(f"{changed} line(s) edited")
    return "; ".join(bits) or "saved (no value changes)"


_COSTING_SHEET_STATUSES = frozenset(("approved", "partial", "draft"))
_COSTING_SHEET_STAGES = frozenset(("pre_production", "main_production"))


def _costing_sheet_filter_values(raw, allowed, label):
    """Parse the comma-separated list filters accepted by the costing list."""
    if raw is None or not str(raw).strip():
        return set()
    values = {value.strip().lower() for value in str(raw).split(",")
              if value.strip()}
    invalid = values - allowed
    if invalid:
        raise HTTPException(
            status_code=400,
            detail="Invalid costing sheet %s: %s" % (
                label, ", ".join(sorted(invalid))))
    return values


@fabric_router.get("/api/fabric/costing/sheets")
def costing_sheets_list(status: str = None, stage: str = None):
    selected_statuses = _costing_sheet_filter_values(
        status, _COSTING_SHEET_STATUSES, "status")
    selected_stages = _costing_sheet_filter_values(
        stage, _COSTING_SHEET_STAGES, "stage")
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        rows = q(conn, """
            SELECT s.id, s.style_name, s.style_number, s.selling_price,
                   s.dps_ref, s.color, s.updated_by_name, s.updated_at,
                   s.embroidery_data, s.stage, s.accessories_pct,
                   s.accessories_pct_meta,
                   -- Stored line totals only: sheets are a snapshot of the
                   -- cost at creation time and never re-price on read.
                   COALESCE(SUM(l.total),0) AS lines_total,
                   COUNT(l.id) AS line_count,
                   MAX(so.n_signed)  AS n_signed,
                   BOOL_OR(so.approved) AS approved
            FROM fabric_costing_sheets s
            LEFT JOIN fabric_costing_lines l ON l.sheet_id = s.id
            LEFT JOIN (
                SELECT sheet_id, COUNT(*) AS n_signed,
                       BOOL_OR(step = 3) AS approved
                FROM fabric_costing_signoffs GROUP BY sheet_id
            ) so ON so.sheet_id = s.id
            GROUP BY s.id
            ORDER BY s.updated_at DESC
        """)
    out = []
    for r in rows:
        sp = float(r["selling_price"]) if r["selling_price"] is not None else None
        tc = round(float(r["lines_total"] or 0), 2)
        # Add embroidery cost when enabled — must match _sheet_payload logic.
        raw_emb = r.get("embroidery_data") or {}
        if isinstance(raw_emb, dict) and raw_emb.get("enabled"):
            emb_cpr = float(raw_emb.get("cost_per_run") or 0)
            emb_rc  = float(raw_emb.get("run_count") or 0)
            tc = round(tc + emb_cpr * emb_rc, 2)
        sp_ex, margin, margin_pct = _costing_margin(sp, tc)
        acc_meta = r.get("accessories_pct_meta")
        if isinstance(acc_meta, str):
            try:
                acc_meta = json.loads(acc_meta)
            except Exception:
                acc_meta = None
        sheet = {
            "id": r["id"], "style_name": r["style_name"],
            "style_number": r["style_number"], "selling_price": sp,
            "selling_price_ex_vat": sp_ex,
            "dps_ref": r["dps_ref"], "color": r["color"],
            "total_cost": tc,
            "margin": margin,
            "margin_pct": margin_pct,
            "line_count": r["line_count"],
            "signed_steps": int(r["n_signed"] or 0),
            "signoff_status": ("approved" if r["approved"]
                               else "partial" if (r["n_signed"] or 0) else "draft"),
            "stage": r.get("stage") or "main_production",
            "accessories_pct": (float(r["accessories_pct"])
                                if r.get("accessories_pct") is not None
                                else None),
            "accessories_pct_meta": (acc_meta
                                     if isinstance(acc_meta, dict) else None),
            "updated_by_name": r["updated_by_name"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        # Filter only after deriving the existing response values. This keeps
        # the status calculation and costing totals identical for filtered and
        # unfiltered list requests.
        if selected_statuses and sheet["signoff_status"] not in selected_statuses:
            continue
        if selected_stages and sheet["stage"] not in selected_stages:
            continue
        out.append(sheet)
    return {"sheets": out}


@fabric_router.get("/api/fabric/costing/sheets/{sheet_id}")
def costing_sheet_get(sheet_id: int):
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        return _sheet_payload(conn, sheet_id)


# ── Costing exports (.xlsx) ─────────────────────────────────────────────
# Both live under /api/fabric/costing/... so api_pg's email-allowlist
# middleware gate covers them exactly like every other costing path.
# Numbers are produced by the SAME code paths the screen uses
# (costing_sheets_list rows / _sheet_payload), so the export always matches
# the on-screen figures.

_COSTING_XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
                      ".spreadsheetml.sheet")


def _costing_wb_styles():
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill
    return openpyxl, {
        "HEAD": Font(bold=True, color="FFFFFF"),
        "HEAD_FILL": PatternFill("solid", fgColor="1A5C38"),
        "TITLE": Font(bold=True, size=13),
        "LBL": Font(bold=True),
        "R": Alignment(horizontal="right"),
    }


def _costing_fname_safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", (s or "").strip()).strip("-") or "sheet"


@fabric_router.get("/api/fabric/costing/export.xlsx")
def costing_export_all_xlsx():
    """All-sheets summary workbook: one row per costing sheet, mirroring the
    on-screen list (same query/rounding as costing_sheets_list)."""
    import io
    openpyxl, st = _costing_wb_styles()
    sheets = costing_sheets_list()["sheets"]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Costing sheets"
    ws["A1"] = "Product Costing — all sheets summary"
    ws["A1"].font = st["TITLE"]
    ws["A2"] = ("Generated " +
                datetime.datetime.now(ZoneInfo("Africa/Nairobi"))
                .strftime("%d %b %Y %H:%M") + " EAT · all amounts in KES")
    cols = ["Style", "Style number", "Total cost / garment",
            "Retail price (VAT-incl)", "Selling price (ex-VAT)",
            "Margin", "Margin %", "Cost lines", "Last edited by", "Last edited at"]
    ws.append([])
    ws.append(cols)
    hdr_row = 4
    for c in range(1, len(cols) + 1):
        cell = ws.cell(row=hdr_row, column=c)
        cell.font = st["HEAD"]
        cell.fill = st["HEAD_FILL"]
    for s in sheets:
        ua = s["updated_at"]
        if ua:
            try:
                ua = (datetime.datetime.fromisoformat(ua)
                      .astimezone(ZoneInfo("Africa/Nairobi"))
                      .strftime("%d %b %Y %H:%M"))
            except Exception:
                pass
        ws.append([
            s["style_name"], s["style_number"],
            s["total_cost"], s["selling_price"], s["selling_price_ex_vat"],
            s["margin"], s["margin_pct"],
            s["line_count"], s["updated_by_name"], ua,
        ])
    for col, w in zip("ABCDEFGHIJ", [34, 14, 20, 18, 18, 12, 10, 10, 24, 20]):
        ws.column_dimensions[col].width = w
    for row in ws.iter_rows(min_row=hdr_row + 1, min_col=3, max_col=8):
        for cell in row:
            cell.alignment = st["R"]
            if cell.column <= 6 and cell.value is not None:
                cell.number_format = "#,##0.00"

    buf = io.BytesIO()
    wb.save(buf)
    fname = ("costing-sheets-summary-" +
             datetime.date.today().isoformat() + ".xlsx")
    return Response(
        content=buf.getvalue(), media_type=_COSTING_XLSX_MIME,
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname})


@fabric_router.get("/api/fabric/costing/sheets/{sheet_id}/export.xlsx")
def costing_export_sheet_xlsx(sheet_id: int):
    """Detailed workbook for ONE costing sheet: a header/summary block plus one
    row per cost line with its Auto/Manual flag and source. Uses the same
    _sheet_payload the editor loads, so numbers match the screen exactly."""
    import io
    openpyxl, st = _costing_wb_styles()
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        s = _sheet_payload(conn, sheet_id, with_history=False)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Cost sheet"
    ws["A1"] = "Costing sheet — " + (s["style_name"] or "")
    ws["A1"].font = st["TITLE"]

    def _eat(ts):
        if not ts:
            return None
        try:
            return (datetime.datetime.fromisoformat(ts)
                    .astimezone(ZoneInfo("Africa/Nairobi"))
                    .strftime("%d %b %Y %H:%M"))
        except Exception:
            return ts

    srows = [
        ("Style", s["style_name"]),
        ("Style number", s["style_number"]),
        ("Total cost / garment (KES)", s["total_cost"]),
        ("Retail price (VAT-incl, KES)", s["selling_price"]),
        ("Selling price (ex-VAT, KES)", s["selling_price_ex_vat"]),
        ("Retail price basis",
         "Auto (modal SKU price)" if s.get("selling_price_is_auto") else "Manual"),
        ("Margin (KES)", s["margin"]),
        ("Margin %", s["margin_pct"]),
        ("Notes", s.get("notes")),
        ("Last edited by", s.get("updated_by_name")),
        ("Last edited at", _eat(s.get("updated_at")) or None),
        ("Created by", s.get("created_by_name")),
        ("Created at", _eat(s.get("created_at")) or None),
    ]
    r0 = 3
    for i, (label, val) in enumerate(srows):
        ws.cell(row=r0 + i, column=1, value=label).font = st["LBL"]
        c = ws.cell(row=r0 + i, column=2, value=val)
        if label.startswith(("Total cost", "Retail price (", "Selling price (",
                             "Margin vs")):
            c.number_format = "#,##0.00"
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 44

    # Cost-lines detail sheet — one row per line, Auto/Manual flag + source.
    ws2 = wb.create_sheet("Cost lines")
    cols = ["#", "Kind", "Label", "Barcode", "Qty", "Unit cost (KES)",
            "Line total (KES)", "Auto/Manual", "Source"]
    ws2.append(cols)
    for c in range(1, len(cols) + 1):
        cell = ws2.cell(row=1, column=c)
        cell.font = st["HEAD"]
        cell.fill = st["HEAD_FILL"]
    kind_lbl = {"fabric": "Fabric", "trim": "Trim",
                "cmt": "CMT / Labour", "overhead": "Overhead"}
    for i, l in enumerate(s["lines"], 1):
        ws2.append([
            i, kind_lbl.get(l["kind"], l["kind"]), l["label"],
            l.get("barcode"),
            l["qty"], l["unit_cost"], l["total"],
            "Auto" if l["is_auto"] else "Manual",
            l["source"],
        ])
    # Embroidery row — appended after all cost lines when embroidery is enabled.
    emb = s.get("embroidery_data") or {}
    if emb.get("enabled"):
        emb_i = len(s["lines"]) + 1
        ws2.append([
            emb_i, "Embroidery", "Embroidery",
            None,
            emb.get("run_count"), emb.get("cost_per_run"), emb.get("embroidery_total"),
            "Manual",
            "",
        ])
    ws2.append([])
    tr = ws2.max_row + 1
    ws2.cell(row=tr, column=3, value="Total cost / garment").font = st["LBL"]
    tc = ws2.cell(row=tr, column=7, value=s["total_cost"])
    tc.font = st["LBL"]
    tc.number_format = "#,##0.00"
    for col, w in zip("ABCDEFGHI", [5, 14, 40, 14, 10, 16, 16, 13, 34]):
        ws2.column_dimensions[col].width = w
    for row in ws2.iter_rows(min_row=2, max_row=ws2.max_row, min_col=5, max_col=7):
        for cell in row:
            cell.alignment = st["R"]
            if cell.value is not None and cell.column >= 6:
                cell.number_format = "#,##0.00"

    buf = io.BytesIO()
    wb.save(buf)
    fname = "costing-%s.xlsx" % _costing_fname_safe(s["style_name"])
    return Response(
        content=buf.getvalue(), media_type=_COSTING_XLSX_MIME,
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname})


def _parse_embroidery_data(raw):
    """Validate and normalise the embroidery_data field from a POST/PUT body.
    Returns a JSON string ready to be stored in the JSONB column, or None when
    embroidery is disabled/absent.  Raises HTTP 400 on bad input."""
    if not raw or not isinstance(raw, dict):
        return None
    enabled = bool(raw.get("enabled", False))
    try:
        cpr = float(raw.get("cost_per_run") or 0)
        rc  = float(raw.get("run_count") or 0)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="embroidery_data: cost_per_run and run_count must be numbers")
    if cpr < 0 or rc < 0:
        raise HTTPException(
            status_code=400,
            detail="embroidery_data: cost_per_run and run_count must be non-negative")
    return json.dumps({"enabled": enabled, "cost_per_run": cpr, "run_count": rc})


@fabric_router.get("/api/fabric/costing/preprod-accessories-pct")
def costing_preprod_accessories_pct():
    """Preview of the Accessories % a NEW pre-production sheet would be
    created with right now: the previous calendar month's pooled Done-DPS
    trims:fabric average (walk-back fallback / labelled 13% default when
    there is no qualifying history). The create endpoint re-computes and
    PERSISTS this itself — the preview only lets the editor show the value
    before saving."""
    with _get_conn() as conn:
        pick = _preprod_accessories_pick(conn)
    return {
        "accessories_pct": pick["pct"],
        "accessories_pct_display": math.floor(pick["pct"] * 100 + 0.5) / 100.0,
        "meta": pick["meta"],
    }


@fabric_router.post("/api/fabric/costing/maintenance/backfill-preprod-accessories")
def costing_backfill_preprod_accessories(request: Request):
    """Admin-only, idempotent retrofit for pre-auto-pick pre-production sheets."""
    user = getattr(request.state, "user", None) or {}
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=403,
            detail="Admin access is required for the Accessories % retrofit")
    uid, uname = _costing_user(request)
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        result = _preprod_accessories_backfill(conn, uid, uname)
        conn.commit()
    return result


@fabric_router.post("/api/fabric/costing/maintenance/backfill-preprod-defaults")
def costing_backfill_preprod_defaults(request: Request):
    """Admin-only controlled migration of Pre-production default inputs."""
    user = getattr(request.state, "user", None) or {}
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=403,
            detail="Admin access is required for the Pre-production defaults retrofit")
    uid, uname = _costing_user(request)
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        result = _preprod_defaults_backfill(conn, uid, uname)
        conn.commit()
    return result


@fabric_router.post("/api/fabric/costing/sheets")
def costing_sheet_create(request: Request, body: dict = Body(...)):
    _costing_require_editor(request)
    style_row = _match_style(body.get("style_name"))
    if not style_row:
        raise HTTPException(status_code=400,
                            detail="Pick a style from the list — free-typed styles are not allowed")
    sp = body.get("selling_price")
    try:
        sp = float(sp) if sp not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="selling_price must be a number")
    if sp is not None and sp < 0:
        raise HTTPException(status_code=400, detail="selling_price must be ≥ 0")
    uid, uname = _costing_user(request)
    canon = style_row.get("style_name")
    stage = (str(body.get("stage") or "main_production").strip())[:50]
    if stage not in ("main_production", "pre_production"):
        stage = "main_production"
    dps_ref = (str(body.get("dps_ref") or "").strip())[:100] or None
    if stage == "main_production" and not dps_ref:
        raise HTTPException(status_code=400,
                            detail="Pick a DPS # for the style — costing sheets are built from one Done DPS")
    color = (str(body.get("color") or "").strip())[:100] or None
    # Pre-production extra fields. accessories_pct is NOT read from the
    # client: pre-production sheets get the server-picked previous-month
    # Done-DPS average below (read-only by design), and main-production
    # sheets don't use it (stored at the legacy 13 default).
    accessories_pct = _PP_ACC_DEFAULT_PCT
    try:
        defect_allowance_pct = (
            float(body["defect_allowance_pct"])
            if body.get("defect_allowance_pct") not in (None, "")
            else (_PP_DEFECT_ALLOWANCE_DEFAULT_PCT
                  if stage == "pre_production" else 10.0))
        mtrs_per_garment = float(body["mtrs_per_garment"]) if body.get("mtrs_per_garment") not in (None, "") else None
        cost_per_minute = (
            float(body["cost_per_minute"])
            if body.get("cost_per_minute") not in (None, "")
            else (_PP_COST_PER_MINUTE_DEFAULT
                  if stage == "pre_production" else None))
        production_multiplier = float(body["production_multiplier"]) if body.get("production_multiplier") not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pre-production numeric fields must be numbers")
    # Non-positive multiplier is meaningless — store NULL so reads fall back to 1.40.
    if production_multiplier is not None and production_multiplier <= 0:
        production_multiplier = None
    cmt_start_time = (str(body.get("cmt_start_time") or "").strip())[:10] or None
    cmt_stop_time  = (str(body.get("cmt_stop_time")  or "").strip())[:10] or None
    emb_data_json = _parse_embroidery_data(body.get("embroidery_data"))
    lines = _clean_costing_lines(body.get("lines"))
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        if stage == "main_production" and dps_ref:
            _require_style_dps(conn, canon, dps_ref, color=color)
        dup = q(conn, "SELECT id FROM fabric_costing_sheets WHERE lower(style_name)=lower(%s)",
                (canon,))
        if dup:
            raise HTTPException(status_code=409,
                                detail=f"A costing sheet for this style already exists (#{dup[0]['id']}) — edit it instead")
        acc_meta_json = None
        if stage == "pre_production":
            # Accessories % — picked ONCE here, from the previous calendar
            # month's Done-DPS average, and persisted with provenance.
            # Client-supplied percentages are never accepted; the derived
            # Accessories line is re-stamped from the picked % too.
            _acc_pick = _preprod_accessories_pick(conn)
            accessories_pct = _acc_pick["pct"]
            acc_meta_json = json.dumps(_acc_pick["meta"])
            _preprod_apply_accessories(lines, accessories_pct, _acc_pick["meta"])
            # Selling price: 70%-margin proposal from the (re-stamped) lines.
            _lines_total = sum(ln["total"] for ln in lines)
            try:
                _raw_emb = json.loads(emb_data_json) if emb_data_json else {}
                if isinstance(_raw_emb, dict) and _raw_emb.get("enabled"):
                    _lines_total += float(_raw_emb.get("cost_per_run", 0)) * float(_raw_emb.get("run_count", 0))
            except Exception:
                pass
            _, sp = _preproduction_proposed_prices(_lines_total)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_costing_sheets
                    (style_name, style_number, selling_price, selling_price_is_auto,
                     notes, dps_ref, color, embroidery_data, stage,
                     accessories_pct, accessories_pct_meta,
                     defect_allowance_pct, mtrs_per_garment,
                     cost_per_minute, cmt_start_time, cmt_stop_time,
                     production_multiplier,
                     created_by, created_by_name,
                     updated_by, updated_by_name)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (canon, style_row.get("style_number"), sp,
                  bool(body.get("selling_price_is_auto")) and stage == "main_production",
                  (str(body.get("notes") or "").strip())[:1000] or None,
                  dps_ref, color, emb_data_json, stage,
                  accessories_pct, acc_meta_json,
                  defect_allowance_pct, mtrs_per_garment,
                  cost_per_minute, cmt_start_time, cmt_stop_time,
                  production_multiplier,
                  uid, uname, uid, uname))
            sheet_id = cur.fetchone()[0]
            for ln in lines:
                cur.execute("""
                    INSERT INTO fabric_costing_lines
                        (sheet_id, kind, label, qty, unit_cost, total, is_auto,
                         source, position, component_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, (sheet_id, ln["kind"], ln["label"], ln["qty"], ln["unit_cost"],
                      ln["total"], ln["is_auto"], ln["source"], ln["position"],
                      ln["component_id"]))
        _costing_history_write(conn, sheet_id, "created", uid, uname,
                               f"sheet created with {len(lines)} line(s)",
                               {"lines": lines, "selling_price": sp,
                                "selling_price_ex_vat": _costing_ex_vat(sp)})
        conn.commit()
        return _sheet_payload(conn, sheet_id)


@fabric_router.put("/api/fabric/costing/sheets/{sheet_id}")
def costing_sheet_update(sheet_id: int, request: Request, body: dict = Body(...)):
    _costing_require_editor(request)
    lines = _clean_costing_lines(body.get("lines"))
    sp = body.get("selling_price")
    try:
        sp = float(sp) if sp not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="selling_price must be a number")
    if sp is not None and sp < 0:
        raise HTTPException(status_code=400, detail="selling_price must be ≥ 0")
    uid, uname = _costing_user(request)
    stage = (str(body.get("stage") or "main_production").strip())[:50]
    if stage not in ("main_production", "pre_production"):
        stage = "main_production"
    # Pre-production extra fields. accessories_pct is NOT read from the
    # client — it is read-only: the value picked at sheet creation (or the
    # hand-typed value saved on legacy sheets) always wins, below.
    try:
        defect_allowance_pct = (
            float(body["defect_allowance_pct"])
            if body.get("defect_allowance_pct") not in (None, "")
            else (_PP_DEFECT_ALLOWANCE_DEFAULT_PCT
                  if stage == "pre_production" else 10.0))
        mtrs_per_garment = float(body["mtrs_per_garment"]) if body.get("mtrs_per_garment") not in (None, "") else None
        cost_per_minute = (
            float(body["cost_per_minute"])
            if body.get("cost_per_minute") not in (None, "")
            else (_PP_COST_PER_MINUTE_DEFAULT
                  if stage == "pre_production" else None))
        production_multiplier = float(body["production_multiplier"]) if body.get("production_multiplier") not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pre-production numeric fields must be numbers")
    # Non-positive multiplier is meaningless — store NULL so reads fall back to 1.40.
    if production_multiplier is not None and production_multiplier <= 0:
        production_multiplier = None
    cmt_start_time = (str(body.get("cmt_start_time") or "").strip())[:10] or None
    cmt_stop_time  = (str(body.get("cmt_stop_time")  or "").strip())[:10] or None
    emb_data_json = _parse_embroidery_data(body.get("embroidery_data"))
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        # Serialize an editor save against the one-time legacy Accessories
        # retrofit. Without the parent-row lock, a stale editor opened before
        # the retrofit could write its old derived line after the migration
        # committed, leaving new provenance paired with old maths.
        sheets = q(conn, """
            SELECT * FROM fabric_costing_sheets WHERE id=%s FOR UPDATE
        """, (sheet_id,))
        if not sheets:
            raise HTTPException(status_code=404, detail="Sheet not found")
        # Approved sheets are read-only — the server, not the UI, enforces it.
        _costing_reject_if_locked(conn, sheet_id)
        _acc_meta = None
        if stage == "pre_production":
            # Accessories % is READ-ONLY: keep the sheet's stored value
            # (picked at creation, or hand-typed on legacy sheets — never
            # re-picked) and re-stamp the derived Accessories line from it,
            # so a stale or tampered editor can't bake a different % into
            # the saved maths. Then the 70%-margin proposed selling price.
            _acc_pct = (float(sheets[0]["accessories_pct"])
                        if sheets[0].get("accessories_pct") is not None
                        else _PP_ACC_DEFAULT_PCT)
            _acc_meta = sheets[0].get("accessories_pct_meta")
            if isinstance(_acc_meta, str):
                try:
                    _acc_meta = json.loads(_acc_meta)
                except Exception:
                    _acc_meta = None
            if not isinstance(_acc_meta, dict):
                _acc_meta = None
            _preprod_stamp_accessories(
                lines, _acc_pct, _acc_meta,
                recalculate=not (
                    isinstance(_acc_meta, dict)
                    and _acc_meta.get("retrofit_status")
                    == "retained_no_history"))
            _lines_total = sum(ln["total"] for ln in lines)
            try:
                _raw_emb = json.loads(emb_data_json) if emb_data_json else {}
                if isinstance(_raw_emb, dict) and _raw_emb.get("enabled"):
                    _lines_total += float(_raw_emb.get("cost_per_run", 0)) * float(_raw_emb.get("run_count", 0))
            except Exception:
                pass
            _, sp = _preproduction_proposed_prices(_lines_total)
        old_sp = float(sheets[0]["selling_price"]) if sheets[0]["selling_price"] is not None else None
        old_lines = q(conn, """
            SELECT kind, label, qty, unit_cost, total, is_auto, source
            FROM fabric_costing_lines WHERE sheet_id=%s
            ORDER BY (kind <> 'fabric'), position, id
        """, (sheet_id,))
        if (isinstance(_acc_meta, dict)
                and _acc_meta.get("retrofit_status")
                == "retained_no_history"):
            _preprod_restore_retained_amount(lines, old_lines)
        summary = _costing_change_summary(old_lines, lines, old_sp, sp)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fabric_costing_sheets
                SET selling_price=%s, selling_price_is_auto=%s, notes=%s,
                    dps_ref=%s, color=%s, embroidery_data=%s, stage=%s,
                    defect_allowance_pct=%s, mtrs_per_garment=%s,
                    cost_per_minute=%s, cmt_start_time=%s, cmt_stop_time=%s,
                    production_multiplier=%s,
                    updated_by=%s, updated_by_name=%s, updated_at=now()
                WHERE id=%s
            """, (sp, bool(body.get("selling_price_is_auto")) and stage == "main_production",
                  (str(body.get("notes") or "").strip())[:1000] or None,
                  (str(body.get("dps_ref") or "").strip())[:100] or None,
                  (str(body.get("color") or "").strip())[:100] or None,
                  emb_data_json, stage,
                  defect_allowance_pct, mtrs_per_garment,
                  cost_per_minute, cmt_start_time, cmt_stop_time,
                  production_multiplier,
                  uid, uname, sheet_id))
            cur.execute("DELETE FROM fabric_costing_lines WHERE sheet_id=%s", (sheet_id,))
            for ln in lines:
                cur.execute("""
                    INSERT INTO fabric_costing_lines
                        (sheet_id, kind, label, qty, unit_cost, total, is_auto,
                         source, position, component_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, (sheet_id, ln["kind"], ln["label"], ln["qty"], ln["unit_cost"],
                      ln["total"], ln["is_auto"], ln["source"], ln["position"],
                      ln["component_id"]))
        _costing_history_write(conn, sheet_id, "updated", uid, uname, summary,
                               {"lines": lines, "selling_price": sp,
                                "selling_price_ex_vat": _costing_ex_vat(sp)})
        conn.commit()
        return _sheet_payload(conn, sheet_id)


# ── Costing sign-off (Prepared / Checked / Approved) ────────────────────
# Three ORDERED digital sign-off steps per sheet. Titles are customizable at
# signing time (defaults in _COSTING_SIGNOFF_DEFAULTS). Signing step 3
# approves the sheet and locks it against edits (enforced in the mutation
# endpoints via _costing_reject_if_locked); un-signing step 3 reopens it and
# is recorded in the change history like every other action.

@fabric_router.post("/api/fabric/costing/sheets/{sheet_id}/signoff")
def costing_sheet_sign(sheet_id: int, request: Request, body: dict = Body(...)):
    try:
        step = int(body.get("step"))
    except (TypeError, ValueError):
        step = 0
    if step not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="step must be 1, 2 or 3")
    title = (str(body.get("title") or "").strip())[:100] \
        or _COSTING_SIGNOFF_DEFAULTS[step]
    uid, uname = _costing_user(request)
    email = _costing_user_email(request)
    # Per-step rights: only the emails authorized for THIS step may sign it.
    if email not in _COSTING_STEP_EMAILS[step]:
        raise HTTPException(
            status_code=403,
            detail=(f"You are not authorized to sign "
                    f"“{_COSTING_SIGNOFF_DEFAULTS[step]}” — only "
                    f"{_costing_signer_list(step)} may sign this step"))
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        sheets = q(conn, "SELECT style_name, color FROM fabric_costing_sheets "
                         "WHERE id=%s", (sheet_id,))
        if not sheets:
            raise HTTPException(status_code=404, detail="Sheet not found")
        signoffs = _costing_signoff_rows(conn, sheet_id)
        if signoffs[step - 1]["signed"]:
            raise HTTPException(status_code=409, detail="This step is already signed")
        for prev in signoffs[:step - 1]:
            if not prev["signed"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Sign the steps in order — “{prev['title']}” is still pending")
        # Separation of duties: you cannot check a sheet you prepared, or
        # approve a sheet you checked. Compared against the CURRENT signature
        # of the immediately preceding step (an unsigned-then-resigned step is
        # judged on whoever holds the signature now), by email — the canonical
        # identity — with a user_id fallback when the email can't be resolved.
        if step in (2, 3):
            prev_row = signoffs[step - 2]
            prev_uid = prev_row.get("signed_by")
            prev_email = _costing_signer_email(conn, prev_uid)
            same = (prev_email == email) if prev_email else (prev_uid and prev_uid == uid)
            if same:
                raise HTTPException(
                    status_code=403,
                    detail=(f"Separation of duties — you signed "
                            f"“{prev_row['title']}” on this sheet, so a "
                            f"different person must sign "
                            f"“{_COSTING_SIGNOFF_DEFAULTS[step]}”"))
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_costing_signoffs
                    (sheet_id, step, title, signed_by, signed_by_name)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (sheet_id, step) DO NOTHING
                RETURNING id
            """, (sheet_id, step, title, uid, uname))
            row = cur.fetchone()
            if row is None:  # lost a concurrent-sign race
                raise HTTPException(status_code=409,
                                    detail="This step is already signed")
            signoff_id = row[0]
        summary = f"“{title}” signed (step {step} of 3)"
        if step == 3:
            summary += " — sheet approved and locked against edits"
        _costing_history_write(conn, sheet_id, "signed", uid, uname, summary,
                               {"step": step, "title": title})
        # Bell-notify the other costing users: a signed step means the sheet
        # now awaits the NEXT signature (or has just been approved). The
        # signoff row id makes each sign event's dedupe key unique even if the
        # same step is later un-signed and re-signed.
        sheet_label = sheets[0]["style_name"] or f"sheet #{sheet_id}"
        if sheets[0].get("color"):
            sheet_label += f" ({sheets[0]['color']})"
        if step == 3:
            n_title = "Costing sheet approved"
            n_msg = (f"{uname} signed “{title}” on the costing sheet for "
                     f"{sheet_label} — the sheet is now approved and locked.")
        else:
            next_title = signoffs[step]["title"]
            n_title = "Costing sheet awaits your signature"
            n_msg = (f"{uname} signed “{title}” on the costing sheet for "
                     f"{sheet_label} — it now awaits “{next_title}” "
                     f"(step {step + 1} of 3).")
        _notify_costing_users(conn, uid, "costing_signoff", n_title, n_msg,
                              f"costing_sign:{sheet_id}:{step}:{signoff_id}")
        conn.commit()
        return _sheet_payload(conn, sheet_id)


@fabric_router.delete("/api/fabric/costing/sheets/{sheet_id}/signoff/{step}")
def costing_sheet_unsign(sheet_id: int, step: int, request: Request):
    """Remove a signature. Clearing a step also clears every LATER step so the
    ordered-signing invariant holds; clearing step 3 un-approves the sheet and
    reopens it for editing (subsequent edits keep being change-logged)."""
    if step not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="step must be 1, 2 or 3")
    uid, uname = _costing_user(request)
    email = _costing_user_email(request)
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        sheets = q(conn, "SELECT style_name, color FROM fabric_costing_sheets "
                         "WHERE id=%s", (sheet_id,))
        if not sheets:
            raise HTTPException(status_code=404, detail="Sheet not found")
        signoffs = _costing_signoff_rows(conn, sheet_id)
        if not signoffs[step - 1]["signed"]:
            raise HTTPException(status_code=400, detail="This step is not signed")
        # Un-sign rights: only the ORIGINAL signer of this step, or someone
        # authorized to sign this step, may remove its signature. Identity is
        # compared by email (canonical — user_ids differ between local: and
        # google: sign-ins), with a user_id fallback when the signer's email
        # can't be resolved. Mirrors the per-step gate in the sign endpoint.
        if email not in _COSTING_STEP_EMAILS[step]:
            signer_uid = signoffs[step - 1].get("signed_by")
            signer_email = _costing_signer_email(conn, signer_uid)
            is_signer = ((signer_email == email) if signer_email
                         else (signer_uid and signer_uid == uid))
            if not is_signer:
                raise HTTPException(
                    status_code=403,
                    detail=(f"You are not authorized to remove the "
                            f"“{signoffs[step - 1]['title']}” signature — only "
                            f"the person who signed it or "
                            f"{_costing_signer_list(step)} may remove it"))
        was_approved = signoffs[2]["signed"]
        title = signoffs[step - 1]["title"]
        # The deleted signoff row ids make this un-sign event's dedupe key
        # unique across repeated sign/unsign cycles of the same step.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fabric_costing_signoffs "
                        "WHERE sheet_id=%s AND step >= %s RETURNING id",
                        (sheet_id, step))
            removed_ids = sorted(r[0] for r in cur.fetchall())
        summary = f"“{title}” signature removed (step {step})"
        if step < 3 and was_approved:
            summary += " together with the later step(s)"
        if was_approved:
            summary += " — sheet un-approved and reopened for editing"
        _costing_history_write(conn, sheet_id,
                               "unapproved" if was_approved else "unsigned",
                               uid, uname, summary, {"step": step})
        # Bell-notify the other costing users of the reversal.
        sheet_label = sheets[0]["style_name"] or f"sheet #{sheet_id}"
        if sheets[0].get("color"):
            sheet_label += f" ({sheets[0]['color']})"
        if was_approved:
            n_title = "Costing sheet un-approved"
            n_msg = (f"{uname} removed the “{title}” signature (step {step}) on "
                     f"the costing sheet for {sheet_label} — the sheet is "
                     "un-approved and reopened for editing.")
        else:
            n_title = "Costing sheet signature removed"
            n_msg = (f"{uname} removed the “{title}” signature (step {step}) on "
                     f"the costing sheet for {sheet_label}.")
        ids_key = "-".join(str(i) for i in removed_ids) or "none"
        _notify_costing_users(conn, uid, "costing_signoff", n_title, n_msg,
                              f"costing_unsign:{sheet_id}:{step}:{ids_key}")
        conn.commit()
        return _sheet_payload(conn, sheet_id)

def _costing_build_pdf_branded(s):
    """Render the costing sheet PDF using the branded renderer in
    artifacts/costing-pdf/costing.py.  Returns raw PDF bytes.
    Raises RuntimeError if content overflows a single page (caller may fall back
    to the inline multi-page renderer).
    Raises ImportError/ModuleNotFoundError if reportlab is unavailable."""
    import sys
    import tempfile

    if _COSTING_PDF_DIR not in sys.path:
        sys.path.insert(0, _COSTING_PDF_DIR)
    from costing import build_sheet  # from artifacts/costing-pdf/costing.py

    kind_order = ["fabric", "trim", "cmt", "overhead"]
    kind_labels = {
        "fabric":   "Fabric",
        "trim":     "Trims & accessories",
        "cmt":      "CMT / Labour",
        "overhead": "Overheads",
    }

    # Group lines by kind in canonical order
    groups_dict: dict = {}
    for kind in kind_order:
        for l in s.get("lines") or []:
            if l.get("kind") == kind:
                lbl = kind_labels[kind]
                if lbl not in groups_dict:
                    groups_dict[lbl] = []
                groups_dict[lbl].append({
                    "desc":      l.get("label") or "—",
                    "barcode":   l.get("barcode") or None,
                    "qty":       float(l["qty"]) if l.get("qty") is not None else 1,
                    "unit":      "unit",
                    "unit_cost": float(l["unit_cost"]) if l.get("unit_cost") is not None else 0,
                })
    groups = [{"label": lbl, "lines": lines} for lbl, lines in groups_dict.items()]
    if not groups:
        groups = [{"label": "Cost lines", "lines": [
            {"desc": "—", "barcode": None, "qty": 1, "unit": "unit", "unit_cost": 0}
        ]}]

    # Order qty — look up produced units from mo_fabric_consumption via dps_ref
    order_qty = 0
    dps_ref = (s.get("dps_ref") or "").strip()
    if dps_ref:
        try:
            with _get_conn() as _conn:
                _rows = q(_conn,
                          "SELECT COALESCE(SUM(produced_qty),0) AS qty "
                          "FROM mo_fabric_consumption WHERE dps_ref=%s",
                          (dps_ref,))
            if _rows and _rows[0]["qty"]:
                order_qty = round(float(_rows[0]["qty"]))
        except Exception:
            pass

    def _fmt_ts(ts):
        """ISO timestamp → 'DD Mon YYYY, HH:MM EAT'"""
        if not ts:
            return None
        try:
            dt = datetime.datetime.fromisoformat(ts).astimezone(ZoneInfo("Africa/Nairobi"))
            return dt.strftime("%d %b %Y, %H:%M EAT")
        except Exception:
            return str(ts)

    # Signoffs: three blocks (role, name=None for unsigned, signed_at)
    signoffs = []
    for so in (s.get("signoffs") or []):
        signoffs.append({
            "role":      so.get("title") or "—",
            "name":      so.get("signed_by_name") if so.get("signed") else None,
            "signed_at": _fmt_ts(so.get("signed_at")) if so.get("signed") else None,
        })

    # Revisions from history — oldest first (history list is newest-first)
    revisions = []
    for h in reversed((s.get("history") or [])[:10]):
        when    = _fmt_ts(h.get("changed_at")) or "—"
        who     = h.get("changed_by_name") or "—"
        action  = h.get("action") or ""
        summary = (h.get("summary") or "").strip()
        entry   = f"{when} — {who}"
        if action:
            entry += f" — {action}"
        if summary:
            entry += f": {summary}"
        revisions.append(entry)
    if not revisions and s.get("created_by_name"):
        when = _fmt_ts(s.get("created_at")) or "—"
        revisions.append(f"{when} — {s['created_by_name']} — sheet created")

    gen = (datetime.datetime.now(ZoneInfo("Africa/Nairobi"))
           .strftime("%d %b %Y, %H:%M EAT"))

    data = {
        "style_name":      s.get("style_name") or "—",
        "style_no":        s.get("style_number") or "—",
        "colour":          s.get("color") or "All colours",
        "dps":             dps_ref or "—",
        "order_qty":       order_qty,
        "currency":        "KES",
        "retail_incl_vat": float(s.get("selling_price") or 0),
        "vat_rate":        0.16,
        "groups":          groups,
        "basis_note":      (s.get("notes") or "").strip(),
        "signoffs":        signoffs,
        "revisions":       revisions,
        "generated_at":    gen,
    }

    import tempfile
    fd, tmp_path = tempfile.mkstemp(suffix=".pdf", prefix="costing_branded_")
    try:
        os.close(fd)  # build_sheet opens the file itself; close the descriptor first
        build_sheet(data, tmp_path)
        with open(tmp_path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Costing sheet PDF export ────────────────────────────────────────────
# Branded A4 costing sheet: Vivo header, style/colour/DPS identity, the full
# cost build-up grouped by kind with per-group subtotals, totals + selling
# price + margin, notes, revision info from the change history, and the three
# sign-off blocks (signed vs pending). Same _sheet_payload the screen uses,
# so figures always match. Lives under /api/fabric/costing/ so the email
# allowlist middleware gate covers it like every other costing path.

def _costing_mult_fmt(pm):
    """Format a sheet's Production Multiplier for display text.

    NULL/invalid/non-positive → the legacy hardcoded 1.40. Two decimals
    minimum ("1.40", "1.55", "0.90"); extra precision kept as typed
    ("1.375") — mirrors costPPMultFmt in the editor JS."""
    try:
        pm = float(pm) if pm is not None else 1.40
    except (TypeError, ValueError):
        pm = 1.40
    if pm <= 0:
        pm = 1.40
    return f"{pm:.2f}" if round(pm, 2) == pm else f"{pm:g}"


def _costing_to_build_data(s):
    """Convert a _sheet_payload dict into the build_sheet input format."""
    import re

    # Extract order_qty from the CMT line's source text (e.g. "÷ 208 garments")
    order_qty = 1
    for ln in s.get("lines", []):
        if ln.get("kind") == "cmt" and ln.get("source"):
            m = re.search(r"÷\s*(\d+)\s*garments", ln["source"], re.IGNORECASE)
            if m:
                order_qty = int(m.group(1))
                break

    # Unit helpers
    _parens_to_unit = {"kg/garment": "kg", "pcs/garment": "pc", "m/garment": "m"}
    _kind_unit_default = {"fabric": "m", "cmt": "gmt", "overhead": "lot", "trim": "pc"}
    _group_labels = {
        "fabric":   "Fabric",
        "trim":     "Trims and accessories",
        "cmt":      "CMT / labour",
        "overhead": "Overheads",
    }

    def _extract_unit(label, kind):
        if label:
            m = re.search(r"\(([^)]+)\)\s*$", label)
            if m:
                raw = m.group(1).lower()
                if raw in _parens_to_unit:
                    return _parens_to_unit[raw]
        return _kind_unit_default.get(kind, "pc")

    def _strip_unit_suffix(label):
        if not label:
            return "—"
        return re.sub(r"\s*\([^)]+/garment\)\s*$", "", label,
                      flags=re.IGNORECASE).strip() or label

    # Build groups
    groups = []
    for kind in ("fabric", "trim", "cmt", "overhead"):
        kind_lines = [ln for ln in s.get("lines", []) if ln.get("kind") == kind]
        if not kind_lines:
            continue
        out_lines = []
        for ln in kind_lines:
            out_lines.append({
                "desc":      _strip_unit_suffix(ln.get("label")),
                "barcode":   ln.get("barcode"),
                "qty":       ln["qty"] if ln.get("qty") is not None else 0,
                "unit":      _extract_unit(ln.get("label"), kind),
                "unit_cost": ln["unit_cost"] if ln.get("unit_cost") is not None else 0,
            })
        groups.append({"label": _group_labels[kind], "lines": out_lines})

    # Embroidery cost — add as its own group when enabled so build_sheet's
    # _derive() includes it in total_cost automatically.
    raw_emb = s.get("embroidery_data") or {}
    if isinstance(raw_emb, dict) and raw_emb.get("enabled"):
        emb_cpr = float(raw_emb.get("cost_per_run") or 0)
        emb_rc  = float(raw_emb.get("run_count") or 0)
        groups.append({
            "label": "Embroidery",
            "lines": [{
                "desc":      f"Embroidery ({emb_rc:g} runs \u00d7 KES {emb_cpr:,.2f}/1 000 stitches)",
                "barcode":   None,
                "qty":       emb_rc,
                "unit":      "run",
                "unit_cost": emb_cpr,
            }],
        })

    # Signoffs — format signed_at as EAT string for build_sheet
    def _fmt_eat(ts_iso):
        if not ts_iso:
            return None
        try:
            dt = (datetime.datetime.fromisoformat(ts_iso)
                  .astimezone(ZoneInfo("Africa/Nairobi")))
            return dt.strftime("%d %b %Y, %H:%M EAT")
        except Exception:
            return str(ts_iso)

    signoffs = []
    for so in s.get("signoffs", []):
        signoffs.append({
            "role":      so.get("title") or "",
            "name":      so.get("signed_by_name") if so.get("signed") else None,
            "signed_at": _fmt_eat(so.get("signed_at")) if so.get("signed") else None,
        })

    # Revisions: history is most-recent-first → reverse to chronological, cap at 8
    history = list(reversed(s.get("history") or []))[-8:]
    revisions = []
    for h in history:
        ts = h.get("changed_at")
        if ts:
            try:
                dt = (datetime.datetime.fromisoformat(ts)
                      .astimezone(ZoneInfo("Africa/Nairobi")))
                ts_str = dt.strftime("%d %b %Y, %H:%M")
            except Exception:
                ts_str = str(ts)
        else:
            ts_str = "—"
        summary = h.get("summary") or ""
        who = h.get("changed_by_name") or ""
        revisions.append(f"{ts_str} — {summary}, {who}")

    # Basis note
    stage = s.get("stage") or "main_production"
    basis_note = (s.get("notes") or "").strip()
    # Accessories % provenance (pre-production sheets created since the
    # auto-pick): the % and its source month must reach the PDF wherever the
    # accessories basis is described — including an explicit note when a
    # walk-back fallback month supplied the value. Legacy sheets (no meta)
    # keep the exact wording they always had.
    acc_prov = None
    if stage == "pre_production":
        _m = s.get("accessories_pct_meta")
        if isinstance(_m, dict):
            _pct_txt = _preprod_acc_pct_fmt(
                s.get("accessories_pct") if s.get("accessories_pct") is not None
                else _m.get("pct"))
            if _m.get("retrofit_status") == "retained_no_history":
                acc_prov = (
                    f"Accessories remain {_pct_txt}% of fabric cost — the "
                    "existing value was retained because no qualifying "
                    "Done-DPS history was available during the controlled "
                    "retrofit.")
            elif _m.get("is_default"):
                acc_prov = (f"Accessories are {_pct_txt}% of fabric cost — the "
                            "standard default (no month with qualifying "
                            "Done-DPS data), picked at sheet creation.")
            else:
                _picked_when = ("backfilled automatically."
                                if _m.get("retrofit_status") == "picked"
                                else "picked at sheet creation.")
                acc_prov = (f"Accessories are {_pct_txt}% of fabric cost — the "
                            f"{_m.get('month_label') or _m.get('source_month')} "
                            f"Done-DPS average ({int(_m.get('dps_count') or 0)} "
                            f"DPS), {_picked_when}")
                if _m.get("fallback"):
                    _req = _m.get("requested_month_label") or "the previous month"
                    acc_prov += (f" Fallback month: {_req} had no qualifying "
                                 "Done DPS.")
    if not basis_note:
        if stage == "pre_production":
            # Quote the sheet's OWN Production Multiplier; sheets saved before
            # the field existed (NULL) used the then-hardcoded 1.40.
            _pm_txt = _costing_mult_fmt(s.get("production_multiplier"))
            _acc_sentence = acc_prov or ("Accessories are calculated as a "
                                         "percentage of fabric cost.")
            basis_note = (
                "Pre-production estimate. Fabric cost is metres per garment × master "
                f"cost/metre. {_acc_sentence} "
                "CMT is derived from start/stop time × cost-per-minute rate with a "
                f"×{_pm_txt} efficiency factor. Defect allowance is a percentage of fabric "
                "cost. Retail price is a target to achieve 70% margin ex-VAT."
            )
        else:
            basis_note = (
                f"Fabric valued at the current fabric-master cost per metre. "
                f"Trims and accessories at the cost recorded on the DPS / MO. "
                f"CMT is actual labour from the completed DPS divided by "
                f"{order_qty} garments, so it moves with order quantity. "
                f"Retail is the modal SKU price."
            )
    elif acc_prov:
        # Sheets with hand-written notes must still surface the auto-picked
        # Accessories % provenance on the PDF.
        basis_note = f"{basis_note} {acc_prov}"

    generated_at = (datetime.datetime.now(ZoneInfo("Africa/Nairobi"))
                    .strftime("%d %b %Y, %H:%M EAT"))

    dps_label = (s.get("dps_ref") or
                 ("Pre-production estimate" if stage == "pre_production" else "—"))
    return {
        "style_name":      s.get("style_name") or "—",
        "style_no":        s.get("style_number") or "—",
        "colour":          s.get("color") or "All colours",
        "dps":             dps_label,
        "currency":        "KES",
        "vat_rate":        0.16,
        "retail_incl_vat": float(s.get("selling_price") or 0),
        "order_qty":       order_qty,
        "groups":          groups,
        "signoffs":        signoffs,
        "revisions":       revisions,
        "basis_note":      basis_note,
        "stage":           stage,
        "generated_at":    generated_at,
    }


def _costing_build_pdf(s):
    """Render the costing sheet PDF using the reference build_sheet renderer.
    Falls back to the inline multi-page renderer when build_sheet raises a
    known non-fatal exception (layout overflow, accounting rounding edge case,
    or missing dependency) so the export never returns HTTP 500 on valid sheets.

    Raises ValueError for sheets with a zero or missing selling price — the
    accounting identity (cogs% + margin% = 100) cannot hold, and the inline
    renderer would produce a corrupt sheet rather than a meaningful fallback."""
    _sp = s.get("selling_price")
    try:
        _sp_f = float(_sp) if _sp is not None else None
    except (TypeError, ValueError):
        _sp_f = None
    if _sp_f is None or _sp_f <= 0:
        raise ValueError(
            "selling_price must be > 0 — the accounting identity "
            "(cogs% + margin% = 100) cannot hold for a zero or missing price")
    import os as _os
    import sys as _sys
    import tempfile
    import logging as _log
    _logger = _log.getLogger("fabric_router")

    _costing_dir = _os.path.join(
        _os.path.dirname(_os.path.abspath(__file__)),
        "artifacts", "costing-pdf"
    )
    if _costing_dir not in _sys.path:
        _sys.path.insert(0, _costing_dir)

    try:
        from costing import build_sheet  # noqa: PLC0415
    except (ImportError, ModuleNotFoundError) as exc:
        _logger.warning(
            "Branded costing PDF renderer unavailable (%s); using inline renderer", exc)
        return _costing_build_pdf_inline(s)

    build_data = _costing_to_build_data(s)
    fd, tmp_path = tempfile.mkstemp(suffix=".pdf", prefix="costing_")
    try:
        _os.close(fd)  # build_sheet opens the file itself
        build_sheet(build_data, tmp_path)
        with open(tmp_path, "rb") as fh:
            return fh.read()
    except RuntimeError as exc:
        # Layout overflow: too many lines for the branded single-page layout
        _logger.warning(
            "Branded costing PDF overflowed one page (%s); using inline renderer", exc)
        return _costing_build_pdf_inline(s)
    except ValueError as exc:
        # Accounting identity rounding edge case in build_sheet()._derive()
        _logger.warning(
            "Branded costing PDF accounting check failed (%s); using inline renderer", exc)
        return _costing_build_pdf_inline(s)
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass

def _costing_build_pdf_inline(s):
    import io
    from xml.sax.saxutils import escape as xesc
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                    Paragraph, Spacer)

    ORANGE = colors.HexColor("#F15A24")
    INK = colors.HexColor("#1A1A1A")
    MUTED = colors.HexColor("#6B6B6B")
    LINE = colors.HexColor("#ECE6E1")
    PAPER = colors.HexColor("#FAF8F4")

    styles = getSampleStyleSheet()
    p_title = ParagraphStyle("t", parent=styles["Heading1"], fontSize=16,
                             textColor=INK, spaceAfter=0, leading=19)
    p_sub = ParagraphStyle("s", parent=styles["Normal"], fontSize=8.5,
                           textColor=MUTED, leading=11)
    p_h = ParagraphStyle("h", parent=styles["Heading2"], fontSize=10.5,
                         textColor=INK, spaceBefore=8, spaceAfter=3)
    p_cell = ParagraphStyle("c", parent=styles["Normal"], fontSize=8.5, leading=10.5)
    p_cellm = ParagraphStyle("cm", parent=p_cell, textColor=MUTED, fontSize=7.5)

    def money(v):
        return "—" if v is None else f"{float(v):,.2f}"

    def eat(ts):
        if not ts:
            return "—"
        try:
            return (datetime.datetime.fromisoformat(ts)
                    .astimezone(ZoneInfo("Africa/Nairobi"))
                    .strftime("%d %b %Y %H:%M"))
        except Exception:
            return str(ts)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=16*mm, rightMargin=16*mm,
        topMargin=14*mm, bottomMargin=14*mm,
        title=f"Costing sheet — {s.get('style_name') or ''}")
    story = []

    # Branded header: flat orange "Vivo" block + title, hairline rule under.
    gen = (datetime.datetime.now(ZoneInfo("Africa/Nairobi"))
           .strftime("%d %b %Y %H:%M"))
    brand = Table([[
        Paragraph('<font color="white"><b>Vivo</b></font>',
                  ParagraphStyle("b", fontSize=13, leading=16,
                                 alignment=1, fontName="Helvetica-Bold")),
        Paragraph(f"<b>Product Costing Sheet</b><br/>"
                  f'<font size="8" color="#6B6B6B">Vivo Fashion Group · '
                  f"Fabric BI · generated {gen} EAT · amounts in KES</font>",
                  p_title),
    ]], colWidths=[22*mm, None], rowHeights=[13*mm])
    brand.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), ORANGE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (1, 0), (1, 0), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 2, ORANGE),
    ]))
    story += [brand, Spacer(1, 5*mm)]

    # Sheet identity block.
    ident = [
        ["Style", s.get("style_name") or "—",
         "Style number", s.get("style_number") or "—"],
        ["Colour scope", s.get("color") or "All colours",
         "Costed from DPS", s.get("dps_ref") or "—"],
    ]
    it = Table(ident, colWidths=[28*mm, None, 30*mm, 45*mm])
    it.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
        ("TEXTCOLOR", (2, 0), (2, -1), MUTED),
        ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
        ("FONTNAME", (3, 0), (3, -1), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [it, Spacer(1, 3*mm)]

    # Cost build-up grouped by kind, subtotal per group.
    kind_lbl = {"fabric": "Fabric", "trim": "Trims & accessories",
                "cmt": "CMT / Labour", "overhead": "Overheads"}
    story.append(Paragraph("Cost build-up", p_h))
    data = [["", "Description", "Qty", "Unit cost", "Line total"]]
    spans = []
    for kind in _COSTING_LINE_KINDS:
        grp = [l for l in s["lines"] if l["kind"] == kind]
        if not grp:
            continue
        hdr_i = len(data)
        data.append([kind_lbl.get(kind, kind), "", "", "", ""])
        spans.append(hdr_i)
        for l in grp:
            desc = xesc(l.get("label") or "—")
            if l.get("barcode"):
                desc += f' <font size="7" color="#6B6B6B">[{xesc(l["barcode"])}]</font>'
            src = l.get("source")
            para = Paragraph(desc, p_cell)
            srcp = Paragraph(xesc(("Auto — " if l.get("is_auto") else "") + src)
                             if src else ("Auto" if l.get("is_auto") else ""),
                             p_cellm)
            data.append(["", [para, srcp] if (src or l.get("is_auto")) else para,
                         "—" if l.get("qty") is None else f"{l['qty']:g}",
                         money(l.get("unit_cost")), money(l.get("total"))])
        sub = round(sum(l.get("total") or 0 for l in grp), 2)
        data.append(["", f"{kind_lbl.get(kind, kind)} subtotal", "", "", money(sub)])
    t = Table(data, colWidths=[30*mm, None, 16*mm, 24*mm, 26*mm], repeatRows=1)
    st = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in spans:
        st += [("SPAN", (0, i), (-1, i)),
               ("BACKGROUND", (0, i), (-1, i), PAPER),
               ("FONTNAME", (0, i), (-1, i), "Helvetica-Bold"),
               ("TEXTCOLOR", (0, i), (-1, i), ORANGE)]
    for i, row in enumerate(data):
        if isinstance(row[1], str) and row[1].endswith("subtotal"):
            st += [("FONTNAME", (1, i), (-1, i), "Helvetica-Bold"),
                   ("LINEABOVE", (0, i), (-1, i), 0.7, MUTED)]
    t.setStyle(TableStyle(st))
    story.append(t)

    # Totals / selling price / margin.
    margin = s.get("margin")
    tot = [
        ["Total cost per garment", money(s.get("total_cost"))],
        ["Retail price (VAT-incl)" + (" (auto — modal SKU price)"
                                      if s.get("selling_price_is_auto")
                                      else " (manual)"),
         money(s.get("selling_price"))],
        ["Selling price (ex-VAT, retail ÷ 1.16)",
         money(s.get("selling_price_ex_vat"))],
        ["Margin", money(margin)],
        ["Margin %", "—" if s.get("margin_pct") is None else f"{s['margin_pct']:.2f}%"],
    ]
    tt = Table(tot, colWidths=[None, 30*mm], hAlign="RIGHT")
    tt.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 3), (-1, -1), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, 3), (-1, -1),
         colors.HexColor("#DC2626") if (margin is not None and margin < 0)
         else colors.HexColor("#15803D")),
        ("LINEABOVE", (0, 0), (-1, 0), 0.7, INK),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    story += [Spacer(1, 2*mm), tt]

    # Notes.
    if s.get("notes"):
        story += [Paragraph("Notes", p_h),
                  Paragraph(xesc(s["notes"]).replace("\n", "<br/>"), p_cell)]

    # Revision info: created/edited stamps + recent change history.
    story.append(Paragraph("Revision info", p_h))
    story.append(Paragraph(
        f"Created by <b>{xesc(s.get('created_by_name') or '—')}</b> on "
        f"{eat(s.get('created_at'))} EAT &nbsp;·&nbsp; last edited by "
        f"<b>{xesc(s.get('updated_by_name') or '—')}</b> on "
        f"{eat(s.get('updated_at'))} EAT", p_cell))
    hist = (s.get("history") or [])[:8]
    if hist:
        hd = [["When (EAT)", "Who", "Action", "What changed"]]
        for h in hist:
            hd.append([eat(h.get("changed_at")), h.get("changed_by_name") or "—",
                       h.get("action") or "", Paragraph(xesc(h.get("summary") or ""), p_cellm)])
        ht = Table(hd, colWidths=[30*mm, 34*mm, 20*mm, None])
        ht.setStyle(TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("TEXTCOLOR", (0, 0), (-1, -1), MUTED),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, MUTED),
            ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story += [Spacer(1, 1.5*mm), ht]

    # Three sign-off blocks — signed shows name + timestamp, unsigned = pending.
    story.append(Paragraph("Sign-off", p_h))
    cells = []
    for so in s["signoffs"]:
        if so["signed"]:
            body = (f'<font size="8" color="#6B6B6B">{xesc(so["title"])}</font><br/>'
                    f'<b>{xesc(so["signed_by_name"] or "—")}</b><br/>'
                    f'<font size="7.5" color="#15803D">Signed · '
                    f'{eat(so["signed_at"])} EAT</font>')
        else:
            body = (f'<font size="8" color="#6B6B6B">{xesc(so["title"])}</font><br/>'
                    f'<font color="#9CA3AF">Pending</font><br/>'
                    f'<font size="7.5" color="#9CA3AF">Not signed</font>')
        cells.append(Paragraph(body, p_cell))
    sot = Table([cells], colWidths=[None, None, None])
    sot.setStyle(TableStyle([
        ("BOX", (0, 0), (0, 0), 0.6, LINE), ("BOX", (1, 0), (1, 0), 0.6, LINE),
        ("BOX", (2, 0), (2, 0), 0.6, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    _signoff_status = s.get("signoff_status") or _costing_signoff_status(
        s.get("signoffs") or [{"signed": False}] * 3)
    _locked = s.get("locked") if "locked" in s else (_signoff_status == "approved")
    status_lbl = {"approved": "APPROVED", "partial": "PARTIALLY SIGNED",
                  "draft": "DRAFT"}[_signoff_status]
    story += [Spacer(1, 1.5*mm), sot, Spacer(1, 2*mm),
              Paragraph(f"Sheet status: <b>{status_lbl}</b>"
                        + (" — locked against edits" if _locked else ""),
                        p_sub)]

    doc.build(story)
    return buf.getvalue()
@fabric_router.get("/api/fabric/costing/sheets/{sheet_id}/export.pdf")
def costing_export_sheet_pdf(sheet_id: int):
    with _get_conn() as conn:
        _ensure_costing_tables(conn)
        s = _sheet_payload(conn, sheet_id, with_history=True)
    try:
        payload = _costing_build_pdf(s)
    except ModuleNotFoundError as e:
        raise HTTPException(status_code=500,
                            detail=f"PDF library unavailable on server ({e.name}); contact admin.")
    except Exception as e:
        raise HTTPException(status_code=500,
                            detail=f"Could not build the costing PDF: {e}")
    fname = "costing-%s.pdf" % _costing_fname_safe(s["style_name"])
    return Response(content=payload, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="%s"' % fname})


# ═════════════════════════════════════════════════════════════════════════════
# SUBLIMATION PRINTING COSTING
# Print-run calculator + persistent costing library, plus the locked machine-
# rate engine constants. Formula source: the "Vivo Sublimation Printing Costing
# → Odoo BOM" template — the browser recalculates live for display, and the
# server RECOMPUTES every derived figure from the inputs on save
# (_sublim_compute below is the single source of truth), so a saved library row
# can never disagree with the inputs it stores. The Odoo BOM's operation time
# always uses the SETTABLE standard throughput (default 60 m/hr) — the run's
# actual rate is shown as a variance readout only, which keeps the exported
# standard cost run-independent.
# The machine-rate engine (labour pool, overhead pool, capacity %) is LOCKED at
# the current template values — making it editable from the UI is a later phase.
# ═════════════════════════════════════════════════════════════════════════════

SUBLIM_MACHINE_RATE = {
    "locked": True,
    # Monthly cost pools (KES) — two presses costed as one unit
    "labour_pool_monthly": 169367.0,
    "overhead_pool_monthly": 918589.37,
    "total_cost_pool_monthly": 1087956.37,
    # Capacity assumptions behind the normal machine-hours figure
    "machines_in_pool": 2,
    "shift_hours_per_day": 8,
    "planned_downtime_pct": 0.25,
    "working_days_per_month": 21,
    "utilisation_pct": 0.85,
    "productive_hrs_per_machine_per_day": 6.0,
    "full_parallel_ceiling_machine_hrs_month": 252.0,
    "normal_machine_hours_month": 214.2,
    # The two numbers every machine-cost calculation keys off
    "cost_per_machine_hour": 5079.161391,
    "cost_per_machine_minute": 84.65268985,
    # Display-only: hourly rate at other utilisations (not interactive)
    "utilisation_sensitivity": [
        {"utilisation_pct": 100, "cost_per_hour": 4317.287183},
        {"utilisation_pct": 85,  "cost_per_hour": 5079.161391},
        {"utilisation_pct": 75,  "cost_per_hour": 5756.38291},
        {"utilisation_pct": 70,  "cost_per_hour": 6167.553118},
    ],
}

_SUBLIM_READY = False

def _ensure_sublimation_tables(conn):
    """Idempotent lazy DDL for the sublimation costing library (same pattern as
    _ensure_fabric_tables). reprint_pct is stored in percent points (5 = 5%),
    exactly as the calculator field holds it, so Load round-trips byte-for-byte."""
    global _SUBLIM_READY
    if _SUBLIM_READY:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sublimation_costings (
                id                     SERIAL PRIMARY KEY,
                saved_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
                saved_by               TEXT,
                fabric_product_id      INTEGER,
                fabric_name            TEXT,
                fabric_barcode         TEXT,
                fabric_width_m         NUMERIC,
                fabric_gsm             NUMERIC,
                metres_printed         NUMERIC,
                machine_time_h         INTEGER,
                machine_time_min       INTEGER,
                ink_cost_per_ml        NUMERIC,
                tile_width_cm          NUMERIC,
                tile_height_cm         NUMERIC,
                ink_cyan_ml            NUMERIC,
                ink_yellow_ml          NUMERIC,
                ink_magenta_ml         NUMERIC,
                ink_black_ml           NUMERIC,
                sub_paper_cost_per_m   NUMERIC,
                prot_paper_cost_per_m  NUMERIC,
                reprint_pct            NUMERIC,
                base_fabric_cost_per_m NUMERIC,
                print_margin_cm        NUMERIC,
                total_printing_cost    NUMERIC,
                printing_cost_per_m    NUMERIC,
                printing_cost_per_kg   NUMERIC,
                finished_cost_per_m    NUMERIC,
                finished_cost_per_kg   NUMERIC,
                std_cost_per_kg        NUMERIC,
                std_throughput_m_hr    NUMERIC
            )
        """)
        # Installs that created the table before the settable BOM standard-
        # throughput field existed gain the column in place (idempotent).
        cur.execute("""
            ALTER TABLE sublimation_costings
            ADD COLUMN IF NOT EXISTS std_throughput_m_hr NUMERIC
        """)
        # Descriptive label fields added so saved costings can be identified by
        # the print design and garment style they relate to (idempotent).
        cur.execute("ALTER TABLE sublimation_costings "
                    "ADD COLUMN IF NOT EXISTS print_name TEXT")
        cur.execute("ALTER TABLE sublimation_costings "
                    "ADD COLUMN IF NOT EXISTS style_name TEXT")
        cur.execute("ALTER TABLE sublimation_costings "
                    "ADD COLUMN IF NOT EXISTS print_code TEXT")
        cur.execute("ALTER TABLE sublimation_costings "
                    "ADD COLUMN IF NOT EXISTS final_product_name TEXT")
        cur.execute("ALTER TABLE sublimation_costings "
                    "ADD COLUMN IF NOT EXISTS final_fabric_barcode TEXT")
    conn.commit()
    _SUBLIM_READY = True

# Inputs the client sends; every derived figure is recomputed server-side.
_SUBLIM_INPUT_FLOAT_FIELDS = (
    "fabric_width_m", "fabric_gsm", "metres_printed", "ink_cost_per_ml",
    "tile_width_cm", "tile_height_cm", "ink_cyan_ml", "ink_yellow_ml",
    "ink_magenta_ml", "ink_black_ml", "sub_paper_cost_per_m",
    "prot_paper_cost_per_m", "reprint_pct", "base_fabric_cost_per_m",
    "print_margin_cm", "std_throughput_m_hr",
)
# Derived columns — persisted from _sublim_compute ONLY; anything the client
# sends under these names is ignored so a saved row can't lie about its inputs.
_SUBLIM_COMPUTED_FIELDS = (
    "total_printing_cost", "printing_cost_per_m", "printing_cost_per_kg",
    "finished_cost_per_m", "finished_cost_per_kg", "std_cost_per_kg",
)
_SUBLIM_INT_FIELDS = ("fabric_product_id", "machine_time_h", "machine_time_min")
_SUBLIM_TEXT_FIELDS = (
    "fabric_name", "fabric_barcode", "print_name", "style_name", "print_code",
    "final_product_name", "final_fabric_barcode",
)

SUBLIM_STD_THROUGHPUT_DEFAULT = 60.0

def _sublim_num(body, field, kind):
    v = body.get(field)
    if v is None or v == "":
        return None
    try:
        return kind(v)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a number")

def _sublim_compute(v):
    """The costing template's arithmetic, server-side — the single source of
    truth for every stored derived figure (mirrors recalcSublimation() in
    fabric_dashboard_live.html). Keys starting with "_" are internals exposed
    for the regression tests and a future Odoo push; the rest are the
    persisted columns.

    BOM operation time ALWAYS uses the settable standard throughput
    (std_throughput_m_hr, default 60 m/hr) — never the run's actual rate,
    which is returned separately as a variance readout. Reprint allowance
    applies to the printing lines only, never the base fabric."""
    def g(k):
        try:
            n = float(v.get(k) or 0)
        except (TypeError, ValueError):
            n = 0.0
        return n if n == n else 0.0  # NaN guard
    width, gsm, metres = g("fabric_width_m"), g("fabric_gsm"), g("metres_printed")
    margin, basem = g("print_margin_cm"), g("base_fabric_cost_per_m")
    mtime = g("machine_time_h") + g("machine_time_min") / 60.0
    ink_cost = g("ink_cost_per_ml")
    tile = g("tile_width_cm") * g("tile_height_cm") / 10000.0
    ml = {c: g(f"ink_{n}_ml") for c, n in
          (("c", "cyan"), ("y", "yellow"), ("m", "magenta"), ("k", "black"))}
    sub_pm, prot_pm = g("sub_paper_cost_per_m"), g("prot_paper_cost_per_m")
    reprint = g("reprint_pct") / 100.0
    std_thr = g("std_throughput_m_hr")
    if std_thr <= 0:
        std_thr = SUBLIM_STD_THROUGHPUT_DEFAULT
    div = lambda a, b: (a / b) if (a is not None and b and b > 0) else None

    # ── Run costing (template formulas, verbatim) ──
    print_w = max(width - 2 * margin / 100.0, 0.0)
    p_area = metres * print_w                    # printed area m²
    f_area = metres * width                      # fabric area m²
    weight = f_area * gsm / 1000.0               # run weight kg
    cov = {c: (ml[c] / tile if tile > 0 else 0.0) for c in ml}
    ink_sub = sum(cov[c] * p_area * ink_cost for c in ml)
    paper = metres * sub_pm + metres * prot_pm
    mach = mtime * SUBLIM_MACHINE_RATE["cost_per_machine_hour"]
    print_sub = ink_sub + paper + mach
    total = print_sub * (1.0 + reprint)
    base_cost = metres * basem
    fin_tot = base_cost + total

    # ── Odoo BOM per 1 kg (operation at the SETTABLE standard throughput) ──
    wplm = width * gsm / 1000.0                  # kg per linear metre
    m_per_kg = (1.0 / wplm) if wplm > 0 else None
    m2_per_kg = (1000.0 / gsm) if gsm > 0 else None
    ratio = (print_w / width) if width > 0 else None
    mat_sub = op_min = mach_kg = clean_std = std_kg = None
    if m_per_kg is not None and m2_per_kg is not None and ratio is not None:
        pm2_per_kg = m2_per_kg * ratio
        bom_base = basem * m_per_kg
        ink_c_kg = sum(cov[c] * pm2_per_kg * ink_cost for c in ml)
        mat_sub = bom_base + ink_c_kg + m_per_kg * sub_pm + m_per_kg * prot_pm
        op_min = m_per_kg * 60.0 / std_thr
        mach_kg = op_min * SUBLIM_MACHINE_RATE["cost_per_machine_minute"]
        clean_std = mat_sub + mach_kg
        # Reprint on printing lines only — the base fabric is never reprinted.
        std_kg = bom_base + (clean_std - bom_base) * (1.0 + reprint)

    return {
        "total_printing_cost": total,
        "printing_cost_per_m": div(total, metres),
        "printing_cost_per_kg": div(total, weight),
        "finished_cost_per_m": div(fin_tot, metres),
        "finished_cost_per_kg": div(fin_tot, weight),
        "std_cost_per_kg": std_kg,
        # internals (never persisted)
        "_ink_subtotal": ink_sub,
        "_paper_subtotal": paper,
        "_machine_conversion": mach,
        "_printing_subtotal": print_sub,
        "_metres_per_kg": m_per_kg,
        "_material_subtotal_per_kg": mat_sub,
        "_operation_min_per_kg": op_min,
        "_machine_cost_per_kg": mach_kg,
        "_clean_std_cost_per_kg": clean_std,
        "_std_throughput_m_hr": std_thr,
        "_actual_throughput_m_hr": div(metres, mtime),
    }

def _sublim_prepare(body):
    """Parse + validate the request body, then recompute every derived column
    from the inputs. Returns the exact dict the INSERT persists — the POST
    endpoint and the regression tests share this path."""
    vals = {}
    for f in _SUBLIM_INPUT_FLOAT_FIELDS:
        vals[f] = _sublim_num(body, f, float)
    for f in _SUBLIM_INT_FIELDS:
        vals[f] = _sublim_num(body, f, int)
    for f in _SUBLIM_TEXT_FIELDS:
        v = (body.get(f) or "").strip()
        vals[f] = v or None
    if not vals["fabric_name"]:
        raise HTTPException(status_code=400,
            detail="fabric_name is required — pick a fabric from the suggestions list")
    if not vals["metres_printed"] or vals["metres_printed"] <= 0:
        raise HTTPException(status_code=400,
            detail="metres_printed must be greater than zero")
    comp = _sublim_compute(vals)
    vals["std_throughput_m_hr"] = comp["_std_throughput_m_hr"]
    for f in _SUBLIM_COMPUTED_FIELDS:
        vals[f] = comp[f]
    return vals

@fabric_router.get("/api/fabric/sublimation/machine-rate")
def sublimation_machine_rate():
    """Locked machine-rate engine constants for the read-only info panel."""
    return SUBLIM_MACHINE_RATE

@fabric_router.get("/api/fabric/sublimation/fabric-search")
def sublimation_fabric_search(q_: str = Query(default="", alias="q"),
                              limit: int = Query(default=20)):
    """Typeahead over the Odoo fabric master for the sublimation calculator.
    No stock join on purpose — a print run can be costed for any fabric product,
    stocked or not. standard_price/uom ride along so the frontend can prefill
    the greige cost per metre where a kg→m conversion exists."""
    term = (q_ or "").strip()
    limit = max(1, min(int(limit or 20), 50))
    with _get_conn() as conn:
        where, params = "TRUE", []
        exact_order_expr = "FALSE"
        exact_order_params: list = []
        if term:
            like = f"%{term}%"
            where = "(p.name ILIKE %s OR p.barcode ILIKE %s OR p.default_code ILIKE %s)"
            params = [like, like, like]
            # Float exact barcode match to top so it is never displaced by
            # the fuzzy-name ordering + LIMIT when the barcode also appears in
            # many product names.
            exact_order_expr = "(LOWER(p.barcode) = LOWER(%s))"
            exact_order_params = [term]
        return q(conn, f"""
            SELECT p.id AS product_id, p.name, p.barcode, p.default_code,
                   ROUND(p.width_m::numeric, 3)        AS fabric_width_m,
                   ROUND(p.gsm::numeric, 1)            AS fabric_gsm,
                   ROUND(p.kg_per_mtr_eff::numeric, 4) AS kg_per_mtr,
                   p.category, p.uom,
                   ROUND(p.standard_price::numeric, 2) AS standard_price
            FROM raw_fabric_products p
            WHERE {where}
            ORDER BY {exact_order_expr} DESC, p.name
            LIMIT %s
        """, params + exact_order_params + [limit])

@fabric_router.get("/api/fabric/sublimation/costings")
def sublimation_costings_list():
    with _get_conn() as conn:
        _ensure_sublimation_tables(conn)
        return {"items": q(conn, """
            SELECT * FROM sublimation_costings ORDER BY saved_at DESC, id DESC
        """)}

@fabric_router.post("/api/fabric/sublimation/costings")
def sublimation_costing_save(request: Request, body: dict = Body(...)):
    uid, name = _fabric_actor(request)
    vals = _sublim_prepare(body)   # validates + recomputes all derived columns
    cols = list(vals.keys()) + ["saved_by"]
    params = list(vals.values()) + [name or uid or None]
    with _get_conn() as conn:
        _ensure_sublimation_tables(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO sublimation_costings (%s) VALUES (%s) RETURNING *"
                % (", ".join(cols), ", ".join(["%s"] * len(cols))),
                params)
            row = cur.fetchone()
        conn.commit()
        _log_fabric_change("Saved sublimation costing", {
            "id": row["id"], "fabric": vals["fabric_name"],
            "barcode": vals["fabric_barcode"],
            "metres": vals["metres_printed"],
            "total_printing_cost": vals["total_printing_cost"],
            "std_cost_per_kg": vals["std_cost_per_kg"],
        }, request)
        return row

@fabric_router.delete("/api/fabric/sublimation/costings/{costing_id}")
def sublimation_costing_delete(costing_id: int, request: Request):
    with _get_conn() as conn:
        _ensure_sublimation_tables(conn)
        # Snapshot BEFORE the row is gone so the audit log stays human-readable.
        snap = q(conn, """
            SELECT id, fabric_name, fabric_barcode, metres_printed
            FROM sublimation_costings WHERE id=%s
        """, (costing_id,))
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sublimation_costings WHERE id=%s", (costing_id,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            raise HTTPException(status_code=404, detail="costing not found")
        _log_fabric_change("Deleted sublimation costing",
                           snap[0] if snap else {"id": costing_id}, request)
        return {"ok": True}


# ── Manufacturing component availability ───────────────────────────────────
def _mfg_filters(mo_ref="", style="", component="", state="", source="", status=""):
    clauses, params = [], []
    # These are one user-entered search expression: a match in any filled
    # highlighted field qualifies the reservation. Status is deliberately not
    # part of this OR group; it is an explicit post-aggregation filter.
    searches = []
    for value, expressions in (
        (mo_ref, ("mo_ref", "dps_ref")),
        (style, ("style_name", "finished_sku", "finished_name")),
        (component, ("component_match",)),
        (state, ("order_state",)),
        (source, ("source_match",)),
    ):
        value = str(value or "").strip()[:120]
        if value:
            searches.append("(" + " OR ".join(f"{column} ILIKE %s"
                                              for column in expressions) + ")")
            params.extend(["%" + value + "%"] * len(expressions))
    if searches:
        clauses.append("(" + " OR ".join(searches) + ")")
    # Availability status is computed after shared components are rolled up.
    # Filtering it here would classify each MO independently and hide a shared
    # component whose final aggregate status differs from one reservation row.
    return (" AND ".join(clauses) or "TRUE"), params


def _mfg_rows(conn, filters=None):
    filters = filters or {}
    where, params = _mfg_filters(**filters)
    # All quantities are normalised to kg at the query boundary.  Odoo can
    # return grams on one move and kg on another; duplicate moves are already
    # collapsed by the extractor at MO/component grain.
    sql = f"""
        WITH demand AS (
          SELECT d.*,
            CASE WHEN lower(COALESCE(d.uom,'')) IN ('g','gram','grams')
                 THEN d.required_qty/1000 ELSE d.required_qty END AS required_kg,
            CASE WHEN lower(COALESCE(d.uom,'')) IN ('g','gram','grams')
                 THEN d.reserved_qty/1000 ELSE d.reserved_qty END AS reserved_kg
          FROM mo_open_component_requirements d
        ), stock AS (
          SELECT product_id,
                 SUM(CASE WHEN lower(COALESCE(uom,'')) IN ('g','gram','grams')
                          THEN COALESCE(available, quantity)/1000
                          ELSE COALESCE(available, quantity) END) AS available_kg,
                 STRING_AGG(DISTINCT NULLIF(location_name,''), ', '
                            ORDER BY NULLIF(location_name,'')) AS stock_locations
          FROM raw_fabric_inventory
          GROUP BY product_id
        ), enriched AS (
          SELECT d.*, COALESCE(s.available_kg,0) AS available_kg,
                 COALESCE(s.stock_locations,'No synced stock') AS stock_locations,
                  (COALESCE(d.component_sku,'') || ' ' ||
                   COALESCE(d.component_name,'')) AS component_match,
                  (COALESCE(d.source_location,'') || ' ' ||
                   COALESCE(s.stock_locations,'')) AS source_match,
                 CASE WHEN COALESCE(s.available_kg,0) >= d.required_kg
                      THEN 'available'
                      WHEN COALESCE(s.available_kg,0) > 0 THEN 'partial'
                      ELSE 'short' END AS availability_status
           FROM demand d LEFT JOIN stock s ON s.product_id=d.component_id
           WHERE d.order_state IN ('confirmed', 'progress')
        )
        SELECT * FROM enriched WHERE {where}
        ORDER BY CASE availability_status WHEN 'short' THEN 0
                 WHEN 'partial' THEN 1 ELSE 2 END, component_name, mo_ref
    """
    return q(conn, sql, tuple(params))


@fabric_router.get("/api/fabric/manufacturing")
def manufacturing_availability(
    mo_ref: str = Query(default=""), style: str = Query(default=""),
    component: str = Query(default=""), state: str = Query(default=""),
    source: str = Query(default=""), status: str = Query(default=""),
    full: bool = Query(default=False)):
    with _get_conn() as conn:
        table = q(conn, "SELECT to_regclass('public.mo_open_component_requirements') AS t")
        if not table or not table[0].get("t"):
            return {"summary": {"components": 0, "orders": 0, "required_kg": 0,
                                "available_kg": 0, "short": 0, "partial": 0,
                                "available": 0}, "components": [], "freshness": None}
        rows = _mfg_rows(conn, {"mo_ref": mo_ref, "style": style,
                                "component": component, "state": state,
                                "source": source, "status": status})
        groups = {}
        for r in rows:
            key = r["component_id"]
            g = groups.setdefault(key, {
                "component_id": key, "component_sku": r.get("component_sku"),
                "component_name": r.get("component_name"), "uom": "kg",
                "required_kg": 0.0, "available_kg": float(r.get("available_kg") or 0),
                "reserved_kg": 0.0, "source_location": r.get("source_location"),
                "stock_locations": r.get("stock_locations"),
                "reservations": []})
            g["required_kg"] += float(r.get("required_kg") or 0)
            g["reserved_kg"] += float(r.get("reserved_kg") or 0)
            g["reservations"].append({
                "mo_id": r["odoo_mo_id"], "mo_ref": r.get("mo_ref"),
                "dps_ref": r.get("dps_ref"), "order_state": r.get("order_state"),
                "style_name": r.get("style_name"), "finished_sku": r.get("finished_sku"),
                "finished_name": r.get("finished_name"),
                "finished_date": r.get("date_planned"),
                "required_kg": float(r.get("required_kg") or 0),
                "reserved_kg": float(r.get("reserved_kg") or 0),
                "available_kg": float(r.get("available_kg") or 0),
                "availability_status": r.get("availability_status"),
                "source_location": r.get("source_location")})
        for g in groups.values():
            g["availability_status"] = ("available" if g["available_kg"] >= g["required_kg"]
                else "partial" if g["available_kg"] > 0 else "short")
        if status in ("available", "partial", "short"):
            components = [g for g in groups.values()
                          if g["availability_status"] == status]
        else:
            components = list(groups.values())
        freshness = q(conn, """
           SELECT MAX(_loaded_at) AS loaded_at,
                 COUNT(DISTINCT odoo_mo_id) AS orders
          FROM mo_open_component_requirements
          WHERE order_state IN ('confirmed', 'progress')
        """)[0]
        counts = {s: sum(1 for g in components if g["availability_status"] == s)
                  for s in ("available", "partial", "short")}
        return {"contract": {
                    "source": "Odoo mrp.production/stock.move snapshot + synced stock",
                    "target_states": {"confirmed": "Confirmed", "progress": "In-progress"},
                    "excluded_states": ["draft", "planned", "to_close", "done", "cancel"],
                    "search": "OR across filled mo_ref, style, component, state, source fields; status is additional",
                },
                "summary": {"components": len(components),
                            "orders": int(freshness.get("orders") or 0),
                            "required_kg": round(sum(g["required_kg"] for g in components), 3),
                            "available_kg": round(sum(g["available_kg"] for g in components), 3),
                            **counts},
                "components": components,
                "freshness": {"odoo_snapshot": freshness.get("loaded_at"),
                              "stock_snapshot": freshness.get("loaded_at")}}


def _mfg_live_suggestions(field, term, limit=20):
    """Small, read-only current-Odoo lookup for the five report fields.

    The report remains available from the last successful snapshot when Odoo is
    down; callers can distinguish that case from a live lookup error.
    """
    import socket
    import xmlrpc.client
    term = str(term or "").strip()[:80]
    if len(term) < 2:
        return []
    url, db = os.environ.get("ODOO_URL"), os.environ.get("ODOO_DB")
    user, password = os.environ.get("ODOO_USER"), os.environ.get("ODOO_PASSWORD")
    if not all((url, db, user, password)):
        raise RuntimeError("Odoo live search is not configured")
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(8)
    try:
        common = xmlrpc.client.ServerProxy(f"{url.rstrip('/')}/xmlrpc/2/common")
        uid = common.authenticate(db, user, password, {})
        if not uid:
            raise RuntimeError("Odoo authentication failed")
        models = xmlrpc.client.ServerProxy(f"{url.rstrip('/')}/xmlrpc/2/object")
        target = [["state", "in", ["confirmed", "progress"]], ["dps_id", "!=", False]]
        if field == "mo":
            domain = target + ["|", ["name", "ilike", term], ["dps_id", "ilike", term]]
            recs = models.execute_kw(db, uid, password, "mrp.production",
                                      "search_read", [domain],
                                      {"fields": ["name", "dps_id", "state"],
                                       "limit": limit, "order": "id desc"})
            return [{"id": r["id"], "label": r.get("name") or "",
                     "detail": (r.get("dps_id") or [None, ""])[1],
                     "state": r.get("state")} for r in recs]
        if field == "state":
            return [{"id": value, "label": label}
                    for value, label in (("confirmed", "Confirmed"),
                                         ("progress", "In-progress"))
                    if term.lower() in label.lower() or term.lower() in value]
        # Product lookups are current Odoo data and are bounded to the
        # categories used by the manufacturing extractor.
        if field in ("component", "style"):
            domain = [["name", "ilike", term]]
            if field == "component":
                domain = ["|", ["name", "ilike", term],
                          ["default_code", "ilike", term]]
            recs = models.execute_kw(db, uid, password, "product.product",
                                      "search_read", [domain],
                                      {"fields": ["default_code", "name"],
                                       "limit": limit, "order": "name"})
            return [{"id": r["id"],
                     "label": " ".join(x for x in (r.get("default_code"), r.get("name")) if x)}
                    for r in recs]
        # Source values are location names in stock.move, narrowed by current
        # target-state MOs rather than exposing the entire location catalogue.
        mo_recs = models.execute_kw(db, uid, password, "mrp.production",
                                    "search_read", [target],
                                    {"fields": ["move_raw_ids"], "limit": 500})
        move_ids = [x for r in mo_recs for x in (r.get("move_raw_ids") or [])]
        if not move_ids:
            return []
        moves = models.execute_kw(db, uid, password, "stock.move", "read",
                                  [move_ids], {"fields": ["location_id"]})
        seen = {}
        for move in moves:
            loc = move.get("location_id")
            if loc and term.lower() in (loc[1] or "").lower():
                seen[loc[0]] = loc[1]
        return [{"id": key, "label": label} for key, label in list(seen.items())[:limit]]
    finally:
        socket.setdefaulttimeout(old_timeout)


@fabric_router.get("/api/fabric/manufacturing/search")
def manufacturing_search(field: str = Query(default=""),
                          q: str = Query(default="")):
    if field not in ("mo", "style", "component", "state", "source"):
        raise HTTPException(status_code=400, detail="Unsupported manufacturing search field")
    try:
        return {"live": True, "field": field, "suggestions": _mfg_live_suggestions(field, q)}
    except Exception as exc:
        return {"live": False, "field": field, "suggestions": [],
                "error": "Odoo live search unavailable", "detail": str(exc)}


@fabric_router.get("/api/fabric/manufacturing.xlsx")
def manufacturing_availability_xlsx(
    mo_ref: str = Query(default=""), style: str = Query(default=""),
    component: str = Query(default=""), state: str = Query(default=""),
    source: str = Query(default=""), status: str = Query(default="")):
    import io
    import openpyxl
    from openpyxl.styles import Font
    filters = {"mo_ref": mo_ref, "style": style, "component": component,
               "state": state, "source": source, "status": status}
    with _get_conn() as conn:
        rows = _mfg_rows(conn, filters)
        generated = datetime.datetime.now(ZoneInfo("Africa/Nairobi")).strftime("%Y-%m-%d %H:%M %Z")
        wb = openpyxl.Workbook()
        ws = wb.active; ws.title = "Component Summary"
        detail = wb.create_sheet("DPS-MO Reservations")
        headers = ["Component SKU", "Component", "Required (kg)", "Available (kg)",
                   "Reserved (kg)", "Status", "Source location", "Stock locations"]
        ws.append(["Manufacturing availability", "Generated", generated, "Filters", json.dumps(filters)])
        ws.append(headers)
        grouped = {}
        for r in rows:
            if r["component_id"] not in grouped:
                grouped[r["component_id"]] = r.copy()
                grouped[r["component_id"]]["required_kg"] = float(r.get("required_kg") or 0)
                grouped[r["component_id"]]["reserved_kg"] = float(r.get("reserved_kg") or 0)
            else:
                g = grouped[r["component_id"]]
                g["required_kg"] += float(r.get("required_kg") or 0)
                g["reserved_kg"] += float(r.get("reserved_kg") or 0)
        for g in grouped.values():
            avail = float(g.get("available_kg") or 0); req = float(g.get("required_kg") or 0)
            current_status = "available" if avail >= req else "partial" if avail > 0 else "short"
            if status in ("available", "partial", "short") and current_status != status:
                continue
            ws.append([g.get("component_sku"), g.get("component_name"), req, avail,
                       float(g.get("reserved_kg") or 0),
                       current_status,
                       g.get("source_location"), g.get("stock_locations")])
        dh = ["DPS/MO", "DPS ref", "Finished style/product", "Finished SKU",
              "State", "Component SKU", "Component", "Required (kg)",
              "Reserved (kg)", "Source/location"]
        detail.append(["DPS/MO reservations", "Generated", generated])
        detail.append(dh)
        for r in rows:
            detail.append([r.get("mo_ref"), r.get("dps_ref"), r.get("style_name") or r.get("finished_name"),
                           r.get("finished_sku"), r.get("order_state"), r.get("component_sku"),
                           r.get("component_name"), float(r.get("required_kg") or 0),
                           float(r.get("reserved_kg") or 0), r.get("source_location")])
        for sheet in (ws, detail):
            sheet.freeze_panes = "A3"; sheet.auto_filter.ref = sheet.dimensions
            for cell in sheet[2]:
                cell.font = Font(bold=True)
            for col in sheet.columns:
                sheet.column_dimensions[col[0].column_letter].width = min(
                    34, max(12, max(len(str(c.value or "")) for c in col) + 2))
        out = io.BytesIO(); wb.save(out); out.seek(0)
        return Response(content=out.getvalue(),
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": 'attachment; filename="manufacturing-availability.xlsx"'})


if __name__ == "__main__":
    # Standalone one-time backfill of the Months-of-Cover daily snapshot. The
    # writer is idempotent (upserts on today's EAT capture date), so this is safe
    # to run manually against any DB (opens its own connection from DATABASE_URL).
    snap = write_cover_snapshot()
    print("Fabric cover snapshot written:", snap)
