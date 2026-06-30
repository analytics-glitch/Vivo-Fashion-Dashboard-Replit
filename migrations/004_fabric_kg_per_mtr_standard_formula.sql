-- Fabric Kg/Mtr: use the standard formula ONLY (Width (m) × GSM ÷ 1000) and
-- ignore the stored Odoo kg_per_mtr value entirely.
--
-- raw_fabric_products.kg_per_mtr_eff / kg_per_mtr_src are STORED GENERATED
-- columns, so ALTER ... ADD COLUMN IF NOT EXISTS in the fabric extract can NOT
-- change the expression of a column that already exists. To make the new
-- formula take effect on a DB where these columns were created with the old
-- "prefer stored, else derive" expression, the columns must be dropped and
-- re-added with the new expression.
--
-- Idempotent + safe to re-run:
--  * ALTER TABLE IF EXISTS — a fresh DB (table not yet created by the fabric
--    extract) is skipped; the extract then creates the columns with the new
--    expression itself.
--  * DROP COLUMN IF EXISTS — re-runs are no-ops once already migrated.
--  * ADD COLUMN IF NOT EXISTS — re-adds with the standard-formula-only
--    expression after the drop.

ALTER TABLE IF EXISTS raw_fabric_products
  DROP COLUMN IF EXISTS kg_per_mtr_eff,
  DROP COLUMN IF EXISTS kg_per_mtr_src;

ALTER TABLE IF EXISTS raw_fabric_products
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
    ) STORED;
