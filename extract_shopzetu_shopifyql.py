cat > /home/runner/workspace/extract_shopzetu_shopifyql.py << 'ENDOFFILE'
"""
extract_shopzetu_shopifyql.py
─────────────────────────────
Pulls Shop Zetu sales via ShopifyQL (GraphQL Admin API) into Replit PostgreSQL.
Mirrors the BigQuery pipeline exactly — same query, same pagination, same logic.

Run modes:
  python extract_shopzetu_shopifyql.py                    # incremental (last 4 days)
  python extract_shopzetu_shopifyql.py --since 2026-01-01 --until 2026-06-10  # full range
  python extract_shopzetu_shopifyql.py --dry-run          # fetch only, no DB write
"""

import os, json, time, logging, argparse, uuid
from datetime import date, timedelta, datetime
import requests
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
SHOP         = os.environ["SHOPZETU_STORE"]          # shop-zetu-kenya.myshopify.com
ACCESS_TOKEN = os.environ["SHOPZETU_TOKEN"]
API_VERSION  = "2025-10"
PAGE_SIZE    = 5000
PAGE_DELAY   = 12   # seconds between pages to avoid rate limits

VENDORS = [
    "Vivo", "vivo", "VIVO",
    "Safari", "safari", "Safari by Vivo", "SafariByVivo",
    "Zoya", "zoya", "Zoya Essentials",
    "Shiv", "shiv",
]

DATABASE_URL = os.environ["DATABASE_URL"]

# ── ShopifyQL query builder ────────────────────────────────────────────────────
def build_shopifyql(since: str, until: str, limit: int = PAGE_SIZE, offset: int = 0) -> str:
    vendor_list = ", ".join(f"'{v}'" for v in VENDORS)
    offset_clause = f" OFFSET {offset}" if offset > 0 else ""
    return (
        f"FROM sales "
        f"SHOW total_sales, orders, gross_sales, discounts, returns, net_sales, "
        f"net_items_sold, quantity_ordered, quantity_returned "
        f"WHERE product_vendor IN ({vendor_list}) "
        f"GROUP BY day, order_id, order_name, subscription_or_one_time, "
        f"line_type, pos_location_name, product_variant_price, "
        f"product_title_at_time_of_sale, product_type, product_vendor, product_variant_id, "
        f"product_variant_sku, product_variant_title_at_time_of_sale, "
        f"new_or_returning_customer WITH TOTALS, CURRENCY 'KES' "
        f"SINCE {since} UNTIL {until} "
        f"ORDER BY gross_sales ASC "
        f"LIMIT {limit}{offset_clause}"
    )

# ── GraphQL runner with rate-limit retry ──────────────────────────────────────
def run_shopifyql(shopifyql: str) -> dict:
    url = f"https://{SHOP}/admin/api/{API_VERSION}/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
    }
    escaped = shopifyql.replace("\\", "\\\\").replace('"', '\\"')
    gql = (
        'query { shopifyqlQuery(query: "' + escaped + '") { '
        'tableData { columns { name displayName dataType } rows } '
        'parseErrors } }'
    )
    for attempt in range(5):
        resp = requests.post(url, headers=headers, json={"query": gql}, timeout=90)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 15))
            log.warning("Rate limited — sleeping %ds", retry_after)
            time.sleep(retry_after)
            continue
        resp.raise_for_status()
        data = resp.json()
        if "errors" in data:
            # Check for windowResetAt rate limit in errors
            for err in data.get("errors", []):
                extensions = err.get("extensions", {})
                if "windowResetAt" in str(extensions):
                    reset_at = extensions.get("windowResetAt", "")
                    log.warning("Query rate limit hit, windowResetAt=%s — sleeping 15s", reset_at)
                    time.sleep(15)
                    break
            else:
                raise RuntimeError(f"GraphQL errors:\n{json.dumps(data['errors'], indent=2)}")
            continue
        parse_errors = (data.get("data") or {}).get("shopifyqlQuery", {}).get("parseErrors", [])
        if parse_errors:
            raise RuntimeError(f"ShopifyQL parse errors:\n{json.dumps(parse_errors, indent=2)}")
        return data
    raise RuntimeError("Max retries exceeded")

