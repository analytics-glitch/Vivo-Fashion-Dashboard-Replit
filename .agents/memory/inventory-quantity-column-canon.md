---
name: all_inventory quantity column canon
description: Which stock-quantity column to use in all_inventory queries — and the phantom column that 500s.
---

**Rule:** the canonical stock-quantity column in `all_inventory` is `available` (~157 uses). `on_hand` exists but is NOT the reporting canon; `available_quantity` does NOT exist at all — referencing it raises "column does not exist" at request time, which raw-SQL-in-string endpoints won't catch until called.

**Why:** two bugs in one session — a new report used `on_hand` (diverges from every SOH surface if reservations appear) and a network-summary query shipped with `available_quantity`, a latent 500 that syntax checks and compile workflows can't see.

**How to apply:** any new query touching `all_inventory` stock quantities uses `SUM(available)`; grep-verify column names against `\d all_inventory` before shipping raw SQL, and curl the endpoint once — compile passing proves nothing about SQL column references.
