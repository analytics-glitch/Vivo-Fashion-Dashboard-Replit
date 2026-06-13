"""
Shopify Sales Extractor (self-contained, saves to our Postgres database)

A faithful port of the reference Shopify Sales Extractor, adapted to run in this
repo with NO `src/` framework. The four framework dependencies of the original
(`src.adapters`, `src.clients.shopify_client`, `src.extractors.utils.vendor_filter`,
`src.utils`) are implemented inline below against:

  - Shopify Admin REST API (via `requests`)
  - our PostgreSQL database (via `psycopg2`, table `raw_shopify_sales`)

Reference logic preserved 1:1:
  - fetch_location_map: /locations.json -> {location_id: name}
  - get_pos_location_name: location_id -> name, else source_name fallback
  - prefetch_customer_orders_count: DB first (raw_shopify_orders), then API for the rest
  - get_customer_type: Returning / New / Guest from orders_count
  - vendor filtering via should_include_vendor
  - one "order" row per line item + one separate "return" row per refund line item,
    returns dated by the refund date and attributed to the ORIGINAL order location,
    restock_type == "cancel" excluded
  - 90-day forward batches, status=any, created_at_min/max, idempotent delete+insert

Adaptations required to save into our DB (documented intentionally):
  - target table is `raw_shopify_sales` (schema in create_raw_tables.py)
  - `day`/`year` use Africa/Nairobi (UTC+3, "EAT") so rows line up with the 1.4M
    rows already loaded and the all_sales transform (East Africa local dates)
  - return rows get a "<line_item_id>_ret" id so they don't collide with the order
    row under the table primary key (line_item_id, store_id) -- a plain match would
    drop returns via ON CONFLICT DO NOTHING
  - checkpoint is derived from MAX(day) in the table (minus 2 days of overlap), so
    re-runs resume forward without a separate checkpoint store

Run:  python3 shopify_sales_extractor.py
Env:  DATABASE_URL, SHOPIFY_{KENYA,UGANDA,RWANDA}_STORE, SHOPIFY_{KENYA,UGANDA,RWANDA}_TOKEN
Optional per-store vendor filter: SHOPIFY_{KENYA,UGANDA,RWANDA}_VENDORS="VendorA,VendorB"
"""

import os
import time
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import psycopg2
import requests
from psycopg2.extras import execute_values, RealDictCursor

API_VERSION = "2025-10"
EAT = timezone(timedelta(hours=3))  # Africa/Nairobi (UTC+3)
DATABASE_URL = os.environ["DATABASE_URL"]


# ---------------------------------------------------------------------------
# src.utils.setup_logger
# ---------------------------------------------------------------------------
def setup_logger():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return logging.getLogger("shopify_sales")


logger = setup_logger()


# ---------------------------------------------------------------------------
# Store configuration (built from env vars; stores without creds are skipped)
# ---------------------------------------------------------------------------
def _vendor_filter(env_key):
    raw = os.environ.get(env_key, "").strip()
    if not raw:
        return None
    return [v.strip() for v in raw.split(",") if v.strip()]


def build_stores():
    candidates = [
        # id            store_env                token_env                vendors_env                cutoff_date
        ("vivowoman",   "SHOPIFY_KENYA_STORE",   "SHOPIFY_KENYA_TOKEN",   "SHOPIFY_KENYA_VENDORS",   "2026-03-19"),
        ("vivo-uganda", "SHOPIFY_UGANDA_STORE",  "SHOPIFY_UGANDA_TOKEN",  "SHOPIFY_UGANDA_VENDORS",  None),
        ("vivo-rwanda", "SHOPIFY_RWANDA_STORE",  "SHOPIFY_RWANDA_TOKEN",  "SHOPIFY_RWANDA_VENDORS",  None),
    ]
    stores = []
    for store_id, store_env, token_env, vendors_env, cutoff in candidates:
        store_url = os.environ.get(store_env)
        access_token = os.environ.get(token_env)
        if not store_url or not access_token:
            logger.warning("[%s] Skipped: %s / %s not set", store_id, store_env, token_env)
            continue
        stores.append({
            "id": store_id,
            "store_url": store_url,
            "access_token": access_token,
            "vendor_filter": _vendor_filter(vendors_env),
            "cutoff_date": cutoff,
        })
    return stores


