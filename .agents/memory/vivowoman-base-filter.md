---
name: vivowoman is the primary Kenya POS (do not exclude)
description: Why historical/pre-2022 sales went "missing" — BASE_FILTERS excluded the main Kenya location.
---

# vivowoman = primary Kenya POS, must NOT be excluded

In the local `all_sales` data, `pos_location_name = 'vivowoman'` is the main Kenya
retail POS: ~1.3M of ~1.55M total rows (84%), spanning 2019-10-24 → 2026-03-19.
Before ~Feb 3 2022 EVERY transaction was recorded under `vivowoman`; named
per-store locations (Vivo Kigali Heights, Online - Shop Zetu, etc.) only appear
from 2022 onward, and `vivowoman` itself stops around 2026-04 after a POS-naming
migration.

`BASE_FILTERS` in `api_pg.py` originally listed `'vivowoman'` in its
`pos_location_name NOT IN (...)` exclusion (inherited from the upstream
bi.vivofashionbrands repo, where the data model differed). That made all
pre-2022 data appear empty and undercounted 2022-2026 Kenya sales.

**Rule:** do NOT exclude `vivowoman`. It is real, distinct retail data — it cannot
be a rollup of the named stores because pre-2022 there were no named stores.
Keep excluding genuinely non-retail names: `Staff purchases` (internal),
`Manual Order` / `Online - vivo-uganda` (currently 0 rows).

**Why it matters:** any future change to BASE_FILTERS or location handling must
preserve `vivowoman`. It surfaces in Locations/breakdowns under the raw label
"vivowoman" (could be relabeled to e.g. "Vivo Kenya (Legacy)" if desired).
