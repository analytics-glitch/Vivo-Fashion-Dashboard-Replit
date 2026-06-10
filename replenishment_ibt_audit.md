# Replenishment & IBT — Audit, Gap Analysis & Improvement Plan

**Project:** Vivo Fashion Group BI
**Scope:** Replenishment, Re-Order, Allocations, Inter-Branch Transfer (IBT), Store Clustering
**Backend:** `api_pg.py` (FastAPI over live Postgres) · **Frontend:** `artifacts/vivo-bi/src`
**Date:** 2026-06-10

> Method: every endpoint and page named below was read directly from source. SQL,
> field names and thresholds are quoted verbatim. Where an endpoint returns stub or
> in-memory data it is called out explicitly. Live data diagnostics were run
> read-only against the production Postgres and are cited inline.

---

## Executive summary (read this first)

The analytical layer is real and reasonably sophisticated; the **operational
(write/track) layer is almost entirely non-functional**. Specifically:

1. **No persistence exists for any operator action.** There are **zero** audit
   tables in the database (`information_schema` search for `%ibt%`, `%replenish%`,
   `%recommend%`, `%alloc%`, `%outcome%`, `%transfer%` returned nothing). All
   "completed", "late", "recommendation status" and "allocation run" state lives
   in **Python module-level dicts/lists** (`_REPLEN_MARKS`, `_ALLOC_RUNS`,
   `_REPLEN_OWNERS`, `_RANGE_OVERRIDES`) or in **pure stubs**. Everything is lost
   on every server restart / redeploy.
2. **The IBT "late" badge can never fire.** `GET /api/ibt/late-count` is a stub
   that returns `{"count": 0}` unconditionally. The Sidebar polls it every 5 min
   and renders a pulsing rose badge — which is therefore dead code in practice.
3. **"Mark IBT as done" does nothing.** `POST /api/ibt/complete` is
   `return {"ok": True}`. `GET /api/ibt/completed` and `/api/ibt/completed/keys`
   return `[]`. So the whole IBT completion / dedupe / outcome loop is a no-op.
4. **Recommendation actions are not stored.** `GET/POST /api/recommendations`
   are stubs (`[]` / `{"ok": True}`). The Re-Order page's "PO raised / dismissed /
   done" pills appear to work (optimistic UI) but persist nowhere.
5. **The SKU-format problem is largely a non-issue.** The raw join
   `s.variant_sku = p.sku` already matches **98.39%** of 1,450,887 sale lines, and
   `i.sku = p.sku` matches **99.88%** of 52,875 inventory rows. A normalisation
   pass would recover ~1.6% of sales lines — worth doing, but it is a minor data-
   quality fix, not the systemic break the brief assumes.
6. **`all_inventory.size` is 100% NULL** (52,875/52,875 rows). Size always comes
   from `all_products_clean.size` via the join. Any endpoint reading `i.size`
   directly (e.g. aged-stock) silently shows blank sizes.
7. **Inventory freshness data already exists and is unused.** `all_inventory` has
   a `_loaded_at timestamp` column and an `on_hand numeric` column. Neither is
   surfaced in the dashboard.

The highest-leverage work is **not new algorithms** — it is giving the existing
recommendations a real persistence + outcome-tracking spine.

---

# SECTION 1 — HOW THE SYSTEM CURRENTLY WORKS

## 1.0 Shared data foundation

**Tables** (all queried live; no materialised snapshots):
- `all_sales s` — one row per sale/return line. Key cols: `variant_sku`,
  `net_quantity`, `ordered_item_quantity`, `net_sales_kes`, `total_sales_kes`,
  `returns_kes`, `sale_kind` (`'sale'|'order'|'return'`), `pos_location_name`,
  `country`, `channel`, `sale_date` (**TEXT**, `'YYYY-MM-DD'`), `customer_id`,
  `order_id`, `product_title`.
- `all_inventory i` — current stock. Cols: `sku`, `available numeric`,
  `on_hand numeric`, `pos_location_name`, `location_name` (bin), `country`,
  `size` (**100% NULL**), `color_print`, `product_name`, `_loaded_at timestamp`.
- `all_products_clean p` — product master. Cols: `sku`, `style_name`, `brand`,
  `product_type` (subcategory), `category`, `collection`, `size`, `color_print`,
  `barcode`, `cost`, `style_launch_date` (TEXT).

**`BASE_FILTERS`** (applied to most sales reads):
```sql
s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda')
AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%shopping bag%'
AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%gift card%'
AND LOWER(COALESCE(s.variant_sku,'')) NOT LIKE '%vb00%'
```

