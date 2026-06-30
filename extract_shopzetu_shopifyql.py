"""
Shop Zetu (Online) LIVE incremental sync — ShopifyQL -> all_sales.

Used by sync_incremental.py to refresh the most recent days. It reuses the exact
proven ShopifyQL extraction from extract_shopzetu_sales.py (same vendor list,
corrected columns, date-window pagination with WITH-TOTALS reconciliation) and
maps the aggregated rows into all_sales using the SAME mapping as
transform_all_sales.transform_shopzetu — most importantly total_sales_kes is the
SIGNED total_sales (return rows are negative), so SUM(total_sales_kes) nets
discounts and returns and reconciles to Shopify's own figures.

This keeps the live path and the full rebuild path identical, so recent days
never drift back up after a rebuild.
"""
import os
import argparse
import logging
from datetime import date, timedelta, datetime, timezone

import psycopg2
from psycopg2.extras import execute_values

from extract_shopzetu_sales import fetch_range, aggregate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]


def to_all_sales_rows(records):
    """Map aggregated raw records -> all_sales tuples (mirrors transform_shopzetu)."""
    now = datetime.now(timezone.utc)
    out = []
    for rec in records:
        title = rec.get("product_title") or ""
        if "shopping bag" in title.lower():
            continue
        is_reversal = rec["is_reversal"]
        total = float(rec["total_sales"])
        gross = float(rec["gross_sales"]) if not is_reversal else 0.0
        disc = abs(float(rec["discounts"])) if not is_reversal else 0.0
        ret = abs(float(rec["returns"])) if is_reversal else 0.0
        net = float(rec["net_sales"])
        price = float(rec["variant_price"] or 0)
        sku = rec["variant_sku"] or ""
        day = rec["day"]
        sale_kind = "return" if is_reversal else "order"
        row_id = f"{rec['order_id']}_{sku}_{day}_{'1' if is_reversal else '0'}"
        out.append((
            row_id, "shop-zetu", rec["order_id"], rec.get("order_name"),
            day, day, "Online - Shop Zetu", "Online", "Online",
            rec.get("customer_id"), rec.get("customer_type"), sale_kind, title, sku,
            int(rec["quantity_ordered"]),
            round(price, 2), round(price, 2),
            round(gross, 2), round(disc, 2), round(net, 2),
            round(total, 2),
            int(rec["net_items_sold"]),
            round(ret, 2),
            now,
        ))
    return out


def write_to_db(rows, since, until):
    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM all_sales WHERE store_id = 'shop-zetu' "
            "AND sale_date::date BETWEEN %s AND %s",
            (since.isoformat(), until.isoformat()),
        )
        log.info("Deleted %d rows", cur.rowcount)
        if rows:
            execute_values(cur, """
                INSERT INTO all_sales (
                    id, store_id, order_id, order_name, sale_date, day,
                    pos_location_name, country, channel,
                    customer_id, customer_type, sale_kind,
                    product_title, variant_sku,
                    ordered_item_quantity, product_price_kes, product_price,
                    gross_sales_kes, discounts_kes, net_sales_kes,
                    total_sales_kes, net_quantity, returns_kes, loaded_at
                ) VALUES %s
            """, rows, page_size=500)
            log.info("Inserted %d rows", len(rows))
        conn.commit()
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None)
    parser.add_argument("--until", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.since and args.until:
        since = datetime.strptime(args.since, "%Y-%m-%d").date()
        until = datetime.strptime(args.until, "%Y-%m-%d").date()
    else:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            cur = conn.cursor()
            cur.execute("SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = 'shop-zetu'")
            last = cur.fetchone()[0]
        finally:
            conn.close()
        since = (last - timedelta(days=4)) if last else date(2024, 1, 1)
        until = date.today()

    log.info("ShopifyQL sync: %s -> %s", since, until)
    raw_rows = fetch_range(since, until)
    if not raw_rows:
        log.info("No rows returned; deleting stale rows in window only")
    records = aggregate(raw_rows)
    rows = to_all_sales_rows(records)
    net = sum(r[20] for r in rows)
    log.info("Transformed %d rows", len(rows))
    log.info("Net total_sales_kes (incl. returns): {:,.2f}".format(net))

    if args.dry_run:
        log.info("--dry-run: skipping DB write")
        return
    write_to_db(rows, since, until)
    log.info("Done")


if __name__ == "__main__":
    main()
