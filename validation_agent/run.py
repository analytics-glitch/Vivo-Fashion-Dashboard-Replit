"""Orchestrator + CLI for the data-validation agent.

Usage:
  python3 -m validation_agent.run                 # live hourly run (validate today)
  python3 -m validation_agent.run --dry-run --days 90   # dry-run report over a window
  python3 -m validation_agent.run --backfill-days 90    # only (re)build baseline history
  python3 -m validation_agent.run --approve <exception_id>
  python3 -m validation_agent.run --reject  <exception_id>

A run executes the five steps in order. In dry-run mode it never sends alerts,
never applies fixes, and prints a full report to stdout. Baseline history is
always (re)folded from validated days so the dry-run also bootstraps the agent.
"""
import argparse
import json
import uuid
from datetime import date, datetime, timedelta

from . import (alerting, baselines, config, consistency, cross_surface, db,
               diagnose, governance)
from .metrics import compute


def _today() -> date:
    return datetime.now().date()


def _audit(conn, run_id, dry_run, **kw):
    cols = ["run_id", "dry_run", "phase", "event"]
    vals = [str(run_id), dry_run, kw.pop("phase"), kw.pop("event")]
    detail = kw.pop("detail", None)
    for k, v in kw.items():
        cols.append(k)
        vals.append(v)
    if detail is not None:
        cols.append("detail")
        vals.append(json.dumps(detail, default=str))
    ph = ",".join(["%s"] * len(vals))
    with db.cursor(conn) as cur:
        cur.execute(
            f"INSERT INTO validation_audit ({','.join(cols)}) VALUES ({ph})", vals)


def _fingerprint(exc) -> str:
    return "|".join(str(x) for x in (
        exc.get("entity_type"), exc.get("entity"), exc.get("subcategory"),
        exc.get("metric") or "_", exc.get("check_code"), exc.get("period_date")))


def _upsert_exception(conn, run_id, exc, dry_run) -> int:
    fp = _fingerprint(exc)
    with db.cursor(conn) as cur:
        cur.execute(
            """
            INSERT INTO validation_exceptions
                (fingerprint, run_id, status, tier, severity, entity_type, entity,
                 subcategory, metric, period_date, check_code, broken_identity,
                 observed, expected_low, expected_high, materiality_kes, diagnosis,
                 proposed_fix_sql, auto_fixable, raw_rows, approval_token, dry_run)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (fingerprint) DO UPDATE SET
                last_seen_at = now(), run_id = EXCLUDED.run_id,
                severity = EXCLUDED.severity, diagnosis = EXCLUDED.diagnosis,
                proposed_fix_sql = EXCLUDED.proposed_fix_sql,
                auto_fixable = EXCLUDED.auto_fixable, observed = EXCLUDED.observed,
                -- Persist agent-side status transitions (open -> auto_resolved /
                -- auto_fixed) so a previously-open finding stops surfacing as
                -- actionable once the current run resolves it. Operator verdicts
                -- (approved / rejected) are never overwritten.
                status = CASE
                    WHEN validation_exceptions.status = 'open'
                         AND EXCLUDED.status IN ('auto_resolved', 'auto_fixed')
                    THEN EXCLUDED.status
                    ELSE validation_exceptions.status
                END,
                resolved_at = CASE
                    WHEN validation_exceptions.status = 'open'
                         AND EXCLUDED.status IN ('auto_resolved', 'auto_fixed')
                    THEN now()
                    ELSE validation_exceptions.resolved_at
                END
            RETURNING id
            """,
            [fp, str(run_id), exc.get("status", "open"), exc["tier"],
             exc["severity"], exc.get("entity_type"), exc.get("entity"),
             exc.get("subcategory"), exc.get("metric"), exc.get("period_date"),
             exc.get("check_code"), exc.get("broken_identity"), exc.get("observed"),
             exc.get("expected_low"), exc.get("expected_high"),
             exc.get("materiality_kes"),
             json.dumps(exc.get("diagnosis"), default=str) if exc.get("diagnosis") else None,
             exc.get("proposed_fix_sql"), bool(exc.get("auto_fixable")),
             json.dumps(exc.get("raw_rows"), default=str) if exc.get("raw_rows") else None,
             exc.get("approval_token"), dry_run])
        return cur.fetchone()["id"]


