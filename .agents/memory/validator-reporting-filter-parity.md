---
name: Validator must measure under reporting filters & show SKUs to the LLM
description: learned_range false-positive flood root causes — unfiltered metrics and SKU-less sample rows misread as duplicates.
---

**Rule 1:** validation_agent metrics must apply the SAME reporting scope as the dashboard (`config.REPORTING_FILTERS`, a deliberate mirrored copy of api_pg `BASE_FILTERS` — `%%`-escaped, kept in lockstep by comment; NEVER import api_pg into validation_agent). Measuring raw all_sales flags days the dashboard never shows (e.g. a 69-unit gift-card line made "units 110" that reporting shows as 38).

**Rule 2:** the LLM diagnoser's sample rows must include `variant_sku` and be filtered the same way. Without the SKU column, a normal multi-line order (line-item grain, same order_id, qty=1 per line, NULL product_type) looks like "indistinguishable duplicate rows" and the LLM confidently proposes a DELETE. With variant_sku visible + grain facts in the SYSTEM prompt, the same day classifies REAL_BUSINESS_EVENT.

**Why:** a 38-finding flood (36 learned_range + 2 cross-surface) was 100% validator defects — raw-data checks confirmed no duplicates (distinct variant_sku per line, `GROUP BY order_id,sku,amount HAVING >1` returned zero).

**How to apply:** before trusting a validator "duplicate ETL batch" diagnosis, run the (order_id, variant_sku, amount) fingerprint dup check on the raw rows. If BASE_FILTERS changes in api_pg, update validation_agent/config.py REPORTING_FILTERS in the same commit.
