---
name: Shop Zetu (Online) ShopifyQL netting
description: How Shop Zetu Online sales are extracted/netted so dashboard total_sales reconciles; pitfalls of ShopifyQL pagination and rebuild concurrency.
---

# Shop Zetu (Online) sales must be netted via signed ShopifyQL total_sales

The dashboard's Online figure was overstated (~40M vs correct ~26M for a period)
because the old REST extractor never netted returns/discounts. The correct source
is **ShopifyQL** (`SHOW total_sales, gross_sales, discounts, total_returns,
net_sales, net_items_sold, quantity_ordered, quantity_returned WHERE
product_vendor IN (VENDORS) GROUP BY ... WITH TOTALS`).

**Rule:** carry the SIGNED ShopifyQL `total_sales` all the way to
`all_sales.total_sales_kes` (return rows are negative). Then
`SUM(total_sales_kes)` nets discounts + returns and reconciles to Shopify's own
WITH-TOTALS figure. Return rows are identified by `order_or_return == 'return'`
(stored as `is_reversal_row`); for those rows zero out gross/discounts and put
`abs(total_returns)` into `returns_kes`, exactly as `transform_all_sales.transform_shopzetu` does.

**Why:** the only way the dashboard equals the merchant's confirmed numbers is to
net at the row level; summing gross or order-only totals double-counts revenue
that was later returned.

## Two paths must stay identical
- Full rebuild: `extract_shopzetu_sales.py` → `raw_shopify_vendor_sales` →
  `transform_all_sales.transform_shopzetu` → `all_sales`.
- Live incremental: `extract_shopzetu_shopifyql.py` (called by `sync_incremental.py`)
  writes recent days straight to `all_sales`. It **imports `fetch_range` + `aggregate`
  from `extract_shopzetu_sales.py`** and maps with the same signed-total logic, so
  recent days don't drift back up after a rebuild. If you change the extraction
  columns/vendor list/grain, both paths update together because they share code.

## ShopifyQL pitfalls
- **OFFSET pagination is broken**: tied sort values cause overlaps/gaps. Use
  **date-window pagination** instead, and auto-split a window when the row-sum
  doesn't equal the WITH-TOTALS row or rows hit the LIMIT (50000). Single-day
  windows can't split further (only a theoretical risk at this data scale —
  Shop Zetu is hundreds of rows/day).
- `LIMIT` is NOT capped at 1000 (5000+ works). `WHERE` has **no LIKE**.
- raw `raw_shopify_vendor_sales` PK is **4-col**: `(order_id, day,
  product_variant_sku, is_reversal_row)` — needed so a sale and its return on the
  same order/sku/day coexist. Keep `create_raw_tables.py` DDL and the extractor's
  `ON CONFLICT` target in lockstep, or fresh DBs break.

## Rebuilding all_sales safely
`transform_all_sales.py` TRUNCATEs then re-inserts. The **Sync Watchdog** runs
`sync_incremental.py` every minute and writes recent-day rows. Two hazards:
1. Two concurrent `transform_all_sales.py` runs interleave and **double full
   history** (non-colliding ids, so no PK protection). Run exactly one.
2. The watchdog injecting mid-rebuild duplicates recent days (self-heals next
   cycle via its DELETE-by-range, but cleaner to avoid).
**Before a manual rebuild, pause the Sync Watchdog** (reconfigure its workflow to
an idle command), run one rebuild to completion, verify per-store counts against
known-good targets, then restore the watchdog command
(`WATCHDOG_MANAGE_API=0 python3 .../watchdog.py`).

## A rebuild resets loaded_at — never anchor an incremental "since" to it
`transform_all_sales.py` stamps every reloaded row with `loaded_at = now()`. Any
incremental sync that computes its `since` watermark from `MAX(loaded_at)` will,
right after a rebuild, jump `since` forward to ~today even though the rebuild's
raw source may only cover up to a few days ago — permanently **skipping the gap
days**. This bit the Odoo/Kenya (`store_id='vivofashiongroup'`) sync: the raw
Odoo table lagged to 06-08, the rebuild reset loaded_at to today, so the next
sync's `since` became 06-12 and it never pulled the 06-09..06-11 orders (the
dashboard showed no recent Kenya). **Anchor `since` to actual data coverage:**
`LEAST(MAX(loaded_at::date), MAX(sale_date::date)) - 1 day` never runs ahead of
the data we hold, so the sync self-heals after any rebuild. (Online/Uganda/Rwanda
were fine because their Shopify syncs were already current.)
