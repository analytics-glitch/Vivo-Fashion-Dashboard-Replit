#!/usr/bin/env python3
"""One-time, idempotent migration from BI PD Flow into Product Workspace PLM.

The source tables live in the default PostgreSQL schema used by the BI API.
The target is the Product Workspace schema. Existing target styles are never
updated or overwritten; reruns only add missing source rows/history.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime
from typing import Any

import psycopg2
import psycopg2.extras


TARGET_SCHEMA = "product_workspace"
SOURCE_SYSTEM = "pd_flow_import"

MAIN_STAGES = [
    "Concept",
    "Initial Design Tech Pack",
    "Pattern",
    "Initial Sample",
    "Fit Session",
    "Approved",
    "Grading",
    "Costing Sample",
    "In Development",
    "Production",
    "Launched",
]
SIDE_STAGES = ["On Hold", "Dropped"]
ALL_STAGES = set(MAIN_STAGES + SIDE_STAGES)


def _normalise(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def canonical_stage(value: Any, status: Any = None, outcome: Any = None) -> str:
    """Map BI's 9-stage vocabulary and common variants to the PLM vocabulary."""
    key = _normalise(value)
    status_key = _normalise(status)
    outcome_key = _normalise(outcome)
    if "drop" in key or "cancel" in key or "drop" in status_key or "cancel" in outcome_key:
        return "Dropped"
    if "hold" in key or "pause" in key:
        return "On Hold"
    if key in {"adopted", "brief", "concept", "idea", "new"}:
        return "Concept"
    if "tech pack" in key or "technical pack" in key or key in {"design", "cad"}:
        return "Initial Design Tech Pack"
    if "pattern" in key and "transfer" not in key:
        return "Pattern"
    if key in {"sampling", "sample", "initial sample", "proto", "prototype"}:
        return "Initial Sample"
    if "sample review" in key or key in {"review", "fit", "fit session", "fit review"}:
        return "Fit Session"
    if "approved" in key or "final review" in key or key in {"approval", "approved for ss"}:
        return "Approved"
    if "grading" in key or "pattern transfer" in key:
        return "Grading"
    if "buying" in key or "cost" in key or "set sample" in key:
        return "Costing Sample"
    if "production" in key or "development" in key or key in {"in development", "cad"}:
        return "In Development"
    if "launched" in key or "launch" in key:
        return "Launched"
    # The source's adopted/pattern/sampling/review vocabulary is the normal
    # path. Unknown variants are safest at Concept rather than inventing a
    # later stage and falsely implying completed work.
    return "Concept"


def normalise_brand(value: Any) -> str:
    key = _normalise(value)
    if "safari" in key:
        return "Safari by Vivo"
    if "zoya" in key:
        return "Zoya"
    return "Vivo"


def as_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
        except ValueError:
            pass
    return date.today()


def as_timestamp(value: Any) -> Any:
    return value or datetime.now().astimezone()


