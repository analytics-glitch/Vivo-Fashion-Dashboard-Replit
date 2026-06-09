"""
sync_all.py — Master orchestrator for the Replit BI pipeline.

Run order:
1. extract_currency_rates.py   — fetch monthly average exchange rates
2. extract_odoo_orders.py      — Odoo POS orders + lines (incremental)
3. extract_odoo_products.py    — Odoo products (full reload)
4. extract_odoo_customers.py   — Odoo customers (incremental)
5. extract_odoo_inventory.py   — Odoo stock (full reload)
6. extract_shopify_sales.py    — Kenya/Uganda/Rwanda Shopify (incremental)
7. extract_shopzetu_sales.py   — Shop Zetu REST (incremental)
8. extract_shopify_customers.py— All Shopify customers (incremental)
9. transform_all_sales.py      — Build all_sales from raw tables
10. transform_all_customers.py — Build all_customers from raw tables
11. transform_all_products_clean.py — Build all_products_clean

Usage:
    python sync_all.py           # run everything
    python sync_all.py --extract # only run extracts (skip transforms)
    python sync_all.py --transform # only run transforms
"""

import subprocess
import sys
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

EXTRACT_SCRIPTS = [
    "extract_currency_rates.py",
    "extract_odoo_orders.py",
    "extract_odoo_products.py",
    "extract_odoo_customers.py",
    "extract_odoo_inventory.py",
    "extract_shopify_sales.py",
    "extract_shopzetu_sales.py",
    "extract_shopify_customers.py",
]

TRANSFORM_SCRIPTS = [
    "transform_all_sales.py",
    "transform_all_customers.py",
    "transform_all_products_clean.py",
]

def run_script(script):
    log.info("=" * 50)
    log.info("Running %s...", script)
    start = datetime.now()
    result = subprocess.run(
        [sys.executable, script],
        capture_output=False,
    )
    elapsed = (datetime.now() - start).seconds
    if result.returncode == 0:
        log.info("✅ %s done in %ds", script, elapsed)
    else:
        log.error("❌ %s FAILED (exit %d) after %ds", script, result.returncode, elapsed)
    return result.returncode == 0

def main():
    args = sys.argv[1:]
    run_extract   = '--transform' not in args
    run_transform = '--extract' not in args

    log.info("Starting Vivo BI sync pipeline")
    log.info("Extract: %s | Transform: %s", run_extract, run_transform)

    failed = []

    if run_extract:
        for script in EXTRACT_SCRIPTS:
            ok = run_script(script)
            if not ok:
                failed.append(script)
                log.warning("Continuing despite failure in %s", script)

    if run_transform:
        for script in TRANSFORM_SCRIPTS:
            ok = run_script(script)
            if not ok:
                failed.append(script)

    log.info("=" * 50)
    if failed:
        log.error("Pipeline completed with failures: %s", failed)
    else:
        log.info("✅ Pipeline complete — all scripts succeeded")

if __name__ == "__main__":
    main()