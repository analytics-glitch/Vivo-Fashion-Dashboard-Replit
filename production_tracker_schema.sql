-- ============================================================
-- Production Tracker Schema
-- Quantity-split stage tracking via an append-only movement ledger.
-- Run on dev (helium) first, then repeat on Neon production.
--   psql $DATABASE_URL -f production_tracker_schema.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Stage reference + allowed transitions
--    allowed_next enforces valid moves in the dashboard UI/API.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_stages (
    stage_key     TEXT PRIMARY KEY,
    stage_name    TEXT NOT NULL,
    sort_order    INT  NOT NULL,
    is_terminal   BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_next  TEXT[] NOT NULL DEFAULT '{}'
);

INSERT INTO production_stages (stage_key, stage_name, sort_order, is_terminal, allowed_next) VALUES
  ('buying_order',   'Buying Order (Odoo)', 0, FALSE, ARRAY['cutting']),
  ('cutting',        'Cutting & Bundling',  1, FALSE, ARRAY['waiting_sewing']),
  ('waiting_sewing', 'Waiting Sewing',      2, FALSE, ARRAY['sewing']),
  ('sewing',         'Sewing',              3, FALSE, ARRAY['finishing','washing']),
  ('washing',        'Washing',             4, FALSE, ARRAY['finishing','warehouse']),
  ('finishing',      'Finishing',           5, FALSE, ARRAY['warehouse','washing','repairs']),
  ('repairs',        'Repairs',             6, FALSE, ARRAY['sewing','finishing','warehouse']),
  ('warehouse',      'Warehouse',           7, TRUE,  ARRAY[]::TEXT[])
ON CONFLICT (stage_key) DO UPDATE
  SET stage_name   = EXCLUDED.stage_name,
      sort_order   = EXCLUDED.sort_order,
      is_terminal  = EXCLUDED.is_terminal,
      allowed_next = EXCLUDED.allowed_next;

-- ------------------------------------------------------------
-- 2. Orders (header) — synced from Odoo.
--    order_ref is the Odoo document number; the rest is metadata
--    used for filtering/grouping on the board.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
    order_ref     TEXT PRIMARY KEY,
    odoo_id       BIGINT,
    style_number  TEXT,
    product_name  TEXT,
    product_sku   TEXT,
    order_qty     NUMERIC,
    fabric        TEXT,
    date_ordered  DATE,
    cost_price_kes NUMERIC,
    cost_date     DATE,
    cost_source   TEXT,
    source        TEXT DEFAULT 'odoo',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prod_orders_style ON production_orders(style_number);
CREATE INDEX IF NOT EXISTS idx_prod_orders_date  ON production_orders(date_ordered);

-- ------------------------------------------------------------
-- 3. Stage movement ledger (append-only).
--    from_stage IS NULL  => intake (units first enter the tracker)
--    Each move records a quantity leaving one stage for the next.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stage_movements (
    id          BIGSERIAL PRIMARY KEY,
    order_ref   TEXT NOT NULL REFERENCES production_orders(order_ref) ON DELETE CASCADE,
    from_stage  TEXT REFERENCES production_stages(stage_key),
    to_stage    TEXT NOT NULL REFERENCES production_stages(stage_key),
    qty         NUMERIC NOT NULL CHECK (qty > 0),
    moved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    moved_by    TEXT,
    note        TEXT,
    -- Optional variant grain: a move can target one SKU (+ size). NULL = a
    -- whole-order move (legacy / variant-less orders).
    sku         TEXT,
    size        TEXT,
    -- Sewing line (A–E) captured on each move INTO the sewing stage at the
    -- (sku, size) grain. NULL on non-sewing moves and on legacy sewing moves;
    -- repair (repairs -> sewing) auto-routing reuses the most recent non-NULL
    -- line for that order+sku+size.
    sewing_line TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage_moves_order ON stage_movements(order_ref);
CREATE INDEX IF NOT EXISTS idx_stage_moves_to    ON stage_movements(to_stage);
CREATE INDEX IF NOT EXISTS idx_stage_moves_from  ON stage_movements(from_stage);
CREATE INDEX IF NOT EXISTS idx_stage_moves_sku   ON stage_movements(order_ref, sku);

-- ------------------------------------------------------------
-- View: current balance per order x stage.
--   qty_here = total moved IN to a stage - total moved OUT of it.
--   Rows with zero balance are hidden.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_stage_balances AS
WITH inbound AS (
    SELECT order_ref,
           to_stage           AS stage,
           SUM(qty)           AS qty_in,
           MIN(moved_at)      AS first_in,
           MAX(moved_at)      AS last_in
    FROM stage_movements
    GROUP BY order_ref, to_stage
),
outbound AS (
    SELECT order_ref,
           from_stage         AS stage,
           SUM(qty)           AS qty_out
    FROM stage_movements
    WHERE from_stage IS NOT NULL
    GROUP BY order_ref, from_stage
)
SELECT
    i.order_ref,
    i.stage,
    (i.qty_in - COALESCE(o.qty_out, 0))                         AS qty_here,
    i.first_in,
    i.last_in,
    EXTRACT(EPOCH FROM (now() - i.last_in)) / 86400.0           AS days_since_last_in
FROM inbound i
LEFT JOIN outbound o
       ON o.order_ref = i.order_ref
      AND o.stage     = i.stage
WHERE (i.qty_in - COALESCE(o.qty_out, 0)) > 0;

-- ------------------------------------------------------------
-- View: WIP summary — "what is where right now".
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_wip_summary AS
SELECT
    b.stage,
    s.stage_name,
    s.sort_order,
    COUNT(DISTINCT b.order_ref)                       AS orders_here,
    SUM(b.qty_here)                                   AS units_here,
    ROUND(AVG(b.days_since_last_in)::numeric, 1)      AS avg_days_in_stage,
    ROUND(MAX(b.days_since_last_in)::numeric, 1)      AS oldest_days_in_stage
FROM v_stage_balances b
JOIN production_stages s ON s.stage_key = b.stage
GROUP BY b.stage, s.stage_name, s.sort_order
ORDER BY s.sort_order;