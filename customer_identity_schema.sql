-- Customer identity layer — isolated, additive tables. Sync never touches these.
CREATE TABLE IF NOT EXISTS customer_identity (
    person_id           BIGINT       NOT NULL,
    source_system       TEXT         NOT NULL,
    source_customer_id  TEXT         NOT NULL,
    store_id            TEXT,
    display_name        TEXT,
    email_n             TEXT,
    phone9              TEXT,
    name_n              TEXT,
    match_method        TEXT,
    built_at            TIMESTAMP    DEFAULT now(),
    PRIMARY KEY (source_system, source_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_ci_person ON customer_identity (person_id);
CREATE INDEX IF NOT EXISTS idx_ci_srcid  ON customer_identity (source_customer_id);
CREATE INDEX IF NOT EXISTS idx_ci_phone  ON customer_identity (phone9);
CREATE INDEX IF NOT EXISTS idx_ci_email  ON customer_identity (email_n);

CREATE TABLE IF NOT EXISTS customer_identity_review (
    review_id    BIGSERIAL PRIMARY KEY,
    match_key    TEXT,
    key_type     TEXT,
    source_ids   TEXT[],
    names        TEXT[],
    status       TEXT DEFAULT 'pending',
    resolved_by  TEXT,
    resolved_at  TIMESTAMP,
    created_at   TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_identity_override (
    source_system       TEXT NOT NULL,
    source_customer_id  TEXT NOT NULL,
    force_person_id     BIGINT NOT NULL,
    reason              TEXT,
    created_by          TEXT,
    created_at          TIMESTAMP DEFAULT now(),
    PRIMARY KEY (source_system, source_customer_id)
);