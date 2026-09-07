-- Persist the normalized Odoo Other Attributes value used by NOOS cover.
ALTER TABLE IF EXISTS raw_fabric_products
    ADD COLUMN IF NOT EXISTS noos_fabric BOOLEAN NOT NULL DEFAULT FALSE;

-- Values in pre-change cover snapshots came from the retired curated list.
-- Version them as legacy so APIs never label or compare them as Odoo NOOS data.
-- A fresh database may not have created this lazy table yet.
DO $$
BEGIN
    IF to_regclass('public.fabric_cover_snapshot') IS NOT NULL THEN
        ALTER TABLE fabric_cover_snapshot
            ADD COLUMN IF NOT EXISTS noos_universe_version TEXT;

        UPDATE fabric_cover_snapshot
        SET noos_universe_version = 'curated-basic-v1'
        WHERE noos_universe_version IS NULL;

        ALTER TABLE fabric_cover_snapshot
            ALTER COLUMN noos_universe_version SET DEFAULT 'odoo-noos-v1',
            ALTER COLUMN noos_universe_version SET NOT NULL;
    END IF;
END
$$;
