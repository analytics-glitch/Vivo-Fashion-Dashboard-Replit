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
    It is `raw_fabric_moves` MINUS the rows the net-consumption definition counts
    inside the override window (RMAT/Stock-exit consumption + genuine returns into
    RMAT/Stock), UNION the sheet rows as pseudo moves (consumption → INTERNAL
    RMAT/Stock → PROD/Stock, returns → INTERNAL production → RMAT/Stock). IN
    (incoming) and inventory-adjustment write-ons are always kept from Odoo;
    everything outside Jan–Apr 2026 is untouched Odoo data.

Barcode → product is resolved at QUERY time inside the view (join on
`raw_fabric_products.barcode`, which is unique — no fan-out). Unmatched sheet rows
keep `product_id = NULL` so they still count in aggregate totals (KPIs, trend,
movement) but drop out of per-fabric views that key on product identity.
"""

# Override window: Jan 1 2026 (inclusive) → May 1 2026 (exclusive) = all of Jan–Apr.
OVERRIDE_SINCE = "2026-01-01"
OVERRIDE_UNTIL_EXCL = "2026-05-01"

# Location literals — must match fabric_router's net-consumption predicates exactly.
# Consumption is the raw-material EXIT (RMAT/Stock → PROD/Stock or Samp/Fabric);
# a genuine return is an INTERNAL move back INTO RMAT/Stock.
PROD_LOC = "Virtual Locations/Production"   # production virtual location
STOCK_LOC = "RMAT/Stock"                    # the raw-material store (exit / return point)
PROD_STOCK_LOC = "PROD/Stock"               # production real-stock (an RMAT exit target)
SAMP_LOC = "Samp/Fabric"                    # sampling location (an RMAT exit target)

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
  -- 1) Raw Odoo moves, minus the rows the NEW net-consumption definition would count
  --    inside the override window: consumption (RMAT/Stock → PROD/Stock or Samp/Fabric,
  --    INTERNAL) and genuine returns back INTO RMAT/Stock (from a real location or
  --    from production, but NOT inventory-adjustment write-ons). These are replaced by
  --    the reconciled sheet rows below. IN moves and inventory-adjustment rows are
  --    always kept. split_part (not LIKE '%') dodges the psycopg2 literal-% trap.
  --    is_fabric: TRUE only when the move's product is classified Fabric (not Trim,
  --    and not an unmatched/unknown product) in raw_fabric_products. Consumption &
  --    movement reads filter on this so trims/accessories — even those measured in
  --    kg — never inflate the fabric figures.
  SELECT m.id, m.product_id, m.product_name, m.product_sku, m.qty, m.uom,
         m.location_from, m.location_to, m.move_type, m.date, m.reference, m.category, m._loaded_at,
         (fp.category = 'Fabric') AS is_fabric
  FROM raw_fabric_moves m
  LEFT JOIN raw_fabric_products fp ON fp.id = m.product_id
  WHERE NOT (
        m.date >= DATE '{OVERRIDE_SINCE}' AND m.date < DATE '{OVERRIDE_UNTIL_EXCL}'
        AND (
              -- consumption legs (RMAT/Stock exit)
              ( m.move_type = 'INTERNAL' AND m.location_from = '{STOCK_LOC}'
                AND m.location_to IN ('{PROD_STOCK_LOC}', '{SAMP_LOC}') )
              -- genuine returns back into RMAT/Stock (excl. inventory-adjustment write-ons)
              OR ( m.move_type = 'INTERNAL' AND m.location_to = '{STOCK_LOC}'
                   AND ( split_part(m.location_from, '/', 1) <> 'Virtual Locations'
                         OR m.location_from = '{PROD_LOC}' ) )
            )
  )
  UNION ALL
  -- 2) Sheet consumption → pseudo INTERNAL RMAT/Stock → PROD/Stock moves (one per
  --    sheet line), matching the new consumption predicate.
  SELECT
      NULL::bigint                                                       AS id,
      pr.id                                                              AS product_id,
      COALESCE(pr.name, NULLIF(BTRIM(sc.product_title), ''),
               'Unmatched fabric (sheet)')                              AS product_name,
      NULL::text                                                        AS product_sku,
      sc.kg                                                             AS qty,
      'kg'                                                              AS uom,
      '{STOCK_LOC}'                                                     AS location_from,
      '{PROD_STOCK_LOC}'                                                AS location_to,
      'INTERNAL'                                                        AS move_type,
      sc.month_start::timestamp                                         AS date,
      'sheet:consumption'                                               AS reference,
      NULL::text                                                        AS category,
      sc._loaded_at                                                     AS _loaded_at,
      TRUE                                                              AS is_fabric
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
      sr._loaded_at                                                    AS _loaded_at,
      TRUE                                                             AS is_fabric
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
