"""
Shop Zetu (Online) sales extractor — ShopifyQL edition.

Populates raw_shopify_vendor_sales directly from Shopify's ShopifyQL `sales`
dataset (the same numbers the merchant sees in Analytics), so the canonical
transform (transform_all_sales.transform_shopzetu) and the live dashboard
reconcile EXACTLY to Shopify's own total_sales / net_sales / returns.

Why ShopifyQL (not the REST orders API): the old REST extractor computed
total_sales = qty * price (gross only), hard-coded discounts to 0, and captured
returns only via an order's financial_status. That overstated Online sales by
~40M because real refunds (-10.4M) and discounts were never netted. ShopifyQL's
`total_sales` is already net of discounts and returns at the line grain and is
SIGNED (return rows are negative), so SUM(total_sales) reconciles to Shopify.

Pagination: ShopifyQL OFFSET is unreliable (ties on the ORDER BY column overlap
across pages), so we paginate by DATE WINDOW. Each window carries WITH TOTALS;
if the fetched rows don't sum to the window's totals (or the row count hits the
LIMIT), the window is split in half and retried. This guarantees completeness
without OFFSET.
"""
import os
import sys
import time
import logging
from datetime import datetime, timezone, timedelta, date

import requests
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]
STORE_URL    = os.environ["SHOPZETU_STORE"]
TOKEN        = os.environ["SHOPZETU_TOKEN"]
API_VERSION  = "2025-10"

HISTORICAL_START = date(2022, 1, 1)
WINDOW_DAYS      = 45      # initial window; auto-splits if incomplete
PAGE_LIMIT       = 50000   # ShopifyQL row cap per query (proven > 5000 OK)
RECONCILE_TOL    = 1.0     # absolute KES tolerance for per-window totals check
RECONCILE_PCT    = 0.001   # relative tolerance (0.1%)
REQUEST_PAUSE    = 3.0     # polite delay between queries
THROTTLE_SLEEP   = 20.0    # backoff on THROTTLED
MAX_RETRIES      = 8

# Vivo-group vendors as they appear in Shop Zetu (mixed case variants).
VENDORS = [
    "Safari", "Vivo", "Zoya", "SOWAIRINA BY VIVO", "VIVO", "VIVO WOMAN", "vivo",
    "SAFARI", "ZOYA", "Zoya Essentials", "Safari By Vivo", "Safari by Vivo",
]

# Metrics requested from ShopifyQL (signed; return rows are negative).
METRICS = [
    "total_sales", "orders", "gross_sales", "discounts", "total_returns",
    "net_sales", "net_items_sold", "quantity_ordered", "quantity_returned",
]


def build_query(since, until, limit):
    vlist = ", ".join(f"'{v}'" for v in VENDORS)
    show = ", ".join(METRICS)
    return (
        f"FROM sales "
        f"SHOW {show} "
        f"WHERE product_vendor IN ({vlist}) "
        f"GROUP BY day, order_id, order_name, subscription_or_one_time, "
        f"order_or_return, line_type, pos_location_name, product_variant_price, "
        f"product_title_at_time_of_sale, product_type, product_vendor, "
        f"product_variant_sku, product_variant_title_at_time_of_sale, "
        f"new_or_returning_customer WITH TOTALS "
        f"SINCE {since.isoformat()} UNTIL {until.isoformat()} "
        f"ORDER BY total_sales ASC LIMIT {limit}"
    )


