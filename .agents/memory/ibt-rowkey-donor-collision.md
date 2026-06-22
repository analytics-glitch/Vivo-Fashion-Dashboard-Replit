---
name: IBT flat-table rowKey donor collision
description: Why the IBT store→store table showed all "—"/0 stub rows, and the rule that any per-suggestion render key must include the donor store.
---

# IBT flat-table rowKey must include the donor (from_store)

The Store→Store IBT page (`IBTFlatTable.jsx`) renders one row per (style, donor, destination, SKU). For each style-level suggestion it lazily fetches `/api/analytics/ibt-sku-breakdown` (N+1, ~300 calls, concurrency 6) and shows a loading **stub** row (Color/Size/SKU/Barcode = "—", Inv FROM/TO = 0) until that suggestion's breakdown resolves.

**Symptom seen:** every row stuck as a stub (dashes + 0). The backend was NOT at fault — the breakdown endpoint returned 200 with valid color/size/sku/from_available/to_available (verified against the DB for warehouse→store AND store→store pairs), and the `skuByKey` **cacheKey** already included the donor + units, so the fetched data was correct.

**Root cause:** the React `rowKey` (both stub and real-SKU) was `style||to_store||sku`, **omitting the donor (from_store)**. The suggestions endpoint emits one row per donor→needer pair, so the SAME (style, to_store, sku) recurs for many donors (logs showed one style→destination from 7 donors). Identical React keys → React keeps the first-mounted element (the loading stub) and never swaps in the resolved SKU rows. Console floods with "Encountered two children with the same key".

**Fix / rule:** any per-suggestion render key in this table must be `style||from_store||to_store||sku` (and `…||__stub`). Suggestions are unique per (style, from_store, to_store), so adding the donor makes keys fully unique. This also isolates the inline "Actual transferred" `actuals[rowKey]` state per donor row.

**Leave alone:** the `completedSkuKeys` hide-filter intentionally uses `style||to_store||sku` (no donor) — completing a SKU for a destination hides it across all donors. Don't add the donor there.

**Why:** a style-level list that fans out per donor will always produce duplicate (style,dest,sku) tuples; the donor is the disambiguator and must be in the render key, not just the data cacheKey.
