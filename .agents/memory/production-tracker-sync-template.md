---
name: Production tracker sync templates
description: The production-order bulk upsert uses a server-owned timestamp expression alongside application values.
---

The production tracker order upsert must keep its explicit execute_values placeholder count equal to the application-supplied row tuple; server-owned columns such as updated_at belong outside that count.

**Why:** A mismatch raises before the transaction reaches PostgreSQL, so the supervised sync can appear to run while production_orders silently remains stale and date-filtered BI views show empty recent periods.

**How to apply:** Whenever production_orders columns or row values change, verify the execute_values template against the tuple length and keep a focused formatting regression test.