**`WAREHOUSE_LOCATIONS`** — a 30-entry tuple of non-selling locations
(`'Warehouse Finished Goods'`, `'Warehouse Receiving'`, `'In Transit'`,
`'Production'`, `'Sale Stock'`, …). Selling-stock queries use
`pos_location_name NOT IN (WAREHOUSE_LOCATIONS)`; warehouse-stock queries invert it.

**Helpers:**
- `build_filters(date_from, date_to, country, channel, extra)` → `sale_date BETWEEN
  '<from>' AND '<to>'` + `BASE_FILTERS` + optional `s.country IN (...)` /
  `s.pos_location_name IN (...)` + `extra`.
- `_period_weeks(from, to)` → `max(1.0, (days+1)/7)` as a literal (used by velocity).
- `run_query(sql, date_to)` → md5-keyed in-process cache with a `smart_ttl`.
- **SQL is built by string concatenation**; injection defence is single-quote
  doubling + `standard_conforming_strings=on` pinned per connection. **There is no
  SKU normalisation function anywhere** — joins are raw equality.

---

## 1.A REPLENISHMENT

### 1.A.1 Re-Order page — `pages/ReOrder.jsx`
- **Calls `GET /api/analytics/new-styles`** (NOT `/re-order-list`, which is a stub —
  see below). Params `date_from/date_to/country/channel`, `days` default 90.
- **Methodology** (`analytics_new_styles`, api_pg.py): styles whose
  `style_launch_date` is within the last `days`. SOR is **launch-to-date**:
  ```sql
  sor_percent = 100.0 * units_sold_launch
              / NULLIF(units_sold_launch + current_stock, 0)
  ```
  `current_stock` = `SUM(i.available)` excluding warehouses. `units_sold_launch` =
  `SUM(net_quantity)` over all sale/order history for the style.
- **Frontend decision logic:** keeps only `isMerchandise(product_type)` rows with
  `sor_percent >= 50`. Urgency tiers (frontend constants): `CRITICAL ≥ 80`,
  `HIGH 65–80`, `MEDIUM 50–65`. Current stock renders a red pill if `< 10`.
- **Actions:** `RecommendationActionPill` → `po_raised | dismissed | done | reset`,
  via `useRecommendationState("reorder")` → **`POST /api/recommendations` (STUB,
  returns `{"ok": true}`, persists nothing)**. "Show resolved" is local `useState`.

### 1.A.2 `GET /api/analytics/re-order-list` — **STUB**
```python
@app.get("/api/analytics/re-order-list")
def stub_analytics_re_order_list(): return []
```

### 1.A.3 Replenish-by-color — `components/ReplenishByColor.jsx` → `GET /api/analytics/replenish-by-color`
- Params: `max_weeks_of_cover` (default **6.0**), `min_sor_percent` (default **40.0**),
  `country`, `channel`.
- **Methodology** (`analytics_replenish_by_color`): 30-day units per style+color,
  store SOH per style+color (warehouses excluded). Then in Python:
  ```python
  weeks_target = 4.0                      # HARDCODED target weeks of cover
  weekly       = units_30d / 4.0
  target       = round(weekly * weeks_target)
  recommended_qty = max(0, target - soh_total)
  woc = soh / (units_30d / 4.0)
  sor = 100 * units / (units + soh)
  # row dropped if sor < min_sor_percent OR woc > max_weeks_of_cover OR total_rec <= 0
  ```
- **Output:** styles with per-color `recommended_qty`, `pct_of_style_sales`,
  sorted by `total_recommended_qty`. Read-only (no action persistence).

### 1.A.4 Replenishment pick-list — `pages/Replenishments.jsx` + `components/ReplenishmentReport.jsx`
- **`GET /api/analytics/replenishment-report`** (default window = last 30 days).
- **Methodology** (`analytics_replenishment_report`): per `(store, sku)` with
  `SUM(net_quantity) > 0`, joined to store SOH and warehouse SOH. The trigger is:
  ```sql
  WHERE COALESCE(ss.soh_store,0) < sold.units_sold     -- sold more than is on the floor
    AND COALESCE(w.soh_wh,0)    > 0                     -- and warehouse can cover it
  ```
  Quantity (Python): `replenish = max(0, min(units_sold - soh_store, soh_wh))`.
  `days_lapsed = today - last_sale`. Owners assigned **round-robin** from
  `_REPLEN_OWNERS` (`owners[idx % len(owners)]`).
