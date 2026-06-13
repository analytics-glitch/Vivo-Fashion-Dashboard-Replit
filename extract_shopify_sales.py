"""
Shopify Sales Extractor — exact mirror of BigQuery extractor
Writes to raw_shopify_sales (PostgreSQL) instead of BigQuery shopify_sales.

Key logic copied exactly from BigQuery extractor:
- fetch_location_map: /locations.json → location_id -> name
- get_pos_location_name: location_id → name, source_name fallback
- Refunds processed as separate return rows dated by refund date
- Returns attributed to ORIGINAL order location
- Fields: id,name,created_at,customer,source_name,location_id,line_items,refunds
- Batches: 90 days, created_at_min/max, status=any
"""
import os, time, logging
import psycopg2
import requests
from collections import defaultdict
from datetime import datetime, timedelta
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ['DATABASE_URL']

STORES = [
    {
        "id":           "vivowoman",
        "store_url":    os.environ["SHOPIFY_KENYA_STORE"],
        "access_token": os.environ["SHOPIFY_KENYA_TOKEN"],
        "cutoff_date":  "2026-03-19",
    },
    {
        "id":           "vivo-uganda",
        "store_url":    os.environ["SHOPIFY_UGANDA_STORE"],
        "access_token": os.environ["SHOPIFY_UGANDA_TOKEN"],
        "cutoff_date":  None,
    },
    {
        "id":           "vivo-rwanda",
        "store_url":    os.environ["SHOPIFY_RWANDA_STORE"],
        "access_token": os.environ["SHOPIFY_RWANDA_TOKEN"],
        "cutoff_date":  None,
    },
]


def fetch_location_map(store_url, access_token):
    """Build a mapping of location_id -> location_name. Exact copy from BigQuery extractor."""
    location_map = {}
    try:
        resp = requests.get(
            f"https://{store_url}/admin/api/2025-10/locations.json",
            headers={"X-Shopify-Access-Token": access_token},
            timeout=30,
        )
        for loc in resp.json().get("locations", []):
            loc_id = loc.get("id")
            loc_name = loc.get("name")
            if loc_id and loc_name:
                location_map[loc_id] = loc_name
    except Exception as e:
        log.warning(f"Failed to fetch locations: {e}")
    return location_map


def get_pos_location_name(location_id, source_name, location_map, store_id):
    """Exact copy from BigQuery extractor."""
    if location_id and location_id in location_map:
        return location_map[location_id]

    source = (source_name or "").lower().strip()

    if source == "shopify_draft_order":
        return "Manual Order"

    if source and source.isdigit():
        return "Third-party App"

    third_party_apps = {"multivendor", "marketplace", "oberlo", "dsers", "spocket", "printful"}
    if source in third_party_apps:
        return "Third-party App"

    return f"Online - {store_id}"


