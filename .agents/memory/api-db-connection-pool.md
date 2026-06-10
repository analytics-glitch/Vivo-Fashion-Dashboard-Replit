---
name: api_pg.py needs a bounded DB connection pool
description: Why the FastAPI BI server kept dying with a clean shutdown (no traceback) and 502s, and the fix
---

# api_pg.py DB connection pooling

## Symptom
The FastAPI api-server workflow intermittently went to FAILED and the dashboard
showed "Request failed with status code 502". The api log ended with a CLEAN
`Shutting down / Application shutdown complete` and NO Python traceback — i.e. the
platform sent SIGTERM, it did not crash on an exception. Memory was fine (not OOM).

## Root cause
`run_query` opened a brand-new `psycopg2.connect()` per query and closed it. The
dashboard fires bursts of ~20-40 parallel requests (KPI sparkline windows +
compare + bootstrap + canonical-units). FastAPI runs sync `def` endpoints in a
~40-thread pool, so the burst opened dozens of fresh connections at once,
exhausting Postgres connections and spiking latency until the platform's startup
health probe (`/api/`) timed out and SIGTERMed the unresponsive server.

## Fix
- Use a module-level `psycopg2.pool.ThreadedConnectionPool` (lazy, double-checked
  lock). `getconn`/`putconn` per query; `putconn(conn, close=True)` on exception so
  a poisoned connection never returns to the pool. Set `conn.autocommit = True`
  (read-only BI) so pooled connections never sit idle-in-transaction.
- Cap request concurrency BELOW the pool size at startup via
  `anyio.to_thread.current_default_thread_limiter().total_tokens = MAX-2` so
  `getconn()` can never overflow the pool (ThreadedConnectionPool raises, it does
  not block, when exhausted).

**Why it matters:** verified by firing 40 concurrent /api/kpis requests — all 200,
server stayed up. Before the fix that burst reliably killed the server.
