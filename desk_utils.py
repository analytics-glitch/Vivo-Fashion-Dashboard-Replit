"""
desk_utils.py — Shared infrastructure for all AI Desks (Phases 4-10).
Provides: shared DB tables, issue register CRUD, coaching log cache, gap helpers.

Tables created here (all desks share them, keyed by desk name):
  desk_issues        — issue register (all desks)
  desk_coaching_log  — daily AI coaching cache (all desks)
  chair_questions    — The Chair's weekly strategic questions
"""
import os, sys, logging, json as _json
from datetime import date, datetime

log = logging.getLogger(__name__)

# ── SOH / Sales filter constants (mirror api_pg.py — kept in sync manually) ──
WAREHOUSE_LOCATIONS = (
    "'Warehouse Finished Goods','Warehouse Receiving','In Transit',"
    "'Holding Warehouse Finished Goods','Finished Goods Production','Production',"
    "'Buying & Merchandise','Raw Materials','Fabric Trimming','Dead Stock Fabric',"
    "'Cutting - Spreading','Washing','Wandia','Galleria Holding','Studio Location',"
    "'Product Development','Repairs','Sampling Fabric','Sampling','Sale Stock',"
    "'Shopping Bags','Recall Location','Fabric Production','Defects Location',"
    "'Staff purchases',"
    "'Sew/Stock/A','Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E'"
)
PIPELINE_LOCATIONS = (
    "'Fabric Trimming','Finished Goods Production',"
    "'Sew/Stock/A','Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E'"
)
SALES_EXCLUSIONS = (
    "'Staff purchases','Manual Order','Online - vivo-uganda',"
    "'Online - vivowoman','Online Orders Location'"
)
THIRD_PARTY_BRANDS = "('Third Party Brand','Third Party Brands')"