# ---------------------------------------------------------------------------
# src.clients.shopify_client.ShopifyClient
# ---------------------------------------------------------------------------
class ShopifyClient:
    def __init__(self, store_config):
        self.store_id = store_config["id"]
        self.store_url = store_config["store_url"]
        self.access_token = store_config["access_token"]
        self._base = f"https://{self.store_url}/admin/api/{API_VERSION}"

    def get_paginated(self, endpoint, params):
        """Follow Shopify cursor pagination (Link header) and return all results."""
        headers = {"X-Shopify-Access-Token": self.access_token}
        url = self._base + endpoint
        key = endpoint.split("/")[-1].split(".")[0]
        all_results = []
        params = dict(params or {})
        while url:
            resp = None
            for attempt in range(3):
                try:
                    resp = requests.get(url, headers=headers, params=params, timeout=60)
                    if resp.status_code == 429:
                        time.sleep(int(resp.headers.get("Retry-After", 10)))
                        continue
                    resp.raise_for_status()
                    break
                except Exception as e:
                    logger.warning("[%s] Retry %d for %s: %s", self.store_id, attempt + 1, endpoint, e)
                    time.sleep(10)
            if resp is None:
                break

            all_results.extend(resp.json().get(key, []))

            next_url = None
            for part in resp.headers.get("Link", "").split(","):
                if 'rel="next"' in part:
                    next_url = part.split(";")[0].strip().strip("<>")
            url = next_url
            params = {}  # cursor is encoded in next_url
        return all_results


# ---------------------------------------------------------------------------
# src.adapters: DB helpers (execute_query / insert_batch / delete_rows / checkpoint)
# ---------------------------------------------------------------------------
_CONN = None


def _conn():
    global _CONN
    if _CONN is None or _CONN.closed:
        _CONN = psycopg2.connect(DATABASE_URL)
    return _CONN


def execute_query(query, params=None):
    conn = _conn()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, params or ())
        return [dict(r) for r in cur.fetchall()]


def get_checkpoint(store_id):
    """Resume point = last loaded day minus 2 days of overlap (idempotent re-insert
    handles the overlap). Empty table -> historical start."""
    rows = execute_query("SELECT MAX(day) AS m FROM raw_shopify_sales WHERE store_id = %s", (store_id,))
    last = rows[0]["m"] if rows else None
    if last:
        return (last - timedelta(days=2)).strftime("%Y-%m-%d")
    return "2019-01-01"


def save_checkpoint(store_id, date_str):
    """No separate checkpoint store: MAX(day) is the source of truth. Logged for parity."""
    logger.info("[%s] Checkpoint advanced to %s", store_id, date_str)


def save_rows(store_id, sales_rows):
    """Atomically replace this batch's orders: delete + insert in ONE transaction
    with a single commit, so a crash can never leave orders deleted-but-not-reinserted."""
    if not sales_rows:
        return
    order_ids = list({str(r["order_id"]) for r in sales_rows if r.get("order_id") is not None})
    now = datetime.utcnow()
    rows = []
    for r in sales_rows:
        rows.append((
            str(r["line_item_id"]) if r.get("line_item_id") else None,  # id
            r["store_id"],
            r["day"],
            str(r["order_id"]) if r.get("order_id") is not None else None,
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
            str(r["line_item_id"]) if r.get("line_item_id") else None,  # line_item_id
            r.get("restock_type"),
            now,
        ))
    conn = _conn()
    try:
        with conn.cursor() as cur:
            if order_ids:
                cur.execute(
                    "DELETE FROM raw_shopify_sales WHERE store_id = %s AND order_id = ANY(%s)",
                    (store_id, order_ids),
                )
            execute_values(cur, """
                INSERT INTO raw_shopify_sales (
                    id, store_id, day, order_id, order_name,
                    purchase_option, sale_kind, sale_line_type, pos_location_name,
                    product_price, product_title, product_type, product_vendor,
                    variant_id, variant_sku, variant_title,
                    customer_type, customer_id,
                    total_sales, orders,
                    gross_sales, discounts, returns, net_sales,
                    net_quantity, ordered_item_quantity, returned_item_quantity,
                    year, line_item_id, restock_type, _loaded_at
                ) VALUES %s
                ON CONFLICT (line_item_id, store_id) DO NOTHING
            """, rows, page_size=500)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------------------
