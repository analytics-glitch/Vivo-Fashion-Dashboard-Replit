---
name: Odoo sync pagination gap
description: Wide catch-up windows in sync_odoo silently truncated at 5000 newest orders, forming permanent mid-history holes; fix = oldest-first pagination + bounded repair overrides.
---

# Odoo sync pagination gap

**Rule:** any Odoo `search_read` over a catch-up window that can exceed the batch limit must paginate **oldest-first** (`order: "write_date asc, id asc"`, offset loop) — never rely on a single limited call.

**Why:** `pos.order`'s default sort is `date_order DESC`. After a full dev rebuild, `sync_odoo`'s `since` anchor pointed ~3 weeks back; a single `limit: 5000` call returned only the 5,000 *newest* orders, silently dropping the oldest days (Kenya 2026-06-14..18, ~2,800 units). The next cycle's `LEAST(loaded_at, sale_date)` anchor then advanced past the hole — that anchor protects the *tail*, not interior gaps — so the hole was permanent until manually repaired.

**2nd incident (products):** `extract_odoo_products` offset-paged `product.product` sorted by `write_date asc`. A concurrent product edit in Odoo shifts rows between pages → products silently skipped (~350 missing in prod, ~72 in dev) → blank barcodes in Store Gaps. Fix = **keyset pagination**: `["id", ">", last_id]` + `order: "id asc"` + advance `last_id = records[-1]["id"]`. Prefer keyset-on-id over ANY offset loop when the table can change mid-extract; verify with Odoo `search_count` == raw row count.

**How to apply:**
- `sync_odoo` now paginates with a hard safety cap; keep it that way for any similar extract.
- One-off gap repairs: set `ODOO_SYNC_SINCE` and **`ODOO_SYNC_UNTIL`** (bounds `write_date` so the repair can't collide with the live sync's recent window) and call `sync_odoo` once — the DELETE-by-order_id + insert path is idempotent.
- A full rebuild in dev must ALSO run `extract_odoo_orders` first (the "Rebuild all_sales" workflow alone does NOT refresh the Odoo raw tables); otherwise the transform writes Kenya only through the stale raw coverage and the sync gap-trap above triggers.
- Diagnostic tell: dev vs prod daily units where dev has near-zero for a contiguous block of days but matches before/after = anchor-skipped gap, not a data-quality issue.
