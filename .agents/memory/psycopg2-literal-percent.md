---
name: psycopg2 literal percent in parameterized SQL
description: Parameterized psycopg2 SQL must escape literal percent characters, including fixed wildcard predicates.
---

When bound parameters are supplied, psycopg2 interprets every percent character in the SQL string as formatting syntax.

**Why:** fixed `LIKE`/`ILIKE` wildcard predicates are parsed together with `%s` bindings; they are not exempt because their values are static.

**How to apply:** Write literal percent characters as `%%` throughout parameterized SQL and keep user values in `%s` bindings. Review the entire query, including fixed predicates.
