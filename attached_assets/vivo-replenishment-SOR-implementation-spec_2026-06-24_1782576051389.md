# Vivo Fashion Group — Replenishment Redesign for Sell-Out Rate (SOR)
### Implementation specification (Markdown build brief for an AI coding agent)

Prepared 24 June 2026 · front-end audit + 5-expert panel (ratified 5/5) · Pages: `/replenishments`, `/replenish-by-item`
Companion files: `vivo-replenishment-SOR-wireframe_2026-06-24.png` (UI layout), `vivo-replenishment-SOR-backtest_2026-06-24.md` (rationale & expected impact).

---

## 1. Objective and the SOR mechanic

North-star metric: **SOR (sell-out rate) = units_sold ÷ (units_sold + store stock)** (warehouse excluded), as currently calculated — measured at store-SKU and rolled up.

Replenishment does not change total chain stock — it only moves units from the warehouse to a selling location. It therefore lifts SOR in exactly two ways:

- **Raise the numerator** — get proven sellers onto the floor before they hit zero, so sales that would have been lost are captured.
- **Protect the denominator** — do NOT push slow, end-of-life or broken-curve stock onto floors, because that inflates store stock and depresses SOR.

Consequence: today's flat rule ("top any SKU that sold ≥1 to 2 units") works against both levers — it under-serves heroes (≈4.5 u/wk/store) and over-serves the long tail (median ≈0.2 u/wk/store). The agreed redesign replaces it.

> **Warehouse holds no sellable stock while a proven-demand location is empty (firm rule).** A unit sitting in the warehouse counts toward neither the SOR numerator nor the store denominator — it is invisible to SOR and is lost sell-through whenever a store or Online that has already sold the item is at zero. Any warehouse unit of a SKU/size for which a proven-demand store or Online is out of stock is **deployable now** and goes to the top of the pick list, subject only to size-curve integrity and the fair-share rule. The warehouse keeps only a defined in-transit / cycle buffer; everything else belongs on a selling floor.

---

## 2. Council verdict

A five-person panel (allocation/merch, supply-chain, store-ops/fulfilment, BI/analytics, product/UX) **unanimously ratified** the SOR-first approach (5/5), each with one binding amendment, now folded in:

| Discipline | Binding amendment |
|---|---|
| Allocation / merch | Operate at size/curve level, not style — a broken curve is dead stock that depresses SOR. Suppression & at-risk flags run on size-level cover from Phase 1. |
| Supply-chain | Correct censored demand (stockout-induced zeros) before trusting velocity; size with min/max service levels (Croston/SBA), not deterministic velocity×cover. |
| Store-ops | Store-receipt confirmation: dispatched ≠ available; quarantine in-transit stock from the SOR denominator and picker credit (catches cross-border shrink). |
| BI / analytics | Define SOR once in a semantic layer, snapshot-anchored to a run_id, or any uplift claim is unfalsifiable. |
| Product / UX | "Projected SOR uplift" must be bounded by what is actually pickable and identical to the metric measured later — or delete it. |

Agreed sequencing correction: the data foundation is a **Phase-1 blocker, not a parallel track** — persist the suggested baseline, capture picker `user_id`, and enforce server-side done-state before any picker-accountability metric goes live.

Unanimous highest-leverage move: **suppress slow / EOL / broken-curve stock and protect fast-mover availability, surfaced through a pick list ranked by honest SOR-uplift — before any sizing sophistication.** The panel estimates this captures the majority of the SOR gain with no new forecasting.

---

## 3. SOR definition — confirmed against the live calculation

Vivo already computes SOR; this spec keeps the live formula and only standardises how it is applied. Confirmed against the Report Catalogue ("formulas reflect the live backend logic"):

```
SOR % = units_sold × 100 ÷ (units_sold + current_stock)
```

Warehouse locations excluded from the stock denominator; identical formula to "sell-through %"; SOR-since-launch uses lifetime units; all money in KES. **This base formula is unchanged.**

**Proposed refinements — additive; they do NOT silently change the headline SOR number:**