# ── Paginated fetch ────────────────────────────────────────────────────────────
def fetch_shopifyql(since: str, until: str):
    all_rows = []
    columns = []
    shopify_totals = {}
    offset = 0
    page = 1

    while True:
        log.info("Page %d (offset=%d) %s → %s", page, offset, since, until)
        data = run_shopifyql(build_shopifyql(since, until, PAGE_SIZE, offset))

        try:
            td = data["data"]["shopifyqlQuery"]["tableData"]
            columns = td["columns"]
            raw_rows = td["rows"]
        except (KeyError, TypeError):
            log.error("Unexpected response: %s", str(data)[:500])
            raise

        if not raw_rows:
            log.info("No more rows — done.")
            break

        # Parse column names
        col_names = [c["name"] for c in columns]

        # Convert rows from list to dict
        parsed = []
        for row in raw_rows:
            if isinstance(row, list):
                parsed.append(dict(zip(col_names, row)))
            elif isinstance(row, dict):
                parsed.append(row)

        # Extract WITH TOTALS from first page
        if page == 1:
            for row in parsed:
                order_id = row.get("order_id") or row.get("order_name", "")
                if not order_id or str(order_id).strip() == "":
                    # This is the totals row
                    try:
                        shopify_totals["gross_sales"] = float(row.get("gross_sales") or 0)
                        shopify_totals["total_sales"] = float(row.get("total_sales") or 0)
                    except:
                        pass
                    break

        # Filter out totals rows (null order_id)
        data_rows = [r for r in parsed if r.get("order_id") and str(r.get("order_id", "")).strip()]
        all_rows.extend(data_rows)
        log.info("  → %d rows so far", len(all_rows))

        if len(raw_rows) < PAGE_SIZE:
            log.info("Last page (%d rows < %d)", len(raw_rows), PAGE_SIZE)
            break

        offset += PAGE_SIZE
        page += 1
        log.info("Sleeping %ds before next page...", PAGE_DELAY)
        time.sleep(PAGE_DELAY)

    log.info("Total: %d data rows fetched", len(all_rows))
    if shopify_totals:
        log.info("Shopify WITH TOTALS: %s", shopify_totals)

    return all_rows, shopify_totals

