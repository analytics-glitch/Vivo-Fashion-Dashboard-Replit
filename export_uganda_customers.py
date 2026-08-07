"""
One-off export: pull the FULL Uganda (Safari by Vivo) Shopify customer database
— all fields — live from the Shopify Admin API and write CSV + Excel.

Reuses the auth + cursor-pagination pattern from extract_shopify_customers.py.
Unlike the incremental sync, this:
  * pulls ALL customers (no updated_at_min filter)
  * requests the FULL customer object (no `fields` whitelist)
  * flattens nested objects (default_address, marketing consent) into columns

Run in the Replit/VS Code shell:  python3 export_uganda_customers.py
Env needed: SHOPIFY_UGANDA_STORE, SHOPIFY_UGANDA_TOKEN
"""
import os, sys, time, json, csv
from datetime import datetime

import requests

STORE_URL = os.environ["SHOPIFY_UGANDA_STORE"]      # safaribyvivo.myshopify.com
TOKEN     = os.environ["SHOPIFY_UGANDA_TOKEN"]
API_VER   = os.environ.get("SHOPIFY_API_VERSION", "2025-10")
BATCH     = 250
OUT_DIR   = os.environ.get("OUT_DIR", ".")

HEADERS = {"X-Shopify-Access-Token": TOKEN}


def fetch_all_customers():
    url = f"https://{STORE_URL}/admin/api/{API_VER}/customers.json"
    params = {"limit": BATCH}   # no fields filter => full object; no date filter => all
    out = []
    page = 0
    while url:
        for attempt in range(5):
            resp = requests.get(url, headers=HEADERS, params=params, timeout=60)
            if resp.status_code == 429:
                wait = int(float(resp.headers.get("Retry-After", 10)))
                print(f"  rate limited, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            break
        batch = resp.json().get("customers", [])
        out.extend(batch)
        page += 1
        print(f"  page {page}: +{len(batch)} (total {len(out)})")
        # cursor pagination via Link header
        link = resp.headers.get("Link", "")
        nxt = None
        for part in link.split(","):
            if 'rel="next"' in part:
                nxt = part.split(";")[0].strip().strip("<>")
        url = nxt
        params = {}   # the next URL already carries the page_info cursor
        time.sleep(0.3)  # be gentle on the 2 req/s limit
    return out


def flatten(c):
    """Flatten a Shopify customer object into a flat dict of scalar columns."""
    addr = c.get("default_address") or {}
    sms = c.get("sms_marketing_consent") or {}
    email_consent = c.get("email_marketing_consent") or {}
    row = {
        "id": c.get("id"),
        "email": c.get("email"),
        "first_name": c.get("first_name"),
        "last_name": c.get("last_name"),
        "phone": c.get("phone"),
        "state": c.get("state"),
        "verified_email": c.get("verified_email"),
        "tax_exempt": c.get("tax_exempt"),
        "tags": c.get("tags"),
        "currency": c.get("currency"),
        "orders_count": c.get("orders_count"),
        "total_spent": c.get("total_spent"),
        "note": c.get("note"),
        "created_at": c.get("created_at"),
        "updated_at": c.get("updated_at"),
        "accepts_email_marketing": (email_consent.get("state") if email_consent else c.get("accepts_marketing")),
        "email_marketing_opt_in_level": email_consent.get("opt_in_level") if email_consent else None,
        "accepts_sms_marketing": sms.get("state") if sms else None,
        "sms_consent_collected_from": sms.get("consent_collected_from") if sms else None,
        # default address (flattened)
        "addr_company": addr.get("company"),
        "addr_address1": addr.get("address1"),
        "addr_address2": addr.get("address2"),
        "addr_city": addr.get("city"),
        "addr_province": addr.get("province"),
        "addr_province_code": addr.get("province_code"),
        "addr_zip": addr.get("zip"),
        "addr_country": addr.get("country"),
        "addr_country_code": addr.get("country_code"),
        "addr_phone": addr.get("phone"),
        "addresses_count": len(c.get("addresses") or []),
    }
    return row


def main():
    print(f"Pulling ALL customers from Uganda store: {STORE_URL}")
    customers = fetch_all_customers()
    print(f"TOTAL customers fetched: {len(customers)}")
    if not customers:
        print("No customers returned.")
        return

    rows = [flatten(c) for c in customers]
    cols = list(rows[0].keys())
    # union of keys in case some rows have extra
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)

    ts = datetime.now().strftime("%d%b%Y")
    csv_path = os.path.join(OUT_DIR, f"Uganda_Shopify_Customers_{ts}.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {csv_path}  ({len(rows)} rows, {len(cols)} cols)")

    # also raw JSON (full fidelity, nothing dropped)
    json_path = os.path.join(OUT_DIR, f"Uganda_Shopify_Customers_{ts}_raw.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(customers, f, indent=2, default=str)
    print(f"Wrote {json_path}  (full raw objects)")


if __name__ == "__main__":
    main()
