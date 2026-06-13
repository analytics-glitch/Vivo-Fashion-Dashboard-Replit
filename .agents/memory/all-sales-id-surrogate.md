---
name: all_sales id is a per-row surrogate, not line_item_id
description: Why all_sales.id must be unique per row (sale+return kept separate) and how the rebuild transform must mirror BigQuery's row set under the (id, store_id) PK.
---

`all_sales` PRIMARY KEY is `(id, store_id)`. In the canonical BigQuery view, `id` (`s.id`) is a column **distinct** from `line_item_id`. BigQuery keeps a line item's **sale and its later return as separate rows** (its dedup grain is `line_item_id + order_id + day + store_id + product_title`).

**Rule:** the rebuild transform (`transform_all_sales.py` `transform_shopify`) must give each output row a **unique surrogate `id`** — never reuse `line_item_id` as `id`.

**Why:** our Postgres `shopify_sales` source has no `s.id`/`_loaded_at` columns, so the original code set `id = line_item_id`. A sale and its return share `line_item_id`+`store_id` (differ only by `day`/`sale_kind`), so they collide on the PK `(id, store_id)` → `CardinalityViolation`. A "fix" that adds an outer `PARTITION BY (line_item_id, store_id)` dedup masks the crash by **dropping ~27k sale/return rows BigQuery keeps**, corrupting reconciliation.

**How to apply:**
- Keep only the inner BQ-grain dedup: `ROW_NUMBER() OVER (PARTITION BY line_item_id, order_id, day, store_id, product_title ORDER BY ctid)`, `WHERE rn = 1`. After this there is exactly one row per grain.
- Set `id = md5(f"{line_item_id}|{order_id}|{day}|{product_title}")` in Python. Because the inner dedup guarantees one row per that grain (store_id is the other PK column), the surrogate is collision-free per `(id, store_id)` — same-day sale+return collapse in BOTH BQ and the inner dedup, so no PK clash is possible.
- This matches the **live incremental sync** (`sync_incremental.py`), which uses `str(uuid.uuid4())` as `id` per row and keeps sale+return separate. So nothing downstream may assume `id == line_item_id`.
- Orders join: `LEFT JOIN (SELECT DISTINCT ON (id::text, store_id) ... ORDER BY id::text, store_id, _loaded_at DESC FROM raw_shopify_orders)` — `raw_shopify_orders` HAS `_loaded_at`, so freshest-customer_id wins deterministically.

**Validate after a TRUNCATE+rebuild:** `COUNT(*) == COUNT(DISTINCT (id, store_id))` (no collisions). A residual reconciliation units gap equal to `SUM(returned_item_quantity)` is the pre-existing `/api/kpis` `net_quantity` vs country-summary `ordered_item_quantity` definitional mismatch, NOT a transform bug.
