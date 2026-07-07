---
name: run_query cache rows are shared
description: Handlers must never mutate rows returned by run_query — the cache hands back the same dict objects.
---

**Rule:** `run_query` (api_pg.py) caches and returns the *same* row-dict objects on repeat calls within TTL. Any handler that reshapes rows (e.g. `r.pop(...)`, `del r[...]`, in-place key renames) must copy first: `r = dict(r)`.

**Why:** kpi-trend/trend-series popped `bucket_date` off cached rows, so the second call within the cache TTL got mutated rows and 500'd / lost fields. Bug is invisible on a cold cache and in one-shot curl tests.

**How to apply:** whenever adding or editing an endpoint that post-processes `run_query` output destructively, copy each row before mutating. `test_net_sales_consistency.py` now double-calls kpi-trend/trend-series to lock this in.
