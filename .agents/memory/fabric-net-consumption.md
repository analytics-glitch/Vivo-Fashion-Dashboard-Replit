---
name: Fabric net consumption & returns
description: How fabric consumption, returns, and weeks-of-cover are defined for the /fabric dashboard
---

# Fabric consumption is OUT minus production returns

In `raw_fabric_moves`, fabric consumption is an `OUT` move (stock → production).
Some of that fabric comes back as a **return**, which is an `INTERNAL` move whose
`location_from = 'Virtual Locations/Production'` AND whose `location_to` is a **real
stock location** (NOT another virtual location). The destination guard matters:
Production → `Virtual Locations/Inventory adjustment` is a stock write-off/correction,
NOT physically returned fabric, and must not net off consumption (two such ~137,100kg
adjustment moves on 2026-06-24 drove "Consumed 30D" to ~−253k m before the guard).
The guard is `split_part(location_to,'/',1) <> 'Virtual Locations'` — `split_part`
(not `LIKE 'Virtual Locations/%'`) so the no-param `q()` queries dodge the literal-%
trap. It lives in the shared `_prod_return_pred()` helper used by BOTH `_net_kg`
(signed-kg) and `_net_cons_where` (row selection) so they stay in lockstep.

**Net consumption = SUM(OUT) − SUM(INTERNAL returns from production).**

**Why:** gross OUT massively overstates real usage — for 2026, gross OUT ≈ 2.46M kg
but returns ≈ 2.23M kg, so true net consumption ≈ 231k kg. The user explicitly wants
consumption reported net of returned fabric.

**How to apply:** use the `_net_kg` / `_net_cons_where` helpers in `fabric_router.py`
(they put OUT positive, INTERNAL-from-production negative). The return arm is
restricted to `move_type='INTERNAL'` so a future non-INTERNAL row from the production
location can't silently net out. Net consumption is wired into `/api/fabric/summary`,
`/api/fabric/consumption`, and `/api/fabric/top-consumed`. `/api/fabric/movement-flow`
shows IN/OUT/INTERNAL separately but ALSO reads the override view (its OUT + production-
return INTERNAL bars reflect the sheet for the override window).

# Sheet override replaces Odoo for Jan–Apr 2026 (do NOT read raw_fabric_moves directly)
Odoo's `raw_fabric_moves` had badly inflated consumption/returns for early 2026 (e.g.
~2.2M kg of fake March production returns). The buying team's reconciled Google Sheet
is the source of truth for **OUT (consumption) and production returns** for the window
`2026-01-01 .. 2026-04-30` ONLY. IN is ALWAYS Odoo; May 2026+ and all pre-2026 stay
Odoo untouched.

**Mechanism:** a DB view `fabric_moves_effective` = `raw_fabric_moves` MINUS in-window
`OUT` and in-window `INTERNAL`-from-`Virtual Locations/Production`, UNION the sheet
consumption rows (pseudo `OUT`) and sheet returns (pseudo `INTERNAL` from production).
Every Fabric endpoint reads `EFFECTIVE_MOVES` (the view), never `raw_fabric_moves`
directly, EXCEPT the register's `last_move` subqueries (latest physical move, must stay
raw). Defined in `fabric_sheet_override.py` (DDL for view + the `fabric_sheet_*`
tables); `fabric_router.py` calls `_ensure_fabric_sheet(conn)` to lazily (re)create
them. **Why a view:** the existing `_net_kg`/`_net_cons_where` helpers and all SQL keep
working unchanged.

**Survives the hourly Odoo TRUNCATE rebuild:** the override lives in separate
`fabric_sheet_consumption` / `fabric_sheet_returns` tables (NOT `raw_fabric_*`), and the
view is recreated each boot. Loader `extract_fabric_sheet.py` does a full TRUNCATE+reload
from the sheet and is hooked into `sync_incremental.py` (bootstrap-if-empty + hourly,
running AFTER the Odoo fabric extract), so it also populates the **separate production
DB** (prod never runs the dev rebuild — see `prod-separate-db-rebuild.md`).