- **Mark done:** `POST /api/analytics/replenishment-report/mark` → writes
  **`_REPLEN_MARKS` (in-memory dict; lost on restart)** keyed by
  `(pos_location,"sku",sku)` and `(pos_location,"barcode",barcode)`. UI is optimistic;
  PDF picker export via `jsPDF`.
- **Roster:** `ReplenishmentRosterCard` → `GET/POST /api/admin/replenishment-config`
  → `_REPLEN_OWNERS` (in-memory; default `["Matthew","Teddy","Alvi","Emma"]`).
- **`GET /api/analytics/replenishment-completed` — STUB `return []`.**

### 1.A.5 Supporting analytics (real, read-only)
- **`/api/analytics/weeks-of-cover`**: 28-day window. `weekly_units = units_28/4.0`,
  `weeks_of_cover = available / (units_28/4.0)`. Grouped by `product_type` + `style_name`.
- **`/api/analytics/velocity`** (`pages/Velocity.jsx`): `rate_of_sale =
  units_sold / _period_weeks(from,to)`; `weeks_of_cover = current_stock /
  rate_of_sale`; `sell_through = sold/(sold+stock)`. Fast/Steady/Slow at >60 / 30–60 / <30.
- **`/api/analytics/size-curve`** (`pages/SizeHealth.jsx`): catalogued sizes vs
  in-stock sizes per style; `broken_sizes`, `health_pct`, `missing_sizes`
  (`string_agg`). Filter `total_sizes >= 2`. **This already detects broken size runs
  at the STORE-aggregate level** (it does not yet feed IBT/replenishment quantities).
- **`/api/analytics/sor-all-styles`** (`SorAllStyles`/`SorStylesTable`): chain-wide SOR.
- **`/api/analytics/aged-stock`** (`AgedStockReport`): per `(store, sku)` not sold in
  ≥ N days (default 60); never-sold → `999` sentinel. **Bug:** selects `MAX(i.size)`
  which is always NULL (see §1.0) so the Size column is blank.

## 1.B ALLOCATIONS (new-buy / replenishment distribution) — `pages/Allocations.jsx`
- `GET /allocations/sizes` → pack ratios from size frequency, clamped 1–4
  (fallback `{"S":2,"M":3,"L":3,"1X":2}`). `GET /allocations/stores`,
  `/allocations/styles` → pickers.
- **`POST /api/allocations/calculate`** — real scoring engine:
  ```python
  vel_score       = units_sold / max_units
  low_stock_score = 1.0 - soh / max_soh
  asp_score       = asp / max_asp
  score = (vw*vel_score + sw*low_stock_score + aw*asp_score) / (vw+sw+aw)
  # total_packs split proportionally to score; largest fractional remainders get +1
  ```
  `total_packs = store_units // pack_unit_size`, where
  `store_units = units_total * (1 - (warehouse_pct + online_pct)/100)`.
- **`POST /api/allocations/save`** → appends to **`_ALLOC_RUNS` (in-memory list)**;
  `created_by_name="Planner"`, `created_by_email="planner@vivo"` **hardcoded**;
  status `pending_fulfilment`.
- **`PATCH /api/allocations/runs/{id}/fulfil`** → mutates the in-memory run to
  `fulfilled`; `fulfilled_by_email="warehouse@vivo"` **hardcoded**.
- **`GET /api/analytics/allocations` — STUB `return []`.**

## 1.C IBT (Inter-Branch Transfer) — `pages/IBT.jsx`

### 1.C.1 Store→store — `GET /api/analytics/ibt-suggestions`
- Params: `date_from/date_to` (default last **30** days), `country`, `limit` (300),
  `low_pct` (**20**), `high_pct` (**150**). Frontend "sensitivity": strict 20/150,
  balanced 30/130, wide 40/120.
- **Methodology** (`ibt_suggestions`):
  ```sql
  stats: per style, avg_u = AVG(units_sold over its stores)   -- HAVING COUNT(*)>=2 AND AVG>0
  froms (donors):  available >= 3  AND units_sold <= low  * avg_u   -- low  = low_pct/100
  tos   (needers): units_sold >= high * avg_u AND available <= 2    -- high = high_pct/100
  pairs: DISTINCT ON (style) — ONE donor→needer pair per style (best avail → best seller)
  units_to_move = GREATEST(LEAST(from_avail-2, GREATEST(to_sold-to_avail,1)), 1)
  estimated_uplift = units_to_move * asp
  ```