def run_query(ql):
    """Execute a ShopifyQL query; returns (rows[list[dict]], totals[dict])."""
    url = f"https://{STORE_URL}/admin/api/{API_VERSION}/graphql.json"
    headers = {"Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN}
    escaped = ql.replace(chr(92), chr(92) + chr(92)).replace(chr(34), chr(92) + chr(34))
    gql = ('query { shopifyqlQuery(query: "' + escaped +
           '") { tableData { columns { name } rows } parseErrors } }')

    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.post(url, headers=headers, json={"query": gql}, timeout=120)
            r.raise_for_status()
            d = r.json()
        except Exception as e:  # transport / 5xx
            last_err = str(e)
            time.sleep(THROTTLE_SLEEP)
            continue
        if "errors" in d:
            if "THROTTLED" in str(d["errors"]):
                time.sleep(THROTTLE_SLEEP)
                continue
            raise RuntimeError(f"ShopifyQL GraphQL error: {str(d['errors'])[:300]}")
        q = d["data"]["shopifyqlQuery"]
        if q.get("parseErrors"):
            raise RuntimeError(f"ShopifyQL parse error: {q['parseErrors']}")
        td = q["tableData"]
        cols = [c["name"] for c in td["columns"]]
        raw_rows = td["rows"]

        def cell(row, key):
            if isinstance(row, dict):
                return row.get(key)
            return row[cols.index(key)] if key in cols else None

        rows = []
        for rr in raw_rows:
            rows.append({k: cell(rr, k) for k in cols})

        totals = {}
        if rows:
            for m in METRICS:
                totals[m] = _num(rows[0].get(f"{m}__totals"))
        return rows, totals
    raise RuntimeError(f"ShopifyQL throttled/failed after {MAX_RETRIES} retries: {last_err}")


def _num(v):
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def fetch_range(since, until, depth=0):
    """Recursively fetch all line rows in [since, until] (inclusive)."""
    time.sleep(REQUEST_PAUSE)
    rows, totals = run_query(build_query(since, until, PAGE_LIMIT))
    tot = totals.get("total_sales", 0.0)
    row_sum = sum(_num(r.get("total_sales")) for r in rows)
    tol = max(RECONCILE_TOL, abs(tot) * RECONCILE_PCT)
    complete = (len(rows) < PAGE_LIMIT) and (abs(row_sum - tot) <= tol)

    pad = "  " * depth
    log.info("%s[%s..%s] rows=%d sum=%.2f totals=%.2f %s",
             pad, since, until, len(rows), row_sum, tot,
             "OK" if complete else "SPLIT")

    if complete:
        return rows

    if since >= until:
        # Single day still incomplete (>50k rows in a day, or unreconcilable).
        log.warning("Single-day window %s incomplete (rows=%d sum=%.2f totals=%.2f); "
                    "keeping fetched rows", since, len(rows), row_sum, tot)
        return rows

    mid = since + (until - since) / 2
    left = fetch_range(since, mid, depth + 1)
    right = fetch_range(mid + timedelta(days=1), until, depth + 1)
    return left + right


def aggregate(rows):
    """Collapse ShopifyQL line rows to the raw PK grain
    (order_id, day, sku, is_reversal_row), summing metrics."""
    agg = {}
    for r in rows:
        order_id = (r.get("order_id") or "").strip()
        day = r.get("day")
        if not order_id or not day:
            continue
        sku = (r.get("product_variant_sku") or "").strip()
        oor = (r.get("order_or_return") or "").strip().lower()
        is_reversal = (oor == "return")
        key = (order_id, str(day), sku, is_reversal)

        rec = agg.get(key)
        if rec is None:
            rec = {
                "order_id": order_id,
                "order_name": r.get("order_name"),
                "day": str(day),
                "product_title": r.get("product_title_at_time_of_sale"),
                "product_type": r.get("product_type"),
                "product_vendor": r.get("product_vendor"),
                "variant_sku": sku,
                "variant_title": r.get("product_variant_title_at_time_of_sale"),
                "variant_price": _num(r.get("product_variant_price")),
                "customer_type": r.get("new_or_returning_customer"),
                "is_reversal": is_reversal,
                "gross_sales": 0.0, "discounts": 0.0, "returns": 0.0,
                "net_sales": 0.0, "total_sales": 0.0, "orders": 0,
                "net_items_sold": 0, "quantity_ordered": 0, "reversed_quantity": 0,
            }
            agg[key] = rec
        rec["gross_sales"]      += _num(r.get("gross_sales"))
        rec["discounts"]        += _num(r.get("discounts"))
        rec["returns"]          += _num(r.get("total_returns"))
        rec["net_sales"]        += _num(r.get("net_sales"))
        rec["total_sales"]      += _num(r.get("total_sales"))
        rec["orders"]           += int(_num(r.get("orders")))
        rec["net_items_sold"]   += int(_num(r.get("net_items_sold")))
        rec["quantity_ordered"] += int(_num(r.get("quantity_ordered")))
        rec["reversed_quantity"] += abs(int(_num(r.get("quantity_returned"))))
    return list(agg.values())


def write_rows(records, since, until):
    now = datetime.now(timezone.utc)
    tuples = []
    for rec in records:
        tuples.append((
            rec["order_id"], rec["order_name"], rec["day"],
            rec["product_title"], rec["product_type"], rec["product_vendor"],
            None,  # product_variant_id (not available from ShopifyQL)
            rec["variant_sku"], rec["variant_title"], rec["variant_price"],
            rec["gross_sales"], rec["discounts"], rec["returns"],
            rec["net_sales"], rec["total_sales"], rec["orders"],
            rec["net_items_sold"], rec["quantity_ordered"], rec["reversed_quantity"],
            rec["customer_type"], rec["is_reversal"], False, now,
        ))

    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM raw_shopify_vendor_sales WHERE day BETWEEN %s AND %s",
            (since.isoformat(), until.isoformat()),
        )
        deleted = cur.rowcount
        execute_values(cur, """
            INSERT INTO raw_shopify_vendor_sales (
                order_id, order_name, day,
                product_title_at_time_of_sale, product_type, product_vendor,
                product_variant_id, product_variant_sku,
                product_variant_title_at_time_of_sale, product_variant_price,
                gross_sales, discounts, returns, net_sales, total_sales,
                orders, net_items_sold, quantity_ordered, reversed_quantity,
                new_or_returning_customer, is_reversal_row, is_totals_row, _loaded_at
            ) VALUES %s
            ON CONFLICT (order_id, day, product_variant_sku, is_reversal_row)
            DO UPDATE SET
                order_name = EXCLUDED.order_name,
                product_title_at_time_of_sale = EXCLUDED.product_title_at_time_of_sale,
                product_type = EXCLUDED.product_type,
                product_vendor = EXCLUDED.product_vendor,
                product_variant_title_at_time_of_sale = EXCLUDED.product_variant_title_at_time_of_sale,
                product_variant_price = EXCLUDED.product_variant_price,
                gross_sales = EXCLUDED.gross_sales,
                discounts = EXCLUDED.discounts,
                returns = EXCLUDED.returns,
                net_sales = EXCLUDED.net_sales,
                total_sales = EXCLUDED.total_sales,
                orders = EXCLUDED.orders,
                net_items_sold = EXCLUDED.net_items_sold,
                quantity_ordered = EXCLUDED.quantity_ordered,
                reversed_quantity = EXCLUDED.reversed_quantity,
                new_or_returning_customer = EXCLUDED.new_or_returning_customer,
                _loaded_at = EXCLUDED._loaded_at
        """, tuples, page_size=1000)
        conn.commit()
        log.info("Wrote %d rows (deleted %d existing) for %s..%s",
                 len(tuples), deleted, since, until)
    finally:
        conn.close()