def run(days: int, dry_run: bool, evaluate_days: int, backfill_only: bool = False):
    run_id = uuid.uuid4()
    conn = db.connect(autocommit=True)
    db.ensure_tables(conn)

    # Auto-seed: on a fresh DB the FOLD window widens to ~90d so baselines exist
    # from day one, but the VALIDATION/report window (Tier-1 exceptions, governance,
    # alerts) stays at the normal recent window — we never emit historical alerts or
    # attempt historical auto-fixes just because we seeded.
    seeded = False
    fold_days = days
    if not dry_run and not backfill_only and baselines.count_points(conn) < config.MIN_HISTORY_POINTS:
        fold_days = max(days, config.BASELINE_WINDOW_DAYS + 1)
        seeded = True
        _audit(conn, run_id, dry_run, phase="baseline", event="auto_seed",
               detail={"reason": "fresh metric_baselines", "fold_days": fold_days,
                       "report_days": days})

    d1 = _today()
    d0 = d1 - timedelta(days=fold_days - 1)        # fold window (wide when seeding)
    report_start = d1 - timedelta(days=days - 1)   # Tier-1/governance/alert window
    env = "dev" if "localhost" in config.DATABASE_URL or "127.0.0.1" in config.DATABASE_URL else "remote"

    rows = compute(conn, d0, d1)

    # Tier-1 runs across the FULL fold window so a bad historical day is blocked from
    # being folded into the baseline, but only recent-window fails become exceptions.
    blocked = set()
    tier1 = []
    for m in rows:
        if m["entity_type"] not in ("store", "group"):
            continue
        fails = consistency.check_row(m)
        if not fails:
            continue
        blocked.add((m["entity_type"], m["entity"], m["subcategory"], m["period_date"]))
        if m["period_date"] < report_start:
            continue
        for f in fails:
            f.update({"entity_type": m["entity_type"], "entity": m["entity"],
                      "subcategory": m["subcategory"], "period_date": m["period_date"]})
            tier1.append(f)

    folded = baselines.fold(conn, rows, blocked)

    # Learned-range bands are full-day distributions, so only COMPLETED days can be
    # range-checked. The current day (d1) is still in progress (the sync loop runs
    # hourly during trading hours): its running partial-day total sits structurally
    # far below a full-day band and would fire a range/PoP "anomaly" for nearly
    # every store every hour until the day closes, drowning real signal. So anchor
    # the evaluation window at the last completed day (yesterday) and never
    # range-check d1 itself. Tier-1 identity checks + cross-surface still cover today.
    eval_end = d1 - timedelta(days=1)
    eval_start = eval_end - timedelta(days=evaluate_days - 1)
    tier2 = []
    if not backfill_only:
        index = baselines.load_index(conn, d1)
        for m in rows:
            if not (eval_start <= m["period_date"] <= eval_end):
                continue
            for f in baselines.check_row(m, index):
                f.update({"entity_type": m["entity_type"], "entity": m["entity"],
                          "subcategory": m["subcategory"], "period_date": m["period_date"]})
                tier2.append(f)

    all_exc = tier1 + tier2
    diagnosed = 0
    if config.llm_enabled() and not backfill_only:
        # Informational notes (low_volume) don't need an LLM diagnosis — don't
        # spend budget on them.
        ranked = sorted((e for e in all_exc if not e.get("informational")),
                        key=lambda e: -(e.get("materiality_kes") or 0))
        for exc in ranked[: config.LLM_MAX_DIAGNOSES]:
            rr = diagnose.sample_rows(conn, exc)
            exc["raw_rows"] = rr
            exc["diagnosis"] = diagnose.diagnose(exc, rr)
            exc["proposed_fix_sql"] = (exc["diagnosis"] or {}).get("proposed_fix_sql")
            diagnosed += 1

    reds, ambers = 0, 0
    red_items = []
    for exc in all_exc:
        decision = governance.decide(exc)
        exc["severity"] = decision["severity"]
        exc["auto_fixable"] = decision["auto_fixable"]
        if decision["action"] == "auto_resolve":
            # Informational / diagnosed-real-business-event findings stay
            # recorded for visibility but never enter the approval queue.
            exc["status"] = "auto_resolved"
            _audit(conn, run_id, dry_run, phase="governance",
                   event="auto_resolved", entity=exc.get("entity"),
                   metric=exc.get("metric"), check_code=exc.get("check_code"),
                   detail={"reason": "informational or REAL_BUSINESS_EVENT diagnosis",
                           "classification": (exc.get("diagnosis") or {}).get("classification")})
        if not dry_run and decision["action"] == "auto_fix" and decision["matched_pattern"]:
            res = governance.apply_fix(conn, exc, decision["matched_pattern"])
            exc["status"] = "auto_fixed" if res.get("applied") else "open"
            _audit(conn, run_id, dry_run, phase="governance",
                   event="fix_applied" if res.get("applied") else "fix_failed",
                   entity=exc.get("entity"), metric=exc.get("metric"),
                   check_code=exc.get("check_code"), detail=res)
        exc_id = _upsert_exception(conn, run_id, exc, dry_run)
        exc["id"] = exc_id
        if exc["severity"] == "red":
            reds += 1
            red_items.append({
                "id": exc_id, "entity": f'{exc["entity_type"]}:{exc["entity"]}',
                "metric": exc.get("metric"), "check_code": exc.get("check_code"),
                "period_date": str(exc.get("period_date")),
                "observed": round(float(exc.get("observed") or 0), 2),
                "expected_low": exc.get("expected_low"),
                "expected_high": exc.get("expected_high"),
                "diagnosis": (exc.get("diagnosis") or {}).get("cause"),
                "proposed_fix_sql": exc.get("proposed_fix_sql")})
        elif exc["severity"] == "amber":
            ambers += 1

    # Step 6 — cross-surface (cross-endpoint) consistency. Read-only HTTP against
    # the live /api: the SAME metric under the SAME filters must read the same
    # number on every page. Runs in dry-run too (no writes to dashboards); skipped
    # only on a backfill-only pass. Self-skips (never raises) if the API/login is
    # unavailable, so a flaky API can never destabilise the run. These breaks fold
    # into the same reds/ambers → overall colour → alert payload.
    xsurf_exc, xsurf_skip = [], None
    if not backfill_only:
        try:
            xsurf_exc, xsurf_skip = cross_surface.run_checks(d1)
        except Exception as e:  # noqa: BLE001 — defence in depth; run_checks shouldn't raise
            xsurf_skip = f"error: {e}"
    for exc in xsurf_exc:
        exc_id = _upsert_exception(conn, run_id, exc, dry_run)
        exc["id"] = exc_id
        if exc["severity"] == "red":
            reds += 1
            red_items.append({
                "id": exc_id, "entity": f'{exc["entity_type"]}:{exc["entity"]}',
                "metric": exc.get("metric"), "check_code": exc.get("check_code"),
                "period_date": str(exc.get("period_date")),
                "observed": round(float(exc.get("observed") or 0), 2),
                "expected_low": exc.get("expected_low"),
                "expected_high": exc.get("expected_high"),
                "diagnosis": (exc.get("diagnosis") or {}).get("cause"),
                "proposed_fix_sql": exc.get("proposed_fix_sql")})
        elif exc["severity"] == "amber":
            ambers += 1
    _audit(conn, run_id, dry_run, phase="cross_surface", event="checks",
           detail={"exceptions": len(xsurf_exc),
                   "reds": sum(1 for e in xsurf_exc if e["severity"] == "red"),
                   "skip": xsurf_skip,
                   "intentional_skips": cross_surface.INTENTIONAL_SKIPS})

    report_rows = [m for m in rows if m["period_date"] >= report_start]
    n_entities = len({(m["entity_type"], m["entity"], m["period_date"]) for m in report_rows})
    definitions = _definition_residuals(report_rows)
    summary = {
        "run_id": str(run_id), "env": env, "window": f"{report_start} .. {d1}",
        "color": alerting.overall_color(reds, ambers),
        "checks": n_entities, "passed": n_entities - len({
            (e["entity_type"], e["entity"], e["period_date"]) for e in tier1}),
        "tier1": len(tier1), "tier2": len(tier2), "reds": reds, "ambers": ambers,
        "folded": folded, "diagnosed": diagnosed, "definitions": definitions,
        "seeded": seeded, "red_items": red_items[:25],
        "cross_surface": len(xsurf_exc), "cross_surface_skip": xsurf_skip,
    }

    alert_res = alerting.send(summary, dry_run)
    _audit(conn, run_id, dry_run, phase="run", event="run_summary",
           detail={**summary, "alert": {k: v for k, v in alert_res.items() if k != "text"}})

    _print_report(summary, tier1, tier2, alert_res, dry_run)
    conn.close()
    return summary


