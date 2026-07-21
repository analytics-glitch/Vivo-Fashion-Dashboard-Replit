"""
Vivo Fabric BI — Standalone FastAPI
Serves data for the Fabric BI dashboard
Run: uvicorn fabric_api:app --port 8081
"""
import base64
import datetime
from zoneinfo import ZoneInfo
import json
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
        cur.execute("""
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
        SELECT r.id, r.qty, r.uom, r.style_name, r.note, r.status,
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

def q(conn, sql, params=()):
    # Every fabric read funnels through here, so this is the one choke point
    # where the support-override table can be lazily ensured before any query
    # that embeds _scope_sql (which subselects from it) runs. Uses its OWN
    # pooled connection so it never disturbs the caller's transaction.
    _ensure_support_overrides()
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
    mon_label = q(conn, """
        SELECT to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM') AS mon
    """)[0]['mon']
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

# ── Summary cards ──────────────────────────────────────────
@fabric_router.get("/api/fabric/summary")
def summary(location: str = Query(default="RMAT/Stock"),
            scope: str = Query(default="main")):
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
        return {
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
              (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id AND {_real_move_sql('m')}) as last_move,
              CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves m WHERE m.product_id=i.product_id AND {_real_move_sql('m')}) as days_since_move
            FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            LEFT JOIN cons_win c ON c.product_id = i.product_id
            LEFT JOIN resv rv ON rv.product_id = i.product_id
            WHERE {' AND '.join(where)}
            {order_by}
            LIMIT %s OFFSET %s
        """, params + [limit, offset])

        total = q(conn, f"""
            SELECT COUNT(*) as n FROM raw_fabric_inventory i
            JOIN raw_fabric_products p ON p.id = i.product_id
            WHERE {' AND '.join(where)}
        """, params)[0]['n']

        return {"total": total, "items": rows}

