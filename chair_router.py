"""
chair_router.py — Phase 10: The Chair
Weekly Sonnet synthesis across all AI Desks. Generates strategic questions for Stephen.
Gate: /api/chair/* — admin only.
"""
import os, logging, requests
from datetime import date, timedelta
import desk_utils as du

log = logging.getLogger(__name__)
DESK = "chair"

ALL_DESKS = [
    "product", "workforce", "customer", "marketing",
    "supply_chain", "production_garment", "retail",
]

_QUESTIONS_SQL = """
SELECT id, run_date, question, source_desk, priority, status,
       answer, answered_by, answered_at, created_at
FROM chair_questions
ORDER BY run_date DESC, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
    WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
LIMIT 100
"""

_OPEN_ISSUES_SQL = """
SELECT desk, COUNT(*) AS open_count,
       COUNT(*) FILTER (WHERE severity IN ('critical','high')) AS high_sev
FROM desk_issues
WHERE status = 'open'
GROUP BY desk
ORDER BY high_sev DESC, open_count DESC
"""

_COACHING_DIGEST_SQL = """
SELECT desk, scope_key, summary, model, run_date
FROM desk_coaching_log
WHERE run_date >= CURRENT_DATE - 7
ORDER BY run_date DESC, desk
"""

_RETAIL_ISSUES_SQL = """
SELECT COUNT(*) AS open_count,
       COUNT(*) FILTER (WHERE severity IN ('high','critical')) AS high_sev
FROM retail_desk_issues
WHERE status = 'open'
"""


def _db_exec(A, sql, params=None):
    if A is not None:
        return A._users_exec(sql, params or [])
    import psycopg2, psycopg2.extras
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or [])
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def _run_chair_synthesis(A, conn) -> dict:
    """Run the weekly Sonnet synthesis across all desk coaching logs and open issues."""
    api_key = os.environ.get("ANTHROPIC_API_KEY","")
    if not api_key:
        return {"note": "AI synthesis not configured (ANTHROPIC_API_KEY missing).",
                "questions": [], "model": None}

    coaching_logs = _db_exec(A, _COACHING_DIGEST_SQL)
    open_issues = _db_exec(A, _OPEN_ISSUES_SQL)
    try:
        retail_issues = _db_exec(A, _RETAIL_ISSUES_SQL)
    except Exception:
        retail_issues = []

    # Combine retail desk issues into the open issues list
    if retail_issues and retail_issues[0].get("open_count", 0):
        open_issues.append({
            "desk": "retail", "open_count": retail_issues[0]["open_count"],
            "high_sev": retail_issues[0].get("high_sev", 0)
        })

    desk_notes = ""
    for log_row in coaching_logs:
        desk = log_row.get("desk","?")
        note = log_row.get("summary","(no note)")
        desk_notes += f"\n## {desk.upper()} DESK\n{note}\n"

    issues_summary = "\n".join(
        f"- {r['desk']}: {r['open_count']} open issues ({r.get('high_sev',0)} high/critical)"
        for r in open_issues
    ) or "No open issues across desks."

    prompt = (
        f"You are The Chair — a strategic intelligence system for Vivo Fashion Group (East Africa).\n"
        f"Today is {date.today().isoformat()}. You have read the weekly AI coaching summaries from "
        f"all operational desks (Retail, Product, Workforce, Customer, Marketing, Supply Chain, "
        f"Garment Production).\n\n"
        f"=== DESK COACHING SUMMARIES (last 7 days) ===\n{desk_notes or 'No desk notes available yet.'}\n\n"
        f"=== OPEN ISSUES BY DESK ===\n{issues_summary}\n\n"
        "Your task:\n"
        "1. Write a 4–6 sentence WEEKLY SYNTHESIS that identifies the 2–3 most important "
        "cross-desk patterns, tensions, or risks facing the business this week.\n"
        "2. Generate exactly 5 STRATEGIC QUESTIONS for Stephen (the CEO/owner) to reflect on or decide. "
        "Each question should require a human decision that data cannot resolve alone "
        "(resource allocation, strategic priority, policy, staff, spend, or partnerships).\n\n"
        "Format your response as follows (use these exact markers):\n"
        "SYNTHESIS:\n<4-6 sentences of synthesis>\n\n"
        "QUESTIONS:\n"
        "1. <question 1> | desk:<source_desk> | priority:<high/medium/low>\n"
        "2. <question 2> | desk:<source_desk> | priority:<high/medium/low>\n"
        "3. <question 3> | desk:<source_desk> | priority:<high/medium/low>\n"
        "4. <question 4> | desk:<source_desk> | priority:<high/medium/low>\n"
        "5. <question 5> | desk:<source_desk> | priority:<high/medium/low>\n"
    )

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-sonnet-4-5", "max_tokens": 800,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=60,
        )
        data = resp.json()
        text = data.get("content",[{}])[0].get("text","")
        synthesis, questions = _parse_chair_output(text)
        return {"synthesis": synthesis, "questions": questions,
                "model": "claude-sonnet-4-5",
                "generated_for": date.today().isoformat()}
    except Exception as e:
        log.warning("chair synthesis error: %s", e)
        return {"synthesis": "Synthesis temporarily unavailable.", "questions": [],
                "model": None, "generated_for": date.today().isoformat()}