**Barcode→product match:** sheet rows carry a barcode joined to `raw_fabric_products.barcode`
(UNIQUE, no fan-out) at query time via `BTRIM`. ~90% of consumption kg matches; unmatched
rows keep `product_id=NULL` / name "Unmatched fabric (sheet)" and are STILL counted in
aggregate totals (summary/trend/movement) but EXCLUDED from per-fabric views
(`top-consumed` filters `product_id IS NOT NULL`).

**Out of scope:** ageing / dead-stock are recency-only and intentionally NOT overridden.

The summary "Consumed / month" KPI (`consumption_30d_kg` field name kept for
compat) is the **average monthly run-rate over the whole move history**, NOT a
trailing 30-day total: total net ÷ (span_days / 30.4375). Monthly net swings wildly
(returns are batch-booked — a single calendar month can even be negative), so a
running 30-day window is misleading. "Months of cover" = stock ÷ this monthly use.

# Stock Mix cover = smoothed 6-month run-rate; consumption floored, totals re-sum
The `/api/fabric/mix` "Stock Mix" tab does NOT compute Weeks/Months of Cover from
the selected consumption window (a short window where an in-window production return
outran its earlier OUT made net negative → cover blanked or absurd). Instead it
carries a per-group **6-month run-rate** (`runrate_monthly_kg/metres`) projected
exactly like the warehouse-wide `_months_of_cover` (M-5..M-1 complete + current
month projected to month-end). Because every step is a linear combination of the
group's monthly net kg, category run-rates sum back to the warehouse run-rate, so
covers reconcile. Cover = available ÷ run-rate; "—" when run-rate ≤ 0 (no sustained
net usage — genuinely happens, e.g. Jersey, where 6-month returns exceed OUT) or the
metre run-rate can't form (missing kg→metre).

**Consumption is floored at 0 per group** (negative = window-aligned return). Flooring
is non-linear, so `sum(floored subcategory rows) ≠ floored category total`. The Total
row / % denominator must therefore be re-summed from the floored rows **at the level
being displayed** (`group_by`): categories for the default view, subcategories for the
subcategory view — otherwise the Total stops reconciling with the rows above it and
shares don't add to 100%. OUT and the production-return credit are surfaced per row
(server `out_*`/`return_*`) so a floored-to-0 cell is explainable (hover ↩ marker).

# Weeks-of-cover uses a monthly-average run-rate
`/api/fabric/top-consumed` weeks_cover = stock ÷ weekly_rate, where
weekly_rate = (net_consumption ÷ months_in_window) ÷ (52/12), and
months_in_window = window_days ÷ 30.4375. I.e. average per full month, then convert
to a weekly rate. (Numerically close to days/7 weekly, but the user asked for the
monthly-average framing and it now runs on NET consumption.)

# Location "All" = RMAT/Stock + Dead/Stock Fabric ONLY (not every location)
The dashboard location dropdown is a fixed whitelist of exactly three options — All
locations, `RMAT/Stock`, `Dead/Stock Fabric` (default RMAT/Stock). The business only
tracks real fabric stock in those two locations; every other warehouse location
(FABRR/HQ/PROD/Samp/…) is excluded from the page entirely.

Backend `_loc_filter()` (constant `_FABRIC_LOCATIONS`): a recognised specific
location filters to just it; `All`/empty/unknown resolves to the SET
`location_name IN ('RMAT/Stock','Dead/Stock Fabric')` (NOT a dropped predicate, NOT
every location). Applies to by-category, register, ageing, attribute-split,
category-stock-consumption.

`summary` buckets: `rmat` = Fabric@RMAT/Stock, `dead` = Dead/Stock Fabric. The three
headline KPIs (Stock on hand / Total fabric value / Total weight) reflect the selected
scope: All = rmat+dead, else just that bucket — so they reconcile (All = RMAT + Dead).
**Months-of-cover always uses the rmat-only kg base** regardless of scope (dead stock
isn't "cover"). `total_fabric_value` (rmat+dead, scope-independent) is returned for the
Dead-stock % so that card doesn't swing with the selection.

**Why this matters:** the OLD behaviour dropped the predicate for All (every location)
and summary summed "all Fabric except Dead". Don't reintroduce that — it leaks the
excluded locations back in.
