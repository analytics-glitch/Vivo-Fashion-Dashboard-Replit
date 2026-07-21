---
name: Retail Desk router
description: Per-store AI coaching + issue register; v2 = 4-bucket composite status, deterministic scanner, exception queues, actions queue.
---

## Status model (v2)

`_composite_status(gap_pct, mom_pct, run_rate_gap_pct, weeks_behind)` → **act_now / watch / on_track / outperforming**

Hard escalation rules (take priority over all others):
- ≥4 consecutive weeks behind → act_now
- gap_pct ≤ -25% → act_now
- gap_pct ≤ -15% AND mom ≤ -10% → act_now

Override rule (ahead-on-path but declining):
- gap ≥ 0 AND mom ≤ -15% → watch (not on_track)
- gap ≥ 0 AND run_rate_gap ≤ -15% → watch

Outperforming requires gap ≥ 15% AND mom ≥ 5% (both must be true).

**Why:** the old 3-bucket (ahead/at_risk/behind) left 29/30 stores in "Ahead" — zero discriminating power.

## Issue scanner

`_deterministic_scan_all(stores_data, path_data, bench)` — 9 rules, throttled 600s.

Runs **batch queries** (not per-store loops):
- `_get_batch_extended_metrics()` — basket, UPT, discount depth, returns (600s cache)
- `_get_batch_dead_stock()` — pre-aggregates inventory by SKU first (triad-joins rule)
- `_get_batch_unknown_category()` — unknown product_type fraction (600s cache)

Rule keys: `consecutive_weeks_behind`, `mom_critical`, `mom_declining`, `basket_low`, `upt_low`, `discount_heavy`, `dead_stock_critical`, `dead_stock_elevated`, `run_rate_declining`, `unknown_category`

Auto-resolve: when triggering metric normalises, sets `status='closed'`, `auto_resolved=TRUE`.

**Why:** individual per-store queries (old `_auto_flag_issues`) would fan-out 30× on every overview load.

## DDL additions (v2, idempotent)

`retail_desk_issues` new columns: `rule_key TEXT`, `kes_impact FLOAT`, `owner_role TEXT`, `auto_resolved BOOLEAN DEFAULT FALSE`

New table `retail_desk_actions`: store, action_text, owner, due_date, status (open/in_progress/done/deferred), expected_kes, source, issue_id, outcome.

## New endpoints

- `PATCH /api/retail-desk/issues/{id}/status` — acknowledge / in_progress / closed
- `GET /api/retail-desk/actions` — active actions (overdue first); scope=active|overdue|all
- `POST /api/retail-desk/actions` — save action from AI analysis or manual
- `PATCH /api/retail-desk/actions/{id}` — update status/outcome

## Overview response shape

```json
{
  "stores": [...],
  "exception_queues": { "act_now": [], "watch": [], "wins": [] },
  "fleet_summary": { "act_now": N, "watch": N, "on_track": N, "outperforming": N,
                     "open_issues_kes": N, ... },
  "fleet_coaching": {...},
  "benchmarks": { "avg_basket": N, "avg_disc_depth_pct": N, "avg_upt": N }
}
```

Each store card now includes: `status` (composite), `path_status` (old path), `mom_pct`, `run_rate_gap_pct`, `weeks_behind`, `open_issues_kes`, `top_issue`.

## Auth gate

`/api/retail-desk/*` — leadership + admin via `clerk_auth_gate`. Actions endpoints follow same gate.

## Location exclusion

`_is_holding_location(name)` checks `_HOLDING_KEYWORDS` tuple; applied in `_store_t12m_query` result filter and batch metric queries.