# ── DDL ──────────────────────────────────────────────────────────────────────

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS desk_issues (
        id          BIGSERIAL PRIMARY KEY,
        desk        TEXT NOT NULL,
        scope_key   TEXT,
        title       TEXT NOT NULL,
        body        TEXT,
        source      TEXT NOT NULL DEFAULT 'manual',
        severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
        status      TEXT NOT NULL DEFAULT 'open'   CHECK (status IN ('open','closed')),
        owner_email TEXT,
        opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at   TIMESTAMPTZ,
        closed_by   TEXT,
        metadata    JSONB
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_desk_issues_desk ON desk_issues (desk, status)",
    """
    CREATE TABLE IF NOT EXISTS desk_coaching_log (
        id          BIGSERIAL PRIMARY KEY,
        desk        TEXT NOT NULL,
        scope_key   TEXT NOT NULL DEFAULT 'overview',
        run_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        summary     TEXT,
        model       TEXT,
        tokens_used INT,
        created_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (desk, scope_key, run_date)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS chair_questions (
        id          BIGSERIAL PRIMARY KEY,
        run_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        question    TEXT NOT NULL,
        source_desk TEXT,
        priority    TEXT NOT NULL DEFAULT 'medium',
        status      TEXT NOT NULL DEFAULT 'open',
        answer      TEXT,
        answered_by TEXT,
        answered_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_chair_questions_date ON chair_questions (run_date DESC)",
    # Add structured column to coaching log (safe, idempotent)
    "ALTER TABLE IF EXISTS desk_coaching_log ADD COLUMN IF NOT EXISTS structured JSONB",
]


def ensure_desk_tables(conn):
    """Create all shared desk tables. Idempotent."""
    with conn.cursor() as cur:
        for stmt in _DDL:
            try:
                cur.execute(stmt)
            except Exception as e:
                conn.rollback()
                log.warning("desk_utils DDL: %s", e)
        conn.commit()
    log.info("desk_utils tables ready")


# ── Issue register CRUD ───────────────────────────────────────────────────────

def list_issues(conn, desk: str, scope_key: str = None, status: str = None) -> list:
    with conn.cursor() as cur:
        wheres = ["desk = %s"]
        params = [desk]
        if scope_key:
            wheres.append("scope_key = %s"); params.append(scope_key)
        if status:
            wheres.append("status = %s"); params.append(status)
        cur.execute(
            f"SELECT id,desk,scope_key,title,body,source,severity,status,"
            f"owner_email,opened_at,closed_at,closed_by,metadata "
            f"FROM desk_issues WHERE {' AND '.join(wheres)} "
            f"ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
            f"WHEN 'medium' THEN 2 ELSE 3 END, opened_at DESC LIMIT 100",
            params,
        )
        cols = [d[0] for d in cur.description]
        rows = []
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            for k in ("opened_at", "closed_at"):
                if d.get(k): d[k] = d[k].isoformat()
            rows.append(d)
    return rows


def create_issue(conn, desk: str, title: str, body: str = None,
                 source: str = "manual", severity: str = "medium",
                 owner_email: str = None, scope_key: str = None,
                 metadata: dict = None) -> dict:
    import json as _json
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO desk_issues (desk,scope_key,title,body,source,severity,owner_email,metadata) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id,opened_at",
            (desk, scope_key, title, body, source, severity, owner_email,
             _json.dumps(metadata) if metadata else None),
        )
        row = cur.fetchone()
        conn.commit()
    return {"id": row[0], "opened_at": row[1].isoformat()}


def close_issue(conn, issue_id: int, closed_by: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE desk_issues SET status='closed', closed_at=now(), closed_by=%s "
            "WHERE id=%s AND status='open' RETURNING id",
            (closed_by, issue_id),
        )
        ok = cur.fetchone() is not None
        conn.commit()
    return ok


def _strip_json(text: str) -> str:
    """Strip markdown code fences that LLMs sometimes wrap JSON in."""
    text = text.strip()
    if text.startswith("```"):
        text = text[text.find("\n") + 1:]
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    return text.strip()


_INTEL_SYSTEM = """You are an elite strategy analyst for Vivo Fashion Group — a vertically-integrated multi-brand fashion retailer operating across East Africa (Kenya, Uganda, Rwanda) and Online. All amounts are in KES.

Analyse the data rigorously. Respond ONLY with valid JSON (no markdown fences, no commentary outside the JSON) in this exact schema:
{
  "risks": [{"title": "...", "evidence": "...", "severity": "critical|high|medium|low", "action": "..."}],
  "opportunities": [{"title": "...", "evidence": "...", "action": "..."}],
  "proposals": [{"text": "...", "priority": "high|medium|low", "timeframe": "immediate|this week|this month"}],
  "summary": "..."
}

Rules:
- Max 3 risks, 2 opportunities, 3 proposals. Summary: 1-2 sentences, plain text.
- Rank risks by severity (highest first). "critical" means immediate material financial or operational impact.
- Be specific: name numbers, stores, percentages, time periods. Never be vague or generic.
- Proposals must be concrete next actions (not observations). Name who should do what.
- Opportunities: only surface where evidence points to a clearly realizable upside.
- If data is insufficient for a section, return an empty array for that section.
- Do NOT fabricate metrics or infer data not provided."""


def call_llm_structured(api_key: str, context_text: str, desk: str,
                         scope_key: str = "overview", conn=None) -> dict:
    """
    Call Claude haiku with structured JSON intelligence request.
    Returns: {note, structured: {risks, opportunities, proposals, summary}, model, generated_for}
    Auto-flags critical/high risks as issues when conn is provided.
    """
    if not api_key:
        return {"note": "AI not configured.", "structured": None,
                "model": None, "generated_for": date.today().isoformat()}
    try:
        import requests as _req
        resp = _req.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-haiku-4-5", "max_tokens": 900,
                  "system": _INTEL_SYSTEM,
                  "messages": [{"role": "user", "content": context_text}]},
            timeout=45,
        )
        raw = resp.json().get("content", [{}])[0].get("text", "")
        structured = _json.loads(_strip_json(raw))
        note = structured.get("summary", "")

        # Auto-flag critical/high risks as issues immediately
        if conn is not None:
            for r in structured.get("risks", []):
                if r.get("severity") in ("critical", "high"):
                    auto_flag_issue(
                        conn, desk=desk, scope_key=scope_key,
                        title=r.get("title", "Auto-detected risk"),
                        body=(f"{r.get('evidence', '')} — "
                              f"Recommended action: {r.get('action', '')}"),
                        severity=r["severity"],
                        dedup_window_days=7,
                    )

        return {"note": note, "structured": structured,
                "model": "claude-haiku-4-5",
                "generated_for": date.today().isoformat()}

    except _json.JSONDecodeError as e:
        log.warning("call_llm_structured [%s/%s] JSON parse error: %s", desk, scope_key, e)
        # Fall back to plain-text note so something is shown
        return {"note": raw[:600] if "raw" in dir() and raw else "Coaching unavailable.",
                "structured": None, "model": "claude-haiku-4-5",
                "generated_for": date.today().isoformat()}
    except Exception as e:
        log.warning("call_llm_structured [%s/%s]: %s", desk, scope_key, e)
        return {"note": "Coaching temporarily unavailable.", "structured": None,
                "model": None, "generated_for": date.today().isoformat()}


def auto_flag_issue(conn, desk: str, scope_key: str, title: str,
                    body: str, severity: str = "medium",
                    dedup_window_days: int = 14) -> bool:
    """Create an auto issue unless a recent one with the same title exists."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM desk_issues WHERE desk=%s AND scope_key=%s "
            "AND source='auto' AND title=%s AND status='open' "
            "AND opened_at >= now() - (%s || ' days')::interval",
            (desk, scope_key, title, str(dedup_window_days)),
        )
        if cur.fetchone():
            return False
    create_issue(conn, desk=desk, scope_key=scope_key, title=title,
                 body=body, source="auto", severity=severity)
    return True


