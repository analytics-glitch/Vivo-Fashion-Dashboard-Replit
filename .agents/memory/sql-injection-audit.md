---
name: api_pg.py SQL-injection posture
description: How user input is kept injection-safe in the BI API, and why bound params were not used.
---

# SQL-injection posture of the FastAPI BI API

**Why not psycopg2 bound params:** SQL is built by string concatenation and
`run_query(query)` passes no params to `cur.execute` (cache keys on `md5(query)`).
The corpus is saturated with literal `%` (LIKE/ILIKE + `BASE_FILTERS`), so moving
to `%s` bound params would force escaping every literal `%`→`%%` across ~65 call
sites — high risk, zero extra safety.

**Defense in use (edge validation + escaping):**
- **Date query params** (`date_from`/`date_to`/`compare_from`/`compare_to`):
  validated to strict ISO in the auth middleware (`_is_iso_date` →
  `date.fromisoformat`); non-ISO → 400. A value that parses as a date can't carry
  a quote, so downstream concatenation is safe. One guard covers all date
  endpoints. (Trade-off: datetime-format inputs like `...T00:00:00Z` are rejected;
  fine because the frontend only sends `YYYY-MM-DD`.)
- **CSV list filters** (country/channel/location via `csv_to_sql`) and the
  quote-doubling sites below rely on `standard_conforming_strings=on`. This is
  **pinned per-connection** (libpq `options='-c standard_conforming_strings=on'`)
  and **asserted at startup** — do not remove either, or quote-doubling escaping
  becomes unsound.

**Already safe in the original code — do NOT "re-fix" or assume vulnerable:**
- `q`/`search`, `customer_id`/`cid`, `product` strip single quotes.
- `color`, `size`, `subcategory`, `style_name`, `names_sql` double single quotes.
- `bucket` is whitelisted; `month` and POST-body dates (`_iso`) are date-parsed.
- All numeric params are `int`/`float`-typed; server-computed dates and the
  `BASE_FILTERS`/`PRODUCT_SUBCATS`/`WAREHOUSE_LOCATIONS` constants are not user input.