# src.extractors.utils.vendor_filter.should_include_vendor
# ---------------------------------------------------------------------------
def should_include_vendor(vendor, vendor_filter):
    """True when no filter is configured, or the vendor is on the allow-list."""
    if not vendor_filter:
        return True
    if not vendor:
        return False
    allowed = {v.strip().lower() for v in vendor_filter}
    return vendor.strip().lower() in allowed


# ---------------------------------------------------------------------------
# Reference extractor functions (logic preserved)
# ---------------------------------------------------------------------------
def fetch_location_map(client):
    """Build a mapping of location_id -> location_name."""
    location_map = {}
    try:
        for loc in client.get_paginated("/locations.json", {}):
            loc_id = loc.get("id")
            loc_name = loc.get("name")
            if loc_id and loc_name:
                location_map[loc_id] = loc_name
    except Exception as e:
        logger.warning("Failed to fetch locations: %s", e)
    return location_map


def get_pos_location_name(location_id, source_name, location_map, store_id):
    """Determine the POS location name based on order source."""
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


def load_customer_orders_count_from_db(store_id, customer_ids):
    """Load orders_count per customer from our DB (raw_shopify_orders) -- fast path."""
    if not customer_ids:
        return {}
    try:
        placeholders = ",".join(["%s"] * len(customer_ids))
        query = f"""
            SELECT customer_id, COUNT(*) AS orders_count
            FROM raw_shopify_orders
            WHERE store_id = %s AND customer_id IN ({placeholders})
            GROUP BY customer_id
        """
        params = (store_id, *[str(c) for c in customer_ids])
        return {row["customer_id"]: row["orders_count"] for row in execute_query(query, params)}
    except Exception as e:
        logger.warning("[%s] Failed to load customer order counts from DB: %s", store_id, e)
        return {}


def prefetch_customer_orders_count(client, store_id, orders, customer_cache):
    """Populate customer_cache[customer_id] = orders_count, DB first then API."""
    customer_ids = set()
    for order in orders:
        customer = order.get("customer")
        if customer and customer.get("id"):
            customer_ids.add(customer["id"])
    if not customer_ids:
        return

    db_counts = load_customer_orders_count_from_db(store_id, customer_ids)
    # DB keys come back as TEXT; map onto the numeric ids used in the cache
    for order in orders:
        customer = order.get("customer")
        if customer and customer.get("id"):
            cid = customer["id"]
            if str(cid) in db_counts:
                customer_cache[cid] = db_counts[str(cid)]

    missing_ids = {cid for cid in customer_ids if cid not in customer_cache}
    if not missing_ids:
        return

    logger.info("[%s] Fetching %d customers from API (not in DB)", store_id, len(missing_ids))
    missing_list = list(missing_ids)
    batch_size = 250
    for i in range(0, len(missing_list), batch_size):
        batch = missing_list[i:i + batch_size]
        ids_param = ",".join(str(cid) for cid in batch)
        try:
            customers = client.get_paginated("/customers.json", {"ids": ids_param, "fields": "id,orders_count"})
            for cust in customers:
                customer_cache[cust["id"]] = cust.get("orders_count", 0)
        except Exception as e:
            logger.warning("[%s] Failed to batch fetch customers: %s", store_id, e)
            for cid in batch:
                customer_cache.setdefault(cid, 0)


def get_customer_type(customer, customer_cache):
    """Returning / New / Guest from the pre-fetched orders_count cache."""
    if not customer:
        return "Guest"
    customer_id = customer.get("id")
    if not customer_id:
        return "Guest"
    orders_count = customer_cache.get(customer_id, 0)
    return "Returning" if orders_count > 1 else "New"


def _eat_day_year(dt):
    """Return (YYYY-MM-DD in EAT, calendar year of the source instant)."""
    if not dt:
        return None, None
    eat = dt.astimezone(EAT)
    return eat.strftime("%Y-%m-%d"), eat.year


