---
name: Fabric net consumption & returns
description: How fabric consumption, returns, and weeks-of-cover are defined for the /fabric dashboard
---

# Fabric consumption is OUT minus production returns

In `raw_fabric_moves`, fabric consumption is an `OUT` move (stock → production).
Some of that fabric comes back as a **return**, which is an `INTERNAL` move whose
`location_from = 'Virtual Locations/Production'` (the only production source value;
exact match, so no LIKE / no psycopg2 literal-% trap). 

**Net consumption = SUM(OUT) − SUM(INTERNAL returns from production).**

**Why:** gross OUT massively overstates real usage — for 2026, gross OUT ≈ 2.46M kg
but returns ≈ 2.23M kg, so true net consumption ≈ 231k kg. The user explicitly wants
consumption reported net of returned fabric.

**How to apply:** use the `_net_kg` / `_net_cons_where` helpers in `fabric_router.py`
(they put OUT positive, INTERNAL-from-production negative). The return arm is
restricted to `move_type='INTERNAL'` so a future non-INTERNAL row from the production
location can't silently net out. Net consumption is wired into `/api/fabric/summary`
(consumed 30d), `/api/fabric/consumption`, and `/api/fabric/top-consumed`.
`/api/fabric/movement-flow` intentionally still shows raw IN/OUT/INTERNAL separately.

# Weeks-of-cover uses a monthly-average run-rate
`/api/fabric/top-consumed` weeks_cover = stock ÷ weekly_rate, where
weekly_rate = (net_consumption ÷ months_in_window) ÷ (52/12), and
months_in_window = window_days ÷ 30.4375. I.e. average per full month, then convert
to a weekly rate. (Numerically close to days/7 weekly, but the user asked for the
monthly-average framing and it now runs on NET consumption.)

# Location "All"
The dashboard location filter has an "All locations" option (value `All`). Backend
`_loc_filter()` drops the `location_name` predicate for `All`/empty across
by-category, register, ageing, attribute-split; `summary` aggregates fabric stock
across every location except `Dead/Stock Fabric` (reported separately) by summing the
per-location rows (don't take rmat[0] — that was a bug that showed only one row).
