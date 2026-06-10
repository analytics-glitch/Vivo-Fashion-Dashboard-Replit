---
name: Ported frontend expects original repo's JSON key names
description: api_pg.py endpoints must match the exact JSON keys the CRA-ported frontend reads, or fields render blank/undefined
---

# Frontend JSON key contracts (api_pg.py ↔ vivo-bi)

The vivo-bi frontend was ported verbatim from analytics-glitch/bi.vivofashionbrands,
so it reads the ORIGINAL backend's JSON key names. api_pg.py (our re-implementation)
must emit those exact keys or fields silently render blank.

Known cases:
- `/api/analytics/active-pos` rows must use key `channel` (NOT `location`) plus `country`.
  FilterBar.jsx and filters.jsx read `l.channel`; a `location` key leaves the POS
  filter's per-store options blank (the country group header still shows because
  `l.country` is correct, which is the tell-tale symptom).

**Why:** a `location` vs `channel` key mismatch left every Kenya POS option blank in the
filter dropdown. When a ported page shows empty rows/labels but the endpoint returns 200
with data, suspect a key-name mismatch first — diff the SQL `AS` aliases against what the
JSX destructures.
