---
name: stock_transfers history retention
description: stock_transfers must never be TRUNCATE-reloaded; done rows accumulate, in-flight rows refresh.
---
The Odoo incoming-transfers extract only fetches a rolling ~7-day window, so a TRUNCATE+reload load would cap "Units Transferred" history at 7 days and silently break any custom-date-range reporting (Store Flow page).

**Rule:** load = DELETE non-`done` rows + upsert `ON CONFLICT (move_id)`; done rows are never deleted, so completed transfer history accumulates from the first sync onward (currently 2026-07-07).

**Why:** period-based transfer metrics are only as old as the retained rows; the source window is short.

**How to apply:** any change to `extract_odoo_transfers.py` loading, or any new consumer of `stock_transfers`, must preserve this. Surfaces should expose the earliest done day (`transfer_history_from`) and warn when the selected range predates it. Completed transfers belong to the EAT business day from `date_done + 3h`; use `scheduled_date + 3h` only while a transfer is still open.
