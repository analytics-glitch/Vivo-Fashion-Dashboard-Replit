-- 003_shopzetu_customer_id.sql
-- Add customer_id to raw_shopify_vendor_sales so Shop Zetu sales can carry
-- customer identity (fetched from the GraphQL Orders API, joined by order_id).
-- ShopifyQL itself cannot expose customer_id; it is enriched separately.
-- Idempotent.
ALTER TABLE raw_shopify_vendor_sales ADD COLUMN IF NOT EXISTS customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_rsvs_order_id ON raw_shopify_vendor_sales(order_id);