def data_url(image_data: Any, content_type: Any) -> str | None:
    if not image_data:
        return None
    raw = str(image_data)
    if raw.startswith("data:") or raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return f"data:{content_type or 'image/jpeg'};base64,{raw}"


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    counts = {"copied": 0, "history_created": 0, "skipped": 0}

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # The existing PLM table uses `code` and `stage` as its canonical
            # fields. These additive aliases retain the requested source
            # identity and migration metadata without breaking existing pages.
            cur.execute(f"""
                ALTER TABLE {TARGET_SCHEMA}.styles
                  ADD COLUMN IF NOT EXISTS style_number TEXT,
                  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
                  ADD COLUMN IF NOT EXISTS launch_week TEXT NOT NULL DEFAULT '',
                  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
            """)
            cur.execute(f"""
                UPDATE {TARGET_SCHEMA}.styles
                   SET style_number = code
                 WHERE style_number IS NULL OR style_number = '';
            """)
            cur.execute(f"""
                CREATE UNIQUE INDEX IF NOT EXISTS styles_style_number_uq
                    ON {TARGET_SCHEMA}.styles (style_number);
            """)
            # A source movement id is needed because the existing stage_history
            # contract has no natural source key. It makes history reruns safe.
            cur.execute(f"""
                ALTER TABLE {TARGET_SCHEMA}.stage_history
                  ADD COLUMN IF NOT EXISTS source_system TEXT,
                  ADD COLUMN IF NOT EXISTS source_movement_id BIGINT;
            """)
            cur.execute(f"""
                CREATE UNIQUE INDEX IF NOT EXISTS stage_history_source_movement_uq
                    ON {TARGET_SCHEMA}.stage_history (source_system, source_movement_id)
                 WHERE source_system IS NOT NULL AND source_movement_id IS NOT NULL;
            """)

            cur.execute("""
                SELECT s.*, i.image_data, i.content_type
                  FROM public.pd_styles s
             LEFT JOIN public.pd_style_images i ON i.style_id = s.id
                 WHERE (
                        s.status = 'active'
                        AND (
                            lower(COALESCE(s.outcome, '')) <> 'cancelled'
                            OR lower(COALESCE(s.current_stage, '')) = 'dropped'
                        )
                    )
                    OR (
                        lower(COALESCE(s.status, '')) IN ('dropped', 'cancelled')
                        AND lower(COALESCE(s.current_stage, '')) = 'dropped'
                    )
                ORDER BY s.id
            """)
            source_styles = cur.fetchall()

            for source in source_styles:
                style_number = (source.get("style_number") or "").strip()
                if not style_number:
                    counts["skipped"] += 1
                    continue
                if style_number.upper().startswith(("TEST", "PLACEHOLDER")):
                    counts["skipped"] += 1
                    continue

                stage = canonical_stage(
                    source.get("current_stage"),
                    source.get("status"),
                    source.get("outcome"),
                )
                created_at = source.get("adoption_date") or source.get("created_at") or datetime.now().astimezone()
                stage_entered_at = source.get("stage_entered_at") or created_at
                progress = round((MAIN_STAGES.index(stage) / (len(MAIN_STAGES) - 1)) * 100) if stage in MAIN_STAGES else 0
                image = data_url(source.get("image_data"), source.get("content_type"))
                notes = (source.get("fabric_name") or "").strip()

                cur.execute(f"""
                    INSERT INTO {TARGET_SCHEMA}.styles
                        (code, style_number, name, brand, category, sub_category, theme,
                         order_type, tier, status, stage, stage_entered_at, owner,
                         designer, pattern_maker, target_date, image, progress, market,
                         notes, launch_week, source, created_at, updated_at)
                    VALUES
                        (%s,%s,%s,%s,%s,%s,%s,%s,'Core',%s,%s,%s,%s,%s,%s,%s,%s,%s,
                         'EA',%s,%s,%s,%s,NOW())
                    ON CONFLICT (style_number) DO NOTHING
                    RETURNING id
                """, (
                    style_number,
                    style_number,
                    (source.get("style_name") or style_number).strip(),
                    normalise_brand(source.get("brand")),
                    (source.get("category") or "Uncategorised").strip(),
                    (source.get("sub_category") or "").strip(),
                    (source.get("theme") or "").strip(),
                    "New",
                    stage,
                    stage,
                    stage_entered_at,
                    (source.get("assignee_name") or source.get("created_by_name") or "").strip(),
                    (source.get("assignee_name") or "").strip(),
                    (source.get("pattern_maker") or "").strip(),
                    as_date(source.get("adoption_date") or source.get("created_at")),
                    image,
                    progress,
                    notes,
                    (source.get("target_order_week") or "").strip(),
                    SOURCE_SYSTEM,
                    created_at,
                ))
                inserted = cur.fetchone()
                if not inserted:
                    counts["skipped"] += 1
                    continue

                counts["copied"] += 1
                target_id = inserted["id"]

                # Preserve the initial imported state even if BI has no
                # movement row for a style.
                cur.execute(f"""
                    INSERT INTO {TARGET_SCHEMA}.stage_history
                        (style_id, from_stage, to_stage, note, created_at,
                         source_system, source_movement_id)
                    VALUES (%s,NULL,%s,%s,%s,%s,NULL)
                    ON CONFLICT DO NOTHING
                """, (
                    target_id,
                    stage,
                    "Initial state imported from BI PD Flow",
                    stage_entered_at,
                    SOURCE_SYSTEM,
                ))
                counts["history_created"] += cur.rowcount

                cur.execute("""
                    SELECT id, from_stage, to_stage, decisions, created_at
                      FROM public.pd_movements
                     WHERE style_id = %s
                     ORDER BY created_at, id
                """, (source["id"],))
                for movement in cur.fetchall():
                    from_stage = canonical_stage(movement.get("from_stage"))
                    to_stage = canonical_stage(movement.get("to_stage"))
                    note = (movement.get("decisions") or "").strip()
                    cur.execute(f"""
                        INSERT INTO {TARGET_SCHEMA}.stage_history
                            (style_id, from_stage, to_stage, note, created_at,
                             source_system, source_movement_id)
                        VALUES (%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (source_system, source_movement_id)
                        WHERE source_system IS NOT NULL AND source_movement_id IS NOT NULL
                        DO NOTHING
                    """, (
                        target_id,
                        from_stage,
                        to_stage,
                        note,
                        as_timestamp(movement.get("created_at")),
                        SOURCE_SYSTEM,
                        movement["id"],
                    ))
                    counts["history_created"] += cur.rowcount

                # Stage notes are also preserved in the audit trail, since the
                # target has no separate notes table.
                cur.execute("""
                    SELECT id, stage_key, note, created_at
                      FROM public.pd_stage_notes
                     WHERE style_id = %s
                     ORDER BY created_at, id
                """, (source["id"],))
                for stage_note in cur.fetchall():
                    note_stage = canonical_stage(stage_note.get("stage_key"))
                    cur.execute(f"""
                        INSERT INTO {TARGET_SCHEMA}.stage_history
                            (style_id, from_stage, to_stage, note, created_at,
                             source_system, source_movement_id)
                        VALUES (%s,NULL,%s,%s,%s,%s,%s)
                        ON CONFLICT (source_system, source_movement_id)
                        WHERE source_system IS NOT NULL AND source_movement_id IS NOT NULL
                        DO NOTHING
                    """, (
                        target_id,
                        note_stage,
                        (stage_note.get("note") or "").strip(),
                        as_timestamp(stage_note.get("created_at")),
                        SOURCE_SYSTEM,
                        -int(stage_note["id"]),
                    ))
                    counts["history_created"] += cur.rowcount

            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(f"PD Flow → Product Workspace migration complete")
    print(f"styles copied: {counts['copied']}")
    print(f"stage history entries created: {counts['history_created']}")
    print(f"styles skipped: {counts['skipped']}")


if __name__ == "__main__":
    main()