def _definition_residuals(rows) -> list[str]:
    grp = [m for m in rows if m["entity_type"] == "group" and m["subcategory"] == "__ALL__"]
    tot = sum(m["total_sales"] for m in grp)
    net = sum(m["net_sales"] for m in grp)
    gross = sum(m["gross_sales"] for m in grp)
    disc = sum(m["discounts"] for m in grp)
    ret = sum(m["return_amount"] for m in grp)
    out = []
    if net:
        out.append(f"total/net ratio = {tot/net:.4f} (VAT assumption {config.VAT_RATE:+.2f}; "
                   f"total is VAT-inclusive)")
    comp = gross - disc - ret
    if net:
        out.append(f"net vs (gross-disc-returns): {net:,.0f} vs {comp:,.0f} "
                   f"(residual {(net-comp)/net*100:+.2f}% — definitional gap across channels)")
    out.append("units_sold = GROSS ordered qty on sale/order rows; "
               "transactions = COUNT(DISTINCT order_id); "
               "conversion = transactions/footfall (footfall conv column empty)")
    return out


def _print_report(summary, tier1, tier2, alert_res, dry_run):
    bar = "=" * 72
    print(bar)
    print(f"  VIVO BI DATA-VALIDATION {'DRY-RUN' if dry_run else 'RUN'} REPORT")
    print(bar)
    print(f"Run            : {summary['run_id']}")
    print(f"Environment    : {summary['env']}")
    print(f"Window         : {summary['window']}"
          + ("   [AUTO-SEED: fresh baselines]" if summary.get("seeded") else ""))
    print(f"Overall status : {summary['color']}")
    print(f"Entity-days    : {summary['checks']}   "
          f"Baseline points folded: {summary['folded']}")
    print(f"Tier-1 (consistency) exceptions : {summary['tier1']}")
    print(f"Tier-2 (learned-range) exceptions: {summary['tier2']}")
    print(f"AMBER (auto-handled): {summary['ambers']}   "
          f"RED (needs approval): {summary['reds']}   "
          f"LLM diagnoses: {summary['diagnosed']}")
    xs = summary.get("cross_surface", 0)
    xs_skip = summary.get("cross_surface_skip")
    print(f"Cross-surface (cross-page) mismatches: {xs}"
          + (f"   [skipped: {xs_skip}]" if xs_skip else ""))
    print()
    print("Definitions used / residuals:")
    for d in summary["definitions"]:
        print(f"  - {d}")

    def _by_code(items):
        agg = {}
        for it in items:
            agg[it["check_code"]] = agg.get(it["check_code"], 0) + 1
        return agg

    if tier1:
        print("\nTier-1 breakdown by check:")
        for code, n in sorted(_by_code(tier1).items(), key=lambda x: -x[1]):
            print(f"  {code:24s} {n}")
        print("  examples:")
        for it in tier1[:5]:
            print(f"   - {it['entity_type']}:{it['entity']} @ {it['period_date']} "
                  f"{it['broken_identity']} (obs {float(it['observed'] or 0):,.2f}, "
                  f"KES delta {float(it.get('materiality_kes') or 0):,.0f})")
    if tier2:
        print("\nTier-2 breakdown by metric:")
        agg = {}
        for it in tier2:
            agg[it["metric"]] = agg.get(it["metric"], 0) + 1
        for metric, n in sorted(agg.items(), key=lambda x: -x[1]):
            print(f"  {metric:24s} {n}")
        print("  examples:")
        for it in tier2[:5]:
            print(f"   - {it['entity_type']}:{it['entity']} {it['metric']} "
                  f"@ {it['period_date']}: {it['broken_identity']} "
                  f"(obs {float(it['observed']):,.2f}, exp "
                  f"[{float(it['expected_low']):,.2f}, {float(it['expected_high']):,.2f}])")

    if summary["red_items"]:
        print("\nRED items needing approval:")
        for it in summary["red_items"]:
            print(f"  * [{it['id']}] {it['entity']} / "
                  f"{it['metric'] or it['check_code']} @ {it['period_date']}")
            if it.get("diagnosis"):
                print(f"      diagnosis: {it['diagnosis']}")

    print("\nAlerting:")
    if dry_run:
        print("  (dry-run — no alerts sent)")
    else:
        print(f"  email   : {alert_res.get('email')}")
        print(f"  whatsapp: {alert_res.get('whatsapp')}")
    print(bar)


