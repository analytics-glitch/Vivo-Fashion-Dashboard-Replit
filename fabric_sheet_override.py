"""
Fabric consumption & returns sheet override (Jan–Apr 2026).

Odoo's `raw_fabric_moves` for Jan 1 – Apr 30 2026 are inflated (notably ~2.2M kg of
fake March production "returns"), so for that window the buying team reconciled the
real consumption (fabric OUT to production) and returns by hand in a Google Sheet.
This module owns the override store + the `fabric_moves_effective` view that every
Fabric consumption/returns read goes through:

  * `fabric_sheet_consumption` / `fabric_sheet_returns` — app-owned tables loaded
    from the sheet (one row per sheet line, period taken from the Month column).
    They live OUTSIDE `raw_fabric_*` so the hourly Odoo TRUNCATE/rebuild never wipes
    them.
  * `fabric_moves_effective` — a VIEW with the SAME columns as `raw_fabric_moves`.
    It is `raw_fabric_moves` MINUS the OUT and production-return rows inside the
    override window, UNION the sheet rows as pseudo moves (consumption → OUT,
    returns → INTERNAL out of the production location). IN (incoming) is always kept
    from Odoo; everything outside Jan–Apr 2026 is untouched Odoo data.

Barcode → product is resolved at QUERY time inside the view (join on
`raw_fabric_products.barcode`, which is unique — no fan-out). Unmatched sheet rows
keep `product_id = NULL` so they still count in aggregate totals (KPIs, trend,
movement) but drop out of per-fabric views that key on product identity.
"""

# Override window: Jan 1 2026 (inclusive) → May 1 2026 (exclusive) = all of Jan–Apr.
OVERRIDE_SINCE = "2026-01-01"
OVERRIDE_UNTIL_EXCL = "2026-05-01"

# The single production virtual location (a return is an INTERNAL move out of it).
PROD_LOC = "Virtual Locations/Production"

# Name of the unified view every consumption/returns read uses instead of the raw
# moves table.
EFFECTIVE_MOVES = "fabric_moves_effective"

DDL_TABLES = """
CREATE TABLE IF NOT EXISTS fabric_sheet_consumption (
    id            SERIAL PRIMARY KEY,
    month_start   DATE NOT NULL,
    barcode       TEXT,
    product_title TEXT,
    kg            NUMERIC NOT NULL,
    _loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabric_sheet_returns (
    id            SERIAL PRIMARY KEY,
    month_start   DATE NOT NULL,
    barcode       TEXT,
    product_title TEXT,
    kg            NUMERIC NOT NULL,
    _loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

# View column order MUST match raw_fabric_moves so callers can swap the FROM clause
# and keep referencing the same columns.
DDL_VIEW = f"""
CREATE OR REPLACE VIEW {EFFECTIVE_MOVES} AS
  -- 1) Raw Odoo moves, minus the OUT + production-return rows inside the override
  --    window. IN and non-production internal moves are always kept.
  SELECT id, product_id, product_name, product_sku, qty, uom,
         location_from, location_to, move_type, date, reference, category, _loaded_at
  FROM raw_fabric_moves m
  WHERE NOT (
        m.date >= DATE '{OVERRIDE_SINCE}' AND m.date < DATE '{OVERRIDE_UNTIL_EXCL}'
        AND ( m.move_type = 'OUT'
              OR (m.move_type = 'INTERNAL' AND m.location_from = '{PROD_LOC}') )
  )
  UNION ALL
  -- 2) Sheet consumption → pseudo OUT moves (one per sheet line).
  SELECT
      NULL::bigint                                                       AS id,
      pr.id                                                              AS product_id,
      COALESCE(pr.name, NULLIF(BTRIM(sc.product_title), ''),
               'Unmatched fabric (sheet)')                              AS product_name,
      NULL::text                                                        AS product_sku,
      sc.kg                                                             AS qty,
      'kg'                                                              AS uom,
      'RMAT/Stock'                                                      AS location_from,
      '{PROD_LOC}'                                                      AS location_to,
      'OUT'                                                             AS move_type,
      sc.month_start::timestamp                                         AS date,
      'sheet:consumption'                                               AS reference,
      NULL::text                                                        AS category,
      sc._loaded_at                                                     AS _loaded_at
  FROM fabric_sheet_consumption sc
  LEFT JOIN raw_fabric_products pr ON BTRIM(pr.barcode) = sc.barcode
  UNION ALL
  -- 3) Sheet returns → pseudo INTERNAL moves OUT of the production location, so
  --    _net_kg subtracts them from consumption exactly like real returns.
  SELECT
      NULL::bigint                                                      AS id,
      pr.id                                                             AS product_id,
      COALESCE(pr.name, NULLIF(BTRIM(sr.product_title), ''),
               'Unmatched fabric (sheet)')                             AS product_name,
      NULL::text                                                       AS product_sku,
      sr.kg                                                            AS qty,
      'kg'                                                             AS uom,
      '{PROD_LOC}'                                                     AS location_from,
      'RMAT/Stock'                                                     AS location_to,
      'INTERNAL'                                                       AS move_type,
      sr.month_start::timestamp                                        AS date,
      'sheet:return'                                                   AS reference,
      NULL::text                                                       AS category,
      sr._loaded_at                                                    AS _loaded_at
  FROM fabric_sheet_returns sr
  LEFT JOIN raw_fabric_products pr ON BTRIM(pr.barcode) = sr.barcode;
"""


def ensure_tables(cur):
    """Create the override tables (idempotent). Safe to call before raw_fabric_*."""
    cur.execute(DDL_TABLES)


def ensure_view(cur):
    """Create/replace the unified view. Requires raw_fabric_moves +
    raw_fabric_products to exist; callers should guard on that."""
    cur.execute(DDL_VIEW)


def base_tables_exist(cur):
    cur.execute("SELECT to_regclass('public.raw_fabric_moves'), "
                "to_regclass('public.raw_fabric_products')")
    a, b = cur.fetchone()
    return bool(a) and bool(b)
