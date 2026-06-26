-- 001_finance_and_images.sql
-- Captures the schema objects created in the finance + product-image work:
--   finance_account_map (table + 122-row reference classification)
--   finance_pl_summary  (view)
--   product_images, product_image_map (image storage tables)
-- Idempotent: safe to run repeatedly. Bulk data (images, accounting lines)
-- is populated by the sync scripts from source, NOT by this migration.

-- ── Image storage tables ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_images (
    tmpl_id    BIGINT PRIMARY KEY,
    image_512  TEXT,
    updated_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_image_map (
    sku        TEXT PRIMARY KEY,
    product_id BIGINT,
    tmpl_id    BIGINT
);

-- ── Finance account map (table) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_account_map (
    account_code TEXT PRIMARY KEY,
    pl_group     TEXT NOT NULL,
    pl_section   TEXT NOT NULL
);

-- Reference data: full official Odoo P&L classification (122 accounts).
-- Replace-in-place so re-running keeps it in sync with this file.
DELETE FROM finance_account_map;
INSERT INTO finance_account_map (account_code, pl_group, pl_section) VALUES
('6001','revenue','revenue'),('60011','revenue','revenue'),('6101','revenue','revenue'),
('6102','revenue','revenue'),('6103','revenue','revenue'),
('6104','other_income','other_income'),('6105','other_income','other_income'),
('6106','other_income','other_income'),('6107','other_income','other_income'),
('5002000000','cogs','costs_of_revenue'),
('70000000','production','costs_of_revenue'),('71000000','production','costs_of_revenue'),
('7112','production','costs_of_revenue'),('7113','production','costs_of_revenue'),('7114','production','costs_of_revenue'),
('7115','production','costs_of_revenue'),('7116','production','costs_of_revenue'),('7122','production','costs_of_revenue'),
('7201','production','costs_of_revenue'),('7202','production','costs_of_revenue'),('7210','production','costs_of_revenue'),
('7215','production','costs_of_revenue'),('7216','production','costs_of_revenue'),('7217','production','costs_of_revenue'),
('7218','production','costs_of_revenue'),('7220','production','costs_of_revenue'),('7221','production','costs_of_revenue'),
('7223','production','costs_of_revenue'),('7251','production','costs_of_revenue'),('7252','production','costs_of_revenue'),
('7253','production','costs_of_revenue'),('7254','production','costs_of_revenue'),('7255','production','costs_of_revenue'),
('7256','production','costs_of_revenue'),('7257','production','costs_of_revenue'),('7301','production','costs_of_revenue'),
('7302','production','costs_of_revenue'),('7303','production','costs_of_revenue'),('7304','production','costs_of_revenue'),
('7305','production','costs_of_revenue'),('7306','production','costs_of_revenue'),('7307','production','costs_of_revenue'),
('7308','production','costs_of_revenue'),
('7401','purchases','costs_of_revenue'),('7402','purchases','costs_of_revenue'),('7403','purchases','costs_of_revenue'),
('7404','purchases','costs_of_revenue'),('7405','purchases','costs_of_revenue'),
('8111','employment','operating_expenses'),('8112','employment','operating_expenses'),
('8113','employment','operating_expenses'),('8114','employment','operating_expenses'),
('8115','employment','operating_expenses'),('8116','employment','operating_expenses'),
('8117','employment','operating_expenses'),('8118','employment','operating_expenses'),
('8202','employment','operating_expenses'),('8204','employment','operating_expenses'),('8205','employment','operating_expenses'),
('8401','admin','operating_expenses'),('8402','admin','operating_expenses'),('8403','admin','operating_expenses'),
('8404','admin','operating_expenses'),('8405','admin','operating_expenses'),('8406','admin','operating_expenses'),
('8407','admin','operating_expenses'),('8408','admin','operating_expenses'),('8409','admin','operating_expenses'),
('8410','admin','operating_expenses'),('8413','admin','operating_expenses'),('8414','admin','operating_expenses'),
('8415','admin','operating_expenses'),('8417','admin','operating_expenses'),('8418','admin','operating_expenses'),
('8419','admin','operating_expenses'),('8420','admin','operating_expenses'),('8421','admin','operating_expenses'),
('8422','admin','operating_expenses'),('8423','admin','operating_expenses'),('8424','admin','operating_expenses'),
('8451','admin','operating_expenses'),('8452','admin','operating_expenses'),('8453','admin','operating_expenses'),
('8454','admin','operating_expenses'),('8455','admin','operating_expenses'),('8456','admin','operating_expenses'),
('8503','establishment','operating_expenses'),('8504','establishment','operating_expenses'),
('8505','establishment','operating_expenses'),('8506','establishment','operating_expenses'),
('8507','establishment','operating_expenses'),('8551','establishment','operating_expenses'),
('8552','establishment','operating_expenses'),('8553','establishment','operating_expenses'),
('8554','establishment','operating_expenses'),('8555','establishment','operating_expenses'),('8556','establishment','operating_expenses'),
('8601','selling','operating_expenses'),('8651','selling','operating_expenses'),('8652','selling','operating_expenses'),
('8653','selling','operating_expenses'),('8654','selling','operating_expenses'),('8655','selling','operating_expenses'),
('8656','selling','operating_expenses'),('8701','selling','operating_expenses'),('8702','selling','operating_expenses'),
('8703','selling','operating_expenses'),('8704','selling','operating_expenses'),
('8801','marketing','operating_expenses'),('8806','marketing','operating_expenses'),('8809','marketing','operating_expenses'),
('8812','marketing','operating_expenses'),('8813','marketing','operating_expenses'),('8814','marketing','operating_expenses'),
('8816','marketing','operating_expenses'),('8817','marketing','operating_expenses'),('8820','marketing','operating_expenses'),
('8901','finance_charges','operating_expenses'),('8902','finance_charges','operating_expenses'),
('8903','finance_charges','operating_expenses'),('8905','finance_charges','operating_expenses'),
('5146000000','other_opex','operating_expenses');

-- ── Finance P&L summary view ─────────────────────────────────────────────
-- Guard: only build the view if its source tables exist. On a fresh prod DB
-- the sync tables may not be present on the very first deploy; the view will
-- be created on a later run once they exist. Re-running this migration is safe
-- because migrate.py records it as applied only on success — but this guard
-- lets the rest of the migration (tables + map) succeed regardless.
DO $$
BEGIN
  IF to_regclass('public.all_sales') IS NOT NULL
     AND to_regclass('public.raw_account_move_lines') IS NOT NULL THEN
    EXECUTE $view$
CREATE OR REPLACE VIEW finance_pl_summary AS
WITH revenue_sales AS (
    SELECT date_trunc('month', all_sales.sale_date::date)::date AS month,
        round(sum(CASE WHEN all_sales.sale_kind = ANY (ARRAY['sale','order']) THEN all_sales.total_sales_kes ELSE 0 END), 0) AS gross_sales,
        round(sum(CASE WHEN all_sales.sale_kind = 'return' THEN all_sales.returns_kes ELSE 0 END), 0) AS returns,
        round(sum(CASE WHEN all_sales.sale_kind = ANY (ARRAY['sale','order']) THEN all_sales.total_sales_kes ELSE 0 END)
            - sum(CASE WHEN all_sales.sale_kind = 'return' THEN all_sales.returns_kes ELSE 0 END), 0) AS net_revenue_pipeline
    FROM all_sales
    WHERE lower(COALESCE(all_sales.product_title, '')) !~~ '%shopping bag%'
      AND lower(COALESCE(all_sales.product_title, '')) !~~ '%gift card%'
      AND lower(COALESCE(all_sales.product_title, '')) !~~ '%gift voucher%'
    GROUP BY date_trunc('month', all_sales.sale_date::date)::date
), acct AS (
    SELECT date_trunc('month', l.date)::date AS month,
        round(sum(CASE WHEN m.pl_group = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0) AS revenue_odoo,
        round(sum(CASE WHEN m.pl_group = 'cogs' THEN l.debit - l.credit ELSE 0 END), 0) AS cogs,
        round(sum(CASE WHEN m.pl_group = 'production' THEN l.debit - l.credit ELSE 0 END), 0) AS production,
        round(sum(CASE WHEN m.pl_group = 'purchases' THEN l.debit - l.credit ELSE 0 END), 0) AS purchases,
        round(sum(CASE WHEN m.pl_group = 'employment' THEN l.debit - l.credit ELSE 0 END), 0) AS employment,
        round(sum(CASE WHEN m.pl_group = 'admin' THEN l.debit - l.credit ELSE 0 END), 0) AS admin,
        round(sum(CASE WHEN m.pl_group = 'establishment' THEN l.debit - l.credit ELSE 0 END), 0) AS establishment,
        round(sum(CASE WHEN m.pl_group = 'selling' THEN l.debit - l.credit ELSE 0 END), 0) AS selling,
        round(sum(CASE WHEN m.pl_group = 'marketing' THEN l.debit - l.credit ELSE 0 END), 0) AS marketing,
        round(sum(CASE WHEN m.pl_group = 'finance_charges' THEN l.debit - l.credit ELSE 0 END), 0) AS finance_charges,
        round(sum(CASE WHEN m.pl_group = 'other_opex' THEN l.debit - l.credit ELSE 0 END), 0) AS other_opex,
        round(sum(CASE WHEN m.pl_group = 'other_income' THEN l.credit - l.debit ELSE 0 END), 0) AS other_income
    FROM raw_account_move_lines l
    JOIN finance_account_map m ON m.account_code = l.account_code
    GROUP BY date_trunc('month', l.date)::date
)
SELECT COALESCE(a.month, r.month) AS month,
    r.gross_sales, r.returns, r.net_revenue_pipeline,
    COALESCE(a.revenue_odoo, 0) AS revenue_odoo,
    COALESCE(a.cogs, 0) AS cogs,
    COALESCE(a.production, 0) AS production,
    COALESCE(a.purchases, 0) AS purchases,
    COALESCE(a.cogs, 0) + COALESCE(a.production, 0) + COALESCE(a.purchases, 0) AS total_costs_of_revenue,
    COALESCE(a.revenue_odoo, 0) - (COALESCE(a.cogs, 0) + COALESCE(a.production, 0) + COALESCE(a.purchases, 0)) AS gross_profit,
    COALESCE(a.employment, 0) AS employment,
    COALESCE(a.admin, 0) AS admin,
    COALESCE(a.establishment, 0) AS establishment,
    COALESCE(a.selling, 0) AS selling,
    COALESCE(a.marketing, 0) AS marketing,
    COALESCE(a.finance_charges, 0) AS finance_charges,
    COALESCE(a.other_opex, 0) AS other_opex,
    COALESCE(a.employment, 0) + COALESCE(a.admin, 0) + COALESCE(a.establishment, 0) + COALESCE(a.selling, 0) + COALESCE(a.marketing, 0) + COALESCE(a.finance_charges, 0) + COALESCE(a.other_opex, 0) AS total_operating_expenses,
    COALESCE(a.other_income, 0) AS other_income,
    COALESCE(a.revenue_odoo, 0) - (COALESCE(a.cogs, 0) + COALESCE(a.production, 0) + COALESCE(a.purchases, 0)) - (COALESCE(a.employment, 0) + COALESCE(a.admin, 0) + COALESCE(a.establishment, 0) + COALESCE(a.selling, 0) + COALESCE(a.marketing, 0) + COALESCE(a.finance_charges, 0) + COALESCE(a.other_opex, 0)) + COALESCE(a.other_income, 0) AS net_profit,
    COALESCE(a.month, r.month) < date_trunc('month', CURRENT_DATE)::date AS is_closed,
    (COALESCE(a.cogs, 0) + COALESCE(a.production, 0) + COALESCE(a.purchases, 0)) > (COALESCE(a.revenue_odoo, 0) * 2) AS has_cost_anomaly
FROM acct a
FULL JOIN revenue_sales r ON r.month = a.month
ORDER BY COALESCE(a.month, r.month);
$view$;
  ELSE
    RAISE NOTICE 'finance_pl_summary skipped: source tables not present yet';
  END IF;
END $$;