- Standardise the measurement window. Today `units_sold` uses each page's own window (Product Analysis 30d, Velocity's selected period, etc.); adopt one named window (e.g. trailing 4 weeks, EAT) so SOR is comparable across pages. SOR-since-launch keeps using lifetime units.
- Compute and store SOR per location/pool — physical stores on their stock, Shop Zetu on its own pool — then roll up unit-weighted (consistent with the current warehouse-excluded denominator).
- Snapshot stock at suggestion time (`on_hand_at_calc`) so pre/post SOR uplift is attributable to a run.
- Add a separate **"saleable SOR"** that nets broken-curve orphan sizes out of the denominator, shown ALONGSIDE the headline (not replacing it) to preserve trend continuity while exposing curve drag; broken-curve also feeds suppression (§4).

### 3a. Which SOR drives what — the grain

Every replenishment decision is taken at **store-SKU level (ideally store-SKU-size)**. Group / national SOR is never used to drive a line — it averages across stores, so a healthy group number can hide one store sold out and another overstocked.

- **Trigger (replenish or not):** read store-SKU(-size) SOR together with current shelf qty. A store that has cleared its stock (high store-SKU SOR, low on-hand) and has a prior local sale qualifies; a store sitting on unsold stock (low store-SKU SOR) does not.
- **Quantity (how much):** read store-SKU velocity × cover, with the censored-demand correction — not SOR. SOR is stock-dependent and saturates at 100% the moment a store sells out, so it tells you *whether and where*; velocity tells you *how much*.
- **Group / national SOR:** the roll-up scoreboard on the KPI strip — the outcome we lift by getting the store-level lines right. Computed FROM the store-level numbers, never the other way round.

---

## 4. Targeting logic — what to move

Per store-SKU (at size grain), a min/max base-stock target, classed by store-SKU velocity computed with the dashboard's own formula. Replaces the flat "2".

> **Proven-demand gate (firm rule):** replenishment only fires for a store-SKU that has SOLD at that store within the demand window. A SKU a store has never sold is never auto-replenished. Placing new or unproven styles into a store is an Allocations decision, not replenishment; a SKU enters the replenishment engine only after the store records its first sale of it.

| Class (store-SKU velocity) | Approx share | min facing | Max / target | Trigger |
|---|---|---|---|---|
| A — fast (≥1.0 u/wk) | ~10% | 3 | `ceil(v × cover_weeks)` | has sold here AND shelf < min facing |
| B — core (0.25–1.0 u/wk) | ~30% | 2 | 6 | has sold here AND shelf < min facing |
| C — tail (<0.25 u/wk) | ~60% | 1 | 1 | pull-to-1 only on an actual sale here |
| New / never sold at this store | — | not via replenishment | — | place via Allocations; enters replenishment only after first local sale |
| EOL / overstock (WOC>16, Retire, markdown) | — | SUPPRESS | 0 | never replenish — show in "Held back" panel |

**Online (Shop Zetu):** demand-sized only — `target = ceil(v_online × cover_weeks_online)`, short cycle (1–2 wks), no presentation floor (there is no display). Same warehouse pool as stores, so it competes in the §6 allocation.

Worked example. Poncho (~4.5 u/wk/store, metro) → target = `ceil(4.5×2) = 9`; today's rule gives 2 (≈78% under-served). Median tail SKU (0.2 u/wk) → target 1, pulled only when it sells; today's rule pushes 2 (the freight + dead-stock waste).

---

## 5. Demand signal — censored-demand correction

At ~0.2 u/wk/store the history is mostly zeros, and many zeros are stockout-induced lost sales, not true non-demand. Uncorrected, velocity is biased low on exactly the fast movers SOR rewards.

- Flag observations where the SKU was out of stock during the window (`stockout_during_window`).
- Treat those as right-censored; impute demand from in-stock stores and the online pool as proxy — but only for store-SKUs that have a prior local sale, so the proven-demand gate (§4) is never bypassed.
- Then classify A/B/C and size on corrected demand. This flag is built in Phase 1 so velocity AND projected-uplift aren't self-reinforcingly understated.

---

## 6. Warehouse allocation — one pass when stock is short

Stores and Shop Zetu draw from the same warehouse pool, so they compete in a single allocation pass per SKU. Replaces the current alphabetical-by-store ordering (which silently rations).