def fetch_sales(store_config, days_per_batch=90, limit=None, start_from=None):
    """Fetch sales (order line items) for one store and save to raw_shopify_sales."""
    client = ShopifyClient(store_config=store_config)
    store_id = client.store_id

    vendor_filter = store_config.get("vendor_filter")
    if vendor_filter:
        logger.info("[%s] Vendor filter active: %d allowed vendors", store_id, len(vendor_filter))

    location_map = fetch_location_map(client)
    logger.info("[%s] Loaded %d location mappings", store_id, len(location_map))

    checkpoint_date = start_from or get_checkpoint(store_id)
    start_date = datetime.strptime(checkpoint_date, "%Y-%m-%d")
    logger.info("[%s] Starting sales from %s", store_id, start_date.date())

    end_date = datetime.utcnow()
    cutoff_date = store_config.get("cutoff_date")
    if cutoff_date:
        end_date = min(end_date, datetime.strptime(cutoff_date, "%Y-%m-%d") + timedelta(days=1))

    total_sales = 0
    orders_processed = 0
    customer_cache = {}

    while start_date < end_date:
        batch_end = min(start_date + timedelta(days=days_per_batch), end_date)
        logger.info("[%s] Fetching sales from %s to %s", store_id, start_date.date(), batch_end.date())

        params = {
            "status": "any",
            "limit": 250,
            "created_at_min": start_date.isoformat() + "Z",
            "created_at_max": batch_end.strftime("%Y-%m-%dT23:59:59Z"),
            "fields": "id,name,created_at,customer,source_name,location_id,line_items,refunds",
        }
        orders = client.get_paginated("/orders.json", params)

        if not orders:
            logger.info("[%s] No orders for %s to %s", store_id, start_date.date(), batch_end.date())
        else:
            prefetch_customer_orders_count(client, store_id, orders, customer_cache)

            sales_rows = []
            for order in orders:
                orders_processed += 1

                created_at = order.get("created_at")
                try:
                    created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00")) if created_at else None
                except Exception:
                    created_dt = datetime.utcnow().replace(tzinfo=timezone.utc)

                order_id = order.get("id")
                order_name = order.get("name")
                customer = order.get("customer")
                customer_id = customer.get("id") if customer else None
                customer_type = get_customer_type(customer, customer_cache)

                day, year = _eat_day_year(created_dt)
                source_name = order.get("source_name")
                purchase_option = source_name or "one_time"
                location_id = order.get("location_id")
                pos_location_name = get_pos_location_name(location_id, source_name, location_map, store_id)

                # Refund details per line_item id
                refund_details_per_line = defaultdict(list)
                for refund in order.get("refunds", []) or []:
                    refund_created_at = refund.get("created_at")
                    try:
                        refund_dt = (
                            datetime.fromisoformat(refund_created_at.replace("Z", "+00:00"))
                            if refund_created_at else created_dt
                        )
                    except Exception:
                        refund_dt = created_dt
                    for rli in refund.get("refund_line_items", []) or []:
                        li = rli.get("line_item") or {}
                        line_item_id = li.get("id")
                        qty = rli.get("quantity", 0)
                        if line_item_id and qty > 0:
                            refund_details_per_line[line_item_id].append({
                                "quantity": int(qty),
                                "refund_date": refund_dt,
                                "restock_type": rli.get("restock_type"),
                            })

                for li in order.get("line_items", []) or []:
                    line_item_id = li.get("id")
                    variant_id = li.get("variant_id") or None
                    variant_sku = li.get("sku") or None
                    variant_title = li.get("variant_title") or li.get("title") or None
                    product_title = li.get("name") or li.get("title") or None
                    product_price = float(li.get("price") or 0)
                    product_type = li.get("product_type") or None
                    product_vendor = li.get("vendor") or None
                    quantity = int(li.get("quantity", 0))

                    if not should_include_vendor(product_vendor, vendor_filter):
                        continue

                    discounts = 0.0
                    for alloc in li.get("discount_allocations", []) or []:
                        try:
                            discounts += float(alloc.get("amount", 0))
                        except Exception:
                            pass

                    gross_sales = product_price * quantity

                    # ORDER row
                    sales_rows.append({
                        "store_id": store_id,
                        "day": day,
                        "order_id": order_id,
                        "order_name": order_name,
                        "line_item_id": str(line_item_id) if line_item_id else None,
                        "purchase_option": purchase_option,
                        "sale_kind": "order",
                        "sale_line_type": "product",
                        "pos_location_name": pos_location_name,
                        "product_price": round(product_price, 2),
                        "product_title": product_title,
                        "product_type": product_type,
                        "product_vendor": product_vendor,
                        "variant_id": variant_id,
                        "variant_sku": variant_sku,
                        "variant_title": variant_title,
                        "customer_type": customer_type,
                        "customer_id": customer_id,
                        "total_sales": round(gross_sales - discounts, 2),
                        "orders": 1,
                        "gross_sales": round(gross_sales, 2),
                        "discounts": round(discounts, 2),
                        "returns": 0,
                        "net_sales": round(gross_sales - discounts, 2),
                        "net_quantity": quantity,
                        "ordered_item_quantity": quantity,
                        "returned_item_quantity": 0,
                        "restock_type": None,
                        "year": year,
                    })

                    # RETURN rows (dated by refund date, attributed to original location)
                    for refund_info in refund_details_per_line.get(line_item_id, []):
                        if refund_info.get("restock_type") == "cancel":
                            continue  # removed before fulfillment -- exclude from sales
                        returned_qty = refund_info["quantity"]
                        refund_day, refund_year = _eat_day_year(refund_info["refund_date"])
                        return_amount = product_price * returned_qty
                        sales_rows.append({
                            "store_id": store_id,
                            "day": refund_day or day,
                            "order_id": order_id,
                            "order_name": order_name,
                            # distinct id so the return row does not collide with the
                            # order row under PK (line_item_id, store_id)
                            "line_item_id": f"{line_item_id}_ret" if line_item_id else None,
                            "purchase_option": purchase_option,
                            "sale_kind": "return",
                            "sale_line_type": "product",
                            "pos_location_name": pos_location_name,
                            "product_price": round(product_price, 2),
                            "product_title": product_title,
                            "product_type": product_type,
                            "product_vendor": product_vendor,
                            "variant_id": variant_id,
                            "variant_sku": variant_sku,
                            "variant_title": variant_title,
                            "customer_type": customer_type,
                            "customer_id": customer_id,
                            "total_sales": round(-return_amount, 2),
                            "orders": 0,
                            "gross_sales": 0,
                            "discounts": 0,
                            "returns": round(return_amount, 2),
                            "net_sales": round(-return_amount, 2),
                            "net_quantity": -returned_qty,
                            "ordered_item_quantity": 0,
                            "returned_item_quantity": returned_qty,
                            "restock_type": refund_info.get("restock_type"),
                            "year": refund_year or year,
                        })

            # Idempotent re-runs: atomically delete this batch's orders, then insert
            if sales_rows:
                save_rows(store_id, sales_rows)
                total_sales += len(sales_rows)
                logger.info("[%s] Inserted %d sales records", store_id, len(sales_rows))

            logger.info(
                "[%s] Sales batch complete: %s to %s (Total: %d)",
                store_id, start_date.date(), batch_end.date(), total_sales,
            )

        save_checkpoint(store_id, batch_end.strftime("%Y-%m-%d"))
        start_date = batch_end

        if limit and orders_processed >= limit:
            logger.info("[%s] Reached limit of %d orders processed", store_id, limit)
            break

    logger.info("[%s] Sales extraction complete. Total sales: %d", store_id, total_sales)
    return total_sales


def main():
    stores = build_stores()
    if not stores:
        raise SystemExit("No Shopify stores configured (set SHOPIFY_*_STORE / SHOPIFY_*_TOKEN).")

    for store in stores:
        fetch_sales(store)

    print("\n=== raw_shopify_sales summary ===")
    for row in execute_query("""
        SELECT store_id, COUNT(*) AS rows, MIN(day) AS first, MAX(day) AS last
        FROM raw_shopify_sales
        GROUP BY store_id ORDER BY store_id
    """):
        print(f"  {row['store_id']}: {row['rows']} rows ({row['first']} to {row['last']})")


if __name__ == "__main__":
    main()
