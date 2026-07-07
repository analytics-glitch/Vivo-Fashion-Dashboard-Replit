"""Step 4 -- the governance fence around financial numbers.

A fix is auto-applied ONLY when all three hold:
  1. it is reversible (an UPDATE, never DELETE/DROP/TRUNCATE; the database
     checkpoint / time-travel is the backstop),
  2. it matches a recognised, registered pattern whose builder declares the exact
     source table(s) it may touch, and
  3. the affected value is below the materiality threshold (default KES 50,000).

Anything that is not auto-fixable ESCALATES to ``validation_exceptions`` and is
never changed automatically -- there is no silent "log only" path. By default NO
fix patterns are registered, so the fence is closed: every exception escalates
until an operator explicitly enables a pattern. Applied fixes run in a single
transaction and are rejected unless they touch only the pattern's allowlisted
tables with an allowed (reversible) operation.

Severity governs alert routing only:
  * red   -> material or structurally impossible -> needs human approval.
  * amber -> immaterial / a real business event  -> informational, still recorded.
"""
from . import config, db

FIX_PATTERNS: dict = {}

_STRUCTURAL = {"net_le_total", "conversion_le_one"}
_FORBIDDEN_SQL = ("DROP", "TRUNCATE", "DELETE", "ALTER", "GRANT", "INSERT",
                  "CREATE", "MERGE", "WITH", ";")
_ALLOWED_VERB = "UPDATE"


def register_pattern(code: str, matcher, builder, targets) -> None:
    """Register an auto-fix pattern.

    ``targets`` is the set of table names the builder is permitted to mutate.
    ``builder(exc)`` must return ``(sql, params)`` where ``sql`` is a single
    reversible UPDATE statement touching only those tables.
    """
    FIX_PATTERNS[code] = {
        "matcher": matcher,
        "builder": builder,
        "targets": {t.lower() for t in targets},
    }


def _match_pattern(exc: dict, diag: dict):
    for code, spec in FIX_PATTERNS.items():
        try:
            if spec["matcher"](exc, diag):
                return code, spec
        except Exception:
            continue
    return None, None


def decide(exc: dict) -> dict:
    """Return a governance decision. Non-auto-fixable exceptions always escalate."""
    diag = exc.get("diagnosis") or {}
    classification = diag.get("classification")
    materiality = float(exc.get("materiality_kes") or 0.0)
    below_threshold = materiality < config.MATERIALITY_KES

    matched, _spec = _match_pattern(exc, diag)
    auto_fixable = (
        classification == "DATA_ERROR"
        and matched is not None
        and below_threshold
    )

    if auto_fixable:
        return {"severity": "amber", "action": "auto_fix", "auto_fixable": True,
                "matched_pattern": matched, "below_threshold": below_threshold}

    structural = exc.get("check_code") in _STRUCTURAL

    # Informational notes (e.g. low-volume ratio days) and learned_range findings
    # the LLM diagnosed as a REAL BUSINESS EVENT with clean rows are auto-resolved:
    # they stay recorded/visible but never land in the "needs a developer fix"
    # queue. A range finding on a legitimate busy day is a fact about trading,
    # not a defect — materiality alone must not escalate it to RED.
    if exc.get("informational") or (
        classification == "REAL_BUSINESS_EVENT"
        and exc.get("check_code") == "learned_range"
        and not structural
    ):
        return {"severity": "amber", "action": "auto_resolve", "auto_fixable": False,
                "matched_pattern": None, "below_threshold": below_threshold}

    if classification == "REAL_BUSINESS_EVENT":
        severity = "red" if (structural or not below_threshold) else "amber"
    elif structural:
        severity = "red"
    elif not below_threshold:
        severity = "red"
    else:
        severity = "amber"

    return {"severity": severity, "action": "escalate", "auto_fixable": False,
            "matched_pattern": None, "below_threshold": below_threshold}


