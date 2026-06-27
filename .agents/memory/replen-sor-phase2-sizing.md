---
name: Replenishment SOR Phase 2 demand sizing
description: How the replenishment pick list sizes quantities (censored-corrected velocity x cover, A/B/C floors, Online no-floor) and how the picker scorecard is attributed.
---

# Replenishment SOR Phase 2 — demand sizing

The pick-list **quantity** is `velocity x cover`, NOT the SOR value. The canonical
SOR formula (`units_sold / (units_sold + soh)`) is untouched and still drives
ranking/deploy-now — never change it when touching sizing.

## Velocity
- Velocity uses the shared `_ewma_weekly(u28, u56)` (recency-weighted), on
  `net_quantity` (net is velocity-only basis). The `sold` CTE must emit `u28`/`u56`
  over a fixed >=56d window AND propagate them into the OUTER select — forgetting the
  outer select silently yields velocity 0 even though units sold in-window.
- **Censored correction:** store-SKUs with `soh==0` (stocked out) are lifted to
  `max(own_vpw, peer_vpw)` where peer_vpw = mean `_ewma_weekly` of the *in-stock*
  stores carrying that SKU. Pareto-safe: only raises proven local sellers that
  stocked out, never invents demand. Flagged `censored_corrected`; `velocity_observed`
  keeps the raw figure for transparency.

## Sizing by class
- A/B/C class from velocity cut-offs (`class_a_vpw`/`class_b_vpw`); floors
  `floor_a/b/c`. Stores: target = floor if C else `max(floor, ceil(v*cover))`.
- **Online (Shop Zetu, `ONLINE_SHOP_ZETU`)**: floor=0, short `online_cover_weeks`,
  target = cover_q with **NO presentation floor** (don't push the online tail).
- never-sold SKUs are excluded by construction (universe = `sold` proven demand);
  their first sale is seeded via Allocations, not Replenishment (UI note says so).

## Knobs
All sizing knobs live in app_config key `replen_sizing`, merged over module
defaults via `_replen_sizing_config()`; `_set_replen_sizing_config()` validates
(non-negative, class_a >= class_b). GET/PUT `/api/analytics/replenishment-sizing-config`
(PUT admin-only). Engine response includes the active `config`.

## Picker scorecard
`/api/analytics/replenishment-picker-scorecard` is built ONLY on the immutable
Phase-1 facts (`fact_pick_event` real user_id x latest `fact_replen_suggestion`
daily snapshot), NOT the completed-audit trail. Attribution: a picker's scope =
the stores they actually worked; their assigned set = that snapshot for those
stores. Fulfilment % is **line-based** (done/assigned) so it is effort-normalised.
**Gated `published:false`** until both a snapshot and attributable pick events
exist in the window — never show fabricated numbers. In dev there are no pick
events so it always reads "accruing"; real data accrues in prod.
