---
name: Uganda sales double-counted (two ingestion feeds)
description: Why Uganda figures read ~2x everywhere — Uganda Shopify sales land in all_sales via BOTH transform paths; Kenya/Rwanda do not.
---

Uganda is the ONLY market whose retail sales enter `all_sales` through **two**
transform paths at once, so its country totals (Targets, Overview, Locations,
everywhere that sums by country) read roughly **double** the true figure.

The two copies of every Uganda line carry the SAME order_id / sku / qty / amount:
- **physical copy** — from `transform_shopify` (source `shopify_sales`, written by
  `shopify_full_extract.py`): `channel`=store name (e.g. "Vivo Acacia",
  "The Oasis Mall"), real `line_item_id`, md5-hash `id`.
- **online copy (the duplicate)** — from `transform_shopzetu` (source
  `raw_shopify_vendor_sales`, the ShopifyQL vendor feed, which includes a
  **vivo-uganda** online vendor alongside shop-zetu): `channel`='Online'
  (country still 'Uganda'), `line_item_id` NULL, UUID `id`.

**Tells / how to confirm:** per-year Uganda "online" half ≈ "physical" half almost
exactly (e.g. 2026: 37.9M vs 35.6M; 2025: 43.3M vs 43.6M). Order-level: ~95% of
Uganda orders appear under BOTH `channel='Online'` and a physical channel. Kenya
has 0 of the UUID/`channel='Online'` rows (single feed); Rwanda has ONLY the
UUID/vendor feed (single feed) — so neither is doubled, **only Uganda**.

**Why it matters / fix shape:** the dedupe must drop only the Uganda overlap, NOT
the whole vendor feed — Rwanda + Kenya-Online legitimately depend on
`raw_shopify_vendor_sales`. The physical (`transform_shopify`, real line_item_id)
copy is the likely authoritative one for Uganda's physical stores; confirm which
feed is canonical with the data owner before deleting. Prod is a SEPARATE DB, so a
dev rebuild won't correct prod history — needs the `REBUILD_ON_BOOT` watchdog gate.