# ── Ageing ──────────────────────────────────────────────────
@fabric_router.get("/api/fabric/ageing")
def ageing(location: str = Query(default="RMAT/Stock"),
           scope: str = Query(default="main")):
    with _get_conn() as conn:
        loc_sql, loc_params = _loc_filter(location)
        return q(conn, f"""
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

# ── Consumption over time ───────────────────────────────────
@fabric_router.get("/api/fabric/consumption")
def consumption(
    since: str = Query(default="2026-01-01"),
    until: str = Query(default="2099-12-31"),
    group_by: str = Query(default="month"),
    scope: str = Query(default="main"),
):
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
            return q(conn, f"""
                SELECT {dim} as period, {metrics}
                FROM {EFFECTIVE_MOVES} m
                LEFT JOIN raw_fabric_products p ON p.id = m.product_id
                WHERE {base_where}
                GROUP BY 1 ORDER BY qty_kg DESC NULLS LAST {limit}
            """, (since, until))
        trunc = {"day": "day", "week": "week"}.get(group_by, "month")
        return q(conn, f"""
            SELECT DATE_TRUNC('{trunc}', m.date)::date as period, {metrics}
            FROM {EFFECTIVE_MOVES} m
            LEFT JOIN raw_fabric_products p ON p.id = m.product_id
            WHERE {base_where}
            GROUP BY 1 ORDER BY 1
        """, (since, until))

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

        return {
            "days": days,
            "total_stock_kg": round(sum(c["stock_kg"] for c in out), 1),
            "total_consumed_kg": round(sum(c["consumed_kg"] for c in out), 1),
            "categories": out,
        }

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
                )
                SELECT
                  p.id, p.name, p.default_code, p.barcode, p.fabric_category, p.fabric_subcategory,
                  p.fabric_structure, p.plain_print, p.weight_range, p.gsm,
                  p.width_m, p.kg_per_mtr_eff as kg_per_mtr, p.kg_per_mtr_src, p.fiber_content, p.fabric_type,
                  p.supplier, p.supplier_fabric_code, p.active, p.primary_color, p.source_city, p.source_country,
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
                  (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id AND {_real_move_sql('mm')}) as last_move,
                  CURRENT_DATE - (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id AND {_real_move_sql('mm')}) as days_since_move
                FROM raw_fabric_products p
                LEFT JOIN inv ON inv.product_id = p.id
                LEFT JOIN cons_win c ON c.product_id = p.id
                LEFT JOIN resv rv ON rv.product_id = p.id
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
        return {
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
              (SELECT MAX(date)::date FROM raw_fabric_moves mm WHERE mm.product_id=p.id AND {_real_move_sql('mm')}) AS last_move
            FROM raw_fabric_products p
            LEFT JOIN stock st ON st.product_id = p.id
            LEFT JOIN usage us ON us.product_id = p.id
            LEFT JOIN last_loc ll ON ll.product_id = p.id
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
                WHERE c.done_date BETWEEN %s AND %s {scope_sql}
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
        return {"kpis": kpis, "by_month": by_month}

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
        return {
            "categories": [r['value'] for r in cats],
            "subcategories": subcats,
            "locations": [r['value'] for r in locs],
            "fabric_colors": [r['value'] for r in colors],
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

@fabric_router.get("/api/fabric/reservations")
def list_reservations(status: str = Query(default="active"), search: str = Query(default=None)):
    with _get_conn() as conn:
        _ensure_fabric_tables(conn)
        where = ["1=1"]
        params = []
        if status and status.lower() != "all":
            where.append("r.status = %s"); params.append(status.lower())
        if search:
            where.append("(p.name ILIKE %s OR p.default_code ILIKE %s OR r.style_name ILIKE %s)")
            params += [f"%{search}%", f"%{search}%", f"%{search}%"]
        # `soh` = current total stock on hand (kg) per fabric across all locations.
        rows = q(conn, f"""
            WITH soh AS (
              SELECT product_id, SUM(quantity) as soh_kg
              FROM raw_fabric_inventory
              GROUP BY product_id
            )
            SELECT r.id, r.product_id, r.qty, r.uom, r.qty_kg, r.style_name, r.note,
              r.status, r.reserved_by_name, r.reserved_at::date as reserved_on,
              r.used_at::date as used_on, r.used_by,
              p.name as fabric_name, p.default_code, p.kg_per_mtr_eff as kg_per_mtr,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN r.qty_kg/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as qty_metres,
              ROUND(COALESCE(s.soh_kg,0)::numeric,2) as soh_kg,
              ROUND(CASE WHEN p.kg_per_mtr_eff>0 THEN COALESCE(s.soh_kg,0)/p.kg_per_mtr_eff ELSE NULL END::numeric,1) as soh_metres,
              (CURRENT_DATE - r.reserved_at::date) as days_reserved,
              CASE WHEN r.used_at IS NOT NULL
                   THEN (r.used_at::date - r.reserved_at::date) END as days_to_use
            FROM fabric_reservations r
            LEFT JOIN raw_fabric_products p ON p.id = r.product_id
            LEFT JOIN soh s ON s.product_id = r.product_id
            WHERE {' AND '.join(where)}
            ORDER BY (r.status='active') DESC, r.reserved_at DESC
            LIMIT 500
        """, params)
        return {"items": rows}

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
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO fabric_reservations
                  (product_id, qty, uom, qty_kg, style_name, note, reserved_by, reserved_by_name)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
            """, (product_id, qty, uom, round(qty_kg, 3), style_name, note, uid, name))
            new_id = cur.fetchone()["id"]
        conn.commit()
        _log_fabric_change("Created", {
            "id": new_id, "product": prod[0].get("name"),
            "style_name": style_name, "qty": qty, "uom": uom,
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
# purely for eyeballing physical stock. Editing is admin-only (enforced in the
# api_pg auth gate on the POST method); the GET is broadly viewable like the rest
# of Fabric BI.
_ROLL_TZ = "Africa/Nairobi"

@fabric_router.get("/api/fabric/rolls")
def rolls_list(
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

        return {"total": total, "items": rows}

@fabric_router.post("/api/fabric/rolls")
def set_roll_count(request: Request, body: dict = Body(...)):
    """Upsert a manual roll count for a (product, location). Admin-only — the
    write is gated server-side in the api_pg auth gate; client hiding of the edit
    controls is not the enforcement point."""
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
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_po_pricing (
                po_id           BIGINT PRIMARY KEY,
                yuan_to_usd     NUMERIC,
                usd_to_kes      NUMERIC,
                updated_by_name TEXT,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
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
        # One-time markers for receiving data migrations (idempotent — prod is
        # a separate DB and picks these up on first touch after publish).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fabric_recv_migrations (
                key TEXT PRIMARY KEY,
                at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
    conn.commit()
    _migrate_recv_one_sheet_per_po(conn)
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

def _recv_quality_only(request):
    """True when this user is restricted to quality-only receiving edits.
    A full fabric admin is never quality-only (admin wins)."""
    u = getattr(request.state, "user", None) or {}
    if _fabric_full_admin(u):
        return False
    return (u.get("email") or "").strip().lower() in _RECV_QUALITY_ONLY_EMAILS

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
    can_approve_delivery: True for fabric_quality_supervisor + admin roles."""
    return {"admin": _recv_is_admin(request),
            "quality_only": _recv_quality_only(request),
            "can_approve_delivery": _insp_can_approve(request)}


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
                  json.dumps({"po_name": sheet.get("po_name") or ""}),
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
# <= 3in = 1pt, 3–6 = 2, 6–9 = 3, > 9in OR any hole = 4. Max 4 pts/defect.
def _insp_defect_points(size_in, is_hole):
    if is_hole:
        return 4
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

_INSP_DEFECT_TYPES = {"Hole", "Slub", "Stain", "Shade variation", "Misweave",
                      "Broken pick", "Knot", "Barre", "Crease", "Dye spot",
                      "Selvage defect", "Snag", "Other"}

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
    out, total = [], 0
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
        pts = _insp_defect_points(size, is_hole)
        total += pts
        out.append({"location_yd": loc, "defect_type": dtype,
                    "size_in": size, "side": side, "points": pts})
    return out, total

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

def _insp_score(total_points, width_in, yards):
    """Points per 100 sq.yd = points × 3600 ÷ (width_in × yards). None when
    width/yards are missing or zero (score not computable yet)."""
    if not width_in or not yards or width_in <= 0 or yards <= 0:
        return None
    return round(float(total_points) * 3600.0 / (float(width_in) * float(yards)), 2)

def _insp_enforce_source_width(ctx, fields):
    """When the roll has a measured width at source, the ticket's width is a
    READ-ONLY prefill: ignore any client-sent value and use the source width
    (width_measured_m × 39.37 in). Width stays fillable only when absent."""
    w_m = ctx.get("width_measured_m")
    if w_m not in (None, ""):
        try:
            fields["width_inches"] = round(float(w_m) * 39.37, 1)
        except (TypeError, ValueError):
            pass
    return fields

def _insp_roll_ctx(conn, roll_id):
    rows = q(conn, """
        SELECT r.id as roll_id, r.sheet_id, r.roll_no, r.qty_kg,
               r.length_yards, r.width_measured_m, r.quality_status,
               r.quality_notes, r.shrinkage_inches, r.bleeding_test,
               r.after_wash_width_cm, r.after_wash_length_cm,
               s.po_id, s.po_name, s.product_id, s.fabric_name, s.barcode
        FROM fabric_receiving_rolls r
        JOIN fabric_receiving_sheets s ON s.id = r.sheet_id
        WHERE r.id=%s AND r.deleted_at IS NULL AND s.deleted_at IS NULL
    """, (roll_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="roll not found")
    return rows[0]

_INSP_TEXT_FIELDS = ("style_article", "construction", "color", "lot_batch",
                     "buyer", "inspector_name", "face_back", "remarks",
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
    f["width_inches"] = _insp_num(body.get("width_inches"), "width (inches)")
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
    for k in ("yards_inspected", "width_inches", "acceptable_limit",
              "total_points", "points_per_100"):
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
    width_m = ctx.get("width_measured_m")
    width_in = round(float(width_m) * 39.37, 1) if width_m not in (None, "") else None
    kg = float(ctx["qty_kg"]) if ctx.get("qty_kg") is not None else None
    yards = float(ctx["length_yards"]) if ctx.get("length_yards") not in (None, "") else None
    u = getattr(request.state, "user", None) or {}
    return {
        "roll": {"roll_id": ctx["roll_id"], "sheet_id": ctx["sheet_id"],
                 "roll_no": ctx["roll_no"], "qty_kg": kg,
                 "length_yards": yards, "width_inches": width_in,
                 "quality_status": ctx.get("quality_status"),
                 "quality_notes": ctx.get("quality_notes"),
                 "shrinkage_inches": (float(ctx["shrinkage_inches"])
                                      if ctx.get("shrinkage_inches") not in (None, "") else None),
                 "bleeding_test": ctx.get("bleeding_test"),
                 "width_measured_m": (float(ctx["width_measured_m"])
                                      if ctx.get("width_measured_m") not in (None, "") else None),
                 "after_wash_width_cm": (float(ctx["after_wash_width_cm"])
                                         if ctx.get("after_wash_width_cm") not in (None, "") else None),
                 "after_wash_length_cm": (float(ctx["after_wash_length_cm"])
                                          if ctx.get("after_wash_length_cm") not in (None, "") else None)},
        "po": {"po_id": ctx.get("po_id"), "po_name": ctx.get("po_name")},
        "fabric": {"name": ctx.get("fabric_name"), "barcode": ctx.get("barcode")},
        "prefill": {"supplier": supplier, "supplier_source": supplier_src,
                    "color": color, "construction": construction,
                    "style_article": None, "lot_batch": None, "buyer": None},
        "resolved": {"supplier": bool(supplier), "color": bool(color),
                     "construction": bool(construction),
                     "style_article": False, "lot_batch": False,
                     "buyer": False, "width": width_in is not None,
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
    notes = str(body.get("quality_notes") or "").strip() or None \
        if "quality_notes" in body else (ctx.get("quality_notes") or None)
    if not _recv_meas_changed(ctx, meas) and \
       (ctx.get("quality_notes") or None) == notes:
        return
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE fabric_receiving_rolls
               SET length_yards=%s, shrinkage_inches=%s, width_measured_m=%s,
                   after_wash_width_cm=%s, after_wash_length_cm=%s,
                   bleeding_test=%s, quality_notes=%s,
                   quality_updated_at=now(), quality_updated_by=%s
             WHERE id=%s AND deleted_at IS NULL
        """, (meas["length_yards"], meas["shrinkage_inches"],
              meas["width_measured_m"], meas["after_wash_width_cm"],
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
                detail="Fabric width (inches) is required to submit")
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
        common = (fields["style_article"], fields["construction"],
                  fields["color"], fields["lot_batch"], fields["buyer"],
                  fields["yards_inspected"], fields["width_inches"],
                  fields["inspector_name"], fields["inspection_date"],
                  fields["face_back"],
                  psycopg2.extras.Json(defects), limit,
                  fields["remarks"], fields["discrepancy_note"],
                  total_points, pp100, grade)
        if latest and latest["status"] == "Draft":
            cur.execute("""
                UPDATE fabric_inspection_tickets SET
                    style_article=%s, construction=%s, color=%s,
                    lot_batch=%s, buyer=%s, yards_inspected=%s,
                    width_inches=%s, inspector_name=%s, inspection_date=%s,
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
                     status, style_article, construction, color, lot_batch,
                     buyer, yards_inspected, width_inches, inspector_name,
                     inspection_date, face_back, defects, acceptable_limit,
                     remarks, discrepancy_note, total_points, points_per_100,
                     grade, created_by)
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

def _recv_po_locked(conn, po_id):
    """A PO's rolls/quantities are LOCKED once it has at least one SUCCESSFUL
    Odoo upload. Failed attempts do not lock."""
    if po_id is None:
        return False
    rows = q(conn, "SELECT 1 FROM fabric_po_uploads "
                   "WHERE po_id=%s AND status='success' LIMIT 1", (po_id,))
    return bool(rows)

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
                      "OR s.po_name ILIKE %s)")
            like = f"%{term}%"
            params = [like, like, like]
        rows = q(conn, f"""
            SELECT s.id, s.product_id, s.barcode, s.fabric_name,
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
            SELECT s.id, s.fabric_name, s.barcode, s.po_id, s.po_name,
                   s.total_kg, s.rolls_count, s.deleted_by,
                   to_char(s.deleted_at AT TIME ZONE 'Africa/Nairobi',
                           'DD Mon YYYY, HH24:MI') as deleted_at,
                   GREATEST(0, %s - EXTRACT(day FROM now() - s.deleted_at)::int)
                     as days_left
            FROM fabric_receiving_sheets s
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
    """All live sheets + rolls of one PO, ordered for the printable sheet."""
    sheets = q(conn, """
        SELECT s.id, s.fabric_name, s.barcode, s.kg_per_mtr,
               s.total_kg, s.total_mtrs, s.rolls_count, s.note,
               s.po_id, s.po_name,
               to_char(s.po_date, 'DD Mon YYYY') as po_date,
               s.created_by_name,
               to_char(s.created_at AT TIME ZONE 'Africa/Nairobi',
                       'DD Mon YYYY, HH24:MI') as created_at
        FROM fabric_receiving_sheets s
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
    return sheets, by_sheet

_RECV_DL_HEADERS = ["Roll #", "Kgs", "Metres", "Length (yds)",
                    "Shrink W", "Shrink L", "Bleeding test", "Width (m)",
                    "Quality", "Notes"]

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

def _recv_dl_row(r):
    def _n(v):
        return float(v) if v not in (None, "") else None
    sw, sl = _recv_dl_shrink_cells(r)
    return [int(r["roll_no"]), _n(r["qty_kg"]), _n(r["qty_mtrs"]),
            _n(r.get("length_yards")), sw, sl,
            (r.get("bleeding_test") or ""), _n(r.get("width_measured_m")),
            (r.get("quality_status") or "Pending"),
            (r.get("quality_notes") or "")]

def _recv_build_xlsx(sheets, by_sheet):
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
        total_kg = 0.0
        for r in by_sheet.get(s["id"], []):
            ws.append(_recv_dl_row(r))
            total_kg += float(r["qty_kg"] or 0)
        ws.append(["Total", round(total_kg, 3),
                   float(s["total_mtrs"]) if s.get("total_mtrs") not in (None, "") else None])
        ws.cell(row=ws.max_row, column=1).font = bold
        ws.cell(row=ws.max_row, column=2).font = bold
        ws.append([])
    widths = [8, 10, 10, 13, 16, 16, 16, 10, 10, 30]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

def _recv_build_pdf(sheets, by_sheet):
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
    for s in sheets:
        title = (s.get("fabric_name") or "") + \
                (f"  [{s.get('barcode')}]" if s.get("barcode") else "")
        story.append(Paragraph(title, h2))
        story.append(Paragraph(
            f"Received by {s.get('created_by_name') or '—'} on "
            f"{s.get('created_at') or '—'}"
            + (f" — note: {s.get('note')}" if s.get("note") else ""), small))
        data = [_RECV_DL_HEADERS]
        total_kg = 0.0
        for r in by_sheet.get(s["id"], []):
            row = _recv_dl_row(r)
            row[-1] = Paragraph(str(row[-1]), cell)
            data.append(["" if v is None else v for v in row])
            total_kg += float(r["qty_kg"] or 0)
        tm = s.get("total_mtrs")
        data.append(["Total", round(total_kg, 3),
                     "" if tm in (None, "") else float(tm),
                     "", "", "", "", "", "", ""])
        t = Table(data, repeatRows=1,
                  colWidths=[15*mm, 17*mm, 17*mm, 21*mm, 27*mm, 27*mm,
                             30*mm, 17*mm, 19*mm, 78*mm])
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
        sheets, by_sheet = _recv_download_data(conn, po_id)
    po_name = (sheets[0].get("po_name") or f"PO-{po_id}").replace("/", "-")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", po_name)
    try:
        if fmt == "xlsx":
            payload = _recv_build_xlsx(sheets, by_sheet)
            media = ("application/vnd.openxmlformats-officedocument"
                     ".spreadsheetml.sheet")
            fname = f"receiving_{safe}.xlsx"
        else:
            payload = _recv_build_pdf(sheets, by_sheet)
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
    """The saved Yuan pricing for one PO: the two FX rates + the per-price-key
    Yuan prices/quote units, normalized (only positive numbers count as set)."""
    head_rows = q(conn, """
        SELECT yuan_to_usd, usd_to_kes, updated_by_name,
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
        "updated_by_name": head.get("updated_by_name"),
        "updated_at": head.get("updated_at"),
        "items": {r["price_key"]: {
                      "yuan_price": _recv_po_num(r["yuan_price"]),
                      "quote_unit": (r["quote_unit"]
                                     if r["quote_unit"] in _PO_QUOTE_UNITS
                                     else "kg")}
                  for r in item_rows},
    }

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
            g = {"price_key": key,
                 "code": e.get("supplier_fabric_code"),
                 "yuan_price": e.get("yuan_price"),
                 "quote_unit": e.get("quote_unit") or "kg",
                 "products": []}
            groups[key] = g
            order.append(key)
        g["products"].append({
            "product_id": e.get("product_id"),
            "fabric_name": e.get("fabric_name"),
            "barcode": e.get("barcode"),
            "line_uom": e.get("line_uom"),
            "line_kind": _po_uom_kind(e.get("line_uom")),
            "kg_per_mtr": e.get("kg_per_mtr"),
            "action": e.get("action"),
        })
    return [groups[k] for k in order]

def _recv_po_plan(conn, odoo, po_id):
    """Build the per-product upload plan for a PO batch: summed sheet totals
    (kg always; metres via the LIVE kg_per_mtr_eff), the matching PO line,
    exactly what would be pushed in the line's own unit AND the KES unit price
    computed from the saved per-PO Yuan pricing. Returns (plan, po_lines,
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
        e = {"product_id": pid,
             "fabric_name": t.get("fabric_name"),
             "barcode": t.get("barcode"),
             "sheets": int(t.get("sheets") or 0),
             "total_kg": kg, "total_mtrs": mtrs,
             "kg_per_mtr": kpm,
             "supplier_fabric_code": sfc,
             "price_key": f"code:{sfc}" if sfc else f"product:{pid}",
             "yuan_price": None, "quote_unit": "kg",
             "push_price": None, "price_missing": False,
             "action": None, "flags": [],
             "line_id": None, "line_qty": None, "line_uom": None,
             "push_qty": None, "push_uom": None}
        it = pricing["items"].get(e["price_key"]) or {}
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
        # Price: Yuan quote → the PO line's OWN unit → KES via the two rates.
        # A cross-unit quote (per-kg on a metre line or per-metre on a kg
        # line) needs the fabric's live kg/m factor; without one the product
        # is BLOCKED (same pattern as the quantity block) — never guessed.
        # Missing rates / missing Yuan price do not block per-product; they
        # block the WHOLE upload (the pricing form must be completed first).
        if e["action"] in ("update", "create"):
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
            elif yp is None or y2u is None or u2k is None:
                e["price_missing"] = True
                e["flags"].append(
                    "Yuan price / FX rates not entered yet — complete the "
                    "pricing form before uploading")
            else:
                unit_yuan = yp
                if qu == "kg" and kind == "m":
                    unit_yuan = yp * kpm
                elif qu == "m" and kind == "kg":
                    unit_yuan = yp / kpm
                # yuan_to_usd is quoted as Yuan PER USD (e.g. 7.9998), so
                # Yuan → USD is a DIVISION; USD → KES is a multiplication.
                e["push_price"] = round(unit_yuan / y2u * u2k, 4)
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

@fabric_router.get("/api/fabric/receiving/po-batches")
def receiving_po_batches():
    """POs that have at least one linked receiving sheet (Postgres only — no
    Odoo round-trip), with sheet/product counts, summed kgs and the latest
    upload attempt, for the batches table on the Receiving tab."""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, """
            WITH g AS (
                SELECT s.po_id,
                       MAX(s.po_name)  as po_name,
                       MAX(s.po_date)  as po_date,
                       COUNT(*)        as sheets,
                       COUNT(DISTINCT s.product_id) as products,
                       SUM(s.total_kg) as total_kg
                FROM fabric_receiving_sheets s
                WHERE s.po_id IS NOT NULL AND s.deleted_at IS NULL
                GROUP BY s.po_id
            ),
            rc AS (
                SELECT s.po_id, COUNT(r.id) as rolls
                FROM fabric_receiving_sheets s
                JOIN fabric_receiving_rolls r
                     ON r.sheet_id = s.id AND r.deleted_at IS NULL
                WHERE s.po_id IS NOT NULL AND s.deleted_at IS NULL
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
                SELECT status, uploaded_by_name, uploaded_at
                FROM fabric_po_uploads u
                WHERE u.po_id = g.po_id
                ORDER BY u.id DESC LIMIT 1
            ) lu ON true
            ORDER BY g.po_date DESC NULLS LAST, g.po_id DESC
        """)
        # Legacy sheets saved before the PO link became mandatory: surface
        # them as one "No PO" group row so they stay reachable (no upload).
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
    no_po_group = None
    if nopo and int(nopo[0].get("sheets") or 0) > 0:
        no_po_group = {"po_id": None, "po_name": None, "po_date": None,
                       "sheets": int(nopo[0]["sheets"]),
                       "products": int(nopo[0]["products"] or 0),
                       "total_kg": nopo[0]["total_kg"],
                       "rolls": int(nopo[0].get("rolls") or 0),
                       "last_upload_status": None, "last_uploaded_by": None,
                       "last_uploaded_at": None}
    return {"items": rows, "no_po": no_po_group}

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
            SELECT s.id, s.product_id, s.barcode, s.fabric_name,
                   s.total_kg, s.total_mtrs, s.rolls_count, s.note,
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
                       r.quality_status, r.quality_notes,
                       r.length_yards, r.shrinkage_inches,
                       r.bleeding_test, r.width_measured_m,
                       r.after_wash_width_cm, r.after_wash_length_cm,
                       t.grade as insp_grade, t.version as insp_version,
                       t.points_per_100 as insp_points,
                       (t.approved_at IS NOT NULL) as insp_approved
                FROM fabric_receiving_rolls r
                LEFT JOIN LATERAL (
                    SELECT grade, version, points_per_100, approved_at
                    FROM fabric_inspection_tickets t
                    WHERE t.sheet_id = r.sheet_id AND t.roll_no = r.roll_no
                      AND t.status = 'Submitted'
                    ORDER BY t.version DESC, t.id DESC LIMIT 1
                ) t ON TRUE
                WHERE r.sheet_id = ANY(%s) AND r.deleted_at IS NULL
                ORDER BY r.sheet_id, r.roll_no, r.id
            """, ([int(s["id"]) for s in sheets],))
        # Lock state + the who/what/when trail (roll changes merged with the
        # Odoo upload history, newest first) for this PO group.
        locked, audit, po_sheet = False, [], None
        if params:  # a real PO id (not the legacy "No PO" group)
            ps = q(conn, """
                SELECT id, po_name,
                       to_char(po_date, 'DD Mon YYYY') as po_date,
                       created_by_name,
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
    rolls_by_sheet = {}
    for r in rolls:
        rolls_by_sheet.setdefault(r["sheet_id"], []).append(
            {k: r[k] for k in ("roll_id", "roll_no", "qty_kg", "qty_mtrs",
                               "quality_status", "quality_notes",
                               "length_yards", "shrinkage_inches",
                               "bleeding_test", "width_measured_m",
                               "after_wash_width_cm", "after_wash_length_cm",
                               "insp_grade", "insp_version", "insp_points",
                               "insp_approved")})
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
        g["sheets"].append(sd)
    out = []
    for key in order:
        g = fabrics[key]
        g["total_kg"] = round(g["total_kg"], 3)
        g["total_mtrs"] = None if g["mtrs_missing"] else round(g["total_mtrs"], 1)
        out.append(g)
    out.sort(key=lambda g: (g.get("fabric_name") or "").lower())
    return {"fabrics": out, "locked": locked, "audit": audit,
            "po_sheet": po_sheet}

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
    for e in plan:  # strip create-only internals from the response
        e.pop("_uom_id", None); e.pop("_price", None); e.pop("_odoo_name", None)
    pricing["groups"] = _recv_pricing_groups(plan)
    pricing.pop("items", None)  # the groups carry the saved values
    return {"po": po, "plan": plan, "lines": po_lines, "sheets": sheets,
            "pricing": pricing, "last_upload": last[0] if last else None}

@fabric_router.post("/api/fabric/receiving/po-batch/{po_id}/pricing")
def receiving_po_pricing_save(po_id: int, request: Request,
                              body: dict = Body(...)):
    """Save the per-PO Yuan pricing form: the two FX rates (Yuan→USD and
    USD→KES) plus one Yuan price + quote unit per price key. Values persist
    per PO (survive reload, reused on re-upload) and stay editable until the
    upload. Empty/zero inputs are stored as NULL ('not set yet')."""
    _recv_block_quality_only(request)
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
                    detail=f"pricing row {i}: Yuan price must be a number")
            if not (yp > 0):
                raise HTTPException(status_code=400,
                    detail=f"pricing row {i}: Yuan price must be greater "
                           "than zero")
        items.append((key, yp, qu))
    _uid, name = _fabric_actor(request)
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_po_pricing
                  (po_id, yuan_to_usd, usd_to_kes, updated_by_name, updated_at)
                VALUES (%s,%s,%s,%s,now())
                ON CONFLICT (po_id) DO UPDATE SET
                  yuan_to_usd=EXCLUDED.yuan_to_usd,
                  usd_to_kes=EXCLUDED.usd_to_kes,
                  updated_by_name=EXCLUDED.updated_by_name,
                  updated_at=now()
            """, (po_id, y2u, u2k, name))
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
        # Pricing gate: BOTH FX rates and a Yuan price for every product that
        # would actually be pushed must be in place before anything is
        # written. Blocked products (quantity or conversion blocks) are
        # excluded — they never reach Odoo anyway.
        missing_bits = []
        if pricing["yuan_to_usd"] is None or pricing["usd_to_kes"] is None:
            missing_bits.append("both FX rates (Yuan→USD and USD→KES)")
        unpriced = sorted({(e.get("fabric_name") or e.get("barcode")
                            or f"product {e['product_id']}")
                           for e in plan
                           if e["action"] in ("update", "create")
                           and e.get("push_price") is None})
        if unpriced:
            missing_bits.append("a Yuan price for: " + ", ".join(unpriced))
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
                      "pricing": {"yuan_to_usd": pricing["yuan_to_usd"],
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
    landed_cost_ok=True) and the general journals with a suggested default
    (Miscellaneous Operations, Odoo's usual landed-cost journal)."""
    odoo = _odoo_connect()
    prods = _lc_kw(odoo, "product.product", "search_read",
                   [[["landed_cost_ok", "=", True]]],
                   {"fields": ["display_name"], "order": "name",
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
    return {"cost_types": [{"id": p["id"], "name": p["display_name"]}
                           for p in prods],
            "journals": [{"id": j["id"], "name": j["name"], "code": j["code"]}
                         for j in journals],
            "default_journal_id": default_id}

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
        lines.append({"product_id": pid,
                      "name": str(ln.get("name") or "").strip() or None,
                      "mode": mode, "amount": amount, "fx_rate": rate,
                      "kes": kes})
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
            "split_method": "by_current_cost_price",
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
                           "fx_rate": l["fx_rate"], "kes": l["kes"]}
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
                   s.note, s.created_by_name, s.updated_by_name,
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
                   quality_status, quality_notes, quality_updated_by,
                   length_yards, shrinkage_inches,
                   bleeding_test, width_measured_m,
                   after_wash_width_cm, after_wash_length_cm,
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
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        exists = q(conn, "SELECT id, fabric_name, po_id "
                         "FROM fabric_receiving_sheets "
                         "WHERE id=%s AND deleted_at IS NULL", (sheet_id,))
        if not exists:
            raise HTTPException(status_code=404, detail="receiving sheet not found")
        po_id = exists[0].get("po_id")
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
                roll_id = it.get("roll_id")
                roll_no = it.get("roll_no")
                # Look up the current values first so we can (a) skip no-op
                # writes and (b) audit the old -> new change.
                _q_cols = ("id, roll_no, quality_status, quality_notes, "
                           "length_yards, shrinkage_inches, bleeding_test, "
                           "width_measured_m, after_wash_width_cm, "
                           "after_wash_length_cm")
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
                if (o.get("quality_status") or None) == status and \
                   (o.get("quality_notes") or None) == notes and \
                   not _recv_meas_changed(o, meas):
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
                           quality_updated_at=now(), quality_updated_by=%s
                     WHERE id=%s AND sheet_id=%s
                """, (status, notes,
                      meas["length_yards"], meas["shrinkage_inches"],
                      meas["bleeding_test"], meas["width_measured_m"],
                      meas["after_wash_width_cm"], meas["after_wash_length_cm"],
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
           not any(k in r for k in _RECV_MEAS_NUM) and "bleeding_test" not in r:
            continue  # roll carries no explicit quality edit → fall back to prev
        try:
            rn = int(r.get("roll_no"))
        except (TypeError, ValueError):
            continue
        st = (str(r.get("status") or "").strip() or None)
        if st is not None and st not in _RECV_QUALITY_STATUSES:
            raise HTTPException(status_code=400,
                detail=f"status must be one of {', '.join(_RECV_QUALITY_STATUSES)}")
        q_in[rn] = {"status": st,
                    "notes": (str(r.get("notes") or "").strip() or None),
                    "meas": _recv_parse_measurements(r)}
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
                       "after_wash_length_cm "
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
                cur.execute("""
                    INSERT INTO fabric_receiving_rolls
                      (sheet_id, roll_no, qty_kg, qty_mtrs,
                       quality_status, quality_notes,
                       length_yards, shrinkage_inches,
                       bleeding_test, width_measured_m,
                       after_wash_width_cm, after_wash_length_cm,
                       quality_updated_by, quality_updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                            COALESCE(%s, CASE WHEN %s THEN now() ELSE NULL END))
                """, (sheet_id, roll_no, qty_kg,
                      round(qty_kg / kpm, 2) if kpm else None,
                      q_status, q_notes,
                      q_meas["length_yards"], q_meas["shrinkage_inches"],
                      q_meas["bleeding_test"], q_meas["width_measured_m"],
                      q_meas["after_wash_width_cm"], q_meas["after_wash_length_cm"],
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
                     status: str = Query(default="")):
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
    extra = (" AND " + " AND ".join(where)) if where else ""
    with _get_conn() as conn:
        _ensure_receiving_tables(conn)
        rows = q(conn, f"""
            SELECT r.roll_no, r.qty_kg, r.quality_status, r.quality_notes,
                   r.quality_updated_by, r.quality_updated_at,
                   r.length_yards, r.shrinkage_inches, r.bleeding_test,
                   r.width_measured_m, r.after_wash_width_cm, r.after_wash_length_cm,
                   s.id as sheet_id, s.fabric_name, s.barcode, s.po_name,
                   COALESCE(s.po_date, (s.created_at AT TIME ZONE 'Africa/Nairobi')::date) as recv_date,
                   p.width_m as expected_width_m,
                   COALESCE(
                     (SELECT MAX(NULLIF(po.supplier,''))
                        FROM raw_fabric_purchase_orders po
                       WHERE po.po_name = s.po_name AND s.po_name IS NOT NULL),
                     'No PO / unknown') as supplier
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
                   COALESCE(
                     (SELECT MAX(NULLIF(po.supplier,''))
                        FROM raw_fabric_purchase_orders po
                       WHERE po.po_name = s.po_name AND s.po_name IS NOT NULL),
                     'No PO / unknown') as supplier,
                   s.fabric_name
            FROM fabric_receiving_sheets s
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
            detail.append({
                "sheet_id": r.get("sheet_id"),
                "po_name": r.get("po_name"),
                "supplier": r.get("supplier"),
                "fabric_name": r.get("fabric_name"),
                "barcode": r.get("barcode"),
                "roll_no": r.get("roll_no"),
                "recv_date": rd_iso,
                "status": stt,
                "qty_kg": float(r["qty_kg"]) if r.get("qty_kg") is not None else None,
                "length_yards": float(r["length_yards"]) if r.get("length_yards") not in (None, "") else None,
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


if __name__ == "__main__":
    # Standalone one-time backfill of the Months-of-Cover daily snapshot. The
    # writer is idempotent (upserts on today's EAT capture date), so this is safe
    # to run manually against any DB (opens its own connection from DATABASE_URL).
    snap = write_cover_snapshot()
    print("Fabric cover snapshot written:", snap)
