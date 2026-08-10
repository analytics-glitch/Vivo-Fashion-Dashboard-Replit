---
name: run_query cache rows are shared
description: Handlers must never mutate rows returned by run_query — the cache hands back the same dict objects.
---

**Rule:** `run_query` (api_pg.py) caches and returns the *same* row-dict objects on repeat calls within TTL. Any handler that reshapes rows (e.g. `r.pop(...)`, `del r[...]`, in-place key renames) must copy first: `r = dict(r)`.

**Why:** kpi-trend/trend-series popped `bucket_date` off cached rows, so the second call within the cache TTL got mutated rows and 500'd / lost fields. Bug is invisible on a cold cache and in one-shot curl tests.

**How to apply:** whenever adding or editing an endpoint that post-processes `run_query` output destructively, copy each row before mutating. `test_net_sales_consistency.py` now double-calls kpi-trend/trend-series to lock this in.

**Also:** `run_query(query, date_to=None, ttl=None)` takes NO `params` kwarg — its cache key is md5 of the SQL string only. Passing `params=` is a latent `TypeError` 500 that survives until the endpoint is actually hit (it bit the costing style-debug endpoint, which had shipped broken). Parameterized reads must interpolate safely or use a direct-connection helper (e.g. fabric_router's `q(conn, sql, params)`).

**COUNT(*) OVER() pattern:** Any endpoint that uses a window `COUNT(*) OVER() AS col` to smuggle a total into the result set must copy rows before popping the column (`[{k: v for k,v in r.items() if k != col} for r in rows]`), never `r.pop()` in-place. The at-risk endpoint hit this: second cache-hit call got `KeyError` on `at_risk_total` because the first call had popped it from the shared dict.