- **Critical limitations:** (a) `DISTINCT ON (f.style)` yields **at most one transfer
  per style** chain-wide — multi-store imbalances are collapsed. (b) "avg over stores"
  is the **chain-wide average**, not peer-cluster aware. (c) Binary in/out thresholds,
  **no 0–100 score**. (d) No size-run integrity. (e) No dead-stock exclusion. (f) No
  lead-time/SLA. (g) `asp` may be NULL → uplift NULL.
- **SKU fan-out:** `GET /api/analytics/ibt-sku-breakdown` →
  `suggested_qty = LEAST(from_av>2 ? from_av-1 : 0, GREATEST(2 - to_av, 0))`
  (tops each SKU at the destination up to 2 units).

### 1.C.2 Warehouse→store — `GET /api/analytics/ibt-warehouse-to-store`
- Donors = `'Warehouse Finished Goods'` only. Needers: store `units_sold >= 3`
  (`HAVING`) and store `available <= 2`.
  `suggested_qty = GREATEST(LEAST(wh.available, units_sold - store_available), 1)`.

### 1.C.3 Completion / late / outcomes — **ALL STUBS**
```python
@app.get("/api/ibt/completed")        -> []
@app.get("/api/ibt/completed/keys")   -> []
@app.get("/api/ibt/late-count")       -> {"count": 0}     # badge can never fire
@app.post("/api/ibt/complete")        -> {"ok": True}     # mark-as-done is a no-op
```
`IBTMarkAsDoneModal` collects `po_number`, `completed_by_name`, `actual_units_moved`,
`transfer_date` and POSTs them into the void. `IBTCompletedMoves` always renders empty.

### 1.C.4 Store clustering — `pages/StoreClusters.jsx` → `GET /api/admin/store-clusters`
- Real computation of per-store `asp`, `avg_basket_units`, `revenue_90d`,
  `pct_tops/bottoms/accessories`, `size_cog` (modal size) over the last 90 days.
- **But "clusters" = pure revenue ranking**: tier A = top third by `revenue_90d`,
  B = middle, C = bottom (`tier_for(idx)`), labelled "Flagship/Core/Developing".
