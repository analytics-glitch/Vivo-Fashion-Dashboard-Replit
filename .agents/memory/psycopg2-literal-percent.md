---
name: psycopg2 literal % in SQL
description: Why some api_pg.py endpoints 500 with "IndexError: tuple index out of range"
---

# psycopg2 treats a literal `%` as a parameter placeholder

When a SQL string contains a literal `%` (e.g. `LIKE '%foo%'`, a `to_char(...,'...%...')`, or any `%`-bearing literal baked into dynamically-built SQL) and you pass it to `cursor.execute(sql)` **without** a params tuple, psycopg2 still runs `%`-style parameter binding over the string and raises `IndexError: tuple index out of range`.

**Why:** psycopg2's `execute(query, vars=None)` always interprets `%` for binding; the only way to emit a literal `%` is to escape it as `%%` (or to pass params so the `%s` placeholders are consumed).

**How to apply:** If an endpoint built from a SQL-generating helper 500s with `tuple index out of range`, the generated SQL has an unescaped literal `%`. Fix by doubling literal `%` to `%%` in the generator, or by routing through proper parameterized `%s` placeholders. Seen in `_ibt_suggestions_sql` feeding `/api/ibt/late-count` (run via `_users_exec(q, fetch=True)` with no params).
