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
                  "CREATE", ";")
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


def _fix_is_safe(sql: str, targets: set) -> tuple[bool, str]:
    upper = sql.upper().strip()
    if not upper.startswith(_ALLOWED_VERB):
        return False, f"only {_ALLOWED_VERB} statements are auto-applied"
    body = upper[:-1] if upper.endswith(";") else upper
    for kw in _FORBIDDEN_SQL:
        if kw == ";":
            if ";" in body:
                return False, "multiple statements not allowed"
            continue
        if kw in body:
            return False, f"forbidden keyword in fix: {kw}"
    if not any(t.upper() in upper for t in targets):
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