def _parse_chair_output(text: str) -> tuple:
    """Parse the structured Chair output into synthesis + question dicts."""
    synthesis = ""
    questions = []
    parts = text.split("QUESTIONS:")
    if len(parts) >= 2:
        synth_part = parts[0].replace("SYNTHESIS:","").strip()
        synthesis = synth_part
        for line in parts[1].strip().split("\n"):
            line = line.strip()
            if not line or not line[0].isdigit():
                continue
            # Strip leading number
            body = line.split(".",1)[-1].strip() if "." in line else line
            # Parse pipes
            segments = [s.strip() for s in body.split("|")]
            question_text = segments[0] if segments else body
            source_desk = "cross"
            priority = "medium"
            for seg in segments[1:]:
                if seg.startswith("desk:"):
                    source_desk = seg[5:].strip()
                elif seg.startswith("priority:"):
                    priority = seg[9:].strip()
            questions.append({"question": question_text,
                               "source_desk": source_desk,
                               "priority": priority})
    else:
        synthesis = text.strip()
    return synthesis, questions


def _save_questions(conn, questions: list):
    """Persist Chair questions for today."""
    # Archive today's existing questions first
    with conn.cursor() as cur:
        cur.execute("UPDATE chair_questions SET status='archived' "
                    "WHERE run_date=CURRENT_DATE AND status='open'")
        for q in questions:
            cur.execute(
                "INSERT INTO chair_questions (run_date,question,source_desk,priority) "
                "VALUES (CURRENT_DATE,%s,%s,%s)",
                (q["question"], q.get("source_desk","cross"),
                 q.get("priority","medium")),
            )
        conn.commit()


def ensure_chair_tables():
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        du.ensure_desk_tables(conn)
    finally:
        conn.close()


def register_chair_routes(app, A):
    _A = A

    @app.get("/api/chair/overview")
    async def chair_overview():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            questions_raw = _db_exec(_A, _QUESTIONS_SQL)
            open_issues_raw = _db_exec(_A, _OPEN_ISSUES_SQL)
            coaching_raw = _db_exec(_A, _COACHING_DIGEST_SQL)

            def _c(rows):
                out = []
                for r in rows:
                    out.append({k: (v.isoformat() if hasattr(v,"isoformat") else v)
                                for k, v in r.items() if v is not None})
                return out

            # Get last Chair synthesis from coaching cache
            synthesis_rec = du.get_coaching(conn, DESK, "weekly_synthesis")

            # Last run date
            last_run = None
            if questions_raw:
                for r in questions_raw:
                    rd = r.get("run_date")
                    if rd:
                        last_run = rd.isoformat() if hasattr(rd,"isoformat") else str(rd)
                        break

            return {
                "as_of": date.today().isoformat(),
                "last_run": last_run,
                "synthesis": synthesis_rec,
                "questions": _c(questions_raw),
                "desk_issues_summary": _c(open_issues_raw),
                "recent_coaching": _c(coaching_raw[-5:]),
            }
        finally:
            conn.close()

    @app.post("/api/chair/run")
    async def chair_run():
        """Trigger a Chair synthesis run (admin-only, called manually or weekly)."""
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            result = _run_chair_synthesis(_A, conn)
            # Persist questions
            if result.get("questions"):
                _save_questions(conn, result["questions"])
            # Cache synthesis
            if result.get("synthesis"):
                du.save_coaching(conn, DESK, result["synthesis"],
                                 scope_key="weekly_synthesis",
                                 model=result.get("model",""))
            return {"ok": True, "questions_generated": len(result.get("questions",[])),
                    "synthesis_preview": (result.get("synthesis") or "")[:200]}
        finally:
            conn.close()

    @app.get("/api/chair/questions")
    async def chair_questions():
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            rows = _db_exec(_A, _QUESTIONS_SQL)
            out = []
            for r in rows:
                out.append({k: (v.isoformat() if hasattr(v,"isoformat") else v)
                            for k, v in r.items() if v is not None})
            return {"questions": out}
        finally:
            conn.close()

    @app.post("/api/chair/questions/{question_id}/answer")
    async def chair_answer_question(question_id: int, request):
        body = await request.json()
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE chair_questions SET answer=%s, answered_by=%s, "
                    "answered_at=now(), status='answered' WHERE id=%s RETURNING id",
                    (body.get("answer",""), body.get("answered_by",""), question_id),
                )
                ok = cur.fetchone() is not None
                conn.commit()
            return {"ok": ok}
        finally:
            conn.close()
