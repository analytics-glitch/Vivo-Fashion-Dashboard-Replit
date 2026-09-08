import xmlrpc.client, os, sys, psycopg2, logging
from psycopg2.extras import execute_values
from datetime import datetime, timedelta
from collections import Counter
import json
import math
import re

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Exit-code convention (consumed by fabric_worker_loop in sync_incremental.py
# and the watchdog's run_fabric_recovery) ────────────────────────────────────
#   0 = success  (extract ran; raw_fabric_* refreshed, _loaded_at advanced)
#   1 = error    (uncaught exception — Python's default for a crashed run)
#   3 = skipped  (another fabric run holds the pg advisory lock; NOTHING was
#       extracted and _loaded_at did NOT advance, so callers must not treat
#       this as a successful pull — no heartbeat, no freshness credit)
EXIT_OK = 0
EXIT_SKIPPED_LOCK = 3

ODOO_URL      = os.environ['ODOO_URL']
ODOO_DB       = os.environ['ODOO_DB']
ODOO_USER     = os.environ['ODOO_USER']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']
DATABASE_URL  = os.environ['DATABASE_URL']
FABRIC_CATS   = [18, 19]  # 18=Raw Materials-Fabric, 19=Accessories & Trims

def odoo_connect():
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models

def create_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS raw_fabric_products (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            default_code    TEXT,
            category        TEXT,
            uom             TEXT,
            standard_price  NUMERIC,
            active          BOOLEAN,
            write_date      TIMESTAMP,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_inventory (
            id              BIGINT PRIMARY KEY,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            location_id     BIGINT,
            location_name   TEXT,
            quantity        NUMERIC,
            reserved_qty    NUMERIC,
            available       NUMERIC,
            uom             TEXT,
            standard_price  NUMERIC,
            total_value     NUMERIC,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_boms (
            id                      BIGINT PRIMARY KEY,
            bom_id                  BIGINT,
            finished_product_name   TEXT,
            finished_product_sku    TEXT,
            component_id            BIGINT,
            component_name          TEXT,
            component_sku           TEXT,
            component_qty           NUMERIC,
            component_uom           TEXT,
            _loaded_at              TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_moves (
            id              BIGINT PRIMARY KEY,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            qty             NUMERIC,
            uom             TEXT,
            location_from   TEXT,
            location_to     TEXT,
            move_type       TEXT,
            date            TIMESTAMP,
            reference       TEXT,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_fabric_purchase_orders (
            id              BIGINT PRIMARY KEY,
            po_id           BIGINT,
            po_name         TEXT,
            supplier        TEXT,
            order_date      DATE,
            product_id      BIGINT,
            product_name    TEXT,
            product_sku     TEXT,
            qty_ordered     NUMERIC,
            qty_received    NUMERIC,
            qty_invoiced    NUMERIC,
            price_unit      NUMERIC,
            total_value     NUMERIC,
            uom             TEXT,
            date_planned    DATE,
            state           TEXT,
            category        TEXT,
            _loaded_at      TIMESTAMP
        );
    """)
    log.info("Tables ready")

FABRIC_COLORS = [
    'Black','White','Navy Blue','Navy','Red','Dark Red','Burgundy','Maroon',
    'Mustard','Yellow','Olive','Dark Olive','Light Olive','Olive Green',
    'Green','Dark Green','Light Green','Sea Green','Mint Green','Mint',
    'Blue','Dark Blue','Light Blue','Sky Blue','Teal','Dark Teal','Turquoise',
    'Pink','Dark Pink','Light Pink','Dusty Pink','Hot Pink','Rose',
    'Purple','Lilac','Lavender','Plum','Mauve',
    'Orange','Dark Orange','Rust','Burnt Orange','Coral',
    'Brown','Dark Brown','Chocolate','Caramel','Tan','Taupe','Dark Taupe',
    'Grey','Gray','Dark Grey','Light Grey','Mid Grey','Charcoal',
    'Cream','Ivory','Off White','Beige','Sand','Nude','Ecru',
    'Camel','Khaki','Stone','Blush','Salmon','Peach',
    'Multicolor','Multi','Print','Stripe','Check','Checked',
    'Light Navy','Dark Navy','Dark Mustard','Light Mustard',
]
_COLORS_SORTED = sorted(set(FABRIC_COLORS), key=len, reverse=True)

def _derive_color(name):
    import re
    for color in _COLORS_SORTED:
        if re.search(r"\b" + re.escape(color) + r"\b", name or "", re.IGNORECASE):
            return color.title()
    return None

def _props_by_label(props):
    """Odoo `properties`-type field → {label: value}. The fabric master carries its
    dedicated Fabric Name / Fabric Supplier Name / Fabric Colour custom fields inside
    `product_properties` (a list of {name,string,value} dicts keyed off a parent
    definition), NOT as top-level x_vivo_* columns. Blank/False → dropped so callers
    can COALESCE cleanly to their fallback."""
    out = {}
    if isinstance(props, list):
        for p in props:
            if isinstance(p, dict) and p.get("string") is not None:
                v = p.get("value")
                if isinstance(v, str):
                    v = v.strip() or None
                if v:
                    out[p["string"]] = v
                    out[_label_key(p["string"])] = v
    return out


def _normalize_yes(value):
    """Normalize an Odoo Yes/No property to a strict boolean.

    Only the explicit display value ``Yes`` qualifies. Empty values, booleans,
    numbers, and every other label are false so a malformed catalogue value
    cannot accidentally enter the NOOS universe.
    """
    value = _odoo_value(value)
    if isinstance(value, str):
        return value.strip().casefold() == "yes"
    return False


# Odoo Studio field ids are configuration data, not an API contract.  Keep the
# business vocabulary here and resolve the live x_* field names from fields_get
# for every product-master pull.  The aliases deliberately tolerate the small
# label changes made by Studio (capitalisation, punctuation, and "(m)" suffixes).
#
# One display label may legitimately be carried by SEVERAL live fields at once:
# the catalogue exposes both a dedicated attribute GSM (many2one) and a plain
# text GSM (char) under the exact same "GSM" label. That is valid configuration,
# not an error — the resolver keeps every such candidate in a deterministic,
# type-aware preference order (dedicated attribute first, free text last) and
# the product pull walks that order per product, so the attribute value wins
# whenever it is populated and the text value only fills the gaps.
FABRIC_ATTRIBUTE_SPECS = {
    "kg_per_mtr": (("Kg/Mtr", "Kg / Mtr", "KG/MTR"), False),
    "width_m": (
        ("Width (m)", "Width", "Width (M)",
         "Width (m) - From Fabric Reference",
         "Width - From Fabric Reference"),
        True,
    ),
    "gsm": (
        ("GSM", "GSM (g/m²)", "GSM (g/m2)",
         "GSM - From Fabric Reference",
         "GSM (g/m²) - From Fabric Reference",
         "GSM (g/m2) - From Fabric Reference"),
        True,
    ),
    "plain_print": (("Plain/Print", "Plain / Print"), False),
    "fabric_structure": (("Fabric Structure",), False),
    "fabric_category": (("Fabric Category",), False),
    "fabric_subcategory": (("Fabric Sub-Category", "Fabric Subcategory"), False),
    "stretch_type": (("Stretch Type",), False),
    "weight_range": (("Weight Range",), False),
    "fiber_content": (("Fiber Content %", "Fibre Content %", "Fiber Content", "Fibre Content"), False),
    "fabric_type": (("Fabric Type",), False),
    "supplier": (("Vendor/Supplier", "Supplier", "Vendor"), False),
    "supplier_fabric_code": (("Supplier Fabric Code",), False),
    "primary_color": (("Primary Color", "Primary Colour"), False),
    "source_city": (("Source City",), False),
    "source_country": (("Source Country",), False),
    "noos_fabric": (("NOOS Fabric",), False),
}


def _label_key(value):
    """Normalize an Odoo display label for stable, punctuation-free matching."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower().replace("²", "2"))


# Preference order when SEVERAL live Odoo fields carry the same display label:
# a dedicated attribute / selection field is the primary source, a plain
# numeric field is next, and a free-text field is the safe fallback. Two
# fields at the SAME rank under the same label are genuinely indistinguishable
# — the resolver refuses to guess between them.
_TYPE_RANK = {
    "many2one": 0, "many2many": 0, "one2many": 0, "reference": 0,
    "selection": 0,
    "float": 1, "integer": 1, "monetary": 1,
    "char": 2, "text": 2, "html": 2,
}
_TYPE_RANK_OTHER = 3


def resolve_fabric_fields(field_metadata):
    """Return concept -> ORDERED live product.product field names (best first).

    Optional attributes may be absent during a staged Odoo configuration
    change, but Width and GSM are conversion-critical and must resolve to at
    least one unambiguous source. A duplicate display label is a VALID
    configuration (the live catalogue carries an attribute-backed GSM and a
    text GSM under the same "GSM" label): every candidate is kept, ordered by
    source-alias order then _TYPE_RANK, and the product pull tries them per product
    in that order (see _fabric_value_from). Raising before search_read /
    TRUNCATE remains the fail-safe when a conversion-critical concept is
    missing entirely or its best candidates are genuinely indistinguishable
    (same label AND same type rank) — no Fabric master rows are changed then.
    """
    by_label = {}
    for name, meta in (field_metadata or {}).items():
        if not isinstance(meta, dict) or not meta.get("string"):
            continue
        by_label.setdefault(_label_key(meta["string"]), []).append(name)

    def _field_type(name):
        return str((field_metadata.get(name) or {}).get("type") or "")

    resolved = {}
    problems = []
    for concept, (aliases, required) in FABRIC_ATTRIBUTE_SPECS.items():
        seen = set()
        # Direct business fields must win over "From Fabric Reference" fallbacks
        # even if Odoo exposes a direct value as a less-specific type (e.g.
        # char). Within one business-label alias, type rank breaks the tie.
        cands = []  # (alias_rank, type_rank, field_name) — sorted = preference
        for alias_rank, alias in enumerate(aliases):
            for name in by_label.get(_label_key(alias), []):
                if name in seen:
                    continue
                seen.add(name)
                cands.append((
                    alias_rank,
                    _TYPE_RANK.get(_field_type(name), _TYPE_RANK_OTHER),
                    name))
        cands.sort()

        ordered, tied = [], []
        i = 0
        while i < len(cands):
            j = i + 1
            while j < len(cands) and cands[j][:2] == cands[i][:2]:
                j += 1
            if j - i > 1:
                # ≥2 fields share one label AND one type rank: no safe order
                # exists from this point down — keep what was already ordered.
                tied = [c[2] for c in cands[i:]]
                break
            ordered.append(cands[i][2])
            i = j

        if tied and not ordered:
            # The would-be PRIMARY source itself is ambiguous — never guess.
            if required:
                problems.append(
                    f"{concept} ({aliases[0]}): ambiguous: " + ", ".join(tied))
            else:
                log.warning("Ignoring ambiguous optional Fabric mapping %s: %s",
                            concept, ", ".join(tied))
            continue
        if tied:
            log.warning(
                "Fabric mapping %s: dropping indistinguishable lower-preference "
                "candidate(s) %s (keeping %s)",
                concept, ", ".join(tied), " > ".join(ordered))
        if ordered:
            resolved[concept] = ordered
            log.info("Fabric Odoo mapping %s=%s", concept,
                     " > ".join(f"{n}({_field_type(n)})" for n in ordered))
        elif required:
            problems.append(f"{concept} ({aliases[0]}): missing")
    if problems:
        raise RuntimeError(
            "Fabric Odoo metadata is unsafe; conversion-critical mapping failed: "
            + "; ".join(problems)
            + ". No Fabric master rows were changed."
        )
    return resolved


def mapping_signature(resolved, field_metadata):
    """Canonical fingerprint of the current attribute source selection.

    Captures which live fields feed each business attribute, their preference
    order and their Odoo types. It is stored in fabric_sync_state after every
    successful product pull; extract_products() promotes an incremental pull
    to a FULL reconciliation whenever the current fingerprint differs from the
    stored one (new duplicate label, moved/renamed Studio field, or a code
    change to the precedence rules), so rows whose Odoo write_date predates
    the change are repaired without waiting for each product to be edited.
    """
    payload = {
        concept: [[name, str((field_metadata.get(name) or {}).get("type") or "")]
                  for name in field_names]
        for concept, field_names in (resolved or {}).items()
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


_MAPPING_STATE_KEY = "fabric_attribute_mapping"
_INCOMPLETE_RECHECK_CURSOR_KEY = "fabric_incomplete_recheck_cursor"
_INCOMPLETE_RECHECK_LIMIT = max(
    1, int(os.environ.get("FABRIC_INCOMPLETE_RECHECK_LIMIT", "2000"))
)

# Tiny key/value side table holding the last successfully-applied mapping
# fingerprint. Created lazily by extract_products so every entry path (fast /
# heavy / full bootstrap / watchdog rescue) is covered.
_FABRIC_SYNC_STATE_DDL = """
    CREATE TABLE IF NOT EXISTS fabric_sync_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMP
    )
"""


def _needs_full_reconcile(stored_signature, current_signature):
    """True when the recorded source-selection fingerprint differs or is absent."""
    return stored_signature != current_signature


def _mapping_state_changed(cur, signature):
    """Compare `signature` against the fingerprint stored in fabric_sync_state."""
    cur.execute("SELECT value FROM fabric_sync_state WHERE key = %s",
                (_MAPPING_STATE_KEY,))
    row = cur.fetchone()
    return _needs_full_reconcile(row[0] if row else None, signature)


def _incomplete_fabric_product_ids(cur):
    """Return incomplete Fabric-master rows for the fast related-field recheck.

    Some Odoo Width/GSM values are related from the Fabric Reference record.  An
    edit to that source can update the related value without advancing the
    product variant's own write_date, which would otherwise leave a false
    "missing Width/GSM" row behind until the next heavy full reconcile.  Re-read
    just the currently incomplete Fabric rows alongside the ordinary incremental
    window; once a row becomes convertible it naturally leaves this small
    recheck set.
    """
    cur.execute("SELECT value FROM fabric_sync_state WHERE key = %s",
                (_INCOMPLETE_RECHECK_CURSOR_KEY,))
    state = cur.fetchone()
    try:
        after_id = max(0, int(state[0])) if state and state[0] is not None else 0
    except (TypeError, ValueError):
        after_id = 0

    where = """
        category = 'Fabric'
        AND (COALESCE(width_m, 0) <= 0 OR COALESCE(gsm, 0) <= 0)
    """
    cur.execute(f"""
        SELECT id
        FROM raw_fabric_products
        WHERE {where} AND id > %s
        ORDER BY id
        LIMIT %s
    """, (after_id, _INCOMPLETE_RECHECK_LIMIT))
    ids = [row[0] for row in cur.fetchall()]
    if len(ids) < _INCOMPLETE_RECHECK_LIMIT:
        # Wrap after reaching the end: if the incomplete population exceeds the
        # cap, a corrected row can never be stranded behind the oldest records.
        cur.execute(f"""
            SELECT id
            FROM raw_fabric_products
            WHERE {where} AND id <= %s
            ORDER BY id
            LIMIT %s
        """, (after_id, _INCOMPLETE_RECHECK_LIMIT - len(ids)))
        ids.extend(row[0] for row in cur.fetchall())
    return ids, (ids[-1] if ids else None)


def _odoo_value(value):
    """Normalize Odoo scalar, many2one, and selection values to a display value."""
    if isinstance(value, (list, tuple)):
        return value[1] if len(value) > 1 else None
    if isinstance(value, dict):
        return value.get("display_name") or value.get("name") or value.get("string")
    return value


# Numeric attribute display values ("157", "1.70", occasionally "157 gsm")
# must become positive floats before persistence. Only magnitude-NEUTRAL unit
# suffixes are tolerated; a magnitude-changing unit (cm, mm, g/cm² …) or free
# text is rejected outright — deriving metres/cost from a misread number is
# worse than an explicit "incomplete" row.
_NUMERIC_VALUE_RE = re.compile(r"^(?P<num>[0-9][0-9.,]*)\s*(?P<unit>[a-z0-9²/%]*)$")
_NUMERIC_UNIT_SUFFIXES = frozenset((
    "gsm", "g/m2", "g/m²",
    "m", "mtr", "mtrs", "metre", "metres", "meter", "meters",
    "kg/m", "kg/mtr",
))


def _normalize_numeric(value, field_name=None):
    """Odoo display value → positive float, or None when unusable.

    Attribute display names arrive as strings ("157", "1.70"); text fields may
    carry stray whitespace, thousands separators, a decimal comma, or a
    harmless unit suffix. Odoo also marshals EMPTY fields as boolean False —
    never a number. Anything that cannot be read as a positive finite number
    (free text, unsupported units, zero/negative readings) returns None so a
    bad source falls through to the next candidate — or leaves the row
    explicitly incomplete — instead of quietly deriving a misleading metre or
    cost figure.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        num = float(value)
    else:
        text = str(value).strip().lower()
        if not text:
            return None
        m = _NUMERIC_VALUE_RE.match(text)
        if not m:
            log.warning("Non-numeric Fabric Odoo value %r for field %s",
                        value, field_name)
            return None
        num_part, unit = m.group("num"), m.group("unit") or ""
        if unit and unit not in _NUMERIC_UNIT_SUFFIXES:
            log.warning("Fabric Odoo value %r for field %s carries unsupported "
                        "unit %r — treated as unusable", value, field_name, unit)
            return None
        if "." in num_part and "," in num_part:
            num_part = num_part.replace(",", "")            # 1,234.5 → 1234.5
        elif "," in num_part:
            if re.fullmatch(r"[0-9]{1,3}(?:,[0-9]{3})+", num_part):
                num_part = num_part.replace(",", "")        # 1,234 → 1234
            elif re.fullmatch(r"[0-9]+,[0-9]+", num_part):
                num_part = num_part.replace(",", ".")       # 1,70 → 1.70
            else:
                log.warning("Non-numeric Fabric Odoo value %r for field %s",
                            value, field_name)
                return None
        try:
            num = float(num_part)
        except ValueError:
            log.warning("Non-numeric Fabric Odoo value %r for field %s",
                        value, field_name)
            return None
    if not math.isfinite(num) or num <= 0:
        # 0 is Odoo's "not set" for numeric fields — silently absent; anything
        # else non-positive/non-finite is a real reading we refuse to use.
        if num != 0:
            log.warning("Rejecting non-positive Fabric Odoo value %r for "
                        "field %s", value, field_name)
        return None
    return num


def _fabric_value(record, field_name, numeric=False):
    value = _odoo_value(record.get(field_name)) if field_name else None
    if numeric:
        return _normalize_numeric(value, field_name)
    if isinstance(value, bool):
        # Odoo marshals an empty field as False — an absent value, not text.
        return None
    if isinstance(value, str):
        value = value.strip() or None
    return value


def _fabric_value_from(record, field_names, numeric=False):
    """First usable value across the ordered candidate fields for one concept.

    Returns (value, source_field_name). The preference order comes from
    resolve_fabric_fields(): a populated dedicated attribute always wins, and
    a text twin is only consulted when every better source is empty or
    unusable (non-numeric / non-positive when numeric=True).
    """
    for field_name in (field_names or ()):
        value = _fabric_value(record, field_name, numeric=numeric)
        if value is not None:
            return value, field_name
    return None, None


def extract_products(uid, models, cur, now, since=None):
    log.info("Extracting fabric products with attributes...")
    
    # Do not queue an ACCESS EXCLUSIVE ALTER on every incremental extract.
    # A waiting ALTER blocks later readers behind it and can freeze every app
    # that reads fabric products. Only attempt DDL when a column is genuinely
    # missing, and fail quickly rather than creating a lock convoy.
    required_columns = {
        "derived_color", "fabric_color", "kg_per_mtr", "width_m", "gsm",
        "plain_print", "fabric_structure", "fabric_category",
        "fabric_subcategory", "stretch_type", "weight_range",
        "fiber_content", "fabric_type", "supplier",
        "supplier_fabric_code", "primary_color", "source_city",
        "source_country", "fabric_name", "fabric_supplier_name",
        "odoo_fabric_color", "noos_fabric", "write_date",
        "kg_per_mtr_eff", "kg_per_mtr_src",
    }
    cur.execute("""
        SELECT attname
        FROM pg_attribute
        WHERE attrelid = 'raw_fabric_products'::regclass
          AND attnum > 0
          AND NOT attisdropped
    """)
    existing_columns = {row[0] for row in cur.fetchall()}
    if not required_columns.issubset(existing_columns):
        cur.execute("SET LOCAL lock_timeout = '2s'")
        cur.execute("""
        ALTER TABLE raw_fabric_products
        ADD COLUMN IF NOT EXISTS derived_color TEXT,
        ADD COLUMN IF NOT EXISTS fabric_color TEXT;
        ALTER TABLE raw_fabric_products 
        ADD COLUMN IF NOT EXISTS kg_per_mtr NUMERIC,
        ADD COLUMN IF NOT EXISTS width_m NUMERIC,
        ADD COLUMN IF NOT EXISTS gsm NUMERIC,
        ADD COLUMN IF NOT EXISTS plain_print TEXT,
        ADD COLUMN IF NOT EXISTS fabric_structure TEXT,
        ADD COLUMN IF NOT EXISTS fabric_category TEXT,
        ADD COLUMN IF NOT EXISTS fabric_subcategory TEXT,
        ADD COLUMN IF NOT EXISTS stretch_type TEXT,
        ADD COLUMN IF NOT EXISTS weight_range TEXT,
        ADD COLUMN IF NOT EXISTS fiber_content TEXT,
        ADD COLUMN IF NOT EXISTS fabric_type TEXT,
        ADD COLUMN IF NOT EXISTS supplier TEXT,
        ADD COLUMN IF NOT EXISTS supplier_fabric_code TEXT,
        ADD COLUMN IF NOT EXISTS primary_color TEXT,
        ADD COLUMN IF NOT EXISTS source_city TEXT,
        ADD COLUMN IF NOT EXISTS source_country TEXT,
        ADD COLUMN IF NOT EXISTS fabric_name TEXT,
        ADD COLUMN IF NOT EXISTS fabric_supplier_name TEXT,
        ADD COLUMN IF NOT EXISTS odoo_fabric_color TEXT,
        ADD COLUMN IF NOT EXISTS noos_fabric BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS write_date TIMESTAMP
        """)

    # Effective Kg/Mtr + source flag — code-defined derived columns (generated,
    # so they stay in lockstep with the stored attributes on every extract and
    # auto-populate on dev AND prod). The conversion is PURELY the standard
    # formula Kg/Mtr = Width (m) × GSM ÷ 1000 when BOTH width_m and gsm are
    # present; the stored Odoo kg_per_mtr value is intentionally IGNORED so every
    # metre/cost/cover figure derives from a single transparent calculation.
    # kg_per_mtr_src marks each row: 'derived' (Width+GSM present) / 'incomplete'.
    # NOTE: these are STORED GENERATED columns, so ADD COLUMN IF NOT EXISTS will
    # NOT change an existing column's expression — on a DB where they already
    # exist with the old formula, migration 003 drops + re-adds them. This block
    # is what gives a FRESH DB the correct expression from the first extract.
    if not {"kg_per_mtr_eff", "kg_per_mtr_src"}.issubset(existing_columns):
        cur.execute("SET LOCAL lock_timeout = '2s'")
        cur.execute("""
        ALTER TABLE raw_fabric_products
        ADD COLUMN IF NOT EXISTS kg_per_mtr_eff NUMERIC
          GENERATED ALWAYS AS (
            CASE
              WHEN COALESCE(width_m,0) > 0 AND COALESCE(gsm,0) > 0
                   THEN width_m * gsm / 1000.0
              ELSE NULL
            END
          ) STORED,
        ADD COLUMN IF NOT EXISTS kg_per_mtr_src TEXT
          GENERATED ALWAYS AS (
            CASE
              WHEN COALESCE(width_m,0) > 0 AND COALESCE(gsm,0) > 0 THEN 'derived'
              ELSE 'incomplete'
            END
          ) STORED
        """)

    batch_size = 200
    offset = 0
    rows = []
    
    # fields_get is intentionally called on every extract, rather than cached:
    # Studio can move a field id while the worker is running.
    try:
        field_metadata = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD, "product.product", "fields_get",
            [[]], {"attributes": ["string", "type", "relation"]})
    except Exception as exc:
        raise RuntimeError(
            f"Unable to inspect Odoo product-field metadata; "
            f"Fabric master data was not changed: {exc}"
        ) from exc
    fabric_fields = resolve_fabric_fields(field_metadata)
    mapping_sig = mapping_signature(fabric_fields, field_metadata)
    cur.execute(_FABRIC_SYNC_STATE_DDL)

    # A change in WHICH live fields feed each business attribute (a new
    # duplicate label, a moved/renamed Studio field, or a code change to the
    # precedence rules) invalidates rows whose Odoo write_date never advanced:
    # they were extracted under the old selection. Promote THIS pull to a full
    # reconciliation so those rows are repaired promptly; the incremental
    # cadence resumes on the next cycle once the new fingerprint is stored.
    if since is not None and _mapping_state_changed(cur, mapping_sig):
        log.warning(
            "Fabric attribute source selection changed (or has no recorded "
            "state) — promoting this pull to a FULL product reconciliation "
            "so previously-extracted rows are repaired.")
        since = None

    # Every candidate field for every concept is pulled, so the per-product
    # fallback can inspect them all (dict.fromkeys dedupes, keeping order).
    candidate_fields = list(dict.fromkeys(
        f for fields in fabric_fields.values() for f in fields))
    FABRIC_FIELDS = [
        "name", "default_code", "categ_id", "uom_id", 
        "standard_price", "active",
        *candidate_fields,
        "barcode",
        "product_properties",  # dedicated Fabric Name / Fabric Supplier Name / Fabric Colour live here
        "write_date",       # Odoo last-modified time (UTC) — drives the category tracker
    ]
    
    # Incremental (fast-path) pull: only products whose Odoo write_date advanced
    # since the last successful pull (plus a small overlap for clock skew). This
    # is usually 0–few records, so the 60s cadence stays cheap. `since=None`
    # (bootstrap / heavy reconcile) pulls every product.
    incomplete_recheck_cursor = None
    domain = [["categ_id", "in", FABRIC_CATS]]
    if since is not None:
        since_str = since.strftime("%Y-%m-%d %H:%M:%S")
        incomplete_ids, incomplete_recheck_cursor = _incomplete_fabric_product_ids(cur)
        if incomplete_ids:
            # Odoo domains are ANDed by default; this adds
            # (recently-written OR currently-incomplete) below the Fabric/Trim
            # category guard.  The latter catches related-field edits whose
            # product.product write_date did not move.
            domain.extend([
                "|",
                ["write_date", ">=", since_str],
                ["id", "in", incomplete_ids],
            ])
            log.info(
                "Incremental product pull since %s (UTC) + %d incomplete "
                "Fabric rows for related-field refresh",
                since_str, len(incomplete_ids),
            )
        else:
            domain.append(["write_date", ">=", since_str])
            log.info("Incremental product pull since %s (UTC)", since_str)

    # Which live field actually supplied each conversion-critical value —
    # logged once per pull so a fallback-heavy catalogue is visible in the
    # sync logs without a per-product noise storm.
    source_counts = {"width_m": Counter(), "gsm": Counter()}

    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, "product.product", "search_read",
            [domain],
            {"fields": FABRIC_FIELDS, "limit": batch_size, "offset": offset,
             "context": {"active_test": False}})
        if not records:
            break
        for r in records:
            cat = r.get("categ_id")
            cat_name = cat[1] if cat else ""
            category = "Fabric" if "Raw" in str(cat_name) else "Trim"

            def pick(concept, numeric=False):
                return _fabric_value_from(
                    r, fabric_fields.get(concept), numeric=numeric)[0]

            kg_mtr = pick("kg_per_mtr", numeric=True)
            width, width_src = _fabric_value_from(
                r, fabric_fields.get("width_m"), numeric=True)
            gsm, gsm_src = _fabric_value_from(
                r, fabric_fields.get("gsm"), numeric=True)
            source_counts["width_m"][width_src or "(none)"] += 1
            source_counts["gsm"][gsm_src or "(none)"] += 1

            props = _props_by_label(r.get("product_properties"))
            fabric_name_odoo     = props.get(_label_key("Fabric Name"))
            fabric_supplier_odoo = props.get(_label_key("Fabric Supplier Name"))
            fabric_color_odoo    = props.get(_label_key("Fabric Colour"))
            noos_fabric          = _normalize_yes(pick("noos_fabric"))

            rows.append((
                r["id"],
                r["name"],
                r.get("default_code"),
                category,
                r["uom_id"][1] if r.get("uom_id") else None,
                r.get("standard_price", 0),
                r.get("active", True),
                kg_mtr,
                width,
                gsm,
                pick("plain_print"),
                pick("fabric_structure"),
                pick("fabric_category"),
                pick("fabric_subcategory"),
                pick("stretch_type"),
                pick("weight_range"),
                pick("fiber_content"),
                pick("fabric_type"),
                pick("supplier"),
                pick("supplier_fabric_code"),
                pick("primary_color"),
                pick("source_city"),
                pick("source_country"),
                r.get("barcode") or None,
                _derive_color(r.get("name","")),
                _derive_color(r.get("name","")),
                fabric_name_odoo,
                fabric_supplier_odoo,
                fabric_color_odoo,
                noos_fabric,
                r.get("write_date") or None,
                now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break

    if since is None and not rows:
        # A full pull that got NOTHING back from Odoo is a broken feed (the
        # category ids vanished, a permissions change, …) — never an excuse to
        # truncate the master. Keep the last known-good rows and fail loudly.
        raise RuntimeError(
            "Fabric full product pull returned 0 records from Odoo; refusing "
            "to truncate the existing Fabric master."
        )

    # Full pull replaces the whole table (also reconciles hard-deletes); the
    # incremental fast path upserts only the changed rows and leaves the rest.
    if since is None:
        cur.execute("TRUNCATE raw_fabric_products")
    if rows:
        execute_values(cur, """
        INSERT INTO raw_fabric_products (
            id, name, default_code, category, uom, standard_price, active,
            kg_per_mtr, width_m, gsm, plain_print, fabric_structure,
            fabric_category, fabric_subcategory, stretch_type, weight_range,
            fiber_content, fabric_type, supplier, supplier_fabric_code, primary_color,
            source_city, source_country, barcode,
            derived_color, fabric_color,
            fabric_name, fabric_supplier_name, odoo_fabric_color, noos_fabric,
            write_date, _loaded_at
        ) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, default_code=EXCLUDED.default_code,
            category=EXCLUDED.category, uom=EXCLUDED.uom,
            standard_price=EXCLUDED.standard_price, active=EXCLUDED.active,
            kg_per_mtr=EXCLUDED.kg_per_mtr, width_m=EXCLUDED.width_m,
            gsm=EXCLUDED.gsm, plain_print=EXCLUDED.plain_print,
            fabric_structure=EXCLUDED.fabric_structure,
            fabric_category=EXCLUDED.fabric_category,
            fabric_subcategory=EXCLUDED.fabric_subcategory,
            stretch_type=EXCLUDED.stretch_type, weight_range=EXCLUDED.weight_range,
            fiber_content=EXCLUDED.fiber_content, fabric_type=EXCLUDED.fabric_type,
            supplier=EXCLUDED.supplier,
            supplier_fabric_code=EXCLUDED.supplier_fabric_code,
            primary_color=EXCLUDED.primary_color,
            source_city=EXCLUDED.source_city, source_country=EXCLUDED.source_country,
            barcode=EXCLUDED.barcode,
            derived_color=EXCLUDED.derived_color, fabric_color=EXCLUDED.fabric_color,
            fabric_name=EXCLUDED.fabric_name,
            fabric_supplier_name=EXCLUDED.fabric_supplier_name,
            odoo_fabric_color=EXCLUDED.odoo_fabric_color,
            noos_fabric=EXCLUDED.noos_fabric,
            write_date=EXCLUDED.write_date,
            _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=200)
    if since is not None:
        # Advance the freshness clock for the WHOLE table so the page's
        # MAX(_loaded_at) age reflects this successful sync even on cycles where
        # nothing changed (0 changed rows is the normal steady state).
        cur.execute("UPDATE raw_fabric_products SET _loaded_at = %s", (now,))

    # Record the source selection that produced THESE rows. The caller commits
    # it atomically with the data: a failed pull rolls back both, so the next
    # run sees the old fingerprint and retries the full reconciliation.
    cur.execute("""
        INSERT INTO fabric_sync_state (key, value, updated_at)
        VALUES (%s, %s, %s)
        ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    """, (_MAPPING_STATE_KEY, mapping_sig, now))
    if incomplete_recheck_cursor is not None:
        cur.execute("""
            INSERT INTO fabric_sync_state (key, value, updated_at)
            VALUES (%s, %s, %s)
            ON CONFLICT (key) DO UPDATE
               SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        """, (_INCOMPLETE_RECHECK_CURSOR_KEY, str(incomplete_recheck_cursor), now))

    if rows:
        for concept, counts in source_counts.items():
            log.info("Fabric %s value sources: %s", concept,
                     ", ".join(f"{f}={c}" for f, c in counts.most_common()))
    log.info("✅ raw_fabric_products: %d changed rows (incremental=%s)",
             len(rows), since is not None)

def extract_inventory(uid, models, cur, now):
    log.info("Extracting fabric inventory...")
    # Product price / category / uom come from the already-refreshed
    # raw_fabric_products table (populated earlier in THIS run) instead of a
    # second full product.product pull from Odoo — that redundant pull was one of
    # the biggest slow points in the cycle. Tuple order: (price, category, uom).
    cur.execute("SELECT id, standard_price, category, uom FROM raw_fabric_products")
    prices = {r[0]: (float(r[1]) if r[1] is not None else 0, r[2], r[3])
              for r in cur.fetchall()}
    if not prices:
        # Bootstrap fallback: products table empty (should not happen because
        # products run first) — pull straight from Odoo, deriving the category.
        for r in models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'product.product', 'search_read',
                [[['categ_id','in',FABRIC_CATS]]],
                {'fields': ['standard_price','categ_id','uom_id']}):
            catn = str((r.get('categ_id') or [None, ''])[1] or '')
            prices[r['id']] = (r.get('standard_price', 0),
                               'Fabric' if 'Raw' in catn else 'Trim',
                               (r.get('uom_id') or [None, None])[1])

    batch_size = 500
    offset = 0
    rows = []
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'stock.quant', 'search_read',
            [[['product_id.categ_id','in',FABRIC_CATS],['location_id.usage','=','internal']]],
            {'fields': ['product_id','location_id','quantity','reserved_quantity','lot_id'],
             'limit': batch_size, 'offset': offset})
        if not records:
            break
        for r in records:
            pid = r['product_id'][0] if r.get('product_id') else None
            pname = r['product_id'][1] if r.get('product_id') else None
            price_info = prices.get(pid, (0, 'Trim', None))
            qty = r.get('quantity', 0)
            res = r.get('reserved_quantity', 0)
            # price_info[1] is already the mapped 'Fabric'/'Trim' category.
            category = price_info[1] or 'Trim'
            rows.append((
                r['id'], pid, pname, None,
                r['location_id'][0] if r.get('location_id') else None,
                r['location_id'][1] if r.get('location_id') else None,
                qty, res, qty - res,
                price_info[2],
                price_info[0],
                qty * price_info[0],
                category, now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break
    if not rows:
        raise RuntimeError(
            "Odoo returned no fabric inventory rows; refusing to prune the last good snapshot"
        )
    execute_values(cur, """
        INSERT INTO raw_fabric_inventory
        (id,product_id,product_name,product_sku,location_id,location_name,
         quantity,reserved_qty,available,uom,standard_price,total_value,category,_loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            product_id=EXCLUDED.product_id, product_name=EXCLUDED.product_name,
            product_sku=EXCLUDED.product_sku, location_id=EXCLUDED.location_id,
            location_name=EXCLUDED.location_name, quantity=EXCLUDED.quantity,
            reserved_qty=EXCLUDED.reserved_qty, available=EXCLUDED.available,
            uom=EXCLUDED.uom, standard_price=EXCLUDED.standard_price,
            total_value=EXCLUDED.total_value, category=EXCLUDED.category,
            _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
    cur.execute(
        "DELETE FROM raw_fabric_inventory WHERE NOT (id = ANY(%s))",
        ([row[0] for row in rows],),
    )
    log.info("✅ raw_fabric_inventory: %d rows", len(rows))

def extract_boms(uid, models, cur, now):
    log.info("Extracting BOMs...")
    boms = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'mrp.bom', 'search_read',
        [[]], {'fields': ['product_tmpl_id','product_id','product_qty','code']})
    
    # Get all BOM lines for fabric/trim components
    lines = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'mrp.bom.line', 'search_read',
        [[['product_id.categ_id','in',FABRIC_CATS]]],
        {'fields': ['bom_id','product_id','product_qty','product_uom_id']})
    
    bom_map = {b['id']: b for b in boms}
    rows = []
    for l in lines:
        bom = bom_map.get(l['bom_id'][0] if l.get('bom_id') else None, {})
        fp = bom.get('product_tmpl_id')
        rows.append((
            l['id'],
            l['bom_id'][0] if l.get('bom_id') else None,
            fp[1] if fp else None,
            bom.get('code'),
            l['product_id'][0] if l.get('product_id') else None,
            l['product_id'][1] if l.get('product_id') else None,
            None,
            l.get('product_qty', 0),
            l['product_uom_id'][1] if l.get('product_uom_id') else None,
            now
        ))
    cur.execute("TRUNCATE raw_fabric_boms")
    execute_values(cur, """
        INSERT INTO raw_fabric_boms
        (id,bom_id,finished_product_name,finished_product_sku,
         component_id,component_name,component_sku,component_qty,component_uom,_loaded_at)
        VALUES %s ON CONFLICT (id) DO NOTHING
    """, rows, page_size=500)
    log.info("✅ raw_fabric_boms: %d rows", len(rows))

def extract_moves(uid, models, cur, now):
    log.info("Extracting fabric stock moves...")
    # Get last move date for incremental
    cur.execute("SELECT MAX(date) FROM raw_fabric_moves")
    last = cur.fetchone()[0]
    since = last - timedelta(days=2) if last else datetime.now() - timedelta(days=730)
    since_str = since.strftime('%Y-%m-%d %H:%M:%S')
    log.info("Fetching moves since %s", since_str)

    batch_size = 1000
    offset = 0
    rows = []
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'stock.move', 'search_read',
            [[['product_id.categ_id','in',FABRIC_CATS],
              ['state','=','done'],
              ['date','>=',since_str]]],
            {'fields': ['product_id','product_uom_qty','product_uom','location_id',
                        'location_dest_id','date','reference','name'],
             'limit': batch_size, 'offset': offset,
             'order': 'date asc'})
        if not records:
            break
        for r in records:
            loc_from = r['location_id'][1] if r.get('location_id') else ''
            loc_to   = r['location_dest_id'][1] if r.get('location_dest_id') else ''
            if 'Vendor' in loc_from or 'Suppliers' in loc_from:
                move_type = 'IN'
            elif 'Customer' in loc_to or 'Production' in loc_to:
                move_type = 'OUT'
            else:
                move_type = 'INTERNAL'
            rows.append((
                r['id'],
                r['product_id'][0] if r.get('product_id') else None,
                r['product_id'][1] if r.get('product_id') else None,
                None,
                r.get('product_uom_qty', 0),
                r['product_uom'][1] if r.get('product_uom') else None,
                loc_from, loc_to, move_type,
                r.get('date'), r.get('reference'),
                None, now
            ))
        offset += batch_size
        if len(records) < batch_size:
            break
    if rows:
        execute_values(cur, """
            INSERT INTO raw_fabric_moves
            (id,product_id,product_name,product_sku,qty,uom,
             location_from,location_to,move_type,date,reference,category,_loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                qty=EXCLUDED.qty, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
    log.info("✅ raw_fabric_moves: %d rows", len(rows))

def extract_purchase_orders(uid, models, cur, now):
    log.info("Extracting fabric purchase orders...")
    # Get PO headers
    pos = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'purchase.order', 'search_read',
        [[]], {'fields': ['name','partner_id','date_order','state']})
    po_map = {p['id']: p for p in pos}

    lines = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'purchase.order.line', 'search_read',
        [[['product_id.categ_id','in',FABRIC_CATS]]],
        {'fields': ['order_id','product_id','product_qty','price_unit',
                    'product_uom','qty_received','qty_invoiced','date_planned']})
    rows = []
    for l in lines:
        po = po_map.get(l['order_id'][0] if l.get('order_id') else None, {})
        pid = l['product_id'][0] if l.get('product_id') else None
        qty = l.get('product_qty', 0)
        price = l.get('price_unit', 0)
        rows.append((
            l['id'],
            l['order_id'][0] if l.get('order_id') else None,
            l['order_id'][1] if l.get('order_id') else None,
            po.get('partner_id',[None,''])[1],
            po.get('date_order','')[:10] if po.get('date_order') else None,
            pid,
            l['product_id'][1] if l.get('product_id') else None,
            None,
            qty,
            l.get('qty_received', 0),
            l.get('qty_invoiced', 0),
            price,
            qty * price,
            l['product_uom'][1] if l.get('product_uom') else None,
            l.get('date_planned','')[:10] if l.get('date_planned') else None,
            po.get('state'),
            None, now
        ))
    cur.execute("TRUNCATE raw_fabric_purchase_orders")
    execute_values(cur, """
        INSERT INTO raw_fabric_purchase_orders
        (id,po_id,po_name,supplier,order_date,product_id,product_name,product_sku,
         qty_ordered,qty_received,qty_invoiced,price_unit,total_value,
         uom,date_planned,state,category,_loaded_at)
        VALUES %s ON CONFLICT (id) DO NOTHING
    """, rows, page_size=500)
    log.info("✅ raw_fabric_purchase_orders: %d rows", len(rows))

def main(mode="full"):
    """Fabric extract with three cadences (see the sync loop):

    - "fast"  (every ~60s): product master (INCREMENTAL via write_date) + fabric
      inventory (stock.quant). Feeds the Stock Mix table + "All products" export;
      reflects an Odoo product edit within ~60s. Prices reuse the just-refreshed
      products table, so there is no second full product.product pull.
    - "heavy" (slow cadence): a FULL product reconcile (catches archives/hard
      deletes the incremental path would miss) plus the genuinely heavy,
      slow-changing history — BOMs, stock moves, purchase orders.
    - "full"  (bootstrap / standalone default): everything, all full pulls.

    Every mode is idempotent (TRUNCATE+upsert or ON CONFLICT), so re-running is
    always safe.
    """
    uid, models = odoo_connect()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.utcnow()
    create_tables(cur)
    conn.commit()

    # Concurrency guard: ONE fabric extract touches the raw_fabric_* tables at a
    # time. The sync loop now runs the fast pull on its own ~60s thread and
    # launches the heavy reconcile fire-and-forget, so a fast pull can fire while
    # a previous heavy pull is still running; an operator may also kick off a
    # standalone run. A single pg session advisory lock (shared by BOTH fast and
    # heavy) makes them mutually exclusive so a fast incremental upsert can never
    # overlap a heavy full-product TRUNCATE+reconcile. If the lock is already
    # held, the losing run skips this pass rather than piling on (the fast path
    # simply retries on its next ~60s tick — well under the 180s staleness
    # banner). "full" (bootstrap) is a one-shot standalone run by design and is
    # NOT gated (nothing else runs against an empty fresh DB at that point).
    lock_key = 0x7FAB12C0  # arbitrary, fabric-extract specific
    have_lock = True
    if mode in ("fast", "heavy"):
        cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,))
        have_lock = cur.fetchone()[0]
        conn.commit()
    if not have_lock:
        log.info("Fabric extract (mode=%s) — another fabric run holds the lock, skipping.", mode)
        conn.close()
        # Distinct exit code so the sync worker / watchdog can tell "skipped,
        # nothing refreshed" apart from a real success (exit-code convention at
        # the top of this module). Exiting 0 here was the bug that let the
        # worker keep writing a fresh fabric heartbeat during lock-skip cycles
        # while the data aged 15+ hours.
        sys.exit(EXIT_SKIPPED_LOCK)

    try:
        if mode in ("fast", "full"):
            since = None
            if mode == "fast":
                # Incremental window = last stored write_date minus a small overlap
                # (guards clock skew / a mid-write pull). Empty table → full pull.
                cur.execute("SELECT MAX(write_date) FROM raw_fabric_products")
                last_wd = cur.fetchone()[0]
                if last_wd is not None:
                    since = last_wd - timedelta(minutes=5)
            extract_products(uid, models, cur, now, since=since)
            conn.commit()
            extract_inventory(uid, models, cur, now)
            conn.commit()

        if mode in ("heavy", "full"):
            if mode == "heavy":
                # Full product reconcile on the slow cadence so archives / rare
                # hard deletes the incremental fast path can't see get cleared.
                extract_products(uid, models, cur, now, since=None)
                conn.commit()
            extract_boms(uid, models, cur, now)
            extract_moves(uid, models, cur, now)
            extract_purchase_orders(uid, models, cur, now)
            conn.commit()
    finally:
        if mode in ("fast", "heavy"):
            cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
            conn.commit()

    # Summary
    for table in ['raw_fabric_products','raw_fabric_inventory','raw_fabric_boms',
                  'raw_fabric_moves','raw_fabric_purchase_orders']:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        log.info("%s: %d rows", table, cur.fetchone()[0])
    conn.close()

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description="Fabric BI Odoo extract")
    ap.add_argument("--mode", choices=["fast", "heavy", "full"], default="full",
                    help="fast=product+inventory (60s), heavy=boms/moves/pos + full "
                         "product reconcile, full=everything (bootstrap/standalone)")
    args = ap.parse_args()
    main(mode=args.mode)
