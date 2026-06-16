---
name: Product Analysis endpoint performance
description: Why /api/analytics/product-analysis is fast now and the constraints that keep it fast
---

# /api/analytics/product-analysis performance

The endpoint aggregates lifetime + period metrics over `all_sales` (~1.6M rows)
joined to `all_products_clean`. It was 82–94s cold because it scanned `all_sales`
**twice**: once for the `sales` lifetime aggregate, and again in a separate
`latest_price` CTE doing `DISTINCT ON (style_name) ... ORDER BY sale_date DESC`,
which forced an ~84MB external-merge **disk sort** of the whole join.

**Decisions (keep these):**
- `current_price` is computed **inside the `sales` CTE** as an argmax in the same
  scan: `(array_agg(product_price_kes ORDER BY sale_date DESC) FILTER (...))[1]`.
  Do NOT reintroduce a second `all_sales` scan/CTE just for the latest price.
- The full computed response is cached via `cache_get/cache_set` (ttl=600s) keyed
  on ALL filter params. `run_query`'s own SQL cache is only ~120s; the 600s
  response cache is what keeps the page warm. The response is identical for every
  user (no PII / user scoping), so sharing it across users is safe.

**Why:** removing the redundant scan + disk sort and caching the payload took
cold load ~82–94s → ~38s and warm loads → ~0.15s.

**Known behavior change / how to apply:** with `dims` (color/print/size) selected,
the `sales` CTE is dim-grain, so `current_price` is now **per-dim**, not the old
style-grain (`DISTINCT ON style_name`) value. For the default no-dims view it is
identical. This is intentional and consistent with exploded-row semantics. If a
style-level invariant price is ever required in exploded views, add a separate
style-grain CTE and join it as a distinct field — do NOT revert to the global sort.

**Staleness:** the 600s cache means manual-retirement overrides and very recent
sales can lag up to 10 min on this page. Acceptable for range analysis.
