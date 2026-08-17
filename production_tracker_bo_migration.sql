-- ============================================================
-- Migration: re-anchor the tracker on the Buying Order (vivo.buying.order)
-- and capture the full BO header + per-colour line breakdown.
-- Safe to run more than once. Run on dev (helium), then on Neon prod.
--   psql $DATABASE_URL -f production_tracker_bo_migration.sql
-- ============================================================

-- Richer BO header on the existing orders table.
ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS buyer                  TEXT,
    ADD COLUMN IF NOT EXISTS style_name             TEXT,
    ADD COLUMN IF NOT EXISTS expected_delivery_date DATE,
    ADD COLUMN IF NOT EXISTS production_type        TEXT,
    ADD COLUMN IF NOT EXISTS lifecycle_type         TEXT,
    ADD COLUMN IF NOT EXISTS bo_state               TEXT,
    ADD COLUMN IF NOT EXISTS notes_html             TEXT,
    ADD COLUMN IF NOT EXISTS cost_price_kes         NUMERIC,
    ADD COLUMN IF NOT EXISTS cost_date              DATE,
    ADD COLUMN IF NOT EXISTS cost_source            TEXT;

-- Per-colour breakdown of each buying order (the BO lines).
CREATE TABLE IF NOT EXISTS production_order_lines (
    id            BIGSERIAL PRIMARY KEY,
    order_ref     TEXT NOT NULL REFERENCES production_orders(order_ref) ON DELETE CASCADE,
    odoo_line_id  BIGINT,
    product_sku   TEXT,
    product_name  TEXT,
    colour        TEXT,
    total_qty     NUMERIC,
    planned_qty   NUMERIC,
    remaining_qty NUMERIC,
    line_state    TEXT,
    UNIQUE (order_ref, odoo_line_id)
);
CREATE INDEX IF NOT EXISTS idx_pol_order ON production_order_lines(order_ref);