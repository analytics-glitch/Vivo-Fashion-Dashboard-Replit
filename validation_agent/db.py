"""Database connection helper and DDL for the agent's three private tables.

The agent only ever creates / writes to ``metric_baselines``, ``validation_audit``
and ``validation_exceptions``. It reads the source metric data (``all_sales`` /
``footfall``) but never writes to it except through the governance fence in
``governance.py``.
"""
import contextlib

import psycopg2
import psycopg2.extras

from . import config


def connect(autocommit: bool = True):
    if not config.DATABASE_URL:
        raise RuntimeError(
            "No database URL. Set DATABASE_URL (or VALIDATION_DATABASE_URL)."
        )
    conn = psycopg2.connect(config.DATABASE_URL)
    conn.autocommit = autocommit
    return conn


@contextlib.contextmanager
def cursor(conn):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield cur
    finally:
        cur.close()


DDL = """
CREATE TABLE IF NOT EXISTS metric_baselines (
    id            BIGSERIAL PRIMARY KEY,
    entity_type   TEXT NOT NULL,
    entity        TEXT NOT NULL,
    subcategory   TEXT NOT NULL DEFAULT '__ALL__',
    metric        TEXT NOT NULL,
    period_date   DATE NOT NULL,
    value         DOUBLE PRECISION,
    dow           SMALLINT,
    is_promo      BOOLEAN NOT NULL DEFAULT FALSE,
    folded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_type, entity, subcategory, metric, period_date)
);
CREATE INDEX IF NOT EXISTS ix_baseline_lookup
    ON metric_baselines (entity_type, entity, subcategory, metric, period_date);

CREATE TABLE IF NOT EXISTS validation_audit (
    id            BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    phase         TEXT NOT NULL,
    event         TEXT NOT NULL,
    tier          SMALLINT,
    entity_type   TEXT,
    entity        TEXT,
    subcategory   TEXT,
    metric        TEXT,
    period_date   DATE,
    check_code    TEXT,
    value         DOUBLE PRECISION,
    expected_low  DOUBLE PRECISION,
    expected_high DOUBLE PRECISION,
    detail        JSONB,
    dry_run       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ix_audit_run ON validation_audit (run_id);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON validation_audit (ts);

CREATE TABLE IF NOT EXISTS validation_exceptions (
    id               BIGSERIAL PRIMARY KEY,
    fingerprint      TEXT NOT NULL UNIQUE,
    run_id           UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at      TIMESTAMPTZ,
    status           TEXT NOT NULL DEFAULT 'open',
    tier             SMALLINT NOT NULL,
    severity         TEXT NOT NULL,
    entity_type      TEXT,
    entity           TEXT,
    subcategory      TEXT,
    metric           TEXT,
    period_date      DATE,
    check_code       TEXT,
    broken_identity  TEXT,
    observed         DOUBLE PRECISION,
    expected_low     DOUBLE PRECISION,
    expected_high    DOUBLE PRECISION,
    materiality_kes  DOUBLE PRECISION,
    diagnosis        JSONB,
    proposed_fix_sql TEXT,
    auto_fixable     BOOLEAN NOT NULL DEFAULT FALSE,
    raw_rows         JSONB,
    approval_token   TEXT,
    dry_run          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ix_exc_status ON validation_exceptions (status);
CREATE INDEX IF NOT EXISTS ix_exc_seen ON validation_exceptions (last_seen_at);
"""


def ensure_tables(conn) -> None:
    with cursor(conn) as cur:
        cur.execute(DDL)
