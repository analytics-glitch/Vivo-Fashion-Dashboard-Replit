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

-- ============================================================
-- Production Workspace Foundation (additive to the tracker)
-- ============================================================
-- This domain owns planning and execution references only. It deliberately
-- links back to production_orders, production_stages, stage_movements and
-- app_users instead of copying those records. The legacy tracker tables and
-- views above remain the source of truth for Odoo intake and stage history.

CREATE TABLE IF NOT EXISTS production_workspace_factories (
    id              BIGSERIAL PRIMARY KEY,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS production_workspace_lines (
    id              BIGSERIAL PRIMARY KEY,
    factory_id      BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (factory_id, code)
);

CREATE TABLE IF NOT EXISTS production_workspace_shifts (
    id              BIGSERIAL PRIMARY KEY,
    factory_id      BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (factory_id, code)
);

CREATE TABLE IF NOT EXISTS production_workspace_calendars (
    id              BIGSERIAL PRIMARY KEY,
    factory_id      BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    calendar_date   DATE NOT NULL,
    shift_id        BIGINT REFERENCES production_workspace_shifts(id) ON DELETE RESTRICT,
    capacity_minutes NUMERIC NOT NULL DEFAULT 0 CHECK (capacity_minutes >= 0),
    day_status      TEXT NOT NULL DEFAULT 'working'
                    CHECK (day_status IN ('working', 'closed', 'holiday')),
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (factory_id, calendar_date, shift_id)
);

CREATE TABLE IF NOT EXISTS production_workspace_machines (
    id              BIGSERIAL PRIMARY KEY,
    factory_id      BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    line_id         BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (factory_id, code)
);

CREATE TABLE IF NOT EXISTS production_workspace_capabilities (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT REFERENCES production_workspace_machines(id) ON DELETE RESTRICT,
    line_id         BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    capability_key  TEXT NOT NULL,
    name            TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (capability_key)
);

CREATE TABLE IF NOT EXISTS production_workspace_operators (
    id              BIGSERIAL PRIMARY KEY,
    -- Canonical app_users IDs are stored here, but this remains a plain text
    -- reference so the standalone Odoo tracker sync can run its idempotent
    -- schema bootstrap before the BI auth store exists.
    user_id         TEXT,
    operator_code   TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_workspace_skills (
    id              BIGSERIAL PRIMARY KEY,
    skill_key       TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reusable operation master data. Plan revisions copy the selected values into
-- production_workspace_operations so a later SAM edit cannot rewrite history.
CREATE TABLE IF NOT EXISTS production_workspace_operation_definitions (
    id                  BIGSERIAL PRIMARY KEY,
    operation_code      TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    default_sam_minutes NUMERIC NOT NULL CHECK (default_sam_minutes > 0),
    capability_id       BIGINT REFERENCES production_workspace_capabilities(id) ON DELETE SET NULL,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'approved', 'retired')),
    version_token       BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE production_workspace_operation_definitions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE production_workspace_operation_definitions
    DROP CONSTRAINT IF EXISTS production_workspace_operation_definitions_status_check;
ALTER TABLE production_workspace_operation_definitions
    ADD CONSTRAINT production_workspace_operation_definitions_status_check
    CHECK (status IN ('draft', 'approved', 'retired'));

-- Approved production targets are maintained independently from a plan, then
-- selected by planners as the target-output denominator for a dated line plan.
CREATE TABLE IF NOT EXISTS production_workspace_targets (
    id              BIGSERIAL PRIMARY KEY,
    factory_id      BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    line_id         BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    target_date     DATE NOT NULL,
    target_qty      NUMERIC NOT NULL CHECK (target_qty > 0),
    status          TEXT NOT NULL DEFAULT 'approved'
                    CHECK (status IN ('draft', 'approved', 'retired')),
    version_token   BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (factory_id, line_id, target_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_target_grain
    ON production_workspace_targets(factory_id, COALESCE(line_id, -1), target_date);

CREATE TABLE IF NOT EXISTS production_workspace_operator_skills (
    operator_id     BIGINT NOT NULL REFERENCES production_workspace_operators(id) ON DELETE CASCADE,
    skill_id        BIGINT NOT NULL REFERENCES production_workspace_skills(id) ON DELETE RESTRICT,
    skill_level     TEXT,
    verified_at     TIMESTAMPTZ,
    verified_by     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (operator_id, skill_id)
);

CREATE TABLE IF NOT EXISTS production_workspace_work_items (
    id                  BIGSERIAL PRIMARY KEY,
    production_order_ref TEXT REFERENCES production_orders(order_ref) ON DELETE SET NULL,
    external_ref        TEXT NOT NULL,
    style_number        TEXT,
    description         TEXT,
    planned_qty         NUMERIC NOT NULL CHECK (planned_qty > 0),
    stage_key           TEXT REFERENCES production_stages(stage_key),
    owner_user_id       TEXT,
    version_token       BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (external_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_work_item_order
    ON production_workspace_work_items(production_order_ref)
    WHERE production_order_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS production_workspace_operations (
    id              BIGSERIAL PRIMARY KEY,
    work_item_id     BIGINT NOT NULL REFERENCES production_workspace_work_items(id) ON DELETE CASCADE,
    plan_version_id  BIGINT NOT NULL,
    operation_code   TEXT NOT NULL,
    name             TEXT NOT NULL,
    sequence_no      INT NOT NULL CHECK (sequence_no > 0),
    sam_minutes      NUMERIC NOT NULL CHECK (sam_minutes > 0),
    capability_id    BIGINT REFERENCES production_workspace_capabilities(id) ON DELETE SET NULL,
    line_id          BIGINT REFERENCES production_workspace_lines(id) ON DELETE SET NULL,
    version_token    BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by       TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_version_id, sequence_no),
    UNIQUE (plan_version_id, operation_code)
);
CREATE TABLE IF NOT EXISTS production_workspace_plan_versions (
    id                  BIGSERIAL PRIMARY KEY,
    work_item_id        BIGINT NOT NULL REFERENCES production_workspace_work_items(id) ON DELETE RESTRICT,
    version_no          INT NOT NULL CHECK (version_no > 0),
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'submitted', 'approved', 'frozen', 'reopened')),
    factory_id          BIGINT NOT NULL REFERENCES production_workspace_factories(id) ON DELETE RESTRICT,
    line_id             BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    shift_id            BIGINT REFERENCES production_workspace_shifts(id) ON DELETE RESTRICT,
    planned_start       DATE NOT NULL,
    planned_end         DATE NOT NULL,
    planned_qty         NUMERIC NOT NULL CHECK (planned_qty > 0),
    owner_user_id       TEXT,
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    frozen_by           TEXT,
    frozen_at           TIMESTAMPTZ,
    reopened_from_id    BIGINT REFERENCES production_workspace_plan_versions(id) ON DELETE SET NULL,
    reopen_reason       TEXT,
    version_token       BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (work_item_id, version_no),
    CHECK (planned_end >= planned_start)
);
CREATE INDEX IF NOT EXISTS idx_workspace_plan_status
    ON production_workspace_plan_versions(status, updated_at DESC);
-- The first release may be applied to an empty workspace table created by an
-- earlier application process. Backfill any such rows to their only/latest plan
-- before making the plan snapshot relationship mandatory.
ALTER TABLE production_workspace_operations
    ADD COLUMN IF NOT EXISTS plan_version_id BIGINT;
UPDATE production_workspace_operations o
SET plan_version_id = (
    SELECT p.id
    FROM production_workspace_plan_versions p
    WHERE p.work_item_id = o.work_item_id
    ORDER BY p.version_no DESC
    LIMIT 1
)
WHERE o.plan_version_id IS NULL;
ALTER TABLE production_workspace_operations
    ALTER COLUMN plan_version_id SET NOT NULL;
ALTER TABLE production_workspace_operations
    DROP CONSTRAINT IF EXISTS production_workspace_operations_work_item_id_sequence_no_key,
    DROP CONSTRAINT IF EXISTS production_workspace_operations_work_item_id_operation_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_operation_sequence
    ON production_workspace_operations(plan_version_id, sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_operation_code
    ON production_workspace_operations(plan_version_id, operation_code);
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_workspace_operation_plan_version'
    ) THEN
        ALTER TABLE production_workspace_operations
            ADD CONSTRAINT fk_workspace_operation_plan_version
            FOREIGN KEY (plan_version_id)
            REFERENCES production_workspace_plan_versions(id)
            ON DELETE CASCADE;
    END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_calendar_grain
    ON production_workspace_calendars(factory_id, calendar_date, COALESCE(shift_id, -1));

CREATE TABLE IF NOT EXISTS production_workspace_readiness_gates (
    id              BIGSERIAL PRIMARY KEY,
    plan_version_id  BIGINT NOT NULL REFERENCES production_workspace_plan_versions(id) ON DELETE CASCADE,
    gate_key         TEXT NOT NULL,
    gate_name        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'passed', 'failed', 'waived')),
    quality_ref      TEXT,
    evidence_ref     TEXT,
    owner_user_id    TEXT,
    due_date         DATE,
    exception_authorized_by TEXT,
    exception_authorized_at TIMESTAMPTZ,
    checked_by       TEXT,
    checked_at       TIMESTAMPTZ,
    note             TEXT,
    version_token    BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    UNIQUE (plan_version_id, gate_key)
);
ALTER TABLE production_workspace_readiness_gates
    ADD COLUMN IF NOT EXISTS evidence_ref TEXT,
    ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
    ADD COLUMN IF NOT EXISTS due_date DATE,
    ADD COLUMN IF NOT EXISTS exception_authorized_by TEXT,
    ADD COLUMN IF NOT EXISTS exception_authorized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS production_workspace_assignments (
    id              BIGSERIAL PRIMARY KEY,
    plan_version_id  BIGINT NOT NULL REFERENCES production_workspace_plan_versions(id) ON DELETE CASCADE,
    operation_id     BIGINT REFERENCES production_workspace_operations(id) ON DELETE RESTRICT,
    operator_id      BIGINT REFERENCES production_workspace_operators(id) ON DELETE RESTRICT,
    line_id          BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    machine_id       BIGINT REFERENCES production_workspace_machines(id) ON DELETE RESTRICT,
    assignment_role  TEXT NOT NULL DEFAULT 'operator',
    planned_minutes  NUMERIC NOT NULL DEFAULT 0 CHECK (planned_minutes >= 0),
    version_token    BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_version_id, operation_id, operator_id, line_id, machine_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_assignment_grain
    ON production_workspace_assignments(
        plan_version_id, COALESCE(operation_id, -1), COALESCE(operator_id, -1),
        COALESCE(line_id, -1), COALESCE(machine_id, -1)
    );

CREATE TABLE IF NOT EXISTS production_workspace_capacity_inputs (
    id               BIGSERIAL PRIMARY KEY,
    plan_version_id   BIGINT NOT NULL REFERENCES production_workspace_plan_versions(id) ON DELETE CASCADE,
    calendar_id       BIGINT REFERENCES production_workspace_calendars(id) ON DELETE RESTRICT,
    line_id           BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    machine_id        BIGINT REFERENCES production_workspace_machines(id) ON DELETE RESTRICT,
    available_minutes NUMERIC NOT NULL CHECK (available_minutes >= 0),
    required_minutes  NUMERIC NOT NULL CHECK (required_minutes >= 0),
    source             TEXT NOT NULL DEFAULT 'planner',
    version_token     BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_version_id, calendar_id, line_id, machine_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_capacity_grain
    ON production_workspace_capacity_inputs(
        plan_version_id, COALESCE(calendar_id, -1), COALESCE(line_id, -1),
        COALESCE(machine_id, -1)
    );

CREATE TABLE IF NOT EXISTS production_workspace_changeovers (
    id                BIGSERIAL PRIMARY KEY,
    plan_version_id   BIGINT NOT NULL REFERENCES production_workspace_plan_versions(id) ON DELETE CASCADE,
    line_id           BIGINT REFERENCES production_workspace_lines(id) ON DELETE RESTRICT,
    from_work_item_id BIGINT REFERENCES production_workspace_work_items(id) ON DELETE RESTRICT,
    to_work_item_id   BIGINT REFERENCES production_workspace_work_items(id) ON DELETE RESTRICT,
    changeover_date   DATE NOT NULL,
    minutes           NUMERIC NOT NULL CHECK (minutes >= 0),
    note              TEXT,
    version_token     BIGINT NOT NULL DEFAULT 1 CHECK (version_token > 0),
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_version_id, line_id, changeover_date, from_work_item_id, to_work_item_id)
);

CREATE TABLE IF NOT EXISTS production_workspace_execution_references (
    id                  BIGSERIAL PRIMARY KEY,
    plan_version_id      BIGINT REFERENCES production_workspace_plan_versions(id) ON DELETE SET NULL,
    work_item_id        BIGINT NOT NULL REFERENCES production_workspace_work_items(id) ON DELETE RESTRICT,
    production_order_ref TEXT REFERENCES production_orders(order_ref) ON DELETE SET NULL,
    stage_movement_id    BIGINT REFERENCES stage_movements(id) ON DELETE SET NULL,
    reference_type       TEXT NOT NULL,
    reference_key        TEXT NOT NULL,
    quantity             NUMERIC CHECK (quantity IS NULL OR quantity >= 0),
    observed_at          TIMESTAMPTZ,
    note                 TEXT,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reference_type, reference_key)
);

CREATE TABLE IF NOT EXISTS production_workspace_workflow_revisions (
    id              BIGSERIAL PRIMARY KEY,
    plan_version_id  BIGINT NOT NULL REFERENCES production_workspace_plan_versions(id) ON DELETE RESTRICT,
    from_status      TEXT,
    to_status        TEXT NOT NULL,
    reason           TEXT NOT NULL,
    changed_by       TEXT,
    changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision_no      INT NOT NULL CHECK (revision_no > 0),
    UNIQUE (plan_version_id, revision_no)
);

CREATE TABLE IF NOT EXISTS production_workspace_audit_events (
    id              BIGSERIAL PRIMARY KEY,
    entity_type      TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    action           TEXT NOT NULL,
    actor_user_id    TEXT,
    actor_name       TEXT,
    reason           TEXT NOT NULL,
    before_json      JSONB,
    after_json       JSONB,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_entity
    ON production_workspace_audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_time
    ON production_workspace_audit_events(occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_reopened_source
    ON production_workspace_plan_versions(reopened_from_id)
    WHERE reopened_from_id IS NOT NULL;

-- Append-only history is a database rule as well as an API convention.
CREATE OR REPLACE FUNCTION production_workspace_immutable_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Production workspace history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS production_workspace_workflow_immutable
    ON production_workspace_workflow_revisions;
CREATE TRIGGER production_workspace_workflow_immutable
    BEFORE UPDATE OR DELETE ON production_workspace_workflow_revisions
    FOR EACH ROW EXECUTE FUNCTION production_workspace_immutable_history();
DROP TRIGGER IF EXISTS production_workspace_audit_immutable
    ON production_workspace_audit_events;
CREATE TRIGGER production_workspace_audit_immutable
    BEFORE UPDATE OR DELETE ON production_workspace_audit_events
    FOR EACH ROW EXECUTE FUNCTION production_workspace_immutable_history();

-- Plans may only change their detailed inputs before submission or after a
-- governed reopen. This protects frozen snapshots even if a future route is
-- accidentally added without the application-level status check.
CREATE OR REPLACE FUNCTION production_workspace_plan_input_mutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_plan_id BIGINT;
    target_status TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_plan_id := OLD.plan_version_id;
    ELSE
        target_plan_id := NEW.plan_version_id;
    END IF;
    SELECT status INTO target_status
    FROM production_workspace_plan_versions
    WHERE id = target_plan_id;
    IF target_status NOT IN ('draft', 'reopened') THEN
        RAISE EXCEPTION 'Plan inputs are locked once a plan is submitted';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS production_workspace_operations_mutable
    ON production_workspace_operations;
CREATE TRIGGER production_workspace_operations_mutable
    BEFORE INSERT OR UPDATE OR DELETE ON production_workspace_operations
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_input_mutable();
DROP TRIGGER IF EXISTS production_workspace_gates_mutable
    ON production_workspace_readiness_gates;
CREATE TRIGGER production_workspace_gates_mutable
    BEFORE INSERT OR UPDATE OR DELETE ON production_workspace_readiness_gates
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_input_mutable();
DROP TRIGGER IF EXISTS production_workspace_assignments_mutable
    ON production_workspace_assignments;
CREATE TRIGGER production_workspace_assignments_mutable
    BEFORE INSERT OR UPDATE OR DELETE ON production_workspace_assignments
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_input_mutable();
DROP TRIGGER IF EXISTS production_workspace_capacity_mutable
    ON production_workspace_capacity_inputs;
CREATE TRIGGER production_workspace_capacity_mutable
    BEFORE INSERT OR UPDATE OR DELETE ON production_workspace_capacity_inputs
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_input_mutable();
DROP TRIGGER IF EXISTS production_workspace_changeovers_mutable
    ON production_workspace_changeovers;
CREATE TRIGGER production_workspace_changeovers_mutable
    BEFORE INSERT OR UPDATE OR DELETE ON production_workspace_changeovers
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_input_mutable();

-- An assignment is meaningful only within the revision that owns its
-- operation. Keep the relationship valid even if a later route writes SQL
-- directly instead of going through the API check.
CREATE OR REPLACE FUNCTION production_workspace_assignment_operation_matches_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    operation_plan_id BIGINT;
BEGIN
    IF NEW.operation_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT plan_version_id INTO operation_plan_id
    FROM production_workspace_operations
    WHERE id = NEW.operation_id;
    IF operation_plan_id IS NULL OR operation_plan_id <> NEW.plan_version_id THEN
        RAISE EXCEPTION 'Assignment operation must belong to the same plan version';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS production_workspace_assignment_operation_plan_guard
    ON production_workspace_assignments;
CREATE TRIGGER production_workspace_assignment_operation_plan_guard
    BEFORE INSERT OR UPDATE OF plan_version_id, operation_id
    ON production_workspace_assignments
    FOR EACH ROW EXECUTE FUNCTION production_workspace_assignment_operation_matches_plan();

-- Factory-scoped records must describe one coherent production context. These
-- checks intentionally duplicate API validation so direct SQL or a future route
-- cannot create a plan with another factory's line, shift, machine, calendar,
-- or capability.
CREATE OR REPLACE FUNCTION production_workspace_master_scope_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    related_factory_id BIGINT;
    related_line_id BIGINT;
    machine_factory_id BIGINT;
    new_row JSONB := to_jsonb(NEW);
BEGIN
    IF TG_TABLE_NAME = 'production_workspace_calendars'
       AND (new_row->>'shift_id') IS NOT NULL THEN
        SELECT factory_id INTO related_factory_id
        FROM production_workspace_shifts WHERE id = (new_row->>'shift_id')::BIGINT;
        IF related_factory_id IS NULL
           OR related_factory_id <> (new_row->>'factory_id')::BIGINT THEN
            RAISE EXCEPTION 'Calendar shift must belong to the same factory';
        END IF;
    ELSIF TG_TABLE_NAME = 'production_workspace_machines'
       AND (new_row->>'line_id') IS NOT NULL THEN
        SELECT factory_id INTO related_factory_id
        FROM production_workspace_lines WHERE id = (new_row->>'line_id')::BIGINT;
        IF related_factory_id IS NULL
           OR related_factory_id <> (new_row->>'factory_id')::BIGINT THEN
            RAISE EXCEPTION 'Machine line must belong to the same factory';
        END IF;
    ELSIF TG_TABLE_NAME = 'production_workspace_capabilities'
       AND (new_row->>'machine_id') IS NOT NULL THEN
        SELECT factory_id, line_id INTO machine_factory_id, related_line_id
        FROM production_workspace_machines WHERE id = (new_row->>'machine_id')::BIGINT;
        IF machine_factory_id IS NULL THEN
            RAISE EXCEPTION 'Capability machine does not exist';
        END IF;
        IF (new_row->>'line_id') IS NOT NULL THEN
            IF related_line_id IS NOT NULL
               AND related_line_id <> (new_row->>'line_id')::BIGINT THEN
                RAISE EXCEPTION 'Capability machine and line must match';
            END IF;
            SELECT factory_id INTO related_factory_id
            FROM production_workspace_lines WHERE id = (new_row->>'line_id')::BIGINT;
            IF related_factory_id IS NULL THEN
                RAISE EXCEPTION 'Capability line does not exist';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM production_workspace_machines m
                WHERE m.id = (new_row->>'machine_id')::BIGINT
                  AND m.factory_id = related_factory_id
            ) THEN
                RAISE EXCEPTION 'Capability machine and line must share a factory';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production_workspace_plan_scope_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    plan_factory_id BIGINT;
    plan_line_id BIGINT;
    plan_shift_id BIGINT;
    related_factory_id BIGINT;
    related_line_id BIGINT;
    effective_line_id BIGINT;
    capability_machine_id BIGINT;
    capability_line_id BIGINT;
    related_machine_id BIGINT;
    capability_key TEXT;
    operator_is_active BOOLEAN;
    machine_is_active BOOLEAN;
    skill_qualified BOOLEAN;
    new_row JSONB := to_jsonb(NEW);
    old_row JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
BEGIN
    IF TG_TABLE_NAME = 'production_workspace_plan_versions' THEN
        plan_factory_id := (new_row->>'factory_id')::BIGINT;
        plan_line_id := (new_row->>'line_id')::BIGINT;
        plan_shift_id := (new_row->>'shift_id')::BIGINT;
    ELSE
        SELECT factory_id, line_id, shift_id
        INTO plan_factory_id, plan_line_id, plan_shift_id
        FROM production_workspace_plan_versions
        WHERE id = (new_row->>'plan_version_id')::BIGINT;
    END IF;

    IF plan_factory_id IS NULL THEN
        RAISE EXCEPTION 'Production plan factory does not exist';
    END IF;
    IF TG_TABLE_NAME = 'production_workspace_plan_versions' THEN
        IF TG_OP = 'UPDATE'
           AND (
               (new_row->>'factory_id') IS DISTINCT FROM (old_row->>'factory_id')
               OR (new_row->>'line_id') IS DISTINCT FROM (old_row->>'line_id')
               OR (new_row->>'shift_id') IS DISTINCT FROM (old_row->>'shift_id')
                OR (new_row->>'planned_start') IS DISTINCT FROM (old_row->>'planned_start')
                OR (new_row->>'planned_end') IS DISTINCT FROM (old_row->>'planned_end')
           )
           AND EXISTS (
               SELECT 1 FROM production_workspace_operations
               WHERE plan_version_id = (new_row->>'id')::BIGINT
               UNION ALL
               SELECT 1 FROM production_workspace_assignments
               WHERE plan_version_id = (new_row->>'id')::BIGINT
               UNION ALL
               SELECT 1 FROM production_workspace_capacity_inputs
               WHERE plan_version_id = (new_row->>'id')::BIGINT
                UNION ALL
                SELECT 1 FROM production_workspace_changeovers
                WHERE plan_version_id = (new_row->>'id')::BIGINT
           ) THEN
            RAISE EXCEPTION
                'Plan factory, line and shift are locked after planning inputs are added';
        END IF;
        IF plan_line_id IS NOT NULL THEN
            SELECT factory_id INTO related_factory_id
            FROM production_workspace_lines WHERE id = plan_line_id;
            IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
                RAISE EXCEPTION 'Plan line must belong to the selected factory';
            END IF;
        END IF;
        IF plan_shift_id IS NOT NULL THEN
            SELECT factory_id INTO related_factory_id
            FROM production_workspace_shifts WHERE id = plan_shift_id;
            IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
                RAISE EXCEPTION 'Plan shift must belong to the selected factory';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    effective_line_id := COALESCE((new_row->>'line_id')::BIGINT, plan_line_id);
    IF (new_row->>'line_id') IS NOT NULL THEN
        SELECT factory_id INTO related_factory_id
        FROM production_workspace_lines WHERE id = (new_row->>'line_id')::BIGINT;
        IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
            RAISE EXCEPTION 'Plan input line must belong to the plan factory';
        END IF;
        IF plan_line_id IS NOT NULL
           AND (new_row->>'line_id')::BIGINT <> plan_line_id THEN
            RAISE EXCEPTION 'Plan input line must match the plan line';
        END IF;
    END IF;

    IF TG_TABLE_NAME IN ('production_workspace_assignments', 'production_workspace_capacity_inputs')
       AND (new_row->>'machine_id') IS NOT NULL THEN
        SELECT factory_id, line_id INTO related_factory_id, related_line_id
        FROM production_workspace_machines WHERE id = (new_row->>'machine_id')::BIGINT;
        IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
            RAISE EXCEPTION 'Plan input machine must belong to the plan factory';
        END IF;
        IF effective_line_id IS NOT NULL AND related_line_id IS NOT NULL
           AND related_line_id <> effective_line_id THEN
            RAISE EXCEPTION 'Plan input machine must match the plan line';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'production_workspace_assignments'
       AND (new_row->>'operation_id') IS NOT NULL THEN
        SELECT capability_id INTO capability_machine_id
        FROM production_workspace_operations WHERE id = (new_row->>'operation_id')::BIGINT;
        IF capability_machine_id IS NOT NULL THEN
            IF (new_row->>'operator_id') IS NULL OR (new_row->>'machine_id') IS NULL THEN
                RAISE EXCEPTION 'Capability-bound operation assignments require an operator and machine';
            END IF;
            SELECT cap.machine_id, cap.capability_key, worker.active, machine.active,
                   EXISTS (
                       SELECT 1 FROM production_workspace_operator_skills os
                       JOIN production_workspace_skills sk ON sk.id=os.skill_id
                       WHERE os.operator_id=worker.id AND sk.skill_key=cap.capability_key AND sk.active
                   )
            INTO related_machine_id, capability_key, operator_is_active, machine_is_active, skill_qualified
            FROM production_workspace_capabilities cap
            JOIN production_workspace_operators worker ON worker.id=(new_row->>'operator_id')::BIGINT
            JOIN production_workspace_machines machine ON machine.id=(new_row->>'machine_id')::BIGINT
            WHERE cap.id = capability_machine_id;
            IF NOT COALESCE(operator_is_active, FALSE)
               OR NOT COALESCE(machine_is_active, FALSE)
               OR NOT COALESCE(skill_qualified, FALSE) THEN
                RAISE EXCEPTION 'Capability assignment requires active, skill-qualified operator and machine';
            END IF;
            IF related_machine_id IS NOT NULL
               AND related_machine_id <> (new_row->>'machine_id')::BIGINT THEN
                RAISE EXCEPTION 'Assignment machine is incompatible with operation capability';
            END IF;
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'production_workspace_capacity_inputs'
       AND (new_row->>'calendar_id') IS NOT NULL THEN
        SELECT factory_id, shift_id INTO related_factory_id, related_line_id
        FROM production_workspace_calendars WHERE id = (new_row->>'calendar_id')::BIGINT;
        IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
            RAISE EXCEPTION 'Capacity calendar must belong to the plan factory';
        END IF;
        IF plan_shift_id IS NOT NULL AND related_line_id IS NOT NULL
           AND related_line_id <> plan_shift_id THEN
            RAISE EXCEPTION 'Capacity calendar must match the plan shift';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'production_workspace_operations'
       AND (new_row->>'capability_id') IS NOT NULL THEN
        SELECT machine_id, line_id INTO capability_machine_id, capability_line_id
        FROM production_workspace_capabilities WHERE id = (new_row->>'capability_id')::BIGINT;
        IF capability_machine_id IS NULL AND capability_line_id IS NULL
           AND NOT EXISTS (
                SELECT 1 FROM production_workspace_capabilities
                WHERE id = (new_row->>'capability_id')::BIGINT
           ) THEN
            RAISE EXCEPTION 'Operation capability does not exist';
        END IF;
        IF effective_line_id IS NOT NULL AND capability_line_id IS NOT NULL
           AND capability_line_id <> effective_line_id THEN
            RAISE EXCEPTION 'Operation capability must match the plan line';
        END IF;
        IF capability_machine_id IS NOT NULL THEN
            SELECT factory_id, line_id INTO related_factory_id, related_line_id
            FROM production_workspace_machines WHERE id = capability_machine_id;
            IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
                RAISE EXCEPTION 'Operation capability must belong to the plan factory';
            END IF;
            IF effective_line_id IS NOT NULL AND related_line_id IS NOT NULL
               AND related_line_id <> effective_line_id THEN
                RAISE EXCEPTION 'Operation capability machine must match the plan line';
            END IF;
        ELSIF capability_line_id IS NOT NULL THEN
            SELECT factory_id INTO related_factory_id
            FROM production_workspace_lines WHERE id = capability_line_id;
            IF related_factory_id IS NULL OR related_factory_id <> plan_factory_id THEN
                RAISE EXCEPTION 'Operation capability must belong to the plan factory';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS production_workspace_master_scope_guard
    ON production_workspace_calendars;
CREATE TRIGGER production_workspace_master_scope_guard
    BEFORE INSERT OR UPDATE OF factory_id, shift_id
    ON production_workspace_calendars
    FOR EACH ROW EXECUTE FUNCTION production_workspace_master_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_machine_scope_guard
    ON production_workspace_machines;
CREATE TRIGGER production_workspace_machine_scope_guard
    BEFORE INSERT OR UPDATE OF factory_id, line_id
    ON production_workspace_machines
    FOR EACH ROW EXECUTE FUNCTION production_workspace_master_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_capability_scope_guard
    ON production_workspace_capabilities;
CREATE TRIGGER production_workspace_capability_scope_guard
    BEFORE INSERT OR UPDATE OF machine_id, line_id
    ON production_workspace_capabilities
    FOR EACH ROW EXECUTE FUNCTION production_workspace_master_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_plan_scope_guard
    ON production_workspace_plan_versions;
CREATE TRIGGER production_workspace_plan_scope_guard
    BEFORE INSERT OR UPDATE OF factory_id, line_id, shift_id, planned_start, planned_end
    ON production_workspace_plan_versions
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_operation_scope_guard
    ON production_workspace_operations;
CREATE TRIGGER production_workspace_operation_scope_guard
    BEFORE INSERT OR UPDATE OF plan_version_id, line_id, capability_id
    ON production_workspace_operations
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_assignment_scope_guard
    ON production_workspace_assignments;
CREATE TRIGGER production_workspace_assignment_scope_guard
    BEFORE INSERT OR UPDATE OF plan_version_id, operation_id, operator_id, line_id, machine_id
    ON production_workspace_assignments
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_capacity_scope_guard
    ON production_workspace_capacity_inputs;
CREATE TRIGGER production_workspace_capacity_scope_guard
    BEFORE INSERT OR UPDATE OF plan_version_id, calendar_id, line_id, machine_id
    ON production_workspace_capacity_inputs
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_scope_guard();
DROP TRIGGER IF EXISTS production_workspace_changeover_scope_guard
    ON production_workspace_changeovers;
CREATE TRIGGER production_workspace_changeover_scope_guard
    BEFORE INSERT OR UPDATE OF plan_version_id, line_id
    ON production_workspace_changeovers
    FOR EACH ROW EXECUTE FUNCTION production_workspace_plan_scope_guard();

-- Factory ownership is the root of every compatibility check. It is an
-- immutable identity for master records, preventing a direct SQL re-parenting
-- update from invalidating plans and inputs that were valid when saved.
CREATE OR REPLACE FUNCTION production_workspace_factory_owner_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.factory_id IS DISTINCT FROM OLD.factory_id THEN
        RAISE EXCEPTION 'Factory ownership is immutable; create a replacement record instead';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS production_workspace_line_factory_immutable
    ON production_workspace_lines;
CREATE TRIGGER production_workspace_line_factory_immutable
    BEFORE UPDATE OF factory_id ON production_workspace_lines
    FOR EACH ROW EXECUTE FUNCTION production_workspace_factory_owner_immutable();
DROP TRIGGER IF EXISTS production_workspace_shift_factory_immutable
    ON production_workspace_shifts;
CREATE TRIGGER production_workspace_shift_factory_immutable
    BEFORE UPDATE OF factory_id ON production_workspace_shifts
    FOR EACH ROW EXECUTE FUNCTION production_workspace_factory_owner_immutable();
DROP TRIGGER IF EXISTS production_workspace_calendar_factory_immutable
    ON production_workspace_calendars;
CREATE TRIGGER production_workspace_calendar_factory_immutable
    BEFORE UPDATE OF factory_id ON production_workspace_calendars
    FOR EACH ROW EXECUTE FUNCTION production_workspace_factory_owner_immutable();
DROP TRIGGER IF EXISTS production_workspace_machine_factory_immutable
    ON production_workspace_machines;
CREATE TRIGGER production_workspace_machine_factory_immutable
    BEFORE UPDATE OF factory_id ON production_workspace_machines
    FOR EACH ROW EXECUTE FUNCTION production_workspace_factory_owner_immutable();