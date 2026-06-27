---
name: Aged-stock "not sold in N days" = recent-window semi-join
description: Perf pattern for store-level aged/dead-stock checks over all_sales — avoid full-history MAX(sale_date).
---

Rule: to find inventory that has NOT sold at its own store within N days, do NOT
compute `MAX(sale_date)` per `(pos_location_name, variant_sku)` over ALL of
`all_sales` and then filter `last_sold < cutoff OR last_sold IS NULL`. Instead use
a recent-window **semi-join**: build `recent_store = SELECT DISTINCT pos, sku FROM
all_sales WHERE sale_kind IN ('sale','order') AND sale_date::date >= CURRENT_DATE -
N days`, then `LEFT JOIN ... WHERE recent_store.pos IS NULL`.

**Why:** the two predicates are logically identical ("most-recent sale older than N
OR never sold" ⟺ "no sale at that (pos,sku) within N days"), but the MAX version
scans all_sales, groups into a huge per-(pos,sku) set, and **spills ~190MB to temp**
(sort), then discards all but the aged inventory. On `/api/analytics/buy-candidates`
this was the second of two full all_sales scans; replacing it dropped cold latency
~11.6s→2.9s and warm ~5.0s→3.0s, eliminating the temp spill, with byte-identical
results (verified via aggregate checksums over all output rows). `all_sales.sale_date`
is TEXT, so cast `::date`; there is no index on it, so the recent scan is still a seq
scan, but the win comes from killing the giant group-by + spill.

**How to apply:** any "aged / dead / not-sold-in-N-days" store-level query over
all_sales. Other candidates with the same shape: the Warehouse Returns aged mode and
any future dead-stock report. The remaining full lifetime scan (lifetime units/sales
for SOR/confidence) is irreducible without an index — and per the
dev-only-DB-objects-block-publish rule, don't hand-add an index in dev.