# ── Transform rows to all_sales format ────────────────────────────────────────
def transform_rows(rows: list[dict]) -> list[tuple]:
    now = datetime.utcnow()
    result = []

    for r in rows:
        order_id   = str(r.get("order_id") or "")
        order_name = str(r.get("order_name") or "")
        day        = str(r.get("day") or "")[:10]

        if not order_id or not day:
            continue

        # Skip shopping bags
        title = str(r.get("product_title_at_time_of_sale") or "")
        if "shopping bag" in title.lower():
            continue

        line_type      = str(r.get("line_type") or "")
        total_sales    = float(r.get("total_sales") or 0)
        gross_sales    = float(r.get("gross_sales") or 0)
        discounts      = float(r.get("discounts") or 0)
        returns_val    = float(r.get("returns") or 0)
        net_sales      = float(r.get("net_sales") or 0)
        net_qty        = int(float(r.get("net_items_sold") or 0))
        qty_ordered    = int(float(r.get("quantity_ordered") or 0))
        qty_returned   = int(float(r.get("quantity_returned") or 0))
        price          = float(r.get("product_variant_price") or 0)
        sku            = str(r.get("product_variant_sku") or "")
        variant_id     = str(r.get("product_variant_id") or "")
        product_type   = str(r.get("product_type") or "")
        vendor         = str(r.get("product_vendor") or "")
        customer_type  = str(r.get("new_or_returning_customer") or "")

        # Derive is_reversal from returns metric sign and line_type
        is_reversal = returns_val < 0 or "return" in line_type.lower()
        sale_kind   = "return" if is_reversal else "order"

        # Match BigQuery: total_sales_kes = total_sales (already in KES, rate=1)
        total_sales_kes  = total_sales if not is_reversal else 0.0
        gross_sales_kes  = gross_sales if not is_reversal else 0.0
        discounts_kes    = abs(discounts) if not is_reversal else 0.0
        returns_kes      = abs(returns_val) if is_reversal else 0.0
        net_sales_kes    = net_sales

        result.append((
            str(uuid.uuid4()),        # id
            "shop-zetu",              # store_id
            order_id,                 # order_id
            order_name,               # order_name
            day,                      # sale_date
            day,                      # day
            "Online - Shop Zetu",     # pos_location_name
            "Online",                 # country
            "Online",                 # channel
            None,                     # customer_id
            customer_type,            # customer_type
            sale_kind,                # sale_kind
            title,                    # product_title
            sku,                      # variant_sku
            qty_ordered,              # ordered_item_quantity
            round(price, 2),          # product_price_kes
            round(price, 2),          # product_price
            round(gross_sales_kes, 2),# gross_sales_kes
            round(discounts_kes, 2),  # discounts_kes
            round(net_sales_kes, 2),  # net_sales_kes
            round(total_sales_kes, 2),# total_sales_kes
            net_qty,                  # net_quantity
            round(returns_kes, 2),    # returns_kes
            now,                      # loaded_at
        ))

    return result

# ── Write to PostgreSQL ────────────────────────────────────────────────────────
def write_to_db(rows: list[tuple], since: str, until: str):
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Delete existing Shop Zetu rows in the date window
    log.info("Deleting shop-zetu rows %s → %s", since, until)
    cur.execute("""
        DELETE FROM all_sales
        WHERE store_id = 'shop-zetu'
          AND sale_date::date BETWEEN %s AND %s
    """, (since, until))
    deleted = cur.rowcount
    log.info("Deleted %d existing rows", deleted)

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
    cur.close()
    conn.close()

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--until", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="Fetch only, no DB write")
    args = parser.parse_args()

    # Default: incremental — last 4 days
    if args.since and args.until:
        since = args.since
        until = args.until
    else:
        conn = psycopg2.connect(DATABASE_URL)
        cur  = conn.cursor()
        cur.execute("SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = 'shop-zetu'")
        last = cur.fetchone()[0]
        cur.close()
        conn.close()
        if last:
            since = str(last - timedelta(days=4))
        else:
            since = "2024-01-01"
        until = str(date.today())

    log.info("ShopifyQL sync: %s → %s", since, until)

    rows_raw, totals = fetch_shopifyql(since, until)

    if not rows_raw:
        log.info("No rows returned — nothing to write")
        return

    rows = transform_rows(rows_raw)
    log.info("Transformed %d rows", len(rows))

    # Reconciliation check
    total_sales_sum = sum(r[20] for r in rows if r[11] == "order")
    log.info("Total sales KES (orders only): {:,.2f}".format(total_sales_sum))
    if totals.get("gross_sales"):
        diff = abs(total_sales_sum - totals["gross_sales"])
        pct  = diff / totals["gross_sales"] * 100 if totals["gross_sales"] else 0
        log.info("Shopify WITH TOTALS gross: {:,.2f}".format(totals["gross_sales"]))
        log.info("Diff: {:,.2f} ({:.2f}%)".format(diff, pct))
        if pct < 5:
            log.info("✅ Reconciliation OK")
        else:
            log.warning("⚠️ Reconciliation MISMATCH > 5%%")

    if args.dry_run:
        log.info("--dry-run: skipping DB write")
        return

    write_to_db(rows, since, until)
    log.info("✅ ShopifyQL sync complete")

if __name__ == "__main__":
    main()
ENDOFFILE