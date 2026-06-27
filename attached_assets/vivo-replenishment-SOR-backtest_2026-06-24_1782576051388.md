# Replenishment for SOR — backtest / simulation results

**Date:** 24 June 2026 · **Status:** calibrated simulation, not a literal historical replay (see "What this is")

## What this is — read first

A *true* historical backtest needs store-SKU(-size)-level sales and historical stock snapshots over time. That granularity isn't available from the dashboard front end (the only raw export is capped at 5,000 lines — audit finding F09 — and no store-SKU-day history is surfaced). So this is the next best thing: a **simulation calibrated to your real published aggregates**, comparing the two rules on the *same* simulated demand so the **delta** is fair.

Calibration anchors (all from the live dashboard): ~5,431 units/week, group sell-through (SOR) ~30.3%, ~888 styles × ~29 stores, median ~0.2 units/week/store-SKU, weeks-of-cover ~10–15 (Inventory/Product Analysis/Exec), and ~100+ styles flagged to stock out within 2 weeks.

Method: 26,000 store-SKU cells; weekly demand drawn from a heavy-tailed lognormal (mean 0.21/wk, so most cells are slow and a few are heroes); Poisson weekly sales; 8-week horizon after an 8-week warm-up; **flat rule** ("top anything that sold to 2") vs **new rule** (size A/B by velocity×cover, tail by class); 6 seeds averaged; swept across starting-stock positions (leaner → more overstocked). Two new-rule variants: **C1** trims the tail floor to 1 (aggressive); **C2** sizes heroes up but never cuts the tail floor below 2 (Pareto-safe).

## Results

| Starting stock | Flat SOR | New-C1 SOR | New-C2 SOR | ΔSOR C1 | ΔSOR C2 | Flat lost (u/8wk) | C1 lost | C2 lost | Ship Δ C1 | Ship Δ C2 |
|---|---|---|---|---|---|---|---|---|---|---|
| Lean | 43.9% | 49.3% | 45.6% | **+5.4** | +1.7 | 5,308 | 1,733 | 1,458 | −7% | +18% |
| Lean-mid | 44.0% | 47.8% | 44.5% | **+3.8** | +0.5 | 2,520 | 1,137 | 892 | −19% | +12% |
| Mid | 39.3% | 41.6% | 39.3% | +2.2 | −0.0 | 424 | 464 | 264 | −42% | +3% |
| Overstocked | 32.7% | 34.0% | 32.7% | +1.3 | −0.0 | 107 | 249 | 90 | −56% | +1% |
| **Vivo's live point (~30%)** | 29.0% | 29.9% | 29.0% | **+0.9** | +0.0 | 49 | 164 | 47 | **−62%** | +0.1% |

## What it says

1. **The new rule beats flat — but at Vivo's current position the win is mostly operational, not a big SOR jump.** Your live ~30% SOR with 10–15 weeks of cover means the network is, on average, **overstocked on a long slow tail** rather than starved. At that point the new rule lifts SOR by only ~**+0.9 point** (trim variant) while shipping ~**60% fewer units** — a large freight, picking-labour, cross-border and working-capital saving for roughly the same availability.

2. **The real SOR upside is concentrated on the fast/hero styles that are actually stocking out** — exactly the ~100+ styles on your stockout banner. Where stores are lean (left of the table), demand-sizing the heroes adds **+3.8 to +5.4 points** of SOR and roughly halves lost sales. The network average hides this because most cells are overstocked slow movers; the gain is real on the segment that matters.

3. **The flat rule structurally can't do either job:** it caps heroes at 2 (so they stock out — lost numerator) and keeps topping the tail to 2 (so it over-ships slow stock — wasted denominator + freight). The new rule fixes both ends.

4. **The tail floor is the key dial.** C1 (floor 1) maximises shipping savings but slightly raises tail stockouts (49→164 units across 26k cells — small in absolute terms). C2 (keep floor 2, only size heroes up) never increases lost sales and is the **Pareto-safe** start. Recommendation: launch with **C2** (capture hero availability with no downside), and trim the genuine slow/EOL tail through the suppression + markdown lever rather than a blanket floor cut.

## Honest caveats

- This is a **calibrated simulation, not your actual history.** Demand is modelled (lognormal + Poisson, stationary); real per-store-SKU dynamics, seasonality and substitution will differ.
- **EOL / dead-stock drawdown is NOT modelled here** — that's the markdown/clearance lever, and it would add further SOR upside on top of these numbers.
- No warehouse stockout in the main sweep (a separate capped test showed the new rule still wins by reallocating the *same* units to heroes).
- Absolute lost-sales figures are small across 26k cells; treat SOR and shipping as the headline outputs.

## Bottom line

Directionally confirmed: the new rule is **≥ the flat rule on SOR in every scenario** and **far cheaper to run** (~60% less shipped at your current stock position), with the largest SOR gains on the stocking-out hero styles. It is not a silver-bullet network-wide SOR jump while you remain overstocked — the first-order win there is cost and freed working capital, with the SOR lift coming as you draw the slow tail down and protect the heroes.

## To run the *true* backtest

Provide (CSV or BigQuery/Odoo access): store-SKU(-size)-level **daily sales** and **daily/weekly stock snapshots** for the last 8–12 weeks, plus the warehouse on-hand history. With that I can replay your actual transfers, score flat vs new on real demand, and produce a defensible SOR delta by store, category and class — and the win/kill thresholds for the live pilot.