| Tier | Rule |
|---|---|
| Tier 1 — protect | Fund each claimant's need-to-next-dispatch = `ceil(v × cycle)`; protect each physical store's presentation minimum. If even Tier 1 can't be covered, fair-share by weight. |
| Tier 2 — optimise | Distribute the remainder toward full target, proportional to `weight = demand_share × margin × sub_factor`. |
| Shortfall | Flag constrained lines; route the gap to buying / inter-branch transfer (IBT). |

`sub_factor` = share of a stockout that becomes a truly lost sale: Shop Zetu ≈ 1.0 (no substitution), physical store ≈ 0.6 (some recovery to adjacent styles). So online climbs the queue only in Tier 2, after every store's presentation minimum is protected.

Micro-example (10 units in WH). Store A core 3/full 6 (0.6×), Store B core 2/full 4 (0.6×), Shop Zetu core 4/full 5 (1.0×). Tier 1 core = 9 ≤ 10 → all funded; remaining 1 → highest weight → Shop Zetu. Final A=3, B=2, Zetu=5.

### Deploy-from-warehouse first

Before any top-up, the allocation pass empties **deployable warehouse stock**: for every SKU/size where the warehouse holds units and a proven-demand store or Online is at zero, ship to that location first (size-curve and fair-share respected). This is the highest-SOR action there is — it turns invisible warehouse stock into on-floor sell-through — and it drives the deployable-warehouse-units KPI toward zero. **The warehouse is a flow-through buffer, not a holding pen.**

---

## 7. Cadence and batching

- Generate transfers on a dispatch calendar, not on page refresh: Kenya metro 2×/week, Kenya upcountry weekly, Uganda & Rwanda weekly (one consolidated customs entry).
- Minimum-transfer gate: don't cut a store transfer below ~6 units / ~KES 5,000 unless it's an A-class stockout; accumulate need to the next slot. Makes cross-border economic and damps daily "nervousness".

---

## 8. UI redesign

Reorient the page from "pick list + reconciliation" to "what to move today for the most SOR, what to deliberately not move, and what the warehouse can't cover." See the wireframe PNG.

**Remove / fix**

- The alphabetical "sorted by POS ascending" default ordering.
- The flat "top-up to 2 units" framing; the single-sale trigger on the tail.
- Every "—" placeholder (blank bins, unnamed picker, uncomputable fulfilment rate).

**Add**

