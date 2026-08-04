#!/usr/bin/env python3
"""Rebuild the pre-aggregated BI rollup tables (customer lifetime/first-purchase,
range-mgmt per-style, product-analysis per-style).

These rollups make the slow cold endpoints (Customers, Range Management, Product
Analysis) fast by materialising the lifetime / trailing-window aggregates they
would otherwise full-scan all_sales for on every request. The read paths fall
back to the live SQL whenever a rollup is missing or stale, so running this is
purely a performance refresh — never a correctness dependency.

It is a thin wrapper around api_pg.run_sales_rollup_refresh() (the single source
of truth for the rollup definitions and the build-then-swap refresh), so it can
never drift from the live read path. Idempotent (full rebuild per table), safe to
re-run, and used by both the one-time prod bootstrap and the hourly refresh folded
into the incremental sync loop (sync_incremental.py).

Usage:
    python3 build_sales_rollups.py            # refresh all rollups
    python3 build_sales_rollups.py rm_style   # refresh only the named rollup(s)
    python3 build_sales_rollups.py --force    # rebuild even if the source
                                              # watermark says nothing changed
"""
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [build_sales_rollups] %(levelname)s %(message)s",
)
log = logging.getLogger("build_sales_rollups")


def main():
    import api_pg
    args = set(sys.argv[1:])
    force = "--force" in args
    args.discard("--force")
    only = args or None
    log.info("Building sales rollups%s%s ...",
             (" (only=%s)" % ",".join(sorted(only))) if only else "",
             " (force)" if force else "")
    results = api_pg.run_sales_rollup_refresh(only=only, force=force)
    failed = False
    for name, outcome in results.items():
        if isinstance(outcome, str) and outcome.startswith("ERROR"):
            failed = True
            log.error("  %s: %s", name, outcome)
        else:
            log.info("  %s: %s rows", name, outcome)
    if failed:
        log.error("One or more rollups failed to refresh")
        sys.exit(1)
    log.info("✅ Sales rollups refreshed")


if __name__ == "__main__":
    main()
