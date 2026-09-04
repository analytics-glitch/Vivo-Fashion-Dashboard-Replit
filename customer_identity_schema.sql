-- Additive durable customer identity schema.  Apply before canonical refresh.
CREATE TABLE IF NOT EXISTS customer_person_registry (
    person_id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_identity_registry (
    source_key TEXT PRIMARY KEY,
    person_id BIGINT NOT NULL REFERENCES customer_person_registry(person_id),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_identity (
    person_id BIGINT NOT NULL,
    source_key TEXT,
    source_system TEXT NOT NULL,
    source_customer_id TEXT NOT NULL,
    store_id TEXT,
    display_name TEXT, email_n TEXT, phone9 TEXT, name_n TEXT, match_method TEXT,
    built_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE customer_identity ADD COLUMN IF NOT EXISTS source_key TEXT;
UPDATE customer_identity SET source_key = source_system || ':' || COALESCE(store_id,'') || ':' || source_customer_id
 WHERE source_key IS NULL;
ALTER TABLE customer_identity DROP CONSTRAINT IF EXISTS customer_identity_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_source_key_uq ON customer_identity(source_key);
CREATE INDEX IF NOT EXISTS idx_ci_person ON customer_identity(person_id);
CREATE INDEX IF NOT EXISTS idx_ci_phone ON customer_identity(phone9);
INSERT INTO customer_person_registry(person_id)
 SELECT DISTINCT person_id FROM customer_identity WHERE person_id IS NOT NULL
 ON CONFLICT DO NOTHING;
SELECT setval(
 pg_get_serial_sequence('customer_person_registry','person_id'),
 COALESCE((SELECT MAX(person_id) FROM customer_person_registry), 1),
 true
);
ALTER TABLE customer_identity DROP CONSTRAINT IF EXISTS customer_identity_person_fk;
ALTER TABLE customer_identity ADD CONSTRAINT customer_identity_person_fk
 FOREIGN KEY(person_id) REFERENCES customer_person_registry(person_id) NOT VALID;

CREATE TABLE IF NOT EXISTS customer_identity_publish_lock (
    lock_name TEXT PRIMARY KEY, touched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_identity_publish (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    published_at TIMESTAMPTZ, source_rows INTEGER, source_fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'never', error TEXT
);
ALTER TABLE customer_identity_publish ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE TABLE IF NOT EXISTS customer_identity_publish_source (
    source_system TEXT NOT NULL,
    store_id TEXT NOT NULL,
    source_rows INTEGER NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_system, store_id)
);
CREATE TABLE IF NOT EXISTS customer_identity_review (
    review_id BIGSERIAL PRIMARY KEY, source_key TEXT, match_key TEXT, key_type TEXT,
    source_ids TEXT[], names TEXT[], status TEXT NOT NULL DEFAULT 'pending',
    resolved_by TEXT, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(source_key, match_key, key_type)
);
ALTER TABLE customer_identity_review ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_review_source_phone_uq
 ON customer_identity_review(source_key,match_key,key_type);
CREATE TABLE IF NOT EXISTS customer_identity_override (
    source_system TEXT NOT NULL, source_customer_id TEXT NOT NULL,
    store_id TEXT, source_key TEXT, force_person_id BIGINT NOT NULL,
    reason TEXT, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ
);
ALTER TABLE customer_identity_override ADD COLUMN IF NOT EXISTS store_id TEXT;
ALTER TABLE customer_identity_override ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE customer_identity_override ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
-- Populate only unambiguous legacy rows. Shopify rows without a store remain
-- NULL/inert rather than accidentally affecting every same-ID store.
UPDATE customer_identity_override
 SET source_key=source_system || ':' ||
   CASE WHEN source_system='odoo' THEN 'vivofashiongroup' ELSE store_id END ||
   ':' || source_customer_id
 WHERE source_key IS NULL
   AND (store_id IS NOT NULL OR source_system='odoo');
ALTER TABLE customer_identity_override
 DROP CONSTRAINT IF EXISTS customer_identity_override_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_override_source_key_uq
 ON customer_identity_override(source_key) WHERE source_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS customer_identity_override_audit (
    audit_id BIGSERIAL PRIMARY KEY, source_key TEXT NOT NULL, force_person_id BIGINT NOT NULL,
    reason TEXT, created_by TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_people (
    person_id BIGINT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, source_records INTEGER,
    systems TEXT, is_pseudo BOOLEAN, total_orders BIGINT, total_spend_kes NUMERIC,
    first_purchase DATE, last_purchase DATE, customer_type TEXT, built_at TIMESTAMPTZ
);