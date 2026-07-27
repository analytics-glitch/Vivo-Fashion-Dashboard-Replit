---
name: Named cursor dies on same-conn commit
description: psycopg2 server-side (named) cursors are closed by conn.commit() unless withhold=True
---
- Streaming a named cursor while flushing batches with `conn.commit()` on the SAME connection raises "named cursor isn't valid anymore" after the first flush — the transform silently left all_products_clean truncated to 1,000 rows, breaking every style-universe surface downstream.
- **Fix:** declare the cursor `conn.cursor(name=..., withhold=True)` (WITH HOLD survives commits), or flush on a separate connection.
- **How to apply:** any ETL that streams via a named cursor and commits per batch on the same conn needs withhold=True.
