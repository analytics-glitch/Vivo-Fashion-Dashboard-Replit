---
name: Postgres text date columns (vivo-bi)
description: all_sales.sale_date is stored as TEXT, breaking date functions unless cast.
---

# all_sales.sale_date is TEXT, not date

The `all_sales` table stores `sale_date` as a TEXT/varchar column (the values look
like ISO dates `YYYY-MM-DD`). Plain `BETWEEN '...' AND '...'` string comparison
works (that's how `build_filters` filters by range), but any date FUNCTION fails:

- `date_trunc('week', s.sale_date)` → `ERROR: function date_trunc(unknown, text) does not exist`

**Fix:** cast first — `date_trunc('week', s.sale_date::date)::date`. Same applies
to `EXTRACT`, `date_part`, interval math, etc.

**Why:** future SQL that buckets/groups by period (trend charts, weekday patterns)
must cast `s.sale_date::date`. The bucketing param must also be validated against
an allowlist (`day|week|month|quarter`) before string-concatenation into SQL,
since `run_query` builds raw SQL strings (no bound params for these).
