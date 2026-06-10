python - << 'EOF'
content = '''import os, json, time, logging, argparse, uuid
from datetime import date, timedelta, datetime
import requests
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SHOP         = os.environ["SHOPZETU_STORE"]
ACCESS_TOKEN = os.environ["SHOPZETU_TOKEN"]
API_VERSION  = "2025-10"
PAGE_SIZE    = 5000
PAGE_DELAY   = 12

VENDORS = [
    "Vivo", "vivo", "VIVO",
    "Safari", "safari", "Safari by Vivo", "SafariByVivo",
    "Zoya", "zoya", "Zoya Essentials",
    "Shiv", "shiv",
]

DATABASE_URL = os.environ["DATABASE_URL"]

def build_shopifyql(since, until, limit=5000, offset=0):
    vendor_list = ", ".join(f"\\'{v}\\'" for v in VENDORS)
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
        f"new_or_returning_customer WITH TOTALS, CURRENCY \\'KES\\' "
        f"SINCE {since} UNTIL {until} "
        f"ORDER BY gross_sales ASC "
        f"LIMIT {limit}{offset_clause}"
    )

def run_shopifyql(shopifyql):
    url = f"https://{SHOP}/admin/api/{API_VERSION}/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
    }
    escaped = shopifyql.replace("\\\\", "\\\\\\\\").replace(\'"\', \'\\\\"\')
    gql = (
        \'query { shopifyqlQuery(query: "\' + escaped + \'") { \'
        \'tableData { columns { name displayName dataType } rows } \'
        \'parseErrors } }\'
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
            for err in data.get("errors", []):
                if "windowResetAt" in str(err.get("extensions", {})):
                    log.warning("Rate limit hit — sleeping 15s")
                    time.sleep(15)
                    break
            else:
                raise RuntimeError(f"GraphQL errors: {data[\'errors\']}")
            continue
        parse_errors = (data.get("data") or {}).get("shopifyqlQuery", {}).get("parseErrors", [])
        if parse_errors:
            raise RuntimeError(f"ShopifyQL parse errors: {parse_errors}")
        return data
    raise RuntimeError("Max retries exceeded")

def fetch_shopifyql(since, until):
    all_rows = []
    columns = []
    shopify_totals = {}
    offset = 0
    page = 1

    while True:
        log.info("Page %d (offset=%d) %s -> %s", page, offset, since, until)
        data = run_shopifyql(build_shopifyql(since, until, PAGE_SIZE, offset))
        td = data["data"]["shopifyqlQuery"]["tableData"]
        columns = td["columns"]
        raw_rows = td["rows"]

        if not raw_rows:
            break

        col_names = [c["name"] for c in columns]
        parsed = []
        for row in raw_rows:
            if isinstance(row, list):
                parsed.append(dict(zip(col_names, row)))
            else:
                parsed.append(row)

        if page == 1:
            for row in parsed:
                if not (row.get("order_id") and str(row.get("order_id", "")).strip()):
                    try:
                        shopify_totals["gross_sales"] = float(row.get("gross_sales") or 0)
                    except:
                        pass
                    break

        data_rows = [r for r in parsed if r.get("order_id") and str(r.get("order_id","")).strip()]
        all_rows.extend(data_rows)
        log.info("  -> %d rows so far", len(all_rows))

        if len(raw_rows) < PAGE_SIZE:
            break

        offset += PAGE_SIZE
        page += 1
        log.info("Sleeping %ds...", PAGE_DELAY)
        time.sleep(PAGE_DELAY)

    return all_rows, shopify_totals

def transform_rows(rows):
    now = datetime.utcnow()
    result = []
    for r in rows:
        order_id  = str(r.get("order_id") or "")
        order_name= str(r.get("order_name") or "")
        day       = str(r.get("day") or "")[:10]
        if not order_id or not day:
            continue
        title = str(r.get("product_title_at_time_of_sale") or "")
        if "shopping bag" in title.lower():
            continue
        line_type    = str(r.get("line_type") or "")
        total_sales  = float(r.get("total_sales") or 0)
        gross_sales  = float(r.get("gross_sales") or 0)
        discounts    = float(r.get("discounts") or 0)
        returns_val  = float(r.get("returns") or 0)
        net_sales    = float(r.get("net_sales") or 0)
        net_qty      = int(float(r.get("net_items_sold") or 0))
        qty_ordered  = int(float(r.get("quantity_ordered") or 0))
        price        = float(r.get("product_variant_price") or 0)
        sku          = str(r.get("product_variant_sku") or "")
        customer_type= str(r.get("new_or_returning_customer") or "")
        is_reversal  = returns_val < 0 or "return" in line_type.lower()
        sale_kind    = "return" if is_reversal else "order"
        total_sales_kes = total_sales if not is_reversal else 0.0
        gross_sales_kes = gross_sales if not is_reversal else 0.0
        discounts_kes   = abs(discounts) if not is_reversal else 0.0
        returns_kes     = abs(returns_val) if is_reversal else 0.0
        result.append((
            str(uuid.uuid4()), "shop-zetu", order_id, order_name,
            day, day, "Online - Shop Zetu", "Online", "Online",
            None, customer_type, sale_kind,
            title, sku, qty_ordered,
            round(price, 2), round(price, 2),
            round(gross_sales_kes, 2), round(discounts_kes, 2),
            round(net_sales, 2), round(total_sales_kes, 2),
            net_qty, round(returns_kes, 2), now,
        ))
    return result

def write_to_db(rows, since, until):
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    cur.execute("DELETE FROM all_sales WHERE store_id = \'shop-zetu\' AND sale_date::date BETWEEN %s AND %s", (since, until))
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
    cur.close()
    conn.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None)
    parser.add_argument("--until", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.since and args.until:
        since = args.since
        until = args.until
    else:
        conn = psycopg2.connect(DATABASE_URL)
        cur  = conn.cursor()
        cur.execute("SELECT MAX(sale_date::date) FROM all_sales WHERE store_id = \'shop-zetu\'")
        last = cur.fetchone()[0]
        cur.close()
        conn.close()
        since = str((last - timedelta(days=4))) if last else "2024-01-01"
        until = str(date.today())

    log.info("ShopifyQL sync: %s -> %s", since, until)
    rows_raw, totals = fetch_shopifyql(since, until)

    if not rows_raw:
        log.info("No rows returned")
        return

    rows = transform_rows(rows_raw)
    log.info("Transformed %d rows", len(rows))

    total_sales_sum = sum(r[20] for r in rows if r[11] == "order")
    log.info("Total sales KES (orders): {:,.2f}".format(total_sales_sum))
    if totals.get("gross_sales"):
        diff = abs(total_sales_sum - totals["gross_sales"])
        pct  = diff / totals["gross_sales"] * 100
        log.info("Shopify WITH TOTALS: {:,.2f} | Diff: {:,.2f} ({:.2f}%)".format(totals["gross_sales"], diff, pct))
        log.info("✅ Reconciliation OK" if pct < 5 else "⚠️  Reconciliation MISMATCH")

    if args.dry_run:
        log.info("--dry-run: skipping DB write")
        return

    write_to_db(rows, since, until)
    log.info("✅ Done")

if __name__ == "__main__":
    main()
'''

with open('/home/runner/workspace/extract_shopzetu_shopifyql.py', 'w') as f:
    f.write(content)
print("File created")
EOF