def _resolve(exc_id: int, approve: bool):
    conn = db.connect(autocommit=True)
    with db.cursor(conn) as cur:
        cur.execute("SELECT * FROM validation_exceptions WHERE id=%s", [exc_id])
        exc = cur.fetchone()
        if not exc:
            print(f"Exception {exc_id} not found.")
            return
        if not approve:
            cur.execute(
                "UPDATE validation_exceptions SET status='rejected', resolved_at=now() "
                "WHERE id=%s", [exc_id])
            print(f"Exception {exc_id} marked rejected.")
            return
        cur.execute(
            "UPDATE validation_exceptions SET status='approved', resolved_at=now() "
            "WHERE id=%s", [exc_id])
    print(f"Exception {exc_id} approved. Apply the proposed fix manually within the "
          f"governance fence, or register a fix pattern to automate it.")
    conn.close()


def main():
    ap = argparse.ArgumentParser(description="Vivo BI data-validation agent")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--days", type=int, default=None,
                    help="window size in days (default 2 live, 90 dry-run)")
    ap.add_argument("--evaluate-days", type=int, default=None,
                    help="how many recent days to range-check (default 1 live, window dry-run)")
    ap.add_argument("--backfill-days", type=int, default=None,
                    help="only (re)build baseline history over N days, no checks/alerts")
    ap.add_argument("--approve", type=int)
    ap.add_argument("--reject", type=int)
    args = ap.parse_args()

    if args.approve:
        _resolve(args.approve, approve=True)
        return
    if args.reject:
        _resolve(args.reject, approve=False)
        return
    if args.backfill_days:
        run(days=args.backfill_days, dry_run=True,
            evaluate_days=0, backfill_only=True)
        return

    if args.dry_run:
        days = args.days or 90
        evaluate = args.evaluate_days or days
    else:
        if not config.within_active_hours():
            print(f"Outside active hours "
                  f"[{config.ACTIVE_HOUR_START:02d}:00-{config.ACTIVE_HOUR_END:02d}:00 "
                  f"{config.ACTIVE_TZ}] — skipping run.")
            return
        days = args.days or 2
        evaluate = args.evaluate_days or 1
    run(days=days, dry_run=args.dry_run, evaluate_days=evaluate)


if __name__ == "__main__":
    main()