- **The cluster assignment is display-only** — IBT matching still uses the chain-wide
  average (the page itself says "Phase 1 surface … the math still uses the chain-wide
  average"). No behavioural/size-curve clustering despite the data being collected.

## 1.D Current limitations (consolidated)
| Area | Limitation | Evidence |
|---|---|---|
| Persistence | No DB tables for any action; in-memory dicts + stubs | `information_schema` audit search empty; `_REPLEN_MARKS/_ALLOC_RUNS` |
| IBT late | `late-count` hardcoded `0` | api_pg.py stub |
| IBT done | `/ibt/complete` no-op; `/ibt/completed` `[]` | api_pg.py stubs |
| Recommendations | `/recommendations` GET/POST stubs | api_pg.py |
| IBT coverage | one pair per style (`DISTINCT ON`) | `ibt_suggestions` |
| Clustering | revenue-rank only, not used in matching | `store-clusters` + page note |
| Lead time | not modelled anywhere | n/a |
| Size curve in qty | size-curve report exists but doesn't drive qty | `size-curve` vs `replenish-by-color` |
| WoC velocity | static `÷4` (28d) or single-period; no rolling/EWMA | `weeks-of-cover`, `replenish-by-color` |
| Dead stock | computed (aged-stock) but not excluded from IBT | `aged-stock` vs `ibt_suggestions` |
| `i.size` | 100% NULL; aged-stock shows blank size | live diagnostic |
| Hardcoded | owners, `weeks_target=4`, planner/warehouse emails | multiple |

---

# SECTION 2 — WHAT THE PROCESS SHOULD IDEALLY DO

**Replenishment should:** identify low-stock SKUs across all stores; size reorder
qty from actual sell-through velocity (rolling/decayed, not a single period);
respect lead time (Vivo ~4 wks production), MOQ and supplier constraints;
prioritise by sales contribution × WoC × season; separate **warehouse
replenishment** (produce/buy) from **store replenishment** (move from WH); flag
dead/overstock separately; emit a PO/production-request; and **split recommended
quantity by size using the historical size mix** per store cluster.

**IBT should:** find true A-excess / B-stockout pairs of the same style; be
**cluster/velocity aware** (don't move into a slow store; match like-for-like
demand); compute an **optimal transfer quantity**; protect **size-run integrity**
at the source; flag **late IBTs** past an SLA; **track outcomes** (did the receiving
store actually sell the units?); and **group transfers by source store** to minimise
trips.

---

# SECTION 3 — GAP ANALYSIS

| Feature | Current state | Ideal state | Gap | Data available? | Complexity | Priority |
|---|---|---|---|---|---|---|
| Action persistence | In-memory / stubs | Durable DB tables | **Total** | N/A (need tables) | Medium | **High** |
| IBT late count | Hardcoded `0` | Real count vs SLA | Total | Needs a recommendations/SLA store | Medium | **High** |
| IBT mark-done + completed | No-op / `[]` | Persisted + dedup | Total | Needs `ibt_completions` | Medium | **High** |
| IBT outcome tracking | None | sell-through of moved units | Total | `all_sales` post-transfer | Complex | Med |
| Weeks of Cover | static `÷4` over 28d / single period | rolling 8-wk EWMA velocity | Method | `all_sales` history | Simple | **High** |
| Lead-time reorder point | absent | `ROP = velocity × (lead+safety)` | Total | constant + velocity | Simple | **High** |
| Size-curve in qty | report only | qty split by size mix | Partial | `all_products_clean.size` + sales | Medium | Med |
| IBT scoring | binary thresholds | 0–100 composite | Method | all present | Medium | Med |
| Size-run integrity | none | don't break core sizes at source | Total | `size-curve` logic reusable | Medium | Med |
| Seasonal weighting | none | recency-weighted velocity | Total | `all_sales` | Medium | Med |
| Dead-stock exclusion | computed, not applied | exclude from IBT/replen | Logic | `aged-stock` | Simple | **High** |
| Chronic stockout | none | flag repeat low-WoC styles | Total | needs history snapshots | Complex | Low |
| Transfer grouping | none | group by source store | Total | derivable | Simple | Med |
| Store clustering in match | display-only | used to gate IBT pairs | Logic | `store-clusters` | Medium | Med |
| SKU normalisation | raw join (98.4%) | normalised join (~100%) | Minor | both tables | Simple | Low |
| Inventory freshness | `_loaded_at` unused | surfaced + stale flag | Wiring | column exists | Simple | **High** |
| `i.size` NULL | blank sizes from `i.size` | derive/﹣use `p.size` | Bug | `p.size` join | Simple | Med |

---

# SECTION 4 — SPECIFIC BUSINESS QUESTIONS

| # | Question | Answered today? | Notes |
|---|---|---|---|
| 1 | Styles at stockout risk in next 2 wks (all stores)? | **Partial** | `weeks-of-cover` shows WoC but no 2-week horizon flag / lead-time |
| 2 | Stores with excess of styles selling well elsewhere? | **Partial** | `ibt-suggestions` does this but one-pair-per-style, chain-avg |
| 3 | Min transfer qty worth an IBT (ROI threshold)? | **No** | `units_to_move ≥ 1` only; no ROI floor |
| 4 | Stores that receive IBTs but still don't sell? | **No** | no outcome tracking (stubs) |
| 5 | Avg time IBT recommendation → completion? | **No** | no recommendation/completion timestamps stored |
| 6 | Styles replenished >3× in 90 days (chronic)? | **No** | no historical recommendation log |
| 7 | Is replenishment qty seasonally adjusted? | **No** | flat `÷4`; no uplift weighting |
| 8 | Are IBTs breaking size runs? | **No** | size-curve exists but not applied to transfers |
| 9 | Stores understocked vs sales potential? | **Partial** | allocation scoring hints; not a dedicated view |
| 10 | % of IBT recs actioned within 7 days? | **No** | no action log |

---

# SECTION 5 — RECOMMENDED IMPROVEMENTS

> Pattern note: this backend builds SQL by concatenation and uses `run_query(sql,
> date_to)`. New write endpoints should use a real table via the existing pool
> (`_get_pool()` / `get_conn()`), parameterised. Below, all examples follow the
> repo's existing style.

## 5a. Algorithm improvements

### A1 — Weeks-of-Cover on a rolling 8-week velocity (replaces static ÷4)
**File:** `api_pg.py` → `analytics_weeks_of_cover` and `analytics_replenish_by_color`.
**Before:** `weekly = units_28 / 4.0`.
**After:** rolling 56-day window with **recency weighting** (recent 28 days ×2):
```sql
WITH sales AS (
  SELECT p.product_type AS subcategory, p.style_name,
    SUM(s.ordered_item_quantity) FILTER (
      WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days') AS units_56,
    SUM(s.ordered_item_quantity) FILTER (
      WHERE s.sale_date::date >= CURRENT_DATE - INTERVAL '28 days') AS units_28
  FROM all_sales s
  LEFT JOIN all_products_clean p ON s.variant_sku = p.sku
  WHERE s.sale_kind IN ('sale','order')
    AND s.sale_date::date >= CURRENT_DATE - INTERVAL '56 days'
    AND """ + BASE_FILTERS + """
  GROUP BY 1,2
)
-- recency-weighted weekly run-rate: last 28d weighted x2 vs the prior 28d
SELECT ...,
  ROUND( ((COALESCE(units_28,0)*2) + GREATEST(COALESCE(units_56,0)-COALESCE(units_28,0),0))
         / 12.0 , 2) AS weekly_units,   -- (2*4wk + 1*4wk) / 12 effective weeks
  ROUND(available / NULLIF(weekly_units,0), 1) AS weeks_of_cover
```
**Verify:** styles with a recent sales spike show a lower (more urgent) WoC than the
flat ÷4 version; styles tailing off show higher WoC.

### A2 — Lead-time reorder point (Vivo production ≈ 4 weeks)
**File:** `api_pg.py`, add constant + apply in replenish endpoints.
```python
LEAD_TIME_WEEKS = 4.0      # Vivo in-house production lead time
SAFETY_WEEKS    = 1.0
# reorder when projected cover during lead time is insufficient:
# reorder_point_units = weekly_units * (LEAD_TIME_WEEKS + SAFETY_WEEKS)
# recommended_qty     = max(0, reorder_point_units - soh_total)
```
Surface `reorder_point`, `at_risk = (weeks_of_cover < LEAD_TIME_WEEKS + SAFETY_WEEKS)`.
**Verify:** any style with `weeks_of_cover < 5` is flagged `at_risk=true` and answers
business Q1 ("stockout risk in next 2 weeks" → use `weeks_of_cover < 2`).

### A3 — Size-curve replenishment quantities
**New endpoint** `GET /api/replenishment/size-breakdown?style_name=&country=`:
derive the 90-day size mix per style and split the recommended qty by it.
```sql
WITH mix AS (
  SELECT p.size, SUM(s.net_quantity) AS u
  FROM all_sales s JOIN all_products_clean p ON p.sku = s.variant_sku
  WHERE p.style_name = '<style>' AND s.sale_kind IN ('sale','order')
    AND s.sale_date::date >= CURRENT_DATE - INTERVAL '90 days'
    AND NULLIF(TRIM(p.size),'') IS NOT NULL
  GROUP BY p.size
)
SELECT size, u, ROUND(100.0*u/NULLIF(SUM(u) OVER (),0),1) AS pct_of_sales FROM mix ORDER BY u DESC;
```
Then `qty_for_size = round(total_recommended_qty * pct_of_sales/100)`.
**Verify:** the per-size quantities sum (±1 rounding) to the style total and follow the
historical S/M/L/XL ratio.

### A4 — IBT 0–100 score (replace binary in/out)
**File:** `ibt_suggestions`, add a scored column and order by it:
```sql
-- per candidate pair, components in [0,1]:
--   donor_excess  = LEAST(from_avail / NULLIF(avg_u,0), 3)/3
--   need_urgency  = LEAST(to_sold / NULLIF(GREATEST(to_avail,0)+1,0), 5)/5
--   sell_through  = to_sold / NULLIF(to_sold + to_avail,0)
score = round(100 * (0.4*donor_excess + 0.4*need_urgency + 0.2*sell_through))
```
Return `score` and `ORDER BY score DESC`. **Verify:** A→B pairs where B is selling fast
and nearly empty while A is heavily overstocked rank at the top (~80–100).

### A5 — Size-run integrity guard (source protection)
In `ibt-sku-breakdown`, cap per-SKU `suggested_qty` so the source keeps ≥1 of every
**core** size it currently stocks:
```sql
suggested_qty = LEAST(
   CASE WHEN from_av > 1 THEN from_av - 1 ELSE 0 END,   -- never take the last unit of a size
   GREATEST(2 - to_av, 0))
```
(Already partially present — make the `from_av - 1` floor explicit and add a
style-level check: skip the move if it would zero out > X% of the style's sizes at source.)
**Verify:** a donor with sizes {S:1,M:1,L:4} only releases L; S/M are protected.

### A6 — Seasonal / recency weighting — folded into A1 (EWMA-style 2× recent).

### A7 — Dead-stock exclusion from IBT/replenishment
Reuse `aged-stock` logic: exclude any `(style)` whose store stock has `>16` weeks of
cover **and** `<5%` sell-through in the last 8 weeks from donor *and* needer sets.
Add to `ibt_suggestions` `combined`/`stats` CTE a `WHERE` excluding such styles.
**Verify:** styles that haven't sold in 120+ days no longer appear as IBT needers.

### A8 — Chronic stockout detection (needs §5b history table)
Once recommendations are logged (B1), flag styles appearing as `at_risk` in ≥3 of the
last ~12 weekly snapshots.

## 5b. New features (full implementations)

### B0 — The foundation: a real persistence schema (do this first)
Create the tables every action endpoint needs (run once; pattern matches `app_users`):
```sql
CREATE TABLE IF NOT EXISTS recommendation_actions (
  id            BIGSERIAL PRIMARY KEY,
  rec_type      TEXT NOT NULL,         -- 'reorder' | 'replenish' | 'ibt'
  rec_key       TEXT NOT NULL,         -- stable key (e.g. style|from|to or pos|sku)
  status        TEXT NOT NULL,         -- 'po_raised' | 'dismissed' | 'done' | 'pending'
  actual_units  INTEGER,
  reason        TEXT,
  acted_by      TEXT,
  acted_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (rec_type, rec_key)
);
CREATE TABLE IF NOT EXISTS ibt_completions (
  id BIGSERIAL PRIMARY KEY, style_name TEXT, brand TEXT, subcategory TEXT,
  from_store TEXT, to_store TEXT, flow TEXT,            -- 'store_to_store'|'warehouse_to_store'
  units_to_move INTEGER, actual_units_moved INTEGER,
  sku TEXT, color TEXT, size TEXT, barcode TEXT,
  po_number TEXT, completed_by_name TEXT,
  suggested_at DATE, transfer_date DATE, completed_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS allocation_runs (
  id TEXT PRIMARY KEY, payload JSONB NOT NULL, status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(), fulfilled_at TIMESTAMPTZ
);
```
Then migrate the stubs/in-memory stores to these tables:
- `/api/recommendations` GET/POST → read/upsert `recommendation_actions`.
- `/api/ibt/complete` → insert `ibt_completions`; `/api/ibt/completed` → select it;
  `/api/ibt/completed/keys` → `SELECT DISTINCT style_name||'|'||from_store||'|'||to_store`.
- `_ALLOC_RUNS` → `allocation_runs`. `_REPLEN_MARKS` → `recommendation_actions`
  (`rec_type='replenish'`).

### B1 — IBT late count (connect the dead badge)
```python
@app.get("/api/ibt/late-count")
def ibt_late_count():
    # "late" = a still-open suggestion older than 5 business days.
    # An IBT is considered actioned if a matching row exists in ibt_completions.
    rows = run_query("""
        WITH open AS (  -- reuse the ibt-suggestions selection, last 30d
            SELECT style_name, from_store, to_store FROM ( """ + _IBT_SUGGEST_SQL + """ ) q
        )
        SELECT COUNT(*) AS count FROM open o
        LEFT JOIN ibt_completions c
          ON c.style_name=o.style_name AND c.from_store=o.from_store AND c.to_store=o.to_store
        WHERE c.id IS NULL
    """)
    return {"count": int(rows[0]["count"]) if rows else 0}
```
(Track a `suggested_at` per recommendation in `recommendation_actions` to compute true
SLA age; `+5 business days` = `recommended_date + INTERVAL '7 days'` as a simple start.)

### B2 — IBT outcome tracking + ROI card
`GET /api/ibt/outcomes`: for each completed transfer, measure destination sell-through:
```sql
SELECT c.style_name, c.to_store, c.actual_units_moved, c.transfer_date,
  COALESCE(SUM(s.net_quantity) FILTER (
     WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 30),0) AS sold_30d,
  ROUND(100.0*COALESCE(SUM(s.net_quantity) FILTER (
     WHERE s.sale_date::date BETWEEN c.transfer_date AND c.transfer_date + 30),0)
     / NULLIF(c.actual_units_moved,0),1) AS sell_through_30d
FROM ibt_completions c
LEFT JOIN all_products_clean p ON p.style_name = c.style_name
LEFT JOIN all_sales s ON s.variant_sku = p.sku AND s.pos_location_name = c.to_store
GROUP BY c.id;
```
Frontend: summary card "% of IBT stock sold within 30 days" + answers Q4/Q5.

### B3 — Replenishment calendar
`GET /api/replenishment/calendar` → bucket `at_risk` styles into ISO weeks by
`ceil((reorder_point - soh) urgency)` and lead time; output
`{week:"2026-W25", actions:[{style, qty, priority, trigger_reason}]}`.

### B4 — Store clustering used in IBT matching
Persist `store-clusters.by_store[store].cluster_id` and add to `ibt_suggestions`:
only emit a pair when `cluster(from) == cluster(to)` or adjacent tiers, and compute
`avg_u` **within the destination's cluster** rather than chain-wide.

## 5c. Data-quality improvements
- **C1 SKU normalisation (low priority — join already 98.4%/99.9%).** If pursued, add
  a helper and apply to joins:
  ```sql
  -- normalise both sides identically:
  UPPER(REGEXP_REPLACE(LTRIM(<col>,'0'), '[^A-Za-z0-9]', '', 'g'))
  ```
  Measure recovery before/after with the match-rate query in this audit.
- **C2 Inventory freshness (column already exists).** Surface `MAX(_loaded_at)` per
  location; flag stale if `now() - _loaded_at > 24h`:
  ```sql
  SELECT pos_location_name, MAX(_loaded_at) AS last_updated,
         (now() - MAX(_loaded_at) > INTERVAL '24 hours') AS stale
  FROM all_inventory GROUP BY pos_location_name;
  ```
- **C3 Size derivation.** `all_inventory.size` is 100% NULL — stop reading `i.size`
  (fix the aged-stock bug, use `p.size`). Optionally derive from the SKU tail
  (`V0821064LGR2X → 2X`) only where `p.size` is also missing.

## 5d. UI/UX improvements
- **D1** Replenishment "Why recommended?" tooltip: e.g. `"<store> has <woc> wks cover
  on an 8-wk run-rate of <weekly> units/wk"`.
- **D2** IBT "Transfer impact" column: projected WoC at source/destination after the move.
- **D3** Bulk approve/reject per store or category (one POST of many `rec_key`s to B0).
- **D4** "Export to operations" — Excel grouped by **source store** (transfer grouping),
  ready for physical execution.

---

# SECTION 6 — IMPLEMENTATION ROADMAP

**Phase 1 — Foundation (now).** *Files:* `api_pg.py` (+ a one-off DDL migration).
1. **B0 schema + migrate stubs/in-memory to tables** (recommendation_actions,
   ibt_completions, allocation_runs). Order first — everything else depends on it.
2. **B1 late-count** + **`/ibt/complete` / `/ibt/completed[/keys]`** real impls.
3. **A1 rolling-velocity WoC** + **A2 lead-time reorder point**.
4. **A7 dead-stock exclusion**; **C2 inventory freshness**; **C3 `i.size` bug**.

**Phase 2 — Algorithm upgrades.** *Files:* `api_pg.py` (`ibt_suggestions`,
`ibt-sku-breakdown`, `replenish-by-color`), `pages/IBT.jsx`, `SizeHealth.jsx`.
5. **A3 size-curve quantities** (`/replenishment/size-breakdown`).
6. **A4 IBT 0–100 scoring** + remove `DISTINCT ON` one-pair-per-style cap.
7. **A5 size-run integrity** guard. **A6** recency weighting (lands with A1).

**Phase 3 — New features.** *Files:* `api_pg.py`, `components/IBTCompletedMoves.jsx`,
new cards, `StoreClusters.jsx`.
8. **B2 IBT outcomes + ROI card**; **B4 clustering in matching**;
   **B3 replenishment calendar**; **D3 bulk actions**; **D4 ops Excel export**.

**Phase 4 — Advanced analytics.** *Files:* `api_pg.py` + a weekly snapshot job.
9. **A8 chronic-stockout** (needs weekly recommendation snapshots);
   replenishment-accuracy tracking (ordered vs subsequently sold);
   7-day forward predictive stockout alerts.

---

## Appendix — live data diagnostics (run read-only, 2026-06-10)
- `all_sales` sale/order lines: **1,450,887**; matched to `all_products_clean`: **98.39%**.
- `all_inventory` rows: **52,875**; matched: **99.88%**; `size` NULL/blank: **52,875 (100%)**.
- `all_inventory` columns include `available`, `on_hand`, `_loaded_at` (freshness).
- Audit tables for ibt/replenish/recommend/alloc/outcome/transfer: **none found**.