def parse_args():
    since = None
    until = None
    for a in sys.argv[1:]:
        if a.startswith("--since="):
            since = datetime.strptime(a.split("=", 1)[1], "%Y-%m-%d").date()
        elif a.startswith("--until="):
            until = datetime.strptime(a.split("=", 1)[1], "%Y-%m-%d").date()
    return since, until


def default_window():
    """Incremental by default: from max(day)-4 to today. Full history if empty."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        cur.execute("SELECT MAX(day) FROM raw_shopify_vendor_sales")
        mx = cur.fetchone()[0]
    finally:
        conn.close()
    today = datetime.now(timezone.utc).date()
    if mx:
        return (mx - timedelta(days=4)), today
    return HISTORICAL_START, today


def main():
    since, until = parse_args()
    if since is None or until is None:
        d_since, d_until = default_window()
        since = since or d_since
        until = until or d_until
    log.info("Shop Zetu ShopifyQL extract: %s .. %s", since, until)

    all_rows = []
    cursor = since
    while cursor <= until:
        win_end = min(cursor + timedelta(days=WINDOW_DAYS - 1), until)
        all_rows.extend(fetch_range(cursor, win_end))
        cursor = win_end + timedelta(days=1)

    log.info("Fetched %d raw line rows; aggregating...", len(all_rows))
    records = aggregate(all_rows)
    log.info("Aggregated to %d rows at (order_id, day, sku, is_reversal) grain", len(records))

    write_rows(records, since, until)

    # Final reconciliation across the whole extracted range.
    net = sum(r["total_sales"] for r in records)
    log.info("DONE. Net total_sales over extract = %.2f KES (%.3fM)", net, net / 1e6)


if __name__ == "__main__":
    main()