# ── Coaching cache ────────────────────────────────────────────────────────────

def get_coaching(conn, desk: str, scope_key: str = "overview") -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT summary, structured, model, created_at FROM desk_coaching_log "
            "WHERE desk=%s AND scope_key=%s AND run_date=CURRENT_DATE",
            (desk, scope_key),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {"note": row[0], "structured": row[1],  # row[1] = JSONB, parsed by psycopg2
            "model": row[2], "generated_for": date.today().isoformat(),
            "cached_at": row[3].isoformat() if row[3] else None}


def save_coaching(conn, desk: str, summary: str, structured=None,
                  scope_key: str = "overview", model: str = "unknown",
                  tokens_used: int = None):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO desk_coaching_log "
            "(desk, scope_key, run_date, summary, structured, model, tokens_used) "
            "VALUES (%s,%s,CURRENT_DATE,%s,%s,%s,%s) "
            "ON CONFLICT (desk,scope_key,run_date) DO UPDATE SET "
            "summary=EXCLUDED.summary, structured=EXCLUDED.structured, "
            "model=EXCLUDED.model, tokens_used=EXCLUDED.tokens_used, created_at=now()",
            (desk, scope_key, summary,
             _json.dumps(structured) if structured else None,
             model, tokens_used),
        )
        conn.commit()


# ── Gap register helper ───────────────────────────────────────────────────────

def register_gap(conn, domain: str, gap_name: str, details: str,
                 impact: str = "medium", status: str = "identified"):
    """Upsert a row into ai_data_gap_register (if the table exists)."""
    with conn.cursor() as cur:
        try:
            cur.execute(
                "INSERT INTO ai_data_gap_register (domain,gap_name,details,impact,status) "
                "VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (domain,gap_name) DO NOTHING",
                (domain, gap_name, details, impact, status),
            )
            conn.commit()
        except Exception:
            conn.rollback()


# ── Lightweight psycopg2 connection helper (for standalone / nightly mode) ───

def _get_raw_conn():
    import psycopg2
    return psycopg2.connect(os.environ["DATABASE_URL"])