def get_paginated(store_url, access_token, endpoint, params):
    """Paginate through all results."""
    headers = {"X-Shopify-Access-Token": access_token}
    url = f"https://{store_url}/admin/api/2025-10{endpoint}"
    all_results = []
    while url:
        for attempt in range(3):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code == 429:
                    time.sleep(int(resp.headers.get("Retry-After", 10)))
                    continue
                resp.raise_for_status()
                break
            except Exception as e:
                log.warning("Retry %d: %s", attempt + 1, e)
                time.sleep(10)

        key = endpoint.split("/")[-1].split(".")[0]
        all_results.extend(resp.json().get(key, []))

        link = resp.headers.get("Link", "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
        url = next_url
        params = {}
    return all_results


def get_checkpoint(cur, store_id):
    cur.execute("SELECT MAX(day) FROM raw_shopify_sales WHERE store_id = %s", (store_id,))
    result = cur.fetchone()[0]
    if result:
        return (result - timedelta(days=2)).strftime("%Y-%m-%d")
    return "2019-01-01"


def save_rows(cur, conn, sales_rows, store_id):
    if not sales_rows:
        return
    # Delete existing rows for these orders
    order_ids = list(set(str(row["order_id"]) for row in sales_rows))
    cur.execute(
        "DELETE FROM raw_shopify_sales WHERE store_id = %s AND order_id = ANY(%s)",
        (store_id, order_ids)
    )
    # Insert
    rows = []
    now = datetime.utcnow()
    for r in sales_rows:
        day = r["day"]
        rows.append((
            str(r["line_item_id"]) if r.get("line_item_id") else None,
            store_id,
            day,
            str(r["order_id"]),
            r.get("order_name"),
            r.get("purchase_option"),
            r.get("sale_kind"),
            r.get("sale_line_type"),
            r.get("pos_location_name"),
            r.get("product_price"),
            r.get("product_title"),
            r.get("product_type"),
            r.get("product_vendor"),
            str(r["variant_id"]) if r.get("variant_id") else None,
            r.get("variant_sku"),
            r.get("variant_title"),
            r.get("customer_type"),
            str(r["customer_id"]) if r.get("customer_id") else None,
            r.get("total_sales"),
            r.get("orders", 1),
            r.get("gross_sales"),
            r.get("discounts"),
            r.get("returns"),
            r.get("net_sales"),
            r.get("net_quantity"),
            r.get("ordered_item_quantity"),
            r.get("returned_item_quantity"),
            r.get("year"),
            r.get("line_item_id_str"),
            r.get("restock_type"),
            now,
        ))
    execute_values(cur, """
        INSERT INTO raw_shopify_sales (
            id, store_id, day, order_id, order_name,
            purchase_option, sale_kind, sale_line_type,
            pos_location_name,
            product_price, product_title, product_type, product_vendor,
            variant_id, variant_sku, variant_title,
            customer_type, customer_id,
            total_sales, orders,
            gross_sales, discounts, returns, net_sales,
            net_quantity, ordered_item_quantity, returned_item_quantity,
            year, line_item_id, restock_type, _loaded_at
        ) VALUES %s
        ON CONFLICT DO NOTHING
    """, rows, page_size=500)
    conn.commit()


def fetch_sales(store_config, cur, conn, start_from=None):
    """Exact copy of BigQuery fetch_sales logic."""
    store_id     = store_config["id"]
    store_url    = store_config["store_url"]
    access_token = store_config["access_token"]
    cutoff_date  = store_config.get("cutoff_date")

    location_map = fetch_location_map(store_url, access_token)
    log.info("[%s] Loaded %d location mappings", store_id, len(location_map))

    checkpoint_date = start_from or get_checkpoint(cur, store_id)
    start_date = datetime.strptime(checkpoint_date, "%Y-%m-%d")
    end_date   = datetime.utcnow()
    if cutoff_date:
        end_date = min(end_date, datetime.strptime(cutoff_date, "%Y-%m-%d") + timedelta(days=1))

    log.info("[%s] Syncing from %s to %s", store_id, start_date.date(), end_date.date())

    total_sales = 0
    customer_cache = {}
    days_per_batch = 90

    while start_date < end_date:
        batch_end = min(start_date + timedelta(days=days_per_batch), end_date)
        log.info("[%s] Fetching %s to %s", store_id, start_date.date(), batch_end.date())

        params = {
            "status": "any",
            "limit": 250,
            "created_at_min": start_date.isoformat() + "Z",
            "created_at_max": batch_end.strftime("%Y-%m-%dT23:59:59Z"),
            "fields": "id,name,created_at,customer,source_name,location_id,line_items,refunds",
        }
        orders = get_paginated(store_url, access_token, "/orders.json", params)

        if orders:
            sales_rows = []
            for order in orders:
                created_at = order.get("created_at")
                try:
                    created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00")) if created_at else None
                except Exception:
                    created_dt = datetime.utcnow()

                order_id   = order.get("id")
                order_name = order.get("name")
                customer   = order.get("customer")
                customer_id = customer.get("id") if customer else None
                customer_type = "Returning" if (customer and customer.get("orders_count", 0) > 1) else ("Guest" if not customer else "New")

                # Convert to EAT (UTC+3) for day — matches BigQuery
                from datetime import timezone as _tz, timedelta as _td
                EAT = _tz(_td(hours=3))
                eat_dt = created_dt.astimezone(EAT) if created_dt else None
                day         = eat_dt.strftime("%Y-%m-%d") if eat_dt else None
                year        = created_dt.year if created_dt else None
                source_name = order.get("source_name")
                location_id = order.get("location_id")
                pos_location_name = get_pos_location_name(location_id, source_name, location_map, store_id)

                # Build refund map per line_item_id — EXACT copy from BigQuery extractor
                refund_details_per_line = defaultdict(list)
                for refund in order.get("refunds", []) or []:
                    refund_created_at = refund.get("created_at")
                    try:
                        refund_dt = datetime.fromisoformat(refund_created_at.replace("Z", "+00:00")) if refund_created_at else created_dt
                    except Exception:
                        refund_dt = created_dt

                    for rli in refund.get("refund_line_items", []) or []:
                        li = rli.get("line_item") or {}
                        line_item_id = li.get("id")
                        qty = rli.get("quantity", 0)
                        restock_type = rli.get("restock_type")
                        if line_item_id and qty > 0:
                            refund_details_per_line[line_item_id].append({
                                "quantity": int(qty),
                                "refund_date": refund_dt,
                                "restock_type": restock_type,
                            })

                for li in order.get("line_items", []) or []:
                    variant_id    = li.get("variant_id") or None
                    variant_sku   = li.get("sku") or None
                    variant_title = li.get("variant_title") or li.get("title") or None
                    product_title = li.get("name") or li.get("title") or None
                    product_price = float(li.get("price") or 0)
                    product_type  = li.get("product_type") or None
                    product_vendor = li.get("vendor") or None
                    quantity      = int(li.get("quantity", 0))
                    line_item_id  = li.get("id")

                    discounts = 0.0
                    for alloc in li.get("discount_allocations", []) or []:
                        try:
                            discounts += float(alloc.get("amount", 0))
                        except Exception:
                            pass

                    gross_sales = product_price * quantity

                    # ORDER row
                    sales_rows.append({
                        "store_id":              store_id,
                        "day":                   day,
                        "order_id":              order_id,
                        "order_name":            order_name,
                        "line_item_id":          line_item_id,
                        "line_item_id_str":      str(line_item_id) if line_item_id else None,
                        "purchase_option":       source_name or "one_time",
                        "sale_kind":             "order",
                        "sale_line_type":        "product",
                        "pos_location_name":     pos_location_name,
                        "product_price":         round(product_price, 2),
                        "product_title":         product_title,
                        "product_type":          product_type,
                        "product_vendor":        product_vendor,
                        "variant_id":            variant_id,
                        "variant_sku":           variant_sku,
                        "variant_title":         variant_title,
                        "customer_type":         customer_type,
                        "customer_id":           customer_id,
                        "total_sales":           round(gross_sales - discounts, 2),
                        "orders":                1,
                        "gross_sales":           round(gross_sales, 2),
                        "discounts":             round(discounts, 2),
                        "returns":               0,
                        "net_sales":             round(gross_sales - discounts, 2),
                        "net_quantity":          quantity,
                        "ordered_item_quantity": quantity,
                        "returned_item_quantity": 0,
                        "restock_type":          None,
                        "year":                  year,
                    })

                    # RETURN rows — dated by refund date, attributed to original location
                    line_refunds = refund_details_per_line.get(line_item_id, [])
                    for refund_info in line_refunds:
                        if refund_info.get("restock_type") == "cancel":
                            continue
                        returned_qty = refund_info["quantity"]
                        refund_dt    = refund_info["refund_date"]
                        from datetime import timezone as _tz, timedelta as _td
                        EAT = _tz(_td(hours=3))
                        eat_refund_dt = refund_dt.astimezone(EAT) if refund_dt else None
                        refund_day   = eat_refund_dt.strftime("%Y-%m-%d") if eat_refund_dt else day
                        refund_year  = refund_dt.year if refund_dt else year
                        return_amount = product_price * returned_qty

                        sales_rows.append({
                            "store_id":              store_id,
                            "day":                   refund_day,
                            "order_id":              order_id,
                            "order_name":            order_name,
                            "line_item_id":          f"{line_item_id}_ret" if line_item_id else None,
                            "line_item_id_str":      f"{line_item_id}_ret" if line_item_id else None,
                            "purchase_option":       source_name or "one_time",
                            "sale_kind":             "return",
                            "sale_line_type":        "product",
                            "pos_location_name":     pos_location_name,
                            "product_price":         round(product_price, 2),
                            "product_title":         product_title,
                            "product_type":          product_type,
                            "product_vendor":        product_vendor,
                            "variant_id":            variant_id,
                            "variant_sku":           variant_sku,
                            "variant_title":         variant_title,
                            "customer_type":         customer_type,
                            "customer_id":           customer_id,
                            "total_sales":           round(-return_amount, 2),
                            "orders":                0,
                            "gross_sales":           0,
                            "discounts":             0,
                            "returns":               round(return_amount, 2),
                            "net_sales":             round(-return_amount, 2),
                            "net_quantity":          -returned_qty,
                            "ordered_item_quantity": 0,
                            "returned_item_quantity": returned_qty,
                            "restock_type":          refund_info.get("restock_type"),
                            "year":                  refund_year,
                        })

            if sales_rows:
                save_rows(cur, conn, sales_rows, store_id)
                total_sales += len(sales_rows)
                log.info("[%s] %s to %s: %d rows saved", store_id, start_date.date(), batch_end.date(), len(sales_rows))

        start_date = batch_end

    log.info("[%s] Done. Total rows: %d", store_id, total_sales)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    for store in STORES:
        fetch_sales(store, cur, conn)

    cur.execute("""
        SELECT store_id, COUNT(*) as rows, MIN(day) as first, MAX(day) as last
        FROM raw_shopify_sales
        GROUP BY store_id ORDER BY store_id
    """)
    print("\n=== raw_shopify_sales summary ===")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]} rows ({row[2]} to {row[3]})")

    conn.close()


if __name__ == "__main__":
    main()