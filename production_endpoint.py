# ============================================================================
# PRODUCTION HOURLY TRACKER — paste this block into api_pg.py near the other
# Production endpoints. Reads production_hourly (fed from the team's Google
# Sheet by extract_production_tracker.py) and returns live actual-vs-target
# plus a projected end-of-day landing (pace so far x 8 productive hours).
# Uses run_query(sql_string) — variables are interpolated with _sql_str().
# ============================================================================
PRODUCTION_PRODUCTIVE_HOURS = 8  # 08:00-17:00 minus 13:00-14:00 lunch


@app.get("/api/production/hourly-tracker")
def production_hourly_tracker(
    work_date: str = Query(default=None),
    sewing_line: str = Query(default=None),
):
    """Live production output vs target for one sewing line on one day.
    Defaults: latest day that has actuals (else max date, else today), and the
    first sewing line present for that day if none is given."""
    line_filter = (
        ("AND sewing_line = '" + _sql_str(sewing_line) + "'") if sewing_line else ""
    )

    # Resolve the day.
    if work_date:
        day = _sql_str(work_date)
    else:
        drow = run_query(
            "SELECT COALESCE("
            "  (SELECT MAX(work_date) FROM production_hourly "
            f"    WHERE actual IS NOT NULL {line_filter}),"
            "  (SELECT MAX(work_date) FROM production_hourly),"
            "  CURRENT_DATE) AS d"
        )
        day = str(drow[0]["d"]) if drow else None
    if not day:
        return {"work_date": None, "slots": [], "daily_target": 0, "made_so_far": 0}

    # Resolve the sewing line if not specified: first line present that day.
    line = sewing_line
    if not line:
        lrow = run_query(
            "SELECT MIN(sewing_line) AS ln FROM production_hourly "
            f"WHERE work_date = '{_sql_str(day)}'"
        )
        line = lrow[0]["ln"] if lrow and lrow[0]["ln"] else "A"

    rows = run_query(
        "SELECT slot, slot_index, target, actual, style "
        "FROM production_hourly "
        f"WHERE work_date = '{_sql_str(day)}' AND sewing_line = '{_sql_str(line)}' "
        "ORDER BY slot_index"
    )

    slots, cum_actual, cum_target, hours_done, made_so_far, style = [], 0, 0, 0, 0, None
    for r in rows or []:
        a, t = r.get("actual"), r.get("target")
        if r.get("style"):
            style = r["style"]
        if a is not None:
            cum_actual += a
            made_so_far += a
            hours_done += 1
        if t is not None:
            cum_target += t
        slots.append(
            {
                "slot": r["slot"],
                "target": t,
                "actual": a,
                "cumulative_actual": cum_actual if a is not None else None,
                "cumulative_target": cum_target if t is not None else None,
                "pct_of_slot": (
                    round(100 * a / t, 1) if (a is not None and t) else None
                ),
            }
        )

    daily_target = cum_target
    pace = (made_so_far / hours_done) if hours_done else 0
    projected = round(pace * PRODUCTION_PRODUCTIVE_HOURS)
    pct_achieved = round(100 * made_so_far / daily_target, 1) if daily_target else None
    projected_pct = round(100 * projected / daily_target, 1) if daily_target else None
    expected_by_now = (
        round((daily_target / PRODUCTION_PRODUCTIVE_HOURS) * hours_done)
        if daily_target
        else 0
    )

    if hours_done == 0:
        status = "Not started"
    elif made_so_far >= expected_by_now:
        status = "On track"
    elif made_so_far >= 0.85 * expected_by_now:
        status = "Slightly behind"
    else:
        status = "Behind"

    # Which sewing lines exist for the day (for a line selector in the UI).
    lines = run_query(
        "SELECT DISTINCT sewing_line FROM production_hourly "
        f"WHERE work_date = '{_sql_str(day)}' ORDER BY sewing_line"
    )
    available_lines = [x["sewing_line"] for x in (lines or [])]

    return {
        "work_date": day,
        "sewing_line": line,
        "available_lines": available_lines,
        "style": style,
        "productive_hours": PRODUCTION_PRODUCTIVE_HOURS,
        "hours_completed": hours_done,
        "daily_target": daily_target,
        "made_so_far": made_so_far,
        "pct_achieved": pct_achieved,
        "expected_by_now": expected_by_now,
        "pace_per_hour": round(pace, 1),
        "projected_landing": projected,
        "projected_pct": projected_pct,
        "status": status,
        "slots": slots,
    }