- SOR KPI strip: current SOR · projected SOR uplift (today's list) · SOR-at-risk (store/Online stock 0 with proven demand) · **deployable warehouse units** (WH stock of SKUs whose proven-demand store/Online is at zero — drive to ~0) · SOR-drag (WOC>16 in store).
- Pick list ranked by expected SOR-uplift, grouped by corridor, with reason cells (sold28/floor/target/class/days-cover), a size-curve mini-indicator, and a warehouse-constrained flag.
- A visible "Held back — not replenishing" panel (EOL / overstock / broken curve) with the reason; overridable by merch.
- "As of today 06:00 EAT" chip; lock the global date bar on this page.
- Picker mobile "my picks": bin-path order, barcode scan, offline mark-done, server-side done-state (no double-pick on reload), "rebalance remaining only".
- Dispatch & receipt block: auto-pulled/validated Odoo transfer number, mandatory store-receipt confirmation, post-replenishment "did SOR rise" tile.

### Should this page have a date range?

- **No reporting date range.** The pick list is an operational as-of-today view; a historical date picker (like the global Last month filter) is meaningless for what to move now, so the global bar stays locked with an as-of-today chip.
- **Yes to one clearly-labelled demand lookback control** (e.g. 4 / 8 / 12 weeks) that sets the velocity and proven-demand window behind the suggestions — labelled as a lookback, not a report date. The transfer-tracking widget keeps its own history date range for reconciliation.

---

## 9. Picker accountability — keep, but fix

The fulfilment-by-picker panel stays (it shows who didn't complete their picks — a real management need that also ties to SOR, since a skipped fast-mover is a stockout). It can't do that job today because it shows User "—", Suggested 0, rate "—". Fix the two missing inputs and add SOR relevance:

| Column | Meaning |
|---|---|
| Picker | From the pick event's `user_id` (no more "—"). |
| Assigned / Done / Missed | Lines handed to the picker vs completed vs left unpicked (the "didn't do the job" signal). |
| Fulfilment % | Units picked ÷ units assigned (computable once the suggested baseline is persisted). |
| Missed-SOR units | Velocity of the lines they skipped — which misses actually cost sales. Ranks damage, not just count. |
| Over-picks | Picked more than suggested — pushing unplanned stock onto a floor (SOR drag). |

Normalise by units and bin-spread so a picker handed scattered single-unit lines isn't unfairly ranked; do not publish until the data is trustworthy.

---

## 10. Data foundation (build first)

Append-only, immutable; this is what makes SOR uplift attributable and the picker metric computable.

```
fact_replen_suggestion(run_id, run_ts_eat, store_id, sku_id, size,
   ruleset_version, shelf_qty_at_calc, v_at_calc, censored_flag, suggested_qty)
fact_pick_event(event_id, run_id, store_id, sku_id, size, user_id,
   qty_picked, picked_ts_eat, odoo_transfer_id, odoo_move_line_id)
fact_store_receipt(odoo_transfer_id, store_id, sku_id, qty_received, received_ts)
```

- `run_id = hash(business_date_EAT | store_scope | ruleset_version)`, upsert so a page reload never duplicates a day's suggestions.
- Conform store and SKU dimensions on surrogate keys (today store names join by string and break).
- Fulfilment rate is point-in-time per run (Σ picked ÷ Σ suggested on the same `run_id`); a separate metric tracks chronically unfilled SKUs.
- Projected SOR uplift (conservative): `expected_incremental_sold = min(suggested_qty, censored-adjusted v × days_to_next_dispatch)`; aggregate only over SKUs with velocity>0; reconcile against the post-replenishment tile.

---

## 11. Phased delivery plan

| Phase | Scope | SOR effect |
|---|---|---|
| Phase 1 — foundation + immediate SOR | Canonical SOR definition; immutable suggestion/pick/receipt fact tables (run_id, EAT, user_id, server-side done-state); censored-demand flag; size-level suppression of EOL/overstock/broken-curve ("Held back" panel); deploy-from-warehouse-first; pick list ranked by honest pickable SOR-uplift; SOR KPI strip. | Largest immediate gain — stops SOR self-harm and protects fast-movers, no new forecasting. |
| Phase 2 — sizing | Class-based min/max at size/curve grain on censored-corrected demand; new-style seeding; online demand-sizing; the fixed picker-accountability panel (Missed-SOR, over-pick, effort-normalised). | Refines the numerator; right-sizes heroes, trims the tail. |
| Phase 3 — flow | One-pass warehouse fair-share allocation (stores + Shop Zetu); corridor cadence + min-transfer gate; full store-receipt confirmation; post-replenishment SOR reconciliation feeding the projection. | Protects gains under scarcity & cross-border; closes the loop. |

---

## 12. Open decisions (the only knobs)

Everything else falls out of the formulas. These need confirmation with ops/merch:

1. `sub_factor` — in-store substitution recovery (0.6 starting guess) and any hard cap on online's share of a scarce SKU.
2. Corridor cover-weeks and the dispatch calendar (metro / upcountry / UG / RW).
3. A/B/C velocity cut-offs, set from the actual store-SKU velocity distribution.
4. EOL / overstock threshold (Report Catalogue default: WOC > 16 weeks).
5. Minimum-transfer gate (units / KES value).

---

## Expected impact (from the calibrated backtest)

Calibrated to Vivo's live ~30% SOR (network reads as overstocked on a slow tail): the new rule is **≥ the flat rule on SOR in every scenario** and ships **~60% fewer units** at the current stock position; the largest SOR gains (+3.8 to +5.4 points) land on the stocking-out hero styles. Launch the **Pareto-safe variant** (size heroes up, keep the tail floor at 2) so lost sales never increase; trim the genuine slow/EOL tail via suppression + markdown, not a blanket floor cut. Full detail and method in `vivo-replenishment-SOR-backtest_2026-06-24.md`. Note: that is a calibrated simulation, not a literal historical replay — a true backtest needs store-SKU(-size) daily sales + stock snapshots.
