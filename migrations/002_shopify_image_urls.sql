-- 002_shopify_image_urls.sql
-- Shopify product image gallery table. Stores CDN image URLs per SKU (ordered),
-- served by GET /api/product-images/{sku}. Bulk data is populated by
-- extract_shopify_images.py from the Shopify API, NOT by this migration.
-- Idempotent.

CREATE TABLE IF NOT EXISTS product_image_urls (
    sku        TEXT NOT NULL,
    image_url  TEXT NOT NULL,
    position   INT  NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    PRIMARY KEY (sku, image_url)
);
CREATE INDEX IF NOT EXISTS idx_piu_sku ON product_image_urls(sku);