def _strip_sql_noise(sql: str) -> str:
    """Single-pass lexer that removes SQL comments and blanks string literals.

    A regex pipeline is NOT safe here: stripping ``--`` comments before string
    literals misreads a ``--`` *inside* a literal as a comment and can hide a
    second statement (``... SET note='abc --'; DELETE ...``). This walks the
    text once, so quotes/comments are interpreted in the correct state:
      * ``'...'`` literals (with ``''`` escapes) are replaced by `` '' ``,
      * ``--`` line comments and ``/*..*/`` block comments are dropped ONLY
        when they start outside a string literal,
      * an unterminated literal or block comment consumes the rest of the
        text (conservative: hidden content never reaches the keyword scan
        as executable-looking SQL).
    """
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            out.append(" '' ")
            i += 1
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
        elif c == "-" and sql[i:i + 2] == "--":
            while i < n and sql[i] != "\n":
                i += 1
        elif c == "/" and sql[i:i + 2] == "/*":
            j = sql.find("*/", i + 2)
            i = n if j == -1 else j + 2
            out.append(" ")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _fix_is_safe(sql: str, targets: set) -> tuple[bool, str]:
    """Return (ok, reason). Accept ONLY a single reversible UPDATE whose actual
    target table is on the pattern's allowlist.

    Hardening (mirrors ``_validation_fix_is_safe`` in api_pg.py):
      * SQL comments (``--`` and ``/*..*/``) and string literals are removed
        by the quote-aware ``_strip_sql_noise`` lexer before analysis so a
        keyword, semicolon, or table name cannot be smuggled past the fence
        inside a comment or string.
      * Single statement only; must *start* with UPDATE (no leading CTE, and
        ``WITH`` is rejected anywhere).
      * Forbidden verbs match on word boundaries, so a column like
        ``created_at`` is not mistaken for CREATE.
      * The table parsed immediately after UPDATE — not merely a name appearing
        somewhere in the text — must be allowlisted (schema-qualifier and
        quoting tolerated).
    """
    import re
    if not sql or not sql.strip():
        return False, "no fix SQL"
    # Remove comments + blank string literals in one quote-aware pass
    # (a regex pipeline misreads `--` inside a literal as a comment).
    scan = _strip_sql_noise(sql.strip())
    upper = scan.upper().strip()
    body = upper[:-1].strip() if upper.endswith(";") else upper
    if ";" in body:
        return False, "multiple statements not allowed"
    if not re.match(rf"^\s*{_ALLOWED_VERB}\b", body):
        return False, f"only {_ALLOWED_VERB} statements are auto-applied"
    for kw in _FORBIDDEN_SQL:
        if kw == ";":
            continue
        if re.search(rf"\b{kw}\b", body):
            return False, f"forbidden keyword in fix: {kw}"
    m = re.match(rf"^\s*{_ALLOWED_VERB}\s+(?:ONLY\s+)?([A-Z0-9_.\"]+)", body)
    if not m:
        return False, "could not identify the UPDATE target table"
    target = m.group(1).replace('"', "")
    if "." in target:
        target = target.split(".")[-1]
    if target.lower() not in {t.lower() for t in targets}:
        return False, "fix does not reference an allowlisted target table"
    return True, "ok"


def apply_fix(conn, exc: dict, pattern_code: str) -> dict:
    spec = FIX_PATTERNS.get(pattern_code)
    if not spec:
        return {"applied": False, "reason": "unknown pattern"}
    sql, params = spec["builder"](exc)
    safe, reason = _fix_is_safe(sql, spec["targets"])
    if not safe:
        return {"applied": False, "reason": f"fence rejected fix: {reason}"}
    prev_autocommit = conn.autocommit
    try:
        conn.autocommit = False
        with db.cursor(conn) as cur:
            cur.execute(sql, params)
            affected = cur.rowcount
        conn.commit()
        return {"applied": True, "rows": affected, "sql": sql}
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        return {"applied": False, "reason": str(e)}
    finally:
        conn.autocommit = prev_autocommit
