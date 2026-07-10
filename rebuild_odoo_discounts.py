"""One-time scoped fix: re-transform ONLY the Odoo (Kenya POS) rows of all_sales.

Why: the 2026-07-09 12:08 full rebuild ran with the pre-fix transform that
mislabelled the VAT component (incl - excl) as discounts_kes, so all
vivofashiongroup history carried discounts ~= 13.5% of sales (understating
canonical Net Sales). The transform was fixed later that day (real discount =
max(price_unit*qty - price_subtotal_incl, 0)), but bulk_insert's ON CONFLICT
does not update discounts_kes, so a plain re-run cannot heal the rows.

This script DELETEs store_id='vivofashiongroup' rows and reinserts them via the
fixed transform_odoo, in ONE transaction (bulk_insert commits only at the end),
so a mid-run failure leaves all_sales untouched. Run with the Sync Watchdog
idled; the sync self-heals recent days afterwards.
"""
import logging

import psycopg2

from transform_all_sales import DATABASE_URL, transform_odoo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    rates = {"Kenya": 1.0, "Online": 1.0}
    cur.execute("SELECT country, rate FROM currency_rates ORDER BY month DESC")
    seen = set()
    for row in cur.fetchall():
        if row[0] not in seen:
            rates[row[0]] = float(row[1])
            seen.add(row[0])
    log.info("Rates: %s", rates)

    cur.execute("SELECT COUNT(*) FROM all_sales WHERE store_id = 'vivofashiongroup'")
    before = cur.fetchone()[0]
    log.info("Existing vivofashiongroup rows: %d", before)

    # Same transaction as the reinsert (transform_odoo -> bulk_insert commits at end).
    cur.execute("DELETE FROM all_sales WHERE store_id = 'vivofashiongroup'")
    log.info("Deleted %d rows", cur.rowcount)

    transform_odoo(cur, conn, rates)

    cur.execute(
        """
        SELECT date_trunc('month', sale_date::date)::date AS m,
               COUNT(*) AS rows,
               ROUND(SUM(total_sales_kes::numeric), 0) AS total,
               ROUND(SUM(discounts_kes::numeric), 0) AS disc,
               ROUND(SUM(discounts_kes::numeric)
                     / NULLIF(SUM(total_sales_kes::numeric), 0) * 100, 2) AS disc_pct
        FROM all_sales
        WHERE store_id = 'vivofashiongroup' AND sale_kind IN ('sale', 'order')
        GROUP BY 1 ORDER BY 1
        """
    )
    print("\n=== vivofashiongroup by month (post-fix) ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} rows, total {row[2]}, disc {row[3]} ({row[4]}%)")

    conn.close()


if __name__ == "__main__":
    main()
