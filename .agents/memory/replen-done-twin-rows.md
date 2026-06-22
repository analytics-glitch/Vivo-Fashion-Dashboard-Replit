---
name: Replenishment done = twin sku+barcode rows
description: Marking a replenishment done writes TWO recommendation_actions rows for one physical item; any rollup must dedup to a canonical SKU.
---

Marking a replenishment "done" (POST `/api/analytics/replenishment-report/mark`)
stores the action under BOTH a `kind='sku'` and a `kind='barcode'` `rec_key`
(`{pos_location}|{kind}|{value}`) whenever the caller passes both — so ONE
physical mark produces TWO `recommendation_actions` rows (rec_type='replenish',
status='done'), each carrying the same `actual_units` / `transfer_ref` /
`acted_by` / `acted_at`.

**Why:** the live report rows are identified by `sku` on Replenishments.jsx but
by `barcode` on the ReplenishmentReport view, so the mark is stored under both
so either GET row flips to done.

**How to apply:** any aggregation/rollup over done replenishment rows (e.g. the
Transfer Tracking report) MUST dedup to one canonical item or it double-counts
units. Resolve each row to a canonical SKU (kind='sku' → its value;
kind='barcode' → join `all_products_clean` on barcode → its sku) and collapse on
that. `recommendation_actions` and `all_products_clean` are the SAME Postgres DB,
so the dedup/enrichment join can be done in one SQL query.

Day bucketing for these rows is by Africa/Nairobi (EAT) calendar day
(`(acted_at AT TIME ZONE 'Africa/Nairobi')::date`) — the report GET and the
transfer-number assign POST must use the EXACT same expression so the assigned
group matches the displayed group.
